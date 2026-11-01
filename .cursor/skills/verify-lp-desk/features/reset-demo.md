# Reset demo

Reset demo returns the isolated LP Desk instance to the shipped default: 5000 USDC split across seven chains, empty positions, empty leaders, empty transaction list.

## Sub-features

- `reset-from-header` runs from the hero link with no confirm dialog.
- `reset-clears-positions` removes open and closed range-book rows.
- `reset-restores-seed` puts SOL at `$1,500.00` and the other seed amounts back.

## How to get to it (user POV)

- On any tab, in the hero under the subtitle, choose `Reset demo ke keadaan default`.

## Driving it with Cursor browser

Preconditions:

- Doctor reports `isolated: true` for this origin.
- Optionally dirty the instance first (open an LP or buy) so reset has something to undo. If the instance is already default, dirty it: fill Buy / Sell with address `verify-token`, symbol `VT`, amount `50`, price `1`, chain `SOL`, then `Buy simulasi`. `#tradeMsg` must contain `berhasil`.

- **Capture before.** Run `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs reset-before`. If you dirtied state, `state.transactions` is non-empty or a SOL USDC is not 1500.
- **Reset.** Choose `Reset demo ke keadaan default` (`#resetDemoBtn`). Toast `#toast` reads `Demo direset ke keadaan default bersih.`
- **See seed balances.** `#balanceGrid` shows a card whose badge is `SOL` and strong text is `$1,500.00`, and a `BASE` card `$800.00`.
- **See empty books.** Range book `#positionsList` has no position cards (or the open count `#posCountOpen` is `0`). `#txList` contains `Belum ada transaksi simulasi.`
- **Proof.** Screenshot the hero + `#balanceGrid`. Run `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs reset-after`. JSON must have `balances.SOL.usdc === 1500`, `balances.BASE.usdc === 800`, `positions.length === 0`, `transactions.length === 0`, `leaders.length === 0`, `totalPortfolioUsdc === 5000`.

## Gotchas

- There is no confirm modal. One click writes default state immediately.
- Clicking this on `http://localhost:3000` wipes the operator's `backend/data/data.json`. Doctor must have failed isolation if you are there — stop.
- Toast auto-hides after about 6 seconds. Screenshot before it disappears, or rely on the after JSON.
- Realtime `/api/realtime` still runs; it does not recreate positions after reset.
