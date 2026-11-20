"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BACKTEST_DAYS,
  HOUR_MS,
  MAX_HISTORY_CANDIDATES,
  backtestSettings,
  selectNaraCandidates,
  filterBacktestCandidates,
  runNaraBacktest,
} = require("./src/nara-backtest");
const { valuePosition } = require("./src/position-valuation");
const { tokenAddressKey, isPoolTokenAddress } = require("./src/uniswap-v4");

const FROM = Date.parse("2026-01-01T00:00:00Z");
const TO = Date.parse("2026-01-31T00:00:00Z");
const SNAPSHOT_AT = Date.parse("2026-02-01T12:00:00Z");
const CANDLE_COUNT = 720;
const POOL_CREATED_AT = new Date(FROM - 31 * 24 * HOUR_MS).toISOString();
const CHAINS = ["BASE", "ETH", "SOL"];
const EVM_ADDRESSES = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "0x514910771af9ca656af840dff83e8264ecf986ca",
  "0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
  "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39",
  "0x853d955acef822db058eb8505911ed77f175b99e",
  "0x4200000000000000000000000000000000000006",
];
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const SOL_CASE_ADDRESS = "so11111111111111111111111111111111111111112";
const QUOTE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_QUOTE_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_ADDRESS = "0x2626664c2603336E57B271c5C0b26F421741e481";

function makeSettings({ autoTrading = {}, tpSl = {} } = {}) {
  return {
    autoTrading: {
      enabled: true,
      minScore: 70,
      source: "DEX",
      verdictFilter: "ANY",
      chainFilter: "ALL",
      amountPerPosition: 250,
      maxPositions: 3,
      dailyLossLimit: 0,
      rangePreset: "medium",
      minLiquidity: 50000,
      minHolder: 500,
      minApr: 50,
      ...autoTrading,
    },
    tpSl: { armed: true, defaultTpPct: 0, defaultSlPct: 0, ...tpSl },
  };
}

function makeCandidate(overrides = {}) {
  const analysis = {
    status: "complete",
    confidence: "high",
    security_score: 100,
    top_holders_percent: 20,
    verdict: "consider",
  };
  return {
    symbol: "ALPHA",
    chain: "BASE",
    address: EVM_ADDRESSES[0],
    recommendation_score: 70,
    liquidity_usd: 120000,
    holders_count: 1000,
    volume_24h: 60000,
    pair_created_at: POOL_CREATED_AT,
    pool_created_at: POOL_CREATED_AT,
    primary_pool_address: POOL_ADDRESS,
    price_change_data_available: true,
    price_change_24h: 8,
    price_change_h1: 2,
    price_change_h6: 5,
    price_change_m5: 1,
    ...overrides,
    agent_analysis: Object.hasOwn(overrides, "agent_analysis")
      ? overrides.agent_analysis == null ? overrides.agent_analysis : { ...analysis, ...overrides.agent_analysis }
      : analysis,
  };
}

function historyFor(candidate, closes = [100]) {
  let open = 100;
  const fallback = closes.length ? closes[closes.length - 1] : 100;
  return {
    key: tokenAddressKey(candidate.chain, candidate.address),
    candles: Array.from({ length: CANDLE_COUNT }, (_, i) => {
      const close = i < closes.length ? closes[i] : fallback;
      const candle = { at: FROM + i * HOUR_MS, open, close, high: Math.max(open, close), low: Math.min(open, close) };
      open = close;
      return candle;
    }),
  };
}

function poolFor(candidate, overrides = {}) {
  return {
    chain: candidate.chain,
    apr: 100,
    tvlUsd: 120000,
    protocol: candidate.chain === "SOL" ? "Meteora DLMM" : "Uniswap v4",
    poolId: candidate.chain === "SOL" ? SOL_ADDRESS : POOL_ADDRESS,
    poolCreatedAt: POOL_CREATED_AT,
    token0: { id: candidate.address, symbol: candidate.symbol },
    token1: { id: candidate.chain === "SOL" ? SOL_QUOTE_ADDRESS : QUOTE_ADDRESS, symbol: "USDC" },
    ...overrides,
  };
}

function backtestInput(overrides = {}) {
  const candidates = overrides.candidates || [makeCandidate()];
  return {
    settings: makeSettings(),
    candidates,
    histories: candidates.map((candidate) => historyFor(candidate)),
    from: FROM,
    to: TO,
    snapshotAt: SNAPSHOT_AT,
    startingBalances: { BASE: { usdc: 1000 } },
    ...overrides,
  };
}

function run(overrides = {}) {
  return runNaraBacktest(backtestInput(overrides));
}

function isoHour(hour) {
  return new Date(FROM + hour * HOUR_MS).toISOString();
}

function cents(value) {
  return Math.round(value * 100) / 100;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertUnavailable(result) {
  assert.equal(result.status, "no_trades");
  assert.deepEqual(result.trades, []);
  assert.equal(result.coverage.usablePriceSeries, 0);
  assert.deepEqual(result.metrics, {
    initialCapital: 1000,
    finalEquity: 1000,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakEven: 0,
    winRatePct: null,
    totalPnl: null,
    returnPct: null,
    maxDrawdownPct: null,
    maxDrawdownUsd: null,
    maxConcurrentPositions: 0,
    dailyLossStoppedDays: 0,
  });
  assert.equal(result.equityCurve.length, CANDLE_COUNT + 1);
  assert.ok(result.equityCurve.every((point) => point.equity === 1000 && point.drawdownPct === 0));
  assert.ok(result.coverage.priceSeries.every((series) => !series.usable && typeof series.error === "string"));
}

test("fixtures use valid addresses, old pools, and exactly 720 synthetic hourly candles", () => {
  assert.equal(BACKTEST_DAYS, 30);
  assert.equal(HOUR_MS, 3600000);
  assert.equal(MAX_HISTORY_CANDIDATES, 10);
  assert.equal(TO - FROM, CANDLE_COUNT * HOUR_MS);
  assert.ok(FROM - Date.parse(POOL_CREATED_AT) >= 31 * 24 * HOUR_MS);
  for (const address of [...EVM_ADDRESSES, QUOTE_ADDRESS, POOL_ADDRESS]) {
    assert.ok(isPoolTokenAddress("BASE", address), address);
  }
  for (const address of [SOL_ADDRESS, SOL_CASE_ADDRESS, SOL_QUOTE_ADDRESS]) {
    assert.ok(isPoolTokenAddress("SOL", address), address);
  }
  const history = historyFor(makeCandidate());
  assert.equal(history.candles.length, CANDLE_COUNT);
  assert.equal(history.candles[0].at, FROM);
  assert.equal(history.candles[CANDLE_COUNT - 1].at, TO - HOUR_MS);
});

test("score 70 is accepted and a score just below 70 is rejected", () => {
  const boundary = makeCandidate();
  const below = makeCandidate({ symbol: "BELOW", address: EVM_ADDRESSES[1], recommendation_score: 69.999 });
  const result = run({ candidates: [below, boundary] });
  assert.equal(result.coverage.eligibleCandidates, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].address, boundary.address);
  assert.match(result.skipped.find((item) => item.symbol === "BELOW").reason, /minScore 70/);
});

test("missing or invalid recommendation scores are not eligible", () => {
  for (const score of [null, undefined, NaN, Infinity, "invalid"]) {
    const result = filterBacktestCandidates([makeCandidate({ recommendation_score: score })], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
    assert.deepEqual(result.eligible, []);
    assert.match(result.skipped[0].reason, /minScore/);
  }
});

test("positions are sized at $250 with at most three simultaneous positions", () => {
  const candidates = EVM_ADDRESSES.slice(0, 5).map((address, i) => makeCandidate({ address, symbol: "TOKEN" + i }));
  const result = run({ candidates, startingBalances: { BASE: { usdc: 10000 } } });
  assert.equal(result.metrics.maxConcurrentPositions, 3);
  assert.equal(result.trades.length, 3);
  assert.ok(result.trades.every((trade) => trade.amount === 250));
  assert.deepEqual(result.trades.map((trade) => trade.address), candidates.slice(0, 3).map((candidate) => candidate.address));
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((item) => /Slot posisi penuh \(maks 3\)/.test(item.reason)));
  for (const point of result.equityCurve) {
    const concurrent = result.trades.filter((trade) => trade.openedAt <= point.at && point.at < trade.closedAt).length;
    assert.ok(concurrent <= 3);
  }
});

test("duplicate detection is chain-aware, EVM case-insensitive, and Base58 case-sensitive", () => {
  const first = makeCandidate();
  const duplicate = makeCandidate({ symbol: "DUP", address: first.address.toLowerCase() });
  const ethereum = makeCandidate({ symbol: "ETH-TOKEN", chain: "ETH", address: first.address.toLowerCase() });
  const solana = makeCandidate({ symbol: "SOL-TOKEN", chain: "SOL", address: SOL_ADDRESS });
  const solDuplicate = makeCandidate({ symbol: "SOL-DUP", chain: "SOL", address: SOL_ADDRESS });
  const solCase = makeCandidate({ symbol: "SOL-CASE", chain: "SOL", address: SOL_CASE_ADDRESS });
  const result = filterBacktestCandidates([first, duplicate, ethereum, solana, solDuplicate, solCase], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, [first, ethereum, solana, solCase]);
  assert.deepEqual(result.skipped.map((item) => item.symbol), ["DUP", "SOL-DUP"]);
  assert.ok(result.skipped.every((item) => /duplikat/.test(item.reason)));
});

test("an ineligible duplicate does not suppress a later eligible candidate", () => {
  const lowScore = makeCandidate({ symbol: "LOW", recommendation_score: 69 });
  const eligible = makeCandidate({ symbol: "ELIGIBLE", address: lowScore.address.toLowerCase() });
  const result = filterBacktestCandidates([lowScore, eligible], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, [eligible]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /minScore/);
});

test("replay funds identical EVM addresses on different chains without duplicate positions", () => {
  const base = makeCandidate();
  const duplicate = makeCandidate({ address: base.address.toLowerCase(), symbol: "DUP" });
  const eth = makeCandidate({ chain: "ETH", address: base.address.toLowerCase(), symbol: "ETH-TOKEN" });
  const sol = makeCandidate({ chain: "SOL", address: SOL_ADDRESS, symbol: "SOL-TOKEN" });
  const result = run({
    candidates: [base, duplicate, eth, sol],
    histories: [base, eth, sol].map((candidate) => historyFor(candidate)),
    startingBalances: { BASE: { usdc: 1000 }, ETH: { usdc: 1000 }, SOL: { usdc: 1000 } },
  });
  assert.equal(result.metrics.totalTrades, 3);
  assert.equal(result.metrics.maxConcurrentPositions, 3);
  assert.deepEqual(result.trades.map((trade) => trade.chain), CHAINS);
  assert.equal(new Set(result.trades.map((trade) => tokenAddressKey(trade.chain, trade.address))).size, 3);
  assert.match(result.skipped.find((item) => item.symbol === "DUP").reason, /duplikat/);
});

for (const verdict of ["consider", "review", "avoid"]) {
  test("configured verdict filter accepts only " + verdict, () => {
    const candidates = ["consider", "review", "avoid"].map((value, i) => makeCandidate({
      symbol: value, address: EVM_ADDRESSES[i], agent_analysis: { verdict: value },
    }));
    const result = filterBacktestCandidates(candidates, makeSettings({ autoTrading: { verdictFilter: verdict } }).autoTrading, SNAPSHOT_AT, CHAINS);
    assert.deepEqual(result.eligible.map((candidate) => candidate.symbol), [verdict]);
    assert.equal(result.skipped.length, 2);
    assert.ok(result.skipped.every((item) => /Verdict/.test(item.reason)));
  });
}

test("ANY verdict and ALL chains preserve eligible candidate order", () => {
  const candidates = CHAINS.map((chain, i) => makeCandidate({
    chain, address: chain === "SOL" ? SOL_ADDRESS : EVM_ADDRESSES[i], agent_analysis: { verdict: ["review", "avoid", "consider"][i] },
  }));
  const result = filterBacktestCandidates(candidates, makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, candidates);
  assert.deepEqual(result.skipped, []);
});

test("configured chain filter excludes otherwise eligible candidates", () => {
  const base = makeCandidate();
  const eth = makeCandidate({ chain: "ETH", address: EVM_ADDRESSES[1] });
  const result = filterBacktestCandidates([eth, base], makeSettings({ autoTrading: { chainFilter: "BASE" } }).autoTrading, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, [base]);
  assert.match(result.skipped[0].reason, /filter BASE/);
});

for (const [name, overrides, reason] of [
  ["unsupported chain", { chain: "UNKNOWN" }, /Chain tidak didukung/],
  ["invalid EVM address", { address: "0xnot-a-token" }, /Alamat token/],
  ["zero EVM address", { address: "0x" + "0".repeat(40) }, /Alamat token/],
  ["invalid Base58 address", { chain: "SOL", address: "0OIl".repeat(10) }, /Alamat token/],
]) {
  test("candidate filter rejects " + name, () => {
    const result = filterBacktestCandidates([makeCandidate(overrides)], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
    assert.deepEqual(result.eligible, []);
    assert.match(result.skipped[0].reason, reason);
  });
}

test("configured liquidity and holder minima are inclusive and can strengthen hard gates", () => {
  const at = makeSettings({ autoTrading: { minLiquidity: 150000, minHolder: 1500 } }).autoTrading;
  const exact = makeCandidate({ liquidity_usd: 150000, holders_count: 1500 });
  const lowLiquidity = makeCandidate({ address: EVM_ADDRESSES[1], liquidity_usd: 149999, holders_count: 1500 });
  const lowHolders = makeCandidate({ address: EVM_ADDRESSES[2], liquidity_usd: 150000, holders_count: 1499 });
  const result = filterBacktestCandidates([exact, lowLiquidity, lowHolders], at, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, [exact]);
  assert.match(result.skipped[0].reason, /\$150000/);
  assert.match(result.skipped[1].reason, /1500/);
});

test("weak configured minima do not bypass $50000 liquidity or 500 holder hard gates", () => {
  const at = makeSettings({ autoTrading: { minLiquidity: 0, minHolder: 0 } }).autoTrading;
  const exact = makeCandidate({ liquidity_usd: 50000, holders_count: 500 });
  const lowLiquidity = makeCandidate({ address: EVM_ADDRESSES[1], liquidity_usd: 49999, holders_count: 500 });
  const lowHolders = makeCandidate({ address: EVM_ADDRESSES[2], liquidity_usd: 50000, holders_count: 499 });
  const result = filterBacktestCandidates([exact, lowLiquidity, lowHolders], at, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, [exact]);
  assert.match(result.skipped[0].reason, /\$50000/);
  assert.match(result.skipped[1].reason, /500/);
});

test("security 95, volume $25000, and concentration below 40% pass hard-gate boundaries", () => {
  const candidate = makeCandidate({
    volume_24h: 25000,
    agent_analysis: { security_score: 95, top_holders_percent: 39.999 },
  });
  const result = filterBacktestCandidates([candidate], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, [candidate]);
  assert.deepEqual(result.skipped, []);
});

for (const [name, overrides, reason] of [
  ["funding quote USDC", { symbol: " usdc " }, /aset quote/],
  ["missing security analysis", { agent_analysis: null }, /belum lengkap/],
  ["partial security analysis", { agent_analysis: { status: "partial" } }, /belum lengkap/],
  ["low security confidence", { agent_analysis: { confidence: "low" } }, /belum lengkap/],
  ["security below 95", { agent_analysis: { security_score: 94.999 } }, /hard-gate 95/],
  ["unknown security score", { agent_analysis: { security_score: undefined } }, /hard-gate 95/],
  ["40% top-holder concentration", { agent_analysis: { top_holders_percent: 40 } }, /hard-gate 40/],
  ["unknown holder concentration", { agent_analysis: { top_holders_percent: null } }, /tidak tersedia/],
  ["unknown holder count", { holders_count: null }, /Holder/],
  ["unknown liquidity", { liquidity_usd: undefined }, /Likuiditas/],
  ["volume below $25000", { volume_24h: 24999 }, /Volume 24 jam/],
  ["unknown volume", { volume_24h: null }, /Volume 24 jam/],
  ["unknown pool age", { pair_created_at: undefined }, /Umur pool/],
  ["pool younger than 24 hours", { pair_created_at: SNAPSHOT_AT - 23 * HOUR_MS }, /minimum 24 jam/],
  ["incomplete price-change data", { price_change_data_available: false }, /tidak lengkap/],
]) {
  test("hard gates reject " + name + " even with permissive settings", () => {
    const at = makeSettings({ autoTrading: { minScore: 0, minLiquidity: 0, minHolder: 0 } }).autoTrading;
    const result = filterBacktestCandidates([makeCandidate(overrides)], at, SNAPSHOT_AT, CHAINS);
    assert.deepEqual(result.eligible, []);
    assert.match(result.skipped[0].reason, reason);
  });
}

for (const [field, limit] of [
  ["price_change_24h", 50], ["price_change_h1", 25], ["price_change_h6", 40], ["price_change_m5", 15],
]) {
  test("volatility hard gate rejects both signs at the " + field + " boundary", () => {
    for (const value of [limit, -limit, limit + 1, -limit - 1]) {
      const result = filterBacktestCandidates([makeCandidate({ [field]: value })], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
      assert.deepEqual(result.eligible, []);
      assert.match(result.skipped[0].reason, /Perubahan harga/);
    }
    for (const value of [limit - 0.001, -limit + 0.001]) {
      assert.equal(filterBacktestCandidates([makeCandidate({ [field]: value })], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS).eligible.length, 1);
    }
  });

  test("volatility hard gate rejects missing or non-finite " + field, () => {
    for (const value of [null, undefined, NaN, Infinity, "invalid"]) {
      const result = filterBacktestCandidates([makeCandidate({ [field]: value })], makeSettings().autoTrading, SNAPSHOT_AT, CHAINS);
      assert.deepEqual(result.eligible, []);
      assert.match(result.skipped[0].reason, /Data perubahan harga/);
    }
  });
}

test("DEX source uses only recommendations and ignores APR enrichment", () => {
  const recommendation = makeCandidate();
  const pending = makeCandidate({ address: EVM_ADDRESSES[1] });
  const agentOut = deepFreeze({ recommendations: [recommendation], pending_candidates: [pending] });
  const at = makeSettings({ autoTrading: { minApr: 100000 } }).autoTrading;
  const selected = selectNaraCandidates(agentOut, at, [poolFor(pending)]);
  assert.deepEqual(selected, [recommendation]);
  assert.equal(selected[0].pool_apr, undefined);
  assert.deepEqual(filterBacktestCandidates(selected, at, SNAPSHOT_AT, CHAINS).eligible, [recommendation]);
});

test("APR source selects the best eligible pool per chain-aware token, including pending candidates", () => {
  const base = makeCandidate();
  const eth = makeCandidate({ chain: "ETH", address: base.address.toLowerCase(), symbol: "ETH-TOKEN" });
  const sol = makeCandidate({ chain: "SOL", address: SOL_ADDRESS, symbol: "SOL-TOKEN" });
  const pending = makeCandidate({ address: EVM_ADDRESSES[1], symbol: "PENDING" });
  const unmatched = makeCandidate({ address: EVM_ADDRESSES[2], symbol: "UNMATCHED" });
  const highest = poolFor(base, { apr: 200, poolId: EVM_ADDRESSES[3], token0: { id: base.address.toLowerCase() } });
  const pools = [
    poolFor(base, { apr: 100 }), highest,
    poolFor(base, { apr: 999, tvlUsd: 49999 }),
    poolFor(eth, { apr: 80 }),
    poolFor(sol, { apr: 120, token0: { id: SOL_QUOTE_ADDRESS }, token1: { id: sol.address } }),
    poolFor(pending, { apr: 150 }),
  ];
  const agentOut = { recommendations: [eth, sol, unmatched, base], pending_candidates: [pending] };
  const snapshot = structuredClone({ agentOut, pools });
  deepFreeze(agentOut);
  deepFreeze(pools);
  const selected = selectNaraCandidates(agentOut, makeSettings({ autoTrading: { source: "UNISWAP_V4" } }).autoTrading, pools);
  assert.deepEqual(selected.map((candidate) => candidate.symbol), ["ALPHA", "PENDING", "SOL-TOKEN", "ETH-TOKEN"]);
  assert.deepEqual(selected.map((candidate) => candidate.pool_apr), [200, 150, 120, 80]);
  assert.equal(selected[0].pool_id, highest.poolId);
  assert.equal(selected[0].pool_protocol, highest.protocol);
  assert.equal(selected[0].pool_tvl_usd, highest.tvlUsd);
  assert.equal(selected[0].pool_created_at, POOL_CREATED_AT);
  assert.notStrictEqual(selected[0], base);
  assert.deepEqual({ agentOut, pools }, snapshot);
});

test("APR selection requires inclusive configured APR and pool liquidity minima", () => {
  const candidates = EVM_ADDRESSES.slice(0, 3).map((address, i) => makeCandidate({ address, symbol: "TOKEN" + i }));
  const at = makeSettings({ autoTrading: { source: "UNISWAP_V4", minApr: 50, minLiquidity: 80000 } }).autoTrading;
  const selected = selectNaraCandidates({ recommendations: candidates }, at, [
    poolFor(candidates[0], { apr: 50, tvlUsd: 80000 }),
    poolFor(candidates[1], { apr: 49.999, tvlUsd: 80000 }),
    poolFor(candidates[2], { apr: 100, tvlUsd: 79999 }),
  ]);
  assert.deepEqual(selected.map((candidate) => candidate.address), [candidates[0].address]);
});

test("APR source matches EVM casing but preserves Solana Base58 casing", () => {
  const base = makeCandidate();
  const sol = makeCandidate({ chain: "SOL", address: SOL_ADDRESS, symbol: "SOL" });
  const solCase = makeCandidate({ chain: "SOL", address: SOL_CASE_ADDRESS, symbol: "SOL-CASE" });
  const selected = selectNaraCandidates({ recommendations: [base, sol, solCase] }, makeSettings({ autoTrading: { source: "UNISWAP_V4" } }).autoTrading, [
    poolFor(base, { token0: { id: base.address.toLowerCase() } }), poolFor(sol),
  ]);
  assert.deepEqual(selected.map((candidate) => candidate.symbol), ["ALPHA", "SOL"]);
});

test("APR candidate filtering rejects absent, invalid, or below-minimum pool APR", () => {
  const at = makeSettings({ autoTrading: { source: "UNISWAP_V4", minApr: 50 } }).autoTrading;
  for (const apr of [null, undefined, NaN, Infinity, 49.999]) {
    const result = filterBacktestCandidates([makeCandidate({ pool_apr: apr })], at, SNAPSHOT_AT, CHAINS);
    assert.deepEqual(result.eligible, []);
    assert.match(result.skipped[0].reason, /APR/);
  }
  assert.equal(filterBacktestCandidates([makeCandidate({ pool_apr: 50 })], at, SNAPSHOT_AT, CHAINS).eligible.length, 1);
});

test("APR selection does not bypass candidate security hard gates", () => {
  const unsafe = makeCandidate({ agent_analysis: { security_score: 94 } });
  const at = makeSettings({ autoTrading: { source: "UNISWAP_V4" } }).autoTrading;
  const selected = selectNaraCandidates({ recommendations: [unsafe] }, at, [poolFor(unsafe, { apr: 1000 })]);
  assert.equal(selected.length, 1);
  const result = filterBacktestCandidates(selected, at, SNAPSHOT_AT, CHAINS);
  assert.deepEqual(result.eligible, []);
  assert.match(result.skipped[0].reason, /hard-gate 95/);
});

test("complete history produces one END trade and a full 721-point equity curve", () => {
  const result = run();
  assert.equal(result.simulation, true);
  assert.equal(result.mode, "current_candidates_historical_prices");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.period, { from: isoHour(0), to: isoHour(720), days: 30, interval: "1h" });
  assert.equal(result.snapshotAt, new Date(SNAPSHOT_AT).toISOString());
  assert.equal(result.coverage.expectedCandlesPerSeries, 720);
  assert.equal(result.coverage.priceSeries[0].candleCount, 720);
  assert.equal(result.coverage.priceSeries[0].usable, true);
  assert.equal(result.coverage.priceSeries[0].error, null);
  assert.equal(result.equityCurve.length, 721);
  assert.ok(result.equityCurve.every((point, i) => point.at === isoHour(i) && point.equity === 1000));
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "END");
  assert.equal(result.trades[0].openedAt, isoHour(0));
  assert.equal(result.trades[0].closedAt, isoHour(720));
  assert.equal(result.trades[0].value, 250);
  assert.equal(result.metrics.totalPnl, 0);
  assert.equal(result.metrics.winRatePct, 0);
});

test("missing history returns null performance metrics without fabricated profit", () => {
  const result = run({ histories: [] });
  assertUnavailable(result);
  assert.equal(result.coverage.fetchedPriceSeries, 0);
  assert.equal(result.coverage.priceSeries[0].candleCount, 0);
  assert.match(result.coverage.priceSeries[0].error, /Riwayat harga tidak tersedia/);
});

test("provider error rejects even an otherwise complete profitable series", () => {
  const candidate = makeCandidate();
  const history = historyFor(candidate, [200]);
  history.error = "Synthetic upstream failure";
  const result = run({ candidates: [candidate], histories: [history] });
  assertUnavailable(result);
  assert.equal(result.coverage.priceSeries[0].candleCount, 720);
  assert.equal(result.coverage.priceSeries[0].error, history.error);
  assert.equal(result.skipped[0].reason, history.error);
});

for (const [name, invalidate] of [
  ["empty series", (history) => { history.candles = []; }],
  ["missing first candle", (history) => { history.candles.shift(); }],
  ["missing final candle", (history) => { history.candles.pop(); }],
  ["missing middle candle", (history) => { history.candles.splice(300, 1); }],
  ["duplicate timestamp hiding an hourly gap", (history) => { history.candles[300].at = history.candles[299].at; }],
  ["721 in-period candles", (history) => { history.candles.push({ ...history.candles[300] }); }],
  ["non-hourly timestamp", (history) => { history.candles[300].at += 1; }],
  ["missing timestamp", (history) => { delete history.candles[300].at; }],
  ["numeric-string timestamp", (history) => { history.candles[300].at = String(history.candles[300].at); }],
  ["out-of-period candle hiding an hourly gap", (history) => { history.candles[300].at = TO; }],
]) {
  test("history validation rejects " + name + " without partial simulation", () => {
    const candidate = makeCandidate();
    const history = historyFor(candidate, [200]);
    invalidate(history);
    const result = run({ candidates: [candidate], histories: [history] });
    assertUnavailable(result);
    assert.match(result.coverage.priceSeries[0].error, /Candle 30 hari tidak lengkap/);
  });
}

for (const field of ["open", "close", "high", "low"]) {
  test("history validation rejects invalid " + field + " prices", () => {
    for (const value of [0, -1, NaN, Infinity, "100", null, undefined]) {
      const candidate = makeCandidate();
      const history = historyFor(candidate, [200]);
      history.candles[300][field] = value;
      const result = run({ candidates: [candidate], histories: [history] });
      assertUnavailable(result);
      assert.match(result.coverage.priceSeries[0].error, /Candle 30 hari tidak lengkap/);
    }
  });
}

for (const [name, changes] of [
  ["high below open", { open: 100, close: 90, high: 99, low: 90 }],
  ["high below close", { open: 100, close: 200, high: 199, low: 100 }],
  ["low above open", { open: 100, close: 200, high: 200, low: 101 }],
  ["low above close", { open: 100, close: 90, high: 100, low: 91 }],
  ["high below low", { open: 100, close: 100, high: 90, low: 110 }],
]) {
  test("history validation rejects impossible OHLC ordering: " + name, () => {
    const candidate = makeCandidate();
    const history = historyFor(candidate, [200]);
    Object.assign(history.candles[300], changes);
    const result = run({ candidates: [candidate], histories: [history] });
    assertUnavailable(result);
    assert.ok(result.coverage.priceSeries[0].error);
  });
}

test("complete reversed history is sorted without mutating input candles", () => {
  const candidate = makeCandidate();
  const history = historyFor(candidate, [102, 90, 100]);
  const expected = run({ candidates: [candidate], histories: [history] });
  history.candles.reverse();
  const snapshot = structuredClone(history);
  deepFreeze(history);
  assert.deepEqual(run({ candidates: [candidate], histories: [history] }), expected);
  assert.deepEqual(history, snapshot);
});

test("candles outside the requested period are ignored without replacing required candles", () => {
  const candidate = makeCandidate();
  const history = historyFor(candidate);
  history.candles.unshift({ at: FROM - HOUR_MS, open: 100, close: 100, high: 100, low: 100 });
  history.candles.push({ at: TO, open: 100, close: 100, high: 100, low: 100 });
  const result = run({ candidates: [candidate], histories: [history] });
  assert.equal(result.coverage.priceSeries[0].candleCount, 720);
  assert.equal(result.coverage.usablePriceSeries, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].closedAt, isoHour(720));
});

test("missing or failed series cannot borrow another chain's matching-address history", () => {
  const base = makeCandidate();
  const eth = makeCandidate({ chain: "ETH", address: base.address.toLowerCase(), symbol: "ETH-TOKEN" });
  const sol = makeCandidate({ chain: "SOL", address: SOL_ADDRESS, symbol: "SOL-TOKEN" });
  const failed = historyFor(sol, [200]);
  failed.error = "Synthetic missing pool";
  const result = run({
    candidates: [base, eth, sol], histories: [historyFor(base), failed],
    startingBalances: { BASE: { usdc: 1000 }, ETH: { usdc: 1000 }, SOL: { usdc: 1000 } },
  });
  assert.equal(result.coverage.usablePriceSeries, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].chain, "BASE");
  assert.equal(result.metrics.totalPnl, 0);
  assert.deepEqual(result.coverage.priceSeries.map((series) => series.usable), [true, false, false]);
  assert.equal(result.skipped.length, 2);
});

test("history candidate cap keeps only the first ten eligible series", () => {
  const candidates = EVM_ADDRESSES.map((address, i) => makeCandidate({ address, symbol: "TOKEN" + i }));
  const result = run({ candidates, startingBalances: { BASE: { usdc: 10000 } } });
  assert.equal(result.coverage.eligibleCandidates, 11);
  assert.equal(result.coverage.usablePriceSeries, 10);
  assert.equal(result.coverage.priceSeries.length, 11);
  assert.equal(result.coverage.priceSeries[10].usable, false);
  assert.match(result.coverage.priceSeries[10].error, /10 kandidat teratas/);
  assert.ok(!result.trades.some((trade) => trade.address === candidates[10].address));
});

// For [4, 16], entry 9 and capital 300, L = 1200/7, x0 = 100/7, y0 = 1200/7.
for (const [name, price, expected] of [
  ["entry", 9, { value: 300, holdValue: 300, il: 0, model: "cl" }],
  ["inside lower half", 6.25, { value: 246.43, holdValue: 260.71, il: -14.29, model: "cl" }],
  ["inside upper half", 12.25, { value: 332.14, holdValue: 346.43, il: -14.29, model: "cl" }],
  ["lower boundary", 4, { value: 171.43, holdValue: 228.57, il: -57.14, model: "cl" }],
  ["upper boundary", 16, { value: 342.86, holdValue: 400, il: -57.14, model: "cl" }],
  ["below range", 1, { value: 42.86, holdValue: 185.71, il: -142.86, model: "cl" }],
  ["above range", 25, { value: 342.86, holdValue: 528.57, il: -185.71, model: "cl" }],
]) {
  test("concentrated LP valuation is deterministic at " + name + " with IL <= 0", () => {
    const position = deepFreeze({ amount: 300, entryPrice: 9, minPrice: 4, maxPrice: 16, distribution: "50/50" });
    const actual = valuePosition(position, price);
    assert.deepEqual(actual, expected);
    assert.ok(actual.il <= 0);
    assert.equal(valuePosition(position, price).value, actual.value);
  });
}

test("concentrated LP valuation is continuous at both range boundaries", () => {
  const position = { amount: 300, entryPrice: 9, minPrice: 4, maxPrice: 16 };
  for (const boundary of [4, 16]) {
    const at = valuePosition(position, boundary);
    assert.deepEqual(valuePosition(position, boundary - 1e-8), at);
    assert.deepEqual(valuePosition(position, boundary + 1e-8), at);
  }
  assert.equal(valuePosition(position, 25).value, valuePosition(position, 100).value);
  assert.equal(valuePosition(position, 2).value, cents(600 / 7));
});

test("entry capital is conserved even when entry is outside the LP range", () => {
  for (const entryPrice of [1, 4, 9, 16, 25]) {
    const position = { amount: 300, entryPrice, minPrice: 4, maxPrice: 16 };
    assert.deepEqual(valuePosition(position, entryPrice), { value: 300, holdValue: 300, il: 0, model: "cl" });
  }
});

test("legacy no-range 50/50 valuation retains non-positive IL", () => {
  const position = { amount: 250, entryPrice: 100, distribution: "50/50" };
  assert.deepEqual(valuePosition(position, 100), { value: 250, holdValue: 250, il: 0, model: "legacy" });
  assert.deepEqual(valuePosition(position, 400), { value: 500, holdValue: 625, il: -125, model: "legacy" });
  assert.deepEqual(valuePosition(position, 25), { value: 125, holdValue: 156.25, il: -31.25, model: "legacy" });
});

test("invalid valuation prices do not fabricate returns", () => {
  const position = { amount: 250, entryPrice: 100, minPrice: 95, maxPrice: 105 };
  for (const price of [0, -1, NaN, undefined]) {
    assert.deepEqual(valuePosition(position, price), { value: 250, holdValue: 250, il: 0, model: "none" });
  }
});

for (const [rangePreset, minPrice, maxPrice] of [
  ["narrow", 98, 102], ["medium", 95, 105], ["wide", 90, 110],
]) {
  test("replay uses the " + rangePreset + " LP range preset", () => {
    const result = run({ settings: makeSettings({ autoTrading: { rangePreset } }) });
    assert.ok(Math.abs(result.trades[0].minPrice - minPrice) < 1e-12);
    assert.ok(Math.abs(result.trades[0].maxPrice - maxPrice) < 1e-12);
    assert.equal(result.trades[0].distribution, "50/50");
  });
}

test("max drawdown marks open LPs to market and uses equity peaks rather than realized losses", () => {
  const candidate = makeCandidate();
  const result = run({ candidates: [candidate], histories: [historyFor(candidate, [200, 50, 100])] });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "END");
  assert.equal(result.trades[0].pnl, 0);
  assert.equal(result.metrics.losses, 0);
  assert.equal(result.metrics.totalPnl, 0);
  assert.equal(result.equityCurve[1].equity, 1003.01);
  assert.equal(result.equityCurve[2].equity, 876.66);
  assert.equal(result.metrics.maxDrawdownUsd, 126.35);
  assert.equal(result.metrics.maxDrawdownPct, 12.6);
  assert.equal(result.equityCurve[2].drawdownPct, 12.6);
  let peak = result.metrics.initialCapital;
  let maxUsd = 0;
  let maxPct = 0;
  for (const point of result.equityCurve) {
    peak = Math.max(peak, point.equity);
    maxUsd = Math.max(maxUsd, peak - point.equity);
    maxPct = Math.max(maxPct, (peak - point.equity) / peak * 100);
    assert.equal(point.drawdownPct, cents((peak - point.equity) / peak * 100));
  }
  assert.equal(result.metrics.maxDrawdownUsd, cents(maxUsd));
  assert.equal(result.metrics.maxDrawdownPct, cents(maxPct));
});

test("wins, losses, and break-even all count in the denominator and total PnL is conserved", () => {
  const candidates = EVM_ADDRESSES.slice(0, 3).map((address, i) => makeCandidate({ address, symbol: ["WIN", "LOSS", "FLAT"][i] }));
  const result = run({ candidates, histories: candidates.map((candidate, i) => historyFor(candidate, [[105], [80], [100]][i])) });
  assert.equal(result.metrics.totalTrades, 3);
  assert.equal(result.metrics.wins, 1);
  assert.equal(result.metrics.losses, 1);
  assert.equal(result.metrics.breakEven, 1);
  assert.equal(result.metrics.winRatePct, 33.33);
  assert.equal(result.metrics.totalPnl, -44.33);
  assert.equal(result.metrics.finalEquity, 955.67);
  assert.equal(result.metrics.returnPct, -4.43);
  assert.deepEqual(result.trades.map((trade) => trade.pnl), [3.01, -47.34, 0]);
  assert.ok(result.trades.every((trade) => trade.reason === "END" && trade.closedAt === isoHour(720)));
  assert.equal(cents(result.trades.reduce((sum, trade) => sum + trade.pnl, 0)), result.metrics.totalPnl);
  assert.equal(cents(result.metrics.finalEquity - result.metrics.initialCapital), result.metrics.totalPnl);
  assert.equal(cents(250 + result.trades.reduce((sum, trade) => sum + trade.value, 0)), result.metrics.finalEquity);
  assert.ok(result.trades.every((trade) => cents(trade.value - trade.amount) === trade.pnl));
});

test("END liquidation includes the last candle close, not the last open or original capital", () => {
  const candidate = makeCandidate();
  const closes = Array(CANDLE_COUNT).fill(100);
  closes[CANDLE_COUNT - 1] = 80;
  const result = run({ candidates: [candidate], histories: [historyFor(candidate, closes)] });
  assert.equal(result.trades[0].reason, "END");
  assert.equal(result.trades[0].closedAt, isoHour(720));
  assert.equal(result.trades[0].exitPrice, 80);
  assert.equal(result.trades[0].value, 202.66);
  assert.equal(result.metrics.finalEquity, 952.66);
  assert.equal(result.metrics.totalPnl, -47.34);
  assert.equal(result.equityCurve[719].equity, 1000);
  assert.equal(result.equityCurve[720].equity, 952.66);
});

test("TP and SL ignore intrabar high/low crossings when the candle closes flat", () => {
  const candidate = makeCandidate();
  const history = historyFor(candidate);
  history.candles[0].high = 200;
  history.candles[0].low = 1;
  const result = run({ candidates: [candidate], histories: [history], settings: makeSettings({ tpSl: { defaultTpPct: 1, defaultSlPct: 1 } }) });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "END");
  assert.equal(result.trades[0].closedAt, isoHour(720));
  assert.equal(result.metrics.totalPnl, 0);
});

for (const [reason, closes, pnl] of [
  ["TP", [102, 105], 3.01], ["SL", [99, 90], -22.01],
]) {
  test(reason + " is evaluated on close using LP capital PnL, not token-price percentage", () => {
    const candidate = makeCandidate();
    const result = run({
      candidates: [candidate], histories: [historyFor(candidate, closes)],
      settings: makeSettings({ tpSl: { defaultTpPct: 1, defaultSlPct: 1 } }),
    });
    assert.equal(result.trades.length, 2);
    assert.equal(result.trades[0].reason, reason);
    assert.equal(result.trades[0].closedAt, isoHour(2));
    assert.equal(result.trades[0].pnl, pnl);
    assert.equal(result.trades[1].openedAt, isoHour(2));
    assert.equal(result.trades[1].entryPrice, closes[1]);
    assert.equal(result.trades[1].reason, "END");
  });
}

test("a vacated slot refills at the following hour's open, never on the exiting candle", () => {
  const candidate = makeCandidate();
  const result = run({
    candidates: [candidate], histories: [historyFor(candidate, [90])],
    settings: makeSettings({ autoTrading: { maxPositions: 1 }, tpSl: { defaultSlPct: 1 } }),
  });
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].reason, "SL");
  assert.equal(result.trades[0].openedAt, isoHour(0));
  assert.equal(result.trades[0].closedAt, isoHour(1));
  assert.equal(result.trades[1].openedAt, isoHour(1));
  assert.equal(result.trades[1].entryPrice, 90);
  assert.equal(result.trades[1].closedAt, isoHour(720));
  assert.equal(result.metrics.maxConcurrentPositions, 1);
  assert.equal(result.metrics.totalPnl, -22.01);
});

test("UTC daily realized-loss stop blocks refills and resets at the next midnight", () => {
  const candidate = makeCandidate();
  const result = run({
    candidates: [candidate], histories: [historyFor(candidate, [80])],
    settings: makeSettings({ autoTrading: { maxPositions: 1, dailyLossLimit: 25 }, tpSl: { defaultSlPct: 10 } }),
  });
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].reason, "SL");
  assert.equal(result.trades[0].closedAt, isoHour(1));
  assert.equal(result.trades[0].pnl, -47.34);
  assert.equal(result.trades[1].openedAt, isoHour(24));
  assert.equal(result.trades[1].reason, "END");
  assert.equal(result.metrics.dailyLossStoppedDays, 1);
  assert.equal(result.metrics.totalPnl, -47.34);
});

test("a loss closing exactly at midnight belongs to the new UTC day", () => {
  const candidate = makeCandidate();
  const closes = Array(24).fill(100);
  closes[23] = 80;
  const result = run({
    candidates: [candidate], histories: [historyFor(candidate, closes)],
    settings: makeSettings({ autoTrading: { maxPositions: 1, dailyLossLimit: 25 }, tpSl: { defaultSlPct: 10 } }),
  });
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].closedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(result.trades[0].reason, "SL");
  assert.equal(result.trades[1].openedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(result.metrics.dailyLossStoppedDays, 1);
});

test("zero daily-loss limit disables the stop without disabling SL", () => {
  const candidate = makeCandidate();
  const result = run({
    candidates: [candidate], histories: [historyFor(candidate, [80])],
    settings: makeSettings({ autoTrading: { maxPositions: 1, dailyLossLimit: 0 }, tpSl: { defaultSlPct: 10 } }),
  });
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].reason, "SL");
  assert.equal(result.trades[1].openedAt, isoHour(1));
  assert.equal(result.metrics.dailyLossStoppedDays, 0);
});

test("daily-loss stop uses realized PnL rather than an open-position drawdown", () => {
  const candidate = makeCandidate();
  const result = run({
    candidates: [candidate], histories: [historyFor(candidate, [80, 100])],
    settings: makeSettings({ autoTrading: { dailyLossLimit: 1 } }),
  });
  assert.equal(result.metrics.dailyLossStoppedDays, 0);
  assert.equal(result.metrics.maxDrawdownUsd, 47.34);
  assert.equal(result.metrics.totalPnl, 0);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, "END");
});

test("insufficient chain cash cannot be funded by another chain's balance", () => {
  const base = makeCandidate();
  const eth = makeCandidate({ chain: "ETH", address: base.address, symbol: "ETH-TOKEN" });
  const result = run({ candidates: [base, eth], startingBalances: { BASE: { usdc: 249.99 }, ETH: { usdc: 1000 } } });
  assert.equal(result.metrics.initialCapital, 1249.99);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].chain, "ETH");
  assert.equal(result.metrics.finalEquity, 1249.99);
  assert.match(result.skipped.find((item) => item.chain === "BASE").reason, /Saldo.*chain BASE/);
});

test("exactly $250 chain cash funds one $250 position", () => {
  const result = run({ startingBalances: { BASE: { usdc: 250 } } });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].amount, 250);
  assert.equal(result.metrics.finalEquity, 250);
  assert.deepEqual(result.skipped, []);
});

test("default $5000 allocation cap is aggregate across chains and includes its boundary", () => {
  const candidates = [
    makeCandidate(),
    makeCandidate({ chain: "ETH", address: EVM_ADDRESSES[1], symbol: "ETH-TOKEN" }),
    makeCandidate({ address: EVM_ADDRESSES[2], symbol: "CAPPED" }),
  ];
  const result = run({
    candidates, startingBalances: { BASE: { usdc: 10000 }, ETH: { usdc: 10000 } },
    settings: makeSettings({ autoTrading: { amountPerPosition: 2500, maxPositions: 3 } }),
  });
  assert.equal(result.metrics.maxConcurrentPositions, 2);
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades.reduce((sum, trade) => sum + trade.amount, 0), 5000);
  assert.deepEqual(result.trades.map((trade) => trade.chain), ["BASE", "ETH"]);
  assert.match(result.skipped.find((item) => item.symbol === "CAPPED").reason, /Alokasi melebihi modal/);
  assert.equal(result.metrics.finalEquity, 20000);
});

test("replay is deterministic, offline, and does not mutate settings, histories, candidates, or balances", (t) => {
  const candidate = makeCandidate();
  const history = historyFor(candidate, [200, 50, 100]);
  history.candles.reverse();
  const input = backtestInput({ candidates: [candidate], histories: [history], startingBalances: { BASE: { usdc: 1000, eth: 7 } } });
  const snapshot = structuredClone(input);
  deepFreeze(input);
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Tests must not access the network"); });
  const clock = t.mock.method(Date, "now", () => { throw new Error("Tests must not use the wall clock"); });
  const first = runNaraBacktest(input);
  const second = runNaraBacktest(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(clock.mock.callCount(), 0);
  assert.notStrictEqual(first.settings, input.settings);
  assert.notStrictEqual(first.settings.autoTrading, input.settings.autoTrading);
  assert.notStrictEqual(first.settings.tpSl, input.settings.tpSl);
  first.settings.autoTrading.minScore = 99;
  first.trades[0].symbol = "CHANGED-OUTPUT";
  assert.equal(input.settings.autoTrading.minScore, 70);
  assert.equal(input.candidates[0].symbol, "ALPHA");
  assert.equal(input.startingBalances.BASE.usdc, 1000);
  assert.equal(input.startingBalances.BASE.eth, 7);
});

test("settings merge only saved keys, round sizing, and leave saved settings and overrides unchanged", () => {
  const saved = makeSettings();
  const overrides = {
    autoTrading: { minScore: 75, amountPerPosition: 250.126, chainFilter: "BASE", unknown: "ignored" },
    tpSl: { defaultTpPct: 15, defaultSlPct: 5, unknown: "ignored" },
    unrelated: { value: true },
  };
  const snapshot = structuredClone({ saved, overrides });
  deepFreeze(saved);
  deepFreeze(overrides);
  const result = backtestSettings(saved, overrides, CHAINS);
  assert.equal(result.autoTrading.minScore, 75);
  assert.equal(result.autoTrading.amountPerPosition, 250.13);
  assert.equal(result.autoTrading.maxPositions, 3);
  assert.equal(result.autoTrading.chainFilter, "BASE");
  assert.equal(result.tpSl.defaultTpPct, 15);
  assert.equal(result.tpSl.defaultSlPct, 5);
  assert.equal(result.autoTrading.unknown, undefined);
  assert.equal(result.tpSl.unknown, undefined);
  assert.equal(result.unrelated, undefined);
  assert.deepEqual({ saved, overrides }, snapshot);
});

test("settings accept allowed numeric boundaries and boolean toggles", () => {
  for (const overrides of [
    { autoTrading: { minScore: 0, amountPerPosition: 0.01, maxPositions: 1, minApr: 0, enabled: false }, tpSl: { armed: false } },
    { autoTrading: { minScore: 100, amountPerPosition: 5000, maxPositions: 20, minApr: 100000 } },
  ]) {
    const result = backtestSettings(makeSettings(), overrides, CHAINS);
    assert.equal(result.autoTrading.amountPerPosition, overrides.autoTrading.amountPerPosition);
    assert.equal(result.autoTrading.maxPositions, overrides.autoTrading.maxPositions);
  }
});

for (const [group, field] of [
  ["autoTrading", "minScore"], ["autoTrading", "amountPerPosition"], ["autoTrading", "maxPositions"],
  ["autoTrading", "dailyLossLimit"], ["autoTrading", "minLiquidity"], ["autoTrading", "minHolder"],
  ["autoTrading", "minApr"], ["tpSl", "defaultTpPct"], ["tpSl", "defaultSlPct"],
]) {
  test("settings reject non-numeric, non-finite, unsafe, or negative " + group + "." + field, () => {
    for (const value of [null, undefined, "70", true, {}, NaN, Infinity, -Infinity, -0.01, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => backtestSettings(makeSettings(), { [group]: { [field]: value } }, CHAINS), (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, new RegExp(field));
        return true;
      });
    }
  });
}

for (const [name, overrides, message] of [
  ["score over 100", { autoTrading: { minScore: 100.01 } }, /minScore/],
  ["size below one cent", { autoTrading: { amountPerPosition: 0.009 } }, /Nominal/],
  ["size above $5000", { autoTrading: { amountPerPosition: 5000.01 } }, /Nominal/],
  ["zero position slots", { autoTrading: { maxPositions: 0 } }, /maxPositions/],
  ["fractional position slots", { autoTrading: { maxPositions: 3.5 } }, /maxPositions/],
  ["over 20 position slots", { autoTrading: { maxPositions: 21 } }, /maxPositions/],
  ["APR over 100000", { autoTrading: { minApr: 100000.01 } }, /minApr/],
  ["unsupported source", { autoTrading: { source: "UNKNOWN" } }, /Sumber/],
  ["unsupported range", { autoTrading: { rangePreset: "unknown" } }, /range/],
  ["unsupported verdict", { autoTrading: { verdictFilter: "unknown" } }, /verdict/],
  ["unsupported chain", { autoTrading: { chainFilter: "UNKNOWN" } }, /chain/],
  ["non-boolean enabled", { autoTrading: { enabled: 1 } }, /Toggle/],
  ["non-boolean armed", { tpSl: { armed: "true" } }, /Toggle/],
]) {
  test("settings reject " + name + " with HTTP 400", () => {
    assert.throws(() => backtestSettings(makeSettings(), overrides, CHAINS), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, message);
      return true;
    });
  });
}

test("settings reject malformed override containers with HTTP 400", () => {
  for (const overrides of [null, [], "invalid", 1, true, { autoTrading: null }, { autoTrading: [] }, { autoTrading: "invalid" }, { tpSl: null }, { tpSl: [] }]) {
    assert.throws(() => backtestSettings(makeSettings(), overrides, CHAINS), (error) => error.statusCode === 400);
  }
});

test("replay validates saved settings rather than trusting malformed values", () => {
  const settings = makeSettings({ autoTrading: { amountPerPosition: "250" } });
  const input = backtestInput({ settings });
  const snapshot = structuredClone(input);
  assert.throws(() => runNaraBacktest(input), (error) => error.statusCode === 400 && /amountPerPosition/.test(error.message));
  assert.deepEqual(input, snapshot);
});

for (const [name, period] of [
  ["29 days", { to: TO - 24 * HOUR_MS }],
  ["31 days", { to: TO + 24 * HOUR_MS }],
  ["empty period", { to: FROM }],
  ["reversed period", { from: TO, to: FROM }],
  ["sub-hour start", { from: FROM + 1, to: TO + 1 }],
  ["sub-hour end", { to: TO + 1 }],
  ["NaN start", { from: NaN }],
  ["infinite start", { from: Infinity }],
  ["infinite end", { to: Infinity }],
  ["string start", { from: String(FROM) }],
  ["string end", { to: String(TO) }],
  ["missing start", { from: undefined }],
  ["null end", { to: null }],
  ["out-of-Date-range timestamps", { from: 8640000000000000, to: 8640000000000000 + 720 * HOUR_MS }],
]) {
  test("period validation rejects " + name + " with HTTP 400", () => {
    assert.throws(() => run(period), (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    });
  });
}

test("snapshot validation rejects missing, non-numeric, non-finite, or out-of-Date-range timestamps", () => {
  for (const snapshotAt of [null, undefined, String(SNAPSHOT_AT), NaN, Infinity, -Infinity, 8640000000000001]) {
    assert.throws(() => run({ snapshotAt }), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /snapshot/);
      return true;
    });
  }
});

test("invalid initial chain balances are rejected without mutation", () => {
  for (const startingBalances of [
    { BASE: { usdc: 0 } }, { BASE: { usdc: -1 } }, { BASE: { usdc: NaN } },
    { BASE: { usdc: Infinity } }, { BASE: { usdc: 1000 }, ETH: { usdc: -1 } },
  ]) {
    const snapshot = structuredClone(startingBalances);
    deepFreeze(startingBalances);
    assert.throws(() => run({ startingBalances }), /Modal awal backtest tidak valid/);
    assert.deepEqual(startingBalances, snapshot);
  }
});
