// Orchestrates enrichment on the client: classify issues per row, call the
// /api/enrich serverless route (one call per product), apply the confidence
// threshold, and accumulate token usage.

import {
  NormalizedTable,
  ProductResult,
  FieldResult,
  TokenUsage,
  FieldStatus,
} from "./types";
import { MDD, isLovValid, labelFor, VISUAL_ATTR_IDS } from "../referenceData";
import { findSkuColumn, findImageColumns } from "../parseWorkbook";

// Decide the status of one cell.
function classify(attrId: string, value: any): FieldStatus {
  const empty = value === null || value === undefined || String(value).trim() === "";
  if (empty) return "missing";
  if (!isLovValid(attrId, value)) return "not_lov";
  // present + valid: optionally re-verify visual attrs against image
  return VISUAL_ATTR_IDS.has(attrId) ? "conflict" : "ok";
}

export interface EnrichOptions {
  model: string;
  threshold: number;          // 0..100
  verifyValidValues: boolean; // if false, skip "conflict" re-checks (cheaper)
  onProgress?: (done: number, total: number) => void;
}

export interface EnrichOutput {
  results: ProductResult[];
  enriched: NormalizedTable;  // table with applied values written in
  usage: TokenUsage;
  cellsScanned: number;
  cellsWithIssues: number;
  cellsApplied: number;
  cellsFlagged: number;
}

export async function runEnrichment(
  table: NormalizedTable,
  opts: EnrichOptions
): Promise<EnrichOutput> {
  const skuCol = findSkuColumn(table);
  const imageCols = findImageColumns(table);

  // Which columns in this file are mandatory + LOV-backed.
  const targetCols = table.headers.filter((h) => {
    const aid = table.columnMap[h];
    return aid && MDD.lov[aid];
  });

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let cellsScanned = 0;
  let cellsWithIssues = 0;
  let cellsApplied = 0;
  let cellsFlagged = 0;

  const enrichedRows = table.rows.map((r) => ({ ...r }));
  const results: ProductResult[] = [];
  const total = table.rows.length;

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const sku = String(row[skuCol!] ?? "").trim();
    const imageUrls = imageCols
      .map((c) => String(row[c] ?? "").trim())
      .filter((u) => /^https?:\/\//.test(u));

    // classify each target cell
    const issues = [];
    for (const col of targetCols) {
      const attrId = table.columnMap[col]!;
      cellsScanned++;
      const status = classify(attrId, row[col]);
      if (status === "ok") continue;
      if (status === "conflict" && !opts.verifyValidValues) continue;
      cellsWithIssues++;
      issues.push({
        column: col,
        attrId,
        label: labelFor(attrId),
        status,
        currentValue: row[col],
        allowedValues: MDD.lov[attrId],
      });
    }

    const fieldResults: FieldResult[] = [];
    let error: string | undefined;

    if (issues.length && imageUrls.length) {
      try {
        const resp = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: opts.model, imageUrls, sku, fields: issues }),
        });
        const data = await resp.json();
        if (data.error) {
          error = data.error;
        } else {
          usage.inputTokens += data.usage?.inputTokens || 0;
          usage.outputTokens += data.usage?.outputTokens || 0;
          for (const r of data.results) {
            const issue = issues.find((x) => x.attrId === r.attrId);
            const apply =
              r.proposedValue != null && r.confidence >= opts.threshold;
            if (apply) {
              enrichedRows[i][r.column] = r.proposedValue;
              cellsApplied++;
            } else {
              cellsFlagged++;
            }
            fieldResults.push({
              column: r.column,
              attrId: r.attrId,
              proposedValue: r.proposedValue,
              confidence: r.confidence,
              reasoning: r.reasoning,
              applied: apply,
              status: issue?.status || "missing",
              previousValue: issue?.currentValue,
            });
          }
        }
      } catch (e: any) {
        error = e?.message || "request failed";
      }
    } else if (issues.length && !imageUrls.length) {
      // issues but no image to resolve them -> all flagged
      for (const issue of issues) {
        cellsFlagged++;
        fieldResults.push({
          column: issue.column,
          attrId: issue.attrId,
          proposedValue: null,
          confidence: 0,
          reasoning: "no product image available",
          applied: false,
          status: issue.status,
          previousValue: issue.currentValue,
        });
      }
    }

    results.push({ rowNumber: table.rawRowNumbers[i], sku, imageUrls, fields: fieldResults, error });
    opts.onProgress?.(i + 1, total);
  }

  return {
    results,
    enriched: { ...table, rows: enrichedRows },
    usage,
    cellsScanned,
    cellsWithIssues,
    cellsApplied,
    cellsFlagged,
  };
}
