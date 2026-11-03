import { afterAll, describe, expect, test } from "bun:test";
import { BLANK_POLICY, POLICY_TEMPLATES } from "../web/src/policy-templates.ts";
import { compilePolicy, loadPolicy, type Policy, type PolicyContext, type PolicyRequest } from "./policy.ts";

const ctx: PolicyContext = {
  token: { id: 1, name: "ci", scopes: ["openai"] },
  upstream: { slug: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1" },
  origin: null,
  ip: null,
  method: "POST",
};

function request(init: Partial<PolicyRequest> = {}): PolicyRequest {
  return { method: "POST", path: "/chat/completions", query: {}, headers: {}, body: { model: "gpt-5" }, ...init };
}

const loaded: Policy[] = [];
afterAll(() => {
  for (const p of loaded) p.dispose();
});

async function template(id: string): Promise<Policy> {
  const source = POLICY_TEMPLATES.find((t) => t.id === id)?.source;
  if (!source) throw new Error(`no template ${id}`);
  const compiled = await compilePolicy(source);
  if (!compiled.ok) throw new Error(compiled.message);
  const result = await loadPolicy(compiled.policy.js);
  if (!result.ok) throw new Error(result.message);
  loaded.push(result.policy);
  return result.policy;
}

describe("dashboard policy templates", () => {
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
