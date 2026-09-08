import { useState } from "react";
import { useLocation } from "wouter";
import { api, type ProviderKey, type Strategy, type UpstreamDetail as Detail } from "../api.ts";
import { formatDate, formatDateTime, formatRelative } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { UrlForms } from "../placements.tsx";
import { Button, Checkbox, ConfirmDialog, Field, Input, LoadError, Mono, Notice, PageHeader, Panel, Pill, TableMessage, TextLink } from "../ui.tsx";
import UpstreamForm from "./UpstreamForm.tsx";

function ModePill({ k, strategy }: { k: ProviderKey; strategy: Strategy }) {
  const enabled = k.enabled === 1;
  if (strategy === "round_robin") return enabled ? <Pill tone="ok">In pool</Pill> : <Pill>Disabled</Pill>;
  if (k.active === 1) return enabled ? <Pill tone="ok">Active</Pill> : <Pill tone="critical">Active but disabled</Pill>;
  return enabled ? <Pill>Standby</Pill> : <Pill>Disabled</Pill>;
}

function KeyStatus({ k, now, strategy }: { k: ProviderKey; now: number; strategy: Strategy }) {
  if (k.revoked_at) return <Pill title={formatDateTime(k.revoked_at)}>Revoked {formatDate(k.revoked_at)}</Pill>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ModePill k={k} strategy={strategy} />
      {k.failing_at ? (
        <>
          <Pill tone="critical" title={formatDateTime(k.failing_at)}>
            Rejected with {k.failing_status ?? "?"}
          </Pill>
          <span className="text-xs text-content-muted">{formatRelative(k.failing_at, now)}</span>
        </>
      ) : null}
    </span>
  );
}

function AddCredentialForm({ upstream, onAdded }: { upstream: Detail; onAdded: () => void }) {
  const names = upstream.secret_names;
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [activate, setActivate] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const action = useAction(async () => {
    const secrets: Record<string, string> = {};
    for (const name of names) secrets[name] = values[name] ?? "";
    await api.keys.add(upstream.id, { label: label.trim(), secrets, activate: upstream.strategy === "round_robin" ? false : activate });
    setLabel("");
    setValues({});
    setShown({});
    setActivate(true);
    onAdded();
  });

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!label.trim()) found.label = "Give the credential a label, such as the date or who issued it.";
    for (const name of names) if (!values[name]) found[name] = `Enter the value for {{${name}}}.`;
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first !== undefined) {
      document.getElementById(first === "label" ? "credential-label" : `credential-${first}`)?.focus();
      return;
    }
    void action.run();
  };

  if (names.length === 0) {
    return (
      <Notice>
        The placements have no <Mono>{"{{placeholders}}"}</Mono>, so a credential has nothing to hold. Requests still need an active credential; add a placeholder to a
        placement in the settings below first.
      </Notice>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Label" htmlFor="credential-label" error={errors.label}>
          <Input id="credential-label" value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={errors.label ? true : undefined} placeholder="prod 2026-09" />
        </Field>
        {names.map((name) => (
          <Field key={name} label={name} htmlFor={`credential-${name}`} error={errors[name]}>
            <div className="flex gap-2">
              <Input
                id={`credential-${name}`}
                type={shown[name] ? "text" : "password"}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                value={values[name] ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  setValues((v) => ({ ...v, [name]: value }));
                  if (errors[name]) {
                    setErrors((er) => {
                      const next = { ...er };
                      delete next[name];
                      return next;
                    });
                  }
                }}
                aria-invalid={errors[name] ? true : undefined}
              />
              <Button onClick={() => setShown((s) => ({ ...s, [name]: !s[name] }))} aria-pressed={shown[name] ?? false}>
                {shown[name] ? "Hide" : "Show"}
              </Button>
            </div>
          </Field>
        ))}
      </div>
      <p className="-mt-2 text-sm text-content-muted">Values are stored server-side; only their first and last characters show afterwards.</p>
      <div className="flex flex-wrap items-center gap-4">
        {upstream.strategy === "round_robin" ? null : <Checkbox label="Make it the active credential" checked={activate} onChange={(e) => setActivate(e.target.checked)} />}
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Adding..." : "Add credential"}
        </Button>
      </div>
      {action.error ? <Notice kind="error">{action.error}</Notice> : null}
    </form>
  );
}

function KeysPanel({ upstream, now, onChange }: { upstream: Detail; now: number; onChange: () => void }) {
  const [revoking, setRevoking] = useState<ProviderKey | null>(null);
  const activate = useAction(async (id: number) => {
    await api.keys.activate(id);
    onChange();
  });
  const revoke = useAction(async (id: number) => {
    await api.keys.revoke(id);
    setRevoking(null);
    onChange();
  });
  const toggle = useAction(async (k: ProviderKey) => {
    await api.keys.setEnabled(k.id, k.enabled !== 1);
    onChange();
  });
  const pool = upstream.strategy === "round_robin";

  return (
    <Panel
      title="Credentials"
      description={
        pool
          ? "Round robin: every enabled credential takes turns. Disable one to pull it from the pool; revoking is permanent."
          : "One credential is active at a time. To rotate, add the new one with the active box checked, then revoke the old one."
      }
      bleed
    >
      <div className="px-4 pb-4">
        <AddCredentialForm key={upstream.updated_at} upstream={upstream} onAdded={onChange} />
      </div>
      {activate.error || toggle.error ? (
        <div className="px-4 pb-3">
          <Notice kind="error">{activate.error ?? toggle.error}</Notice>
        </div>
      ) : null}
      <table className="tbl">
        <thead>
          <tr>
            <th>Label</th>
            <th>Values</th>
            <th>Status</th>
            <th>Last used</th>
            <th>Added</th>
            <th className="actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {upstream.keys.length === 0 ? (
            <TableMessage colSpan={6}>No credentials yet. Requests to this upstream return 503 until one is {pool ? "enabled" : "active"}.</TableMessage>
          ) : (
            upstream.keys.map((k) => (
              <tr key={k.id} className={k.revoked_at ? "text-content-muted" : ""}>
                <td>
                  <span className="block max-w-[24ch] truncate" title={k.label}>
                    {k.label}
                  </span>
                </td>
                <td>
                  {Object.entries(k.hints).map(([name, hint]) => (
                    <Mono key={name} className="block whitespace-nowrap">
                      <span className={upstream.secret_names.includes(name) ? "" : "line-through"} title={upstream.secret_names.includes(name) ? undefined : "No placement uses this value"}>
                        {name}
                      </span>{" "}
                      <span className="text-content-muted">{hint}</span>
                    </Mono>
                  ))}
                </td>
                <td>
                  <KeyStatus k={k} now={now} strategy={upstream.strategy} />
                </td>
                <td title={k.last_used_at ? formatDateTime(k.last_used_at) : undefined}>{formatRelative(k.last_used_at, now)}</td>
                <td title={formatDateTime(k.created_at)}>{formatDate(k.created_at)}</td>
                <td className="actions">
                  {k.revoked_at ? null : (
                    <span className="inline-flex gap-1">
                      {pool || k.active === 1 ? null : (
                        <Button size="sm" variant="quiet" onClick={() => void activate.run(k.id)} disabled={activate.busy}>
                          Activate
                        </Button>
                      )}
                      <Button size="sm" variant="quiet" onClick={() => void toggle.run(k)} disabled={toggle.busy}>
                        {k.enabled === 1 ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="quiet" className="text-status-critical hover:text-status-critical" onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke "${revoking.label}"?` : ""}
        confirmLabel="Revoke credential"
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
        {!pool && revoking?.active === 1
          ? `This is the active credential. Until another one is activated, requests to ${upstream.slug} return 503. A revoked credential cannot be used again.`
          : "A revoked credential cannot be used again; disable it instead to keep it around."}
      </ConfirmDialog>
    </Panel>
  );
}

export default function UpstreamDetail({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const load = useLoad(`upstream:${id}`, () => api.upstreams.get(id));
  const [deleting, setDeleting] = useState(false);
  const remove = useAction(async () => {
    await api.upstreams.remove(id);
    navigate("/upstreams");
  });
  const u = load.data;

  if (!u) {
    return (
      <>
        <PageHeader title="Upstream" />
        {load.error ? (
          <div className="flex flex-col gap-3">
            <LoadError message={load.error} onRetry={load.reload} />
            <p className="text-sm">
              <TextLink href="/upstreams">Back to upstreams</TextLink>
            </p>
          </div>
        ) : (
          <p className="text-sm text-content-muted">Loading upstream...</p>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={u.name}
        description={
          <span className="flex flex-wrap gap-x-3">
            <Mono>{u.slug}</Mono>
            <Mono className="break-all">{u.base_url}</Mono>
          </span>
        }
        actions={
          <Button variant="quiet" className="text-status-critical hover:text-status-critical" onClick={() => setDeleting(true)}>
            Delete upstream
          </Button>
        }
      />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      <div className="flex flex-col gap-6">
        <Panel title="Consumer addresses" description="Send requests here with a keygate token; the path after the slug is forwarded to the base URL.">
          <UrlForms slug={u.slug} />
        </Panel>
        <KeysPanel upstream={u} now={load.at} onChange={load.reload} />
        <Panel title="Settings">
          <UpstreamForm
            key={u.updated_at}
            initial={u}
            submitLabel="Save changes"
            onSubmit={async (input) => {
              await api.upstreams.update(id, input);
              load.reload();
            }}
          />
        </Panel>
      </div>
      <ConfirmDialog
        open={deleting}
        title={`Delete "${u.name}"?`}
        confirmLabel="Delete upstream"
        busy={remove.busy}
        error={remove.error}
        onClose={() => {
          setDeleting(false);
          remove.reset();
        }}
        onConfirm={() => void remove.run()}
      >
        Its credentials are deleted with it and requests to {u.slug} return 404. Tokens scoped to it keep the slug in their scope but stop working for it. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
