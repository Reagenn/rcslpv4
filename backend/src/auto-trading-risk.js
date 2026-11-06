"use strict";

const MIN_POOL_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_LIQUIDITY_USD = 50_000;
const MIN_VOLUME_24H_USD = 25_000;
const MIN_HOLDER_COUNT = 500;
const MIN_SECURITY_SCORE = 95;
const MAX_TOP_HOLDERS_PERCENT = 40;

function timestamp(value) {
  if (value == null || value === "") return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

function finiteNumber(value) {
  return value != null && value !== "" && Number.isFinite(Number(value));
}

function autoTradingRiskReason(candidate, options = {}) {
  const analysis = candidate && candidate.agent_analysis;
  if (!analysis || analysis.status !== "complete" || analysis.confidence !== "high") {
    return "Data keamanan/holder GoPlus belum lengkap; Auto Trading menolak kandidat berisiko tidak diketahui.";
  }

  const securityScore = Number(analysis.security_score);
  if (!Number.isFinite(securityScore) || securityScore < MIN_SECURITY_SCORE) {
    return "Skor keamanan " + (Number.isFinite(securityScore) ? securityScore : "-") + " di bawah hard-gate " + MIN_SECURITY_SCORE + ".";
  }

  const topHoldersPercent = Number(analysis.top_holders_percent);
  if (!finiteNumber(analysis.top_holders_percent)) {
    return "Konsentrasi 10 holder teratas tidak tersedia; kandidat dilewati.";
  }
  if (topHoldersPercent >= MAX_TOP_HOLDERS_PERCENT) {
    return "Konsentrasi 10 holder teratas " + topHoldersPercent + "% mencapai batas hard-gate " + MAX_TOP_HOLDERS_PERCENT + "%.";
  }

  const holderCount = Number(candidate.holders_count);
  const minimumHolders = Math.max(MIN_HOLDER_COUNT, Number(options.minHolderCount) || 0);
  if (!finiteNumber(candidate.holders_count) || holderCount < minimumHolders) {
    return "Holder " + (finiteNumber(candidate.holders_count) ? holderCount : "-") + " di bawah hard-gate " + minimumHolders + ".";
  }

  const liquidity = Number(candidate.liquidity_usd);
  const minimumLiquidity = Math.max(MIN_LIQUIDITY_USD, Number(options.minLiquidityUsd) || 0);
  if (!finiteNumber(candidate.liquidity_usd) || liquidity < minimumLiquidity) {
    return "Likuiditas " + (finiteNumber(candidate.liquidity_usd) ? "$" + Math.round(liquidity) : "-") + " di bawah hard-gate $" + Math.round(minimumLiquidity) + ".";
  }
  const volume24h = Number(candidate.volume_24h);
  if (!finiteNumber(candidate.volume_24h)) return "Volume 24 jam tidak tersedia.";
  if (volume24h < MIN_VOLUME_24H_USD) {
    return "Volume 24 jam $" + Math.round(volume24h) + " di bawah hard-gate $" + MIN_VOLUME_24H_USD + ".";
  }

  const now = Number(options.now) || Date.now();
  const pairCreatedAt = timestamp(candidate.pair_created_at);
  if (!Number.isFinite(pairCreatedAt)) return "Umur pool tidak tersedia.";
  const poolAgeHours = (now - pairCreatedAt) / (60 * 60 * 1000);
  if (poolAgeHours < MIN_POOL_AGE_MS / (60 * 60 * 1000)) {
    return "Umur pool " + Math.max(0, Math.round(poolAgeHours * 10) / 10) + " jam; hard-gate minimum 24 jam.";
  }

  if (candidate.price_change_data_available !== true) {
    return "Data perubahan harga 5m/1h/6h/24h tidak lengkap; kandidat dilewati.";
  }
  const changes = [
    ["24 jam", candidate.price_change_24h, 50],
    ["1 jam", candidate.price_change_h1, 25],
    ["6 jam", candidate.price_change_h6, 40],
    ["5 menit", candidate.price_change_m5, 15],
  ];
  for (const [period, value, maxChange] of changes) {
    if (!finiteNumber(value)) return "Data perubahan harga " + period + " tidak valid.";
    if (Math.abs(Number(value)) >= maxChange) {
      return "Perubahan harga " + period + " sebesar " + Number(value) + "% melewati batas volatilitas ±" + maxChange + "%.";
    }
  }
  return null;
}

module.exports = {
  autoTradingRiskReason,
  MIN_POOL_AGE_MS,
  MIN_LIQUIDITY_USD,
  MIN_VOLUME_24H_USD,
  MIN_HOLDER_COUNT,
  MIN_SECURITY_SCORE,
  MAX_TOP_HOLDERS_PERCENT,
};
