import { beforeEach, describe, expect, test } from "bun:test";
import { loadEnv } from "./env.ts";
import { createProxy, resolveTarget } from "./proxy.ts";
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
}

const apiKeyHeader: Placement[] = [{ type: "header", name: "x-api-key", value: "{{key}}" }];

function setup(placements: Placement[], respond?: () => Response, secrets: Record<string, string> = { key: "REAL" }) {
  const store = new Store(":memory:");
  const captured: Captured[] = [];
  const upstreamId = store.createUpstream({ slug: "up", name: "Up", base_url: "https://up.example/base", placements, strategy: "active", notes: "" });
  const userId = store.createUser("a@b.c", "A", "x");
  const keyId = store.addKey(upstreamId, "k1", secrets, true, userId);
  const { token } = store.createToken({ name: "t", scopes: ["up"], origins: ["https://app.test"], expires_at: null }, userId);
  const proxy = createProxy({
    store,
    env,
    fetch: async (url, init) => {
      const req = new Request(url, init);
      captured.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
      return respond ? respond() : new Response("upstream-body", { status: 200, headers: { "x-up": "1", "content-encoding": "gzip" } });
    },
  });
  return { store, proxy, token, keyId, captured };
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
    c.store.updateUpstream(upstream.id, { slug: "up", name: "Up", base_url: "https://up.example/base", placements: two, strategy: "round_robin", notes: "" });
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

  test("round robin takes turns and sits out a flagged credential", async () => {
    let status = 200;
    const c = setup(apiKeyHeader, () => new Response("x", { status }));
    const upstream = c.store.upstreamBySlug("up");
    if (!upstream) throw new Error("upstream missing");
    c.store.updateUpstream(upstream.id, { slug: "up", name: "Up", base_url: "https://up.example/base", placements: apiKeyHeader, strategy: "round_robin", notes: "" });
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
