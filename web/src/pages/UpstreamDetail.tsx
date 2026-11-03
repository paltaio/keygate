import { useState } from "react";
import { useLocation } from "wouter";
import { api, type Placement, type ProviderKey, type UpstreamDetail as Detail } from "../api.ts";
import { formatDate, formatDateTime, formatRelative } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { NO_PLACEMENT_ERRORS, cleanPlacements, firstPlacementErrorId, validatePlacements, type PlacementErrors } from "../placement-rules.ts";
import { PlacementsEditor } from "../placements-editor.tsx";
import { PlacementPreview, UrlForms } from "../placements.tsx";
import { Button, Checkbox, ConfirmDialog, Field, Input, LoadError, Mono, Notice, PageHeader, Panel, Pill, SecretInput, TableMessage, TextLink } from "../ui.tsx";
import UpstreamForm from "./UpstreamForm.tsx";

function PlacementsPanel({ upstream, onSaved }: { upstream: Detail; onSaved: () => void }) {
  const [placements, setPlacements] = useState<Placement[]>(() => upstream.placements.map((p) => ({ ...p })));
  const [errors, setErrors] = useState<PlacementErrors>(NO_PLACEMENT_ERRORS);
  const action = useAction(async (next: Placement[]) => {
    await api.upstreams.update(upstream.id, { slug: upstream.slug, name: upstream.name, base_url: upstream.base_url, strategy: upstream.strategy, notes: upstream.notes, docs: upstream.docs, placements: next });
    onSaved();
  });
  const dirty = JSON.stringify(placements) !== JSON.stringify(upstream.placements);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const cleaned = cleanPlacements(placements);
    const found = validatePlacements(cleaned);
    setErrors(found);
    const focusId = firstPlacementErrorId(found);
    if (focusId) {
      document.getElementById(focusId)?.focus();
      return;
    }
    void action.run(cleaned);
  };

  return (
    <Panel title="Placements" description="What the upstream receives, and which values a credential must hold to fill it.">
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PlacementsEditor
          placements={placements}
          errors={errors}
          onChange={(next) => {
            setPlacements(next);
            setErrors(NO_PLACEMENT_ERRORS);
          }}
        />
        <div className="flex flex-col gap-2 lg:sticky lg:top-6 lg:self-start">
          <h3 className="text-sm font-medium">What the upstream receives</h3>
          <PlacementPreview placements={placements} />
        </div>
        {action.error ? (
          <div className="lg:col-span-2">
            <Notice kind="error">{action.error}</Notice>
          </div>
        ) : null}
        <div className="flex items-center gap-3 lg:col-span-2">
          <Button type="submit" variant="primary" busy={action.busy} disabled={!dirty && !action.busy}>
            {action.busy ? "Saving..." : "Save placements"}
          </Button>
          {dirty ? (
            <Button
              variant="quiet"
              onClick={() => {
                setPlacements(upstream.placements.map((p) => ({ ...p })));
                setErrors(NO_PLACEMENT_ERRORS);
              }}
            >
              Discard changes
            </Button>
          ) : (
            <span className="text-sm text-content-muted">Saved. Credentials missing a new value are flagged below.</span>
          )}
        </div>
      </form>
    </Panel>
  );
}

function StatusCell({ k, upstream, now }: { k: ProviderKey; upstream: Detail; now: number }) {
  if (k.revoked_at) return <Pill title={formatDateTime(k.revoked_at)}>Revoked {formatDate(k.revoked_at)}</Pill>;
  const enabled = k.enabled === 1;
  const pool = upstream.strategy === "round_robin";
  const missing = k.missing.length ? k.missing.join(", ") : null;
  let mode: React.ReactNode;
  if (pool) {
    if (!enabled) mode = <Pill>Disabled</Pill>;
    else if (missing) mode = <Pill tone="critical">Not in pool: missing {missing}</Pill>;
    else mode = <Pill tone="ok">In pool</Pill>;
  } else if (k.active === 1) {
    mode = enabled ? <Pill tone="ok">Active</Pill> : <Pill tone="critical">Active but disabled</Pill>;
  } else {
    mode = enabled ? <Pill>Standby</Pill> : <Pill>Disabled</Pill>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {mode}
      {missing && !(pool && enabled) ? <Pill tone="critical">Missing: {missing}</Pill> : null}
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
  const pool = upstream.strategy === "round_robin";
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [activate, setActivate] = useState(true);
  const [labelError, setLabelError] = useState<string | null>(null);
  const action = useAction(async () => {
    const secrets: Record<string, string> = {};
    for (const name of names) {
      const v = values[name];
      if (v) secrets[name] = v;
    }
    await api.keys.add(upstream.id, { label: label.trim(), secrets, activate: pool ? false : activate });
    setLabel("");
    setValues({});
    setActivate(true);
    onAdded();
  });

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!label.trim()) {
      setLabelError("Give the credential a label, such as the date or who issued it.");
      document.getElementById("credential-label")?.focus();
      return;
    }
    setLabelError(null);
    void action.run();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Label" htmlFor="credential-label" error={labelError}>
          <Input
            id="credential-label"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (labelError) setLabelError(null);
            }}
            aria-invalid={labelError ? true : undefined}
            placeholder="prod 2026-09"
          />
        </Field>
        {names.map((name) => (
          <Field key={name} label={name} htmlFor={`credential-${name}`}>
            <SecretInput id={`credential-${name}`} value={values[name] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [name]: v }))} />
          </Field>
        ))}
      </div>
      <p className="-mt-2 text-sm text-content-muted">
        {names.length === 0
          ? "The placements have no placeholders, so this credential holds no values."
          : "Every value is optional here and can be filled in later with Edit. A credential missing any value is not used for requests."}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        {pool ? null : <Checkbox label="Make it the active credential" checked={activate} onChange={(e) => setActivate(e.target.checked)} />}
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Adding..." : "Add credential"}
        </Button>
      </div>
      {action.error ? <Notice kind="error">{action.error}</Notice> : null}
    </form>
  );
}

interface EditorProps {
  k: ProviderKey;
  upstream: Detail;
  focusName: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

/** Inline editor row: blank keeps the current value, Clear removes it, typing replaces it. */
function CredentialEditor({ k, upstream, focusName, onSaved, onCancel }: EditorProps) {
  const names = [...new Set([...upstream.secret_names, ...Object.keys(k.hints)])];
  const [label, setLabel] = useState(k.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [labelError, setLabelError] = useState<string | null>(null);
  const action = useAction(async () => {
    const patch: { label?: string; secrets?: Record<string, string | null> } = {};
    if (label.trim() !== k.label) patch.label = label.trim();
    const secrets: Record<string, string | null> = {};
    for (const name of names) {
      if (cleared.includes(name)) secrets[name] = null;
      else if (values[name]) secrets[name] = values[name] ?? null;
    }
    if (Object.keys(secrets).length) patch.secrets = secrets;
    if (Object.keys(patch).length) await api.keys.update(k.id, patch);
    onSaved();
  });

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!label.trim()) {
      setLabelError("The label cannot be empty.");
      document.getElementById(`edit-${k.id}-label`)?.focus();
      return;
    }
    setLabelError(null);
    void action.run();
  };

  const colSpan = 5 + upstream.secret_names.length;
  return (
    <tr>
      <td colSpan={colSpan} className="bg-surface-sunken">
        <form onSubmit={submit} className="flex flex-col gap-4 py-2">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Label" htmlFor={`edit-${k.id}-label`} error={labelError}>
              <Input id={`edit-${k.id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={labelError ? true : undefined} autoFocus={focusName === null} />
            </Field>
            {names.map((name) => {
              const hint = k.hints[name];
              const isCleared = cleared.includes(name);
              const unused = !upstream.secret_names.includes(name);
              return (
                <Field
                  key={name}
                  label={unused ? `${name} (no placement uses it)` : name}
                  htmlFor={`edit-${k.id}-${name}`}
                  hint={isCleared ? "Will be removed on save." : hint ? `Current value ${hint}. Leave blank to keep it.` : "No value yet."}
                >
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <SecretInput
                        id={`edit-${k.id}-${name}`}
                        value={values[name] ?? ""}
                        onChange={(v) => {
                          setValues((s) => ({ ...s, [name]: v }));
                          if (v) setCleared((c) => c.filter((n) => n !== name));
                        }}
                        autoFocus={focusName === name}
                      />
                    </div>
                    {hint ? (
                      <Button
                        variant="quiet"
                        aria-pressed={isCleared}
                        onClick={() => {
                          setCleared((c) => (c.includes(name) ? c.filter((n) => n !== name) : [...c, name]));
                          setValues((s) => ({ ...s, [name]: "" }));
                        }}
                      >
                        {isCleared ? "Keep" : "Clear"}
                      </Button>
                    ) : null}
                  </div>
                </Field>
              );
            })}
          </div>
          {action.error ? <Notice kind="error">{action.error}</Notice> : null}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" busy={action.busy}>
              {action.busy ? "Saving..." : "Save credential"}
            </Button>
            <Button variant="quiet" onClick={onCancel} disabled={action.busy}>
              Cancel
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

function CredentialsPanel({ upstream, now, onChange }: { upstream: Detail; now: number; onChange: () => void }) {
  const [revoking, setRevoking] = useState<ProviderKey | null>(null);
  const [editing, setEditing] = useState<{ id: number; focus: string | null } | null>(null);
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
    await api.keys.update(k.id, { enabled: k.enabled !== 1 });
    onChange();
  });
  const pool = upstream.strategy === "round_robin";
  const names = upstream.secret_names;
  const colSpan = 5 + names.length;

  return (
    <Panel
      title="Credentials"
      description={
        pool
          ? "Round robin: every enabled, complete credential takes turns. Disable one to pull it from the pool; revoking is permanent."
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
            {names.map((name) => (
              <th key={name}>
                <span className="font-mono normal-case tracking-normal">{`{{${name}}}`}</span>
              </th>
            ))}
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
            <TableMessage colSpan={colSpan}>No credentials yet. Requests to this upstream return 503 until one is {pool ? "enabled and complete" : "active and complete"}.</TableMessage>
          ) : (
            upstream.keys.map((k) => {
              const extra = Object.keys(k.hints).filter((n) => !names.includes(n));
              return (
                <RowGroup key={k.id}>
                  <tr className={k.revoked_at ? "text-content-muted" : ""}>
                    <td>
                      <span className="block max-w-[24ch] truncate" title={k.label}>
                        {k.label}
                      </span>
                      {extra.length ? (
                        <span className="block text-xs text-content-muted" title={extra.map((n) => `${n} ${k.hints[n] ?? ""}`).join(", ")}>
                          also holds {extra.join(", ")}
                        </span>
                      ) : null}
                    </td>
                    {names.map((name) => (
                      <td key={name}>
                        {k.hints[name] ? (
                          <Mono>{k.hints[name]}</Mono>
                        ) : k.revoked_at ? (
                          <span className="text-content-muted">-</span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Pill tone="critical">Missing</Pill>
                            <Button size="sm" variant="quiet" onClick={() => setEditing({ id: k.id, focus: name })}>
                              Add value
                            </Button>
                          </span>
                        )}
                      </td>
                    ))}
                    <td>
                      <StatusCell k={k} upstream={upstream} now={now} />
                    </td>
                    <td title={k.last_used_at ? formatDateTime(k.last_used_at) : undefined}>{formatRelative(k.last_used_at, now)}</td>
                    <td title={formatDateTime(k.created_at)}>{formatDate(k.created_at)}</td>
                    <td className="actions">
                      {k.revoked_at ? null : (
                        <span className="inline-flex gap-1">
                          <Button size="sm" variant="quiet" onClick={() => setEditing({ id: k.id, focus: null })} disabled={editing?.id === k.id}>
                            Edit
                          </Button>
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
                  {editing?.id === k.id ? (
                    <CredentialEditor
                      key={`${k.id}-${editing.focus ?? ""}`}
                      k={k}
                      upstream={upstream}
                      focusName={editing.focus}
                      onSaved={() => {
                        setEditing(null);
                        onChange();
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : null}
                </RowGroup>
              );
            })
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

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
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
            <span>{u.strategy === "round_robin" ? "Round robin" : "Active credential"}</span>
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
        <PlacementsPanel key={`placements-${u.updated_at}`} upstream={u} onSaved={load.reload} />
        <CredentialsPanel upstream={u} now={load.at} onChange={load.reload} />
        <Panel title="Consumer addresses" description="Send requests here with a keygate token; the path after the slug is forwarded to the base URL.">
          <UrlForms slug={u.slug} />
        </Panel>
        <Panel title="Settings">
          <UpstreamForm
            key={`settings-${u.updated_at}`}
            mode="settings"
            initial={u}
            submitLabel="Save settings"
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
