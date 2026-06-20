// Loads the embedded MDD LOV + golden schema and exposes helpers.
// The MDD file is baked in here so the backend never re-parses Excel at runtime.

import mddLovJson from "@/data/mdd_lov.json";
import schemaJson from "@/data/golden_schema.json";
import { SchemaColumn } from "./types";

interface MddLov {
  attributeNames: Record<string, string>;
  lov: Record<string, string[]>;
}

export const MDD: MddLov = mddLovJson as MddLov;
export const SCHEMA: SchemaColumn[] = schemaJson as SchemaColumn[];

// Mandatory columns that are constrained by an MDD LOV list — these are the
// fields the tool validates and can auto-fill from the image.
export const MANDATORY_LOV_COLUMNS: SchemaColumn[] = SCHEMA.filter(
  (c) => c.mandatory && c.attrId && MDD.lov[c.attrId]
);

// Subset that is genuinely determinable by looking at a product photo.
// Used to nudge the model; non-visual attrs still get processed but should
// receive low confidence and therefore get flagged rather than auto-filled.
export const VISUAL_ATTR_IDS = new Set<string>([
  "womencasualtopwearsleeve",
  "womentopwearfit",
  "womencasualtopwearneckcollar",
  "occasion",
  "colorfamilyapparel",
  "dresslength",
  "womenpattern",
  "womenfabric",
]);

export function allowedValuesFor(attrId: string): string[] {
  return MDD.lov[attrId] || [];
}

export function isLovValid(attrId: string, value: any): boolean {
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  const list = MDD.lov[attrId];
  if (!list) return true; // free-text attribute: any non-empty value is acceptable
  return list.some((opt) => opt.trim().toLowerCase() === v);
}

export function labelFor(attrId: string): string {
  return MDD.attributeNames[attrId] || attrId;
}

// ---- Synonym map: common seller header variants -> schema attrId ----
// Used when an uploaded file is NOT in the golden #ATTR format and we must
// guess which column means what. Keys are normalized (lowercase, no spaces).
export const HEADER_SYNONYMS: Record<string, string> = {
  sleeve: "womencasualtopwearsleeve",
  sleeves: "womencasualtopwearsleeve",
  sleevelength: "womencasualtopwearsleeve",
  sleevetype: "womencasualtopwearsleeve",
  fit: "womentopwearfit",
  fittype: "womentopwearfit",
  neck: "womencasualtopwearneckcollar",
  collar: "womencasualtopwearneckcollar",
  neckline: "womencasualtopwearneckcollar",
  neckcollar: "womencasualtopwearneckcollar",
  occasion: "occasion",
  pattern: "womenpattern",
  print: "womenpattern",
  fabric: "fabricapparel",
  fabricfamily: "womenfabric",
  material: "fabricapparel",
  size: "womencasualtopwearsize",
  ageband: "ageband",
  age: "ageband",
  colorfamily: "colorfamilyapparel",
  colourfamily: "colorfamilyapparel",
  color: "colorapparel",
  colour: "colorapparel",
  dresslength: "dresslength",
  length: "dresslength",
  multipack: "multipack",
  brand: "brand",
};

// Identify SKU + image columns by name (normalized).
export const SKU_HEADER_KEYS = [
  "sellerarticlesku",
  "sku",
  "skucode",
  "articlesku",
  "stylecode",
  "articlecode",
];

export function normalizeHeader(h: string): string {
  return String(h || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")        // drop "(Refer LOV List)" etc.
    .replace(/\[.*?\]/g, "")        // drop "[cm]" etc.
    .replace(/[^a-z0-9]/g, "")      // strip spaces/punct
    .trim();
}

// Build a lookup of normalized schema names -> attrId for fuzzy matching.
export const SCHEMA_NAME_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const c of SCHEMA) {
    if (c.attrId) idx[normalizeHeader(c.name)] = c.attrId;
  }
  return idx;
})();
