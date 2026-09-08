import { api, type OverviewUpstream } from "../api.ts";
import { formatCount, formatDateTime, formatMs, formatRelative } from "../format.ts";
import { useLoad } from "../hooks.ts";
import { Button, LinkButton, LoadError, Mono, PageHeader, Panel, Pill, TableMessage, TextLink } from "../ui.tsx";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-ctl bg-surface-raised px-4 py-3">
      <p className="text-xs font-medium tracking-wide text-content-muted uppercase">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-content-muted">{hint}</p> : null}
    </div>
  );
}

function ActiveKeyCell({ upstream, now }: { upstream: OverviewUpstream; now: number }) {
  const key = upstream.active_key;
  if (!key) {
    return (
      <div>
        <Pill tone="critical">No active key</Pill>
        <p className="mt-1 text-xs text-content-muted">Requests get 503 until a key is active.</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="truncate" title={key.label}>
        {key.label} <Mono className="text-content-muted">{key.hint}</Mono>
      </p>
      {key.failing_at ? (
        <p className="mt-1">
          <Pill tone="critical" title={formatDateTime(key.failing_at)}>
            Rejected with {key.failing_status ?? "?"}, {formatRelative(key.failing_at, now)}
          </Pill>
        </p>
      ) : null}
    </div>
  );
}

export default function Overview() {
  const load = useLoad("overview", api.overview);
  const data = load.data;
  const failing = data?.upstreams.filter((u) => u.active_key?.failing_at).length ?? 0;
  const keyless = data?.upstreams.filter((u) => !u.active_key).length ?? 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={data ? `Traffic since ${formatDateTime(data.since)}.` : "Traffic for the last 24 hours."}
        actions={
          <Button onClick={load.reload} busy={load.loading && data !== null}>
            Refresh
          </Button>
        }
      />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Upstreams" value={formatCount(data?.upstreams.length)} hint={failing || keyless ? `${failing} rejected key, ${keyless} without a key` : undefined} />
        <Stat label="Live tokens" value={formatCount(data?.tokens)} />
        <Stat label="Unmatched requests" value={formatCount(data?.unmatched_requests)} hint="Sent to a host or path with no upstream." />
      </div>
      <Panel title="Upstreams" description="Last 24 hours. Errors are upstream 4xx and 5xx answers; rejected requests never reached the upstream." bleed className="mt-6">
        <table className="tbl">
          <thead>
            <tr>
              <th>Upstream</th>
              <th className="num">Requests</th>
              <th className="num">Errors</th>
              <th className="num">Rejected</th>
              <th className="num">Avg latency</th>
              <th>Active key</th>
              <th className="num">Keys</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <TableMessage colSpan={7}>{load.error ? "Nothing to show." : "Loading upstreams..."}</TableMessage>
            ) : data.upstreams.length === 0 ? (
              <TableMessage colSpan={7}>
                <p>No upstreams yet. Add one to start proxying.</p>
                <div className="mt-3">
                  <LinkButton href="/upstreams/new" variant="primary">
                    Add upstream
                  </LinkButton>
                </div>
              </TableMessage>
            ) : (
              data.upstreams.map((u) => (
                <tr key={u.id}>
                  <td>
                    <TextLink href={`/upstreams/${u.id}`}>{u.name}</TextLink>
                    <p>
                      <Mono className="text-content-muted">{u.slug}</Mono>
                    </p>
                  </td>
                  <td className="num">{formatCount(u.requests)}</td>
                  <td className={u.errors > 0 ? "num text-status-critical" : "num"}>{formatCount(u.errors)}</td>
                  <td className="num">{formatCount(u.rejected)}</td>
                  <td className="num">{formatMs(u.avg_latency_ms)}</td>
                  <td>
                    <ActiveKeyCell upstream={u} now={load.at} />
                  </td>
                  <td className="num">{formatCount(u.key_count)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
