/**
 * Converts a PaySim-format CSV (columns: step, type, amount, nameOrig, oldbalanceOrg,
 * newbalanceOrig, nameDest, oldbalanceDest, newbalanceDest, isFraud, isFlaggedFraud) into this
 * project's test-case JSON format (see scripts/import-test-cases.ts).
 *
 * Honest limitation, worth knowing before you use this: PaySim logs COMPLETED mobile-money
 * transfers, not failed payments — it has no real "why did this fail" label. What this script
 * does is repurpose the two signals PaySim genuinely has (an account balance lower than the
 * transaction, and a fraud flag) into our failure categories; everything else is a best-effort
 * guess based on transaction `type`, not something the data actually tells you. Real payment-
 * gateway failure logs aren't public anywhere — this is the closest real-data stand-in, not a
 * perfect match.
 *
 * Sampling is STRATIFIED by derived category, not a plain "every Nth row" — fraud rows are only
 * ~8,000 out of 6.3 million in real PaySim (0.13%), so a uniform sample of a couple hundred rows
 * would almost certainly contain zero of them. Instead this fills a fixed quota PER category,
 * scanning as much of the file as it takes (up to a safety cap) to find enough of the rare ones,
 * so every category the decision engine cares about is actually represented in the output.
 *
 * Usage:
 *   npx tsx scripts/convert-paysim.ts path/to/paysim.csv [perCategoryQuota]
 *
 * Writes test-cases.json in the current directory, ready for:
 *   npx tsx scripts/import-test-cases.ts test-cases.json
 */
import fs from "fs";
import readline from "readline";

const FIRST_NAMES = [
  "Aarav", "Priya", "Rohan", "Ananya", "Vikram", "Sneha", "Aditya", "Kavya", "Rahul", "Meera",
  "Arjun", "Ishita", "Karan", "Neha", "Siddharth", "Pooja", "Manish", "Riya", "Yash", "Divya",
  "Harsh", "Aditi", "Nikhil", "Tanvi", "Akash", "Simran", "Dev", "Nisha", "Mohit", "Shreya",
];
const LAST_NAMES = [
  "Sharma", "Nair", "Mehta", "Gupta", "Joshi", "Kapoor", "Verma", "Reddy", "Singh", "Shah",
  "Malhotra", "Bansal", "Rao", "Sethi", "Iyer", "Khanna", "Arora", "Kaur", "Patel", "Kulkarni",
];

// Quotas match realistic day-to-day merchant traffic, not an equal per-category split and not a
// "make sure every path gets stress-tested" split either. Real fraud is under 1% of traffic, not
// 5-17% -- both earlier attempts at this still overweighted it enough to drag the whole batch's
// recovery rate down in a way normal traffic never would. This still guarantees every category
// has SOME real presence (nothing drops to zero, so decision-engine coverage is still checkable),
// just at genuinely typical, not artificially inflated, proportions.
const CATEGORY_QUOTAS: Record<(typeof CATEGORIES)[number], number> = {
  TEMPORARY_FAILURE: 50, // 25%
  CHECKOUT_ABANDONED: 44, // 22%
  INSUFFICIENT_FUNDS: 44, // 22%
  EXPIRED_PAYMENT: 30, // 15%
  OTHER: 28, // 14%
  SUSPICIOUS_PAYMENT: 4, // 2%
};
const CATEGORIES = [
  "SUSPICIOUS_PAYMENT",
  "INSUFFICIENT_FUNDS",
  "CHECKOUT_ABANDONED",
  "EXPIRED_PAYMENT",
  "TEMPORARY_FAILURE",
  "OTHER",
] as const;

// How many real data rows to scan before giving up on filling every quota -- fraud rows are rare
// enough that finding a full quota of them can require scanning a large chunk of the file.
const MAX_ROWS_TO_SCAN = 4_000_000;

/** Deterministic pseudo-random from a string, so the same PaySim customer ID always maps to the
 *  same fake name/probability roll across the whole file (not a fresh random pick per row). */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function nameFor(id: string) {
  const h = hashString(id);
  return `${FIRST_NAMES[h % FIRST_NAMES.length]} ${LAST_NAMES[(h >> 8) % LAST_NAMES.length]}`;
}

// PaySim amounts don't correspond to rupees at any realistic scale -- rescale into our typical
// ₹100-₹75,000 test range using a log-ish compression so both small and large PaySim amounts land
// somewhere plausible, rather than either all clustering tiny or a few blowing out to crores.
function rescaleAmount(paysimAmount: number): number {
  const rupees = Math.round(50 + Math.sqrt(paysimAmount) * 8);
  return Math.min(75000, Math.max(50, rupees));
}

function categoryFor(row: { type: string; isFraud: string; oldbalanceOrg: string; amount: string }) {
  if (row.isFraud === "1") return { category: "SUSPICIOUS_PAYMENT", suspicious: true };
  const oldBalance = Number(row.oldbalanceOrg);
  const amount = Number(row.amount);
  if (oldBalance > 0 && oldBalance < amount) return { category: "INSUFFICIENT_FUNDS", suspicious: false };
  // PaySim's `type` doesn't map to a real failure reason -- this is a best-effort guess, not a
  // derived fact, see the file-level doc comment above.
  const byType: Record<string, string> = {
    PAYMENT: "CHECKOUT_ABANDONED",
    TRANSFER: "OTHER",
    CASH_OUT: "EXPIRED_PAYMENT",
    DEBIT: "TEMPORARY_FAILURE",
    CASH_IN: "TEMPORARY_FAILURE",
  };
  return { category: byType[row.type] ?? "OTHER", suspicious: false };
}

async function main() {
  const filePath = process.argv[2];
  const scale = Number(process.argv[3] ?? 1); // multiply every category quota by this
  if (!filePath) {
    console.error("Usage: npx tsx scripts/convert-paysim.ts path/to/paysim.csv [scale]");
    process.exit(1);
  }
  const quotas = Object.fromEntries(CATEGORIES.map((c) => [c, Math.round(CATEGORY_QUOTAS[c] * scale)])) as Record<string, number>;
  console.log(`Quotas: ${CATEGORIES.map((c) => `${c}=${quotas[c]}`).join(", ")} (total ${Object.values(quotas).reduce((a, b) => a + b, 0)})`);

  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  let header: string[] | null = null;
  const seenCount = new Map<string, number>(); // nameOrig -> how many rows we've seen so far (for prior-history)
  const buckets = new Map<string, unknown[]>(CATEGORIES.map((c) => [c, []]));
  let rowIndex = 0;

  const isFull = () => CATEGORIES.every((c) => buckets.get(c)!.length >= quotas[c]);

  for await (const line of rl) {
    if (!header) {
      header = line.split(",");
      continue;
    }
    rowIndex++;
    if (rowIndex > MAX_ROWS_TO_SCAN || isFull()) break;

    const cols = line.split(",");
    const row = Object.fromEntries(header.map((h, i) => [h.trim(), cols[i]?.trim()])) as Record<string, string>;
    const custId = row.nameOrig;
    const priorCount = seenCount.get(custId) ?? 0;
    seenCount.set(custId, priorCount + 1);

    const { category, suspicious } = categoryFor(row as any);
    const bucket = buckets.get(category)!;
    if (bucket.length >= quotas[category]) continue; // this category's quota is already full

    bucket.push({
      label: `converted from PaySim row ${rowIndex} (type=${row.type}${row.isFraud === "1" ? ", isFraud=1" : ""})`,
      customerName: nameFor(custId),
      customerEmail: `${nameFor(custId).toLowerCase().replace(" ", ".")}.${custId.slice(-4)}@example.test`,
      amountRupees: rescaleAmount(Number(row.amount)),
      failureCategory: category,
      ...(suspicious ? { isSuspicious: true } : {}),
      ...(priorCount > 0 ? { priorSuccessfulPayments: Math.min(priorCount, 10) } : {}),
    });
  }
  rl.close();

  const cases = CATEGORIES.flatMap((c) => buckets.get(c)!);
  fs.writeFileSync("test-cases.json", JSON.stringify(cases, null, 2));

  console.log(`\nScanned ${rowIndex} rows. Wrote ${cases.length} total test cases to test-cases.json.\n`);
  console.log("Per-category coverage:");
  for (const c of CATEGORIES) {
    const n = buckets.get(c)!.length;
    const flag = n < quotas[c] ? "  <- quota NOT fully met, this category is genuinely this rare in the scanned rows" : "";
    console.log(`  ${c.padEnd(20)} ${n}/${quotas[c]}${flag}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
