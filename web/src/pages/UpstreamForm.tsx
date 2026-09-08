import { useState } from "react";
import { PLACEMENT_TYPES, STRATEGIES, type Placement, type PlacementType, type Strategy, type Upstream, type UpstreamInput } from "../api.ts";
import { PLACEMENT_NAME_HINT, PLACEMENT_TYPE_LABEL, RESERVED_SLUGS, SLUG_PATTERN, placeholderNames } from "../format.ts";
import { useAction } from "../hooks.ts";
import { PlacementPreview, UrlForms } from "../placements.tsx";
import { Button, Field, Input, Mono, Notice, Select, Textarea } from "../ui.tsx";

interface Errors {
  slug?: string | undefined;
  name?: string | undefined;
  base_url?: string | undefined;
  placements?: string | undefined;
  rows: Record<number, string>;
}

const NO_ERRORS: Errors = { rows: {} };

const STRATEGY_LABEL: Record<Strategy, string> = { active: "Active credential", round_robin: "Round robin" };
const STRATEGY_HELP: Record<Strategy, string> = {
  active: "Every request uses the one active credential.",
  round_robin: "Requests take turns across every enabled credential; one the provider rejects sits out for five minutes.",
};
const MAX_PLACEMENTS = 20;

const PRESETS: { label: string; placements: Placement[] }[] = [
  { label: "Bearer header", placements: [{ type: "header", name: "Authorization", value: "Bearer {{token}}" }] },
  { label: "X-API-Key header", placements: [{ type: "header", name: "X-API-Key", value: "{{api_key}}" }] },
  { label: "api_key query", placements: [{ type: "query", name: "api_key", value: "{{api_key}}" }] },
];

const EMPTY: UpstreamInput = {
  slug: "",
  name: "",
  base_url: "",
  placements: PRESETS[0]?.placements.map((p) => ({ ...p })) ?? [],
  strategy: "active",
  notes: "",
};

function fromUpstream(u: Upstream): UpstreamInput {
  return { slug: u.slug, name: u.name, base_url: u.base_url, placements: u.placements.map((p) => ({ ...p })), strategy: u.strategy, notes: u.notes };
}

function validate(form: UpstreamInput): Errors {
  const errors: Errors = { rows: {} };
  if (!SLUG_PATTERN.test(form.slug)) errors.slug = "Use lowercase letters, digits and dashes, starting with a letter or digit.";
  else if (RESERVED_SLUGS.has(form.slug)) errors.slug = `"${form.slug}" is reserved.`;
  if (!form.name.trim()) errors.name = "Give the upstream a name.";
  try {
    const url = new URL(form.base_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") errors.base_url = "The base URL must start with https:// or http://.";
  } catch {
    errors.base_url = "Enter a full URL such as https://api.example.com/v1.";
  }
  if (form.placements.length === 0) errors.placements = "Add at least one placement.";
  form.placements.forEach((p, i) => {
    if (!p.name.trim()) errors.rows[i] = "Name the header, parameter, cookie or field.";
    else if (!p.value.trim()) errors.rows[i] = "Give the value a template, such as Bearer {{token}}.";
  });
  return errors;
}

function firstInvalidId(errors: Errors): string | undefined {
  if (errors.name) return "upstream-name";
  if (errors.slug) return "upstream-slug";
  if (errors.base_url) return "upstream-base_url";
  const row = Object.keys(errors.rows)[0];
  if (row !== undefined) return `upstream-placement-${row}-name`;
  if (errors.placements) return "upstream-add-placement";
  return undefined;
}

interface Props {
  initial?: Upstream;
  submitLabel: string;
  onSubmit: (input: UpstreamInput) => Promise<void>;
}

export default function UpstreamForm({ initial, submitLabel, onSubmit }: Props) {
  const [form, setForm] = useState<UpstreamInput>(() => (initial ? fromUpstream(initial) : EMPTY));
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const action = useAction(onSubmit);

  const set = <K extends "slug" | "name" | "base_url" | "notes" | "strategy">(key: K, value: UpstreamInput[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    const field: "slug" | "name" | "base_url" | undefined = key === "slug" || key === "name" || key === "base_url" ? key : undefined;
    if (field && errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };
  const setRow = (index: number, patch: Partial<Placement>): void => {
    setForm((f) => ({ ...f, placements: f.placements.map((p, i) => (i === index ? { ...p, ...patch } : p)) }));
    if (errors.rows[index]) {
      setErrors((e) => {
        const rows = { ...e.rows };
        delete rows[index];
        return { ...e, rows };
      });
    }
  };
  const addRow = (): void => {
    setForm((f) => ({ ...f, placements: [...f.placements, { type: "header", name: "", value: "" }] }));
    setErrors((e) => ({ ...e, placements: undefined }));
  };
  const removeRow = (index: number): void => {
    setForm((f) => ({ ...f, placements: f.placements.filter((_, i) => i !== index) }));
    setErrors((e) => ({ ...e, rows: {} }));
  };
  const applyPreset = (placements: Placement[]): void => {
    setForm((f) => ({ ...f, placements: placements.map((p) => ({ ...p })) }));
    setErrors((e) => ({ ...e, placements: undefined, rows: {} }));
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const cleaned: UpstreamInput = {
      ...form,
      slug: form.slug.trim(),
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      placements: form.placements.map((p) => ({ type: p.type, name: p.name.trim(), value: p.value.trim() })),
      notes: form.notes.trim(),
    };
    const found = validate(cleaned);
    setErrors(found);
    const focusId = firstInvalidId(found);
    if (focusId) {
      document.getElementById(focusId)?.focus();
      return;
    }
    void action.run(cleaned);
  };

  const names = placeholderNames(form.placements);

  return (
    <form onSubmit={submit} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-5">
        <Field label="Name" htmlFor="upstream-name" error={errors.name}>
          <Input id="upstream-name" value={form.name} onChange={(e) => set("name", e.target.value)} aria-invalid={errors.name ? true : undefined} placeholder="OpenAI" />
        </Field>
        <Field label="Slug" htmlFor="upstream-slug" hint="Consumers address the upstream by this slug in the path or as a subdomain." error={errors.slug}>
          <Input id="upstream-slug" className="font-mono" value={form.slug} onChange={(e) => set("slug", e.target.value)} aria-invalid={errors.slug ? true : undefined} placeholder="openai" spellCheck={false} />
        </Field>
        <Field label="Base URL" htmlFor="upstream-base_url" hint="The consumer's path is appended to this URL." error={errors.base_url}>
          <Input id="upstream-base_url" className="font-mono" value={form.base_url} onChange={(e) => set("base_url", e.target.value)} aria-invalid={errors.base_url ? true : undefined} placeholder="https://api.openai.com/v1" spellCheck={false} />
        </Field>

        <Field label="Strategy" htmlFor="upstream-strategy" hint={STRATEGY_HELP[form.strategy]}>
          <Select id="upstream-strategy" value={form.strategy} onChange={(e) => set("strategy", e.target.value as Strategy)}>
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {STRATEGY_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Placements</legend>
          <p className="-mt-1 text-sm text-content-muted">
            Where credential values go on each request. Write <Mono>{"{{name}}"}</Mono> where a value belongs; text outside the braces is sent as-is.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-content-muted">Prefill:</span>
            {PRESETS.map((preset) => (
              <Button key={preset.label} size="sm" onClick={() => applyPreset(preset.placements)}>
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            {form.placements.map((p, i) => {
              const rowError = errors.rows[i];
              return (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="grid gap-2 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-center">
                    <Select aria-label={`Placement ${i + 1} location`} value={p.type} onChange={(e) => setRow(i, { type: e.target.value as PlacementType })}>
                      {PLACEMENT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {PLACEMENT_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </Select>
                    <Input
                      id={`upstream-placement-${i}-name`}
                      aria-label={`Placement ${i + 1} name`}
                      className="font-mono"
                      placeholder={PLACEMENT_NAME_HINT[p.type]}
                      value={p.name}
                      onChange={(e) => setRow(i, { name: e.target.value })}
                      aria-invalid={rowError ? true : undefined}
                      spellCheck={false}
                    />
                    <Input
                      id={`upstream-placement-${i}-value`}
                      aria-label={`Placement ${i + 1} value template`}
                      className="font-mono"
                      placeholder="Bearer {{token}}"
                      value={p.value}
                      onChange={(e) => setRow(i, { value: e.target.value })}
                      aria-invalid={rowError ? true : undefined}
                      spellCheck={false}
                    />
                    <Button variant="quiet" onClick={() => removeRow(i)} disabled={form.placements.length <= 1} aria-label={`Remove placement ${i + 1}`}>
                      Remove
                    </Button>
                  </div>
                  {rowError ? (
                    <p className="text-sm text-status-critical" role="alert">
                      {rowError}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          {errors.placements ? (
            <p className="text-sm text-status-critical" role="alert">
              {errors.placements}
            </p>
          ) : null}
          <div>
            <Button id="upstream-add-placement" size="sm" onClick={addRow} disabled={form.placements.length >= MAX_PLACEMENTS}>
              Add placement
            </Button>
            {form.placements.length >= MAX_PLACEMENTS ? <span className="ml-2 text-sm text-content-muted">Up to {MAX_PLACEMENTS} placements.</span> : null}
          </div>
        </fieldset>

        <Field label="Notes" htmlFor="upstream-notes" hint="Only visible here.">
          <Textarea id="upstream-notes" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        {action.error ? <Notice kind="error">{action.error}</Notice> : null}
        <div>
          <Button type="submit" variant="primary" busy={action.busy}>
            {action.busy ? "Saving..." : submitLabel}
          </Button>
        </div>
      </div>
      <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
        <div>
          <h3 className="text-sm font-medium">What the upstream receives</h3>
          <p className="mt-0.5 mb-2 text-sm text-content-muted">Every placement after the consumer token is swapped out.</p>
          <PlacementPreview placements={form.placements} />
          <p className="mt-2 text-sm text-content-muted">
            {names.length === 0 ? (
              "No placeholders: every placement is sent as a constant."
            ) : (
              <>
                A credential must hold: <Mono>{names.join(", ")}</Mono>
              </>
            )}
          </p>
        </div>
        {initial ? null : (
          <div>
            <h3 className="text-sm font-medium">Consumer addresses</h3>
            <p className="mt-0.5 mb-2 text-sm text-content-muted">Either form reaches this upstream once it is saved.</p>
            <UrlForms slug={SLUG_PATTERN.test(form.slug) && !RESERVED_SLUGS.has(form.slug) ? form.slug : "slug"} />
          </div>
        )}
      </aside>
    </form>
  );
}
