// Google-only health agent for entix.health.
// Runs exclusively on Google infrastructure: Gemini (from the dedicated
// entix-health GCP project) + native Google Search grounding. No other
// providers are ever called from this module.
//
// PHI handling: the patient snapshot goes only to the Gemini API (first-party
// model provider). Search grounding queries are produced by the model itself
// under an explicit no-identifiers instruction.

import crypto from "node:crypto";
import { config } from "./config.js";
import { memorySummary } from "./council.js";

export type GoogleAgentInput = {
  personSlug: string;
  sessionId: string;
  userMessage: string;
  memoryContext: unknown;
};

export type GoogleAgentResult = {
  ok: boolean;
  request_id: string;
  answer: string;
  model: string;
  project: string | null;
  sources: Array<{ title: string; url: string }>;
  grounded: boolean;
};

const SYSTEM_PROMPT = [
  "أنت «وكيل Google الصحي» في منصة Entix Health — مساعد صحي شخصي يعمل بنماذج Google حصراً.",
  "لديك ملخص ملف المستخدم الصحي؛ استخدمه لتخصيص الإجابة، واستخدم بحث Google عند الحاجة لأدلة حديثة.",
  "قواعد صارمة: لا تذكر أي مُعرّفات شخصية في استعلامات البحث. لا تشخّص ولا تصف جرعات دوائية جديدة — وجّه لمراجعة الطبيب.",
  "أجب بالعربية بإيجاز ونقاط واضحة، واذكر مصادرك عند الاستشهاد."
].join("\n");

export function googleAgentEnabled(): boolean {
  return Boolean(config.GOOGLE_AGENT_GEMINI_KEY || config.GEMINI_API_KEY);
}

export async function runGoogleAgent(input: GoogleAgentInput): Promise<GoogleAgentResult> {
  const requestId = crypto.randomUUID();
  const apiKey = config.GOOGLE_AGENT_GEMINI_KEY || config.GEMINI_API_KEY;
  if (!apiKey) throw new Error("google_agent_key_missing");

  const model = config.GOOGLE_AGENT_MODEL;
  // Key travels in a header (never in the URL) so it can't leak into proxy logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const user = [
    `ملخص الملف الصحي (خاص — لا يُرسل لأي طرف ثالث):\n${memorySummary(input.memoryContext)}`,
    `سؤال المستخدم:\n${input.userMessage}`
  ].join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let json: any = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        tools: [{ google_search: {} }]
      })
    });
    json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`google_agent_http_${res.status}`);
  } finally {
    clearTimeout(timer);
  }

  const candidate = json?.candidates?.[0];
  const answer = String((candidate?.content?.parts || []).map((p: any) => p?.text || "").join("\n")).trim();
  if (!answer) throw new Error("google_agent_empty");

  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c: any) => ({ title: String(c?.web?.title || "").slice(0, 140), url: String(c?.web?.uri || "") }))
    .filter((s: { title: string; url: string }) => s.url)
    .slice(0, 6);

  return {
    ok: true,
    request_id: requestId,
    answer,
    model,
    project: config.GOOGLE_HEALTH_PROJECT || null,
    sources,
    grounded: sources.length > 0
  };
}
