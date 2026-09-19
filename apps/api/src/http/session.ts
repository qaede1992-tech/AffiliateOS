import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, OperatorRole } from "./auth.js";

export const SESSION_COOKIE = "affiliateos_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

type SessionPayload = AuthContext & { exp: number; nonce: string };

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionCookieValue(context: AuthContext, secret: string, now = Date.now()): string {
  const payload: SessionPayload = {
    ...context,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url")
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionCookieValue(value: string | undefined, secret: string, now = Date.now()): AuthContext | null {
  if (!value) return null;
  const [encoded, suppliedSignature] = value.split(".");
  if (!encoded || !suppliedSignature) return null;
  const expectedSignature = sign(encoded, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(decode(encoded)) as Partial<SessionPayload>;
    if (!payload.operatorId || !payload.role || !payload.exp || payload.exp <= Math.floor(now / 1000)) return null;
    if (!["admin", "operator", "viewer"].includes(payload.role)) return null;
    return { operatorId: payload.operatorId, role: payload.role as OperatorRole };
  } catch {
    return null;
  }
}

export function readSessionCookie(request: FastifyRequest, secret: string): AuthContext | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const cookie = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return verifySessionCookieValue(cookie?.slice(SESSION_COOKIE.length + 1), secret);
}

export function setSessionCookie(reply: FastifyReply, value: string, production: boolean): void {
  reply.header("Set-Cookie", `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Strict${production ? "; Secure" : ""}`);
}

export function clearSessionCookie(reply: FastifyReply, production: boolean): void {
  reply.header("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${production ? "; Secure" : ""}`);
}
