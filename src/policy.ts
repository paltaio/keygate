import { Scope, getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";

export const MAX_SOURCE_BYTES = 100 * 1024;
const HOOK_DEADLINE_MS = 50;
export const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const MESSAGE_MAX = 200;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_DENY_MESSAGE = "This request was denied by a policy";

export const POLICY_NEEDS = ["body", "responseBody"] as const;
export type PolicyNeed = (typeof POLICY_NEEDS)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface PolicyRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Json | undefined;
}

export interface PolicyResponse {
  status: number;
  headers: Record<string, string>;
  body: Json | undefined;
}

export interface PolicyContext {
  token: { id: number; name: string; scopes: string[] };
  upstream: { slug: string; name: string; base_url: string };
  origin: string | null;
  ip: string | null;
  method: string;
  bodySkipped?: "not_requested" | "too_large" | "unparsed";
}

export type PolicyDecision<T> =
  | { kind: "continue"; value: T }
  | { kind: "deny"; status: number; message: string }
  | { kind: "respond"; status: number; headers: Record<string, string>; body: Json | undefined }
  | { kind: "error"; message: string };

export interface PolicyInfo {
  name: string;
  needs: PolicyNeed[];
  onRequest: boolean;
  onResponse: boolean;
}

export interface CompiledPolicy extends PolicyInfo {
  js: string;
}

export type CompileResult = { ok: true; policy: CompiledPolicy } | { ok: false; message: string };
export type LoadResult = { ok: true; policy: Policy } | { ok: false; message: string };

/**
 * Evaluated in every context before the policy module. Returns the host entry points, which stay
 * out of reach of policy code; installs the hook globals. Policy results leave the sandbox only as
 * JSON strings produced here.
 */
const PRELUDE = String.raw`(() => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const keys = Object.keys;
  const define = Object.defineProperty;
  const freeze = Object.freeze;
  const NativeRegExp = RegExp;
  const NativePromise = Promise;
  const decisions = new WeakSet();

  const toRegExp = (pattern) => {
    if (pattern instanceof NativeRegExp) return pattern;
    if (typeof pattern !== "string") throw new TypeError("pattern must be a string or a RegExp");
    return undefined;
  };
  const glob = (pattern) =>
    new NativeRegExp("^" + pattern.replace(/[.+^$|()[\]{}\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");

  const match = (value, pattern) => {
    if (isArray(pattern)) return pattern.some((p) => match(value, p));
    const re = toRegExp(pattern);
    if (typeof value !== "string") return false;
    if (re) {
      re.lastIndex = 0;
      return re.test(value);
    }
    if (pattern.includes("*") || pattern.includes("?")) return glob(pattern).test(value);
    return value === pattern;
  };

  const replaceDeep = (value, pattern, replacement) => {
    const given = toRegExp(pattern);
    const re = given && !given.global ? new NativeRegExp(given.source, given.flags + "g") : given;
    const literal = () => replacement;
    const walk = (v) => {
      if (typeof v === "string") return re ? v.replace(re, replacement) : v.replaceAll(pattern, literal);
      if (isArray(v)) return v.map(walk);
      if (v === null || typeof v !== "object") return v;
      const out = {};
      for (const k of keys(v)) define(out, k, { value: walk(v[k]), enumerable: true, writable: true, configurable: true });
      return out;
    };
    return walk(value);
  };

  const decision = (d) => {
    freeze(d);
    decisions.add(d);
    return d;
  };

  globalThis.match = match;
  globalThis.replaceDeep = replaceDeep;
  globalThis.deny = (status, message) => decision({ kind: "deny", status: status === undefined ? 403 : status, message });
  globalThis.respond = (status, headers, body) => decision({ kind: "respond", status, headers, body });

  let subject, context, result;
  const prepare = (input, ctx) => {
    subject = context = result = undefined;
    subject = parse(input);
    context = parse(ctx);
  };
  const invoke = (hook) => {
    result = hook(subject, context);
  };
  const collect = () => {
    const s = subject;
    const r = result;
    subject = context = result = undefined;
    if (r === undefined) return stringify({ kind: "continue", value: s });
    if (decisions.has(r)) return stringify(r);
    if (r instanceof NativePromise) return stringify({ kind: "error", message: "hook returned a Promise; hooks must be synchronous" });
    return stringify({ kind: "error", message: "hook must return undefined, deny() or respond()" });
  };

  const describe = (ns) =>
    stringify({ meta: ns.meta, onRequest: typeof ns.onRequest === "function", onResponse: typeof ns.onResponse === "function" });

  return { prepare, invoke, collect, describe };
})()`;

class PolicyError extends Error {
  /** Set when the runtime must be rebuilt before its next call. */
  readonly reset: boolean;

  constructor(message: string, reset = false) {
    super(message);
    this.reset = reset;
  }
}

// Bun otherwise folds these to host constants ("function", "development") at transpile time.
const transpiler = new Bun.Transpiler({ loader: "ts", define: { require: "require", "process.env.NODE_ENV": "process.env.NODE_ENV" } });

/** Strips types, loads the module once in a fresh sandbox, and validates its exports. */
export async function compilePolicy(source: string): Promise<CompileResult> {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return { ok: false, message: `source exceeds ${MAX_SOURCE_BYTES / 1024} KB` };
  let js: string;
  try {
    js = transpiler.transformSync(source);
  } catch (e) {
    return { ok: false, message: truncate(transpileError(e)) };
  }
  const loaded = await loadPolicy(js);
  if (!loaded.ok) return loaded;
  const { name, needs, onRequest, onResponse } = loaded.policy;
  loaded.policy.dispose();
  return { ok: true, policy: { name, needs, onRequest, onResponse, js } };
}

/** Builds a reusable sandbox for compiled policy code. */
export async function loadPolicy(js: string): Promise<LoadResult> {
  const qjs = await getQuickJS();
  try {
    return { ok: true, policy: new Policy(qjs, js, new Sandbox(qjs, js)) };
  } catch (e) {
    return { ok: false, message: truncate(messageOf(e)) };
  }
}

export class Policy implements PolicyInfo {
  readonly name: string;
  readonly needs: PolicyNeed[];
  readonly onRequest: boolean;
  readonly onResponse: boolean;
  readonly js: string;
  private readonly qjs: QuickJSWASMModule;
  private sandbox: Sandbox | undefined;
  private broken: string | undefined;

  /** @internal Use loadPolicy. */
  constructor(qjs: QuickJSWASMModule, js: string, sandbox: Sandbox) {
    this.qjs = qjs;
    this.js = js;
    this.sandbox = sandbox;
    this.name = sandbox.info.name;
    this.needs = sandbox.info.needs;
    this.onRequest = sandbox.info.onRequest;
    this.onResponse = sandbox.info.onResponse;
  }

  runRequest(req: PolicyRequest, ctx: PolicyContext): PolicyDecision<PolicyRequest> {
    if (!this.onRequest) return { kind: "continue", value: req };
    return this.run("onRequest", req, ctx, (v) => requestValue(v, req.method));
  }

  runResponse(res: PolicyResponse, ctx: PolicyContext): PolicyDecision<PolicyResponse> {
    if (!this.onResponse) return { kind: "continue", value: res };
    return this.run("onResponse", res, ctx, responseValue);
  }

  dispose(): void {
    this.sandbox?.dispose();
    this.sandbox = undefined;
    this.broken = "policy is disposed";
  }

  private run<T>(hook: "onRequest" | "onResponse", subject: T, ctx: PolicyContext, value: (v: Json | undefined) => T): PolicyDecision<T> {
    const sandbox = this.sandbox ?? this.rebuild();
    if (!sandbox) return { kind: "error", message: truncate(this.broken ?? "policy is unavailable") };
    try {
      const out = sandbox.call(hook, JSON.stringify(subject), JSON.stringify(ctx));
      // An async hook leaves queued jobs that never run; drop them with the runtime.
      if (out.reset || sandbox.runtime.hasPendingJob()) {
        sandbox.dispose();
        this.sandbox = undefined;
      }
      if (!out.ok) return { kind: "error", message: truncate(out.message) };
      return decide(JSON.parse(out.json), value);
    } catch (e) {
      return { kind: "error", message: truncate(messageOf(e)) };
    }
  }

  private rebuild(): Sandbox | undefined {
    if (this.broken) return undefined;
    try {
      this.sandbox = new Sandbox(this.qjs, this.js);
      return this.sandbox;
    } catch (e) {
      this.broken = `policy failed to reload: ${messageOf(e)}`;
      return undefined;
    }
  }
}

type CallResult = { ok: true; json: string; reset: boolean } | { ok: false; message: string; reset: boolean };

/** One QuickJS runtime and context holding a loaded policy module. */
class Sandbox {
  readonly runtime: QuickJSRuntime;
  readonly info: PolicyInfo;
  private readonly vm: QuickJSContext;
  private readonly handles: QuickJSHandle[] = [];
  private readonly prepare: QuickJSHandle;
  private readonly invoke: QuickJSHandle;
  private readonly collect: QuickJSHandle;
  private readonly hooks: Partial<Record<"onRequest" | "onResponse", QuickJSHandle>> = {};
  private deadline = 0;
  private interrupted = false;

  constructor(qjs: QuickJSWASMModule, js: string) {
    this.runtime = qjs.newRuntime();
    this.runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    this.runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    this.runtime.setInterruptHandler(() => {
      if (Date.now() <= this.deadline) return false;
      this.interrupted = true;
      return true;
    });
    this.vm = this.runtime.newContext();
    try {
      const api = this.keep(this.evaluate(PRELUDE, "prelude.js", "global"));
      this.prepare = this.keep(this.vm.getProp(api, "prepare"));
      this.invoke = this.keep(this.vm.getProp(api, "invoke"));
      this.collect = this.keep(this.vm.getProp(api, "collect"));
      const describe = this.keep(this.vm.getProp(api, "describe"));
      const ns = this.keep(this.evaluate(js, "policy.js", "module"));
      const state = this.vm.getPromiseState(ns);
      if (state.type !== "fulfilled" || !state.notAPromise) {
        if (state.type === "fulfilled") state.value.dispose();
        else if (state.type === "rejected") state.error.dispose();
        throw new PolicyError("top-level await is not supported");
      }
      if (this.runtime.hasPendingJob()) throw new PolicyError("top-level promise callbacks are not supported");
      this.info = parseInfo(this.callJson(describe, [ns]));
      for (const hook of ["onRequest", "onResponse"] as const) if (this.info[hook]) this.hooks[hook] = this.keep(this.vm.getProp(ns, hook));
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  call(hook: "onRequest" | "onResponse", input: string, context: string): CallResult {
    const fn = this.hooks[hook];
    if (!fn) return { ok: false, message: `${hook} is not defined`, reset: false };
    try {
      this.callStep(this.prepare, [input, context]).dispose();
      this.callStep(this.invoke, [fn]).dispose();
      return { ok: true, json: this.callJson(this.collect, []), reset: false };
    } catch (e) {
      if (e instanceof PolicyError) return { ok: false, message: e.message, reset: e.reset };
      return { ok: false, message: messageOf(e), reset: true };
    }
  }

  dispose(): void {
    for (const h of this.handles.splice(0)) if (h.alive) h.dispose();
    if (this.vm.alive) this.vm.dispose();
    if (this.runtime.alive) this.runtime.dispose();
  }

  private keep(handle: QuickJSHandle): QuickJSHandle {
    this.handles.push(handle);
    return handle;
  }

  private evaluate(code: string, filename: string, type: "global" | "module"): QuickJSHandle {
    return this.guard(() => this.vm.evalCode(code, filename, { type }));
  }

  /** Calls a sandbox function under its own deadline; strings are passed as new sandbox strings. */
  private callStep(fn: QuickJSHandle, args: (QuickJSHandle | string)[]): QuickJSHandle {
    using scope = new Scope();
    const handles = args.map((a) => (typeof a === "string" ? scope.manage(this.vm.newString(a)) : a));
    return this.guard(() => this.vm.callFunction(fn, this.vm.undefined, handles));
  }

  private callJson(fn: QuickJSHandle, args: (QuickJSHandle | string)[]): string {
    using value = this.callStep(fn, args);
    if (this.vm.typeof(value) !== "string") throw new PolicyError("sandbox returned a non-string result");
    return this.vm.getString(value);
  }

  /** Runs code under the per-call deadline and turns a sandbox exception into a PolicyError. */
  private guard(step: () => ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle {
    this.interrupted = false;
    this.deadline = Date.now() + HOOK_DEADLINE_MS;
    const result = step();
    this.deadline = 0;
    if (!result.error) return result.value;
    const thrown: unknown = this.vm.dump(result.error);
    result.error.dispose();
    if (this.interrupted) throw new PolicyError(`exceeded the ${HOOK_DEADLINE_MS} ms time limit`);
    const message = errorMessage(thrown);
    if (/out of memory/.test(message)) throw new PolicyError(`exceeded the ${MEMORY_LIMIT_BYTES / 1024 / 1024} MB memory limit`, true);
    throw new PolicyError(message);
  }
}

function errorMessage(thrown: unknown): string {
  if (isRecord(thrown) && typeof thrown.message === "string") {
    return typeof thrown.name === "string" && thrown.name ? `${thrown.name}: ${thrown.message}` : thrown.message;
  }
  if (typeof thrown === "string") return thrown;
  return JSON.stringify(thrown) ?? String(thrown);
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function transpileError(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length > 0) return e.errors.map(messageOf).join("; ");
  return messageOf(e);
}

export function truncate(message: string): string {
  return message.slice(0, MESSAGE_MAX);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseInfo(json: string): PolicyInfo {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw) || !isRecord(raw.meta)) throw new PolicyError("the module must export meta = { name, needs? }");
  const { name, needs = [] } = raw.meta;
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new PolicyError("meta.name must be 1 to 63 lowercase letters, digits or dashes, and not start with a dash");
  if (!Array.isArray(needs) || needs.some((n) => !POLICY_NEEDS.includes(n)))
    throw new PolicyError(`meta.needs must be an array of ${POLICY_NEEDS.map((n) => `"${n}"`).join(" or ")}`);
  const onRequest = raw.onRequest === true;
  const onResponse = raw.onResponse === true;
  if (!onRequest && !onResponse) throw new PolicyError("the module must export an onRequest or onResponse function");
  return { name, needs: POLICY_NEEDS.filter((n) => needs.includes(n)), onRequest, onResponse };
}

function decide<T>(raw: Json, value: (v: Json | undefined) => T): PolicyDecision<T> {
  if (!isRecord(raw)) throw new PolicyError("invalid hook result");
  switch (raw.kind) {
    case "continue":
      return { kind: "continue", value: value(raw.value) };
    case "deny": {
      const message = raw.message ?? DEFAULT_DENY_MESSAGE;
      if (typeof message !== "string") throw new PolicyError("deny() message must be a string");
      return { kind: "deny", status: status(raw.status, 400, 499, "deny() status"), message };
    }
    case "respond":
      return {
        kind: "respond",
        status: status(raw.status, 200, 599, "respond() status"),
        headers: headers(raw.headers ?? {}, "respond() headers"),
        body: raw.body,
      };
    case "error":
      return { kind: "error", message: String(raw.message) };
    default:
      throw new PolicyError("invalid hook result");
  }
}

function requestValue(v: Json | undefined, method: string): PolicyRequest {
  if (!isRecord(v)) throw new PolicyError("req must be an object");
  if (typeof v.path !== "string" || !v.path.startsWith("/")) throw new PolicyError('req.path must be a string starting with "/"');
  if (/\\|%5c/i.test(v.path) || hasControlCharacter(v.path) || v.path.split("/").some((seg) => /^(\.|%2e){1,2}$/i.test(seg)))
    throw new PolicyError('req.path must not contain "." or ".." segments, backslashes or control characters');
  return { method, path: v.path, query: strings(v.query, "req.query"), headers: headers(v.headers, "req.headers"), body: v.body };
}

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function responseValue(v: Json | undefined): PolicyResponse {
  if (!isRecord(v)) throw new PolicyError("res must be an object");
  return { status: status(v.status, 200, 599, "res.status"), headers: headers(v.headers, "res.headers"), body: v.body };
}

function status(v: unknown, min: number, max: number, label: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PolicyError(`${label} must be an integer from ${min} to ${max}`);
  return v;
}

function strings(v: unknown, label: string): Record<string, string> {
  if (!isRecord(v)) throw new PolicyError(`${label} must be an object of strings`);
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => {
      if (typeof x !== "string") throw new PolicyError(`${label}["${k}"] must be a string`);
      return [k, x] as const;
    }),
  );
}

function headers(v: unknown, label: string): Record<string, string> {
  const lower = new Map<string, string>();
  for (const [k, x] of Object.entries(strings(v, label))) {
    const name = k.toLowerCase();
    if (lower.has(name)) throw new PolicyError(`${label}["${name}"] is set more than once`);
    lower.set(name, x);
  }
  const record = Object.fromEntries(lower);
  try {
    new Headers(record);
  } catch {
    throw new PolicyError(`${label} has an invalid header name or value`);
  }
  return record;
}
