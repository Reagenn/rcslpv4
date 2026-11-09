"use strict";
/**
 * LP Desk — local backend v4 (simulation only).
 * Plain Node http server, no dependencies. Serves the frontend and a small
 * JSON API. No real wallet, no seed phrase/private key, no real on-chain
 * transactions. All balances, trades, positions and PnL are simulated.
 *
 * Data sources (public, read-only): DexScreener (token/pair market data),
 * Meteora DLMM Data API (dlmm.datapi.meteora.ag — Solana DLMM pools),
 * GoPlus (token security / holder data on supported chains).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const {
  UNISWAP_V4_NETWORKS,
  normalizeGeckoPools,
  normalizeMeteoraPools,
  tokenAddressKey,
  isPoolTokenAddress,
} = require("./uniswap-v4");
const { migrateLegacyPositionRisk, positionExitReason } = require("./position-risk");
const { autoTradingRiskReason } = require("./auto-trading-risk");

function loadLocalEnv() {
  const envFile = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envFile)) return;
  const contents = fs.readFileSync(envFile, "utf8").replace(/^\uFEFF/, "");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    while (value.startsWith(match[1] + "=")) value = value.slice(match[1].length + 1).trim();
    process.env[match[1]] = value;
  }
}
loadLocalEnv();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
let ACTIVE_DATA_FILE = DATA_FILE;
let activeUserId = null;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const CHAINS = ["SOL", "BASE", "ROBINHOOD", "BSC", "HYPEREVM", "ARC", "ETH"];
const TOTAL_PORTFOLIO_USDC = 5000;
const MAX_SIMULATED_TOPUP_USDC = 1_000_000;

// DexScreener chainId -> our chain label. Pair dari chainId lain DITOLAK
// dengan pesan jelas (tidak pernah dipetakan diam-diam ke chain lain).
const DEX_CHAIN_MAP = {
  solana: "SOL",
  base: "BASE",
  bsc: "BSC",
  ethereum: "ETH",
  robinhood: "ROBINHOOD",
  hyperevm: "HYPEREVM",
  arc: "ARC",
};
// GoPlus chain ids (hanya chain yang didukung GoPlus; lainnya -> SECURITY UNAVAILABLE)
const GOPLUS_CHAIN_ID = { SOL: 101, BASE: 8453, BSC: 56, ETH: 1, ROBINHOOD: 4663 };
const METEORA_DATAPI = "https://dlmm.datapi.meteora.ag";
let poolAprCache = { at: 0, data: null };

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function todayISO(d) {
  const x = d || new Date();
  return x.toISOString().slice(0, 10);
}
function monthKey(d) {
  const x = d || new Date();
  return x.toISOString().slice(0, 7);
}
/** Price-aware rounding: tiny prices keep enough decimals, big prices stay tidy. */
function roundPrice(p) {
  const v = Number(p);
  if (!isFinite(v) || v <= 0) return 0;
  if (v >= 1000) return Math.round(v * 100) / 100;
  if (v >= 1) return Math.round(v * 10000) / 10000;
  if (v >= 0.01) return Math.round(v * 1e6) / 1e6;
  return Math.round(v * 1e8) / 1e8;
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function defaultSettings() {
  // Default disamakan dengan nilai hosted Demo LP Desk yang teramati:
  // Nara min score 70, nominal 250, maks 3, preset wide, hanya verdict "consider"
  // (setara only_consider di hosted), guardrail 150 / 50.000 / 500.
  // Byte TP +22% / SL 28%. Kopi nominal 250, maks 3, preset wide, batas harian 150.
  return {
    autoTrading: { enabled: false, minScore: 70, amountPerPosition: 250, maxPositions: 3, chainFilter: "ALL", rangePreset: "wide", verdictFilter: "consider", dailyLossLimit: 150, minLiquidity: 50000, minHolder: 500, source: "DEX", minApr: 20 },
    tpSl: { armed: false, defaultTpPct: 22, defaultSlPct: 28 },
    copyTrading: { enabled: false, leaderId: null, amountPerCopy: 250, maxPositions: 3, rangePreset: "wide", dailyLossLimit: 150 },
  };
}

function defaultState() {
  const balances = {};
  const seed = { SOL: 1500, BASE: 800, ROBINHOOD: 500, BSC: 700, HYPEREVM: 500, ARC: 500, ETH: 500 };
  for (const c of CHAINS) balances[c] = { usdc: seed[c] || 0, tokens: {} };
  return {
    version: 4,
    balances,
    positions: [],
    transactions: [],
    pnlLedger: [], // { date, delta, kind: 'fee'|'close'|'rebalance'|'baseline', ref }
    feeClaimLog: [], // { date, amount, ref }
    dueDiligence: {}, // address -> { checks, verdict, notes, updatedAt }
    leaders: [], // Copy Trading watchlist — mulai KOSONG; diisi manual oleh pengguna
    claimedFeesTotal: 0,
    createdAt: new Date().toISOString(),
    settings: defaultSettings(),
    agentLogs: [], // { at, agent, message, kind, ref }
  };
}

// Filter verdict Nara memakai kosakata verdict analisis agent ala hosted
// (consider | review | avoid | ANY). Nilai lama berupa label tampilan DD
// (Consider / Short-term play / Pending / Avoid) dimigrasikan otomatis.
function normalizeVerdictFilter(v) {
  const legacy = { Consider: "consider", "Short-term play": "review", Pending: "review", Avoid: "avoid" };
  if (legacy[v]) return legacy[v];
  return ["ANY", "consider", "review", "avoid"].includes(v) ? v : "consider";
}

function loadState(filePath) {
  const base = defaultState();
  try {
    const raw = fs.readFileSync(filePath || DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.balances || !Array.isArray(parsed.positions)) return base;
    const merged = Object.assign(base, parsed);
    // Migrasi status lama 'rebalanced' -> 'closed' + closeReason 'rebalance'
    // (menyamakan hosted: posisi lama rebalance berstatus closed dan dirantai
    // lewat replaces/replacedBy).
    merged.positions = (merged.positions || []).map((p) => {
      const normalized = p && p.status === "rebalanced" ? { ...p, status: "closed", closeReason: p.closeReason || "rebalance" } : p;
      return migrateLegacyPositionRisk(normalized);
    });
    const pSettings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    const bs = defaultSettings();
    merged.settings = {
      autoTrading: Object.assign({}, bs.autoTrading, pSettings.autoTrading && typeof pSettings.autoTrading === "object" ? pSettings.autoTrading : {}),
      tpSl: Object.assign({}, bs.tpSl, pSettings.tpSl && typeof pSettings.tpSl === "object" ? pSettings.tpSl : {}),
      copyTrading: Object.assign({}, bs.copyTrading, pSettings.copyTrading && typeof pSettings.copyTrading === "object" ? pSettings.copyTrading : {}),
    };
    merged.settings.autoTrading.verdictFilter = normalizeVerdictFilter(merged.settings.autoTrading.verdictFilter);
    merged.leaders = Array.isArray(parsed.leaders) ? parsed.leaders : [];
    merged.agentLogs = Array.isArray(parsed.agentLogs) ? parsed.agentLogs.slice(0, 50) : [];
    merged.version = 4;
    return merged;
  } catch (_) {
    return base;
  }
}
function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}
function saveState(currentState) {
  atomicWriteJson(ACTIVE_DATA_FILE, currentState);
}

/* ---------------- helpers: agent logs, live PnL, positions ---------------- */

function logAgent(agent, message, kind, ref) {
  if (!Array.isArray(state.agentLogs)) state.agentLogs = [];
  state.agentLogs.unshift({ at: new Date().toISOString(), agent, message, kind: kind || "info", ref: ref || null });
  state.agentLogs = state.agentLogs.slice(0, 50);
  saveState(state);
}
function todayPnl() {
  const date = todayISO();
  return round2(state.pnlLedger.filter((e) => e.date === date).reduce((s, e) => s + (Number(e.delta) || 0), 0));
}
function totalPnlLive() {
  const ledger = state.pnlLedger.reduce((s, e) => s + (Number(e.delta) || 0), 0);
  const open = state.positions
    .filter((p) => p.status === "open")
    .reduce((s, p) => {
      const current = Number(p.currentPrice ?? p.entryPrice) || 0;
      // PnL terbuka dari valuasi bersama valuePosition() (model CL), bukan
      // lagi amount × (current/entry) yang memberi eksposur token 100%.
      return s + round2(valuePosition(p, current).value - Number(p.amount));
    }, 0);
  return round2(ledger + open);
}
function livePortfolioValue() {
  return round2(TOTAL_PORTFOLIO_USDC + totalPnlLive());
}

function openPositionInternal(fields) {
  const chain = (fields.chain || "").toUpperCase();
  if (!CHAINS.includes(chain)) return { error: "Chain tidak valid." };
  const amount = Number(fields.amount) || 0;
  const entryPrice = Number(fields.price ?? fields.entryPrice) || 0;
  const minPrice = Number(fields.minPrice) || 0;
  const maxPrice = Number(fields.maxPrice) || 0;
  if (amount <= 0 || entryPrice <= 0) return { error: "Nominal dan harga harus lebih dari 0." };
  if (minPrice <= 0 || maxPrice <= minPrice) return { error: "Range min/max tidak valid." };
  // skipBalanceCheck: dipakai rebalance — pengganti didanai dari nilai settled
  // posisi lama; gagal di tengah setelah posisi lama tertutup akan merusak
  // alur, jadi cek saldo dilewati di jalur ini saja.
  if (!fields.skipBalanceCheck && state.balances[chain].usdc < amount) return { error: "Saldo simulasi tidak cukup di chain " + chain + "." };
  state.balances[chain].usdc = round2(state.balances[chain].usdc - amount);
  const pos = {
    id: uid("lp"),
    chain,
    address: fields.address || "",
    symbol: fields.symbol || "TOKEN",
    name: fields.name || "Unknown Token",
    pair: fields.pair || "",
    pairUrl: fields.pairUrl || "",
    poolAddress: fields.poolAddress || null,
    product: fields.product || (chain === "SOL" ? "DLMM" : "SIM_RANGE"),
    source: fields.source || "Open LP",
    copyLeaderId: fields.copyLeaderId || null,
    amount: round2(amount),
    entryPrice: roundPrice(entryPrice),
    currentPrice: roundPrice(entryPrice),
    minPrice: roundPrice(minPrice),
    maxPrice: roundPrice(maxPrice),
    lowerBin: fields.lowerBin != null ? Number(fields.lowerBin) : null,
    upperBin: fields.upperBin != null ? Number(fields.upperBin) : null,
    side: fields.side || "Spot",
    strategy: fields.strategy || "Spot",
    quote: fields.quote || "USDC",
    sl: fields.sl != null ? Number(fields.sl) : null,
    tp: fields.tp != null ? Number(fields.tp) : null,
    slPnlPct: fields.slPnlPct != null && Number(fields.slPnlPct) > 0 ? Math.abs(Number(fields.slPnlPct)) : null,
    tpPnlPct: fields.tpPnlPct != null && Number(fields.tpPnlPct) > 0 ? Math.abs(Number(fields.tpPnlPct)) : null,
    binStepBps: Number(fields.binStepBps) || 25,
    fees: 0,
    rewards: 0,
    claimed: 0, // fee+reward yang sudah diklaim untuk posisi ini (claimed_fee ala hosted)
    status: "open",
    createdAt: new Date().toISOString(),
    closedAt: null,
    replacedBy: null,
    replaces: fields.replaces || null,
    distribution: fields.distribution || "50/50",
  };
  state.positions.unshift(pos);
  saveState(state);
  return { pos };
}

function closePositionInternal(pos, reason) {
  if (!pos) return { error: "Posisi tidak ditemukan." };
  if (pos.status !== "open") return { error: "Posisi sudah ditutup." };
  const kind = reason === "rebalance" ? "rebalance" : "close";
  // Nilai tutup dari valuasi bersama valuePosition() (model CL) pada harga
  // tersimpan terakhir — closePnl yang tercatat mulai sekarang mengikuti
  // model realistis; closePnl historis TIDAK dihitung ulang.
  const currentValue = valuePosition(pos, Number(pos.currentPrice ?? pos.entryPrice) || 0).value;
  const valueChange = round2(currentValue - Number(pos.amount));
  const fees = round2((Number(pos.fees) || 0) + (Number(pos.rewards) || 0));
  // Nilai settled = nilai posisi saat tutup + fee/reward yang belum diklaim.
  // Rebalance memakai nilai ini untuk mendanai posisi pengganti.
  const settledValue = round2(currentValue + fees);
  state.balances[pos.chain].usdc = round2(state.balances[pos.chain].usdc + settledValue);
  state.claimedFeesTotal = round2(state.claimedFeesTotal + fees);
  if (fees > 0) state.feeClaimLog.push({ date: todayISO(), amount: fees, ref: pos.id });
  if (valueChange !== 0) {
    state.pnlLedger.push({ date: todayISO(), delta: valueChange, kind, ref: pos.id });
  }
  // Fee yang belum diklaim TIDAK dipindahkan ke claimed saat tutup — kartu
  // hosted menampilkan UNCLAIMED FEES dan CLAIMED FEES terpisah juga untuk
  // posisi tertutup. claimed per posisi hanya bertambah lewat aksi Claim.
  // Status selalu 'closed' (menyamakan hosted); alasan tutup dicatat terpisah
  // ('close' | 'rebalance' | 'TP' | 'SL') dan rantai rebalance dijaga oleh
  // replaces/replacedBy.
  pos.status = "closed";
  pos.closeReason = reason;
  pos.closedAt = new Date().toISOString();
  pos.closeValue = currentValue;
  pos.closePnl = round2(valueChange + fees);
  saveState(state);
  return { pos, settledValue };
}

let state = loadState();
let candidatesCache = { at: 0, data: null, userId: null };

/* ---------------- DexScreener / GoPlus / Meteora helpers ---------------- */

async function fetchJson(u, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  return pairs.slice().sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

function chainFromPair(pair) {
  if (!pair) return null;
  return DEX_CHAIN_MAP[(pair.chainId || "").toLowerCase()] || null;
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* ---------------- Monthly profit computation ---------------- */

function monthlyPositionPnl(month) {
  const period = month || monthKey();
  const realizedRows = state.pnlLedger.filter((entry) =>
    (entry.date || "").startsWith(period) && ["close", "rebalance"].includes(entry.kind),
  );
  const claimedFees = state.feeClaimLog
    .filter((entry) => (entry.date || "").startsWith(period))
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const openPositions = state.positions.filter((position) =>
    position.status === "open" && (position.createdAt || "").startsWith(period),
  );
  const openPnl = openPositions.reduce((sum, position) => {
    const price = Number(position.currentPrice ?? position.entryPrice) || 0;
    const value = valuePosition(position, price).value;
    return sum + value + (Number(position.fees) || 0) + (Number(position.rewards) || 0) - (Number(position.amount) || 0);
  }, 0);
  const positionIds = new Set([
    ...realizedRows.map((entry) => entry.ref).filter(Boolean),
    ...state.feeClaimLog.filter((entry) => (entry.date || "").startsWith(period)).map((entry) => entry.ref).filter(Boolean),
    ...openPositions.map((position) => position.id),
  ]);
  return {
    month: period,
    pnl: round2(realizedRows.reduce((sum, entry) => sum + (Number(entry.delta) || 0), 0) + claimedFees + openPnl),
    positions: positionIds.size,
  };
}

function monthlySummary(month) {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = [];
  let totalPnl = 0;
  let biggestWin = 0;
  let winDays = 0;
  let lossDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = month + "-" + String(d).padStart(2, "0");
    const delta = state.pnlLedger.filter((e) => e.date === date).reduce((s, e) => s + (Number(e.delta) || 0), 0);
    const positions = state.positions.filter((p) => {
      const created = (p.createdAt || "").slice(0, 10);
      const closed = (p.closedAt || "").slice(0, 10);
      return created <= date && (!p.closedAt || closed >= date);
    }).length;
    if (delta > 0) winDays++;
    if (delta < 0) lossDays++;
    if (delta > biggestWin) biggestWin = delta;
    totalPnl += delta;
    days.push({ date, day: d, pnl: round2(delta), positions });
  }
  const feesClaimed = state.feeClaimLog.filter((e) => (e.date || "").startsWith(month)).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const claimableFees = state.positions.filter((p) => p.status === "open").reduce((s, p) => s + (Number(p.fees) || 0) + (Number(p.rewards) || 0), 0);
  const closes = state.pnlLedger.filter((e) => e.kind === "close" && (e.date || "").startsWith(month)).length;
  const invested = state.positions.filter((p) => (p.createdAt || "").startsWith(month)).map((p) => Number(p.amount) || 0);
  const avgInvested = invested.length ? invested.reduce((a, b) => a + b, 0) / invested.length : 0;
  const winRate = winDays + lossDays > 0 ? (winDays / (winDays + lossDays)) * 100 : 0;
  return {
    month,
    days,
    totals: {
      totalPortfolioValue: livePortfolioValue(), // berlabel LIVE REALTIME di UI
      allTimeDeposit: TOTAL_PORTFOLIO_USDC,
      feesClaimed: round2(feesClaimed),
      claimableFees: round2(claimableFees),
      totalPnl: round2(totalPnl),
      avgInvested: round2(avgInvested),
      winRate: round2(winRate),
      biggestWin: round2(biggestWin),
      closes,
      winDays,
      lossDays,
    },
  };
}

/* ---------------- Meteora DLMM Data API ----------------
 * Endpoint aktif: https://dlmm.datapi.meteora.ag/pools
 * filter_by=token_x=<mint> / token_y=<mint>, sort_by=tvl:desc.
 * Field pool: pool_config{bin_step, base_fee_pct}, dynamic_fee_pct, tvl,
 * current_price, volume{30m,1h,2h,4h,12h,24h}, fees{sda}, fee_tvl_ratio{sda}.
 * Jendela fee yang tersedia: 30m/1h/2h/4h/12h/24h (tidak ada 5m/6h). */

async function fetchMeteoraPoolsByMint(mint, limit) {
  const size = limit || 25;
  const mk = (side) => METEORA_DATAPI + "/pools?page_size=" + size + "&sort_by=tvl:desc&filter_by=" + encodeURIComponent(side + "=" + mint);
  const results = await Promise.allSettled([fetchJson(mk("token_x"), 15000), fetchJson(mk("token_y"), 15000)]);
  const byAddr = new Map();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of (r.value && r.value.data) || []) {
      if (p && p.address && !byAddr.has(p.address)) byAddr.set(p.address, p);
    }
  }
  return [...byAddr.values()].sort((a, b) => (Number(b.tvl) || 0) - (Number(a.tvl) || 0));
}

function normalizeMeteoraPool(p, mint) {
  const isX = p.token_x && p.token_x.address === mint;
  const tok = isX ? p.token_x : p.token_y;
  const quote = isX ? p.token_y : p.token_x;
  const tvl = Number(p.tvl) || 0;
  const fees24h = p.fees ? Number(p.fees["24h"]) || 0 : 0;
  const baseFeePct = p.pool_config ? Number(p.pool_config.base_fee_pct) || 0 : 0;
  const dynamicFeePct = Number(p.dynamic_fee_pct) || 0;
  return {
    source: "Meteora DLMM",
    chain: "SOL",
    protocol: "DLMM",
    poolAddress: p.address,
    name: p.name || ((tok && tok.symbol) || "?") + "/" + ((quote && quote.symbol) || "?"),
    baseSymbol: (tok && tok.symbol) || "?",
    quoteSymbol: (quote && quote.symbol) || "?",
    tokenAddress: mint,
    price: roundPrice((tok && tok.price) || 0),
    baseFeePct: round2(baseFeePct),
    dynamicFeePct: round2(dynamicFeePct),
    feePct: round2(baseFeePct + dynamicFeePct),
    binStep: p.pool_config ? Number(p.pool_config.bin_step) || null : null,
    tvl: round2(tvl),
    liquidity: round2(tvl),
    volume24h: round2(p.volume ? Number(p.volume["24h"]) || 0 : 0),
    fees24h: round2(fees24h),
    // Fee/TVL dalam PERSEN (bukan rasio mentah): fees24h / tvl * 100,
    // presisi 4 desimal (tampilan hosted: 0,3208%).
    feeTvl24hPct: tvl > 0 ? Math.round((fees24h / tvl) * 100 * 10000) / 10000 : null,
    // Est. fee APR (%) = fee 24j / TVL * 365 * 100.
    aprPct: tvl > 0 ? round2((fees24h / tvl) * 365 * 100) : null,
    marketCap: (tok && tok.market_cap) || null,
    holders: (tok && tok.holders) || null,
    createdAt: p.created_at || null,
  };
}

/** Fee/TVL jendela untuk tabel Discover — hanya pool Meteora DLMM Solana.
 * Mengembalikan { m5, h1, h6, h24 } dalam PERSEN atau null bila jendela/data
 * tidak tersedia (datapi tidak menyediakan jendela 5m dan 6h -> null jujur). */
async function meteoraFeeTvlWindows(mint) {
  try {
    const pools = await fetchMeteoraPoolsByMint(mint, 5);
    if (!pools.length) return null;
    const top = pools[0];
    const tvl = Number(top.tvl) || 0;
    if (!(tvl > 0) || !top.fees) return null;
    const pct = (w) => (top.fees[w] != null ? Math.round(((Number(top.fees[w]) || 0) / tvl) * 100 * 10000) / 10000 : null);
    return { m5: null, h1: pct("1h"), h6: null, h24: pct("24h"), poolAddress: top.address };
  } catch (_) {
    return null;
  }
}

/* ---------------- Copy LP discovery + range ---------------- */

function looksLikeSolanaMint(a) {
  return typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}

async function discoverPools(address) {
  const notes = [];
  let pairs = [];
  try {
    const data = await fetchJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(address), 12000);
    pairs = data.pairs || [];
  } catch (_) {
    notes.push("DexScreener tidak dapat dihubungi saat discovery.");
  }
  const dexPoolsAll = pairs
    .map((pair) => {
      const chain = chainFromPair(pair);
      // Token yang dicari bisa berada di sisi quote (mis. X/USDC yang dicari X
      // adalah base; USDC yang dicari adalah quote). Pilih sisi yang cocok.
      const quoteIsTarget = pair.quoteToken && pair.quoteToken.address && pair.quoteToken.address.toLowerCase() === String(address).toLowerCase();
      const targetTok = quoteIsTarget ? pair.quoteToken : pair.baseToken;
      const otherTok = quoteIsTarget ? pair.baseToken : pair.quoteToken;
      return {
        source: "DexScreener",
        chain: chain || (pair.chainId || "").toUpperCase(),
        supportedChain: !!chain,
        protocol: pair.dexId || "DEX",
        poolAddress: pair.pairAddress || "",
        name: ((pair.baseToken && pair.baseToken.symbol) || "?") + "/" + ((pair.quoteToken && pair.quoteToken.symbol) || "?"),
        baseSymbol: (targetTok && targetTok.symbol) || "?",
        quoteSymbol: (otherTok && otherTok.symbol) || "?",
        tokenAddress: (targetTok && targetTok.address) || address,
        price: roundPrice(pair.priceUsd),
        feePct: null, // DexScreener tidak mempublikasikan fee tier -> kosong, tidak ditebak
        fees24h: null,
        binStep: null,
        tvl: round2((pair.liquidity && pair.liquidity.usd) || 0),
        liquidity: round2((pair.liquidity && pair.liquidity.usd) || 0),
        volume24h: round2((pair.volume && pair.volume.h24) || 0),
        marketCap: pair.marketCap || pair.fdv || null,
        pairUrl: pair.url || "",
        createdAt: pair.pairCreatedAt || null,
      };
    })
    .sort((a, b) => b.tvl - a.tvl);
  // Filter chain dominan (menyamakan perilaku hosted yang teramati): hanya
  // pool dari chain yang didukung, dan hanya chain dengan total likuiditas
  // terbesar untuk CA ini — CA yang sama bisa hidup di banyak chain
  // (mis. USDC 0xA0b8… muncul di Ethereum DAN PulseChain; hosted menampilkan
  // 2 pool Uniswap Ethereum saja).
  const supportedPools = dexPoolsAll.filter((p) => p.supportedChain);
  const tvlByChain = {};
  for (const p of supportedPools) tvlByChain[p.chain] = (tvlByChain[p.chain] || 0) + p.tvl;
  const dominantChain = Object.entries(tvlByChain).sort((a, b) => b[1] - a[1])[0];
  const dexPools = (dominantChain ? supportedPools.filter((p) => p.chain === dominantChain[0]) : supportedPools).slice(0, 25);
  if (dominantChain && supportedPools.length > dexPools.length) {
    notes.push("Pool DexScreener difilter ke chain dominan token ini (" + dominantChain[0] + ").");
  }
  if (pairs.length && !supportedPools.length) {
    notes.push("Pair DexScreener untuk CA ini hanya ada di chain di luar 7 chain simulasi — tidak ditampilkan.");
  }

  let meteoraPools = [];
  if (looksLikeSolanaMint(address)) {
    try {
      // Daftar pool Meteora = pair DexScreener ber-dexId "meteora", diperkaya
      // per alamat dari Meteora DLMM Data API (GET /pools/<address>).
      // Strategi ini menyamakan jumlah pool hosted yang teramati
      // (wrapped SOL -> 12 pool; query mint mentah datapi memberi ribuan).
      const dexMeteoraPairs = pairs.filter((pr) => (pr.dexId || "").toLowerCase() === "meteora");
      if (dexMeteoraPairs.length) {
        const raws = await Promise.allSettled(dexMeteoraPairs.map((pr) => fetchJson(METEORA_DATAPI + "/pools/" + encodeURIComponent(pr.pairAddress), 12000)));
        meteoraPools = dexMeteoraPairs
          .map((pr, i) => {
            const raw = raws[i].status === "fulfilled" ? raws[i].value : null;
            if (raw && raw.address) return normalizeMeteoraPool(raw, address);
            // Lookup datapi gagal -> tampilkan data DexScreener apa adanya;
            // fee/bin step kosong (tidak ditebak).
            return {
              source: "Meteora DLMM",
              chain: "SOL",
              protocol: "DLMM",
              poolAddress: pr.pairAddress,
              name: ((pr.baseToken && pr.baseToken.symbol) || "?") + "/" + ((pr.quoteToken && pr.quoteToken.symbol) || "?"),
              baseSymbol: (pr.baseToken && pr.baseToken.symbol) || "?",
              quoteSymbol: (pr.quoteToken && pr.quoteToken.symbol) || "?",
              tokenAddress: address,
              price: roundPrice(pr.priceUsd),
              baseFeePct: null,
              dynamicFeePct: null,
              feePct: null,
              binStep: null,
              tvl: round2((pr.liquidity && pr.liquidity.usd) || 0),
              liquidity: round2((pr.liquidity && pr.liquidity.usd) || 0),
              volume24h: round2((pr.volume && pr.volume.h24) || 0),
              fees24h: null,
              feeTvl24hPct: null,
              aprPct: null,
              marketCap: pr.marketCap || pr.fdv || null,
              holders: null,
              createdAt: pr.pairCreatedAt || null,
              pairUrl: pr.url || "",
            };
          })
          .sort((a, b) => b.tvl - a.tvl)
          .slice(0, 25);
      } else {
        const raw = await fetchMeteoraPoolsByMint(address, 25);
        meteoraPools = raw.map((p) => normalizeMeteoraPool(p, address)).slice(0, 25);
      }
    } catch (_) {
      notes.push("Meteora DLMM Data API tidak dapat dihubungi saat discovery.");
    }
  }
  const best = pickBestPair(pairs);
  const token =
    best ?
      {
        name: (best.baseToken && best.baseToken.name) || "Unknown",
        symbol: (best.baseToken && best.baseToken.symbol) || "???",
        price: roundPrice(best.priceUsd),
        marketCap: best.marketCap || best.fdv || null,
        change24h: best.priceChange ? Number(best.priceChange.h24) || 0 : 0,
      }
    : meteoraPools.length ?
      {
        name: meteoraPools[0].baseSymbol,
        symbol: meteoraPools[0].baseSymbol,
        price: meteoraPools[0].price,
        marketCap: meteoraPools[0].marketCap,
        change24h: 0,
      }
    : null;
  if (!meteoraPools.length && looksLikeSolanaMint(address)) {
    notes.push("Tidak ada pool Meteora DLMM untuk mint ini (jumlah Meteora = 0).");
  }
  if (!looksLikeSolanaMint(address)) {
    notes.push("Alamat ini bukan mint Solana — pool Meteora DLMM tidak berlaku (jumlah Meteora = 0).");
  }
  return {
    address,
    token,
    meteoraPools,
    dexPools,
    meteoraCount: meteoraPools.length,
    dexCount: dexPools.length,
    notes,
  };
}

/** Hitung range ala DLMM dari volatilitas 24 jam + bin step asli pool.
 * Spot: simetris. Curve: lebih sempit (konsentrasi di sekitar harga aktif).
 * Bid-Ask: asimetris — sisi bawah lebih lebar dari sisi atas. */
function computeRange(price, binStepBps, strategy, change24hPct) {
  const stepPct = Math.max(1, Number(binStepBps) || 25) / 100; // % per bin
  const step = stepPct / 100;
  const vol = Math.max(Math.abs(Number(change24hPct) || 0), stepPct * 4);
  let oneSide = Math.round(vol / stepPct);
  oneSide = Math.max(4, Math.min(250, oneSide));
  let below = oneSide;
  let above = oneSide;
  if (strategy === "Curve") {
    below = Math.max(3, Math.round(oneSide * 0.7));
    above = below;
  } else if (strategy === "Bid-Ask") {
    below = Math.round(oneSide * 1.4);
    above = Math.max(2, Math.round(oneSide * 0.6));
  }
  return {
    minPrice: roundPrice(price * Math.pow(1 + step, -below)),
    maxPrice: roundPrice(price * Math.pow(1 + step, above)),
    lowerBin: -below,
    upperBin: above,
    binsBelow: below,
    binsAbove: above,
    stepPct,
  };
}

/* ---------------- Candidate agent analysis ---------------- */

function goplusSecurityScore(g) {
  if (!g) return null;
  let s = 100;
  if (g.is_honeypot === "1") return 0;
  if (g.is_mintable === "1") s -= 30;
  if (g.is_blacklisted === "1") s -= 20;
  if (g.can_take_back_ownership === "1") s -= 10;
  const buyTax = parseFloat(g.buy_tax || 0) || 0;
  const sellTax = parseFloat(g.sell_tax || 0) || 0;
  if (buyTax > 5 || sellTax > 5) s -= 15;
  if (g.cannot_sell_all === "1" || g.cannot_buy === "1") s -= 25;
  if (g.is_open_source === "0") s -= 10;
  return clampScore(s);
}
function organicProxyScore(holderCount, pair, hasHolderData, topHoldersPercent) {
  const txns = (pair?.txns?.h24?.buys || 0) + (pair?.txns?.h24?.sells || 0);
  let s;
  if (hasHolderData === false) {
    if (txns > 500) s = 80;
    else if (txns > 100) s = 60;
    else s = 40;
  } else {
    const h = Number(holderCount) || 0;
    s = 30;
    if (h >= 10000) s = 100;
    else if (h >= 1000) s = 80;
    else if (h >= 100) s = 55;
    if (txns > 500) s = Math.min(100, s + 10);
    else if (txns > 100) s = Math.min(100, s + 5);
  }
  // Konsentrasi holder teratas menekan proxy organik (distribusi makin
  // terpusat = makin tidak organik).
  if (topHoldersPercent != null) {
    if (topHoldersPercent >= 80) s -= 25;
    else if (topHoldersPercent >= 60) s -= 15;
    else if (topHoldersPercent >= 40) s -= 8;
  }
  return clampScore(s);
}
/** Persen suplai yang dipegang 10 holder teratas dari respons GoPlus.
 * Field percent GoPlus adalah pecahan (0.087 = 8,7%) — terverifikasi dari
 * rasio balance/total_supply. Mengembalikan null bila data tidak ada. */
function topHoldersPercent(g) {
  if (!g || !Array.isArray(g.holders) || !g.holders.length) return null;
  const sum = g.holders.slice(0, 10).reduce((s, h) => s + (parseFloat(h && h.percent) || 0), 0);
  return round2(sum * 100);
}
/** Format USD tanpa desimal ala teks rationale hosted: $5,957 / $1,261,321. */
function fmtUsd0(n) {
  return "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
}
function marketScore(pair) {
  if (!pair) return 0;
  const liq = pair.liquidity?.usd || 0;
  const vol = pair.volume?.h24 || 0;
  const liqScore =
    liq >= 1e6 ? 100
    : liq >= 1e5 ? 75
    : liq >= 1e4 ? 50
    : 25;
  const volScore =
    vol >= 1e6 ? 100
    : vol >= 1e5 ? 75
    : vol >= 1e4 ? 50
    : 25;
  return Math.round((liqScore + volScore) / 2);
}

async function runPoolAprScan() {
  const now = Date.now();
  if (poolAprCache.data && now - poolAprCache.at < 5 * 60 * 1000) return poolAprCache.data;

  const requests = UNISWAP_V4_NETWORKS.map((network) => ({
    network,
    fetchPools: async () => {
      const url = "https://api.geckoterminal.com/api/v2/networks/" + network.networkId +
        "/dexes/" + network.dexId + "/pools?include=base_token%2Cquote_token";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "application/json;version=20230302" },
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        return normalizeGeckoPools(network, await response.json(), now);
      } finally {
        clearTimeout(timeout);
      }
    },
  }));
  requests.push({
    network: { chainName: "Solana (Meteora DLMM)" },
    fetchPools: async () => normalizeMeteoraPools(
      await fetchJson(METEORA_DATAPI + "/pools?page_size=100&sort_by=tvl:desc", 15000), now
    ),
  });

  const results = await Promise.allSettled(requests.map(async (request) => ({
    network: request.network,
    pools: await request.fetchPools(),
  })));
  const successful = [];
  const failedNetworks = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") successful.push(result.value);
    else failedNetworks.push({
      chain: requests[index].network.chainName,
      error: result.reason && result.reason.name === "AbortError" ? "timeout" : (result.reason && result.reason.message) || "request gagal",
    });
  });
  if (!successful.length) {
    const error = new Error("Gagal mengambil data APR pool dari semua sumber network.");
    error.statusCode = 502;
    error.failedNetworks = failedNetworks;
    throw error;
  }

  const pools = successful.flatMap((result) => result.pools)
    .sort((a, b) => b.apr - a.apr)
    .slice(0, 100);
  const data = {
    fetchedAt: new Date().toISOString(),
    source: "GeckoTerminal + Meteora DLMM Data API",
    networksScanned: successful.map((result) => result.network.chainName),
    failedNetworks,
    aprFormula: "Uniswap v4: (volume 24 jam × fee tier) / TVL × 365; Solana/Meteora DLMM: fee 24 jam dari API / TVL × 365. Keduanya indikatif, bukan jaminan hasil.",
    pools,
  };
  poolAprCache = { at: now, data };
  return data;
}

async function runCandidateAgent() {
  const now = Date.now();
  if (candidatesCache.data && candidatesCache.userId === activeUserId && now - candidatesCache.at < 5 * 60 * 1000) {
    return candidatesCache.data;
  }
  // Gabungkan beberapa feed publik agar kandidat tidak bergantung pada boost
  // terbaru saja. Tambahkan token Robinhood dari pool v4 yang sudah terindeks,
  // lalu prioritaskan chain tersebut dengan batas total kandidat yang wajar.
  const feedUrls = [
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-boosts/top/v1",
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-profiles/recent-updates/v1",
  ];
  const [feedResults, robinhoodPools] = await Promise.all([
    Promise.allSettled(feedUrls.map((url) => fetchJson(url, 12000))),
    runPoolAprScan().then((result) => result.pools.filter((pool) => pool.chain === "ROBINHOOD")).catch(() => []),
  ]);
  const feed = feedResults.flatMap((result) => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []);
  const candidatesByKey = new Map();
  const addCandidate = (chain, address) => {
    if (!CHAINS.includes(chain) || !isPoolTokenAddress(chain, address)) return;
    const key = tokenAddressKey(chain, address);
    if (!candidatesByKey.has(key)) candidatesByKey.set(key, { address, chain });
  };
  for (const p of feed) addCandidate(DEX_CHAIN_MAP[(p.chainId || "").toLowerCase()], p.tokenAddress);
  for (const pool of robinhoodPools) {
    addCandidate(pool.chain, pool.token0 && pool.token0.id);
    addCandidate(pool.chain, pool.token1 && pool.token1.id);
  }
  const allPicked = [...candidatesByKey.values()];
  const robinhoodPicked = allPicked.filter((candidate) => candidate.chain === "ROBINHOOD").slice(0, 40);
  const otherPicked = allPicked.filter((candidate) => candidate.chain !== "ROBINHOOD");
  const picked = robinhoodPicked.concat(otherPicked.slice(0, 60 - robinhoodPicked.length));

  // DexScreener menerima beberapa alamat token sekaligus (maks. 30), jadi
  // ambil data pair per chain secara batch alih-alih satu request per token.
  const grouped = new Map();
  for (const candidate of picked) {
    if (!grouped.has(candidate.chain)) grouped.set(candidate.chain, []);
    grouped.get(candidate.chain).push(candidate);
  }
  const enriched = [];
  const batches = [...grouped.entries()].flatMap(([chain, list]) =>
    Array.from({ length: Math.ceil(list.length / 30) }, (_, index) => ({
      chain,
      candidates: list.slice(index * 30, (index + 1) * 30),
    })),
  );
  const pairResults = await Promise.allSettled(batches.map(async (batch) => {
    const addresses = batch.candidates.map((candidate) => candidate.address).join(",");
    const data = await fetchJson("https://api.dexscreener.com/latest/dex/tokens/" + addresses, 12000);
    return { ...batch, pairs: data.pairs || [] };
  }));
  for (const result of pairResults) {
    if (result.status !== "fulfilled") continue;
    const { chain, candidates, pairs } = result.value;
    for (const candidate of candidates) {
      const candidateKey = tokenAddressKey(chain, candidate.address);
      const tokenPairs = pairs.filter((pair) => {
        if (chainFromPair(pair) !== chain) return false;
        return tokenAddressKey(chain, pair.baseToken && pair.baseToken.address) === candidateKey ||
          tokenAddressKey(chain, pair.quoteToken && pair.quoteToken.address) === candidateKey;
      });
      const pair = pickBestPair(tokenPairs);
      if (!pair) continue;
      const token = tokenAddressKey(chain, pair.baseToken && pair.baseToken.address) === candidateKey ? pair.baseToken : pair.quoteToken;
      enriched.push({
        ...candidate,
        pair,
        poolCount: tokenPairs.length,
        name: token && token.name || "Unknown",
        symbol: token && token.symbol || "???",
      });
    }
  }
  // GoPlus security per chain
  const byChain = {};
  for (const e of enriched) (byChain[e.chain] = byChain[e.chain] || []).push(e);
  const goplusByAddr = {};
  await Promise.all(Object.entries(byChain).map(async ([chain, list]) => {
    const gid = GOPLUS_CHAIN_ID[chain];
    if (chain === "SOL") {
      // GoPlus token_security umum TIDAK mendukung Solana; pakai endpoint
      // khusus Solana /v1/solana/token_security dan ambil PER ALAMAT.
      const results = await Promise.allSettled(list.map(async (entry) => {
        const res = await fetchJson("https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=" + encodeURIComponent(entry.address), 12000);
        return { entry, security: Object.values(res.result || {})[0] || null };
      }));
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value.security) continue;
        const { entry, security: v } = result.value;
        const hasFee = v.transfer_fee && Object.keys(v.transfer_fee).length > 0;
        goplusByAddr[tokenAddressKey("SOL", entry.address)] = {
          is_honeypot: "0",
          is_mintable: v.mintable?.status === "1" ? "1" : "0",
          is_blacklisted: v.freezable?.status === "1" ? "1" : "0",
          can_take_back_ownership: "0",
          buy_tax: hasFee ? "10" : "0",
          sell_tax: hasFee ? "10" : "0",
          cannot_sell_all: v.non_transferable === "1" ? "1" : "0",
          is_open_source: "1",
          holder_count: v.holder_count != null && Number.isFinite(Number(v.holder_count)) ? Number(v.holder_count) : null,
          holders: Array.isArray(v.holders) ? v.holders : [],
        };
      }
      return;
    }
    if (!gid) return;
    try {
      const addrs = list.map((entry) => entry.address).join(",");
      const res = await fetchJson("https://api.gopluslabs.io/api/v1/token_security/" + gid + "?contract_addresses=" + encodeURIComponent(addrs), 12000);
      const resultByAddress = new Map(Object.entries(res.result || {}).map(([address, value]) => [address.toLowerCase(), value]));
      for (const entry of list) {
        const security = resultByAddress.get(entry.address.toLowerCase());
        if (security) goplusByAddr[tokenAddressKey(chain, entry.address)] = security;
      }
    } catch (_) {
      /* GoPlus unavailable for this chain -> SECURITY UNAVAILABLE */
    }
  }));
  // Retry GoPlus per token untuk Robinhood bila batch tidak mengembalikan angka
  // holder; sebagian respons batch melewatkan item tanpa menjelaskan sebabnya.
  const robinhoodMissingHolders = enriched.filter((entry) => {
    if (entry.chain !== "ROBINHOOD") return false;
    const security = goplusByAddr[tokenAddressKey(entry.chain, entry.address)];
    return !security || security.holder_count == null || !Number.isFinite(Number(security.holder_count));
  }).slice(0, 12);
  const holderRetries = await Promise.allSettled(robinhoodMissingHolders.map(async (entry) => {
    const url = "https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=" + encodeURIComponent(entry.address);
    const response = await fetchJson(url, 8000);
    const result = response.result || {};
    const security = result[entry.address] || result[entry.address.toLowerCase()] || Object.values(result)[0];
    return { entry, security };
  }));
  for (const result of holderRetries) {
    if (result.status !== "fulfilled" || !result.value.security) continue;
    const { entry, security } = result.value;
    const key = tokenAddressKey(entry.chain, entry.address);
    goplusByAddr[key] = { ...(goplusByAddr[key] || {}), ...security };
  }
  // Fee/TVL jendela dari pool Meteora DLMM — hanya kandidat Solana.
  const feeTvlByAddr = {};
  await Promise.all(
    enriched
      .filter((e) => e.chain === "SOL")
      .map(async (e) => {
        feeTvlByAddr[e.address] = await meteoraFeeTvlWindows(e.address);
      }),
  );

  // Pemetaan kandidat ke bentuk PERSIS respons getlprecommendations hosted:
  // field flat snake_case + agent_analysis{} + due_diligence{} + rationale[].
  const analyzedAt = new Date().toISOString();
  const scored = enriched.map((e) => {
    const g = goplusByAddr[tokenAddressKey(e.chain, e.address)] || null;
    const security = goplusSecurityScore(g);
    const reportedHolderCount = g && (g.holder_count ?? g.holders_count);
    const exactHolderCount = reportedHolderCount != null && Number.isFinite(Number(reportedHolderCount)) && Number(reportedHolderCount) >= 0;
    const holderListCount = g && Array.isArray(g.holders) ? g.holders.length : 0;
    const holderCountIsLowerBound = !exactHolderCount && holderListCount > 0;
    const hasHolderData = exactHolderCount || holderCountIsLowerBound;
    const holderCount = exactHolderCount ? Number(reportedHolderCount) : holderCountIsLowerBound ? holderListCount : null;
    const topPct = g ? topHoldersPercent(g) : null;
    const organic = g ? organicProxyScore(holderCount || 0, e.pair, hasHolderData, topPct) : null;
    const market = marketScore(e.pair);
    // Skor agent hosted: 45% keamanan + 25% proxy organik + 30% pasar.
    // Chain tanpa data GoPlus: skor hanya memakai data pasar DEX Screener
    // (sesuai teks limitation hosted) agar kandidat tetap bisa diperingkat.
    let total;
    if (security !== null && organic !== null) {
      total = clampScore(0.45 * security + 0.25 * organic + 0.3 * market);
    } else if (security !== null) {
      total = clampScore(0.45 * security + 0.3 * market);
    } else {
      total = market;
    }
    const status =
      !g ? "unavailable"
      : exactHolderCount ? "complete"
      : "partial";
    const confidence = status === "complete" ? "high" : "low";
    const findings =
      g ?
        {
          honeypot: g.is_honeypot === "1",
          mintable: g.is_mintable === "1",
          blacklisted: g.is_blacklisted === "1",
          buyTax: parseFloat(g.buy_tax || 0) || 0,
          sellTax: parseFloat(g.sell_tax || 0) || 0,
        }
      : null;
    let verdict;
    if (findings && findings.honeypot) verdict = "avoid";
    else if (security !== null && security < 40) verdict = "avoid";
    else if (total >= 70 && security !== null && security >= 70) verdict = "consider";
    else if (total < 40) verdict = "avoid";
    else verdict = "review";
    const pc = e.pair.priceChange || {};
    const priceChangeDataAvailable = ["h24", "h1", "h6", "m5"].every((period) => pc[period] != null && Number.isFinite(Number(pc[period])));
    const vol = e.pair.volume || {};
    const liquidity = round2(e.pair.liquidity?.usd || 0);
    const volume24h = round2(vol.h24 || 0);
    const chg24 = Number(pc.h24) || 0;
    const chg1 = Number(pc.h1) || 0;
    const marketStatus =
      Math.abs(chg24) >= 50 || Math.abs(chg1) >= 25 ? "volatile"
      : security === null || liquidity < 10000 ? "check"
      : "ready";
    const rationale = [
      "Likuiditas " + fmtUsd0(liquidity),
      "Volume 24j " + fmtUsd0(volume24h),
      (e.poolCount || 0) > 0 ? e.poolCount + " pool terdaftar di DexScreener" : null,
      Math.abs(chg24) >= 50 ? "Pergerakan harga 24 jam sangat tinggi" : null,
    ].filter(Boolean);
    const positives = [
      findings && !findings.honeypot && !findings.mintable && !findings.blacklisted && findings.buyTax <= 5 && findings.sellTax <= 5 ? "Tidak ada flag kontrak berisiko pada respons GoPlus" : null,
      topPct != null && topPct < 40 ? "Konsentrasi 10 holder teratas relatif rendah (" + topPct + "%)" : null,
      liquidity >= 1000000 ? "Likuiditas dalam (di atas $1,000,000)" : null,
    ].filter(Boolean);
    const risks = [
      findings && findings.honeypot ? "Indikasi honeypot pada respons GoPlus" : null,
      findings && findings.mintable ? "Kontrak masih bisa mencetak token baru (mintable)" : null,
      findings && findings.blacklisted ? "Kontrak memiliki mekanisme blacklist" : null,
      findings && (findings.buyTax > 5 || findings.sellTax > 5) ? "Pajak transaksi tinggi (beli " + findings.buyTax + "% / jual " + findings.sellTax + "%)" : null,
      Math.abs(chg24) >= 50 ? "Pergerakan harga 24 jam sangat tinggi" : null,
      liquidity > 0 && liquidity < 10000 ? "Likuiditas rendah" : null,
      topPct != null && topPct >= 60 ? "Konsentrasi 10 holder teratas tinggi (" + topPct + "%)" : null,
    ].filter(Boolean);
    const limitations = [
      !g && GOPLUS_CHAIN_ID[e.chain] ? "GoPlus belum memiliki data keamanan untuk alamat ini." : null,
      !g && !GOPLUS_CHAIN_ID[e.chain] ? "GoPlus belum dipakai untuk profil chain " + e.chain + "; skor hanya memakai data pasar DEX Screener." : null,
      holderCountIsLowerBound ? "GoPlus mengembalikan daftar holder tanpa total; angka holder yang ditampilkan adalah batas minimum dari jumlah baris yang tersedia." : null,
      g && !hasHolderData ? "Data holder tidak tersedia dari GoPlus untuk alamat ini; proxy organik memakai aktivitas transaksi." : null,
      "Bundling, cabal, same-block buyers, dan riwayat sosial tidak tercakup API publik — tetap periksa manual lewat due diligence.",
      "Data Smart LP tidak tersedia dari sumber publik mana pun dan tidak pernah diisi perkiraan.",
    ].filter(Boolean);
    const sources = ["DEX Screener"];
    if (g) sources.push("GoPlus");
    const ft = feeTvlByAddr[e.address] || { m5: null, h1: null, h6: null, h24: null };
    if (ft.h24 != null || ft.h1 != null) sources.push("Meteora DLMM Data API");
    const manual = state.dueDiligence[e.address] || null;
    const mc = (manual && manual.checks) || {};
    const dueDiligence = {
      bundled_percent: null, // persen bundling manual tidak dikumpulkan v4 -> null jujur
      cabal_control: mc.cabal || "pending",
      completed_checks: manual ? Number(manual.completedChecks) || 0 : 0,
      final_verdict: manual ? manual.verdict : "Pending",
      holder_verdict: mc.holders || "pending",
      notes: manual ? manual.notes || "" : "",
      organic_score: null, // skor organik manual numerik tidak dikumpulkan v4
      same_block_buyers_percent: null,
      social_history: mc.social || "pending",
      updated_at: manual ? manual.updatedAt || null : null,
    };
    return {
      address: e.address,
      agent_analysis: {
        analyzed_at: analyzedAt,
        confidence,
        holder_count: holderCount,
        holder_count_is_lower_bound: holderCountIsLowerBound,
        holder_count_source: hasHolderData ? "GoPlus" : null,
        limitations,
        organic_proxy_score: organic,
        positives,
        risks,
        score: total,
        security_score: security,
        sources,
        status,
        top_holders_percent: topPct,
        verdict,
      },
      chain: e.chain,
      dex_id: e.pair.dexId || null,
      dexscreener_url: e.pair.url || null,
      due_diligence: dueDiligence,
      due_diligence_score: manual ? Math.round(((Number(manual.completedChecks) || 0) / 6) * 100) : 0,
      fee_tvl_1h: ft.h1,
      fee_tvl_24h: ft.h24,
      fee_tvl_5m: ft.m5,
      fee_tvl_6h: ft.h6,
      holders_count: holderCount,
      holders_count_is_lower_bound: holderCountIsLowerBound,
      holders_count_source: hasHolderData ? "GoPlus" : null,
      liquidity_usd: liquidity,
      market_cap_usd: e.pair.marketCap || e.pair.fdv || null,
      market_score: market,
      market_status: marketStatus,
      name: e.name,
      pair_created_at: e.pair.pairCreatedAt || null,
      price_change_data_available: priceChangeDataAvailable,
      pair_symbol: ((e.pair.baseToken && e.pair.baseToken.symbol) || "?") + "/" + ((e.pair.quoteToken && e.pair.quoteToken.symbol) || "?"),
      pool_count: e.poolCount || 0,
      price_change_24h: pc.h24 || 0,
      price_change_h1: pc.h1 || 0,
      price_change_h6: pc.h6 || 0,
      price_change_m5: pc.m5 || 0,
      price_usd: roundPrice(e.pair.priceUsd),
      primary_pool_address: e.pair.pairAddress || null,
      rank: null,
      rationale,
      recommendation_score: total,
      safety_score: security !== null ? security : market,
      smart_lp_status: "unavailable",
      symbol: e.symbol,
      volume_24h: volume24h,
      volume_h1: vol.h1 || 0,
      volume_h6: vol.h6 || 0,
      volume_m5: vol.m5 || 0,
    };
  });
  const sortedAll = scored.slice().sort((a, b) => (b.recommendation_score || 0) - (a.recommendation_score || 0));
  const ranked = sortedAll.slice(0, 10).map((c, i) => ({ ...c, rank: i + 1 }));
  const rankedAddrs = new Set(ranked.map((c) => c.address));
  const pending = scored.filter((c) => !rankedAddrs.has(c.address));
  const out = {
    fetched_at: analyzedAt,
    recommendations: ranked,
    pending_candidates: pending,
    source_note:
      "Kandidat pasar berasal dari DEX Screener (boost terbaru/teratas, profil terbaru/baru diperbarui) dan token Uniswap v4 Robinhood Chain. Keamanan dan hitungan holder memakai GoPlus; maksimal 12 token Robinhood tanpa hitungan dari batch dicoba ulang per token. Bila hanya daftar holder tersedia, angka ditandai sebagai batas minimum; data yang tidak tersedia tetap ditampilkan sebagai tidak tersedia, bukan dikarang. Fee/TVL berasal dari Meteora DLMM hanya untuk Solana. Smart LP tidak tersedia dan tidak pernah diperkirakan.",
  };
  candidatesCache = { at: now, data: out, userId: activeUserId };
  return out;
}

/* ---------------- HTTP helpers ---------------- */

function securityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'self'");
}
function sendJson(res, code, obj) {
  securityHeaders(res);
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
function sendText(res, code, text, type) {
  securityHeaders(res);
  res.writeHead(code, { "content-type": type || "text/plain; charset=utf-8" });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (data.length + chunk.length > 64 * 1024) {
        tooLarge = true;
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return resolve({});
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

const SESSION_COOKIE = "lpdesk_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();
function emptyUsersStore() {
  return { version: 1, legacyClaimed: false, users: {}, sessions: {} };
}
function readUsersStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    if (!parsed || !parsed.users || !parsed.sessions) throw new Error("Invalid users store");
    parsed.legacyClaimed = parsed.legacyClaimed === true;
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return emptyUsersStore();
    throw error;
  }
}
function writeUsersStore(store) {
  atomicWriteJson(USERS_FILE, store);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function hashSession(sessionId) {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}
function sessionFromRequest(req) {
  const cookie = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(SESSION_COOKIE + "="));
  if (!cookie) return "";
  try { return decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)); } catch (_) { return ""; }
}
function setSessionCookie(req, res, value, maxAge) {
  const forwardedHttps = req.headers["x-forwarded-proto"] === "https";
  const secure = (req.socket && req.socket.encrypted) || forwardedHttps ? "; Secure" : "";
  res.setHeader("set-cookie", SESSION_COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + secure);
}
function authThrottleKey(req) {
  return req.socket && req.socket.remoteAddress || "unknown";
}
function authThrottled(req) {
  const key = authThrottleKey(req);
  const now = Date.now();
  if (authAttempts.size > 10000) {
    for (const [attemptKey, attempt] of authAttempts) if (now - attempt.startedAt >= 15 * 60 * 1000) authAttempts.delete(attemptKey);
  }
  const prior = authAttempts.get(key);
  if (prior && now - prior.startedAt < 15 * 60 * 1000 && prior.count >= 10) return true;
  if (!prior || now - prior.startedAt >= 15 * 60 * 1000) authAttempts.set(key, { startedAt: now, count: 1 });
  else prior.count++;
  return false;
}
function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function validUsername(value) {
  return /^[a-z0-9][a-z0-9_-]{2,23}$/.test(value);
}
function validText(value, max, allowEmpty) {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}
function validHttpsUrl(value, max) {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > max) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch (_) { return false; }
}
function validAvatarValue(value) {
  if (validHttpsUrl(value, 500)) return true;
  if (typeof value !== "string" || value.length > 45 * 1024) return false;
  const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length >= 4 && bytes.length <= 32 * 1024 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}
function defaultProfile(username, displayName) {
  return {
    displayName: displayName || username,
    discordName: "",
    bio: "",
    avatarUrl: "",
    bannerUrl: "",
    sharePositions: false,
    shareNetWorth: false,
    showOnLeaderboard: false,
  };
}
function publicUserFields(user) {
  const p = user.profile || defaultProfile(user.username);
  return {
    username: user.username,
    displayName: p.displayName,
    discordName: p.discordName,
    bio: p.bio,
    avatarUrl: p.avatarUrl,
    bannerUrl: p.bannerUrl,
    followers: Object.values(readUsersStore().users).filter((other) => (other.following || []).includes(user.id)).length,
    followingCount: (user.following || []).length,
  };
}
function deskFileFor(user) {
  return path.join(DATA_DIR, "desks", user.id + ".json");
}
function publicDeskData(user) {
  const profile = user.profile || defaultProfile(user.username);
  const result = publicUserFields(user);
  if (!profile.sharePositions && !profile.shareNetWorth) return result;
  const desk = loadState(deskFileFor(user));
  if (profile.sharePositions) {
    result.positions = desk.positions.map((position) => {
      const pub = positionPublic(position);
      return {
        symbol: pub.token_symbol,
        chain: position.chain,
        product: position.product,
        status: position.status,
        entryPrice: pub.entry_price,
        currentPrice: pub.current_price,
        positionValue: pub.position_value,
        netPnl: pub.net_pnl,
        createdAt: pub.created_at,
        closedAt: pub.closed_at,
      };
    });
  }
  if (profile.shareNetWorth) {
    const balances = Object.values(desk.balances || {}).reduce((sum, balance) => sum + (Number(balance.usdc) || 0), 0);
    const positions = (desk.positions || []).filter((position) => position.status === "open");
    const positionsValue = positions.reduce((sum, position) => sum + valuePosition(position, Number(position.currentPrice ?? position.entryPrice) || 0).value, 0);
    result.netWorth = round2(balances + positionsValue);
    result.simulation = true;
  }
  return result;
}
function profileValidation(body) {
  const limits = { displayName: 40, discordName: 64, bio: 280 };
  for (const [key, max] of Object.entries(limits)) {
    if (Object.prototype.hasOwnProperty.call(body, key) && !validText(body[key], max, key !== "displayName")) return key + " is invalid or too long.";
  }
  if (Object.prototype.hasOwnProperty.call(body, "avatarUrl") && !validAvatarValue(body.avatarUrl)) {
    return "avatarUrl must be an HTTPS URL or a compressed JPEG image within the size limit.";
  }
  if (Object.prototype.hasOwnProperty.call(body, "bannerUrl") && !validHttpsUrl(body.bannerUrl, 1000)) {
    return "bannerUrl must be an HTTPS URL within the length limit.";
  }
  for (const key of ["sharePositions", "shareNetWorth", "showOnLeaderboard"]) {
    if (Object.prototype.hasOwnProperty.call(body, key) && typeof body[key] !== "boolean") return key + " must be boolean.";
  }
  const allowed = new Set(["displayName", "discordName", "bio", "avatarUrl", "bannerUrl", "sharePositions", "shareNetWorth", "showOnLeaderboard"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return "Unknown profile field.";
  return null;
}
function resolveSession(req, store) {
  const raw = sessionFromRequest(req);
  if (!raw) return null;
  const hash = hashSession(raw);
  const session = store.sessions[hash];
  if (!session || session.expiresAt <= Date.now()) {
    if (session) delete store.sessions[hash];
    return null;
  }
  return Object.values(store.users).find((user) => user.id === session.userId) || null;
}

/* ---------------- Position helpers ---------------- */

function makeBins(entryPrice, binStepBps, count) {
  const step = (binStepBps || 25) / 10000;
  const bins = [];
  const half = Math.floor(count / 2);
  for (let i = -half; i <= half; i++) {
    bins.push({ index: i, price: roundPrice(entryPrice * Math.pow(1 + step, i)) });
  }
  return bins;
}
function distributionWeights(distribution) {
  const m = String(distribution || "50/50").split("/");
  const wt = Number(m[0]) || 0;
  const wq = Number(m[1]) || 0;
  const sum = wt + wq;
  if (sum <= 0) return { token: 0.5, quote: 0.5 };
  return { token: wt / sum, quote: wq / sum };
}
// Valuasi concentrated liquidity (gaya Uniswap v3 / DLMM, pendekatan kontinu
// di atas range harga tersimpan posisi [pa, pb] = [minPrice, maxPrice]).
// SATU fungsi ini dipakai semua jalur (positionPublic, /api/realtime,
// totalPnlLive, closePositionInternal) agar angka tidak pernah berbeda
// antar-layar.
//
// Model: posisi direpresentasikan oleh likuiditas konstan L. Komposisi awal
// pada harga buka p0 diturunkan dari L:
//   p0 di dalam range : x0 = L(1/√p0 − 1/√pb),  y0 = L(√p0 − √pa)
//   p0 ≤ pa           : x0 = L(1/√pa − 1/√pb),   y0 = 0   (semua token)
//   p0 ≥ pb           : x0 = 0,                 y0 = L(√pb − √pa) (semua quote)
// dengan L dipilih sehingga x0·p0 + y0 = amount. Range yang offset dari entry
// (single-sided) tertangani alami oleh cabang p0 di tepi/luar range.
// Nilai pada harga live p:
//   p ≤ pa : semua token — value = x·p, x = L(1/√pa − 1/√pb)
//   p ≥ pb : semua quote — value = L(√pb − √pa) (BEKU, tidak ikut naik lagi)
//   di dalam range: x = L(1/√p − 1/√pb), y = L(√p − √pa), value = x·p + y
// Benchmark HOLD = memegang jumlah awal yang sama: holdValue = x0·p + y0.
// Karena pool menjual aset yang naik (dan membeli yang turun) secara
// bertahap, value ≤ holdValue untuk semua p → il = value − holdValue ≤ 0,
// seperti LP asli. (Model lama amount × r memberi eksposur token 100% dan
// membuat "IL" positif saat harga naik — itu yang diperbaiki di sini.)
// Untuk DLMM ini adalah pendekatan kontinu di atas range bin tersimpan
// [minPrice, maxPrice], bukan penjumlahan per-bin diskret.
// Fallback legacy (posisi tanpa range valid): full-range berbobot
// value = amount × r^(w.token) vs holdValue rumus bobot — il ≤ 0 oleh AM–GM.
function valuePosition(pos, price) {
  const amount = Number(pos.amount) || 0;
  const p0 = Number(pos.entryPrice) || 0;
  const p = Number(price);
  const pa = Number(pos.minPrice) || 0;
  const pb = Number(pos.maxPrice) || 0;
  if (!(amount > 0) || !(p0 > 0) || !(p > 0)) {
    return { value: round2(amount), holdValue: round2(amount), il: 0, model: "none" };
  }
  if (pa > 0 && pb > pa) {
    const sa = Math.sqrt(pa);
    const sb = Math.sqrt(pb);
    // Jumlah aset per unit L pada harga q (piecewise v3).
    const amountsAt = (q) => {
      if (q <= pa) return { x: 1 / sa - 1 / sb, y: 0 };
      if (q >= pb) return { x: 0, y: sb - sa };
      const sq = Math.sqrt(q);
      return { x: 1 / sq - 1 / sb, y: sq - sa };
    };
    const at0 = amountsAt(p0);
    const v0perL = at0.x * p0 + at0.y;
    if (v0perL > 0) {
      const L = amount / v0perL;
      const x0 = at0.x * L;
      const y0 = at0.y * L;
      const at = amountsAt(p);
      const value = at.x * L * p + at.y * L;
      const holdValue = x0 * p + y0;
      return { value: round2(value), holdValue: round2(holdValue), il: round2(holdValue - value), model: "cl" };
    }
  }
  const r = p / p0;
  const w = distributionWeights(pos.distribution);
  const value = amount * Math.pow(r, w.token);
  const holdValue = amount * (w.token * r + w.quote);
  return { value: round2(value), holdValue: round2(holdValue), il: round2(value - holdValue), model: "legacy" };
}

function positionPublic(p) {
  const current = roundPrice(p.currentPrice ?? p.entryPrice);
  // Valuasi + benchmark dari fungsi bersama valuePosition() (model
  // concentrated liquidity; lihat komentar di atas fungsi itu).
  const { value, holdValue, il } = valuePosition(p, current);
  const positionPnl = p.status === "open"
    ? round2(value + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - (Number(p.amount) || 0))
    : p.closePnl != null ? round2(p.closePnl) : round2(value + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - (Number(p.amount) || 0));
  const netVsHolding = round2(value + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - holdValue);
  const inRange = current >= p.minPrice && current <= p.maxPrice;
  const bins = makeBins(p.entryPrice, p.binStepBps, 21);
  const half = Math.floor(bins.length / 2);
  // Active bin dihitung dari harga live terhadap bin step posisi (relatif ke
  // bin entry = 0), BUKAN hardcode — menyamakan hosted yang menampilkan bin
  // aktif nyata pada kartu posisi dan grafik bins.
  const stepRatio = (Number(p.binStepBps) || 25) / 10000;
  let stepsFromEntry = 0;
  if (stepRatio > 0 && p.entryPrice > 0 && current > 0) {
    stepsFromEntry = Math.round(Math.log(current / p.entryPrice) / Math.log(1 + stepRatio));
  }
  if (p.lowerBin != null && p.upperBin != null) {
    stepsFromEntry = Math.max(Number(p.lowerBin), Math.min(Number(p.upperBin), stepsFromEntry));
  }
  const activeBinIndex = Math.max(0, Math.min(bins.length - 1, stepsFromEntry + half));
  const activeBin = stepsFromEntry;
  const pctOf = (v) => (v != null && Number(v) > 0 && p.entryPrice > 0 ? round2((Number(v) / p.entryPrice - 1) * 100) : null);
  const minPct = pctOf(p.minPrice);
  const maxPct = pctOf(p.maxPrice);
  const slPct = p.slPnlPct != null ? -Math.abs(Number(p.slPnlPct)) : pctOf(p.sl);
  const tpPct = p.tpPnlPct != null ? Math.abs(Number(p.tpPnlPct)) : pctOf(p.tp);
  const claimedFee = round2(Number(p.claimed) || 0);
  return {
    ...p,
    currentPrice: current,
    value,
    holdValue,
    il,
    ilPct: holdValue > 0 ? round2((il / holdValue) * 100) : 0,
    netVsHolding,
    inRange,
    bins,
    activeBinIndex,
    activeBin,
    minPct,
    maxPct,
    slPct,
    tpPct,
    claimed: claimedFee,
    ageHours: p.createdAt ? round2((Date.now() - new Date(p.createdAt).getTime()) / 3600000) : 0,
    // Alias snake_case menyamakan bentuk posisi getdesk hosted (untuk
    // konsumen API yang mengharapkan field hosted).
    token_symbol: p.symbol,
    token_address: p.address,
    entry_price: p.entryPrice,
    current_price: current,
    position_value: value,
    hold_value: holdValue,
    net_pnl: positionPnl,
    net_pnl_vs_holding: netVsHolding,
    position_pnl: positionPnl,
    impermanent_loss: il,
    unclaimed_fee: round2(Number(p.fees) || 0),
    claimed_fee: claimedFee,
    lm_reward: round2(Number(p.rewards) || 0),
    bin_step: p.binStepBps,
    active_bin: activeBin,
    lower_bin: p.lowerBin,
    upper_bin: p.upperBin,
    min_pct: minPct,
    max_pct: maxPct,
    sl_pct: slPct,
    tp_pct: tpPct,
    pool_address: p.poolAddress,
    copy_leader_id: p.copyLeaderId,
    replaces_position_id: p.replaces,
    replaced_by_position_id: p.replacedBy,
    created_at: p.createdAt,
    closed_at: p.closedAt,
  };
}

/* ---------------- Live price + TP/SL helpers ---------------- */

async function fetchLivePrice(address, fallback, chain) {
  if (!address) return fallback;
  try {
    const data = await fetchJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(address), 8000);
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    const chainPairs = chain ? pairs.filter((pair) => chainFromPair(pair) === chain) : pairs;
    const pair = pickBestPair(chainPairs);
    if (!pair || !pair.priceUsd) return fallback;
    return roundPrice(pair.priceUsd);
  } catch (_) {
    return fallback;
  }
}

// Evaluasi SL/TP untuk posisi open pada harga yang sudah segar.
function evaluateTpSlOnFreshPrices(openPositions) {
  const closed = [];
  for (const p of openPositions) {
    if (p.status !== "open") continue;
    const price = Number(p.currentPrice ?? p.entryPrice) || 0;
    const hasPnlTarget = Number(p.slPnlPct) > 0 || Number(p.tpPnlPct) > 0;
    const hasPriceTarget = (p.sl != null && Number(p.sl) > 0) || (p.tp != null && Number(p.tp) > 0);
    if (!hasPnlTarget && !hasPriceTarget) continue;
    const value = valuePosition(p, price).value;
    const pnl = round2(value + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - (Number(p.amount) || 0));
    const reason = positionExitReason(p, price, pnl);
    if (!reason) continue;
    const r = closePositionInternal(p, reason);
    if (!r.error) {
      closed.push({ id: p.id, symbol: p.symbol, reason, price });
      logAgent("Byte", p.symbol + " ditutup oleh " + reason + " pada " + price + " USDC.", "ok", p.id);
    }
  }
  return closed;
}

async function repriceOpenPositions() {
  const opens = state.positions.filter((p) => p.status === "open");
  let changed = false;
  // BUGFIX unclaimed fee: akrual fee per siklus realtime untuk SETIAP posisi
  // open. Sebelumnya fee hanya bertambah lewat refresh manual
  // (/api/lp/refresh), jadi UNCLAIMED FEES diam di $0 selama pemakaian
  // realtime normal. Menyamakan hosted: "nilai portofolio, PnL & fee
  // dihitung ulang tiap siklus". Rumus per siklus: amount × 0,00002 ×
  // (0,5 + acak 0..1); LM reward = 20% dari fee siklus itu. Akrual berlaku
  // untuk semua posisi open — juga yang alamatnya gagal di-reprice — dan
  // TIDAK menulis ledger (aturan throttle tetap; ledger hanya dari refresh
  // manual/close/rebalance).
  for (const p of opens) {
    const fee = round2((Number(p.amount) || 0) * 0.00002 * (0.5 + Math.random()));
    if (fee > 0) {
      p.fees = round2((Number(p.fees) || 0) + fee);
      p.rewards = round2((Number(p.rewards) || 0) + round2(fee * 0.2));
      changed = true;
    }
  }
  const byChainAddress = {};
  for (const p of opens) {
    if (!p.address) continue;
    const key = tokenAddressKey(p.chain, p.address);
    (byChainAddress[key] = byChainAddress[key] || []).push(p);
  }
  const tokenKeys = Object.keys(byChainAddress);
  if (!tokenKeys.length) {
    if (changed) saveState(state);
    return;
  }
  const results = await Promise.allSettled(tokenKeys.map((key) => {
    const position = byChainAddress[key][0];
    return fetchLivePrice(position.address, null, position.chain);
  }));
  results.forEach((res, i) => {
    const key = tokenKeys[i];
    const live = res.status === "fulfilled" ? res.value : null;
    if (live == null || !isFinite(live) || live <= 0) return;
    for (const p of byChainAddress[key]) {
      if (Number(p.currentPrice) !== live) {
        p.currentPrice = live;
        changed = true;
      }
    }
  });
  // Ledger TIDAK ditulis pada siklus realtime (di-throttle); hanya harga
  // tersimpan + fee terakru yang diperbarui. Delta PnL dicatat saat
  // refresh/close/rebalance.
  if (changed) saveState(state);
}

/* ---------------- Copy Trading (Kopi) helpers ---------------- */

function sortedLeaders() {
  return (state.leaders || []).slice().sort((a, b) => (Number(b.winrate) || 0) - (Number(a.winrate) || 0));
}
function pickCopyLeader() {
  const list = sortedLeaders();
  if (!list.length) return null;
  const wanted = state.settings.copyTrading.leaderId;
  if (wanted) {
    const found = list.find((l) => l.id === wanted);
    if (found) return found;
  }
  return list[0]; // otomatis peringkat #1 (winrate tertinggi)
}

/* ---------------- Server ---------------- */

async function handleRequest(req, res) {
  try {
    const parsed = new URL(req.url, "http://localhost");
    const pathname = parsed.pathname;
    const origin = req.headers.origin;
    const forwardedHttps = req.headers["x-forwarded-proto"] === "https";
    const requestOrigin = ((req.socket && req.socket.encrypted) || forwardedHttps ? "https://" : "http://") + req.headers.host;
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && origin !== requestOrigin) {
      return sendJson(res, 403, { error: "Cross-origin request rejected." });
    }
    const authRoute = pathname === "/api/auth/register" || pathname === "/api/auth/login";
    const authBody = authRoute ? await readBody(req) : null;

    if (pathname === "/api/auth/register" && req.method === "POST") {
      const username = normalizeUsername(authBody.username);
      const password = authBody.password;
      const displayName = authBody.displayName;
      if (authThrottled(req)) return sendJson(res, 429, { error: "Too many authentication attempts. Try again later." });
      if (!validUsername(username) || typeof password !== "string" || password.length < 10 || password.length > 128 || (displayName !== undefined && !validText(displayName, 40, false))) {
        return sendJson(res, 400, { error: "Invalid username, password, or display name." });
      }
      const store = readUsersStore();
      if (Object.prototype.hasOwnProperty.call(store.users, username)) return sendJson(res, 409, { error: "Username is already registered." });
      const userId = crypto.randomBytes(16).toString("hex");
      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived.toString("hex"))));
      const user = {
        id: userId,
        username,
        passwordSalt: salt,
        passwordHash,
        profile: defaultProfile(username, displayName ? displayName.trim() : username),
        following: [],
        createdAt: new Date().toISOString(),
      };
      const deskFile = deskFileFor(user);
      fs.mkdirSync(path.dirname(deskFile), { recursive: true });
      if (!store.legacyClaimed && fs.existsSync(DATA_FILE)) {
        const legacyTemp = deskFile + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
        try {
          fs.copyFileSync(DATA_FILE, legacyTemp);
          fs.renameSync(legacyTemp, deskFile);
        } catch (error) {
          try { fs.unlinkSync(legacyTemp); } catch (_) {}
          throw error;
        }
        try { fs.chmodSync(deskFile, 0o600); } catch (_) {}
      } else {
        atomicWriteJson(deskFile, defaultState());
      }
      store.legacyClaimed = true;
      store.users[username] = user;
      const sessionId = crypto.randomBytes(32).toString("hex");
      store.sessions[hashSession(sessionId)] = { userId, expiresAt: Date.now() + SESSION_TTL_MS };
      writeUsersStore(store);
      ACTIVE_DATA_FILE = deskFile;
      activeUserId = userId;
      state = loadState(deskFile);
      setSessionCookie(req, res, sessionId, Math.floor(SESSION_TTL_MS / 1000));
      return sendJson(res, 201, { user: { username, displayName: user.profile.displayName } });
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      const username = normalizeUsername(authBody.username);
      if (authThrottled(req)) return sendJson(res, 429, { error: "Too many authentication attempts. Try again later." });
      const store = readUsersStore();
      const user = Object.prototype.hasOwnProperty.call(store.users, username) ? store.users[username] : null;
      const passwordValid = typeof authBody.password === "string" && authBody.password.length <= 128;
      const password = passwordValid ? authBody.password : "";
      const salt = user ? user.passwordSalt : "lpdesk-invalid-user-salt";
      const candidate = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived.toString("hex"))));
      const matches = !!user && passwordValid && safeEqual(candidate, user.passwordHash);
      if (!matches) return sendJson(res, 401, { error: "Invalid username or password." });
      authAttempts.delete(authThrottleKey(req));
      const sessionId = crypto.randomBytes(32).toString("hex");
      store.sessions[hashSession(sessionId)] = { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS };
      for (const [id, session] of Object.entries(store.sessions)) if (session.expiresAt <= Date.now()) delete store.sessions[id];
      writeUsersStore(store);
      ACTIVE_DATA_FILE = deskFileFor(user);
      activeUserId = user.id;
      state = loadState(ACTIVE_DATA_FILE);
      setSessionCookie(req, res, sessionId, Math.floor(SESSION_TTL_MS / 1000));
      return sendJson(res, 200, { user: { username: user.username, displayName: user.profile.displayName } });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const store = readUsersStore();
      const raw = sessionFromRequest(req);
      if (raw) delete store.sessions[hashSession(raw)];
      writeUsersStore(store);
      setSessionCookie(req, res, "", 0);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/auth/me" && req.method === "GET") {
      const store = readUsersStore();
      const user = resolveSession(req, store);
      return sendJson(res, 200, { user: user ? { username: user.username, displayName: user.profile.displayName } : null });
    }

    if (pathname === "/api/leaderboard" && req.method === "GET") {
      const store = readUsersStore();
      const leaderboard = Object.values(store.users)
        .filter((user) => user.profile && user.profile.showOnLeaderboard)
        .map((user) => {
          const fields = publicUserFields(user);
          if (user.profile.shareNetWorth) {
            const desk = loadState(deskFileFor(user));
            const balanceTotal = Object.values(desk.balances || {}).reduce((sum, balance) => sum + (Number(balance.usdc) || 0), 0);
            const positionTotal = (desk.positions || []).filter((position) => position.status === "open").reduce((sum, position) => sum + valuePosition(position, Number(position.currentPrice ?? position.entryPrice) || 0).value, 0);
            fields.netWorth = round2(balanceTotal + positionTotal);
            fields.simulation = true;
          }
          return fields;
        })
        .sort((a, b) => (Number(b.netWorth) || 0) - (Number(a.netWorth) || 0));
      return sendJson(res, 200, { leaderboard });
    }

    const publicProfileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (publicProfileMatch && req.method === "GET") {
      let username;
      try { username = normalizeUsername(decodeURIComponent(publicProfileMatch[1])); } catch (_) { return sendJson(res, 400, { error: "Invalid username." }); }
      const store = readUsersStore();
      const user = Object.prototype.hasOwnProperty.call(store.users, username) ? store.users[username] : null;
      if (!user) return sendJson(res, 404, { error: "Profile not found." });
      return sendJson(res, 200, publicDeskData(user));
    }

    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      const spaRoute = /^\/u\/[^/]+\/?$/.test(pathname) || pathname === "/following" || pathname === "/leaderboard";
      const rel = pathname === "/" || spaRoute ? "/index.html" : pathname;
      const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, "");
      const filePath = path.join(FRONTEND_DIR, safe);
      if (!filePath.startsWith(FRONTEND_DIR)) return sendText(res, 403, "Forbidden");
      fs.readFile(filePath, (err, data) => {
        if (err && spaRoute) {
          return fs.readFile(path.join(FRONTEND_DIR, "index.html"), (indexError, indexData) => {
            if (indexError) return sendText(res, 404, "Not found");
            securityHeaders(res);
            res.writeHead(200, { "content-type": MIME[".html"] });
            res.end(indexData);
          });
        }
        if (err) return sendText(res, 404, "Not found");
        securityHeaders(res);
        res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
      return;
    }

    const store = readUsersStore();
    const user = resolveSession(req, store);
    if (!user) return sendJson(res, 401, { error: "Authentication required." });
    ACTIVE_DATA_FILE = deskFileFor(user);
    activeUserId = user.id;
    state = loadState(ACTIVE_DATA_FILE);

    if (pathname === "/api/profile" && req.method === "GET") {
      return sendJson(res, 200, { ...publicUserFields(user), ...user.profile });
    }
    if (pathname === "/api/profile" && req.method === "POST") {
      const body = await readBody(req);
      const validationError = profileValidation(body);
      if (validationError) return sendJson(res, 400, { error: validationError });
      const profile = { ...defaultProfile(user.username), ...user.profile };
      for (const key of Object.keys(body)) profile[key] = typeof body[key] === "string" ? body[key].trim() : body[key];
      if (!profile.displayName) return sendJson(res, 400, { error: "displayName cannot be empty." });
      user.profile = profile;
      writeUsersStore(store);
      return sendJson(res, 200, { ...publicUserFields(user), ...profile });
    }
    if (pathname === "/api/following" && req.method === "GET") {
      const users = Object.values(store.users);
      const followingIds = new Set(user.following || []);
      const followed = (user.following || []).map((id) => users.find((other) => other.id === id)).filter(Boolean);
      const followers = users.filter((other) => (other.following || []).includes(user.id));
      return sendJson(res, 200, {
        following: followed.map((other) => ({ ...publicDeskData(other), followsYou: (other.following || []).includes(user.id) })),
        followers: followers.map((other) => ({ ...publicDeskData(other), isFollowing: followingIds.has(other.id) })),
      });
    }
    if (pathname === "/api/following" && req.method === "POST") {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      if (!validUsername(username) || !["follow", "unfollow"].includes(body.action)) return sendJson(res, 400, { error: "Invalid username or action." });
      const target = Object.prototype.hasOwnProperty.call(store.users, username) ? store.users[username] : null;
      if (!target) return sendJson(res, 404, { error: "Profile not found." });
      if (target.id === user.id) return sendJson(res, 400, { error: "You cannot follow yourself." });
      if (!Array.isArray(user.following)) user.following = [];
      if (body.action === "follow" && !user.following.includes(target.id)) user.following.push(target.id);
      if (body.action === "unfollow") user.following = user.following.filter((id) => id !== target.id);
      writeUsersStore(store);
      return sendJson(res, 200, { ok: true, following: user.following.map((id) => Object.values(store.users).find((other) => other.id === id)).filter(Boolean).map(publicDeskData) });
    }

    // ---- API ----
    if (pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, {
        balances: state.balances,
        positions: state.positions.map(positionPublic),
        transactions: state.transactions,
        pnlLedger: state.pnlLedger,
        monthlyPositionPnl: monthlyPositionPnl(),
        dueDiligence: state.dueDiligence,
        leaders: state.leaders,
        claimedFeesTotal: round2(state.claimedFeesTotal),
        totalPortfolioUsdc: TOTAL_PORTFOLIO_USDC,
        settings: state.settings,
        agentLogs: (state.agentLogs || []).slice(0, 20),
      });
    }

    if (pathname === "/api/balance/fund" && req.method === "POST") {
      const b = await readBody(req);
      const chain = String(b.chain || "").toUpperCase();
      const requestedAmount = Number(b.amount);
      const amount = round2(requestedAmount);
      if (!CHAINS.includes(chain)) return sendJson(res, 400, { error: "Chain tidak valid." });
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > MAX_SIMULATED_TOPUP_USDC || amount <= 0) {
        return sendJson(res, 400, { error: "Nominal isi saldo harus lebih dari 0 dan maksimal $1.000.000 USDC per pengisian." });
      }
      if (!state.balances[chain]) state.balances[chain] = { usdc: 0, tokens: {} };
      state.balances[chain].usdc = round2((Number(state.balances[chain].usdc) || 0) + amount);
      state.transactions.unshift({
        id: uid("tx"),
        chain,
        symbol: "USDC",
        address: "",
        side: "deposit",
        amount,
        price: 1,
        at: new Date().toISOString(),
      });
      state.transactions = state.transactions.slice(0, 100);
      saveState(state);
      return sendJson(res, 200, { ok: true, chain, amount, balance: state.balances[chain].usdc, balances: state.balances, transactions: state.transactions });
    }

    if (pathname === "/api/reset" && req.method === "POST") {
      state = defaultState();
      candidatesCache = { at: 0, data: null };
      saveState(state);
      return sendJson(res, 200, { ok: true, message: "Demo direset ke keadaan default bersih." });
    }

    if (pathname === "/api/settings" && req.method === "GET") {
      return sendJson(res, 200, { settings: state.settings });
    }

    if (pathname === "/api/settings" && req.method === "POST") {
      const b = await readBody(req);
      const incoming = b && b.settings && typeof b.settings === "object" ? b.settings : null;
      if (!incoming) return sendJson(res, 400, { error: "Payload settings kosong." });
      const merged = JSON.parse(JSON.stringify(state.settings));
      for (const group of ["autoTrading", "tpSl", "copyTrading"]) {
        const g = incoming[group];
        if (g && typeof g === "object") {
          for (const key of Object.keys(g)) {
            if (Object.prototype.hasOwnProperty.call(merged[group], key)) merged[group][key] = g[key];
          }
        }
      }
      const at = merged.autoTrading;
      const tp = merged.tpSl;
      const ct = merged.copyTrading;
      const numFields = [
        ["autoTrading.minApr", at.minApr],
        ["autoTrading.minScore", at.minScore],
        ["autoTrading.amountPerPosition", at.amountPerPosition],
        ["autoTrading.maxPositions", at.maxPositions],
        ["autoTrading.dailyLossLimit", at.dailyLossLimit],
        ["autoTrading.minLiquidity", at.minLiquidity],
        ["autoTrading.minHolder", at.minHolder],
        ["tpSl.defaultTpPct", tp.defaultTpPct],
        ["tpSl.defaultSlPct", tp.defaultSlPct],
        ["copyTrading.amountPerCopy", ct.amountPerCopy],
        ["copyTrading.maxPositions", ct.maxPositions],
        ["copyTrading.dailyLossLimit", ct.dailyLossLimit],
      ];
      for (const [name, v] of numFields) {
        if (typeof v !== "number" || !isFinite(v) || v < 0) {
          return sendJson(res, 400, { error: "Nilai " + name + " tidak valid (harus angka >= 0)." });
        }
      }
      if (at.minScore > 100) return sendJson(res, 400, { error: "minScore harus 0..100." });
      if (at.minApr > 100000) return sendJson(res, 400, { error: "minApr harus 0..100000." });
      if (at.source !== "DEX" && at.source !== "UNISWAP_V4") return sendJson(res, 400, { error: "Sumber auto trading tidak valid." });
      if (at.amountPerPosition <= 0) return sendJson(res, 400, { error: "amountPerPosition harus > 0." });
      if (ct.amountPerCopy <= 0) return sendJson(res, 400, { error: "amountPerCopy harus > 0." });
      if (!Number.isInteger(at.maxPositions) || at.maxPositions < 1 || at.maxPositions > 20) {
        return sendJson(res, 400, { error: "maxPositions harus bilangan bulat 1..20." });
      }
      if (!Number.isInteger(ct.maxPositions) || ct.maxPositions < 1 || ct.maxPositions > 20) {
        return sendJson(res, 400, { error: "copyTrading.maxPositions harus bilangan bulat 1..20." });
      }
      if (ct.leaderId !== null && typeof ct.leaderId !== "string") {
        return sendJson(res, 400, { error: "copyTrading.leaderId tidak valid." });
      }
      merged.autoTrading.verdictFilter = normalizeVerdictFilter(merged.autoTrading.verdictFilter);
      state.settings = merged;
      saveState(state);
      return sendJson(res, 200, { settings: state.settings });
    }

    if (pathname === "/api/agent-logs" && req.method === "GET") {
      return sendJson(res, 200, { logs: (state.agentLogs || []).slice(0, 50) });
    }

    if (pathname === "/api/agent/auto-trading" && req.method === "POST") {
      const b = await readBody(req);
      if (b && b.action && b.action !== "run") return sendJson(res, 400, { error: "Action tidak valid." });
      const at = state.settings.autoTrading;
      const tp = state.settings.tpSl;
      if (!at.enabled) {
        return sendJson(res, 400, { error: "Auto Trading LP nonaktif. Aktifkan dulu di pengaturan Nara." });
      }
      const today = todayPnl();
      const dailyLossLimit = Number(at.dailyLossLimit) || 0;
      if (dailyLossLimit > 0 && today <= -dailyLossLimit) {
        const msg = "Berhenti: batas kerugian harian tercapai (PnL hari ini " + today + " USDC, batas -" + dailyLossLimit + " USDC).";
        logAgent("Nara", msg, "warn");
        return sendJson(res, 200, {
          stoppedByDailyLoss: true,
          todayPnl: today,
          dailyLossLimit,
          opened: [],
          skipped: [{ symbol: "-", reason: msg }],
        });
      }
      let agentOut;
      let v4Pools = [];
      try {
        agentOut = await runCandidateAgent();
        if (at.source === "UNISWAP_V4") v4Pools = (await runPoolAprScan()).pools;
      } catch (e) {
        return sendJson(res, e.statusCode || 502, {
          error: e.message || "Agent analysis gagal. Coba lagi nanti.",
          failedNetworks: e.failedNetworks || [],
        });
      }
      let candidates = (agentOut.recommendations || []).concat(agentOut.pending_candidates || []);
      if (at.source === "UNISWAP_V4") {
        const bestByToken = new Map();
        for (const pool of v4Pools) {
          if (pool.apr < Number(at.minApr || 0) || pool.tvlUsd < Number(at.minLiquidity || 0)) continue;
          for (const token of [pool.token0, pool.token1]) {
            const address = String(token && token.id || "");
            if (!isPoolTokenAddress(pool.chain, address)) continue;
            const key = tokenAddressKey(pool.chain, address);
            const previous = bestByToken.get(key);
            if (!previous || pool.apr > previous.apr) bestByToken.set(key, pool);
          }
        }
        candidates = candidates.filter((candidate) => bestByToken.has(tokenAddressKey(candidate.chain, candidate.address)))
          .map((candidate) => {
            const pool = bestByToken.get(tokenAddressKey(candidate.chain, candidate.address));
            return { ...candidate, pool_apr: pool.apr, pool_protocol: pool.protocol, pool_id: pool.poolId, pool_tvl_usd: pool.tvlUsd };
          }).sort((a, b) => b.pool_apr - a.pool_apr);
      } else {
        candidates = agentOut.recommendations || [];
      }
      const opened = [];
      const skipped = [];
      const openAddrs = new Set(state.positions.filter((p) => p.status === "open").map((p) => tokenAddressKey(p.chain, p.address)));
      const rangePct =
        at.rangePreset === "narrow" ? 0.02
        : at.rangePreset === "wide" ? 0.1
        : 0.05;
      let slots = Math.max(0, at.maxPositions - state.positions.filter((p) => p.status === "open").length);
      let allocated = state.positions.filter((p) => p.status === "open").reduce((s, p) => s + (Number(p.amount) || 0), 0);
      for (const c of candidates) {
        const sym = c.symbol || "???";
        const score = c.recommendation_score;
        const aVerdict = c.agent_analysis ? c.agent_analysis.verdict : null;
        if (at.source === "UNISWAP_V4" && (c.pool_apr == null || c.pool_apr < Number(at.minApr || 0))) {
          skipped.push({ symbol: sym, reason: "APR pool tidak memenuhi batas minimum." });
          continue;
        }
        if (!CHAINS.includes(c.chain)) {
          skipped.push({ symbol: sym, reason: "Chain " + c.chain + " di luar 7 chain simulasi." });
          continue;
        }
        const safetyReason = autoTradingRiskReason(c, { minLiquidityUsd: at.minLiquidity, minHolderCount: at.minHolder });
        if (safetyReason) {
          skipped.push({ symbol: sym, reason: safetyReason });
          continue;
        }
        if (score == null || Number(score) < Number(at.minScore)) {
          skipped.push({ symbol: sym, reason: "Skor " + (score == null ? "-" : score) + " di bawah minScore " + at.minScore + "." });
          continue;
        }
        if (at.verdictFilter !== "ANY" && aVerdict !== at.verdictFilter) {
          skipped.push({ symbol: sym, reason: "Verdict agent " + aVerdict + " tidak sesuai filter " + at.verdictFilter + "." });
          continue;
        }
        if (at.chainFilter !== "ALL" && c.chain !== at.chainFilter) {
          skipped.push({ symbol: sym, reason: "Chain " + c.chain + " tidak sesuai filter " + at.chainFilter + "." });
          continue;
        }
        if (c.address && openAddrs.has(tokenAddressKey(c.chain, c.address))) {
          skipped.push({ symbol: sym, reason: "Sudah ada posisi open untuk token ini." });
          continue;
        }
        if (Number(c.liquidity_usd || 0) < Number(at.minLiquidity)) {
          skipped.push({ symbol: sym, reason: "Likuiditas " + c.liquidity_usd + " di bawah minLiquidity " + at.minLiquidity + "." });
          continue;
        }
        if (c.holders_count == null) {
          skipped.push({ symbol: sym, reason: "Data holder tidak tersedia (dianggap TIDAK lolos, bukan lolos)." });
          continue;
        }
        if (Number(c.holders_count || 0) < Number(at.minHolder)) {
          skipped.push({ symbol: sym, reason: "Holder " + c.holders_count + " di bawah minHolder " + at.minHolder + "." });
          continue;
        }
        if (slots <= 0) {
          skipped.push({ symbol: sym, reason: "Slot posisi penuh (maks " + at.maxPositions + " posisi)." });
          continue;
        }
        if (allocated + Number(at.amountPerPosition) > TOTAL_PORTFOLIO_USDC) {
          skipped.push({ symbol: sym, reason: "Alokasi melebihi modal 5000 USDC." });
          continue;
        }
        const price = Number(c.price_usd) || 0;
        if (!(price > 0)) {
          skipped.push({ symbol: sym, reason: "Harga kandidat tidak valid." });
          continue;
        }
        const slPnlPct = Number(tp.defaultSlPct) > 0 ? Number(tp.defaultSlPct) : null;
        const tpPnlPct = Number(tp.defaultTpPct) > 0 ? Number(tp.defaultTpPct) : null;
        const r = openPositionInternal({
          chain: c.chain,
          address: c.address,
          symbol: c.symbol,
          name: c.name,
          pair: c.pair_symbol || "",
          pairUrl: c.dexscreener_url || "",
          poolAddress: c.pool_id || c.primary_pool_address || null,
          amount: Number(at.amountPerPosition),
          price,
          minPrice: roundPrice(price * (1 - rangePct)),
          maxPrice: roundPrice(price * (1 + rangePct)),
          side: "Both",
          strategy: "Spot",
          quote: "USDC",
          slPnlPct,
          tpPnlPct,
          binStepBps: c.chain === "SOL" ? 25 : 100,
          distribution: "50/50",
          source: "Auto Trading LP",
        });
        if (r.error) {
          skipped.push({ symbol: sym, reason: r.error });
          continue;
        }
        opened.push({ symbol: c.symbol, chain: c.chain, amount: Number(at.amountPerPosition), price, apr: c.pool_apr == null ? null : c.pool_apr, protocol: c.pool_protocol || null });
        if (c.address) openAddrs.add(tokenAddressKey(c.chain, c.address));
        slots -= 1;
        allocated += Number(at.amountPerPosition);
        logAgent("Nara", "Membuka LP " + c.symbol + " (" + c.chain + ") sebesar " + at.amountPerPosition + " USDC pada " + price + " USDC.", "ok", r.pos.id);
      }
      if (at.source === "UNISWAP_V4" && !candidates.length) {
        skipped.push({ symbol: "-", reason: "Tidak ada token pool APR yang cocok dengan feed analisis DEX Screener saat ini. Preview APR tidak otomatis membuka posisi; hanya kandidat yang dianalisis dan lolos semua guardrail yang dapat disimulasikan." });
      }
      logAgent("Nara", "Auto Trading selesai: " + opened.length + " dibuka, " + skipped.length + " dilewati (PnL hari ini " + today + " USDC).", "info");
      return sendJson(res, 200, { stoppedByDailyLoss: false, todayPnl: today, dailyLossLimit, opened, skipped });
    }

    if (pathname === "/api/agent/tp-sl-check" && req.method === "POST") {
      const opens = state.positions.filter((p) => p.status === "open" && ((p.slPnlPct != null && Number(p.slPnlPct) > 0) || (p.tpPnlPct != null && Number(p.tpPnlPct) > 0) || (p.sl != null && Number(p.sl) > 0) || (p.tp != null && Number(p.tp) > 0)));
      const checked = opens.length;
      const results = await Promise.allSettled(opens.map((p) => fetchLivePrice(p.address, null, p.chain)));
      let changed = false;
      results.forEach((res2, i) => {
        const live = res2.status === "fulfilled" ? res2.value : null;
        if (live != null && isFinite(live) && live > 0 && Number(opens[i].currentPrice) !== live) {
          opens[i].currentPrice = live;
          changed = true;
        }
      });
      if (changed) saveState(state);
      const closed = evaluateTpSlOnFreshPrices(opens);
      return sendJson(res, 200, { checked, closed });
    }

    /* ---- Copy Trading LP (Kopi) ---- */
    if (pathname === "/api/leaders" && req.method === "GET") {
      return sendJson(res, 200, { leaders: sortedLeaders() });
    }

    if (pathname === "/api/leaders" && req.method === "POST") {
      const b = await readBody(req);
      const label = String(b.label || "").trim();
      const wallet = String(b.wallet || "").trim();
      if (!label) return sendJson(res, 400, { error: "Label leader wajib diisi." });
      if (!wallet) return sendJson(res, 400, { error: "Alamat wallet leader wajib diisi." });
      const chain = (b.chain || "SOL").toUpperCase();
      if (!CHAINS.includes(chain)) return sendJson(res, 400, { error: "Chain leader tidak valid." });
      const winrate = Number(b.winrate);
      if (!isFinite(winrate) || winrate < 0 || winrate > 100) return sendJson(res, 400, { error: "Winrate harus angka 0..100." });
      const totalPnl = Number(b.totalPnl) || 0;
      const leader = {
        id: uid("ldr"),
        label,
        wallet,
        chain,
        platform: String(b.platform || "LP Agent Smart LP"),
        winrate,
        totalPnl,
        holdTime: String(b.holdTime || ""),
        strategy: ["Spot", "Curve", "Bid-Ask"].includes(b.strategy) ? b.strategy : "Spot",
        favoriteToken: String(b.favoriteToken || "").trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.leaders.push(leader);
      saveState(state);
      logAgent("Kopi", "Leader ditambahkan: " + label + " (" + chain + ", winrate " + winrate + "%) — input manual.", "info");
      return sendJson(res, 200, { ok: true, leader, leaders: sortedLeaders() });
    }

    if (pathname === "/api/leaders/update" && req.method === "POST") {
      const b = await readBody(req);
      const leader = (state.leaders || []).find((l) => l.id === b.id);
      if (!leader) return sendJson(res, 404, { error: "Leader tidak ditemukan." });
      const chain = b.chain != null ? String(b.chain).toUpperCase() : leader.chain;
      if (!CHAINS.includes(chain)) return sendJson(res, 400, { error: "Chain leader tidak valid." });
      const winrate = b.winrate != null ? Number(b.winrate) : leader.winrate;
      if (!isFinite(winrate) || winrate < 0 || winrate > 100) return sendJson(res, 400, { error: "Winrate harus angka 0..100." });
      leader.label = b.label != null ? String(b.label).trim() || leader.label : leader.label;
      leader.wallet = b.wallet != null ? String(b.wallet).trim() || leader.wallet : leader.wallet;
      leader.chain = chain;
      leader.platform = b.platform != null ? String(b.platform) : leader.platform;
      leader.winrate = winrate;
      leader.totalPnl = b.totalPnl != null ? Number(b.totalPnl) || 0 : leader.totalPnl;
      leader.holdTime = b.holdTime != null ? String(b.holdTime) : leader.holdTime;
      leader.strategy = ["Spot", "Curve", "Bid-Ask"].includes(b.strategy) ? b.strategy : leader.strategy;
      leader.favoriteToken = b.favoriteToken != null ? String(b.favoriteToken).trim() : leader.favoriteToken;
      leader.updatedAt = new Date().toISOString();
      saveState(state);
      return sendJson(res, 200, { ok: true, leader, leaders: sortedLeaders() });
    }

    if (pathname === "/api/leaders/delete" && req.method === "POST") {
      const b = await readBody(req);
      const idx = (state.leaders || []).findIndex((l) => l.id === b.id);
      if (idx < 0) return sendJson(res, 404, { error: "Leader tidak ditemukan." });
      const removed = state.leaders.splice(idx, 1)[0];
      if (state.settings.copyTrading.leaderId === removed.id) state.settings.copyTrading.leaderId = null;
      saveState(state);
      logAgent("Kopi", "Leader dihapus: " + removed.label + ".", "info");
      return sendJson(res, 200, { ok: true, leaders: sortedLeaders() });
    }

    if (pathname === "/api/agent/copy-trading" && req.method === "POST") {
      const b = await readBody(req);
      if (b && b.action && b.action !== "run") return sendJson(res, 400, { error: "Action tidak valid." });
      const ct = state.settings.copyTrading;
      const tp = state.settings.tpSl;
      if (!ct.enabled) {
        return sendJson(res, 400, { error: "Copy Trading LP nonaktif. Aktifkan dulu di pengaturan Kopi." });
      }
      const leader = pickCopyLeader();
      if (!leader) {
        return sendJson(res, 200, {
          opened: [],
          skipped: [{ symbol: "-", reason: "Watchlist leader kosong — tambahkan leader dulu (input manual dari Smart LP)." }],
          leader: null,
        });
      }
      const today = todayPnl();
      const dailyLossLimit = Number(ct.dailyLossLimit) || 0;
      if (dailyLossLimit > 0 && today <= -dailyLossLimit) {
        const msg = "Berhenti: batas kerugian harian Copy Trading tercapai (PnL hari ini " + today + " USDC, batas -" + dailyLossLimit + " USDC).";
        logAgent("Kopi", msg, "warn");
        return sendJson(res, 200, { stoppedByDailyLoss: true, todayPnl: today, dailyLossLimit, leader: { id: leader.id, label: leader.label, winrate: leader.winrate }, opened: [], skipped: [{ symbol: "-", reason: msg }] });
      }
      const opened = [];
      const skipped = [];
      const copyOpen = state.positions.filter((p) => p.status === "open" && p.source === "Copy Trading LP");
      let slots = Math.max(0, Number(ct.maxPositions) - copyOpen.length);
      if (slots <= 0) {
        skipped.push({ symbol: "-", reason: "Slot posisi copy penuh (maks " + ct.maxPositions + " posisi Copy Trading LP)." });
        return sendJson(res, 200, { leader: { id: leader.id, label: leader.label, winrate: leader.winrate }, opened, skipped });
      }
      // Tentukan target: token favorit leader (harga diverifikasi ulang via
      // DexScreener) atau kandidat teratas agent API di chain leader.
      let target = null;
      if (leader.favoriteToken) {
        try {
          const data = await fetchJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(leader.favoriteToken), 10000);
          const pairs = (data.pairs || []).filter((p) => chainFromPair(p));
          const onChain = leader.chain ? pairs.filter((p) => chainFromPair(p) === leader.chain) : [];
          const best = pickBestPair(onChain.length ? onChain : pairs);
          if (best) {
            target = {
              address: (best.baseToken && best.baseToken.address) || leader.favoriteToken,
              symbol: (best.baseToken && best.baseToken.symbol) || "TOKEN",
              name: (best.baseToken && best.baseToken.name) || "Unknown Token",
              price: roundPrice(best.priceUsd),
              chain: chainFromPair(best),
              pair: ((best.baseToken && best.baseToken.symbol) || "?") + "/" + ((best.quoteToken && best.quoteToken.symbol) || "?"),
              pairUrl: best.url || "",
              change24h: best.priceChange ? Number(best.priceChange.h24) || 0 : 0,
            };
          }
        } catch (_) {
          /* fall through ke kandidat agent */
        }
        if (!target) skipped.push({ symbol: leader.favoriteToken.slice(0, 10) + "…", reason: "Token favorit leader tidak punya pair di chain yang didukung — mencoba kandidat agent." });
      }
      if (!target) {
        try {
          const agentOut = await runCandidateAgent();
          const pool = (agentOut.recommendations || []).concat(agentOut.pending_candidates || []);
          const cand = pool.find((c) => !leader.chain || c.chain === leader.chain) || pool[0];
          if (cand) {
            target = {
              address: cand.address,
              symbol: cand.symbol,
              name: cand.name,
              price: Number(cand.price_usd) || 0,
              chain: cand.chain,
              pair: cand.pair_symbol || "",
              pairUrl: cand.dexscreener_url || "",
              change24h: Number(cand.price_change_24h) || 0,
            };
          }
        } catch (_) {
          /* agent gagal */
        }
      }
      if (!target || !(target.price > 0)) {
        skipped.push({ symbol: "-", reason: "Tidak ada target copy yang valid saat ini (token favorit/kandidat agent tidak tersedia)." });
        return sendJson(res, 200, { leader: { id: leader.id, label: leader.label, winrate: leader.winrate }, opened, skipped });
      }
      const already = state.positions.some((p) => p.status === "open" && (p.address || "").toLowerCase() === (target.address || "").toLowerCase());
      if (already) {
        skipped.push({ symbol: target.symbol, reason: "Guardrail anti-duplikat: token ini sudah punya posisi terbuka." });
        return sendJson(res, 200, { leader: { id: leader.id, label: leader.label, winrate: leader.winrate }, opened, skipped });
      }
      const allocated = state.positions.filter((p) => p.status === "open").reduce((s, p) => s + (Number(p.amount) || 0), 0);
      if (allocated + Number(ct.amountPerCopy) > TOTAL_PORTFOLIO_USDC) {
        skipped.push({ symbol: target.symbol, reason: "Alokasi melebihi modal 5000 USDC." });
        return sendJson(res, 200, { leader: { id: leader.id, label: leader.label, winrate: leader.winrate }, opened, skipped });
      }
      const strategy = ["Spot", "Curve", "Bid-Ask"].includes(leader.strategy) ? leader.strategy : "Spot";
      const range = computeRange(target.price, 25, strategy, target.change24h);
      const slPnlPct = Number(tp.defaultSlPct) > 0 ? Number(tp.defaultSlPct) : null;
      const tpPnlPct = Number(tp.defaultTpPct) > 0 ? Number(tp.defaultTpPct) : null;
      const r = openPositionInternal({
        chain: target.chain,
        address: target.address,
        symbol: target.symbol,
        name: target.name,
        pair: target.pair,
        pairUrl: target.pairUrl,
        amount: Number(ct.amountPerCopy),
        price: target.price,
        minPrice: range.minPrice,
        maxPrice: range.maxPrice,
        lowerBin: range.lowerBin,
        upperBin: range.upperBin,
        side: "Both",
        strategy,
        quote: "USDC",
        slPnlPct,
        tpPnlPct,
        binStepBps: 25,
        distribution: "50/50",
        source: "Copy Trading LP",
        copyLeaderId: leader.id,
        product: target.chain === "SOL" ? "DLMM" : "SIM_RANGE",
      });
      if (r.error) {
        skipped.push({ symbol: target.symbol, reason: r.error });
      } else {
        opened.push({ symbol: target.symbol, chain: target.chain, amount: Number(ct.amountPerCopy), price: target.price });
        logAgent("Kopi", "Copy " + leader.label + ": membuka LP " + target.symbol + " (" + target.chain + ") sebesar " + ct.amountPerCopy + " USDC — mengikuti profil strategi leader (simulasi).", "ok", r.pos.id);
      }
      logAgent("Kopi", "Copy Trading selesai (leader " + leader.label + "): " + opened.length + " dibuka, " + skipped.length + " dilewati.", "info");
      return sendJson(res, 200, { leader: { id: leader.id, label: leader.label, winrate: leader.winrate }, todayPnl: today, opened, skipped });
    }

    if (pathname === "/api/realtime" && req.method === "GET") {
      await repriceOpenPositions();
      let closedByTpSl = [];
      if (state.settings.tpSl.armed) {
        const opens = state.positions.filter((p) => p.status === "open");
        closedByTpSl = evaluateTpSlOnFreshPrices(opens);
      }
      const openNow = state.positions.filter((p) => p.status === "open");
      const allocatedCapital = round2(openNow.reduce((s, p) => s + (Number(p.amount) || 0), 0));
      const claimableFees = round2(openNow.reduce((s, p) => s + (Number(p.fees) || 0) + (Number(p.rewards) || 0), 0));
      const positions = openNow.map((p) => {
        const entry = Number(p.entryPrice) || 0;
        const livePrice = roundPrice(p.currentPrice ?? p.entryPrice);
        // Nilai dari valuasi bersama valuePosition() (model CL) — konsisten
        // dengan kartu posisi (positionPublic) dan total PnL di atas.
        const value = valuePosition(p, livePrice).value;
        // entryPrice + pnlPct: untuk ticker gaya hosted ("SIMBOL / PAIR
        // $harga ±persen% vs entry"); pair dipakai sebagai label pair.
        const pnlPct = entry > 0 ? round2(((livePrice - entry) / entry) * 100) : 0;
        const inRange = livePrice >= Number(p.minPrice) && livePrice <= Number(p.maxPrice);
        return { id: p.id, symbol: p.symbol, chain: p.chain, pair: p.pair || "", entryPrice: roundPrice(entry), livePrice, value, pnl: round2(value - Number(p.amount)), pnlPct, inRange };
      });
      return sendJson(res, 200, {
        isLive: true,
        intervalSec: 5,
        portfolioValue: livePortfolioValue(),
        totalPnl: totalPnlLive(),
        freeCapital: round2(TOTAL_PORTFOLIO_USDC - allocatedCapital),
        allocatedCapital,
        claimableFees,
        positions,
        closedByTpSl,
        lastUpdated: new Date().toISOString(),
      });
    }

    if (pathname === "/api/dex/search" && req.method === "GET") {
      const q = parsed.searchParams.get("q") || "";
      if (!q.trim()) return sendJson(res, 200, { pairs: [] });
      try {
        const data = await fetchJson("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q), 12000);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: "DexScreener tidak dapat dihubungi. Coba lagi nanti." });
      }
    }

    if (pathname === "/api/dex/token" && req.method === "GET") {
      const address = parsed.searchParams.get("address") || "";
      if (!address.trim()) return sendJson(res, 400, { error: "Alamat token kosong." });
      try {
        const data = await fetchJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(address), 12000);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: "DexScreener tidak dapat dihubungi. Coba lagi nanti." });
      }
    }

    if (["/api/pools/apr", "/api/uniswap-v4/pools"].includes(pathname) && req.method === "GET") {
      try {
        return sendJson(res, 200, await runPoolAprScan());
      } catch (e) {
        return sendJson(res, e.statusCode || 502, {
          error: e.message || "Gagal mengambil data APR pool.",
          failedNetworks: e.failedNetworks || [],
        });
      }
    }

    if (pathname === "/api/candidates" && req.method === "GET") {
      try {
        const out = await runCandidateAgent();
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 502, { error: "Agent analysis gagal. Coba lagi nanti." });
      }
    }

    /* ---- Copy LP (penemuan pool semua chain) ---- */
    if (pathname === "/api/copylp/discover" && req.method === "GET") {
      const address = (parsed.searchParams.get("address") || "").trim();
      if (!address) return sendJson(res, 400, { error: "Alamat token (CA) kosong." });
      try {
        const out = await discoverPools(address);
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 502, { error: "Discovery pool gagal. Coba lagi nanti." });
      }
    }

    if (pathname === "/api/copylp/range" && req.method === "POST") {
      const b = await readBody(req);
      const price = Number(b.price) || 0;
      if (!(price > 0)) return sendJson(res, 400, { error: "Harga tidak valid." });
      const strategy = ["Spot", "Curve", "Bid-Ask"].includes(b.strategy) ? b.strategy : "Spot";
      const range = computeRange(price, Number(b.binStepBps) || 25, strategy, Number(b.change24h) || 0);
      return sendJson(res, 200, { ok: true, strategy, ...range });
    }

    if (pathname === "/api/copylp/open" && req.method === "POST") {
      const b = await readBody(req);
      const price = Number(b.price) || 0;
      const minPrice = Number(b.minPrice) || 0;
      const maxPrice = Number(b.maxPrice) || 0;
      if (!(price > 0) || minPrice <= 0 || maxPrice <= minPrice) {
        return sendJson(res, 400, { error: "Harga/range tidak valid untuk membuka posisi copy." });
      }
      const isDlmm = (b.chain || "").toUpperCase() === "SOL" && b.source === "Meteora DLMM";
      const r = openPositionInternal({
        chain: b.chain,
        address: b.tokenAddress || b.address || "",
        symbol: b.symbol,
        name: b.name,
        pair: b.name || "",
        pairUrl: b.pairUrl || "",
        poolAddress: b.poolAddress || null,
        amount: Number(b.amount) || 0,
        price,
        minPrice,
        maxPrice,
        lowerBin: b.lowerBin,
        upperBin: b.upperBin,
        side: "Both",
        strategy: ["Spot", "Curve", "Bid-Ask"].includes(b.strategy) ? b.strategy : "Spot",
        quote: b.quote || "USDC",
        sl: b.sl,
        tp: b.tp,
        binStepBps: Number(b.binStepBps) || 25,
        distribution: "50/50",
        source: "Copy LP",
        product: isDlmm ? "DLMM" : "SIM_RANGE",
      });
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, { ok: true, position: positionPublic(r.pos) });
    }

    if (pathname === "/api/copylp/pool-positions" && req.method === "GET") {
      const pool = parsed.searchParams.get("pool") || "";
      if (!pool) return sendJson(res, 400, { error: "Parameter pool kosong." });
      const list = state.positions
        .filter((p) => p.poolAddress === pool)
        .map((p) => {
          const pub = positionPublic(p);
          return { ...pub, upnl: round2(pub.value + (Number(p.fees) || 0) + (Number(p.rewards) || 0) - Number(p.amount)) };
        });
      return sendJson(res, 200, { pool, positions: list });
    }

    if (pathname === "/api/copylp/monitor" && req.method === "POST") {
      const targets = state.positions.filter((p) => p.status === "open" && p.poolAddress);
      const results = await Promise.allSettled(targets.map((p) => fetchLivePrice(p.address, null)));
      let changed = false;
      results.forEach((res2, i) => {
        const live = res2.status === "fulfilled" ? res2.value : null;
        if (live != null && isFinite(live) && live > 0 && Number(targets[i].currentPrice) !== live) {
          targets[i].currentPrice = live;
          changed = true;
        }
      });
      if (changed) saveState(state);
      const report = targets.map((p) => {
        const pub = positionPublic(p);
        let suggestion = "Tetap di range — tidak ada tindakan.";
        if (!pub.inRange) {
          suggestion = p.product === "DLMM" ? "Keluar range — disarankan REBALANCE (cara Meteora/DLMM)." : "Keluar range — disarankan TUTUP posisi (range generik non-DLMM).";
        }
        return {
          id: p.id,
          symbol: p.symbol,
          chain: p.chain,
          poolAddress: p.poolAddress,
          livePrice: pub.currentPrice,
          inRange: pub.inRange,
          minPrice: p.minPrice,
          maxPrice: p.maxPrice,
          suggestion,
        };
      });
      const outCount = report.filter((r) => !r.inRange).length;
      logAgent("Copy LP", "Monitor memeriksa " + report.length + " posisi copy; " + outCount + " di luar range.", outCount ? "warn" : "info");
      return sendJson(res, 200, { checked: report.length, outOfRange: outCount, positions: report });
    }

    if (pathname === "/api/monthly" && req.method === "GET") {
      const month = parsed.searchParams.get("month") || monthKey();
      return sendJson(res, 200, monthlySummary(month));
    }

    if (pathname === "/api/trade" && req.method === "POST") {
      const b = await readBody(req);
      const chain = (b.chain || "").toUpperCase();
      const amount = Number(b.amount) || 0;
      const price = Number(b.price) || 0;
      const symbol = b.symbol || "TOKEN";
      const address = b.address || "";
      if (!CHAINS.includes(chain)) return sendJson(res, 400, { error: "Chain tidak valid." });
      if (amount <= 0 || price <= 0) return sendJson(res, 400, { error: "Nominal dan harga harus lebih dari 0." });
      const bal = state.balances[chain];
      if (b.side === "buy") {
        if (bal.usdc < amount) return sendJson(res, 400, { error: "Saldo simulasi tidak cukup di chain " + chain + "." });
        bal.usdc = round2(bal.usdc - amount);
        const qty = amount / price;
        bal.tokens[address] = bal.tokens[address] || { symbol, qty: 0 };
        bal.tokens[address].qty += qty;
      } else if (b.side === "sell") {
        const held = bal.tokens[address]?.qty || 0;
        const qty = amount / price;
        if (held < qty) return sendJson(res, 400, { error: "Saldo token simulasi tidak cukup." });
        bal.tokens[address].qty = Math.max(0, held - qty);
        bal.usdc = round2(bal.usdc + amount);
      } else {
        return sendJson(res, 400, { error: "Arah transaksi tidak valid." });
      }
      state.transactions.unshift({
        id: uid("tx"),
        chain,
        symbol,
        address,
        side: b.side,
        amount: round2(amount),
        price: roundPrice(price),
        at: new Date().toISOString(),
      });
      state.transactions = state.transactions.slice(0, 100);
      saveState(state);
      return sendJson(res, 200, { ok: true, balances: state.balances, transactions: state.transactions });
    }

    if (pathname === "/api/lp/open" && req.method === "POST") {
      const b = await readBody(req);
      // SL/TP dari terminal adalah persentase PnL terhadap modal USD posisi.
      // Alias slPct/tpPct tetap diterima; sl/tp absolut hanya untuk posisi lama.
      if (b.slPnlPct == null && b.slPct != null) b.slPnlPct = Math.abs(Number(b.slPct));
      if (b.tpPnlPct == null && b.tpPct != null) b.tpPnlPct = Math.abs(Number(b.tpPct));
      for (const [field, value] of [["slPnlPct", b.slPnlPct], ["tpPnlPct", b.tpPnlPct]]) {
        if (value != null && (!Number.isFinite(Number(value)) || Math.abs(Number(value)) > 100000)) {
          return sendJson(res, 400, { error: field + " harus angka antara 0 dan 100000." });
        }
      }
      if (b.slPnlPct != null || b.tpPnlPct != null || b.slPct != null || b.tpPct != null) {
        b.slPnlPct = b.slPnlPct == null || Number(b.slPnlPct) === 0 ? null : Math.abs(Number(b.slPnlPct));
        b.tpPnlPct = b.tpPnlPct == null || Number(b.tpPnlPct) === 0 ? null : Math.abs(Number(b.tpPnlPct));
        b.sl = null;
        b.tp = null;
      }
      const r = openPositionInternal(b);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, { ok: true, position: positionPublic(r.pos) });
    }

    if (pathname === "/api/lp/refresh" && req.method === "POST") {
      const date = todayISO();
      let accrued = 0;
      for (const p of state.positions) {
        if (p.status !== "open") continue;
        const drift = 1 + (Math.random() - 0.5) * 0.02;
        p.currentPrice = roundPrice((p.currentPrice ?? p.entryPrice) * drift);
        const fee = round2(p.amount * 0.001 * (0.5 + Math.random()));
        const reward = round2(fee * 0.2);
        p.fees = round2((p.fees || 0) + fee);
        p.rewards = round2((p.rewards || 0) + reward);
        accrued += fee + reward;
      }
      if (accrued > 0) {
        state.pnlLedger.push({ date, delta: round2(accrued), kind: "fee", ref: "refresh" });
      }
      saveState(state);
      return sendJson(res, 200, { ok: true, accrued: round2(accrued), positions: state.positions.map(positionPublic) });
    }

    if (pathname === "/api/lp/claim" && req.method === "POST") {
      const b = await readBody(req);
      const p = state.positions.find((x) => x.id === b.id);
      if (!p) return sendJson(res, 404, { error: "Posisi tidak ditemukan." });
      const claimed = round2((p.fees || 0) + (p.rewards || 0));
      p.claimed = round2((Number(p.claimed) || 0) + claimed);
      p.fees = 0;
      p.rewards = 0;
      state.claimedFeesTotal = round2(state.claimedFeesTotal + claimed);
      if (claimed > 0) state.feeClaimLog.push({ date: todayISO(), amount: claimed, ref: p.id });
      saveState(state);
      return sendJson(res, 200, { ok: true, claimed, position: positionPublic(p) });
    }

    if (pathname === "/api/lp/close" && req.method === "POST") {
      const b = await readBody(req);
      const p = state.positions.find((x) => x.id === b.id);
      if (!p) return sendJson(res, 404, { error: "Posisi tidak ditemukan." });
      if (p.status !== "open") return sendJson(res, 400, { error: "Posisi sudah ditutup." });
      const r = closePositionInternal(p, "close");
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, { ok: true, position: positionPublic(r.pos) });
    }

    if (pathname === "/api/lp/rebalance" && req.method === "POST") {
      const b = await readBody(req);
      const old = state.positions.find((x) => x.id === b.id);
      if (!old) return sendJson(res, 404, { error: "Posisi tidak ditemukan." });
      if (old.status !== "open") return sendJson(res, 400, { error: "Posisi sudah ditutup." });
      const minPrice = Number(b.minPrice) || 0;
      const maxPrice = Number(b.maxPrice) || 0;
      if (minPrice <= 0 || maxPrice <= minPrice) return sendJson(res, 400, { error: "Range min/max tidak valid." });
      // Tutup posisi lama dulu, lalu danai pengganti dari NILAI SETTLED posisi
      // lama (bukan nominal awal) — pelajaran bug v3: pengganti tidak boleh
      // ditolak saldo setelah posisi lama tertutup.
      const closed = closePositionInternal(old, "rebalance");
      if (closed.error) return sendJson(res, 400, { error: closed.error });
      const entryPrice = roundPrice(old.currentPrice ?? old.entryPrice);
      const opened = openPositionInternal({
        chain: old.chain,
        address: old.address,
        symbol: old.symbol,
        name: old.name,
        pair: old.pair,
        pairUrl: old.pairUrl,
        poolAddress: old.poolAddress,
        product: old.product,
        source: old.source,
        copyLeaderId: old.copyLeaderId,
        amount: closed.settledValue,
        price: entryPrice,
        minPrice,
        maxPrice,
        side: old.side,
        strategy: old.strategy,
        quote: old.quote,
        sl: old.sl,
        tp: old.tp,
        slPnlPct: old.slPnlPct,
        tpPnlPct: old.tpPnlPct,
        binStepBps: old.binStepBps,
        distribution: old.distribution,
        replaces: old.id,
        skipBalanceCheck: true,
      });
      if (opened.error) return sendJson(res, 400, { error: opened.error });
      old.replacedBy = opened.pos.id;
      saveState(state);
      logAgent("Copy LP", "Rebalance " + old.symbol + ": posisi lama ditutup, pengganti didanai dari nilai settled " + closed.settledValue + " USDC.", "info", opened.pos.id);
      return sendJson(res, 200, { ok: true, old: positionPublic(old), replacement: positionPublic(opened.pos), settledValue: closed.settledValue });
    }

    if (pathname === "/api/lp/delete" && req.method === "POST") {
      const b = await readBody(req);
      const idx = state.positions.findIndex((x) => x.id === b.id);
      if (idx < 0) return sendJson(res, 404, { error: "Posisi tidak ditemukan." });
      const pos = state.positions[idx];
      // Posisi dalam rantai rebalance DLMM tidak boleh dihapus: menghapusnya
      // akan merusak relasi posisi lama <-> pengganti.
      if (pos.replaces || pos.replacedBy) {
        return sendJson(res, 400, {
          error: "Posisi ini bagian dari rantai rebalance DLMM (terhubung ke posisi " + (pos.replacedBy || pos.replaces) + ") — tidak bisa dihapus agar relasi posisi tidak rusak.",
        });
      }
      const removedLedger = state.pnlLedger.filter((e) => e.ref === pos.id).length;
      state.pnlLedger = state.pnlLedger.filter((e) => e.ref !== pos.id);
      const feeRows = state.feeClaimLog.filter((e) => e.ref === pos.id);
      const feeSum = feeRows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      state.feeClaimLog = state.feeClaimLog.filter((e) => e.ref !== pos.id);
      if (feeSum > 0) state.claimedFeesTotal = Math.max(0, round2(state.claimedFeesTotal - feeSum));
      const removedLogs = (state.agentLogs || []).filter((l) => l.ref === pos.id).length;
      state.agentLogs = (state.agentLogs || []).filter((l) => l.ref !== pos.id);
      state.positions.splice(idx, 1);
      saveState(state);
      return sendJson(res, 200, {
        ok: true,
        deletedId: pos.id,
        pair: pos.pair || pos.symbol,
        status: pos.status,
        removedLedgerRows: removedLedger,
        removedLogRows: removedLogs,
      });
    }

    if (pathname === "/api/dd" && req.method === "POST") {
      const b = await readBody(req);
      const address = b.address || "";
      if (!address) return sendJson(res, 400, { error: "Alamat token kosong." });
      const checks = b.checks || {};
      const keys = ["organic", "holders", "bundling", "cabal", "sameBlock", "social"];
      const done = keys.filter((k) => checks[k] && checks[k] !== "pending").length;
      let verdict = "Pending";
      if (done === keys.length) {
        const bad = keys.filter((k) => checks[k] === "fail").length;
        const warn = keys.filter((k) => checks[k] === "warn").length;
        verdict =
          bad >= 2 ? "Avoid"
          : bad === 1 || warn >= 2 ? "Short-term play"
          : "Consider";
      }
      state.dueDiligence[address] = {
        address,
        chain: b.chain || "",
        symbol: b.symbol || "",
        checks,
        completedChecks: done,
        verdict,
        notes: b.notes || "",
        updatedAt: new Date().toISOString(),
      };
      candidatesCache = { at: 0, data: null };
      saveState(state);
      return sendJson(res, 200, { ok: true, dd: state.dueDiligence[address] });
    }

    if (pathname === "/api/dd" && req.method === "GET") {
      return sendJson(res, 200, state.dueDiligence);
    }

    return sendJson(res, 404, { error: "Endpoint tidak ditemukan." });
  } catch (e) {
    if (!res.headersSent) return sendJson(res, 500, { error: "Terjadi kesalahan server. Coba lagi nanti." });
    if (!res.writableEnded) res.end();
  }
}

let requestQueue = Promise.resolve();
const server = http.createServer((req, res) => {
  const current = requestQueue.then(() => handleRequest(req, res));
  requestQueue = current.catch(() => {});
});

server.listen(PORT, HOST, () => {
  console.log("LP Desk local v4 running at http://" + HOST + ":" + PORT);
});
