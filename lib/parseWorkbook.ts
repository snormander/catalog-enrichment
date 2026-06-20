// Parses CSV/XLSX into a normalized table, auto-detecting the real header row
// regardless of seller format (merged brand cell on top, multiple header rows,
// or a single clean header). Runs in the browser via SheetJS.

import * as XLSX from "xlsx";
import { NormalizedTable } from "./types";
import {
  normalizeHeader,
  SCHEMA_NAME_INDEX,
  HEADER_SYNONYMS,
  SKU_HEADER_KEYS,
} from "./referenceData";

// Read a File into a 2D array of raw cell values.
export async function readSheetMatrix(file: File): Promise<any[][]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<any[]>(ws, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  return matrix as any[][];
}

// Score a candidate header row by how many of its cells look like known columns.
function scoreHeaderRow(row: any[]): number {
  let score = 0;
  for (const cell of row) {
    const n = normalizeHeader(cell);
    if (!n) continue;
    if (SCHEMA_NAME_INDEX[n]) score += 2;
    else if (HEADER_SYNONYMS[n]) score += 2;
    else if (SKU_HEADER_KEYS.includes(n)) score += 3;
    else if (n.includes("image") || n.includes("title") || n.includes("product"))
      score += 1;
    else if (n.length > 1) score += 0.2; // any non-trivial label
  }
  return score;
}

// Detect whether a row is the golden "#ATTR_..." mapping row.
function isAttrMappingRow(row: any[]): boolean {
  const hits = row.filter((c) => String(c).startsWith("#ATTR_")).length;
  return hits >= 3;
}

export interface DetectResult {
  matrix: any[][];
  headerRowIndex: number;
  dataStartIndex: number;
  attrRowIndex: number | null;
}

// Find the header row and where data starts.
export function detectStructure(matrix: any[][]): DetectResult {
  const scanTo = Math.min(matrix.length, 15);
  let bestRow = 0;
  let bestScore = -1;
  for (let r = 0; r < scanTo; r++) {
    const s = scoreHeaderRow(matrix[r] || []);
    if (s > bestScore) {
      bestScore = s;
      bestRow = r;
    }
  }

  // Look for a golden #ATTR mapping row near the header (within 2 rows below).
  let attrRowIndex: number | null = null;
  for (let r = bestRow; r < Math.min(matrix.length, bestRow + 3); r++) {
    if (isAttrMappingRow(matrix[r] || [])) {
      attrRowIndex = r;
      break;
    }
  }

  // Data starts after the header row, or after the #ATTR row if present.
  let dataStartIndex = (attrRowIndex !== null ? attrRowIndex : bestRow) + 1;

  // Skip any immediately-following metadata rows that aren't real products
  // (heuristic: rows that are mostly empty or look like type/length markers).
  while (
    dataStartIndex < matrix.length &&
    isMetadataRow(matrix[dataStartIndex])
  ) {
    dataStartIndex++;
  }

  return { matrix, headerRowIndex: bestRow, dataStartIndex, attrRowIndex };
}

function isMetadataRow(row: any[]): boolean {
  if (!row) return true;
  const nonEmpty = row.filter((c) => String(c).trim() !== "");
  if (nonEmpty.length === 0) return true;
  const markers = ["MANDATORY", "NON-MANDATORY", "STRING", "ENUM", "INTEGER", "DECIMAL"];
  const markerCount = nonEmpty.filter((c) =>
    markers.includes(String(c).trim().toUpperCase())
  ).length;
  return markerCount / nonEmpty.length > 0.5;
}

// Map each detected header to a schema attrId (or null).
export function buildColumnMap(
  headers: string[],
  attrRow: any[] | null
): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  headers.forEach((h, i) => {
    // 1) golden format: read attrId straight from the #ATTR row
    if (attrRow && attrRow[i] && String(attrRow[i]).startsWith("#ATTR_")) {
      const body = String(attrRow[i]).slice(6);
      map[h] = body.split("_")[0];
      return;
    }
    const n = normalizeHeader(h);
    // 2) exact schema name match
    if (SCHEMA_NAME_INDEX[n]) {
      map[h] = SCHEMA_NAME_INDEX[n];
      return;
    }
    // 3) synonym match
    if (HEADER_SYNONYMS[n]) {
      map[h] = HEADER_SYNONYMS[n];
      return;
    }
    // 4) fuzzy contains
    const fuzzy = Object.keys(HEADER_SYNONYMS).find(
      (k) => n.includes(k) || k.includes(n)
    );
    map[h] = fuzzy ? HEADER_SYNONYMS[fuzzy] : null;
  });
  return map;
}

export async function normalizeWorkbook(file: File): Promise<NormalizedTable> {
  const matrix = await readSheetMatrix(file);
  const { headerRowIndex, dataStartIndex, attrRowIndex } = detectStructure(matrix);

  const rawHeaders = (matrix[headerRowIndex] || []).map((h, i) =>
    String(h).trim() || `col_${i}`
  );
  // de-duplicate header names
  const seen: Record<string, number> = {};
  const headers = rawHeaders.map((h) => {
    if (seen[h] === undefined) {
      seen[h] = 0;
      return h;
    }
    seen[h] += 1;
    return `${h}_${seen[h]}`;
  });

  const attrRow = attrRowIndex !== null ? matrix[attrRowIndex] : null;
  const columnMap = buildColumnMap(headers, attrRow);

  const rows: Record<string, any>[] = [];
  const rawRowNumbers: number[] = [];
  for (let r = dataStartIndex; r < matrix.length; r++) {
    const raw = matrix[r] || [];
    if (raw.every((c) => String(c).trim() === "")) continue;
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => {
      obj[h] = raw[i] !== undefined ? raw[i] : "";
    });
    rows.push(obj);
    rawRowNumbers.push(r);
  }

  return {
    headerRowIndex,
    dataStartIndex,
    headers,
    rows,
    columnMap,
    rawRowNumbers,
  };
}

// Find the SKU column name within a normalized table.
export function findSkuColumn(table: NormalizedTable): string | null {
  for (const h of table.headers) {
    if (SKU_HEADER_KEYS.includes(normalizeHeader(h))) return h;
  }
  // fall back to first column
  return table.headers[0] || null;
}

// Find image-url columns within a normalized table.
export function findImageColumns(table: NormalizedTable): string[] {
  return table.headers.filter((h) => {
    const n = normalizeHeader(h);
    return n.startsWith("image") || n === "productimages";
  });
}

// Export a table back to an .xlsx Blob for download.
export function tableToXlsxBlob(
  headers: string[],
  rows: Record<string, any>[]
): Blob {
  const aoa = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
