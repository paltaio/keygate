import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { api, type CreatedToken, type Token, type TokenPolicy } from "../api.ts";
import { errorMessage, formatDate, formatDateTime, formatRelative, isPast } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { Button, ConfirmDialog, CopyButton, InkBlock, LinkButton, LoadError, Mono, Notice, PageHeader, Panel, Pill, TableMessage, TextLink } from "../ui.tsx";
import TokenForm from "./TokenForm.tsx";

function Scopes({ scopes }: { scopes: string[] }) {
  if (scopes.includes("*")) return <span>All upstreams</span>;
  return <Mono className="break-words">{scopes.join(", ")}</Mono>;
}

function Origins({ origins }: { origins: string[] }) {
  if (origins.includes("*")) return <span>Any origin</span>;
  if (origins.length === 0) return <span className="text-content-muted">No browser use</span>;
  const shown = origins.slice(0, 2);
  const rest = origins.length - shown.length;
  return (
    <Mono className="break-all" title={origins.join("\n")}>
      {shown.join(", ")}
      {rest > 0 ? ` +${rest}` : ""}
    </Mono>
  );
}

function Policies({ policies }: { policies: TokenPolicy[] }) {
  const label = (p: TokenPolicy): string => (p.enabled ? p.name : `${p.name} (off)`);
  return (
    <span className="block text-content-muted" title={policies.length ? `Policies, in order: ${policies.map(label).join(", ")}` : undefined}>
      {policies.slice(0, 3).map((p) => (
        <Mono key={p.policy_id} className="block max-w-[24ch] truncate">
          {label(p)}
        </Mono>
      ))}
      {policies.length > 3 ? <span className="text-xs">+{policies.length - 3} more</span> : null}
    </span>
  );
}

function TokenStatus({ t, now }: { t: Token; now: number }) {
  if (t.revoked_at) return <Pill title={formatDateTime(t.revoked_at)}>Revoked {formatDate(t.revoked_at)}</Pill>;
  if (t.enabled !== 1) return <Pill tone="critical">Disabled</Pill>;
  if (isPast(t.expires_at, now)) return <Pill tone="critical">Expired</Pill>;
  return <Pill tone="ok">Live</Pill>;
}

export function TokensPage() {
  const load = useLoad("tokens", api.tokens.list);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [rotating, setRotating] = useState<Token | null>(null);
  const [rotated, setRotated] = useState<CreatedToken | null>(null);
  const revoke = useAction(async (id: number) => {
    await api.tokens.revoke(id);
    setRevoking(null);
    load.reload();
  });
  const rotate = useAction(async (id: number) => {
    setRotated(await api.tokens.rotate(id));
    setRotating(null);
    load.reload();
  });
  const toggle = useAction(async (t: Token) => {
    await api.tokens.setEnabled(t.id, t.enabled !== 1);
    load.reload();
  });
  const data = load.data;

  return (
    <>
      <PageHeader
        title="Tokens"
        description="What consumers send instead of the provider credential. Each token names the upstreams and browser origins it may use."
        actions={
          <LinkButton href="/tokens/new" variant="primary">
            Create token
          </LinkButton>
        }
      />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      {toggle.error ? (
        <Notice kind="error" className="mb-4">
          {toggle.error}
        </Notice>
      ) : null}
      {rotated ? (
        <div className="mb-6">
          <CreatedTokenPanel
            created={rotated}
            title={`Token "${rotated.name}" rotated`}
            actions={
              <Button variant="primary" onClick={() => setRotated(null)}>
                Done
              </Button>
            }
          />
        </div>
      ) : null}
      <Panel bleed>
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Upstreams</th>
              <th>Origins</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Status</th>
              <th className="actions">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <TableMessage colSpan={8}>{load.error ? "Nothing to show." : "Loading tokens..."}</TableMessage>
            ) : data.length === 0 ? (
              <TableMessage colSpan={8}>
                <p>No tokens yet. Create one and hand it to a consumer instead of the provider credential.</p>
                <div className="mt-3">
                  <LinkButton href="/tokens/new" variant="primary">
                    Create token
                  </LinkButton>
                </div>
              </TableMessage>
            ) : (
              data.map((t) => (
                <tr key={t.id} className={t.revoked_at ? "text-content-muted" : ""}>
                  <td>
                    <span className="block max-w-[24ch] truncate" title={t.name}>
                      {t.name}
                    </span>
                    <Policies policies={t.policies} />
                  </td>
                  <td>
                    <Mono title={t.rotated_at ? `Rotated ${formatDateTime(t.rotated_at)}` : undefined}>{t.hint}</Mono>
                  </td>
                  <td>
                    <Scopes scopes={t.scopes} />
                  </td>
                  <td>
                    <Origins origins={t.origins} />
                  </td>
                  <td title={t.expires_at ? formatDateTime(t.expires_at) : undefined}>{t.expires_at ? formatDate(t.expires_at) : "Never"}</td>
                  <td title={t.last_used_at ? formatDateTime(t.last_used_at) : undefined}>{formatRelative(t.last_used_at, load.at)}</td>
                  <td>
                    <TokenStatus t={t} now={load.at} />
                  </td>
                  <td className="actions">
                    <span className="inline-flex gap-1">
                      <LinkButton size="sm" variant="quiet" href={`/requests?token_id=${t.id}`}>
                        Log
                      </LinkButton>
                      {t.revoked_at ? null : (
                        <>
                          <LinkButton size="sm" variant="quiet" href={`/tokens/${t.id}`}>
                            Edit
                          </LinkButton>
                          <Button size="sm" variant="quiet" onClick={() => void toggle.run(t)} disabled={toggle.busy}>
                            {t.enabled === 1 ? "Disable" : "Enable"}
                          </Button>
                          <Button size="sm" variant="quiet" onClick={() => setRotating(t)}>
                            Rotate
                          </Button>
                          <Button size="sm" variant="quiet" className="text-status-critical hover:text-status-critical" onClick={() => setRevoking(t)}>
                            Revoke
                          </Button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke "${revoking.name}"?` : ""}
        confirmLabel="Revoke token"
        busy={revoke.busy}
        error={revoke.error}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        onConfirm={() => {
          if (revoking) void revoke.run(revoking.id);
        }}
      >
        Requests carrying this token are refused from now on. This cannot be undone; create a new token to restore access.
      </ConfirmDialog>
      <ConfirmDialog
        open={rotating !== null}
        title={rotating ? `Rotate "${rotating.name}"?` : ""}
        confirmLabel="Rotate token"
        busy={rotate.busy}
        error={rotate.error}
        onClose={() => {
          setRotating(null);
          rotate.reset();
        }}
        onConfirm={() => {
          if (rotating) void rotate.run(rotating.id);
        }}
      >
        A new value is generated and shown once. The current value is refused from now on; upstreams, origins and expiry stay as they are.
      </ConfirmDialog>
    </>
  );
}

function CreatedTokenPanel({ created, title, actions, warning }: { created: CreatedToken; title: string; actions: ReactNode; warning?: string | null | undefined }) {
  return (
    <Panel title={title}>
      {warning ? (
        <Notice kind="error" className="mb-4">
          {warning}
        </Notice>
      ) : null}
      <Notice kind="info" className="mb-4">
        Copy the token now. It is shown this once and cannot be retrieved later; rotate the token if it is lost.
      </Notice>
      <div className="flex items-center gap-2">
        <InkBlock className="min-w-0 flex-1 select-all">{created.token}</InkBlock>
        <CopyButton value={created.token} label="Copy token" size="md" />
      </div>
      <p className="mt-4 text-sm text-content-muted">
        Consumers send it as <Mono>Authorization: Bearer {"<token>"}</Mono>, in the <Mono>X-Keygate-Token</Mono> header, as <Mono>?keygate_token=</Mono>, or in place
        of any placement value.
      </p>
      <div className="mt-5 flex gap-2">{actions}</div>
    </Panel>
  );
}

export function NewTokenPage() {
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  if (created) {
    return (
      <>
        <PageHeader title="New token" />
        <CreatedTokenPanel
          created={created}
          title={`Token "${created.name}" created`}
          warning={policyError ? `The token was created without its policies: ${policyError}. Attach them with Edit on the tokens page.` : null}
          actions={
            <>
              <LinkButton href="/tokens" variant="primary">
                Done
              </LinkButton>
              <Button onClick={() => setCreated(null)}>Create another</Button>
            </>
          }
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title="New token" description="The token value is generated on save and shown once." />
      <Panel>
        <TokenForm
          submitLabel="Create token"
          onSubmit={async (input, policies) => {
            const token = await api.tokens.create(input);
            let failed: string | null = null;
            if (policies?.length) {
              try {
                await api.tokens.setPolicies(token.id, policies);
              } catch (e) {
                failed = errorMessage(e);
              }
            }
            setPolicyError(failed);
            setCreated(token);
          }}
        />
      </Panel>
    </>
  );
}

export function EditTokenPage({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const load = useLoad("tokens", api.tokens.list);
  const token = load.data?.find((t) => t.id === id);

  if (!token) {
    return (
      <>
        <PageHeader title="Edit token" />
        {load.error ? (
          <LoadError message={load.error} onRetry={load.reload} />
        ) : load.data ? (
          <p className="text-sm text-content-muted">
            No token with id {id}. <TextLink href="/tokens">Back to tokens</TextLink>
          </p>
        ) : (
          <p className="text-sm text-content-muted">Loading token...</p>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={token.name}
        description={
          <span>
            <Mono>{token.hint}</Mono>, created {formatDate(token.created_at)}
          </span>
        }
      />
      {token.revoked_at ? <Notice className="mb-4">This token was revoked on {formatDateTime(token.revoked_at)}. Changes save but it stays unusable.</Notice> : null}
      <Panel>
        <TokenForm
          initial={token}
          submitLabel="Save changes"
          onSubmit={async (input, policies) => {
            await api.tokens.update(id, input);
            if (policies) await api.tokens.setPolicies(id, policies);
            navigate("/tokens");
          }}
        />
      </Panel>
    </>
  );
}
