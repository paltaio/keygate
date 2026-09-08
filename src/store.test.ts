import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

test("columns added after the first release are created on older databases", () => {
  const dir = mkdtempSync(join(tmpdir(), "keygate-"));
  const path = join(dir, "old.db");
  const first = new Store(path);
  for (const [table, column] of [["upstreams", "strategy"], ["provider_keys", "enabled"], ["tokens", "enabled"]]) {
    first.db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  first.db.run("INSERT INTO tokens (name, hint, hash, scopes, origins, created_at) VALUES ('t', 'h', 'x', '[]', '[]', 'now')");
  first.close();

  const second = new Store(path);
  const token = second.tokens()[0];
  expect(token?.enabled).toBe(1);
  expect(second.db.query<{ name: string }, []>("PRAGMA table_info(upstreams)").all().some((c) => c.name === "strategy")).toBe(true);
  second.close();
  rmSync(dir, { recursive: true });
});
