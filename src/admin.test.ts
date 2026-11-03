import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "./admin.ts";
import { loadEnv } from "./env.ts";
import { createProxy } from "./proxy.ts";
import { Store } from "./store.ts";

const env = loadEnv({ KEYGATE_HOST: "keygate.test", KEYGATE_DATA_DIR: ":memory:" });

describe("admin API keys", () => {
  const store = new Store(":memory:");
  const app = new Hono().route("/api", adminRoutes(store, env));
  let cookie = "";
  let apiKey = "";

  beforeAll(async () => {
    store.createUser("admin@test.local", "A", await Bun.password.hash("password123"));
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@test.local", password: "password123" }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  test("a session creates an API key that is returned once", async () => {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "agent" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; hint: string };
    expect(body.key.startsWith("kga_")).toBe(true);
    apiKey = body.key;
    const list = (await (await app.request("/api/api-keys", { headers: { cookie } })).json()) as Array<Record<string, unknown>>;
    expect(list[0]?.hint).toBe(body.hint);
    expect(list[0]?.key).toBeUndefined();
    expect(list[0]?.hash).toBeUndefined();
  });

  test("the API key manages upstreams and tokens as its creator", async () => {
    const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const me = await app.request("/api/auth/me", { headers: auth });
    expect(((await me.json()) as { api_key?: { name: string } }).api_key?.name).toBe("agent");
    const up = await app.request("/api/upstreams", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ slug: "exa", name: "Exa", base_url: "https://api.exa.ai", placements: [{ type: "header", name: "x-api-key", value: "{{key}}" }] }),
    });
    expect(up.status).toBe(201);
    const token = await app.request("/api/tokens", { method: "POST", headers: auth, body: JSON.stringify({ name: "t", scopes: ["exa"] }) });
    expect(token.status).toBe(201);
    expect(store.tokens()[0]?.created_by).toBe(1);
  });

  test("the API key cannot manage users or API keys", async () => {
    const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    expect((await app.request("/api/users", { headers: auth })).status).toBe(403);
    expect((await app.request("/api/api-keys", { method: "POST", headers: auth, body: JSON.stringify({ name: "x" }) })).status).toBe(403);
    expect((await app.request("/api/users/1", { method: "DELETE", headers: auth })).status).toBe(403);
  });

  test("rotating a key or token keeps the row and replaces the secret", async () => {
    const id = store.apiKeys()[0]?.id ?? 0;
    const res = await app.request(`/api/api-keys/${id}/rotate`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; key: string; hint: string; rotated_at: string | null };
    expect(body.id).toBe(id);
    expect(body.key.startsWith("kga_")).toBe(true);
    expect(body.key).not.toBe(apiKey);
    expect(body.rotated_at).not.toBeNull();
    expect((await app.request("/api/upstreams", { headers: { authorization: `Bearer ${apiKey}` } })).status).toBe(401);
    expect((await app.request("/api/upstreams", { headers: { authorization: `Bearer ${body.key}` } })).status).toBe(200);
    apiKey = body.key;

    const token = store.tokens()[0];
    if (!token) throw new Error("no token to rotate");
    const rotated = await app.request(`/api/tokens/${token.id}/rotate`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
    expect(rotated.status).toBe(200);
    const t = (await rotated.json()) as { id: number; token: string; scopes: string[]; hash?: string };
    expect(t.id).toBe(token.id);
    expect(t.token.startsWith("kg_")).toBe(true);
    expect(t.scopes).toEqual(["exa"]);
    expect(t.hash).toBeUndefined();
    expect(store.tokenByValue(t.token)?.id).toBe(token.id);
    expect(store.tokenById(token.id)?.hash).not.toBe(token.hash);
  });

  test("a revoked or unknown key is refused", async () => {
    expect((await app.request("/api/upstreams", { headers: { authorization: "Bearer kga_nope" } })).status).toBe(401);
    const id = store.apiKeys()[0]?.id ?? 0;
    expect((await app.request(`/api/api-keys/${id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await app.request("/api/upstreams", { headers: { authorization: `Bearer ${apiKey}` } })).status).toBe(401);
    expect((await app.request(`/api/api-keys/${id}/rotate`, { method: "POST", headers: { cookie } })).status).toBe(404);
  });
});

interface PolicyBody {
  id: number;
  name: string;
  needs: string[];
  enabled: boolean;
  token_count: number;
  source: string;
  tokens: Array<{ id: number; name: string }>;
}

interface TokenBody {
  id: number;
  policies: Array<{ policy_id: number; name: string; enabled: boolean }>;
}

function gate(name: string, message: string, needs = ""): string {
  return `export const meta = { name: ${JSON.stringify(name)}${needs} };
export function onRequest(req: { headers: Record<string, string> }) {
  if (req.headers["x-block"] === "1") return deny(403, ${JSON.stringify(message)});
}`;
}

function noop(name: string): string {
  return `export const meta = { name: ${JSON.stringify(name)} };
export function onRequest() {}`;
}

describe("admin policies", () => {
  const store = new Store(":memory:");
  const app = new Hono().route("/api", adminRoutes(store, env));
  const upstreamCalls: string[] = [];
  const proxy = createProxy({
    store,
    env,
    fetch: async (url) => {
      upstreamCalls.push(url);
      return new Response("ok");
    },
  });
  let auth: Record<string, string> = {};
  let tokenId = 0;
  let tokenValue = "";
  let userId = 0;

  beforeAll(() => {
    userId = store.createUser("admin@test.local", "A", "x");
    auth = { authorization: `Bearer ${store.createApiKey("agent", userId).key}`, "content-type": "application/json" };
    const upstreamId = store.createUpstream({ slug: "up", name: "Up", base_url: "https://up.example", placements: [{ type: "header", name: "x-api-key", value: "{{key}}" }], strategy: "active", notes: "", docs: "" });
    store.addKey(upstreamId, "k", { key: "REAL" }, true, userId);
    const created = store.createToken({ name: "t1", scopes: ["up"], origins: [], expires_at: null }, userId);
    tokenId = created.id;
    tokenValue = created.token;
  });

  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const blocked = () => proxy(new Request("http://keygate.test/up/x", { headers: { "x-api-key": tokenValue, "x-block": "1" } }));

  async function create(source: string): Promise<PolicyBody> {
    const res = await call("POST", "/policies", { source });
    expect(res.status).toBe(201);
    return (await res.json()) as PolicyBody;
  }

  test("an API key creates a policy as its creator", async () => {
    const policy = await create(gate("gate", "v1", `, needs: ["body"]`));
    expect(policy).toMatchObject({ name: "gate", needs: ["body"], enabled: true, token_count: 0, tokens: [] });
    expect(policy.source).toContain("v1");
    expect(store.policyById(policy.id)?.created_by).toBe(userId);
    const list = (await (await call("GET", "/policies")).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: policy.id, name: "gate", needs: ["body"], enabled: true, token_count: 0 });
    expect(list[0]?.source).toBeUndefined();
    expect(list[0]?.compiled).toBeUndefined();
  });

  test("a source that does not compile is refused with the message", async () => {
    const syntax = await call("POST", "/policies", { source: "export const meta = {" });
    expect(syntax.status).toBe(400);
    expect(((await syntax.json()) as { error: string }).error).toBe("compile_error");
    const noHooks = await call("POST", "/policies", { source: `export const meta = { name: "x" };` });
    expect(await noHooks.json()).toEqual({ error: "compile_error", message: "the module must export an onRequest or onResponse function" });
    expect((await call("POST", "/policies", { source: 42 })).status).toBe(400);
    const huge = await call("POST", "/policies", { source: "x".repeat(200 * 1024) });
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({ error: "compile_error", message: "source exceeds 100 KB" });
    expect(store.policies()).toHaveLength(1);
  });

  test("a name in use is refused on create and on rename", async () => {
    const taken = await call("POST", "/policies", { source: gate("gate", "dup") });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "name_taken", message: "A policy named gate already exists; change meta.name" });
    const other = await create(noop("other"));
    const rename = await call("PATCH", `/policies/${other.id}`, { source: noop("gate") });
    expect(rename.status).toBe(409);
    expect(((await rename.json()) as { error: string }).error).toBe("name_taken");
    const renamed = await call("PATCH", `/policies/${other.id}`, { source: noop("other-2") });
    expect(((await renamed.json()) as PolicyBody).name).toBe("other-2");
    expect((await call("PATCH", "/policies/999", { enabled: false })).status).toBe(404);
    expect((await call("GET", "/policies/999")).status).toBe(404);
  });

  test("attachments replace the token's list in order and show on token views", async () => {
    const [gatePolicy, other] = store.policies().sort((a, b) => a.id - b.id);
    if (!gatePolicy || !other) throw new Error("missing policies");
    const put = await call("PUT", `/tokens/${tokenId}/policies`, { policies: [{ policy_id: other.id, enabled: false }, { policy_id: gatePolicy.id, enabled: true }] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual([
      { policy_id: other.id, name: "other-2", enabled: false },
      { policy_id: gatePolicy.id, name: "gate", enabled: true },
    ]);
    const tokens = (await (await call("GET", "/tokens")).json()) as TokenBody[];
    expect(tokens[0]?.policies.map((p) => p.name)).toEqual(["other-2", "gate"]);

    await call("PUT", `/tokens/${tokenId}/policies`, { policies: [{ policy_id: gatePolicy.id, enabled: true }, { policy_id: other.id, enabled: true }] });
    const patched = (await (await call("PATCH", `/tokens/${tokenId}`, { name: "t1", scopes: ["up"] })).json()) as TokenBody;
    expect(patched.policies).toEqual([
      { policy_id: gatePolicy.id, name: "gate", enabled: true },
      { policy_id: other.id, name: "other-2", enabled: true },
    ]);
    const detail = (await (await call("GET", `/policies/${gatePolicy.id}`)).json()) as PolicyBody;
    expect(detail.token_count).toBe(1);
    expect(detail.tokens).toEqual([{ id: tokenId, name: "t1" }]);

    const created = (await (await call("POST", "/tokens", { name: "t2", scopes: ["up"] })).json()) as TokenBody;
    expect(created.policies).toEqual([]);
  });

  test("unknown or repeated policy ids are refused with the ids", async () => {
    const id = store.policies()[0]?.id ?? 0;
    const unknown = await call("PUT", `/tokens/${tokenId}/policies`, { policies: [{ policy_id: id, enabled: true }, { policy_id: 999, enabled: true }] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown_policy", policy_ids: [999] });
    const dup = await call("PUT", `/tokens/${tokenId}/policies`, { policies: [{ policy_id: id, enabled: true }, { policy_id: id, enabled: false }] });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: "duplicate_policy", policy_ids: [id] });
    expect(store.tokenPolicies(tokenId)).toHaveLength(2);
  });

  test("a saved source applies to the next proxied request", async () => {
    const id = store.policyByName("gate")?.id ?? 0;
    const first = await blocked();
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({ error: "policy_denied", policy: "gate", message: "v1" });
    expect((await call("PATCH", `/policies/${id}`, { source: gate("gate", "v2") })).status).toBe(200);
    expect(((await (await blocked()).json()) as { message: string }).message).toBe("v2");
    expect(upstreamCalls).toHaveLength(0);
  });

  test("disabling a policy stops it from running", async () => {
    const id = store.policyByName("gate")?.id ?? 0;
    const off = await call("PATCH", `/policies/${id}`, { enabled: false });
    expect(((await off.json()) as PolicyBody).enabled).toBe(false);
    const passed = await blocked();
    expect(passed.status).toBe(200);
    expect(await passed.text()).toBe("ok");
    expect(upstreamCalls).toHaveLength(1);
    await call("PATCH", `/policies/${id}`, { enabled: true });
    expect((await blocked()).status).toBe(403);
  });

  test("the request log filters by policy name", async () => {
    const rows = (await (await call("GET", "/requests?policy=gate")).json()) as Array<{ policy: string | null; error: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.policy === "gate" && r.error === "policy_denied")).toBe(true);
    expect(await (await call("GET", "/requests?policy=other-2")).json()).toEqual([]);
    const all = (await (await call("GET", "/requests")).json()) as Array<{ policy: string | null }>;
    expect(all.some((r) => r.policy === null)).toBe(true);
  });

  test("a policy cannot be deleted while attached", async () => {
    const id = store.policyByName("gate")?.id ?? 0;
    const refused = await call("DELETE", `/policies/${id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "policy_in_use", tokens: [{ id: tokenId, name: "t1" }] });
    const other = store.policyByName("other-2")?.id ?? 0;
    expect((await call("PUT", `/tokens/${tokenId}/policies`, { policies: [{ policy_id: other, enabled: true }] })).status).toBe(200);
    expect((await call("DELETE", `/policies/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/policies/${id}`)).status).toBe(404);
    expect(store.policyById(id)).toBeNull();
  });

  test("a revoked token takes no attachments", async () => {
    const other = store.policyByName("other-2")?.id ?? 0;
    expect((await call("DELETE", `/tokens/${tokenId}`)).status).toBe(200);
    const res = await call("PUT", `/tokens/${tokenId}/policies`, { policies: [{ policy_id: other, enabled: true }] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toBe("No such token, or it is revoked");
    expect((await call("PUT", "/tokens/999/policies", { policies: [] })).status).toBe(404);
    expect((await call("DELETE", `/policies/${other}`)).status).toBe(200);
  });

  test("tokens are created and updated together with their policies", async () => {
    const policy = await create(noop("issued"));
    const tokenCount = store.tokens().length;
    const unknown = await call("POST", "/tokens", { name: "t3", scopes: ["up"], policies: [{ policy_id: policy.id, enabled: true }, { policy_id: 999, enabled: true }] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown_policy", policy_ids: [999] });
    expect(store.tokens()).toHaveLength(tokenCount);

    const created = await call("POST", "/tokens", { name: "t3", scopes: ["up"], policies: [{ policy_id: policy.id, enabled: false }] });
    expect(created.status).toBe(201);
    const token = (await created.json()) as TokenBody & { token: string };
    expect(token.token).toStartWith("kg_");
    expect(token.policies).toEqual([{ policy_id: policy.id, name: "issued", enabled: false }]);

    const dup = await call("PATCH", `/tokens/${token.id}`, { name: "renamed", scopes: ["up"], policies: [{ policy_id: policy.id, enabled: true }, { policy_id: policy.id, enabled: true }] });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: "duplicate_policy", policy_ids: [policy.id] });
    expect(store.tokenById(token.id)?.name).toBe("t3");
    expect(store.tokenPolicies(token.id)).toHaveLength(1);

    const patched = await call("PATCH", `/tokens/${token.id}`, { name: "renamed", scopes: ["up"], policies: [{ policy_id: policy.id, enabled: true }] });
    expect(await patched.json()).toMatchObject({ id: token.id, name: "renamed", policies: [{ policy_id: policy.id, name: "issued", enabled: true }] });
    const kept = await call("PATCH", `/tokens/${token.id}`, { name: "renamed-2", scopes: ["up"] });
    expect(((await kept.json()) as TokenBody).policies).toHaveLength(1);

    expect((await call("DELETE", `/tokens/${token.id}`)).status).toBe(200);
    expect((await call("PATCH", `/tokens/${token.id}`, { name: "revoked", scopes: ["up"], policies: [] })).status).toBe(404);
    expect(store.tokenById(token.id)?.name).toBe("renamed-2");
  });
});

describe("login throttle", () => {
  const store = new Store(":memory:");
  const attempt = (app: Hono, forwardedFor: string, password: string, socket?: string) =>
    app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ email: "throttle@test.local", password }),
      },
      socket ? { server: { requestIP: () => ({ address: socket, family: "IPv4", port: 40000 }) } } : undefined,
    );

  beforeAll(async () => {
    store.createUser("throttle@test.local", "T", await Bun.password.hash("password123"));
  });

  test("with no trusted proxy, X-Forwarded-For does not change the key", async () => {
    const app = new Hono().route("/api", adminRoutes(store, env));
    for (let i = 0; i < 10; i++) expect((await attempt(app, `203.0.113.${i}`, "wrong-password", "192.0.2.10")).status).toBe(401);
    expect((await attempt(app, "203.0.113.200", "password123", "192.0.2.10")).status).toBe(429);
    expect((await attempt(app, "203.0.113.200", "password123", "192.0.2.11")).status).toBe(200);
  });

  test("with one trusted proxy, the last X-Forwarded-For entry is the key", async () => {
    const app = new Hono().route("/api", adminRoutes(store, loadEnv({ KEYGATE_TRUSTED_PROXY_HOPS: "1" })));
    for (let i = 0; i < 10; i++) expect((await attempt(app, `203.0.113.${i}, 198.51.100.7`, "wrong-password")).status).toBe(401);
    expect((await attempt(app, "203.0.113.200, 198.51.100.7", "password123")).status).toBe(429);
    expect((await attempt(app, "198.51.100.7, 198.51.100.8", "password123")).status).toBe(200);
  });
});
