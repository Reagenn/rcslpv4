# LP Desk verification map

Maintained source for verifying user-facing behavior of LP Desk local v4. Read this index, then the feature file for the journey.

## Baseline preconditions

- Launch with `node .cursor/skills/verify-lp-desk/scripts/launch.mjs` and use only that `origin`.
- Run `node .cursor/skills/verify-lp-desk/scripts/doctor.mjs` and require `isolated: true`.
- Never open or reset `http://localhost:3000` from this checkout.
- Start each recipe from default demo state unless its preconditions say otherwise. Default = 7 chain USDC seed totaling 5000, no positions, no leaders, no transactions.
- Restore default with the header button `Reset demo ke keadaan default` on the **isolated** origin when a previous mutation is in the way.
- Keep proof files in `.cursor/skills/verify-lp-desk/evidence/`. Cleanup must not delete them.

## Driving conventions

- Browser: Cursor browser tools against `origin`. Click by accessible name or the ids in the skill table.
- After each mutation, snapshot `GET /api/state` with `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs <label>`.
- Treat on-screen copy as literal (Indonesian UI).
- Report an unreachable path with the control you tried and the unmet precondition. Do not mark it verified via `/api/*` alone.

## Features

- [Reset demo](./reset-demo.md) — wipe instance state back to the 5000 USDC seed.
- [Open simulated LP](./open-lp.md) — Desk terminal search + open, range book card.
- [Buy / sell simulasi](./simulated-trade.md) — per-chain USDC and token qty plus transaction list.
- [Copy LP discover](./copy-lp.md) — paste CA, pool list, Zap In confirm.
- [Monthly profit](./monthly-profit.md) — calendar tab and live sidebar numbers.
