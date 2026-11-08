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
  AUTONOMOUS_PUBLICATION_ENABLED: booleanEnvironment,
  AUTONOMOUS_CYCLE_INTERVAL_MS: z.coerce.number().int().min(300_000).default(900_000),
  AUTONOMOUS_MINIMUM_SCORE: z.coerce.number().min(0).max(100).default(60),
  AUTONOMOUS_MAXIMUM_RESULTS: z.coerce.number().int().min(1).max(1000).default(10),
  AUTONOMOUS_MINIMUM_COMMISSION_BPS: z.coerce.number().int().min(0).max(1_000_000).default(0),
  AUTONOMOUS_MINIMUM_COMMISSION_AMOUNT_CENTS: z.coerce.number().int().min(0).default(0),
  AUTONOMOUS_MINIMUM_DEMAND_SCORE: z.coerce.number().min(0).max(100).default(0),
  AUTONOMOUS_OPTIMIZATION_MIN_COMMISSION_PER_CLICK_CENTS: z.coerce.number().min(0).default(0),
  AUTONOMOUS_MARKETPLACE_POLICIES_JSON: marketplacePoliciesEnvironment.default({}),
  PROVIDER_EVENT_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  SHOPEE_INTAKE_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  SHOPEE_INTAKE_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  SHOPEE_INTAKE_RECOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  SHOPEE_INTAKE_RECOVERY_RESOLVER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  SHOPEE_CONVERSION_SYNC_ENABLED: booleanEnvironment,
  SHOPEE_CONVERSION_SYNC_INTERVAL_MS: z.coerce.number().int().min(300_000).default(900_000),
  SHOPEE_CONVERSION_SYNC_LOOKBACK_HOURS: z.coerce.number().positive().max(31 * 24).default(8 * 24),
  SHOPEE_AFFILIATE_CREDENTIAL_REFERENCE: z.string().trim().optional(),
  SHOPEE_AFFILIATE_MARKET: z.string().trim().regex(/^[A-Za-z]{2}$/).default("ID"),
  SHOPEE_AFFILIATE_API_VERSION: z.string().trim().regex(/^v\d+$/).default("v2"),
  TIKTOK_CLIENT_KEY: z.string().trim().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  INSTAGRAM_CLIENT_ID: z.string().trim().optional(),
  INSTAGRAM_CLIENT_SECRET: z.string().optional(),
  OPENVERSE_CLIENT_ID: z.string().trim().min(1).optional(),
  OPENVERSE_CLIENT_SECRET: z.string().min(1).optional(),
  OPENAI_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
  AI_PRODUCT_IMAGE_GENERATION_ENABLED: booleanEnvironment,
  AI_PRODUCT_IMAGE_MODEL: z.string().trim().min(1).max(100).default("gpt-image-2.5-sunburst"),
  SOCIAL_CREDENTIALS_JSON: z.string().optional(),
  SOCIAL_CREDENTIAL_STORE_PATH: z.string().trim().default("/var/lib/affiliateos/secrets/social-credentials.enc"),
  SOCIAL_CREDENTIAL_STORE_KEY: z.string().trim().min(32).optional(),
  SUPABASE_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  SUPABASE_STORAGE_SERVICE_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  SUPABASE_MEDIA_BUCKET: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).default("affiliate-media"))
}).superRefine((value, context) => {
  if (value.AI_PRODUCT_IMAGE_GENERATION_ENABLED && !value.OPENAI_API_KEY) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["OPENAI_API_KEY"], message: "OPENAI_API_KEY is required when AI product image generation is enabled." });
  }
  if (Boolean(value.OPENVERSE_CLIENT_ID) !== Boolean(value.OPENVERSE_CLIENT_SECRET)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENVERSE_CLIENT_SECRET"],
      message: "OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET must be configured together."
    });
  }
  const storageConfigured = Boolean(value.SUPABASE_URL || value.SUPABASE_STORAGE_SERVICE_KEY);
  if (value.AI_PRODUCT_IMAGE_GENERATION_ENABLED && (!value.SUPABASE_URL || !value.SUPABASE_STORAGE_SERVICE_KEY)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["SUPABASE_STORAGE_SERVICE_KEY"], message: "Supabase private Storage must be configured when AI product image generation is enabled." });
  }
  if (storageConfigured && (!value.SUPABASE_URL || !value.SUPABASE_STORAGE_SERVICE_KEY)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SUPABASE_STORAGE_SERVICE_KEY"],
      message: "SUPABASE_URL and SUPABASE_STORAGE_SERVICE_KEY must be configured together."
    });
  }
});

export const environment = environmentSchema.parse(process.env);
