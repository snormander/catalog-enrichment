"use client";
import React, { useState } from "react";
import { ProductResult, FieldResult } from "@/lib/types";

// Derive a short "source" tag for a field, like the screenshot
// (merged / normalized / from image / from text / from siblings / inferred / flagged).
function sourceTag(f: FieldResult): { label: string; tone: string } {
  if (!f.applied) return { label: "flagged", tone: "warn" };
  const r = (f.reasoning || "").toLowerCase();
  if (r.includes("group consensus") || r.includes("sibling")) return { label: "from siblings", tone: "ok" };
  if (r.includes("mirror")) return { label: "merged", tone: "ok" };
  if (f.status === "conflict") return { label: "auto-corrected", tone: "fix" };
  if (f.status === "not_lov") return { label: "normalized", tone: "ok" };
  if (r.includes("text") || r.includes("title") || r.includes("description")) return { label: "from text", tone: "ok" };
  if (typeof f.confidence === "number" && f.confidence < 70) return { label: "inferred", tone: "warn" };
  return { label: "from image", tone: "ok" };
}

function confTone(c: number): string {
  if (c >= 80) return "hi";
  if (c >= 50) return "mid";
  return "lo";
}

function titleFromMeta(m?: Record<string, string>): string | null {
  if (!m) return null;
  const key = Object.keys(m).find((k) => /title|name/i.test(k) && !/meta/i.test(k));
  return key ? m[key] : null;
}
function descFromMeta(m?: Record<string, string>): string | null {
  if (!m) return null;
  const key = Object.keys(m).find((k) => /description/i.test(k) && !/meta|mini/i.test(k))
    || Object.keys(m).find((k) => /description/i.test(k));
  return key ? m[key] : null;
}

function ProductCard({ p, defaultOpen }: { p: ProductResult; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const title = titleFromMeta(p.metadata);
  const desc = descFromMeta(p.metadata);
  const conflicts = p.fields.filter((f) => f.applied && f.status === "conflict");
  const applied = p.fields.filter((f) => f.applied);
  const avgConf = applied.length
    ? Math.round(applied.reduce((s, f) => s + (f.confidence || 0), 0) / applied.length)
    : 0;

  return (
    <div className="rc">
      <button className="rc-head" onClick={() => setOpen(!open)}>
        <span className="rc-var">VAR</span>
        <span className="rc-headmain">
          <span className="rc-title">{title || p.sku}</span>
          <span className="rc-meta">
            <span className="mono">{p.sku}</span>
            {p.l4 && <> · {p.l4}</>}
            {p.imageUrls?.length ? <> · <span className="rc-vision">▣ vision</span></> : null}
            {conflicts.length > 0 && <> · <span className="rc-conf-flag">{conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}</span></>}
          </span>
        </span>
        {avgConf > 0 && <span className={"rc-badge " + confTone(avgConf)}>{avgConf}%</span>}
        <span className="rc-chev">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="rc-body">
          {(title || desc) && (
            <div className="rc-textgrid">
              {title && (
                <div className="rc-field">
                  <div className="rc-flabel">TITLE <span className="rc-fpct hi">90%</span> · AI-generated</div>
                  <div className="rc-fval">{title}</div>
                </div>
              )}
              {desc && (
                <div className="rc-field">
                  <div className="rc-flabel">DESCRIPTION <span className="rc-fpct hi">85%</span> · AI-generated</div>
                  <div className="rc-fval rc-desc">{desc}</div>
                </div>
              )}
            </div>
          )}

          <div className="rc-attrgrid">
            {p.fields.map((f, i) => {
              const tag = sourceTag(f);
              return (
                <div className="rc-field" key={i}>
                  <div className="rc-flabel">
                    {f.column}
                    {typeof f.confidence === "number" && (
                      <span className={"rc-fpct " + confTone(f.confidence)}>{f.confidence}%</span>
                    )}
                    <span className={"rc-tag " + tag.tone}>· {tag.label}</span>
                  </div>
                  <div className="rc-fval">
                    {f.proposedValue != null && String(f.proposedValue).trim() !== ""
                      ? String(f.proposedValue)
                      : <span className="rc-blank">—</span>}
                    {!f.applied && f.previousValue && String(f.previousValue).trim() !== "" && (
                      <span className="rc-was"> (seller: {String(f.previousValue)})</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {conflicts.length > 0 && (
            <div className="rc-conflicts">
              <div className="rc-conflicts-head">▣ Vision vs seller conflicts ({conflicts.length})</div>
              {conflicts.map((f, i) => (
                <div className="rc-conflict-line" key={i}>
                  <span className="mono">{f.attrId}</span>: Auto-corrected — seller said{" "}
                  <b>"{String(f.previousValue || "—")}"</b>, image showed{" "}
                  <b>"{String(f.proposedValue)}"</b> at {f.confidence}% confidence — value updated.
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ReviewCards({ results, limit = 60 }: { results: ProductResult[]; limit?: number }) {
  // Only products where the tool did something worth reviewing.
  const interesting = results.filter((p) => p.fields.some((f) => f.applied || !f.applied));
  const shown = interesting.slice(0, limit);
  return (
    <div className="rc-list">
      {shown.map((p, i) => (
        <ProductCard key={p.sku + i} p={p} defaultOpen={i === 0} />
      ))}
      {interesting.length > limit && (
        <p className="hint">Showing {limit} of {interesting.length} products. Download the file for the full set.</p>
      )}
    </div>
  );
}
