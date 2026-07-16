import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

const cookieName = "tper_health_session";
const googleStateCookieName = "tper_google_state";

export type SessionPayload = {
  slug: string;
  email: string;
  role: "admin" | "member";
  status: "active" | "pending" | "suspended";
  iat: number;
};

function sign(value: string) {
  return crypto.createHmac("sha256", config.APP_SESSION_SECRET).update(value).digest("hex");
}

function cookieDomain() {
  try {
    const host = new URL(config.PUBLIC_BASE_URL).hostname;
    if (host === config.COOKIE_DOMAIN || host.endsWith(`.${config.COOKIE_DOMAIN}`)) return config.COOKIE_DOMAIN;
  } catch {
    return undefined;
  }
  return undefined;
}

function secureCookieOptions(maxAge?: number) {
  const domain = cookieDomain();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true,
    path: "/",
    ...(domain ? { domain } : {}),
    ...(maxAge ? { maxAge } : {})
  };
}

function clearCookieOptions() {
  const domain = cookieDomain();
  return {
    path: "/",
    ...(domain ? { domain } : {})
  };
}

export function makeSessionCookie(session: Omit<SessionPayload, "iat">) {
  const payload = Buffer.from(JSON.stringify({ ...session, iat: Date.now() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionCookie(token?: string) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionPayload;
    if (!parsed.slug || !parsed.email || parsed.status !== "active") return null;
    // Enforce server-side session expiry — the browser cookie maxAge alone is
    // not enough if the token is exfiltrated (XSS / log leak). iat is set in
    // makeSessionCookie as Date.now() (ms). Reject anything older than 7 days.
    const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    if (!parsed.iat || Date.now() - parsed.iat > SESSION_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const session = verifySessionCookie(request.cookies?.[cookieName]);
  if (!session) {
    return reply.code(401).send({ error: "not_authenticated" });
  }
  (request as any).session = session;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const session = verifySessionCookie(request.cookies?.[cookieName]);
  if (!session) {
    return reply.code(401).send({ error: "not_authenticated" });
  }
  if (session.role !== "admin") {
    return reply.code(403).send({ error: "admin_required" });
  }
  (request as any).session = session;
}

export function setSession(reply: FastifyReply, session: Omit<SessionPayload, "iat">) {
  reply.setCookie(cookieName, makeSessionCookie(session), secureCookieOptions(60 * 60 * 24 * 7));
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(cookieName, clearCookieOptions());
}

export function setGoogleState(reply: FastifyReply, state: string) {
  reply.setCookie(googleStateCookieName, state, secureCookieOptions(60 * 10));
}

export function readGoogleState(request: FastifyRequest) {
  return request.cookies?.[googleStateCookieName];
}

export function clearGoogleState(reply: FastifyReply) {
  reply.clearCookie(googleStateCookieName, clearCookieOptions());
}

export async function requireHmdbSecret(request: FastifyRequest, reply: FastifyReply) {
  const supplied = request.headers["x-hmdb-secret"];
  const token = Array.isArray(supplied) ? supplied[0] : supplied;
  // Use a constant-time comparison to avoid timing attacks that could leak the
  // secret byte-by-byte. The plain `!==` short-circuits on the first mismatch.
  if (!token || !timingSafeStringEqual(token, config.HMDB_API_SECRET)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

export function requestIp(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0]?.trim();
  return request.ip;
}

export function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
