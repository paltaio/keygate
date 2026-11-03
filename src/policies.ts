import { bodyMediaKind, joinUrl, type Carrier } from "./inject.ts";
import { isRecord, loadPolicy, messageOf, truncate, type Json, type LoadResult, type Policy, type PolicyContext, type PolicyDecision, type PolicyRequest, type PolicyResponse } from "./policy.ts";
import type { RunnablePolicy } from "./store.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type BodySkipped = NonNullable<PolicyContext["bodySkipped"]>;

interface CacheEntry {
  updatedAt: string;
  loading: Promise<LoadResult>;
  /** Leases holding the entry. A replaced entry is disposed once this drops to zero. */
  users: number;
  replaced: boolean;
}

interface LeasedPolicy {
  row: RunnablePolicy;
  entry: CacheEntry;
}

/** Loaded policies by id, rebuilt when a policy's updated_at moves forward. */
export class PolicyCache {
  private readonly entries = new Map<number, CacheEntry>();

  /** Holds the loaded code for `rows` until the lease is disposed, even if a policy is edited meanwhile. */
  lease(rows: readonly RunnablePolicy[]): PolicyLease {
    return new PolicyLease(
      rows.map((row) => ({ row, entry: this.acquire(row) })),
      (entry) => this.release(entry),
    );
  }

  private acquire(row: RunnablePolicy): CacheEntry {
    let entry = this.entries.get(row.id);
    // A request holding an older snapshot of the row runs the newer cached code.
    if (!entry || entry.updatedAt < row.updated_at) {
      if (entry) {
        entry.replaced = true;
        this.disposeIfUnused(entry);
      }
      const loading = loadPolicy(row.compiled).catch((e: unknown): LoadResult => ({ ok: false, message: messageOf(e) }));
      entry = { updatedAt: row.updated_at, loading, users: 0, replaced: false };
      this.entries.set(row.id, entry);
    }
    entry.users++;
    return entry;
  }

  private release(entry: CacheEntry): void {
    entry.users--;
    this.disposeIfUnused(entry);
  }

  private disposeIfUnused(entry: CacheEntry): void {
    if (entry.replaced && entry.users === 0) void entry.loading.then((r) => r.ok && r.policy.dispose());
  }
}

/** A token's runnable policies in attachment order, loaded once for both phases of a request. */
export class PolicyLease implements Disposable {
  readonly entries: readonly LeasedPolicy[];
  private readonly release: (entry: CacheEntry) => void;
  private released = false;

  constructor(entries: readonly LeasedPolicy[], release: (entry: CacheEntry) => void) {
    this.entries = entries;
    this.release = release;
  }

  get size(): number {
    return this.entries.length;
  }

  needs(need: "body" | "responseBody"): boolean {
    return this.entries.some(({ row }) => row.needs.includes(need));
  }

  [Symbol.dispose](): void {
    if (this.released) return;
    this.released = true;
    for (const { entry } of this.entries) this.release(entry);
  }
}

/** A chain that stopped the request: the response keygate sends instead of forwarding it. */
export type PolicyStop =
  | { kind: "deny"; policy: string; status: number; message: string }
  | { kind: "respond"; policy: string; status: number; headers: Record<string, string>; body: Json | undefined }
  | { kind: "error"; policy: string; message: string };

/** `body` replaces the raw request body when a policy changed a body the placements did not parse. */
export type RequestOutcome = { kind: "continue"; body?: string } | { kind: "invalid_body" } | PolicyStop;

export interface RequestRun {
  request: Request;
  /** The outgoing request; its parsed body, if any, is the one the placements need. */
  carrier: Carrier;
  /** The request body as sent, when the placements did not parse it. */
  raw: ArrayBuffer | undefined;
  /** Size of the request body as read. */
  bytes: number;
  /** Path after the slug. */
  path: string;
  baseUrl: string;
  /** Header names a policy may not set. */
  reservedHeaders: ReadonlySet<string>;
  ctx: Omit<PolicyContext, "bodySkipped">;
}

interface Exposed {
  value: Json | undefined;
  kind?: "json" | "form";
  /** Undecoded form text when the placements did not parse the body. */
  text?: string;
  skipped?: BodySkipped;
}

/**
 * Runs the onRequest hooks in order, each on the previous one's result, and applies the final
 * result to the carrier. Fields a policy left unchanged keep their original wire form.
 */
export async function runRequestPolicies(lease: PolicyLease, run: RequestRun): Promise<RequestOutcome> {
  const exposed = exposeBody(lease, run);
  if (!exposed) return { kind: "invalid_body" };
  const ctx: PolicyContext = { ...run.ctx, ...(exposed.skipped ? { bodySkipped: exposed.skipped } : {}) };
  const original: PolicyRequest = {
    method: run.request.method,
    path: run.path,
    query: firstValues(run.carrier.url.searchParams),
    headers: Object.fromEntries(run.carrier.headers),
    body: exposed.value,
  };
  let hooked = false;
  const result = await runChain(
    lease.entries,
    original,
    (policy, value) => {
      hooked ||= policy.onRequest;
      return policy.runRequest(value, ctx);
    },
    (before, after) => checkStep(run, exposed, before, after),
  );
  if (result.kind !== "continue") return result;
  try {
    const body = apply(run, exposed, original, result.value, hooked);
    return body === undefined ? { kind: "continue" } : { kind: "continue", body };
  } catch (e) {
    return failure(lease.entries.at(-1)?.row.name ?? "", messageOf(e));
  }
}

/** What the client gets as the response body: the provider stream, its buffered bytes, a rewritten JSON body, or nothing. */
export type ResponseBody = ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | string | null;

/** `upstream_error` is a provider body that failed while it was being read. */
export type ResponseOutcome = { kind: "continue"; status: number; body: ResponseBody } | { kind: "upstream_error"; message: string } | PolicyStop;

export interface ResponseRun {
  response: Response;
  /** Provider headers the client gets; header edits are written into it. */
  headers: Headers;
  /** Header names a policy may not set. */
  reservedHeaders: ReadonlySet<string>;
  ctx: Omit<PolicyContext, "bodySkipped">;
}

interface ExposedResponse {
  value: Json | undefined;
  skipped?: BodySkipped;
  /** The provider response has no body. */
  empty: boolean;
  body: ResponseBody;
}

/**
 * Runs the onResponse hooks last to first, each on the previous one's result. Status and header
 * edits always apply; the body is exposed only for JSON up to 1 MB. When the chain stops, the
 * provider body is cancelled.
 */
export async function runResponsePolicies(lease: PolicyLease, run: ResponseRun): Promise<ResponseOutcome> {
  let exposed: ExposedResponse;
  try {
    exposed = await exposeResponseBody(lease, run);
  } catch (e) {
    return { kind: "upstream_error", message: messageOf(e) };
  }
  const outcome = await responseChain(lease, run, exposed);
  if (outcome.kind !== "continue" && exposed.body instanceof ReadableStream) void exposed.body.cancel().catch(() => undefined);
  return outcome;
}

async function responseChain(lease: PolicyLease, run: ResponseRun, exposed: ExposedResponse): Promise<ResponseOutcome> {
  const ctx: PolicyContext = { ...run.ctx, ...(exposed.skipped ? { bodySkipped: exposed.skipped } : {}) };
  const headers = Object.fromEntries([...run.headers].filter(([name]) => name !== "set-cookie"));
  const original: PolicyResponse = { status: run.response.status, headers, body: exposed.value };
  const result = await runChain(
    [...lease.entries].reverse(),
    original,
    (policy, value) => policy.runResponse(value, ctx),
    (before, after) => checkResponseStep(run, exposed, before, after),
  );
  if (result.kind !== "continue") return result;
  const final = result.value;
  try {
    for (const name of Object.keys(original.headers)) if (!Object.hasOwn(final.headers, name)) run.headers.delete(name);
    for (const [name, value] of Object.entries(final.headers)) if (original.headers[name] !== value) run.headers.set(name, value);
    if (deepEqual(original.body, final.body)) return { kind: "continue", status: final.status, body: exposed.body };
    settleContentType(run.headers, "json", original.headers, final.headers);
    return { kind: "continue", status: final.status, body: JSON.stringify(final.body) };
  } catch (e) {
    return failure(lease.entries[0]?.row.name ?? "", messageOf(e));
  }
}

/** Runs one hook per policy in the given order; the first deny, respond or error stops the chain. */
async function runChain<T>(
  entries: readonly LeasedPolicy[],
  initial: T,
  hook: (policy: Policy, value: T) => PolicyDecision<T>,
  check: (before: T, after: T) => string | undefined,
): Promise<{ kind: "continue"; value: T } | PolicyStop> {
  let current = initial;
  for (const { row, entry } of entries) {
    try {
      const loaded = await entry.loading;
      if (!loaded.ok) return failure(row.name, loaded.message);
      const decision = hook(loaded.policy, current);
      if (decision.kind !== "continue") return stopFor(row.name, decision);
      const problem = check(current, decision.value);
      if (problem) return failure(row.name, problem);
      current = decision.value;
    } catch (e) {
      return failure(row.name, messageOf(e));
    }
  }
  return { kind: "continue", value: current };
}

function stopFor(policy: string, decision: Exclude<PolicyDecision<unknown>, { kind: "continue" }>): PolicyStop {
  switch (decision.kind) {
    case "error":
      return failure(policy, decision.message);
    case "deny":
      return { ...decision, policy };
    case "respond":
      if (decision.body !== undefined && NULL_BODY_STATUSES.has(decision.status)) return failure(policy, `respond() status ${decision.status} cannot have a body`);
      return { ...decision, policy };
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

/** The response for a policy's respond(): string bodies as text, other JSON values as JSON. */
export function customResponse(stop: { status: number; headers: Record<string, string>; body: Json | undefined }, extra: Record<string, string>): { response: Response; bytes: number } {
  const headers = new Headers(stop.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  let text: string | null = null;
  if (typeof stop.body === "string") {
    text = stop.body;
    if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  } else if (stop.body !== undefined) {
    text = JSON.stringify(stop.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return { response: new Response(text, { status: stop.status, headers }), bytes: text === null ? 0 : Buffer.byteLength(text) };
}

function failure(policy: string, message: string): PolicyStop {
  return { kind: "error", policy, message: truncate(message) };
}

/** Returns undefined when a needed JSON body does not parse. */
function exposeBody(lease: PolicyLease, run: RequestRun): Exposed | undefined {
  const { request, carrier } = run;
  if (request.method === "GET" || request.method === "HEAD" || run.bytes === 0) return { value: undefined };
  if (!lease.needs("body")) return { value: undefined, skipped: "not_requested" };
  const kind = bodyMediaKind(request.headers.get("content-type"));
  if (!kind) return { value: undefined, skipped: "unparsed" };
  if (run.bytes > MAX_BODY_BYTES) return { value: undefined, skipped: "too_large" };
  if (carrier.body?.kind === "json") return { value: carrier.body.value, kind: "json" };
  if (carrier.body?.kind === "form") return { value: firstValues(carrier.body.value), kind: "form" };
  const text = new TextDecoder().decode(run.raw);
  if (kind === "form") return { value: firstValues(new URLSearchParams(text)), kind, text };
  try {
    return { value: JSON.parse(text), kind };
  } catch {
    return undefined;
  }
}

/** What one hook changed that keygate cannot apply, or undefined. */
function checkStep(run: RequestRun, exposed: Exposed, before: PolicyRequest, after: PolicyRequest): string | undefined {
  if (after.path !== before.path) {
    const basePath = new URL(run.baseUrl).pathname.replace(/\/$/, "");
    const path = joinUrl(run.baseUrl, after.path, "").pathname;
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return "req.path must stay under the upstream's base URL";
  }
  for (const [name, value] of Object.entries(after.headers)) {
    if (run.reservedHeaders.has(name) && before.headers[name] !== value) return `req.headers["${name}"] cannot be set by a policy`;
  }
  if (deepEqual(before.body, after.body)) return undefined;
  if (before.body === undefined) return exposed.skipped ? `req.body cannot be changed when the body was not read (${exposed.skipped})` : "req.body cannot be set on a request without a body";
  if (after.body === undefined) return "req.body cannot be removed";
  if (exposed.kind === "form" && !isStringRecord(after.body)) return "req.body must be an object of strings for a form request";
  if (run.carrier.body?.kind === "json" && !isRecord(after.body)) return "req.body must stay a JSON object for this upstream";
  return undefined;
}

async function exposeResponseBody(lease: PolicyLease, run: ResponseRun): Promise<ExposedResponse> {
  const { response } = run;
  const length = response.headers.get("content-length");
  if (response.body === null || run.ctx.method === "HEAD" || NULL_BODY_STATUSES.has(response.status) || length === "0") return { value: undefined, empty: true, body: response.body };
  const passThrough = (skipped: BodySkipped, body: ResponseBody = response.body): ExposedResponse => ({ value: undefined, skipped, empty: false, body });
  if (!lease.needs("responseBody")) return passThrough("not_requested");
  if (bodyMediaKind(response.headers.get("content-type")) !== "json") return passThrough("unparsed");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return passThrough("too_large");
  // Content-Length, when present, counts encoded bytes; the cap applies to the decoded body.
  const read = await readCapped(response.body, MAX_BODY_BYTES);
  if (read instanceof ReadableStream) return passThrough("too_large", read);
  try {
    return { value: JSON.parse(new TextDecoder().decode(read)), empty: false, body: read };
  } catch {
    return passThrough("unparsed", read);
  }
}

/** Reads up to `max` bytes. Past that, returns a stream that replays what was read and then the rest. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > max) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** What one onResponse hook changed that keygate cannot apply, or undefined. */
function checkResponseStep(run: ResponseRun, exposed: ExposedResponse, before: PolicyResponse, after: PolicyResponse): string | undefined {
  for (const [name, value] of Object.entries(after.headers)) {
    if ((name === "set-cookie" || run.reservedHeaders.has(name)) && before.headers[name] !== value) return `res.headers["${name}"] cannot be set by a policy`;
  }
  if (after.status !== before.status && !exposed.empty && NULL_BODY_STATUSES.has(after.status)) return `res.status ${after.status} cannot be used on a response with a body`;
  if (deepEqual(before.body, after.body)) return undefined;
  if (before.body === undefined) return exposed.skipped ? `res.body cannot be changed when the body was not read (${exposed.skipped})` : "res.body cannot be set on a response without a body";
  if (after.body === undefined) return "res.body cannot be removed";
  return undefined;
}

/**
 * Writes the chain's result into the carrier; returns a replacement raw body when one is needed.
 * When an onRequest hook ran, the query and an exposed form body go out as the hooks saw them:
 * one pair per key.
 */
function apply(run: RequestRun, exposed: Exposed, original: PolicyRequest, final: PolicyRequest, hooked: boolean): string | undefined {
  const { carrier } = run;
  if (final.path !== original.path) carrier.url = joinUrl(run.baseUrl, final.path, carrier.url.search);
  if (hooked) {
    const search = editPairs(carrier.url.search.slice(1), original.query, final.query);
    if (search !== carrier.url.search.slice(1)) carrier.url.search = search;
  }
  for (const name of Object.keys(original.headers)) if (!Object.hasOwn(final.headers, name)) carrier.headers.delete(name);
  for (const [name, value] of Object.entries(final.headers)) if (original.headers[name] !== value) carrier.headers.set(name, value);

  const parsed = carrier.body;
  if (parsed) settleContentType(carrier.headers, parsed.kind, original.headers, final.headers);
  if (hooked && exposed.kind === "form" && isStringRecord(original.body) && isStringRecord(final.body)) {
    const raw = parsed?.kind === "form" ? parsed.value.toString() : (exposed.text ?? "");
    const text = editPairs(raw, original.body, final.body);
    if (parsed?.kind === "form") {
      parsed.value = new URLSearchParams(text);
      return undefined;
    }
    if (text === raw) return undefined;
    settleContentType(carrier.headers, "form", original.headers, final.headers);
    return text;
  }
  if (deepEqual(original.body, final.body)) return undefined;
  if (parsed?.kind === "json" && isRecord(final.body)) {
    parsed.value = final.body;
    return undefined;
  }
  settleContentType(carrier.headers, "json", original.headers, final.headers);
  return JSON.stringify(final.body);
}

/** Sets the plain content type for `kind` unless the headers already name that kind or a policy set its own. */
function settleContentType(headers: Headers, kind: "json" | "form", before: Record<string, string>, after: Record<string, string>): void {
  const policySet = Object.hasOwn(after, "content-type") && after["content-type"] !== before["content-type"];
  if (policySet || bodyMediaKind(headers.get("content-type")) === kind) return;
  headers.set("content-type", kind === "json" ? "application/json" : "application/x-www-form-urlencoded");
}

/**
 * Rebuilds `key=value` pairs as hooks saw them. Each key keeps only its first pair: rewritten when
 * its value changed between `before` and `after`, dropped when deleted, copied as sent otherwise.
 * New keys are appended.
 */
function editPairs(raw: string, before: Record<string, string>, after: Record<string, string>): string {
  const changed = new Map<string, string | undefined>();
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) changed.set(key, undefined);
  for (const [key, value] of Object.entries(after)) if (before[key] !== value) changed.set(key, value);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const key = new URLSearchParams(pair).keys().next().value ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    if (!changed.has(key)) out.push(pair);
    else {
      const value = changed.get(key);
      if (value !== undefined) out.push(new URLSearchParams([[key, value]]).toString());
    }
  }
  for (const [key, value] of changed) if (value !== undefined && !seen.has(key)) out.push(new URLSearchParams([[key, value]]).toString());
  return out.join("&");
}

/** First value of each key, as hooks see query strings and form bodies. */
function firstValues(params: URLSearchParams): Record<string, string> {
  const first = new Map<string, string>();
  for (const [key, value] of params) if (!first.has(key)) first.set(key, value);
  return Object.fromEntries(first);
}

function isStringRecord(v: Json | undefined): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === "string");
}

function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}
