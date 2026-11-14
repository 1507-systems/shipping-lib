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

/** Common English country names and ISO alpha-3 codes -> ISO 3166-1 alpha-2. */
const COUNTRY_NAMES: Record<string, string> = {
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  canada: 'CA', can: 'CA', mexico: 'MX', mex: 'MX',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'northern ireland': 'GB', gbr: 'GB', ireland: 'IE', irl: 'IE',
  germany: 'DE', deu: 'DE', france: 'FR', fra: 'FR', spain: 'ES', esp: 'ES', italy: 'IT', ita: 'IT',
  portugal: 'PT', netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL', nld: 'NL', belgium: 'BE',
  switzerland: 'CH', austria: 'AT', sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI', iceland: 'IS',
  poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ', greece: 'GR', israel: 'IL', turkey: 'TR', turkiye: 'TR',
  australia: 'AU', aus: 'AU', 'new zealand': 'NZ', nzl: 'NZ', japan: 'JP', jpn: 'JP', china: 'CN', chn: 'CN',
  'south korea': 'KR', korea: 'KR', 'republic of korea': 'KR', taiwan: 'TW', 'hong kong': 'HK', singapore: 'SG',
  india: 'IN', ind: 'IN', philippines: 'PH', thailand: 'TH', vietnam: 'VN', 'viet nam': 'VN', malaysia: 'MY',
  indonesia: 'ID', brazil: 'BR', bra: 'BR', argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE',
  'south africa': 'ZA', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA',
};

/**
 * "us", "USA", "United States", "" -> "US"; "Canada" -> "CA"; a 2-letter
 * code is upper-cased. Anything else unrecognized is upper-cased and trimmed
 * and is NOT valid ISO alpha-2: check with isIsoCountry().
 */
export function normalizeCountry(input: string | undefined): string {
  const t = (input ?? '').trim();
  if (!t) return 'US';
  const n = t.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (Object.hasOwn(COUNTRY_NAMES, n)) return COUNTRY_NAMES[n]!;
  return t.toUpperCase();
}

/** True for a two-letter (ISO 3166-1 alpha-2 shaped) country code. */
export function isIsoCountry(code: string): boolean {
  return /^[A-Z]{2}$/.test(code);
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
