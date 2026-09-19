import { z } from "zod";

const environmentSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(?:ql)?:\/\//.test(value), { message: "DATABASE_URL must use the postgres:// or postgresql:// protocol." }),
  API_AUTH_TOKEN: z.string().trim().min(32).optional(),
  API_AUTH_OPERATOR_ID: z.string().trim().min(1).default("development-operator"),
  API_AUTH_OPERATOR_ROLE: z.enum(["admin", "operator", "viewer"]).default("admin")
});

export const environment = environmentSchema.parse(process.env);
