"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

(async () => {
  const root = process.cwd();
  const frontendScript = fs.readFileSync(path.join(root, "frontend", "assets", "js", "app.js"), "utf8");
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
    result = await request("/api/settings", "POST", cookieA, { settings: { tpSl: { defaultTpPct: 37 } } });
    assert.equal(result.response.status, 200, "save account A settings");
    result = await request("/api/settings", "GET", cookieB);
    assert.equal(result.data.settings.tpSl.defaultTpPct, 22, "account B settings isolated");
    result = await request("/api/settings", "GET", cookieA);
    assert.equal(result.data.settings.tpSl.defaultTpPct, 37, "account A settings persist");
    result = await request("/api/lp/open", "POST", cookieA, {
      chain: "BASE", symbol: "TEST", address: "private-token-address", amount: 100,
      price: 2, minPrice: 1, maxPrice: 3,
    });
    assert.equal(result.response.status, 200, "account A can create a simulated position");
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

    console.log("Smoke tests passed: Base Mainnet config, SPA assets, auth, private defaults, account isolation, follow, leaderboard, CSRF and logout.");
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
