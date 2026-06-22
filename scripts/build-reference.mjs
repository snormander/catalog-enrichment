// Regenerates the three reference JSON files from latest_lov.csv at the repo root.
// Run with:  node scripts/build-reference.mjs   (or: npm run build:reference)
//
// CSV columns expected (same order as the LOV export):
//   CATEGORY_CODE, CATEGORY_NAME, ATTRIBUTE_CODE, ATTRIBUTE_NAME,
//   ATTRIBUTE_TYPE, LOV_CODE, LOV_NAME, CATEGORY_CATALOG_ID
//
// Outputs (consumed by the app at runtime):
//   data/mdd_lov.json           { attributeNames, lov }
//   data/hierarchy.json         { l4List, hierarchy }
//   data/attr_applicability.json { <normalized category>: [attrCode, ...] }

import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CSV = path.join(ROOT, "latest_lov.csv");
const OUT = path.join(ROOT, "data");

if (!fs.existsSync(CSV)) {
  console.error("latest_lov.csv not found at repo root:", CSV);
  process.exit(1);
}

// Minimal CSV parser that handles quoted fields and embedded commas/newlines.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const ncat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const text = fs.readFileSync(CSV, "utf8");
const rows = parseCSV(text);
rows.shift(); // header

const lov = {}, names = {}, applic = {}, cats = new Set();
for (const r of rows) {
  if (!r || r.length < 7) continue;
  const [catCode, catName, code, aName, , , lovName] = r.map((x) => (x ?? "").trim());
  if (!code) continue;
  if (aName) names[code] = aName;
  if (catName && !ncat(catName).startsWith("others")) {
    cats.add(catName);
    (applic[ncat(catName)] ||= new Set()).add(code);
  }
  if (lovName) (lov[code] ||= new Set()).add(lovName);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "mdd_lov.json"), JSON.stringify({
  attributeNames: names,
  lov: Object.fromEntries(Object.entries(lov).map(([k, v]) => [k, [...v].sort()])),
}));
const l4List = [...cats].sort();
fs.writeFileSync(path.join(OUT, "hierarchy.json"), JSON.stringify({
  l4List, hierarchy: l4List.map((l4) => ({ l4 })),
}));
fs.writeFileSync(path.join(OUT, "attr_applicability.json"), JSON.stringify(
  Object.fromEntries(Object.entries(applic).map(([k, v]) => [k, [...v].sort()]))
));

console.log(`Reference rebuilt: ${Object.keys(lov).length} attributes, ${l4List.length} categories.`);
