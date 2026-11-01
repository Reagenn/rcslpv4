# Copy LP discover

Copy LP takes a token contract address, lists Meteora DLMM pools (Solana mints) and DexScreener pools (dominant supported chain), lets the user pick a pool, and opens a simulated Zap In position tagged source `Copy LP`.

## Sub-features

- `copy-discover` fills `#copyPoolList` from `Cari pool`.
- `copy-empty-honest` shows notes when Meteora count is 0 (non-Solana mint).
- `copy-zap` confirms a position from the selected pool.
- `copy-pool-positions` lists the desk's own positions for that `poolAddress`.

## How to get to it (user POV)

- Tab `Copy LP`.
- Paste CA into `Contract Address (CA) token`, choose `Cari pool`.
- Select a pool card, then Zap In step 3 `Confirm — Buka posisi (simulasi)`.

## Driving it with Cursor browser

Preconditions:

- Isolated origin, doctor pass, default demo.
- Network to DexScreener and, for Solana mints, `https://dlmm.datapi.meteora.ag`. Failure of those APIs fails this feature.
- Fixture mint: wrapped SOL `So11111111111111111111111111111111111111112`.

- **Discover.** Tab `Copy LP`. Fill `#copyCaInput` with the fixture mint. Choose `Cari pool`. `#copyPoolList` shows pool cards (Meteora and/or Dex). `#copyTokenHead` is non-empty.
- **Select.** Click one supported pool card. `#zapPoolInfo` is no longer `Belum ada pool dipilih.`
- **Zap.** Leave `#zapAmount` at `200`. Choose `Confirm — Buka posisi (simulasi)`. `#zapMsg` is not an error.
- **Pool positions.** `#poolPositions` shows at least one row for the desk (not a third-party wallet).
- **Proof.** Screenshot discover list + zap summary + pool positions. `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs copy-lp-after` — an open position with `source: "Copy LP"` and `poolAddress` set; SOL USDC reduced by 200 if the pool was SOL.

## Gotchas

- DexScreener pools are filtered to the dominant supported chain of that CA. Missing PulseChain rows for a USDC Ethereum CA is expected, not a bug.
- Fee fields from DexScreener stay empty (`—`); do not treat blank fee as a failed discover.
- Monitor (`Jalankan monitor`) is a later journey; open proof does not require it.
- If discover returns zero pools, record `#copyMsg` and the `notes` from a snapshot; do not invent a pool via `POST /api/copylp/open`.
