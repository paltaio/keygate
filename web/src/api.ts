export const PLACEMENT_TYPES = ["header", "query", "cookie", "json", "form"] as const;
export type PlacementType = (typeof PLACEMENT_TYPES)[number];

/** One location on the outgoing request; `value` is a template where `{{name}}` is filled from the active credential. */
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
  created_at: string;
}

export interface ProviderKey {
  id: number;
  upstream_id: number;
  label: string;
  hints: Record<string, string>;
  /** Placeholder names the placements need that this credential does not hold. */
  missing: string[];
  active: number;
  enabled: number;
  failing_at: string | null;
  failing_status: number | null;
  last_used_at: string | null;
  created_by: number | null;
  created_at: string;
  revoked_at: string | null;
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

export interface Upstream extends UpstreamInput {
  id: number;
  created_at: string;
  updated_at: string;
  /** Placeholder names the placements need, in first-seen order. */
  secret_names: string[];
  active_key: ProviderKey | null;
  key_count: number;
  /** Credentials that can serve: 1 or 0 in active mode, the pool size in round_robin. */
  usable_key_count: number;
}

export interface UpstreamDetail extends Upstream {
  keys: ProviderKey[];
}

export interface OverviewUpstream extends Upstream {
  requests: number;
  errors: number;
  rejected: number;
  avg_latency_ms: number | null;
}

export interface Overview {
  since: string;
  upstreams: OverviewUpstream[];
  unmatched_requests: number;
  tokens: number;
}

export interface TokenInput {
  name: string;
  scopes: string[];
  origins: string[];
  expires_at: string | null;
}

/** One entry of a token's ordered policy list; `enabled` is the attachment's own switch. */
export interface TokenPolicy {
  policy_id: number;
  name: string;
  enabled: boolean;
}

export interface TokenPolicyInput {
  policy_id: number;
  enabled: boolean;
}

/** Body of POST and PATCH /tokens; `policies` replaces the ordered attachment list in the same write. */
export interface TokenWrite extends TokenInput {
  policies?: TokenPolicyInput[];
}

export interface Token extends TokenInput {
  id: number;
  hint: string;
  enabled: number;
  revoked_at: string | null;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  rotated_at: string | null;
  policies: TokenPolicy[];
}

export interface CreatedToken extends Token {
  token: string;
}

export type PolicyNeed = "body" | "responseBody";

export interface Policy {
  id: number;
  name: string;
  needs: PolicyNeed[];
  enabled: boolean;
  /** Tokens the policy is attached to, enabled or not. */
  token_count: number;
  created_at: string;
  updated_at: string;
}

export interface TokenRef {
  id: number;
  name: string;
}

export interface PolicyDetail extends Policy {
  source: string;
  tokens: TokenRef[];
}

export interface ApiKey {
  id: number;
  name: string;
  hint: string;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_at: string | null;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface RequestRow {
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

export const REQUEST_STATUSES = ["ok", "client_error", "upstream_error", "proxy_error"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface RequestFilter {
  token_id?: number;
  upstream_id?: number;
  /** Exact policy name. */
  policy?: string;
  status?: RequestStatus;
  before?: number;
  limit?: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  /** The parsed error body, e.g. `tokens` on policy_in_use or `policy_ids` on unknown_policy. */
  body: Record<string, unknown>;

  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const sessionListeners = new Set<() => void>();

/** Runs fn whenever the server answers that the session is gone. */
export function onUnauthenticated(fn: () => void): () => void {
  sessionListeners.add(fn);
  return () => {
    sessionListeners.delete(fn);
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "network", "The server did not answer. Check the connection and try again.");
  }
  if (res.ok) return (await res.json()) as T;
  let code = "request_failed";
  let message = `The server answered with status ${res.status}`;
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = { ...parsed };
    if (typeof data.error === "string") code = data.error;
    if (typeof data.message === "string") message = data.message;
  } catch {
    // Non-JSON error body; keep the status message.
  }
  if (res.status === 401 && code === "unauthenticated") for (const fn of sessionListeners) fn();
  throw new ApiError(res.status, code, message, data);
}

function query(filter: RequestFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined) params.set(key, String(value));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  login: (email: string, password: string) => request<User>("POST", "/auth/login", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  me: () => request<User>("GET", "/auth/me"),
  overview: () => request<Overview>("GET", "/overview"),
  upstreams: {
    list: () => request<Upstream[]>("GET", "/upstreams"),
    get: (id: number) => request<UpstreamDetail>("GET", `/upstreams/${id}`),
    create: (input: UpstreamInput) => request<Upstream>("POST", "/upstreams", input),
    update: (id: number, input: UpstreamInput) => request<Upstream>("PATCH", `/upstreams/${id}`, input),
    remove: (id: number) => request<{ ok: true }>("DELETE", `/upstreams/${id}`),
  },
  keys: {
    add: (upstreamId: number, input: { label: string; secrets: Record<string, string>; activate: boolean }) =>
      request<ProviderKey>("POST", `/upstreams/${upstreamId}/keys`, input),
    activate: (id: number) => request<{ ok: true }>("POST", `/keys/${id}/activate`),
    update: (id: number, patch: { label?: string; secrets?: Record<string, string | null>; enabled?: boolean }) => request<ProviderKey>("PATCH", `/keys/${id}`, patch),
    revoke: (id: number) => request<{ ok: true }>("DELETE", `/keys/${id}`),
  },
  tokens: {
    list: () => request<Token[]>("GET", "/tokens"),
    create: (input: TokenWrite) => request<CreatedToken>("POST", "/tokens", input),
    update: (id: number, input: TokenWrite) => request<Token>("PATCH", `/tokens/${id}`, input),
    setEnabled: (id: number, enabled: boolean) => request<Token>("PATCH", `/tokens/${id}/enabled`, { enabled }),
    rotate: (id: number) => request<CreatedToken>("POST", `/tokens/${id}/rotate`),
    revoke: (id: number) => request<{ ok: true }>("DELETE", `/tokens/${id}`),
  },
  policies: {
    list: () => request<Policy[]>("GET", "/policies"),
    get: (id: number) => request<PolicyDetail>("GET", `/policies/${id}`),
    create: (source: string) => request<PolicyDetail>("POST", "/policies", { source }),
    update: (id: number, patch: { source?: string; enabled?: boolean }) => request<PolicyDetail>("PATCH", `/policies/${id}`, patch),
    remove: (id: number) => request<{ ok: true }>("DELETE", `/policies/${id}`),
  },
  requests: (filter: RequestFilter) => request<RequestRow[]>("GET", `/requests${query(filter)}`),
  apiKeys: {
    list: () => request<ApiKey[]>("GET", "/api-keys"),
    create: (name: string) => request<CreatedApiKey>("POST", "/api-keys", { name }),
    rotate: (id: number) => request<CreatedApiKey>("POST", `/api-keys/${id}/rotate`),
    revoke: (id: number) => request<{ ok: true }>("DELETE", `/api-keys/${id}`),
  },
  users: {
    list: () => request<User[]>("GET", "/users"),
    create: (input: { email: string; name: string; password: string }) => request<User>("POST", "/users", input),
    setPassword: (id: number, password: string) => request<{ ok: true }>("POST", `/users/${id}/password`, { password }),
    remove: (id: number) => request<{ ok: true }>("DELETE", `/users/${id}`),
  },
};
