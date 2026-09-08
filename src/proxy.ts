import type { Env } from "./env.ts";
import { bodyKinds, extractToken, inject, parseCookies, serializeBody, serializeCookies, type Carrier, type ParsedBody } from "./inject.ts";
import { MissingSecretError, RESERVED_SLUGS, parseList, parsePlacements, parseSecrets, placeholderNames, type ProviderKey, type Store, type Upstream } from "./store.ts";

/** A credential flagged by the provider sits out of the round-robin pool for this long. */
const FAILING_COOLDOWN_MS = 5 * 60_000;

export const SESSION_COOKIE = "kg_session";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REQUEST_STRIP = new Set([...HOP_BY_HOP, "host", "content-length", "accept-encoding", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip"]);
const RESPONSE_STRIP = new Set([...HOP_BY_HOP, "content-encoding", "content-length"]);

export interface Target {
  slug: string;
  path: string;
}

/** Which upstream a request addresses: <slug>.<public host> or the first path segment. */
export function resolveTarget(url: URL, host: string | null, publicHost: string | undefined): Target | undefined {
  const hostname = (host ?? url.host).split(":")[0]?.toLowerCase() ?? "";
  if (publicHost && hostname.endsWith(`.${publicHost.toLowerCase()}`)) {
    const slug = hostname.slice(0, -(publicHost.length + 1));
    if (slug && !slug.includes(".")) return { slug, path: url.pathname };
  }
  const match = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return undefined;
  const slug = match[1] ?? "";
  if (RESERVED_SLUGS.has(slug)) return undefined;
  return { slug, path: match[2] ?? "/" };
}

export function isUpstreamHost(host: string | null, publicHost: string | undefined): boolean {
  if (!host || !publicHost) return false;
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  return hostname !== publicHost.toLowerCase() && hostname.endsWith(`.${publicHost.toLowerCase()}`);
}

function joinUrl(base: string, path: string, search: string): URL {
  const url = new URL(base);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${path}`;
  url.search = search;
  return url;
}

function error(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return Response.json({ error: code, message }, { status, headers: extra });
}

function corsHeaders(origin: string, req: Request): Record<string, string> {
  const requested = req.headers.get("access-control-request-headers");
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": requested ?? "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

async function readBody(req: Request, wants: { json: boolean; form: boolean }): Promise<{ parsed?: ParsedBody; raw?: ArrayBuffer; bytes: number }> {
  if (req.method === "GET" || req.method === "HEAD") return { bytes: 0 };
  const contentType = req.headers.get("content-type") ?? "";
  if (wants.json && contentType.includes("application/json")) {
    const text = await req.text();
    const value: unknown = text.trim() ? JSON.parse(text) : {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProxyError(400, "body_not_object", "The JSON body must be an object so the key can be added to it");
    }
    return { parsed: { kind: "json", value: value as Record<string, unknown> }, bytes: text.length };
  }
  if (wants.form && contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return { parsed: { kind: "form", value: new URLSearchParams(text) }, bytes: text.length };
  }
  const raw = await req.arrayBuffer();
  return { raw, bytes: raw.byteLength };
}

class ProxyError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProxyOptions {
  store: Store;
  env: Env;
  fetch?: Fetch;
}

export function createProxy(options: ProxyOptions): (req: Request) => Promise<Response> {
  const { store, env } = options;
  const doFetch = options.fetch ?? fetch;
  const turns = new Map<number, number>();

  function pickKey(upstream: Upstream): ProviderKey | null {
    if (upstream.strategy !== "round_robin") return store.activeKey(upstream.id);
    const pool = store.liveKeys(upstream.id);
    if (!pool.length) return null;
    const cutoff = Date.now() - FAILING_COOLDOWN_MS;
    const healthy = pool.filter((k) => !k.failing_at || Date.parse(k.failing_at) < cutoff);
    const candidates = healthy.length ? healthy : pool;
    const turn = turns.get(upstream.id) ?? 0;
    turns.set(upstream.id, turn + 1);
    return candidates[turn % candidates.length] ?? null;
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = resolveTarget(url, req.headers.get("host"), env.KEYGATE_HOST);
    const upstream = target ? store.upstreamBySlug(target.slug) : null;
    if (!target || !upstream) {
      store.logRequest({
        token_id: null,
        upstream_id: null,
        method: req.method,
        path: url.pathname,
        status: 404,
        latency_ms: null,
        bytes_in: null,
        bytes_out: null,
        origin: req.headers.get("origin"),
        error: "unknown_upstream",
      });
      return error(404, "unknown_upstream", "No upstream is configured for this host or path");
    }

    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS" && origin && req.headers.has("access-control-request-method")) {
      if (!store.originAllowed(upstream.slug, origin)) return error(403, "origin_not_allowed", "No token allows this origin");
      return new Response(null, { status: 204, headers: corsHeaders(origin, req) });
    }

    const started = performance.now();
    const log = (fields: { token_id: number | null; status: number | null; bytes_in: number; bytes_out: number | null; error: string | null }): void => {
      store.logRequest({
        upstream_id: upstream.id,
        method: req.method,
        path: target.path,
        latency_ms: Math.round(performance.now() - started),
        origin,
        ...fields,
      });
    };
    const reject = (tokenId: number | null, status: number, code: string, message: string, bytesIn: number): Response => {
      log({ token_id: tokenId, status, bytes_in: bytesIn, bytes_out: null, error: code });
      return error(status, code, message, origin ? corsHeaders(origin, req) : {});
    };

    const headers = new Headers();
    for (const [name, value] of req.headers) if (!REQUEST_STRIP.has(name)) headers.set(name, value);
    const cookies = parseCookies(headers.get("cookie"));
    if (cookies.delete(SESSION_COOKIE)) {
      if (cookies.size) headers.set("cookie", serializeCookies(cookies));
      else headers.delete("cookie");
    }

    const placements = parsePlacements(upstream.placements);
    let body: Awaited<ReturnType<typeof readBody>>;
    try {
      body = await readBody(req, bodyKinds(placements));
    } catch (e) {
      if (e instanceof ProxyError) return reject(null, e.status, e.code, e.message, 0);
      return reject(null, 400, "invalid_body", "The request body could not be parsed", 0);
    }

    const carrier: Carrier = { url: joinUrl(upstream.base_url, target.path, url.search), headers };
    if (body.parsed) carrier.body = body.parsed;

    const tokenValue = extractToken(carrier, placements);
    if (!tokenValue) return reject(null, 401, "missing_token", "Send a keygate token in X-Keygate-Token, Authorization: Bearer, ?keygate_token, or the upstream's own key slot", body.bytes);
    const token = store.tokenByValue(tokenValue);
    if (!token || token.revoked_at) return reject(token?.id ?? null, 401, "invalid_token", "This token is unknown or revoked", body.bytes);
    if (!token.enabled) return reject(token.id, 401, "disabled_token", "This token is disabled", body.bytes);
    if (token.expires_at && token.expires_at <= new Date().toISOString()) return reject(token.id, 401, "expired_token", "This token has expired", body.bytes);
    const scopes = parseList(token.scopes);
    if (!scopes.includes("*") && !scopes.includes(upstream.slug)) return reject(token.id, 403, "upstream_not_in_scope", `This token is not scoped to ${upstream.slug}`, body.bytes);
    if (origin) {
      const origins = parseList(token.origins);
      if (!origins.includes("*") && !origins.includes(origin)) return reject(token.id, 403, "origin_not_allowed", "This token does not allow requests from this origin", body.bytes);
    }

    const key = pickKey(upstream);
    if (!key && placeholderNames(placements).length) return reject(token.id, 503, "no_active_key", `${upstream.slug} has no enabled credential to use`, body.bytes);
    try {
      inject(carrier, placements, key ? parseSecrets(key.secrets) : {});
    } catch (e) {
      if (e instanceof MissingSecretError) return reject(token.id, 503, "credential_incomplete", e.message, body.bytes);
      throw e;
    }
    store.touchToken(token.id);

    let outBody: string | ArrayBuffer | null = null;
    if (carrier.body) {
      const serialized = serializeBody(carrier.body);
      outBody = serialized.text;
      headers.set("content-type", serialized.contentType);
    } else if (body.raw && body.raw.byteLength > 0) {
      outBody = body.raw;
    }

    let res: Response;
    try {
      res = await doFetch(carrier.url.toString(), {
        method: req.method,
        headers,
        body: outBody,
        redirect: "manual",
        signal: AbortSignal.timeout(env.KEYGATE_UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reject(token.id, 502, "upstream_unreachable", message, body.bytes);
    }

    if (key) store.markKeyResult(key.id, res.status);

    const outHeaders = new Headers();
    for (const [name, value] of res.headers) if (!RESPONSE_STRIP.has(name)) outHeaders.append(name, value);
    if (origin) for (const [name, value] of Object.entries(corsHeaders(origin, req))) outHeaders.set(name, value);

    if (!res.body) {
      log({ token_id: token.id, status: res.status, bytes_in: body.bytes, bytes_out: 0, error: null });
      return new Response(null, { status: res.status, headers: outHeaders });
    }

    let bytesOut = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesOut += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          log({ token_id: token.id, status: res.status, bytes_in: body.bytes, bytes_out: bytesOut, error: null });
        },
      }),
    );
    return new Response(counted, { status: res.status, headers: outHeaders });
  };
}
