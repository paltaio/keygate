---
name: keygate
description: "Manage keygate at {{host}}, the proxy that holds third-party API keys: list and create upstreams and their placements, add, edit, rotate, enable or revoke provider credentials, create and scope consumer tokens, and read the request log. Use when a task needs a new proxied API, a key rotation, a token for a client or machine, or an answer to why a proxied call failed. Triggers on keygate, api key proxy, rotate the key, add an upstream, proxied token, consumer token, credential pool, kg_ token, why is exa failing through keygate."
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
`no_active_key`, `credential_incomplete`. `upstream <slug>` prints the
placements, the value names a credential must hold, and every credential
with its state.

Upstreams: `upstreams`, `upstream <slug>`, `upstream create <slug> --base-url
URL --placement P [--placement P] [--strategy active|round_robin]`,
`upstream update <slug> ...`, `upstream delete <slug>`. A placement is
`type:name=template` with type `header`, `query`, `cookie`, `json` (a field in
a JSON object body) or `form` (a urlencoded field); `{{name}}` in the template
is filled from the credential, text outside it is sent as-is. Adding a
placement with a new name flags existing credentials as missing that value;
it never blocks them.

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
update <id> ...`, `token enable|disable <id>`, `token revoke <id>`. The
plaintext appears once in the create output; hand it to the client and do not
keep it elsewhere. `--scope '*'` covers every upstream. Origins matter only
for browser callers; a token without origins refuses requests that carry an
Origin header.

`--json` on any command prints the API response for jq.

## Client side

A client needs the base URL and a consumer token. It may send the token in
`X-Keygate-Token`, in `Authorization: Bearer kg_...`, in `?keygate_token=`,
or in the slot the upstream's own key would occupy, which is what lets SDKs
work by changing only their base URL and API key:

    EXA_BASE=https://{{host}}/exa  EXA_API_KEY=kg_...
    OPENAI_BASE_URL=https://{{host}}/openai/v1  OPENAI_API_KEY=kg_...

Subdomain form: `https://<slug>.{{host}}/...`, when a wildcard record points
at keygate.
