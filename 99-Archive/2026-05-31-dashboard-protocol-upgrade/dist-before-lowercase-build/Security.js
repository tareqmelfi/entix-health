import crypto from "node:crypto";
import { config } from "./config.js";
const cookieName = "tper_health_session";
const googleStateCookieName = "tper_google_state";
function sign(value) {
    return crypto.createHmac("sha256", config.APP_SESSION_SECRET).update(value).digest("hex");
}
export function makeSessionCookie(session) {
    const payload = Buffer.from(JSON.stringify({ ...session, iat: Date.now() })).toString("base64url");
    return `${payload}.${sign(payload)}`;
}
export function verifySessionCookie(token) {
    if (!token || !token.includes("."))
        return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature)
        return null;
    const expected = sign(payload);
    if (signature.length !== expected.length)
        return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!parsed.slug || !parsed.email || parsed.status !== "active")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export async function requireSession(request, reply) {
    const session = verifySessionCookie(request.cookies?.[cookieName]);
    if (!session) {
        return reply.code(401).send({ error: "not_authenticated" });
    }
    request.session = session;
}
export async function requireAdmin(request, reply) {
    const session = verifySessionCookie(request.cookies?.[cookieName]);
    if (!session) {
        return reply.code(401).send({ error: "not_authenticated" });
    }
    if (session.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
    }
    request.session = session;
}
export function setSession(reply, session) {
    reply.setCookie(cookieName, makeSessionCookie(session), {
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 7
    });
}
export function clearSession(reply) {
    reply.clearCookie(cookieName, { path: "/" });
}
export function setGoogleState(reply, state) {
    reply.setCookie(googleStateCookieName, state, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/api/auth/google",
        maxAge: 60 * 10
    });
}
export function readGoogleState(request) {
    return request.cookies?.[googleStateCookieName];
}
export function clearGoogleState(reply) {
    reply.clearCookie(googleStateCookieName, { path: "/api/auth/google" });
}
export async function requireHmdbSecret(request, reply) {
    const supplied = request.headers["x-hmdb-secret"];
    const token = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!token || token !== config.HMDB_API_SECRET) {
        return reply.code(401).send({ error: "unauthorized" });
    }
}
export function requestIp(request) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length)
        return forwarded.split(",")[0]?.trim();
    return request.ip;
}
export function timingSafeStringEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length)
        return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
