"use strict";

function migrateLegacyPositionRisk(position) {
  if (!position || position.status !== "open") return position;
  const entryPrice = Number(position.entryPrice) || 0;
  if (!(entryPrice > 0)) return position;
  const migrated = { ...position };
  if (migrated.slPnlPct == null && migrated.sl != null && Number(migrated.sl) > 0) {
    migrated.slPnlPct = Math.round(Math.abs((Number(migrated.sl) / entryPrice - 1) * 100) * 100) / 100;
    migrated.sl = null;
  }
  if (migrated.tpPnlPct == null && migrated.tp != null && Number(migrated.tp) > 0) {
    migrated.tpPnlPct = Math.round(Math.abs((Number(migrated.tp) / entryPrice - 1) * 100) * 100) / 100;
    migrated.tp = null;
  }
  return migrated;
}

function positionExitReason(position, price, positionPnl) {
  const amount = Number(position.amount) || 0;
  const slPnlPct = Math.abs(Number(position.slPnlPct) || 0);
  const tpPnlPct = Math.abs(Number(position.tpPnlPct) || 0);
  const pnl = Number(positionPnl) || 0;
  const currentPrice = Number(price) || 0;
  if (slPnlPct > 0) {
    if (pnl <= -(amount * slPnlPct) / 100) return "SL";
  } else if (position.sl != null && Number(position.sl) > 0 && currentPrice <= Number(position.sl)) {
    return "SL";
  }
  if (tpPnlPct > 0) {
    if (pnl >= (amount * tpPnlPct) / 100) return "TP";
  } else if (position.tp != null && Number(position.tp) > 0 && currentPrice >= Number(position.tp)) {
    return "TP";
  }
  return null;
}

module.exports = { migrateLegacyPositionRisk, positionExitReason };
