import { useState } from "react";
import { useLocation } from "wouter";
import { api, type ProviderKey, type UpstreamDetail as Detail } from "../api.ts";
import { formatDate, formatDateTime, formatRelative } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { UrlForms } from "../slot.tsx";
import { Button, Checkbox, ConfirmDialog, Field, Input, LoadError, Mono, Notice, PageHeader, Panel, Pill, TableMessage, TextLink } from "../ui.tsx";
import UpstreamForm from "./UpstreamForm.tsx";

function KeyStatus({ k, now }: { k: ProviderKey; now: number }) {
  if (k.revoked_at) return <Pill title={formatDateTime(k.revoked_at)}>Revoked {formatDate(k.revoked_at)}</Pill>;
  if (k.failing_at) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Pill tone="critical" title={formatDateTime(k.failing_at)}>
          Rejected with {k.failing_status ?? "?"}
        </Pill>
        <span className="text-xs text-content-muted">{formatRelative(k.failing_at, now)}</span>
      </span>
    );
  }
  if (k.active === 1) return <Pill tone="ok">Active</Pill>;
  return <Pill>Standby</Pill>;
}

function AddKeyForm({ upstreamId, onAdded }: { upstreamId: number; onAdded: () => void }) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [activate, setActivate] = useState(true);
  const [errors, setErrors] = useState<{ label?: string; secret?: string }>({});
  const action = useAction(async () => {
    await api.keys.add(upstreamId, { label: label.trim(), secret, activate });
    setLabel("");
    setSecret("");
    setShow(false);
    setActivate(true);
    onAdded();
  });

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const found: { label?: string; secret?: string } = {};
    if (!label.trim()) found.label = "Give the key a label, such as the date or who issued it.";
    if (!secret) found.secret = "Paste the provider key.";
    setErrors(found);
    if (found.label) {
      document.getElementById("key-label")?.focus();
      return;
    }
    if (found.secret) {
      document.getElementById("key-secret")?.focus();
      return;
    }
    void action.run();
  };

  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-start">
      <Field label="Label" htmlFor="key-label" error={errors.label}>
        <Input id="key-label" value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={errors.label ? true : undefined} placeholder="prod 2026-09" />
      </Field>
      <Field label="Provider key" htmlFor="key-secret" error={errors.secret} hint="Stored server-side; only the first and last characters show afterwards.">
        <div className="flex gap-2">
          <Input
            id="key-secret"
            type={show ? "text" : "password"}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            aria-invalid={errors.secret ? true : undefined}
          />
          <Button onClick={() => setShow((s) => !s)} aria-pressed={show}>
            {show ? "Hide" : "Show"}
          </Button>
        </div>
      </Field>
      <div className="flex flex-col gap-3 md:pt-7">
        <Checkbox label="Make it the active key" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Adding..." : "Add key"}
        </Button>
      </div>
      {action.error ? (
        <div className="md:col-span-3">
          <Notice kind="error">{action.error}</Notice>
        </div>
      ) : null}
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

  return (
    <Panel
      title="Provider keys"
      description="One key is active at a time. To rotate, add the new key with the active box checked, then revoke the old one."
      bleed
    >
      <div className="px-4 pb-4">
        <AddKeyForm upstreamId={upstream.id} onAdded={onChange} />
      </div>
      {activate.error ? (
        <div className="px-4 pb-3">
          <Notice kind="error">{activate.error}</Notice>
        </div>
      ) : null}
      <table className="tbl">
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
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
            <TableMessage colSpan={6}>No keys yet. Requests to this upstream return 503 until one is active.</TableMessage>
          ) : (
            upstream.keys.map((k) => (
              <tr key={k.id} className={k.revoked_at ? "text-content-muted" : ""}>
                <td>
                  <span className="block max-w-[24ch] truncate" title={k.label}>
                    {k.label}
                  </span>
                </td>
                <td>
                  <Mono>{k.hint}</Mono>
                </td>
                <td>
                  <KeyStatus k={k} now={now} />
                </td>
                <td title={k.last_used_at ? formatDateTime(k.last_used_at) : undefined}>{formatRelative(k.last_used_at, now)}</td>
                <td title={formatDateTime(k.created_at)}>{formatDate(k.created_at)}</td>
                <td className="actions">
                  {k.revoked_at ? null : (
                    <span className="inline-flex gap-1">
                      {k.active === 1 ? null : (
                        <Button size="sm" variant="quiet" onClick={() => void activate.run(k.id)} disabled={activate.busy}>
                          Activate
                        </Button>
                      )}
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
        confirmLabel="Revoke key"
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
        {revoking?.active === 1
          ? `This is the active key. Until another key is activated, requests to ${upstream.slug} return 503. A revoked key cannot be activated again.`
          : "A revoked key cannot be activated again."}
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
        Its provider keys are deleted with it and requests to {u.slug} return 404. Tokens scoped to it keep the slug in their scope but stop working for it. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
