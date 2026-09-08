import { useState } from "react";
import { api, type Token, type TokenInput } from "../api.ts";
import { fromLocalInput, isOrigin, toLocalInput } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { Button, Checkbox, Field, Fieldset, Input, Notice, Radio, Textarea } from "../ui.tsx";

type OriginMode = "none" | "any" | "list";

interface FormState {
  name: string;
  allScopes: boolean;
  scopes: string[];
  originMode: OriginMode;
  originText: string;
  expires: string;
}

interface Errors {
  name?: string;
  scopes?: string;
  origins?: string;
  expires?: string;
}

function fromToken(t: Token): FormState {
  const allScopes = t.scopes.includes("*");
  const originMode: OriginMode = t.origins.includes("*") ? "any" : t.origins.length === 0 ? "none" : "list";
  return {
    name: t.name,
    allScopes,
    scopes: allScopes ? [] : t.scopes,
    originMode,
    originText: originMode === "list" ? t.origins.join("\n") : "",
    expires: toLocalInput(t.expires_at),
  };
}

const FIELD_IDS: Record<keyof Errors, string> = {
  name: "token-name",
  scopes: "token-scope-0",
  origins: "token-origins",
  expires: "token-expires",
};

const EMPTY: FormState = { name: "", allScopes: true, scopes: [], originMode: "none", originText: "", expires: "" };

interface Props {
  initial?: Token;
  submitLabel: string;
  onSubmit: (input: TokenInput) => Promise<void>;
}

export default function TokenForm({ initial, submitLabel, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(() => (initial ? fromToken(initial) : EMPTY));
  const [errors, setErrors] = useState<Errors>({});
  const upstreams = useLoad("upstreams", api.upstreams.list);
  const action = useAction(onSubmit);

  const update = (patch: Partial<FormState>): void => setForm((f) => ({ ...f, ...patch }));
  const toggleScope = (slug: string, on: boolean): void =>
    setForm((f) => ({ ...f, scopes: on ? [...new Set([...f.scopes, slug])] : f.scopes.filter((s) => s !== slug) }));

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const found: Errors = {};
    const name = form.name.trim();
    if (!name) found.name = "Give the token a name so you can tell it apart in the log.";
    if (!form.allScopes && form.scopes.length === 0) found.scopes = "Pick at least one upstream, or allow all.";
    const origins = form.originMode === "any" ? ["*"] : form.originMode === "none" ? [] : form.originText.split(/\s+/).filter(Boolean);
    if (form.originMode === "list") {
      if (origins.length === 0) found.origins = "List at least one origin, or choose another option.";
      else {
        const bad = origins.find((o) => !isOrigin(o));
        if (bad) found.origins = `"${bad}" is not an origin. Use scheme and host only, like https://app.example.com.`;
      }
    }
    const expires_at = fromLocalInput(form.expires);
    if (form.expires && !expires_at) found.expires = "Enter a valid date and time.";
    setErrors(found);
    const firstInvalid = (["name", "scopes", "origins", "expires"] as const).find((key) => found[key]);
    if (firstInvalid) {
      document.getElementById(FIELD_IDS[firstInvalid])?.focus();
      return;
    }
    void action.run({ name, scopes: form.allScopes ? ["*"] : form.scopes, origins, expires_at });
  };

  // Slugs the token already names that no longer exist as upstreams stay selectable so editing does not silently drop them.
  const knownSlugs = upstreams.data?.map((u) => u.slug) ?? [];
  const slugs = [...new Set([...knownSlugs, ...form.scopes])];

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-6">
      <Field label="Name" htmlFor="token-name" error={errors.name}>
        <Input id="token-name" value={form.name} onChange={(e) => update({ name: e.target.value })} aria-invalid={errors.name ? true : undefined} placeholder="marketing site" />
      </Field>

      <Fieldset legend="Upstreams" hint="Which upstreams this token may call.">
        <Radio name="scopes" label="All upstreams, including ones added later" checked={form.allScopes} onChange={() => update({ allScopes: true })} />
        <Radio name="scopes" label="Only these upstreams" checked={!form.allScopes} onChange={() => update({ allScopes: false })} />
        {!form.allScopes ? (
          <div className="ml-6 flex flex-col gap-1.5">
            {upstreams.error ? <Notice kind="error">{upstreams.error}</Notice> : null}
            {upstreams.data === null && !upstreams.error ? <p className="text-sm text-content-muted">Loading upstreams...</p> : null}
            {upstreams.data !== null && slugs.length === 0 ? <p className="text-sm text-content-muted">No upstreams exist yet, so there is nothing to pick.</p> : null}
            {slugs.map((slug, index) => (
              <Checkbox
                key={slug}
                id={`token-scope-${index}`}
                label={
                  <span className="font-mono text-[13px]">
                    {slug}
                    {knownSlugs.includes(slug) ? "" : " (no such upstream)"}
                  </span>
                }
                checked={form.scopes.includes(slug)}
                onChange={(e) => toggleScope(slug, e.target.checked)}
              />
            ))}
            {errors.scopes ? (
              <p className="text-sm text-status-critical" role="alert">
                {errors.scopes}
              </p>
            ) : null}
          </div>
        ) : null}
      </Fieldset>

      <Fieldset legend="Browser origins" hint="Requests that carry an Origin header are refused unless it is listed here. Server-side callers send no Origin and are unaffected.">
        <Radio name="origins" label="No browser use" checked={form.originMode === "none"} onChange={() => update({ originMode: "none" })} />
        <Radio name="origins" label="Any origin" checked={form.originMode === "any"} onChange={() => update({ originMode: "any" })} />
        <Radio name="origins" label="Only these origins" checked={form.originMode === "list"} onChange={() => update({ originMode: "list" })} />
        {form.originMode === "list" ? (
          <div className="ml-6">
            <Textarea
              id="token-origins"
              aria-label="Allowed origins, one per line"
              className="font-mono"
              rows={3}
              placeholder={"https://app.example.com\nhttp://localhost:5173"}
              value={form.originText}
              onChange={(e) => update({ originText: e.target.value })}
              aria-invalid={errors.origins ? true : undefined}
              spellCheck={false}
            />
            {errors.origins ? (
              <p className="mt-1.5 text-sm text-status-critical" role="alert">
                {errors.origins}
              </p>
            ) : (
              <p className="mt-1.5 text-sm text-content-muted">One per line.</p>
            )}
          </div>
        ) : null}
      </Fieldset>

      <Field label="Expires" htmlFor="token-expires" hint="Leave empty and the token lives until revoked." error={errors.expires}>
        <div className="flex gap-2">
          <Input id="token-expires" type="datetime-local" className="max-w-xs" value={form.expires} onChange={(e) => update({ expires: e.target.value })} aria-invalid={errors.expires ? true : undefined} />
          {form.expires ? (
            <Button variant="quiet" onClick={() => update({ expires: "" })}>
              Clear
            </Button>
          ) : null}
        </div>
      </Field>

      {action.error ? <Notice kind="error">{action.error}</Notice> : null}
      <div>
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
