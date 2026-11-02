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
> **Phase 3:** akun dengan desk privat, profil publik, follow, dan leaderboard
> opt-in (seluruh angka leaderboard simulasi). Posisi dan net worth tidak dibagikan
> secara default. Notifikasi TP/SL dan keluar-range bersifat lokal saat tab
> realtime terbuka; PWA meng-cache shell UI, bukan API/data akun. Tidak ada Web
> Push server atau pemantauan/auto-close 24/7.

## Cara menjalankan

Persyaratan: **Node.js 18+**. Jalankan dari **dalam folder hasil ekstrak**
`lp-desk-local-v4/`:

```bash
npm install   # tidak ada dependensi eksternal; memastikan struktur siap
npm start     # menjalankan backend di http://localhost:3000
```

Lalu buka **http://localhost:3000** di browser dan daftar akun. Akun pertama
mengambil salinan state demo lama (`backend/data/data.json`); akun selanjutnya
mendapat desk baru yang privat. State akun disimpan di `backend/data/users.json`
dan `backend/data/desks/` (jangan commit/unggah file tersebut).

Server hanya bind ke `127.0.0.1` secara default. Untuk reverse proxy/container,
set `HOST=0.0.0.0` dan gunakan HTTPS di proxy. Penyimpanan JSON/session ini
single-process dan belum hardened untuk deployment publik atau multi-worker;
jangan expose langsung ke internet.

> ❌ **Jangan membuka `frontend/index.html` langsung dengan klik ganda
> (file://).** Semua panggilan API akan gagal. Jika terlanjur, aplikasi
> menampilkan banner peringatan merah yang mengarahkan ke `npm start` +
> `http://localhost:3000`.

## Reset data

Reset desk akun yang sedang masuk melalui tautan **“Reset demo ke keadaan
default”** di header. Reset tidak menghapus akun/profil. Untuk menghapus seluruh
akun, session, dan desk lokal, hentikan server lalu hapus `backend/data/users.json`
dan `backend/data/desks/`. `backend/data/data.json` adalah file migrasi legacy;
penghapusnya tidak mereset desk akun yang sudah dibuat. Desk baru dimulai dengan
saldo simulasi **5.000 USDC**.

## Struktur singkat

```
lp-desk-local-v4/
  frontend/                 -> index.html + assets/css/styles.css + assets/js/app.js
  backend/
    src/server.js           -> server Node http murni (tanpa dependensi) + semua API
    data/data.json          -> legacy state (sumber migrasi akun pertama)
    data/users.json         -> akun/session/profil (runtime, privat)
    data/desks/             -> state privat per akun (runtime)
    package.json
  Dokumentasi.md            -> dokumentasi lengkap: arsitektur, endpoint, PETA FITUR
  README.md
  package.json              -> script start + test:phase3
  .gitignore
```

Penjelasan lengkap setiap fitur beserta lokasi kodenya ada di
**Dokumentasi.md**.
