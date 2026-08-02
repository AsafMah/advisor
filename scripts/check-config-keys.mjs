// Cross-checks that the config key set is identical across DEFAULTS, the example config, and the
// README table. Run with: node scripts/check-config-keys.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

const src = read("extension.mjs");
const start = src.indexOf("const DEFAULTS");
const defaults = [...src.slice(start, src.indexOf("};", start)).matchAll(/^ {4}(\w+):/gm)].map(
    (m) => m[1],
);

const example = Object.keys(JSON.parse(read("advisor.example.json")));

const backtick = String.fromCharCode(96);
// The config table is the only one whose rows are `key` | `default` | meaning, so require a
// second backticked cell to avoid matching the severity table.
const rowPattern = new RegExp(`^\\| ${backtick}(\\w+)${backtick}\\s*\\|[^|]*${backtick}`, "gm");
const documented = [...new Set([...read("README.md").matchAll(rowPattern)].map((m) => m[1]))];

let failed = false;
const compare = (a, b, aName, bName) => {
    const missing = a.filter((k) => !b.includes(k));
    if (missing.length) {
        failed = true;
        console.error(`MISMATCH  in ${aName} but not ${bName}: ${missing.join(", ")}`);
    } else {
        console.log(`ok        every ${aName} key is in ${bName}`);
    }
};

console.log(
    `DEFAULTS: ${defaults.length}  example: ${example.length}  documented: ${documented.length}`,
);
compare(defaults, example, "DEFAULTS", "example");
compare(example, defaults, "example", "DEFAULTS");
compare(defaults, documented, "DEFAULTS", "README");
compare(documented, defaults, "README", "DEFAULTS");

process.exit(failed ? 1 : 0);
