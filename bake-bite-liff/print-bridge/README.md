# Bake & Bite Print Bridge 0.1

Windows pilot. Use one cashier computer only.

Thai setup instructions: https://pairattori-00129.github.io/-bazi-hourly-app/bake-bite-liff/print-bridge.html

## Files
- BakeBite-PrintBridge.ps1: Windows PowerShell 5.1 / .NET Framework WinForms agent, UTF-8 with BOM.
- Start-PrintBridge.cmd: launches script with STA; does not bypass execution policy.

## Routing
Choose two distinct installed printer queues. Counter receives receipt + all-department packing checklist. Kitchen receives items whose snapshot station_id matches the chosen enabled printer station. Port selection remains the responsibility of Windows.

## Test
The configuration window offers a 3-document sample. No sales are created. Verify Thai shaping, wrapping, paper length/cut and correct device yourself.

## Operation
Disable browser cash auto-print in Hardware Settings and reload POS before enabling the bridge to avoid duplicate receipts. The agent polls authenticated bridge-orders every 3 seconds, keyset-paginated by (paid_at,id), then fetches print-order. First start begins at current UTC time. Later starts resume from local state. Only paid POS orders are included. Do not run on a second computer.

## Recovery
Writes local state before spooling each document, then marks submitted after PrintDocument.Print returns. This means submitted to Windows, not paper-output confirmation. A crash/error in between requires operator confirmation; no claim of exactly-once physical printing. Don't delete local state. No cloud distributed lease or cross-computer deduplication in this pilot. Manual web printing is separate and can produce additional copies.

## Credentials
Password and token stay in process memory. No service-role key or printer-control HTTP listener. Session expires according to existing POS API policy. Restart and sign in again on expiry. Only config and job state are written under LOCALAPPDATA/BakeBitePrintBridge.

## Limits
Manual startup, one counter + one kitchen station, internet required. Not a production-certified Windows installer; Windows execution policy may prevent running unsigned scripts. Do not disable protections to work around this; have the script reviewed/signed or report the policy message. No automatic cash drawer command; driver settings can still open drawer on any counter print. Configure cashbox actions carefully.
