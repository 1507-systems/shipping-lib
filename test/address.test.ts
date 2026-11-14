import { describe, expect, it } from 'vitest';
import {
  isContiguousUs,
  isPoBox,
  missingAddressFields,
  normalizeCountry,
  normalizeUsState,
  normalizeUsZip,
} from '../src/index';

describe('address helpers', () => {
  it('normalizes US states', () => {
    expect(normalizeUsState('co')).toBe('CO');
    expect(normalizeUsState('Colorado')).toBe('CO');
    expect(normalizeUsState(' new  york ')).toBe('NY');
    expect(normalizeUsState('District of Columbia')).toBe('DC');
    expect(normalizeUsState('ZZ')).toBeNull();
    expect(normalizeUsState('Ontario')).toBeNull();
  });

  it('normalizes ZIPs', () => {
    expect(normalizeUsZip('80501')).toBe('80501');
    expect(normalizeUsZip('805011234')).toBe('80501-1234');
    expect(normalizeUsZip('80501-1234')).toBe('80501-1234');
    expect(normalizeUsZip('02134')).toBe('02134');
    expect(normalizeUsZip('8050')).toBeNull();
    expect(normalizeUsZip('K1A 0B1')).toBeNull();
  });

  it('normalizes countries', () => {
    expect(normalizeCountry(undefined)).toBe('US');
    expect(normalizeCountry('')).toBe('US');
    expect(normalizeCountry('U.S.A.')).toBe('US');
    expect(normalizeCountry('United States')).toBe('US');
    expect(normalizeCountry('ca')).toBe('CA');
  });

  it('knows the contiguous 48', () => {
    expect(isContiguousUs('CO')).toBe(true);
    expect(isContiguousUs('DC')).toBe(true);
    expect(isContiguousUs('AK')).toBe(false);
    expect(isContiguousUs('Hawaii')).toBe(false);
    expect(isContiguousUs('PR')).toBe(false);
    expect(isContiguousUs('XX')).toBe(false);
  });

  it('detects PO Boxes', () => {
    expect(isPoBox('PO Box 12')).toBe(true);
    expect(isPoBox('P.O. Box 12')).toBe(true);
    expect(isPoBox('post office box 9')).toBe(true);
    expect(isPoBox('123 Box Elder St')).toBe(false);
    expect(isPoBox(undefined)).toBe(false);
  });

  it('lists missing required fields without throwing', () => {
    expect(missingAddressFields({ name: 'A', line1: '1 St', city: 'X', state: 'CO', postalCode: '80501' })).toEqual([]);
    expect(missingAddressFields({ name: ' ', line1: '1 St' })).toEqual(['name', 'city', 'state', 'postalCode']);
    expect(missingAddressFields(null)).toEqual(['name', 'line1', 'city', 'state', 'postalCode']);
  });
});
