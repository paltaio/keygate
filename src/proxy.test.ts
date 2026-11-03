import { beforeEach, describe, expect, test } from "bun:test";
import { loadEnv } from "./env.ts";
import { PolicyCache, type PolicyLease } from "./policies.ts";
import { compilePolicy } from "./policy.ts";
import { clientIp, createProxy, resolveTarget, serveDirectory } from "./proxy.ts";
import { Store, type Placement } from "./store.ts";

const env = loadEnv({ KEYGATE_HOST: "keygate.test", KEYGATE_DATA_DIR: ":memory:" });

describe("resolveTarget", () => {
  test("subdomain", () => {
    expect(resolveTarget(new URL("http://x/v1/a?b=1"), "exa.keygate.test:3000", "keygate.test")).toEqual({ slug: "exa", path: "/v1/a" });
  });
  test("path prefix", () => {
    expect(resolveTarget(new URL("http://keygate.test/exa/v1/a"), "keygate.test", "keygate.test")).toEqual({ slug: "exa", path: "/v1/a" });
    expect(resolveTarget(new URL("http://keygate.test/exa"), "keygate.test", "keygate.test")).toEqual({ slug: "exa", path: "/" });
  });
  test("reserved and root", () => {
    expect(resolveTarget(new URL("http://keygate.test/admin/x"), "keygate.test", "keygate.test")).toBeUndefined();
    expect(resolveTarget(new URL("http://keygate.test/"), "keygate.test", "keygate.test")).toBeUndefined();
  });
});

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
}

const apiKeyHeader: Placement[] = [{ type: "header", name: "x-api-key", value: "{{key}}" }];

function setup(placements: Placement[], respond?: () => Response, secrets: Record<string, string> = { key: "REAL" }) {
  const store = new Store(":memory:");
  const captured: Captured[] = [];
  const upstreamId = store.createUpstream({ slug: "up", name: "Up", base_url: "https://up.example/base", placements, strategy: "active", notes: "", docs: "" });
  const userId = store.createUser("a@b.c", "A", "x");
  const keyId = store.addKey(upstreamId, "k1", secrets, true, userId);
  const { id: tokenId, token } = store.createToken({ name: "t", scopes: ["up"], origins: ["https://app.test"], expires_at: null }, userId);
  const proxy = createProxy({
    store,
    env,
    fetch: async (url, init) => {
      const req = new Request(url, init);
      const bytes = new Uint8Array(await req.arrayBuffer());
      captured.push({ url: req.url, method: req.method, headers: req.headers, body: new TextDecoder().decode(bytes), bytes });
      return respond ? respond() : new Response("upstream-body", { status: 200, headers: { "x-up": "1", "content-encoding": "gzip" } });
    },
  });
  return { store, proxy, token, tokenId, keyId, captured };
}

describe("proxy", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(apiKeyHeader);
  });

  test("swaps the token for the key, joins the path, strips hop headers", async () => {
    const res = await ctx.proxy(
      new Request("http://keygate.test/up/v1/search?q=1", {
        method: "POST",
        headers: { "x-api-key": ctx.token, "content-type": "application/json", cookie: "kg_session=abc; other=1", "accept-encoding": "br" },
        body: '{"a":1}',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-body");
    expect(res.headers.get("x-up")).toBe("1");
    expect(res.headers.has("content-encoding")).toBe(false);
    const sent = ctx.captured[0];
    expect(sent?.url).toBe("https://up.example/base/v1/search?q=1");
    expect(sent?.headers.get("x-api-key")).toBe("REAL");
    expect(sent?.headers.get("cookie")).toBe("other=1");
    expect(sent?.headers.has("accept-encoding")).toBe(false);
    expect(sent?.body).toBe('{"a":1}');
    const [log] = ctx.store.requests({ limit: 10 });
    expect(log?.status).toBe(200);
    expect(log?.bytes_out).toBe("upstream-body".length);
    expect(log?.path).toBe("/v1/search");
  });

  test("subdomain routing", async () => {
    const res = await ctx.proxy(new Request("http://x/v1/a", { headers: { host: "up.keygate.test", "x-keygate-token": ctx.token } }));
    expect(res.status).toBe(200);
    expect(ctx.captured[0]?.url).toBe("https://up.example/base/v1/a");
  });

  test("missing, unknown, and out-of-scope tokens", async () => {
    expect((await ctx.proxy(new Request("http://keygate.test/up/x"))).status).toBe(401);
    expect((await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": "kg_nope" } }))).status).toBe(401);
    const other = ctx.store.createToken({ name: "o", scopes: ["else"], origins: [], expires_at: null }, 1).token;
    const res = await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": other } }));
    expect(res.status).toBe(403);
    expect(ctx.captured).toHaveLength(0);
    expect(ctx.store.requests({ limit: 10, status: "proxy_error" })).toHaveLength(3);
    expect(ctx.store.requests({ limit: 10, status: "client_error" })).toHaveLength(0);
  });

  test("llms.txt is public and carries the docs", async () => {
    const upstream = ctx.store.upstreamBySlug("up");
    if (!upstream) throw new Error("upstream missing");
    ctx.store.updateUpstream(upstream.id, { slug: "up", name: "Up", base_url: "https://up.example/base", placements: apiKeyHeader, strategy: "active", notes: "private", docs: "## Search\n\nPOST /v1/search" });
    const res = await ctx.proxy(new Request("http://keygate.test/up/llms.txt"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toStartWith("# Up\n");
    expect(text).toContain("`https://keygate.test/up` or `https://up.keygate.test`");
    expect(text).toContain("`x-api-key: kg_...`");
    expect(text).toEndWith("## Search\n\nPOST /v1/search\n");
    expect(text).not.toContain("private");
    const sub = await ctx.proxy(new Request("http://x/llms.txt", { headers: { host: "up.keygate.test" } }));
    expect(await sub.text()).toBe(text);
    expect(ctx.captured).toHaveLength(0);
  });

  test("root llms.txt lists the upstreams a token reaches", async () => {
    ctx.store.createUpstream({ slug: "other", name: "Other", base_url: "https://other.example", placements: apiKeyHeader, strategy: "active", notes: "", docs: "" });
    const anonymous = await serveDirectory(ctx.store, env, new Request("http://keygate.test/llms.txt")).text();
    expect(anonymous).toStartWith("# keygate\n");
    expect(anonymous).not.toContain("/up/llms.txt)");
    const scoped = await serveDirectory(ctx.store, env, new Request("http://keygate.test/llms.txt", { headers: { authorization: `Bearer ${ctx.token}` } })).text();
    expect(scoped).toContain("- [Up](https://keygate.test/up/llms.txt): `https://keygate.test/up` to https://up.example/base");
    expect(scoped).not.toContain("Other");
    expect(serveDirectory(ctx.store, env, new Request("http://keygate.test/llms.txt?keygate_token=kg_nope")).status).toBe(401);
  });

  test("unknown upstream is refused and logged", async () => {
    expect((await ctx.proxy(new Request("http://keygate.test/nope/x"))).status).toBe(404);
    const [row] = ctx.store.requests({ limit: 1 });
    expect(row?.upstream_id).toBeNull();
    expect(row?.error).toBe("unknown_upstream");
    expect(ctx.store.statsSince("2000-01-01")).toEqual([{ upstream_id: null, requests: 1, errors: 0, rejected: 1, avg_latency_ms: null }]);
  });

  test("origin allowlist and preflight", async () => {
    const ok = await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": ctx.token, origin: "https://app.test" } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.test");
    const bad = await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": ctx.token, origin: "https://evil.test" } }));
    expect(bad.status).toBe(403);
    const preflight = await ctx.proxy(
      new Request("http://keygate.test/up/x", { method: "OPTIONS", headers: { origin: "https://app.test", "access-control-request-method": "POST", "access-control-request-headers": "x-api-key" } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toBe("x-api-key");
    const denied = await ctx.proxy(new Request("http://keygate.test/up/x", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } }));
    expect(denied.status).toBe(403);
  });

  test("no active key", async () => {
    ctx.store.revokeKey(ctx.keyId);
    const res = await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": ctx.token } }));
    expect(res.status).toBe(503);
  });

  test("upstream 401 flags the key, 200 clears it", async () => {
    let status = 401;
    const c = setup(apiKeyHeader, () => new Response("x", { status }));
    await (await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }))).text();
    expect(c.store.keyById(c.keyId)?.failing_status).toBe(401);
    status = 200;
    await (await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }))).text();
    expect(c.store.keyById(c.keyId)?.failing_at).toBeNull();
  });

  test("upstream failure is a 502 with a log row", async () => {
    const c = setup(apiKeyHeader, () => {
      throw new Error("connect ECONNREFUSED");
    });
    const res = await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }));
    expect(res.status).toBe(502);
    expect(c.store.requests({ limit: 1 })[0]?.error).toBe("upstream_unreachable");
  });

  test("query, cookie, json and form slots", async () => {
    const q = setup([{ type: "query", name: "key", value: "{{key}}" }]);
    await q.proxy(new Request(`http://keygate.test/up/x?key=${q.token}&a=1`));
    expect(q.captured[0]?.url).toBe("https://up.example/base/x?a=1&key=REAL");

    const ck = setup([{ type: "cookie", name: "sid", value: "{{key}}" }]);
    await ck.proxy(new Request("http://keygate.test/up/x", { headers: { cookie: `sid=${ck.token}` } }));
    expect(ck.captured[0]?.headers.get("cookie")).toBe("sid=REAL");

    const j = setup([{ type: "json", name: "api_key", value: "{{key}}" }]);
    await j.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: j.token, q: 1 }) }));
    expect(JSON.parse(j.captured[0]?.body ?? "")).toEqual({ q: 1, api_key: "REAL" });

    const f = setup([{ type: "form", name: "api_key", value: "{{key}}" }]);
    await f.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `api_key=${f.token}&q=1` }));
    expect(f.captured[0]?.body).toBe("q=1&api_key=REAL");

    const bad = setup([{ type: "json", name: "api_key", value: "{{key}}" }]);
    const res = await bad.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { "content-type": "application/json", "x-keygate-token": bad.token }, body: "[1]" }));
    expect(res.status).toBe(400);
  });

  test("several placements filled from one credential", async () => {
    const multi: Placement[] = [
      { type: "header", name: "authorization", value: "Bearer {{token}}" },
      { type: "header", name: "x-api-key", value: "{{key}}" },
      { type: "query", name: "client", value: "{{client_id}}" },
      { type: "json", name: "client_secret", value: "{{client_secret}}" },
    ];
    const c = setup(multi, undefined, { token: "T", key: "K", client_id: "C", client_secret: "S" });
    const res = await c.proxy(
      new Request("http://keygate.test/up/x?a=1", {
        method: "POST",
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
        body: JSON.stringify({ q: 1 }),
      }),
    );
    expect(res.status).toBe(200);
    const sent = c.captured[0];
    expect(sent?.url).toBe("https://up.example/base/x?a=1&client=C");
    expect(sent?.headers.get("authorization")).toBe("Bearer T");
    expect(sent?.headers.get("x-api-key")).toBe("K");
    expect(JSON.parse(sent?.body ?? "")).toEqual({ q: 1, client_secret: "S" });
  });

  test("constant-only placements need no credential", async () => {
    const c = setup([{ type: "header", name: "x-client", value: "keygate" }]);
    c.store.revokeKey(c.keyId);
    const res = await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }));
    expect(res.status).toBe(200);
    expect(c.captured[0]?.headers.get("x-client")).toBe("keygate");
  });

  test("round robin skips incomplete credentials; editing completes one", async () => {
    const two: Placement[] = [
      { type: "header", name: "authorization", value: "Bearer {{token}}" },
      { type: "header", name: "x-api-key", value: "{{key}}" },
    ];
    const c = setup(two, undefined, { token: "T1", key: "K1" });
    const upstream = c.store.upstreamBySlug("up");
    if (!upstream) throw new Error("upstream missing");
    c.store.updateUpstream(upstream.id, { slug: "up", name: "Up", base_url: "https://up.example/base", placements: two, strategy: "round_robin", notes: "", docs: "" });
    const partial = c.store.addKey(upstream.id, "k2", { token: "T2" }, false, 1);
    const call = async () => {
      await (await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }))).text();
      return c.captured.at(-1)?.headers.get("x-api-key");
    };
    expect([await call(), await call()]).toEqual(["K1", "K1"]);
    expect(c.store.updateKey(partial, { secrets: { key: "K2" } })).toBe(true);
    expect([await call(), await call()]).toEqual(["K1", "K2"]);
    expect(c.store.updateKey(partial, { label: "renamed", secrets: { key: null } })).toBe(true);
    expect(c.store.keyById(partial)?.label).toBe("renamed");
    expect([await call(), await call()]).toEqual(["K1", "K1"]);
  });

  test("credential lacking a placeholder value is a 503", async () => {
    const c = setup([{ type: "header", name: "authorization", value: "Bearer {{token}}" }], undefined, { key: "K" });
    const res = await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }));
    expect(res.status).toBe(503);
    expect(c.store.requests({ limit: 1 })[0]?.error).toBe("credential_incomplete");
  });

  test("disabled token and disabled active credential", async () => {
    const tokenId = ctx.store.tokens()[0]?.id ?? 0;
    ctx.store.setTokenEnabled(tokenId, false);
    expect((await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": ctx.token } }))).status).toBe(401);
    expect(ctx.store.originAllowed("up", "https://app.test")).toBe(false);
    ctx.store.setTokenEnabled(tokenId, true);
    ctx.store.setKeyEnabled(ctx.keyId, false);
    expect((await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": ctx.token } }))).status).toBe(503);
    ctx.store.setKeyEnabled(ctx.keyId, true);
    expect((await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": ctx.token } }))).status).toBe(200);
  });

  test("unusable tokens get their code and message from the proxy and the directory", async () => {
    const expired = ctx.store.createToken({ name: "e", scopes: ["up"], origins: [], expires_at: "2020-01-01T00:00:00Z" }, 1);
    const disabled = ctx.store.createToken({ name: "d", scopes: ["up"], origins: [], expires_at: null }, 1);
    ctx.store.setTokenEnabled(disabled.id, false);
    const cases: [string, string, string][] = [
      ["kg_nope", "invalid_token", "This token is unknown or revoked"],
      [disabled.token, "disabled_token", "This token is disabled"],
      [expired.token, "expired_token", "This token has expired"],
    ];
    for (const [token, code, message] of cases) {
      const proxied = await ctx.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": token } }));
      const listed = serveDirectory(ctx.store, env, new Request("http://keygate.test/llms.txt", { headers: { "x-keygate-token": token } }));
      for (const res of [proxied, listed]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: code, message });
      }
    }
    expect(ctx.store.requests({ limit: 3 }).map((r) => r.token_id)).toEqual([expired.id, disabled.id, null]);
  });

  test("round robin takes turns and sits out a flagged credential", async () => {
    let status = 200;
    const c = setup(apiKeyHeader, () => new Response("x", { status }));
    const upstream = c.store.upstreamBySlug("up");
    if (!upstream) throw new Error("upstream missing");
    c.store.updateUpstream(upstream.id, { slug: "up", name: "Up", base_url: "https://up.example/base", placements: apiKeyHeader, strategy: "round_robin", notes: "", docs: "" });
    const k2 = c.store.addKey(upstream.id, "k2", { key: "SECOND" }, false, 1);
    c.store.addKey(upstream.id, "k3", { key: "THIRD" }, false, 1);
    const call = async () => {
      await (await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }))).text();
      return c.captured.at(-1)?.headers.get("x-api-key");
    };
    expect([await call(), await call(), await call(), await call()]).toEqual(["REAL", "SECOND", "THIRD", "REAL"]);
    status = 401;
    expect(await call()).toBe("SECOND");
    status = 200;
    expect([await call(), await call(), await call()]).toEqual(["THIRD", "REAL", "THIRD"]);
    c.store.setKeyEnabled(k2, false);
    c.store.setKeyEnabled(ctx.keyId, true);
    expect(c.store.liveKeys(upstream.id).map((k) => k.label)).toEqual(["k1", "k3"]);
  });

  test("streams the upstream body through", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\n"));
        controller.enqueue(new TextEncoder().encode("data: b\n\n"));
        controller.close();
      },
    });
    const c = setup(apiKeyHeader, () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const res = await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }));
    expect(await res.text()).toBe("data: a\n\ndata: b\n\n");
    expect(c.store.requests({ limit: 1 })[0]?.bytes_out).toBe(18);
  });
});

type Setup = ReturnType<typeof setup>;

function responseHook(name: string, body: string, needs: string[] = []): string {
  return `export const meta = { name: "${name}", needs: ${JSON.stringify(needs)} };\nexport function onResponse(res, ctx) {\n${body}\n}`;
}

function hook(name: string, body: string, needs: string[] = []): string {
  return `export const meta = { name: "${name}", needs: ${JSON.stringify(needs)} };\nexport function onRequest(req, ctx) {\n${body}\n}`;
}

async function addPolicy(store: Store, source: string): Promise<number> {
  const compiled = await compilePolicy(source);
  if (!compiled.ok) throw new Error(compiled.message);
  const { name, needs, js } = compiled.policy;
  return store.createPolicy({ name, source, compiled: js, needs }, 1);
}

async function attach(c: Setup, sources: string[], tokenId = c.tokenId): Promise<number[]> {
  const ids: number[] = [];
  for (const source of sources) ids.push(await addPolicy(c.store, source));
  const result = c.store.setTokenPolicies(
    tokenId,
    ids.map((policy_id) => ({ policy_id, enabled: true })),
  );
  if (!result.ok) throw new Error(result.error);
  return ids;
}

interface Call {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
  /** null sends no token header. */
  token?: string | null;
  ip?: string;
}

/** Sends a request through the proxy with the token header and, with a body, its Content-Length. */
function call(c: Setup, path: string, init: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.token === null ? {} : { "x-keygate-token": init.token ?? c.token }), ...init.headers };
  if (init.body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(typeof init.body === "string" ? Buffer.byteLength(init.body) : init.body.byteLength);
  }
  const req = new Request(`http://keygate.test/up${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body ?? null });
  return c.proxy(req, init.ip);
}

const json = { "content-type": "application/json" };
const form = { "content-type": "application/x-www-form-urlencoded" };

describe("request policies", () => {
  test("a policy that returns nothing leaves the request as sent", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("noop", "", ["body"])]);
    const res = await call(c, "/x?b=%7E&a=1", { headers: json, body: '{ "a" : 1 }' });
    expect(res.status).toBe(200);
    await res.text();
    const sent = c.captured[0];
    expect(sent?.url).toBe("https://up.example/base/x?b=%7E&a=1");
    expect(sent?.body).toBe('{ "a" : 1 }');
    expect(sent?.headers.get("x-api-key")).toBe("REAL");
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ status: 200, error: null, policy: null });
  });

  test("ctx carries the token, upstream, origin, ip and method", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("ctx", `req.headers["x-ctx"] = JSON.stringify(ctx);`)]);
    await call(c, "/x", { method: "PUT", headers: { origin: "https://app.test" }, ip: "10.0.0.1" });
    expect(JSON.parse(c.captured[0]?.headers.get("x-ctx") ?? "")).toEqual({
      token: { id: c.tokenId, name: "t", scopes: ["up"] },
      upstream: { slug: "up", name: "Up", base_url: "https://up.example/base" },
      origin: "https://app.test",
      ip: "10.0.0.1",
      method: "PUT",
    });
    await call(c, "/x");
    expect(JSON.parse(c.captured[1]?.headers.get("x-ctx") ?? "").ip).toBeNull();
  });

  test("header and body changes reach the upstream; credentials are added after", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [
      hook(
        "edit",
        `req.headers["x-seen"] = Object.keys(req.headers).filter((k) => k.startsWith("x-")).join(",");
        req.headers["X-Team"] = "ops";
        delete req.headers["x-drop"];
        req.body.model = "small";`,
        ["body"],
      ),
    ]);
    const res = await call(c, "/x", { token: null, headers: { ...json, "x-api-key": c.token, "x-drop": "1" }, body: '{"model":"big","n":1}' });
    expect(res.status).toBe(200);
    await res.text();
    const sent = c.captured[0];
    expect(sent?.headers.get("x-seen")).toBe("x-drop");
    expect(sent?.headers.get("x-team")).toBe("ops");
    expect(sent?.headers.has("x-drop")).toBe(false);
    expect(sent?.headers.get("x-api-key")).toBe("REAL");
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "")).toEqual({ model: "small", n: 1 });
    expect(c.store.requests({ limit: 1 })[0]?.policy).toBeNull();
  });

  test("a JSON body the placements parse is shared without the token slot", async () => {
    const c = setup([{ type: "json", name: "api_key", value: "{{key}}" }]);
    await attach(c, [hook("keys", `req.headers["x-keys"] = Object.keys(req.body).join(","); req.body.q = 2;`, ["body"])]);
    await call(c, "/x", { token: null, headers: json, body: JSON.stringify({ api_key: c.token, q: 1 }) });
    const sent = c.captured[0];
    expect(sent?.headers.get("x-keys")).toBe("q");
    expect(JSON.parse(sent?.body ?? "")).toEqual({ q: 2, api_key: "REAL" });
  });

  test("query keys are edited one by one; untouched pairs keep their order and encoding", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("query", `req.headers["x-a"] = req.query.a; req.query.b = "9"; delete req.query.d; req.query.e = "new value";`)]);
    await call(c, "/x?a=1&b=2&a=3&c=%7E&d=4&d=5");
    expect(c.captured[0]?.headers.get("x-a")).toBe("1");
    expect(c.captured[0]?.url).toBe("https://up.example/base/x?a=1&b=9&c=%7E&e=new+value");
  });

  test("form fields are edited one by one", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("form", `req.headers["x-a"] = req.body.a; req.body.b = "9";`, ["body"])]);
    await call(c, "/x", { headers: form, body: "a=1&b=2&a=3&c=x%20y" });
    const sent = c.captured[0];
    expect(sent?.headers.get("x-a")).toBe("1");
    expect(sent?.body).toBe("a=1&b=9&c=x%20y");
    expect(sent?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  test("repeated query keys go out as the first pair, the one the policy saw", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("models", `if (match(req.query.model, "gpt-4")) return deny(403, "Model not allowed");`)]);
    expect((await call(c, "/x?model=gpt-4&model=ok")).status).toBe(403);
    expect((await call(c, "/x?model=ok&n=%7E&model=gpt-4&n=2")).status).toBe(200);
    expect(c.captured.map((s) => s.url)).toEqual(["https://up.example/base/x?model=ok&n=%7E"]);

    const other = c.store.createToken({ name: "o", scopes: ["up"], origins: [], expires_at: null }, 1);
    await attach(c, [responseHook("response-only", "")], other.id);
    await call(c, "/x?model=ok&model=gpt-4", { token: other.token });
    expect(c.captured[1]?.url).toBe("https://up.example/base/x?model=ok&model=gpt-4");
  });

  test("repeated form keys go out as the first pair; JSON bodies keep duplicate keys", async () => {
    const policy = hook("models", `if (match(req.body?.model, "gpt-4")) return deny(403, "Model not allowed");`, ["body"]);
    const c = setup(apiKeyHeader);
    await attach(c, [policy]);
    expect((await call(c, "/x", { headers: form, body: "model=gpt-4&model=ok" })).status).toBe(403);
    expect((await call(c, "/x", { headers: form, body: "model=ok&n=%7E&model=gpt-4" })).status).toBe(200);
    expect((await call(c, "/x", { headers: form, body: "model=ok&n=1" })).status).toBe(200);
    expect((await call(c, "/x", { headers: json, body: '{"model":"ok","n":1,"n":2}' })).status).toBe(200);
    expect(c.captured.map((s) => s.body)).toEqual(["model=ok&n=%7E", "model=ok&n=1", '{"model":"ok","n":1,"n":2}']);

    const placed = setup([{ type: "form", name: "api_key", value: "{{key}}" }]);
    await attach(placed, [policy]);
    expect((await call(placed, "/x", { token: null, headers: form, body: `api_key=${placed.token}&model=gpt-4&model=ok` })).status).toBe(403);
    expect((await call(placed, "/x", { token: null, headers: form, body: `api_key=${placed.token}&model=ok&model=gpt-4` })).status).toBe(200);
    expect(placed.captured.map((s) => s.body)).toEqual(["model=ok&api_key=REAL"]);
  });

  test("a rewritten body keeps a media type that still names its kind", async () => {
    const edit = hook(
      "retype",
      `if (req.headers["x-mode"] === "own") req.headers["content-type"] = "text/plain";
      if (req.headers["x-mode"] === "drop") delete req.headers["content-type"];
      req.body.a = typeof req.body.a === "string" ? "2" : 2;`,
      ["body"],
    );
    const c = setup(apiKeyHeader);
    await attach(c, [edit]);
    const cases: [Record<string, string>, string, string][] = [
      [{ "content-type": "application/vnd.api+json; charset=utf-8" }, '{"a":1}', "application/vnd.api+json; charset=utf-8"],
      [{ ...json, "x-mode": "own" }, '{"a":1}', "text/plain"],
      [{ ...json, "x-mode": "drop" }, '{"a":1}', "application/json"],
      [{ "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, "a=1", "application/x-www-form-urlencoded; charset=utf-8"],
      [{ ...form, "x-mode": "drop" }, "a=1", "application/x-www-form-urlencoded"],
    ];
    for (const [headers, body] of cases) expect((await call(c, "/x", { headers, body })).status).toBe(200);
    expect(c.captured.map((s) => s.headers.get("content-type"))).toEqual(cases.map(([, , type]) => type));
    expect(c.captured.map((s) => s.body)).toEqual(['{"a":2}', '{"a":2}', '{"a":2}', "a=2", "a=2"]);

    const placed = setup([{ type: "json", name: "api_key", value: "{{key}}" }]);
    await attach(placed, [edit]);
    await call(placed, "/x", { headers: { "content-type": "application/problem+json" }, body: '{"a":1}' });
    await call(placed, "/x", { headers: { ...json, "x-mode": "own" }, body: '{"a":1}' });
    expect(placed.captured.map((s) => s.headers.get("content-type"))).toEqual(["application/problem+json", "text/plain"]);
  });

  test("a path rewrite is joined under the base URL", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("path", `req.path = "/v2" + req.path;`)]);
    await call(c, "/x?q=1");
    expect(c.captured[0]?.url).toBe("https://up.example/base/v2/x?q=1");
  });

  test("deny answers with the policy's status and logs the policy", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("gate", `if (req.headers["x-model"] === "big") return deny(429, "too big"); if (req.headers["x-model"] === "huge") return deny();`)]);
    const res = await call(c, "/x", { headers: { "x-model": "big", origin: "https://app.test" } });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "policy_denied", policy: "gate", message: "too big" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    const fallback = await call(c, "/x", { headers: { "x-model": "huge" } });
    expect(fallback.status).toBe(403);
    expect(((await fallback.json()) as { message: string }).message).toBe("This request was denied by a policy");
    expect(c.captured).toHaveLength(0);
    expect(c.store.requests({ limit: 1, policy: "gate" })[0]).toMatchObject({ status: 403, error: "policy_denied", policy: "gate", token_id: c.tokenId });
  });

  test("respond sends exactly the response the policy built", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [
      hook(
        "answer",
        `switch (req.headers["x-mode"]) {
          case "text": return respond(200, { "x-a": "1" }, "hi");
          case "json": return respond(201, {}, { ok: true });
          case "html": return respond(200, { "Content-Type": "text/html" }, "<b>x</b>");
          case "empty": return respond(204);
          case "bad": return respond(204, {}, "x");
        }`,
      ),
    ]);
    const text = await call(c, "/x", { headers: { "x-mode": "text", origin: "https://app.test" } });
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("x-a")).toBe("1");
    expect(text.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(await text.text()).toBe("hi");

    const body = await call(c, "/x", { headers: { "x-mode": "json" } });
    expect(body.status).toBe(201);
    expect(body.headers.get("content-type")).toBe("application/json");
    expect(await body.text()).toBe('{"ok":true}');

    const html = await call(c, "/x", { headers: { "x-mode": "html" } });
    expect(html.headers.get("content-type")).toBe("text/html");
    expect(await html.text()).toBe("<b>x</b>");

    const empty = await call(c, "/x", { headers: { "x-mode": "empty" } });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    expect((await call(c, "/x", { headers: { "x-mode": "bad" } })).status).toBe(500);
    expect(c.captured).toHaveLength(0);
    const rows = c.store.requests({ limit: 10 });
    expect(rows.filter((r) => r.error === "policy_response").map((r) => r.status)).toEqual([204, 200, 201, 200]);
    expect(rows.every((r) => r.policy === "answer")).toBe(true);
  });

  test("a throwing policy fails closed with a truncated message", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("boom", `throw new Error("boom " + "x".repeat(300));`)]);
    const res = await call(c, "/x", { headers: { origin: "https://app.test" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    const body = (await res.json()) as { error: string; policy: string; message: string };
    expect(body.error).toBe("policy_error");
    expect(body.policy).toBe("boom");
    expect(body.message).toStartWith("Error: boom x");
    expect(body.message).toHaveLength(200);
    expect(c.captured).toHaveLength(0);
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ status: 500, error: "policy_error", policy: "boom" });
  });

  test("a policy whose code does not load fails closed", async () => {
    const c = setup(apiKeyHeader);
    const id = c.store.createPolicy({ name: "broken", source: "", compiled: "export const meta = {", needs: [] }, 1);
    c.store.setTokenPolicies(c.tokenId, [{ policy_id: id, enabled: true }]);
    const res = await call(c, "/x");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "policy_error", policy: "broken" });
    expect(c.captured).toHaveLength(0);
  });

  test("a body too deep to hand to the sandbox fails closed", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("deep", "", ["body"])]);
    const res = await call(c, "/x", { headers: json, body: "[".repeat(200_000) + "]".repeat(200_000) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "policy_error", policy: "deep" });
    expect(c.captured).toHaveLength(0);
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ status: 500, error: "policy_error", policy: "deep" });
  });

  test("policies cannot set framing headers, header line breaks, or break a placement body", async () => {
    const cases: [string, Placement[], string, string][] = [
      ["host", apiKeyHeader, `req.headers.host = "evil.example";`, ""],
      ["transfer-encoding", apiKeyHeader, `req.headers["transfer-encoding"] = "chunked";`, ""],
      ["content-length", apiKeyHeader, `req.headers["content-length"] = "1";`, ""],
      ["crlf", apiKeyHeader, `req.headers["x-a"] = "a\\r\\nx-injected: 1";`, ""],
      ["array-body", [{ type: "json", name: "api_key", value: "{{key}}" }], `req.body = [1];`, '{"q":1}'],
    ];
    for (const [name, placements, body, sent] of cases) {
      const c = setup(placements);
      await attach(c, [hook(name, body, ["body"])]);
      const res = await call(c, "/x", sent ? { headers: json, body: sent } : {});
      expect([name, res.status]).toEqual([name, 500]);
      expect(await res.json()).toMatchObject({ error: "policy_error", policy: name });
      expect(c.captured).toHaveLength(0);
    }

    const c = setup(apiKeyHeader);
    await attach(c, [hook("steal", `req.headers["x-api-key"] = "attacker";`)]);
    expect((await call(c, "/x")).status).toBe(200);
    expect(c.captured[0]?.headers.get("x-api-key")).toBe("REAL");
  });

  test("an older snapshot gets the newer cached code; replaced code lives until its lease ends", async () => {
    const [v1, v2] = await Promise.all([compilePolicy(hook("v", `req.headers["x-v"] = "1";`)), compilePolicy(hook("v", `req.headers["x-v"] = "2";`))]);
    if (!v1.ok || !v2.ok) throw new Error("compile failed");
    const cache = new PolicyCache();
    const row = { id: 1, name: "v", needs: [] };
    const older = { ...row, compiled: v1.policy.js, updated_at: "2026-01-01T00:00:00.001Z" };
    const first = cache.lease([older]);
    const newer = cache.lease([{ ...row, compiled: v2.policy.js, updated_at: "2026-01-01T00:00:00.002Z" }]);
    const stale = cache.lease([older]);
    const version = async (lease: PolicyLease): Promise<string | undefined> => {
      const loaded = await lease.entries[0]?.entry.loading;
      if (!loaded?.ok) throw new Error("load failed");
      const decision = loaded.policy.runRequest({ method: "GET", path: "/", query: {}, headers: {}, body: undefined }, { token: { id: 1, name: "t", scopes: [] }, upstream: { slug: "up", name: "Up", base_url: "https://up.example" }, origin: null, ip: null, method: "GET" });
      return decision.kind === "continue" ? decision.value.headers["x-v"] : decision.kind;
    };
    expect(await version(first)).toBe("1");
    expect(await version(stale)).toBe("2");
    first[Symbol.dispose]();
    expect(await version(first)).toBe("error");
    newer[Symbol.dispose]();
    stale[Symbol.dispose]();
    expect(await version(newer)).toBe("2");
  });

  test("policies run in attachment order and the first stop ends the chain", async () => {
    const c = setup(apiKeyHeader);
    const [a, b] = await Promise.all([addPolicy(c.store, hook("append-a", `req.headers["x-order"] = (req.headers["x-order"] ?? "") + "a";`)), addPolicy(c.store, hook("append-b", `req.headers["x-order"] = (req.headers["x-order"] ?? "") + "b";`))]);
    c.store.setTokenPolicies(c.tokenId, [{ policy_id: b, enabled: true }, { policy_id: a, enabled: true }]);
    await call(c, "/x");
    expect(c.captured[0]?.headers.get("x-order")).toBe("ba");

    const stop = await addPolicy(c.store, hook("stop", `if (req.headers["x-order"] === "ab") return deny(409, "seen ab");`));
    const thrower = await addPolicy(c.store, hook("thrower", `throw new Error("unreachable");`));
    c.store.setTokenPolicies(c.tokenId, [a, b, stop, thrower].map((policy_id) => ({ policy_id, enabled: true })));
    const res = await call(c, "/x");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ policy: "stop", message: "seen ab" });
    expect(c.captured).toHaveLength(1);
  });

  test("disabled policies and disabled attachments are skipped", async () => {
    const c = setup(apiKeyHeader);
    const off = await addPolicy(c.store, hook("off", "return deny();"));
    const detached = await addPolicy(c.store, hook("detached", "return deny();"));
    c.store.setPolicyEnabled(off, false);
    c.store.setTokenPolicies(c.tokenId, [
      { policy_id: off, enabled: true },
      { policy_id: detached, enabled: false },
    ]);
    expect((await call(c, "/x")).status).toBe(200);
    c.store.setPolicyEnabled(off, true);
    expect((await call(c, "/x")).status).toBe(403);
  });

  describe("bodies", () => {
    const report = hook("report", `req.headers["x-skipped"] = String(ctx.bodySkipped); req.headers["x-body"] = JSON.stringify(req.body) ?? "none";`, ["body"]);

    test("a JSON body is parsed", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [report]);
      await call(c, "/x", { headers: json, body: "[1,2]" });
      expect(c.captured[0]?.headers.get("x-skipped")).toBe("undefined");
      expect(c.captured[0]?.headers.get("x-body")).toBe("[1,2]");
    });

    test("requests without a body have no bodySkipped", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [report]);
      await call(c, "/x");
      await call(c, "/x", { method: "POST", headers: { ...json, "content-length": "0" } });
      for (const sent of c.captured) {
        expect(sent.headers.get("x-skipped")).toBe("undefined");
        expect(sent.headers.get("x-body")).toBe("none");
      }
    });

    test("the 1 MB limit counts the bytes read; larger bodies are too_large and pass through", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [report]);
      const big = JSON.stringify({ pad: "\u00e9".repeat(600_000) });
      await call(c, "/x", { headers: json, body: big });
      await call(c, "/x", { headers: { ...json, "content-length": String(2 * 1024 * 1024) }, body: '{"a":1}' });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"b":2}'));
          controller.close();
        },
      });
      await c.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { ...json, "x-keygate-token": c.token }, body: stream }));
      expect(c.captured.map((s) => [s.headers.get("x-skipped"), s.headers.get("x-body"), s.body === big ? "big" : s.body])).toEqual([
        ["too_large", "none", "big"],
        ["undefined", '{"a":1}', '{"a":1}'],
        ["undefined", '{"b":2}', '{"b":2}'],
      ]);
    });

    test("multipart is unparsed and streams through byte for byte", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [report]);
      const head = new TextEncoder().encode('--b\r\ncontent-disposition: form-data; name="f"; filename="f.bin"\r\n\r\n');
      const tail = new TextEncoder().encode("\r\n--b--\r\n");
      const payload = new Uint8Array(head.length + 256 + tail.length);
      payload.set(head);
      payload.set(Uint8Array.from({ length: 256 }, (_, i) => i), head.length);
      payload.set(tail, head.length + 256);
      await call(c, "/x", { headers: { "content-type": "multipart/form-data; boundary=b" }, body: payload });
      const sent = c.captured[0];
      expect(sent?.headers.get("x-skipped")).toBe("unparsed");
      expect(sent?.headers.get("content-type")).toBe("multipart/form-data; boundary=b");
      expect(sent?.bytes).toEqual(payload);
    });

    test("application/jsonl is unparsed; +json types are parsed", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [report]);
      const lines = '{"a":1}\n{"b":2}\n';
      await call(c, "/x", { headers: { "content-type": "application/jsonl" }, body: lines });
      await call(c, "/x", { headers: { "content-type": "Application/Problem+JSON; charset=utf-8" }, body: '{"c":3}' });
      expect(c.captured.map((s) => [s.headers.get("x-skipped"), s.headers.get("x-body"), s.body])).toEqual([
        ["unparsed", "none", lines],
        ["undefined", '{"c":3}', '{"c":3}'],
      ]);
    });

    test("without needs body the body is not_requested", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [hook("plain", `req.headers["x-skipped"] = String(ctx.bodySkipped); req.headers["x-body"] = String(req.body);`)]);
      await call(c, "/x", { headers: json, body: '{"a":1}' });
      expect(c.captured[0]?.headers.get("x-skipped")).toBe("not_requested");
      expect(c.captured[0]?.headers.get("x-body")).toBe("undefined");
      expect(c.captured[0]?.body).toBe('{"a":1}');
    });

    test("setting a body that was not read, or removing a parsed one, is a policy error", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [hook("setter", `if (req.headers["x-mode"] === "remove") req.body = undefined; else req.body = { a: 1 };`, ["body"])]);
      const skipped = await call(c, "/x", { headers: { "content-type": "text/plain" }, body: "hello" });
      expect(skipped.status).toBe(500);
      expect(((await skipped.json()) as { message: string }).message).toContain("unparsed");
      expect((await call(c, "/x")).status).toBe(500);
      expect((await call(c, "/x", { headers: { ...json, "x-mode": "remove" }, body: "{}" })).status).toBe(500);
      expect(c.captured).toHaveLength(0);
    });

    test("invalid JSON is refused before policies run", async () => {
      const c = setup(apiKeyHeader);
      await attach(c, [report]);
      const res = await call(c, "/x", { headers: json, body: "{nope" });
      expect(res.status).toBe(400);
      expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ error: "invalid_body", policy: null });
    });
  });

  test("a token without policies is untouched by another token's policies", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [hook("deny-all", "return deny();")]);
    const other = c.store.createToken({ name: "o", scopes: ["up"], origins: [], expires_at: null }, 1).token;
    expect((await call(c, "/x", { token: other })).status).toBe(200);
    expect((await call(c, "/x")).status).toBe(403);
  });

  test("preflights, rejected tokens and llms.txt do not run policies", async () => {
    const c = setup(apiKeyHeader);
    const thrower = hook("thrower", `throw new Error("ran");`);
    const [id] = await attach(c, [thrower]);
    if (id === undefined) throw new Error("policy missing");
    const preflight = await c.proxy(new Request("http://keygate.test/up/x", { method: "OPTIONS", headers: { origin: "https://app.test", "access-control-request-method": "POST" } }));
    expect(preflight.status).toBe(204);
    expect((await call(c, "/x", { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await c.proxy(new Request("http://keygate.test/up/llms.txt"))).status).toBe(200);
    const outOfScope = c.store.createToken({ name: "o", scopes: ["else"], origins: [], expires_at: null }, 1);
    c.store.setTokenPolicies(outOfScope.id, [{ policy_id: id, enabled: true }]);
    expect((await call(c, "/x", { token: outOfScope.token })).status).toBe(403);
    c.store.setTokenEnabled(c.tokenId, false);
    expect((await call(c, "/x")).status).toBe(401);
    const rows = c.store.requests({ limit: 10 });
    expect(rows.map((r) => r.error)).toEqual(["disabled_token", "upstream_not_in_scope", "origin_not_allowed"]);
    expect(rows.every((r) => r.policy === null)).toBe(true);
  });
});

function jsonResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers } });
}

describe("response policies", () => {
  test("status and header edits apply; the body streams through", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [responseHook("edit", `res.status = 202; res.headers["X-Added"] = "1"; delete res.headers["x-up"]; res.headers["x-skipped"] = String(ctx.bodySkipped);`)]);
    const res = await call(c, "/x", { headers: { origin: "https://app.test" } });
    expect(res.status).toBe(202);
    expect(res.headers.get("x-added")).toBe("1");
    expect(res.headers.has("x-up")).toBe(false);
    expect(res.headers.get("x-skipped")).toBe("not_requested");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(await res.text()).toBe("upstream-body");
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ status: 202, error: null, policy: null, bytes_out: 13 });
  });

  test("set-cookie is hidden from policies and passes through", async () => {
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const c = setup(apiKeyHeader, () => new Response("x", { headers }));
    await attach(c, [responseHook("cookies", `res.headers["x-cookie"] = String(res.headers["set-cookie"]);`)]);
    const res = await call(c, "/x");
    expect(res.headers.get("x-cookie")).toBe("undefined");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  test("a JSON body is exposed and rewritten", async () => {
    const c = setup(apiKeyHeader, () => jsonResponse('{ "user" : "ann", "secret" : "s3" }', 200, { "content-type": "application/json; charset=utf-8" }));
    await attach(c, [responseHook("redact", `res.body.secret = "[redacted]";`, ["responseBody"])]);
    const res = await call(c, "/x");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ user: "ann", secret: "[redacted]" });
    expect(c.store.requests({ limit: 1 })[0]?.bytes_out).toBe(Buffer.byteLength(text));
  });

  test("an exposed body left unchanged keeps its bytes", async () => {
    const c = setup(apiKeyHeader, () => jsonResponse('{ "a" : 1 }'));
    await attach(c, [responseHook("look", `res.headers["x-a"] = String(res.body.a);`, ["responseBody"])]);
    const res = await call(c, "/x");
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.text()).toBe('{ "a" : 1 }');
  });

  test("SSE streams through byte for byte with header edits applied", async () => {
    const events = ["data: a\n\n", "data: b\n\n"];
    const c = setup(apiKeyHeader, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(new TextEncoder().encode(e));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    await attach(c, [responseHook("sse", `res.headers["x-skipped"] = String(ctx.bodySkipped); res.headers["x-body"] = String(res.body);`, ["responseBody"])]);
    const res = await call(c, "/x");
    expect(res.headers.get("x-skipped")).toBe("unparsed");
    expect(res.headers.get("x-body")).toBe("undefined");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(events.join(""));
    expect(c.store.requests({ limit: 1 })[0]?.bytes_out).toBe(18);
  });

  test("JSON over 1 MB, declared or actual, is too_large and passes through", async () => {
    const big = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
    let declared: string | null = String(Buffer.byteLength(big));
    const c = setup(apiKeyHeader, () => new Response(declared === null ? new Blob([big]).stream() : big, { headers: { "content-type": "application/json", ...(declared === null ? {} : { "content-length": declared }) } }));
    await attach(c, [responseHook("size", `res.headers["x-skipped"] = String(ctx.bodySkipped);`, ["responseBody"])]);
    const declaredLarge = await call(c, "/x");
    expect(declaredLarge.headers.get("x-skipped")).toBe("too_large");
    expect(await declaredLarge.text()).toBe(big);
    declared = "10";
    const actualLarge = await call(c, "/x");
    expect(actualLarge.headers.get("x-skipped")).toBe("too_large");
    expect(await actualLarge.text()).toBe(big);
    declared = null;
    const undeclared = await call(c, "/x");
    expect(undeclared.headers.get("x-skipped")).toBe("too_large");
    expect(await undeclared.text()).toBe(big);
  });

  test("a compressed JSON response without Content-Length is exposed", async () => {
    const c = setup(apiKeyHeader, () => new Response(new Blob(['{"a":1}']).stream(), { headers: { "content-type": "application/json", "content-encoding": "gzip" } }));
    await attach(c, [responseHook("look", `res.headers["x-skipped"] = String(ctx.bodySkipped); res.body.b = res.body.a + 1;`, ["responseBody"])]);
    const res = await call(c, "/x");
    expect(res.headers.get("x-skipped")).toBe("undefined");
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(await res.json()).toEqual({ a: 1, b: 2 });
  });

  test("a rewritten response body keeps a media type that still names its kind", async () => {
    let type = "application/vnd.api+json; charset=utf-8";
    const c = setup(apiKeyHeader, () => jsonResponse('{"a":1}', 200, { "content-type": type }));
    await attach(
      c,
      [
        responseHook(
          "retype",
          `if (ctx.method === "PUT") res.headers["content-type"] = "text/plain";
          if (ctx.method === "DELETE") delete res.headers["content-type"];
          res.body.a = 2;`,
          ["responseBody"],
        ),
      ],
    );
    const kept = await call(c, "/x");
    expect(kept.headers.get("content-type")).toBe("application/vnd.api+json; charset=utf-8");
    expect(await kept.text()).toBe('{"a":2}');
    type = "application/json";
    expect((await call(c, "/x", { method: "PUT" })).headers.get("content-type")).toBe("text/plain");
    expect((await call(c, "/x", { method: "DELETE" })).headers.get("content-type")).toBe("application/json");
  });

  test("a response without a body has no bodySkipped", async () => {
    const c = setup(apiKeyHeader, () => new Response(null, { status: 204 }));
    await attach(c, [responseHook("empty", `res.headers["x-skipped"] = String(ctx.bodySkipped); res.status = 200;`, ["responseBody"])]);
    const res = await call(c, "/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-skipped")).toBe("undefined");
  });

  test("deny and respond replace the provider response, which is cancelled; the key still records it", async () => {
    let cancelled = 0;
    const c = setup(apiKeyHeader, () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("secret"));
        },
        cancel() {
          cancelled++;
        },
      });
      return new Response(stream, { status: 401, headers: { "content-type": "text/plain" } });
    });
    await attach(c, [responseHook("replace", `if (ctx.method === "POST") return respond(200, { "x-r": "1" }, { replaced: true }); return deny(424, "provider refused");`)]);
    const denied = await call(c, "/x", { headers: { origin: "https://app.test" } });
    expect(denied.status).toBe(424);
    expect(denied.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(await denied.json()).toEqual({ error: "policy_denied", policy: "replace", message: "provider refused" });
    const responded = await call(c, "/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "q" });
    expect(responded.status).toBe(200);
    expect(responded.headers.get("x-r")).toBe("1");
    expect(await responded.text()).toBe('{"replaced":true}');
    expect(cancelled).toBe(2);
    expect(c.store.keyById(c.keyId)?.failing_status).toBe(401);
    expect(c.store.requests({ limit: 2 }).map((r) => [r.status, r.error, r.policy])).toEqual([
      [200, "policy_response", "replace"],
      [424, "policy_denied", "replace"],
    ]);
  });

  test("a throwing onResponse fails closed", async () => {
    const c = setup(apiKeyHeader);
    await attach(c, [responseHook("boom", `throw new Error("bad response");`)]);
    const res = await call(c, "/x");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "policy_error", policy: "boom", message: "Error: bad response" });
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ status: 500, error: "policy_error", policy: "boom" });
  });

  test("onResponse runs last to first after onRequest ran first to last", async () => {
    const c = setup(apiKeyHeader);
    const both = (name: string) =>
      `export const meta = { name: "${name}" };
      export function onRequest(req) { req.headers["x-order"] = (req.headers["x-order"] ?? "") + "${name}"; }
      export function onResponse(res) { res.headers["x-order"] = (res.headers["x-order"] ?? "") + "${name}"; }`;
    await attach(c, [both("a"), both("b"), responseHook("c", `res.headers["x-order"] = (res.headers["x-order"] ?? "") + "c";`)]);
    const res = await call(c, "/x");
    expect(c.captured[0]?.headers.get("x-order")).toBe("ab");
    expect(res.headers.get("x-order")).toBe("cba");
  });

  test("a provider body that fails while read for a policy is a 502", async () => {
    const c = setup(apiKeyHeader, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":'));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(stream, { headers: { "content-type": "application/json", "content-length": "20" } });
    });
    await attach(c, [responseHook("reader", "", ["responseBody"])]);
    const res = await call(c, "/x");
    expect(res.status).toBe(502);
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ error: "upstream_unreachable", policy: null });
  });

  test("does not run on keygate's own 502", async () => {
    const c = setup(apiKeyHeader, () => {
      throw new Error("connect ECONNREFUSED");
    });
    await attach(c, [responseHook("boom", `throw new Error("ran");`)]);
    const res = await call(c, "/x");
    expect(res.status).toBe(502);
    expect(c.store.requests({ limit: 1 })[0]).toMatchObject({ error: "upstream_unreachable", policy: null });
  });

  test("changes keygate cannot apply are policy errors", async () => {
    const cases: [string, string, string[]][] = [
      ["not-exposed", `res.body = { a: 1 };`, []],
      ["removed", `res.body = undefined;`, ["responseBody"]],
      ["content-length", `res.headers["content-length"] = "1";`, []],
      ["content-encoding", `res.headers["content-encoding"] = "gzip";`, []],
      ["set-cookie", `res.headers["set-cookie"] = "a=1";`, []],
      ["no-content", `res.status = 204;`, []],
    ];
    for (const [name, body, needs] of cases) {
      const c = setup(apiKeyHeader, () => jsonResponse('{"a":1}'));
      await attach(c, [responseHook(name, body, needs)]);
      const res = await call(c, "/x");
      expect([name, res.status]).toEqual([name, 500]);
      expect(await res.json()).toMatchObject({ error: "policy_error", policy: name });
    }
  });
});

describe("clientIp", () => {
  const socket = () => "192.0.2.9";
  test("no trusted hops uses the socket address", () => {
    expect(clientIp(0, "1.1.1.1", socket)).toBe("192.0.2.9");
  });
  test("counts hops from the right of X-Forwarded-For", () => {
    expect(clientIp(1, "1.1.1.1, 10.0.0.2", socket)).toBe("10.0.0.2");
    expect(clientIp(2, "1.1.1.1, 10.0.0.2", socket)).toBe("1.1.1.1");
  });
  test("more hops than entries is null", () => {
    expect(clientIp(3, "1.1.1.1, 10.0.0.2", socket)).toBeNull();
    expect(clientIp(1, null, socket)).toBeNull();
  });
});
