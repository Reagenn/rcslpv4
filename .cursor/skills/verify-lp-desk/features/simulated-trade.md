# Buy / sell simulasi

Buy and sell move simulated USDC and token quantity on one chain and append a row under Riwayat Transaksi Simulasi.

## Sub-features

- `trade-buy` deducts USDC and credits token qty.
- `trade-sell` requires enough token qty; credits USDC.
- `trade-history` shows side, symbol, chain, amount, price.
- `trade-insufficient` leaves balances unchanged and sets `#tradeMsg` to an error.

## How to get to it (user POV)

- Tab `Desk`, panel `Saldo per Chain` (`#balancesPanel`), box `Buy / Sell Simulasi`.

## Driving it with Cursor browser

Preconditions:

- Isolated origin, doctor pass, default demo.
- Buy fixture: chain `SOL`, address `verify-token`, symbol `VT`, nominal `50`, harga `2`.

- **Buy.** Fill `#tradeChain` `SOL`, `#tradeAddress` `verify-token`, `#tradeSymbol` `VT`, `#tradeAmount` `50`, `#tradePrice` `2`. Choose `Buy simulasi`. `#tradeMsg` contains `Buy simulasi VT sebesar $50.00 berhasil di SOL.`
- **See balances.** SOL card in `#balanceGrid` shows `$1,450.00` and `VT: 25.0000`.
- **History.** `#txList` has a row starting with `BUY VT` and `SOL`.
- **Sell.** Same address/symbol, amount `20`, price `2`. Choose `Sell simulasi`. SOL USDC becomes `$1,470.00` and remaining qty is `15.0000`.
- **Insufficient sell.** Amount `99999` at price `1`. Choose `Sell simulasi`. `#tradeMsg` is `Saldo token simulasi tidak cukup.` Balances stay at the post-sell values.
- **Proof.** Screenshots of `#balanceGrid` and `#txList`. `node .cursor/skills/verify-lp-desk/scripts/snapshot-state.mjs trade-after` with `transactions[0].side` reflecting the last successful trade.

## Gotchas

- Address is required even for this simulation; empty `#tradeAddress` yields `Isi alamat token dulu.`
- Amount is USDC not token qty. Qty = amount / price.
- Reset demo clears trades. Do not prove persistence across reset.
