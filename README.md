# keygate

Reverse proxy that injects API keys. Clients send a keygate token; keygate
swaps it for the real provider credential and forwards the request.

## Run

```sh
cp .env.example .env   # KEYGATE_HOST plus the first admin user
docker compose up -d
```

Dashboard at `https://<KEYGATE_HOST>/admin`. State is one SQLite file in
`./data`; credentials are stored in plain text, so guard the volume like the
keys themselves. Subdomain routing (`exa.<host>`) needs `*.<host>` pointed at
the same service; path routing (`<host>/exa/...`) works with the bare host.

| Variable | Default | Notes |
|---|---|---|
| `KEYGATE_HOST` | | Public hostname; enables `<slug>.<host>` routing |
| `KEYGATE_ADMIN_EMAIL`, `KEYGATE_ADMIN_PASSWORD`, `KEYGATE_ADMIN_NAME` | | First user, created when no users exist |
| `PORT` | `3000` | |
| `KEYGATE_DATA_DIR` | `/data` | |
| `KEYGATE_LOG_RETENTION_DAYS` | `30` | `0` keeps every request log row |
| `KEYGATE_SESSION_DAYS` | `14` | |
| `KEYGATE_UPSTREAM_TIMEOUT_MS` | `300000` | Includes streamed bodies |
| `KEYGATE_TRUSTED_PROXY_HOPS` | `0` | Proxies that append to `X-Forwarded-For`; sets the client IP for policies and login throttling. `0` uses the socket address |

## Use

```sh
curl -H "X-Keygate-Token: kg_..." https://keygate.example.com/exa/search -d '{"query":"..."}'

OPENAI_BASE_URL=https://openai.keygate.example.com/v1 OPENAI_API_KEY=kg_... python app.py
```

The token goes in `X-Keygate-Token`, `Authorization: Bearer`,
`?keygate_token=`, or wherever the upstream expects its own key. Browser
callers need an `Origin` on the token's origin list.

`GET /<slug>/llms.txt` needs no token and describes the upstream: base URL,
token slots and its docs field. `GET /llms.txt` with a token lists the
upstreams it reaches.

## Model

- Upstream: a slug, a base URL, and one or more placements.
- Placement: where a value goes (`header`, `query`, `cookie`, `json` field,
  `form` field) and a template like `Bearer {{token}}`. Text outside `{{ }}`
  is sent as-is.
- Credential: the named values the templates need. One with values
  missing is flagged and not used. Disable is reversible; revoke is not.
- Strategy: `active` uses the one active credential; `round_robin` takes
  turns across enabled credentials and benches one the provider rejected with
  401 or 403 for five minutes.
- Token: `kg_...`, scoped to upstreams, with optional browser origins and
  expiry. Shown once; rotate replaces the value and keeps the scopes.

Responses stream through unchanged unless a policy edits them. Header, query
and cookie placements forward the body byte for byte; `json` and `form`
placements re-serialize it.

## Policies

A policy is a TypeScript module attached to tokens. It runs in a QuickJS
sandbox after the token checks and before the credential is added, and can
change the request and response or answer itself. It cannot reach
credentials, the network, files or the environment.

```ts
export const meta = { name: "no-big-models", needs: ["body"] };

export function onRequest(req, ctx) {
  if (ctx.bodySkipped) return deny(400, "The request body could not be checked");
  if (match(req.body?.model, ["gpt-5*", "o3-pro"])) return deny(403, "Model not allowed");
  req.headers["x-client"] = ctx.token.name;
}

export function onResponse(res) {
  delete res.headers["x-request-id"];
}
```

- Return nothing to continue, `deny(status?, message?)` for
  `{"error":"policy_denied",...}`, or `respond(status, headers?, body?)`.
- `onRequest` runs in the token's attachment order, `onResponse` in reverse;
  the first deny or respond stops the chain.
- Bodies reach policies when listed in `meta.needs`, JSON or form, and at most
  1 MB; otherwise `ctx.bodySkipped` says why.
- Each hook step gets 50 ms plus 100 ms per MB of input, a request's hooks
  share 500 ms, and each policy gets 16 MB. Errors and timeouts fail closed
  with `500 policy_error`.

The full hook API is in the skill at `/docs/skill.md`.

## Admin API

Everything in the dashboard is `/api`, authenticated by the session cookie or by
a dashboard-issued `kga_...` key sent as `Authorization: Bearer`. API keys act
as their creator and cannot manage users or other API keys. Secrets are
write-only; responses carry hints.

A CLI and an agent skill are served by the instance:

```sh
mkdir -p ~/.claude/skills/keygate
curl -fsSL https://<host>/docs/skill.md -o ~/.claude/skills/keygate/SKILL.md
curl -fsSL https://<host>/docs/keygate.ts -o ~/.claude/skills/keygate/keygate.ts
bun ~/.claude/skills/keygate/keygate.ts help   # reads KEYGATE_URL and KEYGATE_API_KEY
```

## Limits

- Browser SDKs that load from the provider's own domain (Google Maps JS) cannot
  be proxied; server-side endpoints can.
- Absolute URLs in responses (pagination links) point at the provider, not at
  keygate.
- Multipart bodies are forwarded untouched, so no field inside them can carry a
  key.

## Development

```sh
bun install
bun run dev        # API on :3000
bun run dev:web    # dashboard with /api proxied
bun run typecheck && bun run lint && bun test && bun run build
```

## License

MIT
