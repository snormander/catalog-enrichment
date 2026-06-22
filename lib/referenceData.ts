// Loads the embedded MDD LOV + golden schema and exposes helpers.
// The MDD file is baked in here so the backend never re-parses Excel at runtime.

import mddLovJson from "@/data/mdd_lov.json";
import schemaJson from "@/data/golden_schema.json";
import hierarchyJson from "@/data/hierarchy.json";
import applicabilityJson from "@/data/attr_applicability.json";
import { SchemaColumn } from "./types";

interface MddLov {
  attributeNames: Record<string, string>;
  lov: Record<string, string[]>;
}

export const MDD: MddLov = mddLovJson as MddLov;
export const SCHEMA: SchemaColumn[] = schemaJson as SchemaColumn[];

interface Hierarchy {
  l4List: string[];
  hierarchy: { l1: string; l2: string; l3: string; l4: string }[];
}
export const HIERARCHY: Hierarchy = hierarchyJson as Hierarchy;
export const L4_LIST: string[] = HIERARCHY.l4List;

// L4 categories where Dress Length is meaningful. For everything else (tops,
// tees, shirts, trousers, etc.) the tool should not fill dress length.
const DRESS_KEYWORDS = ["dress", "gown", "kaftan", "kurta", "kurti", "lehenga", "saree", "jump suit", "jumpsuit", "ethnic dresses"];
export function isDressL4(l4: string): boolean {
  const s = String(l4 || "").toLowerCase();
  return DRESS_KEYWORDS.some((k) => s.includes(k));
}

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

// Attributes that CANNOT be determined from a product photo. The image can't
// reveal demographic targeting, a season code, or country of manufacture, so
// the tool should never auto-fill these from vision — it flags them for a human
// instead of guessing. This is the single biggest accuracy lever: it stops the
// model from confidently writing wrong values that tank the score.
export const NON_VISUAL_ATTR_IDS = new Set<string>([
  "ageband",         // "22-35", "16 to 22" — not visible in an image
  "seasonapparel",   // "SS18", "AW19" — a catalogue season code, not visual
  "countryOfOrigin", // manufacturing origin — not visual
  "occasion",        // "Work Wear" vs "College Look" — subjective, seller-defined
]);

// Attribute IDs that are mandatory per the golden schema. The tool focuses on
// these (the Seller Portal rejects on missing mandatory fields). To also enrich
// optional visual fields (e.g. Pattern), add their attrId here or relax the
// targetCols filter in enrichClient.ts.
export const MANDATORY_ATTR_IDS = new Set<string>(
  SCHEMA.filter((c) => c.mandatory && c.attrId && MDD.lov[c.attrId]).map((c) => c.attrId as string)
);

// Mandatory fields that are visually determinable but have NO LOV list in the
// MDD (free text). The tool still fills these from the image + metadata — most
// importantly Color, which the seller often leaves blank even though the title
// usually states it (e.g. "...Womens Orange Slim Fit Top").
export const FREE_TEXT_VISUAL_ATTR_IDS = new Set<string>([
  "colorapparel", // Color (free text, no LOV)
]);

// Row metadata passed to the model to help fill values — the product title,
// name and descriptions frequently state colour, fit, neck, sleeve, pattern.
// Listed by attrId (matched from the #ATTR row) OR by normalized display name.
export const METADATA_ATTR_IDS = [
  "genericName",
  "stylenote",
  "brandDescription",
];
export const METADATA_HEADER_KEYS = [
  "producttitle",
  "productname",
  "productdescription",
  "productminidescription",
  "productmetatitle",
  "displayproductname",
];

// Centralized value normalization for both LOV-validity and accuracy scoring:
// lowercase, trim, collapse internal whitespace, strip punctuation/hyphens.
// This bridges trivial vocabulary drift (e.g. "V-Neck" vs "V neck",
// "Short Sleeves" vs "short sleeves", "Navy  Blue" vs "Navy Blue").
export function normalizeValue(v: any): string {
  const base = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // punctuation/hyphens -> space
    .replace(/\s+/g, " ")
    .trim();
  // Fold simple plurals per token so "Short sleeve" == "Short Sleeves",
  // "Check" == "Checks". Strips a trailing 's' on tokens longer than 3 chars.
  return base
    .split(" ")
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t))
    .join(" ");
}

// Category-agnostic predicates so the tool works across seller templates
// (men's / women's / ethnic / lingerie), which use different attribute-id
// prefixes for the same concept (e.g. mensleeve vs womencasualtopwearsleeve).
const VISUAL_PATTERNS = ["sleeve", "fit", "neck", "collar", "colorfamily", "colourfamily", "pattern", "print", "length", "shape", "silhouette", "rise", "coverage", "padding", "transparency", "hemline", "waistband"];
export function isVisualAttr(attrId: string | null | undefined): boolean {
  const a = String(attrId || "").toLowerCase();
  if (!a || NON_VISUAL_ATTR_IDS.has(a)) return false;
  return VISUAL_PATTERNS.some((p) => a.includes(p));
}
export function isFabricAttr(attrId: string | null | undefined): boolean {
  return String(attrId || "").toLowerCase().includes("fabric");
}
export function isColorFamilyAttr(attrId: string | null | undefined): boolean {
  const a = String(attrId || "").toLowerCase();
  return a.includes("colorfamily") || a.includes("colourfamily");
}
export function isColorFreeText(attrId: string | null | undefined): boolean {
  const a = String(attrId || "").toLowerCase();
  return a === "colorapparel" || a === "colourapparel";
}
export function isDressLengthAttr(attrId: string | null | undefined): boolean {
  return String(attrId || "").toLowerCase().includes("dresslength");
}

// Attribute → L4 applicability (from the MDD Attribute_Mapping matrix). Lets the
// tool ignore attributes that don't apply to a product's category (e.g. Bra Type
// on a dress) instead of treating them as gaps.
const APPLICABILITY = applicabilityJson as Record<string, string[]>;
const APPLIC_SETS: Record<string, Set<string>> = {};
for (const k of Object.keys(APPLICABILITY)) APPLIC_SETS[k] = new Set(APPLICABILITY[k]);
function normL4(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export function attrAppliesToL4(attrId: string | null | undefined, l4: string | null | undefined): boolean {
  const set = APPLIC_SETS[normL4(l4 || "")];
  if (!set) return true;        // unknown L4 → don't filter (fail-open)
  if (!attrId) return true;
  return set.has(attrId);
}

export function allowedValuesFor(attrId: string): string[] {
  return MDD.lov[attrId] || [];
}

export function isLovValid(attrId: string, value: any): boolean {
  if (value === null || value === undefined) return false;
  const v = normalizeValue(value);
  if (!v) return false;
  const list = MDD.lov[attrId];
  if (!list) return true; // free-text attribute: any non-empty value is acceptable
  return list.some((opt) => normalizeValue(opt) === v);
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
