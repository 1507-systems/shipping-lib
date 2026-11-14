/**
 * RFC 4180 CSV writer and tolerant parser.
 *
 * Writer: CRLF record separators; a field is quoted when it contains a comma,
 * a double quote, CR or LF, or leading/trailing whitespace; embedded quotes
 * are doubled. Cells are passed through the formula-injection guard first
 * (see guardFormula) unless disabled.
 *
 * Parser: accepts CRLF, LF or lone CR; strips a leading UTF-8 BOM; handles
 * quoted fields with embedded delimiters, doubled quotes and newlines; is
 * lenient about stray quotes inside unquoted fields (kept literally) and an
 * unterminated final quote (reads to end of input and reports it). It never
 * throws on malformed input.
 */

/**
 * Spreadsheet formula-injection guard (CWE-1236).
 *
 * Excel, LibreOffice and Google Sheets evaluate a cell as a formula when it
 * begins with `=`, `+`, `-` or `@` (and some also act on a leading tab or CR).
 * An exported address like `=HYPERLINK("http://evil","x")` would run when the
 * operator opens the file. The guard prefixes such cells with a single quote
 * (the OWASP-recommended neutralization), which spreadsheets show as text.
 *
 * Rule, precisely:
 *  - Leading `=`, `@`, full-width `＝`/`＠`, TAB or CR: always neutralized.
 *  - Leading `+` or `-`: neutralized UNLESS the whole cell is a plain number or
 *    phone-like string, i.e. it matches /^[+-][0-9 ().+\-]*$/ and contains at
 *    least one digit. Those characters cannot form a function call, a cell
 *    reference (needs a letter) or a DDE payload (needs `|`), so values like
 *    `-12.5` and `+1 (555) 010-0199` pass through unchanged and are not
 *    corrupted. `-2+3` stays too: arithmetic on literals is inert.
 *    `+1 555 cmd|' /c calc'!A0` or `-SUM(A1)` are neutralized.
 */
export function guardFormula(cell: string): string {
  if (cell === '') return cell;
  const first = cell[0]!;
  if (first === '=' || first === '@' || first === '＝' || first === '＠' || first === '\t' || first === '\r') {
    return "'" + cell;
  }
  if (first === '+' || first === '-') {
    if (/^[+-][0-9 ().+\-]*$/.test(cell) && /\d/.test(cell)) return cell;
    return "'" + cell;
  }
  return cell;
}

/**
 * Formula guard for a phone column: like guardFormula, but also passes a
 * phone number with an extension ("+1 555-010-0199 ext. 5", "-555 0199 x12")
 * unchanged. The only letters allowed are the extension marker, followed by
 * digits only, so no function call, cell reference or DDE payload can form.
 */
export function guardPhone(cell: string): string {
  if (/^[+-]?[0-9 ().\-]+(?:\s*(?:x|ext\.?|extension)\s*\d+)?$/i.test(cell) && /\d/.test(cell)) return cell;
  return guardFormula(cell);
}

export type CsvCell = string | number | boolean | null | undefined;

/** A per-cell guard: receives the cell text and its 0-based column index. */
export type CellGuard = (cell: string, columnIndex: number) => string;

export interface WriteCsvOptions {
  /**
   * Apply guardFormula to every cell (default true), or pass a per-column
   * guard function (e.g. guardPhone for a phone column, guardFormula elsewhere).
   */
  formulaGuard?: boolean | CellGuard;
  /** Prefix a UTF-8 BOM so Excel detects the encoding (default false). */
  bom?: boolean;
}

function cellText(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}

/** Quote one field per RFC 4180 when needed. Does not apply the formula guard. */
export function escapeCsvField(text: string): string {
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/** Serialize rows to CSV. Every record, including the last, ends with CRLF. */
export function writeCsv(rows: readonly (readonly CsvCell[])[], options: WriteCsvOptions = {}): string {
  const g = options.formulaGuard ?? true;
  const guard: CellGuard | null = typeof g === 'function' ? g : g ? guardFormula : null;
  let out = options.bom ? '﻿' : '';
  for (const row of rows) {
    out +=
      row
        .map((v, col) => {
          const t = cellText(v);
          return escapeCsvField(guard ? guard(t, col) : t);
        })
        .join(',') + '\r\n';
  }
  return out;
}

export interface ParseCsvResult {
  records: string[][];
  /** 1-based physical record number of each entry in `records` (blank lines are skipped but counted). */
  recordNumbers: number[];
  /** True when the input ended inside a quoted field. */
  unterminatedQuote: boolean;
}

export interface ParseCsvOptions {
  /** Field delimiter. Default: auto-detect from the first line (comma, tab or semicolon; comma wins ties). */
  delimiter?: string;
  /** Keep records whose every field is empty (default false). */
  keepBlankRecords?: boolean;
}

function detectDelimiter(text: string): string {
  // First physical line, ignoring delimiters inside quotes.
  let inQuotes = false;
  const counts: Record<string, number> = { ',': 0, '\t': 0, ';': 0 };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) break;
    else if (!inQuotes && c in counts) counts[c]!++;
  }
  let best = ',';
  for (const d of ['\t', ';']) if (counts[d]! > counts[best]!) best = d;
  return best;
}

export function parseCsv(input: string, options: ParseCsvOptions = {}): ParseCsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = options.delimiter ?? detectDelimiter(text);
  const records: string[][] = [];
  const recordNumbers: number[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  let recordNo = 1;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    const blank = record.every((f) => f === '');
    if (!blank || options.keepBlankRecords) {
      records.push(record);
      recordNumbers.push(recordNo);
    }
    record = [];
    recordNo++;
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '' && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (c === delim) {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    // Stray quote in an unquoted field, or text after a closing quote: keep literally.
    field += c;
    i++;
  }
  const unterminatedQuote = inQuotes;
  // Flush the final record unless the input ended exactly on a record separator.
  if (field !== '' || record.length > 0 || fieldWasQuoted) endRecord();
  return { records, recordNumbers, unterminatedQuote };
}

/**
 * Header normalization for tolerant column lookup: NFKC, lowercase, `#` read
 * as "number", every non-alphanumeric run removed.
 * "Tracking #" -> "trackingnumber", " Order ID " -> "orderid", "ZIP/Postal" -> "zippostal".
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFKC')
    .toLowerCase()
    .replace(/#/g, 'number')
    .replace(/[^a-z0-9]+/g, '');
}

export interface CsvTableRow {
  /** 1-based physical record number (header is 1). */
  row: number;
  /**
   * Values keyed by the ORIGINAL header text. A null-prototype object, so a
   * header named "constructor" or "__proto__" is an ordinary key.
   */
  values: Record<string, string>;
}

export interface CsvTable {
  headers: string[];
  rows: CsvTableRow[];
  unterminatedQuote: boolean;
  /**
   * Find the first header matching any alias (compared via normalizeHeader).
   * Aliases are tried in order, so put the most specific first.
   */
  column(...aliases: string[]): string | undefined;
}

/** Parse CSV whose first non-blank record is a header row. */
export function parseCsvTable(input: string, options: ParseCsvOptions = {}): CsvTable {
  const { records, recordNumbers, unterminatedQuote } = parseCsv(input, options);
  const headers = (records[0] ?? []).map((h) => h.trim());
  const byNorm = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (n && !byNorm.has(n)) byNorm.set(n, h);
  }
  const rows: CsvTableRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!;
    const values: Record<string, string> = Object.create(null);
    headers.forEach((h, idx) => {
      if (h && !Object.hasOwn(values, h)) values[h] = rec[idx] ?? '';
    });
    rows.push({ row: recordNumbers[r]!, values });
  }
  return {
    headers,
    rows,
    unterminatedQuote,
    column(...aliases: string[]) {
      for (const a of aliases) {
        const hit = byNorm.get(normalizeHeader(a));
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
  };
}
