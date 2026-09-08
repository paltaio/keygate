import { beforeEach, describe, expect, test } from "bun:test";
import { loadEnv } from "./env.ts";
import { createProxy, resolveTarget } from "./proxy.ts";
import { Store } from "./store.ts";

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

function setup(upstream: { slot_type: "header" | "query" | "cookie" | "json" | "form"; slot_name: string; slot_prefix?: string }, respond?: () => Response) {
  const store = new Store(":memory:");
  const captured: Captured[] = [];
  const upstreamId = store.createUpstream({
    slug: "up",
    name: "Up",
    base_url: "https://up.example/base",
    slot_type: upstream.slot_type,
    slot_name: upstream.slot_name,
    slot_prefix: upstream.slot_prefix ?? "",
    notes: "",
  });
  const userId = store.createUser("a@b.c", "A", "x");
  const keyId = store.addKey(upstreamId, "k1", "REAL", true, userId);
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
    ctx = setup({ slot_type: "header", slot_name: "x-api-key" });
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
    const c = setup({ slot_type: "header", slot_name: "x-api-key" }, () => new Response("x", { status }));
    await (await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }))).text();
    expect(c.store.keyById(c.keyId)?.failing_status).toBe(401);
    status = 200;
    await (await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }))).text();
    expect(c.store.keyById(c.keyId)?.failing_at).toBeNull();
  });

  test("upstream failure is a 502 with a log row", async () => {
    const c = setup({ slot_type: "header", slot_name: "x-api-key" }, () => {
      throw new Error("connect ECONNREFUSED");
    });
    const res = await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }));
    expect(res.status).toBe(502);
    expect(c.store.requests({ limit: 1 })[0]?.error).toBe("upstream_unreachable");
  });

  test("query, cookie, json and form slots", async () => {
    const q = setup({ slot_type: "query", slot_name: "key" });
    await q.proxy(new Request(`http://keygate.test/up/x?key=${q.token}&a=1`));
    expect(q.captured[0]?.url).toBe("https://up.example/base/x?a=1&key=REAL");

    const ck = setup({ slot_type: "cookie", slot_name: "sid" });
    await ck.proxy(new Request("http://keygate.test/up/x", { headers: { cookie: `sid=${ck.token}` } }));
    expect(ck.captured[0]?.headers.get("cookie")).toBe("sid=REAL");

    const j = setup({ slot_type: "json", slot_name: "api_key" });
    await j.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: j.token, q: 1 }) }));
    expect(JSON.parse(j.captured[0]?.body ?? "")).toEqual({ q: 1, api_key: "REAL" });

    const f = setup({ slot_type: "form", slot_name: "api_key" });
    await f.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `api_key=${f.token}&q=1` }));
    expect(f.captured[0]?.body).toBe("q=1&api_key=REAL");

    const bad = setup({ slot_type: "json", slot_name: "api_key" });
    const res = await bad.proxy(new Request("http://keygate.test/up/x", { method: "POST", headers: { "content-type": "application/json", "x-keygate-token": bad.token }, body: "[1]" }));
    expect(res.status).toBe(400);
  });

  test("streams the upstream body through", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\n"));
        controller.enqueue(new TextEncoder().encode("data: b\n\n"));
        controller.close();
      },
    });
    const c = setup({ slot_type: "header", slot_name: "x-api-key" }, () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const res = await c.proxy(new Request("http://keygate.test/up/x", { headers: { "x-keygate-token": c.token } }));
    expect(await res.text()).toBe("data: a\n\ndata: b\n\n");
    expect(c.store.requests({ limit: 1 })[0]?.bytes_out).toBe(18);
  });
});
