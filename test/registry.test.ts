import { describe, expect, it } from 'vitest';
import { createPirateShipProvider, createRegistry, type ShippingProvider } from '../src/index';

const fake = (id: string, rates = false): ShippingProvider => ({
  id,
  displayName: id,
  appUrl: 'https://example.com',
  capabilities: { exportFile: false, importTracking: false, purchaseLabel: rates, rates },
});

describe('createRegistry', () => {
  it('registers, gets and lists in order', () => {
    const r = createRegistry();
    const ps = createPirateShipProvider();
    r.registerProvider(ps);
    r.registerProvider(fake('live', true));
    expect(r.getProvider('pirateship')).toBe(ps);
    expect(r.getProvider('nope')).toBeUndefined();
    expect(r.listProviders().map((p) => p.id)).toEqual(['pirateship', 'live']);
  });

  it('filters by capability', () => {
    const r = createRegistry([createPirateShipProvider(), fake('live', true)]);
    expect(r.listProviders({ exportFile: true }).map((p) => p.id)).toEqual(['pirateship']);
    expect(r.listProviders({ purchaseLabel: true }).map((p) => p.id)).toEqual(['live']);
    expect(r.listProviders({ purchaseLabel: true, exportFile: true })).toEqual([]);
  });

  it('rejects duplicate and empty ids', () => {
    const r = createRegistry([fake('a')]);
    expect(() => r.registerProvider(fake('a'))).toThrow(/already registered/);
    expect(() => r.registerProvider(fake(' '))).toThrow(/non-empty/);
  });

  it('registries are independent (no shared global state)', () => {
    const a = createRegistry();
    const b = createRegistry();
    a.registerProvider(fake('x'));
    expect(b.getProvider('x')).toBeUndefined();
    expect(b.listProviders()).toEqual([]);
  });

  it('unregisters', () => {
    const r = createRegistry([fake('x')]);
    expect(r.unregisterProvider('x')).toBe(true);
    expect(r.unregisterProvider('x')).toBe(false);
    expect(r.listProviders()).toEqual([]);
  });
});
