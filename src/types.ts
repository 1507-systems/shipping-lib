/**
 * Core, provider-agnostic shipping types.
 *
 * Everything here is plain data (no classes, no platform types) so it can be
 * serialized into a queue, a KV value, a D1 row, or a browser form without
 * conversion. Money is integer cents; weight is ounces; dimensions are inches.
 */

export type Carrier = 'UPS' | 'USPS' | 'FedEx' | 'DHL';

export interface Address {
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  /** Two-letter code for US/CA addresses (full US state names are normalized by providers that need it). */
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string;
  phone?: string;
  email?: string;
}

export interface Parcel {
  /** Total parcel weight in ounces. */
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

/** The shipping method the customer selected at checkout, in canonical form (see services.ts). */
export interface ServiceSelection {
  carrier: Carrier;
  /** Canonical id, e.g. 'ups_ground', 'ups_2nd_day_air', 'usps_ground_advantage'. */
  code: string;
  /** Human display name, e.g. 'UPS Ground'. */
  name: string;
}

export interface ShipmentItem {
  description: string;
  quantity: number;
}

export interface ShipmentRequest {
  /** Store order id. The round-trip join key between export and tracking import. */
  reference: string;
  service: ServiceSelection;
  to: Address;
  /** Ship-from address. Some providers (Pirate Ship) take this per batch from the account instead. */
  from?: Address;
  /** One or more parcels. Must be non-empty. */
  parcels: Parcel[];
  items?: ShipmentItem[];
  notes?: string;
}

export interface ParcelRef {
  /** 1-based parcel index within the shipment. */
  index: number;
  count: number;
}

export interface TrackingUpdate {
  /** Store order id recovered from the provider's data, or null when the row carried none. */
  reference: string | null;
  /** Present when the provider row was one parcel of a multi-parcel shipment. */
  parcel?: ParcelRef;
  trackingNumber: string;
  /** Carrier, from the provider's data or inferred from the tracking number; null when neither works. */
  carrier: Carrier | null;
  /** The service actually purchased, resolved to the canonical catalog when possible. */
  service?: ServiceSelection;
  /** The provider's raw service text (kept even when it could not be resolved). */
  serviceName?: string;
  costCents?: number;
  /** ISO date (YYYY-MM-DD) or ISO timestamp when recognized, otherwise the provider cell verbatim. */
  shippedAt?: string;
  recipientName?: string;
  recipientPostalCode?: string;
  /** Provider tracking/label status text, if present (e.g. "Delivered", "Refunded"). */
  status?: string;
  /** The source row keyed by its original header, for fields this type does not model. */
  raw?: Record<string, string>;
}

export interface ProviderCapabilities {
  /** Can produce a file (CSV, etc.) the operator uploads to the provider. */
  exportFile: boolean;
  /** Can parse a provider export back into tracking updates. */
  importTracking: boolean;
  /** Can buy a label programmatically. */
  purchaseLabel: boolean;
  /** Can quote rates programmatically. */
  rates: boolean;
}

export type WarningLevel = 'info' | 'warning';

export interface ExportWarning {
  level: WarningLevel;
  /** Stable machine code, e.g. 'missing_field', 'mixed_services'. */
  code: string;
  message: string;
  /** Shipment references this warning concerns, when it concerns specific ones. */
  references?: string[];
}

export interface ExportFile {
  filename: string;
  mimeType: string;
  content: string;
}

export interface ExportResult extends ExportFile {
  warnings: ExportWarning[];
  /** References of shipments left out of the file because they could not be exported. */
  skipped: string[];
}

export interface ImportError {
  /** 1-based physical record number in the file (the header is record 1). 0 for file-level errors. */
  row: number;
  message: string;
}

export interface TrackingImportResult {
  updates: TrackingUpdate[];
  errors: ImportError[];
}

export interface RateQuote {
  service: ServiceSelection;
  costCents: number;
  estimatedDays?: number;
}

export interface PurchasedLabel {
  reference: string;
  trackingNumber: string;
  carrier: Carrier;
  service: ServiceSelection;
  costCents?: number;
  /** URL or data URI of the label document. */
  labelUrl?: string;
  labelMimeType?: string;
}

export interface ShippingProvider {
  /** Stable registry id, e.g. 'pirateship'. */
  id: string;
  displayName: string;
  /** Where the operator goes to finish the job by hand (upload, buy, export). */
  appUrl: string;
  capabilities: ProviderCapabilities;
  exportShipments?(requests: ShipmentRequest[]): ExportResult;
  parseTrackingImport?(text: string): TrackingImportResult;
  /** Declared for live-API providers (Shippo, EasyPost, carrier direct). */
  purchaseLabel?(request: ShipmentRequest): Promise<PurchasedLabel>;
  /** Declared for live-API providers (Shippo, EasyPost, carrier direct). */
  getRates?(request: ShipmentRequest): Promise<RateQuote[]>;
}
