import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./env";
import { errorHandler } from "./middleware/errorHandler";
import { webhooksRouter } from "./routes/webhooks";
import { sessionRouter } from "./routes/session";
import { paymentsRouter } from "./routes/payments";
import { recoveryRouter } from "./routes/recovery";
import { policiesRouter } from "./routes/policies";
import { auditRouter } from "./routes/audit";
import { metricsRouter } from "./routes/metrics";
import { simulationRouter } from "./routes/simulation";
import { startScheduler } from "./services/scheduler";

const app = express();

// CORS: a single explicit allowed origin, never a wildcard, per deployment requirements.
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
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
app.use("/api/recovery", recoveryRouter);
app.use("/api/policies", policiesRouter);
app.use("/api/audit", auditRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/simulation", simulationRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`[server] RazorRecover backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startScheduler();
});
