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

  return `You are a meticulous catalogue data QA expert for an apparel marketplace.
Study the product image(s) for SKU ${sku} carefully, then determine the correct value for each field below.

Strict rules:
- Pick a value EXACTLY as written in that field's allowed list — copy its spelling, casing and spacing verbatim. Never invent, pluralize, or reformat (e.g. if the list has "Short sleeve", do not return "Short Sleeves").
- Judge ONLY the main garment in the image, not props, models' other clothing, or background.
- For colour fields, identify the single DOMINANT colour of the garment and map it to the closest allowed family.
- Match the most specific correct option (prefer "Half Sleeves" over "Short sleeve" when the image clearly shows half sleeves).
- Confidence (integer 0-100) must reflect visual certainty: 90-100 only when unmistakable in the image; 50-79 when plausible but uncertain; under 40 when the image does not actually show the attribute (fabric composition, packaging, etc.). Never output high confidence for a guess.

Fields:
${lines.join("\n")}

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"results":[{"attrId":"<id>","value":"<one allowed value, verbatim>","confidence":<0-100>,"reasoning":"<short>"}]}`;
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
    const { model, imageUrls = [], sku = "", fields = [], maxImages = 3 } = body;
    if (!fields.length) {
      return NextResponse.json({ results: [], usage: { inputTokens: 0, outputTokens: 0 } });
    }

    // Fetch up to `maxImages` images server-side (avoids browser CORS + keeps
    // payload sane). All are sent together so the model reasons over every angle
    // in a single call.
    const cap = Math.max(1, Math.min(Number(maxImages) || 3, 5));
    const parts: any[] = [];
    for (const url of imageUrls.slice(0, cap)) {
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
