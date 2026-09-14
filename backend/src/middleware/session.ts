import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../db";
import { env } from "../env";

const COOKIE_NAME = "rr_session";

function sign(merchantId: string): string {
  const mac = crypto.createHmac("sha256", env.SESSION_SECRET).update(merchantId).digest("hex");
  return `${merchantId}.${mac}`;
}

function verify(token: string): string | null {
  const [merchantId, mac] = token.split(".");
  if (!merchantId || !mac) return null;
  const expected = crypto.createHmac("sha256", env.SESSION_SECRET).update(merchantId).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(mac, "utf8");
  if (expectedBuf.length !== actualBuf.length) return null;
  return crypto.timingSafeEqual(expectedBuf, actualBuf) ? merchantId : null;
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: (env.isProduction ? "none" : "lax") as "none" | "lax",
};

export function setSessionCookie(res: Response, merchantId: string) {
  res.cookie(COOKIE_NAME, sign(merchantId), { ...COOKIE_OPTIONS, maxAge: 1000 * 60 * 60 * 24 * 30 });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
}

declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
    }
  }
}

// CSRF defense: the session cookie is `sameSite: "none"` in production (the frontend and backend
// are deployed on different origins — Vercel + Render — so the cookie must be sendable
// cross-site), which switches off the browser's own default CSRF protection. A plain HTML
// <form method="POST"> from another site can't set a custom header, so requiring one on every
// state-changing request means a forged cross-site form submission has no way to get past this
// check even though the browser still attaches the cookie. A cross-origin *script* that tried to
// add the header instead would trigger a CORS preflight, which the single-explicit-origin CORS
// policy in server.ts already rejects for anything but FRONTEND_URL — so this is effective
// specifically because it forces exactly the request shape CORS was already restricting.
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALUE = "XMLHttpRequest";

/** Resolves req.merchantId from the signed session cookie. Never trusts a merchant id supplied
 *  directly by the client body/query — only this cookie-derived value is used for ownership
 *  checks throughout the API. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  if (!CSRF_SAFE_METHODS.has(req.method) && req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    res.status(403).json({ error: "Missing required client header." });
    return;
  }

  const token = req.cookies?.[COOKIE_NAME];
  const merchantId = token ? verify(token) : null;

  if (!merchantId) {
    res.status(401).json({ error: "No valid session. Please log in." });
    return;
  }

  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) {
    res.status(401).json({ error: "Session refers to an unknown merchant." });
    return;
  }

  req.merchantId = merchantId;
  next();
}

export { COOKIE_NAME };
