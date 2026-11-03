import { afterAll, describe, expect, test } from "bun:test";
import { getQuickJS } from "quickjs-emscripten";
import { BLANK_POLICY, POLICY_TEMPLATES } from "../web/src/policy-templates.ts";
import { MAX_SOURCE_BYTES, MEMORY_LIMIT_BYTES, compilePolicy, loadPolicy, type Policy, type PolicyContext, type PolicyRequest, type PolicyResponse } from "./policy.ts";

const ctx: PolicyContext = {
  token: { id: 1, name: "ci", scopes: ["openai"] },
  upstream: { slug: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1" },
  origin: null,
  ip: "10.0.0.1",
  method: "POST",
};

function request(init: Partial<PolicyRequest> = {}): PolicyRequest {
  return { method: "POST", path: "/chat/completions", query: {}, headers: { "content-type": "application/json" }, body: { model: "gpt-5" }, ...init };
}

const response: PolicyResponse = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };

const loaded: Policy[] = [];
afterAll(() => {
  for (const p of loaded) p.dispose();
});

async function load(source: string): Promise<Policy> {
  const compiled = await compilePolicy(source);
  if (!compiled.ok) throw new Error(compiled.message);
  const result = await loadPolicy(compiled.policy.js);
  if (!result.ok) throw new Error(result.message);
  loaded.push(result.policy);
  return result.policy;
}

function policy(hooks: string, meta = `{ name: "test" }`): Promise<Policy> {
  return load(`export const meta = ${meta};\n${hooks}`);
}

async function onRequest(body: string, req = request()) {
  return (await policy(`export function onRequest(req, ctx) { ${body} }`)).runRequest(req, ctx);
}

/** Evaluates an expression inside a hook and returns its JSON-serializable value. */
async function evaluate(expr: string): Promise<unknown> {
  const decision = await onRequest(`req.body = ${expr};`);
  if (decision.kind !== "continue") throw new Error(JSON.stringify(decision));
  return decision.value.body;
}

describe("compilePolicy", () => {
  test("accepts TypeScript and reports meta and hooks", async () => {
    const result = await compilePolicy(`
      type Req = { headers: Record<string, string> };
      export const meta = { name: "add-team", needs: ["responseBody", "body", "body"] };
      export function onRequest(req: Req): void { req.headers["x-team"] = "ops"; }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toMatchObject({ name: "add-team", needs: ["body", "responseBody"], onRequest: true, onResponse: false });
    expect(result.policy.js).not.toContain(": Req");
  });

  test("defaults needs to empty", async () => {
    const result = await compilePolicy(`export const meta = { name: "a" }; export const onResponse = () => {};`);
    expect(result).toMatchObject({ ok: true, policy: { needs: [], onRequest: false, onResponse: true } });
  });

  const failures: [string, string, RegExp][] = [
    ["syntax error", `export const meta = { name: "a" ; export function onRequest() {}`, /Expected "}" but found ";"/],
    ["missing meta", `export function onRequest() {}`, /meta/],
    ["bad name", `export const meta = { name: "Bad_Name" }; export function onRequest() {}`, /meta\.name/],
    ["name too long", `export const meta = { name: "${"a".repeat(64)}" }; export function onRequest() {}`, /meta\.name/],
    ["bad needs", `export const meta = { name: "a", needs: ["headers"] }; export function onRequest() {}`, /meta\.needs/],
    ["needs not a list", `export const meta = { name: "a", needs: "body" }; export function onRequest() {}`, /meta\.needs/],
    ["no hooks", `export const meta = { name: "a" }; export const onRequest = 1;`, /onRequest or onResponse/],
    ["throw at load", `export const meta = { name: "a" }; export function onRequest() {} throw new Error("boom");`, /boom/],
    ["import", `import { readFileSync } from "fs"; export const meta = { name: "a" }; export function onRequest() { readFileSync("/etc/hosts"); }`, /fs/],
    ["top-level await", `export const meta = { name: "a" }; export function onRequest() {} await 0;`, /^top-level await is not supported$/],
    ["top-level promise callback", `export const meta = { name: "a" }; export function onRequest() {} Promise.resolve().then(() => {});`, /^top-level promise callbacks are not supported$/],
    ["loop at load", `export const meta = { name: "a" }; export function onRequest() {} while (true) {}`, /50 ms/],
  ];
  for (const [label, source, message] of failures) {
    test(`rejects ${label}`, async () => {
      const result = await compilePolicy(source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(message);
    });
  }

  test("rejects sources over the size limit", async () => {
    const source = `export const meta = { name: "a" }; export function onRequest() {}\n//${"x".repeat(MAX_SOURCE_BYTES)}`;
    expect(await compilePolicy(source)).toEqual({ ok: false, message: "source exceeds 100 KB" });
  });
});

describe("onRequest", () => {
  test("returning undefined continues with the request unchanged", async () => {
    const req = request({ query: { a: "1" } });
    expect(await onRequest(`return undefined;`, req)).toEqual({ kind: "continue", value: req });
  });

  test("a policy without onRequest continues the request", async () => {
    const p = await policy(`export function onResponse() { throw new Error("x"); }`);
    const req = request();
    expect(p.runRequest(req, ctx)).toEqual({ kind: "continue", value: req });
  });

  test("receives ctx", async () => {
    expect(await evaluate(`[ctx.token.name, ctx.upstream.slug, ctx.ip, ctx.origin, ctx.bodySkipped === undefined]`)).toEqual([
      "ci",
      "openai",
      "10.0.0.1",
      null,
      true,
    ]);
  });

  test("mutations to headers, query, path and body come back", async () => {
    const decision = await onRequest(
      `req.headers["x-team"] = "ops"; delete req.headers["content-type"]; req.query.limit = "5"; req.path = "/v2" + req.path; req.body.model = "gpt-5-mini";`,
      request({ query: { a: "1" } }),
    );
    expect(decision).toEqual({
      kind: "continue",
      value: { method: "POST", path: "/v2/chat/completions", query: { a: "1", limit: "5" }, headers: { "x-team": "ops" }, body: { model: "gpt-5-mini" } },
    });
  });

  test("header names a hook writes are lower-cased", async () => {
    expect(await onRequest(`req.headers["X-Team"] = "ops";`)).toMatchObject({ kind: "continue", value: { headers: { "content-type": "application/json", "x-team": "ops" } } });
    expect(await onRequest(`return respond(200, { "X-Cache": "hit" });`)).toMatchObject({ kind: "respond", headers: { "x-cache": "hit" } });
    const p = await policy(`export function onResponse(res) { res.headers["X-Policy"] = "1"; }`);
    expect(p.runResponse(response, ctx)).toMatchObject({ kind: "continue", value: { headers: { "x-policy": "1" } } });
  });

  test("method changes are ignored", async () => {
    const decision = await onRequest(`req.method = "DELETE";`);
    expect(decision.kind === "continue" && decision.value.method).toBe("POST");
  });

  test("invalid mutations are errors", async () => {
    expect(await onRequest(`req.path = "v1";`)).toEqual({ kind: "error", message: 'req.path must be a string starting with "/"' });
    for (const path of ["/../../admin", "/a/%2e%2e/b", "/a/%2E/b", "/a/./b", "/a/..", "/a\\b", "/a%5Cb", "/.\t./admin", "/a\x7fb"]) {
      expect(await onRequest(`req.path = ${JSON.stringify(path)};`)).toEqual({
        kind: "error",
        message: 'req.path must not contain "." or ".." segments, backslashes or control characters',
      });
    }
    expect(await onRequest(`req.path = "/a/..b/.c/...";`)).toMatchObject({ kind: "continue", value: { path: "/a/..b/.c/..." } });
    expect(await onRequest(`req.headers["x-n"] = 1;`)).toEqual({ kind: "error", message: 'req.headers["x-n"] must be a string' });
    expect(await onRequest(`req.query.n = true;`)).toEqual({ kind: "error", message: 'req.query["n"] must be a string' });
    expect(await onRequest(`req.headers["Content-Type"] = "text/plain";`)).toEqual({ kind: "error", message: 'req.headers["content-type"] is set more than once' });
    expect(await onRequest(`req.headers["bad name"] = "x";`)).toEqual({ kind: "error", message: "req.headers has an invalid header name or value" });
  });

  test("deny defaults to 403", async () => {
    expect(await onRequest(`return deny();`)).toEqual({ kind: "deny", status: 403, message: "This request was denied by a policy" });
  });

  test("deny with status and message", async () => {
    expect(await onRequest(`return deny(429, "slow down");`)).toEqual({ kind: "deny", status: 429, message: "slow down" });
  });

  test("deny status outside 400-499 is an error", async () => {
    for (const status of [399, 500, 404.5, "403"]) {
      expect(await onRequest(`return deny(${JSON.stringify(status)});`)).toEqual({ kind: "error", message: "deny() status must be an integer from 400 to 499" });
    }
  });

  test("respond builds a custom response", async () => {
    expect(await onRequest(`return respond(200, { "x-cache": "hit" }, { cached: true });`)).toEqual({
      kind: "respond",
      status: 200,
      headers: { "x-cache": "hit" },
      body: { cached: true },
    });
    expect(await onRequest(`return respond(204);`)).toEqual({ kind: "respond", status: 204, headers: {}, body: undefined });
    expect(await onRequest(`return respond(200, {}, "plain");`)).toMatchObject({ kind: "respond", body: "plain" });
  });

  test("other return values are errors", async () => {
    expect(await onRequest(`return { kind: "deny", status: 403 };`)).toEqual({ kind: "error", message: "hook must return undefined, deny() or respond()" });
    expect(await onRequest(`return false;`)).toMatchObject({ kind: "error" });
  });

  test("an async hook is an error and the runtime is rebuilt", async () => {
    const p = await policy(`let calls = 0; export async function onRequest(req) { calls++; await null; } export function onResponse(res) { res.headers.calls = String(calls); }`);
    expect(p.runRequest(request(), ctx)).toEqual({ kind: "error", message: "hook returned a Promise; hooks must be synchronous" });
    expect(p.runResponse(response, ctx)).toMatchObject({ kind: "continue", value: { headers: { calls: "0" } } });
  });

  test("a throw is an error", async () => {
    expect(await onRequest(`throw new TypeError("nope");`)).toEqual({ kind: "error", message: "TypeError: nope" });
    expect(await onRequest(`throw "raw";`)).toEqual({ kind: "error", message: "raw" });
  });

  test("long messages are cut to 200 characters", async () => {
    const decision = await onRequest(`throw new Error("x".repeat(500));`);
    expect(decision.kind === "error" && decision.message.length).toBe(200);
  });

  test("an endless loop is stopped after about 50 ms and the policy keeps working", async () => {
    const p = await policy(`export function onRequest(req) { if (req.body.loop) while (true) {} req.headers.ok = "1"; }`);
    const started = performance.now();
    expect(p.runRequest(request({ body: { loop: true } }), ctx)).toEqual({ kind: "error", message: "exceeded the 50 ms time limit" });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(250);
    expect(p.runRequest(request({ body: {} }), ctx)).toMatchObject({ kind: "continue", value: { headers: { ok: "1" } } });
  });

  test("deep recursion hits the stack limit", async () => {
    expect(await onRequest(`const f = (n) => f(n + 1) + 1; f(0);`)).toEqual({ kind: "error", message: "InternalError: stack overflow" });
  });

  test("a 100 MB allocation hits the memory limit, wasm memory stays bounded, and the runtime is rebuilt", async () => {
    const memory = (await getQuickJS()).getWasmMemory();
    const p = await policy(
      `let calls = 0;
       export function onRequest(req) {
         calls++;
         if (req.body.big) { const mb = "x".repeat(1024 * 1024); const parts = []; for (let i = 0; i < 100; i++) parts.push(mb + i); req.body = parts.join("").length; }
         req.headers.calls = String(calls);
       }`,
    );
    expect(p.runRequest(request({ body: {} }), ctx)).toMatchObject({ kind: "continue", value: { headers: { calls: "1" } } });
    const before = memory.buffer.byteLength;
    expect(p.runRequest(request({ body: { big: true } }), ctx)).toEqual({ kind: "error", message: "exceeded the 16 MB memory limit" });
    const first = memory.buffer.byteLength;
    expect(first - before).toBeLessThanOrEqual(3 * MEMORY_LIMIT_BYTES);
    for (let i = 0; i < 3; i++) expect(p.runRequest(request({ body: { big: true } }), ctx)).toMatchObject({ kind: "error" });
    expect(memory.buffer.byteLength).toBe(first);
    expect(p.runRequest(request({ body: {} }), ctx)).toMatchObject({ kind: "continue", value: { headers: { calls: "1" } } });
  });

  test("host capabilities are absent", async () => {
    expect(
      await evaluate(`[typeof fetch, typeof require, typeof Bun, typeof process, typeof XMLHttpRequest, typeof setTimeout, typeof globalThis.run, typeof globalThis.describe]`),
    ).toEqual(Array(8).fill("undefined"));
    expect(await onRequest(`req.body = process.env.NODE_ENV;`)).toEqual({ kind: "error", message: "ReferenceError: 'process' is not defined" });
  });
});

describe("onResponse", () => {
  test("status, header and body edits come back", async () => {
    const p = await policy(`export function onResponse(res) { res.status = 202; res.headers["x-policy"] = "1"; res.body = { wrapped: res.body }; }`);
    expect(p.runResponse(response, ctx)).toEqual({ kind: "continue", value: { status: 202, headers: { "content-type": "application/json", "x-policy": "1" }, body: { wrapped: { ok: true } } } });
  });

  test("invalid status is an error", async () => {
    const p = await policy(`export function onResponse(res) { res.status = 99; }`);
    expect(p.runResponse(response, ctx)).toEqual({ kind: "error", message: "res.status must be an integer from 200 to 599" });
  });

  test("deny replaces the response", async () => {
    const p = await policy(`export function onResponse(res) { if (res.status === 200) return deny(451, "blocked"); }`);
    expect(p.runResponse(response, ctx)).toEqual({ kind: "deny", status: 451, message: "blocked" });
  });
});

describe("match", () => {
  const cases: [string, boolean][] = [
    [`match("gpt-5", "gpt-5")`, true],
    [`match("gpt-5", "gpt-4")`, false],
    [`match("gpt-5-mini", "gpt-*")`, true],
    [`match("claude", "gpt-*")`, false],
    [`match("gpt-5", "gpt-?")`, true],
    [`match("gpt-55", "gpt-?")`, false],
    [`match("a.b", "a?b")`, true],
    [`match("axb", "a.*")`, false],
    [`match("gpt-5", "/^gpt-/i")`, false],
    [`match("gpt-5", /^gpt/)`, true],
    [`match("claude-4", /^gpt/)`, false],
    [`match("claude-4", ["gpt-*", /^claude/])`, true],
    [`match("o3", ["gpt-*", /^claude/])`, false],
    [`match(5, "5")`, false],
  ];
  for (const [expr, expected] of cases) {
    test(expr, async () => {
      expect(await evaluate(expr)).toBe(expected);
    });
  }

  test("a non-string pattern is an error", async () => {
    expect(await onRequest(`match("a", 1);`)).toMatchObject({ kind: "error", message: expect.stringContaining("pattern must be") });
  });
});

describe("replaceDeep", () => {
  test("string pattern replaces every occurrence in nested strings and leaves keys alone", async () => {
    expect(await evaluate(`replaceDeep({ secret: "a secret and a secret", list: ["secret", 1, null, { secret: true }] }, "secret", "***")`)).toEqual({
      secret: "a *** and a ***",
      list: ["***", 1, null, { secret: true }],
    });
  });

  test("regex patterns", async () => {
    expect(await evaluate(`replaceDeep({ a: "sk-123 sk-456", b: ["SK-7"] }, /sk-\\d+/gi, "[key]")`)).toEqual({ a: "[key] [key]", b: ["[key]"] });
    expect(await evaluate(`replaceDeep({ a: "SK-1 sk-2", b: ["sk-3 sk-4"] }, /sk-\\d/i, "x")`)).toEqual({ a: "x x", b: ["x x"] });
  });

  test("string patterns and replacements are literal", async () => {
    expect(await evaluate(`replaceDeep(["sk-1 sk-2"], "/sk-\\\\d/", "x")`)).toEqual(["sk-1 sk-2"]);
    expect(await evaluate(`replaceDeep("price 5", "5", "$$5")`)).toBe("price $$5");
  });

  test("returns a copy", async () => {
    expect(await evaluate(`(() => { const v = { a: ["x"] }; const c = replaceDeep(v, "x", "y"); return [v.a[0], c.a[0], c !== v]; })()`)).toEqual(["x", "y", true]);
  });

  test("keeps __proto__ as a plain key", async () => {
    expect(await evaluate(`replaceDeep(JSON.parse('{"__proto__": {"a": "x"}}'), "x", "y")`)).toEqual(JSON.parse(`{"__proto__": {"a": "y"}}`));
  });
});

describe("dashboard policy templates", () => {
  async function template(id: string): Promise<Policy> {
    const source = POLICY_TEMPLATES.find((t) => t.id === id)?.source;
    if (!source) throw new Error(`no template ${id}`);
    return load(source);
  }

  test("all compile", async () => {
    for (const source of [BLANK_POLICY, ...POLICY_TEMPLATES.map((t) => t.source)]) {
      const compiled = await compilePolicy(source);
      expect(compiled.ok ? "ok" : compiled.message).toBe("ok");
    }
  });

  test("deny-models denies a matching model and an unchecked body", async () => {
    const p = await template("deny-models");
    expect(p.runRequest(request({ body: { model: "gpt-4o" } }), ctx)).toMatchObject({ kind: "deny", status: 403 });
    expect(p.runRequest(request(), ctx).kind).toBe("continue");
    expect(p.runRequest(request({ body: undefined }), { ...ctx, bodySkipped: "too_large" })).toMatchObject({ kind: "deny", status: 400 });
  });

  test("redact-body replaces emails and the literal string, and denies an unchecked body", async () => {
    const p = await template("redact-body");
    const decision = p.runRequest(request({ body: { messages: [{ content: "mail a.b@example.com about Project Falcon" }] } }), ctx);
    expect(decision).toMatchObject({ kind: "continue", value: { body: { messages: [{ content: "mail [email] about [redacted]" }] } } });
    expect(p.runRequest(request({ body: undefined }), { ...ctx, bodySkipped: "too_large" })).toMatchObject({ kind: "deny", status: 400 });
    expect(p.runRequest(request({ method: "GET", body: undefined }), ctx).kind).toBe("continue");
  });

  test("add-header sets the token name", async () => {
    const p = await template("add-header");
    expect(p.runRequest(request(), ctx)).toMatchObject({ kind: "continue", value: { headers: { "x-client": "ci" } } });
  });

  test("block-paths matches encoded and doubled slashes", async () => {
    const p = await template("block-paths");
    for (const path of ["/files", "/Files/abc", "//files/x", "/%66iles"]) expect(p.runRequest(request({ path }), ctx).kind).toBe("deny");
    expect(p.runRequest(request({ path: "/filesystem" }), ctx).kind).toBe("continue");
  });
});
