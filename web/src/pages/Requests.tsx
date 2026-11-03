import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { api, REQUEST_STATUSES, type RequestFilter, type RequestRow, type RequestStatus } from "../api.ts";
import { REQUEST_STATUS_LABEL, formatBytes, formatDateTime, formatMs, requestKind } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { Button, LoadError, Mono, Notice, PageHeader, Panel, Select, TableMessage, TextLink } from "../ui.tsx";

const PAGE = 100;
const COLUMNS = 12;

function parseFilter(search: string): RequestFilter {
  const params = new URLSearchParams(search);
  const filter: RequestFilter = {};
  const upstream = Number(params.get("upstream_id"));
  if (Number.isInteger(upstream) && upstream > 0) filter.upstream_id = upstream;
  const token = Number(params.get("token_id"));
  if (Number.isInteger(token) && token > 0) filter.token_id = token;
  const status = params.get("status");
  if (status && (REQUEST_STATUSES as readonly string[]).includes(status)) filter.status = status as RequestStatus;
  const policy = params.get("policy");
  if (policy) filter.policy = policy;
  return filter;
}

function toSearch(filter: RequestFilter): string {
  const params = new URLSearchParams();
  if (filter.upstream_id) params.set("upstream_id", String(filter.upstream_id));
  if (filter.token_id) params.set("token_id", String(filter.token_id));
  if (filter.status) params.set("status", filter.status);
  if (filter.policy) params.set("policy", filter.policy);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Status color; a response a policy built is colored by its own status code. */
function statusTone(row: RequestRow): string {
  const kind = requestKind(row.error === "policy_response" ? { ...row, error: null } : row);
  return kind === "ok" ? "text-status-ok" : kind === "client_error" ? "text-content-default" : "text-status-critical";
}

function StatusCell({ row }: { row: RequestRow }) {
  const tone = statusTone(row);
  return <span className={`num font-medium ${tone}`}>{row.status ?? "-"}</span>;
}

function PolicyCell({ name, id }: { name: string | null; id: number | undefined }) {
  if (name === null) return <span className="text-content-muted">-</span>;
  if (id === undefined) return <Mono className="whitespace-nowrap">{name}</Mono>;
  return (
    <TextLink href={`/policies/${id}`} className="font-mono text-[13px] whitespace-nowrap">
      {name}
    </TextLink>
  );
}

export default function Requests() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const filter = parseFilter(search);
  const filterKey = toSearch(filter);
  const active = filterKey !== "";

  const upstreams = useLoad("upstreams", api.upstreams.list);
  const tokens = useLoad("tokens", api.tokens.list);
  const policies = useLoad("policies", api.policies.list);
  const first = useLoad(`requests${filterKey}`, () => api.requests({ ...filter, limit: PAGE }));
  const [extra, setExtra] = useState<{ key: string; rows: RequestRow[]; exhausted: boolean }>({ key: filterKey, rows: [], exhausted: false });
  const more = extra.key === filterKey ? extra : { key: filterKey, rows: [], exhausted: false };
  const rows = first.data ? [...first.data, ...more.rows] : [];
  const last = rows[rows.length - 1];
  const hasMore = first.data !== null && first.data.length === PAGE && !more.exhausted && last !== undefined;

  const loadMore = useAction(async () => {
    if (!last) return;
    const page = await api.requests({ ...filter, before: last.id, limit: PAGE });
    setExtra({ key: filterKey, rows: [...more.rows, ...page], exhausted: page.length < PAGE });
  });

  const setFilter = (key: "upstream_id" | "token_id" | "status" | "policy", raw: string): void => {
    const next: RequestFilter = { ...filter };
    delete next[key];
    if (raw) {
      if (key === "status") next.status = raw as RequestStatus;
      else if (key === "policy") next.policy = raw;
      else next[key] = Number(raw);
    }
    navigate(`/requests${toSearch(next)}`, { replace: true });
  };

  const upstreamName = new Map(upstreams.data?.map((u) => [u.id, u.slug]) ?? []);
  const tokenName = new Map(tokens.data?.map((t) => [t.id, t.name]) ?? []);
  const policyId = new Map(policies.data?.map((p) => [p.name, p.id]) ?? []);
  // A filtered name that no longer exists stays selectable.
  const policyNames = [...new Set([...policyId.keys(), ...(filter.policy ? [filter.policy] : [])])];
  const refresh = (): void => {
    setExtra({ key: filterKey, rows: [], exhausted: false });
    first.reload();
  };

  return (
    <>
      <PageHeader
        title="Requests"
        description="Every request that reached an upstream, newest first."
        actions={
          <Button onClick={refresh} busy={first.loading && first.data !== null}>
            Refresh
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Upstream</span>
          <Select className="w-auto min-w-40" value={filter.upstream_id ?? ""} onChange={(e) => setFilter("upstream_id", e.target.value)}>
            <option value="">All</option>
            {upstreams.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.slug}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Token</span>
          <Select className="w-auto min-w-40" value={filter.token_id ?? ""} onChange={(e) => setFilter("token_id", e.target.value)}>
            <option value="">All</option>
            {tokens.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.revoked_at ? " (revoked)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Status</span>
          <Select className="w-auto min-w-40" value={filter.status ?? ""} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">All</option>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REQUEST_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Policy</span>
          <Select className="w-auto min-w-40" value={filter.policy ?? ""} onChange={(e) => setFilter("policy", e.target.value)}>
            <option value="">All</option>
            {policyNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        {active ? (
          <Button variant="quiet" onClick={() => navigate("/requests", { replace: true })}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {first.error ? <LoadError message={first.error} onRetry={first.reload} /> : null}
      <Panel bleed>
        <table className="tbl min-w-[70rem]">
          <thead>
            <tr>
              <th>Time</th>
              <th>Upstream</th>
              <th>Token</th>
              <th>Method</th>
              <th>Path</th>
              <th className="num">Status</th>
              <th className="num">Latency</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th>Error</th>
              <th>Policy</th>
              <th>Origin</th>
            </tr>
          </thead>
          <tbody className={first.loading && first.data !== null ? "opacity-60" : ""}>
            {first.data === null ? (
              <TableMessage colSpan={COLUMNS}>{first.error ? "Nothing to show." : "Loading requests..."}</TableMessage>
            ) : rows.length === 0 ? (
              <TableMessage colSpan={COLUMNS}>{active ? "No requests match these filters." : "No requests logged yet. Traffic through any upstream shows up here."}</TableMessage>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap tabular-nums" title={r.ts}>
                    {formatDateTime(r.ts)}
                  </td>
                  <td>
                    <Mono>{r.upstream_id === null ? "-" : (upstreamName.get(r.upstream_id) ?? `#${r.upstream_id}`)}</Mono>
                  </td>
                  <td>
                    <span className="block max-w-[18ch] truncate" title={r.token_id === null ? "No valid token" : (tokenName.get(r.token_id) ?? `#${r.token_id}`)}>
                      {r.token_id === null ? <span className="text-content-muted">-</span> : (tokenName.get(r.token_id) ?? `#${r.token_id}`)}
                    </span>
                  </td>
                  <td>
                    <Mono>{r.method}</Mono>
                  </td>
                  <td>
                    <Mono className="block max-w-[32ch] truncate" title={r.path}>
                      {r.path}
                    </Mono>
                  </td>
                  <td className="num">
                    <StatusCell row={r} />
                  </td>
                  <td className="num">{formatMs(r.latency_ms)}</td>
                  <td className="num">{formatBytes(r.bytes_in)}</td>
                  <td className="num">{formatBytes(r.bytes_out)}</td>
                  <td>{r.error ? <Mono className={r.error === "policy_response" ? "text-content-muted" : "text-status-critical"}>{r.error}</Mono> : <span className="text-content-muted">-</span>}</td>
                  <td>
                    <PolicyCell name={r.policy} id={r.policy === null ? undefined : policyId.get(r.policy)} />
                  </td>
                  <td>
                    {r.origin ? (
                      <Mono className="block max-w-[24ch] truncate" title={r.origin}>
                        {r.origin}
                      </Mono>
                    ) : (
                      <span className="text-content-muted">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {hasMore || loadMore.error ? (
          <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-3">
            {hasMore ? (
              <Button onClick={() => void loadMore.run()} busy={loadMore.busy}>
                {loadMore.busy ? "Loading..." : "Load older requests"}
              </Button>
            ) : null}
            {loadMore.error ? <Notice kind="error">{loadMore.error}</Notice> : null}
          </div>
        ) : null}
      </Panel>
    </>
  );
}
