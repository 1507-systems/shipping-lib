/**
 * Canonical service catalog and loose-input resolution.
 *
 * Checkout systems hand us service identifiers in many shapes: display names
 * with or without trademark glyphs ("UPS® Ground"), carrier API codes ("03"),
 * our own canonical ids ("ups_ground"), or a label provider's spelling
 * ("Next Day Air Early®"). resolveService() maps all of them to one catalog
 * entry so the service a customer paid for can be compared, exactly, to the
 * service that was actually bought.
 *
 * Matching is exact on a normalized form, never substring: "UPS Next Day Air
 * Early" must not resolve to "UPS Next Day Air".
 */

import type { Carrier, ServiceSelection } from './types';

export interface ServiceDefinition extends ServiceSelection {
  /** Extra accepted spellings (normalized at lookup time). */
  aliases: string[];
  /** UPS Rating/Shipping API service code, for UPS services. */
  upsCode?: string;
  /** True for services that only ship domestically. */
  domestic: boolean;
}

function def(
  carrier: Carrier,
  code: string,
  name: string,
  aliases: string[] = [],
  extra: { upsCode?: string; domestic?: boolean } = {},
): ServiceDefinition {
  return {
    carrier,
    code,
    name,
    aliases,
    domestic: extra.domestic ?? true,
    ...(extra.upsCode !== undefined ? { upsCode: extra.upsCode } : {}),
  };
}

export const SERVICE_CATALOG: readonly ServiceDefinition[] = Object.freeze([
  // UPS domestic. Codes are UPS API service codes.
  def('UPS', 'ups_ground', 'UPS Ground', [], { upsCode: '03' }),
  def('UPS', 'ups_ground_saver', 'UPS Ground Saver', ['UPS SurePost'], { upsCode: '93' }),
  def('UPS', 'ups_3_day_select', 'UPS 3 Day Select', ['UPS Three Day Select'], { upsCode: '12' }),
  def('UPS', 'ups_2nd_day_air', 'UPS 2nd Day Air', ['UPS Second Day Air', 'UPS 2 Day Air', 'UPS 2Day Air'], {
    upsCode: '02',
  }),
  def('UPS', 'ups_2nd_day_air_am', 'UPS 2nd Day Air A.M.', ['UPS 2nd Day Air AM', 'UPS Second Day Air AM'], {
    upsCode: '59',
  }),
  def('UPS', 'ups_next_day_air', 'UPS Next Day Air', ['UPS Overnight', 'UPS 1 Day Air'], { upsCode: '01' }),
  def('UPS', 'ups_next_day_air_saver', 'UPS Next Day Air Saver', [], { upsCode: '13' }),
  def('UPS', 'ups_next_day_air_early', 'UPS Next Day Air Early', ['UPS Next Day Air Early AM', 'UPS Next Day Air Early A.M.'], {
    upsCode: '14',
  }),
  // UPS international.
  def('UPS', 'ups_standard', 'UPS Standard', [], { upsCode: '11', domestic: false }),
  def('UPS', 'ups_worldwide_express', 'UPS Worldwide Express', [], { upsCode: '07', domestic: false }),
  def('UPS', 'ups_worldwide_expedited', 'UPS Worldwide Expedited', [], { upsCode: '08', domestic: false }),
  def('UPS', 'ups_worldwide_saver', 'UPS Worldwide Saver', ['UPS Saver'], { upsCode: '65', domestic: false }),
  def('UPS', 'ups_worldwide_economy', 'UPS Worldwide Economy', [], { domestic: false }),
  // USPS.
  def('USPS', 'usps_ground_advantage', 'USPS Ground Advantage', ['Ground Advantage']),
  def('USPS', 'usps_priority', 'USPS Priority Mail', ['USPS Priority', 'Priority Mail']),
  def('USPS', 'usps_priority_express', 'USPS Priority Mail Express', ['USPS Express Mail', 'Priority Mail Express']),
  def('USPS', 'usps_media_mail', 'USPS Media Mail', ['Media Mail']),
  def('USPS', 'usps_first_class_international', 'USPS First Class Package International', [
    'USPS First-Class Package International Service',
    'First Class Package International',
  ], { domestic: false }),
  def('USPS', 'usps_priority_international', 'USPS Priority Mail International', ['Priority Mail International'], {
    domestic: false,
  }),
  def('USPS', 'usps_priority_express_international', 'USPS Priority Mail Express International', [
    'Priority Mail Express International',
  ], { domestic: false }),
  // FedEx.
  def('FedEx', 'fedex_ground', 'FedEx Ground'),
  def('FedEx', 'fedex_home_delivery', 'FedEx Home Delivery', ['FedEx Ground Home Delivery']),
  def('FedEx', 'fedex_express_saver', 'FedEx Express Saver'),
  def('FedEx', 'fedex_2day', 'FedEx 2Day', ['FedEx 2 Day', 'FedEx Two Day']),
  def('FedEx', 'fedex_standard_overnight', 'FedEx Standard Overnight'),
  def('FedEx', 'fedex_priority_overnight', 'FedEx Priority Overnight'),
  def('FedEx', 'fedex_international_priority', 'FedEx International Priority', [], { domestic: false }),
  // DHL.
  def('DHL', 'dhl_express_worldwide', 'DHL Express Worldwide', ['DHL Express'], { domestic: false }),
]);

/**
 * Lowercase, drop trademark glyphs and periods, turn every other
 * non-alphanumeric run into one space, trim.
 * "UPS® 2nd Day Air A.M." -> "ups 2nd day air am"
 */
export function normalizeServiceText(input: string): string {
  // Glyphs first: NFKC would turn ™ into the letters "TM".
  return input
    .replace(/[®™©℠]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const CARRIER_WORDS: Record<Carrier, string> = { UPS: 'ups', USPS: 'usps', FedEx: 'fedex', DHL: 'dhl' };

/** Variant words providers append that do not change the underlying service. */
const VARIANT_SUFFIX =
  /\s(?:cubic|weight based|flat rate(?: [a-z ]*)?|regional rate(?: [a-z ]*)?|commercial|retail|service)$/;

type Index = Map<string, ServiceDefinition>;
let index: Index | null = null;

function buildIndex(): Index {
  const map: Index = new Map();
  const add = (key: string, entry: ServiceDefinition) => {
    const k = normalizeServiceText(key);
    if (k && !map.has(k)) map.set(k, entry);
  };
  for (const entry of SERVICE_CATALOG) {
    add(entry.code, entry);
    add(entry.name, entry);
    for (const alias of entry.aliases) add(alias, entry);
  }
  // Second pass: names without the carrier prefix ("Next Day Air Early").
  // Added only when the remainder is at least two words (a bare "ground" or
  // "standard" is too generic), maps to exactly one service across all
  // carriers ("ground saver" yes; "ground" is UPS and FedEx), and is not
  // already a first-pass key.
  const candidates = new Map<string, Set<ServiceDefinition>>();
  for (const entry of SERVICE_CATALOG) {
    const word = CARRIER_WORDS[entry.carrier];
    for (const text of [entry.name, ...entry.aliases]) {
      const n = normalizeServiceText(text);
      if (!n.startsWith(word + ' ')) continue;
      const rest = n.slice(word.length + 1);
      if (rest.split(' ').length < 2) continue;
      const set = candidates.get(rest) ?? new Set<ServiceDefinition>();
      set.add(entry);
      candidates.set(rest, set);
    }
  }
  for (const [key, set] of candidates) {
    if (set.size === 1) add(key, [...set][0]!);
  }
  return map;
}

function lookup(key: string): ServiceDefinition | null {
  index ??= buildIndex();
  return index.get(key) ?? null;
}

export interface ResolveOptions {
  /** Restrict the match to one carrier (also enables bare numeric codes only for UPS). */
  carrier?: Carrier;
}

/**
 * Map a loose service name or code to its canonical catalog entry, or null.
 * Accepts canonical ids ("ups_ground"), display names in any case with or
 * without ®/™ ("UPS® Ground"), names without the carrier prefix, UPS API
 * service codes as two digits ("03"), and provider variant suffixes
 * ("USPS Priority Mail Cubic" -> usps_priority).
 */
export function resolveService(input: string | null | undefined, options: ResolveOptions = {}): ServiceDefinition | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const accept = (entry: ServiceDefinition | null) =>
    entry && (!options.carrier || entry.carrier === options.carrier) ? entry : null;

  // UPS numeric service codes. Exactly two digits: a bare "3" is ambiguous.
  if (/^\d{2}$/.test(raw)) {
    if (options.carrier && options.carrier !== 'UPS') return null;
    return SERVICE_CATALOG.find((s) => s.upsCode === raw) ?? null;
  }

  let key = normalizeServiceText(raw);
  const hit = accept(lookup(key));
  if (hit) return hit;

  // Peel provider variant suffixes ("... cubic", "... flat rate envelope").
  for (let i = 0; i < 3; i++) {
    const stripped = key.replace(VARIANT_SUFFIX, '');
    if (stripped === key) break;
    key = stripped;
    const again = accept(lookup(key));
    if (again) return again;
  }
  return null;
}

/** The plain ServiceSelection (carrier, code, name) for a catalog entry. */
export function toSelection(entry: ServiceSelection): ServiceSelection {
  return { carrier: entry.carrier, code: entry.code, name: entry.name };
}

/** True when two selections denote the same canonical service. */
export function sameService(a: ServiceSelection | null | undefined, b: ServiceSelection | null | undefined): boolean {
  return !!a && !!b && a.carrier === b.carrier && a.code === b.code;
}

/** Public tracking page for a carrier tracking number. */
export function trackingUrl(carrier: Carrier, trackingNumber: string): string {
  const n = encodeURIComponent(trackingNumber.trim());
  switch (carrier) {
    case 'UPS':
      return `https://www.ups.com/track?tracknum=${n}`;
    case 'USPS':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case 'FedEx':
      return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case 'DHL':
      return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`;
  }
}

/** Parse a free-text carrier name ("ups", "U.S. Postal Service", "FedEx Ground") to a Carrier. */
export function parseCarrier(input: string | null | undefined): Carrier | null {
  if (typeof input !== 'string') return null;
  const n = normalizeServiceText(input);
  if (!n) return null;
  if (/^(usps|us postal service|united states postal service|us mail)\b/.test(n)) return 'USPS';
  if (/^(ups|united parcel service)\b/.test(n)) return 'UPS';
  if (/^(fedex|federal express)\b/.test(n)) return 'FedEx';
  if (/^dhl\b/.test(n)) return 'DHL';
  return null;
}

/**
 * Best-effort carrier inference from a tracking number's shape. Used only when
 * the provider row names no carrier; returns null rather than guess when the
 * shape is shared between carriers.
 */
export function inferCarrier(trackingNumber: string): Carrier | null {
  const t = trackingNumber.replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^(9[1-5]\d{18,24}|(EC|EA|CP|RA|LZ|LX)\d{9}US)$/.test(t)) return 'USPS';
  return null;
}
