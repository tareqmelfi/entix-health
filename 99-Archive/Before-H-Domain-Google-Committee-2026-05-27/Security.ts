import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

const cookieName = "tper_health_session";

function sign(value: string) {
  return crypto.createHmac("sha256", config.APP_SESSION_SECRET).update(value).digest("hex");
}

export function makeSessionCookie(slug: string) {
  const payload = Buffer.from(JSON.stringify({ slug, iat: Date.now() })).toString("base64url");
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
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.slug !== "tareq") return null;
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
}

export function setSession(reply: FastifyReply, slug = "tareq") {
  reply.setCookie(cookieName, makeSessionCookie(slug), {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(cookieName, { path: "/" });
}

export async function requireHmdbSecret(request: FastifyRequest, reply: FastifyReply) {
  const supplied = request.headers["x-hmdb-secret"];
  const token = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!token || token !== config.HMDB_API_SECRET) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

export function requestIp(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0]?.trim();
  return request.ip;
}
