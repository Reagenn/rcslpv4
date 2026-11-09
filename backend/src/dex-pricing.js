"use strict";

const { tokenAddressKey } = require("./uniswap-v4");

function pairPriceUsdForToken(pair, address, chain) {
  if (!pair || !address) return null;
  const chainName = chain || "";
  const targetKey = tokenAddressKey(chainName, address);
  const baseKey = tokenAddressKey(chainName, pair.baseToken && pair.baseToken.address);
  const quoteKey = tokenAddressKey(chainName, pair.quoteToken && pair.quoteToken.address);
  const basePriceUsd = Number(pair.priceUsd);
  if (!(basePriceUsd > 0) || !Number.isFinite(basePriceUsd)) return null;
  if (targetKey === baseKey) return basePriceUsd;
  if (targetKey !== quoteKey) return null;

  // DexScreener's priceNative is the base-token price denominated in the
  // quote token. Divide base USD price by that ratio to get quote-token USD.
  const basePriceInQuote = Number(pair.priceNative);
  if (!(basePriceInQuote > 0) || !Number.isFinite(basePriceInQuote)) return null;
  const quotePriceUsd = basePriceUsd / basePriceInQuote;
  return Number.isFinite(quotePriceUsd) && quotePriceUsd > 0 ? quotePriceUsd : null;
}

module.exports = { pairPriceUsdForToken };
