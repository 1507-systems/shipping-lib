/**
 * @1507-systems/shipping-lib: provider-agnostic shipping-label layer.
 * Provider modules are also available as subpaths (e.g. "./pirateship").
 */
export type {
  Address,
  Carrier,
  CustomsDeclaration,
  CustomsItem,
  KnownCarrier,
  LabelFormat,
  ExportFile,
  ExportResult,
  ExportWarning,
  ImportError,
  Parcel,
  ParcelRef,
  ProviderCapabilities,
  PurchaseOptions,
  PurchaseResult,
  PurchasedLabel,
  RateQuote,
  ServiceSelection,
  ShipmentItem,
  ShipmentOptions,
  ShipmentRequest,
  ShippingProvider,
  TrackingImportResult,
  TrackingUpdate,
  VoidResult,
  WarningLevel,
} from './types';

export {
  SERVICE_CATALOG,
  inferCarrier,
  isKnownCarrier,
  normalizeServiceText,
  parseCarrier,
  resolveSelection,
  resolveService,
  sameService,
  toSelection,
  trackingUrl,
  type ResolveOptions,
  type ServiceDefinition,
} from './services';

export {
  escapeCsvField,
  guardFormula,
  guardPhone,
  normalizeHeader,
  parseCsv,
  parseCsvTable,
  writeCsv,
  type CsvCell,
  type CsvTable,
  type CsvTableRow,
  type ParseCsvOptions,
  type ParseCsvResult,
  type WriteCsvOptions,
} from './csv';

export {
  REQUIRED_ADDRESS_FIELDS,
  isContiguousUs,
  isIsoCountry,
  isPoBox,
  missingAddressFields,
  normalizeCountry,
  normalizeUsState,
  normalizeUsZip,
} from './address';

export { createRegistry, type ProviderRegistry } from './registry';

export {
  reconcileShipments,
  type MatchVia,
  type ReconcileEntry,
  type ReconcileMatch,
  type ReconcileResult,
  type ServiceMismatch,
} from './reconcile';

export {
  createPirateShipProvider,
  PIRATE_SHIP_APP_URL,
  PIRATE_SHIP_ID,
  type PirateShipProvider,
} from './pirateship';
