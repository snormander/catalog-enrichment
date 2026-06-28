// Template-based copy generation (Title, Description, Meta×3, Tags, etc.) and
// conservative text-keyword inference. Copy is portal-valid and readable but
// generic — tagged source:"generated" so it's clearly machine-written.

import { MDD, normalizeValue } from "./referenceData";

type Fields = Record<string, { attrId: string; value: string }>;

function pick(fields: Fields, ...concepts: string[]): string {
  // find a field whose attrId loosely matches one of the concept stems
  for (const c of concepts) {
    for (const k of Object.keys(fields)) {
      if (k.toLowerCase().includes(c)) {
        const v = fields[k]?.value;
        if (v) return v;
      }
    }
  }
  return "";
}

export interface CopyOut { name: string; value: string; mandatory?: boolean }

// Fetch a seller-provided value from the row's metadata blob by normalized header.
function metaGet(meta: Record<string, string>, ...needles: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const n of needles) {
    for (const [k, v] of Object.entries(meta)) {
      if (norm(k) === n && v && v.trim()) return v.trim();
    }
  }
  return "";
}

// First sentence(s) of a text, up to `limit` chars, ending cleanly.
function firstSentence(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > 40) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

export function buildCopy(fields: Fields, l4: string, meta: Record<string, string>): Record<string, CopyOut> {
  const brand = pick(fields, "brand");
  const color = pick(fields, "colorfamily", "color");
  const fit = pick(fields, "fit");
  const pattern = pick(fields, "pattern");
  const sleeve = pick(fields, "sleeve");
  const neck = pick(fields, "collarneck", "neck");
  const fabric = pick(fields, "fabricfamily", "fabric");
  const productType = l4;

  // Seller-provided copy (preferred when present), looked up by exact header.
  const sellerTitle = metaGet(meta, "product title");
  const sellerDesc  = metaGet(meta, "product description");
  const sellerMini  = metaGet(meta, "product minidescription", "product mini description");
  const sellerMetaT = metaGet(meta, "product metatitle", "product meta title");
  const sellerMetaK = metaGet(meta, "product metakeyword", "product meta keyword");
  const sellerMetaD = metaGet(meta, "product metadescription", "product meta description");

  // Title — seller's if given, else generated.
  const titleParts = [brand, color, pattern, fit, productType].filter(Boolean);
  const title = (sellerTitle || titleParts.join(" ")).slice(0, 100) || productType;

  // Description — seller's if given, else generated marketing sentence.
  let description: string;
  if (sellerDesc) {
    description = sellerDesc.slice(0, 600);
  } else {
    const descBits: string[] = [];
    if (color || pattern) descBits.push(`This ${[color, pattern].filter(Boolean).join(" ")} ${productType.toLowerCase()}`.trim());
    else descBits.push(`This ${productType.toLowerCase()}`);
    if (fabric) descBits.push(`is crafted from ${fabric.toLowerCase()}`);
    if (fit) descBits.push(`in a ${fit.toLowerCase()} silhouette`);
    if (sleeve) descBits.push(`featuring ${sleeve.toLowerCase()}`);
    if (neck) descBits.push(`and a ${neck.toLowerCase()}`);
    description = (descBits.join(" ").replace(/\s+/g, " ").trim() + ". A versatile pick for everyday styling.").slice(0, 600);
  }

  // Mini-description — NOT a blind truncation:
  //   1. seller's own mini, if provided
  //   2. else a compact attribute spec line (distinct from the description)
  //   3. else the first clean sentence of the description
  let mini: string;
  if (sellerMini) {
    mini = sellerMini.slice(0, 150);
  } else {
    const specBits = [color, pattern, fabric ? fabric.toLowerCase() : "", fit ? `${fit.toLowerCase()} fit` : ""].filter(Boolean);
    const spec = specBits.length >= 2
      ? `${[color, pattern].filter(Boolean).join(" ")} ${productType.toLowerCase()}${fabric ? " in " + fabric.toLowerCase() : ""}${fit ? ", " + fit.toLowerCase() + " fit" : ""}.`.replace(/\s+/g, " ").trim()
      : "";
    mini = (spec || firstSentence(description, 150)).slice(0, 150);
  }

  const tags = (sellerMetaK || [productType, color, pattern, fit, fabric, brand].filter(Boolean).join(", ")).slice(0, 100);

  return {
    title:           { name: "PRODUCT TITLE", value: title.slice(0, 100), mandatory: true },
    name:            { name: "PRODUCT NAME", value: title.slice(0, 200), mandatory: true },
    description:     { name: "PRODUCT DESCRIPTION", value: description.slice(0, 600), mandatory: true },
    stylenote:       { name: "Style Note", value: description.slice(0, 600), mandatory: true },
    minidescription: { name: "PRODUCT MINIDESCRIPTION", value: mini },
    metatitle:       { name: "PRODUCT METATITLE", value: (sellerMetaT || title).slice(0, 100) },
    metakeyword:     { name: "PRODUCT METAKEYWORD", value: tags.slice(0, 100) },
    metadescription: { name: "PRODUCT METADESCRIPTION", value: (sellerMetaD || mini || description).slice(0, 200) },
    tags:            { name: "PRODUCT TAGS", value: tags.slice(0, 100) },
    genericName:     { name: "Generic Name", value: productType.slice(0, 50), mandatory: true },
    displayproduct:  { name: "Display Product Name", value: title.slice(0, 100) },
  };
}

// ── Text inference ───────────────────────────────────────────────────────────

function l4FromText(text: string): string {
  const s = text.toLowerCase();
  const has = (...k: string[]) => k.some((x) => s.includes(x));
  if (has("kurta set", "kurta with", "with dupatta", "with palazzo")) return "Kurta Sets";
  if (has("kurta", "kurti")) return "Kurta";
  if (has("saree", "sari")) return "Saree";
  if (has("lehenga")) return "Lehenga";
  if (has("ethnic dress", "anarkali")) return "Ethnic Dresses";
  if (has("gown", "maxi dress", "midi dress", " dress")) return "Casual dresses";
  if (has("jean", "denim")) return "Jeans";
  if (has("trouser", "chino")) return "Casual trousers";
  if (has("short")) return "Shorts";
  if (has("skirt")) return "Skirts";
  if (has("formal shirt")) return "Formal shirt";
  if (has("shirt")) return "casual shirts";
  if (has("sweatshirt", "hoodie")) return "Sweatshirts & Hoodies";
  if (has("sweater", "pullover", "cardigan")) return "Sweaters & Cardigans";
  if (has("night", "pyjama", "pajama", "lounge")) return "Nightwear Tops";
  if (has("top", "tee", "t-shirt", "tshirt", "blouse")) return "Tops and tees";
  return "Tops and tees";
}

function attrFromText(concept: string, text: string, attrId: string): string {
  const s = text.toLowerCase();
  const allowed = MDD.lov[attrId];
  const ret = (val: string) => {
    if (!allowed || !allowed.length) return val;
    const n = normalizeValue(val);
    const m = allowed.find((a) => normalizeValue(a) === n) || allowed.find((a) => normalizeValue(a).includes(n) || n.includes(normalizeValue(a)));
    return m || "";
  };
  if (concept.includes("pattern")) {
    if (/\bcheck/.test(s)) return ret("Checked") || ret("Check");
    if (/\bfloral/.test(s)) return ret("Floral");
    if (/\bstripe/.test(s)) return ret("Striped") || ret("Stripes");
    if (/\bprint/.test(s)) return ret("Printed") || ret("Print");
    if (/\bembroider/.test(s)) return ret("Embroidered");
    if (/\bsolid|\bplain/.test(s)) return ret("Solid");
  }
  if (concept.includes("sleeve")) {
    if (/sleeveless/.test(s)) return ret("Sleeveless");
    if (/half sleeve|short sleeve/.test(s)) return ret("Short") || ret("Short Sleeves");
    if (/three.quarter|3\/4/.test(s)) return ret("Three-Quarter") || ret("Three Quarter Sleeves");
    if (/full sleeve|long sleeve/.test(s)) return ret("Long") || ret("Full Sleeves");
  }
  if (concept.includes("neck") || concept.includes("collar")) {
    if (/v.neck/.test(s)) return ret("V-Neck") || ret("V Neck");
    if (/round neck|crew/.test(s)) return ret("Round Neck") || ret("Round neck");
    if (/collar|button.down/.test(s)) return ret("Shirt Collar") || ret("Collar Neck");
    if (/high neck|turtle/.test(s)) return ret("High Neck");
  }
  if (concept.includes("fit")) {
    if (/slim/.test(s)) return ret("Slim") || ret("Slim Fit");
    if (/regular/.test(s)) return ret("Regular") || ret("Regular Fit");
    if (/relaxed|loose|oversized/.test(s)) return ret("Relaxed") || ret("Loose");
    if (/skinny/.test(s)) return ret("Skinny");
    if (/straight/.test(s)) return ret("Straight");
  }
  if (concept.includes("color")) {
    for (const col of ["Black", "White", "Blue", "Navy", "Red", "Green", "Pink", "Yellow", "Grey", "Brown", "Beige", "Purple", "Orange", "Maroon", "Multi"]) {
      if (new RegExp(`\\b${col.toLowerCase()}\\b`).test(s)) return ret(col) || col;
    }
  }
  if (concept.includes("fabric")) {
    for (const fab of ["Cotton", "Polyester", "Rayon", "Linen", "Silk", "Wool", "Denim", "Nylon", "Viscose", "Modal"]) {
      if (new RegExp(`\\b${fab.toLowerCase()}\\b`).test(s)) return ret(fab) || fab;
    }
  }
  if (concept.includes("dress length")) {
    if (/maxi|ankle/.test(s)) return ret("Ankle Length") || ret("Maxi");
    if (/knee/.test(s)) return ret("Knee Length");
    if (/mini|above knee|short/.test(s)) return ret("Above Knee");
  }
  return "";
}

export const inferFromText = { l4: l4FromText, attr: attrFromText };
