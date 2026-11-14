# PROJECT_LOG — shipping-lib

## What this is

A shared 1507 Systems library that sits in front of label providers and does not depend on any one of them. It holds a canonical service catalog, RFC 4180 CSV with a formula-injection guard, a provider registry, and reconciliation of tracking against orders, including a check of checkout service against purchased service. The first provider is Pirate Ship, built on its sanctioned spreadsheet-import and shipment-export routes. It will be published as the public MIT repo `1507-systems/shipping-lib` and consumed as `github:1507-systems/shipping-lib#v0.1.0`.

## 2026-11-13: initial build (v0.1.0, local only)

- Scaffolded with the path-router-lib conventions: ESM, source-form TS exports (`.` and `./pirateship`), zero runtime deps, devDeps typescript and vitest only, validate and cortex-close workflows. One deliberate difference: tsconfig `lib` is `["ES2022"]`, without DOM, so the code stays Web-standard (Workers and browser).
- Modules: `types`, `services` (catalog, `resolveService`, `trackingUrl`, carrier parse/infer), `csv`, `address`, `registry` (`createRegistry`, with no globals), `reconcile`, and `providers/pirateship`.
- Pirate Ship: there is no API (support article 2309246), and the ToS bans robots and scraping, so the provider is CSV-only and `purchaseLabel`/`rates` are false. It has a fixed upload header set, one row per parcel (`REF/NofM`), and the Order ID in both Order ID and Rubber Stamp 1. The checkout service goes in a visible "Requested Shipping Service" column. `exportBatches()` gives one file per service, and `reconcileShipments()` verifies the purchased service from the export's Service column.
- The README "Assumptions" section records the undocumented points: export header spellings, Phone mapping, rubber stamp count, and per-row service.
- Not yet done: create the GitHub repo, push, tag v0.1.0. After that, check the alias lists against one real Pirate Ship shipment export from the account.
