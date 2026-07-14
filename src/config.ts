import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().default(3030),
  DATABASE_URL: z.string().min(1),
  HMDB_API_SECRET: z.string().min(32),
  APP_SESSION_SECRET: z.string().min(32),
  TPER_HEALTH_ACCESS_CODE: z.string().min(8).optional(),
  HMDB_DEFAULT_PERSON_SLUG: z.string().default("tareq"),
  HMDB_FILES_DIR: z.string().default("/data/health-memory/files"),
  HMDB_EXPORT_DIR: z.string().default("/data/health-memory/exports"),
  HMDB_LOG_LEVEL: z.string().default("info"),
  PUBLIC_BASE_URL: z.string().url().default("https://entix.health"),
  COOKIE_DOMAIN: z.string().default("entix.health"),
  HMDB_DB_RESOURCE_NAME: z.string().default("T-PER-HMDB-PG"),
  HMDB_API_RESOURCE_NAME: z.string().default("T-PER-HMDB-API"),
  HMDB_FILES_RESOURCE_NAME: z.string().default("T-PER-HMDB-FILES"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  ADMIN_GOOGLE_EMAILS: z.string().default("tareq@fc.sa"),
  N8N_GENERAL_CHAT_WEBHOOK: z.string().url().optional(),
  N8N_DOCUMENT_INGEST_WEBHOOK: z.string().url().optional(),
  N8N_HEALTH_COMMITTEE_WEBHOOK: z.string().url().optional(),
  N8N_HEALTH_COMMITTEE_SECRET: z.string().min(32).optional(),
  N8N_HEALTH_COMMITTEE_WORKFLOW_NAME: z.string().default("T-PER-WF-HEALTH-COMMITTEE-V02"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_PHI_ENABLED: z.string().default("false"),
  SERPER_API_KEY: z.string().optional(),
  // Google-only agent — served from the dedicated entix-health GCP project.
  // Uses Gemini exclusively with native Google Search grounding.
  GOOGLE_HEALTH_PROJECT: z.string().optional(),
  GOOGLE_AGENT_GEMINI_KEY: z.string().optional(),
  GOOGLE_AGENT_MODEL: z.string().default("gemini-3.5-flash"),
  // In-API doctor council (multi-model orchestrator). Model IDs are env-driven
  // so they can be swapped to newer releases without code changes.
  COUNCIL_ENABLED: z.string().default("true"),
  COUNCIL_WEB_RESEARCH: z.string().default("true"),
  COUNCIL_MODEL_CLINICIAN: z.string().default("claude-opus-4-8"),
  COUNCIL_MODEL_AUDITOR: z.string().default("gpt-5.5"),
  COUNCIL_MODEL_RESEARCHER: z.string().default("gemini-3.5-flash"),
  COUNCIL_TIMEOUT_MS: z.coerce.number().default(45000),
  // Vision model used to read lab-report images/PDFs into structured markers.
  EXTRACTION_MODEL: z.string().default("claude-opus-4-8"),
  // Optional local-login seed (OFF by default). No credentials live in source —
  // they are injected via env only when SEED_LOCAL_LOGIN === "true".
  SEED_LOCAL_LOGIN: z.string().default("false"),
  SEED_LOCAL_EMAIL: z.string().optional(),
  SEED_LOCAL_SALT: z.string().optional(),
  SEED_LOCAL_HASH: z.string().optional()
});

export const config = EnvSchema.parse(process.env);

export const adminEmails = new Set(
  config.ADMIN_GOOGLE_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

export function googleOAuthEnabled() {
  return Boolean(config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function googleRedirectUri() {
  return config.GOOGLE_OAUTH_REDIRECT_URI || `${config.PUBLIC_BASE_URL}/api/auth/google/callback`;
}

export function providerStatus() {
  return {
    rayan: config.ANTHROPIC_API_KEY ? "configured" : "provider_missing",
    theo: config.ANTHROPIC_API_KEY ? "configured" : "provider_missing",
    sam: config.OPENAI_API_KEY ? "configured" : "provider_missing",
    lena: config.GEMINI_API_KEY ? "configured" : "provider_missing",
    openrouter:
      config.OPENROUTER_API_KEY && config.OPENROUTER_PHI_ENABLED === "true"
        ? "fallback_enabled"
        : "disabled_for_phi"
  };
}
