// Model catalogue + token-cost maths.
// Prices are per 1,000,000 tokens (USD), verified June 2026. Google updates
// these periodically — edit here if rates change. INR conversion via USD_TO_INR.

import { TokenUsage } from "./types";

export interface ModelDef {
  id: string;            // Gemini API model string
  label: string;
  inputPerM: number;     // USD per 1M input tokens
  outputPerM: number;    // USD per 1M output tokens
}

export const MODELS: ModelDef[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", inputPerM: 0.3, outputPerM: 2.5 },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", inputPerM: 1.25, outputPerM: 10.0 },
];

export const USD_TO_INR = 83.5; // adjust to current FX if needed

export function modelById(id: string): ModelDef {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

export function costForUsage(usage: TokenUsage, modelId: string) {
  const m = modelById(modelId);
  const usd =
    (usage.inputTokens / 1_000_000) * m.inputPerM +
    (usage.outputTokens / 1_000_000) * m.outputPerM;
  return { usd, inr: usd * USD_TO_INR };
}
