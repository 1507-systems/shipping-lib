import { describe, expect, it } from 'vitest';
import {
  SERVICE_CATALOG,
  inferCarrier,
  parseCarrier,
  resolveService,
  sameService,
  toSelection,
  trackingUrl,
} from '../src/index';

const code = (input: string, opts?: Parameters<typeof resolveService>[1]) => resolveService(input, opts)?.code ?? null;

describe('resolveService', () => {
  it.each([
    ['UPS Ground', 'ups_ground'],
    ['ups ground', 'ups_ground'],
    ['UPS® Ground', 'ups_ground'],
    ['03', 'ups_ground'],
    ['ups_ground', 'ups_ground'],
    ['UPS 2nd Day Air', 'ups_2nd_day_air'],
    ['UPS 2nd Day Air®', 'ups_2nd_day_air'],
    ['UPS Second Day Air', 'ups_2nd_day_air'],
    ['02', 'ups_2nd_day_air'],
    ['UPS Next Day Air', 'ups_next_day_air'],
    ['UPS Next Day Air®', 'ups_next_day_air'],
    ['01', 'ups_next_day_air'],
    ['12', 'ups_3_day_select'],
    ['13', 'ups_next_day_air_saver'],
    ['14', 'ups_next_day_air_early'],
    ['59', 'ups_2nd_day_air_am'],
    ['93', 'ups_ground_saver'],
    ['UPS 2nd Day Air AM®', 'ups_2nd_day_air_am'],
    ['UPS 2nd Day Air A.M.', 'ups_2nd_day_air_am'],
    ['Next Day Air Early®', 'ups_next_day_air_early'],
    ['UPS Next Day Air® Early', 'ups_next_day_air_early'],
    ['Next Day Air Saver®', 'ups_next_day_air_saver'],
    ['UPS Ground Saver®', 'ups_ground_saver'],
    ['Ground Saver', 'ups_ground_saver'],
    ['USPS Ground Advantage™', 'usps_ground_advantage'],
    ['USPS Ground Advantage Cubic', 'usps_ground_advantage'],
    ['USPS Priority Mail®', 'usps_priority'],
    ['USPS Priority Mail Cubic', 'usps_priority'],
    ['USPS Priority Mail Flat Rate Envelope', 'usps_priority'],
    ['Priority Mail Express', 'usps_priority_express'],
    ['USPS Priority Mail Express International®', 'usps_priority_express_international'],
    ['USPS First Class Package International®', 'usps_first_class_international'],
    ['UPS Standard®', 'ups_standard'],
    ['UPS Worldwide Expedited®', 'ups_worldwide_expedited'],
    ['  fedex 2day ', 'fedex_2day'],
  ])('%j -> %s', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('never matches by substring', () => {
    expect(code('UPS Next Day Air Early')).toBe('ups_next_day_air_early');
    expect(code('UPS Next Day Air Something')).toBeNull();
    expect(code('UPS Ground Express')).toBeNull();
  });

  it('refuses ambiguous or too-generic bare names', () => {
    expect(code('Ground')).toBeNull(); // UPS Ground vs FedEx Ground
    expect(code('Standard')).toBeNull();
    expect(code('Express')).toBeNull();
    expect(code('Standard shipping')).toBeNull();
  });

  it('numeric codes need exactly two digits and are UPS only', () => {
    expect(code('3')).toBeNull();
    expect(code('003')).toBeNull();
    expect(code('99')).toBeNull();
    expect(code('03', { carrier: 'USPS' })).toBeNull();
    expect(code('03', { carrier: 'UPS' })).toBe('ups_ground');
  });

  it('honors a carrier restriction', () => {
    expect(code('USPS Priority Mail', { carrier: 'UPS' })).toBeNull();
    expect(code('USPS Priority Mail', { carrier: 'USPS' })).toBe('usps_priority');
  });

  it('returns null for empty or non-string input', () => {
    expect(resolveService('')).toBeNull();
    expect(resolveService('   ')).toBeNull();
    expect(resolveService(null)).toBeNull();
    expect(resolveService(undefined)).toBeNull();
    expect(resolveService(3 as unknown as string)).toBeNull();
  });

  it('every catalog entry resolves from its code and name', () => {
    for (const s of SERVICE_CATALOG) {
      expect(resolveService(s.code)?.code).toBe(s.code);
      expect(resolveService(s.name)?.code).toBe(s.code);
      for (const a of s.aliases) expect(resolveService(a)?.code).toBe(s.code);
    }
  });

  it('catalog codes are unique and UPS codes unique', () => {
    const codes = SERVICE_CATALOG.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    const ups = SERVICE_CATALOG.flatMap((s) => (s.upsCode ? [s.upsCode] : []));
    expect(new Set(ups).size).toBe(ups.length);
  });
});

describe('sameService / toSelection', () => {
  it('compares carrier and code only', () => {
    const a = toSelection(resolveService('UPS Ground')!);
    expect(a).toEqual({ carrier: 'UPS', code: 'ups_ground', name: 'UPS Ground' });
    expect(sameService(a, { carrier: 'UPS', code: 'ups_ground', name: 'whatever' })).toBe(true);
    expect(sameService(a, { carrier: 'UPS', code: 'ups_2nd_day_air', name: 'UPS Ground' })).toBe(false);
    expect(sameService(a, null)).toBe(false);
  });
});

describe('trackingUrl', () => {
  it('builds carrier URLs and encodes the number', () => {
    expect(trackingUrl('UPS', '1Z999AA10123456784')).toBe('https://www.ups.com/track?tracknum=1Z999AA10123456784');
    expect(trackingUrl('USPS', '9400100000000000000000')).toBe(
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000',
    );
    expect(trackingUrl('FedEx', '123456789012')).toBe('https://www.fedex.com/fedextrack/?trknbr=123456789012');
    expect(trackingUrl('DHL', '1234567890')).toContain('tracking-id=1234567890');
    expect(trackingUrl('UPS', 'a&b=c/../"x"')).toBe('https://www.ups.com/track?tracknum=a%26b%3Dc%2F..%2F%22x%22');
  });
});

describe('parseCarrier / inferCarrier', () => {
  it('parses carrier names', () => {
    expect(parseCarrier('UPS')).toBe('UPS');
    expect(parseCarrier('usps')).toBe('USPS');
    expect(parseCarrier('U.S. Postal Service')).toBe('USPS');
    expect(parseCarrier('FedEx Ground')).toBe('FedEx');
    expect(parseCarrier('DHL Express')).toBe('DHL');
    expect(parseCarrier('Pony Express')).toBeNull();
    expect(parseCarrier('')).toBeNull();
  });

  it('infers from tracking number shape only when unambiguous', () => {
    expect(inferCarrier('1Z999AA10123456784')).toBe('UPS');
    expect(inferCarrier('9400 1000 0000 0000 0000 00')).toBe('USPS');
    expect(inferCarrier('EC123456789US')).toBe('USPS');
    expect(inferCarrier('123456789012')).toBeNull();
  });
});
