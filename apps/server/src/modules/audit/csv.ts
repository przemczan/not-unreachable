/** Characters a spreadsheet may read as the start of a formula (OWASP, "CSV injection"). */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One RFC 4180 cell; a value that would start a formula gets a leading `'`, so it reads as text. */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows joined with CRLF, ending with one (RFC 4180). */
export function toCsv(rows: readonly (readonly (string | null)[])[]): string {
  return rows.map((row) => `${row.map(csvCell).join(",")}\r\n`).join("");
}
