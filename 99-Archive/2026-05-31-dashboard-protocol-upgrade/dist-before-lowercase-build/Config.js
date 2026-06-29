import { z } from "zod";
const EnvSchema = z.object({
    NODE_ENV: z.string().default("production"),
    PORT: z.coerce.number().default(3030),
    DATABASE_URL: z.string().min(1),
    HMDB_API_SECRET: z.string().min(32),
    APP_SESSION_SECRET: z.string().min(32),
    TPER_HEALTH_ACCESS_CODE: z.string().min(8),
    HMDB_DEFAULT_PERSON_SLUG: z.string().default("tareq"),
    HMDB_FILES_DIR: z.string().default("/data/health-memory/files"),
    HMDB_EXPORT_DIR: z.string().default("/data/health-memory/exports"),
    HMDB_LOG_LEVEL: z.string().default("info"),
    PUBLIC_BASE_URL: z.string().url().default("https://h.fc.sa"),
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
    ADMIN_GOOGLE_EMAILS: z.string().default("tareq@fc.sa"),
    N8N_GENERAL_CHAT_WEBHOOK: z.string().url().optional(),
    N8N_DOCUMENT_INGEST_WEBHOOK: z.string().url().optional(),
    N8N_HEALTH_COMMITTEE_WEBHOOK: z.string().url().optional(),
    N8N_HEALTH_COMMITTEE_SECRET: z.string().min(32).optional()
});
export const config = EnvSchema.parse(process.env);
export const adminEmails = new Set(config.ADMIN_GOOGLE_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
export function googleOAuthEnabled() {
    return Boolean(config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET);
}
export function googleRedirectUri() {
    return config.GOOGLE_OAUTH_REDIRECT_URI || `${config.PUBLIC_BASE_URL}/api/auth/google/callback`;
}
