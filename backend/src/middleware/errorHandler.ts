import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: err.flatten() });
    return;
  }
  console.error(`[error] ${req.method} ${req.path}:`, err);
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
}

export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<void>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
