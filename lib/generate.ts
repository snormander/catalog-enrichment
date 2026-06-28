// ─────────────────────────────────────────────────────────────────────────────
// Canonical "100% fill" generator.
//
// Given a parsed seller sheet, produces an MDD-canonical output: every product
// classified to an L4, every mandatory attribute for that L4 filled through a
// cascade (seller → vision → text inference → default → generated copy), with a
// source + confidence tag on each value. One Gemini call PER STYLE CODE (sizes
// of one garment share image/metadata); results fan to every size row.
//
// Column matching is concept-based: exact #ATTR code first, then fuzzy display
// name (gender/spelling/punctuation-proof — "fittopwearmen" and "womentopwearfit"
// both resolve to concept "fit").
// ─────────────────────────────────────────────────────────────────────────────

import type { NormalizedTable } from "./types";
import { MDD, normalizeValue, normalizeHeader } from "./referenceData";
import { findImageColumns, findSkuColumn } from "./parseWorkbook";
import l4AttrsJson from "@/data/l4_attributes.json";
import { buildCopy } from "./copyTemplates";
import { DEFAULTS, defaultFor } from "./defaults";
import { ENVELOPE } from "./envelope";

interface AttrMeta { name: string; mandatory: boolean; concept: string }
interface L4Entry { l4: string; mandatory: string[]; optional: string[] }
const ATTR_META: Record<string, AttrMeta> = (l4AttrsJson as any).attrMeta;
const L4_ATTRS: Record<string, L4Entry> = (l4AttrsJson as any).l4Attrs;

export type FieldSource = "seller" | "normalized" | "image" | "inferred" | "default" | "generated" | "consensus";

export interface GenField {
  attrId: string;
  name: string;
  value: string;
  confidence: number;
  source: FieldSource;
  mandatory: boolean;
  /** set when an existing seller value conflicted with vision */
  conflict?: "changed" | "flagged";
  previousValue?: string;
}

export interface GenRow {
  sku: string;
  styleCode: string;
  l4: string;
  fields: Record<string, GenField>;
  imageUrls: string[];
  envelope: Record<string, string>;  // seller-sourced envelope values (hsn, weight, dims…)
}

export interface GenReport {
  totalRows: number;
  uniqueStyleCodes: number;
  apiCalls: number;
  // missing-fill breakdown: source × mandatory/optional
  filledDefaultMandatory: number;
  filledDefaultOptional: number;
  filledInferredMandatory: number;
  filledInferredOptional: number;
  filledImageMandatory: number;
  filledImageOptional: number;
  filledGeneratedMandatory: number;
  // conflicts
  conflictsChanged: number;
  conflictsFlagged: number;
  byL4: Record<string, number>;
}

// Space-form concept key — MUST match how concepts and L4 keys were generated
// in l4_attributes.json (lowercase, "(Refer LOV List)" dropped, every run of
// non-alphanumerics collapsed to a single space). normalizeHeader strips spaces
// entirely, which would break multi-word concept/L4 matching, so we don't use it here.
const nname = (s: string) =>
  String(s || "")
    .toLowerCase()
    .replace(/\(refer lov list\)/ig, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Build a concept → seller column index for one table (display name + code).
function sellerConceptIndex(table: NormalizedTable) {
  const byCode: Record<string, string> = {};
  const byConcept: Record<string, string> = {};
  // the display-name row is headerRowIndex; headers already hold names
  for (const h of table.headers) {
    const code = table.columnMap[h];
    if (code) byCode[code.toLowerCase()] = h;
    const concept = nname(h.replace(/\(refer lov list\)/ig, "").replace(/\*/g, ""));
    if (concept && !(concept in byConcept)) byConcept[concept] = h;
  }
  return { byCode, byConcept };
}

// Resolve the seller column that holds a given MDD attribute, by concept.
function resolveSellerCol(
  attrId: string,
  idx: { byCode: Record<string, string>; byConcept: Record<string, string> }
): string | undefined {
  // 1. exact #ATTR code
  const exact = idx.byCode[attrId.toLowerCase()];
  if (exact) return exact;
  // 2. fuzzy concept (display name) match
  const concept = ATTR_META[attrId]?.concept;
  if (concept && idx.byConcept[concept]) return idx.byConcept[concept];
  return undefined;
}

// LOV-constrained? (has enumerated values)
const hasLov = (attrId: string) => Array.isArray(MDD.lov[attrId]) && MDD.lov[attrId].length > 0;

// Normalize a raw seller value to a valid LOV value (case/space/punct-insensitive).
function toLov(attrId: string, raw: string): { value: string; ok: boolean } {
  const allowed = MDD.lov[attrId];
  if (!allowed || !allowed.length) return { value: raw, ok: !!raw }; // free text
  const n = normalizeValue(raw);
  for (const a of allowed) if (normalizeValue(a) === n) return { value: a, ok: true };
  return { value: raw, ok: false };
}

const VISUAL_CONCEPTS = ["sleeve", "fit", "neck collar", "neck", "collar", "color family", "pattern", "dress length", "dress shape", "skirt length", "shape", "length", "rise", "waist rise"];
const isVisualConcept = (c: string) => VISUAL_CONCEPTS.some((v) => c.includes(v));

// Group row indices by style code (fallback: sku prefix → shared image → solo).
export function groupByStyle(table: NormalizedTable): Map<string, number[]> {
  const styleCol = table.headers.find((h) => table.columnMap[h] === "stylecode");
  const skuCol = findSkuColumn(table);
  const imgCols = findImageColumns(table);
  const groups = new Map<string, number[]>();
  table.rows.forEach((r, i) => {
    let key = styleCol ? String(r[styleCol] ?? "").trim() : "";
    if (!key && skuCol) {
      const sku = String(r[skuCol] ?? "").trim();
      key = sku.length >= 14 && /\d{2}$/.test(sku) ? sku.slice(0, -2) : "";
    }
    if (!key && imgCols.length) key = "img:" + String(r[imgCols[0]] ?? "").trim();
    if (!key && skuCol) key = "solo:" + String(r[skuCol] ?? "").trim() + ":" + i;
    if (!key) key = "row:" + i;
    (groups.get(key) || groups.set(key, []).get(key)!).push(i);
  });
  return groups;
}

// Concatenate row metadata (mandatory OR long text), excluding image/tool cols.
function contextBlob(table: NormalizedTable, row: Record<string, any>, imgSet: Set<string>): Record<string, string> {
  const m: Record<string, string> = {};
  let total = 0;
  for (const h of table.headers) {
    if (imgSet.has(h) || h.startsWith("_")) continue;
    const v = String(row[h] ?? "").trim();
    if (!v) continue;
    if (table.mandatoryMap[h] || v.length > 40) {
      m[h] = v.slice(0, 400);
      total += m[h].length;
      if (total > 4000) break;
    }
  }
  return m;
}

export interface GenOptions {
  conflictThreshold: number;     // overwrite seller value above this (0-100)
  defaults?: Partial<typeof DEFAULTS>;
  // vision attrs keyed by style key: { conceptName: {value, confidence} }
  visionByStyle?: Map<string, { l4?: string; attrs: Record<string, { value: string; confidence: number }> }>;
}

// L4 display list for the model to classify into.
const L4_DISPLAY_LIST = Object.values(L4_ATTRS).map((e) => e.l4);

// The visual concepts we ask the model to determine per style code.
const VISION_CONCEPTS_FROM = ["color family", "pattern", "sleeve", "fit", "neck collar", "dress length", "dress shape", "waist rise"];

export interface RunCanonicalOptions extends GenOptions {
  model: string;
  maxImages?: number;
  requestsPerMinute?: number;
  onProgress?: (done: number, total: number) => void;
}

// Orchestrates the full canonical fill: one /api/enrich call PER STYLE CODE,
// fans results to all sizes, then runs generateRows. Returns rows + report +
// token usage. Designed to run in the browser (calls the same API route).
export async function runCanonical(table: NormalizedTable, opts: RunCanonicalOptions): Promise<{ rows: GenRow[]; report: GenReport; usage: { inputTokens: number; outputTokens: number } }> {
  const idx = sellerConceptIndex(table);
  const imgCols = findImageColumns(table);
  const imgSet = new Set(imgCols);
  const groups = groupByStyle(table);
  const visionByStyle = new Map<string, { l4?: string; attrs: Record<string, { value: string; confidence: number }> }>();
  let inputTokens = 0, outputTokens = 0, done = 0;

  const interval = opts.requestsPerMinute && opts.requestsPerMinute > 0 ? 60000 / opts.requestsPerMinute : 0;
  let last = 0;
  const pace = async () => { if (!interval) return; const wait = last + interval - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now(); };

  const styleKeys = [...groups.keys()];
  for (const styleKey of styleKeys) {
    const lead = table.rows[groups.get(styleKey)![0]];
    const imageUrls = imgCols.map((c) => String(lead[c] ?? "").trim())
      .map((u) => (u.startsWith("//") ? "https:" + u : u))
      .filter((u) => /^https?:\/\//.test(u))
      .slice(0, opts.maxImages || 3);

    if (imageUrls.length) {
      // Ask the model for the visual concepts + L4. We send concept "columns".
      const fields = VISION_CONCEPTS_FROM.map((concept) => {
        // find an applicable attr id of this concept to source allowed values
        const attrId = Object.keys(ATTR_META).find((a) => ATTR_META[a].concept === concept);
        return {
          column: concept, attrId: concept, label: concept,
          status: "missing", currentValue: "",
          allowedValues: attrId && MDD.lov[attrId] ? MDD.lov[attrId] : [],
        };
      });
      const metadata = contextBlob(table, lead, imgSet);
      try {
        await pace();
        const resp = await fetch("/api/enrich", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: opts.model, imageUrls, sku: styleKey, fields, metadata, l4List: L4_DISPLAY_LIST }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const attrs: Record<string, { value: string; confidence: number }> = {};
          for (const r of data.results || []) {
            if (r.proposedValue) attrs[r.attrId] = { value: r.proposedValue, confidence: (r.confidence ?? 50) / 100 };
          }
          visionByStyle.set(styleKey, { l4: data.l4, attrs });
          inputTokens += data.usage?.inputTokens || 0;
          outputTokens += data.usage?.outputTokens || 0;
        }
      } catch { /* leave this style without vision; cascade still fills */ }
    }
    done++;
    opts.onProgress?.(done, styleKeys.length);
  }

  const { rows, report } = generateRows(table, { ...opts, visionByStyle });
  report.apiCalls = visionByStyle.size;
  return { rows, report, usage: { inputTokens, outputTokens } };
}

// Text keyword inference (very conservative) — reused for fallback fills.
import { inferFromText } from "./copyTemplates";

export function generateRows(table: NormalizedTable, opts: GenOptions): { rows: GenRow[]; report: GenReport } {
  const idx = sellerConceptIndex(table);
  const skuCol = findSkuColumn(table);
  const imgCols = findImageColumns(table);
  const imgSet = new Set(imgCols);
  const groups = groupByStyle(table);
  const D = { ...DEFAULTS, ...(opts.defaults || {}) };

  const report: GenReport = {
    totalRows: table.rows.length, uniqueStyleCodes: groups.size, apiCalls: 0,
    filledDefaultMandatory: 0, filledDefaultOptional: 0,
    filledInferredMandatory: 0, filledInferredOptional: 0,
    filledImageMandatory: 0, filledImageOptional: 0,
    filledGeneratedMandatory: 0, conflictsChanged: 0, conflictsFlagged: 0, byL4: {},
  };

  const out: GenRow[] = new Array(table.rows.length);

  for (const [styleKey, idxs] of groups) {
    const vision = opts.visionByStyle?.get(styleKey);
    if (vision) report.apiCalls++; // one call per style (recorded by caller)

    // Determine L4 for the group (vision → keyword from lead metadata).
    const leadRow = table.rows[idxs[0]];
    const leadBlob = Object.values(contextBlob(table, leadRow, imgSet)).join(" ");
    let l4 = vision?.l4 || inferFromText.l4(leadBlob);
    const l4key = nname(l4);
    let entry = L4_ATTRS[l4key];
    if (!entry) { // unknown L4 → use a tops-and-tees-like minimal set fallback
      entry = L4_ATTRS["tops and tees"] || Object.values(L4_ATTRS)[0];
      l4 = entry.l4;
    }
    report.byL4[entry.l4] = (report.byL4[entry.l4] || 0) + idxs.length;

    for (const ri of idxs) {
      const row = table.rows[ri];
      const blob = Object.values(contextBlob(table, row, imgSet)).join(" ");
      const fields: Record<string, GenField> = {};

      const allAttrs = [
        ...entry.mandatory.map((a) => ({ a, mand: true })),
        ...entry.optional.map((a) => ({ a, mand: false })),
      ];

      for (const { a, mand } of allAttrs) {
        const meta = ATTR_META[a];
        const concept = meta?.concept || a;
        const sellerCol = resolveSellerCol(a, idx);
        const sellerRaw = sellerCol ? String(row[sellerCol] ?? "").trim() : "";
        const vAttr = vision?.attrs[concept];

        let value = "", source: FieldSource = "default", conf = 0, conflict: GenField["conflict"], prev: string | undefined;

        // 1) seller value (normalized to LOV when applicable)
        if (sellerRaw) {
          const lov = toLov(a, sellerRaw);
          value = lov.value;
          source = lov.ok && hasLov(a) ? "normalized" : "seller";
          conf = lov.ok || !hasLov(a) ? 0.95 : 0.4;
        }

        // 2) vision (visual concepts) — fill if blank, or override on conflict
        if (vAttr && vAttr.value && isVisualConcept(concept)) {
          const vConfPct = vAttr.confidence * 100;
          if (!value) {
            value = vAttr.value; source = "image"; conf = vAttr.confidence;
            if (mand) report.filledImageMandatory++; else report.filledImageOptional++;
          } else if (normalizeValue(value) !== normalizeValue(vAttr.value)) {
            // conflict
            if (vConfPct >= opts.conflictThreshold) {
              prev = value; value = vAttr.value; source = "image"; conf = vAttr.confidence;
              conflict = "changed"; report.conflictsChanged++;
            } else {
              conflict = "flagged"; prev = vAttr.value; report.conflictsFlagged++;
            }
          }
        }

        // 3) text inference (visual concepts still blank)
        if (!value && isVisualConcept(concept)) {
          const inf = inferFromText.attr(concept, blob, a);
          if (inf) {
            value = inf; source = "inferred"; conf = 0.55;
            if (mand) report.filledInferredMandatory++; else report.filledInferredOptional++;
          }
        }

        // 4) default (admin / non-visual / still blank) — mandatory only
        if (!value && mand) {
          const d = defaultFor(a, concept, blob, D);
          if (d) {
            value = d; source = "default"; conf = 0.5;
            if (mand) report.filledDefaultMandatory++; else report.filledDefaultOptional++;
          }
        }

        if (value) fields[a] = { attrId: a, name: meta?.name || a, value, confidence: conf, source, mandatory: mand, conflict, previousValue: prev };
      }

      // 5) generated copy (title/description/meta/tags) — always
      const copy = buildCopy(fields, entry.l4, contextBlob(table, row, imgSet));
      for (const [k, v] of Object.entries(copy)) {
        if (!fields[k] || !fields[k].value) {
          fields[k] = { attrId: k, name: v.name, value: v.value, confidence: 0.85, source: "generated", mandatory: !!v.mandatory };
          if (v.mandatory) report.filledGeneratedMandatory++;
        }
      }

      // capture seller-sourced envelope values (hsn, weight, dimensions, …)
      const envelope: Record<string, string> = {};
      for (const col of ENVELOPE) {
        if (col.fill === "seller" && col.from) {
          const sc = idx.byConcept[col.from] || idx.byCode[col.from];
          if (sc) envelope[col.key] = String(row[sc] ?? "").trim();
        }
      }

      out[ri] = {
        sku: skuCol ? String(row[skuCol] ?? "").trim() : "",
        styleCode: styleKey,
        l4: entry.l4,
        fields,
        imageUrls: imgCols.map((c) => String(row[c] ?? "").trim()).filter((u) => /^https?:\/\//.test(u)),
        envelope,
      };
    }
  }

  // Style-code consensus for constant (non-size) fields: fill blanks + correct outliers.
  for (const [, idxs] of groups) {
    if (idxs.length < 2) continue;
    const attrs = new Set<string>();
    idxs.forEach((ri) => out[ri] && Object.keys(out[ri].fields).forEach((a) => attrs.add(a)));
    for (const a of attrs) {
      if (ATTR_META[a]?.concept?.includes("size")) continue;
      const counts = new Map<string, number>();
      idxs.forEach((ri) => {
        const f = out[ri]?.fields[a];
        if (f?.value) counts.set(f.value, (counts.get(f.value) || 0) + 1);
      });
      if (!counts.size) continue;
      const top = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
      idxs.forEach((ri) => {
        const r = out[ri]; if (!r) return;
        const f = r.fields[a];
        if (!f || !f.value) {
          r.fields[a] = { attrId: a, name: ATTR_META[a]?.name || a, value: top, confidence: 0.8, source: "consensus", mandatory: !!ATTR_META[a]?.mandatory };
        }
      });
    }
  }

  return { rows: out.filter(Boolean), report };
}
