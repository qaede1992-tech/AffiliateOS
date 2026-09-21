import { z } from "zod";

const booleanEnvironment = z.preprocess((value) => {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean());

const environmentSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(?:ql)?:\/\//.test(value), { message: "DATABASE_URL must use the postgres:// or postgresql:// protocol." }),
  API_AUTH_TOKEN: z.string().trim().min(32).optional(),
  API_AUTH_OPERATOR_ID: z.string().trim().min(1).default("development-operator"),
  API_AUTH_OPERATOR_ROLE: z.enum(["admin", "operator", "viewer"]).default("admin"),
  AUTONOMOUS_CYCLE_ENABLED: booleanEnvironment,
  AUTONOMOUS_CYCLE_INTERVAL_MS: z.coerce.number().int().min(300_000).default(900_000),
  AUTONOMOUS_PUBLICATION_DELAY_MS: z.coerce.number().int().min(60_000).default(300_000)
});

export const environment = environmentSchema.parse(process.env);
