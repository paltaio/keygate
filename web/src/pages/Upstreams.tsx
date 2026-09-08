import { useLocation } from "wouter";
import { api } from "../api.ts";
import { formatCount, slotSummary } from "../format.ts";
import { useLoad } from "../hooks.ts";
import { LinkButton, LoadError, Mono, PageHeader, Panel, Pill, TableMessage, TextLink } from "../ui.tsx";
import UpstreamForm from "./UpstreamForm.tsx";

export function UpstreamsPage() {
  const load = useLoad("upstreams", api.upstreams.list);
  const data = load.data;
  return (
    <>
      <PageHeader
        title="Upstreams"
        description="Third-party APIs keygate fronts, each with the provider key it injects."
        actions={
          <LinkButton href="/upstreams/new" variant="primary">
            Add upstream
          </LinkButton>
        }
      />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      <Panel bleed>
        <table className="tbl">
          <thead>
            <tr>
              <th>Upstream</th>
              <th>Base URL</th>
              <th>Key slot</th>
              <th>Active key</th>
              <th className="num">Keys</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <TableMessage colSpan={5}>{load.error ? "Nothing to show." : "Loading upstreams..."}</TableMessage>
            ) : data.length === 0 ? (
              <TableMessage colSpan={5}>
                <p>No upstreams yet. Add the first API you want to front.</p>
                <div className="mt-3">
                  <LinkButton href="/upstreams/new" variant="primary">
                    Add upstream
                  </LinkButton>
                </div>
              </TableMessage>
            ) : (
              data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <TextLink href={`/upstreams/${u.id}`}>{u.name}</TextLink>
                    <p>
                      <Mono className="text-content-muted">{u.slug}</Mono>
                    </p>
                  </td>
                  <td>
                    <Mono className="block max-w-[32ch] truncate" title={u.base_url}>
                      {u.base_url}
                    </Mono>
                  </td>
                  <td>
                    <Mono className="block max-w-[32ch] truncate" title={slotSummary(u)}>
                      {slotSummary(u)}
                    </Mono>
                  </td>
                  <td>
                    {u.active_key ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate" title={u.active_key.label}>
                          {u.active_key.label}
                        </span>
                        <Mono className="text-content-muted">{u.active_key.hint}</Mono>
                        {u.active_key.failing_at ? <Pill tone="critical">Rejected with {u.active_key.failing_status ?? "?"}</Pill> : null}
                      </span>
                    ) : (
                      <Pill tone="critical">None</Pill>
                    )}
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

export function NewUpstreamPage() {
  const [, navigate] = useLocation();
  return (
    <>
      <PageHeader title="New upstream" description="Provider keys are added on the upstream page after it is created." />
      <Panel>
        <UpstreamForm
          submitLabel="Create upstream"
          onSubmit={async (input) => {
            const created = await api.upstreams.create(input);
            navigate(`/upstreams/${created.id}`);
          }}
        />
      </Panel>
    </>
  );
}
