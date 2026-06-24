// Adapts canonical generator output to the existing ReviewCards UI, and scores
// accuracy when the user uploads a corrected sheet in the same canonical schema.

import type { GenRow } from "./generate";
import type { ProductResult, FieldResult, NormalizedTable } from "./types";
import { normalizeValue } from "./referenceData";
import { findSkuColumn } from "./parseWorkbook";

const sourceReason: Record<string, string> = {
  image: "from image",
  inferred: "inferred from text",
  default: "default value",
  generated: "generated copy",
  seller: "seller value",
  normalized: "normalized",
  consensus: "group consensus (siblings)",
};

export function genRowsToResults(rows: GenRow[]): ProductResult[] {
  return rows.map((r, i) => {
    const fields: FieldResult[] = Object.values(r.fields).map((f) => ({
      column: f.name,
      attrId: f.attrId,
      proposedValue: f.value,
      confidence: Math.round(f.confidence * 100),
      reasoning: sourceReason[f.source] || f.source,
      applied: f.conflict !== "flagged",
      status: f.conflict === "changed" ? "conflict" : f.conflict === "flagged" ? "conflict" : "missing",
      previousValue: f.previousValue ?? "",
    }));
    // metadata for the card header (title/description from generated copy)
    const metadata: Record<string, string> = {};
    if (r.fields["title"]) metadata["Product Title"] = r.fields["title"].value;
    if (r.fields["description"]) metadata["Description"] = r.fields["description"].value;
    return {
      rowNumber: i + 1,
      sku: r.sku,
      l4: r.l4,
      imageUrls: r.imageUrls,
      fields,
      metadata,
    };
  });
}

export interface CanonicalAccuracy {
  evaluated: number;
  correct: number;
  accuracy: number;
  byAttr: Record<string, { correct: number; total: number }>;
}

// Compare generated values against a corrected ("golden") sheet in the same
// canonical schema, matched by SKU + attribute code.
export function evaluateCanonical(golden: NormalizedTable, rows: GenRow[]): CanonicalAccuracy {
  const skuCol = findSkuColumn(golden);
  // index golden rows by SKU → { attrId: value }
  const bySku = new Map<string, Record<string, string>>();
  for (const gr of golden.rows) {
    const sku = skuCol ? String(gr[skuCol] ?? "").trim() : "";
    if (!sku) continue;
    const m: Record<string, string> = {};
    for (const h of golden.headers) {
      const aid = golden.columnMap[h];
      if (aid) {
        const v = String(gr[h] ?? "").trim();
        if (v) m[aid] = v;
      }
    }
    bySku.set(sku, m);
  }

  let evaluated = 0, correct = 0;
  const byAttr: Record<string, { correct: number; total: number }> = {};
  for (const r of rows) {
    const g = bySku.get(r.sku);
    if (!g) continue;
    for (const [attrId, f] of Object.entries(r.fields)) {
      const goldenVal = g[attrId];
      if (goldenVal == null || goldenVal === "") continue; // only score where golden has a value
      evaluated++;
      const ok = normalizeValue(f.value) === normalizeValue(goldenVal);
      if (ok) correct++;
      (byAttr[attrId] ||= { correct: 0, total: 0 });
      byAttr[attrId].total++;
      if (ok) byAttr[attrId].correct++;
    }
  }
  return { evaluated, correct, accuracy: evaluated ? correct / evaluated : 0, byAttr };
}
