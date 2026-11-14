/**
 * Provider registry. Deliberately not a module-level singleton: each call to
 * createRegistry() returns an independent registry, so tests, Workers isolates
 * and multiple stores in one process never share state by accident.
 */

import type { ProviderCapabilities, ShippingProvider } from './types';

export interface ProviderRegistry {
  /** Add a provider. Throws if the id is empty or already registered (a programming error, not user data). */
  registerProvider(provider: ShippingProvider): void;
  getProvider(id: string): ShippingProvider | undefined;
  /** Providers in registration order, optionally only those having every listed capability. */
  listProviders(require?: Partial<Record<keyof ProviderCapabilities, true>>): ShippingProvider[];
  /** Remove a provider; returns whether one was removed. */
  unregisterProvider(id: string): boolean;
}

export function createRegistry(initial: readonly ShippingProvider[] = []): ProviderRegistry {
  const providers = new Map<string, ShippingProvider>();

  const registry: ProviderRegistry = {
    registerProvider(provider) {
      if (!provider || typeof provider.id !== 'string' || provider.id.trim() === '') {
        throw new Error('shipping-lib: provider id must be a non-empty string');
      }
      if (providers.has(provider.id)) {
        throw new Error(`shipping-lib: provider "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    getProvider(id) {
      return providers.get(id);
    },
    listProviders(require = {}) {
      const wanted = Object.keys(require) as (keyof ProviderCapabilities)[];
      return [...providers.values()].filter((p) => wanted.every((k) => p.capabilities[k]));
    },
    unregisterProvider(id) {
      return providers.delete(id);
    },
  };

  for (const p of initial) registry.registerProvider(p);
  return registry;
}
