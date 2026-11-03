import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type PolicyInput } from "./store.ts";

test("columns added after the first release are created on older databases", () => {
  const dir = mkdtempSync(join(tmpdir(), "keygate-"));
  const path = join(dir, "old.db");
  const first = new Store(path);
  for (const [table, column] of [["upstreams", "strategy"], ["provider_keys", "enabled"], ["tokens", "enabled"], ["requests", "policy"]]) {
    first.db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  first.db.run("INSERT INTO tokens (name, hint, hash, scopes, origins, created_at) VALUES ('t', 'h', 'x', '[]', '[]', 'now')");
  first.db.run("INSERT INTO requests (ts, method, path) VALUES ('now', 'GET', '/')");
  first.close();

  const second = new Store(path);
  const token = second.tokens()[0];
  expect(token?.enabled).toBe(1);
  expect(second.db.query<{ name: string }, []>("PRAGMA table_info(upstreams)").all().some((c) => c.name === "strategy")).toBe(true);
  expect(second.requests({ limit: 10 })[0]?.policy).toBeNull();
  second.close();
  rmSync(dir, { recursive: true });
});

const policyInput = (name: string, needs: PolicyInput["needs"] = []): PolicyInput => ({
  name,
  source: `export const meta = { name: "${name}" };`,
  compiled: `export const meta = { name: "${name}" };`,
  needs,
});

describe("policies", () => {
  let store: Store;
  let userId: number;
  let tokenId: number;
  let a: number;
  let b: number;
  let c: number;
  beforeEach(() => {
    store = new Store(":memory:");
    userId = store.createUser("a@b.test", "A", "x");
    tokenId = store.createToken({ name: "t1", scopes: ["*"], origins: ["*"], expires_at: null }, userId).id;
    a = store.createPolicy(policyInput("alpha", ["body"]), userId);
    b = store.createPolicy(policyInput("bravo", ["body", "responseBody"]), userId);
    c = store.createPolicy(policyInput("charlie"), userId);
  });

  test("create, look up and list", () => {
    const alpha = store.policyById(a);
    expect(alpha).toMatchObject({ id: a, name: "alpha", needs: '["body"]', enabled: 1, created_by: userId });
    expect(alpha?.created_at).toBe(alpha?.updated_at ?? "");
    expect(store.policyByName("bravo")?.id).toBe(b);
    expect(store.policyByName("missing")).toBeNull();
    expect(store.policyById(999)).toBeNull();
    expect(() => store.createPolicy(policyInput("alpha"), userId)).toThrow();

    store.setTokenPolicies(tokenId, [{ policy_id: b, enabled: false }]);
    const list = store.policies();
    expect(list.map((p) => [p.name, p.token_count])).toEqual([["alpha", 0], ["bravo", 1], ["charlie", 0]]);
    expect(list[0]).not.toHaveProperty("source");
    expect(list[0]).not.toHaveProperty("compiled");
  });

  test("update replaces the fields and moves updated_at forward", () => {
    const before = store.policyById(a);
    expect(store.updatePolicy(a, { ...policyInput("alpha-2"), source: "s2", compiled: "c2" })).toBe(true);
    const first = store.policyById(a);
    expect(first).toMatchObject({ name: "alpha-2", source: "s2", compiled: "c2", needs: "[]", created_at: before?.created_at ?? "" });
    expect((first?.updated_at ?? "") > (before?.updated_at ?? "")).toBe(true);
    store.updatePolicy(a, policyInput("alpha-2"));
    expect((store.policyById(a)?.updated_at ?? "") > (first?.updated_at ?? "")).toBe(true);
    expect(store.updatePolicy(999, policyInput("x"))).toBe(false);
  });

  test("enable and disable", () => {
    expect(store.setPolicyEnabled(a, false)).toBe(true);
    expect(store.policyById(a)?.enabled).toBe(0);
    expect(store.setPolicyEnabled(a, true)).toBe(true);
    expect(store.policyById(a)?.enabled).toBe(1);
    expect(store.setPolicyEnabled(999, true)).toBe(false);
  });

  test("replacing attachments sets the order", () => {
    expect(store.tokenPolicies(tokenId)).toEqual([]);
    expect(store.setTokenPolicies(tokenId, [{ policy_id: c, enabled: true }, { policy_id: a, enabled: false }, { policy_id: b, enabled: true }])).toEqual({ ok: true });
    expect(store.tokenPolicies(tokenId)).toEqual([
      { policy_id: c, name: "charlie", enabled: 1, position: 0 },
      { policy_id: a, name: "alpha", enabled: 0, position: 1 },
      { policy_id: b, name: "bravo", enabled: 1, position: 2 },
    ]);
    store.setTokenPolicies(tokenId, [{ policy_id: b, enabled: true }, { policy_id: c, enabled: true }]);
    expect(store.tokenPolicies(tokenId).map((p) => [p.name, p.position])).toEqual([["bravo", 0], ["charlie", 1]]);
    expect(store.setTokenPolicies(tokenId, [])).toEqual({ ok: true });
    expect(store.tokenPolicies(tokenId)).toEqual([]);
  });

  test("a failing replace leaves the old list", () => {
    store.setTokenPolicies(tokenId, [{ policy_id: a, enabled: true }, { policy_id: b, enabled: false }]);
    const old = store.tokenPolicies(tokenId);
    expect(store.setTokenPolicies(tokenId, [{ policy_id: c, enabled: true }, { policy_id: 999, enabled: true }])).toEqual({
      ok: false,
      error: "unknown_policy",
      policy_ids: [999],
    });
    expect(store.tokenPolicies(tokenId)).toEqual(old);
    expect(store.setTokenPolicies(tokenId, [{ policy_id: c, enabled: true }, { policy_id: c, enabled: false }])).toEqual({
      ok: false,
      error: "duplicate_policy",
      policy_ids: [c],
    });
    expect(store.tokenPolicies(tokenId)).toEqual(old);
    expect(store.setTokenPolicies(999, [{ policy_id: a, enabled: true }])).toEqual({ ok: false, error: "token_not_found" });
  });

  test("runnable policies skip disabled attachments and disabled policies", () => {
    store.setTokenPolicies(tokenId, [{ policy_id: c, enabled: true }, { policy_id: a, enabled: false }, { policy_id: b, enabled: true }]);
    const charlie = store.policyById(c);
    const bravo = store.policyById(b);
    expect(store.runnablePolicies(tokenId)).toEqual([
      { id: c, name: "charlie", needs: [], compiled: charlie?.compiled ?? "", updated_at: charlie?.updated_at ?? "" },
      { id: b, name: "bravo", needs: ["body", "responseBody"], compiled: bravo?.compiled ?? "", updated_at: bravo?.updated_at ?? "" },
    ]);
    store.setPolicyEnabled(c, false);
    expect(store.runnablePolicies(tokenId).map((p) => p.name)).toEqual(["bravo"]);
  });

  test("tokens using a policy", () => {
    const other = store.createToken({ name: "t2", scopes: ["*"], origins: ["*"], expires_at: null }, userId).id;
    store.setTokenPolicies(tokenId, [{ policy_id: a, enabled: true }]);
    store.setTokenPolicies(other, [{ policy_id: b, enabled: true }, { policy_id: a, enabled: false }]);
    expect(store.policyTokens(a)).toEqual([{ id: tokenId, name: "t1" }, { id: other, name: "t2" }]);
    expect(store.policyTokens(b)).toEqual([{ id: other, name: "t2" }]);
    expect(store.policyTokens(c)).toEqual([]);
  });

  test("delete is refused while attached", () => {
    store.setTokenPolicies(tokenId, [{ policy_id: a, enabled: false }]);
    expect(store.deletePolicy(a)).toEqual({ status: "in_use", tokens: [{ id: tokenId, name: "t1" }] });
    expect(store.policyById(a)).not.toBeNull();

    store.setTokenPolicies(tokenId, []);
    expect(store.deletePolicy(a)).toEqual({ status: "deleted" });
    expect(store.policyById(a)).toBeNull();
    expect(store.deletePolicy(a)).toEqual({ status: "not_found" });
  });

  test("revoking a token detaches its policies", () => {
    const other = store.createToken({ name: "t2", scopes: ["*"], origins: ["*"], expires_at: null }, userId).id;
    store.setTokenPolicies(tokenId, [{ policy_id: a, enabled: true }, { policy_id: b, enabled: false }]);
    store.setTokenPolicies(other, [{ policy_id: b, enabled: true }]);
    expect(store.revokeToken(tokenId)).toBe(true);
    expect(store.tokenPolicies(tokenId)).toEqual([]);
    expect(store.policyTokens(b)).toEqual([{ id: other, name: "t2" }]);
    expect(store.deletePolicy(a)).toEqual({ status: "deleted" });
    expect(store.setTokenPolicies(tokenId, [{ policy_id: c, enabled: true }])).toEqual({ ok: false, error: "token_not_found" });
    expect(store.tokenPolicies(tokenId)).toEqual([]);
  });

  test("request log filter by policy", () => {
    const log = { token_id: tokenId, upstream_id: null, method: "POST", path: "/v1", status: 403, latency_ms: 1, bytes_in: 0, bytes_out: 0, origin: null };
    store.logRequest({ ...log, error: "policy_denied", policy: "alpha" });
    store.logRequest({ ...log, error: "policy_error", policy: "alpha-2" });
    store.logRequest({ ...log, status: 200, error: null });
    expect(store.requests({ limit: 10, policy: "alpha" }).map((r) => [r.policy, r.error])).toEqual([["alpha", "policy_denied"]]);
    expect(store.requests({ limit: 10, policy: "alph" })).toEqual([]);
    expect(store.requests({ limit: 10 }).map((r) => r.policy)).toEqual([null, "alpha-2", "alpha"]);

    store.logRequest({ ...log, status: 200, error: "policy_response", policy: "bravo" });
    expect(store.requests({ limit: 10, status: "ok" }).map((r) => r.error)).toEqual([null]);
    expect(store.requests({ limit: 10, status: "proxy_error" }).map((r) => r.policy)).toEqual(["bravo", "alpha-2", "alpha"]);
  });
});
