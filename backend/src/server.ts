import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./env";
import { errorHandler } from "./middleware/errorHandler";
import { webhooksRouter } from "./routes/webhooks";
import { authRouter } from "./routes/auth";
import { sessionRouter } from "./routes/session";
import { merchantRouter } from "./routes/merchant";
import { paymentsRouter } from "./routes/payments";
import { customersRouter } from "./routes/customers";
import { recoveryRouter } from "./routes/recovery";
import { policiesRouter } from "./routes/policies";
import { auditRouter } from "./routes/audit";
import { metricsRouter } from "./routes/metrics";
import { simulationRouter } from "./routes/simulation";
import { installmentPlansRouter } from "./routes/installmentPlans";
import { publicOffersRouter } from "./routes/publicOffers";
import { startScheduler } from "./services/scheduler";

// Defense in depth for a single-instance deployment: a background job (simulation, scheduler tick)
// runs several async chains at once, and if one throws after a `Promise.all` it's grouped in has
// already settled, that rejection has nothing left awaiting it — Node treats it as fatal and kills
// the whole process by default. Every call site that can produce this is caught locally (see
// simulationService), but this is the last-resort net so one missed case takes down a log line,
// not the whole server mid-demo.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection (not crashing):", reason);
});

const app = express();

// Render (and every other PaaS this is likely deployed behind) terminates TLS at a reverse proxy
// and forwards the real client IP via X-Forwarded-For. Without this, express-rate-limit below
// would see every request as coming from the proxy's own IP — one shared bucket for all traffic
// instead of one per client. Only trusted in production: locally there's no proxy in front of the
// dev server, so trusting X-Forwarded-For there would let anyone hitting it directly spoof their
// rate-limit identity via that header.
if (env.isProduction) {
  app.set("trust proxy", 1);
}

// Baseline security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.). This is a pure
// JSON API with no HTML views of its own, so the parts of helmet's defaults aimed at documents the
// browser renders don't do much here — except Cross-Origin-Resource-Policy, whose default
// (`same-origin`) would actively break the legitimate cross-origin frontend fetching this API in
// production (Vercel + Render are different origins), so that one's relaxed explicitly.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// CORS: a single explicit allowed origin, never a wildcard, per deployment requirements.
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    // Content-Disposition isn't on the default CORS-safelisted response headers, so without this,
    // `fetch` can read the CSV export's body fine but `res.headers.get("Content-Disposition")`
    // silently returns null — the download still works, just always falls back to a generic
    // filename instead of the server's date-stamped one.
    exposedHeaders: ["Content-Disposition"],
  }),
);

// Generous general ceiling on the whole API — high enough to never bother a real merchant's
// dashboard (several SWR hooks poll every 5-30s; this app has a handful of pages, not hundreds),
// but a real backstop against a scripted flood. Session-cookie routes still enforce their own
// per-merchant authorization on top of this — this is only about request *volume*. Razorpay's own
// webhook deliveries are exempt: they're already gated by HMAC signature verification (see
// routes/webhooks.ts), and a real payment-failure burst or Razorpay's own retry-on-timeout
// behavior sharing a budget with dashboard polling could cause genuine webhooks to be dropped.
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/webhooks"),
});
app.use("/api", apiLimiter);

// The one router with no session cookie at all (see routes/publicOffers.ts) — a tighter ceiling
// specifically because there's no other authorization gate in front of it besides the plan id
// itself being unguessable, so it's the most exposed surface to a scripted enumeration attempt.
const publicOfferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/public/emi-offers", publicOfferLimiter);

// Login/signup brute-force protection — deliberately much tighter than the general API limit and
// keyed purely on request volume (no lockout state to manage, no way to lock a real user out of
// their own account by having someone else fail their password repeatedly).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth", authLimiter);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "razorrecover-backend", time: new Date().toISOString() });
});

// Webhook route needs the RAW body for HMAC signature verification — mounted before the
// app-wide JSON parser so Razorpay's exact bytes are preserved.
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRouter);
app.use("/api/session", sessionRouter);
app.use("/api/merchant", merchantRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/recovery", recoveryRouter);
app.use("/api/policies", policiesRouter);
app.use("/api/audit", auditRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/simulation", simulationRouter);
app.use("/api/installment-plans", installmentPlansRouter);
// Deliberately not behind requireSession -- see routes/publicOffers.ts.
app.use("/api/public/emi-offers", publicOffersRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`[server] RazorRecover backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startScheduler();
});
