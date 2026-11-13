#!/usr/bin/env node
// Checks saved report JSON files against content/schema/report.v1.schema.json (the emulator runs save report.json).
//   node tools/smoke/validate-report.mjs <report.json>...
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(REPO, "content/schema/report.v1.schema.json"), "utf8")));
let bad = 0;
for (const f of process.argv.slice(2)) {
  const ok = validate(JSON.parse(readFileSync(f, "utf8")));
  if (!ok) bad++;
  console.log(`${ok ? "valid" : "INVALID"} ${f}${ok ? "" : ` ${JSON.stringify(validate.errors).slice(0, 600)}`}`);
}
process.exit(bad ? 1 : 0);
