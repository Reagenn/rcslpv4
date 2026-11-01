#!/usr/bin/env node
"use strict";
import fs from "fs";
import { INSTANCE_FILE, EVIDENCE_DIR, readInstance, pidAlive, stopPid } from "./lib.mjs";

function main() {
  const inst = readInstance();
  if (!inst) {
    console.log(JSON.stringify({ ok: true, skipped: "no instance" }));
    return;
  }
  if (pidAlive(inst.pid)) stopPid(inst.pid);
  if (inst.instanceDir && fs.existsSync(inst.instanceDir)) {
    fs.rmSync(inst.instanceDir, { recursive: true, force: true });
  }
  fs.rmSync(INSTANCE_FILE, { force: true });
  const evidenceStillThere = fs.existsSync(EVIDENCE_DIR);
  console.log(
    JSON.stringify({
      ok: true,
      killedPid: inst.pid,
      removedInstanceDir: inst.instanceDir,
      evidenceDir: EVIDENCE_DIR,
      evidenceSurvived: evidenceStillThere,
    }),
  );
}

main();
