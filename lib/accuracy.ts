// Accuracy = of the cells the tool FILLED or CHANGED, how many match the
// golden (correct) sheet. Rows are aligned by SKU.

import { NormalizedTable, ProductResult, AccuracyReport } from "./types";
import { findSkuColumn } from "./parseWorkbook";
import { normalizeHeader, SCHEMA_NAME_INDEX, HEADER_SYNONYMS } from "./referenceData";

function valEq(a: any, b: any): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function attrIdForHeader(header: string): string | null {
  const n = normalizeHeader(header);
  return SCHEMA_NAME_INDEX[n] || HEADER_SYNONYMS[n] || null;
}

// Build a SKU -> golden row lookup. Maps by attrId so differing column names
// across the two files still line up.
function indexGoldenByAttr(golden: NormalizedTable) {
  const skuCol = findSkuColumn(golden);
  const bySku: Record<string, Record<string, any>> = {};
  for (const row of golden.rows) {
    const sku = String(row[skuCol!] ?? "").trim();
    if (!sku) continue;
    const byAttr: Record<string, any> = {};
    for (const h of golden.headers) {
      const aid = attrIdForHeader(h);
      if (aid) byAttr[aid] = row[h];
    }
    bySku[sku] = byAttr;
  }
  return bySku;
}

export function evaluateAccuracy(
  golden: NormalizedTable,
  results: ProductResult[]
): AccuracyReport {
  const goldenBySku = indexGoldenByAttr(golden);
  let evaluated = 0;
  let correct = 0;
  let unmatchedRows = 0;
  const perAttribute: Record<string, { correct: number; total: number }> = {};

  for (const product of results) {
    const goldenRow = goldenBySku[String(product.sku).trim()];
    if (!goldenRow) {
      unmatchedRows++;
      continue;
    }
    for (const f of product.fields) {
      // only score cells the tool actually wrote
      if (!f.applied || f.proposedValue == null) continue;
      const truth = goldenRow[f.attrId];
      if (truth === undefined || String(truth).trim() === "") continue; // nothing to compare against
      evaluated++;
      perAttribute[f.attrId] = perAttribute[f.attrId] || { correct: 0, total: 0 };
      perAttribute[f.attrId].total++;
      if (valEq(f.proposedValue, truth)) {
        correct++;
        perAttribute[f.attrId].correct++;
      }
    }
  }

  return {
    evaluated,
    correct,
    accuracy: evaluated ? correct / evaluated : 0,
    perAttribute,
    unmatchedRows,
  };
}
