"use strict";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function distributionWeights(distribution) {
  const m = String(distribution || "50/50").split("/");
  const wt = Number(m[0]) || 0;
  const wq = Number(m[1]) || 0;
  const sum = wt + wq;
  if (sum <= 0) return { token: 0.5, quote: 0.5 };
  return { token: wt / sum, quote: wq / sum };
}

// Continuous concentrated-liquidity valuation shared by the desk and backtest.
// L is chosen so the entry token/quote amounts sum to the deposited capital.
function valuePosition(pos, price) {
  const amount = Number(pos.amount) || 0;
  const p0 = Number(pos.entryPrice) || 0;
  const p = Number(price);
  const pa = Number(pos.minPrice) || 0;
  const pb = Number(pos.maxPrice) || 0;
  if (!(amount > 0) || !(p0 > 0) || !(p > 0)) {
    return { value: round2(amount), holdValue: round2(amount), il: 0, model: "none" };
  }
  if (pa > 0 && pb > pa) {
    const sa = Math.sqrt(pa);
    const sb = Math.sqrt(pb);
    const amountsAt = (q) => {
      if (q <= pa) return { x: 1 / sa - 1 / sb, y: 0 };
      if (q >= pb) return { x: 0, y: sb - sa };
      const sq = Math.sqrt(q);
      return { x: 1 / sq - 1 / sb, y: sq - sa };
    };
    const at0 = amountsAt(p0);
    const v0perL = at0.x * p0 + at0.y;
    if (v0perL > 0) {
      const L = amount / v0perL;
      const x0 = at0.x * L;
      const y0 = at0.y * L;
      const at = amountsAt(p);
      const value = at.x * L * p + at.y * L;
      const holdValue = x0 * p + y0;
      return { value: round2(value), holdValue: round2(holdValue), il: round2(value - holdValue), model: "cl" };
    }
  }
  const r = p / p0;
  const w = distributionWeights(pos.distribution);
  const value = amount * Math.pow(r, w.token);
  const holdValue = amount * (w.token * r + w.quote);
  return { value: round2(value), holdValue: round2(holdValue), il: round2(value - holdValue), model: "legacy" };
}

module.exports = { valuePosition };
