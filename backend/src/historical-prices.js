"use strict";

const { tokenAddressKey, isPoolTokenAddress } = require("./uniswap-v4");

const GECKO_NETWORKS = { SOL: "solana", BASE: "base", ETH: "eth", BSC: "bsc", ROBINHOOD: "robinhood", HYPEREVM: "hyperevm", ARC: "arc" };
const CACHE_TTL_MS = 5 * 60 * 1000;
const historyCache = new Map();
let nextRequestAt = 0;
let slotQueue = Promise.resolve();

async function waitForGeckoSlot(fetchImpl) {
  if (fetchImpl !== fetch) return;
  const slot = slotQueue.then(async () => {
    while (nextRequestAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, nextRequestAt - Date.now()));
    nextRequestAt = Date.now() + 6500;
  });
  slotQueue = slot.catch(() => {});
  await slot;
}

function normalizeGeckoOhlcv(payload) {
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error("Format respons OHLCV GeckoTerminal tidak valid.");
  const candles = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6 || row.slice(0, 6).some((value) => value == null || value === "")) continue;
    const [timestamp, open, high, low, close, volumeUsd] = row.slice(0, 6).map(Number);
    if (![timestamp, open, high, low, close, volumeUsd].every(Number.isFinite) || !Number.isInteger(timestamp) || timestamp <= 0 ||
      ![open, high, low, close].every((price) => price > 0) || volumeUsd < 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    candles.set(timestamp * 1000, { at: timestamp * 1000, open, high, low, close, volumeUsd });
  }
  return [...candles.values()].sort((a, b) => a.at - b.at);
}

async function fetchPoolHistory(candidate, { from, to }, fetchImpl) {
  const network = GECKO_NETWORKS[candidate.chain];
  if (!network) throw new Error("Riwayat OHLCV belum didukung untuk chain " + candidate.chain + ".");
  if (!isPoolTokenAddress(candidate.chain, candidate.address)) throw new Error("Alamat token OHLCV tidak valid.");
  const pool = String(candidate.pool_id || candidate.primary_pool_address || "");
  const validPool = candidate.chain === "SOL" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool) : /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pool);
  if (!validPool) throw new Error("Alamat pool untuk riwayat OHLCV tidak tersedia atau tidak valid.");
  const candles = new Map();
  let before = Math.floor(to / 1000) - 1;
  for (let page = 0; page < 2; page++) {
    const url = new URL("https://api.geckoterminal.com/api/v2/networks/" + network + "/pools/" + encodeURIComponent(pool) + "/ohlcv/hour");
    url.search = new URLSearchParams({ aggregate: "1", limit: "1000", before_timestamp: String(before), currency: "usd", token: candidate.address, include_empty_intervals: "true" }).toString();
    let payload;
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitForGeckoSlot(fetchImpl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetchImpl(url.toString(), { signal: controller.signal, headers: { accept: "application/json;version=20230203" } });
        if (response.status === 429 && attempt === 0 && fetchImpl === fetch) {
          nextRequestAt = Math.max(nextRequestAt, Date.now() + 60000);
          continue;
        }
        if (!response.ok) throw new Error(response.status === 429 ? "Rate limit GeckoTerminal (HTTP 429); coba lagi nanti." : "GeckoTerminal OHLCV HTTP " + response.status + ".");
        payload = await response.json();
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
    const requestedKey = tokenAddressKey(candidate.chain, candidate.address);
    // GeckoTerminal places the requested chart token in meta.base, even for quote charts.
    const tokenMatches = payload?.meta?.base?.address && tokenAddressKey(candidate.chain, payload.meta.base.address) === requestedKey;
    if (!tokenMatches) throw new Error("Identitas token pada respons OHLCV tidak cocok dengan kandidat.");
    const rows = normalizeGeckoOhlcv(payload);
    for (const candle of rows) if (candle.at >= from && candle.at < to) candles.set(candle.at, candle);
    if (!rows.length || rows[0].at <= from || payload.data.attributes.ohlcv_list.length < 1000) break;
    before = Math.floor(rows[0].at / 1000) - 1;
  }
  return [...candles.values()].sort((a, b) => a.at - b.at);
}

async function loadNaraPriceHistories(candidates, period, fetchImpl = fetch) {
  const histories = [];
  // Bound concurrent requests and share successful/in-flight history across runs.
  for (let index = 0; index < candidates.length; index += 2) {
    const batch = await Promise.all(candidates.slice(index, index + 2).map(async (candidate) => {
      const key = tokenAddressKey(candidate.chain, candidate.address);
      const cacheKey = key + ":" + (candidate.pool_id || candidate.primary_pool_address) + ":" + period.from + ":" + period.to;
      try {
        let entry = fetchImpl === fetch ? historyCache.get(cacheKey) : null;
        if (!entry || Date.now() - entry.at >= CACHE_TTL_MS) {
          const promise = fetchPoolHistory(candidate, period, fetchImpl);
          entry = { at: Date.now(), promise };
          if (fetchImpl === fetch) {
            historyCache.set(cacheKey, entry);
            if (historyCache.size > 50) historyCache.delete(historyCache.keys().next().value);
            promise.catch(() => { if (historyCache.get(cacheKey) === entry) historyCache.delete(cacheKey); });
          }
        }
        return { key, candles: await entry.promise, error: null };
      } catch (error) {
        return { key, candles: [], error: error.name === "AbortError" ? "Timeout memuat riwayat OHLCV GeckoTerminal." : error.message || "Riwayat OHLCV gagal dimuat." };
      }
    }));
    histories.push(...batch);
  }
  return histories;
}

module.exports = { normalizeGeckoOhlcv, loadNaraPriceHistories };
