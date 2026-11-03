import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../skill/keygate.ts");

const writes: Array<{ method: string; path: string; body: unknown }> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/api/policies") return Response.json([{ id: 7, name: "gate" }, { id: 9, name: "redact" }]);
    if (req.method === "GET" && pathname === "/api/tokens") return Response.json([{ id: 3, name: "t", scopes: ["up"], origins: [], expires_at: null, policies: [] }]);
    const body: unknown = await req.json();
    writes.push({ method: req.method, path: pathname, body });
    return Response.json({ id: 3, name: "t", hint: "kg_...", scopes: ["up"], origins: [], expires_at: null, policies: [], token: "kg_x" });
  },
});
afterAll(() => server.stop(true));

async function cli(...argv: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv, "--json"], {
    env: { ...process.env, KEYGATE_URL: server.url.href, KEYGATE_API_KEY: "kga_test", KEYGATE_ENV_FILE: "/nonexistent" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("keygate CLI", () => {
  test("token create and update send --policy in the same write", async () => {
    expect((await cli("token", "create", "--name", "t", "--scope", "up", "--policy", "redact", "--policy", "gate:off")).code).toBe(0);
    expect((await cli("token", "update", "3", "--policy", "gate")).code).toBe(0);
    expect((await cli("token", "update", "3", "--name", "u")).code).toBe(0);
    expect(writes).toEqual([
      { method: "POST", path: "/api/tokens", body: { name: "t", scopes: ["up"], origins: [], expires_at: null, policies: [{ policy_id: 9, enabled: true }, { policy_id: 7, enabled: false }] } },
      { method: "PATCH", path: "/api/tokens/3", body: { name: "t", scopes: ["up"], origins: [], expires_at: null, policies: [{ policy_id: 7, enabled: true }] } },
      { method: "PATCH", path: "/api/tokens/3", body: { name: "u", scopes: ["up"], origins: [], expires_at: null } },
    ]);
  });

  test("policy subcommands that act on a policy need its name", async () => {
    for (const sub of ["update", "enable", "disable", "delete"]) {
      expect(await cli("policy", sub)).toEqual({ code: 1, stderr: `keygate: policy ${sub} needs a name\n` });
    }
  });
});
