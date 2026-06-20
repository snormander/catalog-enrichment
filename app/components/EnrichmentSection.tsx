"use client";
import React, { useState } from "react";
import FileDrop from "./FileDrop";
import ReportCard from "./ReportCard";
import { normalizeWorkbook, tableToXlsxBlob } from "@/lib/lib2/parseWorkbook";
import { runEnrichment } from "@/lib/lib2/enrichClient";
import { evaluateAccuracy } from "@/lib/lib2/accuracy";
import { MODELS, costForUsage } from "@/lib/lib2/cost";
import { NormalizedTable, RunReport, ProductResult } from "@/lib/lib2/types";

export default function EnrichmentSection() {
  const [sellerName, setSellerName] = useState<string | null>(null);
  const [seller, setSeller] = useState<NormalizedTable | null>(null);
  const [goldenName, setGoldenName] = useState<string | null>(null);
  const [golden, setGolden] = useState<NormalizedTable | null>(null);

  const [model, setModel] = useState(MODELS[0].id);
  const [threshold, setThreshold] = useState(80);
  const [verify, setVerify] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<RunReport | null>(null);
  const [results, setResults] = useState<ProductResult[]>([]);
  const [enriched, setEnriched] = useState<NormalizedTable | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onSeller(file: File) {
    setErr(null); setReport(null);
    setSellerName(file.name);
    try { setSeller(await normalizeWorkbook(file)); }
    catch (e: any) { setErr("Seller file: " + e.message); }
  }
  async function onGolden(file: File) {
    setGoldenName(file.name);
    try { setGolden(await normalizeWorkbook(file)); }
    catch (e: any) { setErr("Golden file: " + e.message); }
  }

  async function run() {
    if (!seller) return;
    setBusy(true); setErr(null); setReport(null);
    setProgress({ done: 0, total: seller.rows.length });
    try {
      const out = await runEnrichment(seller, {
        model, threshold, verifyValidValues: verify,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResults(out.results);
      setEnriched(out.enriched);

      const cost = costForUsage(out.usage, model);
      const rep: RunReport = {
        fileName: sellerName || "seller.xlsx",
        model, threshold,
        productsProcessed: out.results.length,
        cellsScanned: out.cellsScanned,
        cellsWithIssues: out.cellsWithIssues,
        cellsApplied: out.cellsApplied,
        cellsFlagged: out.cellsFlagged,
        usage: out.usage,
        costUSD: cost.usd,
        costINR: cost.inr,
        generatedAt: new Date().toISOString(),
      };
      if (golden) rep.accuracy = evaluateAccuracy(golden, out.results);
      setReport(rep);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadEnriched() {
    if (!enriched) return;
    const blob = tableToXlsxBlob(enriched.headers, enriched.rows);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (sellerName?.replace(/\.[^.]+$/, "") || "seller") + "_enriched.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;

  return (
    <>
      <div className="card">
        <h2>2 · Enrich seller data</h2>
        <p className="hint">
          Upload a seller file in any layout — the tool finds the real header row, maps columns to the
          embedded MDD dictionary, then fills or fixes mandatory fields from the product image, applying
          a value only when the model’s confidence clears your threshold.
        </p>
        <div className="row">
          <div className="col"><FileDrop label="Seller data (to enrich)" onFile={onSeller} fileName={sellerName} /></div>
          <div className="col">
            <FileDrop label="Golden data — for accuracy" optional onFile={onGolden} fileName={goldenName}
              hint="Upload to score accuracy; skip to enrich only" />
          </div>
        </div>
      </div>

      <div className="card">
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
        <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          Re-verify already-valid visual fields against the image (more accurate, higher cost)
        </label>

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
        <button className="btn" disabled={!seller || busy} onClick={run}>
          {busy ? "Enriching…" : "Run enrichment"}
        </button>
      </div>

      {report && <ReportCard report={report} />}

      {enriched && (
        <div className="card">
          <div className="spread">
            <h2>Enriched output</h2>
            <button className="btn secondary" onClick={downloadEnriched}>Download enriched .xlsx</button>
          </div>
          <p className="hint">Per-field decisions for the first products in this run.</p>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>SKU</th><th>Field</th><th>Status</th><th>Was</th>
                  <th>Proposed</th><th className="num">Conf.</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {results.flatMap((p) =>
                  p.fields.map((f, i) => (
                    <tr key={p.rowNumber + "_" + f.attrId + i}>
                      <td className="mono">{i === 0 ? p.sku : ""}</td>
                      <td>{f.column}</td>
                      <td><span className={"pill " + f.status}>{f.status}</span></td>
                      <td>{f.previousValue ? String(f.previousValue) : <small className="dim">—</small>}</td>
                      <td>{f.proposedValue ?? <small className="dim">—</small>}</td>
                      <td className="num">{f.confidence}%</td>
                      <td>
                        <span className={"pill " + (f.applied ? "applied" : "flagged")}>
                          {f.applied ? "filled" : "flagged"}
                        </span>
                      </td>
                    </tr>
                  ))
                ).slice(0, 60)}
              </tbody>
            </table>
          </div>
          {results.some((p) => p.error) && (
            <div className="notice bad" style={{ marginTop: 12 }}>
              Some rows errored (e.g. unreachable image or API issue). They were left unchanged.
            </div>
          )}
        </div>
      )}
    </>
  );
}
