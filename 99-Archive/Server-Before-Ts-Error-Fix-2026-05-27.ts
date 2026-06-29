import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { checkDb, getPersonBySlug, pool, withPerson } from "./db.js";
import { config } from "./config.js";
import { clearSession, requireHmdbSecret, requireSession, requestIp, setSession } from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

const app = Fastify({
  logger: {
    level: config.HMDB_LOG_LEVEL,
    redact: ["req.headers.cookie", "req.headers.authorization", "req.headers.x-hmdb-secret"]
  },
  bodyLimit: 2 * 1024 * 1024
});

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
});
await app.register(cors, { origin: false });
await app.register(cookie);
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, path: request.url }, "request_failed");
  const statusCode = (error as any).statusCode || 500;
  reply.code(statusCode).send({
    error: statusCode === 500 ? "internal_error" : error.message,
    request_id: request.id
  });
});

app.get("/healthz", async (_request, reply) => {
  const db = await checkDb().catch(() => false);
  return reply.code(db ? 200 : 503).send({
    status: db ? "ok" : "degraded",
    service: "T-PER-HMDB-API",
    version: "0.1.0",
    db: db ? "connected" : "unavailable",
    uptime_seconds: Math.floor(process.uptime())
  });
});

app.post("/api/login", async (request, reply) => {
  const body = z.object({ accessCode: z.string().min(1) }).parse(request.body);
  if (body.accessCode !== config.TPER_HEALTH_ACCESS_CODE) {
    return reply.code(401).send({ error: "invalid_access_code" });
  }
  setSession(reply, "tareq");
  return { ok: true, person_slug: "tareq" };
});

app.post("/api/logout", { preHandler: requireSession }, async (_request, reply) => {
  clearSession(reply);
  return { ok: true };
});

app.get("/api/bootstrap", { preHandler: requireSession }, async () => {
  const db = await checkDb().catch(() => false);
  const person = await getPersonBySlug(config.HMDB_DEFAULT_PERSON_SLUG);
  return {
    ok: true,
    app: "T-OS Health",
    person_slug: config.HMDB_DEFAULT_PERSON_SLUG,
    db_connected: db,
    person_ready: Boolean(person),
    n8n_general_chat: Boolean(config.N8N_GENERAL_CHAT_WEBHOOK),
    n8n_document_ingest: Boolean(config.N8N_DOCUMENT_INGEST_WEBHOOK),
    hmdb_ready: db && Boolean(person)
  };
});

app.get("/api/documents", { preHandler: requireSession }, async () => {
  return withPerson(config.HMDB_DEFAULT_PERSON_SLUG, async (client, person) => {
    const result = await client.query(
      `select id, document_type, title, file_hash, summary, created_at, metadata
       from documents
       where person_id = $1
       order by created_at desc
       limit 30`,
      [person.id]
    );
    return { documents: result.rows };
  });
});

app.post("/api/chat", { preHandler: requireSession }, async (request, reply) => {
  const body = z.object({ question: z.string().trim().min(1).max(4000) }).parse(request.body);
  const sessionId = `t-per-ui-${Date.now()}`;
  await withPerson(config.HMDB_DEFAULT_PERSON_SLUG, async (client, person) => {
    await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 't-per-health-ui', 'chat_question', 'General chat question', $2, 2, $3, $4)`,
      [person.id, body.question, sessionId, { route: "api_chat" }]
    );
  });

  if (!config.N8N_GENERAL_CHAT_WEBHOOK) {
    return reply.code(503).send({ error: "n8n_general_chat_not_configured" });
  }

  const n8nResponse = await fetch(config.N8N_GENERAL_CHAT_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: body.question, sessionId })
  });
  const payload = await n8nResponse.json().catch(() => ({ ok: false, answer: "n8n returned a non-JSON response" }));
  const answer = String(payload.answer || payload.message || "No answer returned.");

  await withPerson(config.HMDB_DEFAULT_PERSON_SLUG, async (client, person) => {
    await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 'n8n-general-chat', 'chat_answer', 'General chat answer', $2, 2, $3, $4)`,
      [person.id, answer, sessionId, payload]
    );
  });

  return { ok: Boolean(payload.ok), answer, n8n: { workflow: "T-PER-WF-HEALTH-GENERAL-SMOKE-EN-V01" } };
});

app.post("/api/documents", { preHandler: requireSession }, async (request, reply) => {
  const data = await request.file();
  if (!data) return reply.code(400).send({ error: "file_required" });

  const buffer = await data.toBuffer();
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const originalName = data.filename || "upload.bin";
  const ext = path.extname(originalName).toLowerCase() || ".bin";
  const allowed = new Set([".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md", ".csv"]);
  if (!allowed.has(ext)) return reply.code(400).send({ error: "unsupported_file_type" });

  const safeTitle = originalName.replace(/[^\w.\- ]+/g, "").slice(0, 140) || `document-${Date.now()}${ext}`;
  const personSlug = config.HMDB_DEFAULT_PERSON_SLUG;
  const personDir = path.join(config.HMDB_FILES_DIR, personSlug);
  await fs.promises.mkdir(personDir, { recursive: true, mode: 0o700 });

  const duplicate = await withPerson(personSlug, async (client, person) => {
    const existing = await client.query(
      "select id, title, file_hash, created_at from documents where person_id = $1 and file_hash = $2 limit 1",
      [person.id, fileHash]
    );
    return existing.rows[0] ?? null;
  });
  if (duplicate) {
    return { ok: true, duplicate: true, document: duplicate, n8n: { status: "skipped_duplicate" } };
  }

  const id = crypto.randomUUID();
  const filePath = path.join(personDir, `${id}${ext}`);
  await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });

  const extractedText =
    ext === ".txt" || ext === ".md" || ext === ".csv" ? buffer.toString("utf8").slice(0, 200_000) : "";

  const documentRecord = await withPerson(personSlug, async (client, person) => {
    const inserted = await client.query(
      `insert into documents (id, person_id, document_type, title, file_path, file_hash, extracted_text, summary, created_by, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 't-per-health-ui', $9)
       returning id, document_type, title, file_hash, summary, created_at, metadata`,
      [
        id,
        person.id,
        ext === ".pdf" ? "lab_pdf" : "uploaded_file",
        safeTitle,
        filePath,
        fileHash,
        extractedText,
        extractedText ? "Text captured and stored. Structured lab extraction is pending n8n parser." : "File stored. Structured extraction is pending n8n parser.",
        { original_name: originalName, mimetype: data.mimetype, bytes: buffer.length, storage: "hmdb_private_volume" }
      ]
    );
    await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 't-per-health-ui', 'document_uploaded', $2, $3, 4, $4, $5)`,
      [person.id, safeTitle, "Private file stored in HMDB volume.", `doc-${id}`, { document_id: id, file_hash: fileHash }]
    );
    return inserted.rows[0];
  });

  let n8n: any = { status: "not_configured" };
  if (config.N8N_DOCUMENT_INGEST_WEBHOOK) {
    const res = await fetch(config.N8N_DOCUMENT_INGEST_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        person_slug: personSlug,
        document_id: id,
        title: safeTitle,
        file_hash: fileHash,
        document_type: documentRecord.document_type
      })
    });
    n8n = await res.json().catch(() => ({ status: "non_json_response" }));
  }

  return { ok: true, duplicate: false, document: documentRecord, n8n };
});

app.get("/v1/persons", { preHandler: requireHmdbSecret }, async () => {
  const result = await pool.query(
    "select slug, display_label, relation_label, status, created_at from health_memory.persons where status = 'active' order by created_at"
  );
  return { persons: result.rows };
});

app.get("/v1/persons/:slug/context", { preHandler: requireHmdbSecret }, async (request) => {
  const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params).slug;
  return withPerson(slug, async (client, person) => {
    const [conditions, medications, supplements, redLines, latestLabs, symptoms, decisions, documents] = await Promise.all([
      client.query("select condition_name as name, status, notes from medical_conditions where person_id = $1 order by created_at desc limit 20", [person.id]),
      client.query("select medication_name as name, dose, frequency, timing, notes, status from medications where person_id = $1 and status = 'active' order by created_at desc", [person.id]),
      client.query("select supplement_name as name, dose, frequency, timing, reason, safety_status, status from supplements where person_id = $1 and status in ('active','trial') order by created_at desc", [person.id]),
      client.query("select rule_code as code, rule_title as title, rule_body as body, severity from red_lines where person_id = $1 and status = 'active' order by rule_code", [person.id]),
      client.query("select id, panel_date, lab_name, summary, created_at from lab_panels where person_id = $1 order by panel_date desc nulls last, created_at desc limit 3", [person.id]),
      client.query("select symptom_name as name, severity, started_at, context, created_at from symptoms_log where person_id = $1 order by created_at desc limit 20", [person.id]),
      client.query("select decision_title as title, decision_body as body, evidence_tier, created_at from decisions_log where person_id = $1 order by created_at desc limit 15", [person.id]),
      client.query("select id, title, document_type, summary, created_at from documents where person_id = $1 order by created_at desc limit 10", [person.id])
    ]);
    return {
      person,
      active_conditions: conditions.rows,
      current_medications: medications.rows,
      current_supplements: supplements.rows,
      active_red_lines: redLines.rows,
      latest_labs: latestLabs.rows,
      recent_symptoms: symptoms.rows,
      recent_decisions: decisions.rows,
      recent_documents: documents.rows,
      context_generated_at: new Date().toISOString()
    };
  });
});

app.addHook("onResponse", async (request, reply) => {
  if (request.url.startsWith("/healthz")) return;
  const endpoint = request.url.split("?")[0] || request.url;
  pool
    .query(
      `insert into health_memory.api_audit_log (request_id, person_slug, endpoint, method, status_code, ip_address, user_agent, duration_ms, metadata)
       values ($1, $2, $3, $4, $5, nullif($6, '')::inet, $7, $8, $9)`,
      [
        request.id,
        config.HMDB_DEFAULT_PERSON_SLUG,
        endpoint,
        request.method,
        reply.statusCode,
        requestIp(request) || "",
        request.headers["user-agent"] || "",
        Math.round(reply.elapsedTime),
        { service: "T-PER-HMDB-API" }
      ]
    )
    .catch((error) => request.log.warn({ err: error }, "audit_log_write_failed"));
});

app.get("*", async (_request, reply) => {
  return reply.sendFile("index.html");
});

await app.listen({ host: "0.0.0.0", port: config.PORT });
