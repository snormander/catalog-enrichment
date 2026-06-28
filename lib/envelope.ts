// The fixed "envelope" — the 28 system/admin/logistics columns the portal
// expects before any category attribute, in their exact order. Parsed from the
// portal upload template. These are identical for every category, so they're
// hardcoded here. Each attribute block (per L4) is appended AFTER this.
//
// fill: how the value is sourced when building output:
//   const   → fixed value in `value`
//   seller  → from the seller row, by concept/code in `from`
//   copy    → from a generated copy field, key in `from`
//   image   → first S3/image URL
//   imgPrio → image priority (1)
//   gidType → "MPN"; gidValue → the SKU
//   startDate / endDate → date defaults
//   blank   → left empty

export type EnvFill =
  | "const" | "seller" | "copy" | "image" | "imgPrio"
  | "gidType" | "gidValue" | "startDate" | "endDate" | "blank";

export interface EnvCol {
  key: string;        // stable internal/API key (used as the #-row code)
  name: string;       // exact portal display-name header
  type: "String" | "INTEGER" | "Decimal" | "Date(dd-MM-yyyy)";
  mandatory: boolean;
  limit: number;
  fill: EnvFill;
  from?: string;      // concept (for seller) or copy-key (for copy)
  value?: string;     // for const
}

export const ENVELOPE: EnvCol[] = [
  { key: "sOrD",                 name: "S_OR_D",                   type: "String",  mandatory: true,  limit: 1,   fill: "const", value: "S" },
  { key: "hsnCode",              name: "HSN CODE",                 type: "String",  mandatory: true,  limit: 15,  fill: "seller", from: "hsn code" },
  { key: "sellerArticleSku",     name: "Seller Article SKU",       type: "String",  mandatory: true,  limit: 30,  fill: "seller", from: "seller article sku" },
  { key: "productTitle",         name: "PRODUCT TITLE",            type: "String",  mandatory: true,  limit: 100, fill: "copy", from: "title" },
  { key: "productName",          name: "PRODUCT NAME",             type: "String",  mandatory: true,  limit: 200, fill: "copy", from: "name" },
  { key: "productDescription",   name: "PRODUCT DESCRIPTION",      type: "String",  mandatory: true,  limit: 600, fill: "copy", from: "description" },
  { key: "productMiniDescription", name: "PRODUCT MINIDESCRIPTION", type: "String", mandatory: false, limit: 150, fill: "copy", from: "minidescription" },
  { key: "productMetaTitle",     name: "PRODUCT METATITLE",        type: "String",  mandatory: false, limit: 100, fill: "copy", from: "metatitle" },
  { key: "productMetaKeyword",   name: "PRODUCT METAKEYWORD",      type: "String",  mandatory: false, limit: 100, fill: "copy", from: "metakeyword" },
  { key: "productMetaDescription", name: "PRODUCT METADESCRIPTION", type: "String", mandatory: false, limit: 200, fill: "copy", from: "metadescription" },
  { key: "productTags",          name: "PRODUCT TAGS",             type: "String",  mandatory: false, limit: 100, fill: "copy", from: "tags" },
  { key: "globalIdentifierType", name: "GLOBAL_IDENTIFIER_TYPE",   type: "String",  mandatory: false, limit: 50,  fill: "gidType" },
  { key: "globalIdentifierValue", name: "GLOBAL_IDENTIFIER_VALUE", type: "INTEGER", mandatory: false, limit: 50,  fill: "gidValue" },
  { key: "globalIdentifierType2", name: "GLOBAL_IDENTIFIER_TYPE_2", type: "String", mandatory: false, limit: 50,  fill: "blank" },
  { key: "globalIdentifierValue2", name: "GLOBAL_IDENTIFIER_VALUE_2", type: "INTEGER", mandatory: false, limit: 50, fill: "blank" },
  { key: "globalIdentifierType3", name: "GLOBAL_IDENTIFIER_TYPE_3", type: "String", mandatory: false, limit: 50,  fill: "blank" },
  { key: "globalIdentifierValue3", name: "GLOBAL_IDENTIFIER_VALUE_3", type: "INTEGER", mandatory: false, limit: 50, fill: "blank" },
  { key: "productStartDate",     name: "PRODUCT STARTDATE",        type: "Date(dd-MM-yyyy)", mandatory: true,  limit: 31, fill: "startDate" },
  { key: "productEndDate",       name: "PRODUCT ENDDATE",          type: "Date(dd-MM-yyyy)", mandatory: false, limit: 31, fill: "endDate" },
  { key: "productReview",        name: "PRODUCT REVIEW",           type: "String",  mandatory: false, limit: 255, fill: "blank" },
  { key: "productImages",        name: "PRODUCT IMAGES",           type: "String",  mandatory: true,  limit: 200, fill: "image" },
  { key: "imagePriority",        name: "IMAGE PRIORITY",           type: "INTEGER", mandatory: false, limit: 3,   fill: "imgPrio" },
  { key: "productVideoUrl",      name: "PRODUCT VIDEO URL",        type: "String",  mandatory: false, limit: 200, fill: "blank" },
  { key: "countryOfManufacturer", name: "COUNTRY OF MANUFACTURER", type: "String", mandatory: false, limit: 50,  fill: "const", value: "India" },
  { key: "productLength",        name: "PRODUCT LENGTH [cm]",      type: "Decimal", mandatory: false, limit: 10,  fill: "seller", from: "product length cm" },
  { key: "productWidth",         name: "PRODUCT WIDTH [cm]",       type: "Decimal", mandatory: false, limit: 10,  fill: "seller", from: "product width cm" },
  { key: "productHeight",        name: "PRODUCT HEIGHT [cm]",      type: "Decimal", mandatory: false, limit: 10,  fill: "seller", from: "product height cm" },
  { key: "productWeight",        name: "PRODUCT WEIGHT [gm]",      type: "Decimal", mandatory: true,  limit: 10,  fill: "seller", from: "product weight gm" },
];

const today = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
};
export const ENV_START_DATE = today();
export const ENV_END_DATE = "31-12-2099";

// Coerce/trim a value to its column type and char limit.
export function formatValue(raw: string, type: EnvCol["type"] | string, limit: number): string {
  let v = String(raw ?? "").trim();
  if (v === "") return v;
  if (type === "INTEGER") { const m = v.replace(/[^\d-]/g, ""); v = m || v; }
  else if (type === "Decimal") { const m = v.replace(/[^\d.-]/g, ""); v = m || v; }
  if (limit && v.length > limit) v = v.slice(0, limit);
  return v;
}
