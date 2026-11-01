#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { EVIDENCE_DIR, ensureDir, readInstance, fetchJson } from "./lib.mjs";

async function main() {
  const label = process.argv[2] || "state";
  const inst = readInstance();
  if (!inst) {
    console.error("no instance");
    process.exit(1);
  }
  const st = await fetchJson(inst.origin + "/api/state");
  ensureDir(EVIDENCE_DIR);
  const dest = path.join(EVIDENCE_DIR, label + ".json");
  fs.writeFileSync(dest, JSON.stringify({ at: new Date().toISOString(), origin: inst.origin, httpStatus: st.status, state: st.json }, null, 2));
  console.log(dest);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
