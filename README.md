# LP Desk — Multi-Chain (Versi Lokal v4, Simulasi)

Rekreasi setia dari Demo LP Desk hosted (keadaan per 2026-10-20), dibangun
ulang sebagai proyek lokal Node.js dengan frontend dan backend terpisah.
**Ini bukan salinan byte-per-byte dari file hosted** — fitur dan alurnya
dibuat semirip mungkin.

> ⚠️ **POSISI LP TETAP SIMULASI.** Saldo desk, trade desk, posisi LP, fee,
> dan PnL bukan dana nyata. Modul swap browser mengirim transaksi ERC-20
> sungguhan hanya di **Base Sepolia testnet**; approval dan swap dikonfirmasi
> terpisah melalui wallet. Gunakan token testnet, jangan aset bernilai nyata.
> Aplikasi menolak jaringan selain Base Sepolia, tidak membaca/menyimpan private
> key, dan tidak mengirimkannya ke server. Data pasar berasal dari API publik
> read-only: DexScreener, Meteora DLMM Data API, dan GoPlus.
>
> **Phase 3 (browser):** notifikasi TP/SL dan keluar-range bersifat lokal saat
> tab realtime terbuka; PWA dapat di-install dan shell UI di-cache untuk offline.
> Tidak ada Web Push server atau pemantauan/auto-close 24/7.

## Cara menjalankan

Persyaratan: **Node.js 18+**. Jalankan dari **dalam folder hasil ekstrak**
`lp-desk-local-v4/`:

```bash
npm install   # tidak ada dependensi eksternal; memastikan struktur siap
npm start     # menjalankan backend di http://localhost:3000
```

Lalu buka **http://localhost:3000** di browser.

> ❌ **Jangan membuka `frontend/index.html` langsung dengan klik ganda
> (file://).** Semua panggilan API akan gagal. Jika terlanjur, aplikasi
> menampilkan banner peringatan merah yang mengarahkan ke `npm start` +
> `http://localhost:3000`.

## Reset data

Tutup server, lalu hapus `backend/data/data.json` — file default bersih
dibuat lagi saat server dijalankan. Atau pakai tautan **“Reset demo ke
keadaan default”** di header aplikasi. Modal dasar simulasi selalu
**5.000 USDC**.

## Struktur singkat

```
lp-desk-local-v4/
  frontend/                 -> index.html + assets/css/styles.css + assets/js/app.js
  backend/
    src/server.js           -> server Node http murni (tanpa dependensi) + semua API
    data/data.json          -> state persisten (default bersih)
    package.json
  Dokumentasi.md            -> dokumentasi lengkap: arsitektur, endpoint, PETA FITUR
  README.md
  package.json              -> script start menjalankan backend
  .gitignore
```

Penjelasan lengkap setiap fitur beserta lokasi kodenya ada di
**Dokumentasi.md**.
