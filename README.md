# LP Desk Local v4

**English:** LP Desk is a local multi-chain liquidity dashboard for DeFi users and developers who want to explore simulated LP workflows, with optional real ERC-20 swaps on Base Mainnet.

**Indonesia:** LP Desk adalah dashboard likuiditas multi-chain lokal untuk pengguna DeFi dan developer yang ingin mencoba alur LP simulasi, dengan opsi swap ERC-20 nyata di Base Mainnet.

> [!WARNING]
> All desk balances, trades, LP positions, fees, PnL, agents, and leaderboard values are simulations. Only swaps submitted through the connected browser wallet use real assets on Base Mainnet; approval and swap are separate, irreversible transactions.
>
> Seluruh saldo desk, trade, posisi LP, fee, PnL, agent, dan nilai leaderboard adalah simulasi. Hanya swap yang dikirim melalui wallet browser yang memakai aset nyata di Base Mainnet; approval dan swap adalah transaksi terpisah yang tidak dapat dibatalkan.

## Features / Fitur Utama

- **Private desk / Desk privat:** Google Sign-In protects a separate locally stored simulation desk for each account. / Google Sign-In melindungi desk simulasi tersimpan lokal yang terpisah untuk setiap akun.
- **Multi-chain LP simulation / Simulasi LP multi-chain:** Track simulated balances, token trades, concentrated-liquidity positions, fees, and PnL across the supported chains. / Pantau saldo, trade token, posisi concentrated liquidity, fee, dan PnL simulasi pada chain yang didukung.
- **Market research / Riset pasar:** Search DEX pairs, review trending candidates, preview pool APR, and run a limited 30-day Nara backtest. / Cari pair DEX, tinjau kandidat trending, preview APR pool, dan jalankan backtest Nara 30 hari yang terbatas.
- **Simulation agents / Agent simulasi:** Nara screens LP candidates, Byte applies TP/SL rules, Sora analyzes the portfolio, and Kopi copies manually selected leader profiles. / Nara menyaring kandidat LP, Byte menerapkan aturan TP/SL, Sora menganalisis portofolio, dan Kopi menyalin profil leader yang dipilih manual.
- **Social and browser tools / Fitur sosial dan browser:** Public profiles, following, opt-in leaderboard, local notifications, and an installable PWA shell. / Profil publik, following, leaderboard opt-in, notifikasi lokal, dan shell PWA yang dapat diinstal.
- **Optional Base swap / Swap Base opsional:** Connect an EIP-1193 wallet to quote, approve, and submit real Uniswap V3 ERC-20 swaps on Base Mainnet. / Hubungkan wallet EIP-1193 untuk quote, approval, dan mengirim swap ERC-20 Uniswap V3 nyata di Base Mainnet.

## Quick Start / Mulai Cepat

Requirements / Persyaratan: **Node.js 18+** and npm. After a fresh clone, run these three commands from the repository root / Setelah clone baru, jalankan tiga perintah ini dari root repositori:

```bash
npm install
npm run build:frontend
npm start
```

Open `http://localhost:3000`. The server starts without credentials, but account sign-in requires a Google OAuth client configuration. Create a **Web application** OAuth Client ID in Google Cloud, add `http://localhost:3000` as an Authorized JavaScript origin, then place only the client ID in the untracked root `.env` file:

Buka `http://localhost:3000`. Server dapat berjalan tanpa kredensial, tetapi login akun memerlukan konfigurasi klien Google OAuth. Buat OAuth Client ID bertipe **Web application** di Google Cloud, tambahkan `http://localhost:3000` sebagai Authorized JavaScript origin, lalu simpan hanya client ID di file `.env` root yang tidak dilacak Git:

```env
GOOGLE_CLIENT_ID=your-google-oauth-client-id
```

Restart `npm start` after changing `.env`. Do not open `frontend/index.html` through `file://`; the frontend depends on the local backend. / Restart `npm start` setelah mengubah `.env`. Jangan buka `frontend/index.html` melalui `file://`; frontend bergantung pada backend lokal.

## How to Use / Cara Pakai

1. Start the server, open `http://localhost:3000`, and sign in with the configured Google account. / Jalankan server, buka `http://localhost:3000`, lalu masuk dengan akun Google yang telah dikonfigurasi.
2. Use **Desk**, **Trending**, or **Open LP** to inspect market data and create simulated trades or LP positions; use Nara's preview or backtest before enabling its simulation. / Gunakan **Desk**, **Trending**, atau **Open LP** untuk memeriksa data pasar dan membuat trade atau posisi LP simulasi; gunakan preview atau backtest Nara sebelum mengaktifkan simulasinya.
3. Monitor simulated positions, PnL, fees, and agents. For an optional real swap, connect a wallet on Base Mainnet and verify every token address, quote, approval, and wallet confirmation. / Pantau posisi, PnL, fee, dan agent simulasi. Untuk swap nyata opsional, hubungkan wallet di Base Mainnet dan periksa setiap alamat token, quote, approval, serta konfirmasi wallet.

## Project Structure / Struktur Proyek

```text
.
|-- frontend/
|   |-- index.html                 # Static UI served by the backend
|   |-- assets/css/styles.css      # UI styles
|   `-- assets/js/app.min.js       # Generated browser bundle
|-- frontend-src/
|   `-- app.js                     # Editable frontend source
|-- backend/
|   |-- src/server.js              # Node HTTP server and local JSON API
|   |-- src/*.js                   # Auth, pricing, risk, valuation, and backtest modules
|   `-- data/                      # Ignored local account and desk state
|-- package.json                   # Start, build, and test scripts
`-- Dokumentasi.md                 # Detailed architecture and feature notes
```

`npm run build:frontend` bundles `frontend-src/app.js` into `frontend/assets/js/app.min.js`. Runtime account data is stored under `backend/data/` and must remain local. / `npm run build:frontend` membundel `frontend-src/app.js` ke `frontend/assets/js/app.min.js`. Data akun runtime disimpan di `backend/data/` dan harus tetap lokal.

## Public APIs / API Publik

| Service / Layanan | URL or endpoint used / URL atau endpoint yang dipakai | Purpose / Kegunaan |
| --- | --- | --- |
| DexScreener API | `https://api.dexscreener.com/latest/dex/search?q={query}`; `https://api.dexscreener.com/latest/dex/tokens/{address-or-list}`; `/token-boosts/latest/v1`; `/token-boosts/top/v1`; `/token-profiles/latest/v1`; `/token-profiles/recent-updates/v1` | Finds token pairs, prices, liquidity, volume, discovery pools, and candidate feeds. / Mencari pair token, harga, likuiditas, volume, pool discovery, dan feed kandidat. |
| GoPlus Security API | `https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={addresses}`; `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={address}` | Reads supported token risk and holder data for candidate screening. / Membaca data risiko dan holder token yang didukung untuk penyaringan kandidat. |
| GeckoTerminal API | `https://api.geckoterminal.com/api/v2/networks/{network}/dexes/{dex}/pools`; `https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/hour` | Loads Uniswap v4 pool data for indicative APR previews and hourly OHLCV for the 30-day backtest. / Memuat data pool Uniswap v4 untuk preview APR indikatif dan OHLCV per jam untuk backtest 30 hari. |
| Meteora DLMM Data API | `https://dlmm.datapi.meteora.ag/pools`; `https://dlmm.datapi.meteora.ag/pools/{poolAddress}` | Loads Solana DLMM pool, TVL, volume, fee, and APR inputs. / Memuat input pool DLMM Solana, TVL, volume, fee, dan APR. |
| Google Identity Services and OAuth | `https://accounts.google.com/gsi/client`; `https://oauth2.googleapis.com/tokeninfo` | Renders Google Sign-In and verifies the returned ID token on the backend. / Menampilkan Google Sign-In dan memverifikasi ID token yang dikembalikan di backend. |
| Uniswap Default Token List | `https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/base.json` | Populates the searchable Base Mainnet token picker. / Mengisi daftar token Base Mainnet yang dapat dicari. |
| Base Mainnet JSON-RPC via browser wallet | `https://mainnet.base.org`; injected EIP-1193 provider methods | Configures Base when needed, reads balances and Uniswap V3 contracts, then submits user-confirmed approvals and swaps. / Mengonfigurasi Base bila perlu, membaca saldo dan kontrak Uniswap V3, lalu mengirim approval dan swap yang dikonfirmasi pengguna. |

No API key, access token, or secret is embedded in this repository or required by the public market-data endpoints. Google sign-in still requires the local `GOOGLE_CLIENT_ID` configuration described above. / Tidak ada API key, access token, atau secret yang ditanamkan di repositori ini atau diperlukan oleh endpoint data pasar publik. Login Google tetap memerlukan konfigurasi lokal `GOOGLE_CLIENT_ID` seperti dijelaskan di atas.

## Known Limitations / Batasan

- The desk cannot create, rebalance, close, or claim fees from real LP positions; those workflows are simulations. / Desk tidak dapat membuat, rebalance, menutup, atau mengklaim fee dari posisi LP nyata; seluruh alur tersebut adalah simulasi.
- Real wallet execution is limited to ERC-20 swaps on Base Mainnet; it does not provide real swaps on the other displayed chains. / Eksekusi wallet nyata terbatas pada swap ERC-20 di Base Mainnet; fitur ini tidak menyediakan swap nyata pada chain lain yang ditampilkan.
- Public market and security data can be unavailable, rate-limited, delayed, or cached. APR, scores, and agent output are indicative and cannot guarantee returns or token safety. / Data pasar dan keamanan publik dapat tidak tersedia, terkena rate limit, terlambat, atau berasal dari cache. APR, skor, dan output agent bersifat indikatif serta tidak menjamin hasil atau keamanan token.
- The 30-day backtest uses current candidate snapshots and excludes LP fees, rewards, gas, and slippage; it is not a historical execution replay. / Backtest 30 hari memakai snapshot kandidat saat ini dan tidak menghitung fee LP, reward, gas, serta slippage; hasilnya bukan replay eksekusi historis.
- Notifications only run while the realtime desk tab is active. There is no server-side Web Push, 24/7 monitoring, or unattended real trading. / Notifikasi hanya berjalan saat tab desk realtime aktif. Tidak ada Web Push server, pemantauan 24/7, atau trading nyata tanpa pengawasan.
- Local JSON storage and in-memory request handling are intended for a single local process, not a hardened public or multi-worker deployment. / Penyimpanan JSON lokal dan penanganan request di memori ditujukan untuk satu proses lokal, bukan deployment publik atau multi-worker yang telah di-hardening.

## Contributing / Kontribusi

1. Fork this repository. / Fork repositori ini.
2. Create a branch named `feat/nama-fitur`. / Buat branch bernama `feat/nama-fitur`.
3. Keep the change focused and open a pull request to `main`. / Jaga perubahan tetap fokus dan buat pull request ke `main`.
4. Use one pull request for one feature. / Gunakan satu pull request untuk satu fitur.

Never commit `.env`, `backend/data/data.json`, `backend/data/users.json`, or `backend/data/desks/`. / Jangan pernah commit `.env`, `backend/data/data.json`, `backend/data/users.json`, atau `backend/data/desks/`.

## License / Lisensi

This project is licensed under the [MIT License](LICENSE). / Proyek ini dilisensikan dengan [Lisensi MIT](LICENSE).
