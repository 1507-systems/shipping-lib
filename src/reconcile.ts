/**
 * Reconcile tracking updates against the shipment requests that produced
 * them, and check that the service actually purchased is the service the
 * customer selected at checkout.
 *
 * Matching order per update:
 *  1. reference, exact;
 *  2. reference, case-insensitive (spreadsheets sometimes change case);
 *  3. recipient name + 5-digit ZIP, only when exactly one request matches.
 * Updates that match nothing are returned in `unmatched`.
 */

import { resolveService, sameService, toSelection } from './services';
import type { ServiceSelection, ShipmentRequest, TrackingUpdate } from './types';

export type MatchVia = 'reference' | 'reference-case-insensitive' | 'recipient';

export interface ReconcileMatch {
  update: TrackingUpdate;
  via: MatchVia;
}

export interface ServiceMismatch {
  trackingNumber: string;
  expected: ServiceSelection;
  actual: ServiceSelection | null;
  /** Provider's raw service text. */
  actualName?: string;
}

export interface ReconcileEntry {
  reference: string;
  expected: ServiceSelection;
  parcelsExpected: number;
  matches: ReconcileMatch[];
  /** Distinct tracking numbers matched to this shipment. */
  trackingNumbers: string[];
  /** pending: nothing yet; partial: fewer labels than parcels; shipped: one label per parcel or more. */
  status: 'pending' | 'partial' | 'shipped';
  /**
   * pending: no labels yet; match: every label's service resolved and equals
   * the checkout service; mismatch: at least one label is a different service;
   * unverified: some label's service is missing or not in the catalog.
   */
  serviceCheck: 'pending' | 'match' | 'mismatch' | 'unverified';
  mismatches: ServiceMismatch[];
}

export interface ReconcileResult {
  entries: ReconcileEntry[];
  unmatched: TrackingUpdate[];
}

function nameKey(name: string | undefined, zip: string | undefined): string | null {
  const n = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const z = (zip ?? '').replace(/\D/g, '').slice(0, 5);
  return n && z.length === 5 ? `${n}|${z}` : null;
}

/** Canonicalize a loose checkout selection (e.g. code "03") so comparison is exact. */
function canonical(service: ServiceSelection): ServiceSelection {
  const opts = service?.carrier ? { carrier: service.carrier } : {};
  const hit = resolveService(service?.code, opts) ?? resolveService(service?.name, opts);
  return hit ? toSelection(hit) : service;
}

export function reconcileShipments(requests: readonly ShipmentRequest[], updates: readonly TrackingUpdate[]): ReconcileResult {
  const entries: ReconcileEntry[] = [];
  const byRef = new Map<string, ReconcileEntry>();
  const byLower = new Map<string, ReconcileEntry[]>();
  const byRecipient = new Map<string, ReconcileEntry[]>();

  for (const req of requests) {
    const reference = typeof req?.reference === 'string' ? req.reference.trim() : '';
    if (!reference || byRef.has(reference)) continue;
    const entry: ReconcileEntry = {
      reference,
      expected: canonical(req.service),
      parcelsExpected: Math.max(1, Array.isArray(req.parcels) ? req.parcels.length : 0),
      matches: [],
      trackingNumbers: [],
      status: 'pending',
      serviceCheck: 'pending',
      mismatches: [],
    };
    entries.push(entry);
    byRef.set(reference, entry);
    const lower = reference.toLowerCase();
    byLower.set(lower, [...(byLower.get(lower) ?? []), entry]);
    const rk = nameKey(req.to?.name, req.to?.postalCode);
    if (rk) byRecipient.set(rk, [...(byRecipient.get(rk) ?? []), entry]);
  }

  const unmatched: TrackingUpdate[] = [];
  for (const update of updates) {
    let entry: ReconcileEntry | undefined;
    let via: MatchVia | undefined;
    const ref = update.reference?.trim();
    if (ref) {
      entry = byRef.get(ref);
      via = 'reference';
      if (!entry) {
        const ci = byLower.get(ref.toLowerCase());
        if (ci?.length === 1) {
          entry = ci[0];
          via = 'reference-case-insensitive';
        }
      }
    }
    if (!entry) {
      const rk = nameKey(update.recipientName, update.recipientPostalCode);
      const hits = rk ? byRecipient.get(rk) : undefined;
      if (hits?.length === 1) {
        entry = hits[0];
        via = 'recipient';
      }
    }
    if (!entry || !via) {
      unmatched.push(update);
      continue;
    }
    if (entry.trackingNumbers.includes(update.trackingNumber)) continue;
    entry.matches.push({ update, via });
    entry.trackingNumbers.push(update.trackingNumber);
  }

  for (const entry of entries) {
    const n = entry.trackingNumbers.length;
    entry.status = n === 0 ? 'pending' : n < entry.parcelsExpected ? 'partial' : 'shipped';
    if (n === 0) continue;
    let unverified = false;
    for (const { update } of entry.matches) {
      if (!update.service) {
        unverified = true;
        continue;
      }
      if (!sameService(update.service, entry.expected)) {
        entry.mismatches.push({
          trackingNumber: update.trackingNumber,
          expected: entry.expected,
          actual: update.service,
          ...(update.serviceName ? { actualName: update.serviceName } : {}),
        });
      }
    }
    entry.serviceCheck = entry.mismatches.length ? 'mismatch' : unverified ? 'unverified' : 'match';
  }

  return { entries, unmatched };
}
