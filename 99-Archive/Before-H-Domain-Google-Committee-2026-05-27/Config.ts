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
  N8N_GENERAL_CHAT_WEBHOOK: z.string().url().optional(),
  N8N_DOCUMENT_INGEST_WEBHOOK: z.string().url().optional()
});

export const config = EnvSchema.parse(process.env);
