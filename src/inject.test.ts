import { describe, expect, test } from "bun:test";
import { bodyKinds, extractToken, inject, type Carrier } from "./inject.ts";
import { MissingSecretError, placeholderNames, type Placement } from "./store.ts";

function carrier(init: { url?: string; headers?: Record<string, string>; body?: Carrier["body"] } = {}): Carrier {
  const c: Carrier = { url: new URL(init.url ?? "https://up.example/v1/x"), headers: new Headers(init.headers) };
  if (init.body) c.body = init.body;
  return c;
}

const header: Placement[] = [{ type: "header", name: "x-api-key", value: "{{key}}" }];
const bearer: Placement[] = [{ type: "header", name: "authorization", value: "Bearer {{key}}" }];
const query: Placement[] = [{ type: "query", name: "key", value: "{{key}}" }];
const cookie: Placement[] = [{ type: "cookie", name: "sid", value: "{{key}}" }];
const json: Placement[] = [{ type: "json", name: "api_key", value: "{{key}}" }];
const form: Placement[] = [{ type: "form", name: "api_key", value: "{{key}}" }];
const multi: Placement[] = [
  { type: "header", name: "authorization", value: "Bearer {{token}}" },
  { type: "header", name: "x-api-key", value: "{{key}}" },
  { type: "header", name: "x-client", value: "keygate" },
  { type: "json", name: "client_id", value: "{{client_id}}" },
];

describe("extractToken", () => {
  test("dedicated header wins and is removed", () => {
    const c = carrier({ headers: { "x-keygate-token": "kg_a", "x-api-key": "kg_b" } });
    expect(extractToken(c, header)).toBe("kg_a");
    expect(c.headers.has("x-keygate-token")).toBe(false);
    expect(c.headers.get("x-api-key")).toBe("kg_b");
  });

  test("bearer authorization holding a keygate token", () => {
    const c = carrier({ headers: { authorization: "Bearer kg_a" } });
    expect(extractToken(c, header)).toBe("kg_a");
    expect(c.headers.has("authorization")).toBe(false);
  });

  test("bearer authorization holding something else is left alone", () => {
    const c = carrier({ headers: { authorization: "Bearer other" } });
    expect(extractToken(c, header)).toBeUndefined();
    expect(c.headers.get("authorization")).toBe("Bearer other");
  });

  test("query parameter", () => {
    const c = carrier({ url: "https://up.example/v1?keygate_token=kg_a&q=1" });
    expect(extractToken(c, header)).toBe("kg_a");
    expect(c.url.search).toBe("?q=1");
  });

  test("placement with literal prefix", () => {
    const c = carrier({ headers: { authorization: "Bearer kg_a" } });
    expect(extractToken(c, bearer)).toBe("kg_a");
    expect(c.headers.has("authorization")).toBe(false);
  });

  test("query placement", () => {
    const c = carrier({ url: "https://up.example/v1?key=kg_a" });
    expect(extractToken(c, query)).toBe("kg_a");
    expect(c.url.searchParams.has("key")).toBe(false);
  });

  test("cookie placement keeps other cookies", () => {
    const c = carrier({ headers: { cookie: "a=1; sid=kg_a; b=2" } });
    expect(extractToken(c, cookie)).toBe("kg_a");
    expect(c.headers.get("cookie")).toBe("a=1; b=2");
  });

  test("json body placement", () => {
    const c = carrier({ body: { kind: "json", value: { api_key: "kg_a", q: 1 } } });
    expect(extractToken(c, json)).toBe("kg_a");
    expect(c.body).toEqual({ kind: "json", value: { q: 1 } });
  });

  test("form body placement", () => {
    const c = carrier({ body: { kind: "form", value: new URLSearchParams("api_key=kg_a&q=1") } });
    expect(extractToken(c, form)).toBe("kg_a");
    expect(c.body?.value.toString()).toBe("q=1");
  });

  test("token in the second of several placements", () => {
    const c = carrier({ headers: { "x-api-key": "kg_a" }, body: { kind: "json", value: {} } });
    expect(extractToken(c, multi)).toBe("kg_a");
    expect(c.headers.has("x-api-key")).toBe(false);
  });

  test("nothing found", () => {
    expect(extractToken(carrier(), header)).toBeUndefined();
    expect(extractToken(carrier({ headers: { "x-client": "keygate" } }), multi)).toBeUndefined();
  });
});

describe("inject", () => {
  test("header with prefix", () => {
    const c = carrier();
    inject(c, bearer, { key: "real" });
    expect(c.headers.get("authorization")).toBe("Bearer real");
  });

  test("query", () => {
    const c = carrier();
    inject(c, query, { key: "real" });
    expect(c.url.searchParams.get("key")).toBe("real");
  });

  test("cookie merges", () => {
    const c = carrier({ headers: { cookie: "a=1" } });
    inject(c, cookie, { key: "real" });
    expect(c.headers.get("cookie")).toBe("a=1; sid=real");
  });

  test("json and form bodies", () => {
    const j = carrier({ body: { kind: "json", value: {} } });
    inject(j, json, { key: "real" });
    expect(j.body).toEqual({ kind: "json", value: { api_key: "real" } });
    const f = carrier({ body: { kind: "form", value: new URLSearchParams() } });
    inject(f, form, { key: "real" });
    expect(f.body?.value.toString()).toBe("api_key=real");
  });

  test("several placements from one credential, constants included", () => {
    const c = carrier({ body: { kind: "json", value: { q: 1 } } });
    inject(c, multi, { token: "T", key: "K", client_id: "C" });
    expect(c.headers.get("authorization")).toBe("Bearer T");
    expect(c.headers.get("x-api-key")).toBe("K");
    expect(c.headers.get("x-client")).toBe("keygate");
    expect(c.body).toEqual({ kind: "json", value: { q: 1, client_id: "C" } });
  });

  test("missing value throws", () => {
    expect(() => inject(carrier(), multi, { token: "T" })).toThrow(MissingSecretError);
  });
});

describe("placements", () => {
  test("placeholder names and body kinds", () => {
    expect(placeholderNames(multi)).toEqual(["token", "key", "client_id"]);
    expect(bodyKinds(multi)).toEqual({ json: true, form: false });
    expect(bodyKinds(header)).toEqual({ json: false, form: false });
  });
});
