import { TOKEN_PREFIX, type SlotType } from "./store.ts";

export const TOKEN_HEADER = "x-keygate-token";
export const TOKEN_QUERY = "keygate_token";

export interface Slot {
  type: SlotType;
  name: string;
  prefix: string;
}

export type ParsedBody =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "form"; value: URLSearchParams };

/** The outgoing request while the consumer token is swapped for the provider key. */
export interface Carrier {
  url: URL;
  headers: Headers;
  body?: ParsedBody;
}

export function isToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

function stripPrefix(value: string, prefix: string): string {
  if (!prefix) return value.trim();
  return value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trim() : value.trim();
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

/**
 * Finds the consumer token, removes it from the request, and returns it.
 * Looked up in order: the keygate header, a bearer Authorization header, the keygate query
 * parameter, then the slot the upstream itself uses for its key.
 */
export function extractToken(carrier: Carrier, slot: Slot): string | undefined {
  const dedicated = carrier.headers.get(TOKEN_HEADER);
  if (dedicated) {
    carrier.headers.delete(TOKEN_HEADER);
    return dedicated.trim();
  }
  const auth = carrier.headers.get("authorization");
  if (auth) {
    const bearer = stripPrefix(auth, "Bearer ");
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
  switch (slot.type) {
    case "header": {
      const value = carrier.headers.get(slot.name);
      if (!value) return undefined;
      const candidate = stripPrefix(value, slot.prefix);
      if (!isToken(candidate)) return undefined;
      carrier.headers.delete(slot.name);
      return candidate;
    }
    case "query": {
      const value = carrier.url.searchParams.get(slot.name);
      if (!value || !isToken(value)) return undefined;
      carrier.url.searchParams.delete(slot.name);
      return value;
    }
    case "cookie": {
      const cookies = parseCookies(carrier.headers.get("cookie"));
      const value = cookies.get(slot.name);
      if (!value || !isToken(value)) return undefined;
      cookies.delete(slot.name);
      if (cookies.size) carrier.headers.set("cookie", serializeCookies(cookies));
      else carrier.headers.delete("cookie");
      return value;
    }
    case "json": {
      if (carrier.body?.kind !== "json") return undefined;
      const value = carrier.body.value[slot.name];
      if (typeof value !== "string" || !isToken(value)) return undefined;
      delete carrier.body.value[slot.name];
      return value;
    }
    case "form": {
      if (carrier.body?.kind !== "form") return undefined;
      const value = carrier.body.value.get(slot.name);
      if (!value || !isToken(value)) return undefined;
      carrier.body.value.delete(slot.name);
      return value;
    }
  }
}

/** Puts the provider key where the upstream expects it. */
export function inject(carrier: Carrier, slot: Slot, secret: string): void {
  switch (slot.type) {
    case "header":
      carrier.headers.set(slot.name, `${slot.prefix}${secret}`);
      return;
    case "query":
      carrier.url.searchParams.set(slot.name, secret);
      return;
    case "cookie": {
      const cookies = parseCookies(carrier.headers.get("cookie"));
      cookies.set(slot.name, secret);
      carrier.headers.set("cookie", serializeCookies(cookies));
      return;
    }
    case "json":
      if (carrier.body?.kind === "json") carrier.body.value[slot.name] = secret;
      return;
    case "form":
      if (carrier.body?.kind === "form") carrier.body.value.set(slot.name, secret);
      return;
  }
}

export function serializeBody(body: ParsedBody): { text: string; contentType: string } {
  return body.kind === "json"
    ? { text: JSON.stringify(body.value), contentType: "application/json" }
    : { text: body.value.toString(), contentType: "application/x-www-form-urlencoded" };
}
