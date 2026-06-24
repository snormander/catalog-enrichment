"use client";
import React, { useState } from "react";
import FileDrop from "./FileDrop";
import { normalizeAllSheets } from "@/lib/parseWorkbook";
import { runCanonical, GenReport, GenRow } from "@/lib/generate";
import { canonicalToBlob } from "@/lib/outputCanonical";
import { genRowsToResults, evaluateCanonical, CanonicalAccuracy } from "@/lib/canonicalAdapt";
import ReviewCards from "./ReviewCards";
import { MODELS, costForUsage } from "@/lib/cost";
import { NormalizedTable, ProductResult } from "@/lib/types";

export default function EnrichmentSection() {
  const [sellerName, setSellerName] = useState<string | null>(null);
  const [sellerSheets, setSellerSheets] = useState<NormalizedTable[]>([]);
  const [goldenName, setGoldenName] = useState<string | null>(null);
  const [goldenSheets, setGoldenSheets] = useState<NormalizedTable[]>([]);

  const [model, setModel] = useState(MODELS[0].id);
  const [conflictThreshold, setConflictThreshold] = useState(80);
  const [maxImages, setMaxImages] = useState(3);
  const [rpm, setRpm] = useState(10);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<GenReport | null>(null);
  const [accuracy, setAccuracy] = useState<CanonicalAccuracy | null>(null);
  const [cost, setCost] = useState<{ usd: number; inr: number } | null>(null);
  const [rows, setRows] = useState<GenRow[]>([]);
  const [results, setResults] = useState<ProductResult[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function onSeller(file: File) {
    setErr(null); setReport(null); setRows([]); setResults([]); setAccuracy(null);
    setSellerName(file.name);
    try {
      const sheets = await normalizeAllSheets(file);
      if (!sheets.length) { setErr("No product rows found in that file."); return; }
      setSellerSheets(sheets);
    } catch (e: any) { setErr("Seller file: " + (e?.message || e)); }
  }
  async function onGolden(file: File) {
    setGoldenName(file.name);
    try { setGoldenSheets(await normalizeAllSheets(file)); }
    catch (e: any) { setErr("Golden file: " + (e?.message || e)); }
  }

  function mergedGolden(): NormalizedTable | null {
    if (!goldenSheets.length) return null;
    return { ...goldenSheets[0], rows: goldenSheets.flatMap((s) => s.rows) };
  }

  async function run() {
    if (!sellerSheets.length) return;
    setBusy(true); setErr(null); setReport(null); setRows([]); setResults([]); setAccuracy(null); setCost(null);
    setProgress({ done: 0, total: sellerSheets[0].rows.length });
    try {
      // Process the first (primary) data sheet; combined templates carry all
      // categories in one sheet anyway, and the generator splits by L4 on output.
      const table = sellerSheets[0];
      const { rows, report, usage } = await runCanonical(table, {
        model, conflictThreshold, maxImages, requestsPerMinute: rpm,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (!rows.length) { setErr("The generator produced no rows — check the file has data rows below the header block."); return; }
      setRows(rows);
      setResults(genRowsToResults(rows));
      setReport(report);
      setCost(costForUsage(usage, model));
      const g = mergedGolden();
      if (g) setAccuracy(evaluateCanonical(g, rows));
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!rows.length) return;
    const blob = canonicalToBlob(rows);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (sellerName?.replace(/\.[^.]+$/, "") || "seller") + "_enriched.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;
  const filledTotal = report
    ? report.filledImageMandatory + report.filledImageOptional +
      report.filledInferredMandatory + report.filledInferredOptional +
      report.filledDefaultMandatory + report.filledDefaultOptional +
      report.filledGeneratedMandatory
    : 0;

  return (
    <>
      <div className="card">
        <span className="section-eyebrow">Step 1 · Enrich</span>
        <h2>Enrich seller data</h2>
        <p className="hint">
          Upload a seller file in any layout. Every product is classified to its L4 category and returned in the
          MDD-canonical schema — every mandatory field present and filled, split into per-L4 tabs. One AI call per
          <strong> style code</strong> (sizes share the call); each value carries a source &amp; confidence tag.
          Upload a corrected sheet in the same schema to score accuracy.
        </p>
        <div className="row">
          <div className="col"><FileDrop label="Seller data (to enrich)" onFile={onSeller} fileName={sellerName} /></div>
          <div className="col">
            <FileDrop label="Golden data — for accuracy" optional onFile={onGolden} fileName={goldenName}
              hint="Upload a corrected sheet (same schema) to score accuracy; skip to enrich only" />
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
                <option key={m.id} value={m.id}>{m.label} — ${m.inputPerM}/${m.outputPerM} per 1M</option>
              ))}
            </select>
          </div>
          <div className="col">
            <label className="field">Conflict confidence — {conflictThreshold}%</label>
            <div className="slider-row">
              <input type="range" min={0} max={100} value={conflictThreshold}
                onChange={(e) => setConflictThreshold(+e.target.value)} />
              <span className="slider-val">{conflictThreshold}%</span>
            </div>
            <small className="dim">Above this, the image overrides a seller value (logged as changed); below, the seller value is kept and the disagreement is flagged. Blank fields are always filled.</small>
          </div>
        </div>
        <div className="gap" />
        <div className="row">
          <div className="col">
            <label className="field">Images per style — {maxImages}</label>
            <div className="slider-row">
              <input type="range" min={1} max={5} value={maxImages}
                onChange={(e) => setMaxImages(+e.target.value)} />
              <span className="slider-val">{maxImages}</span>
            </div>
            <small className="dim">Image links sent per style code. More angles can help, but cost more input tokens.</small>
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
        </div>

        <div className="gap" />
        {err && <div className="notice bad">{err}</div>}
        {busy && (
          <div style={{ marginBottom: 14 }}>
            <div className="spread" style={{ marginBottom: 6 }}>
              <small className="dim">Processing style codes…</small>
              <small className="mono">{progress.done}/{progress.total}</small>
            </div>
            <div className="progress"><span style={{ width: `${pct}%` }} /></div>
          </div>
        )}
        <button className="btn" disabled={!sellerSheets.length || busy} onClick={run}>
          {busy ? `Enriching… ${progress.done}/${progress.total}` : "Run enrichment"}
        </button>
      </div>

      {report && (
        <div className="card">
          <span className="section-eyebrow">Report</span>
          <h2>Enrichment summary</h2>
          <div className="report-grid">
            <Stat label="Rows" value={report.totalRows} />
            <Stat label="Unique style codes (options)" value={report.uniqueStyleCodes} />
            <Stat label="AI calls (per style code)" value={report.apiCalls} />
            <Stat label="Missing fields filled" value={filledTotal} />
            <Stat label="Conflicts changed" value={report.conflictsChanged} />
            <Stat label="Conflicts flagged" value={report.conflictsFlagged} />
            {cost && <Stat label="Est. cost" value={`$${cost.usd.toFixed(4)}`} />}
            {accuracy && <Stat label="Accuracy" value={`${(accuracy.accuracy * 100).toFixed(1)}%`} />}
          </div>

          <div className="gap" />
          <h3>Missing-field fills — by source × requirement</h3>
          <table className="mini-table">
            <thead><tr><th>Source</th><th>Mandatory</th><th>Optional</th></tr></thead>
            <tbody>
              <tr><td>From image</td><td>{report.filledImageMandatory}</td><td>{report.filledImageOptional}</td></tr>
              <tr><td>Inferred (text)</td><td>{report.filledInferredMandatory}</td><td>{report.filledInferredOptional}</td></tr>
              <tr><td>Default</td><td>{report.filledDefaultMandatory}</td><td>{report.filledDefaultOptional}</td></tr>
              <tr><td>Generated copy</td><td>{report.filledGeneratedMandatory}</td><td>—</td></tr>
            </tbody>
          </table>

          {accuracy && (
            <>
              <div className="gap" />
              <h3>Accuracy vs corrected sheet — {accuracy.correct}/{accuracy.evaluated} fields correct</h3>
              <small className="dim">Scored only on fields present in your corrected sheet, matched by SKU and attribute.</small>
            </>
          )}

          <div className="gap" />
          <h3>Rows by L4 category</h3>
          <table className="mini-table">
            <thead><tr><th>L4</th><th>Rows</th></tr></thead>
            <tbody>
              {Object.entries(report.byL4).sort((a, b) => b[1] - a[1]).map(([l4, n]) => (
                <tr key={l4}><td>{l4}</td><td>{n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="spread">
            <h2>Enriched output</h2>
            <button className="btn secondary" onClick={download}>Download enriched .xlsx</button>
          </div>
          <p className="hint">
            Canonical MDD schema, split into a Main tab plus one tab per L4, with _source and _confidence columns.
          </p>
          <details open style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 650, fontSize: 13.5, color: "var(--accent)" }}>
              Review — {results.length} product{results.length === 1 ? "" : "s"} (click to expand)
            </summary>
            <p className="hint" style={{ marginTop: 10 }}>
              Each product shows its filled attributes with confidence and how each value was derived
              (image / text / default / generated / siblings). Flagged conflicts show the seller's original in brackets.
            </p>
            <ReviewCards results={results} />
          </details>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-val">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
