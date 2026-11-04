import { useState } from "react";
import { STRATEGIES, type Placement, type Strategy, type Upstream, type UpstreamInput } from "../api.ts";
import { RESERVED_SLUGS, SLUG_PATTERN, placeholderNames } from "../format.ts";
import { useAction } from "../hooks.ts";
import { NO_PLACEMENT_ERRORS, PLACEMENT_PRESETS, cleanPlacements, firstPlacementErrorId, validatePlacements, type PlacementErrors } from "../placement-rules.ts";
import { PlacementsEditor } from "../placements-editor.tsx";
import { PlacementPreview, UrlForms } from "../placements.tsx";
import { Button, Field, Input, Mono, Notice, Select, Textarea } from "../ui.tsx";

interface Errors {
  slug?: string | undefined;
  name?: string | undefined;
  base_url?: string | undefined;
  placements: PlacementErrors;
}

const NO_ERRORS: Errors = { placements: NO_PLACEMENT_ERRORS };

const STRATEGY_LABEL: Record<Strategy, string> = { active: "Active credential", round_robin: "Round robin" };
const STRATEGY_HELP: Record<Strategy, string> = {
  active: "Every request uses the one active credential.",
  round_robin: "Requests take turns across every enabled, complete credential; one the provider rejects sits out for five minutes.",
};

const EMPTY: UpstreamInput = {
  slug: "",
  name: "",
  base_url: "",
  placements: PLACEMENT_PRESETS[0]?.placements.map((p) => ({ ...p })) ?? [],
  strategy: "active",
  notes: "",
  docs: "",
};

function fromUpstream(u: Upstream): UpstreamInput {
  return { slug: u.slug, name: u.name, base_url: u.base_url, placements: u.placements.map((p) => ({ ...p })), strategy: u.strategy, notes: u.notes, docs: u.docs };
}

function validateFields(form: UpstreamInput): Omit<Errors, "placements"> {
  const errors: Omit<Errors, "placements"> = {};
  if (!SLUG_PATTERN.test(form.slug)) errors.slug = "Use lowercase letters, digits and dashes, starting with a letter or digit.";
  else if (RESERVED_SLUGS.has(form.slug)) errors.slug = `"${form.slug}" is reserved.`;
  if (!form.name.trim()) errors.name = "Give the upstream a name.";
  try {
    const url = new URL(form.base_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") errors.base_url = "The base URL must start with https:// or http://.";
  } catch {
    errors.base_url = "Enter a full URL such as https://api.example.com/v1.";
  }
  return errors;
}

interface Props {
  initial?: Upstream;
  /** "create" shows every field; "settings" hides the placements, which the upstream page edits separately. */
  mode: "create" | "settings";
  submitLabel: string;
  onSubmit: (input: UpstreamInput) => Promise<void>;
}

export default function UpstreamForm({ initial, mode, submitLabel, onSubmit }: Props) {
  const [form, setForm] = useState<UpstreamInput>(() => (initial ? fromUpstream(initial) : EMPTY));
  const [errors, setErrors] = useState<Errors>(NO_ERRORS);
  const action = useAction(onSubmit);

  const set = <K extends "slug" | "name" | "base_url" | "notes" | "docs" | "strategy">(key: K, value: UpstreamInput[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    const field: "slug" | "name" | "base_url" | undefined = key === "slug" || key === "name" || key === "base_url" ? key : undefined;
    if (field && errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };
  const setPlacements = (placements: Placement[]): void => {
    setForm((f) => ({ ...f, placements }));
    setErrors((e) => ({ ...e, placements: NO_PLACEMENT_ERRORS }));
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const cleaned: UpstreamInput = {
      ...form,
      slug: form.slug.trim(),
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      placements: cleanPlacements(form.placements),
      notes: form.notes.trim(),
      docs: form.docs.trim(),
    };
    const found: Errors = { ...validateFields(cleaned), placements: mode === "create" ? validatePlacements(cleaned.placements) : NO_PLACEMENT_ERRORS };
    setErrors(found);
    const focusId = found.name ? "upstream-name" : found.slug ? "upstream-slug" : found.base_url ? "upstream-base_url" : firstPlacementErrorId(found.placements);
    if (focusId) {
      document.getElementById(focusId)?.focus();
      return;
    }
    void action.run(cleaned);
  };

  const names = placeholderNames(form.placements);

  return (
    <form onSubmit={submit} className={mode === "create" ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "grid gap-5 md:grid-cols-2"}>
      <div className={mode === "create" ? "flex flex-col gap-5" : "contents"}>
        <Field label="Name" htmlFor="upstream-name" error={errors.name}>
          <Input id="upstream-name" value={form.name} onChange={(e) => set("name", e.target.value)} aria-invalid={errors.name ? true : undefined} placeholder="OpenAI" />
        </Field>
        <Field label="Slug" htmlFor="upstream-slug" hint="Consumers address the upstream by this slug in the path or as a subdomain." error={errors.slug}>
          <Input id="upstream-slug" mono value={form.slug} onChange={(e) => set("slug", e.target.value)} aria-invalid={errors.slug ? true : undefined} placeholder="openai" spellCheck={false} />
        </Field>
        <Field label="Base URL" htmlFor="upstream-base_url" hint="The consumer's path is appended to this URL." error={errors.base_url}>
          <Input id="upstream-base_url" mono value={form.base_url} onChange={(e) => set("base_url", e.target.value)} aria-invalid={errors.base_url ? true : undefined} placeholder="https://api.openai.com/v1" spellCheck={false} />
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
        {mode === "create" ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Placements</legend>
            <PlacementsEditor placements={form.placements} errors={errors.placements} onChange={setPlacements} />
          </fieldset>
        ) : null}
        <Field label="Notes" htmlFor="upstream-notes" hint="Only visible here.">
          <Textarea id="upstream-notes" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <Field label="Docs" htmlFor="upstream-docs" hint={`Markdown served at ${window.location.origin}/${form.slug || "slug"}/llms.txt to tokens scoped to this upstream, below the base URL and token lines keygate writes.`}>
          <Textarea id="upstream-docs" mono rows={8} value={form.docs} onChange={(e) => set("docs", e.target.value)} spellCheck={false} />
        </Field>
        {action.error ? (
          <div className={mode === "create" ? "" : "md:col-span-2"}>
            <Notice kind="error">{action.error}</Notice>
          </div>
        ) : null}
        <div className={mode === "create" ? "" : "md:col-span-2"}>
          <Button type="submit" variant="primary" busy={action.busy}>
            {action.busy ? "Saving..." : submitLabel}
          </Button>
        </div>
      </div>
      {mode === "create" ? (
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
                  A credential can hold: <Mono>{names.join(", ")}</Mono>
                </>
              )}
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium">Consumer addresses</h3>
            <p className="mt-0.5 mb-2 text-sm text-content-muted">Either form reaches this upstream once it is saved.</p>
            <UrlForms slug={SLUG_PATTERN.test(form.slug) && !RESERVED_SLUGS.has(form.slug) ? form.slug : "slug"} />
          </div>
        </aside>
      ) : null}
    </form>
  );
}
