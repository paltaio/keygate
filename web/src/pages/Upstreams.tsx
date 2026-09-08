import { useLocation } from "wouter";
import { api } from "../api.ts";
import { CredentialCell } from "../credential.tsx";
import { formatCount, placementSummary } from "../format.ts";
import { useLoad } from "../hooks.ts";
import { LinkButton, LoadError, Mono, PageHeader, Panel, TableMessage, TextLink } from "../ui.tsx";
import UpstreamForm from "./UpstreamForm.tsx";

export function UpstreamsPage() {
  const load = useLoad("upstreams", api.upstreams.list);
  const data = load.data;
  return (
    <>
      <PageHeader
        title="Upstreams"
        description="Third-party APIs keygate fronts, each with the credential it injects."
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
              <th>Placements</th>
              <th>In use</th>
              <th className="num">Credentials</th>
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
                    {u.placements.slice(0, 2).map((p, i) => (
                      <Mono key={i} className="block max-w-[32ch] truncate" title={placementSummary(p)}>
                        {placementSummary(p)}
                      </Mono>
                    ))}
                    {u.placements.length > 2 ? <span className="text-xs text-content-muted">+{u.placements.length - 2} more</span> : null}
                  </td>
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

export function NewUpstreamPage() {
  const [, navigate] = useLocation();
  return (
    <>
      <PageHeader title="New upstream" description="Credentials are added on the upstream page after it is created." />
      <Panel>
        <UpstreamForm
          mode="create"
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
