import { useState } from "react";
import { SLOT_TYPES, type SlotType, type Upstream, type UpstreamInput } from "../api.ts";
import { RESERVED_SLUGS, SLOT_HELP, SLOT_NAME_HINT, SLUG_PATTERN } from "../format.ts";
import { useAction } from "../hooks.ts";
import { SlotPreview, UrlForms } from "../slot.tsx";
import { Button, Field, Input, Notice, Select, Textarea } from "../ui.tsx";

type Errors = Partial<Record<keyof UpstreamInput, string>>;

const EMPTY: UpstreamInput = {
  slug: "",
  name: "",
  base_url: "",
  slot_type: "header",
  slot_name: "Authorization",
  slot_prefix: "Bearer ",
  notes: "",
};

function fromUpstream(u: Upstream): UpstreamInput {
  return { slug: u.slug, name: u.name, base_url: u.base_url, slot_type: u.slot_type, slot_name: u.slot_name, slot_prefix: u.slot_prefix, notes: u.notes };
}

function validate(form: UpstreamInput): Errors {
  const errors: Errors = {};
  if (!SLUG_PATTERN.test(form.slug)) errors.slug = "Use lowercase letters, digits and dashes, starting with a letter or digit.";
  else if (RESERVED_SLUGS.has(form.slug)) errors.slug = `"${form.slug}" is reserved.`;
  if (!form.name.trim()) errors.name = "Give the upstream a name.";
  try {
    const url = new URL(form.base_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") errors.base_url = "The base URL must start with https:// or http://.";
  } catch {
    errors.base_url = "Enter a full URL such as https://api.example.com/v1.";
  }
  if (!form.slot_name.trim()) errors.slot_name = "Name the header, parameter, cookie or field that carries the key.";
  return errors;
}

interface Props {
  initial?: Upstream;
  submitLabel: string;
  onSubmit: (input: UpstreamInput) => Promise<void>;
}

export default function UpstreamForm({ initial, submitLabel, onSubmit }: Props) {
  const [form, setForm] = useState<UpstreamInput>(() => (initial ? fromUpstream(initial) : EMPTY));
  const [errors, setErrors] = useState<Errors>({});
  const action = useAction(onSubmit);

  const set = <K extends keyof UpstreamInput>(key: K, value: UpstreamInput[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const cleaned: UpstreamInput = {
      ...form,
      slug: form.slug.trim(),
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      slot_name: form.slot_name.trim(),
      notes: form.notes.trim(),
    };
    const found = validate(cleaned);
    setErrors(found);
    const first = (Object.keys(found) as (keyof UpstreamInput)[])[0];
    if (first) {
      document.getElementById(`upstream-${first}`)?.focus();
      return;
    }
    void action.run(cleaned);
  };

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
        <Field label="Key slot" htmlFor="upstream-slot_type" hint={SLOT_HELP[form.slot_type]}>
          <Select id="upstream-slot_type" value={form.slot_type} onChange={(e) => set("slot_type", e.target.value as SlotType)}>
            {SLOT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Slot name" htmlFor="upstream-slot_name" hint={SLOT_NAME_HINT[form.slot_type]} error={errors.slot_name}>
          <Input id="upstream-slot_name" className="font-mono" value={form.slot_name} onChange={(e) => set("slot_name", e.target.value)} aria-invalid={errors.slot_name ? true : undefined} spellCheck={false} />
        </Field>
        {form.slot_type === "header" ? (
          <Field label="Prefix" htmlFor="upstream-slot_prefix" hint='Text placed before the key in the header, including any trailing space. Leave empty for a bare key.'>
            <Input id="upstream-slot_prefix" className="font-mono" value={form.slot_prefix} onChange={(e) => set("slot_prefix", e.target.value)} spellCheck={false} />
          </Field>
        ) : null}
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
          <h3 className="text-sm font-medium">Key placement</h3>
          <p className="mt-0.5 mb-2 text-sm text-content-muted">What the upstream receives after the consumer token is swapped out.</p>
          <SlotPreview slot={form} />
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
