import { useState } from "react";
import { api, type ApiKey, type CreatedApiKey } from "../api.ts";
import { formatDate, formatDateTime, formatRelative } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { Button, ConfirmDialog, CopyButton, Field, InkBlock, Input, LoadError, Mono, Notice, PageHeader, Panel, Pill, TableMessage } from "../ui.tsx";

function installLines(origin: string): string {
  return ["mkdir -p ~/.claude/skills/keygate", `curl -fsSL ${origin}/docs/skill.md -o ~/.claude/skills/keygate/SKILL.md`, `curl -fsSL ${origin}/docs/keygate.ts -o ~/.claude/skills/keygate/keygate.ts`].join("\n");
}

function envLines(origin: string, key: string | null): string {
  return [`KEYGATE_URL=${origin}`, `KEYGATE_API_KEY=${key ?? "kga_..."}`].join("\n");
}

function CreatedPanel({ created, onDone, onAnother }: { created: CreatedApiKey; onDone: () => void; onAnother: () => void }) {
  return (
    <Panel title={`API key "${created.name}" created`}>
      <Notice className="mb-4">Copy the key now. It is shown this once and cannot be retrieved later; create a new key if it is lost.</Notice>
      <div className="flex items-center gap-2">
        <InkBlock className="min-w-0 flex-1 select-all">{created.key}</InkBlock>
        <CopyButton value={created.key} label="Copy key" size="md" />
      </div>
      <p className="mt-4 text-sm text-content-muted">
        Send it as <Mono>Authorization: Bearer {"<key>"}</Mono> on requests to <Mono>{window.location.origin}/api</Mono>.
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
        <Button onClick={onAnother}>Create another</Button>
      </div>
    </Panel>
  );
}

function CreateForm({ onCreated }: { onCreated: (key: CreatedApiKey) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const action = useAction(async () => {
    onCreated(await api.apiKeys.create(name.trim()));
    setName("");
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) {
          setError("Name the key after what will use it, such as a laptop or an agent.");
          document.getElementById("api-key-name")?.focus();
          return;
        }
        setError(null);
        void action.run();
      }}
      className="flex flex-col gap-4 md:flex-row md:items-start"
    >
      <div className="min-w-0 flex-1">
        <Field label="Name" htmlFor="api-key-name" error={error}>
          <Input
            id="api-key-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            placeholder="agent on my laptop"
          />
        </Field>
      </div>
      <div className="md:pt-7">
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Creating..." : "Create API key"}
        </Button>
      </div>
      {action.error ? (
        <div className="md:basis-full">
          <Notice kind="error">{action.error}</Notice>
        </div>
      ) : null}
    </form>
  );
}

export default function ApiKeys() {
  const load = useLoad("api-keys", api.apiKeys.list);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useAction(async (id: number) => {
    await api.apiKeys.revoke(id);
    setRevoking(null);
    load.reload();
  });
  const data = load.data;
  const origin = window.location.origin;

  return (
    <>
      <PageHeader title="API keys" description="Let a terminal or an agent call this API as you. A key can do everything you can here except manage users and API keys." />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      <div className="flex flex-col gap-6">
        {created ? (
          <CreatedPanel
            created={created}
            onDone={() => setCreated(null)}
            onAnother={() => {
              setCreated(null);
              document.getElementById("api-key-name")?.focus();
            }}
          />
        ) : (
          <Panel title="New API key">
            <CreateForm
              onCreated={(key) => {
                setCreated(key);
                load.reload();
              }}
            />
          </Panel>
        )}
        <Panel bleed>
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th className="actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <TableMessage colSpan={6}>{load.error ? "Nothing to show." : "Loading API keys..."}</TableMessage>
              ) : data.length === 0 ? (
                <TableMessage colSpan={6}>No API keys yet. Create one to use keygate from a terminal or an agent.</TableMessage>
              ) : (
                data.map((k) => (
                  <tr key={k.id} className={k.revoked_at ? "text-content-muted" : ""}>
                    <td>
                      <span className="block max-w-[28ch] truncate" title={k.name}>
                        {k.name}
                      </span>
                    </td>
                    <td>
                      <Mono>{k.hint}</Mono>
                    </td>
                    <td title={formatDateTime(k.created_at)}>{formatDate(k.created_at)}</td>
                    <td title={k.last_used_at ? formatDateTime(k.last_used_at) : undefined}>{formatRelative(k.last_used_at, load.at)}</td>
                    <td>{k.revoked_at ? <Pill title={formatDateTime(k.revoked_at)}>Revoked {formatDate(k.revoked_at)}</Pill> : <Pill tone="ok">Live</Pill>}</td>
                    <td className="actions">
                      {k.revoked_at ? null : (
                        <Button size="sm" variant="quiet" className="text-status-critical hover:text-status-critical" onClick={() => setRevoking(k)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
        <Panel title="Use it from a terminal or an agent" description="Installs the keygate skill and CLI for Claude Code or any agent that reads a SKILL.md; the CLI takes the key from an env file.">
          <div className="flex flex-col gap-5">
            <div>
              <p className="mb-2 text-sm">Install the skill and CLI:</p>
              <div className="flex items-start gap-2">
                <InkBlock className="min-w-0 flex-1">{installLines(origin)}</InkBlock>
                <CopyButton value={installLines(origin)} />
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm">
                Then put the key in <Mono>~/.config/agents/keygate.env</Mono>:
              </p>
              <div className="flex items-start gap-2">
                <InkBlock className="min-w-0 flex-1">{envLines(origin, created?.key ?? null)}</InkBlock>
                <CopyButton value={envLines(origin, created?.key ?? null)} />
              </div>
              {created ? <p className="mt-2 text-sm text-content-muted">The key you just created is filled in above.</p> : null}
            </div>
          </div>
        </Panel>
      </div>
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke "${revoking.name}"?` : ""}
        confirmLabel="Revoke API key"
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
        Requests signed with this key are refused from now on. This cannot be undone; create a new key to restore access.
      </ConfirmDialog>
    </>
  );
}
