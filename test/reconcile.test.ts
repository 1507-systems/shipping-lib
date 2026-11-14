import { describe, expect, it } from 'vitest';
import { reconcileShipments, type ShipmentRequest, type TrackingUpdate } from '../src/index';
import { createPirateShipProvider } from '../src/pirateship';
import { PIRATE_SHIP_EXPORT_CSV } from './fixtures/pirateship-shipment-export';

const to = (name: string, postalCode: string): ShipmentRequest['to'] => ({
  name,
  line1: '1 Main St',
  city: 'Longmont',
  state: 'CO',
  postalCode,
  country: 'US',
});

const requests: ShipmentRequest[] = [
  { reference: 'ORDER-1001', service: { carrier: 'UPS', code: '03', name: 'UPS Ground' }, to: to('Ada Lovelace', '80501'), parcels: [{ weightOz: 40 }] },
  { reference: 'ORDER-1002', service: { carrier: 'UPS', code: 'ups_2nd_day_air', name: 'UPS 2nd Day Air' }, to: to('Grace Hopper', '22201'), parcels: [{ weightOz: 20 }, { weightOz: 18.5 }] },
  { reference: 'ORDER-1003', service: { carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' }, to: to('Alan Turing', '80302'), parcels: [{ weightOz: 12 }] },
  { reference: 'ORDER-1004', service: { carrier: 'USPS', code: 'usps_priority', name: 'USPS Priority Mail' }, to: to('Dana Lee', '80501'), parcels: [{ weightOz: 8 }] },
  { reference: 'ORDER-1005', service: { carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' }, to: to('Nobody Yet', '80501'), parcels: [{ weightOz: 8 }, { weightOz: 8 }] },
];

describe('reconcileShipments with the Pirate Ship fixture', () => {
  const { updates } = createPirateShipProvider().parseTrackingImport(PIRATE_SHIP_EXPORT_CSV);
  const result = reconcileShipments(requests, updates);
  const byRef = Object.fromEntries(result.entries.map((e) => [e.reference, e]));

  it('matches by reference and checks the purchased service against checkout', () => {
    expect(byRef['ORDER-1001']).toMatchObject({ status: 'shipped', serviceCheck: 'match', trackingNumbers: ['1Z999AA10123456784'] });
    expect(byRef['ORDER-1001']!.expected.code).toBe('ups_ground'); // canonicalized from "03"
    expect(byRef['ORDER-1002']).toMatchObject({ status: 'shipped', serviceCheck: 'match', parcelsExpected: 2 });
    expect(byRef['ORDER-1002']!.trackingNumbers).toHaveLength(2);
  });

  it('flags a service mismatch', () => {
    const e = byRef['ORDER-1003']!;
    expect(e.serviceCheck).toBe('mismatch');
    expect(e.mismatches).toEqual([
      {
        trackingNumber: '9400100000000000000017',
        expected: { carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' },
        actual: { carrier: 'USPS', code: 'usps_ground_advantage', name: 'USPS Ground Advantage' },
        actualName: 'USPS Ground Advantage™',
      },
    ]);
  });

  it('falls back to recipient name + ZIP5 when the row has no reference', () => {
    const e = byRef['ORDER-1004']!;
    expect(e.status).toBe('shipped');
    expect(e.serviceCheck).toBe('match');
    expect(e.matches[0]!.via).toBe('recipient');
  });

  it('leaves unshipped orders pending', () => {
    expect(byRef['ORDER-1005']).toMatchObject({ status: 'pending', serviceCheck: 'pending', matches: [] });
    expect(result.unmatched).toEqual([]);
  });
});

describe('reconcileShipments edge cases', () => {
  const u = (over: Partial<TrackingUpdate>): TrackingUpdate => ({ reference: null, trackingNumber: 'T', carrier: 'UPS', ...over });
  const one = requests.slice(4, 5); // ORDER-1005, 2 parcels

  it('reports partial shipments and unverified services', () => {
    const r = reconcileShipments(one, [u({ reference: 'ORDER-1005', trackingNumber: 'T1', serviceName: 'Mystery' })]);
    expect(r.entries[0]).toMatchObject({ status: 'partial', serviceCheck: 'unverified' });
  });

  it('matches case-insensitively, dedupes tracking numbers, returns unmatched', () => {
    const r = reconcileShipments(one, [
      u({ reference: 'order-1005', trackingNumber: 'T1' }),
      u({ reference: 'ORDER-1005', trackingNumber: 'T1' }),
      u({ reference: 'ORDER-9999', trackingNumber: 'T9' }),
    ]);
    expect(r.entries[0]!.matches.map((m) => m.via)).toEqual(['reference-case-insensitive']);
    expect(r.unmatched.map((x) => x.trackingNumber)).toEqual(['T9']);
  });

  it('does not recipient-match when the name + ZIP is ambiguous', () => {
    const twins: ShipmentRequest[] = [
      { ...requests[0]!, reference: 'A' },
      { ...requests[0]!, reference: 'B' },
    ];
    const r = reconcileShipments(twins, [u({ recipientName: 'Ada Lovelace', recipientPostalCode: '80501-1111' })]);
    expect(r.unmatched).toHaveLength(1);
  });
});

describe('full round trip: export -> (operator buys in Pirate Ship) -> export -> import', () => {
  it('order ids written on upload come back as references', () => {
    const ps = createPirateShipProvider();
    const out = ps.exportShipments(requests);
    // Simulate Pirate Ship's shipment export: it carries our Order ID through.
    const lines = out.content.trim().split('\r\n').slice(1);
    let n = 0;
    const exported = [
      'Order ID,Carrier,Service,Tracking Number',
      ...lines.map((line) => {
        const orderId = line.split(',')[0]!;
        const svc = /USPS Priority/.test(line) ? 'USPS Priority Mail®' : /2nd Day/.test(line) ? 'UPS 2nd Day Air®' : 'UPS® Ground';
        n++;
        return `${orderId},${svc.startsWith('USPS') ? 'USPS' : 'UPS'},${svc},TRK${n}`;
      }),
    ].join('\r\n');
    const { updates, errors } = ps.parseTrackingImport(exported);
    expect(errors).toEqual([]);
    const r = reconcileShipments(requests, updates);
    expect(r.unmatched).toEqual([]);
    expect(r.entries.map((e) => [e.reference, e.status, e.serviceCheck])).toEqual([
      ['ORDER-1001', 'shipped', 'match'],
      ['ORDER-1002', 'shipped', 'match'],
      ['ORDER-1003', 'shipped', 'match'],
      ['ORDER-1004', 'shipped', 'match'],
      ['ORDER-1005', 'shipped', 'match'],
    ]);
  });
});
