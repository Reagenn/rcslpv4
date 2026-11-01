"use strict";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const SERVER_JS = path.join(REPO_ROOT, "backend", "src", "server.js");

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function extractFn(src, name) {
  const needle = "function " + name + "(";
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("function " + name + " not found in server.js");
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const text = src.slice(start, i + 1);
        const line = src.slice(0, start).split("\n").length;
        return { name, text, line, endLine: line + text.split("\n").length - 1 };
      }
    }
  }
  throw new Error("unclosed function " + name);
}

export const NEEDED = [
  "round2",
  "roundPrice",
  "todayISO",
  "uid",
  "defaultSettings",
  "defaultState",
  "distributionWeights",
  "valuePosition",
  "openPositionInternal",
  "closePositionInternal",
  "evaluateTpSlOnFreshPrices",
];

export function loadServerFns() {
  const src = fs.readFileSync(SERVER_JS, "utf8");
  const parts = NEEDED.map((n) => extractFn(src, n));
  const blob =
    '"use strict";\n' +
    "const CHAINS = [\"SOL\", \"BASE\", \"ROBINHOOD\", \"BSC\", \"HYPEREVM\", \"ARC\", \"ETH\"];\n" +
    "const TOTAL_PORTFOLIO_USDC = 5000;\n" +
    "let state;\n" +
    "function logAgent() {}\n" +
    "function saveState() {}\n" +
    parts.map((p) => p.text).join("\n") +
    "\nreturn { round2, roundPrice, defaultState, valuePosition, openPositionInternal, closePositionInternal, evaluateTpSlOnFreshPrices, getState: () => state, setState: (s) => { state = s; } };\n";
  const factory = new Function(blob);
  const api = factory();
  return {
    api,
    parts,
    sha256: sha256File(SERVER_JS),
    srcLen: src.length,
  };
}
