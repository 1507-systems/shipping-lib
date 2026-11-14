import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvTable, type ShipmentRequest, type ServiceSelection } from '../src/index';
import {
  createPirateShipProvider,
  parcelOrderId,
  parseCents,
  parseShipDate,
  splitParcelOrderId,
  trackingUrlFor,
  PIRATE_SHIP_APP_URL,
  PIRATE_SHIP_IMPORT_HEADERS,
} from '../src/pirateship';
import { PIRATE_SHIP_EXPORT_CSV } from './fixtures/pirateship-shipment-export';

const UPS_GROUND: ServiceSelection = { carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' };
const UPS_2DAY: ServiceSelection = { carrier: 'UPS', code: 'ups_2nd_day_air', name: 'UPS 2nd Day Air' };
const USPS_PRIORITY: ServiceSelection = { carrier: 'USPS', code: 'usps_priority', name: 'USPS Priority Mail' };

const addr = (over: Partial<ShipmentRequest['to']> = {}): ShipmentRequest['to'] => ({
  name: 'Ada Lovelace',
  line1: '12 Analytical Way',
  city: 'Longmont',
  state: 'CO',
  postalCode: '80501',
  country: 'US',
  ...over,
});

const req = (reference: string, over: Partial<ShipmentRequest> = {}): ShipmentRequest => ({
  reference,
  service: UPS_GROUND,
  to: addr(),
  parcels: [{ weightOz: 40, lengthIn: 10, widthIn: 8, heightIn: 4 }],
  ...over,
});

const ps = createPirateShipProvider();
const rows = (csv: string) => {
  const t = parseCsvTable(csv);
  return t.rows.map((r) => r.values);
};
const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe('provider metadata', () => {
  it('is CSV-only: no label purchase, no rates', () => {
    expect(ps.id).toBe('pirateship');
    expect(ps.displayName).toBe('Pirate Ship');
    expect(ps.appUrl).toBe(PIRATE_SHIP_APP_URL);
    expect(ps.capabilities).toEqual({ exportFile: true, importTracking: true, purchaseLabel: false, rates: false });
    expect(ps.purchaseLabel).toBeUndefined();
    expect(ps.getRates).toBeUndefined();
  });
});

describe('exportShipments', () => {
  it('emits the exact fixed header row', () => {
    const out = ps.exportShipments([req('A-1')]);
    expect(out.content.split('\r\n')[0]).toBe(
      'Order ID,Full Name,Company,Address Line 1,Address Line 2,City,State,Zip,Country,Email,Phone,Pounds,Ounces,Length,Width,Height,Rubber Stamp 1,Rubber Stamp 2,Requested Shipping Service,Order Items,Note',
    );
    expect(parseCsv(out.content).records[0]).toEqual([...PIRATE_SHIP_IMPORT_HEADERS]);
    expect(out.filename).toBe('pirateship-import.csv');
    expect(out.mimeType).toBe('text/csv;charset=utf-8');
  });

  it('header row is identical even for an empty export (mapping is remembered by header)', () => {
    const out = ps.exportShipments([]);
    expect(out.content).toBe(PIRATE_SHIP_IMPORT_HEADERS.join(',') + '\r\n');
    expect(out.warnings).toEqual([]);
  });

  it('fills a row: order id, stamp, Pirate Ship service name, weight split, dims, items', () => {
    const out = ps.exportShipments([
      req('A-1', {
        to: addr({ company: 'Engines Ltd', line2: 'Suite 1', email: 'ada@example.com', phone: '+1 (555) 010-0199' }),
        items: [
          { description: 'Widget', quantity: 2 },
          { description: 'Gadget, large', quantity: 1 },
        ],
        notes: 'Gift',
      }),
    ]);
    expect(rows(out.content)).toEqual([
      {
        'Order ID': 'A-1',
        'Full Name': 'Ada Lovelace',
        Company: 'Engines Ltd',
        'Address Line 1': '12 Analytical Way',
        'Address Line 2': 'Suite 1',
        City: 'Longmont',
        State: 'CO',
        Zip: '80501',
        Country: 'US',
        Email: 'ada@example.com',
        Phone: '+1 (555) 010-0199',
        Pounds: '2',
        Ounces: '8',
        Length: '10',
        Width: '8',
        Height: '4',
        'Rubber Stamp 1': 'A-1',
        'Rubber Stamp 2': '',
        'Requested Shipping Service': 'UPS® Ground',
        'Order Items': '2 x Widget; 1 x Gadget, large',
        Note: 'Gift',
      },
    ]);
    expect(out.warnings).toEqual([
      expect.objectContaining({ level: 'info', code: 'buy_with_service', references: ['A-1'] }),
    ]);
    expect(out.warnings[0]!.message).toContain('UPS® Ground');
  });

  it('splits weights into pounds + ounces exactly', () => {
    const out = ps.exportShipments([
      req('W', { parcels: [{ weightOz: 15.5 }, { weightOz: 16 }, { weightOz: 33.333 }, { weightOz: 0.1 }] }),
    ]);
    const r = rows(out.content);
    expect(r.map((x) => [x.Pounds, x.Ounces])).toEqual([
      ['0', '15.5'],
      ['1', '0'],
      ['2', '1.33'],
      ['0', '0.1'],
    ]);
    expect(r.map((x) => x.Length)).toEqual(['', '', '', '']);
  });

  it('emits one row per parcel with suffixed Order IDs in stamp and Order ID', () => {
    const out = ps.exportShipments([req('ORDER-1', { parcels: [{ weightOz: 10 }, { weightOz: 12 }, { weightOz: 14 }] })]);
    const r = rows(out.content);
    expect(r.map((x) => x['Order ID'])).toEqual(['ORDER-1/1of3', 'ORDER-1/2of3', 'ORDER-1/3of3']);
    expect(r.map((x) => x['Rubber Stamp 1'])).toEqual(['ORDER-1/1of3', 'ORDER-1/2of3', 'ORDER-1/3of3']);
  });

  it('uses the rubberStamp2 option and filename base (sanitized)', () => {
    const p = createPirateShipProvider({ rubberStamp2: 'Packing list enclosed', filenameBase: '../store orders 11/13' });
    const out = p.exportShipments([req('A')]);
    expect(rows(out.content)[0]!['Rubber Stamp 2']).toBe('Packing list enclosed');
    expect(out.filename).toBe('store-orders-11-13.csv');
  });

  it('can prefix a BOM', () => {
    const out = createPirateShipProvider({ bom: true }).exportShipments([req('A')]);
    expect(out.content.startsWith('﻿Order ID,')).toBe(true);
  });

  it('groups mixed services contiguously and warns with the groups', () => {
    const out = ps.exportShipments([
      req('G1'),
      req('D1', { service: UPS_2DAY }),
      req('G2', { service: { carrier: 'UPS', code: '03', name: 'whatever' } }),
      req('P1', { service: USPS_PRIORITY }),
    ]);
    const r = rows(out.content);
    expect(r.map((x) => [x['Order ID'], x['Requested Shipping Service']])).toEqual([
      ['G1', 'UPS® Ground'],
      ['G2', 'UPS® Ground'],
      ['D1', 'UPS 2nd Day Air®'],
      ['P1', 'USPS Priority Mail®'],
    ]);
    const mixed = out.warnings.find((w) => w.code === 'mixed_services')!;
    expect(mixed.level).toBe('warning');
    expect(mixed.message).toContain('UPS® Ground: G1, G2');
    expect(mixed.message).toContain('UPS 2nd Day Air®: D1');
    expect(mixed.message).toContain('USPS Priority Mail®: P1');
    expect(mixed.references).toEqual(['G1', 'G2', 'D1', 'P1']);
  });

  it('resolves the checkout service by name when the code is loose', () => {
    const out = ps.exportShipments([req('N', { service: { carrier: 'UPS', code: '', name: 'UPS Next Day Air' } })]);
    expect(rows(out.content)[0]!['Requested Shipping Service']).toBe('UPS Next Day Air®');
  });

  it('neutralizes formula injection but leaves phone numbers intact', () => {
    const out = ps.exportShipments([
      req('X', { to: addr({ name: '=HYPERLINK("http://evil","click")', company: '@SUM(A1)', phone: '+1 555 010 0199' }), notes: '-cmd|calc' }),
    ]);
    const r = rows(out.content)[0]!;
    expect(r['Full Name']).toBe('\'=HYPERLINK("http://evil","click")');
    expect(r.Company).toBe("'@SUM(A1)");
    expect(r.Note).toBe("'-cmd|calc");
    expect(r.Phone).toBe('+1 555 010 0199');
  });

  it('normalizes US state names and 9-digit ZIPs, warns on bad ones', () => {
    const out = ps.exportShipments([
      req('S1', { to: addr({ state: 'Colorado', postalCode: '805011234', country: 'usa' }) }),
      req('S2', { to: addr({ state: 'Narnia', postalCode: '123' }) }),
    ]);
    const r = rows(out.content);
    expect([r[0]!.State, r[0]!.Zip, r[0]!.Country]).toEqual(['CO', '80501-1234', 'US']);
    expect([r[1]!.State, r[1]!.Zip]).toEqual(['Narnia', '123']);
    expect(codes(out.warnings)).toEqual(expect.arrayContaining(['invalid_state', 'invalid_zip']));
  });

  it('skips rows missing required address fields with a warning, never throws', () => {
    const out = ps.exportShipments([
      req('OK'),
      req('BAD', { to: { name: 'X', line1: '', city: '', state: 'CO', postalCode: '80501', country: 'US' } }),
      { reference: 'NOTO', service: UPS_GROUND } as unknown as ShipmentRequest,
    ]);
    expect(out.skipped).toEqual(['BAD', 'NOTO']);
    const missing = out.warnings.filter((w) => w.code === 'missing_field');
    expect(missing.map((w) => w.references)).toEqual([['BAD'], ['NOTO']]);
    expect(missing[0]!.message).toContain('line1, city');
    expect(rows(out.content).map((x) => x['Order ID'])).toEqual(['OK']);
  });

  it('uses the company as the name when the name is blank', () => {
    const out = ps.exportShipments([req('C', { to: addr({ name: '', company: 'Acme' }) })]);
    expect(rows(out.content)[0]!['Full Name']).toBe('Acme');
    expect(codes(out.warnings)).toContain('name_from_company');
  });

  it('tolerates garbage input', () => {
    const bad = ps.exportShipments(null as unknown as ShipmentRequest[]);
    expect(codes(bad.warnings)).toEqual(['invalid_input']);
    const mixed = ps.exportShipments([null, 42, req('A')] as unknown as ShipmentRequest[]);
    expect(mixed.skipped).toEqual(['#1', '#2']);
    expect(rows(mixed.content)).toHaveLength(1);
  });

  it('skips missing/duplicate references and unknown/unsupported services', () => {
    const out = ps.exportShipments([
      req(''),
      req('DUP'),
      req('DUP'),
      req('FX', { service: { carrier: 'FedEx', code: 'fedex_ground', name: 'FedEx Ground' } }),
      req('UNK', { service: { carrier: 'UPS', code: 'mystery', name: 'Standard shipping' } }),
    ]);
    expect(out.skipped).toEqual(['#1', 'DUP', 'FX', 'UNK']);
    expect(codes(out.warnings)).toEqual(
      expect.arrayContaining(['missing_reference', 'duplicate_reference', 'unsupported_service', 'unknown_service']),
    );
    expect(rows(out.content).map((x) => x['Order ID'])).toEqual(['DUP']);
  });

  it('warns on weight and dimension problems but keeps the row', () => {
    const out = ps.exportShipments([
      req('W0', { parcels: [{ weightOz: 0 }] }),
      req('WN', { parcels: [{ weightOz: Number.NaN, lengthIn: 5 }] }),
      req('NP', { parcels: [] }),
    ]);
    const r = rows(out.content);
    expect(r.map((x) => [x['Order ID'], x.Pounds, x.Ounces])).toEqual([
      ['W0', '', ''],
      ['WN', '', ''],
      ['NP', '', ''],
    ]);
    const c = codes(out.warnings);
    expect(c.filter((x) => x === 'invalid_weight')).toHaveLength(2);
    expect(c).toContain('partial_dimensions');
    expect(c).toContain('no_parcels');
  });

  it('flags UPS Ground Saver restrictions', () => {
    const saver: ServiceSelection = { carrier: 'UPS', code: 'ups_ground_saver', name: 'UPS Ground Saver' };
    const out = ps.exportShipments([req('GS', { service: saver, to: addr({ line1: 'PO Box 7', state: 'AK', postalCode: '99501' }) })]);
    expect(codes(out.warnings)).toEqual(expect.arrayContaining(['ground_saver_po_box', 'ground_saver_area', 'no_rubber_stamps']));
  });

  it('flags international shipments and service/destination mismatches', () => {
    const out = ps.exportShipments([
      req('INTL', { to: addr({ country: 'CA', state: 'ON', postalCode: 'K1A 0B1' }) }),
      req('STD', { service: { carrier: 'UPS', code: 'ups_standard', name: 'UPS Standard' } }),
    ]);
    const r = rows(out.content);
    expect(r[0]!.Country).toBe('CA');
    expect(r[0]!.Zip).toBe('K1A 0B1');
    const mismatches = out.warnings.filter((w) => w.code === 'service_destination_mismatch');
    expect(mismatches.map((w) => w.references)).toEqual([['INTL'], ['STD']]);
    expect(codes(out.warnings)).toContain('customs_required');
  });

  it('notes long rubber stamps and parcel-like references', () => {
    const out = ps.exportShipments([
      req('X'.repeat(40)),
      req('USPS-ABCDEFGHIJKLMNOPQRSTUVW', { service: USPS_PRIORITY }),
      req('Z/1of2'),
    ]);
    const long = out.warnings.filter((w) => w.code === 'rubber_stamp_long');
    expect(long).toHaveLength(2);
    expect(codes(out.warnings)).toContain('reference_looks_like_parcel');
  });
});

describe('exportBatches', () => {
  it('writes one file per service, each with the same headers and only its shipments', () => {
    const res = ps.exportBatches([req('G1'), req('D1', { service: UPS_2DAY }), req('G2'), req('BAD', { to: addr({ city: '' }) })]);
    expect(res.skipped).toEqual(['BAD']);
    expect(res.batches.map((b) => [b.filename, b.service.code, b.pirateShipService, b.references])).toEqual([
      ['pirateship-import-ups_ground.csv', 'ups_ground', 'UPS® Ground', ['G1', 'G2']],
      ['pirateship-import-ups_2nd_day_air.csv', 'ups_2nd_day_air', 'UPS 2nd Day Air®', ['D1']],
    ]);
    for (const b of res.batches) {
      expect(parseCsv(b.content).records[0]).toEqual([...PIRATE_SHIP_IMPORT_HEADERS]);
      const svc = new Set(rows(b.content).map((x) => x['Requested Shipping Service']));
      expect([...svc]).toEqual([b.pirateShipService]);
    }
    const buy = res.warnings.filter((w) => w.code === 'buy_with_service');
    expect(buy.map((w) => w.references)).toEqual([['G1', 'G2'], ['D1']]);
    expect(buy[1]!.message).toContain('UPS 2nd Day Air®');
  });
});

describe('parseTrackingImport (fixture)', () => {
  const res = ps.parseTrackingImport(PIRATE_SHIP_EXPORT_CSV);

  it('parses valid rows into updates', () => {
    expect(res.updates.map((u) => u.trackingNumber)).toEqual([
      '1Z999AA10123456784',
      '1Z999AA10123456791',
      '1Z999AA10123456808',
      '9400100000000000000017',
      '9405500000000000000024',
    ]);
    const first = res.updates[0]!;
    expect(first).toMatchObject({
      reference: 'ORDER-1001',
      carrier: 'UPS',
      service: { carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' },
      serviceName: 'UPS® Ground',
      costCents: 1234,
      shippedAt: '2026-11-12',
      recipientName: 'Ada Lovelace',
      recipientPostalCode: '80501',
      status: 'In Transit',
    });
    expect(first.parcel).toBeUndefined();
    expect(first.raw?.['Insurance Type']).toBe('None');
  });

  it('splits multi-parcel order ids', () => {
    expect(res.updates[1]).toMatchObject({ reference: 'ORDER-1002', parcel: { index: 1, count: 2 }, costCents: 2510 });
    expect(res.updates[2]).toMatchObject({ reference: 'ORDER-1002', parcel: { index: 2, count: 2 } });
  });

  it('resolves service variants and keeps null reference when absent', () => {
    expect(res.updates[3]!.service?.code).toBe('usps_ground_advantage');
    expect(res.updates[4]).toMatchObject({ reference: null, carrier: 'USPS', service: { code: 'usps_priority' } });
  });

  it('reports skipped rows with their record numbers', () => {
    expect(res.errors).toEqual([
      { row: 7, message: 'Label 1Z999AA10123456815 is "Refunded"; row skipped.' },
      { row: 8, message: 'No tracking number; row skipped.' },
    ]);
  });
});

describe('parseTrackingImport (variants)', () => {
  it('accepts header variants, Excel-forced cells and our guard apostrophe', () => {
    const csv = 'tracking #,ORDER NUMBER,service,total cost,date\n="1Z999AA10123456784",\'=EVIL-1,UPS Ground,"$1,234.565",2026-11-13 08:15:00\n';
    const { updates, errors } = ps.parseTrackingImport(csv);
    expect(errors).toEqual([]);
    expect(updates[0]).toMatchObject({
      trackingNumber: '1Z999AA10123456784',
      reference: '=EVIL-1',
      carrier: 'UPS',
      costCents: 123457,
      shippedAt: '2026-11-13',
    });
  });

  it('falls back to Rubber Stamp 1 for the reference and infers carrier from the number', () => {
    const { updates } = ps.parseTrackingImport('Tracking Number,Order ID,Rubber Stamp 1\n9400100000000000000017,,R-9/2of2\n123456789012,,\n');
    expect(updates[0]).toMatchObject({ reference: 'R-9', parcel: { index: 2, count: 2 }, carrier: 'USPS' });
    expect(updates[1]).toMatchObject({ reference: null, carrier: null });
    expect(updates[1]!.service).toBeUndefined();
  });

  it('keeps unrecognized dates and unparseable services verbatim', () => {
    const { updates } = ps.parseTrackingImport('Tracking Number,Created Date,Service\n1Z999AA10123456784,Nov 13 2026,Pirate Special\n');
    expect(updates[0]).toMatchObject({ shippedAt: 'Nov 13 2026', serviceName: 'Pirate Special', carrier: 'UPS' });
    expect(updates[0]!.service).toBeUndefined();
  });

  it('skips duplicate tracking numbers', () => {
    const { updates, errors } = ps.parseTrackingImport('Tracking Number\n1Z1\n1Z1\n');
    expect(updates).toHaveLength(1);
    expect(errors).toEqual([{ row: 3, message: 'Duplicate tracking number 1Z1; row skipped.' }]);
  });

  it('reports file-level problems without throwing', () => {
    expect(ps.parseTrackingImport('').errors[0]).toEqual({ row: 0, message: 'The file is empty.' });
    expect(ps.parseTrackingImport(null as unknown as string).errors[0]!.row).toBe(0);
    expect(ps.parseTrackingImport('PK\u0003\u0004binary').errors[0]!.message).toContain('XLSX');
    const noCol = ps.parseTrackingImport('Name,Zip\nA,1\n');
    expect(noCol.updates).toEqual([]);
    expect(noCol.errors[0]).toMatchObject({ row: 1 });
    expect(noCol.errors[0]!.message).toContain('Name, Zip');
    expect(ps.parseTrackingImport('Tracking Number\n"1Z1').errors[0]!.message).toContain('quoted');
  });
});

describe('helpers', () => {
  it('parcelOrderId / splitParcelOrderId round-trip', () => {
    expect(parcelOrderId('A', 1, 1)).toBe('A');
    expect(parcelOrderId('A', 2, 3)).toBe('A/2of3');
    expect(splitParcelOrderId('A/2of3')).toEqual({ reference: 'A', parcel: { index: 2, count: 3 } });
    expect(splitParcelOrderId('A/2of3/1of2')).toEqual({ reference: 'A/2of3', parcel: { index: 1, count: 2 } });
    expect(splitParcelOrderId('A/4of3')).toEqual({ reference: 'A/4of3' });
    expect(splitParcelOrderId('A/1of1')).toEqual({ reference: 'A/1of1' });
    expect(splitParcelOrderId('2026/0042')).toEqual({ reference: '2026/0042' });
  });

  it('parseCents', () => {
    expect(parseCents('$12.34')).toBe(1234);
    expect(parseCents('12')).toBe(1200);
    expect(parseCents('0.105')).toBe(11);
    expect(parseCents('1,234.5 USD')).toBe(123450);
    expect(parseCents('-$5.00')).toBe(-500);
    expect(parseCents('($5.00)')).toBe(-500);
    expect(parseCents('.99')).toBe(99);
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('')).toBeNull();
    expect(parseCents('$')).toBeNull();
  });

  it('parseShipDate', () => {
    expect(parseShipDate('11/13/2026')).toBe('2026-11-13');
    expect(parseShipDate('1/2/26')).toBe('2026-01-02');
    expect(parseShipDate('2026-11-13T10:00:00Z')).toBe('2026-11-13');
    expect(parseShipDate('11/13/2026 3:04 PM')).toBe('2026-11-13');
    expect(parseShipDate('2/30/2026')).toBeNull();
    expect(parseShipDate('yesterday')).toBeNull();
  });

  it('trackingUrlFor', () => {
    expect(trackingUrlFor({ carrier: 'UPS', trackingNumber: '1Z1' })).toBe('https://www.ups.com/track?tracknum=1Z1');
    expect(trackingUrlFor({ carrier: null, trackingNumber: 'x' })).toBeNull();
  });
});
