export const SLOT_TYPES = ["header", "query", "cookie", "json", "form"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

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
  hint: string;
  active: number;
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
  slot_type: SlotType;
  slot_name: string;
  slot_prefix: string;
  notes: string;
}

export interface Upstream extends UpstreamInput {
  id: number;
  created_at: string;
  updated_at: string;
  active_key: ProviderKey | null;
  key_count: number;
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

export interface Token extends TokenInput {
  id: number;
  hint: string;
  revoked_at: string | null;
  created_by: number | null;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedToken extends Token {
  token: string;
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
}

export const REQUEST_STATUSES = ["ok", "client_error", "upstream_error", "proxy_error"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface RequestFilter {
  token_id?: number;
  upstream_id?: number;
  status?: RequestStatus;
  before?: number;
  limit?: number;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof data.error === "string") code = data.error;
    if (typeof data.message === "string") message = data.message;
  } catch {
    // Non-JSON error body; keep the status message.
  }
  if (res.status === 401 && code === "unauthenticated") for (const fn of sessionListeners) fn();
  throw new ApiError(res.status, code, message);
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
    add: (upstreamId: number, input: { label: string; secret: string; activate: boolean }) =>
      request<ProviderKey>("POST", `/upstreams/${upstreamId}/keys`, input),
    activate: (id: number) => request<{ ok: true }>("POST", `/keys/${id}/activate`),
    revoke: (id: number) => request<{ ok: true }>("DELETE", `/keys/${id}`),
  },
  tokens: {
    list: () => request<Token[]>("GET", "/tokens"),
    create: (input: TokenInput) => request<CreatedToken>("POST", "/tokens", input),
    update: (id: number, input: TokenInput) => request<Token>("PATCH", `/tokens/${id}`, input),
    revoke: (id: number) => request<{ ok: true }>("DELETE", `/tokens/${id}`),
  },
  requests: (filter: RequestFilter) => request<RequestRow[]>("GET", `/requests${query(filter)}`),
  users: {
    list: () => request<User[]>("GET", "/users"),
    create: (input: { email: string; name: string; password: string }) => request<User>("POST", "/users", input),
    setPassword: (id: number, password: string) => request<{ ok: true }>("POST", `/users/${id}/password`, { password }),
    remove: (id: number) => request<{ ok: true }>("DELETE", `/users/${id}`),
  },
};
