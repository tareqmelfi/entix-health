// EN-PRJ-VITA · In-API Doctor Council (multi-model orchestrator)
// Network of specialised members: a researcher gathers evidence, a clinician
// drafts the answer, an auditor cross-checks it for hallucination/safety, and a
// deterministic validator enforces personal red-lines. Output carries a
// confidence score. Designed to reduce hallucination and never replace a doctor.
//
// PHI handling: patient memory context goes ONLY to the first-party model
// providers (Anthropic / OpenAI / Google). The web researcher (Serper) receives
// a generalised medical query with NO patient identifiers or values.

import crypto from "node:crypto";
import { config } from "./config.js";

export type CouncilHit = { code: string; severity: string; message: string };

export type CouncilResult = {
  ok: boolean;
  request_id: string;
  final_answer: string;
  validator_status: {
    status: "pass" | "caution" | "blocked";
    blocked: boolean;
    hits: CouncilHit[];
  };
  models_used: string[];
  confidence: number; // 0-100
  sources: Array<{ title: string; url: string }>;
  member_status: Record<string, { ok: boolean; model: string; note?: string }>;
  memory_delta: Record<string, unknown>;
};

export type CouncilInput = {
  personSlug: string;
  sessionId: string;
  userMessage: string;
  memoryContext: unknown; // health snapshot (lab trends, meds, conditions)
  redLineHits: CouncilHit[]; // from the deterministic, PHI-aware local validator
  pastMemory?: string; // cross-session recall: summary of older conversations/events
  // Inline images attached to this chat message (base64 + media type). When
  // present, the council/direct engine routes to a multimodal model so the AI
  // actually SEES what the user uploaded (e.g. a photo they want an opinion on).
  images?: Array<{ b64: string; media: string }>;
};

const DISCLAIMER_AR =
  "هذا توجيه تنظيمي شخصي مبني على ملفك ومصادر عامة، وليس تشخيصاً طبياً ولا بديلاً عن طبيبك المعالج. أي قرار دواء أو جرعة راجع فيه طبيباً مرخّصاً.";

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider adapters. Each returns plain text or throws.
// ---------------------------------------------------------------------------

async function callAnthropic(model: string, system: string, user: string, timeoutMs: number) {
  if (!config.ANTHROPIC_API_KEY) throw new Error("anthropic_key_missing");
  const r = await fetchJsonWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1400,
        system,
        messages: [{ role: "user", content: user }]
      })
    },
    timeoutMs
  );
  if (!r.ok) throw new Error(`anthropic_http_${r.status}`);
  const text = (r.json?.content || [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("anthropic_empty");
  return text;
}

async function callOpenAI(model: string, system: string, user: string, timeoutMs: number) {
  if (!config.OPENAI_API_KEY) throw new Error("openai_key_missing");
  const r = await fetchJsonWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    },
    timeoutMs
  );
  if (!r.ok) throw new Error(`openai_http_${r.status}`);
  const text = String(r.json?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("openai_empty");
  return text;
}

async function callGemini(model: string, system: string, user: string, timeoutMs: number) {
  if (!config.GEMINI_API_KEY) throw new Error("gemini_key_missing");
  // Key travels in a header (never in the URL) so it can't leak into proxy logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  const r = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }]
      })
    },
    timeoutMs
  );
  if (!r.ok) throw new Error(`gemini_http_${r.status}`);
  const text = String(
    (r.json?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("\n")
  ).trim();
  if (!text) throw new Error("gemini_empty");
  return text;
}

// Multimodal Gemini call — sends inline images alongside the text prompt so the
// model can actually SEE what the user attached (a photo, a screenshot, a rash,
// a wound, an ECG strip, etc.). Used by both the direct chat and the council
// clinician seat whenever the user's message carries images.
async function callGeminiVision(
  model: string,
  system: string,
  user: string,
  images: Array<{ b64: string; media: string }>,
  timeoutMs: number
) {
  if (!config.GEMINI_API_KEY) throw new Error("gemini_key_missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  const parts: any[] = images.slice(0, 6).map((im) => ({
    inline_data: { mime_type: im.media, data: im.b64 }
  }));
  parts.push({ text: user });
  const r = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }]
      })
    },
    timeoutMs
  );
  if (!r.ok) throw new Error(`gemini_vision_http_${r.status}`);
  const text = String(
    (r.json?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("\n")
  ).trim();
  if (!text) throw new Error("gemini_vision_empty");
  return text;
}

// Generalised web search — receives NO patient data, only a neutral medical query.
// Strip potential PHI before any third-party call: emails, phones, dates, and
// measured lab values (number + unit). Medical terms like "B12" or "Type 2
// diabetes" survive — only standalone identifying/measured numbers are removed.
function sanitizeSearchQuery(message: string): string {
  return message
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
    .replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, " ")
    .replace(/\d+(?:[.,]\d+)?\s*(?:ng\/mL|mg\/dL|g\/dL|mmol\/L|µ?IU\/m?L|pg\/mL|nmol\/L|mcg|mg|kg|%)/gi, " ")
    .replace(/(?<![A-Za-z-])\d{4,}(?:[.,]\d+)?(?![A-Za-z])/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

async function webSearch(query: string, timeoutMs: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  if (!config.SERPER_API_KEY) return [];
  try {
    const r = await fetchJsonWithTimeout(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": config.SERPER_API_KEY },
        body: JSON.stringify({ q: query, num: 6 })
      },
      timeoutMs
    );
    if (!r.ok) return [];
    return (r.json?.organic || [])
      .slice(0, 6)
      .map((o: any) => ({ title: String(o.title || ""), url: String(o.link || ""), snippet: String(o.snippet || "") }))
      .filter((o: any) => o.url);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Council orchestration
// ---------------------------------------------------------------------------

export function memorySummary(memoryContext: any): string {
  if (!memoryContext) return "لا يوجد سياق طبي محفوظ بعد.";
  try {
    const stats = memoryContext.stats || {};
    const trends = (memoryContext.lab_trends || []).slice(0, 14);
    const meds = (memoryContext.medications || []).slice(0, 12);
    const supps = (memoryContext.supplements || []).slice(0, 12);
    const conds = (memoryContext.conditions || []).slice(0, 10);
    const trendLines = trends
      .map((t: any) => `${t.marker_name}: ${t.latest_value ?? "-"}${t.unit ? " " + t.unit : ""}${t.flag ? ` [${t.flag}]` : ""}`)
      .join("; ");
    const medLines = meds.map((m: any) => [m.name, m.dose, m.timing].filter(Boolean).join(" ")).join("; ");
    const suppLines = supps.map((m: any) => [m.name, m.dose, m.timing].filter(Boolean).join(" ")).join("; ");
    const condLines = conds.map((c: any) => c.name || c.condition_name).filter(Boolean).join("; ");
    return [
      `إحصاء: ${stats.documents || 0} ملفات، ${stats.reports || 0} تقارير، ${stats.lab_markers || 0} مؤشرات.`,
      trendLines ? `أحدث المؤشرات: ${trendLines}` : "",
      medLines ? `الأدوية: ${medLines}` : "",
      suppLines ? `المكملات: ${suppLines}` : "",
      condLines ? `الحالات: ${condLines}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "تعذّر تلخيص السياق الطبي.";
  }
}

function parseAuditor(text: string): { agreement: number; flags: string[]; corrected?: string } {
  // The auditor is asked to return a JSON block. Parse defensively.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const j = JSON.parse(match[0]);
      return {
        agreement: clamp(Number(j.agreement ?? j.agreement_score ?? 60)),
        flags: Array.isArray(j.flags) ? j.flags.map(String) : [],
        corrected: typeof j.corrected_answer === "string" && j.corrected_answer.trim() ? j.corrected_answer.trim() : undefined
      };
    } catch {
      // fall through
    }
  }
  return { agreement: 55, flags: [], corrected: undefined };
}

export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
  const requestId = crypto.randomUUID();
  const timeoutMs = config.COUNCIL_TIMEOUT_MS;
  const modelsUsed: string[] = [];
  const memberStatus: CouncilResult["member_status"] = {};
  const sources: CouncilResult["sources"] = [];

  const hardBan = input.redLineHits.some((h) => h.severity === "hard_ban");
  const caution = input.redLineHits.length > 0 && !hardBan;

  // 1) Hard red-line → block immediately, never deliberate the banned item.
  if (hardBan) {
    const answer = [
      "تم إيقاف هذا المسار حسب قواعد السلامة الشخصية المسجّلة في ملفك:",
      ...input.redLineHits.map((h) => `- ${h.message}`),
      "الخطوة الآمنة: لا تبدأ أو ترفع الجرعة، واطلب بديلاً أقل خطورة بعد مراجعة طبيبك.",
      "",
      DISCLAIMER_AR
    ].join("\n");
    return {
      ok: true,
      request_id: requestId,
      final_answer: answer,
      validator_status: { status: "blocked", blocked: true, hits: input.redLineHits },
      models_used: ["validator:red-lines-v01"],
      confidence: 96,
      sources: [],
      member_status: { validator: { ok: true, model: "deterministic-red-lines" } },
      memory_delta: { request_id: requestId, validator_status: "blocked", council: true }
    };
  }

  const memCtx = memorySummary(input.memoryContext);

  // 2) Researcher — neutral web evidence (no PHI) + Gemini synthesis.
  let research = "";
  if (config.COUNCIL_WEB_RESEARCH === "true") {
    const safeQuery = sanitizeSearchQuery(input.userMessage);
    const hits = safeQuery ? await webSearch(`${safeQuery} evidence guideline`, Math.min(8000, timeoutMs)) : [];
    for (const h of hits.slice(0, 5)) sources.push({ title: h.title, url: h.url });
    const snippetBlock = hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.snippet} (${h.url})`).join("\n");
    try {
      research = await callGemini(
        config.COUNCIL_MODEL_RESEARCHER,
        "أنت باحث طبي. لخّص الأدلة الموثوقة بإيجاز ونقاط، واذكر القيود وعدم اليقين. لا تخترع مصادر. اكتب بالعربية.",
        `سؤال المستخدم (بدون بيانات شخصية): ${input.userMessage}\n\nمقتطفات بحث:\n${snippetBlock || "لا يوجد"}\n\nأعطني ملخص أدلة موجز (5-8 نقاط) قابل للاستخدام السريري.`,
        Math.min(15000, timeoutMs)
      );
      modelsUsed.push(`researcher:${config.COUNCIL_MODEL_RESEARCHER}`);
      memberStatus.researcher = { ok: true, model: config.COUNCIL_MODEL_RESEARCHER };
    } catch (e) {
      memberStatus.researcher = { ok: false, model: config.COUNCIL_MODEL_RESEARCHER, note: String(e).slice(0, 80) };
    }
  }

  // 3) Clinician — primary answer (Claude Opus). Sees PHI memory context.
  const clinicianSystem = [
    "أنت طبيب سريري ضمن مجلس صحي شخصي لمنصة Entix Health.",
    "اكتب بالعربية بلهجة سعودية واضحة ومهنية، مختصرة وعملية.",
    "لا تعطِ تشخيصاً قاطعاً ولا تدّعي اليقين؛ صِغ كـ«توجيه تنظيمي شخصي».",
    "اربط كلامك بمؤشرات الملف الفعلية عند توفرها، ووضّح متى يلزم مراجعة الطبيب.",
    "ميّز بوضوح بين ما يظهر في التحاليل المرفوعة حالياً وما تستند إليه من ذاكرة سابقة: عند الإشارة لمعلومة قديمة قل صراحةً «من نقاشنا/ملفك السابق». لا تنسب معلومة لمصدر غير موجود، ولا تبالغ في استنتاج لا تدعمه القيم المتوفرة فعلياً.",
    "إذا كانت هناك تنبيهات سلامة، اذكرها أولاً.",
    "عند بناء أو عرض بروتوكول علاجي أو مكمّلات: لكل عنصر اذكر بوضوح — (1) الاسم بالعربي والإنجليزي، (2) الجرعة والتوقيت، (3) البراند/الصيغة الموصى بها بعد بحث عن الأفضل مع «لماذا هذه الصيغة تحديداً؟»، (4) مع ماذا يتعارض أو يجب فصله عنه ولماذا. استخدم جداول Markdown منظّمة (| عمود | عمود |) عند عرض جداول أو جرعات ليظهر بشكل احترافي.",
    caution ? `تنبيهات سلامة يجب دمجها: ${input.redLineHits.map((h) => h.message).join(" | ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  const clinicianUser = [
    `سؤال المستخدم: ${input.userMessage}`,
    "",
    `سياق الملف الطبي:\n${memCtx}`,
    "",
    input.pastMemory ? `ذاكرة سابقة عابرة للجلسات (محادثات/قرارات أقدم — استخدمها للربط والاستمرارية):\n${input.pastMemory}` : "",
    "",
    research ? `ملخص الباحث (أدلة عامة):\n${research}` : "لا يوجد ملخص بحث.",
    "",
    "أعطِ إجابة عملية واضحة تربط بما قاله المستخدم سابقاً عند صلته. واختم دائماً بعنوان **خطة الـ90 يوم:** يليه قائمة مرقّمة (1. 2. 3. ...) من 3 إلى 5 خطوات محددة قابلة للتنفيذ ومرتّبة بالأولوية (فحص/جرعة/سلوك)."
  ]
    .filter(Boolean)
    .join("\n");

  let clinician = "";
  let clinicianModel = config.COUNCIL_MODEL_CLINICIAN;
  try {
    clinician = await callAnthropic(config.COUNCIL_MODEL_CLINICIAN, clinicianSystem, clinicianUser, timeoutMs);
    modelsUsed.push(`clinician:${config.COUNCIL_MODEL_CLINICIAN}`);
    memberStatus.clinician = { ok: true, model: config.COUNCIL_MODEL_CLINICIAN };
  } catch (e1) {
    // Fallback to OpenAI then Gemini so the clinician seat is rarely empty.
    try {
      clinician = await callOpenAI(config.COUNCIL_MODEL_AUDITOR, clinicianSystem, clinicianUser, timeoutMs);
      clinicianModel = config.COUNCIL_MODEL_AUDITOR;
      modelsUsed.push(`clinician:${config.COUNCIL_MODEL_AUDITOR}`);
      memberStatus.clinician = { ok: true, model: config.COUNCIL_MODEL_AUDITOR, note: "fallback_from_anthropic" };
    } catch (e2) {
      try {
        clinician = await callGemini(config.COUNCIL_MODEL_RESEARCHER, clinicianSystem, clinicianUser, timeoutMs);
        clinicianModel = config.COUNCIL_MODEL_RESEARCHER;
        modelsUsed.push(`clinician:${config.COUNCIL_MODEL_RESEARCHER}`);
        memberStatus.clinician = { ok: true, model: config.COUNCIL_MODEL_RESEARCHER, note: "fallback_from_openai" };
      } catch (e3) {
        memberStatus.clinician = { ok: false, model: clinicianModel, note: String(e3).slice(0, 80) };
      }
    }
  }

  // If no clinician produced anything, signal caller to use deterministic fallback.
  if (!clinician) {
    return {
      ok: false,
      request_id: requestId,
      final_answer: "",
      validator_status: { status: caution ? "caution" : "pass", blocked: false, hits: input.redLineHits },
      models_used: modelsUsed,
      confidence: 0,
      sources,
      member_status: memberStatus,
      memory_delta: { request_id: requestId, council: true, degraded: true }
    };
  }

  // 4) Auditor — cross-check the clinician answer (GPT). Returns JSON.
  let agreement = 60;
  let auditorFlags: string[] = [];
  let corrected: string | undefined;
  try {
    const auditText = await callOpenAI(
      config.COUNCIL_MODEL_AUDITOR,
      "أنت مدقّق سلامة سريري مستقل. مهمتك كشف الهلوسة والتناقض ومخاطر السلامة في إجابة زميلك. أعد فقط JSON.",
      [
        `السؤال: ${input.userMessage}`,
        `سياق الملف: ${memCtx}`,
        research ? `أدلة الباحث: ${research}` : "",
        `إجابة الطبيب المقترحة:\n${clinician}`,
        "",
        'أعد JSON بالشكل: {"agreement": 0-100, "flags": ["..."], "corrected_answer": "النسخة المصححة بالعربية إذا لزم، أو نفس الإجابة"}'
      ]
        .filter(Boolean)
        .join("\n"),
      timeoutMs
    );
    const parsed = parseAuditor(auditText);
    agreement = parsed.agreement;
    auditorFlags = parsed.flags;
    corrected = parsed.corrected;
    modelsUsed.push(`auditor:${config.COUNCIL_MODEL_AUDITOR}`);
    memberStatus.auditor = { ok: true, model: config.COUNCIL_MODEL_AUDITOR };
  } catch (e) {
    memberStatus.auditor = { ok: false, model: config.COUNCIL_MODEL_AUDITOR, note: String(e).slice(0, 80) };
  }

  // 5) Validator + consensus + confidence.
  const finalCore = corrected && corrected.length > 40 ? corrected : clinician;
  const membersOk = [memberStatus.researcher, memberStatus.clinician, memberStatus.auditor].filter((m) => m?.ok).length;
  let confidence = clamp(
    0.55 * agreement + // auditor agreement
      (membersOk >= 3 ? 18 : membersOk === 2 ? 10 : 2) + // breadth of council
      (sources.length > 0 ? 10 : 0) + // grounded in sources
      (caution ? -8 : 8) // safety posture
  );
  const status: "pass" | "caution" = caution || auditorFlags.length > 0 ? "caution" : "pass";
  if (status === "caution") confidence = Math.min(confidence, 80);

  const hits: CouncilHit[] = [
    ...input.redLineHits,
    ...auditorFlags.map((f, i) => ({ code: `AUDIT-${i + 1}`, severity: "audit_flag", message: f }))
  ];

  // Sources + confidence are surfaced in the UI meta (pills + collapsible list),
  // so they are NOT duplicated inside the answer body — keeps the chat clean.
  const finalAnswer = [
    status === "caution" && hits.length ? "⚠️ تنبيهات قبل التنفيذ:\n" + hits.map((h) => `- ${h.message}`).join("\n") + "\n" : "",
    finalCore,
    "",
    DISCLAIMER_AR
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ok: true,
    request_id: requestId,
    final_answer: finalAnswer,
    validator_status: { status, blocked: false, hits },
    models_used: modelsUsed,
    confidence,
    sources,
    member_status: memberStatus,
    memory_delta: {
      request_id: requestId,
      validator_status: status,
      confidence,
      agreement,
      members_ok: membersOk,
      council: true
    }
  };
}

export function councilEnabled() {
  return (
    config.COUNCIL_ENABLED === "true" &&
    Boolean(config.ANTHROPIC_API_KEY || config.OPENAI_API_KEY || config.GEMINI_API_KEY)
  );
}

// ---------------------------------------------------------------------------
// Direct chat — a single fast model for ordinary discussion (no full council).
// The council is reserved for diagnostic / lab-analysis requests to save time.
// ---------------------------------------------------------------------------
export async function runDirect(input: CouncilInput): Promise<CouncilResult> {
  const requestId = crypto.randomUUID();
  const timeoutMs = Math.min(config.COUNCIL_TIMEOUT_MS, 18000);
  const hardBan = input.redLineHits.some((h) => h.severity === "hard_ban");
  if (hardBan) {
    const answer = [
      "تم إيقاف هذا المسار حسب قواعد السلامة الشخصية المسجّنة في ملفك:",
      ...input.redLineHits.map((h) => `- ${h.message}`),
      "الخطوة الآمنة: لا تبدأ أو ترفع الجرعة، واطلب بديلاً أقل خطورة بعد مراجعة طبيبك.",
      "",
      DISCLAIMER_AR
    ].join("\n");
    return {
      ok: true, request_id: requestId, final_answer: answer,
      validator_status: { status: "blocked", blocked: true, hits: input.redLineHits },
      models_used: ["validator:red-lines-v01"], confidence: 96, sources: [],
      member_status: { validator: { ok: true, model: "deterministic-red-lines" } },
      memory_delta: { request_id: requestId, validator_status: "blocked", direct: true }
    };
  }
  const caution = input.redLineHits.length > 0;
  const memCtx = memorySummary(input.memoryContext);
  const hasImages = Array.isArray(input.images) && input.images.length > 0;
  const system = [
    "أنت مساعد Entix Health الصحي الشخصي — محادثة مباشرة ودّية ومهنية بالعربية بلهجة سعودية واضحة.",
    "أجب باختصار وعملية. اربط بمؤشرات ملف المستخدم عند الصلة. لا تعطِ تشخيصاً قاطعاً.",
    "إذا احتاج السؤال تحليلاً تشخيصياً عميقاً أو مراجعة تحاليل، اقترح عليه تحويله إلى «مجلس الأطباء» لتحليل أعمق بمصادر وثقة.",
    // CRITICAL anti-hallucination rules — the prior system prompt let the model
    // drift into generic lab-analysis answers even when the user asked about a
    // totally unrelated image. These rules force it to answer the ACTUAL question.
    "قواعد صارمة للإجابة:",
    "1) أجب عن سؤال المستخدم الفعلي بالضبط كما طرحه — لا تستبدله بسؤال آخر تظن أنه أقرب.",
    "2) إذا أرفق المستخدم صورة، انظر إلى الصورة فعلياً وأجب عمّا يراه فيها. لا تتجاهلها ولا تتصرف كأنها تحاليل مخزّنة.",
    "3) إذا لم تكن مؤشرات الملف الطبي مرتبطة بالسؤال، لا تذكرها. لا تبدأ بسرد التحاليل أو الأدوية ما لم يسأل المستخدم عنها.",
    "4) إذا لم تعرف الإجابة أو لم تتوفر بيانات كافية، قل صراحةً «لا أعرف» أو «أحتاج مزيد معلومات» بدل اختراع رد.",
    "5) ميّز بوضوح بين ما تراه في الصورة المرفقة وما تعرفه من ملف المستخدم المخزّن.",
    caution ? `تنبيهات سلامة يجب دمجها: ${input.redLineHits.map((h) => h.message).join(" | ")}` : ""
  ].filter(Boolean).join("\n");
  const user = [
    `رسالة المستخدم: ${input.userMessage}`, "",
    hasImages ? `(أرفق المستخدم ${input.images!.length} صورة — انظر إليها وأجب عنها تحديداً.)` : "",
    `سياق ملفه الطبي (استخدمه فقط عند الصلة المباشرة بالسؤال):\n${memCtx}`, "",
    input.pastMemory ? `ذاكرة سابقة عابرة للجلسات:\n${input.pastMemory}` : ""
  ].filter(Boolean).join("\n");
  let answer = "";
  let model = config.COUNCIL_MODEL_CLINICIAN;
  const memberStatus: CouncilResult["member_status"] = {};
  // When the user attached images, route to a multimodal model that can SEE them.
  // Gemini Flash Vision is fast and accurate for general image Q&A. We prefer it
  // first for image-bearing messages; the text-only Claude/GPT path stays for
  // plain text questions (it's better at long-form clinical reasoning).
  if (hasImages) {
    try {
      answer = await callGeminiVision(config.COUNCIL_MODEL_VISION, system, user, input.images!, timeoutMs);
      model = config.COUNCIL_MODEL_VISION;
      memberStatus.assistant = { ok: true, model, note: "multimodal" };
    } catch (e1) {
      memberStatus.assistant = { ok: false, model, note: String(e1).slice(0, 80) };
    }
  }
  if (!answer) {
    try {
      answer = await callAnthropic(config.COUNCIL_MODEL_CLINICIAN, system, user, timeoutMs);
      model = config.COUNCIL_MODEL_CLINICIAN;
      memberStatus.assistant = { ok: true, model };
    } catch {
      try {
        answer = await callOpenAI(config.COUNCIL_MODEL_AUDITOR, system, user, timeoutMs);
        model = config.COUNCIL_MODEL_AUDITOR; memberStatus.assistant = { ok: true, model, note: "fallback" };
      } catch {
        try {
          answer = await callGemini(config.COUNCIL_MODEL_RESEARCHER, system, user, timeoutMs);
          model = config.COUNCIL_MODEL_RESEARCHER; memberStatus.assistant = { ok: true, model, note: "fallback2" };
        } catch (e3) {
          memberStatus.assistant = { ok: false, model, note: String(e3).slice(0, 80) };
        }
      }
    }
  }
  if (!answer) {
    return {
      ok: false, request_id: requestId, final_answer: "",
      validator_status: { status: caution ? "caution" : "pass", blocked: false, hits: input.redLineHits },
      models_used: [], confidence: 0, sources: [], member_status: memberStatus,
      memory_delta: { request_id: requestId, direct: true, degraded: true }
    };
  }
  const finalAnswer = [
    caution && input.redLineHits.length ? "⚠️ " + input.redLineHits.map((h) => h.message).join(" · ") + "\n" : "",
    answer
  ].filter(Boolean).join("\n");
  return {
    ok: true, request_id: requestId, final_answer: finalAnswer,
    validator_status: { status: caution ? "caution" : "pass", blocked: false, hits: input.redLineHits },
    models_used: [`direct:${model}`], confidence: -1, sources: [], member_status: memberStatus,
    memory_delta: { request_id: requestId, direct: true, multimodal: hasImages }
  };
}

// ---------------------------------------------------------------------------
// Vision lab extraction — reads report image(s) with a top vision model and
// returns structured markers. Far more accurate than tesseract + regex.
// ---------------------------------------------------------------------------
export type ExtractedMarker = {
  marker_name: string;
  name_ar: string | null;
  value_text: string | null;
  value_numeric: number | null;
  unit: string | null;
  reference_range: string | null;
  flag: string | null;
  status_label: string | null;
  explain: string | null;
  explain_long: string | null;
};
export type LabExtraction = {
  panel_date: string | null;
  lab_name: string | null;
  markers: ExtractedMarker[];
  raw_text: string;
  model: string;
};

export async function visionExtractLabs(
  images: Array<{ b64: string; media: string }>,
  opts?: { model?: string; timeoutMs?: number }
): Promise<LabExtraction> {
  if (!config.ANTHROPIC_API_KEY) throw new Error("anthropic_key_missing");
  const model = opts?.model || config.EXTRACTION_MODEL || config.COUNCIL_MODEL_CLINICIAN;
  const timeoutMs = opts?.timeoutMs || Math.max(30000, config.COUNCIL_TIMEOUT_MS);
  const system =
    "You are a meticulous medical laboratory report extractor. Read the lab report image(s) carefully and extract EVERY test/marker exactly as printed. Be precise with numbers, units and reference ranges. Return ONLY valid JSON, no prose.";
  const instruction =
    'Extract all lab markers from the image(s). Return strict JSON only:\n{"panel_date":"YYYY-MM-DD or null","lab_name":"string or null","markers":[{"marker_name":"canonical English test name","name_ar":"Arabic name of the test","value_text":"value exactly as printed","value_numeric":number or null,"unit":"unit string or null","reference_range":"low-high or as printed or null","flag":"high|low|normal|critical or null","status_label":"short ARABIC descriptive status","explain":"short ARABIC tagline (max ~7 words): what this marker is","explain_long":"detailed ARABIC explanation (1-2 sentences, ~30-45 words): what it measures, what happens if it is HIGH and if it is LOW, and what this specific value means for the patient"}]}\nRules: use canonical English marker names (e.g. TSH, Free T4, Ferritin, Iron, TIBC, Vitamin D, Vitamin B12, HbA1c, Fasting Glucose, ALT, AST, Creatinine, eGFR, Hemoglobin, Hematocrit, WBC, Platelets, LDL, HDL, Total Cholesterol, Triglycerides). "name_ar" = the common Arabic name (e.g. WBC → "خلايا الدم البيضاء", Ferritin → "مخزون الحديد", Vitamin D → "فيتامين د", HbA1c → "السكر التراكمي"). "status_label" = a short nuanced ARABIC status reflecting where the value sits vs its range (e.g. "طبيعي"، "طبيعي ومستقر"، "مرتفع قليلاً"، "منخفض قليلاً"، "نقص يتطلب تدخل"، "مرتفع — يحتاج متابعة"). Map each marker to its correct unit — never put an enzyme unit (U/L) on glucose or a hormone. value_numeric must be a number only. If a value is text put it in value_text and set value_numeric null. "explain" = short Arabic tagline only. "explain_long" MUST be Arabic, 1-2 full sentences, and MUST describe the effect of BOTH a high and a low value plus the meaning of this patient\'s actual result (this is the core educational value — be specific, not generic). Do not invent markers that are not present.';
  const content: any[] = images.slice(0, 6).map((im) => ({
    type: "image",
    source: { type: "base64", media_type: im.media, data: im.b64 }
  }));
  content.push({ type: "text", text: instruction });
  const r = await fetchJsonWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content }] })
    },
    timeoutMs
  );
  if (!r.ok) throw new Error(`vision_http_${r.status}`);
  const text = (r.json?.content || [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("vision_no_json");
  const parsed = JSON.parse(match[0]);
  const markers: ExtractedMarker[] = (Array.isArray(parsed.markers) ? parsed.markers : [])
    .map((m: any) => {
      const name = String(m.marker_name || m.name || "").trim();
      if (!name) return null;
      let num: number | null = null;
      if (typeof m.value_numeric === "number" && Number.isFinite(m.value_numeric)) num = m.value_numeric;
      else if (m.value_numeric != null) {
        const f = parseFloat(String(m.value_numeric).replace(/,/g, ""));
        num = Number.isFinite(f) ? f : null;
      }
      const flag = m.flag ? String(m.flag).toLowerCase().trim() : null;
      return {
        marker_name: name.slice(0, 120),
        name_ar: m.name_ar ? String(m.name_ar).slice(0, 80) : null,
        value_text: m.value_text != null ? String(m.value_text).slice(0, 60) : num != null ? String(num) : null,
        value_numeric: num,
        unit: m.unit ? String(m.unit).slice(0, 30) : null,
        reference_range: m.reference_range ? String(m.reference_range).slice(0, 60) : null,
        flag: flag && ["high", "low", "normal", "critical", "abnormal"].includes(flag) ? flag : null,
        status_label: m.status_label ? String(m.status_label).slice(0, 48) : null,
        explain: m.explain ? String(m.explain).slice(0, 120) : m.explanation ? String(m.explanation).slice(0, 120) : null,
        explain_long: m.explain_long ? String(m.explain_long).slice(0, 400) : m.explanation_long ? String(m.explanation_long).slice(0, 400) : null
      } as ExtractedMarker;
    })
    .filter(Boolean) as ExtractedMarker[];
  const rawText = markers
    .map((m) => `${m.marker_name}: ${m.value_text ?? ""}${m.unit ? " " + m.unit : ""}${m.reference_range ? " (" + m.reference_range + ")" : ""}${m.flag ? " [" + m.flag + "]" : ""}`)
    .join("\n");
  const dateStr = typeof parsed.panel_date === "string" && /\d{4}-\d{2}-\d{2}/.test(parsed.panel_date) ? parsed.panel_date.slice(0, 10) : null;
  return {
    panel_date: dateStr,
    lab_name: parsed.lab_name ? String(parsed.lab_name).slice(0, 120) : null,
    markers,
    raw_text: rawText,
    model
  };
}
