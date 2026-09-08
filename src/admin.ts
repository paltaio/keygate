import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { allowLoginAttempt, clearLoginAttempts, clientIp, endSession, requireUser, startSession, type AuthVariables } from "./auth.ts";
import type { Env } from "./env.ts";
import { PLACEMENT_TYPES, RESERVED_SLUGS, STRATEGIES, parseList, parsePlacements, parseSecrets, placeholderNames, secretHint, type ProviderKey, type Store, type Token, type Upstream } from "./store.ts";

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes")
  .refine((s) => !RESERVED_SLUGS.has(s), "reserved name");

const origin = z.string().refine((value) => {
  if (value === "*") return true;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, "must be * or an origin like https://app.example.com");

const isoDate = z.iso.datetime({ offset: true });

const secretName = z.string().regex(/^[A-Za-z0-9_]+$/, "letters, digits and underscores");

const placement = z.object({
  type: z.enum(PLACEMENT_TYPES),
  name: z.string().min(1).max(200),
  value: z.string().min(1).max(4000),
});

const schemas = {
  login: z.object({ email: z.email(), password: z.string().min(1) }),
  user: z.object({ email: z.email(), name: z.string().min(1).max(100), password: z.string().min(8).max(200) }),
  password: z.object({ password: z.string().min(8).max(200) }),
  upstream: z.object({
    slug,
    name: z.string().min(1).max(100),
    base_url: z.url({ protocol: /^https?$/ }),
    placements: z.array(placement).min(1).max(20),
    strategy: z.enum(STRATEGIES).default("active"),
    notes: z.string().max(2000).default(""),
  }),
  enabled: z.object({ enabled: z.boolean() }),
  key: z.object({
    label: z.string().min(1).max(100),
    secrets: z.record(secretName, z.string().min(1).max(4000)).refine((s) => Object.keys(s).length > 0, "at least one value"),
    activate: z.boolean().default(true),
  }),
  token: z.object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.union([z.literal("*"), slug])).min(1),
    origins: z.array(origin).default([]),
    expires_at: isoDate.nullable().default(null),
  }),
  requests: z.object({
    token_id: z.coerce.number().int().positive().optional(),
    upstream_id: z.coerce.number().int().positive().optional(),
    status: z.enum(["ok", "client_error", "upstream_error", "proxy_error"]).optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
};

function fail(status: 400 | 404 | 409, code: string, message: string): never {
  throw new HTTPException(status, { res: Response.json({ error: code, message }, { status }) });
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, "invalid_json", "The request body must be JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) fail(400, "validation_failed", result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return result.data;
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) fail(400, "invalid_id", "Route id must be a positive integer");
  return id;
}

export function keyView(key: ProviderKey): Omit<ProviderKey, "secrets"> & { hints: Record<string, string> } {
  const { secrets, ...rest } = key;
  return { ...rest, hints: Object.fromEntries(Object.entries(parseSecrets(secrets)).map(([k, v]) => [k, secretHint(v)])) };
}

export function tokenView(token: Token): Omit<Token, "hash" | "scopes" | "origins"> & { scopes: string[]; origins: string[] } {
  const { hash, scopes, origins, ...rest } = token;
  void hash;
  return { ...rest, scopes: parseList(scopes), origins: parseList(origins) };
}

interface UpstreamView extends Omit<Upstream, "placements"> {
  placements: ReturnType<typeof parsePlacements>;
  secret_names: string[];
  active_key: ReturnType<typeof keyView> | null;
  key_count: number;
  /** Credentials that can serve requests: the active one, or the round-robin pool. */
  usable_key_count: number;
}

function upstreamView(store: Store, upstream: Upstream): UpstreamView {
  const keys = store.keysForUpstream(upstream.id);
  const active = keys.find((k) => k.active === 1 && !k.revoked_at);
  const placements = parsePlacements(upstream.placements);
  const live = keys.filter((k) => !k.revoked_at && k.enabled === 1);
  return {
    ...upstream,
    placements,
    secret_names: placeholderNames(placements),
    active_key: active && active.enabled === 1 ? keyView(active) : null,
    key_count: keys.filter((k) => !k.revoked_at).length,
    usable_key_count: upstream.strategy === "round_robin" ? live.length : active && active.enabled === 1 ? 1 : 0,
  };
}

/** Names the placements need that the credential does not provide. */
function missingSecrets(placements: ReturnType<typeof parsePlacements>, secrets: Record<string, string>): string[] {
  return placeholderNames(placements).filter((n) => !(n in secrets));
}

export function adminRoutes(store: Store, env: Env): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post("/auth/login", async (c) => {
    const ip = clientIp(c);
    if (!allowLoginAttempt(ip)) return c.json({ error: "too_many_attempts", message: "Try again in 15 minutes" }, 429);
    const input = await parseBody(c, schemas.login);
    const user = store.userByEmail(input.email);
    const ok = user ? await Bun.password.verify(input.password, user.password_hash) : false;
    if (!user || !ok) return c.json({ error: "bad_credentials", message: "Email or password is wrong" }, 401);
    clearLoginAttempts(ip);
    startSession(c, store, env, user.id);
    return c.json({ id: user.id, email: user.email, name: user.name });
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/api/auth/login") return next();
    return requireUser(store)(c, next);
  });

  app.post("/auth/logout", (c) => {
    endSession(c, store);
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => {
    const user = c.get("user");
    return c.json({ id: user.id, email: user.email, name: user.name });
  });

  app.get("/overview", (c) => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const stats = new Map(store.statsSince(since).map((s) => [s.upstream_id, s]));
    const upstreams = store.upstreams().map((u) => {
      const s = stats.get(u.id);
      return { ...upstreamView(store, u), requests: s?.requests ?? 0, errors: s?.errors ?? 0, rejected: s?.rejected ?? 0, avg_latency_ms: s?.avg_latency_ms ?? null };
    });
    const unknown = stats.get(null);
    return c.json({
      since,
      upstreams,
      unmatched_requests: unknown?.requests ?? 0,
      tokens: store.tokens().filter((t) => !t.revoked_at && t.enabled === 1).length,
    });
  });

  app.get("/users", (c) => c.json(store.users()));

  app.post("/users", async (c) => {
    const input = await parseBody(c, schemas.user);
    if (store.userByEmail(input.email)) fail(409, "email_taken", "A user with this email exists");
    const id = store.createUser(input.email, input.name, await Bun.password.hash(input.password));
    return c.json({ id, email: input.email, name: input.name }, 201);
  });

  app.post("/users/:id/password", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, schemas.password);
    if (!store.userById(id)) fail(404, "not_found", "No such user");
    store.setPassword(id, await Bun.password.hash(input.password));
    return c.json({ ok: true });
  });

  app.delete("/users/:id", (c) => {
    const id = idParam(c);
    if (id === c.get("user").id) fail(409, "self_delete", "Sign in as another user to delete this one");
    if (!store.deleteUser(id)) fail(404, "not_found", "No such user");
    return c.json({ ok: true });
  });

  app.get("/upstreams", (c) => c.json(store.upstreams().map((u) => upstreamView(store, u))));

  app.post("/upstreams", async (c) => {
    const input = await parseBody(c, schemas.upstream);
    if (store.upstreamBySlug(input.slug)) fail(409, "slug_taken", "An upstream with this slug exists");
    const id = store.createUpstream(input);
    const created = store.upstreamById(id);
    if (!created) fail(404, "not_found", "Upstream vanished after creation");
    return c.json(upstreamView(store, created), 201);
  });

  app.get("/upstreams/:id", (c) => {
    const upstream = store.upstreamById(idParam(c));
    if (!upstream) fail(404, "not_found", "No such upstream");
    return c.json({ ...upstreamView(store, upstream), keys: store.keysForUpstream(upstream.id).map(keyView) });
  });

  app.patch("/upstreams/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, schemas.upstream);
    const existing = store.upstreamBySlug(input.slug);
    if (existing && existing.id !== id) fail(409, "slug_taken", "An upstream with this slug exists");
    const active = store.activeKey(id);
    if (active) {
      const missing = missingSecrets(input.placements, parseSecrets(active.secrets));
      if (missing.length) fail(409, "secrets_missing", `The active credential has no value for: ${missing.join(", ")}. Add a credential with those values first.`);
    }
    if (!store.updateUpstream(id, input)) fail(404, "not_found", "No such upstream");
    const updated = store.upstreamById(id);
    if (!updated) fail(404, "not_found", "No such upstream");
    return c.json(upstreamView(store, updated));
  });

  app.delete("/upstreams/:id", (c) => {
    if (!store.deleteUpstream(idParam(c))) fail(404, "not_found", "No such upstream");
    return c.json({ ok: true });
  });

  app.get("/upstreams/:id/keys", (c) => {
    const upstream = store.upstreamById(idParam(c));
    if (!upstream) fail(404, "not_found", "No such upstream");
    return c.json(store.keysForUpstream(upstream.id).map(keyView));
  });

  app.post("/upstreams/:id/keys", async (c) => {
    const upstream = store.upstreamById(idParam(c));
    if (!upstream) fail(404, "not_found", "No such upstream");
    const input = await parseBody(c, schemas.key);
    const missing = missingSecrets(parsePlacements(upstream.placements), input.secrets);
    if (missing.length) fail(400, "secrets_missing", `Missing values for: ${missing.join(", ")}`);
    const id = store.addKey(upstream.id, input.label, input.secrets, input.activate, c.get("user").id);
    const key = store.keyById(id);
    if (!key) fail(404, "not_found", "Key vanished after creation");
    return c.json(keyView(key), 201);
  });

  app.post("/keys/:id/activate", (c) => {
    if (!store.activateKey(idParam(c))) fail(404, "not_found", "No such key, or it is revoked");
    return c.json({ ok: true });
  });

  app.patch("/keys/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, schemas.enabled);
    if (!store.setKeyEnabled(id, input.enabled)) fail(404, "not_found", "No such credential, or it is revoked");
    const key = store.keyById(id);
    if (!key) fail(404, "not_found", "No such credential");
    return c.json(keyView(key));
  });

  app.delete("/keys/:id", (c) => {
    if (!store.revokeKey(idParam(c))) fail(404, "not_found", "No such key, or it is already revoked");
    return c.json({ ok: true });
  });

  app.get("/tokens", (c) => c.json(store.tokens().map(tokenView)));

  app.post("/tokens", async (c) => {
    const input = await parseBody(c, schemas.token);
    const { id, token } = store.createToken(input, c.get("user").id);
    const created = store.tokenById(id);
    if (!created) fail(404, "not_found", "Token vanished after creation");
    return c.json({ ...tokenView(created), token }, 201);
  });

  app.patch("/tokens/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, schemas.token);
    if (!store.updateToken(id, input)) fail(404, "not_found", "No such token");
    const updated = store.tokenById(id);
    if (!updated) fail(404, "not_found", "No such token");
    return c.json(tokenView(updated));
  });

  app.patch("/tokens/:id/enabled", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, schemas.enabled);
    if (!store.setTokenEnabled(id, input.enabled)) fail(404, "not_found", "No such token, or it is revoked");
    const token = store.tokenById(id);
    if (!token) fail(404, "not_found", "No such token");
    return c.json(tokenView(token));
  });

  app.delete("/tokens/:id", (c) => {
    if (!store.revokeToken(idParam(c))) fail(404, "not_found", "No such token, or it is already revoked");
    return c.json({ ok: true });
  });

  app.get("/requests", (c) => {
    const result = schemas.requests.safeParse(c.req.query());
    if (!result.success) fail(400, "validation_failed", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return c.json(store.requests(result.data));
  });

  return app;
}
