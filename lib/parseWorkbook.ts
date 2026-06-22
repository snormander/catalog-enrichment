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

function wsToMatrix(ws: XLSX.WorkSheet): any[][] {
  return XLSX.utils.sheet_to_json<any[]>(ws, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  }) as any[][];
}

// Read the FIRST sheet into a 2D array (kept for the simulator).
export async function readSheetMatrix(file: File): Promise<any[][]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  return wsToMatrix(wb.Sheets[wb.SheetNames[0]]);
}

// Read ALL sheets into [{name, matrix}] (each sheet is an L4 category).
export async function readAllSheets(file: File): Promise<{ name: string; matrix: any[][] }[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  return wb.SheetNames.map((name) => ({ name, matrix: wsToMatrix(wb.Sheets[name]) }));
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
    // 4) no confident match -> leave unmapped.
    // (A loose "contains" check used to mis-map e.g. Image_1 -> ageband
    //  because "im[age]" contains "age", so it is deliberately removed.)
    map[h] = null;
  });
  return map;
}

// Normalize a single raw matrix into a NormalizedTable, capturing the full
// header block (every row above the data) so the schema can be re-emitted.
export function normalizeMatrix(matrix: any[][], sheetName?: string): NormalizedTable {
  const { headerRowIndex, dataStartIndex, attrRowIndex } = detectStructure(matrix);

  const rawHeaders = (matrix[headerRowIndex] || []).map((h, i) =>
    String(h).trim() || `col_${i}`
  );
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

  // Everything above the data rows is the schema block (type / mandatory /
  // char-limit / display name / #ATTR system name). Preserved verbatim.
  const headerBlock = matrix.slice(0, dataStartIndex).map((r) => (r || []).slice());

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

  return { sheetName, headerBlock, headerRowIndex, dataStartIndex, headers, rows, columnMap, rawRowNumbers };
}

export async function normalizeWorkbook(file: File): Promise<NormalizedTable> {
  const matrix = await readSheetMatrix(file);
  return normalizeMatrix(matrix);
}

// Parse EVERY sheet in the workbook (each = an L4 category). Sheets with no
// detectable product rows are skipped.
export async function normalizeAllSheets(file: File): Promise<NormalizedTable[]> {
  const sheets = await readAllSheets(file);
  const tables: NormalizedTable[] = [];
  for (const { name, matrix } of sheets) {
    if (!matrix || matrix.length === 0) continue;
    const t = normalizeMatrix(matrix, name);
    if (t.rows.length > 0) tables.push(t);
  }
  return tables;
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

// Build one worksheet AoA preserving the original schema header block, then the
// data rows, with two audit columns appended at the end.
function tableToAoa(table: NormalizedTable, auditCols: string[]): any[][] {
  const ncol = table.headers.length;
  const aoa: any[][] = [];

  // Re-emit the original header block (type / mandatory / char-limit / display
  // name / #ATTR). Pad/trim each row to the column count, then append audit
  // header cells so the schema rows line up with the new columns.
  const block = table.headerBlock && table.headerBlock.length
    ? table.headerBlock
    : [table.headers]; // fallback: single header row
  const lastIdx = block.length - 1;
  block.forEach((row, ri) => {
    const r = Array.from({ length: ncol }, (_, i) => (row[i] !== undefined ? row[i] : ""));
    // audit columns: label them sensibly across the schema rows
    auditCols.forEach((name) => {
      if (ri === 0) r.push("String");
      else if (lastIdx >= 1 && ri === 1) r.push("NON-MANDATORY");
      else if (ri === lastIdx) r.push(name); // put the column name on the last (name) row
      else r.push("");
    });
    aoa.push(r);
  });

  // Data rows
  for (const row of table.rows) {
    const r = table.headers.map((h) => row[h] ?? "");
    auditCols.forEach((name) => r.push(row[name] ?? ""));
    aoa.push(r);
  }
  return aoa;
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Single-table export (used by the simulator).
export function tableToXlsxBlob(headers: string[], rows: Record<string, any>[]): Blob {
  const aoa = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: XLSX_MIME });
}

// Multi-sheet, schema-preserving export. One sheet per L4 table, audit columns
// appended. Used for the enriched output and the simulator's schema'd output.
export function tablesToXlsxBlob(
  tables: NormalizedTable[],
  auditCols: string[] = []
): Blob {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  tables.forEach((t, i) => {
    let name = (t.sheetName || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name)) name = (name.slice(0, 28) + "_" + (i + 1)).slice(0, 31);
    used.add(name);
    const ws = XLSX.utils.aoa_to_sheet(tableToAoa(t, auditCols));
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: XLSX_MIME });
}
