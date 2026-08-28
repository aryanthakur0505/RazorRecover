import { Router } from "express";
import { randomUUID } from "crypto";
import { requireSession } from "../middleware/session";
import { asyncHandler } from "../middleware/errorHandler";
import { simulationRequestSchema } from "../schemas/api";
import { runSimulation, SimulationSummary } from "../services/simulationService";

export const simulationRouter = Router();
simulationRouter.use(requireSession);

interface SimJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  processed: number;
  total: number;
  result?: SimulationSummary;
  error?: string;
}

// In-memory job tracker — fine for a single-instance hackathon deployment; a real multi-instance
// deployment would move this to the database or a shared cache, which is out of scope here.
const jobs = new Map<string, SimJob>();

simulationRouter.post(
  "/run",
  asyncHandler(async (req, res) => {
    const body = simulationRequestSchema.parse(req.body);
    const jobId = randomUUID();
    const merchantId = req.merchantId!;

    jobs.set(jobId, { status: "RUNNING", processed: 0, total: body.size });
    res.json({ jobId });

    // Fire-and-forget: the frontend polls GET /:jobId for progress/result.
    runSimulation(merchantId, body.size, body.seed ?? 42, (processed, total) => {
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, processed, total });
    })
      .then((result) => {
        jobs.set(jobId, { status: "COMPLETED", processed: body.size, total: body.size, result });
      })
      .catch((err) => {
        console.error("[simulation] run failed:", err);
        jobs.set(jobId, {
          status: "FAILED",
          processed: 0,
          total: body.size,
          error: err instanceof Error ? err.message : "Simulation failed",
        });
      });
  }),
);

simulationRouter.get(
  "/:jobId",
  asyncHandler(async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Simulation job not found" });
      return;
    }
    res.json(job);
  }),
);
