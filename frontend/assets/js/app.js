"use strict";
/* LP Desk local frontend v4 — LP positions remain simulation-only.
 * Browser-wallet swaps are limited to user-confirmed Base Mainnet transactions; no keys are read or stored.
 * SATU font stack dipakai UI (CSS) dan canvas Card Studio (FONT_STACK di sini). */
const $ = (id) => document.getElementById(id);
const FONT_STACK = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
const CHAINS = ["SOL", "BASE", "ROBINHOOD", "BSC", "HYPEREVM", "ARC", "ETH"];
const STABLE_QUOTES = ["USDC", "USDT", "USD", "SOL", "WSOL", "ETH", "WETH"];

let deskState = null;
let selectedToken = null;
let lpLastResults = [];
let candidatesData = null;
let ddContext = null;
let currentMonth = new Date().toISOString().slice(0, 7);
let cardBg = { type: null, img: null, video: null, name: "", objectUrl: "" };
let cardMonthlyCache = null;
let videoPreviewRaf = null;
let settings = JSON.parse(JSON.stringify(defaultSettings()));
let rtPaused = false;
let rtTimer = null;
let rtCountdownTimer = null;
let rtSecondsLeft = 5;
let discoverState = { tab: "trending", tf: "h24", hideRisky: false, chain: "ALL", expanded: null };
let copyDiscovery = null;
let copySelectedPool = null;
let copyTokenChange24h = 0;
/* UI baru mengikuti hosted: filter chain bar + filter Range book, kontrol
   segmented Open LP, dan cache payload realtime terakhir (untuk strip
   statistik + sidebar Monthly). */
let chainFilter = "ALL";
let posStatusFilter = "open";
let deskMode = "networth";
let posLayout = "cards";
let posSortOrder = "newest";
let posSearchQuery = "";
let balanceCurrency = "USD";
let balanceRates = {
  idr: Number(localStorage.getItem("rcslpv4-rate-idr")) || 0,
  eth: Number(localStorage.getItem("rcslpv4-rate-eth")) || 0,
};
let lpSideVal = "Both";
let lpStrategyVal = "Spot";
let lpPreset = "wide";
let rtData = null;
let walletProvider = null;
let walletAddress = "";
let walletChainId = "";
let walletNativeBalance = null;
let walletBoundProvider = null;
const NOTIFICATION_PREFS_KEY = "rcslpv4-browser-notifications";
let notificationPreferences = loadNotificationPreferences();
let rangeNotificationBaselineReady = false;
let previousRealtimeRange = new Map();
let rangeAlertsSent = new Set();
let deferredPwaInstallPrompt = null;
const BASE_MAINNET_CHAIN_ID = "0x2105";
const BASE_MAINNET_UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const BASE_MAINNET_UNISWAP_V3_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const BASE_MAINNET_UNISWAP_V3_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const BASE_MAINNET_TOKENS = [
  { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  { symbol: "USDC", name: "USD Coin (Base)", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
];
const BASE_MAINNET_TOKEN_LIST_URL = "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/base.json";
let listedBaseMainnetTokens = [];
let baseMainnetTokenListStatus = "Memuat daftar token Base dari Uniswap…";
let importedBaseMainnetTokens = [];
let tokenPickerTarget = "A";
let baseMainnetPoolContext = null;
let baseMainnetSwapQuote = null;
const LP_PRESETS = { tight: [-5, 5], wide: [-20, 20] };
const CHAIN_COLORS = { SOL: "#14f195", BASE: "#5b8cff", ROBINHOOD: "#00c805", BSC: "#f0b90b", HYPEREVM: "#a7f3ea", ARC: "#7d9bff", ETH: "#8a9cf5" };

function defaultSettings() {
  // Disamakan dengan default hosted: Nara 70/250/3/wide/consider,
  // Byte TP +22% / SL 28%, Kopi 250/3/wide.
  return {
    autoTrading: { enabled: false, minScore: 70, amountPerPosition: 250, maxPositions: 3, chainFilter: "ALL", rangePreset: "wide", verdictFilter: "consider", dailyLossLimit: 150, minLiquidity: 50000, minHolder: 500, source: "DEX", minApr: 20 },
    tpSl: { armed: false, defaultTpPct: 22, defaultSlPct: 28 },
    copyTrading: { enabled: false, leaderId: null, amountPerCopy: 250, maxPositions: 3, rangePreset: "wide", dailyLossLimit: 150 },
  };
}
function loadNotificationPreferences() {
  const defaults = { enabled: false, takeProfit: true, stopLoss: true, outOfRange: true };
  try {
    const stored = JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY) || "null");
    if (!stored || typeof stored !== "object") return defaults;
    return {
      enabled: stored.enabled === true,
      takeProfit: stored.takeProfit !== false,
      stopLoss: stored.stopLoss !== false,
      outOfRange: stored.outOfRange !== false,
    };
  } catch (_) {
    return defaults;
  }
}
function saveNotificationPreferences() {
  localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(notificationPreferences));
  renderNotificationSettings();
}
function renderNotificationSettings() {
  const supported = window.isSecureContext && "Notification" in window;
  const permission = supported ? Notification.permission : "unsupported";
  $("notifyTp").checked = notificationPreferences.takeProfit;
  $("notifySl").checked = notificationPreferences.stopLoss;
  $("notifyOutOfRange").checked = notificationPreferences.outOfRange;
  const button = $("enableNotificationsBtn");
  button.disabled = !supported || permission === "denied";
  if (!supported) {
    button.textContent = "Notifikasi tidak tersedia";
    $("notificationStatus").textContent = "Perlu browser yang mendukung Notification API dan secure context (localhost/HTTPS).";
  } else if (permission === "denied") {
    button.textContent = "Izin diblokir di browser";
    $("notificationStatus").textContent = "Ubah izin notifikasi situs dari pengaturan browser untuk mengaktifkannya.";
  } else if (notificationPreferences.enabled && permission === "granted") {
    button.textContent = "Matikan notifikasi";
    $("notificationStatus").textContent = "Notifikasi aktif saat desk dan polling realtime berjalan.";
  } else if (permission === "granted") {
    button.textContent = "Aktifkan notifikasi browser";
    $("notificationStatus").textContent = "Izin sudah ada; tekan tombol untuk mulai menerima alert lokal.";
  } else {
    button.textContent = "Minta izin notifikasi";
    $("notificationStatus").textContent = "Notifikasi nonaktif sampai kamu memberi izin lewat tombol ini.";
  }
}
async function enableBrowserNotifications() {
  if (!window.isSecureContext || !("Notification" in window)) return renderNotificationSettings();
  if (Notification.permission === "granted") {
    notificationPreferences.enabled = !notificationPreferences.enabled;
    saveNotificationPreferences();
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    notificationPreferences.enabled = permission === "granted";
    saveNotificationPreferences();
  } catch (_) {
    $("notificationStatus").textContent = "Browser tidak memberikan izin notifikasi.";
  }
}
function sendBrowserNotification(title, body, tag) {
  if (!notificationPreferences.enabled || !window.isSecureContext || !("Notification" in window) || Notification.permission !== "granted") return;
  const options = { body, icon: "/icon.svg", badge: "/icon.svg", tag, renotify: false };
  const fallback = () => { try { new Notification(title, options); } catch (_) { /* Browser tidak mendukung jalur notifikasi ini. */ } };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistration("/")
      .then((registration) => registration ? registration.showNotification(title, options) : fallback())
      .catch(fallback);
    return;
  }
  fallback();
}
function processRealtimeNotifications(data) {
  for (const item of data.closedByTpSl || []) {
    if (item.reason === "TP" && notificationPreferences.takeProfit) {
      sendBrowserNotification("Take profit simulasi", item.symbol + " ditutup otomatis pada harga " + fmtPrice(item.price) + ".", "rcs-tp-" + item.id);
    } else if (item.reason === "SL" && notificationPreferences.stopLoss) {
      sendBrowserNotification("Stop loss simulasi", item.symbol + " ditutup otomatis pada harga " + fmtPrice(item.price) + ".", "rcs-sl-" + item.id);
    }
  }
  const nextRange = new Map();
  for (const position of data.positions || []) {
    if (typeof position.inRange !== "boolean") continue;
    const previous = previousRealtimeRange.get(position.id);
    if (rangeNotificationBaselineReady && previous === true && position.inRange === false &&
        notificationPreferences.outOfRange && !rangeAlertsSent.has(position.id)) {
      rangeAlertsSent.add(position.id);
      sendBrowserNotification("LP keluar range", (position.pair || position.symbol) + " berada di luar range. Tidak ada posisi yang ditutup.", "rcs-range-" + position.id);
    }
    nextRange.set(position.id, position.inRange);
  }
  previousRealtimeRange = nextRange;
  rangeNotificationBaselineReady = true;
}
function updatePwaStatus(message) {
  $("pwaStatus").textContent = message;
}
async function initPwa() {
  const installed = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  if (installed) updatePwaStatus("RCS LP Desk sudah berjalan sebagai aplikasi.");
  else updatePwaStatus("Bisa dipasang dari browser jika browser mendukung PWA.");
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    updatePwaStatus("PWA perlu browser yang mendukung Service Worker dan localhost/HTTPS.");
  } else {
    navigator.serviceWorker.register("/service-worker.js", { scope: "/" })
      .then(() => updatePwaStatus(installed ? "Aplikasi terpasang; shell offline tersedia." : "PWA siap. Data API tetap perlu server online."))
      .catch(() => updatePwaStatus("Service Worker gagal didaftarkan; buka dari localhost atau HTTPS."));
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPwaInstallPrompt = event;
    $("pwaInstallBtn").hidden = false;
    updatePwaStatus("Siap di-install ke perangkat.");
  });
  window.addEventListener("appinstalled", () => {
    deferredPwaInstallPrompt = null;
    $("pwaInstallBtn").hidden = true;
    updatePwaStatus("RCS LP Desk berhasil di-install.");
  });
  $("pwaInstallBtn").addEventListener("click", async () => {
    if (!deferredPwaInstallPrompt) return;
    deferredPwaInstallPrompt.prompt();
    const choice = await deferredPwaInstallPrompt.userChoice;
    deferredPwaInstallPrompt = null;
    $("pwaInstallBtn").hidden = true;
    updatePwaStatus(choice.outcome === "accepted" ? "Install diterima." : "Install dibatalkan; kamu bisa install dari menu browser.");
  });
}
function initNotificationSettings() {
  renderNotificationSettings();
  $("enableNotificationsBtn").addEventListener("click", enableBrowserNotifications);
  $("notifyTp").addEventListener("change", () => { notificationPreferences.takeProfit = $("notifyTp").checked; saveNotificationPreferences(); });
  $("notifySl").addEventListener("change", () => { notificationPreferences.stopLoss = $("notifySl").checked; saveNotificationPreferences(); });
  $("notifyOutOfRange").addEventListener("change", () => { notificationPreferences.outOfRange = $("notifyOutOfRange").checked; saveNotificationPreferences(); });
}
function fmtCount(n) {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(2);
}
function fmtPct(n, digits) {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + "B%";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M%";
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + "K%";
  return v.toFixed(digits != null ? digits : 2) + "%";
}
function fmtPrice(p) {
  const v = Number(p) || 0;
  if (v === 0) return "0";
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(6);
  return v.toPrecision(3);
}
function fmtAge(ts) {
  if (!ts) return "—";
  const diff = Date.now() - Number(ts);
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return days + "d";
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return hours + "h";
  const mins = Math.floor(diff / 60000);
  return Math.max(1, mins) + "m";
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function showToast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    t.hidden = true;
  }, 6000);
}
async function api(pathname, options) {
  const res = await fetch(pathname, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && currentAccount && !pathname.startsWith("/api/auth/")) {
      stopRealtime();
      currentAccount = null;
      deskState = null;
      showAuth("Sesi berakhir. Masuk kembali untuk membuka desk.");
    }
    const err = new Error(data.error || "HTTP " + res.status);
    err.status = res.status;
    err.friendly = data.error || "Terjadi kesalahan. Coba lagi nanti.";
    err.details = data;
    throw err;
  }
  return data;
}
function postJson(pathname, body) {
  return api(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}
function setMsg(id, text, isErr) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isErr ? "var(--danger)" : "";
}

/* ---------------- State loading + renderers ---------------- */

async function loadState() {
  deskState = await api("/api/state");
  if (deskState.settings) settings = deskState.settings;
  renderChainBar();
  renderBalances();
  renderTransactions();
  renderPositions();
  renderHolding();
  renderCrew();
  renderTpSlStrip();
  renderAgentActivity();
  return deskState;
}

function formatBalanceAmount(usd) {
  if (balanceCurrency === "IDR") {
    return balanceRates.idr > 0 ? "Rp" + Math.round(usd * balanceRates.idr).toLocaleString("id-ID") : "Atur kurs IDR";
  }
  if (balanceCurrency === "ETH") {
    return balanceRates.eth > 0 ? (usd / balanceRates.eth).toFixed(6) + " ETH" : "Atur harga ETH";
  }
  return fmtMoney(usd);
}
function renderBalances() {
  if (!deskState) return;
  const grid = $("balanceGrid");
  const totalUsd = CHAINS.reduce((sum, c) => sum + (Number(deskState.balances?.[c]?.usdc) || 0), 0);
  $("balanceTotal").textContent = formatBalanceAmount(totalUsd);
  document.querySelectorAll("#balCurSeg [data-cur]").forEach((b) => b.classList.toggle("active", b.dataset.cur === balanceCurrency));
  grid.innerHTML = CHAINS.map((c) => {
    const b = (deskState.balances && deskState.balances[c]) || { usdc: 0, tokens: {} };
    const toks = Object.entries(b.tokens || {}).filter(([, t]) => (t.qty || 0) > 0.000001);
    return (
      '<div class="balance-card"><span class="chain-badge">' +
      c +
      "</span><strong>" +
      formatBalanceAmount(Number(b.usdc) || 0) +
      "</strong>" +
      (toks.length ? toks.map(([, t]) => '<span class="tok">' + esc(t.symbol) + ": " + Number(t.qty).toFixed(4) + "</span>").join("<br>") : '<span class="tok">Tidak ada token simulasi</span>') +
      "</div>"
    );
  }).join("");
}
function setWalletStatus(message, isError) {
  const el = $("walletStatus");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}
function renderBrowserWallet() {
  $("walletAddress").textContent = walletAddress ? walletAddress.slice(0, 6) + "…" + walletAddress.slice(-4) : "—";
  const onBaseMainnet = walletChainId.toLowerCase() === BASE_MAINNET_CHAIN_ID;
  const chainNumber = walletChainId ? Number.parseInt(walletChainId, 16) : 0;
  $("walletNetwork").textContent = !walletChainId ? "—" : onBaseMainnet ? "Base Mainnet · 8453" : "Chain ID " + chainNumber;
  $("walletNativeBalance").textContent = walletNativeBalance == null ? "—" : walletNativeBalance + " ETH";
  $("walletSwitchBtn").hidden = !walletAddress || onBaseMainnet;
  $("walletConnectBtn").textContent = walletAddress ? "Ganti wallet" : "Hubungkan wallet";
}
function weiToEth(weiHex) {
  const wei = BigInt(weiHex);
  const whole = wei / 1000000000000000000n;
  const fraction = (wei % 1000000000000000000n).toString().padStart(18, "0").slice(0, 6);
  return whole.toString() + "." + fraction;
}
function bindWalletEvents(provider) {
  if (!provider || walletBoundProvider === provider || typeof provider.on !== "function") return;
  walletBoundProvider = provider;
  provider.on("accountsChanged", (accounts) => {
    walletAddress = Array.isArray(accounts) ? (accounts[0] || "") : "";
    walletNativeBalance = null;
    clearBaseMainnetSwapQuote("Akun wallet berubah. Buat quote baru.");
    renderBrowserWallet();
    if (walletAddress) refreshBrowserWallet();
    else setWalletStatus("Wallet tidak terhubung di aplikasi.");
  });
  provider.on("chainChanged", (chainId) => {
    walletChainId = String(chainId || "");
    walletNativeBalance = null;
    baseMainnetPoolContext = null;
    $("poolQuoteBtn").disabled = true;
    clearBaseMainnetSwapQuote("Jaringan berubah. Periksa ulang pool dan quote di Base Mainnet.");
    setPoolQuoteResult("Jaringan berubah. Periksa ulang pool di Base Mainnet.");
    renderBrowserWallet();
    if (walletAddress) refreshBrowserWallet();
  });
  provider.on("disconnect", () => {
    walletAddress = "";
    walletChainId = "";
    walletNativeBalance = null;
    baseMainnetPoolContext = null;
    $("poolQuoteBtn").disabled = true;
    clearBaseMainnetSwapQuote("Wallet terputus. Buat quote baru setelah menghubungkan kembali.");
    renderBrowserWallet();
    setWalletStatus("Wallet terputus.");
  });
}
async function refreshBrowserWallet() {
  if (!walletProvider || !walletAddress) return;
  try {
    walletChainId = String(await walletProvider.request({ method: "eth_chainId" }));
    if (walletChainId.toLowerCase() === BASE_MAINNET_CHAIN_ID) {
      const balance = await walletProvider.request({ method: "eth_getBalance", params: [walletAddress, "latest"] });
      walletNativeBalance = weiToEth(balance);
      setWalletStatus("Wallet terhubung · Base Mainnet");
    } else {
      walletNativeBalance = null;
      setWalletStatus("Jaringan berbeda. Pindah ke Base Mainnet untuk melanjutkan.", true);
    }
    renderBrowserWallet();
  } catch (e) {
    walletNativeBalance = null;
    renderBrowserWallet();
    setWalletStatus("Gagal membaca jaringan/saldo: " + (e && e.message ? e.message : "provider error"), true);
  }
}
async function connectBrowserWallet() {
  if (!window.ethereum || typeof window.ethereum.request !== "function") {
    setWalletStatus("Wallet EIP-1193 tidak terdeteksi. Buka aplikasi ini di browser dengan wallet extension.", true);
    return;
  }
  walletProvider = window.ethereum;
  bindWalletEvents(walletProvider);
  const button = $("walletConnectBtn");
  button.disabled = true;
  try {
    const accounts = await walletProvider.request({ method: "eth_requestAccounts" });
    walletAddress = Array.isArray(accounts) ? (accounts[0] || "") : "";
    if (!walletAddress) throw new Error("Wallet tidak mengembalikan alamat akun.");
    setWalletStatus("Wallet terhubung. Memeriksa Base Mainnet…");
    await refreshBrowserWallet();
  } catch (e) {
    setWalletStatus(e && e.code === 4001 ? "Permintaan koneksi ditolak di wallet." : "Koneksi gagal: " + (e && e.message ? e.message : "provider error"), true);
  } finally {
    button.disabled = false;
    renderBrowserWallet();
  }
}
async function switchToBaseMainnet() {
  if (!walletProvider) return;
  const button = $("walletSwitchBtn");
  button.disabled = true;
  try {
    await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_MAINNET_CHAIN_ID }] });
  } catch (e) {
    if (e && e.code === 4902) {
      try {
        await walletProvider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: BASE_MAINNET_CHAIN_ID,
            chainName: "Base Mainnet",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          }],
        });
      } catch (addError) {
        setWalletStatus("Gagal menambahkan Base Mainnet: " + (addError.message || "wallet error"), true);
      }
    } else {
      setWalletStatus(e && e.code === 4001 ? "Permintaan pindah jaringan ditolak di wallet." : "Gagal pindah jaringan: " + (e && e.message ? e.message : "wallet error"), true);
    }
  } finally {
    button.disabled = false;
    await refreshBrowserWallet();
  }
}
function setPoolCheckResult(message, isError) {
  const el = $("poolCheckResult");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}
function addressAbiWord(address) {
  return address.slice(2).toLowerCase().padStart(64, "0");
}
function abiWord(data, index) {
  const body = String(data || "").replace(/^0x/, "");
  const start = index * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64) throw new Error("Respons ABI tidak lengkap dari RPC.");
  return word;
}
function abiAddress(data) {
  return "0x" + abiWord(data, 0).slice(-40);
}
function allBaseMainnetTokens() {
  const seen = new Set();
  return BASE_MAINNET_TOKENS.concat(listedBaseMainnetTokens, importedBaseMainnetTokens).filter((token) => {
    const address = String(token.address || "");
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || seen.has(address.toLowerCase())) return false;
    seen.add(address.toLowerCase());
    return true;
  });
}
async function loadBaseMainnetTokenList() {
  const status = $("tokenPickerListStatus");
  if (status) status.textContent = baseMainnetTokenListStatus;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(BASE_MAINNET_TOKEN_LIST_URL, { signal: controller.signal, cache: "no-cache" });
    if (!response.ok) throw new Error("Daftar token tidak tersedia (HTTP " + response.status + ").");
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("Format daftar token tidak valid.");
    listedBaseMainnetTokens = entries.filter((token) => token && token.chainId === 8453 &&
      /^0x[a-fA-F0-9]{40}$/.test(String(token.address || "")) &&
      typeof token.symbol === "string" && token.symbol.length > 0 && token.symbol.length <= 32 &&
      typeof token.name === "string" && token.name.length > 0 && token.name.length <= 80 &&
      Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36)
      .map((token) => ({ symbol: token.symbol, name: token.name, address: token.address, decimals: token.decimals }));
    baseMainnetTokenListStatus = listedBaseMainnetTokens.length + " token Base dari Uniswap Default Token List. Token list bukan verifikasi keamanan atau likuiditas.";
  } catch (error) {
    baseMainnetTokenListStatus = "Daftar online gagal dimuat; token bawaan dan token yang di-import tetap tersedia. " + (error.name === "AbortError" ? "Koneksi timeout." : error.message);
  } finally {
    window.clearTimeout(timeout);
    const previousA = $("poolTokenA").value;
    const previousB = $("poolTokenB").value;
    populateBaseMainnetTokenSelectors();
    if (tokenByAddress(previousA)) $("poolTokenA").value = previousA;
    if (tokenByAddress(previousB)) $("poolTokenB").value = previousB;
    renderPoolTokenDetails();
    renderTokenPicker();
  }
}
function tokenByAddress(address) {
  return allBaseMainnetTokens().find((token) => token.address.toLowerCase() === String(address || "").toLowerCase());
}
function populateBaseMainnetTokenSelectors() {
  const previousA = $("poolTokenA").value;
  const previousB = $("poolTokenB").value;
  [$("poolTokenA"), $("poolTokenB")].forEach((select) => {
    select.replaceChildren();
    allBaseMainnetTokens().forEach((token) => {
      const option = document.createElement("option");
      option.value = token.address;
      option.textContent = token.symbol + " · " + token.name + " · " + token.address.slice(0, 6) + "…" + token.address.slice(-4);
      select.appendChild(option);
    });
  });
  $("poolTokenA").value = tokenByAddress(previousA) ? previousA : BASE_MAINNET_TOKENS[0].address;
  $("poolTokenB").value = tokenByAddress(previousB) ? previousB : BASE_MAINNET_TOKENS[1].address;
  renderPoolTokenDetails();
}
function renderPoolTokenDetails() {
  const tokenA = tokenByAddress($("poolTokenA").value);
  const tokenB = tokenByAddress($("poolTokenB").value);
  const lines = [tokenA, tokenB].filter(Boolean).map((token, index) =>
    "Token " + (index ? "B" : "A") + " · " + token.symbol + " · " + token.address + " · " + token.decimals + " decimals");
  $("poolTokenDetails").textContent = lines.join("\n") || "Pilih token untuk melihat alamat kontraknya.";
  const direction = $("poolQuoteDirection");
  if (direction && tokenA && tokenB) {
    direction.options[0].textContent = tokenA.symbol + " → " + tokenB.symbol;
    direction.options[1].textContent = tokenB.symbol + " → " + tokenA.symbol;
  }
  [["chooseTokenABtn", tokenA, "A"], ["chooseTokenBBtn", tokenB, "B"]].forEach(([id, token, side]) => {
    const button = $(id);
    if (!button) return;
    button.textContent = token ? token.symbol + " · " + token.name : "Pilih token";
    button.title = token ? token.address : "Pilih token " + side;
    button.setAttribute("aria-label", token ? "Pilih token " + side + ": " + token.symbol + ", " + token.address : "Pilih token " + side);
  });
}
function renderTokenPicker() {
  const search = $("tokenPickerSearch").value.trim().toLowerCase();
  const matches = allBaseMainnetTokens().filter((token) =>
    [token.symbol, token.name, token.address].some((value) => String(value).toLowerCase().includes(search)));
  const quick = $("tokenPickerQuick");
  quick.replaceChildren();
  const preferredSymbols = ["WETH", "USDC", "AERO", "USDbC", "cbBTC", "DAI", "DEGEN", "TOSHI"];
  const quickTokens = preferredSymbols.map((symbol) => allBaseMainnetTokens().find((token) => token.symbol.toLowerCase() === symbol.toLowerCase())).filter(Boolean);
  quickTokens.filter((token) => !search || [token.symbol, token.name, token.address].some((value) => String(value).toLowerCase().includes(search))).forEach((token) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = token.symbol;
    button.title = token.name + " · " + token.address;
    button.addEventListener("click", () => chooseTokenFromPicker(token.address));
    quick.appendChild(button);
  });
  const status = $("tokenPickerListStatus");
  if (status) status.textContent = baseMainnetTokenListStatus + " · " + allBaseMainnetTokens().length + " token tersedia.";
  const list = $("tokenPickerList");
  list.replaceChildren();
  matches.forEach((token) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "token-picker-row";
    row.addEventListener("click", () => chooseTokenFromPicker(token.address));
    const badge = document.createElement("span");
    badge.className = "token-picker-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = token.symbol.slice(0, 1).toUpperCase();
    const copy = document.createElement("span");
    copy.className = "token-picker-copy";
    const title = document.createElement("strong");
    title.textContent = token.name + " · " + token.symbol;
    const detail = document.createElement("small");
    detail.textContent = token.address.slice(0, 8) + "…" + token.address.slice(-6) + " · " + token.decimals + " decimals";
    copy.append(title, detail);
    row.append(badge, copy);
    list.appendChild(row);
  });
  $("tokenPickerEmpty").hidden = matches.length > 0;
}
function openTokenPicker(target) {
  tokenPickerTarget = target === "B" ? "B" : "A";
  $("tokenPickerTitle").textContent = "Pilih Token " + tokenPickerTarget;
  $("tokenPickerSearch").value = "";
  renderTokenPicker();
  $("tokenPickerModal").hidden = false;
  window.requestAnimationFrame(() => $("tokenPickerSearch").focus());
}
function chooseTokenFromPicker(address) {
  const select = $(tokenPickerTarget === "A" ? "poolTokenA" : "poolTokenB");
  select.value = address;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  $("tokenPickerModal").hidden = true;
}
function decodeAbiText(result) {
  const body = String(result || "").replace(/^0x/, "");
  if (!body || body.length % 2) throw new Error("Metadata token ABI tidak valid.");
  let hex = "";
  if (body.length === 64) {
    hex = body;
  } else {
    const offset = Number(BigInt("0x" + abiWord(result, 0)));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset metadata token tidak valid.");
    const lengthStart = offset * 2;
    const length = Number(BigInt("0x" + body.slice(lengthStart, lengthStart + 64)));
    if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new Error("Metadata token terlalu panjang.");
    hex = body.slice(lengthStart + 64, lengthStart + 64 + length * 2);
  }
  const bytes = new Uint8Array(hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) || []);
  return new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim();
}
async function importBaseMainnetToken() {
  const button = $("addCustomTokenBtn");
  const address = $("customTokenAddress").value.trim();
  const expectedAccount = walletAddress;
  const status = $("customTokenStatus");
  const setStatus = (message, isError) => {
    status.textContent = message;
    status.classList.toggle("error", !!isError);
  };
  if (!walletProvider || !walletAddress) return setStatus("Hubungkan wallet terlebih dahulu.", true);
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return setStatus("Masukkan alamat kontrak EVM yang valid.", true);
  button.disabled = true;
  setStatus("Memverifikasi kontrak dan metadata token di Base Mainnet…");
  try {
    await currentBaseMainnetAccount(expectedAccount);
    const code = await walletProvider.request({ method: "eth_getCode", params: [address, "latest"] });
    if (!code || /^0x0*$/i.test(code)) throw new Error("Alamat tersebut bukan kontrak yang terpasang di Base Mainnet.");
    const known = tokenByAddress(address);
    if (known) {
      setStatus(known.symbol + " sudah ada di daftar token. Pilih token itu dari menu.");
      return;
    }
    const [symbolResult, nameResult, decimalsResult] = await Promise.all([
      baseMainnetCall(address, "0x95d89b41").catch(() => null),
      baseMainnetCall(address, "0x06fdde03").catch(() => null),
      baseMainnetCall(address, "0x313ce567"),
    ]);
    const decimals = Number(BigInt("0x" + abiWord(decimalsResult, 0)));
    if (!Number.isInteger(decimals) || decimals > 36) throw new Error("Decimals token tidak valid atau di luar batas dukungan.");
    const [balanceResult, allowanceResult] = await Promise.all([
      baseMainnetCall(address, "0x70a08231" + addressAbiWord(expectedAccount)),
      baseMainnetCall(address, "0xdd62ed3e" + addressAbiWord(expectedAccount) + addressAbiWord(BASE_MAINNET_UNISWAP_V3_ROUTER)),
    ]);
    abiWord(balanceResult, 0);
    abiWord(allowanceResult, 0);
    await currentBaseMainnetAccount(expectedAccount);
    const symbol = symbolResult ? decodeAbiText(symbolResult) : "";
    const name = nameResult ? decodeAbiText(nameResult) : "";
    const token = { symbol: symbol || "TOKEN", name: name || "Imported token", address, decimals };
    importedBaseMainnetTokens.push(token);
    const previousA = $("poolTokenA").value;
    const previousB = $("poolTokenB").value;
    populateBaseMainnetTokenSelectors();
    $("poolTokenA").value = previousA;
    $("poolTokenB").value = previousB;
    renderPoolTokenDetails();
    $("customTokenAddress").value = "";
    setStatus("Token berhasil diverifikasi dan ditambahkan untuk tab ini. Pilih token dari menu.");
  } catch (e) {
    setStatus(e && e.message ? e.message : "Gagal memverifikasi token pada RPC Base Mainnet.", true);
  } finally {
    button.disabled = false;
  }
}
async function baseMainnetCall(to, data) {
  return walletProvider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
}
async function checkBaseMainnetPool() {
  const button = $("poolCheckBtn");
  baseMainnetPoolContext = null;
  $("poolQuoteBtn").disabled = true;
  clearBaseMainnetSwapQuote("Pool sedang diperiksa ulang. Buat quote baru setelah pemeriksaan selesai.");
  $("poolQuoteResult").textContent = "Periksa pool terlebih dahulu untuk mengaktifkan quote.";
  const tokenA = $("poolTokenA").value.trim();
  const tokenB = $("poolTokenB").value.trim();
  const fee = Number($("poolFeeTier").value);
  const checkAccount = walletAddress.toLowerCase();
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  if (!walletProvider || !walletAddress) return setPoolCheckResult("Hubungkan wallet terlebih dahulu.", true);
  if (!addressPattern.test(tokenA) || !addressPattern.test(tokenB)) return setPoolCheckResult("Masukkan dua alamat kontrak ERC-20 yang valid.", true);
  if (tokenA.toLowerCase() === tokenB.toLowerCase()) return setPoolCheckResult("Token A dan Token B harus berbeda.", true);
  if (![500, 3000, 10000].includes(fee)) return setPoolCheckResult("Fee tier tidak valid.", true);
  button.disabled = true;
  setPoolCheckResult("Memeriksa chain dan factory Uniswap V3 Base Mainnet…");
  try {
    walletChainId = String(await walletProvider.request({ method: "eth_chainId" }));
    if (walletChainId.toLowerCase() !== BASE_MAINNET_CHAIN_ID) {
      renderBrowserWallet();
      throw new Error("Pindahkan wallet ke Base Mainnet sebelum memeriksa pool.");
    }
    const factoryData = "0x1698ee82" + addressAbiWord(tokenA) + addressAbiWord(tokenB) + fee.toString(16).padStart(64, "0");
    const poolResult = await baseMainnetCall(BASE_MAINNET_UNISWAP_V3_FACTORY, factoryData);
    const poolAddress = abiAddress(poolResult);
    if (/^0x0{40}$/i.test(poolAddress)) {
      baseMainnetPoolContext = null;
      $("poolQuoteBtn").disabled = true;
      setPoolCheckResult("Pool tidak ditemukan untuk pasangan token dan fee tier ini pada factory Uniswap V3 Base Mainnet.");
      return;
    }
    const [token0Result, token1Result, slot0Result, liquidityResult] = await Promise.all([
      baseMainnetCall(poolAddress, "0x0dfe1681"),
      baseMainnetCall(poolAddress, "0xd21220a7"),
      baseMainnetCall(poolAddress, "0x3850c7bd"),
      baseMainnetCall(poolAddress, "0x1a686502"),
    ]);
    const token0 = abiAddress(token0Result);
    const token1 = abiAddress(token1Result);
    const [decimals0Result, decimals1Result] = await Promise.all([
      baseMainnetCall(token0, "0x313ce567"),
      baseMainnetCall(token1, "0x313ce567"),
    ]);
    const decimals0 = Number(BigInt("0x" + abiWord(decimals0Result, 0)));
    const decimals1 = Number(BigInt("0x" + abiWord(decimals1Result, 0)));
    if (decimals0 > 36 || decimals1 > 36) throw new Error("Decimals token di luar batas yang didukung.");
    walletChainId = String(await walletProvider.request({ method: "eth_chainId" }));
    if (walletChainId.toLowerCase() !== BASE_MAINNET_CHAIN_ID) throw new Error("Jaringan berubah saat pemeriksaan. Ulangi di Base Mainnet.");
    const slot0Body = String(slot0Result || "").replace(/^0x/, "");
    const sqrtPriceX96 = BigInt("0x" + abiWord(slot0Result, 0));
    const tick = Number(BigInt.asIntN(24, BigInt("0x" + abiWord(slot0Result, 1))));
    const rawLiquidity = BigInt("0x" + abiWord(liquidityResult, 0));
    let spotPrice = null;
    let priceText = "belum diinisialisasi";
    if (sqrtPriceX96 > 0n && slot0Body.length >= 64) {
      const sqrtRatio = Number(sqrtPriceX96) / 2 ** 96;
      const price = sqrtRatio * sqrtRatio * 10 ** (decimals0 - decimals1);
      if (Number.isFinite(price) && price > 0) {
        spotPrice = price;
        priceText = price.toLocaleString("en-US", { maximumSignificantDigits: 8 });
      }
    }
    if ($("poolTokenA").value.toLowerCase() !== tokenA.toLowerCase() || $("poolTokenB").value.toLowerCase() !== tokenB.toLowerCase() || Number($("poolFeeTier").value) !== fee) {
      throw new Error("Pilihan token atau fee tier berubah saat pemeriksaan. Periksa pool kembali.");
    }
    await currentBaseMainnetAccount(checkAccount);
    baseMainnetPoolContext = { tokenA: tokenA.toLowerCase(), tokenB: tokenB.toLowerCase(), fee, poolAddress, token0, token1, decimals0, decimals1, spotPrice };
    const quoteReady = spotPrice > 0 && rawLiquidity > 0n;
    $("poolQuoteBtn").disabled = !quoteReady;
    $("poolQuoteResult").textContent = quoteReady ? "Pool siap untuk quote swap indikatif." : "Pool belum memiliki harga/liquidity aktif; quote belum tersedia.";
    setPoolCheckResult(
      "Pool ditemukan · " + poolAddress +
      "\nToken0: " + token0 + " (" + decimals0 + " decimals)" +
      "\nToken1: " + token1 + " (" + decimals1 + " decimals)" +
      "\nFee: " + (fee / 10000) + "% · Tick: " + tick +
      "\nSpot indikatif: 1 token0 ≈ " + priceText + " token1" +
      "\nLiquidity pool (raw): " + rawLiquidity.toString() +
      "\nRead-only call; bukan quote mint/eksekusi dan tidak ada transaksi dikirim.",
    );
  } catch (e) {
    setPoolCheckResult(e && e.message ? e.message : "Gagal membaca pool dari RPC wallet.", true);
  } finally {
    button.disabled = false;
    renderBrowserWallet();
  }
}
function decimalToTokenUnits(text, decimals) {
  const value = String(text || "").trim();
  if (!value || value.length > 80 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Jumlah harus angka desimal positif yang valid (maks. 80 karakter).");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Jumlah desimal melebihi decimals token (" + decimals + ").");
  const scale = 10n ** BigInt(decimals);
  const fractionUnits = fraction ? BigInt(fraction.padEnd(decimals, "0")) : 0n;
  const units = BigInt(whole) * scale + fractionUnits;
  if (units <= 0n) throw new Error("Jumlah input harus lebih besar dari nol.");
  if (units >= (1n << 256n)) throw new Error("Jumlah input melebihi batas uint256.");
  return units;
}
function tokenUnitsToDecimal(units, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  if (!decimals) return whole.toString();
  const fraction = (units % scale).toString().padStart(decimals, "0");
  const visible = fraction.slice(0, Math.min(decimals, 18)).replace(/0+$/, "");
  return visible ? whole.toString() + "." + visible : whole.toString();
}
async function quoteBaseMainnetSwap() {
  const button = $("poolQuoteBtn");
  const context = baseMainnetPoolContext;
  clearBaseMainnetSwapQuote("Quote sedang dibuat.");
  if (!context) return setPoolQuoteResult("Periksa pool terlebih dahulu.", true);
  const tokenA = $("poolTokenA").value.trim().toLowerCase();
  const tokenB = $("poolTokenB").value.trim().toLowerCase();
  const fee = Number($("poolFeeTier").value);
  if (tokenA !== context.tokenA || tokenB !== context.tokenB || fee !== context.fee) {
    baseMainnetPoolContext = null;
    button.disabled = true;
    return setPoolQuoteResult("Pasangan atau fee tier berubah. Periksa ulang pool terlebih dahulu.", true);
  }
  if (!walletProvider || !walletAddress) return setPoolQuoteResult("Hubungkan wallet terlebih dahulu.", true);
  const direction = $("poolQuoteDirection").value;
  const tokenIn = direction === "aToB" ? tokenA : tokenB;
  const tokenOut = direction === "aToB" ? tokenB : tokenA;
  const inputDecimals = tokenIn === context.token0.toLowerCase() ? context.decimals0 : context.decimals1;
  const outputDecimals = tokenOut === context.token0.toLowerCase() ? context.decimals0 : context.decimals1;
  const amountText = $("poolQuoteAmount").value.trim();
  const slippageBps = Number($("swapSlippage").value);
  const quoteAccount = walletAddress.toLowerCase();
  let amountIn;
  try {
    amountIn = decimalToTokenUnits(amountText, inputDecimals);
  } catch (e) {
    return setPoolQuoteResult(e.message, true);
  }
  if (![50, 100, 200, 500].includes(slippageBps)) return setPoolQuoteResult("Batas slippage tidak valid.", true);
  button.disabled = true;
  setPoolQuoteResult("Meminta quote exact-input ke QuoterV2 Base Mainnet…");
  try {
    walletChainId = String(await walletProvider.request({ method: "eth_chainId" }));
    if (walletChainId.toLowerCase() !== BASE_MAINNET_CHAIN_ID) throw new Error("Wallet harus berada di Base Mainnet.");
    const quoteData = "0xc6a5026a" + addressAbiWord(tokenIn) + addressAbiWord(tokenOut) +
      amountIn.toString(16).padStart(64, "0") + fee.toString(16).padStart(64, "0") + "0".repeat(64);
    const balanceData = "0x70a08231" + addressAbiWord(quoteAccount);
    const allowanceData = "0xdd62ed3e" + addressAbiWord(quoteAccount) + addressAbiWord(BASE_MAINNET_UNISWAP_V3_ROUTER);
    const [quoteResult, balanceResult, allowanceResult] = await Promise.all([
      baseMainnetCall(BASE_MAINNET_UNISWAP_V3_QUOTER, quoteData),
      baseMainnetCall(tokenIn, balanceData),
      baseMainnetCall(tokenIn, allowanceData),
    ]);
    const amountOut = BigInt("0x" + abiWord(quoteResult, 0));
    if (amountOut <= 0n) throw new Error("Quote menghasilkan output nol; swap dibatalkan.");
    const gasEstimate = BigInt("0x" + abiWord(quoteResult, 3));
    const minAmountOut = amountOut * BigInt(10000 - slippageBps) / 10000n;
    const tokenBalance = BigInt("0x" + abiWord(balanceResult, 0));
    const allowance = BigInt("0x" + abiWord(allowanceResult, 0));
    walletChainId = String(await walletProvider.request({ method: "eth_chainId" }));
    if (walletChainId.toLowerCase() !== BASE_MAINNET_CHAIN_ID || walletAddress.toLowerCase() !== quoteAccount) {
      throw new Error("Jaringan atau akun berubah saat quote. Ulangi dari awal.");
    }
    await currentBaseMainnetAccount(quoteAccount);
    if (baseMainnetPoolContext !== context || $("poolQuoteAmount").value.trim() !== amountText ||
        $("poolQuoteDirection").value !== direction || Number($("swapSlippage").value) !== slippageBps) {
      throw new Error("Pool atau input berubah saat quote. Jalankan quote kembali.");
    }
    const amountOutText = tokenUnitsToDecimal(amountOut, outputDecimals);
    const minOutText = tokenUnitsToDecimal(minAmountOut, outputDecimals);
    const amountInNumber = Number(amountIn) / 10 ** inputDecimals;
    const amountOutNumber = Number(amountOut) / 10 ** outputDecimals;
    const inputIsToken0 = tokenIn === context.token0.toLowerCase();
    const spotRate = inputIsToken0 ? context.spotPrice : 1 / context.spotPrice;
    const expectedAtSpot = amountInNumber * spotRate;
    const impact = expectedAtSpot > 0 && Number.isFinite(expectedAtSpot) && Number.isFinite(amountOutNumber) ? (1 - amountOutNumber / expectedAtSpot) * 100 : NaN;
    const impactText = Number.isFinite(impact) ? impact.toFixed(4) + "% versus spot" : "tidak tersedia";
    baseMainnetSwapQuote = { context, tokenIn, tokenOut, fee, amountIn, amountOut, minAmountOut, inputDecimals,
      outputDecimals, amountText, slippageBps, account: quoteAccount, tokenBalance, allowance, createdAt: Date.now() };
    const enoughBalance = tokenBalance >= amountIn;
    const enoughAllowance = allowance >= amountIn;
    updateMainnetSwapButtons();
    setSwapApprovalStatus(!enoughBalance ? "Saldo token input tidak cukup untuk jumlah ini." : !$("mainnetRiskAcknowledged").checked ?
      "Baca peringatan dan centang pengakuan risiko mainnet sebelum approval atau swap." : enoughAllowance ?
      "Allowance cukup. Quote berlaku 2 menit; periksa detail lalu lanjutkan." :
      "Saldo cukup. Approve akan memberi izin tepat sebesar jumlah input ke router tetap.");
    const tokenInInfo = tokenByAddress(tokenIn);
    const tokenOutInfo = tokenByAddress(tokenOut);
    setPoolQuoteResult(
      "Input: " + amountText + " " + (tokenInInfo ? tokenInInfo.symbol : "token") + " · output quote ≈ " + amountOutText + " " + (tokenOutInfo ? tokenOutInfo.symbol : "token") +
      "\nMinimum output (slippage " + (slippageBps / 100).toFixed(2) + "%): " + minOutText + " " + (tokenOutInfo ? tokenOutInfo.symbol : "token") +
      "\nPrice impact indikatif: " + impactText + "\nGas estimate QuoterV2: " + gasEstimate.toLocaleString("en-US") + " units (bukan biaya final)" +
      "\nRouter: Uniswap SwapRouter02 · quote berlaku 2 menit · transaksi hanya di Base Mainnet.",
    );
  } catch (e) {
    clearBaseMainnetSwapQuote("Quote gagal. Buat quote baru sebelum transaksi.");
    setPoolQuoteResult(e && e.message ? e.message : "QuoterV2 gagal menghitung quote untuk pool/jumlah ini.", true);
  } finally {
    button.disabled = !baseMainnetPoolContext;
    renderBrowserWallet();
  }
}
async function currentBaseMainnetAccount(expectedAccount) {
  const chainId = String(await walletProvider.request({ method: "eth_chainId" }));
  const accounts = await walletProvider.request({ method: "eth_accounts" });
  if (chainId.toLowerCase() !== BASE_MAINNET_CHAIN_ID) throw new Error("Transaksi hanya diizinkan di Base Mainnet (8453).");
  const current = Array.isArray(accounts) ? (accounts[0] || "") : "";
  if (!current || current.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error("Akun wallet berubah atau tidak lagi terhubung. Buat quote baru.");
  return current;
}
function requireFreshSwapQuote() {
  const q = baseMainnetSwapQuote;
  if (!q || !baseMainnetPoolContext || q.context !== baseMainnetPoolContext) throw new Error("Buat quote swap baru terlebih dahulu.");
  if (Date.now() - q.createdAt > 120000) {
    clearBaseMainnetSwapQuote("Quote kedaluwarsa setelah 2 menit. Buat quote baru.");
    throw new Error("Quote kedaluwarsa. Buat quote baru.");
  }
  if (q.account !== walletAddress.toLowerCase() || q.amountText !== $("poolQuoteAmount").value.trim() ||
      q.tokenIn !== ($("poolQuoteDirection").value === "aToB" ? $("poolTokenA").value.trim().toLowerCase() : $("poolTokenB").value.trim().toLowerCase()) ||
      q.slippageBps !== Number($("swapSlippage").value)) throw new Error("Akun, jumlah, arah, atau slippage berubah. Buat quote baru.");
  return q;
}
async function sendBaseMainnetTransaction(to, data, description, expectedAccount) {
  if (!$("mainnetRiskAcknowledged").checked) throw new Error("Centang pengakuan risiko Base Mainnet sebelum mengirim transaksi dengan aset nyata.");
  const from = await currentBaseMainnetAccount(expectedAccount);
  const tx = { from, to, data, value: "0x0" };
  const gasEstimate = BigInt(await walletProvider.request({ method: "eth_estimateGas", params: [tx] }));
  const gasLimit = gasEstimate * 120n / 100n;
  const gasPrice = BigInt(await walletProvider.request({ method: "eth_gasPrice" }));
  const gasBalance = BigInt(await walletProvider.request({ method: "eth_getBalance", params: [from, "latest"] }));
  const maxGasCost = gasLimit * gasPrice;
  if (gasBalance < maxGasCost) throw new Error("Saldo ETH Base Mainnet tidak cukup untuk estimasi gas maksimum " + weiToEth("0x" + maxGasCost.toString(16)) + " ETH.");
  const summary = "ASET NYATA · BASE MAINNET (8453) · TRANSAKSI TIDAK DAPAT DIBATALKAN\n\n" + description + "\n\nJaringan: Base Mainnet (8453)\nDari: " + from + "\nKe: " + to +
    "\nGas limit: " + gasLimit.toString() + " · gas price: " + gasPrice.toString() + " wei" +
    "\nMaksimum biaya gas indikatif: " + weiToEth("0x" + maxGasCost.toString(16)) + " ETH\n\nLanjutkan ke konfirmasi wallet?";
  if (!window.confirm(summary)) throw new Error("Transaksi dibatalkan sebelum dibuka di wallet.");
  await currentBaseMainnetAccount(expectedAccount);
  if (baseMainnetSwapQuote && baseMainnetSwapQuote.account === expectedAccount.toLowerCase()) requireFreshSwapQuote();
  const hash = await walletProvider.request({ method: "eth_sendTransaction", params: [{ ...tx,
    gas: "0x" + gasLimit.toString(16), gasPrice: "0x" + gasPrice.toString(16), chainId: BASE_MAINNET_CHAIN_ID }] });
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(hash))) throw new Error("Wallet tidak mengembalikan transaction hash yang valid.");
  setSwapTxResult("Transaksi dikirim · menunggu konfirmasi jaringan…", false, hash);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await walletProvider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (receipt.status && BigInt(receipt.status) === 0n) {
        setSwapTxResult("Transaksi gagal (reverted) di Base Mainnet. Periksa receipt.", true, hash);
        throw new Error("Transaksi masuk chain tetapi gagal (reverted). Lihat receipt di BaseScan.");
      }
      setSwapTxResult("Transaksi terkonfirmasi di Base Mainnet.", false, hash);
      return { hash, receipt };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { hash, receipt: null };
}
async function readSwapAllowance(q) {
  const result = await baseMainnetCall(q.tokenIn, "0xdd62ed3e" + addressAbiWord(q.account) + addressAbiWord(BASE_MAINNET_UNISWAP_V3_ROUTER));
  return BigInt("0x" + abiWord(result, 0));
}
async function approveBaseMainnetSwap() {
  const button = $("swapApproveBtn");
  button.disabled = true;
  try {
    const q = requireFreshSwapQuote();
    await currentBaseMainnetAccount(q.account);
    const balanceResult = await baseMainnetCall(q.tokenIn, "0x70a08231" + addressAbiWord(q.account));
    if (BigInt("0x" + abiWord(balanceResult, 0)) < q.amountIn) throw new Error("Saldo token input tidak lagi cukup.");
    let allowance = await readSwapAllowance(q);
    if (allowance >= q.amountIn) {
      q.allowance = allowance;
      setSwapApprovalStatus("Allowance sudah cukup; periksa detail quote lalu swap.");
      updateMainnetSwapButtons();
      return;
    }
    if (allowance > 0n) {
      setSwapApprovalStatus("Allowance lama perlu di-reset ke nol terlebih dahulu.");
      const reset = await sendBaseMainnetTransaction(q.tokenIn, "0x095ea7b3" + addressAbiWord(BASE_MAINNET_UNISWAP_V3_ROUTER) + "0".repeat(64),
        "RESET APPROVAL · izin token lama akan diubah menjadi 0.", q.account);
      if (!reset.receipt) throw new Error("Reset approval masih pending. Tunggu konfirmasi lalu buat quote baru.");
      allowance = await readSwapAllowance(q);
      if (allowance !== 0n) throw new Error("Allowance belum menjadi nol setelah reset.");
    }
    const approvalData = "0x095ea7b3" + addressAbiWord(BASE_MAINNET_UNISWAP_V3_ROUTER) + q.amountIn.toString(16).padStart(64, "0");
    const approved = await sendBaseMainnetTransaction(q.tokenIn, approvalData,
      "APPROVAL TOKEN · jumlah tepat " + q.amountText + " dari token " + q.tokenIn + " · router Uniswap SwapRouter02 " + BASE_MAINNET_UNISWAP_V3_ROUTER, q.account);
    if (!approved.receipt) {
      setSwapApprovalStatus("Approval dikirim tetapi masih pending. Tunggu receipt; jangan kirim swap dulu.", true);
      return;
    }
    const updatedAllowance = await readSwapAllowance(q);
    const updatedBalance = BigInt("0x" + abiWord(await baseMainnetCall(q.tokenIn, "0x70a08231" + addressAbiWord(q.account)), 0));
    if (updatedAllowance < q.amountIn || updatedBalance < q.amountIn) throw new Error("Approval atau saldo tidak mencukupi setelah konfirmasi. Buat quote baru.");
    q.allowance = updatedAllowance;
    updateMainnetSwapButtons();
    setSwapApprovalStatus("Approval terkonfirmasi untuk jumlah tepat. Periksa kembali quote, lalu klik Swap.");
  } catch (e) {
    setSwapApprovalStatus(e && e.message ? e.message : "Approval gagal.", true);
    if (e && e.code === 4001) setSwapTxResult("Permintaan transaksi ditolak di wallet.", true);
  } finally {
    updateMainnetSwapButtons();
  }
}
async function executeBaseMainnetSwap() {
  const button = $("swapExecuteBtn");
  button.disabled = true;
  try {
    const q = requireFreshSwapQuote();
    if (!$("mainnetRiskAcknowledged").checked) throw new Error("Centang pengakuan risiko Base Mainnet sebelum swap.");
    await currentBaseMainnetAccount(q.account);
    const [balanceResult, allowance] = await Promise.all([
      baseMainnetCall(q.tokenIn, "0x70a08231" + addressAbiWord(q.account)), readSwapAllowance(q),
    ]);
    const balance = BigInt("0x" + abiWord(balanceResult, 0));
    if (balance < q.amountIn) throw new Error("Saldo token input tidak lagi cukup; buat quote baru.");
    if (allowance < q.amountIn) {
      $("swapApproveBtn").disabled = false;
      throw new Error("Allowance belum cukup. Jalankan approval jumlah tepat terlebih dahulu.");
    }
    const calldata = "0x04e45aaf" + addressAbiWord(q.tokenIn) + addressAbiWord(q.tokenOut) +
      q.fee.toString(16).padStart(64, "0") + addressAbiWord(q.account) + q.amountIn.toString(16).padStart(64, "0") +
      q.minAmountOut.toString(16).padStart(64, "0") + "0".repeat(64);
    const result = await sendBaseMainnetTransaction(BASE_MAINNET_UNISWAP_V3_ROUTER, calldata,
      "SWAP ERC-20 EXACT-INPUT · token input " + q.tokenIn + " · jumlah " + q.amountText +
      " · token output " + q.tokenOut + " · output quote " + tokenUnitsToDecimal(q.amountOut, q.outputDecimals) +
      " · minimum output " + tokenUnitsToDecimal(q.minAmountOut, q.outputDecimals) +
      " · slippage maksimum " + (q.slippageBps / 100).toFixed(2) + "% · pool " + q.context.poolAddress +
      " · fee tier " + q.fee + " · router tetap Uniswap SwapRouter02.", q.account);
    baseMainnetSwapQuote = null;
    $("swapApproveBtn").disabled = true;
    $("swapExecuteBtn").disabled = true;
    setSwapTxResult(result.receipt ? "Swap terkonfirmasi di Base Mainnet." : "Swap sudah dikirim tetapi receipt belum terlihat. Periksa BaseScan sebelum mencoba lagi.", !result.receipt, result.hash);
    setSwapApprovalStatus("Quote dibatalkan setelah transaksi dikirim. Buat quote baru untuk swap berikutnya.");
    await refreshBrowserWallet();
  } catch (e) {
    setSwapApprovalStatus(e && e.message ? e.message : "Swap gagal.", true);
    if (e && e.code === 4001) setSwapTxResult("Permintaan swap ditolak di wallet.", true);
  } finally {
    updateMainnetSwapButtons();
  }
}
function setPoolQuoteResult(message, isError) {
  const el = $("poolQuoteResult");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}
function setSwapApprovalStatus(message, isError) {
  const el = $("swapApprovalStatus");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}
function setSwapTxResult(message, isError, hash) {
  const el = $("swapTxResult");
  const link = $("swapTxLink");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
  if (hash && /^0x[a-fA-F0-9]{64}$/.test(hash)) {
    link.href = "https://basescan.org/tx/" + hash;
    link.hidden = false;
  } else {
    link.removeAttribute("href");
    link.hidden = true;
  }
}
function updateMainnetSwapButtons() {
  const quote = baseMainnetSwapQuote;
  const acknowledged = $("mainnetRiskAcknowledged").checked;
  const fresh = quote && Date.now() - quote.createdAt <= 120000 && quote.account === walletAddress.toLowerCase() && walletChainId.toLowerCase() === BASE_MAINNET_CHAIN_ID;
  const enoughBalance = fresh && quote.tokenBalance >= quote.amountIn;
  const enoughAllowance = fresh && quote.allowance >= quote.amountIn;
  $("swapApproveBtn").disabled = !acknowledged || !enoughBalance || enoughAllowance;
  $("swapExecuteBtn").disabled = !acknowledged || !enoughBalance || !enoughAllowance;
}
function clearBaseMainnetSwapQuote(message) {
  baseMainnetSwapQuote = null;
  $("swapApproveBtn").disabled = true;
  $("swapExecuteBtn").disabled = true;
  setSwapApprovalStatus(message || "Quote invalid. Buat quote baru untuk melanjutkan.");
}
function initBrowserWallet() {
  walletProvider = window.ethereum || null;
  if (walletProvider) {
    bindWalletEvents(walletProvider);
    setWalletStatus("Wallet ditemukan. Klik Hubungkan untuk memberi izin akses akun.");
  } else {
    setWalletStatus("Wallet EIP-1193 tidak terdeteksi. Gunakan browser dengan wallet extension.", true);
  }
  renderBrowserWallet();
  $("walletConnectBtn").addEventListener("click", connectBrowserWallet);
  $("walletSwitchBtn").addEventListener("click", switchToBaseMainnet);
  populateBaseMainnetTokenSelectors();
  $("chooseTokenABtn").addEventListener("click", () => openTokenPicker("A"));
  $("chooseTokenBBtn").addEventListener("click", () => openTokenPicker("B"));
  $("tokenPickerSearch").addEventListener("input", renderTokenPicker);
  $("tokenPickerModal").addEventListener("click", (event) => {
    if (event.target === $("tokenPickerModal")) $("tokenPickerModal").hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("tokenPickerModal").hidden) $("tokenPickerModal").hidden = true;
  });
  $("poolCheckBtn").addEventListener("click", checkBaseMainnetPool);
  $("poolQuoteBtn").addEventListener("click", quoteBaseMainnetSwap);
  $("addCustomTokenBtn").addEventListener("click", importBaseMainnetToken);
  $("swapApproveBtn").addEventListener("click", approveBaseMainnetSwap);
  $("swapExecuteBtn").addEventListener("click", executeBaseMainnetSwap);
  $("mainnetRiskAcknowledged").addEventListener("change", updateMainnetSwapButtons);
  const invalidatePoolCheck = () => {
    baseMainnetPoolContext = null;
    $("poolQuoteBtn").disabled = true;
    clearBaseMainnetSwapQuote("Pasangan atau fee tier berubah. Periksa pool dan quote kembali.");
    setPoolCheckResult("Pasangan token atau fee tier berubah. Periksa ulang pool.");
    setPoolQuoteResult("Pasangan atau fee tier berubah. Periksa ulang pool.");
  };
  const invalidateSwapQuote = () => clearBaseMainnetSwapQuote("Input berubah. Buat quote baru sebelum transaksi.");
  $("poolTokenA").addEventListener("change", () => { invalidatePoolCheck(); renderPoolTokenDetails(); });
  $("poolTokenB").addEventListener("change", () => { invalidatePoolCheck(); renderPoolTokenDetails(); });
  $("poolFeeTier").addEventListener("change", invalidatePoolCheck);
  $("poolQuoteAmount").addEventListener("input", invalidateSwapQuote);
  $("poolQuoteDirection").addEventListener("change", invalidateSwapQuote);
  $("swapSlippage").addEventListener("change", invalidateSwapQuote);
  loadBaseMainnetTokenList();
}

function renderTransactions() {
  if (!deskState) return;
  const list = $("txList");
  const txs = deskState.transactions || [];
  if (!txs.length) {
    list.innerHTML = '<p class="muted">Belum ada transaksi simulasi.</p>';
    return;
  }
  list.innerHTML = txs
    .slice(0, 30)
    .map(
      (t) =>
        '<div class="tx-row"><span><strong>' +
        esc(t.side.toUpperCase()) +
        "</strong> " +
        esc(t.symbol) +
        ' <span class="chain-badge">' +
        esc(t.chain) +
        "</span></span>" +
        "<span>" +
        fmtMoney(t.amount) +
        " @ " +
        fmtPrice(t.price) +
        '</span><span class="muted">' +
        new Date(t.at).toLocaleString("id-ID") +
        "</span></div>",
    )
    .join("");
}

async function doTrade(side) {
  const chain = $("tradeChain").value;
  const address = $("tradeAddress").value.trim();
  const symbol = $("tradeSymbol").value.trim() || "TOKEN";
  const amount = Number($("tradeAmount").value) || 0;
  const price = Number($("tradePrice").value) || 0;
  if (!address) {
    setMsg("tradeMsg", "Isi alamat token dulu.", true);
    return;
  }
  if (!(amount > 0) || !(price > 0)) {
    setMsg("tradeMsg", "Nominal dan harga harus lebih dari 0.", true);
    return;
  }
  try {
    await postJson("/api/trade", { chain, side, address, symbol, amount, price });
    setMsg("tradeMsg", (side === "buy" ? "Buy" : "Sell") + " simulasi " + symbol + " sebesar " + fmtMoney(amount) + " berhasil di " + chain + ".");
    await loadState();
  } catch (e) {
    setMsg("tradeMsg", e.friendly || e.message, true);
  }
}

/* Kategori Range book: open apa adanya; posisi closed yang digantikan
   rebalance (replacedBy terisi / closeReason 'rebalance') masuk Leftover —
   sisa rantai rebalance; closed lain masuk Closed. */
function posCategory(p) {
  if (p.status === "open") return "open";
  if (p.replacedBy || p.closeReason === "rebalance") return "leftover";
  return "closed";
}
function renderChainBar() {
  const bar = $("chainBar");
  if (!bar || !deskState) return;
  const opens = (deskState.positions || []).filter((p) => p.status === "open");
  const countFor = (c) => (c === "ALL" ? opens.length : opens.filter((p) => p.chain === c).length);
  const cell = (key, label, avatarHtml) =>
    '<button type="button" class="chain-cell' +
    (chainFilter === key ? " active" : "") +
    '" data-chainfilter="' +
    key +
    '">' +
    avatarHtml +
    '<span class="chain-meta"><span class="chain-name">' +
    label +
    "</span>" +
    '<span class="chain-open">' +
    countFor(key) +
    " open</span></span></button>";
  bar.innerHTML =
    cell("ALL", "All networks", '<span class="chain-avatar all">' + CHAINS.length + "</span>") +
    CHAINS.map((c) => cell(c, c, '<span class="chain-avatar" style="background:' + (CHAIN_COLORS[c] || "#888") + '">' + c.charAt(0) + "</span>")).join("");
  bar.querySelectorAll("[data-chainfilter]").forEach((b) =>
    b.addEventListener("click", () => {
      chainFilter = b.dataset.chainfilter;
      renderChainBar();
      renderPositions();
    }),
  );
}
function renderTpSlStrip() {
  const stateEl = $("stripTpSlState");
  if (!stateEl) return;
  const armed = !!(settings && settings.tpSl && settings.tpSl.armed);
  stateEl.textContent = armed ? "ARMED" : "PAUSED";
  const tog = $("stripTpSlToggle");
  if (tog) tog.checked = armed;
}

function renderPositionTable(positions) {
  const rows = positions.map((p) => {
    const live = p.status === "open";
    const pnl = live ? round2Client((Number(p.value) || 0) + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - (Number(p.amount) || 0)) : Number(p.closePnl) || 0;
    const actions = live
      ? '<button type="button" class="text-btn" data-act="claim" data-id="' + esc(p.id) + '">Claim</button> <button type="button" class="text-btn" data-act="close" data-id="' + esc(p.id) + '">Close</button>'
      : "—";
    return "<tr><td><strong>" + esc(p.symbol || "—") + "</strong><br>" + esc(p.pair || "—") + "</td><td>" + esc(p.chain || "—") + "</td><td>" + (live ? (p.inRange ? "In range" : "Out of range") : esc(posCategory(p))) + "</td><td>" + fmtMoney(p.amount) + "</td><td>" + fmtMoney(p.value) + "</td><td class=\"" + (pnl >= 0 ? "pos" : "neg") + "\">" + (pnl > 0 ? "+" : "") + fmtMoney(pnl) + "</td><td>" + fmtMoney((Number(p.fees) || 0) + (Number(p.rewards) || 0)) + "</td><td>" + actions + "</td></tr>";
  }).join("");
  return '<div class="table-wrap"><table class="pos-table"><thead><tr><th>Token / Pair</th><th>Chain</th><th>Status</th><th>Deposit</th><th>Value</th><th>PnL</th><th>Fees</th><th>Aksi</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
}
function attachPositionActions(list) {
  list.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => handlePositionAction(btn.dataset.act, btn.dataset.id, btn));
  });
}
function renderPositions() {
  if (!deskState) return;
  const list = $("positionsList");
  const positions = deskState.positions || [];
  const counts = { open: 0, closed: 0, leftover: 0 };
  for (const p of positions) counts[posCategory(p)]++;
  $("posCountOpen").textContent = counts.open;
  $("posCountClosed").textContent = counts.closed;
  $("posCountLeftover").textContent = counts.leftover;
  $("posCountView").textContent = "0";
  document.querySelectorAll("#posFilterSeg [data-pfilter]").forEach((b) => b.classList.toggle("active", b.dataset.pfilter === posStatusFilter));
  document.querySelectorAll("#deskModeSeg [data-dmode]").forEach((b) => b.classList.toggle("active", b.dataset.dmode === deskMode));
  document.querySelectorAll("#posLayoutSeg [data-layout]").forEach((b) => b.classList.toggle("active", b.dataset.layout === posLayout));
  const calendarMode = deskMode === "calendar";
  list.hidden = calendarMode;
  $("positionsCount").hidden = calendarMode;
  $("deskCalendar").hidden = !calendarMode;
  $("holdingPanel").hidden = calendarMode;
  if (calendarMode) {
    renderDeskCalendar();
    return;
  }
  let shown = posStatusFilter === "view" ? [] : positions.filter((p) => posCategory(p) === posStatusFilter && (chainFilter === "ALL" || p.chain === chainFilter));
  const query = posSearchQuery.trim().toLocaleLowerCase("id-ID");
  if (query) shown = shown.filter((p) => [p.symbol, p.pair, p.chain, p.address, p.poolAddress].some((v) => String(v || "").toLocaleLowerCase("id-ID").includes(query)));
  shown.sort((a, b) => {
    const ta = Date.parse(a.createdAt || a.closedAt || "") || 0;
    const tb = Date.parse(b.createdAt || b.closedAt || "") || 0;
    return posSortOrder === "oldest" ? ta - tb : tb - ta;
  });
  $("positionsCount").textContent = posStatusFilter === "view"
    ? "View Yanman · read-only · data profil belum terhubung"
    : "Menampilkan " + shown.length + " dari " + positions.length + " posisi · filter chain: " + (chainFilter === "ALL" ? "All networks" : chainFilter);
  if (posStatusFilter === "view") {
    list.innerHTML = '<p class="muted">View Yanman bersifat read-only. Data posisi profil belum tersedia pada versi simulasi lokal ini.</p>';
    renderHolding();
    return;
  }
  if (!positions.length) {
    list.innerHTML = '<p class="muted">Belum ada posisi. Buka posisi pertama lewat Open LP atau Copy LP.</p>';
    renderHolding();
    return;
  }
  if (!shown.length) {
    list.innerHTML = '<p class="muted">Tidak ada posisi yang cocok dengan filter ini.</p>';
    renderHolding();
    return;
  }
  if (posLayout === "table") {
    list.innerHTML = renderPositionTable(shown);
    attachPositionActions(list);
    renderHolding();
    return;
  }
  list.innerHTML = shown
    .map((p) => {
      const live = p.status === "open";
      const fees = (Number(p.fees) || 0) + (Number(p.rewards) || 0);
      const upnl =
        live ? round2Client(p.value + fees - p.amount)
        : p.closePnl != null ? p.closePnl
        : 0;
      const pnlPct = Number(p.amount) > 0 ? round2Client((upnl / Number(p.amount)) * 100) : 0;
      const movePct = p.entryPrice > 0 ? round2Client((p.currentPrice / p.entryPrice - 1) * 100) : 0;
      const isDlmm = p.product === "DLMM" && p.lowerBin != null && p.upperBin != null;
      const productLabel = p.product === "DLMM" ? "METEORA DLMM" : "SIM RANGE";
      const pill =
        live ?
          '<span class="status-pill ' + (p.inRange ? "in" : "out") + '">' + (p.inRange ? "IN RANGE" : "OUT OF RANGE") + "</span>"
        : '<span class="status-pill ' + posCategory(p) + '">' + (posCategory(p) === "leftover" ? "LEFTOVER" : "CLOSED") + "</span>";
      // Bar range: DLMM memakai posisi active bin relatif terhadap fixed bins;
      // generik memakai posisi harga live di antara min–max price.
      let rangeBlock = "";
      if (isDlmm) {
        const span = Math.max(1, p.upperBin - p.lowerBin);
        const rel = Math.max(0, Math.min(100, (((p.activeBin != null ? p.activeBin : p.lowerBin) - p.lowerBin) / span) * 100));
        rangeBlock =
          '<div class="range-block"><div class="range-labels"><span>FIXED ' +
          p.lowerBin +
          '</span><span class="mid">ACTIVE ' +
          (p.activeBin != null ? p.activeBin : "—") +
          "</span><span>FIXED " +
          p.upperBin +
          "</span></div>" +
          '<div class="range-bar"><span class="range-marker" style="left:' +
          rel +
          '%"></span></div></div>';
      } else {
        const spanP = (Number(p.maxPrice) || 0) - (Number(p.minPrice) || 0);
        const relP = spanP > 0 ? Math.max(0, Math.min(100, (((Number(p.currentPrice) || 0) - (Number(p.minPrice) || 0)) / spanP) * 100)) : 0;
        rangeBlock =
          '<div class="range-block"><div class="range-labels"><span>MIN ' +
          (p.minPct != null ? p.minPct + "%" : fmtPrice(p.minPrice)) +
          '</span><span class="mid">HARGA LIVE</span><span>MAX ' +
          (p.maxPct != null ? "+" + p.maxPct + "%" : fmtPrice(p.maxPrice)) +
          "</span></div>" +
          '<div class="range-bar"><span class="range-marker" style="left:' +
          relP +
          '%"></span></div></div>';
      }
      const slTpTxt = "SL " + (p.slPct != null ? (p.slPct > 0 ? "+" : "") + p.slPct + "%" : "—") + " · TP " + (p.tpPct != null ? "+" + p.tpPct + "%" : "—");
      const metaBits = [
        "Nominal " + fmtMoney(p.amount),
        p.pair ? "Pair " + esc(p.pair) : "",
        "Side " + esc(p.side || "—") + " · Quote " + esc(p.quote || "USDC"),
        p.createdAt ? "Dibuka " + new Date(p.createdAt).toLocaleString("id-ID") : "",
        p.poolAddress ? "Pool " + esc(String(p.poolAddress).slice(0, 10)) + "…" : "",
        p.replaces ? "Menggantikan posisi sebelumnya (rebalance)" : "",
        p.replacedBy ? "Digantikan oleh posisi rebalance" : "",
        !live && p.closePnl != null ? "PnL tutup " + fmtMoney(p.closePnl) : "",
        !live && p.closedAt ? "Ditutup " + new Date(p.closedAt).toLocaleString("id-ID") : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        '<article class="position-card" data-pos="' +
        p.id +
        '">' +
        '<div class="pos-head">' +
        '<span class="pos-avatar">' +
        esc((p.symbol || "?").charAt(0)) +
        "</span>" +
        '<div class="pos-title"><h4>' +
        esc(p.symbol) +
        " / " +
        esc(p.quote || "USDC") +
        (p.source && p.source !== "Open LP" ? '<span class="src-label">' + esc(p.source) + "</span>" : "") +
        "</h4>" +
        '<div class="pos-sub">CHAIN ' +
        esc(p.chain) +
        " · " +
        productLabel +
        " · " +
        esc(p.strategy || "Spot") +
        (p.product === "DLMM" ? " · " + p.binStepBps + " BPS" : "") +
        "</div></div>" +
        pill +
        "</div>" +
        '<div class="live-strip"><span class="live-dot"></span><span class="lp-label">HARGA LIVE</span>' +
        '<span class="lp-price">' +
        fmtPrice(p.currentPrice) +
        "</span>" +
        '<span class="lp-entry">Entry ' +
        fmtPrice(p.entryPrice) +
        ' <span class="' +
        (movePct >= 0 ? "pos" : "neg") +
        '">' +
        (movePct >= 0 ? "▲ +" : "▼ ") +
        movePct +
        "%</span></span>" +
        '<span class="lp-src">DEX Screener · realtime</span></div>' +
        '<div class="pos-stats">' +
        "<div><span>LP POSITION VALUE</span><strong>" +
        fmtMoney(p.value) +
        "</strong></div>" +
        '<div><span>PNL POSISI</span><strong class="' +
        (upnl >= 0 ? "pos" : "neg") +
        '">' +
        (upnl >= 0 ? "+" : "−") +
        fmtMoney(Math.abs(upnl)) +
        '</strong><small class="pnl-percent ' +
        (pnlPct >= 0 ? "pos" : "neg") +
        '">' +
        (pnlPct >= 0 ? "+" : "") +
        pnlPct.toFixed(2) +
        "% dari deposit</small></div>" +
        "<div><span>HOLD BENCHMARK</span><strong>" +
        fmtMoney(p.holdValue) +
        "</strong></div>" +
        '<div><span>NET PNL VS HOLDING</span><strong class="' +
        (p.netVsHolding >= 0 ? "pos" : "neg") +
        '">' +
        fmtMoney(p.netVsHolding) +
        "</strong></div>" +
        '<div><span>IL / DIVERGENCE</span><strong class="' +
        (p.il < 0 ? "neg" : "") +
        '">' +
        fmtMoney(p.il) +
        " (" +
        p.ilPct +
        "%)</strong></div>" +
        "</div>" +
        rangeBlock +
        '<div class="fee-row">' +
        "<div><span>UNCLAIMED FEES</span><strong>" +
        fmtMoney(p.fees) +
        "</strong></div>" +
        "<div><span>CLAIMED FEES</span><strong>" +
        fmtMoney(p.claimed) +
        "</strong></div>" +
        "<div><span>LM REWARDS</span><strong>" +
        fmtMoney(p.rewards) +
        "</strong></div>" +
        "</div>" +
        (isDlmm ? '<p class="dlmm-note">Bin ' + p.lowerBin + "–" + p.upperBin + " tetap untuk umur posisi ini. Rebalance menutup posisi lama dan membuat posisi pengganti; fee tidak auto-compound.</p>" : "") +
        '<p class="pos-meta">' +
        metaBits +
        (live ? "" : ' · uPnL/PnL: <span class="' + (upnl >= 0 ? "pos" : "neg") + '">' + fmtMoney(upnl) + "</span>") +
        "</p>" +
        '<div class="pos-foot"><span class="pos-sltp">' +
        slTpTxt +
        "</span>" +
        '<div class="pos-actions">' +
        (live ?
          '<button type="button" class="text-btn" data-act="claim" data-id="' +
          p.id +
          '">Claim</button>' +
          '<button type="button" class="text-btn" data-act="rebalance" data-id="' +
          p.id +
          '">Rebalance</button>' +
          '<button type="button" class="text-btn" data-act="close" data-id="' +
          p.id +
          '">Close</button>'
        : "") +
        '<button type="button" class="text-btn danger" data-act="askdelete" data-id="' +
        p.id +
        '">Hapus</button>' +
        '</div></div><div class="delete-slot"></div>' +
        "</article>"
      );
    })
    .join("");
  attachPositionActions(list);
  renderHolding();
}
function round2Client(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function handlePositionAction(act, id, btn) {
  const card = btn.closest(".position-card");
  if (act === "askdelete") {
    const slot = card.querySelector(".delete-slot");
    slot.innerHTML =
      '<div class="delete-confirm">Hapus posisi ini <strong>permanen</strong>? Baris ledger PnL dan log aktivitas terkait ikut dihapus agar Monthly Profit konsisten.' +
      '<div class="actions"><button type="button" class="danger" data-del="yes">Ya, hapus permanen</button><button type="button" class="secondary" data-del="no">Batal</button></div></div>';
    slot.querySelector('[data-del="yes"]').addEventListener("click", async () => {
      try {
        const r = await postJson("/api/lp/delete", { id });
        showToast("Posisi " + (r.pair || "") + " dihapus (" + r.removedLedgerRows + " baris ledger dibersihkan).");
        await loadState();
      } catch (e) {
        showToast(e.friendly || e.message, true);
      }
    });
    slot.querySelector('[data-del="no"]').addEventListener("click", () => {
      slot.innerHTML = "";
    });
    return;
  }
  try {
    if (act === "claim") {
      const r = await postJson("/api/lp/claim", { id });
      showToast("Fee ter-claim: " + fmtMoney(r.claimed));
    } else if (act === "close") {
      await postJson("/api/lp/close", { id });
      showToast("Posisi ditutup.");
    } else if (act === "rebalance") {
      const p = (deskState.positions || []).find((x) => x.id === id);
      if (!p) return;
      const span = Math.max((Number(p.maxPrice) || 0) - (Number(p.minPrice) || 0), Number(p.currentPrice) * 0.05);
      const r = await postJson("/api/lp/rebalance", { id, minPrice: Math.max(0, p.currentPrice - span / 2), maxPrice: p.currentPrice + span / 2 });
      showToast("Rebalance selesai — pengganti didanai dari nilai settled " + fmtMoney(r.settledValue) + ".");
    }
    await loadState();
  } catch (e) {
    showToast(e.friendly || e.message, true);
  }
}

function renderHolding() {
  if (!deskState) return;
  const opens = (deskState.positions || []).filter((p) => p.status === "open");
  const sum = (fn) => round2Client(opens.reduce((s, p) => s + (Number(fn(p)) || 0), 0));
  const netVsHolding = sum((p) => p.netVsHolding);
  const il = sum((p) => p.il);
  const fees = sum((p) => (Number(p.fees) || 0) + (Number(p.rewards) || 0));
  $("holdingSummary").innerHTML =
    "<div><span>Posisi terbuka</span><strong>" +
    opens.length +
    "</strong></div>" +
    '<div><span>Desk Net PnL vs Holding (open)</span><strong class="' +
    (netVsHolding >= 0 ? "pos" : "neg") +
    '">' +
    fmtMoney(netVsHolding) +
    "</strong></div>" +
    '<div><span>Total impermanent loss</span><strong class="' +
    (il < 0 ? "neg" : "") +
    '">' +
    fmtMoney(il) +
    "</strong></div>" +
    "<div><span>Fee + reward belum diklaim</span><strong>" +
    fmtMoney(fees) +
    "</strong></div>";
  // Strip statistik kolom (a): nilai besar + persen vs total hold benchmark.
  const stripEl = $("stripNetPnl");
  if (stripEl) {
    const holdSum = sum((p) => p.holdValue);
    const pct = holdSum > 0 ? round2Client((netVsHolding / holdSum) * 100) : 0;
    stripEl.textContent = fmtMoney(netVsHolding);
    stripEl.className = "num " + (netVsHolding >= 0 ? "pos" : "neg");
    const pctEl = $("stripNetPnlPct");
    pctEl.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "% vs holding";
    pctEl.className = "strip-pct " + (pct >= 0 ? "pos" : "neg");
  }
  const firstDlmm = opens.find((p) => p.product === "DLMM") || opens[0];
  const bp = $("binsPreview");
  if (firstDlmm && firstDlmm.bins && firstDlmm.bins.length) {
    bp.innerHTML =
      firstDlmm.bins
        .map((b, i) => {
          const h = 18 + Math.round(46 * Math.exp(-Math.pow(i - firstDlmm.activeBinIndex, 2) / 18));
          return '<div class="bin' + (i === firstDlmm.activeBinIndex ? " active" : "") + '" style="height:' + h + 'px" title="Bin ' + b.index + " · " + fmtPrice(b.price) + '"></div>';
        })
        .join("") + "";
    bp.insertAdjacentHTML("beforeend", "");
    bp.title = "Price bins " + firstDlmm.symbol + " (bin oranye = active bin)";
  } else {
    bp.innerHTML = '<p class="muted">Buka posisi DLMM (Solana) untuk melihat price bins.</p>';
  }
}

/* ---------------- Agent Crew ---------------- */

function agentRunning(name) {
  if (!settings) return false;
  if (name === "nara") return !!settings.autoTrading.enabled;
  if (name === "byte") return !!settings.tpSl.armed;
  if (name === "kopi") return !!settings.copyTrading.enabled;
  return true; // sora selalu BERJALAN (analis on-demand)
}
function renderCrew() {
  const statusText = {
    nara: (r) => (r ? "AKTIF · AUTO" : "NONAKTIF"),
    byte: (r) => (r ? "ARMED" : "PAUSED"),
    sora: () => "SIAP ANALISIS",
    kopi: (r) => (r ? "AKTIF" : "NONAKTIF"),
  };
  for (const name of ["nara", "byte", "sora", "kopi"]) {
    const running = agentRunning(name);
    const badge = $("badge-" + name);
    const dot = $("dot-" + name);
    const char = $("char-" + name);
    if (badge) {
      badge.textContent = running ? "BERJALAN" : "BERHENTI";
      badge.className = "crew-badge " + (running ? "running" : "stopped");
    }
    if (dot) dot.className = "status-dot" + (running ? " running" : "");
    if (char && char.parentElement) char.parentElement.classList.toggle("dim", !running);
    const statusEl = $("crewStatus-" + name);
    if (statusEl) statusEl.textContent = statusText[name](running);
    const chip = $("chip-" + name);
    if (chip) chip.classList.toggle("on", running);
  }
  renderTpSlStrip();
}
function renderAgentActivity() {
  const box = $("agentActivity");
  const logs = (deskState && deskState.agentLogs) || [];
  if (!logs.length) {
    box.innerHTML = '<p class="muted">Belum ada aktivitas agent.</p>';
    return;
  }
  box.innerHTML = logs
    .slice(0, 12)
    .map(
      (l) =>
        '<div class="log-row"><span class="who">' +
        esc(l.agent) +
        '</span><span class="msg">' +
        esc(l.message) +
        '</span><span class="when">' +
        new Date(l.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) +
        "</span></div>",
    )
    .join("");
}
function renderAgentLogs(elId, agentName) {
  const el = $(elId);
  if (!el) return;
  const logs = ((deskState && deskState.agentLogs) || []).filter((l) => l.agent === agentName);
  el.innerHTML = logs.length ? logs.map((l) => '<div class="log-row"><span class="when">' + new Date(l.at).toLocaleString("id-ID") + "</span>" + esc(l.message) + "</div>").join("") : '<p class="muted">Belum ada log untuk agen ini.</p>';
}

/* ---------------- Realtime (tetap 5 detik, tanpa animasi) ---------------- */

async function refreshRealtime() {
  try {
    const data = await api("/api/realtime");
    rtData = data;
    processRealtimeNotifications(data);
    const timeStr = new Date(data.lastUpdated).toLocaleTimeString("id-ID");
    $("rtValue").textContent = fmtMoney(data.portfolioValue);
    const pnlPctTotal = round2Client((data.totalPnl / 5000) * 100);
    $("rtPnl").textContent = (data.totalPnl >= 0 ? "+" : "−") + fmtMoney(Math.abs(data.totalPnl)) + " (" + (pnlPctTotal >= 0 ? "+" : "") + pnlPctTotal.toFixed(2) + "%)";
    $("rtPnl").className = data.totalPnl >= 0 ? "pos" : "neg";
    $("stripUpdated").textContent = timeStr;
    $("rtAllocated").textContent = fmtMoney(data.allocatedCapital);
    $("rtFreeCapital").textContent = fmtMoney(data.freeCapital);
    $("rtClaimable").textContent = fmtMoney(data.claimableFees);
    $("rtUpdated").textContent = timeStr;
    // Ticker gaya hosted: "SIMBOL / PAIR $harga ±persen%" (persen vs entry,
    // dari field entryPrice + pnlPct payload /api/realtime).
    $("rtTicker").innerHTML =
      (data.positions || [])
        .map(
          (p) => '<span class="tick">' + esc(p.pair || p.symbol) + " " + fmtPrice(p.livePrice) + ' <span class="' + (p.pnlPct >= 0 ? "pos" : "neg") + '">' + (p.pnlPct >= 0 ? "+" : "") + Number(p.pnlPct || 0).toFixed(2) + "%</span></span>",
        )
        .join("") || '<span class="muted">Tidak ada posisi terbuka.</span>';
    if (data.closedByTpSl && data.closedByTpSl.length) {
      $("rtClosed").textContent = "Auto TP/SL menutup: " + data.closedByTpSl.map((c) => c.symbol + " (" + c.reason + ")").join(", ");
      await loadState();
    }
    rtSecondsLeft = 5;
  } catch (e) {
    setMsg("rtMsg", "Realtime gagal dimuat: " + (e.friendly || e.message), true);
  }
}
function startRealtime() {
  stopRealtime();
  rtSecondsLeft = 5;
  rtTimer = setInterval(() => {
    if (!rtPaused) liveTick(false);
  }, 5000);
  rtCountdownTimer = setInterval(() => {
    const el = $("rtStatus");
    if (!el) return;
    if (rtPaused) {
      el.textContent = "Jeda";
      return;
    }
    if (liveTickBusy) {
      el.textContent = "Mengambil harga…";
      return;
    }
    rtSecondsLeft = Math.max(0, rtSecondsLeft - 1);
    el.textContent = rtSecondsLeft + " dtk";
  }, 1000);
}
function stopRealtime() {
  if (rtTimer) clearInterval(rtTimer);
  if (rtCountdownTimer) clearInterval(rtCountdownTimer);
  rtTimer = null;
  rtCountdownTimer = null;
}

/* ---------------- Realtime SEMUA fitur (tetap 5 detik, tanpa animasi) ----------------
   Satu siklus 5 detik yang sama memperbarui: panel Portfolio Realtime,
   lalu tab yang sedang aktif (Desk: state penuh; Monthly Profit: sidebar +
   kalender + preview Card Studio yang kini menyatu di tab Monthly; Top LP:
   kandidat dari cache server — scan sumber maks. tiap 5 menit agar tidak
   kena batas API publik; Copy LP: posisi pool terpilih + monitor bila
   sudah pernah dijalankan). Refresh tab dilewati sesaat bila akan
   mengganggu: modal terbuka, pengguna sedang mengetik/memilih di form,
   konfirmasi hapus posisi sedang tampil, atau baris detail Discover
   sedang terbuka. */

let liveTickBusy = false;
let copyMonitorStarted = false;
let cardRecording = false;

function liveGuardBlocked() {
  if (document.querySelector(".modal:not([hidden])")) return true;
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA")) return true;
  if (document.querySelector(".delete-confirm")) return true;
  if (document.querySelector(".disc-detail")) return true;
  return false;
}
function activeTabName() {
  const p = document.querySelector(".tab-panel.active");
  return p ? p.id.replace("tab-", "") : "desk";
}
async function liveTick(manual) {
  if (!manual && rtPaused) return;
  if (liveTickBusy) return;
  liveTickBusy = true;
  const nowBtn = $("rtNowBtn");
  if (nowBtn) {
    nowBtn.disabled = true;
    nowBtn.textContent = "Memperbarui…";
  }
  try {
    await refreshRealtime();
    if (!liveGuardBlocked()) {
      const tab = activeTabName();
      if (tab === "desk") await loadState();
      else if (tab === "monthly") {
        await renderMonthly();
        if (!cardRecording) await renderCardPreview();
      } else if (tab === "toplp") await loadCandidates(false);
      else if (tab === "copylp") {
        if (copySelectedPool) await loadPoolPositions();
        if (copyMonitorStarted) await runCopyMonitor(true);
      }
    }
  } catch (_) {
    /* tiap fungsi menangani errornya sendiri */
  } finally {
    liveTickBusy = false;
    if (nowBtn) {
      nowBtn.disabled = false;
      nowBtn.textContent = "Perbarui sekarang";
    }
  }
}

/* ---------------- Open LP terminal ---------------- */

function chainFromDexId(chainId) {
  const map = { solana: "SOL", base: "BASE", bsc: "BSC", ethereum: "ETH", robinhood: "ROBINHOOD", hyperevm: "HYPEREVM", arc: "ARC" };
  return map[String(chainId || "").toLowerCase()] || null;
}
function tokenFromPair(pair) {
  const chain = chainFromDexId(pair.chainId);
  const base = pair.baseToken || {};
  const quote = pair.quoteToken || {};
  if (STABLE_QUOTES.includes((quote.symbol || "").toUpperCase()) || !STABLE_QUOTES.includes((base.symbol || "").toUpperCase())) {
    return { address: base.address, symbol: base.symbol, name: base.name, pairSymbol: quote.symbol };
  }
  return { address: quote.address, symbol: quote.symbol, name: quote.name, pairSymbol: base.symbol };
}
function selectToken(pair, chainLabel) {
  const t = tokenFromPair(pair);
  selectedToken = {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    chain: chainLabel,
    price: Number(pair.priceUsd) || 0,
    pair: (pair.baseToken?.symbol || "?") + "/" + (pair.quoteToken?.symbol || "?"),
    pairUrl: pair.url || "",
  };
  $("lpSelectedInfo").textContent = "Dipilih: " + selectedToken.symbol + " (" + chainLabel + ") @ " + fmtPrice(selectedToken.price);
  $("lpPairInfo").textContent = selectedToken.pair + " · " + fmtPrice(selectedToken.price);
  const selChain = $("lpChain");
  if (selChain.value === "AUTO" || CHAINS.includes(chainLabel)) selChain.value = chainLabel === "AUTO" ? "AUTO" : chainLabel;
  applyLpPreset(lpPreset);
}
/* Preset range gaya hosted: Tight −5/+5, Wide −20/+20 mengisi Min %/Max %;
   Custom = nilai manual pengguna (tidak ditimpa). */
function applyLpPreset(name) {
  lpPreset = name;
  document.querySelectorAll("#lpPresetSeg [data-preset]").forEach((b) => b.classList.toggle("active", b.dataset.preset === name));
  const pr = LP_PRESETS[name];
  if (pr) {
    $("lpMinPct").value = pr[0];
    $("lpMaxPct").value = pr[1];
  }
}
/* Bar distribusi visual: nilai select berbentuk "token/quote" (kontrak API
   server); label + bar ditampilkan QUOTE dulu seperti hosted. */
function updateDistBar() {
  const parts = String($("lpDistribution").value || "50/50")
    .split("/")
    .map(Number);
  const tok = parts[0] || 0;
  const quo = parts[1] || 0;
  $("distBarQuote").style.width = quo + "%";
  $("distBarToken").style.width = tok + "%";
  $("distLabel").textContent = quo + "% QUOTE · " + tok + "% TOKEN";
}
function renderSearchResults(pairs, sourceLabel) {
  const box = $("lpSearchResults");
  lpLastResults = pairs || [];
  if (!lpLastResults.length) {
    box.innerHTML = '<p class="muted">Tidak ada hasil.</p>';
    return;
  }
  box.innerHTML =
    lpLastResults
      .map((pair, i) => {
        const chain = chainFromDexId(pair.chainId);
        const t = tokenFromPair(pair);
        const label = chain || "TIDAK DIDUKUNG (" + esc(pair.chainId || "?") + ")";
        return (
          '<button type="button" class="token-result" data-idx="' +
          i +
          '">' +
          "<span><strong>" +
          esc(t.symbol || "?") +
          "</strong> — " +
          esc(t.name || "") +
          "<small>" +
          esc((pair.baseToken?.symbol || "?") + "/" + (pair.quoteToken?.symbol || "?")) +
          " · " +
          esc(pair.dexId || "") +
          " · " +
          label +
          "</small></span>" +
          "<span>" +
          fmtPrice(pair.priceUsd) +
          "<small>Liq " +
          fmtCompact(pair.liquidity?.usd) +
          " · Vol24h " +
          fmtCompact(pair.volume?.h24) +
          "</small></span>" +
          "</button>"
        );
      })
      .join("") + (sourceLabel ? '<p class="muted">Sumber: <a href="https://dexscreener.com" target="_blank" rel="noopener">DexScreener</a></p>' : "");
  box.querySelectorAll(".token-result").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pair = lpLastResults[Number(btn.dataset.idx)];
      const chain = chainFromDexId(pair.chainId);
      if (!chain) {
        setMsg("lpMsg", 'Pair ini berasal dari chain "' + (pair.chainId || "?") + '" yang TIDAK termasuk 7 chain simulasi (SOL, BASE, ROBINHOOD, BSC, HYPEREVM, ARC, ETH). Pair ditolak — tidak dipetakan ke chain lain.', true);
        return;
      }
      selectToken(pair, chain);
      setMsg("lpMsg", "Token dipilih: " + selectedToken.symbol + " di " + chain + ".");
    });
  });
}
async function searchLpTokens() {
  const q = $("lpSearchInput").value.trim();
  if (!q) {
    setMsg("lpMsg", "Isi kata kunci atau alamat token dulu.", true);
    return;
  }
  setMsg("lpMsg", "Mencari di DexScreener…");
  try {
    let pairs = [];
    if (/^0x[0-9a-fA-F]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
      const data = await api("/api/dex/token?address=" + encodeURIComponent(q));
      pairs = data.pairs || [];
    } else {
      const data = await api("/api/dex/search?q=" + encodeURIComponent(q));
      pairs = data.pairs || [];
    }
    const chainSel = $("lpChain").value;
    if (chainSel !== "AUTO") {
      pairs = pairs.filter((p) => chainFromDexId(p.chainId) === chainSel);
    }
    renderSearchResults(pairs.slice(0, 12), true);
    setMsg("lpMsg", pairs.length ? "Klik hasil untuk memilih token." : "Tidak ada pair yang cocok.");
  } catch (e) {
    setMsg("lpMsg", e.friendly || e.message, true);
  }
}
async function autopilotPick() {
  const q = $("lpSearchInput").value.trim();
  if (!q) return null;
  const data = await api("/api/dex/token?address=" + encodeURIComponent(q));
  const pairs = (data.pairs || []).filter((p) => chainFromDexId(p.chainId));
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pairs[0] || null;
}
async function openLp() {
  let sel = selectedToken;
  if (!sel) {
    setMsg("lpMsg", "Auto-pilot: mencari token dari alamat yang ditempel…");
    try {
      const best = await autopilotPick();
      if (!best) {
        setMsg("lpMsg", "Auto-pilot gagal: alamat tidak ditemukan atau hanya ada di chain yang tidak didukung.", true);
        return;
      }
      selectToken(best, chainFromDexId(best.chainId));
      sel = selectedToken;
    } catch (e) {
      setMsg("lpMsg", e.friendly || e.message, true);
      return;
    }
  }
  const chainSel = $("lpChain").value;
  const chain = chainSel === "AUTO" ? sel.chain : chainSel;
  const amount = Number($("lpAmount").value) || 0;
  // Min %/Max % (gaya hosted) diterjemahkan ke harga absolut dari harga
  // token terpilih — kontrak API server TETAP minPrice/maxPrice absolut.
  const minPct = Number($("lpMinPct").value);
  const maxPct = Number($("lpMaxPct").value);
  if (!(amount > 0)) {
    setMsg("lpMsg", "Nominal harus lebih dari 0.", true);
    return;
  }
  if (!isFinite(minPct) || !isFinite(maxPct) || minPct <= -100 || maxPct <= minPct) {
    setMsg("lpMsg", "Range Min %/Max % tidak valid (Max % harus lebih besar dari Min %, dan Min % harus di atas −100%).", true);
    return;
  }
  const minPrice = sel.price * (1 + minPct / 100);
  const maxPrice = sel.price * (1 + maxPct / 100);
  // SL/TP terminal dalam PERSEN seperti hosted (SL negatif, mis. -28; TP
  // positif, mis. 22) — server mengonversinya ke harga absolut.
  const slPct = $("lpSl").value === "" ? null : Number($("lpSl").value);
  const tpPct = $("lpTp").value === "" ? null : Number($("lpTp").value);
  try {
    const r = await postJson("/api/lp/open", {
      chain,
      address: sel.address,
      symbol: sel.symbol,
      name: sel.name,
      pair: sel.pair,
      pairUrl: sel.pairUrl,
      amount,
      price: sel.price,
      minPrice,
      maxPrice,
      side: lpSideVal,
      strategy: lpStrategyVal,
      quote: $("lpQuote").value,
      slPct,
      tpPct,
      binStepBps: Number($("lpBinStep").value) || 25,
      distribution: $("lpDistribution").value,
    });
    setMsg("lpMsg", "Posisi LP " + r.position.symbol + " dibuka di " + r.position.chain + " sebesar " + fmtMoney(r.position.amount) + ".");
    await loadState();
  } catch (e) {
    setMsg("lpMsg", e.friendly || e.message, true);
  }
}

/* ---------------- Monthly profit ---------------- */

function renderCalendarGrid(targetId, days, month) {
  const [y, m] = month.split("-").map(Number);
  const today = new Date().toISOString().slice(0, 10);
  const offset = new Date(y, m - 1, 1).getDay();
  let cells = "";
  for (let i = 0; i < offset; i++) cells += '<div class="cal-blank"></div>';
  cells += (days || []).map((d) =>
    '<div class="cal-day' + (d.pnl > 0 ? " up" : d.pnl < 0 ? " down" : "") + (d.date === today ? " today" : "") + '"><span class="d">' +
    d.day +
    "</span>" +
    (d.pnl !== 0 ? '<span class="pnl-val ' + (d.pnl > 0 ? "pos" : "neg") + '">' + (d.pnl > 0 ? "+" : "−") + fmtMoney(Math.abs(d.pnl)) + '</span><span class="cnt">' + d.positions + " posisi</span>" : "") +
    "</div>",
  ).join("");
  $(targetId).innerHTML = cells;
}
async function renderDeskCalendar() {
  try {
    const data = await api("/api/monthly?month=" + encodeURIComponent(currentMonth));
    const [y, m] = currentMonth.split("-").map(Number);
    $("deskCalendarMonth").textContent = new Date(y, m - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
    renderCalendarGrid("deskCalendarGrid", data.days, currentMonth);
  } catch (e) {
    $("deskCalendarGrid").innerHTML = '<p class="muted">Kalender belum dapat dimuat: ' + esc(e.friendly || e.message) + "</p>";
  }
}
async function renderMonthly() {
  const data = await api("/api/monthly?month=" + encodeURIComponent(currentMonth));
  const [y, m] = currentMonth.split("-").map(Number);
  $("monthLabel").textContent = new Date(y, m - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
  const t = data.totals;
  // Sidebar: nilai portfolio + Total PnL memakai payload realtime terakhir
  // (all-time live) bila ada; fallback ke totals /api/monthly.
  const portfolioValue = rtData ? rtData.portfolioValue : t.totalPortfolioValue;
  const totalPnlAll = rtData ? rtData.totalPnl : t.totalPnl;
  $("mSideValue").textContent = fmtMoney(portfolioValue);
  $("mSideDeposit").textContent = fmtCompact(t.allTimeDeposit);
  $("mSideFeesClaimed").textContent = fmtMoney(t.feesClaimed);
  $("mSideClaimable").textContent = fmtMoney(t.claimableFees);
  const pnlEl = $("mSideTotalPnl");
  pnlEl.textContent = (totalPnlAll >= 0 ? "+" : "−") + fmtMoney(Math.abs(totalPnlAll));
  pnlEl.className = "num side-big " + (totalPnlAll >= 0 ? "pos" : "neg");
  const pct = t.allTimeDeposit > 0 ? round2Client((totalPnlAll / t.allTimeDeposit) * 100) : 0;
  const pill = $("mSideTotalPnlPct");
  pill.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  pill.className = "pct-pill" + (pct < 0 ? " neg" : "");
  $("mSideAvg").textContent = fmtMoney(t.avgInvested);
  $("mSideWinRate").textContent = t.winRate + "%";
  $("mSideBiggestWin").textContent = fmtMoney(t.biggestWin);
  const head = $("monthPnlHead");
  head.textContent = (t.totalPnl >= 0 ? "+" : "−") + fmtMoney(Math.abs(t.totalPnl));
  head.className = "num " + (t.totalPnl >= 0 ? "pos" : "neg");
  renderCalendarGrid("monthlyCalendar", data.days, currentMonth);
  return data;
}

/* ---------------- Card Studio (SATU renderer untuk preview + PNG + WebM) ---------------- */

function drawCard(ctx, W, H, monthly) {
  // Desain mengikuti kartu hosted (referensi screenshot Monthly Profit hosted):
  // bingkai oranye tipis, latar gelap ber-grid halus, logo oranye + wordmark
  // putih, eyebrow CALENDAR, judul Monthly Recap, bulan Bahasa Indonesia,
  // MONTHLY PnL di kanan atas, label "LP DESK - SIMULATION", kalender dengan
  // offset hari pertama (Minggu = kolom 0) dan sel PnL terisi solid, lalu
  // baris statistik bawah 4 kolom (CLOSES / FEES / W/L / WIN RATE).
  const ORANGE = "#f0760a";
  const MUTED = "#8b98ab";
  const GREEN = "#2fbf71";
  const RED = "#e5484d";
  ctx.fillStyle = "#0a0e14";
  ctx.fillRect(0, 0, W, H);
  const bright = Number($("bgBrightness").value) || 112;
  ctx.save();
  ctx.filter = "brightness(" + bright + "%)";
  if (cardBg.type === "image" && cardBg.img) {
    ctx.drawImage(cardBg.img, 0, 0, W, H);
  } else if (cardBg.type === "video" && cardBg.video) {
    try {
      ctx.drawImage(cardBg.video, 0, 0, W, H);
    } catch (_) {
      /* frame belum siap */
    }
  }
  ctx.restore();
  if (cardBg.type) {
    ctx.fillStyle = "rgba(6,10,16,0.55)";
    ctx.fillRect(0, 0, W, H);
  }
  // Grid latar halus
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 80; gx < W; gx += 80) {
    ctx.moveTo(gx + 0.5, 0);
    ctx.lineTo(gx + 0.5, H);
  }
  for (let gy = 80; gy < H; gy += 80) {
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(W, gy + 0.5);
  }
  ctx.stroke();
  const t = monthly.totals;
  const [y, m] = currentMonth.split("-").map(Number);
  const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const signed = (n) => {
    const v = Number(n) || 0;
    return (
      (v > 0 ? "+"
      : v < 0 ? "-"
      : "") +
      "$" +
      Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  };
  const rr = (x, yy, w, h, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, yy, w, h, r);
    else ctx.rect(x, yy, w, h);
  };
  // Header: logo oranye + wordmark putih
  ctx.fillStyle = ORANGE;
  ctx.fillRect(96, 78, 5, 46);
  ctx.beginPath();
  ctx.moveTo(101, 80);
  ctx.lineTo(140, 90);
  ctx.lineTo(101, 101);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 46px " + FONT_STACK;
  ctx.textAlign = "left";
  ctx.fillText("ReagenCorp", 154, 118);
  ctx.fillStyle = MUTED;
  ctx.font = "600 20px " + FONT_STACK;
  ctx.textAlign = "right";
  ctx.fillText("LP DESK - SIMULATION", 1504, 112);
  ctx.textAlign = "left";
  // Blok judul
  ctx.fillStyle = MUTED;
  ctx.font = "700 23px " + FONT_STACK;
  ctx.fillText("C A L E N D A R", 96, 218);
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 92px " + FONT_STACK;
  ctx.fillText("Monthly Recap", 96, 308);
  ctx.fillStyle = "#a7b2c2";
  ctx.font = "600 34px " + FONT_STACK;
  ctx.fillText(MONTHS_ID[m - 1] + " " + y, 96, 358);
  // MONTHLY PnL di kanan atas
  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.font = "600 22px " + FONT_STACK;
  ctx.fillText("MONTHLY PNL", 1504, 218);
  ctx.fillStyle =
    t.totalPnl > 0 ? GREEN
    : t.totalPnl < 0 ? RED
    : "#ffffff";
  ctx.font = "800 92px " + FONT_STACK;
  ctx.fillText(signed(t.totalPnl), 1504, 310);
  ctx.textAlign = "left";
  // Kalender: offset hari pertama (Minggu = kolom 0), sel PnL terisi solid
  const offset = new Date(y, m - 1, 1).getDay();
  const rows = Math.ceil((offset + monthly.days.length) / 7);
  const x0 = 96,
    y0 = 396,
    cellW = 192,
    gapX = 12,
    gapY = 10;
  const cellH = Math.floor((452 - (rows - 1) * gapY) / rows);
  monthly.days.forEach((d, i) => {
    const idx = offset + i;
    const col = idx % 7,
      row = Math.floor(idx / 7);
    const x = x0 + col * (cellW + gapX),
      yy = y0 + row * (cellH + gapY);
    if (d.pnl > 0 || d.pnl < 0) {
      ctx.fillStyle = d.pnl > 0 ? "#0d9d68" : "#8a2e2e";
      rr(x, yy, cellW, cellH, 12);
      ctx.fill();
      ctx.fillStyle = d.pnl > 0 ? "#eafff5" : "#ffe9e9";
      ctx.font = "600 19px " + FONT_STACK;
      ctx.fillText(String(d.day), x + 14, yy + 30);
      ctx.font = "700 30px " + FONT_STACK;
      ctx.fillText(signed(d.pnl), x + 14, yy + cellH - 16);
    } else {
      ctx.fillStyle = MUTED;
      ctx.font = "600 19px " + FONT_STACK;
      ctx.fillText(String(d.day), x + 14, yy + 30);
    }
  });
  // Statistik bawah: 4 kolom berlabel
  const stats = [
    ["CLOSES", String(t.closes)],
    ["FEES", fmtMoney(t.feesClaimed)],
    ["W/L", t.winDays + "/" + t.lossDays],
    ["WIN RATE", t.winRate + "%"],
  ];
  stats.forEach((s, i) => {
    const x = 96 + i * 364;
    ctx.fillStyle = MUTED;
    ctx.font = "600 20px " + FONT_STACK;
    ctx.fillText(s[0], x, 884);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 42px " + FONT_STACK;
    ctx.fillText(s[1], x, 930);
  });
  // Bingkai oranye tipis
  ctx.strokeStyle = ORANGE;
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 40, W - 80, H - 80);
}
async function renderCardPreview() {
  const monthly = await api("/api/monthly?month=" + encodeURIComponent(currentMonth));
  cardMonthlyCache = monthly;
  const canvas = $("cardCanvas");
  drawCard(canvas.getContext("2d"), canvas.width, canvas.height, monthly);
  return monthly;
}
function startVideoPreviewLoop() {
  if (videoPreviewRaf) return;
  const tick = () => {
    videoPreviewRaf = requestAnimationFrame(tick);
    // Preview video: gambar ulang frame video berjalan ke canvas preview
    // memakai renderer + cache yang sama (tanpa fetch berulang).
    if (cardBg.type === "video" && cardBg.video && !cardBg.video.paused && cardMonthlyCache) {
      const canvas = $("cardCanvas");
      if (canvas && $("tab-monthly").classList.contains("active")) {
        drawCard(canvas.getContext("2d"), canvas.width, canvas.height, cardMonthlyCache);
      }
    }
  };
  tick();
}
async function downloadCard() {
  const monthly = await api("/api/monthly?month=" + encodeURIComponent(currentMonth));
  cardRecording = true;
  const fileBase = "ReagenCorp-profit-" + currentMonth;
  if (cardBg.type === "video" && cardBg.video) {
    setMsg("cardMsg", "Merekam video card 10 detik (WebM HD, 12 Mbps)…");
    const off = document.createElement("canvas");
    off.width = 1600;
    off.height = 1000;
    const octx = off.getContext("2d");
    const stream = off.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const done = new Promise((r) => {
      rec.onstop = r;
    });
    const video = cardBg.video;
    const wasPaused = video.paused;
    video.loop = true;
    try {
      await video.play();
    } catch (_) {
      /* tetap rekam frame diam */
    }
    rec.start(200);
    const started = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        drawCard(octx, 1600, 1000, monthly);
        if (performance.now() - started < 10000) requestAnimationFrame(tick);
        else resolve();
      };
      tick();
    });
    rec.stop();
    await done;
    if (wasPaused) video.pause();
    const blob = new Blob(chunks, { type: "video/webm" });
    triggerDownload(URL.createObjectURL(blob), fileBase + ".webm");
    setMsg("cardMsg", "Video card diunduh: " + fileBase + ".webm");
    cardRecording = false;
    return;
  }
  const off = document.createElement("canvas");
  off.width = 1600;
  off.height = 1000;
  drawCard(off.getContext("2d"), 1600, 1000, monthly);
  const a = document.createElement("a");
  a.download = fileBase + ".png";
  a.href = off.toDataURL("image/png");
  a.click();
  setMsg("cardMsg", "Kartu diunduh: " + fileBase + ".png");
  cardRecording = false;
}
function triggerDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function setBgInfo() {
  const info = $("bgInfo");
  if (!cardBg.type) {
    info.textContent = "Belum ada background. Input gambar dan video saling eksklusif.";
    $("bgRemoveBtn").hidden = true;
    $("bgPlayBtn").hidden = true;
    return;
  }
  info.textContent = "Background aktif: " + (cardBg.type === "image" ? "GAMBAR → ekspor PNG HD" : "VIDEO → ekspor WebM HD 10 detik") + " · file: " + cardBg.name;
  $("bgRemoveBtn").hidden = false;
  $("bgPlayBtn").hidden = cardBg.type !== "video";
}

/* ---------------- Settings ---------------- */

async function saveSettings() {
  const data = await postJson("/api/settings", { settings });
  settings = data.settings;
  renderCrew();
  return settings;
}
function fillNaraForm() {
  const at = settings.autoTrading;
  $("naraEnabled").checked = !!at.enabled;
  $("naraMinScore").value = at.minScore;
  $("naraAmount").value = at.amountPerPosition;
  $("naraMaxPos").value = at.maxPositions;
  $("naraChain").value = at.chainFilter;
  $("naraRange").value = at.rangePreset;
  $("naraVerdict").value = at.verdictFilter;
  $("naraDailyLoss").value = at.dailyLossLimit;
  $("naraMinLiq").value = at.minLiquidity;
  $("naraMinHolder").value = at.minHolder;
  $("naraSource").value = at.source || "DEX";
  $("naraMinApr").value = at.minApr == null ? 20 : at.minApr;
  renderAgentLogs("naraLogs", "Nara");
}
function readNaraForm() {
  const at = settings.autoTrading;
  at.enabled = $("naraEnabled").checked;
  at.minScore = Number($("naraMinScore").value) || 0;
  at.amountPerPosition = Number($("naraAmount").value) || 0;
  at.maxPositions = Number($("naraMaxPos").value) || 0;
  at.chainFilter = $("naraChain").value;
  at.rangePreset = $("naraRange").value;
  at.verdictFilter = $("naraVerdict").value;
  at.dailyLossLimit = Number($("naraDailyLoss").value) || 0;
  at.minLiquidity = Number($("naraMinLiq").value) || 0;
  at.minHolder = Number($("naraMinHolder").value) || 0;
  at.source = $("naraSource").value;
  at.minApr = Number($("naraMinApr").value) || 0;
}
function fillByteForm() {
  const tp = settings.tpSl;
  $("byteArmed").checked = !!tp.armed;
  $("byteTp").value = tp.defaultTpPct;
  $("byteSl").value = tp.defaultSlPct;
  renderByteChart();
  renderAgentLogs("byteLogs", "Byte");
}
function renderByteChart() {
  const box = $("byteChart");
  const opens = ((deskState && deskState.positions) || []).filter((p) => p.status === "open");
  if (!opens.length) {
    box.innerHTML = '<p class="muted">Tidak ada posisi terbuka.</p>';
    return;
  }
  box.innerHTML = opens
    .map((p) => {
      const hasSl = p.sl != null && Number(p.sl) > 0;
      const hasTp = p.tp != null && Number(p.tp) > 0;
      if (!hasSl && !hasTp) return '<div class="byte-row"><strong>' + esc(p.symbol) + "</strong> — tanpa SL/TP.</div>";
      const lo = hasSl ? Number(p.sl) : p.entryPrice * 0.8;
      const hi = hasTp ? Number(p.tp) : p.entryPrice * 1.2;
      const pos = Math.max(0, Math.min(100, ((p.currentPrice - lo) / (hi - lo)) * 100));
      const slW = hasSl ? ((Number(p.sl) - lo) / (hi - lo)) * 100 : 0;
      const tpW = hasTp ? ((hi - Number(p.tp)) / (hi - lo)) * 100 : 0;
      return (
        '<div class="byte-row"><strong>' +
        esc(p.symbol) +
        '</strong> <span class="chain-badge">' +
        esc(p.chain) +
        "</span> harga " +
        fmtPrice(p.currentPrice) +
        " · SL " +
        (hasSl ? fmtPrice(p.sl) : "—") +
        " · TP " +
        (hasTp ? fmtPrice(p.tp) : "—") +
        '<div class="byte-track"><span class="byte-sl" style="width:' +
        slW +
        '%"></span><span class="byte-tp" style="width:' +
        tpW +
        '%"></span><span class="byte-marker" style="left:calc(' +
        pos +
        '% - 2px)"></span></div></div>'
      );
    })
    .join("");
}
function renderSora() {
  const box = $("soraBody");
  const positions = (deskState && deskState.positions) || [];
  const opens = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed" || p.status === "rebalanced");
  const totalCapital = 5000;
  const allocated = round2Client(opens.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const remaining = round2Client(totalCapital - allocated);
  const totalPnl = round2Client(
    positions.reduce((s, p) => {
      const fees = (Number(p.fees) || 0) + (Number(p.rewards) || 0);
      return (
        s +
        (p.status === "open" ? (Number(p.value) || 0) + fees - (Number(p.amount) || 0)
        : p.closePnl != null ? p.closePnl
        : 0)
      );
    }, 0),
  );
  const wins = closed.filter((p) => (p.closePnl || 0) > 0).length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 10000) / 100 : 0;
  const fees = round2Client(positions.reduce((s, p) => s + (Number(p.fees) || 0) + (Number(p.rewards) || 0), 0)) + (Number(deskState.claimedFeesTotal) || 0);
  const byChain = {};
  for (const p of opens) byChain[p.chain] = round2Client((byChain[p.chain] || 0) + (Number(p.amount) || 0));
  const chainRows = Object.entries(byChain).sort((a, b) => b[1] - a[1]);
  const topChain = chainRows[0];
  const insights = [];
  if (topChain && allocated > 0 && topChain[1] / allocated > 0.6) insights.push("Konsentrasi tinggi: " + Math.round((topChain[1] / allocated) * 100) + "% modal terbuka ada di " + topChain[0] + ". Pertimbangkan diversifikasi chain.");
  const outCount = opens.filter((p) => !p.inRange).length;
  if (outCount) insights.push(outCount + " posisi di luar range — pertimbangkan rebalance atau tutup.");
  if (remaining < totalCapital * 0.1 && opens.length) insights.push("Modal bebas tinggal " + fmtMoney(remaining) + " — hampir habis teralokasi.");
  if (!insights.length) insights.push("Alokasi terlihat seimbang; tidak ada konsentrasi atau posisi bermasalah yang menonjol.");
  const health = opens
    .map((p) => {
      const movePct = p.entryPrice > 0 ? (Math.abs(p.currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const risk =
        !p.inRange ? "Tinggi"
        : movePct > 10 ? "Sedang"
        : "Rendah";
      return (
        '<div class="log-row"><strong>' +
        esc(p.symbol) +
        '</strong> <span class="chain-badge">' +
        esc(p.chain) +
        "</span> " +
        (p.inRange ? "IN RANGE" : "OUT OF RANGE") +
        " · risiko " +
        risk +
        " · uPnL " +
        fmtMoney((Number(p.value) || 0) + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - (Number(p.amount) || 0)) +
        "</div>"
      );
    })
    .join("");
  const recs = [];
  if (outCount) recs.push("Rebalance/tutup " + outCount + " posisi out-of-range.");
  if (fees > 0) recs.push("Claim fee yang tersedia agar tercatat di Monthly Profit.");
  if (!recs.length) recs.push("Tidak ada tindakan mendesak. Pantau lewat panel realtime.");
  box.innerHTML =
    '<div class="sora-grid">' +
    "<div><span>Modal teralokasi</span><strong>" +
    fmtMoney(allocated) +
    "</strong></div>" +
    "<div><span>Remaining capital</span><strong>" +
    fmtMoney(remaining) +
    "</strong></div>" +
    '<div><span>Total PnL</span><strong class="' +
    (totalPnl >= 0 ? "pos" : "neg") +
    '">' +
    fmtMoney(totalPnl) +
    "</strong></div>" +
    "<div><span>Win rate (posisi tutup)</span><strong>" +
    winRate +
    "%</strong></div>" +
    "<div><span>Total fees (klaim + belum)</span><strong>" +
    fmtMoney(fees) +
    "</strong></div>" +
    "<div><span>Posisi terbuka / total</span><strong>" +
    opens.length +
    " / " +
    positions.length +
    "</strong></div>" +
    "</div>" +
    "<h4>Alokasi per chain</h4>" +
    (chainRows.length ?
      chainRows.map(([c, v]) => '<div class="log-row"><span class="chain-badge">' + c + "</span> " + fmtMoney(v) + " (" + (allocated > 0 ? Math.round((v / allocated) * 100) : 0) + "%)</div>").join("")
    : '<p class="muted">Belum ada alokasi.</p>') +
    "<h4>Concentration insights</h4>" +
    insights.map((i) => '<div class="log-row">' + esc(i) + "</div>").join("") +
    "<h4>Kesehatan posisi</h4>" +
    (health || '<p class="muted">Tidak ada posisi terbuka.</p>') +
    "<h4>Rekomendasi</h4>" +
    recs.map((r) => '<div class="log-row">' + esc(r) + "</div>").join("");
  renderAgentLogs("soraLogs", "Sora");
}

/* ---------------- Top LP — Discover ---------------- */

const TF_LABEL = { m5: "5M", h1: "1H", h6: "6H", h24: "24H" };
const TF_VOL = { m5: "volume_m5", h1: "volume_h1", h6: "volume_h6", h24: "volume_h24" };
const TF_FEE = { m5: "fee_tvl_5m", h1: "fee_tvl_1h", h6: "fee_tvl_6h", h24: "fee_tvl_24h" };
function allCandidates() {
  if (!candidatesData) return [];
  // Bentuk respons menyamakan hosted: recommendations + pending_candidates.
  return (candidatesData.recommendations || []).concat(candidatesData.pending_candidates || []);
}
function sparklineSvg(c) {
  const vals = [c.price_change_m5 || 0, c.price_change_h1 || 0, c.price_change_h6 || 0, c.price_change_24h || 0];
  const min = Math.min(...vals, 0),
    max = Math.max(...vals, 0);
  const range = max - min || 1;
  const pts = vals.map((v, i) => 4 + i * 14 + "," + (20 - ((v - min) / range) * 16)).join(" ");
  const up = (c.price_change_24h || 0) >= 0;
  return '<svg class="spark" width="48" height="24" viewBox="0 0 48 24"><polyline points="' + pts + '" fill="none" stroke="' + (up ? "#2fbf71" : "#e5484d") + '" stroke-width="2"/></svg>';
}
function feeTvlCell(v) {
  return v == null ? "—" : fmtPct(v);
}
function discoverRows() {
  let rows = allCandidates().slice();
  if (discoverState.chain !== "ALL") rows = rows.filter((c) => c.chain === discoverState.chain);
  if (discoverState.hideRisky) rows = rows.filter((c) => !(c.safety_score != null && c.safety_score < 50));
  const tf = discoverState.tf;
  if (discoverState.tab === "trending") rows.sort((a, b) => (b[TF_VOL[tf]] || 0) - (a[TF_VOL[tf]] || 0));
  else if (discoverState.tab === "new") rows.sort((a, b) => (b.pair_created_at || 0) - (a.pair_created_at || 0));
  else if (discoverState.tab === "feeTvl") rows.sort((a, b) => (b[TF_FEE[tf]] != null ? b[TF_FEE[tf]] : -1) - (a[TF_FEE[tf]] != null ? a[TF_FEE[tf]] : -1));
  else if (discoverState.tab === "rising") rows.sort((a, b) => (b.fee_tvl_24h != null ? b.fee_tvl_24h : -1) - (a.fee_tvl_24h != null ? a.fee_tvl_24h : -1));
  return rows;
}
function renderDiscover() {
  const body = $("discoverBody");
  const rows = discoverRows();
  if (!candidatesData) {
    body.innerHTML = '<tr><td colspan="17" class="muted">Memuat kandidat…</td></tr>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="17" class="muted">Tidak ada kandidat untuk tab/filter ini. ' + (discoverState.tab === "rising" ? "Rising fees kosong secara jujur bila tidak ada data fee Meteora yang naik." : "") + "</td></tr>";
    return;
  }
  body.innerHTML = rows
    .map((c) => {
      const dd = c.due_diligence || {};
      const ddDone = (dd.completed_checks || 0) >= 6;
      const chg = c.price_change_24h || 0;
      const main =
        '<tr class="disc-row" data-addr="' +
        esc(c.address) +
        '">' +
        '<td data-label="Token"><span class="tok-name">' +
        esc(c.symbol) +
        '</span> <span class="tok-sub">' +
        c.pool_count +
        " pool · " +
        esc(c.chain) +
        "</span><br>" +
        (c.rank ? '<span class="rank-badge">#' + c.rank + "</span> " : "") +
        (ddDone ? '<span class="rank-badge">DD: ' + esc(dd.final_verdict) + "</span>" : '<span class="dd-pending">DD Pending — belum diperiksa, bukan rekomendasi</span>') +
        "</td>" +
        '<td data-label="Age">' +
        fmtAge(c.pair_created_at) +
        "</td>" +
        '<td data-label="Price 24h">' +
        fmtPrice(c.price_usd) +
        ' <span class="' +
        (chg >= 0 ? "pos" : "neg") +
        '">' +
        (chg >= 0 ? "+" : "") +
        chg +
        "%</span>" +
        sparklineSvg(c) +
        "</td>" +
        '<td data-label="MCap">' +
        (c.market_cap_usd ? fmtCompact(c.market_cap_usd) : "—") +
        "</td>" +
        '<td data-label="Holders">' +
        fmtCount(c.holders_count) +
        "</td>" +
        '<td data-label="Vol 5M">' +
        fmtCompact(c.volume_m5) +
        "</td>" +
        '<td data-label="Vol 1H">' +
        fmtCompact(c.volume_h1) +
        "</td>" +
        '<td data-label="Vol 6H">' +
        fmtCompact(c.volume_h6) +
        "</td>" +
        '<td data-label="Vol 24H">' +
        fmtCompact(c.volume_24h) +
        "</td>" +
        '<td data-label="Liquidity">' +
        fmtCompact(c.liquidity_usd) +
        "</td>" +
        '<td data-label="F/T 5M">' +
        feeTvlCell(c.fee_tvl_5m) +
        "</td>" +
        '<td data-label="F/T 1H">' +
        feeTvlCell(c.fee_tvl_1h) +
        "</td>" +
        '<td data-label="F/T 6H">' +
        feeTvlCell(c.fee_tvl_6h) +
        "</td>" +
        '<td data-label="F/T 24H">' +
        feeTvlCell(c.fee_tvl_24h) +
        "</td>" +
        '<td data-label="Smart LP" title="Smart LP tidak tersedia dari sumber publik mana pun.">—</td>' +
        '<td data-label="Safety">' +
        (c.safety_score == null ? "—" : c.safety_score) +
        "</td>" +
        '<td data-label="Aksi"><button type="button" class="open-pool-btn" data-openpool="' +
        esc(c.address) +
        '">Open pool</button></td>' +
        "</tr>";
      let detail = "";
      if (discoverState.expanded === c.address) {
        detail = '<tr class="disc-detail"><td colspan="17">' + candidateDetailHtml(c) + "</td></tr>";
      }
      return main + detail;
    })
    .join("");
  body.querySelectorAll("tr.disc-row").forEach((tr) => {
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      const addr = tr.dataset.addr;
      discoverState.expanded = discoverState.expanded === addr ? null : addr;
      renderDiscover();
    });
  });
  body.querySelectorAll("[data-openpool]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPoolFromDiscover(btn.dataset.openpool);
    });
  });
  body.querySelectorAll("[data-copyca]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyCa(btn.dataset.copyca, btn);
    });
  });
  body.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openCandidateModal(btn.dataset.detail);
    });
  });
  body.querySelectorAll("[data-dd]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDdModal(btn.dataset.dd);
    });
  });
}
function candidateDetailHtml(c) {
  const aa = c.agent_analysis || {};
  const dd = c.due_diligence || {};
  const listOr = (arr, empty) => (arr && arr.length ? "<ul>" + arr.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : '<p class="muted">' + empty + "</p>");
  return (
    '<div class="detail-grid">' +
    "<div><h4>Analisis agent</h4>" +
    (aa.status === "unavailable" ? "<p><strong>SECURITY UNAVAILABLE</strong> — confidence rendah, jangan dianggap aman.</p>" : "") +
    "<p>Skor agent: <strong>" +
    (aa.score == null ? "—" : aa.score + "/100") +
    "</strong> · Verdict: <strong>" +
    esc(aa.verdict || "—") +
    "</strong> · Confidence: " +
    esc(aa.confidence || "—") +
    " · Status data: " +
    esc(aa.status || "—") +
    "<br>" +
    "Security 45%: " +
    (aa.security_score == null ? "—" : aa.security_score) +
    " · Organic proxy 25%: " +
    (aa.organic_proxy_score == null ? "—" : aa.organic_proxy_score) +
    " · Market quality 30%: " +
    (c.market_score == null ? "—" : c.market_score) +
    " · Safety: " +
    (c.safety_score == null ? "—" : c.safety_score) +
    "<br>" +
    "Holders: " +
    (aa.holder_count == null ? "tidak tersedia" : fmtCount(aa.holder_count)) +
    (aa.top_holders_percent != null ? " · 10 holder teratas: " + aa.top_holders_percent + "%" : "") +
    " · Likuiditas: " +
    fmtMoney(c.liquidity_usd) +
    " · Volume 24h: " +
    fmtMoney(c.volume_24h) +
    " · Market status: " +
    esc(c.market_status || "—") +
    "</p>" +
    "<h4>Rationale</h4>" +
    listOr(c.rationale, "Tidak ada rationale.") +
    "<h4>Sisi positif</h4>" +
    listOr(aa.positives, "Tidak ada catatan positif.") +
    "<h4>Risiko</h4>" +
    listOr(aa.risks, "Tidak ada risiko yang ter-flag.") +
    (aa.limitations || []).map((l) => '<p class="muted">' + esc(l) + "</p>").join("") +
    '<p class="muted">Sumber: ' +
    esc((aa.sources || []).join(", ") || "—") +
    " · Dianalisis: " +
    (aa.analyzed_at ? new Date(aa.analyzed_at).toLocaleString("id-ID") : "—") +
    "</p>" +
    "</div>" +
    '<div><h4>Contract Address</h4><p style="word-break:break-all">' +
    esc(c.address) +
    "</p>" +
    '<div class="actions"><button type="button" class="copy-ca-btn" data-copyca="' +
    esc(c.address) +
    '">Copy CA</button>' +
    '<button type="button" class="secondary" data-detail="' +
    esc(c.address) +
    '">Modal detail</button>' +
    '<button type="button" class="secondary" data-dd="' +
    esc(c.address) +
    '">Due diligence manual</button></div>' +
    '<p class="muted">DD manual: ' +
    (dd.completed_checks || 0) +
    "/6 cek · verdict " +
    esc(dd.final_verdict || "Pending") +
    " · skor DD " +
    (c.due_diligence_score || 0) +
    '/100 · Pair: <a href="' +
    esc(c.dexscreener_url || "#") +
    '" target="_blank" rel="noopener">DexScreener</a></p></div>' +
    "</div>"
  );
}
async function copyCa(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    // Fallback kompatibel webview: textarea sementara + execCommand.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) {
      ok = false;
    }
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? "Tersalin ✓" : "Gagal menyalin";
    setTimeout(() => {
      btn.textContent = old;
    }, 2000);
  }
  if (!ok) showToast("Clipboard tidak tersedia di webview ini — salin alamat manual dari teks CA.", true);
}
function openCandidateModal(address) {
  const c = allCandidates().find((x) => x.address === address);
  if (!c) return;
  $("candidateDetail").innerHTML = candidateDetailHtml(c);
  $("candidateModal").hidden = false;
  $("candidateDetail")
    .querySelectorAll("[data-copyca]")
    .forEach((b) => b.addEventListener("click", () => copyCa(b.dataset.copyca, b)));
  $("candidateDetail")
    .querySelectorAll("[data-dd]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        $("candidateModal").hidden = true;
        openDdModal(b.dataset.dd);
      }),
    );
}
const DD_CHECKS = [
  ["organic", "Organic score (GMGN)"],
  ["holders", "Distribusi holder (bubblemaps)"],
  ["bundling", "Bundling (isitbundled)"],
  ["cabal", "Kontrol cabal (gatekept / Padre)"],
  ["sameBlock", "Same-block buyers (DevsNightmareProbot)"],
  ["social", "Riwayat sosial (Fable intel)"],
];
function openDdModal(address) {
  const c = allCandidates().find((x) => x.address === address);
  if (!c) return;
  ddContext = c;
  // Cek lengkap tersimpan di state desk (dueDiligence per alamat); kandidat
  // hanya membawa ringkasannya di field due_diligence.
  const dd = ((deskState && deskState.dueDiligence) || {})[c.address] || { checks: {}, notes: "" };
  $("ddForm").innerHTML =
    "<p><strong>" +
    esc(c.symbol) +
    '</strong> <span class="chain-badge">' +
    esc(c.chain) +
    '</span><br><span class="muted" style="word-break:break-all">' +
    esc(c.address) +
    "</span></p>" +
    DD_CHECKS.map(
      ([key, label]) =>
        "<label>" +
        label +
        ' <select data-ddcheck="' +
        key +
        '">' +
        '<option value="pending"' +
        ((dd.checks?.[key] || "pending") === "pending" ? " selected" : "") +
        ">Belum diperiksa</option>" +
        '<option value="pass"' +
        (dd.checks?.[key] === "pass" ? " selected" : "") +
        ">Lolos</option>" +
        '<option value="warn"' +
        (dd.checks?.[key] === "warn" ? " selected" : "") +
        ">Peringatan</option>" +
        '<option value="fail"' +
        (dd.checks?.[key] === "fail" ? " selected" : "") +
        ">Gagal</option>" +
        "</select></label>",
    ).join("");
  $("ddNotes").value = dd.notes || "";
  setMsg("ddMsg", "");
  $("ddModal").hidden = false;
}
async function saveDd() {
  if (!ddContext) return;
  const checks = {};
  document.querySelectorAll("[data-ddcheck]").forEach((sel) => {
    checks[sel.dataset.ddcheck] = sel.value;
  });
  try {
    const r = await postJson("/api/dd", { address: ddContext.address, chain: ddContext.chain, symbol: ddContext.symbol, checks, notes: $("ddNotes").value });
    setMsg("ddMsg", "DD tersimpan. Verdict: " + r.dd.verdict + " (" + r.dd.completedChecks + "/6 cek).");
    candidatesData = await api("/api/candidates");
    await loadState();
    renderDiscover();
  } catch (e) {
    setMsg("ddMsg", e.friendly || e.message, true);
  }
}
async function loadCandidates(forceMsg) {
  try {
    candidatesData = await api("/api/candidates");
    const noteEl = $("discSourceNote");
    if (noteEl && candidatesData.source_note) noteEl.textContent = candidatesData.source_note;
    renderDiscover();
    if (forceMsg) setMsg("discMsg", "Kandidat diperbarui: " + allCandidates().length + " token (" + (candidatesData.recommendations || []).length + " berperingkat + " + (candidatesData.pending_candidates || []).length + " pending).");
  } catch (e) {
    setMsg("discMsg", "Gagal memuat kandidat: " + (e.friendly || e.message), true);
  }
}
function openPoolFromDiscover(address) {
  switchTab("copylp");
  $("copyCaInput").value = address;
  discoverCopyLp();
}

/* ---------------- Copy LP ---------------- */

async function discoverCopyLp() {
  const address = $("copyCaInput").value.trim();
  if (!address) {
    setMsg("copyMsg", "Tempel CA token dulu.", true);
    return;
  }
  setMsg("copyMsg", "Mencari pool di Meteora DLMM Data API + DexScreener…");
  try {
    copyDiscovery = await api("/api/copylp/discover?address=" + encodeURIComponent(address));
    copyTokenChange24h = copyDiscovery.token ? Number(copyDiscovery.token.change24h) || 0 : 0;
    const t = copyDiscovery.token;
    $("copyTokenHead").innerHTML =
      t ? "<h3>" + esc(t.name) + " (" + esc(t.symbol) + ") — " + fmtPrice(t.price) + " · MCap " + (t.marketCap ? fmtCompact(t.marketCap) : "—") + " · 24h " + (t.change24h >= 0 ? "+" : "") + t.change24h + "%</h3>" : "";
    setMsg("copyMsg", "Ditemukan " + copyDiscovery.meteoraCount + " pool Meteora DLMM + " + copyDiscovery.dexCount + " pool DexScreener." + (copyDiscovery.notes && copyDiscovery.notes.length ? " " + copyDiscovery.notes.join(" ") : ""));
    renderCopyPools();
    if (copyDiscovery.meteoraPools.length) selectCopyPool(copyDiscovery.meteoraPools[0]);
    else if (copyDiscovery.dexPools.length) selectCopyPool(copyDiscovery.dexPools[0]);
  } catch (e) {
    setMsg("copyMsg", e.friendly || e.message, true);
  }
}
function poolCardHtml(p, kind) {
  return (
    '<button type="button" class="pool-card" data-pooladdr="' +
    esc(p.poolAddress) +
    '" data-kind="' +
    kind +
    '">' +
    '<span class="pool-top"><span>' +
    esc(p.name) +
    ' <span class="chain-badge">' +
    esc(p.chain) +
    "</span></span><span>" +
    fmtPrice(p.price) +
    "</span></span>" +
    '<span class="pool-meta">' +
    esc(p.source) +
    " · " +
    esc(p.protocol) +
    " · Fee: " +
    (p.feePct == null ? "— (tidak dipublikasikan)" : fmtPct(p.feePct) + (p.baseFeePct != null ? " (base " + fmtPct(p.baseFeePct) + " + dinamis " + fmtPct(p.dynamicFeePct) + ")" : "")) +
    " · Bin step: " +
    (p.binStep == null ? "—" : p.binStep) +
    " · TVL/Likuiditas: " +
    fmtCompact(p.tvl) +
    " · Vol 24h: " +
    fmtCompact(p.volume24h) +
    (p.fees24h != null ? " · Fees 24h: " + fmtCompact(p.fees24h) + " · Fee/TVL 24h: " + fmtPct(p.feeTvl24hPct) + " · Est. APR: " + fmtPct(p.aprPct) : "") +
    "</span></button>"
  );
}
function renderCopyPools() {
  const box = $("copyPoolList");
  if (!copyDiscovery) {
    box.innerHTML = '<p class="muted">Belum ada discovery.</p>';
    return;
  }
  const m = copyDiscovery.meteoraPools || [];
  const d = copyDiscovery.dexPools || [];
  box.innerHTML =
    "<h4>Pool Meteora DLMM — Solana (" +
    m.length +
    ")</h4>" +
    (m.length ? m.map((p) => poolCardHtml(p, "meteora")).join("") : '<p class="muted">Tidak ada pool Meteora untuk CA ini.</p>') +
    "<h4>Pool DexScreener — semua chain (" +
    d.length +
    ")</h4>" +
    (d.length ? d.map((p) => poolCardHtml(p, "dex")).join("") : '<p class="muted">Tidak ada pool DexScreener untuk CA ini.</p>');
  box.querySelectorAll(".pool-card").forEach((card) => {
    card.addEventListener("click", () => {
      const all = m.concat(d);
      const pool = all.find((p) => p.poolAddress === card.dataset.pooladdr);
      if (pool) selectCopyPool(pool);
    });
  });
}
function selectCopyPool(pool) {
  copySelectedPool = pool;
  document.querySelectorAll(".pool-card").forEach((c) => c.classList.toggle("selected", c.dataset.pooladdr === pool.poolAddress));
  $("zapPoolInfo").textContent = "Pool terpilih: " + pool.name + " (" + pool.source + ", " + pool.chain + ") · harga " + fmtPrice(pool.price);
  const stats = [
    ["Harga", fmtPrice(pool.price)],
    ["MCap token", pool.marketCap ? fmtCompact(pool.marketCap) : "—"],
    ["TVL", fmtCompact(pool.tvl)],
    ["Volume 24h", fmtCompact(pool.volume24h)],
    ["Fees 24h", pool.fees24h == null ? "—" : fmtCompact(pool.fees24h)],
    ["Fee/TVL 24h", pool.feeTvl24hPct == null ? "—" : fmtPct(pool.feeTvl24hPct)],
    ["Est. fee APR", pool.aprPct == null ? "—" : fmtPct(pool.aprPct)],
    ["Bin step", pool.binStep == null ? "—" : pool.binStep],
  ];
  $("copyStats").innerHTML = stats.map(([k, v]) => "<div><span>" + k + "</span><strong>" + v + "</strong></div>").join("");
  applyZapRange("auto");
  loadPoolPositions();
}
async function applyZapRange(mode) {
  const pool = copySelectedPool;
  if (!pool) return;
  const price = Number(pool.price) || 0;
  if (!(price > 0)) return;
  const strategy = $("zapStrategy").value;
  if (mode === "auto") {
    try {
      const r = await postJson("/api/copylp/range", { price, binStepBps: pool.binStep || 25, strategy, change24h: copyTokenChange24h });
      $("zapMin").value = r.minPrice;
      $("zapMax").value = r.maxPrice;
      $("zapRangeInfo").textContent = "Range server dari volatilitas 24j + bin step " + (pool.binStep || 25) + ": bins " + r.lowerBin + " … +" + r.upperBin + " (step " + r.stepPct + "%/bin).";
      pool._range = r;
    } catch (e) {
      setMsg("zapMsg", e.friendly || e.message, true);
    }
  } else {
    const presets = { both5: [-5, 5], both10: [-10, 10], below50: [-50, 0], below70: [-70, 0] };
    const pr = presets[mode];
    if (pr) {
      $("zapMin").value = fmtPrice(price * (1 + pr[0] / 100));
      $("zapMax").value = fmtPrice(price * (1 + pr[1] / 100));
      pool._range = null;
    }
  }
  updateZapNote();
  updateZapSummary();
}
function updateZapNote() {
  const pool = copySelectedPool;
  const note = $("zapRangeNote");
  if (!pool) {
    note.textContent = "";
    return;
  }
  const min = Number($("zapMin").value) || 0;
  const max = Number($("zapMax").value) || 0;
  const spot = Number(pool.price) || 0;
  if (max > 0 && max <= spot) note.textContent = "Catatan: seluruh range di bawah harga saat ini (" + fmtPrice(spot) + ").";
  else if (min > 0 && min >= spot) note.textContent = "Catatan: seluruh range di atas harga saat ini (" + fmtPrice(spot) + ").";
  else if (min > 0 && max > min) note.textContent = "Catatan: harga saat ini (" + fmtPrice(spot) + ") berada di dalam range.";
  else note.textContent = "";
}
function updateZapSummary() {
  const pool = copySelectedPool;
  const box = $("zapSummary");
  if (!pool) {
    box.innerHTML = '<span class="muted">Pilih pool dulu.</span>';
    return;
  }
  box.innerHTML =
    "<div><span>Deposit</span><strong>" +
    fmtMoney(Number($("zapAmount").value) || 0) +
    " (" +
    ($("zapMode").value === "zap" ? "Zap In" : "Kedua token") +
    ")</strong></div>" +
    "<div><span>Price range</span><strong>" +
    fmtPrice(Number($("zapMin").value) || 0) +
    " – " +
    fmtPrice(Number($("zapMax").value) || 0) +
    "</strong></div>" +
    "<div><span>Current price</span><strong>" +
    fmtPrice(pool.price) +
    "</strong></div>" +
    "<div><span>Slippage</span><strong>" +
    (Number($("zapSlippage").value) || 0) +
    "%</strong></div>" +
    "<div><span>Pool</span><strong>" +
    esc(pool.name) +
    " · " +
    esc(pool.chain) +
    "</strong></div>";
}
async function zapOpen() {
  const pool = copySelectedPool;
  if (!pool) {
    setMsg("zapMsg", "Pilih pool dulu dari daftar.", true);
    return;
  }
  const amount = Number($("zapAmount").value) || 0;
  const minPrice = Number($("zapMin").value) || 0;
  const maxPrice = Number($("zapMax").value) || 0;
  if (!(amount > 0)) {
    setMsg("zapMsg", "Nominal harus lebih dari 0.", true);
    return;
  }
  if (minPrice <= 0 || maxPrice <= minPrice) {
    setMsg("zapMsg", "Range min/max tidak valid.", true);
    return;
  }
  try {
    const r = await postJson("/api/copylp/open", {
      chain: pool.chain,
      source: pool.source,
      poolAddress: pool.poolAddress,
      tokenAddress: pool.tokenAddress,
      symbol: pool.baseSymbol,
      name: pool.name,
      price: pool.price,
      amount,
      minPrice,
      maxPrice,
      lowerBin: pool._range ? pool._range.lowerBin : null,
      upperBin: pool._range ? pool._range.upperBin : null,
      strategy: $("zapStrategy").value,
      binStepBps: pool.binStep || 25,
      pairUrl: pool.pairUrl || "",
    });
    setMsg("zapMsg", "Posisi Copy LP dibuka: " + r.position.symbol + " di " + r.position.chain + " sebesar " + fmtMoney(r.position.amount) + " (pool_address tersimpan).");
    await loadState();
    loadPoolPositions();
  } catch (e) {
    setMsg("zapMsg", e.friendly || e.message, true);
  }
}
async function loadPoolPositions() {
  const box = $("poolPositions");
  const pool = copySelectedPool;
  if (!pool) {
    box.innerHTML = '<p class="muted">Pilih pool untuk melihat posisi desk di pool itu.</p>';
    return;
  }
  try {
    const data = await api("/api/copylp/pool-positions?pool=" + encodeURIComponent(pool.poolAddress));
    const list = data.positions || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted">Belum ada posisi desk di pool ini (status kosong — jujur, bukan data orang lain).</p>';
      return;
    }
    box.innerHTML =
      '<table class="mini-table"><thead><tr><th>Posisi</th><th>Value</th><th>Fee</th><th>uPnL</th><th>Age</th><th>Range</th><th>Status</th><th>Aksi</th></tr></thead><tbody>' +
      list
        .map(
          (p) =>
            "<tr><td>" +
            esc(p.symbol) +
            " #" +
            esc(String(p.id).slice(-4)) +
            '<br><span class="muted">' +
            esc(p.status) +
            "</span></td>" +
            "<td>" +
            fmtMoney(p.value) +
            "</td><td>" +
            fmtMoney((Number(p.fees) || 0) + (Number(p.rewards) || 0)) +
            "</td>" +
            '<td class="' +
            (p.upnl >= 0 ? "pos" : "neg") +
            '">' +
            fmtMoney(p.upnl) +
            "</td>" +
            "<td>" +
            p.ageHours +
            " jam</td><td>" +
            fmtPrice(p.minPrice) +
            " – " +
            fmtPrice(p.maxPrice) +
            "</td>" +
            "<td>" +
            (p.status === "open" ?
              p.inRange ?
                '<span class="range-ok">IN</span>'
              : '<span class="range-out">OUT</span>'
            : "—") +
            "</td>" +
            "<td>" +
            (p.status === "open" ?
              '<button type="button" data-pp="claim" data-id="' +
              p.id +
              '">Claim</button> <button type="button" class="secondary" data-pp="rebalance" data-id="' +
              p.id +
              '">Rebalance</button> <button type="button" class="secondary" data-pp="close" data-id="' +
              p.id +
              '">Close</button>'
            : "") +
            "</td></tr>",
        )
        .join("") +
      "</tbody></table>";
    box.querySelectorAll("[data-pp]").forEach((b) => b.addEventListener("click", () => handlePositionAction(b.dataset.pp, b.dataset.id, b).then(loadPoolPositions)));
  } catch (e) {
    box.innerHTML = '<p class="muted">Gagal memuat posisi pool.</p>';
  }
}
async function runCopyMonitor(quiet) {
  copyMonitorStarted = true;
  const out = $("copyMonitorOut");
  if (quiet !== true) out.innerHTML = '<p class="muted">Memeriksa posisi Copy LP dari harga live…</p>';
  try {
    const r = await postJson("/api/copylp/monitor", {});
    if (!r.positions.length) {
      out.innerHTML = '<p class="muted">Tidak ada posisi Copy LP terbuka dengan pool_address.</p>';
      return;
    }
    out.innerHTML =
      "<p>Diperiksa: " +
      r.checked +
      " posisi · di luar range: " +
      r.outOfRange +
      "</p>" +
      r.positions
        .map(
          (p) =>
            '<div class="mon-row"><strong>' +
            esc(p.symbol) +
            '</strong> <span class="chain-badge">' +
            esc(p.chain) +
            "</span> harga live " +
            fmtPrice(p.livePrice) +
            " · range " +
            fmtPrice(p.minPrice) +
            " – " +
            fmtPrice(p.maxPrice) +
            " · " +
            (p.inRange ? '<span class="range-ok">IN RANGE</span>' : '<span class="range-out">OUT OF RANGE</span>') +
            '<br><span class="muted">' +
            esc(p.suggestion) +
            "</span> " +
            '<button type="button" class="secondary" data-mon="rebalance" data-id="' +
            p.id +
            '">Rebalance</button> ' +
            '<button type="button" class="secondary" data-mon="claim" data-id="' +
            p.id +
            '">Claim</button> ' +
            '<button type="button" class="secondary" data-mon="close" data-id="' +
            p.id +
            '">Close</button></div>',
        )
        .join("");
    out.querySelectorAll("[data-mon]").forEach((b) => b.addEventListener("click", () => handlePositionAction(b.dataset.mon, b.dataset.id, b).then(runCopyMonitor)));
    await loadState();
  } catch (e) {
    out.innerHTML = '<p class="muted">Monitor gagal: ' + esc(e.friendly || e.message) + "</p>";
  }
}

/* ---------------- Kopi — Copy Trading LP ---------------- */

function sortedLeadersClient() {
  const list = ((deskState && deskState.leaders) || []).slice();
  return list.sort((a, b) => (Number(b.winrate) || 0) - (Number(a.winrate) || 0));
}
function renderLeaders() {
  const list = sortedLeadersClient();
  const box = $("leaderList");
  const sel = $("kopiLeaderSelect");
  const currentSel = settings.copyTrading.leaderId || "";
  sel.innerHTML = '<option value="">Otomatis — peringkat #1</option>' + list.map((l) => '<option value="' + l.id + '"' + (currentSel === l.id ? " selected" : "") + ">" + esc(l.label) + " (" + l.winrate + "%)</option>").join("");
  if (!list.length) {
    box.innerHTML = '<p class="muted">Watchlist kosong. Tambahkan leader pertama lewat formulir di atas — data yang kamu masukkan sendiri dari Smart LP/platform lain (input manual, bukan data live).</p>';
    return;
  }
  box.innerHTML = list
    .map(
      (l, i) =>
        '<div class="leader-card"><div class="leader-top"><strong>' +
        esc(l.label) +
        "</strong>" +
        (i === 0 ? '<span class="leader-badge">LEADER COPY</span>' : "") +
        "</div>" +
        '<div class="manual-note">input manual — bukan data live</div>' +
        '<div class="leader-meta">Wallet: ' +
        esc(l.wallet) +
        "<br>Chain: " +
        esc(l.chain) +
        " · Platform: " +
        esc(l.platform) +
        " · Winrate: " +
        l.winrate +
        "% · Total PnL: " +
        fmtMoney(l.totalPnl) +
        " · Hold: " +
        esc(l.holdTime || "—") +
        " · Strategi: " +
        esc(l.strategy) +
        (l.favoriteToken ? "<br>Token favorit: " + esc(l.favoriteToken) : "") +
        "</div>" +
        '<div class="actions"><button type="button" class="secondary" data-leader-edit="' +
        l.id +
        '">Edit</button>' +
        '<button type="button" class="secondary" data-leader-del="' +
        l.id +
        '">Hapus leader</button></div></div>',
    )
    .join("");
  box.querySelectorAll("[data-leader-edit]").forEach((b) => b.addEventListener("click", () => fillLeaderForm(b.dataset.leaderEdit)));
  box.querySelectorAll("[data-leader-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await postJson("/api/leaders/delete", { id: b.dataset.leaderDel });
        await loadState();
        renderLeaders();
        setMsg("leaderMsg", "Leader dihapus.");
      } catch (e) {
        setMsg("leaderMsg", e.friendly || e.message, true);
      }
    }),
  );
}
function fillLeaderForm(id) {
  const l = ((deskState && deskState.leaders) || []).find((x) => x.id === id);
  if (!l) return;
  $("leaderId").value = l.id;
  $("leaderLabel").value = l.label;
  $("leaderWallet").value = l.wallet;
  $("leaderChain").value = l.chain;
  $("leaderPlatform").value = l.platform;
  $("leaderWinrate").value = l.winrate;
  $("leaderPnl").value = l.totalPnl;
  $("leaderHold").value = l.holdTime || "";
  $("leaderStrategy").value = l.strategy;
  $("leaderFav").value = l.favoriteToken || "";
  $("leaderCancelEditBtn").hidden = false;
}
function clearLeaderForm() {
  $("leaderId").value = "";
  $("leaderLabel").value = "";
  $("leaderWallet").value = "";
  $("leaderWinrate").value = "";
  $("leaderPnl").value = "";
  $("leaderHold").value = "";
  $("leaderFav").value = "";
  $("leaderCancelEditBtn").hidden = true;
}
async function saveLeader() {
  const id = $("leaderId").value;
  const body = {
    label: $("leaderLabel").value.trim(),
    wallet: $("leaderWallet").value.trim(),
    chain: $("leaderChain").value,
    platform: $("leaderPlatform").value.trim(),
    winrate: Number($("leaderWinrate").value),
    totalPnl: Number($("leaderPnl").value) || 0,
    holdTime: $("leaderHold").value.trim(),
    strategy: $("leaderStrategy").value,
    favoriteToken: $("leaderFav").value.trim(),
  };
  try {
    if (id) await postJson("/api/leaders/update", { id, ...body });
    else await postJson("/api/leaders", body);
    clearLeaderForm();
    await loadState();
    renderLeaders();
    setMsg("leaderMsg", "Leader tersimpan (input manual — bukan data live).");
  } catch (e) {
    setMsg("leaderMsg", e.friendly || e.message, true);
  }
}
function fillKopiForm() {
  const ct = settings.copyTrading;
  $("kopiEnabled").checked = !!ct.enabled;
  $("kopiAmount").value = ct.amountPerCopy;
  $("kopiMaxPos").value = ct.maxPositions;
  $("kopiRange").value = ct.rangePreset;
  $("kopiDailyLoss").value = ct.dailyLossLimit;
  renderLeaders();
  renderAgentLogs("kopiLogs", "Kopi");
}
function readKopiForm() {
  const ct = settings.copyTrading;
  ct.enabled = $("kopiEnabled").checked;
  ct.leaderId = $("kopiLeaderSelect").value || null;
  ct.amountPerCopy = Number($("kopiAmount").value) || 0;
  ct.maxPositions = Number($("kopiMaxPos").value) || 0;
  ct.rangePreset = $("kopiRange").value;
  ct.dailyLossLimit = Number($("kopiDailyLoss").value) || 0;
}
async function runKopi() {
  readKopiForm();
  try {
    await saveSettings();
  } catch (e) {
    $("kopiRunOut").innerHTML = '<p class="muted">' + esc(e.friendly || e.message) + "</p>";
    return;
  }
  $("kopiRunOut").innerHTML = '<p class="muted">Kopi menjalankan copy (simulasi)…</p>';
  try {
    const r = await postJson("/api/agent/copy-trading", { action: "run" });
    const lines = [];
    if (r.leader) lines.push("Leader: <strong>" + esc(r.leader.label) + "</strong> (winrate " + r.leader.winrate + "%)");
    (r.opened || []).forEach((o) => lines.push("Dibuka: " + esc(o.symbol) + " (" + esc(o.chain) + ") " + fmtMoney(o.amount) + " @ " + fmtPrice(o.price)));
    (r.skipped || []).forEach((s) => lines.push("Dilewati: " + esc(s.symbol) + " — " + esc(s.reason)));
    $("kopiRunOut").innerHTML = "<ul>" + lines.map((l) => "<li>" + l + "</li>").join("") + "</ul>";
    await loadState();
    renderLeaders();
    renderAgentLogs("kopiLogs", "Kopi");
  } catch (e) {
    $("kopiRunOut").innerHTML = '<p class="muted">' + esc(e.friendly || e.message) + "</p>";
  }
}
async function scanNaraV4Pools() {
  const box = $("naraV4Pools");
  box.textContent = "Memuat pool Uniswap v4 multi-network dan menghitung estimasi APR…";
  try {
    const out = await api("/api/uniswap-v4/pools");
    const rows = (out.pools || []).slice(0, 10);
    if (!rows.length) {
      box.textContent = "Belum ada pool yang memenuhi batas umur, TVL, volume, dan fee tier yang dapat dibaca.";
      return;
    }
    box.innerHTML = '<p><strong>Pool Uniswap v4 multi-network (estimasi APR):</strong></p><ul>' + rows.map((p) =>
      "<li>" + esc(p.chainName) + " · " + esc(p.token0.symbol) + "/" + esc(p.token1.symbol) + " — " + Number(p.apr).toFixed(2) + "% APR · fee tier " + Number(p.feePercent).toFixed(4) + "% · TVL " + fmtMoney(p.tvlUsd) + " · estimasi fee 24j " + fmtMoney(p.estimatedFees24hUsd) + "</li>"
    ).join("") + "</ul><p class=\"muted\">" + esc(out.aprFormula) + "</p>" +
      (out.failedNetworks && out.failedNetworks.length ? '<p class="muted">Sebagian network gagal dimuat: ' + esc(out.failedNetworks.map((n) => n.chain).join(", ")) + ".</p>" : "");
  } catch (e) {
    box.textContent = e.status === 404 && e.message === "Endpoint tidak ditemukan."
      ? "Rute APR v4 belum tersedia pada backend yang berjalan. Hentikan server lama lalu jalankan ulang dengan `npm start`."
      : (e.details && e.details.failedNetworks && e.details.failedNetworks.length
        ? (e.friendly || e.message) + " Network gagal: " + e.details.failedNetworks.map((n) => n.chain).join(", ") + "."
        : e.friendly || e.message);
  }
}

async function runNara() {
  readNaraForm();
  try {
    await saveSettings();
  } catch (e) {
    $("naraRunOut").innerHTML = '<p class="muted">' + esc(e.friendly || e.message) + "</p>";
    return;
  }
  $("naraRunOut").innerHTML = '<p class="muted">' + (settings.autoTrading.source === "UNISWAP_V4" ? "Nara memindai pool Uniswap v4 multi-network dengan APR minimum…" : "Nara memindai Top 10 agent API…") + "</p>";
  try {
    const r = await postJson("/api/agent/auto-trading", { action: "run" });
    const lines = [];
    if (r.stoppedByDailyLoss) lines.push("Berhenti: batas kerugian harian tercapai (PnL hari ini " + fmtMoney(r.todayPnl) + ").");
    (r.opened || []).forEach((o) => lines.push("Dibuka: " + esc(o.symbol) + " (" + esc(o.chain) + ") " + fmtMoney(o.amount) + " @ " + fmtPrice(o.price) + (o.apr == null ? "" : " · APR v4 " + Number(o.apr).toFixed(2) + "% historis")));
    (r.skipped || []).forEach((s) => lines.push("Dilewati: " + esc(s.symbol) + " — " + esc(s.reason)));
    $("naraRunOut").innerHTML = "<ul>" + lines.map((l) => "<li>" + l + "</li>").join("") + "</ul>";
    await loadState();
    renderAgentLogs("naraLogs", "Nara");
  } catch (e) {
    $("naraRunOut").innerHTML = '<p class="muted">' + esc(e.friendly || e.message) + "</p>";
  }
}

/* ---------------- Nara: jalan otomatis tiap 5 menit ----------------
   Hanya berjalan bila Auto Trading LP aktif. Tidak membaca ulang form agar
   nilai yang sedang diedit pengguna tidak tertimpa. */

const NARA_INTERVAL_MS = 5 * 60 * 1000;
let naraTimer = null;
let naraBusy = false;

async function naraAutoTick() {
  if (naraBusy || !settings || !settings.autoTrading.enabled) return;
  naraBusy = true;
  try {
    const r = await postJson("/api/agent/auto-trading", { action: "run" });
    if ((r.opened || []).length) showToast("Nara membuka " + r.opened.length + " LP baru.");
    if (!liveGuardBlocked()) await loadState();
    renderAgentLogs("naraLogs", "Nara");
  } catch (_) {
    /* error tercatat di log agent oleh server */
  } finally {
    naraBusy = false;
  }
}

function startNaraSchedule() {
  if (naraTimer) clearInterval(naraTimer);
  naraTimer = setInterval(naraAutoTick, NARA_INTERVAL_MS);
}

/* ---------------- Tabs, modals, init ---------------- */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "monthly") {
    renderMonthly();
    renderCardPreview();
  }
  if (name === "toplp" && !candidatesData) loadCandidates(false);
}
function openAgentModal(name) {
  if (name === "nara") {
    fillNaraForm();
    $("naraModal").hidden = false;
  }
  if (name === "byte") {
    fillByteForm();
    $("byteModal").hidden = false;
  }
  if (name === "sora") {
    renderSora();
    $("soraModal").hidden = false;
  }
  if (name === "kopi") {
    fillKopiForm();
    $("kopiModal").hidden = false;
  }
}
function fillChainSelects() {
  $("lpChain").innerHTML = '<option value="AUTO">Auto (deteksi dari pair)</option>' + CHAINS.map((c) => '<option value="' + c + '">' + c + "</option>").join("");
  $("naraChain").innerHTML = '<option value="ALL">Semua</option>' + CHAINS.map((c) => '<option value="' + c + '">' + c + "</option>").join("");
  $("tradeChain").innerHTML = CHAINS.map((c) => '<option value="' + c + '">' + c + "</option>").join("");
  $("leaderChain").innerHTML = CHAINS.map((c) => '<option value="' + c + '">' + c + "</option>").join("");
  $("discChain").innerHTML = '<option value="ALL">Semua</option>' + CHAINS.map((c) => '<option value="' + c + '">' + c + "</option>").join("");
}
let currentAccount = null;
let authRegisterMode = false;
function setAuthMode(register) {
  authRegisterMode = register;
  $("authTitle").textContent = register ? "Buat akun" : "Masuk ke desk";
  $("authSubmit").textContent = register ? "Daftar" : "Masuk";
  $("displayNameField").hidden = !register;
  $("authPassword").autocomplete = register ? "new-password" : "current-password";
  $("authModeToggle").textContent = register ? "Sudah punya akun? Masuk" : "Belum punya akun? Daftar";
  $("authError").textContent = "";
}
function showAuth(message) {
  $("authScreen").hidden = false;
  $("accountBar").hidden = true;
  $("socialScreen").hidden = true;
  $("profileEditor").hidden = true;
  $("app").hidden = true;
  if (message) $("authError").textContent = message;
}
function publicProfileMarkup(profile, followed) {
  const positions = (profile.positions || []).map((position) => '<article class="social-item"><h3>' + esc(position.symbol || "LP") + ' · ' + esc(position.chain || "") + '</h3><p>' + esc(position.product || "") + ' · ' + esc(position.status || "") + '</p><p>Entry ' + esc(String(position.entryPrice ?? "—")) + ' · Current ' + esc(String(position.currentPrice ?? "—")) + '</p><p>Nilai ' + fmtMoney(position.positionValue) + ' · PnL ' + fmtMoney(position.netPnl) + '</p></article>').join("");
  const avatar = profile.avatarUrl ? '<img class="social-avatar" src="' + esc(profile.avatarUrl) + '" alt="Avatar ' + esc(profile.displayName) + '" />' : '<div class="social-avatar" aria-hidden="true"></div>';
  return '<div class="social-banner"></div><div class="social-user">' + avatar + '<div><h1>' + esc(profile.displayName || profile.username) + '</h1><p class="muted">@' + esc(profile.username) + ' · ' + Number(profile.followers || 0) + ' followers</p></div></div>' +
    (profile.discordName ? '<p>Discord: ' + esc(profile.discordName) + '</p>' : "") + (profile.bio ? '<p>' + esc(profile.bio) + '</p>' : "") +
    (profile.netWorth != null ? '<article class="social-item"><strong>Net worth simulasi: ' + fmtMoney(profile.netWorth) + '</strong><p class="muted small">Simulasi, bukan performa atau dana nyata.</p></article>' : "") +
    (profile.positions ? '<h2>Posisi yang dibagikan</h2><p class="muted small">Semua posisi di bawah ini simulasi.</p><div class="social-grid">' + (positions || '<p>Tidak ada posisi.</p>') + '</div>' : '<p class="muted">Posisi tidak dibagikan.</p>') +
    (currentAccount && currentAccount.username !== profile.username ? '<button id="followProfileBtn" type="button">' + (followed ? "Unfollow" : "Follow") + '</button>' : "");
}
async function renderSocialRoute() {
  const path = location.pathname;
  $("app").hidden = true;
  $("authScreen").hidden = true;
  $("socialScreen").hidden = false;
  const content = $("socialContent");
  content.innerHTML = '<p class="muted">Memuat…</p>';
  if (path === "/leaderboard") {
    const data = await api("/api/leaderboard");
    const rows = (data.leaderboard || []).map((item, index) => '<article class="social-item"><h3>#' + (index + 1) + ' · <a href="/u/' + encodeURIComponent(item.username) + '">' + esc(item.displayName || item.username) + '</a></h3><p>@' + esc(item.username) + (item.netWorth != null ? ' · ' + fmtMoney(item.netWorth) + ' net worth simulasi' : "") + '</p><p class="muted small">Peringkat berdasarkan net worth simulasi, bukan hasil trading nyata.</p></article>').join("");
    content.innerHTML = '<p class="eyebrow">KOMUNITAS</p><h1>Leaderboard simulasi</h1><p class="muted">Hanya akun yang memilih tampil. Net worth hanya ditampilkan jika dibagikan.</p><div class="social-grid">' + (rows || '<p>Belum ada akun yang memilih tampil.</p>') + '</div>';
    return;
  }
  if (path === "/following") {
    if (!currentAccount) return showAuth("Masuk untuk melihat akun yang kamu ikuti.");
    const data = await api("/api/following");
    const rows = (data.following || []).map((item) => '<article class="social-item"><h3><a href="/u/' + encodeURIComponent(item.username) + '">' + esc(item.displayName || item.username) + '</a></h3><p>@' + esc(item.username) + '</p>' + (item.netWorth != null ? '<p>Net worth simulasi: ' + fmtMoney(item.netWorth) + '</p>' : '<p class="muted">Net worth tidak dibagikan.</p>') + '</article>').join("");
    content.innerHTML = '<p class="eyebrow">KOMUNITAS</p><h1>Following</h1><div class="social-grid">' + (rows || '<p>Kamu belum mengikuti akun. Kunjungi profil publik untuk follow.</p>') + '</div>';
    return;
  }
  const match = path.match(/^\/u\/([^/]+)\/?$/);
  if (match) {
    const username = decodeURIComponent(match[1]);
    const profile = await api("/api/profiles/" + encodeURIComponent(username));
    let followed = false;
    if (currentAccount) {
      const followData = await api("/api/following");
      followed = (followData.following || []).some((item) => item.username === profile.username);
    }
    content.innerHTML = publicProfileMarkup(profile, followed);
    if (profile.bannerUrl) {
      const banner = content.querySelector(".social-banner");
      banner.style.backgroundImage = "url('" + encodeURI(new URL(profile.bannerUrl).href).replace(/'/g, "%27") + "')";
    }
    const followButton = $("followProfileBtn");
    if (followButton) followButton.addEventListener("click", async () => {
      followButton.disabled = true;
      try {
        await postJson("/api/following", { username: profile.username, action: followed ? "unfollow" : "follow" });
        await renderSocialRoute();
      } catch (error) { followButton.disabled = false; showToast(error.friendly || error.message, true); }
    });
  }
}
async function loadProfileEditor() {
  const profile = await api("/api/profile");
  $("profileDisplayName").value = profile.displayName || "";
  $("profileDiscord").value = profile.discordName || "";
  $("profileBio").value = profile.bio || "";
  $("profileAvatar").value = profile.avatarUrl || "";
  $("profileBanner").value = profile.bannerUrl || "";
  $("sharePositions").checked = profile.sharePositions === true;
  $("shareNetWorth").checked = profile.shareNetWorth === true;
  $("showOnLeaderboard").checked = profile.showOnLeaderboard === true;
  $("profileMessage").textContent = "";
  $("profileEditor").hidden = false;
  $("profileDisplayName").focus();
}
function markAccountNav(path) {
  document.querySelectorAll("[data-account-nav]").forEach((link) => {
    const active = new URL(link.href).pathname === path;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}
async function bootstrapAccount() {
  const me = await api("/api/auth/me");
  currentAccount = me.user;
  const path = location.pathname;
  const socialRoute = path === "/following" || path === "/leaderboard" || /^\/u\/[^/]+\/?$/.test(path);
  if (socialRoute) {
    $("accountBar").hidden = !currentAccount;
    if (currentAccount) {
      $("accountLabel").textContent = "@" + currentAccount.username;
      $("myProfileLink").href = "/u/" + encodeURIComponent(currentAccount.username);
    }
    markAccountNav(path);
    if (path === "/following" && !currentAccount) return showAuth("Masuk untuk melihat akun yang kamu ikuti.");
    await renderSocialRoute();
    return;
  }
  if (!currentAccount) return showAuth();
  $("authScreen").hidden = true;
  $("socialScreen").hidden = true;
  $("app").hidden = false;
  $("accountBar").hidden = false;
  $("accountLabel").textContent = "@" + currentAccount.username;
  $("myProfileLink").href = "/u/" + encodeURIComponent(currentAccount.username);
  markAccountNav(path);
  await loadState();
  refreshRealtime();
  startRealtime();
  startNaraSchedule();
}
function bindAccountUi() {
  $("authModeToggle").addEventListener("click", () => setAuthMode(!authRegisterMode));
  $("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("authSubmit").disabled = true;
    $("authError").textContent = "";
    try {
      const payload = { username: $("authUsername").value, password: $("authPassword").value };
      if (authRegisterMode && $("authDisplayName").value.trim()) payload.displayName = $("authDisplayName").value.trim();
      await postJson(authRegisterMode ? "/api/auth/register" : "/api/auth/login", payload);
      location.href = "/";
    } catch (error) { $("authError").textContent = error.friendly || error.message; }
    finally { $("authSubmit").disabled = false; }
  });
  $("logoutBtn").addEventListener("click", async () => {
    try { await postJson("/api/auth/logout", {}); } catch (_) {}
    clearInterval(rtTimer);
    clearInterval(rtCountdownTimer);
    deskState = null;
    currentAccount = null;
    location.href = "/";
  });
  $("editProfileBtn").addEventListener("click", () => loadProfileEditor().catch((error) => showToast(error.message, true)));
  const closeProfileEditor = () => {
    $("profileEditor").hidden = true;
    $("editProfileBtn").focus();
  };
  $("closeProfileBtn").addEventListener("click", closeProfileEditor);
  $("profileEditor").addEventListener("click", (event) => { if (event.target === $("profileEditor")) closeProfileEditor(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("profileEditor").hidden) closeProfileEditor();
  });
  $("profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      displayName: $("profileDisplayName").value, discordName: $("profileDiscord").value, bio: $("profileBio").value,
      avatarUrl: $("profileAvatar").value, bannerUrl: $("profileBanner").value,
      sharePositions: $("sharePositions").checked, shareNetWorth: $("shareNetWorth").checked,
      showOnLeaderboard: $("showOnLeaderboard").checked,
    };
    try {
      await postJson("/api/profile", payload);
      $("profileMessage").textContent = "Profil tersimpan.";
      currentAccount.displayName = payload.displayName;
      $("accountLabel").textContent = "@" + currentAccount.username;
    } catch (error) { $("profileMessage").textContent = error.friendly || error.message; }
  });
}
function init() {
  if (location.protocol === "file:") $("fileWarning").hidden = false;
  initPwa();
  initNotificationSettings();
  initBrowserWallet();
  fillChainSelects();
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll("[data-agent]").forEach((el) => el.addEventListener("click", () => openAgentModal(el.dataset.agent)));
  document.querySelectorAll(".modal-close").forEach((b) =>
    b.addEventListener("click", () => {
      $(b.dataset.close).hidden = true;
    }),
  );
  document.querySelectorAll(".modal").forEach((m) =>
    m.addEventListener("click", (e) => {
      if (e.target === m) m.hidden = true;
    }),
  );

  $("lpSearchBtn").addEventListener("click", searchLpTokens);
  $("lpOpenBtn").addEventListener("click", openLp);
  const doRefreshSimulation = async () => {
    try {
      const r = await postJson("/api/lp/refresh", {});
      setMsg("lpMsg", "Refresh selesai. Fee terakru (simulasi): " + fmtMoney(r.accrued) + " — tercatat di ledger Monthly Profit.");
      await loadState();
    } catch (e) {
      setMsg("lpMsg", e.friendly || e.message, true);
    }
  };
  $("lpRefreshBtn").addEventListener("click", doRefreshSimulation);
  // Hero: navigasi cepat + refresh simulasi (alur yang sama dengan panel).
  $("heroRefreshBtn").addEventListener("click", doRefreshSimulation);
  $("heroCopyBtn").addEventListener("click", () => switchTab("copylp"));
  $("heroTopBtn").addEventListener("click", () => switchTab("toplp"));
  $("heroOpenBtn").addEventListener("click", () => {
    switchTab("desk");
    $("openLpPanel").scrollIntoView();
  });
  // Open LP: kontrol segmented gaya hosted (preset range / strategi / side).
  document.querySelectorAll("#lpPresetSeg [data-preset]").forEach((b) => b.addEventListener("click", () => applyLpPreset(b.dataset.preset)));
  ["lpMinPct", "lpMaxPct"].forEach((id) =>
    $(id).addEventListener("input", () => {
      if (lpPreset !== "custom") applyLpPreset("custom");
    }),
  );
  document.querySelectorAll("#lpStrategySeg [data-strategy]").forEach((b) =>
    b.addEventListener("click", () => {
      lpStrategyVal = b.dataset.strategy;
      document.querySelectorAll("#lpStrategySeg [data-strategy]").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  document.querySelectorAll("#lpSideSeg [data-side]").forEach((b) =>
    b.addEventListener("click", () => {
      lpSideVal = b.dataset.side;
      document.querySelectorAll("#lpSideSeg [data-side]").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  $("lpDistribution").addEventListener("change", updateDistBar);
  updateDistBar();
  // Desk LP: kategori, Networth/Calendar, pencarian, urutan, dan layout.
  document.querySelectorAll("#posFilterSeg [data-pfilter]").forEach((b) =>
    b.addEventListener("click", () => {
      posStatusFilter = b.dataset.pfilter;
      renderPositions();
    }),
  );
  document.querySelectorAll("#deskModeSeg [data-dmode]").forEach((b) =>
    b.addEventListener("click", () => {
      deskMode = b.dataset.dmode;
      renderPositions();
    }),
  );
  document.querySelectorAll("#posLayoutSeg [data-layout]").forEach((b) =>
    b.addEventListener("click", () => {
      posLayout = b.dataset.layout;
      renderPositions();
    }),
  );
  $("posSearch").addEventListener("input", () => {
    posSearchQuery = $("posSearch").value;
    renderPositions();
  });
  $("posSort").addEventListener("change", () => {
    posSortOrder = $("posSort").value;
    renderPositions();
  });
  document.querySelectorAll("#balCurSeg [data-cur]").forEach((b) =>
    b.addEventListener("click", () => {
      balanceCurrency = b.dataset.cur;
      renderBalances();
    }),
  );
  $("rateIdr").value = balanceRates.idr || "";
  $("rateEth").value = balanceRates.eth || "";
  $("rateIdr").addEventListener("input", () => {
    balanceRates.idr = Number($("rateIdr").value) || 0;
    localStorage.setItem("rcslpv4-rate-idr", String(balanceRates.idr));
    renderBalances();
  });
  $("rateEth").addEventListener("input", () => {
    balanceRates.eth = Number($("rateEth").value) || 0;
    localStorage.setItem("rcslpv4-rate-eth", String(balanceRates.eth));
    renderBalances();
  });
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || (active && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) || document.querySelector(".modal:not([hidden])")) return;
    event.preventDefault();
    $("posSearch").focus();
  });
  // Card Studio (di tab Monthly): tombol dashed memicu input file tersembunyi.
  $("bgPickImageBtn").addEventListener("click", () => $("bgImageInput").click());
  $("bgPickVideoBtn").addEventListener("click", () => $("bgVideoInput").click());
  $("downloadCardBtnTop").addEventListener("click", () => {
    downloadCard().catch((e) => setMsg("cardMsg", e.message, true));
  });
  $("tradeBuyBtn").addEventListener("click", () => doTrade("buy"));
  $("tradeSellBtn").addEventListener("click", () => doTrade("sell"));

  $("rtToggle").addEventListener("change", () => {
    rtPaused = !$("rtToggle").checked;
    $("rtToggleLabel").textContent = rtPaused ? "Realtime OFF" : "Realtime ON";
    if (!rtPaused) liveTick(true);
  });
  $("rtNowBtn").addEventListener("click", () => liveTick(true));
  // Strip statistik: toggle Auto TP/SL memakai jalur simpan settings yang
  // sama dengan modal Byte.
  $("stripTpSlToggle").addEventListener("change", async () => {
    settings.tpSl.armed = $("stripTpSlToggle").checked;
    try {
      await saveSettings();
    } catch (e) {
      showToast(e.friendly || e.message, true);
    }
    renderTpSlStrip();
  });

  $("monthPrev").addEventListener("click", () => {
    shiftMonth(-1);
  });
  $("monthNext").addEventListener("click", () => {
    shiftMonth(1);
  });
  $("monthToday").addEventListener("click", () => {
    currentMonth = new Date().toISOString().slice(0, 7);
    renderMonthly();
    if ($("tab-monthly").classList.contains("active")) renderCardPreview();
  });

  $("bgImageInput").addEventListener("change", () => {
    const f = $("bgImageInput").files[0];
    if (!f) return;
    clearBgMedia();
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      cardBg = { type: "image", img, video: null, name: f.name, objectUrl: url };
      setBgInfo();
      renderCardPreview();
    };
    img.src = url;
  });
  $("bgVideoInput").addEventListener("change", () => {
    const f = $("bgVideoInput").files[0];
    if (!f) return;
    clearBgMedia();
    const url = URL.createObjectURL(f);
    const video = $("bgVideoPreview");
    video.src = url;
    video.onloadeddata = () => {
      cardBg = { type: "video", img: null, video, name: f.name, objectUrl: url };
      setBgInfo();
      renderCardPreview();
      startVideoPreviewLoop();
    };
  });
  $("bgRemoveBtn").addEventListener("click", () => {
    clearBgMedia();
    cardBg = { type: null, img: null, video: null, name: "", objectUrl: "" };
    $("bgImageInput").value = "";
    $("bgVideoInput").value = "";
    setBgInfo();
    renderCardPreview();
  });
  $("bgPlayBtn").addEventListener("click", () => {
    const v = cardBg.video || $("bgVideoPreview");
    if (!v) return;
    if (v.paused) {
      v.play();
    } else {
      v.pause();
    }
  });
  $("bgBrightness").addEventListener("input", () => {
    $("brightnessVal").textContent = $("bgBrightness").value + "%";
    renderCardPreview();
  });
  $("downloadCardBtn").addEventListener("click", () => {
    downloadCard().catch((e) => setMsg("cardMsg", e.message, true));
  });

  // Discover controls
  document.querySelectorAll(".disc-tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".disc-tab").forEach((x) => x.classList.toggle("active", x === b));
      discoverState.tab = b.dataset.dtab;
      renderDiscover();
    }),
  );
  document.querySelectorAll(".disc-tf-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".disc-tf-btn").forEach((x) => x.classList.toggle("active", x === b));
      discoverState.tf = b.dataset.tf;
      renderDiscover();
    }),
  );
  $("discHideRisky").addEventListener("change", () => {
    discoverState.hideRisky = $("discHideRisky").checked;
    renderDiscover();
  });
  $("discChain").addEventListener("change", () => {
    discoverState.chain = $("discChain").value;
    renderDiscover();
  });
  $("discRefreshBtn").addEventListener("click", () => loadCandidates(true));

  // Copy LP
  $("copyDiscoverBtn").addEventListener("click", discoverCopyLp);
  $("zapStrategy").addEventListener("change", () => applyZapRange("auto"));
  document.querySelectorAll(".zap-preset").forEach((b) => b.addEventListener("click", () => applyZapRange(b.dataset.preset)));
  document.querySelectorAll(".step-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const input = $(b.dataset.target);
      const v = Number(input.value) || 0;
      if (v > 0) {
        input.value = fmtPrice(v * (1 + Number(b.dataset.dir) * 0.01));
        updateZapNote();
        updateZapSummary();
      }
    }),
  );
  ["zapMin", "zapMax"].forEach((id) =>
    $(id).addEventListener("input", () => {
      updateZapNote();
      updateZapSummary();
    }),
  );
  ["zapAmount", "zapSlippage"].forEach((id) => $(id).addEventListener("input", updateZapSummary));
  $("zapMode").addEventListener("change", updateZapSummary);
  $("zapOpenBtn").addEventListener("click", zapOpen);
  $("copyMonitorBtn").addEventListener("click", () => runCopyMonitor(false));

  // Agents
  $("naraSaveBtn").addEventListener("click", async () => {
    readNaraForm();
    try {
      await saveSettings();
      showToast("Pengaturan Nara tersimpan.");
      fillNaraForm();
    } catch (e) {
      showToast(e.friendly || e.message, true);
    }
  });
  $("naraRunBtn").addEventListener("click", runNara);
  $("naraV4ScanBtn").addEventListener("click", scanNaraV4Pools);
  $("byteSaveBtn").addEventListener("click", async () => {
    settings.tpSl.armed = $("byteArmed").checked;
    settings.tpSl.defaultTpPct = Number($("byteTp").value) || 0;
    settings.tpSl.defaultSlPct = Number($("byteSl").value) || 0;
    try {
      await saveSettings();
      showToast("Pengaturan Byte tersimpan.");
      fillByteForm();
    } catch (e) {
      showToast(e.friendly || e.message, true);
    }
  });
  $("byteCheckBtn").addEventListener("click", async () => {
    try {
      const r = await postJson("/api/agent/tp-sl-check", {});
      $("byteCheckOut").textContent = "Diperiksa " + r.checked + " posisi ber-SL/TP; ditutup: " + (r.closed.length ? r.closed.map((c) => c.symbol + " (" + c.reason + ")").join(", ") : "tidak ada") + ".";
      await loadState();
      renderByteChart();
    } catch (e) {
      $("byteCheckOut").textContent = e.friendly || e.message;
    }
  });
  $("leaderSaveBtn").addEventListener("click", saveLeader);
  $("leaderCancelEditBtn").addEventListener("click", clearLeaderForm);
  $("kopiSaveBtn").addEventListener("click", async () => {
    readKopiForm();
    try {
      await saveSettings();
      showToast("Pengaturan Kopi tersimpan.");
      fillKopiForm();
    } catch (e) {
      showToast(e.friendly || e.message, true);
    }
  });
  $("kopiRunBtn").addEventListener("click", runKopi);
  $("ddSaveBtn").addEventListener("click", saveDd);

  $("resetDemoBtn").addEventListener("click", async () => {
    try {
      await postJson("/api/reset", {});
      selectedToken = null;
      showToast("Demo direset ke keadaan default bersih.");
      await loadState();
      renderMonthly();
    } catch (e) {
      showToast(e.friendly || e.message, true);
    }
  });

  bindAccountUi();
  bootstrapAccount().catch((error) => {
    if (error.status === 401 || error.message.includes("Authentication required")) return showAuth();
    if (location.pathname === "/following" || location.pathname === "/leaderboard" || /^\/u\/[^/]+\/?$/.test(location.pathname)) {
      $("app").hidden = true;
      $("authScreen").hidden = true;
      $("socialScreen").hidden = false;
      $("socialContent").innerHTML = '<p class="form-error" role="alert">' + esc(error.message || "Profil gagal dimuat.") + '</p>';
      return;
    }
    showAuth("Server tidak tersedia. Pastikan backend berjalan, lalu muat ulang halaman.");
    console.error("Account bootstrap failed", error);
  });
}
function clearBgMedia() {
  const v = $("bgVideoPreview");
  try {
    v.pause();
  } catch (_) {
    /* abaikan */
  }
  v.removeAttribute("src");
  v.load();
}
function shiftMonth(delta) {
  const [y, m] = currentMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentMonth = d.toISOString().slice(0, 7);
  renderMonthly();
}
document.addEventListener("DOMContentLoaded", init);
