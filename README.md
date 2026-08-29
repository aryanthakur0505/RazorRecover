# RazorRecover — AI Revenue Recovery Agent

An AI-assisted system that detects failed/at-risk Razorpay payments, diagnoses why they failed,
scores their recoverability, recommends a bounded recovery action, enforces that recommendation
against merchant guardrails, executes it through Razorpay **Test Mode**, and measures the actual
gross and net revenue recovered — with a full audit trail.

> **Not** "ChatGPT connected to Razorpay." The AI is a reasoning layer that sits on top of a
> deterministic backend. It recommends; it never executes. A backend policy engine decides what's
> allowed, and only allowed actions ever reach Razorpay.

## Problem statement

Failed and abandoned payments are silent revenue leaks. Merchants either do nothing, or blast
every failure with the same blunt retry/email regardless of *why* it failed, the customer's
history, or the risk of the payment being fraudulent. RazorRecover replaces that with a
per-payment, explainable, guardrailed recovery decision — and reports the net economics of
running it.

## Core flow

```
Razorpay Event → Verified Webhook → Idempotency → Failure Classification → Recovery Score
  → Decision Engine (+ AI reasoning for ambiguous cases only) → Policy/Guardrail Check
  → Human Approval (if required) → Razorpay Action (Test Mode) → Outcome
  → Net Revenue Calculation → Audit Log
```

## Architecture

```
frontend/  Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + Recharts + SWR
                │  fetch, credentials: include, NEXT_PUBLIC_API_URL
                ▼
backend/   Express + TypeScript
  ├─ routes/        webhooks, session, payments, recovery, policies, audit, metrics, simulation
  ├─ services/
  │   ├─ classification.ts     deterministic failure → category
  │   ├─ scoring.ts            deterministic 0-100 recovery score (+explainable factors)
  │   ├─ decisionEngine.ts     deterministic action + AI-escalation gate + dunning schedule
  │   ├─ policyEngine.ts       guardrails — the ONLY place allowed to say "execute"
  │   ├─ executionService.ts   idempotency → re-verify → re-check policy → Razorpay call → audit
  │   ├─ aiAgent.ts / aiTools.ts   Groq tool-calling, data-minimized, structured output
  │   ├─ simulationService.ts  seeded synthetic dataset generator (same engine, no fake logic)
  │   └─ scheduler.ts          polls due dunning retries (no Redis/queue — v1 simplicity)
  └─ prisma/schema.prisma      Merchant, Customer, Payment, RecoveryAttempt, RecoveryPolicy,
                               AuditLog, WebhookEvent (idempotency ledger)
                │
                ▼
         PostgreSQL (hosted)          Razorpay Test Mode API          Groq API
```

**The AI never touches money.** `aiAgent.ts` runs a bounded tool-calling loop (read-only,
data-minimized tools) and must end by calling `submit_recovery_recommendation`, validated against
a strict Zod schema. That recommendation is just another input to `decisionEngine`/`policyEngine`
— the same guardrails apply whether the recommendation came from a human, the deterministic
engine, or the AI.

**The AI is not called per payment.** Only payments the deterministic engine flags as ambiguous
(recovery score in a middle band, an unclassifiable failure reason, or conflicting signals across
attempts) are escalated to Groq. Routine cases — the majority — never make an LLM call. A
1000-payment simulation makes **zero** Groq calls by design (see "Simulation mode" below).

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js, TypeScript, Tailwind CSS, shadcn/ui, lucide-react, Recharts, SWR |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL + Prisma ORM |
| AI | Groq API — free, OpenAI-compatible (tool/function calling, structured outputs) |
| Payments | Razorpay Test Mode APIs |
| Validation | Zod (webhooks, AI output, API DTOs) |
| Deployment | Frontend → Vercel · Backend → Render · DB → any hosted Postgres |

## Repository layout

```
backend/    Express API — see backend/.env.example
frontend/   Next.js app — see frontend/.env.example
render.yaml Render blueprint for the backend
```

## Local setup

Prerequisites: Node 20+, npm, a PostgreSQL database (local or hosted — e.g. [Neon](https://neon.tech)
or [Supabase](https://supabase.com) both have a free tier that works fine here), a Razorpay Test
Mode account, and (optionally) a free Groq API key.

### 1. Database

Create a Postgres database and copy its connection string. Any host works as long as it's
reachable from where the backend runs.

### 2. Backend

```bash
cd backend
cp .env.example .env      # fill in DATABASE_URL, Razorpay keys, Groq key, SESSION_SECRET
npm install
npx prisma migrate dev --name init   # creates tables
npm run seed                          # creates the demo merchant + default policy
npm run dev                           # http://localhost:4000
```

`GET /health` should return `{"status":"ok",...}` once running.

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install
npm run dev                  # http://localhost:3000
```

Open `http://localhost:3000` — the app calls `POST /api/session/init` on load, which
finds-or-creates a single demo merchant and sets a signed session cookie (no login screen, per
the hackathon scope).

## Environment variables

**Backend** (`backend/.env`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PORT` | Server port (Render sets this automatically) |
| `FRONTEND_URL` | Exact origin allowed by CORS — never a wildcard |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Test Mode API credentials |
| `RAZORPAY_WEBHOOK_SECRET` | Used to verify the `X-Razorpay-Signature` header |
| `GROQ_API_KEY` | Optional — if unset, the AI layer reports "unavailable" and every ambiguous case is escalated to human review instead. Free key at console.groq.com |
| `GROQ_MODEL` | Defaults to `openai/gpt-oss-120b` |
| `GROQ_BASE_URL` | Defaults to Groq's endpoint — only change this to point at a different OpenAI-compatible provider instead |
| `SESSION_SECRET` | Signs the mock merchant session cookie |

**Frontend** (`frontend/.env.local`):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the backend (no trailing slash) |

## Database setup & migrations

```bash
cd backend
npx prisma migrate dev       # local development — creates/updates tables
npx prisma migrate deploy    # production — applies pending migrations only
npx prisma studio            # optional GUI to inspect data
```

The seed script (`npm run seed`) is idempotent — safe to re-run.

## Razorpay Test Mode setup

1. Sign up at [dashboard.razorpay.com](https://dashboard.razorpay.com) and switch to **Test Mode**.
2. Settings → API Keys → generate a Test key, copy the Key ID/Secret into `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`.
3. Settings → Webhooks → Add New Webhook:
   - URL: `https://<your-backend>/api/webhooks/razorpay` (use an ngrok/tunnel URL for local testing)
   - Secret: any string — put the same value in `RAZORPAY_WEBHOOK_SECRET`
   - Events: `payment.failed`, `order.paid` (add `payment.captured` too if you want retry outcomes to resolve on that event as well)
4. Trigger a test failure from the Razorpay test checkout (use a [test card](https://razorpay.com/docs/payments/payments/test-card-upi-details/) configured to fail) and watch it flow through Recovery Operations.

### Webhook idempotency & signature verification

`POST /api/webhooks/razorpay` is mounted with `express.raw()` so the HMAC-SHA256 signature is
verified over the exact bytes Razorpay sent (`services/razorpay.ts#verifyWebhookSignature`, using
`crypto.timingSafeEqual`). An unverified request is rejected with 400 and never processed. Each
event is deduped by a derived id (`event:entityId:timestamp`) stored in `WebhookEvent` — a
redelivered webhook is acknowledged with 200 but is a no-op.

## AI setup (Groq)

Set `GROQ_API_KEY` in `backend/.env` — get a free key at [console.groq.com](https://console.groq.com)
(no credit card required). If omitted, the backend runs fine — the dashboard shows the agent as
"Unavailable" and ambiguous cases are routed straight to human approval instead of being silently
guessed at. The agent only ever receives operational fields (see "Data minimization" below) via a
fixed set of read-only tools, and its only write action is a structured recommendation that the
policy engine independently re-evaluates.

**Using a different provider instead?** Set `GROQ_BASE_URL` and `GROQ_MODEL` to point the same
client elsewhere — no code changes needed, since this just needs an OpenAI-compatible
chat-completions + tool-calling API, which several providers mirror exactly:

| Provider | `GROQ_BASE_URL` | `GROQ_MODEL` |
|---|---|---|
| [Groq](https://console.groq.com) (free, no card) — default | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| [Gemini](https://aistudio.google.com) (free tier) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.0-flash` |
| OpenAI | `https://api.openai.com/v1` (or omit) | `gpt-4o-mini` |

Note that an OpenAI key specifically needs **billing credits** added at
platform.openai.com/settings/organization/billing before calls succeed — a fresh API key with $0
credits authenticates fine but every call fails with a 429 `insufficient_quota` error, which the
agent treats the same as "unavailable" (falls back to human review). Groq's free tier doesn't have
this requirement.

## Data minimization

The AI never sees card numbers, CVV, bank credentials, passwords, or Razorpay secrets — Razorpay
itself never gives the backend those either. It also never sees customer name/email/phone; its
tools return only operational aggregates: payment id/amount/status/category, and counts like
previous successful/failed payments, previous recovery attempts/success rate, and time since last
payment.

## Simulation mode

From the Executive Command Center, pick 100 / 500 / 1000 and run a simulation. It generates a
seeded (mulberry32 PRNG) synthetic dataset of customers and payments — a realistic mix of
successful payments and failures across all categories, amounts, and histories — and runs every
one of them through the **exact same** classification → scoring → decision → policy →
execution → audit pipeline as live traffic. The only thing swapped out is the Razorpay network
call itself (replaced with a synthetic response shaped like a real one), so 1000 payments doesn't
mean 1000 real Test Mode API calls or 1000 Groq calls. Same seed → same dataset → reproducible
results.

## Recovery workflow

`RETRY` → creates a fresh Razorpay Order (Test Mode can't silently re-charge a failed card) with a
dunning delay per attempt number. `PAYMENT_LINK` → creates a real Razorpay Payment Link. `STOP` →
halts automation, no external call. `ESCALATE` → routes to human approval (always used for
suspicious payments). A background scheduler (1-minute interval scan — no Redis/queue needed at
this scale) picks up attempts whose scheduled time has arrived.

## Guardrails (policy engine)

Enforced in `services/policyEngine.ts`, independent of who recommended the action:

- **Retry limit** — no more than `maxRetries` attempts per payment
- **Amount limit** — auto-execution capped at `maxAutoRecoveryAmount`; above it, requires merchant approval
- **Communication limit** — at most `maxCommunicationsPerPeriod` payment links per customer per `communicationPeriodHours`
- **Suspicious payment rule** — `RETRY`/`PAYMENT_LINK` forbidden outright
- **Payment state rule** — never acts on an already-captured/refunded payment
- **Quiet hours** — no automated retry/link inside the configured window
- **Minimum retry spacing** — enforces `minRetryIntervalMinutes` between attempts

All are editable from Policies & Audit and take effect immediately on the next evaluation.

## Idempotency

Every recovery attempt gets a key = `sha256(paymentId:attemptNumber:action)`, stored as a unique
column. `executionService` checks it before doing anything; a repeated trigger (duplicate webhook,
scheduler re-scan, double-click) is a safe no-op. Webhook events are separately deduped in
`WebhookEvent` before any business logic runs.

## Revenue / ROI calculation

All figures are computed live from stored rows — nothing is hard-coded:

- **Revenue at risk** = sum of currently-`FAILED` payment amounts
- **Gross revenue recovered** = sum of `revenueRecovered` across attempts
- **Recovery cost** = sum of `recoveryCost` (flat assumed per-action cost + AI cost when used)
- **Net recovered revenue** = gross recovered − recovery cost
- **Recovery rate** = succeeded / (succeeded + failed) resolved attempts
- **Net ROI** = net recovered revenue / recovery cost

## Audit trail

`AuditLog` is append-only — no route anywhere updates or deletes a row. Every webhook receipt,
score calculation, AI recommendation, policy check, approval decision, execution, and outcome
writes a new row, visible on the Policies & Audit screen.

## Deployment

### Backend → Render

Use the included `render.yaml` (Render → New → Blueprint), or manually:
- Root directory: `backend`
- Build: `npm install && npm run build && npx prisma migrate deploy`
- Start: `npm start`
- Health check path: `/health`
- Set all env vars from the table above (`FRONTEND_URL` = your Vercel URL)

### Frontend → Vercel

- Root directory: `frontend`
- Framework preset: Next.js (auto-detected)
- Env var: `NEXT_PUBLIC_API_URL` = your Render backend URL

### Database → hosted Postgres

Any provider works (Neon, Supabase, Render Postgres, RDS). Point `DATABASE_URL` at it and run
`npx prisma migrate deploy` once (the Render build command above does this automatically on
every deploy).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Frontend shows "Backend unavailable" | `NEXT_PUBLIC_API_URL` wrong/unreachable, or backend crashed on boot (check env vars) |
| CORS error in browser console | `FRONTEND_URL` on the backend doesn't exactly match the frontend's origin |
| Webhook returns 400 | Signature mismatch — `RAZORPAY_WEBHOOK_SECRET` doesn't match what's configured in the Razorpay Dashboard |
| `prisma migrate` fails to connect | `DATABASE_URL` unreachable — check host/port/SSL mode (`?sslmode=require` for most hosted Postgres) |
| Agent status shows "Unavailable" | `GROQ_API_KEY` not set — this is a safe, expected fallback, not a bug |
| Simulation seems stuck at "Simulating…" | Check the backend logs — 1000 payments processed sequentially can take up to ~30-60s |
