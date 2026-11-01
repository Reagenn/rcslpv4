#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { INSTANCE_FILE, REPO_DATA_FILE, REPO_ROOT, readInstance, pidAlive, fetchJson, fetchText } from "./lib.mjs";

function fail(msg) {
  console.error("DOCTOR FAIL: " + msg);
  process.exit(1);
}

async function main() {
  const inst = readInstance();
  if (!inst) fail("no instance file at " + INSTANCE_FILE + " — run launch.mjs first");
  if (!pidAlive(inst.pid)) fail("pid " + inst.pid + " is not running");
  const page = await fetchText(inst.origin + "/").catch((e) => fail("GET / failed: " + e.message));
  if (page.status !== 200) fail("GET / status " + page.status);
  if (!page.body.includes("LP Desk") || !page.body.includes("Liquidity operations")) fail("GET / is not LP Desk v4 HTML");
  const st = await fetchJson(inst.origin + "/api/state").catch((e) => fail("GET /api/state failed: " + e.message));
  if (st.status !== 200 || !st.json || !st.json.balances) fail("/api/state not usable");
  if (st.json.totalPortfolioUsdc !== 5000) fail("totalPortfolioUsdc is " + st.json.totalPortfolioUsdc + ", expected 5000");
  const dataFile = inst.dataFile;
  if (!dataFile || !fs.existsSync(path.dirname(dataFile))) fail("instance data dir missing: " + dataFile);
  const resolvedData = path.resolve(dataFile);
  const resolvedRepoData = path.resolve(REPO_DATA_FILE);
  if (resolvedData === resolvedRepoData) fail("instance is using the repo data.json — refusing to drive a shared file");
  const serverSrc = path.join(inst.instanceDir, "backend", "src", "server.js");
  const repoSrc = path.join(REPO_ROOT, "backend", "src", "server.js");
  if (!fs.existsSync(serverSrc)) fail("instance server.js missing");
  const sameBuild = fs.readFileSync(serverSrc).equals(fs.readFileSync(repoSrc));
  if (!sameBuild) fail("instance server.js does not match repo backend/src/server.js");
  console.log(
    JSON.stringify(
      {
        ok: true,
        origin: inst.origin,
        pid: inst.pid,
        dataFile: resolvedData,
        repoDataFile: resolvedRepoData,
        isolated: true,
        totalPortfolioUsdc: st.json.totalPortfolioUsdc,
        openPositions: (st.json.positions || []).filter((p) => p.status === "open").length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => fail(e.message));
