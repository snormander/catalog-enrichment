"use client";
import React from "react";
import { RunReport } from "@/lib/types";
import { labelFor } from "@/lib/referenceData";

export default function ReportCard({ report }: { report: RunReport }) {
  const acc = report.accuracy;
  return (
    <div className="card">
      <div className="spread">
        <h2>Report — {report.fileName}</h2>
        <small className="dim mono">{new Date(report.generatedAt).toLocaleString()}</small>
      </div>
      <p className="hint">
        Model <b>{report.model}</b> · confidence threshold <b>{report.threshold}%</b>
      </p>

      <div className="metrics">
        <div className="metric"><div className="k">Products</div><div className="v">{report.productsProcessed}</div></div>
        <div className="metric"><div className="k">Cells scanned</div><div className="v">{report.cellsScanned}</div></div>
        <div className="metric warn"><div className="k">Issues found</div><div className="v">{report.cellsWithIssues}</div></div>
        <div className="metric ok"><div className="k">Auto-filled</div><div className="v">{report.cellsApplied}</div></div>
        <div className="metric"><div className="k">Flagged for review</div><div className="v">{report.cellsFlagged}</div></div>
      </div>

      <div className="gap" />
      <div className="metrics">
        <div className="metric accent">
          <div className="k">Input tokens</div>
          <div className="v">{report.usage.inputTokens.toLocaleString()}</div>
        </div>
        <div className="metric accent">
          <div className="k">Output tokens</div>
          <div className="v">{report.usage.outputTokens.toLocaleString()}</div>
        </div>
        <div className="metric">
          <div className="k">Est. cost (USD)</div>
          <div className="v">${report.costUSD.toFixed(4)}</div>
        </div>
        <div className="metric">
          <div className="k">Est. cost (INR)</div>
          <div className="v">₹{report.costINR.toFixed(2)}</div>
        </div>
        <div className="metric">
          <div className="k">Cost / product</div>
          <div className="v">₹{report.productsProcessed ? (report.costINR / report.productsProcessed).toFixed(3) : "0"}</div>
        </div>
      </div>

      {acc ? (
        <>
          <div className="gap" />
          <h2 style={{ fontSize: 14 }}>Accuracy vs golden</h2>
          <div className="metrics">
            <div className={"metric " + (acc.accuracy >= 0.8 ? "ok" : acc.accuracy >= 0.5 ? "warn" : "bad")}>
              <div className="k">Accuracy</div>
              <div className="v">{(acc.accuracy * 100).toFixed(1)}<small>%</small></div>
            </div>
            <div className="metric"><div className="k">Cells scored</div><div className="v">{acc.evaluated}</div></div>
            <div className="metric ok"><div className="k">Correct</div><div className="v">{acc.correct}</div></div>
            <div className="metric bad"><div className="k">Wrong</div><div className="v">{acc.evaluated - acc.correct}</div></div>
            <div className="metric"><div className="k">Rows unmatched</div><div className="v">{acc.unmatchedRows}</div></div>
          </div>

          {Object.keys(acc.perAttribute).length > 0 && (
            <div className="scroll-x" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr><th>Attribute</th><th className="num">Correct</th><th className="num">Total</th><th>Accuracy</th></tr>
                </thead>
                <tbody>
                  {Object.entries(acc.perAttribute).map(([aid, s]) => {
                    const pct = s.total ? (s.correct / s.total) : 0;
                    return (
                      <tr key={aid}>
                        <td>{labelFor(aid)} <small className="dim mono">{aid}</small></td>
                        <td className="num">{s.correct}</td>
                        <td className="num">{s.total}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div className="bar"><span style={{ width: `${pct * 100}%` }} /></div>
                            <span className="mono">{(pct * 100).toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="notice info" style={{ marginTop: 16 }}>
          No golden sheet uploaded — accuracy scoring skipped. Token usage and cost still apply.
        </div>
      )}
    </div>
  );
}
