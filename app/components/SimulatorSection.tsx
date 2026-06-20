"use client";
import React, { useState } from "react";
import FileDrop from "./FileDrop";
import { normalizeWorkbook, tableToXlsxBlob } from "@/lib/lib2/parseWorkbook";
import { simulateIncorrect, SimResult } from "@/lib/lib2/simulate";
import { NormalizedTable } from "@/lib/lib2/types";

export default function SimulatorSection() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [golden, setGolden] = useState<NormalizedTable | null>(null);
  const [missingPct, setMissingPct] = useState(35);
  const [conflictPct, setConflictPct] = useState(8);
  const [result, setResult] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(file: File) {
    setErr(null); setResult(null);
    setFileName(file.name);
    try {
      const t = await normalizeWorkbook(file);
      setGolden(t);
    } catch (e: any) {
      setErr("Could not read file: " + e.message);
    }
  }

  function run() {
    if (!golden) return;
    setBusy(true);
    try {
      const r = simulateIncorrect(golden, { missingPct, conflictPct, seed: 42 });
      setResult(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!result) return;
    const blob = tableToXlsxBlob(result.table.headers, result.table.rows);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (fileName?.replace(/\.[^.]+$/, "") || "seller") + "_incorrect.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  const missingCount = result?.changeLog.filter((c) => c.action === "missing").length || 0;
  const conflictCount = result?.changeLog.filter((c) => c.action === "conflict").length || 0;

  return (
    <>
      <div className="card">
        <h2>1 · Build incorrect seller data</h2>
        <p className="hint">
          Upload the corrected golden sheet. The simulator degrades it to mimic real seller files —
          blanking mandatory attributes (missing) and swapping some to image-conflicting values (wrong) —
          using the rates from the problem brief.
        </p>
        <FileDrop label="Golden (corrected) sheet" onFile={onFile} fileName={fileName} />

        <div className="gap" />
        <div className="row">
          <div className="col">
            <label className="field">Missing rate — {missingPct}%</label>
            <div className="slider-row">
              <input type="range" min={0} max={60} value={missingPct}
                onChange={(e) => setMissingPct(+e.target.value)} />
              <span className="slider-val">{missingPct}%</span>
            </div>
            <small className="dim">Brief: 30–40% of mandatory attributes missing</small>
          </div>
          <div className="col">
            <label className="field">Conflicting rate — {conflictPct}%</label>
            <div className="slider-row">
              <input type="range" min={0} max={30} value={conflictPct}
                onChange={(e) => setConflictPct(+e.target.value)} />
              <span className="slider-val">{conflictPct}%</span>
            </div>
            <small className="dim">Brief: 5–10% conflict with the product image</small>
          </div>
        </div>

        <div className="gap" />
        {err && <div className="notice bad">{err}</div>}
        <button className="btn" disabled={!golden || busy} onClick={run}>
          {busy ? "Generating…" : "Generate incorrect sheet"}
        </button>
      </div>

      {result && (
        <div className="card">
          <div className="spread">
            <h2>Degraded sheet ready</h2>
            <button className="btn secondary" onClick={download}>Download .xlsx</button>
          </div>
          <div className="gap" />
          <div className="metrics">
            <div className="metric"><div className="k">Rows</div><div className="v">{result.table.rows.length}</div></div>
            <div className="metric bad"><div className="k">Cells blanked</div><div className="v">{missingCount}</div></div>
            <div className="metric warn"><div className="k">Cells corrupted</div><div className="v">{conflictCount}</div></div>
            <div className="metric"><div className="k">Total edits</div><div className="v">{result.changeLog.length}</div></div>
          </div>
          <p className="hint" style={{ marginTop: 16 }}>
            Feed this file into the Enrichment tab. Keep the golden sheet too — upload it there as the
            optional ground-truth to score accuracy.
          </p>
        </div>
      )}
    </>
  );
}
