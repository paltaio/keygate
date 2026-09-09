#!/usr/bin/env bun
// CLI over the keygate admin API. Run `bun keygate.ts help` for usage.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ENV_FILE = join(homedir(), ".config/agents/keygate.env");
const MULTI_FLAGS = new Set(["placement", "value", "clear", "scope", "origin"]);
const BOOLEAN_FLAGS = new Set(["json", "standby", "help"]);

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value: string | undefined;
    const eq = name.indexOf("=");
    if (eq > 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (!BOOLEAN_FLAGS.has(name) && argv[i + 1] !== undefined && !(argv[i + 1] ?? "").startsWith("--")) {
      value = argv[++i];
    }
    if (MULTI_FLAGS.has(name)) (multi[name] ??= []).push(value ?? "");
    else flags[name] = value ?? true;
  }
  return { positional, flags, multi };
}

const args = parseArgs(process.argv.slice(2));
const flag = (name: string): string | undefined => (typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined);
const has = (name: string): boolean => name in args.flags;
const multi = (name: string): string[] => args.multi[name] ?? [];

function fail(message: string): never {
  console.error(`keygate: ${message}`);
  process.exit(1);
}

function setting(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envFile = process.env.KEYGATE_ENV_FILE || DEFAULT_ENV_FILE;
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`));
      if (m) return (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

const baseUrl = (setting("KEYGATE_URL") ?? "").replace(/\/$/, "");
const apiKey = setting("KEYGATE_API_KEY");

async function api<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T> {
  if (!baseUrl || !apiKey) fail(`Set KEYGATE_URL and KEYGATE_API_KEY in the environment or ${DEFAULT_ENV_FILE}`);
  const url = new URL(`${baseUrl}/api${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${apiKey}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : null,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    fail(`${res.status} from ${url.pathname}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = data as { error?: string; message?: string };
    fail(`${res.status} ${err.error ?? ""} ${err.message ?? ""}`.replace(/\s+/g, " ").trim());
  }
  return data as T;
}

const out = (value: unknown): void => {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const emit = (data: unknown, text: () => string): void => {
  if (has("json")) out(data);
  else out(text());
};

function table(rows: string[][]): string {
  const widths = rows.reduce<number[]>((w, r) => r.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd()).join("\n");
}

const when = (iso: string | null | undefined): string => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

interface Placement {
  type: "header" | "query" | "cookie" | "json" | "form";
  name: string;
  value: string;
}

interface Credential {
  id: number;
  label: string;
  hints: Record<string, string>;
  missing: string[];
  active: number;
  enabled: number;
  failing_at: string | null;
  failing_status: number | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface Upstream {
  id: number;
  slug: string;
  name: string;
  base_url: string;
  placements: Placement[];
  strategy: "active" | "round_robin";
  notes: string;
  secret_names: string[];
  active_key: Credential | null;
  key_count: number;
  usable_key_count: number;
  keys?: Credential[];
}

interface Token {
  id: number;
  name: string;
  hint: string;
  scopes: string[];
  origins: string[];
  expires_at: string | null;
  revoked_at: string | null;
  enabled: number;
  last_used_at: string | null;
  created_at: string;
}

interface RequestRow {
  id: number;
  ts: string;
  token_id: number | null;
  upstream_id: number | null;
  method: string;
  path: string;
  status: number | null;
  latency_ms: number | null;
  bytes_out: number | null;
  error: string | null;
  origin: string | null;
}

interface Overview {
  since: string;
  upstreams: Array<Upstream & { requests: number; errors: number; rejected: number; avg_latency_ms: number | null }>;
  unmatched_requests: number;
  tokens: number;
}

function parsePlacement(spec: string): Placement {
  const m = /^(header|query|cookie|json|form):([^=]+)=(.*)$/s.exec(spec);
  if (!m) fail(`--placement wants type:name=value, e.g. "header:Authorization=Bearer {{token}}", got "${spec}"`);
  return { type: m[1] as Placement["type"], name: (m[2] ?? "").trim(), value: m[3] ?? "" };
}

async function parseValues(specs: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) fail(`--value wants name=value, name=@file or name=- for stdin, got "${spec}"`);
    const name = spec.slice(0, eq).trim();
    const raw = spec.slice(eq + 1);
    if (raw === "-") values[name] = (await Bun.stdin.text()).trim();
    else if (raw.startsWith("@")) values[name] = readFileSync(raw.slice(1), "utf8").trim();
    else values[name] = raw;
    if (!values[name]) fail(`--value ${name} is empty`);
  }
  return values;
}

async function upstreamBySlug(slug: string): Promise<Upstream> {
  const list = await api<Upstream[]>("/upstreams");
  const found = list.find((u) => u.slug === slug);
  if (!found) fail(`no upstream "${slug}"; run: bun keygate.ts upstreams`);
  return found;
}

function credentialStatus(c: Credential, strategy: Upstream["strategy"]): string {
  if (c.revoked_at) return "revoked";
  const parts: string[] = [];
  if (!c.enabled) parts.push("disabled");
  else if (strategy === "round_robin") parts.push(c.missing.length ? "not in pool" : "in pool");
  else parts.push(c.active ? "active" : "standby");
  if (c.missing.length) parts.push(`missing ${c.missing.join(",")}`);
  if (c.failing_at) parts.push(`rejected ${c.failing_status} ${when(c.failing_at)}`);
  return parts.join(", ");
}

function credentialRows(keys: Credential[], strategy: Upstream["strategy"]): string[][] {
  return [
    ["ID", "LABEL", "VALUES", "STATUS", "LAST USED"],
    ...keys.map((c) => [
      String(c.id),
      c.label,
      Object.entries(c.hints).map(([k, v]) => `${k}=${v}`).join(" ") || "-",
      credentialStatus(c, strategy),
      when(c.last_used_at),
    ]),
  ];
}

function upstreamText(u: Upstream): string {
  const lines = [
    `${u.slug}  ${u.name}  ${u.base_url}  ${u.strategy}`,
    ...u.placements.map((p) => `  ${p.type} ${p.name}: ${p.value}`),
    `  values: ${u.secret_names.join(", ") || "none"}   usable credentials: ${u.usable_key_count}/${u.key_count}`,
  ];
  if (u.notes) lines.push(`  notes: ${u.notes}`);
  if (u.keys) lines.push("", table(credentialRows(u.keys, u.strategy)));
  return lines.join("\n");
}

function upstreamInput(base: Partial<Upstream>, slugOverride?: string): Record<string, unknown> {
  const placements = multi("placement").length ? multi("placement").map(parsePlacement) : base.placements;
  if (!placements?.length) fail("at least one --placement is required");
  return {
    slug: flag("slug") ?? slugOverride ?? base.slug,
    name: flag("name") ?? base.name ?? slugOverride ?? base.slug,
    base_url: flag("base-url") ?? base.base_url ?? fail("--base-url is required"),
    placements,
    strategy: flag("strategy") ?? base.strategy ?? "active",
    notes: flag("notes") ?? base.notes ?? "",
  };
}

function tokenInput(base: Partial<Token>): Record<string, unknown> {
  const expires = flag("expires");
  return {
    name: flag("name") ?? base.name ?? fail("--name is required"),
    scopes: multi("scope").length ? multi("scope") : (base.scopes ?? fail("at least one --scope is required")),
    origins: multi("origin").length ? multi("origin").filter((o) => o !== "none") : (base.origins ?? []),
    expires_at: expires === "none" ? null : (expires ?? base.expires_at ?? null),
  };
}

function tokenRows(tokens: Token[]): string[][] {
  return [
    ["ID", "NAME", "HINT", "SCOPES", "ORIGINS", "STATUS", "LAST USED"],
    ...tokens.map((t) => [
      String(t.id),
      t.name,
      t.hint,
      t.scopes.join(","),
      t.origins.join(",") || "-",
      t.revoked_at ? "revoked" : !t.enabled ? "disabled" : t.expires_at ? `expires ${when(t.expires_at)}` : "live",
      when(t.last_used_at),
    ]),
  ];
}

const idArg = (value: string | undefined, what: string): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail(`${what} id must be a positive integer`);
  return id;
};

async function run(): Promise<void> {
  const [command, sub, target] = args.positional;
  switch (command) {
    case "overview": {
      const data = await api<Overview>("/overview");
      emit(data, () =>
        [
          `since ${when(data.since)}   live tokens ${data.tokens}   unmatched ${data.unmatched_requests}`,
          table([
            ["UPSTREAM", "REQUESTS", "ERRORS", "REJECTED", "AVG MS", "STRATEGY", "USABLE", "IN USE"],
            ...data.upstreams.map((u) => [
              u.slug,
              String(u.requests),
              String(u.errors),
              String(u.rejected),
              u.avg_latency_ms === null ? "-" : String(Math.round(u.avg_latency_ms)),
              u.strategy,
              `${u.usable_key_count}/${u.key_count}`,
              u.strategy === "round_robin" ? `pool of ${u.usable_key_count}` : u.active_key ? `${u.active_key.label}${u.active_key.failing_at ? ` (rejected ${u.active_key.failing_status})` : ""}` : "none",
            ]),
          ]),
        ].join("\n"),
      );
      return;
    }
    case "upstreams": {
      const list = await api<Upstream[]>("/upstreams");
      emit(list, () =>
        table([
          ["SLUG", "BASE URL", "STRATEGY", "PLACEMENTS", "VALUES", "USABLE"],
          ...list.map((u) => [u.slug, u.base_url, u.strategy, u.placements.map((p) => `${p.type}:${p.name}`).join(" "), u.secret_names.join(",") || "-", `${u.usable_key_count}/${u.key_count}`]),
        ]),
      );
      return;
    }
    case "upstream": {
      if (sub === "create") {
        if (!target) fail("upstream create needs a slug");
        const created = await api<Upstream>("/upstreams", { method: "POST", body: upstreamInput({}, target) });
        emit(created, () => upstreamText(created));
        return;
      }
      if (sub === "update") {
        const current = await upstreamBySlug(target ?? fail("upstream update needs a slug"));
        const updated = await api<Upstream>(`/upstreams/${current.id}`, { method: "PATCH", body: upstreamInput(current) });
        emit(updated, () => upstreamText(updated));
        return;
      }
      if (sub === "delete") {
        const current = await upstreamBySlug(target ?? fail("upstream delete needs a slug"));
        await api(`/upstreams/${current.id}`, { method: "DELETE" });
        emit({ ok: true }, () => `deleted ${current.slug}`);
        return;
      }
      const found = await upstreamBySlug(sub ?? fail("upstream needs a slug"));
      const detail = await api<Upstream>(`/upstreams/${found.id}`);
      emit(detail, () => upstreamText(detail));
      return;
    }
    case "credentials": {
      const up = await upstreamBySlug(sub ?? fail("credentials needs an upstream slug"));
      const keys = await api<Credential[]>(`/upstreams/${up.id}/keys`);
      emit(keys, () => table(credentialRows(keys, up.strategy)));
      return;
    }
    case "credential": {
      if (sub === "add") {
        const up = await upstreamBySlug(target ?? fail("credential add needs an upstream slug"));
        const secrets = await parseValues(multi("value"));
        const created = await api<Credential>(`/upstreams/${up.id}/keys`, {
          method: "POST",
          body: { label: flag("label") ?? fail("--label is required"), secrets, activate: !has("standby") },
        });
        emit(created, () => `added credential ${created.id} "${created.label}": ${credentialStatus(created, up.strategy)}`);
        return;
      }
      const id = idArg(target, "credential");
      if (sub === "edit") {
        const secrets: Record<string, string | null> = await parseValues(multi("value"));
        for (const name of multi("clear")) secrets[name] = null;
        const body: Record<string, unknown> = {};
        if (flag("label")) body.label = flag("label");
        if (Object.keys(secrets).length) body.secrets = secrets;
        if (!Object.keys(body).length) fail("nothing to change; pass --label, --value or --clear");
        const updated = await api<Credential>(`/keys/${id}`, { method: "PATCH", body });
        emit(updated, () => `credential ${updated.id} "${updated.label}": values ${Object.keys(updated.hints).join(",") || "none"}${updated.missing.length ? `, missing ${updated.missing.join(",")}` : ""}`);
        return;
      }
      if (sub === "activate") {
        await api(`/keys/${id}/activate`, { method: "POST" });
        emit({ ok: true }, () => `credential ${id} is now active`);
        return;
      }
      if (sub === "enable" || sub === "disable") {
        await api(`/keys/${id}`, { method: "PATCH", body: { enabled: sub === "enable" } });
        emit({ ok: true }, () => `credential ${id} ${sub}d`);
        return;
      }
      if (sub === "revoke") {
        await api(`/keys/${id}`, { method: "DELETE" });
        emit({ ok: true }, () => `credential ${id} revoked`);
        return;
      }
      return fail(`unknown credential command "${sub ?? ""}"`);
    }
    case "tokens": {
      const list = await api<Token[]>("/tokens");
      emit(list, () => table(tokenRows(list)));
      return;
    }
    case "token": {
      if (sub === "create") {
        const created = await api<Token & { token: string }>("/tokens", { method: "POST", body: tokenInput({}) });
        emit(created, () => `token ${created.id} "${created.name}" for ${created.scopes.join(",")}\n${created.token}\nShown once. Store it now.`);
        return;
      }
      const id = idArg(target, "token");
      if (sub === "update") {
        const current = (await api<Token[]>("/tokens")).find((t) => t.id === id) ?? fail(`no token ${id}`);
        const updated = await api<Token>(`/tokens/${id}`, { method: "PATCH", body: tokenInput(current) });
        emit(updated, () => table(tokenRows([updated])));
        return;
      }
      if (sub === "enable" || sub === "disable") {
        await api(`/tokens/${id}/enabled`, { method: "PATCH", body: { enabled: sub === "enable" } });
        emit({ ok: true }, () => `token ${id} ${sub}d`);
        return;
      }
      if (sub === "revoke") {
        await api(`/tokens/${id}`, { method: "DELETE" });
        emit({ ok: true }, () => `token ${id} revoked`);
        return;
      }
      return fail(`unknown token command "${sub ?? ""}"`);
    }
    case "requests": {
      const query: Record<string, string | undefined> = {
        status: flag("status"),
        limit: flag("limit"),
        before: flag("before"),
        token_id: flag("token"),
      };
      if (flag("upstream")) query.upstream_id = String((await upstreamBySlug(flag("upstream") ?? "")).id);
      const [rows, upstreams] = await Promise.all([api<RequestRow[]>("/requests", { query }), api<Upstream[]>("/upstreams")]);
      const slugOf = new Map(upstreams.map((u) => [u.id, u.slug]));
      emit(rows, () =>
        table([
          ["ID", "TIME", "UPSTREAM", "TOKEN", "METHOD", "PATH", "STATUS", "MS", "BYTES", "ERROR"],
          ...rows.map((r) => [
            String(r.id),
            when(r.ts),
            r.upstream_id === null ? "-" : (slugOf.get(r.upstream_id) ?? String(r.upstream_id)),
            r.token_id === null ? "-" : String(r.token_id),
            r.method,
            r.path.length > 40 ? `${r.path.slice(0, 37)}...` : r.path,
            r.status === null ? "-" : String(r.status),
            r.latency_ms === null ? "-" : String(r.latency_ms),
            r.bytes_out === null ? "-" : String(r.bytes_out),
            r.error ?? "",
          ]),
        ]),
      );
      return;
    }
    case "help":
    case undefined:
      help();
      return;
    default:
      fail(`unknown command "${command}". Run: bun keygate.ts help`);
  }
}

function help(): void {
  console.log(`Usage: bun keygate.ts <command> [flags]

Setup: KEYGATE_URL and KEYGATE_API_KEY in the environment or ${DEFAULT_ENV_FILE}.

overview                                      Traffic and credential state per upstream, last 24h
upstreams                                     List upstreams
upstream <slug>                               One upstream with its credentials
upstream create <slug> --base-url U --placement P... [--name N] [--strategy active|round_robin] [--notes T]
upstream update <slug> [--slug S] [--name N] [--base-url U] [--placement P...] [--strategy S] [--notes T]
upstream delete <slug>
credentials <slug>                            Credentials of an upstream
credential add <slug> --label L --value name=VALUE... [--standby]
credential edit <id> [--label L] [--value name=VALUE...] [--clear name...]
credential activate|enable|disable|revoke <id>
tokens                                        List consumer tokens
token create --name N --scope SLUG... [--origin O...] [--expires ISO]
token update <id> [--name N] [--scope SLUG...] [--origin O...|--origin none] [--expires ISO|none]
token enable|disable|revoke <id>
requests [--upstream SLUG] [--token ID] [--status ok|client_error|upstream_error|proxy_error] [--limit N] [--before ID]

--placement is type:name=template, where type is header, query, cookie, json or form and the
template holds {{name}} where a credential value goes: "header:Authorization=Bearer {{token}}",
"query:key={{key}}", "json:client_secret={{secret}}". Passing --placement on update replaces all.
--value is name=VALUE, name=@file to read a file, or name=- to read stdin.
--scope takes an upstream slug or * for all. --json prints the raw API response.
`);
}

await run();
