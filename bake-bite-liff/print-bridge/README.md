# Bake & Bite Print Bridge 0.2

Windows PowerShell 5.1/.NET Framework pilot, one cashier PC. Setup: ../print-bridge.html.

## Admin configuration
Authenticated read-only pos-api?action=bridge-config returns counter enabled/name/paper plus all enabled printer stations, with a SHA-256 revision. Counter is saved in hardware_settings; departments in prep_stations. No privileged database key is delivered to client. User POS sessions can read printer configuration, but cannot modify Admin configuration.

Agent refreshes configuration each poll (~3 seconds plus network/print time). Validate all enabled printer names against InstalledPrinters; suspend without advancing watermark on unknown/blank names. Never default to another queue. Station items are matched by order_items.prep_station_id snapshots, not live product categories.

## Routing and idempotency
Counter receipt and packing documents use per-order receipt/packing keys. Each department uses station-{uuid}, so two stations on one printer still produce distinct tickets. Keys do not include printer names: changing a destination does not resend jobs already submitted. Pending jobs use current configuration. Disabled outputs are not scheduled. Turning outputs back on does not backfill orders whose watermark has already advanced.

## Upgrade
Close 0.1.1 first. Preserve LOCALAPPDATA/BakeBitePrintBridge/state.json and config.json. Version 1 ledger kitchen keys map to station UUID from the previous config.json; back up old state before migration. Fail closed if old kitchen history exists but old station mapping is missing. Do not delete state to repair a problem. No automatic reprints of history.

## Testing
Mock tests cover authorization, station filtering, config revision changes, keyed duplicate prevention and legacy key migration. Must validate 0.2 on actual Windows/printers; this environment cannot run WinForms/Windows spooler. Existing PrintDocument rendering logic retained. Test all devices sends synthetic documents only; no order writes.

## Limits
One computer, authenticated session lifetime, internet needed, manual startup, no cloud distributed lease, no exactly-once physical-paper guarantee. A submitted job means handed to Windows. Ambiguous submissions require operator decision. Do not run 0.1.1 and 0.2 together. Browser auto-cash print must be disabled to prevent independent browser copies. No execution-policy bypass in launcher; no password/token written to disk.
