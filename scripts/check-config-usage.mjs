// Verifies that every config key read via cfg() is declared in DEFAULTS, so a key cannot be read
// but undocumented (as `surfaceTest` once was).
// Run with: node scripts/check-config-usage.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "extension.mjs"), "utf8");

const start = src.indexOf("const DEFAULTS");
const declared = [...src.slice(start, src.indexOf("};", start)).matchAll(/^ {4}(\w+):/gm)].map(
    (m) => m[1],
);

const used = [...new Set([...src.matchAll(/cfg\("(\w+)"\)/g)].map((m) => m[1]))];

const undeclared = used.filter((k) => !declared.includes(k));
const unused = declared.filter((k) => !used.includes(k));

let failed = false;
if (undeclared.length) {
    failed = true;
    console.error(`MISMATCH  read via cfg() but not in DEFAULTS: ${undeclared.join(", ")}`);
} else {
    console.log("ok        every cfg() key is declared in DEFAULTS");
}

if (unused.length) {
    failed = true;
    console.error(`MISMATCH  declared in DEFAULTS but never read: ${unused.join(", ")}`);
} else {
    console.log("ok        every DEFAULTS key is read somewhere");
}

process.exit(failed ? 1 : 0);
