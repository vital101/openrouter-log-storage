// Enforces the >=90% statement-coverage gate that bun 1.4.4 accepts in
// bunfig.toml but never actually enforces. Reads the lcov report written by
// `bun test --coverage` (coverage/lcov.info) and exits non-zero if the overall
// line-hit ratio is below the threshold.
//
// Usage: node scripts/check-coverage.mjs [minPercent]
import { readFileSync } from "node:fs";

const THRESHOLD = Number(process.argv[2] ?? process.env.COVERAGE_MIN ?? 90);
const LCOV_PATH = "coverage/lcov.info";

let lcov;
try {
  lcov = readFileSync(LCOV_PATH, "utf8");
} catch {
  console.error(`check-coverage: ${LCOV_PATH} not found - run \`bun test --coverage\` first`);
  process.exit(1);
}

let hit = 0;
let found = 0;
const perFile = [];

for (const record of lcov.split("end_of_record")) {
  const sf = record.match(/^SF:(.+)$/m)?.[1];
  if (!sf) continue;
  const lh = Number(record.match(/^LH:(\d+)$/m)?.[1] ?? 0);
  const lf = Number(record.match(/^LF:(\d+)$/m)?.[1] ?? 0);
  hit += lh;
  found += lf;
  perFile.push({ file: sf, pct: lf === 0 ? 100 : (100 * lh) / lf });
}

if (found === 0) {
  console.error("check-coverage: no coverage records found");
  process.exit(1);
}

const pct = (100 * hit) / found;
const failedFiles = perFile.filter((f) => f.pct < THRESHOLD);

console.log(
  `check-coverage: ${pct.toFixed(2)}% of ${found} lines covered (gate: ${THRESHOLD}%)`,
);

if (pct < THRESHOLD) {
  console.error(`check-coverage: FAILED - overall coverage below ${THRESHOLD}%`);
  if (failedFiles.length > 0) {
    console.error("  files under the gate:");
    for (const f of failedFiles.sort((a, b) => a.pct - b.pct)) {
      console.error(`    ${f.pct.toFixed(1).padStart(5)}%  ${f.file}`);
    }
  }
  process.exit(1);
}

console.log("check-coverage: passed");
