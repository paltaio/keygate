import type { Env } from "./env.ts";
import { TOKEN_QUERY, bodyKinds, bodyMediaKind, extractToken, inject, joinUrl, parseCookies, serializeBody, serializeCookies, type Carrier, type ParsedBody } from "./inject.ts";
import { PolicyCache, customResponse, runRequestPolicies, runResponsePolicies, type PolicyStop, type ResponseBody } from "./policies.ts";
import type { Json } from "./policy.ts";
import { MissingSecretError, RESERVED_SLUGS, missingSecrets, parseList, parsePlacements, parseSecrets, placeholderNames, type Placement, type ProviderKey, type Store, type Token, type Upstream } from "./store.ts";

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

const ONE_PLACEHOLDER = /^([^{]*)\{\{\s*[A-Za-z0-9_]+\s*\}\}([^{]*)$/;

/** How a placement looks with the consumer token standing in for the credential, if it can carry one. */
function tokenSlot(p: Placement): string | undefined {
  const match = ONE_PLACEHOLDER.exec(p.value);
  if (!match) return undefined;
  const value = `${match[1] ?? ""}kg_...${match[2] ?? ""}`;
  switch (p.type) {
    case "header":
      return `\`${p.name}: ${value}\``;
    case "query":
      return `\`?${p.name}=${value}\``;
    case "cookie":
      return `\`Cookie: ${p.name}=${value}\``;
    case "json":
      return `\`"${p.name}": "${value}"\` in the JSON body`;
    case "form":
      return `\`${p.name}=${value}\` in the form body`;
  }
}

const TOKEN_SLOTS = ["`X-Keygate-Token: kg_...`", "`Authorization: Bearer kg_...`", `\`?${TOKEN_QUERY}=kg_...\``];

/** The public llms.txt for an upstream: how to call it through keygate, followed by its docs. */
export function llmsText(upstream: Upstream, origin: string, publicHost: string | undefined): string {
  const bases = [`${origin}/${upstream.slug}`];
  if (publicHost) bases.push(`https://${upstream.slug}.${publicHost}`);
  const slots = [...TOKEN_SLOTS];
  for (const p of parsePlacements(upstream.placements)) {
    const slot = tokenSlot(p);
    if (slot && !slots.includes(slot)) slots.push(slot);
  }
  const lines = [
    `# ${upstream.name}`,
    "",
    `> ${upstream.name} API through keygate. Requests go to ${upstream.base_url} with the provider credential added; callers send a keygate token (kg_...).`,
    "",
    `- Base URL: ${bases.map((b) => `\`${b}\``).join(" or ")}`,
    `- Paths after the base URL are appended to \`${upstream.base_url}\`.`,
    `- Token, any one of: ${slots.join(", ")}`,
  ];
  const docs = upstream.docs.trim();
  if (docs) lines.push("", docs);
  return `${lines.join("\n")}\n`;
}

/** The root llms.txt. `upstreams` is what the caller's token reaches; without a token the list is left out. */
export function directoryText(origin: string, upstreams: Upstream[] | undefined): string {
  const lines = [
    "# keygate",
    "",
    `> API proxy at ${origin}. Each upstream is a third-party API reached through keygate with a keygate token (kg_...); keygate adds the provider credential.`,
    "",
    `- Token, any one of: ${TOKEN_SLOTS.join(", ")}`,
    `- \`${origin}/<slug>/llms.txt\` has an upstream's base URL, where else the token is accepted, and its docs.`,
    "",
    "## Upstreams",
    "",
  ];
  if (!upstreams) lines.push(`Send a token with this request to list the upstreams it reaches: \`curl -H "X-Keygate-Token: kg_..." ${origin}/llms.txt\``);
  else if (!upstreams.length) lines.push("This token reaches no upstreams.");
  else for (const u of upstreams) lines.push(`- [${u.name}](${origin}/${u.slug}/llms.txt): \`${origin}/${u.slug}\` to ${u.base_url}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The client address: the socket peer when no proxy is trusted, else the `hops`-th entry from the
 * right of X-Forwarded-For, or null when the header has fewer entries.
 */
export function clientIp(hops: number, forwardedFor: string | null, socket: () => string | null): string | null {
  if (hops === 0) return socket();
  const entries = forwardedFor ? forwardedFor.split(",").map((e) => e.trim()) : [];
  return entries[entries.length - hops] || null;
}

function publicOrigin(env: Env, url: URL): string {
  return env.KEYGATE_HOST ? `https://${env.KEYGATE_HOST}` : url.origin;
}

/** Why a token cannot be used, or undefined when it can. */
function tokenRefusal(token: Token | null): { code: string; message: string } | undefined {
  if (!token || token.revoked_at) return { code: "invalid_token", message: "This token is unknown or revoked" };
  if (!token.enabled) return { code: "disabled_token", message: "This token is disabled" };
  if (token.expires_at && token.expires_at <= new Date().toISOString()) return { code: "expired_token", message: "This token has expired" };
  return undefined;
}

/** GET /llms.txt on the bare host. A token, if sent, must be valid; the list then covers its scopes. */
export function serveDirectory(store: Store, env: Env, req: Request): Response {
  const url = new URL(req.url);
  const value = extractToken({ url, headers: new Headers(req.headers) }, []);
  let upstreams: Upstream[] | undefined;
  if (value) {
    const token = store.tokenByValue(value);
    const refusal = tokenRefusal(token);
    if (refusal || !token) return error(401, refusal?.code ?? "invalid_token", refusal?.message ?? "This token is unknown or revoked");
    const scopes = parseList(token.scopes);
    upstreams = store.upstreams().filter((u) => scopes.includes("*") || scopes.includes(u.slug));
  }
  const text = directoryText(publicOrigin(env, url), upstreams);
  return new Response(req.method === "HEAD" ? null : text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
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
  const kind = bodyMediaKind(req.headers.get("content-type"));
  if (wants.json && kind === "json") {
    const text = await req.text();
    const value: Json = text.trim() ? JSON.parse(text) : {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProxyError(400, "body_not_object", "The JSON body must be an object so the key can be added to it");
    }
    return { parsed: { kind: "json", value }, bytes: text.length };
  }
  if (wants.form && kind === "form") {
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

export function createProxy(options: ProxyOptions): (req: Request, ip?: string | null) => Promise<Response> {
  const { store, env } = options;
  const doFetch = options.fetch ?? fetch;
  const turns = new Map<number, number>();
  const policies = new PolicyCache();

  function pickKey(upstream: Upstream, placements: Placement[]): ProviderKey | null {
    if (upstream.strategy !== "round_robin") return store.activeKey(upstream.id);
    const pool = store.liveKeys(upstream.id).filter((k) => missingSecrets(placements, parseSecrets(k.secrets)).length === 0);
    if (!pool.length) return null;
    const cutoff = Date.now() - FAILING_COOLDOWN_MS;
    const healthy = pool.filter((k) => !k.failing_at || Date.parse(k.failing_at) < cutoff);
    const candidates = healthy.length ? healthy : pool;
    const turn = turns.get(upstream.id) ?? 0;
    turns.set(upstream.id, turn + 1);
    return candidates[turn % candidates.length] ?? null;
  }

  return async function handle(req: Request, ip: string | null = null): Promise<Response> {
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

    if (target.path === "/llms.txt" && (req.method === "GET" || req.method === "HEAD")) {
      const text = llmsText(upstream, publicOrigin(env, url), env.KEYGATE_HOST);
      return new Response(req.method === "HEAD" ? null : text, { headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
    }

    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS" && origin && req.headers.has("access-control-request-method")) {
      if (!store.originAllowed(upstream.slug, origin)) return error(403, "origin_not_allowed", "No token allows this origin");
      return new Response(null, { status: 204, headers: corsHeaders(origin, req) });
    }

    const started = performance.now();
    const log = (fields: { token_id: number | null; status: number | null; bytes_in: number; bytes_out: number | null; error: string | null; policy?: string }): void => {
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
    const stop = (tokenId: number, outcome: PolicyStop, bytesIn: number): Response => {
      const cors = origin ? corsHeaders(origin, req) : {};
      if (outcome.kind === "respond") {
        const { response, bytes } = customResponse(outcome, cors);
        log({ token_id: tokenId, status: outcome.status, bytes_in: bytesIn, bytes_out: bytes, error: "policy_response", policy: outcome.policy });
        return response;
      }
      const status = outcome.kind === "deny" ? outcome.status : 500;
      const code = outcome.kind === "deny" ? "policy_denied" : "policy_error";
      log({ token_id: tokenId, status, bytes_in: bytesIn, bytes_out: null, error: code, policy: outcome.policy });
      return Response.json({ error: code, policy: outcome.policy, message: outcome.message }, { status, headers: cors });
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
    const refusal = tokenRefusal(token);
    if (refusal || !token) return reject(token?.id ?? null, 401, refusal?.code ?? "invalid_token", refusal?.message ?? "This token is unknown or revoked", body.bytes);
    const scopes = parseList(token.scopes);
    if (!scopes.includes("*") && !scopes.includes(upstream.slug)) return reject(token.id, 403, "upstream_not_in_scope", `This token is not scoped to ${upstream.slug}`, body.bytes);
    if (origin) {
      const origins = parseList(token.origins);
      if (!origins.includes("*") && !origins.includes(origin)) return reject(token.id, 403, "origin_not_allowed", "This token does not allow requests from this origin", body.bytes);
    }

    let rawBody: string | ArrayBuffer | undefined = body.raw;
    using lease = policies.lease(store.runnablePolicies(token.id));
    const policyCtx = {
      token: { id: token.id, name: token.name, scopes },
      upstream: { slug: upstream.slug, name: upstream.name, base_url: upstream.base_url },
      origin,
      ip,
      method: req.method,
    };
    if (lease.size) {
      const outcome = await runRequestPolicies(lease, {
        request: req,
        carrier,
        raw: body.raw,
        path: target.path,
        baseUrl: upstream.base_url,
        reservedHeaders: REQUEST_STRIP,
        ctx: policyCtx,
      });
      if (outcome.kind === "invalid_body") return reject(token.id, 400, "invalid_body", "The request body could not be parsed", body.bytes);
      if (outcome.kind !== "continue") return stop(token.id, outcome, body.bytes);
      if (outcome.body !== undefined) rawBody = outcome.body;
    }

    const key = pickKey(upstream, placements);
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
    } else if (typeof rawBody === "string" || (rawBody && rawBody.byteLength > 0)) {
      outBody = rawBody;
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
    let status = res.status;
    let resBody: ResponseBody = res.body;
    if (lease.size) {
      const outcome = await runResponsePolicies(lease, { response: res, headers: outHeaders, reservedHeaders: RESPONSE_STRIP, ctx: policyCtx });
      if (outcome.kind === "upstream_error") return reject(token.id, 502, "upstream_unreachable", outcome.message, body.bytes);
      if (outcome.kind !== "continue") return stop(token.id, outcome, body.bytes);
      status = outcome.status;
      resBody = outcome.body;
    }
    if (origin) for (const [name, value] of Object.entries(corsHeaders(origin, req))) outHeaders.set(name, value);

    if (!(resBody instanceof ReadableStream)) {
      const bytes = resBody === null ? 0 : typeof resBody === "string" ? Buffer.byteLength(resBody) : resBody.byteLength;
      log({ token_id: token.id, status, bytes_in: body.bytes, bytes_out: bytes, error: null });
      return new Response(resBody, { status, headers: outHeaders });
    }

    let bytesOut = 0;
    const counted = resBody.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesOut += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          log({ token_id: token.id, status, bytes_in: body.bytes, bytes_out: bytesOut, error: null });
        },
      }),
    );
    return new Response(counted, { status, headers: outHeaders });
  };
}
