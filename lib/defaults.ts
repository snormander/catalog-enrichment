// Centralized defaults for the canonical generator. Applied only as a LAST
// resort (after seller / vision / text inference / consensus) and always
// tagged source:"default" with low confidence. Business-sensitive values
// (season, age band) live here so they're changed in one place.

import { MDD, normalizeValue } from "./referenceData";

export const DEFAULTS = {
  season: "SS26",
  ageBand: "18 - 45",
  occasion: "Daily",
  country: "India",
  weightGrams: "250",
  startDate: todayDDMMYYYY(),
  endDate: "31-12-2099",
};

function todayDDMMYYYY(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

const SIZE_CHART_SENTENCE = "Please check size chart table to know the exact size to be ordered";

function washCareFor(fabric: string): string {
  const f = fabric.toLowerCase();
  if (/silk|chiffon|georgette|satin/.test(f)) return "Dry clean recommended. Hand wash cold with mild detergent. Do not wring.";
  if (/linen/.test(f)) return "Machine wash cold on gentle cycle. Iron while damp. Do not bleach.";
  if (/wool|cashmere/.test(f)) return "Dry clean only. Do not wash. Store flat to retain shape.";
  if (/denim/.test(f)) return "Machine wash cold inside out with similar colours. Do not bleach. Tumble dry low.";
  return "Machine wash cold with similar colours. Do not bleach. Tumble dry low.";
}

// Resolve a default for an attribute that's still blank. `concept` is the
// normalized display name; `blob` is the row's text (used for wash care).
export function defaultFor(attrId: string, concept: string, blob: string, D: typeof DEFAULTS): string {
  const c = concept;
  // concept-specific known defaults
  if (c.includes("country") && c.includes("origin")) return D.country;
  if (c.includes("season")) return D.season;
  if (c.includes("age band")) return D.ageBand;
  if (c.includes("occasion")) return D.occasion;
  if (c === "multi pack" || c.includes("multi pack")) return "No";
  if (c.includes("net quantity") || c.includes("pack quantity") || c.includes("number of")) return "1";
  if (c.includes("weight")) return D.weightGrams;
  if (c.includes("warranty") && c.includes("type")) return "NA";
  if (c.includes("warranty")) return "0";
  if (c.includes("lead time")) return "0";
  if (c.includes("size chart") || c === "model fit") return SIZE_CHART_SENTENCE;
  if (c.includes("gst")) return "Yes";
  if (c.includes("dangerous")) return "No";
  if (c.includes("seller") && c.includes("status")) return "Yes";
  if (c.includes("platform")) return "Marketplace";
  if (c.includes("start date")) return D.startDate;
  if (c.includes("end date")) return D.endDate;
  if (c.includes("upload status") || c === "s or d") return "S";
  if (c.includes("wash")) return washCareFor(blob);
  if (c === "unisex") return "No";

  // generic LOV fallback: pick the most-general (first alphabetical) allowed value
  const allowed = MDD.lov[attrId];
  if (allowed && allowed.length) {
    // prefer a value that appears in the text, else the first
    const n = normalizeValue(blob);
    const hit = allowed.find((v) => n.includes(normalizeValue(v)));
    return hit || allowed[0];
  }

  // free-text mandatory with no signal — leave blank (caller may flag)
  return "";
}
