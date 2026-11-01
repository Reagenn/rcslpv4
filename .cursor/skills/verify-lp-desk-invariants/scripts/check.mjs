#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadServerFns, SERVER_JS, sha256File } from "./extract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const COVERAGE = path.join(SKILL_DIR, "coverage.json");

function fail(msg, extra) {
  console.error("FAIL: " + msg);
  if (extra) console.error(extra);
  process.exit(1);
}

function loadCoverage() {
  return JSON.parse(fs.readFileSync(COVERAGE, "utf8"));
}

function main() {
  const cov = loadCoverage();
  const { api, parts, sha256 } = loadServerFns();
  if (sha256 !== cov.serverJsSha256) {
    fail(
      "backend/src/server.js hash is " +
        sha256 +
        " but coverage.json last confirmed " +
        cov.serverJsSha256 +
        ". Re-read valuePosition / openPositionInternal / closePositionInternal / evaluateTpSlOnFreshPrices against the new file, update the model if the code still matches the properties, then move serverJsSha256 only after that confirmation.",
    );
  }
  for (const p of parts) {
    const rec = cov.functions[p.name];
    if (!rec) fail("extracted " + p.name + " but coverage.json has no entry");
    if (rec.line !== p.line) {
      fail(p.name + " moved to line " + p.line + " (coverage.json has " + rec.line + "). Update coverage after confirming the property still describes the function.");
    }
  }

  const { valuePosition, defaultState, openPositionInternal, closePositionInternal, evaluateTpSlOnFreshPrices, setState, getState, round2 } = api;

  let ilChecked = 0;
  const prices = [0.0001, 0.01, 0.5, 1, 10, 100, 1234.56];
  const amounts = [1, 50, 100, 250, 1500];
  for (const amount of amounts) {
    for (const p0 of prices) {
      for (const span of [0.02, 0.1, 0.5, 2]) {
        const pa = p0 * (1 - span);
        const pb = p0 * (1 + span);
        if (!(pa > 0 && pb > pa)) continue;
        const pos = { amount, entryPrice: p0, minPrice: pa, maxPrice: pb, distribution: "50/50" };
        const samples = [pa / 2, pa, pa * 1.001, p0, pb * 0.999, pb, pb * 1.5, p0 * 0.01, p0 * 50];
        for (const p of samples) {
          if (!(p > 0)) continue;
          const r = valuePosition(pos, p);
          ilChecked++;
          if (!(r.value >= 0) || !(r.holdValue >= 0)) fail("negative value", { pos, p, r });
          if (r.model === "cl" && r.il > 0.02) {
            fail("impermanent loss became positive (user would see IL as a gain vs holding)", { amount, p0, pa, pb, p, r });
          }
        }
      }
      const posLegacy = { amount, entryPrice: p0, minPrice: 0, maxPrice: 0, distribution: "50/50" };
      for (const p of [p0 * 0.5, p0, p0 * 2]) {
        const r = valuePosition(posLegacy, p);
        ilChecked++;
        if (r.model === "legacy" && r.il > 0.02) fail("legacy IL positive", { posLegacy, p, r });
      }
    }
  }

  setState(defaultState());
  const opened = openPositionInternal({
    chain: "SOL",
    address: "verify",
    symbol: "VT",
    name: "Verify Token",
    amount: 100,
    price: 10,
    minPrice: 8,
    maxPrice: 12,
  });
  if (opened.error) fail("open seed failed: " + opened.error);
  const afterOpen = getState();
  if (afterOpen.balances.SOL.usdc !== 1400) fail("open did not deduct 100 USDC from SOL", afterOpen.balances.SOL);
  const pos = afterOpen.positions[0];
  pos.currentPrice = 10;
  const closed = closePositionInternal(pos, "close");
  if (closed.error) fail("close failed: " + closed.error);
  const afterClose = getState();
  const sumUsdc = Object.values(afterClose.balances).reduce((s, b) => s + Number(b.usdc), 0);
  if (Math.abs(sumUsdc - 5000) > 0.05) fail("USDC not conserved after open/close at unchanged price", { sumUsdc, settled: closed.settledValue });

  setState(defaultState());
  const o2 = openPositionInternal({
    chain: "SOL",
    address: "verify",
    symbol: "VT",
    amount: 200,
    price: 10,
    minPrice: 8,
    maxPrice: 12,
    sl: 9,
    tp: 11,
  });
  if (o2.error) fail("tp/sl open failed: " + o2.error);
  const pHitSl = getState().positions[0];
  pHitSl.currentPrice = 8.5;
  pHitSl.sl = 9;
  pHitSl.tp = 7;
  const slWins = evaluateTpSlOnFreshPrices([pHitSl]);
  if (slWins.length !== 1 || slWins[0].reason !== "SL") {
    fail("when price is at or below SL, close reason must be SL even if TP is also numerically satisfied", slWins);
  }

  setState(defaultState());
  const o3 = openPositionInternal({
    chain: "SOL",
    address: "verify",
    symbol: "VT",
    amount: 200,
    price: 10,
    minPrice: 8,
    maxPrice: 12,
    sl: 9,
    tp: 11,
  });
  if (o3.error) fail(o3.error);
  const pHitTp = getState().positions[0];
  pHitTp.currentPrice = 12;
  const tpHits = evaluateTpSlOnFreshPrices([pHitTp]);
  if (tpHits.length !== 1 || tpHits[0].reason !== "TP") fail("price above TP should close with TP", tpHits);

  setState(defaultState());
  const o4 = openPositionInternal({
    chain: "SOL",
    address: "verify",
    symbol: "VT",
    amount: 200,
    price: 10,
    minPrice: 8,
    maxPrice: 12,
  });
  const old = o4.pos;
  old.currentPrice = 10;
  const closedRb = closePositionInternal(old, "rebalance");
  const replacement = openPositionInternal({
    chain: "SOL",
    address: "verify",
    symbol: "VT",
    amount: closedRb.settledValue,
    price: 10,
    minPrice: 9,
    maxPrice: 11,
    skipBalanceCheck: true,
    replaces: old.id,
  });
  if (replacement.error) fail("rebalance replacement rejected: " + replacement.error);
  old.replacedBy = replacement.pos.id;
  const st = getState();
  if (Math.abs(st.balances.SOL.usdc - 1300) > 0.05) fail("rebalance must not take extra USDC beyond the original open", st.balances.SOL);
  if (replacement.pos.amount !== closedRb.settledValue) fail("replacement not funded from settledValue");

  console.log(
    JSON.stringify(
      {
        ok: true,
        serverJs: SERVER_JS,
        serverJsSha256: sha256,
        ilSamples: ilChecked,
        properties: [
          "CL IL is never a gain versus holding (il <= 0 within rounding)",
          "open deducts amount; close at unchanged price restores 5000 USDC",
          "SL wins when both SL and TP could apply",
          "rebalance replacement amount is settledValue and does not extra-debit the chain",
        ],
      },
      null,
      2,
    ),
  );
}

main();
