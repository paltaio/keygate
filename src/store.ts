import { Database } from "bun:sqlite";
import { POLICY_NEEDS, type PolicyNeed } from "./policy.ts";

export const PLACEMENT_TYPES = ["header", "query", "cookie", "json", "form"] as const;
export type PlacementType = (typeof PLACEMENT_TYPES)[number];

/** Where one value goes on the outgoing request. `value` is a template; `{{name}}` is filled from the active credential. */
export interface Placement {
  type: PlacementType;
  name: string;
  value: string;
}

export const STRATEGIES = ["active", "round_robin"] as const;
export type Strategy = (typeof STRATEGIES)[number];

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
  /** JSON array of Placement. */
  placements: string;
  /** `active`: the one active credential serves every request. `round_robin`: enabled credentials take turns. */
  strategy: Strategy;
  notes: string;
  /** Markdown served publicly at /<slug>/llms.txt. */
  docs: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderKey {
  id: number;
  upstream_id: number;
  label: string;
  /** JSON object: placeholder name to secret value. */
  secrets: string;
  active: number;
  enabled: number;
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
  enabled: number;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  rotated_at: string | null;
}

export interface ApiKey {
  id: number;
  name: string;
  hint: string;
  hash: string;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_at: string | null;
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
  /** Name of the policy that denied, answered, or failed the request. */
  policy: string | null;
}

export interface StoredPolicy {
  id: number;
  name: string;
  source: string;
  /** Type-stripped module the sandbox loads. */
  compiled: string;
  /** JSON array of PolicyNeed. */
  needs: string;
  enabled: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type PolicySummary = Omit<StoredPolicy, "source" | "compiled"> & { token_count: number };

/** One entry of a token's attachment list; `enabled` is the attachment's own switch. */
export interface TokenPolicy {
  policy_id: number;
  name: string;
  enabled: number;
  position: number;
}

/** A policy the proxy runs for a token: both the policy and its attachment are enabled. */
export interface RunnablePolicy {
  id: number;
  name: string;
  needs: PolicyNeed[];
  compiled: string;
  updated_at: string;
}

export interface TokenRef {
  id: number;
  name: string;
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
  placements TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  docs TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_keys (
  id INTEGER PRIMARY KEY,
  upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  secrets TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
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
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  rotated_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hint TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  rotated_at TEXT
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
  error TEXT,
  policy TEXT
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_token ON requests(token_id, ts);
CREATE INDEX IF NOT EXISTS requests_upstream ON requests(upstream_id, ts);
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  compiled TEXT NOT NULL,
  needs TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_policies (
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  policy_id INTEGER NOT NULL REFERENCES policies(id),
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (token_id, policy_id)
);
CREATE INDEX IF NOT EXISTS token_policies_policy ON token_policies(policy_id);
`;

/** Columns added after the first release; applied to databases created before them. */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["upstreams", "strategy", "TEXT NOT NULL DEFAULT 'active'"],
  ["provider_keys", "enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["tokens", "enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["tokens", "rotated_at", "TEXT"],
  ["api_keys", "rotated_at", "TEXT"],
  ["upstreams", "docs", "TEXT NOT NULL DEFAULT ''"],
  ["requests", "policy", "TEXT"],
];

export const RESERVED_SLUGS = new Set(["admin", "api", "health", "assets", "docs"]);

const now = (): string => new Date().toISOString();

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** Consumer tokens, accepted by the proxy. */
export const TOKEN_PREFIX = "kg_";
/** Admin API keys, accepted by /api. */
export const API_KEY_PREFIX = "kga_";

function randomToken(prefix: string = TOKEN_PREFIX): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + Buffer.from(bytes).toString("base64url");
}

function tokenHint(token: string, prefix: string = TOKEN_PREFIX): string {
  return `${token.slice(0, prefix.length + 4)}...${token.slice(-4)}`;
}

export function secretHint(secret: string): string {
  return secret.length <= 8 ? "****" : `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

export interface UpstreamInput {
  slug: string;
  name: string;
  base_url: string;
  placements: Placement[];
  strategy: Strategy;
  notes: string;
  docs: string;
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
  policy?: string | null | undefined;
}

export interface RequestFilter {
  token_id?: number | undefined;
  upstream_id?: number | undefined;
  /** Exact policy name. */
  policy?: string | undefined;
  status?: "ok" | "client_error" | "upstream_error" | "proxy_error" | undefined;
  before?: number | undefined;
  limit: number;
}

export interface PolicyInput {
  name: string;
  source: string;
  compiled: string;
  needs: PolicyNeed[];
}

export interface TokenPolicyInput {
  policy_id: number;
  enabled: boolean;
}

export type PolicyDeleteResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "in_use"; tokens: TokenRef[] };

export type PolicyListError = { ok: false; error: "unknown_policy" | "duplicate_policy"; policy_ids: number[] };

export type SetTokenPoliciesResult = { ok: true } | { ok: false; error: "token_not_found" } | PolicyListError;

export type CreateTokenResult = { ok: true; id: number; token: string } | PolicyListError;

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
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const columns = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!columns.some((c) => c.name === column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
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
        `INSERT INTO upstreams (slug, name, base_url, placements, strategy, notes, docs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.slug, input.name, input.base_url, JSON.stringify(input.placements), input.strategy, input.notes, input.docs, ts, ts);
    return Number(result.lastInsertRowid);
  }

  updateUpstream(id: number, input: UpstreamInput): boolean {
    const result = this.db
      .query<never, [string, string, string, string, string, string, string, string, number]>(
        `UPDATE upstreams SET slug = ?, name = ?, base_url = ?, placements = ?, strategy = ?, notes = ?, docs = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.slug, input.name, input.base_url, JSON.stringify(input.placements), input.strategy, input.notes, input.docs, now(), id);
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
        "SELECT * FROM provider_keys WHERE upstream_id = ? AND active = 1 AND enabled = 1 AND revoked_at IS NULL LIMIT 1",
      )
      .get(upstreamId);
  }

  /** Enabled, unrevoked credentials in creation order: the round-robin pool. */
  liveKeys(upstreamId: number): ProviderKey[] {
    return this.db
      .query<ProviderKey, [number]>(
        "SELECT * FROM provider_keys WHERE upstream_id = ? AND enabled = 1 AND revoked_at IS NULL ORDER BY id",
      )
      .all(upstreamId);
  }

  /** Renames a credential and merges values: a string sets one, null removes one, absent leaves it. */
  updateKey(id: number, input: { label?: string | undefined; secrets?: Record<string, string | null> | undefined }): boolean {
    const key = this.keyById(id);
    if (!key || key.revoked_at) return false;
    const secrets = parseSecrets(key.secrets);
    for (const [name, value] of Object.entries(input.secrets ?? {})) {
      if (value === null) delete secrets[name];
      else secrets[name] = value;
    }
    this.db
      .query<never, [string, string, number]>("UPDATE provider_keys SET label = ?, secrets = ? WHERE id = ?")
      .run(input.label ?? key.label, JSON.stringify(secrets), id);
    return true;
  }

  setKeyEnabled(id: number, enabled: boolean): boolean {
    return (
      this.db
        .query<never, [number, number]>("UPDATE provider_keys SET enabled = ? WHERE id = ? AND revoked_at IS NULL")
        .run(enabled ? 1 : 0, id).changes > 0
    );
  }

  addKey(upstreamId: number, label: string, secrets: Record<string, string>, activate: boolean, createdBy: number): number {
    const insert = this.db.query<never, [number, string, string, number, number, string]>(
      `INSERT INTO provider_keys (upstream_id, label, secrets, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      if (activate) this.deactivateKeys(upstreamId);
      return Number(insert.run(upstreamId, label, JSON.stringify(secrets), activate ? 1 : 0, createdBy, now()).lastInsertRowid);
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

  /** Replaces the secret of a live token in place; scopes, origins and expiry stay. Returns the new plaintext. */
  rotateToken(id: number): string | null {
    const token = randomToken();
    const changed = this.db
      .query<never, [string, string, string, number]>(
        "UPDATE tokens SET hint = ?, hash = ?, rotated_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(tokenHint(token), sha256(token), now(), id).changes;
    return changed > 0 ? token : null;
  }

  /** Revoking also detaches every policy from the token. */
  revokeToken(id: number): boolean {
    const run = this.db.transaction((): boolean => {
      const revoked =
        this.db
          .query<never, [string, number]>("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now(), id).changes > 0;
      if (revoked) this.db.query<never, [number]>("DELETE FROM token_policies WHERE token_id = ?").run(id);
      return revoked;
    });
    return run();
  }

  setTokenEnabled(id: number, enabled: boolean): boolean {
    return (
      this.db
        .query<never, [number, number]>("UPDATE tokens SET enabled = ? WHERE id = ? AND revoked_at IS NULL")
        .run(enabled ? 1 : 0, id).changes > 0
    );
  }

  touchToken(id: number): void {
    this.db.query<never, [string, number]>("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now(), id);
  }

  /** Whether any live token scoped to this upstream allows the browser origin. Used for preflight only. */
  originAllowed(slug: string, origin: string): boolean {
    const rows = this.db
      .query<Pick<Token, "scopes" | "origins">, [string]>(
        "SELECT scopes, origins FROM tokens WHERE revoked_at IS NULL AND enabled = 1 AND (expires_at IS NULL OR expires_at > ?)",
      )
      .all(now());
    return rows.some((row) => {
      const scopes = parseList(row.scopes);
      const origins = parseList(row.origins);
      return (scopes.includes("*") || scopes.includes(slug)) && (origins.includes("*") || origins.includes(origin));
    });
  }

  // Admin API keys

  apiKeys(): ApiKey[] {
    return this.db.query<ApiKey, []>("SELECT * FROM api_keys ORDER BY id DESC").all();
  }

  apiKeyByValue(value: string): ApiKey | null {
    return this.db.query<ApiKey, [string]>("SELECT * FROM api_keys WHERE hash = ?").get(sha256(value));
  }

  createApiKey(name: string, createdBy: number): { id: number; key: string } {
    const key = randomToken(API_KEY_PREFIX);
    const result = this.db
      .query<never, [string, string, string, number, string]>(
        "INSERT INTO api_keys (name, hint, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(name, tokenHint(key, API_KEY_PREFIX), sha256(key), createdBy, now());
    return { id: Number(result.lastInsertRowid), key };
  }

  /** Replaces the secret of a live API key in place. Returns the new plaintext. */
  rotateApiKey(id: number): string | null {
    const key = randomToken(API_KEY_PREFIX);
    const changed = this.db
      .query<never, [string, string, string, number]>(
        "UPDATE api_keys SET hint = ?, hash = ?, rotated_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(tokenHint(key, API_KEY_PREFIX), sha256(key), now(), id).changes;
    return changed > 0 ? key : null;
  }

  revokeApiKey(id: number): boolean {
    return (
      this.db
        .query<never, [string, number]>("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now(), id).changes > 0
    );
  }

  touchApiKey(id: number): void {
    this.db.query<never, [string, number]>("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), id);
  }

  // Policies

  policies(): PolicySummary[] {
    return this.db
      .query<PolicySummary, []>(
        `SELECT p.id, p.name, p.needs, p.enabled, p.created_by, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM token_policies tp WHERE tp.policy_id = p.id) AS token_count
         FROM policies p ORDER BY p.name`,
      )
      .all();
  }

  policyById(id: number): StoredPolicy | null {
    return this.db.query<StoredPolicy, [number]>("SELECT * FROM policies WHERE id = ?").get(id);
  }

  policyByName(name: string): StoredPolicy | null {
    return this.db.query<StoredPolicy, [string]>("SELECT * FROM policies WHERE name = ?").get(name);
  }

  createPolicy(input: PolicyInput, createdBy: number): number {
    const ts = now();
    const result = this.db
      .query<never, [string, string, string, string, number, string, string]>(
        `INSERT INTO policies (name, source, compiled, needs, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.source, input.compiled, JSON.stringify(input.needs), createdBy, ts, ts);
    return Number(result.lastInsertRowid);
  }

  updatePolicy(id: number, input: PolicyInput): boolean {
    // updated_at keys the proxy's compiled-policy cache, so every update must move it forward,
    // even two updates within the same millisecond.
    return (
      this.db
        .query<never, [string, string, string, string, string, number]>(
          `UPDATE policies SET name = ?1, source = ?2, compiled = ?3, needs = ?4,
             updated_at = CASE WHEN ?5 > updated_at THEN ?5
                               ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') END
           WHERE id = ?6`,
        )
        .run(input.name, input.source, input.compiled, JSON.stringify(input.needs), now(), id).changes > 0
    );
  }

  setPolicyEnabled(id: number, enabled: boolean): boolean {
    return (
      this.db.query<never, [number, number]>("UPDATE policies SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes > 0
    );
  }

  /** Refuses while any token has the policy attached, enabled or not. */
  deletePolicy(id: number): PolicyDeleteResult {
    const run = this.db.transaction((): PolicyDeleteResult => {
      const tokens = this.policyTokens(id);
      if (tokens.length > 0) return { status: "in_use", tokens };
      const deleted = this.db.query<never, [number]>("DELETE FROM policies WHERE id = ?").run(id).changes > 0;
      return { status: deleted ? "deleted" : "not_found" };
    });
    return run();
  }

  /** Tokens with the policy attached, enabled or not. */
  policyTokens(policyId: number): TokenRef[] {
    return this.db
      .query<TokenRef, [number]>(
        `SELECT t.id, t.name FROM token_policies tp JOIN tokens t ON t.id = tp.token_id
         WHERE tp.policy_id = ? ORDER BY t.id`,
      )
      .all(policyId);
  }

  /** The token's attachment list in run order. */
  tokenPolicies(tokenId: number): TokenPolicy[] {
    return this.db
      .query<TokenPolicy, [number]>(
        `SELECT tp.policy_id, p.name, tp.enabled, tp.position FROM token_policies tp JOIN policies p ON p.id = tp.policy_id
         WHERE tp.token_id = ? ORDER BY tp.position`,
      )
      .all(tokenId);
  }

  /** Replaces the token's attachment list with `attachments` in the given order, all or nothing. */
  setTokenPolicies(tokenId: number, attachments: readonly TokenPolicyInput[]): SetTokenPoliciesResult {
    const replace = this.db.transaction((): SetTokenPoliciesResult => {
      const token = this.tokenById(tokenId);
      if (!token || token.revoked_at) return { ok: false, error: "token_not_found" };
      const invalid = this.invalidPolicyList(attachments);
      if (invalid) return invalid;
      this.writeTokenPolicies(tokenId, attachments);
      return { ok: true };
    });
    return replace();
  }

  /** Creates a token with `attachments` in order, in one transaction; nothing is written when the list is invalid. */
  createTokenWithPolicies(input: TokenInput, createdBy: number, attachments: readonly TokenPolicyInput[]): CreateTokenResult {
    const run = this.db.transaction((): CreateTokenResult => {
      const invalid = this.invalidPolicyList(attachments);
      if (invalid) return invalid;
      const created = this.createToken(input, createdBy);
      this.writeTokenPolicies(created.id, attachments);
      return { ok: true, ...created };
    });
    return run();
  }

  /** Updates a live token and replaces its attachment list in one transaction, all or nothing. */
  updateTokenWithPolicies(id: number, input: TokenInput, attachments: readonly TokenPolicyInput[]): SetTokenPoliciesResult {
    const run = this.db.transaction((): SetTokenPoliciesResult => {
      const token = this.tokenById(id);
      if (!token || token.revoked_at) return { ok: false, error: "token_not_found" };
      const invalid = this.invalidPolicyList(attachments);
      if (invalid) return invalid;
      this.updateToken(id, input);
      this.writeTokenPolicies(id, attachments);
      return { ok: true };
    });
    return run();
  }

  private invalidPolicyList(attachments: readonly TokenPolicyInput[]): PolicyListError | undefined {
    const ids = attachments.map((a) => a.policy_id);
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (duplicates.length > 0) return { ok: false, error: "duplicate_policy", policy_ids: duplicates };
    const unknown = ids.filter((id) => !this.policyById(id));
    if (unknown.length > 0) return { ok: false, error: "unknown_policy", policy_ids: unknown };
    return undefined;
  }

  private writeTokenPolicies(tokenId: number, attachments: readonly TokenPolicyInput[]): void {
    this.db.query<never, [number]>("DELETE FROM token_policies WHERE token_id = ?").run(tokenId);
    const insert = this.db.query<never, [number, number, number, number]>(
      "INSERT INTO token_policies (token_id, policy_id, position, enabled) VALUES (?, ?, ?, ?)",
    );
    attachments.forEach((a, position) => insert.run(tokenId, a.policy_id, position, a.enabled ? 1 : 0));
  }

  runnablePolicies(tokenId: number): RunnablePolicy[] {
    return this.db
      .query<Omit<RunnablePolicy, "needs"> & { needs: string }, [number]>(
        `SELECT p.id, p.name, p.needs, p.compiled, p.updated_at FROM token_policies tp JOIN policies p ON p.id = tp.policy_id
         WHERE tp.token_id = ? AND tp.enabled = 1 AND p.enabled = 1 ORDER BY tp.position`,
      )
      .all(tokenId)
      .map((row) => ({ ...row, needs: parseNeeds(row.needs) }));
  }

  // Request log

  logRequest(input: RequestLogInput): void {
    this.db
      .query<never, [string, number | null, number | null, string, string, number | null, number | null, number | null, number | null, string | null, string | null, string | null]>(
        `INSERT INTO requests (ts, token_id, upstream_id, method, path, status, latency_ms, bytes_in, bytes_out, origin, error, policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.policy ?? null,
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
    if (filter.policy !== undefined) {
      where.push("policy = ?");
      params.push(filter.policy);
    }
    if (filter.before !== undefined) {
      where.push("id < ?");
      params.push(filter.before);
    }
    switch (filter.status) {
      case "ok":
        where.push("status < 400 AND error IS NULL");
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

export function parsePlacements(json: string): Placement[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (p): p is Placement =>
        typeof p === "object" && p !== null && PLACEMENT_TYPES.includes((p as Placement).type) &&
        typeof (p as Placement).name === "string" && typeof (p as Placement).value === "string",
    );
  } catch {
    return [];
  }
}

export function parseSecrets(json: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every `{{name}}` referenced by the placements, in first-seen order. */
export function placeholderNames(placements: Placement[]): string[] {
  const names: string[] = [];
  for (const p of placements) {
    for (const m of p.value.matchAll(PLACEHOLDER)) {
      const name = m[1];
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Placeholder names the placements need that the credential does not hold. */
export function missingSecrets(placements: Placement[], secrets: Record<string, string>): string[] {
  return placeholderNames(placements).filter((n) => !(n in secrets));
}

export function renderTemplate(template: string, secrets: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = secrets[name];
    if (value === undefined) throw new MissingSecretError(name);
    return value;
  });
}

export class MissingSecretError extends Error {
  secret: string;
  constructor(secret: string) {
    super(`The active credential has no value for {{${secret}}}`);
    this.name = "MissingSecretError";
    this.secret = secret;
  }
}

export function parseNeeds(json: string): PolicyNeed[] {
  return parseList(json).filter((n): n is PolicyNeed => POLICY_NEEDS.some((need) => need === n));
}

export function parseList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
