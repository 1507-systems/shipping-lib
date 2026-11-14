# shipping-lib

A shipping-label layer that does not depend on any one provider. A store hands
its shipments to a label provider through it and gets tracking back, joined to
its own order ids. It also checks that the service actually bought is the one
the customer picked at checkout.

- **Web-standard only.** No Cloudflare types, no DOM, no Node APIs, and zero
  runtime dependencies. It runs in Cloudflare Workers, the browser, Node 18 or
  later, Deno and Bun.
- **Source-form TypeScript.** `exports` points at `src/*.ts`, and consumers
  bundle it themselves (wrangler/esbuild, vite, vitest, tsx). There are no
  build artifacts to drift.
- **Providers are pluggable.** Pirate Ship ships today. Shippo, EasyPost,
  carrier-direct or other live-API providers implement the same
  `ShippingProvider` interface.

## Install

Consumed as a `github:` dependency pinned to an annotated release tag:

```json
{
  "dependencies": {
    "@1507-systems/shipping-lib": "github:1507-systems/shipping-lib#v0.1.0"
  }
}
```

```ts
import { resolveService, reconcileShipments, createRegistry } from '@1507-systems/shipping-lib';
import { createPirateShipProvider } from '@1507-systems/shipping-lib/pirateship';
```

## Pirate Ship has no API

Pirate Ship says plainly: **"Pirate Ship doesn't offer an API."**
([support article 2309246](https://support.pirateship.com/en/articles/2309246-does-pirate-ship-have-an-api)).
It points users to its integrations and to "spreadsheet uploading (and
tracking data exporting)". Its [Terms of Use](https://ship.pirateship.com/terms)
(last modified March 31, 2024) forbid accessing the service "by any means
other than through interfaces we provide". They also prohibit robots and web
scraping, and the penalty can be suspension or termination of the account.

This library therefore contains **no** client for Pirate Ship's private web
GraphQL, no session-cookie handling and no browser automation. The
community "pirateship-api" wrappers all work that way, and this library does
not depend on them. The provider uses only the two sanctioned routes, and a
person drives both of them in the Pirate Ship web app:

| Step | Who | What |
|---|---|---|
| 1 | Code | `exportShipments()` / `exportBatches()` generates the upload CSV |
| 2 | Operator | Pirate Ship > Ship > Import a Spreadsheet, choose the service shown, buy, print |
| 3 | Operator | Shipments grid (blank search) > Export, or a batch's "Export Data". Use CSV (Settings > General Settings > Spreadsheet Export Filetype) |
| 4 | Code | `parseTrackingImport()` turns that file into `TrackingUpdate[]`. `reconcileShipments()` joins it to orders and checks the service |

`capabilities` is `{ exportFile: true, importTracking: true, purchaseLabel: false, rates: false, track: false, voidLabel: false }`.

### The upload CSV

The header row is fixed, so Pirate Ship asks you to map the columns once and
then remembers the mapping by header text:

```
Order ID,Full Name,Company,Address Line 1,Address Line 2,City,State,Zip,Country,Email,Phone,Pounds,Ounces,Length,Width,Height,Rubber Stamp 1,Rubber Stamp 2,Requested Shipping Service,Order Items,Note
```

One-time mapping in Pirate Ship's import dialog (also exported as
`FIRST_UPLOAD_MAPPING`, and repeated in every export's `first_upload_mapping`
info warning). Columns left unmapped are dropped:

| Column | Map to |
|---|---|
| Order ID | Order ID |
| Full Name | Name |
| Company, City, State, Country | the field of the same name |
| Address Line 1 / Address Line 2 | Address / Address Line 2 |
| Zip | Zipcode |
| Email | Email Address |
| Pounds / Ounces | Package Weight (pounds / ounces), Override |
| Length / Width / Height | Package dimensions, Override |
| Rubber Stamp 1 | Rubber Stamp 1 (prints the order id on the label, for matching it to the packing list) |
| Rubber Stamp 2 | Rubber Stamp 2 (optional fixed text, `rubberStamp2` option) |
| Phone, Requested Shipping Service, Order Items, Note | Passthrough (not native Pirate Ship fields; they never print on the label) |

Row rules:

- **One row per parcel.** A shipment with N > 1 parcels becomes N rows whose
  Order ID is `REF/1ofN`, `REF/2ofN` and so on. The import splits them back
  into `reference` plus `parcel: { index, count }`. Single-parcel shipments
  use the bare reference.
- Weight is split into whole pounds plus ounces (up to 2 decimals). Pirate Ship
  wants numbers only. A missing or invalid weight or dimension is left blank,
  so Pirate Ship's batch "Default" package applies, and a warning is emitted.
- For US addresses, state names are normalized to 2-letter codes and 9-digit
  ZIPs to `NNNNN-NNNN`. Common country names ("Canada", "United Kingdom")
  become ISO alpha-2; anything else that is not 2 letters gets
  `invalid_country`.
- A leading `- ` / `+ ` bullet on name/company/address lines is dropped
  (`- Rear` -> `Rear`) instead of being formula-guarded, because Pirate Ship's
  importer is not a spreadsheet and would keep the guard apostrophe.
- Item quantities may be numbers or numeric strings; anything that is not a
  positive whole number prints as `?` with an `invalid_quantity` warning.
- `customs`, `insuranceCents`, `options` and `labelFormat` cannot be set from
  a spreadsheet; they produce `customs_required` / `unsupported_option` info.
- A shipment is **skipped**, and listed in `skipped` with a warning, when it
  has no reference, a duplicate reference, an unknown service, a service
  Pirate Ship does not sell (FedEx, DHL), or a missing required address field
  (name, line1, city, state, postalCode). User data never causes a throw.
- Warnings are structured: `{ level: 'info' | 'warning', code, message, references? }`.
  Codes include `missing_field`, `invalid_state`, `invalid_zip`,
  `invalid_weight`, `partial_dimensions`, `no_parcels`, `customs_required`,
  `service_destination_mismatch`, `ground_saver_po_box`, `ground_saver_area`,
  `no_rubber_stamps` (UPS Ground Saver and USPS international labels print no
  stamps), `rubber_stamp_long`, `rubber_stamp_overflow` (a long Order ID wraps
  into the line Rubber Stamp 2 needs and pushes it off), `invalid_country`,
  `invalid_quantity`, `unsupported_option`, `mixed_services`,
  `mixed_package_types`, `first_upload_mapping` and `buy_with_service`.

### Matching the checkout service

Pirate Ship's spreadsheet import **cannot set the carrier or service per
row**: the service is chosen per batch when buying. The library enforces the
checkout method in three places:

1. **Carried:** every row carries Pirate Ship's own spelling of the checkout
   service, such as `UPS® Ground` or `UPS 2nd Day Air®`, in
   `Requested Shipping Service`. It reaches Pirate Ship's grid and exports only
   if mapped as Passthrough, and it does not print on the label.
2. **Grouped:** `exportBatches()` writes one CSV per service and package type
   (`ShipmentRequest.packageType`), for example
   `pirateship-import-ups_ground.csv`, and names the service (and package) to
   pick for each.
   `exportShipments()` writes a single file sorted by service. When the file
   mixes services it adds a `mixed_services` warning that lists each group.
3. **Verified:** after purchase, `reconcileShipments(requests, updates)` reads
   the export's `Service` column and flags any label whose service differs
   from checkout (`serviceCheck: 'mismatch'`). The checkout service is
   resolved with `resolveSelection()`, the same resolver the exporter uses,
   so a loose `{ carrier: 'ups', code: '01' }` checks as UPS Next Day Air. A
   checkout service outside the catalog yields `'unverified'`, never a
   raw-code mismatch. Updates are joined by reference; the recipient
   name + ZIP fallback is used only for rows with no Order ID, so an old
   order's label in a full history export is never attached to a repeat
   customer's new order (it lands in `unmatched`).

## Usage

```ts
import { createRegistry, reconcileShipments, resolveService, toSelection } from '@1507-systems/shipping-lib';
import { createPirateShipProvider } from '@1507-systems/shipping-lib/pirateship';

const registry = createRegistry([createPirateShipProvider({ rubberStamp2: 'Packing list enclosed' })]);
const ps = registry.getProvider('pirateship')!;

// Square / checkout gave us "UPS Ground" or "03": canonicalize it.
const service = toSelection(resolveService(order.shippingMethod)!);

const out = ps.exportShipments!([
  {
    reference: order.id,
    service,
    to: { name: 'Ada Lovelace', line1: '12 Analytical Way', city: 'Longmont', state: 'CO', postalCode: '80501', country: 'US' },
    parcels: [{ weightOz: 40, lengthIn: 10, widthIn: 8, heightIn: 4 }],
    items: [{ description: 'Widget', quantity: 2 }],
  },
]);
// out.content -> CSV to download; out.warnings -> show to the operator; out.skipped -> fix and retry.

// Later: the operator uploads Pirate Ship's shipment export.
const { updates, errors } = ps.parseTrackingImport!(exportCsvText);
const { entries, unmatched } = reconcileShipments(pendingRequests, updates);
for (const e of entries) {
  // e.status: pending | partial | shipped; e.serviceCheck: pending | match | mismatch | unverified
}
```

### Service resolution

```ts
resolveService('UPS® Ground')?.code;          // 'ups_ground'
resolveService('03')?.code;                   // 'ups_ground' (UPS API service code)
resolveService('UPS 2nd Day Air')?.code;      // 'ups_2nd_day_air'  ('02')
resolveService('UPS Next Day Air')?.code;     // 'ups_next_day_air' ('01')
resolveService('Next Day Air Early®')?.code;  // 'ups_next_day_air_early'
resolveService('USPS Priority Mail Cubic')?.code; // 'usps_priority'
resolveService('Ground');                     // null: ambiguous (UPS vs FedEx)
trackingUrl('UPS', '1Z999AA10123456784');     // https://www.ups.com/track?tracknum=1Z...
```

Matching is exact on a normalized form, so trademark glyphs, case and
punctuation are ignored, but substrings never match. "UPS Next Day Air Early"
never resolves to "UPS Next Day Air". Numeric codes must be exactly two digits
and are UPS only.

### CSV and formula injection

`writeCsv` and `parseCsv` implement RFC 4180, with tolerant parsing: BOM,
CRLF/LF/CR, stray quotes and an unterminated final quote are all accepted, and
the parser never throws. Before quoting, every written cell goes through
`guardFormula`:

- A cell starting with `=`, `@`, full-width `＝`/`＠`, TAB or CR is always
  prefixed with `'`.
- A cell starting with `+` or `-` is prefixed with `'` **unless** the whole cell
  is a plain number or phone number (`/^[+-][0-9 ().+\-]*$/` with at least
  one digit). That exception keeps `+1 (555) 010-0199` and `-12.5` intact:
  those characters can't form a function call, a cell reference or a DDE
  payload. `-SUM(A1)` and `+cmd|...` are still neutralized.
- `guardPhone` additionally passes a trailing extension
  (`+1 555-010-0199 ext. 5`, `x12`). `writeCsv` takes `formulaGuard` as a
  per-column function, and the Pirate Ship export uses `guardPhone` for the
  Phone column only.

Tracking import reverses the guard on reference cells. It also unwraps
Excel's `="..."` text-forcing, so references and tracking numbers round-trip
exactly.

## Adding a provider

Write a factory that returns a `ShippingProvider`, declare its capabilities
honestly, and implement only the methods those capabilities promise:

```ts
import type { ShippingProvider } from '@1507-systems/shipping-lib';

export function createExampleApiProvider(opts: { apiKey: string; fetch?: typeof fetch }): ShippingProvider {
  return {
    id: 'example',
    displayName: 'Example Labels',
    appUrl: 'https://app.example.com',
    capabilities: { exportFile: false, importTracking: false, purchaseLabel: true, rates: true, track: true, voidLabel: true },
    // Return each quote's provider rate id (rateId) so the exact quote can be bought.
    async getRates(req) { /* POST to the provider's documented API */ return []; },
    // One label per parcel (labels[i].parcel). Pass idempotencyKey to the API so a retry never buys twice.
    async purchaseLabel(req, { rateId, idempotencyKey }) { /* ... */ return { labels: [] }; },
    async getTracking(trackingNumber) { return null; },
    async voidLabel(label) { return { accepted: false }; },
  };
}
```

`Carrier` is open (`KnownCarrier | string`), so an aggregator can report
carriers outside the catalog (OnTrac, Canada Post). When a provider uses its
own service code, set `ServiceSelection.canonical` to the catalog id when one
exists so `sameService`/`reconcileShipments` still compare exactly.
`ShipmentRequest` also carries optional `customs`, `insuranceCents`,
`options` (signature, etc.), `packageType` and `labelFormat`.

Put it in `src/providers/<id>.ts`, add a `src/<id>.ts` subpath entry and a
matching `exports` entry in `package.json`, and use the canonical service
catalog (`resolveService`) so `reconcileShipments` keeps working unchanged.
Use `registry.listProviders({ purchaseLabel: true })` to pick a provider by
capability.

## Assumptions

Pirate Ship does not publish everything this library needs. These choices are
the most defensible ones available and are confirmed only where noted:

1. **No per-row service.** No document shows a spreadsheet column that sets
   carrier or service, so we plan for one batch per service.
2. **Header spellings.** No fixed schema exists ("you can use any title for
   each column"), and mapping is remembered by header text. We use the
   spellings from Pirate Ship's own integration order export (Order ID, Full
   Name, Address Line 1, Zip, Email, Phone, Requested Shipping Service, Order
   Items, Note) and from its weights article (Pounds, Ounces, Length, Width,
   Height). Which headers are auto-mapped on a first upload is not
   documented.
3. **Phone** is not listed among the spreadsheet mappable fields. The column
   is emitted anyway. If Pirate Ship offers no Phone target, map it to
   Passthrough or leave it unmapped. Unmapped columns are assumed to be
   ignored.
4. **One Order ID per row.** Per a third-party guide (EZFormz), each Order ID
   should appear once, which is why multi-parcel shipments use the `/NofM`
   suffix. A reference that itself ends in `/NofM` gets a warning.
5. **Rubber stamps.** Only "Rubber Stamp 1" is named in the docs. We emit
   Rubber Stamp 1 and 2. The length limits are USPS 25 characters and UPS 35
   per line; longer ids get an info warning, because Pirate Ship wraps and
   then truncates. Rubber stamps don't print on UPS Ground Saver.
6. **Country** is emitted as ISO 3166-1 alpha-2 (`US`, `CA`). Customs forms
   can't be set from a spreadsheet, so international rows get a
   `customs_required` note.
7. **Shipment-export headers are undocumented.** Only State, Country, Order
   ID, Carrier, Insurance Type and Service are named. The importer matches
   headers case- and punctuation-insensitively, against alias lists: tracking
   (`Tracking Number`, `Tracking #`, ...), cost (`Cost`, `Label Cost`,
   `Postage`, ...), date (`Ship Date`, `Created Date`, ...), recipient
   (`Recipient`, `Full Name`, `Name`, ...), ZIP and status. The fixture in
   `test/fixtures/` follows the documented columns and assumes the rest. The
   first real export from the account should be checked against it.
8. **Export file type.** Only CSV is parsed. An XLSX upload is detected and
   reported, with instructions to switch Spreadsheet Export Filetype to CSV.
9. **Skipped rows.** Rows whose status contains refund, void or cancel are
   skipped and reported. Dates are normalized to `YYYY-MM-DD` when recognized
   (`M/D/YYYY`, `M/D/YY`, ISO); time and time zone are dropped. Unrecognized
   dates are kept verbatim.
10. **No pushed tracking.** Pirate Ship pushes no tracking back for
    spreadsheet orders. Tracking is current only as of the last export the
    operator imports. Its Square integration, which this library does not use,
    writes tracking back natively.

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit (lib ES2022 only: no DOM, no Node types)
npm test            # vitest run (hermetic, no network)
```

CI (`validate.yml`) runs both on every PR and on every push to `main` (Node 22).

## Releases

Annotated git tags: `git tag -a v0.x.y -m "..." && git push origin v0.x.y`.
There is no registry publish and no deploy job; consumers pin tags.

## License

MIT, Copyright (c) 2026 1507 Systems.
