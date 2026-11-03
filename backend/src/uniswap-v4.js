"use strict";

const UNISWAP_V4_NETWORKS = [
  { networkId: "base", dexId: "uniswap-v4-base", chain: "BASE", chainName: "Base" },
  { networkId: "eth", dexId: "uniswap-v4-ethereum", chain: "ETH", chainName: "Ethereum" },
  { networkId: "bsc", dexId: "uniswap-v4-bsc", chain: "BSC", chainName: "BNB Chain" },
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
      chain: network.chain,
      chainName: network.chainName,
      token0: toToken(base),
      token1: toToken(quote),
      tvlUsd: Math.round(tvlUsd * 100) / 100,
      volume24hUsd: Math.round(volume24hUsd * 100) / 100,
      feePercent,
      estimatedFees24hUsd: Math.round(estimatedFees24hUsd * 100) / 100,
      apr: Math.round(apr * 100) / 100,
      poolCreatedAt: new Date(createdAt).toISOString(),
    };
  }).filter(Boolean);
}

module.exports = { UNISWAP_V4_NETWORKS, normalizeGeckoPools };
