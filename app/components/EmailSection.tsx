"use client";
import React from "react";

export default function EmailSection() {
  return (
    <>
      <div className="coming-banner">
        <div>
          <h2>Fetch from Email</h2>
          <p>
            Automatically pull seller catalogue sheets straight from the inboxes sellers email them to —
            no manual downloads. Matching attachments are queued, enriched, and saved to the database.
          </p>
        </div>
        <span className="coming-chip">Coming soon</span>
      </div>

      {/* Mock of the planned UI, visually disabled */}
      <div className="card disabled-veil" aria-hidden>
        <span className="section-eyebrow">Connected inboxes</span>
        <div className="row" style={{ marginBottom: 18 }}>
          <div className="stat-chip"><span className="n">12</span><span className="l">Inboxes linked</span></div>
          <div className="stat-chip"><span className="n">37</span><span className="l">Sheets in queue</span></div>
          <div className="stat-chip"><span className="n">128</span><span className="l">Enriched today</span></div>
          <div className="stat-chip"><span className="n">4</span><span className="l">Needs review</span></div>
        </div>

        <span className="section-eyebrow">Inbound queue</span>
        <div className="gap" />
        <div className="mock-grid">
          {[
            { from: "vendor-supplies@gmail.com", subj: "Catalogue Upload – AW26 Women Tops", n: 2 },
            { from: "stylemart.seller@gmail.com", subj: "Catalogue Upload – Kurtas Batch 4", n: 1 },
            { from: "trendz.apparel@gmail.com", subj: "Catalogue Upload – Denim Restock", n: 3 },
            { from: "fab.fashion.in@gmail.com", subj: "Catalogue Upload – Dresses June", n: 1 },
          ].map((m, i) => (
            <div className="mock-mail" key={i}>
              <div className="from">{m.from}</div>
              <div className="subj">{m.subj}</div>
              <div className="att">📎 {m.n} .xlsx attached</div>
            </div>
          ))}
        </div>
        <div className="gap" />
        <div className="row">
          <div className="col">
            <label className="field">Trigger subject line</label>
            <input type="text" value="Catalogue Upload" readOnly />
          </div>
          <div className="col">
            <label className="field">Auto-enrich on arrival</label>
            <select disabled><option>On — using last run settings</option></select>
          </div>
          <div className="col" style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn" disabled>Connect a Gmail inbox</button>
          </div>
        </div>
      </div>

      {/* Flowchart explaining the planned pipeline */}
      <div className="card">
        <span className="section-eyebrow">How it will work</span>
        <h2>Planned pipeline</h2>
        <p className="hint">From seller email to enriched record in the database — fully automated.</p>
        <div className="scroll-x" style={{ border: "none", overflowX: "auto" }}>
          <EmailFlow />
        </div>
      </div>
    </>
  );
}

function EmailFlow() {
  // Self-contained SVG flow using the Tata CLiQ gradient.
  return (
    <svg viewBox="0 0 1230 280" width="100%" style={{ minWidth: 1000, maxWidth: 1230 }}
      xmlns="http://www.w3.org/2000/svg" fontFamily="Inter, system-ui, sans-serif">
      <defs>
        <linearGradient id="cliqGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e6177f" />
          <stop offset="0.5" stopColor="#7b2ff7" />
          <stop offset="1" stopColor="#2b6fe6" />
        </linearGradient>
        <marker id="fa" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="#b3209f" />
        </marker>
      </defs>

      {[
        { x: 20, t: "Seller emails", d: "10–15 Gmail inboxes receive seller sheets", icon: "✉" },
        { x: 262, t: "Filter by subject", d: "Match the trigger subject line", icon: "⌕" },
        { x: 504, t: "Extract attachment", d: "Pull .xlsx / .csv into a queue", icon: "▤" },
        { x: 746, t: "Auto-enrich", d: "Run the enrichment engine per sheet", icon: "✦" },
        { x: 988, t: "Save to database", d: "Store enriched records + audit", icon: "▥" },
      ].map((s, i) => (
        <g key={i}>
          <rect x={s.x} y={66} width={212} height={138} rx={14} fill="#fff"
            stroke="#e7e3ef" strokeWidth={1.5} />
          <rect x={s.x} y={66} width={212} height={5} rx={2.5} fill="url(#cliqGrad)" />
          <circle cx={s.x + 32} cy={104} r={16} fill="#f7e7f3" />
          <text x={s.x + 32} y={110} textAnchor="middle" fontSize="16" fill="#b3209f">{s.icon}</text>
          <foreignObject x={s.x + 54} y={86} width={148} height={44}>
            <div style={{ fontSize: 13.5, fontWeight: 650, color: "#241d3a", lineHeight: 1.2 }}>{s.t}</div>
          </foreignObject>
          <foreignObject x={s.x + 16} y={134} width={182} height={60}>
            <div style={{ fontSize: 11.5, color: "#6b6480", lineHeight: 1.35 }}>{s.d}</div>
          </foreignObject>
          {i < 4 && (
            <line x1={s.x + 212} y1={130} x2={s.x + 250} y2={130}
              stroke="#b3209f" strokeWidth={2} markerEnd="url(#fa)" />
          )}
        </g>
      ))}
      <text textAnchor="middle" fontSize="11.5" fill="#6b6480">
        <tspan x={615} y={244}>Sheets flagged as low-confidence during enrichment are routed to</tspan>
        <tspan x={615} y={262}>“Needs review” instead of being saved automatically.</tspan>
      </text>
    </svg>
  );
}
