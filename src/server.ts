import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { adminRoutes } from "./admin.ts";
import { bootstrapAdmin } from "./auth.ts";
import { loadEnv } from "./env.ts";
import { createProxy, isUpstreamHost, serveDirectory } from "./proxy.ts";
import { Store } from "./store.ts";

const env = loadEnv();
mkdirSync(env.KEYGATE_DATA_DIR, { recursive: true });
const store = new Store(join(env.KEYGATE_DATA_DIR, "keygate.db"));
await bootstrapAdmin(store, env);

const proxy = createProxy({ store, env });
const app = new Hono();

app.use("*", async (c, next) => {
  if (isUpstreamHost(c.req.header("host") ?? null, env.KEYGATE_HOST)) return proxy(c.req.raw);
  await next();
});

app.get("/", (c) => c.redirect("/admin"));
app.get("/health", (c) => c.json({ ok: true }));
app.get("/llms.txt", (c) => serveDirectory(store, env, c.req.raw));

const skillDir = "./skill";
const skillTemplate = await Bun.file(join(skillDir, "SKILL.md")).text();
const cliSource = await Bun.file(join(skillDir, "keygate.ts")).text();
const publicHost = (c: { req: { header: (name: string) => string | undefined } }): string => env.KEYGATE_HOST ?? c.req.header("host") ?? "localhost";
app.get("/docs/skill.md", (c) => c.text(skillTemplate.replaceAll("{{host}}", publicHost(c)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/docs/keygate.ts", (c) => c.text(cliSource, 200, { "content-type": "text/typescript; charset=utf-8" }));
app.route("/api", adminRoutes(store, env));

const webRoot = "./dist/web";
const index = Bun.file(join(webRoot, "index.html"));
const hasWeb = await index.exists();
if (hasWeb) {
  const indexHtml = await index.text();
  app.use("/admin/*", serveStatic({ root: webRoot, rewriteRequestPath: (path) => path.replace(/^\/admin/, "") || "/" }));
  app.get("/admin", (c) => c.html(indexHtml));
  app.get("/admin/*", (c) => c.html(indexHtml));
} else {
  console.warn("keygate: dist/web is missing; run `bun run build` to serve the dashboard");
}

app.all("*", (c) => proxy(c.req.raw));

function prune(): void {
  const removed = store.pruneRequests(env.KEYGATE_LOG_RETENTION_DAYS);
  store.pruneSessions();
  if (removed) console.log(`keygate: pruned ${removed} request log rows`);
}
prune();
setInterval(prune, 3_600_000);

const server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 255 });
console.log(`keygate: listening on ${server.url}${env.KEYGATE_HOST ? ` for ${env.KEYGATE_HOST}` : ""}`);
