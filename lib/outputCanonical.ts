// Builds the canonical output workbook in the FULL portal schema:
//   - "Main – Enriched" tab (union of all columns)
//   - one tab per L4 with the envelope + that L4's attribute columns
//   - 5-row schema header block (type / MANDATORY / limit / display name / code)
//   - char-limit enforcement on every value
//   - _source and _confidence audit columns at the end
//
// Column order per tab: the fixed 28-column ENVELOPE first, then the L4's
// attributes (mandatory then optional) in MDD order, then audit columns.
// Header names are canonical (envelope constants + MDD ATTRIBUTE_NAME), with
// the internal key as the final fallback.

import * as XLSX from "xlsx";
import type { GenRow } from "./generate";
import { MDD } from "./referenceData";
import { ENVELOPE, ENV_START_DATE, ENV_END_DATE, formatValue, EnvCol } from "./envelope";
import l4AttrsJson from "@/data/l4_attributes.json";

interface AttrMeta { name: string; mandatory: boolean; concept: string; type: string; limit: number }
const ATTR_META: Record<string, AttrMeta> = (l4AttrsJson as any).attrMeta;
const L4_ATTRS: Record<string, { l4: string; mandatory: string[]; optional: string[] }> = (l4AttrsJson as any).l4Attrs;
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const nL4 = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Canonical display name: envelope constant → MDD ATTRIBUTE_NAME → internal key.
function displayName(code: string): string {
  return ATTR_META[code]?.name || code;
}
function attrType(code: string): string {
  return ATTR_META[code]?.type || (Array.isArray(MDD.lov[code]) && MDD.lov[code].length ? "ENUM" : "STRING");
}
function attrLimit(code: string): number {
  return ATTR_META[code]?.limit || (Array.isArray(MDD.lov[code]) && MDD.lov[code].length ? 500 : 255);
}

// Resolve one envelope cell's value for a row.
function envValue(col: EnvCol, r: GenRow): string {
  switch (col.fill) {
    case "const": return col.value || "";
    case "seller": return r.envelope[col.key] || "";
    case "copy": return r.fields[col.from || ""]?.value || "";
    case "image": return r.imageUrls[0] || "";
    case "imgPrio": return r.imageUrls.length ? "1" : "";
    case "gidType": return "MPN";
    case "gidValue": return r.sku;
    case "startDate": return ENV_START_DATE;
    case "endDate": return ENV_END_DATE;
    default: return "";
  }
}

// Ordered attribute codes for an L4 (mandatory then optional, MDD order).
function attrCodesFor(l4: string, rows: GenRow[]): string[] {
  const entry = L4_ATTRS[nL4(l4)];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (a: string) => { if (a && !seen.has(a) && !ENVELOPE_KEYS.has(a)) { seen.add(a); out.push(a); } };
  if (entry) { entry.mandatory.forEach(add); entry.optional.forEach(add); }
  // include any generated/extra attribute present on the rows but not in the matrix
  for (const r of rows) for (const a of Object.keys(r.fields)) add(a);
  return out;
}
// envelope copy keys (title/name/etc.) shouldn't be duplicated as attributes
const ENVELOPE_KEYS = new Set(ENVELOPE.filter((e) => e.fill === "copy").map((e) => e.from!));

function buildSheet(l4: string | null, rows: GenRow[]): any[][] {
  const attrCodes = l4 ? attrCodesFor(l4, rows) : unionAttrCodes(rows);
  const aoa: any[][] = [];

  // header rows: type / mandatory / limit / display name / code
  const typeRow: any[] = []; const mandRow: any[] = []; const limRow: any[] = [];
  const nameRow: any[] = []; const codeRow: any[] = [];
  const pushCol = (type: string, mand: boolean, limit: number, name: string, code: string) => {
    typeRow.push(type); mandRow.push(mand ? "MANDATORY" : "NON-MANDATORY");
    limRow.push(limit || ""); nameRow.push(name); codeRow.push(code);
  };
  if (l4) { typeRow.push("String"); mandRow.push("NON-MANDATORY"); limRow.push(""); nameRow.push("L4 Category"); codeRow.push("_l4"); }
  for (const c of ENVELOPE) pushCol(c.type, c.mandatory, c.limit, c.name, c.key);
  for (const a of attrCodes) pushCol(attrType(a), !!ATTR_META[a]?.mandatory, attrLimit(a), displayName(a), `#ATTR_${a}_${displayName(a)}`);
  // audit
  for (const extra of ["_source", "_confidence"]) { typeRow.push("String"); mandRow.push("NON-MANDATORY"); limRow.push(""); nameRow.push(extra); codeRow.push(extra); }
  aoa.push(typeRow, mandRow, limRow, nameRow, codeRow);

  // data rows
  for (const r of rows) {
    const row: any[] = [];
    if (l4) row.push(r.l4);
    for (const c of ENVELOPE) row.push(formatValue(envValue(c, r), c.type, c.limit));
    const srcParts: string[] = []; const confParts: string[] = [];
    for (const a of attrCodes) {
      const f = r.fields[a];
      if (f) {
        srcParts.push(`${a}:${f.source}${f.conflict ? "/" + f.conflict : ""}`);
        confParts.push(`${a}:${Math.round(f.confidence * 100)}%`);
        row.push(formatValue(f.value, attrType(a), attrLimit(a)));
      } else row.push("");
    }
    row.push(srcParts.join("; "), confParts.join("; "));
    aoa.push(row);
  }
  return aoa;
}

function unionAttrCodes(rows: GenRow[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const r of rows) for (const a of Object.keys(r.fields)) if (!seen.has(a) && !ENVELOPE_KEYS.has(a)) { seen.add(a); out.push(a); }
  return out;
}

function safeName(name: string, used: Set<string>, fallback: string): string {
  let n = (name || fallback).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || fallback;
  const base = n; let k = 2;
  while (used.has(n)) { n = (base.slice(0, 28) + " " + k).slice(0, 31); k++; }
  used.add(n); return n;
}

export function canonicalToBlob(rows: GenRow[]): Blob {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheet(null, rows)), safeName("Main – Enriched", used, "Main"));
  const byL4 = new Map<string, GenRow[]>();
  for (const r of rows) (byL4.get(r.l4) || byL4.set(r.l4, []).get(r.l4)!).push(r);
  for (const [l4, rs] of byL4) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheet(l4, rs)), safeName(l4, used, "L4"));
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: MIME });
}
