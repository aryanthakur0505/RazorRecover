// Shared constants & lightweight types used across the deterministic engine.
// Amounts are always in paise (integer) to avoid floating point drift.

export const RECOVERY_COST = {
  // Flat, deterministic assumed cost per action (paise). Documented, not invented on the fly —
  // used consistently for every attempt so ROI numbers are reproducible.
  RETRY: 200, // ₹2 — simulated gateway/processing cost of an auto retry
  PAYMENT_LINK: 500, // ₹5 — assumed messaging/notification cost to deliver the link
  // ₹150 — a human agent's time on one manual follow-up call/email (~10-15min at a modest
  // loaded rate), not free labor. Was 0 for a while, which understated total recovery cost by
  // however much revenue came through ESCALATE — the exact case a Net ROI in the hundreds-of-x
  // range should have been a signal to go check, not a number to display uncritically.
  ESCALATE: 15000,
  STOP: 0, // no action was taken, so genuinely free
  // ₹250 — negotiating the plan (like ESCALATE) plus servicing it over several months (monthly
  // reminders/collection instead of one contact). Charged once, at plan creation, regardless of
  // whether it later completes or defaults — the cost was incurred either way.
  EMI_PLAN: 25000,
} as const;

// Cost per reasoning call (paise), used only when an attempt actually escalates to the AI layer.
// Groq's free tier has no per-call charge, so this is 0 by default — if you switch GROQ_BASE_URL
// to a paid provider (e.g. OpenAI), change this to a real flat estimate for that provider's
// pricing so ROI numbers stay honest instead of silently treating AI calls as free when they
// aren't.
export const AI_COST_PER_CALL_PAISE = 0;

// Recovery score band that triggers AI reasoning instead of the pure deterministic path.
export const AI_ESCALATION_SCORE_BAND = { min: 35, max: 65 } as const;

// Minimum recovery score for a direct RETRY (frictionless auto-attempt, no customer action) instead
// of a PAYMENT_LINK (customer has to click). Was 70 — that left a wide 10-69 band, including scores
// that mean "more likely than not to succeed" (50+), getting downgraded to a customer-facing link
// instead of just trying again automatically. 50 is the natural cut: below it, the model thinks
// recovery is a coin-flip-or-worse, so it's worth asking the customer to act instead of silently
// re-attempting; 50 and up, a direct retry is the odds-on-favorite move and doesn't need to bother
// them at all. Deliberately still above AI_ESCALATION_SCORE_BAND's floor (35) — the ambiguous band
// keeps getting a real AI look before any of this fires, this only changes the deterministic default.
export const RETRY_SCORE_THRESHOLD = 50;

// Flat assumed success rate for a human's manual follow-up after approving an ESCALATE — used
// only by the simulation engine (there's no automated recovery score to lean on here; that score
// is deliberately forced to 0 for suspicious payments). A documented modeling assumption, not a
// measured figure: most human-reviewed escalations turn out to be resolvable, but not all.
export const ESCALATION_MANUAL_RESOLUTION_RATE = 0.4;

// Simulated RETRY outcomes previously used `recoveryScore / 100` as the success probability with
// no adjustment — a plausible but pessimistic modeling choice, since it treats the risk score as
// if it were the *only* thing separating a recovered payment from a lost one. In practice a
// meaningful share of "failed" payments are transient (a card auto-retries fine the next day) —
// an effect the raw score doesn't capture. This flat, documented uplift models that: it does NOT
// change the recovery score itself (decisionEngine's thresholds are untouched, and live/webhook-
// resolved outcomes never touch this constant at all — only the *simulated* outcome roll for a
// RETRY attempt specifically). Capped below 1.0 so even a top-scored attempt can still genuinely
// fail — this is an optimism adjustment, not a guarantee.
export const SIMULATED_RECOVERY_OPTIMISM_BOOST = 0.15;
export const SIMULATED_RECOVERY_MAX_PROBABILITY = 0.92;

// PAYMENT_LINK (and EMI installment collection, which is just a payment link sent monthly) is a
// fundamentally different mechanism from RETRY: RETRY is a frictionless automatic charge, while
// a payment link requires the customer to actually notice it, open it, and manually complete
// payment. Real-world dunning data backs this up plainly — a payment link's conversion is
// "substantially lower" than an automated retry at the same underlying risk level, not the same
// or better. So instead of RETRY's optimism boost, PAYMENT_LINK carries a flat friction penalty
// on the same base (recoveryScore / 100) — modeling the real cost of requiring customer action,
// not assuming it converts as well as an auto-charge just because the score is the same.
export const PAYMENT_LINK_FRICTION_PENALTY = 0.1;
export const SIMULATED_RECOVERY_MIN_PROBABILITY = 0.05; // never literally zero -- some fraction of links do get clicked even on a weak case

export interface ScoreFactor {
  factor: string;
  impact: number; // signed contribution to the 0-100 score
  detail: string;
}

export interface ScoreResult {
  score: number;
  factors: ScoreFactor[];
}

export interface CustomerRecoveryStats {
  totalSuccessfulPayments: number;
  totalFailedPayments: number;
  previousRecoveryAttempts: number;
  previousRecoverySuccesses: number;
  recentlyContacted: boolean; // within policy communication window
  hoursSinceLastPayment: number | null;
}

export type DecisionSource = "DETERMINISTIC" | "AI";

export interface DecisionResult {
  action: "RETRY" | "PAYMENT_LINK" | "STOP" | "ESCALATE" | "EMI_PLAN";
  source: DecisionSource;
  confidence: number; // 0-1
  riskFlags: string[];
  decisionFactors: ScoreFactor[];
  recommendedChannel?: "AUTO_DEBIT" | "PAYMENT_LINK" | "NONE";
  cause?: string;
  requiresApproval: boolean;
  approvalReason?: string;
}

export interface PolicyCheckResult {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface PolicyEvaluation {
  allowed: boolean;
  checks: PolicyCheckResult[];
  requiresApproval: boolean;
  approvalReason?: string;
  stopReason?: string;
}

// ---------------------------------------------------------------------------
// EMI / installment plans (INSUFFICIENT_FUNDS recovery)
// ---------------------------------------------------------------------------

// Below this amount, splitting into monthly installments isn't worth the overhead for either
// side — offer the normal RETRY/PAYMENT_LINK path instead. Matches the policy's default
// maxAutoRecoveryAmount, which is not a coincidence: amounts this large already require a human
// to look at the case, and an EMI offer is exactly the kind of judgment call that human should
// be the one making.
export const EMI_MIN_AMOUNT_PAISE = 500_000; // ₹5,000

export const EMI_TENURE_OPTIONS_MONTHS = [6, 12, 24] as const;
export type EmiTenureMonths = (typeof EMI_TENURE_OPTIONS_MONTHS)[number];

// Flat (simple) annual interest rate, the SAME across every tenure by deliberate policy choice —
// a 24-month plan costs more in total only because interest accrues over more months, not
// because the rate itself is higher. Flat/simple interest (not reducing-balance) is used because
// it's transparent and easy to explain to a customer on a recovery call: "15% a year on what you
// owe, spread evenly." A real product would let a merchant tune this per-policy; here it's a
// single documented constant so every plan in the system is priced identically and reproducibly.
export const EMI_ANNUAL_INTEREST_RATE_BPS = 1500; // 15.00% p.a.

// A plan defaults (remaining balance goes back into the normal recovery pipeline as a fresh
// STOP/ESCALATE candidate) after this many *consecutive* missed installments — one missed month
// isn't treated as a lost cause (people are late for all kinds of reasons), but a pattern is.
// 3 matches how real Indian lenders actually grade this under RBI's IRAC norms: SMA-0 (1 missed
// payment) and SMA-1 (2 in a row) are just early-warning stages, not default -- an account is
// only classified NPA/default at 90+ days overdue, which for a monthly EMI is 3 consecutive
// misses. A customer who resumes paying before that resets the clock instead of staying "in
// default" over one or two isolated bad months (see completePlan in emiService.ts).
export const EMI_DEFAULT_AFTER_CONSECUTIVE_MISSES = 3;

// A PAYMENT_LINK or ESCALATE attempt used to resolve won/lost the instant it was sent -- honest
// about the guardrails, dishonest about timing: a real customer doesn't decide in zero seconds.
// This is how long the attempt sits as "still recovering" (status EXECUTED) before the simulated
// outcome is actually decided -- matching the same real-world dunning data that says most
// recovery happens within the first few days, not instantly (see executionService.ts's
// resolveOrAwaitCustomerResponse). RETRY is deliberately excluded -- an auto-debit resolves via
// the bank almost immediately in real life, there's nothing to wait for there.
export const CUSTOMER_RESPONSE_WINDOW_DAYS = 3;

// The customer picks the tenure, not the merchant — an EMI_PLAN attempt sends an offer with all
// three EMI_TENURE_OPTIONS_MONTHS and waits. This is how long they have to respond before the
// offer expires and the payment goes back into the normal recovery pipeline (see
// emiService.resolveOfferIfDue).
export const EMI_OFFER_WINDOW_DAYS = 7;

// Probability the customer responds to the offer AT ALL within the window (separate from, and a
// bit more generous than, SIMULATED_RECOVERY_OPTIMISM_BOOST — clicking "choose a plan" is a
// lower bar than actually paying, so a customer more readily engages with an offer than commits
// to completing one). Capped at SIMULATED_RECOVERY_MAX_PROBABILITY, same reasoning as elsewhere:
// even a well-scored customer can simply ignore a message.
export const EMI_OFFER_RESPONSE_BOOST = 0.2;

// Which tenure a responding customer picks isn't uniform — real EMI take-up skews toward shorter
// terms for smaller amounts (less benefit to stretching a small bill over 2 years) and toward
// longer terms as the amount grows (spreading a big bill thinner matters more). Bands are
// evaluated in order, first match by principalAmount (paise) wins.
export const EMI_TENURE_WEIGHTS_BY_AMOUNT: { maxAmount: number; weights: Record<EmiTenureMonths, number> }[] = [
  { maxAmount: 1_000_000, weights: { 6: 0.6, 12: 0.3, 24: 0.1 } }, // < ₹10,000
  { maxAmount: 2_500_000, weights: { 6: 0.3, 12: 0.45, 24: 0.25 } }, // ₹10,000–₹25,000
  { maxAmount: Infinity, weights: { 6: 0.15, 12: 0.35, 24: 0.5 } }, // ≥ ₹25,000
];

// Cost of sending the offer itself (a payment-link-style message with the 6/12/24 options) — same
// order of magnitude as PAYMENT_LINK's messaging cost, charged whether or not the customer ever
// responds. Distinct from (and much smaller than) RECOVERY_COST.EMI_PLAN, which is the cost of
// actually negotiating-and-servicing an ACCEPTED plan — that fuller cost only applies once a
// tenure is chosen and the plan starts running.
export const EMI_OFFER_ONLY_COST = 500; // ₹5
