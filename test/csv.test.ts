import { describe, expect, it } from 'vitest';
import { escapeCsvField, guardFormula, normalizeHeader, parseCsv, parseCsvTable, writeCsv } from '../src/index';

describe('writeCsv', () => {
  it('writes CRLF records and quotes only when needed', () => {
    expect(writeCsv([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });

  it('quotes embedded commas, quotes, CR and LF; doubles quotes', () => {
    const out = writeCsv([['x,y', 'say "hi"', 'line1\nline2', 'cr\rhere']]);
    expect(out).toBe('"x,y","say ""hi""","line1\nline2","cr\rhere"\r\n');
  });

  it('quotes leading/trailing whitespace so it survives', () => {
    expect(escapeCsvField(' pad ')).toBe('" pad "');
    expect(escapeCsvField('plain')).toBe('plain');
  });

  it('renders null/undefined/NaN as empty and numbers/booleans as text', () => {
    expect(writeCsv([[null, undefined, Number.NaN, 0, 1.5, true]])).toBe(',,,0,1.5,true\r\n');
  });

  it('optionally prefixes a BOM', () => {
    expect(writeCsv([['a']], { bom: true })).toBe('﻿a\r\n');
  });

  it('applies the formula guard by default and can disable it', () => {
    expect(writeCsv([['=1+1']])).toBe("'=1+1\r\n");
    expect(writeCsv([['=1+1']], { formulaGuard: false })).toBe('=1+1\r\n');
  });

  it('round-trips arbitrary content through parseCsv', () => {
    const rows = [
      ['h1', 'h2', 'h3'],
      ['a,b', '"q"', 'multi\r\nline'],
      ['', ' sp ', 'ünïcødé ✓'],
    ];
    expect(parseCsv(writeCsv(rows, { formulaGuard: false })).records).toEqual(rows);
  });
});

describe('guardFormula', () => {
  it.each([
    ['=HYPERLINK("http://evil","x")'],
    ['@SUM(A1)'],
    ['+cmd|\' /c calc\'!A0'],
    ['-SUM(A1:A2)'],
    ['\tleading tab'],
    ['\rleading cr'],
    ['＝1+1'],
    ['＠x'],
    ['+A1'],
    ['-'],
  ])('neutralizes %j', (cell) => {
    expect(guardFormula(cell)).toBe("'" + cell);
  });

  it.each([
    ['+1 (555) 010-0199'],
    ['+44 20 7946 0958'],
    ['-12.5'],
    ['-0.01'],
    ['+15550100199'],
    ['555-0100'],
    ['-2+3'],
    ['Smith = Jones'],
    ['a@b.com'],
    [''],
    ['123 Main St'],
  ])('leaves %j unchanged', (cell) => {
    expect(guardFormula(cell)).toBe(cell);
  });
});

describe('parseCsv', () => {
  it('strips a BOM and handles CRLF, LF and lone CR', () => {
    expect(parseCsv('﻿a,b\r\n1,2\n3,4\r5,6').records).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('parses quoted fields with commas, doubled quotes and newlines', () => {
    expect(parseCsv('"a,1","b ""x""","c\r\nd"\r\n').records).toEqual([['a,1', 'b "x"', 'c\r\nd']]);
  });

  it('keeps empty fields and a trailing empty field', () => {
    expect(parseCsv('a,,c,\r\n').records).toEqual([['a', '', 'c', '']]);
  });

  it('skips blank records but counts them in recordNumbers', () => {
    const r = parseCsv('h\r\n\r\nx\r\n,\r\ny');
    expect(r.records).toEqual([['h'], ['x'], ['y']]);
    expect(r.recordNumbers).toEqual([1, 3, 5]);
  });

  it('can keep blank records', () => {
    expect(parseCsv('a\n\nb', { keepBlankRecords: true }).records).toEqual([['a'], [''], ['b']]);
  });

  it('is lenient with stray quotes in unquoted fields', () => {
    expect(parseCsv('5" box,ok').records).toEqual([['5" box', 'ok']]);
  });

  it('reports an unterminated quote instead of throwing', () => {
    const r = parseCsv('a,"unterminated\nstill');
    expect(r.unterminatedQuote).toBe(true);
    expect(r.records).toEqual([['a', 'unterminated\nstill']]);
  });

  it('auto-detects tab and semicolon delimiters', () => {
    expect(parseCsv('a\tb\n1\t2').records).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a;b\n1;2').records).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('"a;b",c\n1,2').records).toEqual([['a;b', 'c'], ['1', '2']]);
  });

  it('returns no records for empty input', () => {
    expect(parseCsv('').records).toEqual([]);
    expect(parseCsv('﻿').records).toEqual([]);
  });
});

describe('normalizeHeader / parseCsvTable', () => {
  it('normalizes case, punctuation and #', () => {
    expect(normalizeHeader(' Tracking # ')).toBe('trackingnumber');
    expect(normalizeHeader('Order ID')).toBe('orderid');
    expect(normalizeHeader('ZIP/Postal Code')).toBe('zippostalcode');
  });

  it('keys values by original header and looks up columns by alias', () => {
    const t = parseCsvTable('﻿ Order ID ,TRACKING #\r\nA-1,1Z1\r\nA-2\r\n');
    expect(t.headers).toEqual(['Order ID', 'TRACKING #']);
    expect(t.column('Tracking Number')).toBe('TRACKING #');
    expect(t.column('nope', 'order id')).toBe('Order ID');
    expect(t.column('missing')).toBeUndefined();
    expect(t.rows).toEqual([
      { row: 2, values: { 'Order ID': 'A-1', 'TRACKING #': '1Z1' } },
      { row: 3, values: { 'Order ID': 'A-2', 'TRACKING #': '' } },
    ]);
  });

  it('first of duplicate headers wins', () => {
    const t = parseCsvTable('a,a\n1,2');
    expect(t.rows[0]!.values).toEqual({ a: '1' });
  });
});
