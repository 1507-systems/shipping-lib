/**
 * Address normalization and validation helpers shared by providers.
 * Pure functions; never throw on user data.
 */

import type { Address } from './types';

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', guam: 'GU', 'us virgin islands': 'VI', 'virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP',
  'armed forces americas': 'AA', 'armed forces europe': 'AE', 'armed forces pacific': 'AP',
};

const US_CODES = new Set(Object.values(US_STATES));

/** Codes outside the contiguous 48 states + DC. */
const NON_CONTIGUOUS = new Set(['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP']);

/** "colorado" / "Colorado" / "co" -> "CO". Returns null when not a US state or territory. */
export function normalizeUsState(input: string): string | null {
  const t = input.trim();
  if (/^[A-Za-z]{2}$/.test(t) && US_CODES.has(t.toUpperCase())) return t.toUpperCase();
  return US_STATES[t.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')] ?? null;
}

/** "802011234" / "80201-1234" / "80201" -> "80201-1234" / "80201". Null when not a 5 or 9 digit ZIP. */
export function normalizeUsZip(input: string): string | null {
  const digits = input.trim().replace(/[\s-]/g, '');
  if (/^\d{5}$/.test(digits)) return digits;
  if (/^\d{9}$/.test(digits)) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return null;
}

/** "us", "USA", "United States", "" -> "US"; other values are upper-cased and trimmed. */
export function normalizeCountry(input: string | undefined): string {
  const t = (input ?? '').trim();
  if (!t) return 'US';
  const n = t.toLowerCase().replace(/\./g, '');
  if (n === 'us' || n === 'usa' || n === 'united states' || n === 'united states of america') return 'US';
  return t.toUpperCase();
}

export function isContiguousUs(state: string): boolean {
  const s = normalizeUsState(state);
  return s !== null && !NON_CONTIGUOUS.has(s);
}

/** True when a street line looks like a PO Box. */
export function isPoBox(line: string | undefined): boolean {
  if (!line) return false;
  return /\b(p\s*\.?\s*o\.?\s*box|post\s+office\s+box|pob\s+\d)/i.test(line);
}

export const REQUIRED_ADDRESS_FIELDS = ['name', 'line1', 'city', 'state', 'postalCode'] as const;

/** Required fields that are missing or blank. Tolerates non-object input. */
export function missingAddressFields(address: Partial<Address> | null | undefined): string[] {
  if (!address || typeof address !== 'object') return [...REQUIRED_ADDRESS_FIELDS];
  return REQUIRED_ADDRESS_FIELDS.filter((f) => {
    const v = address[f];
    return typeof v !== 'string' || v.trim() === '';
  });
}
