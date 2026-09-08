import { api } from "../api.ts";
import { CredentialCell } from "../credential.tsx";
import { formatCount, formatDateTime, formatMs } from "../format.ts";
import { useLoad } from "../hooks.ts";
import { Button, LinkButton, LoadError, Mono, PageHeader, Panel, TableMessage, TextLink } from "../ui.tsx";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-ctl bg-surface-raised px-4 py-3">
      <p className="text-xs font-medium tracking-wide text-content-muted uppercase">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-content-muted">{hint}</p> : null}
    </div>
  );
}

export default function Overview() {
  const load = useLoad("overview", api.overview);
  const data = load.data;
  const failing = data?.upstreams.filter((u) => u.active_key?.failing_at).length ?? 0;
  const keyless = data?.upstreams.filter((u) => u.usable_key_count === 0).length ?? 0;

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
        <Stat label="Upstreams" value={formatCount(data?.upstreams.length)} hint={failing || keyless ? `${failing} with a rejected credential, ${keyless} without one` : undefined} />
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
              <th>In use</th>
              <th className="num">Credentials</th>
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
                    <CredentialCell upstream={u} now={load.at} />
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
