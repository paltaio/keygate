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

## Use

```sh
curl -H "X-Keygate-Token: kg_..." https://keygate.example.com/exa/search -d '{"query":"..."}'

OPENAI_BASE_URL=https://openai.keygate.example.com/v1 OPENAI_API_KEY=kg_... python app.py
```

The token is accepted in `X-Keygate-Token`, in `Authorization: Bearer`, in
`?keygate_token=`, or wherever the upstream expects its own key. The last form
is what makes SDKs work with only a base URL change. Browser callers must send
an `Origin` that is on the token's origin list.

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
  expiry. Shown once.

Responses stream through unchanged. Header, query and cookie placements forward
the body byte for byte; `json` and `form` placements re-serialize it.

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
