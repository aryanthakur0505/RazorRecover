// Excel/Sheets/Numbers all treat a cell starting with one of these characters as a formula, even
// in a plain .csv file — a customer name of e.g. `=HYPERLINK("http://evil","click")` or
// `=cmd|'/c calc'!A1` (customer names ultimately come from checkout form input relayed through
// Razorpay webhooks, so they're not merchant-controlled) would execute when the merchant opens
// this export. Prefixing with a tab neutralizes the formula while staying invisible in the opened
// spreadsheet — the standard mitigation for CSV/formula injection (OWASP).
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Minimal RFC 4180-ish CSV serialization — quotes a cell only when it actually needs it (contains
 *  a comma, quote, or newline), doubling embedded quotes. Good enough for Excel/Sheets/Numbers;
 *  not trying to handle every edge case a full CSV library would. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (s.length > 0 && FORMULA_TRIGGER_CHARS.has(s[0])) {
    s = `\t${s}`;
  }
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
