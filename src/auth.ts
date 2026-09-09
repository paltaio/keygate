import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "./env.ts";
import { SESSION_COOKIE } from "./proxy.ts";
import type { ApiKey, Store, User } from "./store.ts";

export interface AuthVariables {
  user: User;
  /** Set when the request authenticated with an admin API key instead of a session. */
  apiKey?: ApiKey;
}

export type AuthContext = Context<{ Variables: AuthVariables }>;

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

/** True when this IP may attempt a login; counts the attempt. */
export function allowLoginAttempt(ip: string, now = Date.now()): boolean {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

export function clearLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

function secure(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

export function startSession(c: Context, store: Store, env: Env, userId: number): void {
  const id = store.createSession(userId, env.KEYGATE_SESSION_DAYS);
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: secure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: env.KEYGATE_SESSION_DAYS * 86_400,
  });
}

export function endSession(c: Context, store: Store): void {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) store.deleteSession(id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Accepts a session cookie or an admin API key as a bearer token. API-key requests act as the key's creator. */
export function requireUser(store: Store): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth && /^bearer\s+/i.test(auth)) {
      const key = store.apiKeyByValue(auth.replace(/^bearer\s+/i, "").trim());
      const user = key && !key.revoked_at && key.created_by ? store.userById(key.created_by) : null;
      if (!key || !user) return c.json({ error: "invalid_api_key", message: "This API key is unknown or revoked" }, 401);
      store.touchApiKey(key.id);
      c.set("user", user);
      c.set("apiKey", key);
      await next();
      return;
    }
    const id = getCookie(c, SESSION_COOKIE);
    const user = id ? store.sessionUser(id) : null;
    if (!user) return c.json({ error: "unauthenticated", message: "Sign in first" }, 401);
    c.set("user", user);
    await next();
  };
}

/** Routes that only a signed-in person may use: managing users and API keys. */
export function requireSession(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (c.get("apiKey")) return c.json({ error: "session_required", message: "Sign in to the dashboard for this" }, 403);
    await next();
  };
}

export async function bootstrapAdmin(store: Store, env: Env): Promise<void> {
  if (store.userCount() > 0) return;
  if (!env.KEYGATE_ADMIN_EMAIL || !env.KEYGATE_ADMIN_PASSWORD) {
    console.warn("keygate: no users exist and KEYGATE_ADMIN_EMAIL / KEYGATE_ADMIN_PASSWORD are unset; the dashboard has no login");
    return;
  }
  const hash = await Bun.password.hash(env.KEYGATE_ADMIN_PASSWORD);
  store.createUser(env.KEYGATE_ADMIN_EMAIL, env.KEYGATE_ADMIN_NAME, hash);
  console.log(`keygate: created first user ${env.KEYGATE_ADMIN_EMAIL}`);
}
