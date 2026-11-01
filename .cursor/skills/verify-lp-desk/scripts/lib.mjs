"use strict";
import { spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(SKILL_DIR, "../../..");
export const RUN_DIR = path.join(SKILL_DIR, "run");
export const INSTANCE_FILE = path.join(RUN_DIR, "instance.json");
export const EVIDENCE_DIR = path.join(SKILL_DIR, "evidence");
export const REPO_DATA_FILE = path.join(REPO_ROOT, "backend", "data", "data.json");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readInstance() {
  if (!fs.existsSync(INSTANCE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(INSTANCE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeInstance(obj) {
  ensureDir(RUN_DIR);
  fs.writeFileSync(INSTANCE_FILE, JSON.stringify(obj, null, 2));
}

export function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function fetchText(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout " + url));
    });
    req.on("error", reject);
  });
}

export async function fetchJson(url, timeoutMs = 4000) {
  const r = await fetchText(url, timeoutMs);
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    json = null;
  }
  return { ...r, json };
}

export function waitFor(fn, timeoutMs, intervalMs = 150) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const v = await fn();
        if (v) return resolve(v);
      } catch {
        /* still starting */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout waiting for ready"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

export function copyTree(src, dest) {
  ensureDir(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

export function makeInstanceDir() {
  const dir = path.join(os.tmpdir(), "lp-desk-verify-" + process.pid + "-" + Date.now().toString(36));
  ensureDir(path.join(dir, "backend", "src"));
  ensureDir(path.join(dir, "backend", "data"));
  fs.copyFileSync(path.join(REPO_ROOT, "backend", "src", "server.js"), path.join(dir, "backend", "src", "server.js"));
  copyTree(path.join(REPO_ROOT, "frontend"), path.join(dir, "frontend"));
  return dir;
}

export function stopPid(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
}

export const DEFAULT_BALANCES = { SOL: 1500, BASE: 800, ROBINHOOD: 500, BSC: 700, HYPEREVM: 500, ARC: 500, ETH: 500 };
export const TOTAL_PORTFOLIO_USDC = 5000;
