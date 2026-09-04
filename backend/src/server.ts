import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./env";
import { errorHandler } from "./middleware/errorHandler";
import { webhooksRouter } from "./routes/webhooks";
import { sessionRouter } from "./routes/session";
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

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "razorrecover-backend", time: new Date().toISOString() });
});

// Webhook route needs the RAW body for HMAC signature verification — mounted before the
// app-wide JSON parser so Razorpay's exact bytes are preserved.
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

app.use(express.json());
app.use(cookieParser());

app.use("/api/session", sessionRouter);
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
