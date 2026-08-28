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

export function setSessionCookie(res: Response, merchantId: string) {
  res.cookie(COOKIE_NAME, sign(merchantId), {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
    }
  }
}

/** Resolves req.merchantId from the signed session cookie. Never trusts a merchant id supplied
 *  directly by the client body/query — only this cookie-derived value is used for ownership
 *  checks throughout the API. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  const merchantId = token ? verify(token) : null;

  if (!merchantId) {
    res.status(401).json({ error: "No valid session. Call POST /api/session/init first." });
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
