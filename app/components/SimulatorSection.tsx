"use client";
import React, { useState } from "react";
import FileDrop from "./FileDrop";
import { normalizeAllSheets, tablesToXlsxBlob } from "@/lib/parseWorkbook";
import { simulateIncorrect } from "@/lib/simulate";
import { NormalizedTable } from "@/lib/types";

export default function SimulatorSection() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [goldenSheets, setGoldenSheets] = useState<NormalizedTable[]>([]);
  const [missingPct, setMissingPct] = useState(35);
  const [conflictPct, setConflictPct] = useState(8);
  const [degraded, setDegraded] = useState<NormalizedTable[] | null>(null);
  const [stats, setStats] = useState({ rows: 0, missing: 0, conflict: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(file: File) {
    setErr(null); setDegraded(null);
    setFileName(file.name);
    try {
      const sheets = await normalizeAllSheets(file);
      if (!sheets.length) { setErr("No product rows found in that file."); return; }
      setGoldenSheets(sheets);
    } catch (e: any) {
      setErr("Could not read file: " + e.message);
    }
  }

  function run() {
    if (!goldenSheets.length) return;
    setBusy(true);
    try {
      const outTables: NormalizedTable[] = [];
      let rows = 0, missing = 0, conflict = 0;
      for (const sheet of goldenSheets) {
        const r = simulateIncorrect(sheet, { missingPct, conflictPct, seed: 42 });
        outTables.push(r.table);
        rows += r.table.rows.length;
        missing += r.changeLog.filter((c) => c.action === "missing").length;
        conflict += r.changeLog.filter((c) => c.action === "conflict").length;
      }
      setDegraded(outTables);
      setStats({ rows, missing, conflict });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!degraded) return;
    const blob = tablesToXlsxBlob(degraded); // schema preserved
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (fileName?.replace(/\.[^.]+$/, "") || "seller") + "_incorrect.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="card">
        <span className="section-eyebrow">Test data generator</span>
        <h2>Build incorrect seller data</h2>
        <p className="hint">
          Upload the corrected golden sheet. The simulator degrades it to mimic real seller files —
          blanking mandatory attributes (missing) and swapping some to image-conflicting values (wrong) —
          using the rates from the problem brief. Every sheet and the original schema are preserved.
        </p>
        <FileDrop label="Golden (corrected) sheet" onFile={onFile} fileName={fileName} />
        {goldenSheets.length > 0 && (
          <p className="hint" style={{ marginTop: 12 }}>
            Detected {goldenSheets.length} sheet{goldenSheets.length > 1 ? "s" : ""}:{" "}
            {goldenSheets.map((s) => `${s.sheetName || "Sheet"} (${s.rows.length})`).join(", ")}
          </p>
        )}

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
        <button className="btn" disabled={!goldenSheets.length || busy} onClick={run}>
          {busy ? "Generating…" : "Generate incorrect sheet"}
        </button>
      </div>

      {degraded && (
        <div className="card">
          <div className="spread">
            <h2>Degraded sheet ready</h2>
            <button className="btn secondary" onClick={download}>Download .xlsx</button>
          </div>
          <div className="gap" />
          <div className="metrics">
            <div className="metric"><div className="k">Sheets</div><div className="v">{degraded.length}</div></div>
            <div className="metric"><div className="k">Rows</div><div className="v">{stats.rows}</div></div>
            <div className="metric bad"><div className="k">Cells blanked</div><div className="v">{stats.missing}</div></div>
            <div className="metric warn"><div className="k">Cells corrupted</div><div className="v">{stats.conflict}</div></div>
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
