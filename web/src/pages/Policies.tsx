import { lazy, Suspense, useState } from "react";
import { useLocation } from "wouter";
import { api, ApiError, type PolicyDetail, type TokenRef } from "../api.ts";
import { errorMessage, formatDateTime, formatRelative } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { BLANK_POLICY, POLICY_TEMPLATES } from "../policy-templates.ts";
import { Button, ConfirmDialog, LinkButton, LoadError, Mono, Notice, PageHeader, Panel, Pill, TableMessage, TextLink } from "../ui.tsx";

const CodeEditor = lazy(() => import("../code-editor.tsx"));

function tokens(n: number): string {
  return `${n} token${n === 1 ? "" : "s"}`;
}

function EnabledPill({ enabled }: { enabled: boolean }) {
  return enabled ? <Pill tone="ok">Enabled</Pill> : <Pill>Disabled</Pill>;
}

export function PoliciesPage() {
  const load = useLoad("policies", api.policies.list);
  const data = load.data;
  return (
    <>
      <PageHeader
        title="Policies"
        description="TypeScript that checks or changes requests and responses for the tokens it is attached to."
        actions={
          <LinkButton href="/policies/new" variant="primary">
            New policy
          </LinkButton>
        }
      />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      <Panel bleed>
        <table className="tbl">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Needs</th>
              <th>Status</th>
              <th>Updated</th>
              <th className="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <TableMessage colSpan={5}>{load.error ? "Nothing to show." : "Loading policies..."}</TableMessage>
            ) : data.length === 0 ? (
              <TableMessage colSpan={5}>
                <p>No policies yet. Start from a template to deny models, redact body text, add a header or block paths.</p>
                <div className="mt-3">
                  <LinkButton href="/policies/new" variant="primary">
                    New policy
                  </LinkButton>
                </div>
              </TableMessage>
            ) : (
              data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <TextLink href={`/policies/${p.id}`} mono>
                      {p.name}
                    </TextLink>
                  </td>
                  <td>{p.needs.length ? <Mono>{p.needs.join(", ")}</Mono> : <span className="text-content-muted">-</span>}</td>
                  <td>
                    <EnabledPill enabled={p.enabled} />
                  </td>
                  <td title={formatDateTime(p.updated_at)}>{formatRelative(p.updated_at, load.at)}</td>
                  <td className="num">{p.token_count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

interface SaveProblem {
  compile: boolean;
  message: string;
}

function problemOf(e: unknown): SaveProblem {
  if (e instanceof ApiError && e.code === "compile_error") return { compile: true, message: e.message };
  if (e instanceof ApiError && e.code === "name_taken") return { compile: false, message: `${e.message}. Pick another meta.name.` };
  return { compile: false, message: errorMessage(e) };
}

interface FormProps {
  initialSource: string;
  /** Tokens the saved policy is attached to; 0 for a new policy. */
  tokenCount: number;
  submitLabel: string;
  templates?: boolean | undefined;
  onSave: (source: string) => Promise<void>;
}

function PolicyForm({ initialSource, tokenCount, submitLabel, templates = false, onSave }: FormProps) {
  const [source, setSource] = useState(initialSource);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const dirty = source !== initialSource;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await onSave(source);
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="policy-source-label" className="text-sm font-medium">
          Code
        </h2>
        {templates ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-content-muted">Start from:</span>
            <Button size="sm" onClick={() => setSource(BLANK_POLICY)}>
              Blank
            </Button>
            {POLICY_TEMPLATES.map((t) => (
              <Button key={t.id} size="sm" onClick={() => setSource(t.source)}>
                {t.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <Suspense fallback={<div className="flex min-h-[26rem] items-center justify-center rounded-ctl border border-border-strong text-sm text-content-muted">Loading editor...</div>}>
        <CodeEditor
          id="policy-source"
          value={source}
          onChange={setSource}
          labelledBy="policy-source-label"
          describedBy={problem ? "policy-source-error" : undefined}
          invalid={problem?.compile}
        />
      </Suspense>
      <p className="text-sm text-content-muted">
        Hook arguments and helpers are described at{" "}
        <TextLink href="/docs/skill.md" mono newTab>
          /docs/skill.md
        </TextLink>
        .
      </p>
      {problem ? (
        <div id="policy-source-error">
          <Notice kind="error">
            {problem.compile ? (
              <>
                <p className="font-medium">Not saved: the code does not compile.</p>
                <Mono className="mt-1 block whitespace-pre-wrap">{problem.message}</Mono>
              </>
            ) : (
              <p>Not saved: {problem.message}</p>
            )}
          </Notice>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" busy={busy} disabled={!dirty && !busy && !templates}>
          {busy ? "Saving..." : submitLabel}
        </Button>
        {dirty && !templates ? (
          <Button
            variant="quiet"
            onClick={() => {
              setSource(initialSource);
              setProblem(null);
            }}
          >
            Discard changes
          </Button>
        ) : null}
        {dirty && tokenCount > 0 ? <span className="text-sm text-content-muted">Saving applies to {tokens(tokenCount)} at once.</span> : null}
      </div>
    </form>
  );
}

export function NewPolicyPage() {
  const [, navigate] = useLocation();
  return (
    <>
      <PageHeader title="New policy" description={<>The name comes from <Mono>meta.name</Mono> in the code.</>} />
      <Panel>
        <PolicyForm
          initialSource={BLANK_POLICY}
          tokenCount={0}
          submitLabel="Create policy"
          templates
          onSave={async (source) => {
            const created = await api.policies.create(source);
            navigate(`/policies/${created.id}`);
          }}
        />
      </Panel>
    </>
  );
}

function TokenLinks({ list }: { list: TokenRef[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {list.map((t) => (
        <TextLink key={t.id} href={`/tokens/${t.id}`}>
          {t.name}
        </TextLink>
      ))}
    </span>
  );
}

function tokenRefs(list: unknown[]): TokenRef[] {
  return list.flatMap((t) => (typeof t === "object" && t !== null && "id" in t && "name" in t && typeof t.id === "number" && typeof t.name === "string" ? [{ id: t.id, name: t.name }] : []));
}

export function PolicyPage({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const load = useLoad(`policy:${id}`, () => api.policies.get(id));
  const [deleting, setDeleting] = useState(false);
  const [inUse, setInUse] = useState<TokenRef[] | null>(null);
  const toggle = useAction(async (p: PolicyDetail) => {
    await api.policies.update(p.id, { enabled: !p.enabled });
    load.reload();
  });
  const remove = useAction(async () => {
    try {
      await api.policies.remove(id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "policy_in_use" && Array.isArray(e.body.tokens)) {
        setInUse(tokenRefs(e.body.tokens));
        setDeleting(false);
        load.reload();
        return;
      }
      throw e;
    }
    navigate("/policies");
  });
  const p = load.data;

  if (!p) {
    return (
      <>
        <PageHeader title="Policy" />
        {load.error ? (
          <div className="flex flex-col gap-3">
            <LoadError message={load.error} onRetry={load.reload} />
            <p className="text-sm">
              <TextLink href="/policies">Back to policies</TextLink>
            </p>
          </div>
        ) : (
          <p className="text-sm text-content-muted">Loading policy...</p>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={p.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <EnabledPill enabled={p.enabled} />
            <span>{p.token_count ? `Attached to ${tokens(p.token_count)}` : "Not attached to any token"}</span>
            {p.needs.length ? (
              <span>
                Needs <Mono>{p.needs.join(", ")}</Mono>
              </span>
            ) : null}
            <span title={formatDateTime(p.updated_at)}>Updated {formatRelative(p.updated_at, load.at)}</span>
          </span>
        }
        actions={
          <>
            <LinkButton href={`/requests?policy=${p.name}`} variant="quiet">
              Requests
            </LinkButton>
            <Button onClick={() => void toggle.run(p)} busy={toggle.busy}>
              {p.enabled ? "Disable policy" : "Enable policy"}
            </Button>
            <Button
              variant="quiet"
              className="text-status-critical hover:text-status-critical"
              onClick={() => {
                setInUse(null);
                setDeleting(true);
              }}
            >
              Delete policy
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-4">
        {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
        {toggle.error ? <Notice kind="error">{toggle.error}</Notice> : null}
        {inUse ? (
          <Notice
            kind="error"
            action={
              <Button size="sm" variant="quiet" onClick={() => setInUse(null)}>
                Dismiss
              </Button>
            }
          >
            <p>Not deleted: the policy is attached to {tokens(inUse.length)}. Detach it from each one first.</p>
            <p className="mt-1">
              <TokenLinks list={inUse} />
            </p>
          </Notice>
        ) : null}
        <Panel>
          <PolicyForm
            key={p.updated_at}
            initialSource={p.source}
            tokenCount={p.token_count}
            submitLabel="Save policy"
            onSave={async (source) => {
              await api.policies.update(p.id, { source });
              load.reload();
            }}
          />
        </Panel>
        {p.tokens.length ? (
          <Panel title="Tokens" description="Code changes and the enabled switch apply to these tokens at once.">
            <TokenLinks list={p.tokens} />
          </Panel>
        ) : null}
      </div>
      <ConfirmDialog
        open={deleting}
        title={`Delete "${p.name}"?`}
        confirmLabel="Delete policy"
        busy={remove.busy}
        error={remove.error}
        onClose={() => {
          setDeleting(false);
          remove.reset();
        }}
        onConfirm={() => void remove.run()}
      >
        {p.token_count ? `It is attached to ${tokens(p.token_count)} and cannot be deleted until it is detached from them.` : "This cannot be undone."}
      </ConfirmDialog>
    </>
  );
}
