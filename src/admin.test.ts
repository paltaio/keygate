import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "./admin.ts";
import { loadEnv } from "./env.ts";
import { Store } from "./store.ts";

const env = loadEnv({ KEYGATE_DATA_DIR: ":memory:" });

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

  test("a revoked or unknown key is refused", async () => {
    expect((await app.request("/api/upstreams", { headers: { authorization: "Bearer kga_nope" } })).status).toBe(401);
    const id = store.apiKeys()[0]?.id ?? 0;
    expect((await app.request(`/api/api-keys/${id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await app.request("/api/upstreams", { headers: { authorization: `Bearer ${apiKey}` } })).status).toBe(401);
  });
});
