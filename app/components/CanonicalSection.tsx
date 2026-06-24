"use client";
import React, { useState } from "react";
import FileDrop from "./FileDrop";
import { normalizeAllSheets } from "@/lib/parseWorkbook";
import { runCanonical, GenReport, GenRow } from "@/lib/generate";
import { canonicalToBlob } from "@/lib/outputCanonical";
import { MODELS, costForUsage } from "@/lib/cost";
import { NormalizedTable } from "@/lib/types";

export default function CanonicalSection() {
  const [sellerName, setSellerName] = useState<string | null>(null);
  const [sheets, setSheets] = useState<NormalizedTable[]>([]);
  const [model, setModel] = useState(MODELS[0].id);
  const [conflictThreshold, setConflictThreshold] = useState(80);
  const [maxImages, setMaxImages] = useState(3);
  const [rpm, setRpm] = useState(10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<GenReport | null>(null);
  const [rows, setRows] = useState<GenRow[]>([]);
  const [cost, setCost] = useState<number | null>(null);

  async function onSeller(file: File) {
    setErr(null); setReport(null); setRows([]);
    try {
      const tables = await normalizeAllSheets(file);
      setSheets(tables); setSellerName(file.name);
    } catch (e: any) { setErr(e?.message || "Could not read file"); }
  }

  async function run() {
    if (!sheets.length) { setErr("Upload a seller sheet first."); return; }
    setBusy(true); setErr(null); setReport(null); setRows([]); setCost(null);
    try {
      const table = sheets[0];
      const { rows, report, usage } = await runCanonical(table, {
        model, conflictThreshold, maxImages, requestsPerMinute: rpm,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setRows(rows); setReport(report);
      setCost(costForUsage(usage, model).usd);
    } catch (e: any) {
      setErr(e?.message || "Generation failed");
    } finally { setBusy(false); }
  }

  function download() {
    if (!rows.length) return;
    const blob = canonicalToBlob(rows);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (sellerName?.replace(/\.[^.]+$/, "") || "seller") + "_canonical.xlsx";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const filledTotal = report
    ? report.filledDefaultMandatory + report.filledDefaultOptional +
      report.filledInferredMandatory + report.filledInferredOptional +
      report.filledImageMandatory + report.filledImageOptional +
      report.filledGeneratedMandatory
    : 0;

  return (
    <section className="card">
      <h2>100% Canonical Fill</h2>
      <p className="dim" style={{ marginTop: -4 }}>
        Produces an MDD-canonical sheet — every mandatory field present and filled, split into per-L4 tabs.
        One AI call per <strong>style code</strong> (sizes share the call); values cascade seller → image → inferred → default,
        each tagged with its source &amp; confidence. Defaults and generated copy are assumptions, clearly labelled for review.
      </p>

      <div className="row">
        <FileDrop label="Seller sheet" onFile={onSeller} fileName={sellerName} />
      </div>

      <div className="gap" />
      <div className="row">
        <div className="col">
          <label className="field">Model</label>
          <select className="text-input" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="col">
          <label className="field">Conflict confidence — {conflictThreshold}%</label>
          <div className="slider-row">
            <input type="range" min={0} max={100} value={conflictThreshold} onChange={(e) => setConflictThreshold(+e.target.value)} />
            <span className="slider-val">{conflictThreshold}%</span>
          </div>
          <small className="dim">Above this, image overrides a seller value (logged as changed); below, it's kept and flagged.</small>
        </div>
        <div className="col">
          <label className="field">Images per style — {maxImages}</label>
          <div className="slider-row">
            <input type="range" min={1} max={5} value={maxImages} onChange={(e) => setMaxImages(+e.target.value)} />
            <span className="slider-val">{maxImages}</span>
          </div>
        </div>
        <div className="col">
          <label className="field">Max requests / min — {rpm === 0 ? "∞" : rpm}</label>
          <div className="slider-row">
            <input type="range" min={0} max={60} value={rpm} onChange={(e) => setRpm(+e.target.value)} />
            <span className="slider-val">{rpm === 0 ? "∞" : rpm}</span>
          </div>
        </div>
      </div>

      <div className="gap" />
      <div className="row">
        <button className="btn" onClick={run} disabled={busy || !sheets.length}>
          {busy ? `Generating… ${progress.done}/${progress.total} style codes` : "Generate 100% sheet"}
        </button>
        {rows.length > 0 && <button className="btn secondary" onClick={download}>Download canonical .xlsx</button>}
      </div>

      {err && <p className="error">{err}</p>}

      {report && (
        <>
          <div className="gap" />
          <div className="report-grid">
            <Stat label="Rows" value={report.totalRows} />
            <Stat label="Unique style codes (options)" value={report.uniqueStyleCodes} />
            <Stat label="AI calls (per style code)" value={report.apiCalls} />
            <Stat label="Missing fields filled" value={filledTotal} />
            <Stat label="Conflicts changed" value={report.conflictsChanged} />
            <Stat label="Conflicts flagged" value={report.conflictsFlagged} />
            {cost != null && <Stat label="Est. cost" value={`$${cost.toFixed(4)}`} />}
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
        </>
      )}
    </section>
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
