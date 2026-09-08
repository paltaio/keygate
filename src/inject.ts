import { TOKEN_PREFIX, renderTemplate, type Placement } from "./store.ts";

export const TOKEN_HEADER = "x-keygate-token";
export const TOKEN_QUERY = "keygate_token";

export type ParsedBody =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "form"; value: URLSearchParams };

/** The outgoing request while the consumer token is swapped for the provider credential. */
export interface Carrier {
  url: URL;
  headers: Headers;
  body?: ParsedBody;
}

export function isToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookies(cookies: Map<string, string>): string {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Which body encodings the placements need parsed. */
export function bodyKinds(placements: Placement[]): { json: boolean; form: boolean } {
  return { json: placements.some((p) => p.type === "json"), form: placements.some((p) => p.type === "form") };
}

function readLocation(carrier: Carrier, p: Placement): string | undefined {
  switch (p.type) {
    case "header":
      return carrier.headers.get(p.name) ?? undefined;
    case "query":
      return carrier.url.searchParams.get(p.name) ?? undefined;
    case "cookie":
      return parseCookies(carrier.headers.get("cookie")).get(p.name);
    case "json": {
      const value = carrier.body?.kind === "json" ? carrier.body.value[p.name] : undefined;
      return typeof value === "string" ? value : undefined;
    }
    case "form":
      return carrier.body?.kind === "form" ? (carrier.body.value.get(p.name) ?? undefined) : undefined;
  }
}

function writeLocation(carrier: Carrier, p: Placement, value: string): void {
  switch (p.type) {
    case "header":
      carrier.headers.set(p.name, value);
      return;
    case "query":
      carrier.url.searchParams.set(p.name, value);
      return;
    case "cookie": {
      const cookies = parseCookies(carrier.headers.get("cookie"));
      cookies.set(p.name, value);
      carrier.headers.set("cookie", serializeCookies(cookies));
      return;
    }
    case "json":
      if (carrier.body?.kind === "json") carrier.body.value[p.name] = value;
      return;
    case "form":
      if (carrier.body?.kind === "form") carrier.body.value.set(p.name, value);
      return;
  }
}

function clearLocation(carrier: Carrier, p: Placement): void {
  switch (p.type) {
    case "header":
      carrier.headers.delete(p.name);
      return;
    case "query":
      carrier.url.searchParams.delete(p.name);
      return;
    case "cookie": {
      const cookies = parseCookies(carrier.headers.get("cookie"));
      cookies.delete(p.name);
      if (cookies.size) carrier.headers.set("cookie", serializeCookies(cookies));
      else carrier.headers.delete("cookie");
      return;
    }
    case "json":
      if (carrier.body?.kind === "json") delete carrier.body.value[p.name];
      return;
    case "form":
      if (carrier.body?.kind === "form") carrier.body.value.delete(p.name);
      return;
  }
}

/** The literal text around the first placeholder of a template, or undefined when it has none. */
function affixes(template: string): { prefix: string; suffix: string } | undefined {
  const start = template.indexOf("{{");
  const end = template.indexOf("}}", start);
  if (start < 0 || end < 0) return undefined;
  return { prefix: template.slice(0, start), suffix: template.slice(end + 2) };
}

/**
 * Finds the consumer token, removes it from the request, and returns it.
 * Looked up in order: the keygate header, a bearer Authorization header, the keygate query
 * parameter, then each placement location, where the token may stand in for the credential.
 */
export function extractToken(carrier: Carrier, placements: Placement[]): string | undefined {
  const dedicated = carrier.headers.get(TOKEN_HEADER);
  if (dedicated) {
    carrier.headers.delete(TOKEN_HEADER);
    return dedicated.trim();
  }
  const auth = carrier.headers.get("authorization");
  if (auth) {
    const bearer = auth.replace(/^bearer\s+/i, "").trim();
    if (isToken(bearer)) {
      carrier.headers.delete("authorization");
      return bearer;
    }
  }
  const query = carrier.url.searchParams.get(TOKEN_QUERY);
  if (query) {
    carrier.url.searchParams.delete(TOKEN_QUERY);
    return query;
  }
  for (const p of placements) {
    const fix = affixes(p.value);
    if (!fix) continue;
    const raw = readLocation(carrier, p);
    if (raw === undefined) continue;
    const lower = raw.toLowerCase();
    if (!lower.startsWith(fix.prefix.toLowerCase()) || !lower.endsWith(fix.suffix.toLowerCase())) continue;
    const inner = raw.slice(fix.prefix.length, raw.length - fix.suffix.length).trim();
    if (!isToken(inner)) continue;
    clearLocation(carrier, p);
    return inner;
  }
  return undefined;
}

/** Writes every placement with its template filled from the credential. Throws MissingSecretError. */
export function inject(carrier: Carrier, placements: Placement[], secrets: Record<string, string>): void {
  for (const p of placements) writeLocation(carrier, p, renderTemplate(p.value, secrets));
}

export function serializeBody(body: ParsedBody): { text: string; contentType: string } {
  return body.kind === "json"
    ? { text: JSON.stringify(body.value), contentType: "application/json" }
    : { text: body.value.toString(), contentType: "application/x-www-form-urlencoded" };
}
