import { describe, expect, test } from "bun:test";
import { extractToken, inject, type Carrier, type Slot } from "./inject.ts";

function carrier(init: { url?: string; headers?: Record<string, string>; body?: Carrier["body"] } = {}): Carrier {
  const c: Carrier = { url: new URL(init.url ?? "https://up.example/v1/x"), headers: new Headers(init.headers) };
  if (init.body) c.body = init.body;
  return c;
}

const header: Slot = { type: "header", name: "x-api-key", prefix: "" };
const bearer: Slot = { type: "header", name: "authorization", prefix: "Bearer " };
const query: Slot = { type: "query", name: "key", prefix: "" };
const cookie: Slot = { type: "cookie", name: "sid", prefix: "" };
const json: Slot = { type: "json", name: "api_key", prefix: "" };
const form: Slot = { type: "form", name: "api_key", prefix: "" };

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

  test("upstream header slot with prefix", () => {
    const c = carrier({ headers: { authorization: "Bearer kg_a" } });
    expect(extractToken(c, bearer)).toBe("kg_a");
  });

  test("upstream query slot", () => {
    const c = carrier({ url: "https://up.example/v1?key=kg_a" });
    expect(extractToken(c, query)).toBe("kg_a");
    expect(c.url.searchParams.has("key")).toBe(false);
  });

  test("upstream cookie slot keeps other cookies", () => {
    const c = carrier({ headers: { cookie: "a=1; sid=kg_a; b=2" } });
    expect(extractToken(c, cookie)).toBe("kg_a");
    expect(c.headers.get("cookie")).toBe("a=1; b=2");
  });

  test("json body slot", () => {
    const c = carrier({ body: { kind: "json", value: { api_key: "kg_a", q: 1 } } });
    expect(extractToken(c, json)).toBe("kg_a");
    expect(c.body).toEqual({ kind: "json", value: { q: 1 } });
  });

  test("form body slot", () => {
    const c = carrier({ body: { kind: "form", value: new URLSearchParams("api_key=kg_a&q=1") } });
    expect(extractToken(c, form)).toBe("kg_a");
    expect(c.body?.value.toString()).toBe("q=1");
  });

  test("nothing found", () => {
    expect(extractToken(carrier(), header)).toBeUndefined();
  });
});

describe("inject", () => {
  test("header with prefix", () => {
    const c = carrier();
    inject(c, bearer, "real");
    expect(c.headers.get("authorization")).toBe("Bearer real");
  });

  test("query", () => {
    const c = carrier();
    inject(c, query, "real");
    expect(c.url.searchParams.get("key")).toBe("real");
  });

  test("cookie merges", () => {
    const c = carrier({ headers: { cookie: "a=1" } });
    inject(c, cookie, "real");
    expect(c.headers.get("cookie")).toBe("a=1; sid=real");
  });

  test("json and form bodies", () => {
    const j = carrier({ body: { kind: "json", value: {} } });
    inject(j, json, "real");
    expect(j.body).toEqual({ kind: "json", value: { api_key: "real" } });
    const f = carrier({ body: { kind: "form", value: new URLSearchParams() } });
    inject(f, form, "real");
    expect(f.body?.value.toString()).toBe("api_key=real");
  });
});
