---
name: verify-lp-desk-invariants
description: Formally check LP Desk simulated capital and concentrated-liquidity valuation — IL never looks like a gain versus holding, open/close conserves the 5000 USDC seed, SL beats TP when both fire, rebalance funds the replacement from settledValue. Use when changing valuePosition, openPositionInternal, closePositionInternal, evaluateTpSlOnFreshPrices, /api/lp/open|close|rebalance, or Auto TP/SL in backend/src/server.js.
---

# Verify LP Desk invariants

A user of this simulation can lose desk USDC or see "impermanent loss" as a profit versus holding if valuation or close/rebalance is wrong. There are no unit tests in the repo. This skill is the check to run on every change that touches those functions.

Node 18+ is already required to run LP Desk. No TLA+ / Java toolchain: the properties are about every input of a pure valuation function and short in-memory sequences of the same functions the HTTP handlers call, not about message-order bugs across processes.

## Whether a change is in scope

In scope if the diff touches `backend/src/server.js` functions recorded in `coverage.json`, or the HTTP routes that call them (`POST /api/lp/open`, `/api/lp/close`, `/api/lp/rebalance`, `/api/agent/tp-sl-check`, `GET /api/realtime` when TP/SL is armed).

If `coverage.json` `serverJsSha256` does not match the file on disk, do not trust a pass from memory. Re-read the functions, fix the check if the code still claims the same properties, then update the hash and line numbers. Move the fingerprint forward only after that confirmation.

This checkout had no git commit at generation time; the fingerprint is the SHA-256 of `backend/src/server.js`.

## Property (plain language)

1. **IL is not a gain.** For a concentrated-liquidity position, desk value versus holding the entry inventory is never positive (beyond two-cent rounding). Harm: the holding benchmark would lie, hiding impermanent loss.
2. **Open then close at the same price restores the 5000 USDC seed** across chains. Harm: simulated capital leaks on a round trip.
3. **Stop-loss wins.** If live price is at or below SL, Byte closes with reason `SL` even when a TP price is also on the wrong side of the market. Harm: a crashing position could be booked as take-profit.
4. **Rebalance spends settled value only.** After close-for-rebalance, the replacement amount equals `settledValue` and SOL USDC matches the post-open level (no second debit of the original size). Harm: the v3 bug — replacement rejected or extra USDC taken after the old position is already closed.

## Run

From the repo root:

```
node .cursor/skills/verify-lp-desk-invariants/scripts/check.mjs
```

Exit 0 and JSON `"ok": true` means every property held on this run's grid and sequences. Exit 1 is a real finding or a stale coverage fingerprint — read the FAIL line. Do not weaken the assertions to get a pass.

The checker **extracts** the live function text from `backend/src/server.js` (it does not keep a second edited copy of the math). `saveState` is a no-op so the operator's `backend/data/data.json` is never written.

## Real bug vs modeling error

- **Real bug:** `valuePosition` returns `il > 0` on an in-range CL sample; or `evaluateTpSlOnFreshPrices` reports `TP` when `price <= sl`; or chain USDC after open/close is not ~5000. Quote the FAIL object (amount, prices, reason). Those fields are the same names as in `server.js`.
- **Modeling / coverage error:** hash mismatch, function not found, line moved. Update `coverage.json` after reading the new code. Do not "fix" a hash mismatch by copying an old hash.

A check you have never seen fail is unused: after writing this skill the generator flipped the IL sign in `valuePosition`, watched this command fail, then restored the file.

## Bounds and what is left out

- IL grid: amounts `{1,50,100,250,1500}`, entry prices from `1e-4` to `1234.56`, range spans 2%–200%, sample live prices below/inside/above the range. Not every IEEE float.
- Sequences are single-threaded in-memory calls, one request at a time. Overlapping `await fetchLivePrice` in `/api/realtime` vs `/api/lp/close` is not explored.
- `round2` / `roundPrice` are the product's rounding; the IL tolerance is 0.02 USDC.
- DexScreener, Meteora, GoPlus, Nara candidate scoring, and Card Studio are out of scope.
- Fee accrual uses `Math.random` in the server; conservation is asserted at unchanged price with zero fees.

## Counterexample shape

Tell a failure as: "Opened 100 USDC of VT on SOL at 10, range 8–12. Live price 20. `valuePosition` reported `il` +N versus holding. `valuePosition` in `backend/src/server.js` (see `coverage.json` line) is what computed that."

## After an intended behavior change

Update the extracted line numbers and hash in `coverage.json` only when the properties still hold (or the user asked to change the property). Point follow-up work at `/maintain-formal-verification-skill`.
