export interface PolicyTemplate {
  id: string;
  label: string;
  source: string;
}

export const BLANK_POLICY = `export const meta = { name: "my-policy" };

export function onRequest(req, ctx) {
}
`;

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "deny-models",
    label: "Deny models",
    source: `export const meta = { name: "deny-models", needs: ["body"] };

const blocked = ["gpt-4*", "o1-*"];

export function onRequest(req, ctx) {
  if (ctx.bodySkipped) return deny(400, "The request body could not be checked");
  if (match(req.body?.model, blocked)) {
    return deny(403, "Model " + req.body.model + " is not allowed");
  }
}
`,
  },
  {
    id: "redact-body",
    label: "Redact body strings",
    source: String.raw`export const meta = { name: "redact-body", needs: ["body"] };

export function onRequest(req) {
  if (req.body === undefined) return;
  req.body = replaceDeep(req.body, /[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
  req.body = replaceDeep(req.body, "Project Falcon", "[redacted]");
}
`,
  },
  {
    id: "add-header",
    label: "Add a header",
    source: `export const meta = { name: "add-header" };

export function onRequest(req, ctx) {
  req.headers["x-client"] = ctx.token.name;
}
`,
  },
  {
    id: "block-paths",
    label: "Block paths",
    source: `export const meta = { name: "block-paths" };

const blocked = ["/files", "/files/*", "/fine_tuning/*"];

export function onRequest(req) {
  const path = decodeURIComponent(req.path).replace(/\\/+/g, "/").toLowerCase();
  if (match(path, blocked)) return deny(403, "This path is blocked");
}
`,
  },
];
