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
const { pairPriceUsdForToken } = require("./src/dex-pricing");
const { verifyGoogleIdToken } = require("./src/google-auth");

(async () => {
  const root = process.cwd();
  const validGoogleClaims = {
    aud: "test-google-client-id",
    iss: "https://accounts.google.com",
    sub: "google-subject-123456",
    email: "alice@example.com",
    email_verified: "true",
    exp: "2000000000",
    name: "Alice Example",
  };
  const fakeGoogleFetch = async () => ({ ok: true, json: async () => validGoogleClaims });
  assert.deepEqual(await verifyGoogleIdToken("a".repeat(32), "test-google-client-id", fakeGoogleFetch, 1900000000000), {
    sub: validGoogleClaims.sub, email: "alice@example.com", name: "Alice Example",
  }, "verified Google identity claims are normalized");
  await assert.rejects(verifyGoogleIdToken("a".repeat(32), "other-client-id", fakeGoogleFetch, 1900000000000), /Invalid Google credential/, "Google audience mismatch is rejected");
  const wethAddress = "0x1111111111111111111111111111111111111111";
  const aiAddress = "0x2222222222222222222222222222222222222222";
  const aiWethPair = {
    baseToken: { address: aiAddress },
    quoteToken: { address: wethAddress },
    priceUsd: "0.02833",
    priceNative: "0.00001336",
  };
  assert.equal(pairPriceUsdForToken(aiWethPair, aiAddress, "ROBINHOOD"), 0.02833, "base-side token uses DexScreener USD price");
  assert(Math.abs(pairPriceUsdForToken(aiWethPair, wethAddress, "ROBINHOOD") - (0.02833 / 0.00001336)) < 1e-9, "quote-side token USD price is derived from priceNative");
  assert.equal(pairPriceUsdForToken(aiWethPair, "0x3333333333333333333333333333333333333333", "ROBINHOOD"), null, "unrelated token address is rejected");
  assert.equal(pairPriceUsdForToken({ ...aiWethPair, priceNative: undefined }, wethAddress, "ROBINHOOD"), null, "quote-side price is rejected without priceNative");
  const frontendScript = fs.readFileSync(path.join(root, "frontend", "assets", "js", "app.js"), "utf8");
  const frontendHtml = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
  const serverScript = fs.readFileSync(path.join(root, "backend", "src", "server.js"), "utf8");
  assert(serverScript.includes("monthlyPositionPnl()"), "desk state exposes month-to-date position PnL");
  assert(frontendHtml.includes('id="stripMonthPnl"'), "dashboard shows month-to-date position PnL");
  assert(frontendHtml.includes('id="profileAvatar" type="url"'), "profile avatar URL input markup is valid");
  assert(!frontendHtml.includes('type</label>="url"'), "profile avatar input does not leak malformed markup into the page");
  assert(serverScript.includes("api.geckoterminal.com"), "EVM APR scanner uses GeckoTerminal REST API");
  assert(serverScript.includes("normalizeMeteoraPools"), "Solana APR scanner uses Meteora pool fee data");
  assert(serverScript.includes("ROBINHOOD: 4663"), "Robinhood token security uses its supported GoPlus chain ID");
  assert(serverScript.includes("/api/pools/apr"), "APR scanner has a protocol-neutral API route");
  assert(serverScript.includes("pairs.filter((pair) => chainFromPair(pair) === chain)"), "live token prices are filtered to the position chain");
  assert(serverScript.includes("/api/auth/google") && serverScript.includes("verifyGoogleIdToken"), "Google ID tokens are verified on the backend");
  assert(frontendHtml.includes("accounts.google.com/gsi/client") && frontendHtml.includes("id=\"googleSignInButton\""), "auth screen offers Google Sign-In");
  assert(!frontendHtml.includes('id="authPassword"'), "password login form is removed");
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
    const sessionTokenA = "phase3-session-alice";
    const sessionTokenB = "phase3-session-bobby";
    const testUser = (id, username, googleSub) => ({
      id, username, googleSub, googleEmail: username + "@example.com",
      profile: { displayName: username, discordName: "", bio: "", avatarUrl: "", bannerUrl: "", sharePositions: false, shareNetWorth: false, showOnLeaderboard: false },
      following: [], createdAt: new Date().toISOString(),
    });
    const usersStore = {
      version: 1, legacyClaimed: true,
      users: { alice: testUser("user-alice", "alice", "google-sub-alice"), bobby: testUser("user-bobby", "bobby", "google-sub-bobby") },
      sessions: {
        [crypto.createHash("sha256").update(sessionTokenA).digest("hex")]: { userId: "user-alice", expiresAt: Date.now() + 60000 },
        [crypto.createHash("sha256").update(sessionTokenB).digest("hex")]: { userId: "user-bobby", expiresAt: Date.now() + 60000 },
      },
    };
    fs.mkdirSync(path.join(temp, "backend", "data"), { recursive: true });
    fs.writeFileSync(path.join(temp, "backend", "data", "users.json"), JSON.stringify(usersStore));
    const cookieA = "lpdesk_session=" + sessionTokenA;
    const cookieB = "lpdesk_session=" + sessionTokenB;
    child = spawn(process.execPath, [path.join(temp, "backend", "src", "server.js")], {
      cwd: temp,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), GOOGLE_CLIENT_ID: "" },
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

    result = await request("/api/auth/config");
    assert.equal(result.data.googleClientId, "", "Google client ID is not exposed when unconfigured");
    result = await request("/api/auth/google", "POST", null, { credential: "test-credential" });
    assert.equal(result.response.status, 503, "Google authentication is disabled until a client ID is configured");
    result = await request("/api/auth/register", "POST", cookieA, { username: "alice", password: "phase3-password-a" });
    assert.equal(result.response.status, 404, "password registration endpoint is removed");
    result = await request("/api/auth/login", "POST", cookieA, { username: "alice", password: "phase3-password-a" });
    assert.equal(result.response.status, 404, "password login endpoint is removed");
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

    const tinyAvatar = "data:image/jpeg;base64,/9j/2Q==";
    result = await request("/api/profile", "GET", cookieA);
    assert.equal(result.data.sharePositions, false, "positions private by default: " + JSON.stringify(result.data));
    assert.equal(result.data.shareNetWorth, false, "net worth private by default");
    result = await request("/api/profile", "POST", cookieA, {
      displayName: "Alice Public", avatarUrl: tinyAvatar, sharePositions: false, shareNetWorth: false, showOnLeaderboard: true,
    });
    assert.equal(result.response.status, 200, "save profile privacy and uploaded avatar");
    assert.equal(result.data.avatarUrl, tinyAvatar, "compressed JPEG avatar is accepted and persisted");
    result = await request("/api/profile", "POST", cookieA, { avatarUrl: "data:image/svg+xml;base64,PHN2Zz4=" });
    assert.equal(result.response.status, 400, "non-raster avatar uploads are rejected");
    result = await request("/api/profiles/alice", "GET");
    assert.equal(result.response.status, 200, "public profile available");
    assert.equal(result.data.avatarUrl, tinyAvatar, "uploaded avatar is included in public profile");
    assert(!("positions" in result.data), "private positions omitted");
    assert(!("netWorth" in result.data), "private net worth omitted");
    assert(!("dueDiligence" in result.data), "private desk metadata omitted");
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
    assert.equal(result.data.monthlyPositionPnl.month, new Date().toISOString().slice(0, 7), "position PnL uses the current calendar month");
    assert.equal(result.data.monthlyPositionPnl.pnl, 0, "new open position starts with zero monthly PnL");
    assert.equal(result.data.monthlyPositionPnl.positions, 1, "monthly PnL identifies current-month open positions");

    result = await request("/api/leaderboard", "GET");
    const rankedAlice = result.data.leaderboard.find((item) => item.username === "alice");
    assert(rankedAlice, "opted-in profile appears on leaderboard");
    assert(!("netWorth" in rankedAlice), "leaderboard hides unshared net worth");

    result = await request("/api/following", "POST", cookieB, { username: "alice", action: "follow" });
    assert.equal(result.response.status, 200, "follow succeeds");
    result = await request("/api/following", "GET", cookieB);
    assert.equal(result.data.following[0].username, "alice", "following lists public profile");
    assert.equal(result.data.following[0].followsYou, false, "one-way follows are identified before follow-back");
    assert(!("positions" in result.data.following[0]), "following respects private positions");
    result = await request("/api/following", "GET", cookieA);
    assert.equal(result.data.followers[0].username, "bobby", "profile owner can list followers");
    assert.equal(result.data.followers[0].isFollowing, false, "followers list identifies accounts not yet followed back");
    result = await request("/api/following", "POST", cookieA, { username: "bobby", action: "follow" });
    assert.equal(result.response.status, 200, "user can follow back a follower");
    result = await request("/api/following", "GET", cookieB);
    assert.equal(result.data.following[0].followsYou, true, "mutual follow relationship is reported");

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
    assert.equal(result.data.followingCount, 1, "following count updated for mutual follow");

    result = await request("/api/reset", "POST", cookieA, {}, "https://attacker.invalid");
    assert.equal(result.response.status, 403, "cross-origin mutation rejected");
    result = await request("/api/auth/logout", "POST", cookieA, {});
    assert.equal(result.response.status, 200, "logout succeeds");
    result = await request("/api/auth/me", "GET", cookieA);
    assert.equal(result.data.user, null, "logged out session revoked");
    result = await request("/api/auth/login", "POST", cookieB, { username: "alice", password: "wrong-password" });
    assert.equal(result.response.status, 404, "legacy password login stays disabled after logout");

    console.log("Smoke tests passed: Google ID token verification, Google-only auth, legacy account linking, USD-based TP/SL, APR normalization, and account isolation.");
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
