// Serverless route that runs the Gemini vision call.
// Keeps GEMINI_API_KEY on the server (never shipped to the browser).
//
// Input  (POST JSON): { model, imageUrls[], sku, fields:[{column,attrId,label,status,currentValue,allowedValues[]}] }
// Output (JSON):      { results:[{column,attrId,proposedValue,confidence,reasoning}], usage:{inputTokens,outputTokens} }

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Fetch an image URL and return base64 + mime type for Gemini inlineData.
async function fetchImageInline(url: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mime: mime.split(";")[0], data: buf.toString("base64") };
}

function buildPrompt(sku: string, fields: any[]) {
  const lines = fields.map((f, i) => {
    return `${i + 1}. Field "${f.label}" (id: ${f.attrId}) — current value: ${
      f.currentValue ? `"${f.currentValue}"` : "MISSING"
    }; issue: ${f.status}. Choose the single best value ONLY from this allowed list: [${f.allowedValues
      .map((v: string) => `"${v}"`)
      .join(", ")}].`;
  });

  return `You are a catalogue data QA expert for an apparel marketplace.
Look at the product image(s) for SKU ${sku} and determine the correct value for each field below.

Rules:
- You MUST pick a value verbatim from the allowed list for each field. Never invent values.
- If the image does not clearly show the attribute, return your best guess but a LOW confidence.
- confidence is an integer 0-100 reflecting how sure you are the value is correct given the image.

Fields:
${lines.join("\n")}

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"results":[{"attrId":"<id>","value":"<one of the allowed values>","confidence":<0-100>,"reasoning":"<short>"}]}`;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY not configured on the server." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const { model, imageUrls = [], sku = "", fields = [] } = body;
    if (!fields.length) {
      return NextResponse.json({ results: [], usage: { inputTokens: 0, outputTokens: 0 } });
    }

    // Fetch up to 3 images server-side (avoids browser CORS + keeps payload sane).
    const parts: any[] = [];
    for (const url of imageUrls.slice(0, 3)) {
      if (!url || !/^https?:\/\//.test(url)) continue;
      try {
        const img = await fetchImageInline(url);
        parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
      } catch {
        // skip unreachable images; the model proceeds on remaining ones
      }
    }
    parts.push({ text: buildPrompt(sku, fields) });

    const payload = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    };

    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    const gres = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!gres.ok) {
      const errText = await gres.text();
      return NextResponse.json(
        { error: `Gemini ${gres.status}: ${errText.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const data = await gres.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    const usageMeta = data?.usageMetadata || {};
    const usage = {
      inputTokens: usageMeta.promptTokenCount || 0,
      outputTokens:
        (usageMeta.candidatesTokenCount || 0) + (usageMeta.thoughtsTokenCount || 0),
    };

    let parsed: any = { results: [] };
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      // model returned non-JSON; treat as no confident answers
    }

    // Map model output (keyed by attrId) back to the requested columns.
    const byAttr: Record<string, any> = {};
    for (const r of parsed.results || []) byAttr[r.attrId] = r;

    const results = fields.map((f: any) => {
      const r = byAttr[f.attrId];
      return {
        column: f.column,
        attrId: f.attrId,
        proposedValue: r?.value ?? null,
        confidence: typeof r?.confidence === "number" ? r.confidence : 0,
        reasoning: r?.reasoning || "",
      };
    });

    return NextResponse.json({ results, usage });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
