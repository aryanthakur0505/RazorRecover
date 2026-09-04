/** Minimal RFC 4180-ish CSV serialization — quotes a cell only when it actually needs it (contains
 *  a comma, quote, or newline), doubling embedded quotes. Good enough for Excel/Sheets/Numbers;
 *  not trying to handle every edge case a full CSV library would. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
