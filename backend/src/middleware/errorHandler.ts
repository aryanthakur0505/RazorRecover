import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { env } from "../env";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.flatten() });
    return;
  }
  console.error(`[error] ${req.method} ${req.path}:`, err);
  // The full message (Prisma errors, the Razorpay/Groq SDKs, etc.) is genuinely useful in
  // development, but in production it can echo back internal detail — table/column names, raw
  // driver errors — to whoever triggered it. Log it in full either way; only the response is
  // generic in production.
  const message = !env.isProduction && err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
}

export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<void>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
