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
import { adminEmails, config, googleOAuthEnabled, googleRedirectUri } from "./config.js";
import {
  clearGoogleState,
  clearSession,
  readGoogleState,
  requireAdmin,
  requireHmdbSecret,
  requireSession,
  requestIp,
  setGoogleState,
  setSession,
  timingSafeStringEqual
} from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

type CommitteeResult = {
  ok: boolean;
  request_id: string;
  final_answer: string;
  validator_status: {
    status: "pass" | "blocked" | "caution";
    blocked: boolean;
    hits: Array<{ code: string; severity: string; message: string }>;
  };
  models_used: string[];
  memory_delta: Record<string, unknown>;
  debug?: Record<string, unknown>;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function currentSession(request: any) {
  return request.session as { slug: string; email: string; role: "admin" | "member"; status: string } | undefined;
}

function googleLoginUrl() {
  return "/api/auth/google";
}

async function ensureAdminUser() {
  const email = "tareq@fc.sa";
  await pool
    .query(
      `insert into health_memory.app_users (email, person_slug, role, status, created_by, metadata)
       values ($1, 'tareq', 'admin', 'active', 'system', '{"seed":"admin"}'::jsonb)
       on conflict (email) do update
       set role = 'admin', status = 'active', person_slug = 'tareq', updated_at = now()`,
      [email]
    )
    .catch((error: unknown) => app.log.warn({ err: error }, "admin_user_seed_skipped"));
}

async function findAppUserByEmail(email: string) {
  const result = await pool.query(
    `select id, email, person_slug, role, status, created_at, updated_at, last_login_at, metadata
     from health_memory.app_users
     where email = $1
     limit 1`,
    [normalizeEmail(email)]
  );
  return result.rows[0] ?? null;
}

async function createPendingUser(email: string, profile: Record<string, unknown>) {
  const normalized = normalizeEmail(email);
  const result = await pool.query(
    `insert into health_memory.app_users (email, role, status, created_by, metadata)
     values ($1, 'member', 'pending', 'google-oauth', $2)
     on conflict (email) do update
     set metadata = app_users.metadata || excluded.metadata, updated_at = now()
     returning id, email, person_slug, role, status, created_at, updated_at, last_login_at, metadata`,
    [normalized, profile]
  );
  return result.rows[0];
}

async function touchUserLogin(email: string) {
  await pool.query("update health_memory.app_users set last_login_at = now(), updated_at = now() where email = $1", [
    normalizeEmail(email)
  ]);
}

function deterministicCommittee(personSlug: string, sessionId: string, userMessage: string): CommitteeResult {
  const text = userMessage.toLowerCase();
  const hits: CommitteeResult["validator_status"]["hits"] = [];

  if (text.includes("ashwagandha") || text.includes("اشواجندا") || text.includes("اشواغندا")) {
    hits.push({
      code: "R-T-ASHWAGANDHA",
      severity: "hard_ban",
      message: "Blocked by personal red-line rules: do not start Ashwagandha in this profile."
    });
  }
  if (text.includes("tadalafil") || text.includes("سياليس") || text.includes("تادالافيل") || /20\s*mg/.test(text)) {
    hits.push({
      code: "R-T-TADALAFIL-20MG",
      severity: "hard_ban",
      message: "Blocked: tadalafil 20mg is a hard red-line item for this personal profile."
    });
  }
  if ((text.includes("iron") || text.includes("حديد")) && (text.includes("levothyroxine") || text.includes("ليفوثيروكسين") || text.includes("ثيروكسين"))) {
    hits.push({
      code: "R-T-IRON-LEVOTHYROXINE",
      severity: "strong_caution",
      message: "Separate iron and levothyroxine by at least 4 hours; do not take them together."
    });
  }
  if ((text.includes("tyrosine") || text.includes("تيروسين")) && (text.includes("wellbutrin") || text.includes("bupropion") || text.includes("ويلبوترين"))) {
    hits.push({
      code: "R-T-TYROSINE-WELLBUTRIN",
      severity: "strong_caution",
      message: "High-dose L-Tyrosine with Wellbutrin requires caution and should not be escalated without review."
    });
  }

  const blocked = hits.some((hit) => hit.severity === "hard_ban");
  const caution = hits.length > 0 && !blocked;
  let finalAnswer = "";

  if (blocked) {
    finalAnswer = [
      "تم إيقاف هذا المسار حسب قواعد السلامة الشخصية.",
      ...hits.map((hit) => `- ${hit.message}`),
      "الخطوة الآمنة: لا تبدأ أو ترفع الجرعة من هذا العنصر، واستخدم بديل أقل خطورة بعد مراجعة السياق الصحي الكامل."
    ].join("\n");
  } else if (caution) {
    finalAnswer = [
      "فيه تنبيه سلامة مهم قبل التنفيذ:",
      ...hits.map((hit) => `- ${hit.message}`),
      "الخلاصة العملية: افصل التوقيت، لا تجمع العناصر المتداخلة، وخل أي تعديل جرعات تدريجي ومراقب."
    ].join("\n");
  } else if (text.includes("meal") || text.includes("غذ") || text.includes("اكل") || text.includes("وجبة")) {
    finalAnswer = [
      "خطة عامة وآمنة كبداية:",
      "- بروتين واضح في كل وجبة.",
      "- كارب بطيء أو ألياف قبل السكريات السريعة.",
      "- خضار أو سلطة يومياً لتثبيت الشهية والطاقة.",
      "- ماء ونوم كفاية قبل تقييم أي مكملات.",
      "هذا توجيه عام، وأقدر أضبطه لاحقاً بعد رفع التحاليل وتسجيل الهدف."
    ].join("\n");
  } else {
    finalAnswer = [
      "المسار الإنتاجي شغال الآن عبر Health Committee وليس عبر الشات القديم فقط.",
      "سؤالك مر على الذاكرة الطبية، الراوتر، قواعد السلامة، ثم حفظ delta في HMDB.",
      "اسألني سؤال محدد أو ارفع ملف تحليل، وبعدها نضيف مرحلة استخراج القيم من الملف."
    ].join("\n");
  }

  return {
    ok: true,
    request_id: crypto.randomUUID(),
    final_answer: finalAnswer,
    validator_status: {
      status: blocked ? "blocked" : caution ? "caution" : "pass",
      blocked,
      hits
    },
    models_used: [
      "router:deterministic-v01",
      "rayan:safety-rules-v01",
      "sam:planning-rules-v01",
      "lena:deferred-until-lab-parser",
      "theo:deterministic-judge-v01"
    ],
    memory_delta: {
      person_slug: personSlug,
      session_id: sessionId,
      event_type: "committee_response",
      validator_status: blocked ? "blocked" : caution ? "caution" : "pass"
    }
  };
}

const app = Fastify({
  logger: {
    level: config.HMDB_LOG_LEVEL,
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers.x-hmdb-secret",
      "req.headers.x-health-webhook-secret",
      "req.body.user_message",
      "req.body.question"
    ]
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
    error: statusCode === 500 ? "internal_error" : error instanceof Error ? error.message : "request_failed",
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
  await ensureAdminUser();
  setSession(reply, { slug: "tareq", email: "tareq@fc.sa", role: "admin", status: "active" });
  return { ok: true, person_slug: "tareq", email: "tareq@fc.sa", role: "admin" };
});

app.post("/api/logout", { preHandler: requireSession }, async (_request, reply) => {
  clearSession(reply);
  return { ok: true };
});

app.get("/api/auth/google/status", async () => {
  return {
    enabled: googleOAuthEnabled(),
    login_url: googleLoginUrl(),
    redirect_uri: googleRedirectUri()
  };
});

app.get("/api/auth/google", async (_request, reply) => {
  if (!googleOAuthEnabled()) {
    return reply.code(503).send({ error: "google_oauth_not_configured" });
  }
  const state = crypto.randomBytes(24).toString("base64url");
  setGoogleState(reply, state);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account");
  return reply.redirect(url.toString());
});

app.get("/api/auth/google/callback", async (request, reply) => {
  const query = z.object({ code: z.string().min(1), state: z.string().min(8) }).parse(request.query);
  const expectedState = readGoogleState(request);
  clearGoogleState(reply);
  if (!googleOAuthEnabled()) return reply.code(503).send({ error: "google_oauth_not_configured" });
  if (!expectedState || expectedState !== query.state) return reply.code(401).send({ error: "invalid_google_state" });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: query.code,
      client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code"
    })
  });
  if (!tokenResponse.ok) return reply.code(401).send({ error: "google_token_exchange_failed" });
  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) return reply.code(401).send({ error: "google_access_token_missing" });

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokenPayload.access_token}` }
  });
  if (!profileResponse.ok) return reply.code(401).send({ error: "google_profile_failed" });
  const profile = (await profileResponse.json()) as { email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!profile.email || !profile.email_verified) return reply.code(401).send({ error: "google_email_not_verified" });

  const email = normalizeEmail(profile.email);
  if (adminEmails.has(email)) {
    await ensureAdminUser();
  }

  const user = (await findAppUserByEmail(email)) ?? (await createPendingUser(email, { name: profile.name, picture: profile.picture }));
  if (user.status !== "active") {
    return reply.type("text/html").send("<!doctype html><meta charset='utf-8'><script>location.href='/?auth=pending'</script>");
  }

  await touchUserLogin(email);
  setSession(reply, { slug: user.person_slug || "tareq", email, role: user.role, status: "active" });
  return reply.type("text/html").send("<!doctype html><meta charset='utf-8'><script>location.href='/'</script>");
});

app.get("/api/bootstrap", { preHandler: requireSession }, async (request) => {
  const db = await checkDb().catch(() => false);
  const session = currentSession(request);
  const personSlug = session?.slug || config.HMDB_DEFAULT_PERSON_SLUG;
  const person = await getPersonBySlug(personSlug);
  return {
    ok: true,
    app: "T-OS Health",
    base_url: config.PUBLIC_BASE_URL,
    person_slug: personSlug,
    auth: {
      email: session?.email,
      role: session?.role,
      is_admin: session?.role === "admin",
      google_enabled: googleOAuthEnabled(),
      google_login_url: googleLoginUrl()
    },
    db_connected: db,
    person_ready: Boolean(person),
    n8n_general_chat: Boolean(config.N8N_GENERAL_CHAT_WEBHOOK),
    n8n_document_ingest: Boolean(config.N8N_DOCUMENT_INGEST_WEBHOOK),
    n8n_health_committee: Boolean(config.N8N_HEALTH_COMMITTEE_WEBHOOK),
    hmdb_ready: db && Boolean(person)
  };
});

app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
  const result = await pool.query(
    `select id, email, person_slug, role, status, created_at, updated_at, last_login_at, metadata
     from health_memory.app_users
     order by created_at desc
     limit 100`
  );
  return { users: result.rows };
});

app.post("/api/admin/users", { preHandler: requireAdmin }, async (request) => {
  const body = z
    .object({
      email: z.string().email(),
      person_slug: z.string().regex(/^[a-z0-9-]+$/).default("tareq"),
      role: z.enum(["admin", "member"]).default("member"),
      status: z.enum(["active", "pending", "suspended"]).default("active")
    })
    .parse(request.body);
  const result = await pool.query(
    `insert into health_memory.app_users (email, person_slug, role, status, created_by)
     values ($1, $2, $3, $4, 'admin-ui')
     on conflict (email) do update
     set person_slug = excluded.person_slug, role = excluded.role, status = excluded.status, updated_at = now()
     returning id, email, person_slug, role, status, created_at, updated_at, last_login_at, metadata`,
    [normalizeEmail(body.email), body.person_slug, body.role, body.status]
  );
  return { ok: true, user: result.rows[0] };
});

app.post("/api/admin/users/:id/approve", { preHandler: requireAdmin }, async (request) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ person_slug: z.string().regex(/^[a-z0-9-]+$/).default("tareq"), role: z.enum(["admin", "member"]).default("member") }).parse(request.body ?? {});
  const result = await pool.query(
    `update health_memory.app_users
     set person_slug = $2, role = $3, status = 'active', updated_at = now()
     where id = $1
     returning id, email, person_slug, role, status, created_at, updated_at, last_login_at, metadata`,
    [params.id, body.person_slug, body.role]
  );
  return { ok: true, user: result.rows[0] ?? null };
});

app.get("/api/documents", { preHandler: requireSession }, async (request) => {
  const session = currentSession(request);
  return withPerson(session?.slug || config.HMDB_DEFAULT_PERSON_SLUG, async (client, person) => {
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
  const result = await runHealthCommittee(request, body.question, `t-per-ui-${Date.now()}`);
  return reply.send(result);
});

async function runHealthCommittee(request: any, userMessage: string, sessionId: string) {
  const session = currentSession(request);
  const personSlug = session?.slug || config.HMDB_DEFAULT_PERSON_SLUG;
  await withPerson(personSlug, async (client, person) => {
    await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 'clinical-clarity-ui', 'chat_question', 'Health committee question', $2, 2, $3, $4)`,
      [person.id, userMessage, sessionId, { route: "api_health_chat", email: session?.email }]
    );
  });

  if (!config.N8N_HEALTH_COMMITTEE_WEBHOOK) {
    const fallback = deterministicCommittee(personSlug, sessionId, userMessage);
    await saveCommitteeResult(personSlug, sessionId, fallback);
    return {
      ok: fallback.ok,
      answer: fallback.final_answer,
      request_id: fallback.request_id,
      validator_status: fallback.validator_status,
      models_used: fallback.models_used,
      n8n: { workflow: "local-deterministic-fallback", configured: false }
    };
  }

  const n8nResponse = await fetch(config.N8N_HEALTH_COMMITTEE_WEBHOOK, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.N8N_HEALTH_COMMITTEE_SECRET ? { "x-health-webhook-secret": config.N8N_HEALTH_COMMITTEE_SECRET } : {})
    },
    body: JSON.stringify({
      person_slug: personSlug,
      session_id: sessionId,
      user_message: userMessage,
      attachments: [],
      source: "clinical-clarity-ui"
    })
  });
  const payload = await n8nResponse.json().catch(() => ({ ok: false, final_answer: "n8n returned a non-JSON response" }));
  const answer = String(payload.final_answer || payload.answer || payload.message || "No answer returned.");
  return {
    ok: Boolean(payload.ok),
    answer,
    request_id: payload.request_id || request.id,
    validator_status: payload.validator_status || { status: "unknown", blocked: false, hits: [] },
    models_used: payload.models_used || [],
    n8n: { workflow: "T-PER-WF-HEALTH-COMMITTEE-V01", configured: true }
  };
}

async function saveCommitteeResult(personSlug: string, sessionId: string, result: CommitteeResult) {
  await withPerson(personSlug, async (client, person) => {
    await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 'health-committee', 'chat_answer', 'Health committee answer', $2, 3, $3, $4)`,
      [person.id, result.final_answer, sessionId, result]
    );
  });
}

app.post("/api/health/chat", { preHandler: requireSession }, async (request, reply) => {
  const body = z
    .object({
      user_message: z.string().trim().min(1).max(6000),
      session_id: z.string().trim().max(120).optional()
    })
    .parse(request.body);
  const sessionId = body.session_id || `t-per-ui-${crypto.randomUUID()}`;
  return reply.send(await runHealthCommittee(request, body.user_message, sessionId));
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
  const session = currentSession(request);
  const personSlug = session?.slug || config.HMDB_DEFAULT_PERSON_SLUG;
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

app.post("/v1/webhook-auth/check", { preHandler: requireHmdbSecret }, async (request) => {
  const body = z.object({ supplied_secret: z.string().optional() }).parse(request.body ?? {});
  const expected = config.N8N_HEALTH_COMMITTEE_SECRET || "";
  const ok = Boolean(expected && body.supplied_secret && timingSafeStringEqual(body.supplied_secret, expected));
  return { ok };
});

app.post("/v1/committee/evaluate", { preHandler: requireHmdbSecret }, async (request) => {
  const body = z
    .object({
      person_slug: z.string().regex(/^[a-z0-9-]+$/),
      session_id: z.string().min(1).max(120),
      user_message: z.string().trim().min(1).max(6000),
      source: z.string().default("n8n-health-committee")
    })
    .parse(request.body);
  await withPerson(body.person_slug, async (client, person) => {
    await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 'n8n-health-committee', 'committee_input', 'Committee input accepted', $2, 2, $3, $4)`,
      [person.id, body.user_message, body.session_id, { source: body.source }]
    );
  });
  const result = deterministicCommittee(body.person_slug, body.session_id, body.user_message);
  await saveCommitteeResult(body.person_slug, body.session_id, result);
  return result;
});

app.post("/v1/persons/:slug/memory-delta", { preHandler: requireHmdbSecret }, async (request) => {
  const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params).slug;
  const body = z
    .object({
      event_type: z.string().min(1).max(80).default("memory_delta"),
      event_title: z.string().max(160).optional(),
      event_body: z.string().max(10_000).optional(),
      session_id: z.string().max(120).optional(),
      importance: z.number().int().min(1).max(5).default(3),
      raw_delta: z.record(z.string(), z.unknown()).default({})
    })
    .parse(request.body ?? {});
  return withPerson(slug, async (client, person) => {
    const result = await client.query(
      `insert into memory_events (person_id, source, event_type, event_title, event_body, importance, session_id, raw_delta)
       values ($1, 'hmdb-api', $2, $3, $4, $5, $6, $7)
       returning id, event_type, event_title, created_at`,
      [person.id, body.event_type, body.event_title || null, body.event_body || null, body.importance, body.session_id || null, body.raw_delta]
    );
    return { ok: true, memory_event: result.rows[0] };
  });
});

app.post("/v1/persons/:slug/document", { preHandler: requireHmdbSecret }, async (request) => {
  const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params).slug;
  const body = z
    .object({
      document_type: z.string().max(80).default("uploaded_file"),
      title: z.string().max(180),
      file_hash: z.string().max(160).optional(),
      extracted_text: z.string().max(200_000).optional(),
      summary: z.string().max(5000).optional(),
      metadata: z.record(z.string(), z.unknown()).default({})
    })
    .parse(request.body ?? {});
  return withPerson(slug, async (client, person) => {
    const result = await client.query(
      `insert into documents (person_id, document_type, title, file_hash, extracted_text, summary, created_by, metadata)
       values ($1, $2, $3, $4, $5, $6, 'hmdb-api', $7)
       returning id, document_type, title, file_hash, summary, created_at`,
      [person.id, body.document_type, body.title, body.file_hash || null, body.extracted_text || "", body.summary || null, body.metadata]
    );
    return { ok: true, document: result.rows[0] };
  });
});

app.post("/v1/persons/:slug/lab-panel", { preHandler: requireHmdbSecret }, async (request) => {
  const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params).slug;
  const body = z
    .object({
      panel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      lab_name: z.string().max(160).optional(),
      source_document_id: z.string().uuid().optional(),
      summary: z.string().max(5000).optional(),
      markers: z
        .array(
          z.object({
            marker_name: z.string().max(120),
            value_text: z.string().max(120).optional(),
            value_numeric: z.number().optional(),
            unit: z.string().max(40).optional(),
            reference_range: z.string().max(120).optional(),
            flag: z.enum(["low", "normal", "high", "critical", "out_of_range"]).optional(),
            interpretation: z.string().max(1000).optional()
          })
        )
        .default([])
    })
    .parse(request.body ?? {});
  return withPerson(slug, async (client, person) => {
    const panel = await client.query(
      `insert into lab_panels (person_id, panel_date, lab_name, source_document_id, summary, created_by)
       values ($1, $2, $3, $4, $5, 'hmdb-api')
       returning id, panel_date, lab_name, summary, created_at`,
      [person.id, body.panel_date || null, body.lab_name || null, body.source_document_id || null, body.summary || null]
    );
    for (const marker of body.markers) {
      await client.query(
        `insert into lab_markers (lab_panel_id, person_id, marker_name, value_text, value_numeric, unit, reference_range, flag, interpretation, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'hmdb-api')`,
        [
          panel.rows[0].id,
          person.id,
          marker.marker_name,
          marker.value_text || null,
          marker.value_numeric ?? null,
          marker.unit || null,
          marker.reference_range || null,
          marker.flag || null,
          marker.interpretation || null
        ]
      );
    }
    return { ok: true, lab_panel: panel.rows[0], markers_saved: body.markers.length };
  });
});

app.post("/v1/persons/:slug/export", { preHandler: requireHmdbSecret }, async (request) => {
  const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params).slug;
  const body = z.object({ export_type: z.enum(["state", "labs_summary", "protocol", "decisions"]).default("state") }).parse(request.body ?? {});
  const context = await withPerson(slug, async (_client) => app.inject({ method: "GET", url: `/v1/persons/${slug}/context`, headers: { "x-hmdb-secret": config.HMDB_API_SECRET } }));
  const payload = JSON.parse(context.payload);
  const content = `# T-PER Health Export\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  const personDir = path.join(config.HMDB_EXPORT_DIR, slug);
  await fs.promises.mkdir(personDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(personDir, `${body.export_type}-${Date.now()}.md`);
  await fs.promises.writeFile(filePath, content, { mode: 0o600 });
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return withPerson(slug, async (client, person) => {
    const result = await client.query(
      `insert into generated_exports (person_id, export_type, file_path, content_hash, metadata)
       values ($1, $2, $3, $4, $5)
       returning id, export_type, file_path, content_hash, generated_at`,
      [person.id, body.export_type, filePath, contentHash, { generated_by: "hmdb-api" }]
    );
    return { ok: true, export: result.rows[0] };
  });
});

app.get("/v1/persons/:slug/search", { preHandler: requireHmdbSecret }, async (request) => {
  const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params).slug;
  const query = z.object({ q: z.string().min(1).max(200) }).parse(request.query);
  return withPerson(slug, async (client, person) => {
    const like = `%${query.q}%`;
    const [documents, memory] = await Promise.all([
      client.query(
        `select id, title, document_type, summary, created_at
         from documents
         where person_id = $1 and (title ilike $2 or extracted_text ilike $2 or summary ilike $2)
         order by created_at desc
         limit 10`,
        [person.id, like]
      ),
      client.query(
        `select id, event_type, event_title, event_body, created_at
         from memory_events
         where person_id = $1 and (event_title ilike $2 or event_body ilike $2)
         order by created_at desc
         limit 10`,
        [person.id, like]
      )
    ]);
    return { documents: documents.rows, memory_events: memory.rows };
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
    .catch((auditError: unknown) => request.log.warn({ err: auditError }, "audit_log_write_failed"));
});

await ensureAdminUser();
await app.listen({ host: "0.0.0.0", port: config.PORT });
