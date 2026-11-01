# Open simulated LP

Open LP on the Desk tab searches DexScreener (or auto-picks the highest-liquidity pair from a pasted mint) and opens a simulated position that deducts USDC on that chain and appears in Range book.

## Sub-features

- `open-search` lists DexScreener pairs from `#lpSearchInput`.
- `open-autopilot` opens from a pasted mint with no prior selection (`#lpOpenBtn` runs auto-pilot).
- `open-book` shows the new card under Range book filter `Open`.
- `open-rejects-unsupported-chain` surfaces a clear error when every pair is outside the seven desk chains.

## How to get to it (user POV)

- Stay on tab `Desk`.
- Use panel `Open LP` (`#openLpPanel`): search or paste, then `Open simulated LP`.
- Hero `+ Open LP` (`#heroOpenBtn`) only scrolls to the same panel.

## Driving it with Cursor browser

Preconditions:

- Isolated origin, doctor pass, default demo (reset if needed).
- Backend can reach `https://api.dexscreener.com`. If search or autopilot returns `DexScreener tidak dapat dihubungi`, the journey fails — do not open via `POST /api/lp/open` instead.
- Amount `#lpAmount` is `100` (default). Chain `#lpChain` can stay `SOL` for a Solana mint.

- **Paste mint.** Put a Solana mint with known DexScreener pairs into `#lpSearchInput` (wrapped SOL `So11111111111111111111111111111111111111112` is the usual fixture).
- **Search.** Choose `Cari token`. `#lpSearchResults` shows pair rows with name, price, and a supported-chain badge. If every row is rejected as outside the seven chains, `#lpMsg` explains that — that is `open-rejects-unsupported-chain`, not a skip.
- **Select a supported pair** (click the result). `#lpSelectedInfo` is no longer `Belum ada token dipilih.` `#lpPairInfo` shows the pair.
- **Open.** Choose `Open simulated LP`. `#lpMsg` must not be an error. `#toast` may also confirm.
- **Range book.** `#posCountOpen` is at least `1`. A card in `#positionsList` shows the token symbol and amount `$100.00` (or the amount you set).
- **Side effect.** `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs open-lp-after`. The matching open position has `source: "Open LP"`, `amount` 100, and `balances[chain].usdc` is 100 lower than the seed for that chain.
- **Proof.** Screenshot `#openLpPanel` plus the new Range book card. Keep the after JSON.

## Gotchas

- Without a selected token, `Open simulated LP` still runs auto-pilot on whatever is in `#lpSearchInput`. An empty box fails with a user-visible message — that is not success.
- Pair from an unsupported DexScreener `chainId` must error clearly, never silently map to another desk chain.
- Live price thereafter needs DexScreener again (`/api/realtime`). Proof of open does not require the live ticker to move.
- `#lpRefreshBtn` is a different journey (simulated drift + fee accrual). Do not use it as a substitute for open.
