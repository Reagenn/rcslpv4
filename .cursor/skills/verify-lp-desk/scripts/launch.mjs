#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  INSTANCE_FILE,
  RUN_DIR,
  EVIDENCE_DIR,
  REPO_DATA_FILE,
  ensureDir,
  readInstance,
  writeInstance,
  pidAlive,
  pickPort,
  makeInstanceDir,
  waitFor,
  fetchJson,
  fetchText,
  stopPid,
} from "./lib.mjs";

async function main() {
  ensureDir(RUN_DIR);
  ensureDir(EVIDENCE_DIR);
  const existing = readInstance();
  if (existing && pidAlive(existing.pid)) {
    console.error("Refuse to double-drive. A verification instance is already running.");
    console.error(JSON.stringify(existing, null, 2));
    console.error("This repo's live demo at http://localhost:3000 uses " + REPO_DATA_FILE + " — do not reset that copy.");
    process.exit(2);
  }
  if (existing && existing.pid && !pidAlive(existing.pid)) {
    fs.rmSync(INSTANCE_FILE, { force: true });
    if (existing.instanceDir && fs.existsSync(existing.instanceDir)) {
      try {
        fs.rmSync(existing.instanceDir, { recursive: true, force: true });
      } catch {
        /* leftover tmp */
      }
    }
  }

  const instanceDir = makeInstanceDir();
  const port = await pickPort();
  const logPath = path.join(RUN_DIR, "server.log");
  const logFd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, ["backend/src/server.js"], {
    cwd: instanceDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", logFd, logFd],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  const dataFile = path.join(instanceDir, "backend", "data", "data.json");
  const origin = "http://127.0.0.1:" + port;
  const instance = {
    pid: child.pid,
    port,
    origin,
    instanceDir,
    dataFile,
    repoDataFile: REPO_DATA_FILE,
    logPath,
    startedAt: new Date().toISOString(),
  };
  writeInstance(instance);

  try {
    await waitFor(async () => {
      const page = await fetchText(origin + "/", 1500);
      if (page.status !== 200 || !page.body.includes("Liquidity operations")) return false;
      const st = await fetchJson(origin + "/api/state", 1500);
      return st.status === 200 && st.json && st.json.balances && st.json.balances.SOL;
    }, 15000);
  } catch (e) {
    stopPid(child.pid);
    console.error("Launch failed: " + e.message);
    console.error("See " + logPath);
    process.exit(1);
  }

  const st = await fetchJson(origin + "/api/state");
  const ready = st.json && Array.isArray(st.json.positions);
  if (!ready) {
    stopPid(child.pid);
    console.error("Process answered but /api/state is not usable.");
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, ...instance, ready: true }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
