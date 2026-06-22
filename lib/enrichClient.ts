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
  NON_VISUAL_ATTR_IDS,
  METADATA_ATTR_IDS,
  METADATA_HEADER_KEYS,
  normalizeHeader,
  L4_LIST,
  isVisualAttr,
  isColorFamilyAttr,
  isColorFreeText,
  attrAppliesToL4,
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
  // free-text fields (e.g. Color) have no LOV; if present, leave as-is
  if (isColorFreeText(attrId)) {
    return isVisualAttr(attrId) ? "conflict" : "ok";
  }
  if (!isLovValid(attrId, value)) return "not_lov";
  return isVisualAttr(attrId) ? "conflict" : "ok";
}

export interface EnrichOptions {
  model: string;
  threshold: number;
  verifyValidValues: boolean;
  concurrency?: number;        // how many products to process in parallel
  maxImages?: number;          // how many image links per product to send (1-5)
  requestsPerMinute?: number;  // pace API calls to stay under rate limits (0 = unlimited)
  ageBandDefault?: string;     // optional catalogue default for empty Age Band cells
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
  notApplicable: number;    // attributes dropped as N/A to the product's category
  consensusFilled: number;  // blanks filled from style-code group consensus
  consensusFixed: number;   // outlier values corrected to match the group
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

// Re-usable audit-column writer (also called after the group-consensus pass).
function writeAuditCols(row: Record<string, any>, fields: FieldResult[]) {
  const typeParts: string[] = [];
  const confParts: string[] = [];
  for (const f of fields) {
    const kind = NON_VISUAL_ATTR_IDS.has(f.attrId) ? "non-visual" : "visual";
    typeParts.push(`${f.column}: ${kind}`);
    if (f.reasoning && f.reasoning.startsWith("group consensus")) {
      confParts.push(`${f.column}: group-filled`);
    } else if (f.applied) {
      confParts.push(`${f.column}: ${f.confidence}% (filled)`);
    } else if (kind === "non-visual") {
      confParts.push(`${f.column}: flagged`);
    } else {
      confParts.push(`${f.column}: ${f.confidence}% (flagged)`);
    }
  }
  row[AUDIT_TYPE_COL] = typeParts.join("; ");
  row[AUDIT_CONF_COL] = confParts.join("; ");
}

// Majority value among non-blank strings (case-insensitive grouping, returns
// the most common original spelling). Null if there are no non-blank values.
function majority(values: any[]): string | null {
  const counts = new Map<string, { raw: string; n: number }>();
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { raw: s, n: 1 });
  }
  let best: { raw: string; n: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best ? best.raw : null;
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
  // The tool's working set is driven by the UPLOADED SHEET'S OWN mandatory
  // markers (not a fixed golden list), so it adapts to any seller template:
  // any column the sheet marks MANDATORY that maps to an LOV attribute, plus
  // the free-text Color column (filled by mirroring from Color Family).
  const targetCols = table.headers.filter((h) => {
    const aid = table.columnMap[h];
    if (!aid || !table.mandatoryMap[h]) return false;
    return !!MDD.lov[aid] || isColorFreeText(aid);
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
  const colorCol = table.headers.find((h) => isColorFreeText(table.columnMap[h]));
  const colorFamilyCol = table.headers.find((h) => isColorFamilyAttr(table.columnMap[h]));

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let cellsScanned = 0;
  let cellsWithIssues = 0;
  let cellsApplied = 0;
  let cellsFlagged = 0;
  let issuesVisual = 0;
  let issuesNonVisual = 0;
  let visualErrored = 0;
  let notApplicable = 0;
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

    // Category-aware filter: drop attributes that don't apply to this product's
    // L4 (e.g. Bra Type / Trouser Type / Dress Length on a dress). Anything the
    // model filled for a non-applicable attribute is reverted to blank, and the
    // field is removed so it isn't counted or shown as a gap.
    for (let k = fieldResults.length - 1; k >= 0; k--) {
      const fr = fieldResults[k];
      if (!attrAppliesToL4(fr.attrId, rowL4)) {
        if (fr.applied) { enrichedRows[idx][fr.column] = ""; cellsApplied--; }
        else { cellsFlagged--; }
        notApplicable++;
        fieldResults.splice(k, 1);
      }
    }

    // Mirror Color (free text) from Color Family if Color is still blank.
    if (colorCol && colorFamilyCol) {
      const curColor = String(enrichedRows[idx][colorCol] ?? "").trim();
      const famVal = String(enrichedRows[idx][colorFamilyCol] ?? "").trim();
      if (!curColor && famVal) {
        enrichedRows[idx][colorCol] = famVal;
        cellsApplied++;
        const famRes = fieldResults.find((fr) => isColorFamilyAttr(fr.attrId));
        fieldResults.push({
          column: colorCol,
          attrId: table.columnMap[colorCol] || "colorapparel",
          proposedValue: famVal,
          confidence: famRes ? famRes.confidence : 100,
          reasoning: "Mirrored from Color Family",
          applied: true,
          status: "missing",
          previousValue: "",
        });
      }
    }

    // Audit columns: list each field the tool acted on (filled or flagged).
    writeAuditCols(enrichedRows[idx], fieldResults);

    results[idx] = {
      rowNumber: table.rawRowNumbers[idx],
      sku: plan.sku,
      imageUrls: plan.imageUrls,
      fields: fieldResults,
      metadata: plan.metadata,
      l4: rowL4,
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

  // ---- Group-consensus pass (deterministic, no API) ----
  // Products that share a Style Code are size variants of the same garment, so
  // every attribute except Size is constant across them. For each style group
  // we take the majority value and apply it to the whole group — filling blanks
  // AND correcting isolated wrong guesses. A catalogue-wide majority backfills
  // non-visual fields (Age Band, Occasion) for groups that are entirely blank.
  let consensusFilled = 0;
  let consensusFixed = 0;
  const styleCol = table.headers.find((h) => table.columnMap[h] === "stylecode");
  if (styleCol) {
    // Constant-across-size columns: everything the tool targets except Size.
    const consensusCols = targetCols.filter((h) => {
      const aid = (table.columnMap[h] || "").toLowerCase();
      return aid && !aid.includes("size");
    });

    // Group row indices by style code.
    const groups = new Map<string, number[]>();
    enrichedRows.forEach((r, idx) => {
      const code = String(r[styleCol] ?? "").trim();
      if (!code) return;
      (groups.get(code) || groups.set(code, []).get(code)!).push(idx);
    });

    // Catalogue-wide majority per column (for the all-blank fallback).
    const catMode: Record<string, string | null> = {};
    for (const col of consensusCols) catMode[col] = majority(enrichedRows.map((r) => r[col]));

    const changedRows = new Set<number>();
    for (const [, idxs] of groups) {
      if (idxs.length < 2) continue;
      for (const col of consensusCols) {
        const attrId = table.columnMap[col]!;
        let target = majority(idxs.map((i) => enrichedRows[i][col]));
        // all-blank group: only backfill non-visual fields from catalogue mode
        if (!target && NON_VISUAL_ATTR_IDS.has(attrId)) target = catMode[col];
        if (!target) continue;
        for (const i of idxs) {
          const cur = String(enrichedRows[i][col] ?? "").trim();
          if (cur.toLowerCase() === target.toLowerCase()) continue;
          const wasBlank = cur === "";
          enrichedRows[i][col] = target;
          if (wasBlank) consensusFilled++; else consensusFixed++;
          changedRows.add(i);
          results[i]?.fields.push({
            column: col,
            attrId,
            proposedValue: target,
            confidence: 100,
            reasoning: wasBlank
              ? "group consensus — filled from same style-code siblings"
              : `group consensus — corrected "${cur}" to match style-code siblings`,
            applied: true,
            status: wasBlank ? "missing" : "conflict",
            previousValue: cur,
          });
        }
      }
    }
    // Refresh audit columns for rows the consensus pass touched.
    for (const i of changedRows) {
      if (results[i]) writeAuditCols(enrichedRows[i], results[i].fields);
    }
  }

  // ---- Age Band default ----
  // Age Band can't come from an image, and consensus can't help when the whole
  // column is empty. If the user supplied a catalogue default, fill any Age Band
  // cell that's still blank (lowest priority — after model and consensus).
  const abDefault = String(opts.ageBandDefault || "").trim();
  if (abDefault) {
    const abCol = table.headers.find((h) => table.columnMap[h] === "ageband");
    if (abCol) {
      enrichedRows.forEach((r, idx) => {
        if (String(r[abCol] ?? "").trim() === "") {
          r[abCol] = abDefault;
          cellsApplied++;
          if (results[idx]) {
            results[idx].fields.push({
              column: abCol, attrId: "ageband", proposedValue: abDefault,
              confidence: 100, reasoning: "catalogue default (Age Band)",
              applied: true, status: "missing", previousValue: "",
            });
            writeAuditCols(r, results[idx].fields);
          }
        }
      });
    }
  }

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
    notApplicable,
    consensusFilled,
    consensusFixed,
    erroredRows,
    firstError,
  };
}
