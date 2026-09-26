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

const opportunitySelectionPolicySchema = z.object({
  minimumScore: z.number().min(0).max(100).optional(),
  maximumResults: z.number().int().min(1).max(1000).optional(),
  targetPriceMaxCents: z.number().int().positive().optional(),
  minimumCommissionRateBps: z.number().int().min(0).max(1_000_000).optional(),
  minimumCommissionAmountCents: z.number().int().min(0).optional(),
  minimumDemandScore: z.number().min(0).max(100).optional()
}).strict();

const marketplacePoliciesEnvironment = z.preprocess((value) => {
  if (value === undefined || value === "") return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}, z.record(z.string().trim().min(1), opportunitySelectionPolicySchema));

const environmentSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(?:ql)?:\/\//.test(value), { message: "DATABASE_URL must use the postgres:// or postgresql:// protocol." }),
  API_AUTH_TOKEN: z.string().trim().min(32).optional(),
  API_AUTH_OPERATOR_ID: z.string().trim().min(1).default("development-operator"),
  API_AUTH_OPERATOR_ROLE: z.enum(["admin", "operator", "viewer"]).default("admin"),
  AUTONOMOUS_CYCLE_ENABLED: booleanEnvironment,
  AUTONOMOUS_CYCLE_INTERVAL_MS: z.coerce.number().int().min(300_000).default(900_000),
  AUTONOMOUS_MINIMUM_SCORE: z.coerce.number().min(0).max(100).default(60),
  AUTONOMOUS_MAXIMUM_RESULTS: z.coerce.number().int().min(1).max(1000).default(10),
  AUTONOMOUS_MINIMUM_COMMISSION_BPS: z.coerce.number().int().min(0).max(1_000_000).default(0),
  AUTONOMOUS_MINIMUM_COMMISSION_AMOUNT_CENTS: z.coerce.number().int().min(0).default(0),
  AUTONOMOUS_MINIMUM_DEMAND_SCORE: z.coerce.number().min(0).max(100).default(0),
  AUTONOMOUS_OPTIMIZATION_MIN_COMMISSION_PER_CLICK_CENTS: z.coerce.number().min(0).default(0),
  AUTONOMOUS_MARKETPLACE_POLICIES_JSON: marketplacePoliciesEnvironment.default({}),
  PROVIDER_EVENT_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE: z.string().trim().optional(),
  SHOPEE_AFFILIATE_APP_ID: z.string().trim().optional(),
  SHOPEE_AFFILIATE_APP_SECRET: z.string().optional(),
  SHOPEE_AFFILIATE_MARKET: z.string().trim().regex(/^[A-Za-z]{2}$/).default("ID"),
  SHOPEE_AFFILIATE_API_VERSION: z.string().trim().regex(/^v\\d+$/).default("v2")
});

export const environment = environmentSchema.parse(process.env);
