"use client";
import React, { useState } from "react";
import FileDrop from "./FileDrop";
import ReportCard from "./ReportCard";
import { normalizeAllSheets, enrichedToL4Blob } from "@/lib/parseWorkbook";
import { runEnrichment, AUDIT_TYPE_COL, AUDIT_CONF_COL, L4_COL } from "@/lib/enrichClient";
import { evaluateAccuracy } from "@/lib/accuracy";
import { MODELS, costForUsage } from "@/lib/cost";
import { NormalizedTable, RunReport, ProductResult } from "@/lib/types";

export default function EnrichmentSection() {
  const [sellerName, setSellerName] = useState<string | null>(null);
  const [sellerSheets, setSellerSheets] = useState<NormalizedTable[]>([]);
  const [goldenName, setGoldenName] = useState<string | null>(null);
  const [goldenSheets, setGoldenSheets] = useState<NormalizedTable[]>([]);

  const [model, setModel] = useState(MODELS[0].id);
  const [threshold, setThreshold] = useState(80);
  const [verify, setVerify] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [maxImages, setMaxImages] = useState(3);
  const [rpm, setRpm] = useState(10);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<RunReport | null>(null);
  const [results, setResults] = useState<ProductResult[]>([]);
  const [enrichedTables, setEnrichedTables] = useState<NormalizedTable[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function onSeller(file: File) {
    setErr(null); setReport(null);
    setSellerName(file.name);
    try {
      const sheets = await normalizeAllSheets(file);
      if (!sheets.length) { setErr("No product rows found in that file."); return; }
      setSellerSheets(sheets);
    } catch (e: any) { setErr("Seller file: " + e.message); }
  }
  async function onGolden(file: File) {
    setGoldenName(file.name);
    try { setGoldenSheets(await normalizeAllSheets(file)); }
    catch (e: any) { setErr("Golden file: " + e.message); }
  }

  // Merge all golden sheets into one lookup table for SKU-based accuracy.
  function mergedGolden(): NormalizedTable | null {
    if (!goldenSheets.length) return null;
    const base = goldenSheets[0];
    return {
      ...base,
      rows: goldenSheets.flatMap((s) => s.rows),
    };
  }

  async function run() {
    if (!sellerSheets.length) return;
    setBusy(true); setErr(null); setReport(null);
    const grandTotal = sellerSheets.reduce((n, s) => n + s.rows.length, 0);
    setProgress({ done: 0, total: grandTotal });

    try {
      const allResults: ProductResult[] = [];
      const outTables: NormalizedTable[] = [];
      const agg = {
        cellsScanned: 0, cellsWithIssues: 0, cellsApplied: 0, cellsFlagged: 0,
        totalAttrCells: 0, mandatoryCells: 0, issuesVisual: 0, issuesNonVisual: 0,
        visualErrored: 0, erroredRows: 0, inputTokens: 0, outputTokens: 0,
        consensusFilled: 0, consensusFixed: 0,
      };
      let firstError: string | undefined;
      let doneSoFar = 0;

      for (const sheet of sellerSheets) {
        const out = await runEnrichment(sheet, {
          model, threshold, verifyValidValues: verify, concurrency, maxImages, requestsPerMinute: rpm,
          onProgress: (d) => setProgress({ done: doneSoFar + d, total: grandTotal }),
        });
        doneSoFar += sheet.rows.length;

        out.results.forEach((r) => { r.sheetName = sheet.sheetName; });
        allResults.push(...out.results);
        outTables.push(out.enriched);

        agg.cellsScanned += out.cellsScanned;
        agg.cellsWithIssues += out.cellsWithIssues;
        agg.cellsApplied += out.cellsApplied;
        agg.cellsFlagged += out.cellsFlagged;
        agg.totalAttrCells += out.totalAttrCells;
        agg.mandatoryCells += out.mandatoryCells;
        agg.issuesVisual += out.issuesVisual;
        agg.issuesNonVisual += out.issuesNonVisual;
        agg.visualErrored += out.visualErrored;
        agg.erroredRows += out.erroredRows;
        agg.consensusFilled += out.consensusFilled;
        agg.consensusFixed += out.consensusFixed;
        agg.inputTokens += out.usage.inputTokens;
        agg.outputTokens += out.usage.outputTokens;
        if (!firstError && out.firstError) firstError = out.firstError;
      }

      setResults(allResults);
      setEnrichedTables(outTables);

      const usage = { inputTokens: agg.inputTokens, outputTokens: agg.outputTokens };
      const cost = costForUsage(usage, model);
      const rep: RunReport = {
        fileName: sellerName || "seller.xlsx",
        model, threshold,
        productsProcessed: allResults.length,
        cellsScanned: agg.cellsScanned,
        cellsWithIssues: agg.cellsWithIssues,
        cellsApplied: agg.cellsApplied,
        cellsFlagged: agg.cellsFlagged,
        erroredRows: agg.erroredRows,
        firstError,
        consensusFilled: agg.consensusFilled,
        consensusFixed: agg.consensusFixed,
        funnel: {
          totalAttrCells: agg.totalAttrCells,
          mandatoryCells: agg.mandatoryCells,
          issues: agg.cellsWithIssues,
          nonVisual: agg.issuesNonVisual,
          visual: agg.issuesVisual,
          errored: agg.visualErrored,
          attempted: agg.cellsApplied,
        },
        usage, costUSD: cost.usd, costINR: cost.inr,
        generatedAt: new Date().toISOString(),
      };
      const g = mergedGolden();
      if (g) {
        rep.accuracy = evaluateAccuracy(g, allResults);
        rep.funnel.scored = rep.accuracy.evaluated;
        rep.funnel.correct = rep.accuracy.correct;
      }
      setReport(rep);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadEnriched() {
    if (!enrichedTables.length) return;
    // Combine all enriched sheets into one dataset, then split into a Main tab
    // plus one tab per L4 category.
    const base = enrichedTables[0];
    const allRows = enrichedTables.flatMap((t) => t.rows);
    const combined = { ...base, rows: allRows };
    const blob = enrichedToL4Blob(combined, L4_COL);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (sellerName?.replace(/\.[^.]+$/, "") || "seller") + "_enriched.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;

  // Only the rows where the tool actually changed/flagged something.
  const changes = results.flatMap((p) =>
    p.fields.map((f) => ({ ...f, sku: p.sku, sheet: p.sheetName }))
  );
  const applied = changes.filter((c) => c.applied);

  return (
    <>
      <div className="card">
        <span className="section-eyebrow">Step 1 · Enrich</span>
        <h2>Enrich seller data</h2>
        <p className="hint">
          Upload a seller file in any layout. Every sheet (L4 category) is processed and written back with
          its original schema preserved. Mandatory fields are filled or fixed from the product image and the
          product text, applying a value only when the model’s confidence clears your threshold.
        </p>
        <div className="row">
          <div className="col"><FileDrop label="Seller data (to enrich)" onFile={onSeller} fileName={sellerName} /></div>
          <div className="col">
            <FileDrop label="Golden data — for accuracy" optional onFile={onGolden} fileName={goldenName}
              hint="Upload to score accuracy; skip to enrich only" />
          </div>
        </div>
        {sellerSheets.length > 0 && (
          <p className="hint" style={{ marginTop: 12 }}>
            Detected {sellerSheets.length} sheet{sellerSheets.length > 1 ? "s" : ""}:{" "}
            {sellerSheets.map((s) => `${s.sheetName || "Sheet"} (${s.rows.length})`).join(", ")}
          </p>
        )}
      </div>

      <div className="card">
        <span className="section-eyebrow">Configuration</span>
        <h2>Run settings</h2>
        <div className="row">
          <div className="col">
            <label className="field">Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — ${m.inputPerM}/${m.outputPerM} per 1M
                </option>
              ))}
            </select>
          </div>
          <div className="col">
            <label className="field">Confidence threshold</label>
            <div className="slider-wrap">
              <div className="slider-row">
                <input type="range" min={0} max={100} value={threshold}
                  onChange={(e) => setThreshold(+e.target.value)} />
                <span className="slider-val">{threshold}%</span>
              </div>
              <small className="dim">Values below this are flagged for human review, not written.</small>
            </div>
          </div>
        </div>
        <div className="gap" />
        <div className="row">
          <div className="col">
            <label className="field">Parallel requests — {concurrency}</label>
            <div className="slider-row">
              <input type="range" min={1} max={20} value={concurrency}
                onChange={(e) => setConcurrency(+e.target.value)} />
              <span className="slider-val">{concurrency}×</span>
            </div>
            <small className="dim">Products at once. Free-tier Gemini allows few requests/min — keep this at 1–2. Raise it only with billing enabled.</small>
          </div>
          <div className="col">
            <label className="field">Images per product — {maxImages}</label>
            <div className="slider-row">
              <input type="range" min={1} max={5} value={maxImages}
                onChange={(e) => setMaxImages(+e.target.value)} />
              <span className="slider-val">{maxImages}</span>
            </div>
            <small className="dim">Image links sent together per row. More angles can help, but cost more input tokens.</small>
          </div>
          <div className="col">
            <label className="field">Max requests / min — {rpm === 0 ? "unlimited" : rpm}</label>
            <div className="slider-row">
              <input type="range" min={0} max={60} value={rpm}
                onChange={(e) => setRpm(+e.target.value)} />
              <span className="slider-val">{rpm === 0 ? "∞" : rpm}</span>
            </div>
            <small className="dim">Free-tier Flash allows ~10/min. Keep at 10 on a free key; raise it (or set ∞) once billing is enabled.</small>
          </div>
          <div className="col" style={{ display: "flex", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
              Re-verify already-valid visual fields against the image (more accurate, higher cost)
            </label>
          </div>
        </div>

        <div className="gap" />
        {err && <div className="notice bad">{err}</div>}
        {busy && (
          <div style={{ marginBottom: 14 }}>
            <div className="spread" style={{ marginBottom: 6 }}>
              <small className="dim">Processing products…</small>
              <small className="mono">{progress.done}/{progress.total}</small>
            </div>
            <div className="progress"><span style={{ width: `${pct}%` }} /></div>
          </div>
        )}
        <button className="btn" disabled={!sellerSheets.length || busy} onClick={run}>
          {busy ? "Enriching…" : "Run enrichment"}
        </button>
      </div>

      {report && <ReportCard report={report} />}

      {enrichedTables.length > 0 && (
        <div className="card">
          <div className="spread">
            <h2>Enriched output</h2>
            <button className="btn secondary" onClick={downloadEnriched}>Download enriched .xlsx</button>
          </div>
          <p className="hint">
            {enrichedTables.length} sheet{enrichedTables.length > 1 ? "s" : ""}, schema preserved, with
            two audit columns appended. {applied.length} value{applied.length === 1 ? "" : "s"} filled/corrected.
          </p>

          {/* Changes made — collapsible review pane */}
          <details open style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 650, fontSize: 13.5, color: "var(--accent)" }}>
              Changes made — {applied.length} filled/corrected (click to {applied.length ? "review" : "expand"})
            </summary>
            <p className="hint" style={{ marginTop: 10 }}>
              Review what changed without opening the file. “Was” shows the prior value (blank = was missing).
              Showing up to 250 entries.
            </p>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Sheet</th><th>SKU</th><th>Field</th><th>Status</th>
                    <th>Was</th><th>Now</th><th className="num">Conf.</th><th>Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.slice(0, 250).map((c, i) => (
                    <tr key={i}>
                      <td><small className="dim">{c.sheet || "—"}</small></td>
                      <td className="mono">{c.sku}</td>
                      <td>{c.column}</td>
                      <td><span className={"pill " + c.status}>{c.status}</span></td>
                      <td>{c.previousValue && String(c.previousValue).trim()
                        ? String(c.previousValue)
                        : <span className="pill missing">blank</span>}</td>
                      <td><b>{c.proposedValue}</b></td>
                      <td className="num">{c.confidence}%</td>
                      <td><small className="dim">{c.reasoning || "—"}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {/* Flagged (not written) — separate collapsible */}
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13, color: "var(--muted)" }}>
              Flagged for review — {changes.length - applied.length} not written (below threshold / non-visual / no image)
            </summary>
            <div className="scroll-x" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Sheet</th><th>SKU</th><th>Field</th><th>Status</th>
                    <th>Was</th><th>Suggested</th><th className="num">Conf.</th><th>Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.filter((c) => !c.applied).slice(0, 250).map((c, i) => (
                    <tr key={i}>
                      <td><small className="dim">{c.sheet || "—"}</small></td>
                      <td className="mono">{c.sku}</td>
                      <td>{c.column}</td>
                      <td><span className={"pill " + c.status}>{c.status}</span></td>
                      <td>{c.previousValue && String(c.previousValue).trim()
                        ? String(c.previousValue)
                        : <span className="pill missing">blank</span>}</td>
                      <td>{c.proposedValue ?? <small className="dim">—</small>}</td>
                      <td className="num">{c.confidence}%</td>
                      <td><small className="dim">{c.reasoning || "—"}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {results.some((p) => p.error) && (
            <div className="notice bad" style={{ marginTop: 12 }}>
              Some rows errored (unreachable image or API issue) and were left unchanged.
            </div>
          )}
        </div>
      )}
    </>
  );
}
