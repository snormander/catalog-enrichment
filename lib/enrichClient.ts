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
  FREE_TEXT_VISUAL_ATTR_IDS,
  METADATA_ATTR_IDS,
  METADATA_HEADER_KEYS,
  normalizeHeader,
  L4_LIST,
  isDressL4,
} from "./referenceData";
import { findSkuColumn, findImageColumns } from "./parseWorkbook";

// Names of the two audit columns appended to the enriched output.
export const AUDIT_TYPE_COL = "_enrichment_type";
export const AUDIT_CONF_COL = "_enrichment_confidence";
export const L4_COL = "_L4_category";

// Columns the tool itself adds — stripped from input before re-enriching so
// they don't stack up on repeated runs.
export const TOOL_ADDED_COLS = [AUDIT_TYPE_COL, AUDIT_CONF_COL, L4_COL];

// Lightweight keyword fallback if the model doesn't return an L4.
export function guessL4FromText(text: string): string {
  const s = (text || "").toLowerCase();
  const pick = (kw: string[], l4: string) => kw.some((k) => s.includes(k)) ? l4 : "";
  return (
    pick(["maxi", "midi", "gown", " dress"], "Casual dresses") ||
    pick(["formal shirt"], "Formal shirt") ||
    pick(["shirt"], "casual shirts") ||
    pick(["jean", "denim"], "Jeans") ||
    pick(["short"], "Shorts") ||
    pick(["skirt"], "Skirts") ||
    pick(["hoodie", "sweatshirt"], "Sweatshirts and hoodies") ||
    pick(["sweater", "pullover"], "Sweaters") ||
    pick(["kurta", "kurti"], "Kurta & kurtis") ||
    pick(["legging", "jegging"], "Leggings & Jeggings") ||
    pick(["jumpsuit", "jump suit"], "Jump suits") ||
    pick(["top", "tee", "t-shirt", "tshirt", "blouse"], "Tops and tees") ||
    "Tops and tees"
  );
}

function classify(attrId: string, value: any): FieldStatus {
  const empty = value === null || value === undefined || String(value).trim() === "";
  if (empty) return "missing";
  // free-text fields (e.g. Color) have no LOV; if present, leave as-is unless re-verifying
  if (FREE_TEXT_VISUAL_ATTR_IDS.has(attrId)) {
    return VISUAL_ATTR_IDS.has(attrId) ? "conflict" : "ok";
  }
  if (!isLovValid(attrId, value)) return "not_lov";
  return VISUAL_ATTR_IDS.has(attrId) ? "conflict" : "ok";
}

export interface EnrichOptions {
  model: string;
  threshold: number;
  verifyValidValues: boolean;
  concurrency?: number;        // how many products to process in parallel
  maxImages?: number;          // how many image links per product to send (1-5)
  requestsPerMinute?: number;  // pace API calls to stay under rate limits (0 = unlimited)
  onProgress?: (done: number, total: number) => void;
}

// Simple shared pacer: ensures request *starts* are spaced at least
// (60000 / rpm) ms apart, so we stay under a provider's per-minute cap even
// with multiple parallel workers. rpm <= 0 means no pacing.
function makePacer(rpm: number) {
  if (!rpm || rpm <= 0) return async () => {};
  const intervalMs = 60000 / rpm;
  let nextSlot = 0;
  return async function pace() {
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + intervalMs;
    const wait = start - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
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

function gatherMetadata(table: NormalizedTable, row: Record<string, any>, metaCols: string[]): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const col of metaCols) {
    const v = String(row[col] ?? "").trim();
    if (v) meta[col] = v.slice(0, 400); // cap length
  }
  return meta;
}

function planRow(table: NormalizedTable, i: number, targetCols: string[], skuCol: string, imageCols: string[], metaCols: string[], verify: boolean) {
  const row = table.rows[i];
  const sku = String(row[skuCol] ?? "").trim();
  const imageUrls = imageCols
    .map((c) => String(row[c] ?? "").trim())
    .filter((u) => /^https?:\/\//.test(u));
  const metadata = gatherMetadata(table, row, metaCols);

  const visualIssues: any[] = [];
  const flagIssues: any[] = [];
  let scanned = 0;

  for (const col of targetCols) {
    const attrId = table.columnMap[col]!;
    scanned++;
    const status = classify(attrId, row[col]);
    if (status === "ok") continue;
    if (status === "conflict" && !verify) continue;

    // Free-text fields (e.g. Color) have no LOV to pick from, so we don't send
    // them to the model with an empty list — they're filled deterministically
    // by mirroring from their LOV counterpart (Color Family) after enrichment.
    if (!MDD.lov[attrId]) continue;

    const issue = {
      column: col,
      attrId,
      label: labelFor(attrId),
      status,
      currentValue: row[col],
      allowedValues: MDD.lov[attrId] || [],
      freeText: false,
    };
    if (NON_VISUAL_ATTR_IDS.has(attrId)) flagIssues.push(issue);
    else visualIssues.push(issue);
  }

  return { i, sku, imageUrls, metadata, visualIssues, flagIssues, scanned };
}

export async function runEnrichment(
  table: NormalizedTable,
  opts: EnrichOptions
): Promise<EnrichOutput> {
  // Strip any columns the tool added on a previous run so they don't stack up.
  if (table.headers.some((h) => TOOL_ADDED_COLS.includes(h))) {
    const keep = table.headers.filter((h) => !TOOL_ADDED_COLS.includes(h));
    const cleanedRows = table.rows.map((r) => {
      const o: Record<string, any> = {};
      for (const h of keep) o[h] = r[h];
      return o;
    });
    const cleanedBlock = (table.headerBlock || []).map((row) =>
      table.headers.map((h, i) => row[i]).filter((_, i) => !TOOL_ADDED_COLS.includes(table.headers[i]))
    );
    table = { ...table, headers: keep, rows: cleanedRows, headerBlock: cleanedBlock };
  }

  const skuCol = findSkuColumn(table)!;
  const imageCols = findImageColumns(table);
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const pace = makePacer(opts.requestsPerMinute ?? 0);

  // All LOV-mapped columns in this file (for the "total attribute cells" context).
  const allLovCols = table.headers.filter((h) => {
    const aid = table.columnMap[h];
    return aid && MDD.lov[aid];
  });
  // The tool's working set: mandatory LOV columns + mandatory free-text visual
  // fields (e.g. Color, which has no LOV but should still be filled).
  const targetCols = table.headers.filter((h) => {
    const aid = table.columnMap[h];
    if (!aid) return false;
    if (MDD.lov[aid] && MANDATORY_ATTR_IDS.has(aid)) return true;
    if (FREE_TEXT_VISUAL_ATTR_IDS.has(aid)) return true; // Color etc.
    return false;
  });

  // Metadata columns (title / name / description / etc.) passed to the model.
  const metaCols = table.headers.filter((h) => {
    const aid = table.columnMap[h];
    if (aid && METADATA_ATTR_IDS.includes(aid)) return true;
    return METADATA_HEADER_KEYS.includes(normalizeHeader(h));
  });

  const totalAttrCells = allLovCols.length * table.rows.length;
  const mandatoryCells = targetCols.length * table.rows.length;

  // Color (free text) is mirrored from Color Family (LOV) so it always fills.
  const colorCol = table.headers.find((h) => table.columnMap[h] === "colorapparel");
  const colorFamilyCol = table.headers.find((h) => table.columnMap[h] === "colorfamilyapparel");

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
    const plan = planRow(table, idx, targetCols, skuCol, imageCols, metaCols, opts.verifyValidValues);
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

    let modelL4: string | null = null;
    if (plan.visualIssues.length && plan.imageUrls.length) {
      try {
        await pace();
        const resp = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: opts.model,
            imageUrls: plan.imageUrls,
            sku: plan.sku,
            fields: plan.visualIssues,
            metadata: plan.metadata,
            maxImages: opts.maxImages ?? 3,
            l4List: L4_LIST,
          }),
        });
        const data = await resp.json();
        if (data.error) {
          error = data.error;
          cellsFlagged += plan.visualIssues.length;
          visualErrored += plan.visualIssues.length;
        } else {
          modelL4 = data.l4 || null;
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

    // Resolve L4: model classification, else keyword fallback from metadata text.
    const metaText = Object.values(plan.metadata || {}).join(" ");
    const rowL4 = modelL4 || guessL4FromText(metaText);
    enrichedRows[idx][L4_COL] = rowL4;

    // Dress Length only applies to dress-type categories. If this row isn't a
    // dress and the tool filled dress length, revert it (keep the cell blank).
    if (!isDressL4(rowL4)) {
      for (const fr of fieldResults) {
        if (fr.attrId === "dresslength" && fr.applied) {
          enrichedRows[idx][fr.column] = "";
          fr.applied = false;
          fr.proposedValue = null;
          fr.reasoning = "skipped — dress length not applicable to " + (rowL4 || "this category");
          cellsApplied--;
          cellsFlagged++;
        }
      }
    }

    // Mirror Color (free text) from Color Family if Color is still blank.
    if (colorCol && colorFamilyCol) {
      const curColor = String(enrichedRows[idx][colorCol] ?? "").trim();
      const famVal = String(enrichedRows[idx][colorFamilyCol] ?? "").trim();
      if (!curColor && famVal) {
        enrichedRows[idx][colorCol] = famVal;
        cellsApplied++;
        const famRes = fieldResults.find((fr) => fr.attrId === "colorfamilyapparel");
        fieldResults.push({
          column: colorCol,
          attrId: "colorapparel",
          proposedValue: famVal,
          confidence: famRes ? famRes.confidence : 100,
          reasoning: "Mirrored from Color Family",
          applied: true,
          status: "missing",
          previousValue: "",
        });
      }
    }

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
      headers: [...table.headers, L4_COL, AUDIT_TYPE_COL, AUDIT_CONF_COL],
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
