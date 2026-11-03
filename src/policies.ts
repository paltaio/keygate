import { bodyMediaKind, joinUrl, type Carrier } from "./inject.ts";
import { isRecord, loadPolicy, messageOf, truncate, type Json, type LoadResult, type PolicyContext, type PolicyRequest } from "./policy.ts";
import type { RunnablePolicy } from "./store.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Loaded policies by id, rebuilt when a policy's updated_at moves forward. */
export class PolicyCache {
  private readonly entries = new Map<number, { updatedAt: string; loading: Promise<LoadResult> }>();

  get(row: RunnablePolicy): Promise<LoadResult> {
    const entry = this.entries.get(row.id);
    // A request holding an older snapshot of the row runs the newer cached code.
    if (entry && entry.updatedAt >= row.updated_at) return entry.loading;
    // Requests already awaiting the replaced entry registered first, so their hook call runs before this dispose.
    if (entry) void entry.loading.then((r) => r.ok && r.policy.dispose());
    const loading = loadPolicy(row.compiled).catch((e: unknown): LoadResult => ({ ok: false, message: messageOf(e) }));
    this.entries.set(row.id, { updatedAt: row.updated_at, loading });
    return loading;
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
  rows: RunnablePolicy[];
  request: Request;
  /** The outgoing request; its parsed body, if any, is the one the placements need. */
  carrier: Carrier;
  /** The request body as sent, when the placements did not parse it. */
  raw: ArrayBuffer | undefined;
  /** Path after the slug. */
  path: string;
  baseUrl: string;
  /** Header names a policy may not set. */
  reservedHeaders: ReadonlySet<string>;
  ctx: Omit<PolicyContext, "method" | "bodySkipped">;
}

interface Exposed {
  value: Json | undefined;
  kind?: "json" | "form";
  /** Undecoded form text when the placements did not parse the body. */
  text?: string;
  skipped?: NonNullable<PolicyContext["bodySkipped"]>;
}

/**
 * Runs the onRequest hooks in order, each on the previous one's result, and applies the final
 * result to the carrier. Fields a policy left unchanged keep their original wire form.
 */
export async function runRequestPolicies(cache: PolicyCache, run: RequestRun): Promise<RequestOutcome> {
  const exposed = exposeBody(run);
  if (!exposed) return { kind: "invalid_body" };
  const ctx: PolicyContext = { ...run.ctx, method: run.request.method, ...(exposed.skipped ? { bodySkipped: exposed.skipped } : {}) };
  const original: PolicyRequest = {
    method: run.request.method,
    path: run.path,
    query: firstValues(run.carrier.url.searchParams),
    headers: Object.fromEntries(run.carrier.headers),
    body: exposed.value,
  };
  let current = original;
  for (const row of run.rows) {
    try {
      const loaded = await cache.get(row);
      if (!loaded.ok) return failure(row.name, loaded.message);
      const decision = loaded.policy.runRequest(current, ctx);
      switch (decision.kind) {
        case "error":
          return failure(row.name, decision.message);
        case "deny":
          return { ...decision, policy: row.name };
        case "respond":
          if (decision.body !== undefined && NULL_BODY_STATUSES.has(decision.status)) return failure(row.name, `respond() status ${decision.status} cannot have a body`);
          return { ...decision, policy: row.name };
        case "continue": {
          const problem = checkStep(run, exposed, current, decision.value);
          if (problem) return failure(row.name, problem);
          current = decision.value;
          break;
        }
        default: {
          const unhandled: never = decision;
          return unhandled;
        }
      }
    } catch (e) {
      return failure(row.name, messageOf(e));
    }
  }
  try {
    const body = apply(run, exposed, original, current);
    return body === undefined ? { kind: "continue" } : { kind: "continue", body };
  } catch (e) {
    return failure(run.rows.at(-1)?.name ?? "", messageOf(e));
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
function exposeBody(run: RequestRun): Exposed | undefined {
  const { request, carrier } = run;
  const length = request.headers.get("content-length");
  if (request.method === "GET" || request.method === "HEAD" || length === "0" || request.body === null) return { value: undefined };
  if (!run.rows.some((r) => r.needs.includes("body"))) return { value: undefined, skipped: "not_requested" };
  const kind = bodyMediaKind(request.headers.get("content-type"));
  if (!kind) return { value: undefined, skipped: "unparsed" };
  if (length === null || !/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES) return { value: undefined, skipped: "too_large" };
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

/** Writes the chain's result into the carrier; returns a replacement raw body when one is needed. */
function apply(run: RequestRun, exposed: Exposed, original: PolicyRequest, final: PolicyRequest): string | undefined {
  const { carrier } = run;
  if (final.path !== original.path) carrier.url = joinUrl(run.baseUrl, final.path, carrier.url.search);
  if (!deepEqual(original.query, final.query)) carrier.url.search = editPairs(carrier.url.search.slice(1), original.query, final.query);
  for (const name of Object.keys(original.headers)) if (!Object.hasOwn(final.headers, name)) carrier.headers.delete(name);
  for (const [name, value] of Object.entries(final.headers)) if (original.headers[name] !== value) carrier.headers.set(name, value);

  if (deepEqual(original.body, final.body)) return undefined;
  const parsed = carrier.body;
  if (exposed.kind === "form" && isStringRecord(original.body) && isStringRecord(final.body)) {
    const text = editPairs(parsed?.kind === "form" ? parsed.value.toString() : (exposed.text ?? ""), original.body, final.body);
    if (parsed?.kind === "form") {
      parsed.value = new URLSearchParams(text);
      return undefined;
    }
    carrier.headers.set("content-type", "application/x-www-form-urlencoded");
    return text;
  }
  if (parsed?.kind === "json" && isRecord(final.body)) {
    parsed.value = final.body;
    return undefined;
  }
  carrier.headers.set("content-type", "application/json");
  return JSON.stringify(final.body);
}

/**
 * Rewrites `key=value` pairs for the keys whose value changed between `before` and `after`. A set
 * key keeps one pair at its first position, a deleted key loses every pair, a new key is appended,
 * and every other pair is copied as sent.
 */
function editPairs(raw: string, before: Record<string, string>, after: Record<string, string>): string {
  const changed = new Map<string, string | undefined>();
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) changed.set(key, undefined);
  for (const [key, value] of Object.entries(after)) if (before[key] !== value) changed.set(key, value);
  const out: string[] = [];
  const written = new Set<string>();
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const key = new URLSearchParams(pair).keys().next().value ?? "";
    if (!changed.has(key)) {
      out.push(pair);
      continue;
    }
    const value = changed.get(key);
    if (value === undefined || written.has(key)) continue;
    out.push(new URLSearchParams([[key, value]]).toString());
    written.add(key);
  }
  for (const [key, value] of changed) if (value !== undefined && !written.has(key)) out.push(new URLSearchParams([[key, value]]).toString());
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
