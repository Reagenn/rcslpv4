---
name: verify-lp-desk
description: Drive the LP Desk local v4 web UI (simulation desk at a disposable origin) the way a user does — launch an isolated server, exercise tabs and buttons, and capture proof. Use when proving a UI or API behavior change in this repo, before handing off a Desk/Copy LP/Monthly/Top LP change, or when asked to verify LP Desk.
---

# Verify LP Desk (local v4)

LP Desk is a single-page web app: vanilla `frontend/` served by a dependency-free Node HTTP server in `backend/src/server.js`. Users never open `frontend/index.html` via `file://`. There is no CLI, no auth, no wallet. All balances and LP positions are simulation state in one JSON file.

This skill is for the next agent, read cold. Commands below are literal.

## Isolate or refuse

The product binds `DATA_FILE` to `backend/data/data.json` next to the running `server.js` (`backend/src/server.js`). Two Node processes started from this checkout share that file. Resetting or opening LP on a shared instance corrupts the operator's demo.

**Never drive `http://localhost:3000` from this checkout.** That origin is the operator's session.

Launch copies `frontend/` plus `backend/src/server.js` into a temp directory and starts Node there on a free `127.0.0.1` port. Doctor must confirm the instance `dataFile` is not the repo `backend/data/data.json`. If doctor fails isolation, stop. Do not reset, trade, or open LP on the shared file.

If `scripts/launch.mjs` reports a live verification pid, do not start a second one. Run doctor against the existing instance or clean it up first.

## Launch

From the repo root:

```
node .cursor/skills/verify-lp-desk/scripts/launch.mjs
```

Ready means:

- stdout JSON includes `origin` (example `http://127.0.0.1:51234`) and `ready: true`
- `GET {origin}/` returns HTML containing `Liquidity operations`
- `GET {origin}/api/state` returns JSON with `balances.SOL` and `totalPortfolioUsdc: 5000`

The first `/api/state` is enough even before `backend/data/data.json` exists on disk: `loadState()` returns `defaultState()` when the file is missing. Usable = default 7-chain USDC seed (SOL 1500, BASE 800, ROBINHOOD 500, BSC 700, HYPEREVM 500, ARC 500, ETH 500), empty positions, empty leaders. A TCP accept without that payload is not ready.

Teardown is `node .cursor/skills/verify-lp-desk/scripts/cleanup.mjs` (see Cleanup). Logs: `.cursor/skills/verify-lp-desk/run/server.log`. Instance metadata: `.cursor/skills/verify-lp-desk/run/instance.json`.

## Doctor

Read-only. Run whenever anything looks off, and before the first drive of a session:

```
node .cursor/skills/verify-lp-desk/scripts/doctor.mjs
```

Pass requires: pid alive, `GET /` is LP Desk v4 HTML, `/api/state` usable with `totalPortfolioUsdc === 5000`, instance `server.js` byte-identical to repo `backend/src/server.js`, and `dataFile` ≠ repo `backend/data/data.json`.

## Drive

Harness: the Cursor browser tools against `origin` from `instance.json` (navigate, snapshot, click, fill). There is no Playwright project in this repo.

Stable handles (prefer these over coordinates):

| Control | Handle |
|---|---|
| Reset demo | button `#resetDemoBtn` accessible name `Reset demo ke keadaan default` |
| Tabs | `.tab` buttons named `Desk`, `Copy LP`, `Monthly Profit`, `Top LP` |
| Open LP submit | `#lpOpenBtn` name `Open simulated LP` |
| Token search | `#lpSearchInput`, `#lpSearchBtn` name `Cari token` |
| Buy / sell | `#tradeChain`, `#tradeAddress`, `#tradeSymbol`, `#tradeAmount`, `#tradePrice`, `#tradeBuyBtn` `Buy simulasi`, `#tradeSellBtn` `Sell simulasi`, `#tradeMsg` |
| Copy LP CA | `#copyCaInput`, `#copyDiscoverBtn` `Cari pool` |
| Zap confirm | `#zapOpenBtn` `Confirm — Buka posisi (simulasi)` |
| Range book filters | `#posFilterSeg` buttons `Open`, `Closed`, `Leftover` |
| Toast | `#toast` |

Recipes live in `features/`. Start from doctor-healthy isolated origin. Prefer the feature file's entry points. Do not call `/api/*` as a substitute for a mapped UI path except where a recipe uses a snapshot helper **after** the UI action, to record side effects.

`POST /api/reset` from the UI is destructive **only** on the instance `dataFile`. Still never click reset on `:3000`.

Network: Open LP auto-pilot, Copy LP discovery, Top LP candidates, and live prices call DexScreener / Meteora / GoPlus through the backend. If those fail, the journey fails; do not shorten it to a local-only stub.

## Evidence

Write under `.cursor/skills/verify-lp-desk/evidence/` (survives cleanup).

Proof standards:

- Drive the real user path (tabs, labeled buttons, typed fields). Do not poke `deskState` from the console or POST a test-only route (there are none).
- Capture the action and the resulting state: browser screenshot + accessibility snapshot of the changed panel, plus `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs <label>` which writes `evidence/<label>.json` from `GET /api/state`.
- Verify side effects in that JSON (balances, positions, transactions, pnlLedger) alongside what the screenshot shows.
- External market APIs are production boundaries; do not mock them. If they are down, record the on-screen error (`#lpMsg`, `#copyMsg`, `#discMsg`) and fail the feature.
- Dry-run does not exist. Every mutation writes `data.json` in the **instance** dir.

Minimum artifact set for a feature: `evidence/<feature>-before.json`, `evidence/<feature>-after.json`, `evidence/<feature>.png` (or a browser screenshot saved into that folder), and a short `evidence/<feature>.md` naming the entry point used.

## Cleanup

```
node .cursor/skills/verify-lp-desk/scripts/cleanup.mjs
```

Kills only the pid in `run/instance.json` (Windows: `taskkill /PID … /T /F`; never `taskkill /IM node.exe`). Deletes the temp instance directory. Deletes `run/instance.json`. Does **not** delete `evidence/`. Does **not** touch repo `backend/data/data.json`.

After cleanup, confirm `evidence/` still contains the run's files.

## Helpers

All from repo root:

| Command | What it does |
|---|---|
| `node .cursor/skills/verify-lp-desk/scripts/launch.mjs` | Isolated copy + server; prints origin JSON |
| `node .cursor/skills/verify-lp-desk/scripts/doctor.mjs` | Read-only health + isolation check |
| `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs <label>` | Write `evidence/<label>.json` |
| `node .cursor/skills/verify-lp-desk/scripts/cleanup.mjs` | Stop pid, remove instance dir, keep evidence |

## Feature map

Read `features/README.md`, then the feature file for the journey.
