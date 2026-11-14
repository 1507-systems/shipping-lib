/**
 * Pirate Ship provider.
 *
 * Pirate Ship does not offer an API ("Pirate Ship doesn't offer an API.",
 * https://support.pirateship.com/en/articles/2309246-does-pirate-ship-have-an-api)
 * and its Terms of Use prohibit robots, scraping and access "by any means other
 * than through interfaces we provide". This provider therefore uses only the
 * two sanctioned routes, both driven by a person in the Pirate Ship web app:
 *
 *  1. Spreadsheet upload (Ship > Import a Spreadsheet). exportShipments()
 *     builds that CSV. Headers are fixed, so Pirate Ship remembers the column
 *     mapping after the first upload.
 *  2. Shipment export (Shipments grid > Export, or a batch's "Export Data").
 *     parseTrackingImport() reads that CSV back into TrackingUpdate[], joined
 *     to orders by the Order ID we put in the upload.
 *
 * It never buys labels or quotes rates (capabilities.purchaseLabel/rates are
 * false) and contains no client for Pirate Ship's private web endpoints.
 *
 * Service selection: Pirate Ship's spreadsheet import has no carrier/service
 * column; the service is picked per batch in the UI when buying. So
 * exportBatches() produces one file per (service, package type), each with a
 * 'buy_with_service' instruction, and reconcileShipments() (../reconcile.ts)
 * checks the export's Service column against the order after purchase. The
 * checkout service is also written to a "Requested Shipping Service" column,
 * but that column, like "Order Items", "Note" and "Phone", is not a native
 * Pirate Ship field: it only survives into Pirate Ship (and its shipment
 * export) when the operator maps it as Passthrough on the first upload. It
 * does not print on the label. Every export carries a 'first_upload_mapping'
 * info warning with the exact mapping (FIRST_UPLOAD_MAPPING).
 */

import { isContiguousUs, isIsoCountry, isPoBox, missingAddressFields, normalizeCountry, normalizeUsState, normalizeUsZip } from '../address';
import { guardFormula, guardPhone, normalizeHeader, parseCsvTable, writeCsv, type CsvCell } from '../csv';
import { inferCarrier, isKnownCarrier, parseCarrier, resolveSelection, resolveService, toSelection, trackingUrl, type ServiceDefinition } from '../services';
import type {
  ExportFile,
  ExportResult,
  ExportWarning,
  ImportError,
  ParcelRef,
  ServiceSelection,
  ShipmentRequest,
  ShippingProvider,
  TrackingImportResult,
  TrackingUpdate,
} from '../types';

export const PIRATE_SHIP_ID = 'pirateship';
export const PIRATE_SHIP_DISPLAY_NAME = 'Pirate Ship';
/** The web app, where the operator uploads, buys and exports. */
export const PIRATE_SHIP_APP_URL = 'https://ship.pirateship.com';
export const PIRATE_SHIP_DOCS = Object.freeze({
  noApi: 'https://support.pirateship.com/en/articles/2309246-does-pirate-ship-have-an-api',
  spreadsheetUpload: 'https://support.pirateship.com/en/articles/1068428-how-do-i-upload-address-spreadsheets-into-pirate-ship',
  spreadsheetFields: 'https://www.pirateship.com/integrations/spreadsheets',
  weightsAndDimensions: 'https://support.pirateship.com/en/articles/2797613',
  rubberStamps: 'https://support.pirateship.com/en/articles/1804193',
  shipmentExport: 'https://support.pirateship.com/en/articles/4143612-can-i-export-a-report-of-my-shipment-history',
  terms: 'https://ship.pirateship.com/terms',
});

/**
 * The exact upload header row, in order. Spellings follow Pirate Ship's own
 * integration order export (article 3514252) where one exists, and its
 * weights/dimensions article for Pounds/Ounces/Length/Width/Height. Never
 * change these casually: Pirate Ship remembers column mappings by header text,
 * so any change forces the operator to re-map.
 */
export const PIRATE_SHIP_IMPORT_HEADERS = Object.freeze([
  'Order ID',
  'Full Name',
  'Company',
  'Address Line 1',
  'Address Line 2',
  'City',
  'State',
  'Zip',
  'Country',
  'Email',
  'Phone',
  'Pounds',
  'Ounces',
  'Length',
  'Width',
  'Height',
  'Rubber Stamp 1',
  'Rubber Stamp 2',
  'Requested Shipping Service',
  'Order Items',
  'Note',
] as const);

/**
 * How to map PIRATE_SHIP_IMPORT_HEADERS on the first upload (Pirate Ship then
 * remembers it by header text). Pirate Ship's mappable fields
 * (pirateship.com/integrations/spreadsheets) are Name, Company, Address,
 * Address Line 2/3, City, State, Zipcode, Country, Email Address, Weight,
 * L/W/H, Order ID, Rubber Stamp and Passthrough. Columns with no native field
 * must be mapped to Passthrough or they are dropped.
 */
export const FIRST_UPLOAD_MAPPING: Readonly<Record<(typeof PIRATE_SHIP_IMPORT_HEADERS)[number], string>> = Object.freeze({
  'Order ID': 'Order ID',
  'Full Name': 'Name',
  Company: 'Company',
  'Address Line 1': 'Address',
  'Address Line 2': 'Address Line 2',
  City: 'City',
  State: 'State',
  Zip: 'Zipcode',
  Country: 'Country',
  Email: 'Email Address',
  Phone: 'Passthrough',
  Pounds: 'Weight (pounds)',
  Ounces: 'Weight (ounces)',
  Length: 'Length',
  Width: 'Width',
  Height: 'Height',
  'Rubber Stamp 1': 'Rubber Stamp 1',
  'Rubber Stamp 2': 'Rubber Stamp 2',
  'Requested Shipping Service': 'Passthrough',
  'Order Items': 'Passthrough',
  Note: 'Passthrough',
});

const PHONE_COLUMN = PIRATE_SHIP_IMPORT_HEADERS.indexOf('Phone');

/**
 * Canonical service code -> Pirate Ship's spelling (pirateship.com/rates and
 * support article 5604653). Only UPS and USPS: Pirate Ship sells nothing else.
 */
export const PIRATE_SHIP_SERVICE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ups_ground: 'UPS® Ground',
  ups_ground_saver: 'UPS Ground Saver®',
  ups_3_day_select: 'UPS 3 Day Select®',
  ups_2nd_day_air: 'UPS 2nd Day Air®',
  ups_2nd_day_air_am: 'UPS 2nd Day Air AM®',
  ups_next_day_air: 'UPS Next Day Air®',
  ups_next_day_air_saver: 'UPS Next Day Air Saver®',
  ups_next_day_air_early: 'UPS Next Day Air® Early',
  ups_standard: 'UPS Standard®',
  ups_worldwide_expedited: 'UPS Worldwide Expedited®',
  ups_worldwide_saver: 'UPS Worldwide Saver®',
  ups_worldwide_express: 'UPS Worldwide Express®',
  usps_ground_advantage: 'USPS Ground Advantage™',
  usps_priority: 'USPS Priority Mail®',
  usps_priority_express: 'USPS Priority Mail Express®',
  usps_media_mail: 'USPS Media Mail®',
  usps_first_class_international: 'USPS First Class Package International®',
  usps_priority_international: 'USPS Priority Mail International®',
  usps_priority_express_international: 'USPS Priority Mail Express International®',
});

/**
 * Rubber stamp line lengths (article 1804193): USPS 25 chars; UPS 35 per line.
 * Overflow from Rubber Stamp 1 "moves to the next line", i.e. into the line
 * Rubber Stamp 2 would use, so a long Order ID pushes Rubber Stamp 2 off.
 */
const STAMP_LIMIT = { USPS: 25, UPS: 35 } as const;

/** Services whose labels print no rubber stamps (article 1804193). */
const NO_STAMP_SERVICES: ReadonlySet<string> = new Set([
  'ups_ground_saver',
  'usps_first_class_international',
  'usps_priority_international',
  'usps_priority_express_international',
]);

/** Multi-parcel Order ID suffix: "ORDER-1" parcel 2 of 3 -> "ORDER-1/2of3". Case-insensitive on read ("/2OF3"). */
const PARCEL_SUFFIX = /^(.+)\/(\d{1,3})of(\d{1,3})$/i;

export function parcelOrderId(reference: string, index: number, count: number): string {
  return count > 1 ? `${reference}/${index}of${count}` : reference;
}

/** Split an Order ID back into the store reference and parcel position. */
export function splitParcelOrderId(orderId: string): { reference: string; parcel?: ParcelRef } {
  const m = PARCEL_SUFFIX.exec(orderId);
  if (m) {
    const index = Number(m[2]);
    const count = Number(m[3]);
    if (count >= 2 && index >= 1 && index <= count) return { reference: m[1]!, parcel: { index, count } };
  }
  return { reference: orderId };
}

export interface PirateShipOptions {
  /** Filename stem for exports (default "pirateship-import"). Sanitized to [A-Za-z0-9._-]. */
  filenameBase?: string;
  /** Fixed text for "Rubber Stamp 2" on every row (default empty), e.g. "Packing list enclosed". */
  rubberStamp2?: string;
  /** Prefix a UTF-8 BOM so Excel opens the file as UTF-8 (default false; Pirate Ship does not need it). */
  bom?: boolean;
}

export interface PirateShipBatch extends ExportFile {
  service: ServiceSelection;
  /** The requests' packageType (saved package to pick for this batch), when given. */
  packageType?: string;
  /** Pirate Ship's name for the service to pick when buying this batch. */
  pirateShipService: string;
  references: string[];
}

export interface PirateShipBatchResult {
  batches: PirateShipBatch[];
  warnings: ExportWarning[];
  skipped: string[];
}

export interface PirateShipProvider extends ShippingProvider {
  exportShipments(requests: ShipmentRequest[]): ExportResult;
  /** Same validation as exportShipments, but one CSV per checkout service. */
  exportBatches(requests: ShipmentRequest[]): PirateShipBatchResult;
  parseTrackingImport(text: string): TrackingImportResult;
}

interface PreparedShipment {
  reference: string;
  service: ServiceDefinition;
  packageType: string;
  rows: CsvCell[][];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** Finite positive number rounded to 2 decimals as a plain numeric string, else '' (also when it rounds to 0). */
function num(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  const hundredths = Math.round(v * 100);
  return hundredths === 0 ? '' : String(hundredths / 100);
}

/**
 * Address text: drop a leading "- " / "+ " bullet ("- Rear" -> "Rear").
 * Pirate Ship's importer is not a spreadsheet, so the formula guard's
 * apostrophe would reach the label verbatim; a sign followed by whitespace
 * is list punctuation, not data. A sign glued to text ("-SUM(A1)") is kept
 * and still guarded.
 */
function addressText(v: unknown): string {
  return str(v).replace(/^[+\-]+\s+(?=\S)/, '');
}

function splitWeight(weightOz: unknown): { pounds: string; ounces: string } | null {
  if (typeof weightOz !== 'number' || !Number.isFinite(weightOz) || weightOz <= 0) return null;
  const totalHundredths = Math.round(weightOz * 100);
  if (totalHundredths === 0) return null;
  const lb = Math.floor(totalHundredths / 1600);
  const oz = (totalHundredths - lb * 1600) / 100;
  return { pounds: String(lb), ounces: String(oz) };
}

function sanitizeFilename(base: string): string {
  const s = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s || 'pirateship-import';
}

/** "N x description; ..." for the packing list. Calls onInvalid with each description whose quantity is not a positive integer. */
function itemsText(items: ShipmentRequest['items'], onInvalid: (description: string, quantity: unknown) => void): string {
  if (!Array.isArray(items)) return '';
  return items
    .filter((i) => i && typeof i.description === 'string' && i.description.trim())
    .map((i) => {
      const description = i.description.trim();
      const raw: unknown = i.quantity;
      const q = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN;
      if (Number.isSafeInteger(q) && q > 0) return `${q} x ${description}`;
      onInvalid(description, raw);
      return `? x ${description}`;
    })
    .join('; ');
}

function prepare(requests: unknown, options: PirateShipOptions): { prepared: PreparedShipment[]; warnings: ExportWarning[]; skipped: string[] } {
  const warnings: ExportWarning[] = [];
  const skipped: string[] = [];
  const prepared: PreparedShipment[] = [];
  const seen = new Set<string>();
  const warn = (level: ExportWarning['level'], code: string, message: string, reference?: string) =>
    warnings.push({ level, code, message, ...(reference ? { references: [reference] } : {}) });

  const list = Array.isArray(requests) ? requests : [];
  if (!Array.isArray(requests)) warn('warning', 'invalid_input', 'exportShipments expects an array of shipment requests.');

  list.forEach((req: Partial<ShipmentRequest> | null | undefined, i) => {
    if (!req || typeof req !== 'object') {
      warn('warning', 'invalid_request', `Shipment at position ${i + 1} is not an object; skipped.`);
      skipped.push(`#${i + 1}`);
      return;
    }
    const reference = str(req.reference);
    const label = reference || `#${i + 1}`;
    const skip = (code: string, message: string) => {
      warn('warning', code, `${label}: ${message} Skipped.`, label);
      skipped.push(label);
    };

    if (!reference) return skip('missing_reference', 'no order reference, so tracking could not be matched back.');
    if (seen.has(reference)) return skip('duplicate_reference', 'reference appears more than once; Pirate Ship needs one Order ID per row.');

    const service = resolveSelection(req.service);
    if (!service) {
      const shown = req.service && typeof req.service === 'object' ? str(req.service.name) || str(req.service.code) : '';
      return skip('unknown_service', `checkout service "${shown}" is not a known service.`);
    }
    const psName = PIRATE_SHIP_SERVICE_NAMES[service.code];
    if (!psName) return skip('unsupported_service', `${service.name} is not sold on Pirate Ship (UPS and USPS only).`);

    const to = (req.to ?? {}) as Partial<ShipmentRequest['to']>;
    let name = str(to.name);
    const company = addressText(to.company);
    if (!name && company) {
      name = company;
      warn('info', 'name_from_company', `${reference}: no recipient name; using the company name.`, reference);
    }
    const missing = missingAddressFields({ ...to, name });
    if (missing.length) return skip('missing_field', `recipient address is missing ${missing.join(', ')}.`);

    const country = normalizeCountry(to.country);
    if (!isIsoCountry(country)) {
      warn('warning', 'invalid_country', `${reference}: country "${str(to.country)}" is not a 2-letter ISO code; Pirate Ship may not recognize it.`, reference);
    }
    let state = str(to.state);
    let zip = str(to.postalCode);
    if (country === 'US') {
      const st = normalizeUsState(state);
      if (st) state = st;
      else warn('warning', 'invalid_state', `${reference}: "${state}" is not a US state code; Pirate Ship needs 2 letters.`, reference);
      const z = normalizeUsZip(zip);
      if (z) zip = z;
      else warn('warning', 'invalid_zip', `${reference}: "${zip}" is not a 5 or 9 digit ZIP.`, reference);
    } else {
      warn('info', 'customs_required', `${reference}: international (${country}); customs forms cannot be set in a spreadsheet, complete them in Pirate Ship.`, reference);
    }
    if (service.domestic && country !== 'US') {
      warn('warning', 'service_destination_mismatch', `${reference}: ${service.name} is domestic but the address is in ${country}.`, reference);
    } else if (!service.domestic && country === 'US') {
      warn('warning', 'service_destination_mismatch', `${reference}: ${service.name} is international but the address is in the US.`, reference);
    }
    if (service.code === 'ups_ground_saver') {
      if (isPoBox(to.line1) || isPoBox(to.line2)) {
        warn('warning', 'ground_saver_po_box', `${reference}: UPS Ground Saver does not deliver to PO Boxes.`, reference);
      }
      if (country === 'US' && !isContiguousUs(state)) {
        warn('warning', 'ground_saver_area', `${reference}: UPS Ground Saver covers the contiguous 48 states only.`, reference);
      }
    }
    const stampsPrint = !NO_STAMP_SERVICES.has(service.code);
    if (!stampsPrint) {
      warn('info', 'no_rubber_stamps', `${reference}: rubber stamps do not print on ${service.name} labels, so the order id will not show on the label; match the package to its packing list another way.`, reference);
    }
    if (req.customs !== undefined && country === 'US') {
      warn('info', 'unsupported_option', `${reference}: customs info is ignored by the spreadsheet upload; complete it in Pirate Ship if needed.`, reference);
    }
    if (req.insuranceCents !== undefined) {
      warn('info', 'unsupported_option', `${reference}: insurance cannot be set from a spreadsheet; add it in Pirate Ship when buying.`, reference);
    }
    if (req.options !== undefined) {
      warn('info', 'unsupported_option', `${reference}: extra services (signature, etc.) cannot be set from a spreadsheet; choose them in Pirate Ship when buying.`, reference);
    }
    if (req.labelFormat !== undefined) {
      warn('info', 'unsupported_option', `${reference}: label format is chosen in Pirate Ship (Settings > Label size), not per shipment.`, reference);
    }
    const packageType = str(req.packageType);

    let parcels = Array.isArray(req.parcels) ? req.parcels : [];
    const noParcels = parcels.length === 0;
    if (noParcels) {
      warn('warning', 'no_parcels', `${reference}: no parcels given; one row with blank weight (Pirate Ship uses the batch default package).`, reference);
      parcels = [{ weightOz: NaN }];
    }
    const count = parcels.length;
    if (count > 999) return skip('too_many_parcels', 'more than 999 parcels.');
    if (count === 1 && PARCEL_SUFFIX.test(reference)) {
      warn('warning', 'reference_looks_like_parcel', `${reference}: reference ends like a parcel suffix (/NofM); tracking import may split it.`, reference);
    }

    const stampLimit = STAMP_LIMIT[service.carrier as 'UPS' | 'USPS'];
    const stamp2 = options.rubberStamp2 ?? '';
    const items = itemsText(req.items, (description, quantity) =>
      warn('warning', 'invalid_quantity', `${reference}: quantity ${JSON.stringify(quantity ?? null)} for "${description}" is not a positive whole number; shown as "?" on the packing list.`, reference),
    );
    const rows: CsvCell[][] = [];
    parcels.forEach((p, idx) => {
      const orderId = parcelOrderId(reference, idx + 1, count);
      const w = splitWeight(p?.weightOz);
      if (!w && !noParcels) {
        warn('warning', 'invalid_weight', `${orderId}: weight must be a positive number of ounces; left blank (batch default package applies).`, reference);
      }
      const dims = [num(p?.lengthIn), num(p?.widthIn), num(p?.heightIn)];
      const given = dims.filter(Boolean).length;
      if (given > 0 && given < 3) {
        warn('warning', 'partial_dimensions', `${orderId}: only some of length/width/height given; Pirate Ship needs all three.`, reference);
      }
      if (stampsPrint && orderId.length > stampLimit) {
        if (stamp2) {
          warn('warning', 'rubber_stamp_overflow', `${orderId}: longer than ${stampLimit} characters; it wraps onto the next stamp line and pushes Rubber Stamp 2 ("${stamp2}") off the label.`, reference);
        } else {
          warn('info', 'rubber_stamp_long', `${orderId}: longer than ${stampLimit} characters; Pirate Ship wraps then truncates the rubber stamp.`, reference);
        }
      }
      rows.push([
        orderId,
        name,
        company,
        addressText(to.line1),
        addressText(to.line2),
        str(to.city),
        state,
        zip,
        country,
        str(to.email),
        str(to.phone),
        w?.pounds ?? '',
        w?.ounces ?? '',
        dims[0],
        dims[1],
        dims[2],
        orderId,
        stamp2,
        psName,
        items,
        str(req.notes),
      ]);
    });

    seen.add(reference);
    prepared.push({ reference, service, packageType, rows });
  });

  const stamp2 = options.rubberStamp2 ?? '';
  if (stamp2) {
    for (const carrier of new Set(prepared.map((p) => p.service.carrier as 'UPS' | 'USPS'))) {
      if (stamp2.length > STAMP_LIMIT[carrier]) {
        warn('warning', 'rubber_stamp_long', `Rubber Stamp 2 "${stamp2}" is longer than ${STAMP_LIMIT[carrier]} characters for ${carrier} labels and will be wrapped or truncated.`);
      }
    }
  }
  if (prepared.length) {
    warn(
      'info',
      'first_upload_mapping',
      'First upload only (Pirate Ship remembers it): map ' +
        Object.entries(FIRST_UPLOAD_MAPPING)
          .map(([from, to]) => `${from} -> ${to}`)
          .join(', ') +
        '. Unmapped columns are dropped.',
    );
  }
  return { prepared, warnings, skipped };
}

/**
 * Group prepared shipments by key, in order of first appearance; input order
 * kept within a group.
 */
function groupBy(prepared: PreparedShipment[], key: (p: PreparedShipment) => string): Map<string, PreparedShipment[]> {
  const groups = new Map<string, PreparedShipment[]>();
  for (const p of prepared) {
    const k = key(p);
    const g = groups.get(k) ?? [];
    g.push(p);
    groups.set(k, g);
  }
  return groups;
}

const groupByService = (prepared: PreparedShipment[]) => groupBy(prepared, (p) => p.service.code);

function cellGuard(cell: string, column: number): string {
  return column === PHONE_COLUMN ? guardPhone(cell) : guardFormula(cell);
}

function toCsv(shipments: PreparedShipment[], options: PirateShipOptions): string {
  return writeCsv([[...PIRATE_SHIP_IMPORT_HEADERS], ...shipments.flatMap((s) => s.rows)], {
    bom: options.bom ?? false,
    formulaGuard: cellGuard,
  });
}

function packageSlug(packageType: string): string {
  return packageType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'package';
}

function serviceGroupWarning(groups: Map<string, PreparedShipment[]>): ExportWarning | null {
  if (groups.size === 0) return null;
  const parts = [...groups.values()].map(
    (g) => `${PIRATE_SHIP_SERVICE_NAMES[g[0]!.service.code]}: ${g.map((s) => s.reference).join(', ')}`,
  );
  const references = [...groups.values()].flatMap((g) => g.map((s) => s.reference));
  if (groups.size === 1) {
    return {
      level: 'info',
      code: 'buy_with_service',
      message: `When buying in Pirate Ship, choose ${parts[0]!.split(':')[0]} for every label in this upload.`,
      references,
    };
  }
  return {
    level: 'warning',
    code: 'mixed_services',
    message:
      'Pirate Ship cannot take the service from a spreadsheet; this file mixes services. ' +
      'Buy each group with its service (or use exportBatches for one file per service): ' +
      parts.join(' | '),
    references,
  };
}

// ---------------------------------------------------------------------------
// Tracking import (shipment export -> TrackingUpdate[])
// ---------------------------------------------------------------------------

const COLS = {
  tracking: ['Tracking Number', 'Tracking #', 'Tracking No', 'Tracking Code', 'Tracking ID', 'Tracking'],
  order: ['Order ID', 'Order Number', 'Order #', 'Order', 'Reference', 'Reference Number'],
  stamp: ['Rubber Stamp 1', 'Rubber Stamp', 'Stamp 1'],
  carrier: ['Carrier'],
  service: ['Service', 'Shipping Service', 'Service Name', 'Mail Class', 'Class'],
  cost: ['Cost', 'Label Cost', 'Total Cost', 'Postage', 'Shipping Cost', 'Amount', 'Price', 'Rate', 'Total'],
  date: ['Ship Date', 'Shipped At', 'Shipped Date', 'Created Date', 'Date Created', 'Label Created', 'Label Date', 'Created', 'Purchase Date', 'Date'],
  name: ['Recipient', 'Recipient Name', 'Full Name', 'Name', 'To Name', 'Ship To Name'],
  zip: ['Zip', 'Zipcode', 'Zip Code', 'Postal Code', 'Postcode', 'ZIP/Postal Code'],
  status: ['Tracking Status', 'Status', 'Label Status', 'Shipment Status'],
} as const;

const REFUND_TEXT = /\b(refund|refunded|refund requested|void|voided|cancel|cancelled|canceled)\b/i;

/** Every column that may carry a label/refund state: the status aliases, plus any header mentioning status, refund or void. */
function statusLikeColumns(headers: readonly string[]): string[] {
  const aliases = new Set(COLS.status.map(normalizeHeader));
  return headers.filter((h) => {
    const n = normalizeHeader(h);
    return n !== '' && (aliases.has(n) || n.includes('status') || n.includes('refund') || n.includes('void'));
  });
}

/**
 * Undo spreadsheet text-forcing on a cell: ="00123" -> 00123, and our own
 * formula-guard apostrophe ('=x -> =x) so references round-trip exactly.
 */
function cleanCell(v: string | undefined): string {
  let t = (v ?? '').trim();
  const forced = /^="(.*)"$/s.exec(t);
  if (forced) t = forced[1]!.replace(/""/g, '"');
  if (/^'[=+\-@\t\r＝＠]/.test(t)) t = t.slice(1);
  return t;
}

/** "$1,234.56" -> 123456; "(5.00)" / "-$5" -> -500. Exact (string arithmetic, half-up). Null if not money. */
export function parseCents(input: string): number | null {
  let t = input.trim().replace(/usd/gi, '').replace(/[\s,$]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-')) {
    negative = !negative;
    t = t.slice(1);
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const whole = Number(m[1] || '0');
  const frac = (m[2] ?? '').padEnd(3, '0');
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** M/D/YYYY, M/D/YY, YYYY-MM-DD (with optional time) -> YYYY-MM-DD. Null when not recognized. */
export function parseShipDate(input: string): string | null {
  const t = input.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,T].*)?$/.exec(t))) {
    mo = Number(m[1]);
    d = Number(m[2]);
    y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseTracking(text: string): TrackingImportResult {
  const updates: TrackingUpdate[] = [];
  const errors: ImportError[] = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { updates, errors: [{ row: 0, message: 'The file is empty.' }] };
  }
  if (text.startsWith('PK\u0003\u0004')) {
    return {
      updates,
      errors: [{ row: 0, message: 'This looks like an XLSX file. Set Pirate Ship Settings > General Settings > Spreadsheet Export Filetype to CSV and export again.' }],
    };
  }
  const table = parseCsvTable(text);
  if (table.unterminatedQuote) errors.push({ row: 0, message: 'The file ends inside a quoted field; the last row may be incomplete.' });
  const col = {
    tracking: table.column(...COLS.tracking),
    order: table.column(...COLS.order),
    stamp: table.column(...COLS.stamp),
    carrier: table.column(...COLS.carrier),
    service: table.column(...COLS.service),
    cost: table.column(...COLS.cost),
    date: table.column(...COLS.date),
    name: table.column(...COLS.name),
    zip: table.column(...COLS.zip),
    status: table.column(...COLS.status),
  };
  if (!col.tracking) {
    errors.push({ row: 1, message: `No tracking number column found. Headers: ${table.headers.join(', ') || '(none)'}` });
    return { updates, errors };
  }
  const get = (values: Record<string, string>, h: string | undefined) => (h ? cleanCell(values[h]) : '');
  const statusCols = statusLikeColumns(table.headers);
  const seen = new Set<string>();

  for (const { row, values } of table.rows) {
    const trackingNumber = get(values, col.tracking).replace(/\s+/g, '');
    const status = get(values, col.status);
    if (!trackingNumber) {
      errors.push({ row, message: 'No tracking number; row skipped.' });
      continue;
    }
    const refundCol = statusCols.find((h) => REFUND_TEXT.test(get(values, h)));
    if (refundCol) {
      errors.push({ row, message: `Label ${trackingNumber} is "${get(values, refundCol)}" (${refundCol}); row skipped.` });
      continue;
    }
    if (seen.has(trackingNumber)) {
      errors.push({ row, message: `Duplicate tracking number ${trackingNumber}; row skipped.` });
      continue;
    }
    seen.add(trackingNumber);

    const orderId = get(values, col.order) || get(values, col.stamp);
    const { reference, parcel } = orderId ? splitParcelOrderId(orderId) : { reference: null, parcel: undefined };

    const serviceName = get(values, col.service);
    const carrierText = get(values, col.carrier);
    let carrier = parseCarrier(carrierText) ?? parseCarrier(serviceName);
    const resolved = serviceName ? resolveService(serviceName, carrier ? { carrier } : {}) : null;
    if (!carrier) carrier = resolved?.carrier ?? inferCarrier(trackingNumber);

    const update: TrackingUpdate = { reference, trackingNumber, carrier };
    if (parcel) update.parcel = parcel;
    if (resolved) update.service = toSelection(resolved);
    if (serviceName) update.serviceName = serviceName;
    const costText = get(values, col.cost);
    if (costText) {
      const c = parseCents(costText);
      if (c !== null) update.costCents = c;
    }
    const dateText = get(values, col.date);
    if (dateText) update.shippedAt = parseShipDate(dateText) ?? dateText;
    const name = get(values, col.name);
    if (name) update.recipientName = name;
    const zip = get(values, col.zip);
    if (zip) update.recipientPostalCode = zip;
    if (status) update.status = status;
    update.raw = Object.assign(Object.create(null) as Record<string, string>, values);
    updates.push(update);
  }
  return { updates, errors };
}

export function createPirateShipProvider(options: PirateShipOptions = {}): PirateShipProvider {
  const base = sanitizeFilename(options.filenameBase ?? 'pirateship-import');
  return {
    id: PIRATE_SHIP_ID,
    displayName: PIRATE_SHIP_DISPLAY_NAME,
    appUrl: PIRATE_SHIP_APP_URL,
    capabilities: Object.freeze({ exportFile: true, importTracking: true, purchaseLabel: false, rates: false, track: false, voidLabel: false }),

    exportShipments(requests) {
      const { prepared, warnings, skipped } = prepare(requests, options);
      const groups = groupByService(prepared);
      const ordered = [...groups.values()].flat();
      const sw = serviceGroupWarning(groups);
      if (sw) warnings.push(sw);
      const pkgs = groupBy(prepared, (p) => p.packageType);
      if (pkgs.size > 1) {
        warnings.push({
          level: 'warning',
          code: 'mixed_package_types',
          message:
            'Pirate Ship takes one package selection per upload; this file mixes package types (use exportBatches for one file per service and package): ' +
            [...pkgs].map(([k, g]) => `${k || '(default)'}: ${g.map((s) => s.reference).join(', ')}`).join(' | '),
          references: prepared.map((p) => p.reference),
        });
      }
      return {
        filename: `${base}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        content: toCsv(ordered, options),
        warnings,
        skipped,
      };
    },

    exportBatches(requests) {
      const { prepared, warnings, skipped } = prepare(requests, options);
      const batches: PirateShipBatch[] = [];
      // One file per (service, package type): Pirate Ship takes the service
      // and the package selection per batch, not per row.
      for (const group of groupBy(prepared, (p) => `${p.service.code}\u0000${p.packageType}`).values()) {
        const { code } = group[0]!.service;
        const packageType = group[0]!.packageType;
        const psName = PIRATE_SHIP_SERVICE_NAMES[code]!;
        const references = group.map((g) => g.reference);
        const filename = packageType ? `${base}-${code}-${packageSlug(packageType)}.csv` : `${base}-${code}.csv`;
        batches.push({
          filename,
          mimeType: 'text/csv;charset=utf-8',
          content: toCsv(group, options),
          service: toSelection(group[0]!.service),
          ...(packageType ? { packageType } : {}),
          pirateShipService: psName,
          references,
        });
        warnings.push({
          level: 'info',
          code: 'buy_with_service',
          message: `${filename}: choose ${psName}${packageType ? ` and the "${packageType}" package` : ''} for every label in this batch.`,
          references,
        });
      }
      return { batches, warnings, skipped };
    },

    parseTrackingImport: parseTracking,
  };
}

/** Convenience: tracking URL for an update, or null when the carrier is unknown. */
export function trackingUrlFor(update: Pick<TrackingUpdate, 'carrier' | 'trackingNumber'>): string | null {
  return isKnownCarrier(update.carrier) ? trackingUrl(update.carrier, update.trackingNumber) : null;
}
