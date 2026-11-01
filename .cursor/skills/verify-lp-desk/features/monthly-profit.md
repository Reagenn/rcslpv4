# Monthly profit

Monthly Profit shows a calendar of daily ledger PnL and a live sidebar (portfolio value, fees, win rate) for the selected month.

## Sub-features

- `month-tab` opens from nav `Monthly Profit`.
- `month-nav` moves with `‹`, `›`, and `Hari Ini`.
- `month-empty` still shows `All-time deposit` `$5,000.00` with a calendar of zeros when the ledger is empty.
- `month-ledger` reflects a close/refresh that wrote `pnlLedger` (do not fake days in the DOM).

## How to get to it (user POV)

- Tab `Monthly Profit`.
- Card Studio on the same tab is a different feature (background upload / download). Do not require a PNG download to prove the calendar.

## Driving it with Cursor browser

Preconditions:

- Isolated origin, doctor pass.
- For `month-empty`, reset demo first.
- For `month-ledger`, first complete [Open simulated LP](./open-lp.md) then `Refresh harga + akrual fee (simulasi)` (`#lpRefreshBtn`) on Desk so a `fee` ledger row exists.

- **Open tab.** Choose `Monthly Profit`. `#monthLabel` shows the current month. `#mSideDeposit` is `$5,000.00`.
- **Empty proof.** After reset, `#monthlyCalendar` day cells exist; `#mSideTotalPnl` is `$0.00` (or `$0.00` equivalent). `#mSideFeesClaimed` is `$0.00`.
- **Ledger proof.** After a Desk refresh with an open position, reload Monthly Profit (tab click is enough; realtime also refreshes). A day cell for today is non-zero **or** `#mSideClaimable` is non-zero. Snapshot `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs monthly-after` and require `pnlLedger` or open position `fees` to explain the number. If the sidebar says live PnL but `pnlLedger` is empty and there are no open positions, fail.
- **Today.** Choose `Hari Ini`. `#monthLabel` matches the current month.
- **Proof.** Screenshot sidebar + calendar. Keep the JSON snapshot.

## Gotchas

- `#mSideValue` is live portfolio (5000 + live PnL), not a static figure. Compare it to `/api/state` plus open position values, not to a screenshot from an older session.
- Card Studio download needs a user file picker (`#bgImageInput` / `#bgVideoInput`). Agents often cannot satisfy the OS file dialog; skip download unless the picker is actually usable, and do not mark Card Studio verified via canvas internals.
- Calendar PnL is ledger-backed. Realtime fee accrual on open positions does not always write `pnlLedger` until refresh/close/rebalance. Do not assert a green today-cell solely because `#rtClaimable` moved.
