// Orchestrates enrichment on the client:
//  - classify issues per row
//  - flag non-visual attributes instead of guessing them
//  - call /api/enrich in PARALLEL batches (concurrency pool) for speed
//  - apply the confidence threshold, accumulate tokens, count errored rows

import {
  NormalizedTable,
  ProductResult,
  FieldResult,
  TokenUsage,
  FieldStatus,
} from "./types";
import {
  MDD,
  isLovValid,
  labelFor,
  VISUAL_ATTR_IDS,
  NON_VISUAL_ATTR_IDS,
  MANDATORY_ATTR_IDS,
} from "./referenceData";
import { findSkuColumn, findImageColumns } from "./parseWorkbook";

// Names of the two audit columns appended to the enriched output.
export const AUDIT_TYPE_COL = "_enrichment_type";
export const AUDIT_CONF_COL = "_enrichment_confidence";

function classify(attrId: string, value: any): FieldStatus {
  const empty = value === null || value === undefined || String(value).trim() === "";
  if (empty) return "missing";
  if (!isLovValid(attrId, value)) return "not_lov";
  return VISUAL_ATTR_IDS.has(attrId) ? "conflict" : "ok";
}

export interface EnrichOptions {
  model: string;
  threshold: number;
  verifyValidValues: boolean;
  concurrency?: number; // how many products to process in parallel
  maxImages?: number;   // how many image links per product to send (1-5)
  onProgress?: (done: number, total: number) => void;
}

export interface EnrichOutput {
  results: ProductResult[];
  enriched: NormalizedTable;
  usage: TokenUsage;
  cellsScanned: number;
  cellsWithIssues: number;
  cellsApplied: number;
  cellsFlagged: number;
  // funnel counters (cell level, over mandatory LOV columns)
  totalAttrCells: number;   // rows × all LOV-mapped columns (mandatory + optional)
  mandatoryCells: number;   // rows × mandatory LOV columns (the tool's working set)
  issuesVisual: number;     // mandatory issues that are visually determinable
  issuesNonVisual: number;  // mandatory issues that are not (flagged)
  visualErrored: number;    // visual issues in rows whose image/API call failed
  erroredRows: number;   // products whose API call failed
  firstError?: string;   // first error message seen (for diagnosis)
}

function planRow(table: NormalizedTable, i: number, targetCols: string[], skuCol: string, imageCols: string[], verify: boolean) {
  const row = table.rows[i];
  const sku = String(row[skuCol] ?? "").trim();
  const imageUrls = imageCols
    .map((c) => String(row[c] ?? "").trim())
    .filter((u) => /^https?:\/\//.test(u));

  const visualIssues: any[] = [];
  const flagIssues: any[] = [];
  let scanned = 0;

  for (const col of targetCols) {
    const attrId = table.columnMap[col]!;
    scanned++;
    const status = classify(attrId, row[col]);
    if (status === "ok") continue;
    if (status === "conflict" && !verify) continue;

    const issue = {
      column: col,
      attrId,
      label: labelFor(attrId),
      status,
      currentValue: row[col],
      allowedValues: MDD.lov[attrId],
    };
    if (NON_VISUAL_ATTR_IDS.has(attrId)) flagIssues.push(issue);
    else visualIssues.push(issue);
  }

  return { i, sku, imageUrls, visualIssues, flagIssues, scanned };
}

export async function runEnrichment(
  table: NormalizedTable,
  opts: EnrichOptions
): Promise<EnrichOutput> {
  const skuCol = findSkuColumn(table)!;
  const imageCols = findImageColumns(table);
  const concurrency = Math.max(1, opts.concurrency ?? 6);

  // All LOV-mapped columns in this file (for the "total attribute cells" context).
  const allLovCols = table.headers.filter((h) => {
    const aid = table.columnMap[h];
    return aid && MDD.lov[aid];
  });
  // The tool's working set: mandatory LOV columns only.
  const targetCols = allLovCols.filter((h) => MANDATORY_ATTR_IDS.has(table.columnMap[h]!));

  const totalAttrCells = allLovCols.length * table.rows.length;
  const mandatoryCells = targetCols.length * table.rows.length;

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let cellsScanned = 0;
  let cellsWithIssues = 0;
  let cellsApplied = 0;
  let cellsFlagged = 0;
  let issuesVisual = 0;
  let issuesNonVisual = 0;
  let visualErrored = 0;
  let erroredRows = 0;
  let firstError: string | undefined;
  let rowsNoImage = 0;

  const enrichedRows = table.rows.map((r) => ({ ...r }));
  const results: ProductResult[] = new Array(table.rows.length);
  const total = table.rows.length;
  let done = 0;

  async function processOne(idx: number) {
    const plan = planRow(table, idx, targetCols, skuCol, imageCols, opts.verifyValidValues);
    cellsScanned += plan.scanned;
    cellsWithIssues += plan.visualIssues.length + plan.flagIssues.length;
    issuesVisual += plan.visualIssues.length;
    issuesNonVisual += plan.flagIssues.length;

    const fieldResults: FieldResult[] = [];
    let error: string | undefined;

    for (const issue of plan.flagIssues) {
      cellsFlagged++;
      fieldResults.push({
        column: issue.column,
        attrId: issue.attrId,
        proposedValue: null,
        confidence: 0,
        reasoning: "not determinable from a product image",
        applied: false,
        status: issue.status,
        previousValue: issue.currentValue,
      });
    }

    if (plan.visualIssues.length && plan.imageUrls.length) {
      try {
        const resp = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: opts.model,
            imageUrls: plan.imageUrls,
            sku: plan.sku,
            fields: plan.visualIssues,
            maxImages: opts.maxImages ?? 3,
          }),
        });
        const data = await resp.json();
        if (data.error) {
          error = data.error;
          cellsFlagged += plan.visualIssues.length;
          visualErrored += plan.visualIssues.length;
        } else {
          usage.inputTokens += data.usage?.inputTokens || 0;
          usage.outputTokens += data.usage?.outputTokens || 0;
          for (const r of data.results) {
            const issue = plan.visualIssues.find((x: any) => x.attrId === r.attrId);
            const apply = r.proposedValue != null && r.confidence >= opts.threshold;
            if (apply) {
              enrichedRows[idx][r.column] = r.proposedValue;
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
        cellsFlagged += plan.visualIssues.length;
        visualErrored += plan.visualIssues.length;
      }
    } else if (plan.visualIssues.length && !plan.imageUrls.length) {
      rowsNoImage++;
      visualErrored += plan.visualIssues.length;
      for (const issue of plan.visualIssues) {
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

    if (error) { erroredRows++; if (!firstError) firstError = error; }

    // Audit columns: list each field the tool acted on (filled or flagged),
    // with its visual/non-visual type and confidence. Blank if nothing acted on.
    const typeParts: string[] = [];
    const confParts: string[] = [];
    for (const f of fieldResults) {
      const kind = NON_VISUAL_ATTR_IDS.has(f.attrId) ? "non-visual" : "visual";
      typeParts.push(`${f.column}: ${kind}`);
      if (f.applied) confParts.push(`${f.column}: ${f.confidence}% (filled)`);
      else if (kind === "non-visual") confParts.push(`${f.column}: flagged`);
      else confParts.push(`${f.column}: ${f.confidence}% (flagged)`);
    }
    enrichedRows[idx][AUDIT_TYPE_COL] = typeParts.join("; ");
    enrichedRows[idx][AUDIT_CONF_COL] = confParts.join("; ");

    results[idx] = {
      rowNumber: table.rawRowNumbers[idx],
      sku: plan.sku,
      imageUrls: plan.imageUrls,
      fields: fieldResults,
      error,
    };
    done++;
    opts.onProgress?.(done, total);
  }

  let next = 0;
  async function worker() {
    while (next < total) {
      const idx = next++;
      await processOne(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  return {
    results,
    enriched: {
      ...table,
      headers: [...table.headers, AUDIT_TYPE_COL, AUDIT_CONF_COL],
      rows: enrichedRows,
    },
    usage,
    cellsScanned,
    cellsWithIssues,
    cellsApplied,
    cellsFlagged,
    totalAttrCells,
    mandatoryCells,
    issuesVisual,
    issuesNonVisual,
    visualErrored,
    erroredRows,
    firstError,
  };
}
