"use strict";

const { autoTradingRiskReason } = require("./auto-trading-risk");
const { positionExitReason } = require("./position-risk");
const { valuePosition } = require("./position-valuation");
const { tokenAddressKey, isPoolTokenAddress } = require("./uniswap-v4");

const HOUR_MS = 60 * 60 * 1000;
const BACKTEST_DAYS = 30;
const MAX_HISTORY_CANDIDATES = 10;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function backtestSettings(saved, overrides, chains) {
  const result = { autoTrading: { ...saved.autoTrading }, tpSl: { ...saved.tpSl } };
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) invalid("Settings backtest tidak valid.");
    for (const group of ["autoTrading", "tpSl"]) {
      if (overrides[group] === undefined) continue;
      if (!overrides[group] || typeof overrides[group] !== "object" || Array.isArray(overrides[group])) invalid("Settings " + group + " tidak valid.");
      for (const key of Object.keys(result[group])) {
        if (Object.prototype.hasOwnProperty.call(overrides[group], key)) result[group][key] = overrides[group][key];
      }
    }
  }
  const at = result.autoTrading;
  const tp = result.tpSl;
  for (const [name, number] of Object.entries({
    minScore: at.minScore, amountPerPosition: at.amountPerPosition, maxPositions: at.maxPositions,
    dailyLossLimit: at.dailyLossLimit, minLiquidity: at.minLiquidity, minHolder: at.minHolder,
    minApr: at.minApr, defaultTpPct: tp.defaultTpPct, defaultSlPct: tp.defaultSlPct,
  })) {
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
      invalid("Nilai " + name + " harus angka >= 0 yang valid.");
    }
  }
  if (at.minScore > 100) invalid("minScore harus 0..100.");
  if (at.amountPerPosition < 0.01 || at.amountPerPosition > 5000) invalid("Nominal backtest harus $0.01..$5,000 per posisi.");
  if (!Number.isInteger(at.maxPositions) || at.maxPositions < 1 || at.maxPositions > 20) invalid("maxPositions harus bilangan bulat 1..20.");
  if (at.minApr > 100000) invalid("minApr harus 0..100000.");
  if (!["DEX", "UNISWAP_V4"].includes(at.source)) invalid("Sumber kandidat backtest tidak valid.");
  if (!["narrow", "medium", "wide"].includes(at.rangePreset)) invalid("Preset range backtest tidak valid.");
  if (!["ANY", "consider", "review", "avoid"].includes(at.verdictFilter)) invalid("Filter verdict backtest tidak valid.");
  if (at.chainFilter !== "ALL" && !chains.includes(at.chainFilter)) invalid("Filter chain backtest tidak valid.");
  if (typeof at.enabled !== "boolean" || typeof tp.armed !== "boolean") invalid("Toggle settings backtest tidak valid.");
  at.amountPerPosition = round2(at.amountPerPosition);
  return result;
}

// Keep APR token selection identical for manual Nara runs and historical scenarios.
function selectNaraCandidates(agentOut, at, pools = []) {
  if (at.source !== "UNISWAP_V4") return agentOut.recommendations || [];
  const bestByToken = new Map();
  for (const pool of pools) {
    if (pool.apr < Number(at.minApr || 0) || pool.tvlUsd < Number(at.minLiquidity || 0)) continue;
    for (const token of [pool.token0, pool.token1]) {
      const address = String(token && token.id || "");
      if (!isPoolTokenAddress(pool.chain, address)) continue;
      const key = tokenAddressKey(pool.chain, address);
      if (!bestByToken.has(key) || pool.apr > bestByToken.get(key).apr) bestByToken.set(key, pool);
    }
  }
  return (agentOut.recommendations || []).concat(agentOut.pending_candidates || [])
    .filter((candidate) => bestByToken.has(tokenAddressKey(candidate.chain, candidate.address)))
    .map((candidate) => {
      const pool = bestByToken.get(tokenAddressKey(candidate.chain, candidate.address));
      return { ...candidate, pool_apr: pool.apr, pool_protocol: pool.protocol, pool_id: pool.poolId,
        pool_tvl_usd: pool.tvlUsd, pool_created_at: pool.poolCreatedAt };
    }).sort((a, b) => b.pool_apr - a.pool_apr);
}

function filterBacktestCandidates(candidates, at, now, chains) {
  const eligible = [];
  const skipped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = tokenAddressKey(candidate.chain, candidate.address);
    let reason = null;
    if (!chains.includes(candidate.chain)) reason = "Chain tidak didukung desk simulasi.";
    else if (!isPoolTokenAddress(candidate.chain, candidate.address)) reason = "Alamat token tidak valid.";
    else if (at.chainFilter !== "ALL" && candidate.chain !== at.chainFilter) reason = "Chain tidak sesuai filter " + at.chainFilter + ".";
    else if (candidate.recommendation_score == null || !Number.isFinite(Number(candidate.recommendation_score)) || Number(candidate.recommendation_score) < at.minScore) reason = "Skor di bawah minScore " + at.minScore + ".";
    else if (at.verdictFilter !== "ANY" && candidate.agent_analysis?.verdict !== at.verdictFilter) reason = "Verdict tidak sesuai filter " + at.verdictFilter + ".";
    else if (at.source === "UNISWAP_V4" && (candidate.pool_apr == null || !Number.isFinite(Number(candidate.pool_apr)) || Number(candidate.pool_apr) < at.minApr)) reason = "APR pool di bawah minimum.";
    else reason = autoTradingRiskReason(candidate, { now, minLiquidityUsd: at.minLiquidity, minHolderCount: at.minHolder });
    if (!reason && seen.has(key)) reason = "Kandidat token duplikat.";
    if (reason) skipped.push({ symbol: candidate.symbol || "???", chain: candidate.chain, address: candidate.address, reason });
    else { seen.add(key); eligible.push(candidate); }
  }
  return { eligible, skipped };
}

function runNaraBacktest({ settings, candidates, histories, from, to, snapshotAt, startingBalances, allocationCap = 5000 }) {
  const chains = Object.keys(startingBalances);
  const usedSettings = backtestSettings(settings, undefined, chains);
  const at = usedSettings.autoTrading;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime()) ||
    from % HOUR_MS || to % HOUR_MS || to - from !== BACKTEST_DAYS * 24 * HOUR_MS) {
    throw Object.assign(new Error("Periode backtest harus 30 hari dengan candle 1 jam lengkap."), { statusCode: 400 });
  }
  if (!Number.isFinite(snapshotAt) || !Number.isFinite(new Date(snapshotAt).getTime())) throw Object.assign(new Error("Waktu snapshot kandidat tidak valid."), { statusCode: 400 });
  const cash = Object.fromEntries(chains.map((chain) => [chain, Number(startingBalances[chain].usdc)]));
  const initialCapital = round2(Object.values(cash).reduce((sum, value) => sum + value, 0));
  if (!(initialCapital > 0) || Object.values(cash).some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Modal awal backtest tidak valid.");
  const expectedCandles = (to - from) / HOUR_MS;
  const { eligible, skipped } = filterBacktestCandidates(candidates, at, snapshotAt, chains);
  const historyByKey = new Map(histories.map((history) => [history.key, history]));
  const series = [];
  const priceSeries = [];
  eligible.forEach((candidate, index) => {
    const key = tokenAddressKey(candidate.chain, candidate.address);
    const history = historyByKey.get(key);
    const candles = (history?.candles || []).filter((candle) => candle.at >= from && candle.at < to).sort((a, b) => a.at - b.at);
    let reason = index >= MAX_HISTORY_CANDIDATES ? "Batas riwayat per run: " + MAX_HISTORY_CANDIDATES + " kandidat teratas yang lolos filter." : history?.error;
    if (!reason && !history) reason = "Riwayat harga tidak tersedia.";
    if (!reason && (candles.length !== expectedCandles || candles.some((candle, i) =>
      candle.at !== from + i * HOUR_MS || ![candle.open, candle.close, candle.high, candle.low].every((price) => Number.isFinite(price) && price > 0) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)
    ))) reason = "Candle 30 hari tidak lengkap (" + candles.length + "/" + expectedCandles + "); kandidat tidak disimulasikan.";
    priceSeries.push({ symbol: candidate.symbol, chain: candidate.chain, address: candidate.address,
      poolAddress: candidate.pool_id || candidate.primary_pool_address || null, candleCount: candles.length,
      zeroVolumeCandles: candles.filter((candle) => candle.volumeUsd === 0).length, usable: !reason, error: reason || null });
    if (reason) skipped.push({ symbol: candidate.symbol, chain: candidate.chain, address: candidate.address, reason });
    else series.push({ candidate, key, candles });
  });

  const open = new Map();
  const trades = [];
  const equityCurve = [{ at: new Date(from).toISOString(), equity: initialCapital, drawdownPct: 0 }];
  const dailyPnl = new Map();
  const stoppedDays = new Set();
  const openedTokens = new Set();
  const lastSkip = new Map();
  const rangePct = at.rangePreset === "narrow" ? 0.02 : at.rangePreset === "wide" ? 0.1 : 0.05;
  let allocated = 0;
  let maxConcurrentPositions = 0;
  let peakEquity = initialCapital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let nextId = 1;
  for (let i = 0; i < expectedCandles; i++) {
    const openedAt = from + i * HOUR_MS;
    const closedAt = openedAt + HOUR_MS;
    const day = new Date(openedAt).toISOString().slice(0, 10);
    const stopped = at.dailyLossLimit > 0 && (dailyPnl.get(day) || 0) <= -at.dailyLossLimit;
    if (stopped) stoppedDays.add(day);
    for (const item of series) {
      if (open.has(item.key)) continue;
      const candidate = item.candidate;
      let reason = autoTradingRiskReason({ ...candidate, pair_created_at: candidate.pool_created_at || candidate.pair_created_at },
        { now: openedAt, minLiquidityUsd: at.minLiquidity, minHolderCount: at.minHolder });
      if (!reason && stopped) reason = "Batas kerugian harian tercapai.";
      if (!reason && open.size >= at.maxPositions) reason = "Slot posisi penuh (maks " + at.maxPositions + ").";
      if (!reason && allocated + at.amountPerPosition > allocationCap) reason = "Alokasi melebihi modal desk simulasi.";
      if (!reason && cash[candidate.chain] < at.amountPerPosition) reason = "Saldo awal simulasi tidak cukup di chain " + candidate.chain + ".";
      if (reason) { lastSkip.set(item.key, reason); continue; }
      const entryPrice = item.candles[i].open;
      const position = { id: "backtest_" + nextId++, chain: candidate.chain, address: candidate.address, symbol: candidate.symbol,
        amount: at.amountPerPosition, entryPrice, minPrice: entryPrice * (1 - rangePct), maxPrice: entryPrice * (1 + rangePct),
        slPnlPct: usedSettings.tpSl.defaultSlPct, tpPnlPct: usedSettings.tpSl.defaultTpPct, distribution: "50/50", openedAt: new Date(openedAt).toISOString() };
      cash[position.chain] = round2(cash[position.chain] - position.amount);
      allocated = round2(allocated + position.amount);
      open.set(item.key, { position, series: item });
      openedTokens.add(item.key);
      maxConcurrentPositions = Math.max(maxConcurrentPositions, open.size);
    }
    let openValue = 0;
    for (const [key, item] of open) {
      const position = item.position;
      const exitPrice = item.series.candles[i].close;
      const value = valuePosition(position, exitPrice).value;
      const pnl = round2(value - position.amount);
      const reason = positionExitReason(position, exitPrice, pnl) || (i === expectedCandles - 1 ? "END" : null);
      if (!reason) { openValue += value; continue; }
      cash[position.chain] = round2(cash[position.chain] + value);
      allocated = round2(allocated - position.amount);
      const closeDay = new Date(closedAt).toISOString().slice(0, 10);
      dailyPnl.set(closeDay, round2((dailyPnl.get(closeDay) || 0) + pnl));
      trades.push({ ...position, exitPrice, closedAt: new Date(closedAt).toISOString(), value, pnl,
        returnPct: round2(pnl / position.amount * 100), reason });
      open.delete(key);
    }
    const equity = round2(Object.values(cash).reduce((sum, value) => sum + value, 0) + openValue);
    peakEquity = Math.max(peakEquity, equity);
    const drawdownUsd = peakEquity - equity;
    const drawdownPct = peakEquity > 0 ? drawdownUsd / peakEquity * 100 : 0;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdownUsd);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    equityCurve.push({ at: new Date(closedAt).toISOString(), equity, drawdownPct: round2(drawdownPct) });
  }
  for (const item of series) {
    if (!openedTokens.has(item.key)) skipped.push({ symbol: item.candidate.symbol, chain: item.candidate.chain,
      address: item.candidate.address, reason: lastSkip.get(item.key) || "Tidak ada entry selama periode backtest." });
  }
  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalPnl = round2(finalEquity - initialCapital);
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const losses = trades.filter((trade) => trade.pnl < 0).length;
  return {
    simulation: true,
    mode: "current_candidates_historical_prices",
    status: trades.length ? "completed" : "no_trades",
    settings: usedSettings,
    snapshotAt: new Date(snapshotAt).toISOString(),
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: BACKTEST_DAYS, interval: "1h" },
    methodology: {
      priceSource: "GeckoTerminal OHLCV USD, candle 1 jam lengkap.",
      signalSource: "Kandidat, skor, keamanan, holder, likuiditas, perubahan harga, dan APR memakai snapshot SAAT INI sepanjang periode, bukan sinyal historis.",
      entryRule: "Urutan kandidat Nara tetap; entry pada open candle, isi slot kosong setiap jam berikutnya, tanpa token duplikat.",
      exitRule: "TP/SL dari PnL modal LP hanya diperiksa pada close candle; posisi tersisa ditutup pada akhir periode (END). Tidak mensimulasikan eksekusi intrabar atau polling 5 detik.",
      valuation: "Model concentrated liquidity desk sesuai preset range. Fee LP, reward, gas, dan slippage tidak dihitung.",
      emptyIntervals: "Jam tanpa swap dapat diisi provider dengan harga close sebelumnya dan volume nol. Itu hanya price mark; entry/exit simulasi mengasumsikan fill, bukan bukti transaksi dapat dieksekusi.",
      capital: "Saldo awal desk simulasi per chain, terpisah dari saldo dan posisi akun aktif. Daily loss memakai PnL terealisasi per hari UTC.",
      warning: "Skenario ini mengandung look-ahead/survivorship bias dari seleksi kandidat saat ini; bukan backtest sinyal historis atau jaminan hasil trading.",
    },
    coverage: { requestedCandidates: candidates.length, eligibleCandidates: eligible.length, fetchedPriceSeries: histories.length,
      usablePriceSeries: series.length, expectedCandlesPerSeries: expectedCandles,
      zeroVolumeCandles: priceSeries.filter((item) => item.usable).reduce((sum, item) => sum + item.zeroVolumeCandles, 0), priceSeries },
    metrics: { initialCapital, finalEquity, totalTrades: trades.length, wins, losses, breakEven: trades.length - wins - losses,
      winRatePct: trades.length ? round2(wins / trades.length * 100) : null, totalPnl: trades.length ? totalPnl : null,
      returnPct: trades.length ? round2(totalPnl / initialCapital * 100) : null,
      maxDrawdownPct: trades.length ? round2(maxDrawdownPct) : null, maxDrawdownUsd: trades.length ? round2(maxDrawdownUsd) : null,
      maxConcurrentPositions, dailyLossStoppedDays: stoppedDays.size },
    equityCurve, trades, skipped,
  };
}

module.exports = { BACKTEST_DAYS, HOUR_MS, MAX_HISTORY_CANDIDATES, backtestSettings, selectNaraCandidates, filterBacktestCandidates, runNaraBacktest };
