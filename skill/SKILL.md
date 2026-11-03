---
name: keygate
description: "Manage keygate at {{host}}, the proxy that holds third-party API keys: list and create upstreams and their placements, add, edit, rotate, enable or revoke provider credentials, create and scope consumer tokens, write and attach request policies, and read the request log. Use when a task needs a new proxied API, a key rotation, a token for a client or machine, a rule that blocks or rewrites a token's requests, or an answer to why a proxied call failed. Triggers on keygate, api key proxy, rotate the key, add an upstream, proxied token, consumer token, credential pool, kg_ token, keygate policy, policy_denied, why is exa failing through keygate."
requires-command: bun
---

# keygate

keygate sits between clients and third-party APIs. A client calls
`https://{{host}}/<slug>/...` with a consumer token (`kg_...`); keygate swaps
it for the real provider credential and forwards the request. Each upstream
lists placements, the places a credential value goes (`header:Authorization=
Bearer {{token}}`, `query:key={{key}}`), and holds credentials, each a named
set of those values. One credential is active, or in round-robin mode every
enabled complete credential takes turns.

## Run it

    bun ~/.claude/skills/keygate/keygate.ts help

The CLI needs `KEYGATE_URL` and `KEYGATE_API_KEY` in the environment or in
`~/.config/agents/keygate.env`. The API key is a dashboard-issued `kga_...`
key; it can do everything below except manage users and other API keys.
Never print, echo or copy the API key, a consumer token, or a credential
value. Pass credential values with `--value name=@file` or `name=-` from
stdin rather than inline when the value is secret.

Install or update on a machine without this skill:

    mkdir -p ~/.claude/skills/keygate
    curl -fsSL https://{{host}}/docs/skill.md -o ~/.claude/skills/keygate/SKILL.md
    curl -fsSL https://{{host}}/docs/keygate.ts -o ~/.claude/skills/keygate/keygate.ts

## Commands

Read first: `overview` shows requests, errors, rejections, latency and the
credential in use per upstream for the last 24 hours. `requests --upstream
exa --status proxy_error` explains a failing client: `missing_token`,
`invalid_token`, `upstream_not_in_scope`, `origin_not_allowed`,
`no_active_key`, `credential_incomplete`, and `policy_denied`,
`policy_response` or `policy_error` with the policy's name in the POLICY
column. `upstream <slug>` prints the placements, the value names a
credential must hold, and every credential with its state.

Upstreams: `upstreams`, `upstream <slug>`, `upstream create <slug> --base-url
URL --placement P [--placement P] [--strategy active|round_robin]`,
`upstream update <slug> ...`, `upstream delete <slug>`. A placement is
`type:name=template` with type `header`, `query`, `cookie`, `json` (a field in
a JSON object body) or `form` (a urlencoded field); `{{name}}` in the template
is filled from the credential, text outside it is sent as-is. Adding a
placement with a new name flags existing credentials as missing that value;
it never blocks them. `--docs T` or `--docs @file.md` sets public markdown
served at `https://{{host}}/<slug>/llms.txt` with no token, below the base
URL and token lines keygate generates; keep secrets out of it. `--notes` stays
private to the dashboard and API. `https://{{host}}/llms.txt` sent with a
consumer token lists the upstreams that token reaches; point a client agent
there with its token.

Credentials: `credentials <slug>`, `credential add <slug> --label L --value
name=VALUE [--value ...] [--standby]`, `credential edit <id> [--label L]
[--value name=VALUE] [--clear name]`, `credential activate <id>`,
`credential enable|disable <id>`, `credential revoke <id>`. Rotation in active
mode: `credential add` with the new values (it becomes active), confirm with
`overview` or a test call, then `credential revoke` the old id. Disable is
reversible; revoke is not. A credential missing any value is flagged and not
used.

Tokens: `tokens`, `token create --name N --scope slug [--scope slug]
[--origin https://app.example] [--expires 2027-01-01T00:00:00Z]`, `token
update <id> ...`, `token enable|disable <id>`, `token rotate <id>`, `token
revoke <id>`. The plaintext appears once in the create or rotate output; hand
it to the client and do not keep it elsewhere. Rotate keeps the id, scopes,
origins and expiry and refuses the old value from then on. `--scope '*'` covers every upstream. Origins matter only
for browser callers; a token without origins refuses requests that carry an
Origin header.

`--json` on any command prints the API response for jq.

## Policies

A policy is a TypeScript module stored on the instance and attached to
tokens. It runs on the requests of those tokens after the token checks and
before keygate adds the credential, with no access to the credential, the
`kg_` token, the network, files or the environment.

Commands: `policies`, `policy <name>` (state, needs, attached tokens and the
source), `policy create --file F`, `policy update <name> --file F`, `policy
enable|disable <name>`, `policy delete <name>` (refused while any token has it
attached; the output lists those tokens). `token policies <id>` prints the
token's list; `token policies <id> --policy a --policy b:off` replaces it, in
that order, with `b` attached but switched off; `--clear` detaches all.
`token create` and `token update` take the same `--policy name[:off]` flags
and set the list in the same write as the token. A compile error refuses a
policy save with the message. A save applies to the next request of every
attached token. `requests --policy <name>` lists the requests a policy denied,
answered or failed.

    export const meta = { name: "no-big-models", needs: ["body"] };

    export function onRequest(req, ctx) {
      if (ctx.bodySkipped) return deny(400, "The request body could not be checked");
      if (match(req.body?.model, ["gpt-5*", "o3-pro"])) return deny(403, "Model not allowed");
      req.headers["x-client"] = ctx.token.name;
    }

The module exports `meta = { name, needs? }` and `onRequest(req, ctx)`,
`onResponse(res, ctx)` or both. `name` is lowercase letters, digits and
dashes, unique, and is the policy's name everywhere; editing it renames the
policy. `needs` may list `"body"` and `"responseBody"`. Hooks are
synchronous; returning a Promise is an error.

`req` is `{ method, path, query, headers, body }` and `res` is `{ status,
headers, body }`, with lower-case header names. Edit them in place: headers,
query keys, `body`, `req.path` (stays under the upstream's base URL) and
`res.status`. Policies cannot set `content-length`, `host`, hop-by-hop or
forwarding headers, or a response's `set-cookie`; `onResponse` does not see
`set-cookie`. Return nothing to continue, `deny(status?, message?)` (400-499,
default 403) to refuse, or `respond(status, headers?, body?)` to answer
instead of the provider; either stops the chain. `ctx` is `{ token: { id,
name, scopes }, upstream: { slug, name, base_url }, origin, ip, method,
bodySkipped }`.

Globals: `deny`, `respond`, `match(value, pattern)` and `replaceDeep(value,
pattern, replacement)`. A string pattern is an exact match, or a whole-string
glob when it holds `*` or `?`; strings are never read as regexes, so pass a
RegExp object for one. An array pattern matches when any element does.
`replaceDeep` returns a copy with every match in every string leaf replaced; a
string pattern and its replacement are literal.

`onRequest` runs in attachment order and `onResponse` in reverse, on every
provider response including errors. `req.body` is the parsed JSON or form
fields only when `needs` has `body`, the type is JSON or urlencoded form and
the body is at most 1 MB; otherwise it is `undefined` and `ctx.bodySkipped` is
`not_requested`, `unparsed` or `too_large`, and the body is forwarded as sent.
A JSON body that fails to parse is refused with `400 invalid_body` when a
policy needs the body. `res.body` needs `responseBody` and a JSON response of
at most 1 MB as read; larger bodies, other types and SSE stream through
untouched. A `responseBody` policy holds a JSON response until it is complete
(up to 1 MB) before the client gets it. `req.query` and form bodies
hold the first value of a repeated key; when an `onRequest` hook runs, the
provider gets only that first pair.

`req.path` is the undecoded wire path after the slug. A path allowlist must
decode it or reject `%2f`, or `/v1/chat/..%2f..%2fadmin` passes a
`/v1/chat/*` check.

Module scope is not state: module-level variables may persist between calls
and tokens, and may reset at any time.

Each hook call has 50 ms and each policy 16 MB of memory. Any failure (throw,
timeout, memory, an invalid return or edit) fails closed with `500
{"error":"policy_error","policy":"<name>","message":"..."}`. A deny answers
`{"error":"policy_denied","policy":"<name>","message":"..."}` with its status.

## Client side

A client needs the base URL and a consumer token. It may send the token in
`X-Keygate-Token`, in `Authorization: Bearer kg_...`, in `?keygate_token=`,
or in the slot the upstream's own key would occupy, which is what lets SDKs
work by changing only their base URL and API key:

    EXA_BASE=https://{{host}}/exa  EXA_API_KEY=kg_...
    OPENAI_BASE_URL=https://{{host}}/openai/v1  OPENAI_API_KEY=kg_...

Subdomain form: `https://<slug>.{{host}}/...`, when a wildcard record points
at keygate.
