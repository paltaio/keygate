import type { Placement, PlacementType, RequestRow, RequestStatus } from "./api.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "3 min ago" style, relative to `now` (the time the data was fetched). */
export function formatRelative(iso: string | null, now: number): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return formatDate(iso);
}

export function isPast(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t <= now;
}

export function formatBytes(n: number | null): string {
  if (n === null) return "-";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatMs(n: number | null): string {
  if (n === null) return "-";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : n.toLocaleString("en-US");
}

/** Local datetime-local input value for an ISO timestamp. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const PLACEMENT_TYPE_LABEL: Record<PlacementType, string> = {
  header: "Header",
  query: "Query parameter",
  cookie: "Cookie",
  json: "JSON body field",
  form: "Form body field",
};

export const PLACEMENT_NAME_HINT: Record<PlacementType, string> = {
  header: "Header name",
  query: "Parameter name",
  cookie: "Cookie name",
  json: "Field name",
  form: "Field name",
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface TemplateSegment {
  text: string;
  placeholder: boolean;
}

/** Splits a template into literal text and placeholder names. */
export function templateSegments(template: string): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: template.slice(last, start), placeholder: false });
    out.push({ text: m[1] ?? "", placeholder: true });
    last = start + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last), placeholder: false });
  return out;
}

/** Every placeholder the placements reference, in first-seen order. */
export function placeholderNames(placements: Placement[]): string[] {
  const names: string[] = [];
  for (const p of placements) {
    for (const s of templateSegments(p.value)) if (s.placeholder && !names.includes(s.text)) names.push(s.text);
  }
  return names;
}

/** Text that precedes the template when the placement is written. */
export function placementPrefix(p: Placement): string {
  const name = p.name || "name";
  switch (p.type) {
    case "header":
      return `${name}: `;
    case "query":
      return `?${name}=`;
    case "cookie":
      return `Cookie: ${name}=`;
    case "json":
      return `body.${name} = `;
    case "form":
      return `${name}=`;
  }
}

/** One-line form of a placement with placeholders shown as <name>. */
export function placementSummary(p: Placement): string {
  return placementPrefix(p) + templateSegments(p.value).map((s) => (s.placeholder ? `<${s.text}>` : s.text)).join("");
}

/** "token sk-...TKEY, key ab...wxyz" for a credential's masked values. */
export function hintsSummary(hints: Record<string, string>): string {
  return Object.entries(hints)
    .map(([name, hint]) => `${name} ${hint}`)
    .join(", ");
}

export function upstreamUrls(slug: string): [string, string] {
  const { protocol, host } = window.location;
  return [`${protocol}//${host}/${slug}/...`, `${protocol}//${slug}.${host}/...`];
}

export function requestKind(row: RequestRow): RequestStatus {
  if (row.error !== null || row.status === null) return "proxy_error";
  if (row.status >= 500) return "upstream_error";
  if (row.status >= 400) return "client_error";
  return "ok";
}

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  ok: "OK",
  client_error: "Client error (4xx)",
  upstream_error: "Upstream error (5xx)",
  proxy_error: "Rejected by keygate",
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const RESERVED_SLUGS = new Set(["admin", "api", "health", "assets"]);

export function isOrigin(value: string): boolean {
  if (value === "*") return true;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}
