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
 * column; the service is picked per batch in the UI when buying. So the
 * checkout service is carried in a visible "Requested Shipping Service"
 * column, exportBatches() produces one file per service, and
 * reconcileShipments() (../reconcile.ts) checks the export's Service column
 * against the order after purchase.
 */

import { isContiguousUs, isPoBox, missingAddressFields, normalizeCountry, normalizeUsState, normalizeUsZip } from '../address';
import { parseCsvTable, writeCsv, type CsvCell } from '../csv';
import { inferCarrier, parseCarrier, resolveService, toSelection, trackingUrl, type ServiceDefinition } from '../services';
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

/** Rubber stamp line lengths (article 1804193): USPS 25 chars; UPS 35 per line. */
const STAMP_LIMIT = { USPS: 25, UPS: 35 } as const;

/** Multi-parcel Order ID suffix: "ORDER-1" parcel 2 of 3 -> "ORDER-1/2of3". */
const PARCEL_SUFFIX = /^(.+)\/(\d{1,3})of(\d{1,3})$/;

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
  rows: CsvCell[][];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** Finite positive number rounded to 2 decimals as a plain numeric string, else ''. */
function num(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  return String(Math.round(v * 100) / 100);
}

function splitWeight(weightOz: unknown): { pounds: string; ounces: string } | null {
  if (typeof weightOz !== 'number' || !Number.isFinite(weightOz) || weightOz <= 0) return null;
  const totalHundredths = Math.round(weightOz * 100);
  const lb = Math.floor(totalHundredths / 1600);
  const oz = (totalHundredths - lb * 1600) / 100;
  return { pounds: String(lb), ounces: String(oz) };
}

function sanitizeFilename(base: string): string {
  const s = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s || 'pirateship-import';
}

function resolveRequestService(service: unknown): ServiceDefinition | null {
  if (!service || typeof service !== 'object') return null;
  const s = service as Partial<ServiceSelection>;
  const carrier = s.carrier;
  const opts = carrier === 'UPS' || carrier === 'USPS' || carrier === 'FedEx' || carrier === 'DHL' ? { carrier } : {};
  return resolveService(s.code, opts) ?? resolveService(s.name, opts);
}

function itemsText(items: ShipmentRequest['items']): string {
  if (!Array.isArray(items)) return '';
  return items
    .filter((i) => i && typeof i.description === 'string' && i.description.trim())
    .map((i) => `${Number.isFinite(i.quantity) ? i.quantity : 1} x ${i.description.trim()}`)
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

    const service = resolveRequestService(req.service);
    if (!service) {
      const shown = req.service && typeof req.service === 'object' ? str(req.service.name) || str(req.service.code) : '';
      return skip('unknown_service', `checkout service "${shown}" is not a known service.`);
    }
    const psName = PIRATE_SHIP_SERVICE_NAMES[service.code];
    if (!psName) return skip('unsupported_service', `${service.name} is not sold on Pirate Ship (UPS and USPS only).`);

    const to = (req.to ?? {}) as Partial<ShipmentRequest['to']>;
    let name = str(to.name);
    const company = str(to.company);
    if (!name && company) {
      name = company;
      warn('info', 'name_from_company', `${reference}: no recipient name; using the company name.`, reference);
    }
    const missing = missingAddressFields({ ...to, name });
    if (missing.length) return skip('missing_field', `recipient address is missing ${missing.join(', ')}.`);

    const country = normalizeCountry(to.country);
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
      warn('info', 'no_rubber_stamps', `${reference}: rubber stamps do not print on UPS Ground Saver labels, so the order id will not show on the label.`, reference);
    }

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
      if (orderId.length > stampLimit) {
        warn('info', 'rubber_stamp_long', `${orderId}: longer than ${stampLimit} characters; Pirate Ship wraps then truncates the rubber stamp.`, reference);
      }
      rows.push([
        orderId,
        name,
        company,
        str(to.line1),
        str(to.line2),
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
        options.rubberStamp2 ?? '',
        psName,
        itemsText(req.items),
        str(req.notes),
      ]);
    });

    seen.add(reference);
    prepared.push({ reference, service, rows });
  });

  return { prepared, warnings, skipped };
}

/** Group prepared shipments by service, in order of first appearance; input order kept within a group. */
function groupByService(prepared: PreparedShipment[]): Map<string, PreparedShipment[]> {
  const groups = new Map<string, PreparedShipment[]>();
  for (const p of prepared) {
    const g = groups.get(p.service.code) ?? [];
    g.push(p);
    groups.set(p.service.code, g);
  }
  return groups;
}

function toCsv(shipments: PreparedShipment[], options: PirateShipOptions): string {
  return writeCsv([[...PIRATE_SHIP_IMPORT_HEADERS], ...shipments.flatMap((s) => s.rows)], { bom: options.bom ?? false });
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
  const seen = new Set<string>();

  for (const { row, values } of table.rows) {
    const trackingNumber = get(values, col.tracking).replace(/\s+/g, '');
    const status = get(values, col.status);
    if (!trackingNumber) {
      errors.push({ row, message: 'No tracking number; row skipped.' });
      continue;
    }
    if (status && /\b(refund|refunded|void|voided|cancel|cancelled|canceled)\b/i.test(status)) {
      errors.push({ row, message: `Label ${trackingNumber} is "${status}"; row skipped.` });
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
    update.raw = { ...values };
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
    capabilities: Object.freeze({ exportFile: true, importTracking: true, purchaseLabel: false, rates: false }),

    exportShipments(requests) {
      const { prepared, warnings, skipped } = prepare(requests, options);
      const groups = groupByService(prepared);
      const ordered = [...groups.values()].flat();
      const sw = serviceGroupWarning(groups);
      if (sw) warnings.push(sw);
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
      for (const [code, group] of groupByService(prepared)) {
        const psName = PIRATE_SHIP_SERVICE_NAMES[code]!;
        const references = group.map((g) => g.reference);
        batches.push({
          filename: `${base}-${code}.csv`,
          mimeType: 'text/csv;charset=utf-8',
          content: toCsv(group, options),
          service: toSelection(group[0]!.service),
          pirateShipService: psName,
          references,
        });
        warnings.push({
          level: 'info',
          code: 'buy_with_service',
          message: `${base}-${code}.csv: choose ${psName} for every label in this batch.`,
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
  return update.carrier ? trackingUrl(update.carrier, update.trackingNumber) : null;
}
