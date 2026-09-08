import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  KEYGATE_DATA_DIR: z.string().default("./data"),
  /** Public hostname. Requests to <slug>.<host> route to that upstream. */
  KEYGATE_HOST: z.string().optional(),
  KEYGATE_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  KEYGATE_SESSION_DAYS: z.coerce.number().int().positive().default(14),
  KEYGATE_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  KEYGATE_ADMIN_EMAIL: z.email().optional(),
  KEYGATE_ADMIN_PASSWORD: z.string().min(8).optional(),
  KEYGATE_ADMIN_NAME: z.string().default("Admin"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return result.data;
}
