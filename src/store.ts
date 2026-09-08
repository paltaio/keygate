import { Database } from "bun:sqlite";

export const SLOT_TYPES = ["header", "query", "cookie", "json", "form"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export interface User {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

export interface Upstream {
  id: number;
  slug: string;
  name: string;
  base_url: string;
  slot_type: SlotType;
  slot_name: string;
  slot_prefix: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderKey {
  id: number;
  upstream_id: number;
  label: string;
  secret: string;
  active: number;
  failing_at: string | null;
  failing_status: number | null;
  last_used_at: string | null;
  created_by: number | null;
  created_at: string;
  revoked_at: string | null;
}

export interface Token {
  id: number;
  name: string;
  hint: string;
  hash: string;
  /** JSON array of upstream slugs, or ["*"]. */
  scopes: string;
  /** JSON array of browser origins, or ["*"]. */
  origins: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
}

export interface RequestLog {
  id: number;
  ts: string;
  token_id: number | null;
  upstream_id: number | null;
  method: string;
  path: string;
  status: number | null;
  latency_ms: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
  origin: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upstreams (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  slot_type TEXT NOT NULL,
  slot_name TEXT NOT NULL,
  slot_prefix TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_keys (
  id INTEGER PRIMARY KEY,
  upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  failing_at TEXT,
  failing_status INTEGER,
  last_used_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS provider_keys_upstream ON provider_keys(upstream_id, active);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hint TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  origins TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  token_id INTEGER,
  upstream_id INTEGER,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  bytes_in INTEGER,
  bytes_out INTEGER,
  origin TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_token ON requests(token_id, ts);
CREATE INDEX IF NOT EXISTS requests_upstream ON requests(upstream_id, ts);
`;

export const RESERVED_SLUGS = new Set(["admin", "api", "health", "assets"]);

const now = (): string => new Date().toISOString();

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export const TOKEN_PREFIX = "kg_";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + Buffer.from(bytes).toString("base64url");
}

function tokenHint(token: string): string {
  return `${token.slice(0, TOKEN_PREFIX.length + 4)}...${token.slice(-4)}`;
}

export function secretHint(secret: string): string {
  return secret.length <= 8 ? "****" : `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

export interface UpstreamInput {
  slug: string;
  name: string;
  base_url: string;
  slot_type: SlotType;
  slot_name: string;
  slot_prefix: string;
  notes: string;
}

export interface TokenInput {
  name: string;
  scopes: string[];
  origins: string[];
  expires_at: string | null;
}

export interface RequestLogInput {
  token_id: number | null;
  upstream_id: number | null;
  method: string;
  path: string;
  status: number | null;
  latency_ms: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
  origin: string | null;
  error: string | null;
}

export interface RequestFilter {
  token_id?: number | undefined;
  upstream_id?: number | undefined;
  status?: "ok" | "client_error" | "upstream_error" | "proxy_error" | undefined;
  before?: number | undefined;
  limit: number;
}

export interface UpstreamStat {
  upstream_id: number | null;
  requests: number;
  /** Responses the upstream answered with 4xx or 5xx. */
  errors: number;
  /** Requests keygate refused before reaching the upstream. */
  rejected: number;
  avg_latency_ms: number | null;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Users and sessions

  userCount(): number {
    const row = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get();
    return row?.n ?? 0;
  }

  users(): Omit<User, "password_hash">[] {
    return this.db
      .query<Omit<User, "password_hash">, []>("SELECT id, email, name, created_at FROM users ORDER BY id")
      .all();
  }

  userByEmail(email: string): User | null {
    return this.db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email);
  }

  userById(id: number): User | null {
    return this.db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(id);
  }

  createUser(email: string, name: string, passwordHash: string): number {
    const result = this.db
      .query<never, [string, string, string, string]>(
        "INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(email, name, passwordHash, now());
    return Number(result.lastInsertRowid);
  }

  setPassword(userId: number, passwordHash: string): void {
    this.db.query<never, [string, number]>("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  }

  deleteUser(id: number): boolean {
    return this.db.query<never, [number]>("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  createSession(userId: number, days: number): string {
    const id = randomToken();
    const expires = new Date(Date.now() + days * 86_400_000).toISOString();
    this.db
      .query<never, [string, number, string, string]>(
        "INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(sha256(id), userId, now(), expires);
    return id;
  }

  sessionUser(sessionId: string): User | null {
    return this.db
      .query<User, [string, string]>(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(sessionId), now());
  }

  deleteSession(sessionId: string): void {
    this.db.query<never, [string]>("DELETE FROM sessions WHERE hash = ?").run(sha256(sessionId));
  }

  // Upstreams

  upstreams(): Upstream[] {
    return this.db.query<Upstream, []>("SELECT * FROM upstreams ORDER BY slug").all();
  }

  upstreamBySlug(slug: string): Upstream | null {
    return this.db.query<Upstream, [string]>("SELECT * FROM upstreams WHERE slug = ?").get(slug);
  }

  upstreamById(id: number): Upstream | null {
    return this.db.query<Upstream, [number]>("SELECT * FROM upstreams WHERE id = ?").get(id);
  }

  createUpstream(input: UpstreamInput): number {
    const ts = now();
    const result = this.db
      .query<never, [string, string, string, string, string, string, string, string, string]>(
        `INSERT INTO upstreams (slug, name, base_url, slot_type, slot_name, slot_prefix, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.slug, input.name, input.base_url, input.slot_type, input.slot_name, input.slot_prefix, input.notes, ts, ts);
    return Number(result.lastInsertRowid);
  }

  updateUpstream(id: number, input: UpstreamInput): boolean {
    const result = this.db
      .query<never, [string, string, string, string, string, string, string, string, number]>(
        `UPDATE upstreams SET slug = ?, name = ?, base_url = ?, slot_type = ?, slot_name = ?, slot_prefix = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.slug, input.name, input.base_url, input.slot_type, input.slot_name, input.slot_prefix, input.notes, now(), id);
    return result.changes > 0;
  }

  deleteUpstream(id: number): boolean {
    return this.db.query<never, [number]>("DELETE FROM upstreams WHERE id = ?").run(id).changes > 0;
  }

  // Provider keys

  keysForUpstream(upstreamId: number): ProviderKey[] {
    return this.db
      .query<ProviderKey, [number]>("SELECT * FROM provider_keys WHERE upstream_id = ? ORDER BY active DESC, id DESC")
      .all(upstreamId);
  }

  keyById(id: number): ProviderKey | null {
    return this.db.query<ProviderKey, [number]>("SELECT * FROM provider_keys WHERE id = ?").get(id);
  }

  activeKey(upstreamId: number): ProviderKey | null {
    return this.db
      .query<ProviderKey, [number]>(
        "SELECT * FROM provider_keys WHERE upstream_id = ? AND active = 1 AND revoked_at IS NULL LIMIT 1",
      )
      .get(upstreamId);
  }

  addKey(upstreamId: number, label: string, secret: string, activate: boolean, createdBy: number): number {
    const insert = this.db.query<never, [number, string, string, number, number, string]>(
      `INSERT INTO provider_keys (upstream_id, label, secret, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      if (activate) this.deactivateKeys(upstreamId);
      return Number(insert.run(upstreamId, label, secret, activate ? 1 : 0, createdBy, now()).lastInsertRowid);
    });
    return run();
  }

  private deactivateKeys(upstreamId: number): void {
    this.db.query<never, [number]>("UPDATE provider_keys SET active = 0 WHERE upstream_id = ?").run(upstreamId);
  }

  activateKey(id: number): boolean {
    const key = this.keyById(id);
    if (!key || key.revoked_at) return false;
    const run = this.db.transaction(() => {
      this.deactivateKeys(key.upstream_id);
      this.db
        .query<never, [number]>("UPDATE provider_keys SET active = 1, failing_at = NULL, failing_status = NULL WHERE id = ?")
        .run(id);
    });
    run();
    return true;
  }

  revokeKey(id: number): boolean {
    return (
      this.db
        .query<never, [string, number]>(
          "UPDATE provider_keys SET revoked_at = ?, active = 0 WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now(), id).changes > 0
    );
  }

  markKeyResult(id: number, status: number): void {
    const ts = now();
    if (status === 401 || status === 403) {
      this.db
        .query<never, [string, number, string, number]>(
          "UPDATE provider_keys SET failing_at = ?, failing_status = ?, last_used_at = ? WHERE id = ?",
        )
        .run(ts, status, ts, id);
    } else if (status < 400) {
      this.db
        .query<never, [string, number]>(
          "UPDATE provider_keys SET failing_at = NULL, failing_status = NULL, last_used_at = ? WHERE id = ?",
        )
        .run(ts, id);
    } else {
      this.db.query<never, [string, number]>("UPDATE provider_keys SET last_used_at = ? WHERE id = ?").run(ts, id);
    }
  }

  // Consumer tokens

  tokens(): Token[] {
    return this.db.query<Token, []>("SELECT * FROM tokens ORDER BY id DESC").all();
  }

  tokenById(id: number): Token | null {
    return this.db.query<Token, [number]>("SELECT * FROM tokens WHERE id = ?").get(id);
  }

  tokenByValue(value: string): Token | null {
    return this.db.query<Token, [string]>("SELECT * FROM tokens WHERE hash = ?").get(sha256(value));
  }

  createToken(input: TokenInput, createdBy: number): { id: number; token: string } {
    const token = randomToken();
    const result = this.db
      .query<never, [string, string, string, string, string, string | null, number, string]>(
        `INSERT INTO tokens (name, hint, hash, scopes, origins, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        tokenHint(token),
        sha256(token),
        JSON.stringify(input.scopes),
        JSON.stringify(input.origins),
        input.expires_at,
        createdBy,
        now(),
      );
    return { id: Number(result.lastInsertRowid), token };
  }

  updateToken(id: number, input: TokenInput): boolean {
    return (
      this.db
        .query<never, [string, string, string, string | null, number]>(
          "UPDATE tokens SET name = ?, scopes = ?, origins = ?, expires_at = ? WHERE id = ?",
        )
        .run(input.name, JSON.stringify(input.scopes), JSON.stringify(input.origins), input.expires_at, id).changes > 0
    );
  }

  revokeToken(id: number): boolean {
    return (
      this.db
        .query<never, [string, number]>("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now(), id).changes > 0
    );
  }

  touchToken(id: number): void {
    this.db.query<never, [string, number]>("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now(), id);
  }

  /** Whether any live token scoped to this upstream allows the browser origin. Used for preflight only. */
  originAllowed(slug: string, origin: string): boolean {
    const rows = this.db
      .query<Pick<Token, "scopes" | "origins">, [string]>(
        "SELECT scopes, origins FROM tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .all(now());
    return rows.some((row) => {
      const scopes = parseList(row.scopes);
      const origins = parseList(row.origins);
      return (scopes.includes("*") || scopes.includes(slug)) && (origins.includes("*") || origins.includes(origin));
    });
  }

  // Request log

  logRequest(input: RequestLogInput): void {
    this.db
      .query<never, [string, number | null, number | null, string, string, number | null, number | null, number | null, number | null, string | null, string | null]>(
        `INSERT INTO requests (ts, token_id, upstream_id, method, path, status, latency_ms, bytes_in, bytes_out, origin, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        input.token_id,
        input.upstream_id,
        input.method,
        input.path,
        input.status,
        input.latency_ms,
        input.bytes_in,
        input.bytes_out,
        input.origin,
        input.error,
      );
  }

  requests(filter: RequestFilter): RequestLog[] {
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (filter.token_id !== undefined) {
      where.push("token_id = ?");
      params.push(filter.token_id);
    }
    if (filter.upstream_id !== undefined) {
      where.push("upstream_id = ?");
      params.push(filter.upstream_id);
    }
    if (filter.before !== undefined) {
      where.push("id < ?");
      params.push(filter.before);
    }
    switch (filter.status) {
      case "ok":
        where.push("status < 400");
        break;
      case "client_error":
        where.push("status >= 400 AND status < 500 AND error IS NULL");
        break;
      case "upstream_error":
        where.push("status >= 500 AND error IS NULL");
        break;
      case "proxy_error":
        where.push("error IS NOT NULL");
        break;
      case undefined:
        break;
    }
    const sql = `SELECT * FROM requests${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    params.push(filter.limit);
    return this.db.query<RequestLog, (number | string)[]>(sql).all(...params);
  }

  statsSince(ts: string): UpstreamStat[] {
    return this.db
      .query<UpstreamStat, [string]>(
        `SELECT upstream_id, COUNT(*) AS requests,
                SUM(CASE WHEN status >= 400 AND error IS NULL THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS rejected,
                AVG(CASE WHEN error IS NULL THEN latency_ms END) AS avg_latency_ms
         FROM requests WHERE ts >= ? GROUP BY upstream_id`,
      )
      .all(ts);
  }

  pruneRequests(olderThanDays: number): number {
    if (olderThanDays <= 0) return 0;
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return this.db.query<never, [string]>("DELETE FROM requests WHERE ts < ?").run(cutoff).changes;
  }

  pruneSessions(): void {
    this.db.query<never, [string]>("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  }
}

export function parseList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
