import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../middleware/errorHandler";
import { setSessionCookie, clearSessionCookie } from "../middleware/session";
import { signupSchema, loginSchema } from "../schemas/api";
import { hashPassword, verifyPassword } from "../services/crypto";

export const authRouter = Router();

authRouter.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const body = signupSchema.parse(req.body);

    const existing = await prisma.merchant.findUnique({ where: { email: body.email } });
    if (existing) {
      // Deliberately vague — "email already in use" on a signup form is normal UX, not the kind
      // of account-enumeration leak login's error message below is written to avoid.
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }

    const passwordHash = await hashPassword(body.password);
    const merchant = await prisma.merchant.create({
      data: { name: body.name, email: body.email, passwordHash },
    });
    // Every merchant needs a policy row to do anything (every guardrail check reads it) — this
    // mirrors exactly what the old single-demo-merchant bootstrap in session.ts used to do.
    await prisma.recoveryPolicy.create({ data: { merchantId: merchant.id } });

    setSessionCookie(res, merchant.id);
    res.status(201).json({ merchantId: merchant.id, name: merchant.name, email: merchant.email });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const merchant = await prisma.merchant.findUnique({ where: { email: body.email } });
    // Same generic response whether the email doesn't exist or the password is wrong, and run the
    // (deliberately slow, scrypt-based) password check either way rather than short-circuiting on
    // "no such account" — otherwise a login attempt's response time alone reveals which registered
    // emails exist.
    const valid = merchant?.passwordHash
      ? await verifyPassword(body.password, merchant.passwordHash)
      : await verifyPassword(body.password, DUMMY_HASH);

    if (!merchant || !valid) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    setSessionCookie(res, merchant.id);
    res.json({ merchantId: merchant.id, name: merchant.name, email: merchant.email });
  }),
);

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// A fixed, valid-format scrypt hash (of a random value nobody typed) to compare a login attempt
// against when the email isn't registered — keeps the "wrong password" and "no such account"
// branches doing the same amount of work instead of the unregistered-email path returning
// near-instantly, which would itself be a timing side-channel for account enumeration.
const DUMMY_HASH =
  "8f14e45fceea167a5a36dedd4bea2543:c9b6d4f0e0e9a9a0b1a4e8c2d7f3a5b6c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8";
