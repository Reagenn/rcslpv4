# Dokumentasi — LP Desk Lokal v4 (Simulasi)

Dokumen ini menjelaskan cara menjalankan proyek, arsitekturnya, dan **peta
fitur**: setiap fitur beserta file frontend, file/endpoint/fungsi backend,
dan sumber datanya.

> **Batasan:** posisi LP, trade desk, saldo desk, fee, dan PnL tetap simulasi.
> Swap browser adalah transaksi ERC-20 sungguhan di **Base Mainnet (chain ID
> 8453)** dan menggunakan aset nyata. Approval dan swap dikonfirmasi terpisah
> di wallet; transaksi on-chain tidak dapat dibatalkan dan dapat menyebabkan
> kehilangan dana. Periksa kontrak token, quote, chain, dan detail transaksi
> sebelum menyetujui. Aplikasi tidak membaca/menyimpan private key dan tidak
> mengirimkannya ke server. Data yang tidak tersedia dari sumber publik
> ditampilkan kosong atau dilabeli jujur, tidak dikarang.

---

## 1. Cara menjalankan + reset

Persyaratan: **Node.js 18+**. Tidak ada dependensi eksternal (server HTTP
Node murni), jadi `npm install` hanya memastikan struktur siap.

```bash
# dari dalam folder lp-desk-local-v4/
npm install
npm start
# buka http://localhost:3000
```

- **Jangan** membuka `frontend/index.html` langsung (klik ganda / `file://`):
  semua panggilan API akan gagal. Halaman menampilkan banner peringatan
  merah bila terdeteksi dibuka via `file://`.
- Server secara default hanya mendengarkan `127.0.0.1`. Untuk expose lewat
  reverse proxy/container, set `HOST=0.0.0.0` dan `PORT` sesuai kebutuhan;
  gunakan HTTPS di proxy.
- Pendaftaran akun pertama mengklaim salinan `backend/data/data.json` sebagai
  desk akun tersebut. Akun berikutnya mendapat desk simulasi baru. File lama
  tidak dihapus. Data akun berada di `backend/data/users.json` dan
  `backend/data/desks/`; semua file runtime ini privat dan tidak boleh di-commit.
- **Reset desk akun saat ini:** klik “Reset demo ke keadaan default” di header
  (`POST /api/reset`). Ini hanya mereset desk akun yang sedang login.

## 2. Struktur folder dan arsitektur

```
lp-desk-local-v4/
  frontend/
    index.html               -> satu halaman, 5 tab: Desk, Copy LP, Monthly Profit, Card Studio, Top LP
    assets/
      css/styles.css         -> seluruh stylesheet (SATU font stack, dipakai juga canvas)
      js/app.js              -> seluruh logika frontend (fetch API, render, canvas, MediaRecorder)
  backend/
    src/server.js            -> server HTTP Node murni + semua endpoint API + semua logika simulasi
    data/data.json           -> legacy state untuk migrasi akun pertama
    data/users.json          -> akun, hash/session, profil (runtime privat)
    data/desks/              -> state JSON privat per akun (runtime)
    package.json
  package.json               -> root; "npm start" = node backend/src/server.js
  README.md
  Dokumentasi.md
  .gitignore
```

### Arsitektur

- **Frontend** (`frontend/assets/js/app.js`) adalah single-page app vanilla
  JS: tidak ada framework/build step. Ia memanggil API backend lewat
  `api()`/`postJson()`, me-render semua panel, dan menggambar kartu
  ReagenCorp ke canvas.
- **Backend** (`backend/src/server.js`) melakukan tiga hal: (1) menyajikan
  file statis frontend, (2) menyediakan REST API JSON `/api/*`, (3) menjadi
  satu-satunya pemanggil API publik eksternal (DexScreener, Meteora DLMM
  Data API, GoPlus) sehingga frontend tidak terkena CORS dan logika
  penilaian (skor agent, range DLMM, Fee/TVL) konsisten di server.
- **State akun** disimpan per akun di `backend/data/desks/<id>.json`;
  `backend/data/data.json` hanya sumber migrasi satu kali untuk akun pertama.
  `backend/data/users.json` menyimpan hash password scrypt, session token yang
  di-hash, profil dan relasi follow. Cookie session HttpOnly, SameSite=Strict;
  mutasi API memeriksa Origin. Server memakai antrean request karena engine
  desk masih memakai state global dalam satu proses.
- **Batas deployment:** penyimpanan JSON dan session store ini untuk penggunaan
  lokal/satu proses, bukan backend multi-worker atau deployment publik yang
  sudah hardened. Jangan expose langsung ke internet; gunakan HTTPS, backup
  privat, dan reverse proxy yang dikonfigurasi dengan benar.
- **Sumber data eksternal (read-only, tanpa API key):**
  - DexScreener `api.dexscreener.com` — pencarian token, pair, harga live,
    profil token terbaru.
  - Meteora DLMM Data API `dlmm.datapi.meteora.ag/pools` — pool DLMM Solana
    (filter `token_x`/`token_y` per mint), fee & fee/TVL per jendela waktu.
  - GoPlus `api.gopluslabs.io` — keamanan token & holder (EVM:
    `/v1/token_security/<chainId>`; Solana: `/v1/solana/token_security`
    per alamat).

### Daftar endpoint API (semua di `backend/src/server.js`)

| Endpoint | Method | Fungsi |
|---|---|---|
| `/api/auth/register` | POST | Daftar akun dan membuat session |
| `/api/auth/login` | POST | Masuk dengan cookie session |
| `/api/auth/logout` | POST | Menghapus session |
| `/api/auth/me` | GET | Memeriksa akun session saat ini |
| `/api/profile` | GET/POST | Baca/simpan profil dan preferensi privacy |
| `/api/profiles/:username` | GET | Profil publik; posisi/net worth hanya jika dipilih untuk dibagikan |
| `/api/following` | GET/POST | Daftar follow; follow/unfollow akun |
| `/api/leaderboard` | GET | Akun yang opt-in, dengan net worth hanya jika dibagikan |
| `/api/state` | GET | Seluruh state UI: balances, positions (via `positionPublic`), transactions, pnlLedger, dueDiligence, leaders, settings, agentLogs |
| `/api/reset` | POST | Kembali ke `defaultState()` bersih |
| `/api/settings` | GET/POST | Baca/simpan settings 3 grup: `autoTrading`, `tpSl`, `copyTrading` (dengan validasi angka) |
| `/api/agent-logs` | GET | 50 log aktivitas agent terakhir |
| `/api/agent/auto-trading` | POST | Jalankan Nara: sumber DEX Screener atau pool APR Uniswap v4 + Meteora Solana, dengan guardrail |
| `/api/agent/tp-sl-check` | POST | Byte: repricing live + `evaluateTpSlOnFreshPrices()` |
| `/api/agent/copy-trading` | POST | Jalankan Kopi: buka posisi copy dari profil leader |
| `/api/leaders` | GET/POST | Daftar leader (terurut winrate) / tambah leader |
| `/api/leaders/update` | POST | Edit leader |
| `/api/leaders/delete` | POST | Hapus leader |
| `/api/realtime` | GET | Siklus realtime: `repriceOpenPositions()`, nilai portfolio live, ticker per posisi, Auto TP/SL bila armed |
| `/api/dex/search` | GET | Proxy pencarian DexScreener (`?q=`) |
| `/api/dex/token` | GET | Proxy pair per alamat token DexScreener (`?address=`) |
| `/api/candidates` | GET | Kandidat Top LP/Discover dari `runCandidateAgent()` (cache 5 menit) |
| `/api/pools/apr` | GET | APR Uniswap v4 EVM + Meteora DLMM Solana (cache 5 menit; no-key API); `/api/uniswap-v4/pools` tetap alias kompatibilitas |
| `/api/copylp/discover` | GET | Penemuan pool Copy LP: `discoverPools()` (Meteora datapi + DexScreener) |
| `/api/copylp/range` | POST | Hitung range DLMM server-side: `computeRange()` |
| `/api/copylp/open` | POST | Buka posisi dari pool Copy LP (`openPositionInternal()`), `poolAddress` tersimpan |
| `/api/copylp/pool-positions` | GET | Posisi desk pada satu `poolAddress` |
| `/api/copylp/monitor` | POST | Monitor Copy LP: repricing live + saran rebalance/tutup |
| `/api/monthly` | GET | Ringkasan Monthly Profit: `monthlySummary()` (`?month=YYYY-MM`) |
| `/api/trade` | POST | Buy/sell simulasi terhadap saldo per chain |
| `/api/lp/open` | POST | Buka posisi LP terminal (`openPositionInternal()`) |
| `/api/lp/refresh` | POST | Simulasi drift harga + akrual fee → ledger PnL harian |
| `/api/lp/claim` | POST | Klaim fee+reward posisi |
| `/api/lp/close` | POST | Tutup posisi (`closePositionInternal()`) |
| `/api/lp/rebalance` | POST | Tutup lama → pengganti didanai **nilai settled** posisi lama |
| `/api/lp/delete` | POST | Hapus posisi + baris ledger + log terkait (ditolak bila dalam rantai rebalance) |
| `/api/dd` | GET/POST | Baca/simpan due diligence manual per alamat token |

### Skema data `backend/data/data.json`

```jsonc
{
  "version": 4,
  "balances": { "SOL": { "usdc": 1500, "tokens": { "<alamat>": { "symbol": "…", "qty": 0 } } }, "BASE": {}, "ROBINHOOD": {}, "BSC": {}, "HYPEREVM": {}, "ARC": {}, "ETH": {} },
  "positions": [ /* objek posisi, lihat di bawah */ ],
  "transactions": [ { "id", "chain", "symbol", "address", "side": "buy|sell", "amount", "price", "at" } ],
  "pnlLedger": [ { "date": "YYYY-MM-DD", "delta": 0, "kind": "fee|close|rebalance|baseline", "ref": "<id posisi>" } ],
  "feeClaimLog": [ { "date", "amount", "ref" } ],
  "dueDiligence": { "<alamat>": { "checks": {organic,holders,bundling,cabal,sameBlock,social}, "completedChecks", "verdict", "notes", "updatedAt" } },
  "leaders": [ { "id", "label", "wallet", "chain", "platform", "winrate", "totalPnl", "holdTime", "strategy", "favoriteToken", "createdAt", "updatedAt" } ],
  "claimedFeesTotal": 0,
  "createdAt": "ISO",
  "settings": {
    "autoTrading": { "enabled", "minScore", "amountPerPosition", "maxPositions", "chainFilter", "rangePreset", "verdictFilter", "dailyLossLimit", "minLiquidity", "minHolder", "source", "minApr" },
    "tpSl": { "armed", "defaultTpPct", "defaultSlPct" },
    "copyTrading": { "enabled", "leaderId", "amountPerCopy", "maxPositions", "rangePreset", "dailyLossLimit" }
  },
  "agentLogs": [ { "at", "agent": "Nara|Byte|Sora|Kopi|Copy LP", "message", "kind", "ref": "<id posisi|null>" } ]
}
```

Objek **posisi**: `id, chain, address, symbol, name, pair, pairUrl,
poolAddress, product ("DLMM"|"SIM_RANGE"), source ("Open LP"|"Auto Trading
LP"|"Copy LP"|"Copy Trading LP"), copyLeaderId, amount, entryPrice,
currentPrice, minPrice, maxPrice, lowerBin, upperBin, side, strategy,
quote, sl, tp, binStepBps, fees, rewards, claimed (fee yang sudah diklaim
untuk posisi ini), status ("open"|"closed"), createdAt, closedAt,
closeValue, closePnl, closeReason ("close"|"rebalance"|"TP"|"SL"),
replacedBy, replaces, distribution`. Respons API (`positionPublic()`)
menambah field terhitung (`value, holdValue, il, netVsHolding, inRange,
bins, activeBin, activeBinIndex, minPct, maxPct, slPct, tpPct`) **dan**
alias snake_case ala hosted (`entry_price, position_value, hold_value,
net_pnl, impermanent_loss, unclaimed_fee, claimed_fee, lm_reward,
bin_step, active_bin, lower_bin, upper_bin, min_pct, max_pct, sl_pct,
tp_pct, pool_address, copy_leader_id, replaces_position_id,
replaced_by_position_id, created_at, closed_at`). Data lama berstatus
`"rebalanced"` dimigrasikan otomatis saat load menjadi `"closed"` +
`closeReason: "rebalance"` (menyamakan hosted).

**Default settings** (menyamakan nilai hosted yang teramati): Nara
`minScore 70, amountPerPosition 250, maxPositions 3, rangePreset "wide",
verdictFilter "consider", dailyLossLimit 150, minLiquidity 50000,
minHolder 500, source "DEX", minApr 20`; Byte `defaultTpPct 22, defaultSlPct 28`; Kopi
`amountPerCopy 250, maxPositions 3, rangePreset "wide",
dailyLossLimit 150`. Filter verdict memakai kosakata verdict analisis
hosted (`consider|review|avoid|ANY`); nilai lama (label DD) dimigrasikan
oleh `normalizeVerdictFilter()`.

---

## 3. PETA FITUR

Semua file frontend yang sama muncul berulang karena proyek ini satu
halaman: UI di `frontend/index.html`, logika di `frontend/assets/js/app.js`,
gaya di `frontend/assets/css/styles.css`. Nama fungsi di bawah adalah nama
persis di kode.

### 1. Multi-chain + mode Auto
7 chain (SOL, BASE, ROBINHOOD, BSC, HYPEREVM, ARC, ETH) dengan label chain
eksplisit di hasil token dan kartu posisi; mode Auto mendeteksi chain dari
pair DexScreener yang cocok. Frontend: `fillChainSelects()`,
`chainFromDexId()`, `selectToken()`, render di `renderPositions()`.
Backend: konstanta `CHAINS` dan `DEX_CHAIN_MAP` di `server.js`. Sumber:
DexScreener (`chainId` pair).

### 2. Pencarian token DexScreener
Cari berdasarkan nama/simbol/alamat; hasil menampilkan nama, simbol, harga,
likuiditas, volume, pair, dan tautan sumber. Pair dari chain di luar 7 chain
didukung **ditolak dengan pesan jelas** (tidak dipetakan diam-diam).
Frontend: `searchLpTokens()`, `renderSearchResults()`, `tokenFromPair()`.
Backend: `GET /api/dex/search`, `GET /api/dex/token`, `chainFromPair()`.
Sumber: DexScreener.

### Auto Trading: preview pool APR multi-network
Nara dapat memakai sumber `APR pool · Uniswap v4 + Meteora Solana`. Scanner membaca GeckoTerminal untuk pool Uniswap v4 di Base, Ethereum, BNB Chain, Robinhood Chain, Optimism, Arbitrum, Polygon, Avalanche, dan Unichain; Solana memakai daftar pool Meteora DLMM dari Data API. Tidak perlu Subgraph/API key; hasil di-cache 5 menit. Pool umur <24 jam, TVL <$10.000, volume/fee tidak valid dikecualikan.

Uniswap v4 APR indikatif dihitung `(volume 24 jam × fee tier) / TVL × 365 × 100`; Solana/Meteora dihitung `fee 24 jam API / TVL × 365 × 100`. Keduanya bukan jaminan hasil; hook/dynamic fee dapat membuat angka berbeda dari pendapatan LP. Solana bukan Uniswap v4, sehingga hasilnya ditandai `Meteora DLMM` dan memakai sumber terpisah.

Tombol **Preview APR (tanpa trading)** hanya mencari dan menampilkan pool. Setelah preview tersedia, tombol **Jalankan simulasi dari pool APR** menjalankan Nara secara eksplisit setelah konfirmasi; Nara harus aktif, dan kandidat tetap harus ada pada feed analisis serta lolos semua guardrail. Jika tak ada kandidat yang cocok, alasan ditampilkan. Aplikasi tidak mengirim transaksi on-chain.

Frontend: modal `#naraModal`, `scanNaraV4Pools()`, `runNara()`. Backend: `runPoolAprScan()`, `POST /api/agent/auto-trading`.

### 3. Terminal Open LP penuh + auto-pilot
Terminal lengkap di tab Desk (range, Side, Quote, Min/Max, SL/TP, strategi,
chain, pencarian token/pool, distribusi aset). SL/TP terminal diisi dalam
**persen** (SL negatif, mis. −28; TP positif, mis. 22) seperti hosted —
server (`POST /api/lp/open`) mengonversinya ke harga absolut dan posisi
menyimpan `sl_pct`/`tp_pct`. Tanpa token terpilih,
“Open LP” menjalankan auto-pilot: mencari sendiri alamat yang ditempel dan
memilih pair likuiditas tertinggi. Token terminal terpisah **tidak ada** di
halaman utama. Frontend: `openLp()`, `autopilotPick()`, panel
`#openLpPanel`. Backend: `POST /api/lp/open` → `openPositionInternal()`.

### 4. Saldo simulasi, buy/sell, riwayat, persistensi
Saldo USDC + token per chain, buy/sell simulasi, riwayat transaksi, semua
persisten di `data.json`. Frontend: `renderBalances()`,
`renderTransactions()`, `doTrade()`, panel `#balancesPanel`. Backend:
`POST /api/trade`, `defaultState()`, `saveState()`.

Koneksi wallet browser EIP-1193 terpisah dari ledger simulasi. Fitur swap
hanya aktif saat wallet berada di **Base Mainnet (8453)**. UI membaca
alamat/saldo native, pool, saldo token, allowance, dan quote melalui RPC wallet.
Pemilih token menyediakan WETH/USDC bawaan dan import alamat kontrak. Kode
kontrak, decimals, balanceOf, dan allowance diperiksa di chain aktif; nama/simbol
bukan verifikasi keaslian. Token import hanya disimpan selama tab terbuka.
Alamat token bawaan: WETH
`0x4200000000000000000000000000000000000006` (lihat [Base contract
docs](https://docs.base.org/specifications/reference/base-contracts)) dan
USDC kanonis Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (lihat [Circle
USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)).

Pemeriksa pool memakai Uniswap V3 Factory Base
`0x33128a8fC17869897dcE68Ed026d694621f6FDfD`; quote exact-input memakai
QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`; eksekusi memakai
SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` (lihat [deployment
docs Uniswap](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)).

Untuk token ERC-20 Base Mainnet yang dipilih pengguna, tombol **Approve jumlah
tepat** memberi allowance sebesar input saja; allowance lama yang nonzero dapat
memerlukan reset ke nol, sebagai transaksi terpisah. Tombol **Swap** mengirim
exact-input dengan minimum output sesuai slippage 0,5/1/2/5%. Sebelum transaksi,
UI memeriksa chain, akun, saldo ETH untuk gas, dan estimasi gas, lalu meminta
konfirmasi tambahan; wallet tetap meminta signing untuk setiap transaksi.
Pengguna juga harus mencentang pengakuan risiko mainnet. Quote kedaluwarsa
setelah 2 menit dan perubahan input/akun/chain/slippage membatalkannya. Hash
receipt ditautkan ke BaseScan. **Approval maupun swap memakai aset nyata dan
tidak dapat dibatalkan.** Posisi LP, trade, dan saldo di desk tetap simulasi;
tidak ada transaksi LP (mint/close/claim). Alamat wallet hanya di memori
frontend; tidak ada backend wallet. Frontend: `initBrowserWallet()`,
`checkBaseMainnetPool()`, `quoteBaseMainnetSwap()`,
`approveBaseMainnetSwap()`, `executeBaseMainnetSwap()`, panel `#walletPanel`.

### 5. Simulasi Meteora DLMM (Solana)
Price bins + active bin, bin step, strategi Spot/Curve/Bid-Ask,
in/out-of-range, rincian fee/reward/IL, claim, dan rebalance — posisi
pengganti didanai dari **nilai settled** posisi lama (`settledValue`), dan
relasi ID lama–baru dicatat (`replaces`/`replacedBy`). Active bin
**dihitung dari harga live** terhadap bin step posisi di
`positionPublic()` (`activeBin` + `activeBinIndex`), tidak lagi hardcode.
Kartu posisi menampilkan harga live + % vs entry, LP position value, hold
benchmark, Net PnL vs Holding, IL, unclaimed/claimed fees, LM rewards,
range dalam harga + persen, bins + ACTIVE, dan SL/TP dalam persen +
harga. Frontend: `renderPositions()`, `renderHolding()` (preview bins),
`handlePositionAction()`. Backend: `positionPublic()`, `makeBins()`,
`POST /api/lp/claim|close|rebalance`, `closePositionInternal()`.

### 6. Desk Net PnL vs Holding
Nilai LP + fee/reward dibandingkan benchmark memegang aset sesuai bobot
distribusi posisi; selisih negatif ≈ impermanent loss. Frontend:
`renderHolding()`. Backend: `positionPublic()` menghitung `holdValue`
(dari `distributionWeights()`), `il`, dan `netVsHolding`.

### 7. Monthly Profit + ledger PnL
Kalender harian (PnL + jumlah posisi), navigasi bulan + Today, dan 8
statistik (Total Portfolio Value **LIVE REALTIME**, All-time Deposit, Fees
Claimed, Claimable Fees, Total PnL, Avg Invested, Win Rate, Biggest Win).
Didasarkan pada ledger PnL bertanggal (`pnlLedger`) yang diisi
refresh/close/rebalance; posisi lama dibaseline nol. Frontend:
`renderMonthly()`, `shiftMonth()`. Backend: `GET /api/monthly`,
`monthlySummary()`, `livePortfolioValue()`.

### 8. Kartu ReagenCorp + Card Studio
Unduh PNG `ReagenCorp-profit-YYYY-MM.png` dengan judul angka utama
“MONTHLY PNL” dan ringkasan W1–W5. Background gambar → PNG HD; video →
WebM HD 10 detik 12 Mbps (video pendek di-loop, preview play/pause);
canvas 1600×1000; input gambar/video saling eksklusif dengan label format
+ nama file + tombol hapus; kecerahan 80–145% (default 112%) sama di
preview dan output. **Satu renderer** `drawCard()` untuk preview, PNG, dan
WebM; **satu font stack** (`FONT_STACK` di app.js = `--font-stack` di CSS).
Frontend: `drawCard()`, `renderCardPreview()`, `downloadCard()`,
`setBgInfo()`, `startVideoPreviewLoop()`.

### 9. Top LP — tabel Discover
Tabel token padat (Token + jumlah pool, Age, Price 24h + sparkline dari
perubahan jendela DexScreener, MCap, Holders, Volume 5M/1H/6H/24H,
Liquidity, Fee/TVL 5M/1H/6H/24H, Smart LP “—” dengan tooltip, Safety,
tombol hijau Open pool → Copy LP dengan CA terisi + auto discovery).
Fee/TVL hanya dari pool Meteora DLMM Solana via
`meteoraFeeTvlWindows()`; jendela 5M/6H tidak disediakan Meteora Data API
sehingga tampil “—”. Tab Trending/New/Top Fee/TVL/Rising fees, switcher
timeframe, Hide risky, filter chain. Tabel memakai `table-layout: fixed` +
colgroup terukur (total 100%) agar muat viewport desktop; di ponsel menjadi
kartu bertumpuk berlabel. Ekspansi baris: analisis agent (skor 45%
security / 25% organic proxy / 30% market quality, verdict, confidence,
modal detail), Copy CA fallback webview (“Tersalin ✓”), dan workflow DD
manual 7 tool / 6 cek / 4 verdict; kandidat belum diperiksa berlabel “DD
Pending — belum diperiksa, bukan rekomendasi” tanpa nomor ranking.
Frontend: `renderDiscover()`, `discoverRows()`, `sparklineSvg()`,
`candidateDetailHtml()`, `openCandidateModal()`, `openDdModal()`,
`saveDd()`, `copyCa()`, `openPoolFromDiscover()`. Backend:
`GET /api/candidates` → `runCandidateAgent()`, `GET/POST /api/dd`.
**Bentuk respons menyamakan `getlprecommendations` hosted persis:**
`{ fetched_at, recommendations[10], pending_candidates[≤50],
source_note }`, dan setiap kandidat membawa field flat snake_case yang
sama dengan hosted (`price_usd, liquidity_usd, volume_m5/h1/h6/h24,
price_change_*, fee_tvl_5m/1h/6h/24h, holders_count, safety_score,
recommendation_score, market_status, smart_lp_status: "unavailable", …`)
plus objek `agent_analysis{score, security_score, organic_proxy_score,
verdict (consider|review|avoid), confidence (high|low), status,
holder_count, top_holders_percent, positives[], risks[], limitations[],
sources[], analyzed_at}` dan `due_diligence{completed_checks,
final_verdict, holder_verdict, cabal_control, social_history, notes,
updated_at, …}` + `due_diligence_score`. Feed menggabungkan DexScreener
(boost terbaru/teratas, profil terbaru/baru diperbarui) dan token Uniswap v4
Robinhood Chain; maksimum 60 kandidat, dengan prioritas hingga 40 token
Robinhood. GoPlus Solana dipanggil per alamat via
`/v1/solana/token_security`; maksimal 12 token Robinhood tanpa hitungan dari
respons batch dicoba ulang per token agar refresh tidak tertahan. Jika API hanya memberikan daftar
`holders[]`, UI menampilkan jumlah baris sebagai batas minimum (`≥`), bukan
angka total. Jika tidak ada sumber yang menyediakan angka, UI menulis
“Tidak tersedia” secara eksplisit dan tidak mengarang data. Skor = 45%
security + 25% organic proxy + 30% market; chain yang tidak didukung GoPlus
hanya memakai data pasar. Robinhood Chain memakai chain ID GoPlus 4663.
Sumber: DexScreener + GeckoTerminal + Meteora DLMM Data API + GoPlus.

### 10. Copy LP (penemuan pool semua chain)
Tempel CA → daftar pool Meteora DLMM Data API (Solana: harga, base +
dynamic fee, bin step, TVL, volume, fee 24j, APR) dan DexScreener
token-pairs (chain lain); fee tak tersedia tampil kosong. Header statistik
pool penuh termasuk **Fee/TVL 24h dalam persen** dan Est. fee APR =
fee 24j ÷ TVL × 365. Range Spot/Curve/Bid-Ask dihitung server dari
volatilitas 24j + bin step asli (`computeRange()`). Posisi dibuka cara
Meteora (DLMM fixed bins di Solana, range generik di chain lain) dengan
`poolAddress` tersimpan. Panel **Zap In 3 langkah** (mode deposit +
slippage; preset ±5%/±10%/−50%/−70% + stepper −1%/+1% + catatan range vs
spot; ringkasan Confirm). Tabel **Positions In Pool** berisi posisi desk
sendiri di pool itu (value, fee, uPnL, age, range, status in/out) dengan
tombol Claim/Rebalance/Close; tanpa posisi → status kosong jujur.
**Copy LP Monitor** menilai ulang posisi terbuka dari harga live dan
menyarankan rebalance (DLMM) / tutup (generik). Frontend:
`discoverCopyLp()`, `renderCopyPools()`, `poolCardHtml()`,
`selectCopyPool()`, `applyZapRange()`, `updateZapNote()`,
`updateZapSummary()`, `zapOpen()`, `loadPoolPositions()`,
`runCopyMonitor()`. Backend: `GET /api/copylp/discover`
(`discoverPools()`, `normalizeMeteoraPool()`),
`POST /api/copylp/range|open|monitor`, `GET /api/copylp/pool-positions`.
Strategi discovery (menyamakan perilaku hosted yang teramati): pool
DexScreener difilter ke **chain dominan** CA (total likuiditas terbesar
di antara 7 chain didukung — CA USDC Ethereum menampilkan 2 pool
Uniswap Ethereum saja, bukan pool PulseChain); daftar Meteora = pair
DexScreener ber-`dexId` "meteora" yang diperkaya per alamat dari
Meteora DLMM Data API (`GET /pools/<address>`) sehingga jumlahnya
mengikuti indeks DexScreener (wrapped SOL → 11–12 pool), dengan
fallback query mint datapi bila tidak ada pair meteora. Fee/TVL persen
memakai presisi 4 desimal (fee ÷ TVL × 100).

### 11. Copy Trading LP + Kopi
Watchlist leader **manual** (mulai KOSONG): formulir tambah/edit/hapus
leader (label, alamat wallet asli, chain, platform sumber, winrate %,
total PnL, hold time, strategi, CA token favorit opsional), daftar terurut
winrate tertinggi berlabel “input manual — bukan data live” + badge
LEADER COPY di #1. “Jalankan” membuka posisi LP simulasi mengikuti profil
leader: token favorit diverifikasi ulang via DexScreener, atau kandidat
teratas agent API di chain leader; guardrail anti-duplikat; label posisi
“Copy Trading LP”. Kopi meniru **profil strategi tercatat**, bukan gerakan
live wallet. Frontend: `renderLeaders()`, `fillLeaderForm()`,
`saveLeader()`, `fillKopiForm()`, `readKopiForm()`, `runKopi()`, modal
`#kopiModal`. Backend: `GET/POST /api/leaders`, `POST /api/leaders/update`,
`POST /api/leaders/delete`, `POST /api/agent/copy-trading`,
`pickCopyLeader()`, `sortedLeaders()`.

### 12. Agent Crew (4 karakter)
Nara (penguin hitam, tengah, Auto Trading LP), Byte (dino biru, kiri, Auto
TP/SL Guard), Kopi (rubah oranye, Copy Trading LP), Sora (dino pink, kanan,
Portfolio Analyst) di scene dermaga tepi danau animasi CSS (bobbing,
blinking, awan bergerak, riak air). Badge pill BERJALAN/BERHENTI di atas
tiap karakter + titik status di kartu; karakter berhenti tampil redup;
klik karakter/kartu membuka pengaturan. Sora selalu BERJALAN. Frontend:
scene `#dockScene` + `renderCrew()` + `agentRunning()` + `openAgentModal()`;
gaya scene di `styles.css` (`.dock-scene`, `.char`, `.fox`, keyframes
`charBob`/`blink`/`cloudMove`/`rippleGrow`).

### 13. Nara — Auto Trading LP
Toggle (default NONAKTIF), min score, amount, max positions, chain filter,
range preset, verdict filter, sumber kandidat (DEX Screener atau Uniswap v4 +
Meteora Solana), APR minimum; tombol preview tidak membuka posisi. “Jalankan
simulasi sekarang” memproses sumber terpilih dengan seluruh guardrail;
batas modal 5.000 USDC; tidak membuka ulang token berposisi.
Guardrail: batas kerugian harian (default 150, 0 = nonaktif, dari ledger
hari ini via `todayPnl()`), likuiditas minimum (default 50.000), minimum
holder (default 500; data holder tidak tersedia = **gagal**, bukan lolos).
Alasan skip menampilkan angka aktual. Frontend: `fillNaraForm()`,
`readNaraForm()`, `runNara()`, modal `#naraModal`. Backend:
`POST /api/agent/auto-trading`.

### 14. Byte — Auto TP/SL Guard
Toggle armed/paused, TP/SL default posisi baru, grafik jarak per posisi ke
TP/SL, tombol periksa yang menutup posisi menyentuh threshold memakai harga
live. Frontend: `fillByteForm()`, `renderByteChart()`, modal `#byteModal`.
Backend: `POST /api/agent/tp-sl-check`, `evaluateTpSlOnFreshPrices()`,
`fetchLivePrice()`.

### 15. Sora — Portfolio Analyst
Alokasi modal, remaining capital, total PnL, win rate, total fees, alokasi
per chain, concentration insights, kesehatan per posisi (in/out of range +
level risiko), dan rekomendasi — dihitung dari data desk. Frontend:
`renderSora()`, modal `#soraModal` (data dari `GET /api/state`).

### 16. Log aktivitas agent
Panel “Aktivitas agent terbaru” di tab Desk + log per agen di tiap modal.
Frontend: `renderAgentActivity()`, `renderAgentLogs()`. Backend:
`logAgent()` menulis ke `agentLogs` (maks 50, field `ref` = id posisi
terkait), `GET /api/agent-logs`, dan `logs` ikut di `GET /api/state`.

### 17. Portfolio realtime (tetap 5 detik, tanpa animasi)
Interval **tetap 5 detik** tanpa pilihan lain dan **tanpa animasi apa pun**
(titik LIVE statis, tanpa pulse/flash/progress bar). Panel menampilkan
countdown, waktu live terakhir, ticker harga per posisi,
remaining/allocated capital, claimable fees; tombol pause + “Perbarui
sekarang”. Nilai = 5.000 USDC + total PnL dari harga DexScreener terbaru;
penulisan ledger di-throttle (siklus realtime hanya memperbarui harga);
Auto TP/SL ikut jalan tiap siklus bila Byte armed. Animasi Agent Crew
tidak termasuk larangan ini. Frontend: `refreshRealtime()`,
`startRealtime()`/`stopRealtime()` (countdown 1 detik hanya memperbarui
teks angka). Backend: `GET /api/realtime`, `repriceOpenPositions()`,
`totalPnlLive()`, `livePortfolioValue()`.

### 18. Hapus posisi
Tombol “Hapus” di setiap kartu posisi + konfirmasi inline (“Ya, hapus
permanen” / “Batal”). Server menghapus posisi + seluruh baris ledger PnL
+ entri log aktivitas yang merujuknya (Monthly Profit konsisten) dan
menyesuaikan `claimedFeesTotal`. Posisi dalam rantai rebalance DLMM
**ditolak** dengan pesan jelas. Frontend: `handlePositionAction()`
(cabang `askdelete`) di `renderPositions()`. Backend:
`POST /api/lp/delete`.

### 19. Reset demo
Tautan “Reset demo ke keadaan default” di header mengembalikan seluruh
state ke default bersih (saldo awal, tanpa posisi/leader/log, watchlist
Kopi kosong). Frontend: handler `#resetDemoBtn` di `init()`. Backend:
`POST /api/reset` → `defaultState()` + `saveState()`.

### 20. Notifikasi browser dan PWA
Notifikasi opsional disimpan per-browser di localStorage. Izin diminta hanya
setelah tombol diklik pengguna. Alert lokal untuk posisi simulasi: TP/SL yang
ditutup oleh Byte dan transisi pertama posisi dari in-range ke out-of-range;
alert range tidak menutup posisi. Perlu tab terbuka, polling realtime aktif,
dan izin notifikasi browser. Ini **bukan Web Push server**, bukan bot 24/7,
dan tidak mengirim transaksi. Frontend: `initNotificationSettings()`,
`processRealtimeNotifications()`, `sendBrowserNotification()`.

PWA menggunakan `frontend/manifest.webmanifest`, `frontend/service-worker.js`,
dan `frontend/icon.svg`. Service Worker meng-cache shell statis untuk membuka
UI saat offline; request `/api/*` tidak pernah di-cache, jadi posisi, harga, dan
aksi tetap perlu server online. Tombol install muncul saat browser mengirim
`beforeinstallprompt`; iOS menggunakan Share → Add to Home Screen. MIME
`.webmanifest` disajikan oleh static server backend.

### 21. Akun privat, profil, follow, leaderboard
Login/registrasi memakai password hash scrypt dan session cookie HttpOnly;
semua API desk memerlukan session. Desk dipisah per user. Akun pertama
mengklaim salinan state legacy satu kali. Profil dasar dapat dilihat publik,
tetapi posisi simulasi/net worth tersembunyi secara default; kontrol share dan
opt-in leaderboard ada di **Edit profil & privasi**. Following hanya menerima
kolom publik yang memang dibagikan. Leaderboard diberi label simulasi, bukan
track record trading. Frontend: `bootstrapAccount()`, `renderSocialRoute()` dan
panel `#profileEditor`. Backend: `/api/auth/*`, `/api/profile(s)/*`,
`/api/following`, `/api/leaderboard`.

Smoke test terisolasi (menyalin server ke direktori sementara):
`npm run test:phase3`. Ini menguji autentikasi, privacy default, isolasi state,
follow, leaderboard, CSRF dan logout.

---

## Catatan kejujuran data

- **Smart LP** (peringkat leader ala LP Agent) tidak punya sumber publik →
  kolomnya selalu “—” dengan penjelasan tooltip.
- **Fee/TVL 5M/6H**: Meteora DLMM Data API menyediakan jendela
  30m/1h/2h/4h/12h/24h; jendela 5M dan 6H karena itu ditampilkan “—”,
  bukan diisi perkiraan.
- **Fee pool non-Meteora**: DexScreener tidak mempublikasikan fee tier →
  kosong.
- **Holder Solana**: endpoint GoPlus Solana menyediakan `holder_count` +
  `holders[]` (terverifikasi live saat audit parity), jadi holder Solana
  ditampilkan nyata. Untuk mint yang respons GoPlus-nya tidak memuat
  `holder_count`, holder ditampilkan tidak tersedia dan Nara
  menganggapnya tidak lolos (bukan lolos).
- **Leader Copy Trading** adalah catatan manual pengguna, bukan data live;
  Kopi tidak bisa mengikuti gerakan wallet secara langsung karena tidak
  ada feed posisi LP per-wallet dari sumber publik yang terverifikasi.

---

## 4. Parity dengan hosted — hasil audit (2026-10-20)

Audit membandingkan v4 terhadap probe langsung aplikasi hosted
(`getlprecommendations`, `getdesk`, `discoverPools`, dan spesifikasi UI
hosted) lalu memperbaiki selisihnya di kode. Standar: UI + fitur sama
persis; ukuran file bukan kendala. Ini tetap rekayasa parity
perilaku/UI — bukan salinan byte-per-byte file hosted.

**Diperbaiki dalam audit ini:**

1. **Respons kandidat** — dari bentuk internal `{generatedAt,
   recommendations, reserveQueue}` + field camelCase menjadi bentuk
   hosted persis: `{fetched_at, recommendations[10],
   pending_candidates[≤10], source_note}` dengan seluruh field flat
   snake_case + `agent_analysis{}` + `due_diligence{}` + `rationale[]`
   (terverifikasi: 26/26 kandidat membawa set field hosted yang persis,
   tanpa field kurang/lebih). Feed diganti dari token-profiles ke
   **token-boosts + token-pairs** sesuai `source_note` hosted.
2. **Holder Solana** — GoPlus Solana ternyata menyediakan
   `holder_count`/`holders[]`; sekarang dipakai (sebelumnya dianggap
   tidak tersedia sehingga holder Solana tampil 0 dan Nara selalu
   melewati token Solana). Konsentrasi 10 holder teratas kini mengisi
   `top_holders_percent` (EVM + Solana) dan menekan proxy organik.
3. **Verdict/confidence** — verdict analisis dipisah dari verdict DD:
   `agent_analysis.verdict ∈ consider|review|avoid`,
   `confidence ∈ high|low` (tidak ada lagi "medium"), status
   `complete|partial|unavailable`. Chain tanpa GoPlus tetap bisa
   diperingkat dari data pasar saja (perilaku hosted) dengan limitation
   verbatim hosted. Kosakata rationale/positives/risks/limitations
   disamakan dengan contoh hosted (mis. “Likuiditas $5,957”,
   “Tidak ada flag kontrak berisiko pada respons GoPlus”,
   “GoPlus belum memiliki data keamanan untuk alamat ini.”).
4. **Tabel Discover** — kolom gabungan “Fee/TVL (timeframe)” yang
   berlebih diganti kolom **Holders** (urutan 17 kolom hosted: Token,
   Age, Price 24h, MCap, Holders, Vol 5M/1H/6H/24H, Liquidity, F/T
   5M/1H/6H/24H, Smart LP, Safety, Aksi; colgroup tetap total 100%).
   Sel Safety kini menampilkan skor (bukan teks panjang). Catatan
   sumber (`source_note` dari API) ditampilkan di panel.
5. **Default settings** — disamakan ke nilai hosted teramati: Nara
   70/250/3/wide/consider + guardrail 150/50.000/500; Byte TP +22 /
   SL 28; Kopi 250/3/wide/150.
6. **Posisi** — `activeBinIndex` tidak lagi hardcode 0: active bin
   dihitung dari harga live; posisi membawa alias field snake_case
   hosted lengkap termasuk `copy_leader_id`, `pool_address`,
   `claimed_fee` per posisi (baru dilacak), `sl_pct`/`tp_pct`,
   `min_pct`/`max_pct`, `active_bin`. Status posisi lama rebalance kini
   `"closed"` + `closeReason: "rebalance"` seperti hosted (dulu
   `"rebalanced"`). Kartu posisi diperkaya: hold benchmark, claimed
   fees, LM rewards terpisah, % harga vs entry, range dalam persen,
   ACTIVE bin, tanggal buka.
7. **Terminal Open LP** — SL/TP kini dalam **persen** seperti hosted
   (dulu harga absolut), dikonversi server.
8. **Discovery Copy LP** — pool DexScreener difilter ke chain dominan
   CA (USDC Ethereum → 2 pool Uniswap saja, cocok dengan hosted);
   daftar Meteora mengikuti pair DexScreener ber-dexId meteora yang
   diperkaya per alamat dari datapi (wrapped SOL → 11–12 pool, cocok
   dengan hosted 12 dalam drift wajar; sebelumnya hingga 50 pool
   mentah). Presisi Fee/TVL diperbaiki ke 4 desimal (0,3245%).
9. **Zap In** — tombol preset “Otomatis” tambahan dihapus; hosted
   hanya punya 4 preset (±5%, ±10%, −50%, −70%). Range otomatis tetap
   menjadi perilaku awal panel.

**Sudah sama sejak awal (terverifikasi ulang):** envelope Monthly
Profit (8 statistik + kalender), realtime tetap 5 detik tanpa animasi
dengan nilai 5.000 + PnL live, badge BERJALAN/BERHENTI, label “input
manual — bukan data live”, tab Discover (Trending/New/Top Fee/TVL/
Rising fees) + switcher timeframe + Hide risky, `fee_tvl_5m`/`fee_tvl_6h`
null (sama seperti hosted), rumus Fee/TVL (fee÷TVL×100) dan Est. APR
(fee24h÷TVL×365), endpoint Meteora `dlmm.datapi.meteora.ag`, penolakan
hapus posisi rantai rebalance, guardrail Nara (data holder hilang =
gagal) dengan alasan skip berangka aktual.

**Masih beda / keputusan rekresi (jujur):**

- `market_status` dan `due_diligence_score` adalah turunan rekresi
  (hosted tidak mempublikasikan rumusnya): market_status dari besar
  perubahan harga + ketersediaan security/likuiditas;
  due_diligence_score = cek selesai ÷ 6 × 100.
- `safety_score` untuk chain tanpa GoPlus = `market_score` (agar kolom
  Safety terisi seperti tabel hosted); `security_score` tetap null.
- DD manual v4 mencatat status cek (pass/warn/fail), bukan angka —
  field numerik hosted (`bundled_percent`, `organic_score`,
  `same_block_buyers_percent`) diisi null, tidak dikarang.
- Jumlah pool/kandidat dapat berbeda ±1–2 dari hosted pada momen
  berbeda karena indeks DexScreener/Meteora berubah terus (drift
  live); nilai tampil per pool/token yang sama cocok dalam toleransi
  drift + pembulatan.
- Settings internal v4 dikelompokkan (`autoTrading`/`tpSl`/
  `copyTrading`), bukan field flat snake_case seperti `getdesk`
  hosted; nilai dan perilaku UI-nya sama.

**Bukti nilai tampil yang cocok (audit 2026-10-20):** wrapped SOL —
pool teratas SOL/USDC: base fee 0,04%, bin step 4, TVL ≈ $4,52 jt,
fee 24j ≈ $14,6 rb, Fee/TVL 0,3245%, Est. APR ≈ 118% (hosted saat
probe: TVL $4,53 jt, fee $14.293–14.337, Fee/TVL 0,314–0,32%, APR
114–117% — selisih drift data live). USDC Ethereum — Meteora 0
(jujur), tepat 2 pool Uniswap, MCap ≈ $72,38 M (hosted $72,37 M),
fee/APR null.
