"use strict";

const UNISWAP_V4_NETWORKS = [
  { networkId: "base", dexId: "uniswap-v4-base", chain: "BASE", chainName: "Base" },
  { networkId: "eth", dexId: "uniswap-v4-ethereum", chain: "ETH", chainName: "Ethereum" },
  { networkId: "bsc", dexId: "uniswap-v4-bsc", chain: "BSC", chainName: "BNB Chain" },
  { networkId: "robinhood", dexId: "uniswap-v4-robinhood", chain: "ROBINHOOD", chainName: "Robinhood Chain" },
  { networkId: "optimism", dexId: "uniswap-v4-optimism", chain: "OPTIMISM", chainName: "Optimism" },
  { networkId: "arbitrum", dexId: "uniswap-v4-arbitrum", chain: "ARBITRUM", chainName: "Arbitrum" },
  { networkId: "polygon_pos", dexId: "uniswap-v4-polygon", chain: "POLYGON", chainName: "Polygon" },
  { networkId: "avax", dexId: "uniswap-v4-avalanche", chain: "AVALANCHE", chainName: "Avalanche" },
  { networkId: "unichain", dexId: "uniswap-v4-unichain", chain: "UNICHAIN", chainName: "Unichain" },
];

function normalizeGeckoPools(network, payload, now, minTvlUsd) {
  const includedTokens = new Map(
    ((payload && payload.included) || [])
      .filter((item) => item && item.type === "token")
      .map((item) => [item.id, item.attributes || {}])
  );
  const pools = (payload && payload.data) || [];
  const minimumTvl = minTvlUsd == null ? 10000 : minTvlUsd;

  return pools.map((pool) => {
    const attrs = pool && pool.attributes || {};
    const relationships = pool && pool.relationships || {};
    const baseId = relationships.base_token && relationships.base_token.data && relationships.base_token.data.id;
    const quoteId = relationships.quote_token && relationships.quote_token.data && relationships.quote_token.data.id;
    const base = includedTokens.get(baseId);
    const quote = includedTokens.get(quoteId);
    const createdAt = Date.parse(attrs.pool_created_at || "");
    const tvlUsd = Number(attrs.reserve_in_usd);
    const volume24hUsd = Number(attrs.volume_usd && attrs.volume_usd.h24);
    const feeMatch = String(attrs.name || "").match(/(?:^|\s)(\d+(?:\.\d+)?)%\s*$/);
    const feePercent = feeMatch ? Number(feeMatch[1]) : NaN;

    if (!attrs.address || !base || !quote || !Number.isFinite(createdAt) || now - createdAt < 24 * 60 * 60 * 1000) return null;
    if (!Number.isFinite(tvlUsd) || tvlUsd < minimumTvl || !Number.isFinite(volume24hUsd) || volume24hUsd <= 0) return null;
    if (!Number.isFinite(feePercent) || feePercent <= 0 || feePercent > 100) return null;

    const estimatedFees24hUsd = volume24hUsd * feePercent / 100;
    if (!(estimatedFees24hUsd > 0)) return null;
    const apr = estimatedFees24hUsd / tvlUsd * 365 * 100;
    const toToken = (token) => ({
      id: String(token.address || "").toLowerCase(),
      symbol: token.symbol || "?",
      name: token.name || token.symbol || "Unknown token",
    });

    return {
      poolId: attrs.address,
      protocol: "Uniswap v4",
      chain: network.chain,
      chainName: network.chainName,
      token0: toToken(base),
      token1: toToken(quote),
      tvlUsd: Math.round(tvlUsd * 100) / 100,
      volume24hUsd: Math.round(volume24hUsd * 100) / 100,
      feePercent,
      fees24hUsd: Math.round(estimatedFees24hUsd * 100) / 100,
      estimatedFees24hUsd: Math.round(estimatedFees24hUsd * 100) / 100,
      apr: Math.round(apr * 100) / 100,
      poolCreatedAt: new Date(createdAt).toISOString(),
    };
  }).filter(Boolean);
}

function normalizeMeteoraPools(payload, now, minTvlUsd) {
  const pools = (payload && payload.data) || [];
  const minimumTvl = minTvlUsd == null ? 10000 : minTvlUsd;
  return pools.map((pool) => {
    const tokenX = pool && pool.token_x || {};
    const tokenY = pool && pool.token_y || {};
    const tvlUsd = Number(pool && pool.tvl);
    const volume24hUsd = Number(pool && pool.volume && pool.volume["24h"]);
    const fees24hUsd = Number(pool && pool.fees && pool.fees["24h"]);
    const createdAt = Number(pool && pool.created_at);
    const feePercent = Number(pool && pool.pool_config && pool.pool_config.base_fee_pct || 0) +
      Number(pool && pool.dynamic_fee_pct || 0);
    if (!pool || !pool.address || !tokenX.address || !tokenY.address) return null;
    if (!Number.isFinite(createdAt) || now - createdAt < 24 * 60 * 60 * 1000) return null;
    if (!Number.isFinite(tvlUsd) || tvlUsd < minimumTvl || !Number.isFinite(volume24hUsd) || volume24hUsd <= 0) return null;
    if (!Number.isFinite(fees24hUsd) || fees24hUsd <= 0) return null;

    const toToken = (token) => ({
      id: String(token.address),
      symbol: token.symbol || "?",
      name: token.name || token.symbol || "Unknown token",
    });
    return {
      poolId: pool.address,
      protocol: "Meteora DLMM",
      chain: "SOL",
      chainName: "Solana",
      token0: toToken(tokenX),
      token1: toToken(tokenY),
      tvlUsd: Math.round(tvlUsd * 100) / 100,
      volume24hUsd: Math.round(volume24hUsd * 100) / 100,
      feePercent: Math.round(feePercent * 10000) / 10000,
      fees24hUsd: Math.round(fees24hUsd * 100) / 100,
      estimatedFees24hUsd: Math.round(fees24hUsd * 100) / 100,
      apr: Math.round((fees24hUsd / tvlUsd * 365 * 100) * 100) / 100,
      poolCreatedAt: new Date(createdAt).toISOString(),
    };
  }).filter(Boolean);
}

function tokenAddressKey(chain, address) {
  const normalizedChain = String(chain || "").toUpperCase();
  const normalizedAddress = String(address || "");
  return normalizedChain + ":" + (normalizedChain === "SOL" ? normalizedAddress : normalizedAddress.toLowerCase());
}

function isPoolTokenAddress(chain, address) {
  const normalizedChain = String(chain || "").toUpperCase();
  const value = String(address || "");
  if (normalizedChain === "SOL") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  return /^0x[a-f0-9]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
}

module.exports = { UNISWAP_V4_NETWORKS, normalizeGeckoPools, normalizeMeteoraPools, tokenAddressKey, isPoolTokenAddress };
