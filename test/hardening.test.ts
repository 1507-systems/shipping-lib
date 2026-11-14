/**
 * Regression tests for the review findings fixed after the initial release:
 * reconcile matching/resolution, CSV guard corruption, parcel-suffix case,
 * tiny weights, prototype-named headers, loose quantities, multi-column
 * refund detection, Pirate Ship stamp/batch/mapping warnings, countries and
 * the extended live-API provider interface.
 */
import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  guardPhone,
  isIsoCountry,
  normalizeCountry,
  parseCsvTable,
  reconcileShipments,
  resolveSelection,
  sameService,
  writeCsv,
  type PurchaseOptions,
  type PurchaseResult,
  type RateQuote,
  type ServiceSelection,
  type ShipmentRequest,
  type ShippingProvider,
  type TrackingUpdate,
} from '../src/index';
import { createPirateShipProvider, FIRST_UPLOAD_MAPPING, splitParcelOrderId, trackingUrlFor } from '../src/pirateship';

const UPS_GROUND: ServiceSelection = { carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' };

const addr = (over: Partial<ShipmentRequest['to']> = {}): ShipmentRequest['to'] => ({
  name: 'Jane Doe',
  line1: '1 Main St',
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
  parcels: [{ weightOz: 40 }],
  ...over,
});

const ps = createPirateShipProvider();
const rows = (csv: string) => parseCsvTable(csv).rows.map((r) => r.values);
const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe('reconcile: recipient fallback only for reference-less updates', () => {
  it('does not attach a repeat customer\'s old labelled order to the new one', () => {
    const requests = [req('ORDER-2000', { service: { carrier: 'UPS', code: 'ups_next_day_air', name: 'UPS Next Day Air' } })];
    const { updates } = ps.parseTrackingImport(
      'Tracking Number,Order ID,Recipient,Zip,Service\r\n1Z999AA10123456784,ORDER-1500,Jane Doe,80501,UPS® Ground\r\n',
    );
    const r = reconcileShipments(requests, updates);
    expect(r.entries[0]).toMatchObject({ reference: 'ORDER-2000', status: 'pending', trackingNumbers: [] });
    expect(r.unmatched.map((u) => u.reference)).toEqual(['ORDER-1500']);
  });

  it('still uses the fallback when the update has no reference', () => {
    const u: TrackingUpdate = { reference: null, trackingNumber: 'T1', carrier: 'UPS', recipientName: 'Jane Doe', recipientPostalCode: '80501', service: UPS_GROUND };
    const r = reconcileShipments([req('ORDER-2000')], [u]);
    expect(r.entries[0]!.matches.map((m) => m.via)).toEqual(['recipient']);
  });
});

describe('reconcile: checkout service resolved like the exporter', () => {
  const nda = { carrier: 'ups', code: '01', name: 'UPS Next Day Air' } as unknown as ServiceSelection;

  it('a lowercase carrier exports and reconciles as a match', () => {
    const out = ps.exportShipments([req('N-1', { service: nda })]);
    expect(out.skipped).toEqual([]);
    expect(rows(out.content)[0]!['Requested Shipping Service']).toBe('UPS Next Day Air®');
    const { updates } = ps.parseTrackingImport('Tracking Number,Order ID,Service\r\n1Z1,N-1,UPS Next Day Air®\r\n');
    const e = reconcileShipments([req('N-1', { service: nda })], updates).entries[0]!;
    expect(e).toMatchObject({ serviceCheck: 'match', expectedResolved: true });
    expect(e.expected).toEqual({ carrier: 'UPS', code: 'ups_next_day_air', name: 'UPS Next Day Air' });
  });

  it('an unresolvable checkout service is unverified, never a raw-code mismatch', () => {
    const odd: ServiceSelection = { carrier: 'OnTrac', code: 'ontrac_ground', name: 'OnTrac Ground' };
    const u: TrackingUpdate = { reference: 'X', trackingNumber: 'T', carrier: 'UPS', service: UPS_GROUND };
    const e = reconcileShipments([req('X', { service: odd })], [u]).entries[0]!;
    expect(e).toMatchObject({ serviceCheck: 'unverified', expectedResolved: false, mismatches: [] });
  });

  it('resolveSelection honours canonical and parses the carrier', () => {
    expect(resolveSelection({ carrier: 'United Parcel Service', code: 'GND', name: 'x', canonical: 'ups_ground' })?.code).toBe('ups_ground');
    expect(resolveSelection({ carrier: 'usps', code: '03' })).toBeNull();
    expect(resolveSelection(null)).toBeNull();
  });

  it('sameService compares canonical ids when a provider-scoped code is present', () => {
    expect(sameService({ carrier: 'UPS', code: 'shippo_ups_ground', name: 'x', canonical: 'ups_ground' }, UPS_GROUND)).toBe(true);
    expect(sameService({ carrier: 'UPS', code: 'shippo_ups_ground', name: 'x' }, UPS_GROUND)).toBe(false);
  });
});

describe('formula guard does not corrupt real phone and address values', () => {
  it('phone extensions pass the Phone column unchanged', () => {
    for (const p of ['+1 555-010-0199 ext. 5', '+1 (555) 010-0199 x12', '-555 0199 extension 7']) expect(guardPhone(p)).toBe(p);
    expect(guardPhone("+1 555 cmd|' /c calc'!A0")).toBe("'+1 555 cmd|' /c calc'!A0");
    expect(guardPhone('=1+1')).toBe("'=1+1");
    expect(guardPhone('+1 555 xA1')).toBe("'+1 555 xA1");
  });

  it('exports phone with extension and "- Rear" address lines without an apostrophe', () => {
    const out = ps.exportShipments([req('P-1', { to: addr({ phone: '+1 555-010-0199 ext. 5', line2: '- Rear', company: '+ Co Ltd' }) })]);
    const r = rows(out.content)[0]!;
    expect(r.Phone).toBe('+1 555-010-0199 ext. 5');
    expect(r['Address Line 2']).toBe('Rear');
    expect(r.Company).toBe('Co Ltd');
    expect(out.content).not.toContain("'");
  });

  it('still guards a glued formula in address lines and the phone extension rule only applies to Phone', () => {
    const out = ps.exportShipments([req('P-2', { to: addr({ line2: '-SUM(A1)', phone: '=cmd' }), notes: '+1 555 ext 5' })]);
    expect(out.content).toContain("'-SUM(A1)");
    expect(out.content).toContain("'=cmd");
    expect(out.content).toContain("'+1 555 ext 5");
  });

  it('writeCsv accepts a per-column guard', () => {
    expect(writeCsv([['+1 ext 5', '+1 ext 5']], { formulaGuard: (c, i) => (i === 0 ? guardPhone(c) : "'" + c) })).toBe(
      "+1 ext 5,'+1 ext 5\r\n",
    );
  });
});

describe('parcel suffix is case-insensitive', () => {
  it('splits /1OF2 and reconciles by reference', () => {
    expect(splitParcelOrderId('ORDER-1/1OF2')).toEqual({ reference: 'ORDER-1', parcel: { index: 1, count: 2 } });
    const { updates } = ps.parseTrackingImport('Tracking Number,Order ID\r\nT1,ORDER-1/1OF2\r\nT2,ORDER-1/2Of2\r\n');
    const e = reconcileShipments([req('ORDER-1', { parcels: [{ weightOz: 1 }, { weightOz: 1 }] })], updates).entries[0]!;
    expect(e.status).toBe('shipped');
    expect(e.matches.map((m) => m.via)).toEqual(['reference', 'reference']);
  });
});

describe('tiny weights and dimensions', () => {
  it('a weight that rounds to 0 is blank with invalid_weight; tiny dims are blank', () => {
    const out = ps.exportShipments([req('T', { parcels: [{ weightOz: 0.004, lengthIn: 0.004, widthIn: 5, heightIn: 5 }] })]);
    const r = rows(out.content)[0]!;
    expect([r.Pounds, r.Ounces, r.Length]).toEqual(['', '', '']);
    expect(codes(out.warnings)).toContain('invalid_weight');
    expect(codes(out.warnings)).toContain('partial_dimensions');
  });
});

describe('headers named after Object.prototype members', () => {
  it('are kept in values and in TrackingUpdate.raw', () => {
    const t = parseCsvTable('constructor,Tracking Number,toString,__proto__\r\nX,1Z,Y,Z\r\n');
    expect({ ...t.rows[0]!.values }).toEqual({ constructor: 'X', 'Tracking Number': '1Z', toString: 'Y', ['__proto__']: 'Z' });
    expect(Object.hasOwn(t.rows[0]!.values, '__proto__')).toBe(true);
    const { updates } = ps.parseTrackingImport('constructor,Tracking Number,__proto__\r\nX,1Z,Z\r\n');
    expect(updates[0]!.raw!['constructor']).toBe('X');
    expect(Object.hasOwn(updates[0]!.raw!, '__proto__')).toBe(true);
  });
});

describe('loose item quantities', () => {
  it('coerces numeric strings and warns on invalid quantities', () => {
    const items = [
      { description: 'Widget', quantity: '3' },
      { description: 'Gadget', quantity: null },
      { description: 'Gizmo', quantity: 0 },
      { description: 'Doohickey', quantity: 2 },
    ] as unknown as ShipmentRequest['items'];
    const out = ps.exportShipments([req('Q', { items })]);
    expect(rows(out.content)[0]!['Order Items']).toBe('3 x Widget; ? x Gadget; ? x Gizmo; 2 x Doohickey');
    expect(out.warnings.filter((w) => w.code === 'invalid_quantity')).toHaveLength(2);
  });
});

describe('refund detection across every status-like column', () => {
  it('skips a refunded label even when Tracking Status says In Transit', () => {
    const res = ps.parseTrackingImport('Tracking Number,Status,Tracking Status,Order ID,Service\r\n1Z1,Refunded,In Transit,1001,UPS Ground\r\n');
    expect(res.updates).toEqual([]);
    expect(res.errors[0]!.message).toContain('"Refunded" (Status)');
  });

  it('checks a Refund Status column too, and keeps live labels', () => {
    const res = ps.parseTrackingImport(
      'Tracking Number,Tracking Status,Refund Status,Order ID\r\n1Z1,In Transit,Refund Requested,1001\r\n1Z2,In Transit,,1002\r\n',
    );
    expect(res.updates.map((u) => [u.trackingNumber, u.status])).toEqual([['1Z2', 'In Transit']]);
    expect(res.errors).toHaveLength(1);
  });
});

describe('Pirate Ship first-upload mapping', () => {
  it('lists every header and maps the non-native ones to Passthrough', () => {
    const w = ps.exportShipments([req('M')]).warnings.find((x) => x.code === 'first_upload_mapping')!;
    expect(w.level).toBe('info');
    for (const h of ['Requested Shipping Service', 'Order Items', 'Note', 'Phone']) {
      expect(FIRST_UPLOAD_MAPPING[h as keyof typeof FIRST_UPLOAD_MAPPING]).toBe('Passthrough');
      expect(w.message).toContain(`${h} -> Passthrough`);
    }
    expect(w.message).toContain('Zip -> Zipcode');
  });
});

describe('rubber stamp overflow and no-stamp services', () => {
  it('warns that a long Order ID pushes Rubber Stamp 2 off the label', () => {
    const p = createPirateShipProvider({ rubberStamp2: 'Packing list enclosed' });
    const out = p.exportShipments([
      req('SQ-ORD-20261113-ABCDEFGH', { service: { carrier: 'USPS', code: 'usps_priority', name: 'USPS Priority Mail' }, parcels: [{ weightOz: 1 }, { weightOz: 1 }, { weightOz: 1 }] }),
    ]);
    const over = out.warnings.filter((w) => w.code === 'rubber_stamp_overflow');
    expect(over).toHaveLength(3);
    expect(over[0]!.level).toBe('warning');
    expect(over[0]!.message).toContain('Packing list enclosed');
  });

  it('warns when Rubber Stamp 2 itself is longer than a line', () => {
    const p = createPirateShipProvider({ rubberStamp2: 'Packing list enclosed - thank you!' });
    const usps = p.exportShipments([req('A', { service: { carrier: 'USPS', code: 'usps_priority', name: 'x' } })]);
    expect(codes(usps.warnings)).toContain('rubber_stamp_long');
    const ups = p.exportShipments([req('A')]);
    expect(codes(ups.warnings)).not.toContain('rubber_stamp_long');
  });

  it('flags USPS international services as printing no rubber stamps', () => {
    const out = ps.exportShipments([
      req('I-1', {
        service: { carrier: 'USPS', code: 'usps_priority_international', name: 'USPS Priority Mail International' },
        to: addr({ country: 'Canada', state: 'ON', postalCode: 'K1A 0B1' }),
      }),
    ]);
    expect(codes(out.warnings)).toContain('no_rubber_stamps');
    expect(codes(out.warnings)).not.toContain('invalid_country');
    expect(rows(out.content)[0]!.Country).toBe('CA');
  });
});

describe('batches split by package type', () => {
  it('exportBatches groups by (service, packageType); exportShipments warns on mixed packages', () => {
    const list = [req('B1'), req('B2', { packageType: 'Insured 12x10x8' }), req('B3'), req('B4', { packageType: 'Insured 12x10x8' })];
    const res = ps.exportBatches(list);
    expect(res.batches.map((b) => [b.filename, b.packageType, b.references])).toEqual([
      ['pirateship-import-ups_ground.csv', undefined, ['B1', 'B3']],
      ['pirateship-import-ups_ground-insured-12x10x8.csv', 'Insured 12x10x8', ['B2', 'B4']],
    ]);
    expect(res.warnings.filter((w) => w.code === 'buy_with_service')[1]!.message).toContain('"Insured 12x10x8" package');
    expect(codes(ps.exportShipments(list).warnings)).toContain('mixed_package_types');
    expect(codes(ps.exportShipments([req('B1'), req('B3')]).warnings)).not.toContain('mixed_package_types');
  });

  it('warns that per-shipment insurance/options/label format are set in Pirate Ship', () => {
    const out = ps.exportShipments([req('O', { insuranceCents: 5000, options: { signature: 'required' }, labelFormat: { size: '4x6', fileType: 'PDF' } })]);
    expect(out.warnings.filter((w) => w.code === 'unsupported_option')).toHaveLength(3);
  });
});

describe('countries', () => {
  it('maps common names to ISO alpha-2 and flags the rest', () => {
    expect(['Canada', 'united kingdom', 'U.K.', 'Germany', 'usa', 'ca', ''].map(normalizeCountry)).toEqual(['CA', 'GB', 'GB', 'DE', 'US', 'CA', 'US']);
    expect(normalizeCountry('constructor')).toBe('CONSTRUCTOR');
    expect(isIsoCountry('CA')).toBe(true);
    expect(isIsoCountry('CANADA')).toBe(false);
    const out = ps.exportShipments([req('C', { service: { carrier: 'UPS', code: 'ups_standard', name: 'UPS Standard' }, to: addr({ country: 'Atlantis' }) })]);
    expect(codes(out.warnings)).toContain('invalid_country');
  });
});

describe('live-API provider interface', () => {
  it('supports multi-parcel purchase results, quoted rate ids, idempotency, open carriers, tracking and void', async () => {
    const calls: PurchaseOptions[] = [];
    const provider: ShippingProvider = {
      id: 'mock-api',
      displayName: 'Mock API',
      appUrl: 'https://example.com',
      capabilities: { exportFile: false, importTracking: false, purchaseLabel: true, rates: true, track: true, voidLabel: true },
      async getRates(): Promise<RateQuote[]> {
        return [{ service: { carrier: 'OnTrac', code: 'ontrac_ground', name: 'OnTrac Ground' }, costCents: 812, rateId: 'rate_1', expiresAt: '2026-11-14T00:00:00Z' }];
      },
      async purchaseLabel(request, options): Promise<PurchaseResult> {
        calls.push(options);
        return {
          labels: request.parcels.map((_, i) => ({
            reference: request.reference,
            parcel: { index: i + 1, count: request.parcels.length },
            trackingNumber: `TRK${i + 1}`,
            carrier: 'OnTrac',
            service: { carrier: 'OnTrac', code: 'ontrac_ground', name: 'OnTrac Ground' },
            labelId: `lbl_${i + 1}`,
          })),
        };
      },
      async getTracking(trackingNumber) {
        return { reference: null, trackingNumber, carrier: 'OnTrac', status: 'In Transit' };
      },
      async voidLabel() {
        return { accepted: true, status: 'refund_pending' };
      },
    };
    const reg = createRegistry([provider, ps]);
    expect(reg.listProviders({ voidLabel: true }).map((p) => p.id)).toEqual(['mock-api']);
    const [quote] = await provider.getRates!(req('L'));
    const res = await provider.purchaseLabel!(req('L', { parcels: [{ weightOz: 1 }, { weightOz: 2 }] }), { rateId: quote!.rateId, idempotencyKey: 'L:1' });
    expect(res.labels.map((l) => [l.trackingNumber, l.parcel])).toEqual([
      ['TRK1', { index: 1, count: 2 }],
      ['TRK2', { index: 2, count: 2 }],
    ]);
    expect(calls).toEqual([{ rateId: 'rate_1', idempotencyKey: 'L:1' }]);
    expect((await provider.voidLabel!(res.labels[0]!)).accepted).toBe(true);
    const t = await provider.getTracking!('TRK1');
    expect(trackingUrlFor(t!)).toBeNull(); // unknown carrier: no URL, no crash
  });
});
