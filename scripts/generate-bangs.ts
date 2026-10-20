// Regenerates src/bangs.json from data/bangs.ts.
// Run with: bun run generate:bangs (after editing data/bangs.ts)
//
// Output is a compact trigger -> url-template map, so the app can do an O(1)
// lookup instead of scanning 13k+ objects. The value is normally just the url
// template; when the bang's landing domain (`d`) differs from the template's
// origin, the value is a [template, domain] pair so bare-bang queries like
// "!gh" still land on the same page as before.
import { writeFileSync } from "node:fs";

import { bangs } from "../data/bangs";

const map: Record<string, string | [string, string]> = {};
let duplicates = 0;
let domainMismatches = 0;

for (const bang of bangs) {
  const trigger = bang.t.toLowerCase();
  // First occurrence wins, matching the old Array.find() semantics
  // (custom overrides live at the top of data/bangs.ts).
  if (trigger in map) {
    duplicates++;
    continue;
  }

  let origin: string | null = null;
  try {
    origin = new URL(bang.u).origin;
  } catch {
    origin = null;
  }

  if (origin === `https://${bang.d}`) {
    map[trigger] = bang.u;
  } else {
    map[trigger] = [bang.u, bang.d];
    domainMismatches++;
  }
}

const outPath = new URL("../src/bangs.json", import.meta.url);
writeFileSync(outPath, JSON.stringify(map));

const count = Object.keys(map).length;
console.log(
  `Wrote ${count} bangs (${duplicates} duplicate triggers skipped, ${domainMismatches} with distinct landing domains).`,
);
