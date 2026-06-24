// Builds the canonical output workbook from generated rows:
//   - "Main – Enriched" tab with every row (union of columns)
//   - one tab per L4 with that L4's column set (mandatory + optional)
//   - 5-row schema header block (type / MANDATORY / limit / display name / #ATTR)
//   - two audit columns: _source and _confidence per row (compact summary)

import * as XLSX from "xlsx";
import type { GenRow } from "./generate";
import { MDD } from "./referenceData";
import l4AttrsJson from "@/data/l4_attributes.json";

interface AttrMeta { name: string; mandatory: boolean; concept: string }
const ATTR_META: Record<string, AttrMeta> = (l4AttrsJson as any).attrMeta;
const L4_ATTRS: Record<string, { l4: string; mandatory: string[]; optional: string[] }> = (l4AttrsJson as any).l4Attrs;
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Copy fields are generated and not always in the MDD attr list — include them.
const COPY_KEYS = ["title", "name", "description", "stylenote", "minidescription",
  "metatitle", "metakeyword", "metadescription", "tags", "genericName", "displayproduct"];

function colName(attrId: string): string {
  return ATTR_META[attrId]?.name || attrId;
}
function colType(attrId: string): string {
  return Array.isArray(MDD.lov[attrId]) && MDD.lov[attrId].length ? "ENUM" : "String";
}

function nL4(s: string) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

// Determine the ordered column set for a set of rows of one L4.
function columnsFor(l4: string, rows: GenRow[]): string[] {
  const entry = L4_ATTRS[nL4(l4)];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (a: string) => { if (a && !seen.has(a)) { seen.add(a); ordered.push(a); } };
  // identity-ish copy + mandatory + optional + any extra present
  COPY_KEYS.forEach(add);
  if (entry) { entry.mandatory.forEach(add); entry.optional.forEach(add); }
  for (const r of rows) for (const a of Object.keys(r.fields)) add(a);
  return ordered;
}

function sheetAoa(l4: string, rows: GenRow[]): any[][] {
  const cols = columnsFor(l4, rows);
  const aoa: any[][] = [];
  // header block
  aoa.push(["String", ...cols.map(colType), "String", "String"]);                         // type
  aoa.push(["String", ...cols.map((a) => (ATTR_META[a]?.mandatory ? "MANDATORY" : "NON-MANDATORY")), "NON-MANDATORY", "NON-MANDATORY"]); // mandatory
  aoa.push(["", ...cols.map(() => "500"), "", ""]);                                          // limit
  aoa.push(["Seller Article SKU", ...cols.map(colName), "_source", "_confidence"]);          // display name
  aoa.push(["SKUCODE*", ...cols.map((a) => `#ATTR_${a}_${colName(a)}`), "_source", "_confidence"]); // code
  // data
  for (const r of rows) {
    const srcParts: string[] = [];
    const confParts: string[] = [];
    const vals = cols.map((a) => {
      const f = r.fields[a];
      if (f) {
        srcParts.push(`${a}:${f.source}${f.conflict ? "/" + f.conflict : ""}`);
        confParts.push(`${a}:${Math.round(f.confidence * 100)}%`);
        return f.value;
      }
      return "";
    });
    aoa.push([r.sku, ...vals, srcParts.join("; "), confParts.join("; ")]);
  }
  return aoa;
}

function safeName(name: string, used: Set<string>, fallback: string): string {
  let n = (name || fallback).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || fallback;
  let base = n, k = 2;
  while (used.has(n)) { n = (base.slice(0, 28) + " " + k).slice(0, 31); k++; }
  used.add(n);
  return n;
}

export function canonicalToBlob(rows: GenRow[]): Blob {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  // Main tab: union of all columns (use a synthetic "all" L4 ordering)
  const allCols = Array.from(new Set(rows.flatMap((r) => Object.keys(r.fields))));
  // Build a Main sheet by treating every row with the union column set
  const mainAoa = sheetMain(rows, allCols);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mainAoa), safeName("Main – Enriched", used, "Main"));
  // per-L4
  const byL4 = new Map<string, GenRow[]>();
  for (const r of rows) (byL4.get(r.l4) || byL4.set(r.l4, []).get(r.l4)!).push(r);
  for (const [l4, rs] of byL4) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetAoa(l4, rs)), safeName(l4, used, "L4"));
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: MIME });
}

function sheetMain(rows: GenRow[], cols: string[]): any[][] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (a: string) => { if (a && !seen.has(a)) { seen.add(a); ordered.push(a); } };
  COPY_KEYS.forEach(add); cols.forEach(add);
  const aoa: any[][] = [];
  aoa.push(["String", "String", ...ordered.map(colType), "String", "String"]);
  aoa.push(["String", "String", ...ordered.map((a) => (ATTR_META[a]?.mandatory ? "MANDATORY" : "NON-MANDATORY")), "NON-MANDATORY", "NON-MANDATORY"]);
  aoa.push(["", "", ...ordered.map(() => "500"), "", ""]);
  aoa.push(["Seller Article SKU", "L4 Category", ...ordered.map(colName), "_source", "_confidence"]);
  aoa.push(["SKUCODE*", "_L4_category", ...ordered.map((a) => `#ATTR_${a}_${colName(a)}`), "_source", "_confidence"]);
  for (const r of rows) {
    const srcParts: string[] = []; const confParts: string[] = [];
    const vals = ordered.map((a) => {
      const f = r.fields[a];
      if (f) { srcParts.push(`${a}:${f.source}${f.conflict ? "/" + f.conflict : ""}`); confParts.push(`${a}:${Math.round(f.confidence * 100)}%`); return f.value; }
      return "";
    });
    aoa.push([r.sku, r.l4, ...vals, srcParts.join("; "), confParts.join("; ")]);
  }
  return aoa;
}
