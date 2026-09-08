# keygate

A reverse proxy that holds your third-party API keys. Clients call keygate with
a consumer token; keygate swaps it for the real provider key and forwards the
request. Rotate a provider key in the dashboard and no client changes. Revoke
one consumer token and only that client stops.

## How a request flows

```
client -- X-Keygate-Token: kg_... -->  keygate  -- x-api-key: <real key> -->  api.exa.ai
```

1. The upstream is picked from the host (`exa.keygate.example.com`) or the first
   path segment (`keygate.example.com/exa/...`).
2. The consumer token is read from `X-Keygate-Token`, from
   `Authorization: Bearer kg_...`, from `?keygate_token=`, or from the slot the
   upstream itself uses for its key. That last form is what lets SDKs work
   unchanged: point the SDK's base URL at keygate and hand it the consumer token
   as its "API key".
3. The token must be live, scoped to that upstream, and, for browser requests,
   list the page's origin.
4. The token is stripped, the active provider key is put in the upstream's slot,
   and the request is forwarded. Responses stream back as they arrive.

Slots: `header` (with an optional prefix such as `Bearer `), `query`, `cookie`,
`json` (a field in a JSON object body), `form` (a field in a urlencoded body).

## Run it

```sh
cp .env.example .env   # set KEYGATE_HOST and the first admin user
docker compose up -d
```

The dashboard is at `https://<KEYGATE_HOST>/admin`. Data lives in `./data`.
Provider keys are stored as plain text in the SQLite file, so treat the volume
like the keys themselves.

For subdomain routing, point `*.<KEYGATE_HOST>` at the same service as the bare
host. Path-prefix routing needs only the bare host.

| Variable | Default | Meaning |
|---|---|---|
| `KEYGATE_HOST` | unset | Public hostname. Enables `<slug>.<host>` routing. |
| `KEYGATE_ADMIN_EMAIL`, `KEYGATE_ADMIN_PASSWORD`, `KEYGATE_ADMIN_NAME` | unset | First user, created only when no users exist. |
| `PORT` | `3000` | Listen port. |
| `KEYGATE_DATA_DIR` | `/data` in the image | SQLite location. |
| `KEYGATE_LOG_RETENTION_DAYS` | `30` | Request log rows older than this are deleted hourly. `0` keeps everything. |
| `KEYGATE_SESSION_DAYS` | `14` | Dashboard session length. |
| `KEYGATE_UPSTREAM_TIMEOUT_MS` | `300000` | Upstream request timeout, including streamed bodies. |

## Using a token

```sh
# any client
curl -H "X-Keygate-Token: kg_..." https://keygate.example.com/exa/search -d '{"query":"..."}'

# an SDK that only knows base URL + API key
OPENAI_BASE_URL=https://openai.keygate.example.com/v1 OPENAI_API_KEY=kg_... python app.py
```

Browser use needs the page origin on the token's origin list. Preflight
requests are answered for any origin that some live token allows for that
upstream; the real request is checked against the token that carries it.

## Limits

- Browser-side SDKs that load from the provider's own domain, such as the
  Google Maps JavaScript API, cannot be proxied. Server-side endpoints can.
- Responses are passed through as-is. A provider that returns absolute URLs to
  itself (pagination links) hands the client links that bypass keygate.
- `json` and `form` slots re-serialize the body. Header, query and cookie slots
  forward the bytes untouched.
- Multipart bodies are forwarded untouched, so a key cannot be injected into a
  multipart field.

## Development

```sh
bun install
bun run dev        # backend on :3000 with reload
bun run dev:web    # dashboard on Vite's port, /api proxied to :3000
bun run build      # dashboard into dist/web, served by the backend at /admin
bun run typecheck && bun run lint && bun test
```

## Admin API

Everything the dashboard does goes through `/api` with a session cookie from
`POST /api/auth/login`. Provider secrets are write-only: responses carry a
short hint, never the value. Consumer tokens are returned once, in the create
response.
