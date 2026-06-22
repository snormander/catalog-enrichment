// Shared types across the app.

export type FieldStatus =
  | "ok"            // present, LOV-valid (and assumed correct)
  | "missing"       // blank
  | "not_lov"       // present but not an allowed MDD value
  | "conflict";     // present, LOV-valid, but flagged to verify against image

export interface SchemaColumn {
  index: number;
  name: string;
  mandatory: boolean;
  attrId: string | null;
  isLov: boolean;
}

// A normalized table extracted from any seller file format.
export interface NormalizedTable {
  sheetName?: string;          // source sheet name (the L4 category)
  headerBlock: any[][];        // raw rows above the data (5-row schema block)
  headerRowIndex: number;      // 0-based row in the raw sheet used as header
  dataStartIndex: number;      // 0-based row where product data begins
  headers: string[];           // cleaned header names
  rows: Record<string, any>[]; // each row keyed by header name
  // mapping: header name -> schema attrId (or null if unmapped)
  columnMap: Record<string, string | null>;
  rawRowNumbers: number[];     // original sheet row index for each data row
}

export interface FieldIssue {
  column: string;        // header/column name in the uploaded file
  attrId: string;        // MDD attribute id
  label: string;         // human label
  status: FieldStatus;
  currentValue: any;
  allowedValues: string[];
}

export interface FieldResult {
  column: string;
  attrId: string;
  proposedValue: string | null;
  confidence: number;    // 0..100
  reasoning?: string;
  applied: boolean;      // true if confidence >= threshold and we wrote it
  status: FieldStatus;
  previousValue: any;
}

export interface ProductResult {
  rowNumber: number;
  sheetName?: string;
  sku: string;
  imageUrls: string[];
  fields: FieldResult[];
  error?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AccuracyReport {
  evaluated: number;        // # of changed cells we could compare to golden
  correct: number;          // # that matched golden
  accuracy: number;         // correct / evaluated (0..1)
  perAttribute: Record<string, { correct: number; total: number }>;
  unmatchedRows: number;    // golden rows we couldn't align by SKU
}

export interface DataFunnel {
  totalAttrCells: number;    // all recognized LOV attribute cells
  mandatoryCells: number;    // mandatory subset (the tool's working set)
  issues: number;            // mandatory cells needing a fix
  nonVisual: number;         // issues not determinable from an image (flagged)
  visual: number;            // issues that are visually determinable
  errored: number;           // visual issues the tool couldn't process (img/API)
  attempted: number;         // visual issues filled (confidence >= threshold)
  scored?: number;           // attempted cells the correct sheet can verify
  correct?: number;          // of scored, how many matched
}

export interface RunReport {
  fileName: string;
  model: string;
  threshold: number;
  productsProcessed: number;
  cellsScanned: number;
  cellsWithIssues: number;
  cellsApplied: number;      // changes written (>= threshold)
  cellsFlagged: number;      // issues left for human (< threshold)
  erroredRows: number;       // products that failed (bad image / API error)
  firstError?: string;       // first error message seen, for diagnosis
  funnel: DataFunnel;
  usage: TokenUsage;
  costUSD: number;
  costINR: number;
  accuracy?: AccuracyReport;
  generatedAt: string;
}
