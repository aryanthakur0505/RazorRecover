# RazorRecover

**An AI-assisted revenue recovery engine for Razorpay — it figures out why a payment failed, decides what to do about it, and never lets an AI or a human skip the guardrails.**

## Overview

Every payment gateway loses money to failed and abandoned payments. Most merchants handle this the same blunt way: retry every failure with the same email or the same charge attempt, regardless of *why* it failed, who the customer is, or whether retrying is even a good idea. That wastes money on payments that were never going to recover and misses payments that would have, with a smarter approach.

RazorRecover replaces that blunt retry with a deterministic, explainable pipeline: every failed payment is classified, scored, and assigned a bounded action (retry, send a payment link, split into EMI, stop, or escalate to a human). An AI reasoning layer (via Groq) is consulted **only** for the genuinely ambiguous cases — it never touches money directly, and every one of its recommendations still has to pass the same policy engine a human-made decision would. The system also measures itself: a "Shadow Mode" records what the plain deterministic engine would have done on every AI-assisted case, so the AI's actual value is a measured number, not an assumption.

## Key Features

- **Deterministic failure classification & recovery scoring** — every failed payment gets a 0–100 recoverability score built from explainable factors (prior payment history, time since failure, amount, retry history), not a black box.
- **Bounded AI escalation** — only payments in an ambiguous score band or with an unclassifiable failure reason reach the AI; routine cases are decided by rules alone, so a 1,000-payment simulation makes zero AI calls by design.
- **Policy engine as the sole execution gate** — retry limits, auto-recovery amount caps, communication limits, quiet hours, minimum retry spacing, suspicious-payment blocking, and a per-customer do-not-contact list are all enforced independently of who (or what) recommended the action.
- **AI Shadow Mode** — every AI-assisted decision is compared against what the deterministic engine alone would have done on the same input, giving a real, measured "did the AI actually help" number instead of a guess.
- **EMI / promise-to-pay** — an `INSUFFICIENT_FUNDS` payment can be offered a 6/12/24-month installment plan (flat interest, customer picks the tenure via a public link, no login); a promise made on a follow-up call is logged the same way as a single-installment plan.
- **Bulk operations at any scale** — approve/reject a handful of items by checkbox, or "select all N matching this filter" and let a background job process the whole backlog with progress polling.
- **Idempotent, signature-verified webhooks** — Razorpay webhooks are HMAC-verified over the raw request body and deduplicated by a derived event id before any business logic runs.
- **Real multi-tenant accounts** — email/password signup and login, each merchant's data (customers, payments, policies, audit log) fully isolated, and each merchant connects their own Razorpay Test Mode account with credentials encrypted at rest.
- **Append-only audit trail** — every webhook, score calculation, AI recommendation, policy check, approval, execution, and outcome is written as a permanent row; nothing is ever edited or deleted.
- **Seeded simulation mode** — generate a reproducible synthetic dataset (100/500/1,000 payments) that runs through the exact same pipeline as live traffic, for testing and demos without needing real webhook traffic.

## How It Works

```
Razorpay webhook → signature verification → idempotency check → failure classification
  → recovery score (0–100) → decision engine (+ AI escalation for ambiguous cases only)
  → policy/guardrail check → human approval (if required) → Razorpay action (Test Mode)
  → outcome recorded → net revenue calculated → audit log
```

1. **Input** — a `payment.failed` webhook from Razorpay (or a synthetic event from the simulation engine).
2. **Classification** — `classification.ts` deterministically maps the raw failure reason to a category (`INSUFFICIENT_FUNDS`, `TEMPORARY_FAILURE`, `EXPIRED_PAYMENT`, `CHECKOUT_ABANDONED`, `SUSPICIOUS_PAYMENT`, `OTHER`).
3. **Scoring** — `scoring.ts` computes a 0–100 recovery score from explainable factors (customer's payment history, time since failure, amount, prior attempt outcomes).
4. **Decision** — `decisionEngine.ts` picks an action (`RETRY`, `PAYMENT_LINK`, `STOP`, `ESCALATE`, or `EMI_PLAN`) deterministically. If the score falls in a mid-range band or the failure reason is unclassifiable, the case is escalated to the AI reasoning layer instead.
5. **AI reasoning (ambiguous cases only)** — `aiAgent.ts` runs a bounded, data-minimized tool-calling loop against Groq's OpenAI-compatible API and must end by calling a schema-validated `submit_recovery_recommendation` tool. The AI never sees card numbers, bank details, or customer PII — only operational aggregates. Its recommendation is just another input to the same decision path a human or the deterministic engine would produce.
6. **Guardrail check** — `policyEngine.ts` independently re-validates the chosen action against the merchant's live policy (retry limits, amount caps, quiet hours, do-not-contact, suspicious-payment blocking) regardless of where the recommendation came from.
7. **Execution** — `executionService.ts` checks the idempotency key, re-verifies the policy one more time, and only then calls the Razorpay Test Mode API (or a synthetic response during simulation).
8. **Outcome & audit** — the result (recovered / not recovered / stopped), gross revenue, recovery cost, and net revenue are recorded, and every step of the above writes an audit log row.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui (Radix UI primitives), Recharts, SWR, sonner (toasts), next-themes |
| Backend | Node.js, Express 4, TypeScript, Zod (schema validation) |
| Database | PostgreSQL via Prisma ORM |
| AI | Groq API (OpenAI-compatible chat completions + tool calling), accessed via the official `openai` SDK client |
| Payments | Razorpay Test Mode API (`razorpay` npm package) |
| Testing | Vitest |
| Dev tooling | tsx (TS execution/watch), ESLint |
| Deployment | Render (backend, via `render.yaml`) · Vercel (frontend) · any hosted PostgreSQL (Neon, Supabase, Render Postgres, etc.) |

## Project Structure

```
RazorRecover/
├── render.yaml                   # Render blueprint for the backend service
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma         # Merchant, Customer, Payment, RecoveryAttempt, RecoveryPolicy,
│   │   │                         # InstallmentPlan, Installment, AuditLog, WebhookEvent
│   │   ├── migrations/           # versioned SQL migrations
│   │   └── seed.ts               # creates the demo merchant + default policy
│   ├── scripts/
│   │   ├── seed-ai-demo.ts       # seeds a few named, real-Groq-call AI demo cases
│   │   ├── import-test-cases.ts  # runs a hand-written JSON dataset through the real pipeline
│   │   ├── convert-paysim.ts     # converts the public PaySim dataset into test-case format
│   │   ├── reset-all-data.ts     # wipes all payment/customer/attempt data for a clean slate
│   │   └── check-breakdown.ts    # ad-hoc data inspection helper
│   └── src/
│       ├── routes/               # webhooks, session, payments, recovery, policies, audit,
│       │                         # metrics, simulation, customers, installmentPlans, publicOffers
│       ├── services/
│       │   ├── classification.ts      # deterministic failure → category
│       │   ├── scoring.ts             # deterministic 0–100 recovery score
│       │   ├── decisionEngine.ts      # deterministic action + AI-escalation gate
│       │   ├── policyEngine.ts        # guardrails — the only place allowed to say "execute"
│       │   ├── executionService.ts    # idempotency → re-verify → Razorpay call → audit
│       │   ├── aiAgent.ts / aiTools.ts # Groq tool-calling, data-minimized
│       │   ├── emiService.ts          # EMI plan / promise-to-pay logic
│       │   ├── simulationService.ts   # seeded synthetic dataset generator
│       │   └── scheduler.ts           # polls due dunning retries and installment due-dates
│       ├── middleware/           # session auth, error handling
│       └── schemas/              # Zod schemas (API DTOs, webhook payloads, AI output)
└── frontend/
    ├── app/                      # Command Center, Recovery Operations, Policies & Audit,
    │                             # EMI & Promise Plans, Customers, public offer page
    ├── components/
    │   ├── dashboard/            # metric cards, charts, AI Impact / Shadow Mode card
    │   ├── operations/           # opportunity table, decision drawer, bulk action bar
    │   ├── plans/ policies/ customers/  # feature-specific views
    │   └── ui/                   # shadcn/ui primitives
    ├── hooks/                    # SWR data-fetching hooks
    └── lib/                      # API client, formatting, shared types
```

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- A PostgreSQL database (local, or a free hosted tier like [Neon](https://neon.tech) or [Supabase](https://supabase.com))
- A [Razorpay](https://dashboard.razorpay.com) account with **Test Mode** enabled
- (Optional) A free [Groq](https://console.groq.com) API key — the app works without one, it just routes every ambiguous case to human review instead

### Installation

**Backend:**

```bash
cd backend
cp .env.example .env        # fill in DATABASE_URL, Groq key, SESSION_SECRET
npm install
npx prisma migrate dev --name init   # creates the database tables
npm run seed                          # creates a demo merchant (login: demo@razorrecover.local / demo12345) + default policy
npm run dev                           # starts the API on http://localhost:4000
```

Verify it's running: `GET http://localhost:4000/health` should return `{"status":"ok", ...}`.

**Frontend:**

```bash
cd frontend
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install
npm run dev                  # starts the app on http://localhost:3002
```

Open `http://localhost:3002` — you'll land on the login screen. Log in with the seeded demo account (`demo@razorrecover.local` / `demo12345`), or sign up for a new one; each account's data (customers, payments, policies) is fully isolated from every other merchant's.

### Other useful commands

```bash
# backend/
npm run build            # compile TypeScript + generate Prisma client
npm run typecheck         # type-check without emitting
npm test                  # run the Vitest test suite
npm run seed:ai-demo       # seed a few named AI-escalated demo cases (real Groq calls)
npm run reset:all          # wipe all payment/customer/attempt data for a clean slate
npx prisma studio          # inspect the database with a GUI
```

## Environment Variables

**Backend** (`backend/.env`):

| Variable | Purpose |
|---|---|
| `PORT` | Port the Express server listens on (Render sets this automatically in production) |
| `NODE_ENV` | `development` or `production` |
| `FRONTEND_URL` | Exact origin allowed by CORS — a single URL, never a wildcard |
| `DATABASE_URL` | PostgreSQL connection string |
| `GROQ_API_KEY` | Optional. If unset, the AI layer reports "unavailable" and every ambiguous case routes to human review instead |
| `GROQ_MODEL` | Model name for the Groq chat-completions API (defaults to `openai/gpt-oss-120b`) |
| `GROQ_BASE_URL` | OpenAI-compatible base URL — can point at a different compatible provider without code changes |
| `SESSION_SECRET` | Signs each merchant's session cookie; also the basis for encrypting stored Razorpay credentials at rest (see below) |

Razorpay credentials are **not** an env var — each merchant connects their own Razorpay Test Mode account from inside the app (log in → **Policies & Audit** → **Razorpay Connection**), since a payment-recovery tool only has anything to recover on the account whose checkout actually failed. Simulations don't need this at all; only live webhooks and real retries/payment links do.

**Frontend** (`frontend/.env.local`):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the backend API (no trailing slash) |

> None of the values above are real credentials — copy `.env.example` in each folder and fill in your own.

## Usage

1. **Log in** (`http://localhost:3002`) — with the seeded demo account or your own signup.
2. **Generate data** — from the Command Center, run a simulation:
   - **100** or **1,000** payments generates a fresh, randomized (but seed-reproducible) dataset every run.
   - **500** rebuilds a fixed, hand-specified demo dataset instead of a random one (400 succeed outright, 100 fail across a deliberate mix of recovered / not-recovered / never-attempted / AI-assisted / EMI cases) — useful when you want the exact same numbers every time, e.g. for a recorded demo.
3. **Work the queue** — go to **Recovery Operations**, filter to "Needs Approval", and open a payment to see its full decision: recovery score with factor breakdown, recommended action, every guardrail check, and (if AI-assisted) the AI's stated confidence. Approve, reject, or override a guardrail-blocked attempt.
4. **Check the AI honestly** — the **AI Impact — Shadow Mode** card on the Command Center shows, for every AI-assisted decision, what the deterministic engine would have done instead, and whether the AI's disagreements actually paid off.
5. **Manage guardrails** — **Policies & Audit** lets you edit retry limits, spending caps, and quiet hours live (no redeploy needed), manage the do-not-contact list, and search the complete append-only audit trail.
6. **EMI & Promise Plans** — view every installment plan and its month-by-month schedule; the public, token-based offer link (`/offer/[id]`) is what a customer would actually open to pick a tenure, no login required.

Example: checking the AI-escalation health of the system directly against the API —

```bash
curl -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
  -d '{"email":"demo@razorrecover.local","password":"demo12345"}' -c cookies.txt
curl -b cookies.txt -H "X-Requested-With: XMLHttpRequest" "http://localhost:4000/api/recovery/opportunities?status=AWAITING_APPROVAL&pageSize=1"
```

## Architecture / Technical Details

- **Frontend ↔ backend**: the Next.js app talks to the Express API over `fetch` with `credentials: "include"`, using a single `NEXT_PUBLIC_API_URL`. There's no server-side rendering dependency on the backend — it's a plain client-fetched SPA-style app on top of the App Router.
- **Auth**: real accounts (`routes/auth.ts`) — email + password (scrypt-hashed, `services/crypto.ts`), a signed HMAC session cookie (`SESSION_SECRET`) identifying the merchant, and a custom-header CSRF check (`middleware/session.ts`) on every mutating request. Every route scopes its queries by the session's merchantId, so one merchant's data is never reachable from another's session.
- **Multi-tenant Razorpay**: each merchant connects their own Razorpay Test Mode account (`routes/merchant.ts`) — the key secret and webhook secret are encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET`) and never read back out through any route. Webhooks are per-merchant (`/api/webhooks/razorpay/:merchantId`), verified against that merchant's own stored webhook secret.
- **Database access**: all backend data access goes through Prisma against PostgreSQL. The schema separates `Payment` (immutable facts about a transaction) from `RecoveryAttempt` (one row per action taken on it, with `attemptNumber` for dunning retries), and `InstallmentPlan`/`Installment` model EMI plans and logged promises with the same underlying tables.
- **Webhook integrity**: `POST /api/webhooks/razorpay` is mounted with `express.raw()` so the HMAC signature is verified over the exact bytes Razorpay sent, using `crypto.timingSafeEqual`. Each event is deduplicated by a derived id in the `WebhookEvent` table before anything else runs.
- **Idempotency**: every recovery attempt has an idempotency key (`sha256(paymentId:attemptNumber:action)`), checked by `executionService` before any Razorpay call — a duplicate webhook, a scheduler re-scan, or a double-click all resolve to a safe no-op.
- **AI boundary**: `aiAgent.ts` calls Groq only for the score band/failure category combinations the deterministic engine flags as ambiguous. It runs a bounded tool-calling loop with read-only, data-minimized tools and must terminate by calling a Zod-validated `submit_recovery_recommendation` tool — its output is treated as just another input to `decisionEngine`/`policyEngine`, never a direct trigger for execution.
- **Guardrails as a single chokepoint**: `policyEngine.ts` is the only code path allowed to authorize an action reaching Razorpay. It's invoked identically whether the recommendation came from the deterministic engine, the AI, or a human override — there's no separate "AI-trusted" path.
- **No queue infrastructure**: the background `scheduler.ts` polls for due dunning retries and installment due-dates on a fixed interval instead of using Redis or a message queue — a deliberate simplicity trade-off at this scale, noted directly in the code as something a multi-instance production deployment would need to revisit.
- **Bulk jobs**: the "select all N matching this filter" bulk-approve/reject flow runs as an in-memory tracked background job (bounded concurrency), polled by the frontend for progress — the same pattern the simulation engine uses for its own progress reporting.

## Deployment

**Backend → Render**, using the included `render.yaml` blueprint (Render → New → Blueprint):
- Root directory: `backend`
- Build command: `npm install --include=dev && npm run build && npx prisma migrate deploy`
- Start command: `npm start`
- Health check path: `/health`
- Environment variables are declared in `render.yaml`; the ones marked `sync: false` (database URL, Razorpay keys, Groq key, frontend URL) must be filled in manually in the Render dashboard. `SESSION_SECRET` is auto-generated by Render.

**Frontend → Vercel**:
- Root directory: `frontend`
- Framework preset: Next.js (auto-detected, zero extra config)
- Environment variable: `NEXT_PUBLIC_API_URL` set to the deployed Render backend URL

**Database**: any hosted PostgreSQL provider. Point `DATABASE_URL` at it and run `npx prisma migrate deploy` once — the Render build command above already does this on every deploy automatically.

## Challenges & Solutions

- **Guardrails had to apply no matter who made the recommendation.** It would have been easy to let the AI "trust itself" and skip a check a human override would still be subject to. The fix was architectural: `policyEngine.ts` is invoked as a single, final chokepoint before any Razorpay call, regardless of whether the recommended action came from the rules engine, the AI, or a manual override.
- **Proving the AI is actually useful, not just present.** Rather than assume an LLM improves outcomes, every AI-assisted decision also computes (but never acts on) what the deterministic engine alone would have chosen — "Shadow Mode" — so the AI's real, measured contribution (or lack of one) is visible on the dashboard instead of asserted in a README.
- **Idempotency across multiple retry sources.** A payment can be retried by a redelivered webhook, a scheduler re-scan, and a merchant's double-click, all for the same logical action. A deterministic idempotency key (`sha256(paymentId:attemptNumber:action)`) checked before every execution collapses all three into a single safe no-op.
- **Keeping AI cost and latency bounded at scale.** A 1,000-payment simulation calling an LLM for every row would be slow and expensive for no real benefit. The decision engine escalates only genuinely ambiguous cases (a narrow score band or an unclassifiable failure reason), and the simulation engine additionally caps AI calls per run — routine cases never make a network call at all.
- **Groq's free-tier rate limits are real during heavy testing.** Bulk-seeding several AI-escalated demo cases back-to-back can hit the per-minute token limit (`rate_limit_exceeded`); the code already treats a failed AI call the same as "unavailable" and falls back to human review rather than surfacing a hard error.
- **Reliable demo data without depending on live network calls.** Random-but-seeded simulation is reproducible in shape but not in exact narrative. For situations needing an identical result every run (e.g. recording a demo), `simulationService.ts` also supports a fixed, hand-specified dataset (the "500" option) that rebuilds the same numbers every time, with no live Groq calls involved.

## Future Improvements

- Replace the in-memory bulk-job/simulation-job tracker (a plain `Map`, explicitly noted in the code as single-instance-only) with a persisted job store for multi-instance deployments.
- Replace the interval-polling scheduler with a real queue (e.g. Redis-backed) once retry/installment volume outgrows a single-instance poll loop.
- Expand automated test coverage beyond the current `decisionEngine` / `policyEngine` / `scoring` unit tests (e.g. route-level integration tests, webhook signature edge cases).
- Support currencies other than INR (amounts are currently paise-denominated throughout).

## Screenshots / Demo

No screenshots or hosted demo links are currently checked into this repository. Recommended next step: run the app locally (see **Getting Started**), generate a simulation dataset, and add screenshots of the Command Center, Recovery Operations, and Policies & Audit screens here.

## License

No `LICENSE` file is currently present in this repository, so no license terms are specified.
