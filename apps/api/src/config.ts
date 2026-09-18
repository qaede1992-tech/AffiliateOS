import { z } from "zod";

const environmentSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(?:ql)?:\/\//.test(value), { message: "DATABASE_URL must use the postgres:// or postgresql:// protocol." })
});

export const environment = environmentSchema.parse(process.env);
