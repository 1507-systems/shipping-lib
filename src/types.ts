/**
 * Core, provider-agnostic shipping types.
 *
 * Everything here is plain data (no classes, no platform types) so it can be
 * serialized into a queue, a KV value, a D1 row, or a browser form without
 * conversion. Money is integer cents; weight is ounces; dimensions are inches.
 */

/** Carriers the canonical service catalog (services.ts) knows. */
export type KnownCarrier = 'UPS' | 'USPS' | 'FedEx' | 'DHL';

/**
 * A carrier name. Known carriers autocomplete; an aggregator API provider may
 * report any other carrier it sells (e.g. 'OnTrac', 'Canada Post') as a plain
 * string. The canonical catalog is the matching layer, not a type gate.
 */
export type Carrier = KnownCarrier | (string & {});

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
  /**
   * Canonical id, e.g. 'ups_ground', 'ups_2nd_day_air', 'usps_ground_advantage'.
   * A provider may put its own provider-scoped code here for a service outside
   * the catalog, and then sets `canonical` when it does map to a catalog entry.
   */
  code: string;
  /** Human display name, e.g. 'UPS Ground'. */
  name: string;
  /** Canonical catalog id when `code` is a provider-scoped code. Compared in preference to `code`. */
  canonical?: string;
}

export interface ShipmentItem {
  description: string;
  quantity: number;
}

export interface CustomsItem {
  description: string;
  quantity: number;
  /** Value per unit, integer cents. */
  valueCents: number;
  /** Weight per unit, ounces. */
  weightOz: number;
  /** Harmonized System tariff code. */
  hsCode?: string;
  /** ISO 3166-1 alpha-2 country of origin. */
  originCountry?: string;
}

export interface CustomsDeclaration {
  contentsType: 'merchandise' | 'gift' | 'documents' | 'sample' | 'return' | 'other';
  items: CustomsItem[];
  /** Text shown when contentsType is 'other'. */
  contentsExplanation?: string;
  /** Exporter/EEL/ITN code where the destination requires one. */
  eelPfc?: string;
}

export interface ShipmentOptions {
  signature?: 'none' | 'required' | 'adult';
  saturdayDelivery?: boolean;
  /** Provider-specific extra services, passed through by providers that understand them. */
  extra?: Record<string, string | number | boolean>;
}

export interface LabelFormat {
  size: '4x6' | '2x7' | 'letter';
  fileType: 'PDF' | 'ZPL' | 'PNG';
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
  /** Customs declaration for international shipments. */
  customs?: CustomsDeclaration;
  /** Declared value to insure, integer cents. */
  insuranceCents?: number;
  /** Signature and other extra services. */
  options?: ShipmentOptions;
  /**
   * Package type or saved-package name (e.g. 'box', 'Flat Rate Envelope',
   * 'Insured 12x10x8'). Batch-oriented providers split batches on it.
   */
  packageType?: string;
  /** Wanted label document format. */
  labelFormat?: LabelFormat;
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
  /** Can fetch live tracking for a tracking number (getTracking). */
  track?: boolean;
  /** Can void/refund a purchased label (voidLabel). */
  voidLabel?: boolean;
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
  /** Opaque provider rate/shipment id; pass back to purchaseLabel to buy exactly this quote. */
  rateId?: string;
  /** ISO timestamp after which rateId is no longer valid. */
  expiresAt?: string;
}

export interface PurchaseOptions {
  /** Buy exactly this quoted rate (RateQuote.rateId) instead of re-rating. */
  rateId?: string;
  /**
   * Required. Stable per logical purchase (e.g. order reference + attempt
   * group); a retry with the same key must not buy a second label. Providers
   * pass it to the API's idempotency mechanism.
   */
  idempotencyKey: string;
}

export interface PurchasedLabel {
  reference: string;
  /** Which parcel this label is for, on a multi-parcel shipment. */
  parcel?: ParcelRef;
  trackingNumber: string;
  carrier: Carrier;
  service: ServiceSelection;
  costCents?: number;
  /** URL or data URI of the label document. */
  labelUrl?: string;
  labelMimeType?: string;
  /** Opaque provider label/transaction id, used by voidLabel. */
  labelId?: string;
}

/** One label per parcel: a multi-parcel request yields several labels. */
export interface PurchaseResult {
  labels: PurchasedLabel[];
}

export interface VoidResult {
  /** True when the provider accepted the void/refund request (refunds may still be pending). */
  accepted: boolean;
  status?: string;
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
  purchaseLabel?(request: ShipmentRequest, options: PurchaseOptions): Promise<PurchaseResult>;
  /** Declared for live-API providers (Shippo, EasyPost, carrier direct). */
  getRates?(request: ShipmentRequest): Promise<RateQuote[]>;
  /** Live tracking for one tracking number (capabilities.track). */
  getTracking?(trackingNumber: string, carrier?: Carrier): Promise<TrackingUpdate | null>;
  /** Void or refund a purchased label (capabilities.voidLabel). */
  voidLabel?(label: PurchasedLabel): Promise<VoidResult>;
}
