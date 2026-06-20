// Simulates realistic "incorrect" seller data from the clean golden sheet,
// using the degradation profile from the problem doc:
//   - ~30-40% of mandatory attributes MISSING
//   - ~5-10% CONFLICTING (wrong value that contradicts the image)
//
// Works on a normalized table. Only touches mandatory LOV-backed columns so
// the corruption mirrors what the enrichment tool actually targets.

import { NormalizedTable } from "./types";
import { MDD, normalizeHeader, SCHEMA_NAME_INDEX, HEADER_SYNONYMS } from "./referenceData";

export interface SimConfig {
  missingPct: number;    // 0..100
  conflictPct: number;   // 0..100
  seed?: number;
}

// Small seeded RNG so runs are reproducible.
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function attrIdForHeader(header: string): string | null {
  const n = normalizeHeader(header);
  return SCHEMA_NAME_INDEX[n] || HEADER_SYNONYMS[n] || null;
}

export interface SimResult {
  table: NormalizedTable;            // the degraded table
  changeLog: {
    rowNumber: number;
    column: string;
    action: "missing" | "conflict";
    original: any;
    newValue: any;
  }[];
}

export function simulateIncorrect(
  golden: NormalizedTable,
  config: SimConfig
): SimResult {
  const rand = mulberry32(config.seed ?? 42);
  const changeLog: SimResult["changeLog"] = [];

  // Which columns are eligible to corrupt (mandatory LOV-backed, present in file).
  const eligible = golden.headers.filter((h) => {
    const attrId = attrIdForHeader(h);
    return attrId && MDD.lov[attrId];
  });

  const newRows = golden.rows.map((row, idx) => {
    const clone: Record<string, any> = { ...row };
    for (const col of eligible) {
      const attrId = attrIdForHeader(col)!;
      const list = MDD.lov[attrId];
      const original = clone[col];
      const roll = rand() * 100;
      if (roll < config.missingPct) {
        clone[col] = "";
        changeLog.push({
          rowNumber: golden.rawRowNumbers[idx],
          column: col,
          action: "missing",
          original,
          newValue: "",
        });
      } else if (roll < config.missingPct + config.conflictPct) {
        // pick a different allowed value to create an image-conflicting error
        const others = list.filter(
          (v) => v.trim().toLowerCase() !== String(original).trim().toLowerCase()
        );
        if (others.length) {
          const wrong = others[Math.floor(rand() * others.length)];
          clone[col] = wrong;
          changeLog.push({
            rowNumber: golden.rawRowNumbers[idx],
            column: col,
            action: "conflict",
            original,
            newValue: wrong,
          });
        }
      }
    }
    return clone;
  });

  return {
    table: { ...golden, rows: newRows },
    changeLog,
  };
}
