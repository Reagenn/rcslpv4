"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const {
  UNISWAP_V4_NETWORKS,
  normalizeGeckoPools,
  normalizeMeteoraPools,
  tokenAddressKey,
  isPoolTokenAddress,
} = require("./src/uniswap-v4");
const { migrateLegacyPositionRisk, positionExitReason } = require("./src/position-risk");
const { autoTradingRiskReason } = require("./src/auto-trading-risk");

(async () => {
  const root = process.cwd();
  const frontendScript = fs.readFileSync(path.join(root, "frontend", "assets", "js", "app.js"), "utf8");
  const serverScript = fs.readFileSync(path.join(root, "backend", "src", "server.js"), "utf8");
  assert(serverScript.includes("api.geckoterminal.com"), "EVM APR scanner uses GeckoTerminal REST API");
  assert(serverScript.includes("normalizeMeteoraPools"), "Solana APR scanner uses Meteora pool fee data");
  assert(serverScript.includes("ROBINHOOD: 4663"), "Robinhood token security uses its supported GoPlus chain ID");
  assert(serverScript.includes("/api/pools/apr"), "APR scanner has a protocol-neutral API route");
  assert(serverScript.includes("pairs.filter((pair) => chainFromPair(pair) === chain)"), "live token prices are filtered to the position chain");
  assert(serverScript.includes("byChainAddress"), "positions sharing an address on different chains are repriced separately");
  assert(!serverScript.includes("UNISWAP_V4_SUBGRAPH_URL"), "APR scanner does not use a Subgraph URL");
  assert(UNISWAP_V4_NETWORKS.some((network) => network.chain === "ROBINHOOD"), "Robinhood Chain v4 pools are included");
  assert(frontendScript.includes("naraAprTradeBtn"), "APR preview provides an explicit simulation action");
  assert(serverScript.includes("token-boosts/top/v1"), "candidate feed includes top boosted tokens");
  assert(serverScript.includes("token-profiles/recent-updates/v1"), "candidate feed includes recently updated token profiles");
  assert(serverScript.includes("slice(0, 40)"), "candidate feed prioritizes up to 40 Robinhood tokens");
  assert(serverScript.includes("holder_count_is_lower_bound"), "partial holder lists are labeled as lower bounds");
  assert(frontendScript.includes("Tidak tersedia"), "missing holder counts are labeled instead of rendered blank");
  assert.equal(positionExitReason({ amount: 250, slPnlPct: 10, tpPnlPct: 10 }, 2222, 5.8), null, "large token price gains do not trigger TP if LP PnL is below the USD target");
  assert.equal(positionExitReason({ amount: 250, slPnlPct: 10, tpPnlPct: 10 }, 900, 25), "TP", "TP triggers at 10% of the USD position amount");
  assert.equal(positionExitReason({ amount: 250, slPnlPct: 10, tpPnlPct: 10 }, 900, -25), "SL", "SL triggers at 10% of the USD position amount");
  assert.equal(positionExitReason({ amount: 100, sl: 90, tp: 110 }, 111, 0), "TP", "legacy absolute-price TP positions remain supported");
  assert.equal(positionExitReason({ amount: 250, slPnlPct: 10, tp: 110 }, 111, 0), "TP", "a legacy absolute-price TP remains active beside a PnL-based SL");
  const migratedRisk = migrateLegacyPositionRisk({ status: "open", entryPrice: 100, sl: 90, tp: 110 });
  assert.equal(migratedRisk.slPnlPct, 10, "legacy open SL is migrated to an equivalent capital percentage");
  assert.equal(migratedRisk.tpPnlPct, 10, "legacy open TP is migrated to an equivalent capital percentage");
  assert.equal(migratedRisk.sl, null, "legacy open price threshold is removed after migration");
  assert.equal(migrateLegacyPositionRisk({ status: "closed", entryPrice: 100, sl: 90 }).sl, 90, "closed history is not rewritten");
  assert(serverScript.includes("autoTradingRiskReason"), "Auto Trading enforces backend risk hard-gates");
  const riskNow = Date.parse("2026-06-12T00:00:00Z");
  const safeCandidate = {
    agent_analysis: { status: "complete", confidence: "high", security_score: 100, top_holders_percent: 20 },
    holders_count: 800, liquidity_usd: 120000, volume_24h: 50000,
    pair_created_at: riskNow - 48 * 60 * 60 * 1000, price_change_data_available: true,
    price_change_24h: 8, price_change_h1: 2, price_change_h6: 5, price_change_m5: 1,
  };
  assert.equal(autoTradingRiskReason(safeCandidate, { now: riskNow }), null, "candidate passing all hard-gates is eligible for configured filters");
  assert.match(autoTradingRiskReason({ ...safeCandidate, price_change_24h: -90 }, { now: riskNow }), /Perubahan harga 24 jam/, "rug-like daily price collapse is blocked");
  assert.match(autoTradingRiskReason({ ...safeCandidate, agent_analysis: { ...safeCandidate.agent_analysis, status: "partial" } }, { now: riskNow }), /Data keamanan\/holder/, "incomplete security data is rejected");
  assert.match(autoTradingRiskReason({ ...safeCandidate, pair_created_at: riskNow - 2 * 60 * 60 * 1000 }, { now: riskNow }), /Umur pool/, "new pools are rejected");
  assert.match(autoTradingRiskReason({ ...safeCandidate, agent_analysis: { ...safeCandidate.agent_analysis, top_holders_percent: 45 } }, { now: riskNow }), /Konsentrasi 10 holder/, "concentrated holder ownership is rejected");
  const scanNow = Date.parse("2026-01-03T00:00:00Z");
  const geckoNetwork = { networkId: "base", chain: "BASE", chainName: "Base" };
  const tokenId = "base_0x1111111111111111111111111111111111111111";
  const quoteId = "base_0x2222222222222222222222222222222222222222";
  const poolFixture = (address, name, createdAt) => ({
    type: "pool",
    attributes: {
      address, name, pool_created_at: createdAt,
      reserve_in_usd: "100000", volume_usd: { h24: "1000000" },
    },
    relationships: {
      base_token: { data: { id: tokenId } },
      quote_token: { data: { id: quoteId } },
    },
  });
  const normalizedPools = normalizeGeckoPools(geckoNetwork, {
    data: [
      poolFixture("0xpool", "TEST / USD 0.01%", "2026-01-01T00:00:00Z"),
      poolFixture("0xyoung", "TEST / USD 0.01%", "2026-01-02T12:00:00Z"),
      poolFixture("0xunknown-fee", "TEST / USD", "2026-01-01T00:00:00Z"),
    ],
    included: [
      { id: tokenId, type: "token", attributes: { address: "0x1111111111111111111111111111111111111111", symbol: "TEST" } },
      { id: quoteId, type: "token", attributes: { address: "0x2222222222222222222222222222222222222222", symbol: "USD" } },
    ],
  }, scanNow);
  assert.equal(normalizedPools.length, 1, "only pools with known fees and at least 24h age are included");
  assert.equal(normalizedPools[0].estimatedFees24hUsd, 100, "estimated fees use volume multiplied by the fee tier");
  assert.equal(normalizedPools[0].apr, 36.5, "estimated APR is annualized against TVL");
  assert.equal(normalizedPools[0].chain, "BASE", "pool retains its network identity");

  const solanaPools = normalizeMeteoraPools({ data: [{
    address: "DLMMpoolAddress",
    token_x: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
    token_y: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
    created_at: Date.parse("2026-01-01T00:00:00Z"),
    tvl: 100000,
    volume: { "24h": 100000 },
    fees: { "24h": 100 },
    pool_config: { base_fee_pct: 0.04 },
    dynamic_fee_pct: 0,
  }] }, scanNow);
  assert.equal(solanaPools.length, 1, "Meteora Solana pool is normalized");
  assert.equal(solanaPools[0].protocol, "Meteora DLMM", "Solana pool is not mislabeled Uniswap v4");
  assert.equal(solanaPools[0].apr, 36.5, "Solana APR uses reported 24h fees and TVL");
  assert(isPoolTokenAddress("SOL", solanaPools[0].token0.id), "Solana mint addresses are accepted");
  assert.notEqual(tokenAddressKey("SOL", "Abc"), tokenAddressKey("SOL", "abc"), "Solana address matching preserves Base58 case");
  assert.equal(tokenAddressKey("BASE", "0xABCD"), tokenAddressKey("BASE", "0xabcd"), "EVM address matching is case-insensitive");
  for (const config of [
    'const BASE_MAINNET_CHAIN_ID = "0x2105"',
    "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    "0x2626664c2603336E57B271c5C0b26F421741e481",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ]) assert(frontendScript.includes(config), "Base Mainnet swap config is present: " + config);
  assert(frontendScript.includes("mainnetRiskAcknowledged"), "mainnet risk acknowledgement gates swaps");
  assert(!frontendScript.includes("BASE_SEPOLIA_CHAIN_ID"), "no testnet chain guard remains");
  assert(!frontendScript.includes("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), "testnet USDC is removed");
  const temp = path.join(os.tmpdir(), "rcs-phase3-" + crypto.randomBytes(6).toString("hex"));
  const port = 41000 + crypto.randomInt(10000);
  const base = "http://127.0.0.1:" + port;
  let child;
  try {
    fs.mkdirSync(path.join(temp, "backend", "src"), { recursive: true });
    fs.cpSync(path.join(root, "backend", "src"), path.join(temp, "backend", "src"), { recursive: true });
    fs.cpSync(path.join(root, "frontend"), path.join(temp, "frontend"), { recursive: true });
    child = spawn(process.execPath, [path.join(temp, "backend", "src", "server.js")], {
      cwd: temp,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    const request = async (pathname, method, cookie, body, origin) => {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (method !== "GET") {
        headers.origin = origin || base;
        headers["content-type"] = "application/json";
      }
      const response = await fetch(base + pathname, {
        method: method || "GET",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { response, data: await response.json().catch(() => ({})) };
    };
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fetch(base + "/api/auth/me");
        ready = true;
        break;
      } catch (_) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert(ready, "server did not start");
    for (const route of ["/", "/following", "/leaderboard", "/u/alice"]) {
      const page = await fetch(base + route);
      assert.equal(page.status, 200, "SPA route is served: " + route);
      const html = await page.text();
      assert(html.includes('href="/assets/css/styles.css"'), "route uses root-relative stylesheet: " + route);
      assert(html.includes('src="/assets/js/app.js"'), "route uses root-relative app script: " + route);
    }
    for (const asset of ["/assets/css/styles.css", "/assets/js/app.js"]) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200, "root asset is served: " + asset);
    }

    let result = await request("/api/state");
    assert.equal(result.response.status, 401, "desk API requires authentication");
    result = await request("/api/balance/fund", "POST", null, { chain: "SOL", amount: 10 });
    assert.equal(result.response.status, 401, "simulated top-up requires authentication");
    result = await request("/api/auth/me");
    assert.equal(result.data.user, null, "anonymous session response");

    result = await request("/api/auth/register", "POST", null, { username: "alice", password: "phase3-password-a", displayName: "Alice" });
    assert.equal(result.response.status, 201, "register first account");
    const cookieA = result.response.headers.get("set-cookie").split(";")[0];

    result = await request("/api/auth/register", "POST", null, { username: "bobby", password: "phase3-password-b" });
    assert.equal(result.response.status, 201, "register second account");
    const cookieB = result.response.headers.get("set-cookie").split(";")[0];
    result = await request("/api/auth/me", "GET", cookieA);
    assert.equal(result.data.user.username, "alice", "first session is valid");
    result = await request("/api/balance/fund", "POST", cookieA, { chain: "SOL", amount: 125.5 });
    assert.equal(result.response.status, 200, "authenticated user can fund a simulated chain balance");
    assert.equal(result.data.balances.SOL.usdc, 1625.5, "top-up adds USDC to the selected chain only");
    assert.equal(result.data.transactions[0].side, "deposit", "simulated top-up is recorded in transaction history");
    result = await request("/api/balance/fund", "POST", cookieA, { chain: "NOT_A_CHAIN", amount: 10 });
    assert.equal(result.response.status, 400, "invalid chain top-up is rejected");
    result = await request("/api/balance/fund", "POST", cookieA, { chain: "SOL", amount: 1000000.01 });
    assert.equal(result.response.status, 400, "oversized simulated top-up is rejected");
    result = await request("/api/state", "GET", cookieB);
    assert.equal(result.data.balances.SOL.usdc, 1500, "simulated top-up is isolated to its account");

    result = await request("/api/profile", "GET", cookieA);
    assert.equal(result.data.sharePositions, false, "positions private by default: " + JSON.stringify(result.data));
    assert.equal(result.data.shareNetWorth, false, "net worth private by default");
    result = await request("/api/profiles/alice", "GET");
    assert.equal(result.response.status, 200, "public profile available");
    assert(!("positions" in result.data), "private positions omitted");
    assert(!("netWorth" in result.data), "private net worth omitted");
    assert(!("dueDiligence" in result.data), "private desk metadata omitted");

    result = await request("/api/profile", "POST", cookieA, {
      displayName: "Alice Public", sharePositions: false, shareNetWorth: false, showOnLeaderboard: true,
    });
    assert.equal(result.response.status, 200, "save profile privacy");
    result = await request("/api/settings", "POST", cookieA, { settings: { tpSl: { defaultTpPct: 37 }, autoTrading: { source: "UNISWAP_V4", minApr: 42 } } });
    assert.equal(result.response.status, 200, "save account A settings");
    result = await request("/api/settings", "GET", cookieB);
    assert.equal(result.data.settings.tpSl.defaultTpPct, 22, "account B settings isolated");
    assert.equal(result.data.settings.autoTrading.source, "DEX", "account B keeps default auto-trading source");
    result = await request("/api/settings", "GET", cookieA);
    assert.equal(result.data.settings.tpSl.defaultTpPct, 37, "account A settings persist");
    assert.equal(result.data.settings.autoTrading.source, "UNISWAP_V4", "account A can select Uniswap v4 source");
    assert.equal(result.data.settings.autoTrading.minApr, 42, "account A APR threshold persists");
    result = await request("/api/lp/open", "POST", cookieA, {
      chain: "BASE", symbol: "TEST", address: "private-token-address", amount: 100,
      price: 2, minPrice: 1, maxPrice: 3, slPnlPct: 10, tpPnlPct: 10,
    });
    assert.equal(result.response.status, 200, "account A can create a simulated position");
    assert.equal(result.data.position.slPnlPct, 10, "SL persists as a percentage of the USD position amount");
    assert.equal(result.data.position.tpPnlPct, 10, "TP persists as a percentage of the USD position amount");
    assert.equal(result.data.position.slPct, -10, "public SL percentage is displayed with a loss sign");
    assert.equal(result.data.position.tpPct, 10, "public TP percentage is displayed with a profit sign");
    assert.equal(result.data.position.net_pnl, 0, "net_pnl reports actual position PnL, not the hold delta");
    assert.equal(result.data.position.net_pnl_vs_holding, 0, "hold-relative PnL is exposed separately");
    result = await request("/api/state", "GET", cookieB);
    assert.equal(result.data.positions.length, 0, "account B cannot see account A positions");
    result = await request("/api/state", "GET", cookieA);
    assert.equal(result.data.positions.length, 1, "account A position persists independently");

    result = await request("/api/leaderboard", "GET");
    const rankedAlice = result.data.leaderboard.find((item) => item.username === "alice");
    assert(rankedAlice, "opted-in profile appears on leaderboard");
    assert(!("netWorth" in rankedAlice), "leaderboard hides unshared net worth");

    result = await request("/api/following", "POST", cookieB, { username: "alice", action: "follow" });
    assert.equal(result.response.status, 200, "follow succeeds");
    result = await request("/api/following", "GET", cookieB);
    assert.equal(result.data.following[0].username, "alice", "following lists public profile");
    assert(!("positions" in result.data.following[0]), "following respects private positions");

    result = await request("/api/profile", "POST", cookieA, { sharePositions: true });
    assert.equal(result.response.status, 200, "share positions preference saves");
    result = await request("/api/profiles/alice", "GET");
    assert.equal(result.data.positions.length, 1, "opted-in simulated position is shared");
    assert(!("address" in result.data.positions[0]), "public position omits token address");
    assert(!("balances" in result.data), "public position response omits private balances");
    result = await request("/api/profile", "POST", cookieA, { shareNetWorth: true });
    assert.equal(result.response.status, 200, "share net worth preference saves");
    result = await request("/api/profiles/alice", "GET");
    assert.equal(result.data.simulation, true, "shared net worth labeled simulation");
    assert.equal(typeof result.data.netWorth, "number", "shared net worth is exposed");
    assert.equal(result.data.followers, 1, "follower count updated");

    result = await request("/api/reset", "POST", cookieA, {}, "https://attacker.invalid");
    assert.equal(result.response.status, 403, "cross-origin mutation rejected");
    result = await request("/api/auth/logout", "POST", cookieA, {});
    assert.equal(result.response.status, 200, "logout succeeds");
    result = await request("/api/auth/me", "GET", cookieA);
    assert.equal(result.data.user, null, "logged out session revoked");
    result = await request("/api/auth/login", "POST", null, { username: "alice", password: "wrong-password" });
    assert.equal(result.response.status, 401, "invalid password rejected");

    console.log("Smoke tests passed: USD-based TP/SL, legacy migration, chain-scoped live prices, LP PnL vs hold metrics, APR normalization, auth and account isolation.");
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; }
      catch (_) { await new Promise((resolve) => setTimeout(resolve, 150)); }
    }
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
