import type { RequestRow, RequestStatus, SlotType } from "./api.ts";

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

export const SLOT_HELP: Record<SlotType, string> = {
  header: "Sent as a request header. The prefix goes in front of the key.",
  query: "Added to the request URL as a query parameter.",
  cookie: "Added to the Cookie request header.",
  json: "Set as a top-level field of the JSON object body.",
  form: "Set as a field of the form-encoded body.",
};

export const SLOT_NAME_HINT: Record<SlotType, string> = {
  header: "Header name, for example Authorization or X-API-Key.",
  query: "Query parameter name, for example api_key.",
  cookie: "Cookie name.",
  json: "Field name in the JSON body.",
  form: "Field name in the form body.",
};

export interface SlotShape {
  slot_type: SlotType;
  slot_name: string;
  slot_prefix: string;
}

/** Text around the key once it is injected: [before, after]. */
export function slotParts(slot: SlotShape): [string, string] {
  const name = slot.slot_name || "name";
  switch (slot.slot_type) {
    case "header":
      return [`${name}: ${slot.slot_prefix}`, ""];
    case "query":
      return [`?${name}=`, ""];
    case "cookie":
      return [`Cookie: ${name}=`, ""];
    case "json":
      return [`{"${name}": "`, `"}`];
    case "form":
      return [`${name}=`, ""];
  }
}

export function slotSummary(slot: SlotShape): string {
  const [before, after] = slotParts(slot);
  return `${before}<key>${after}`;
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
