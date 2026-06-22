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

function buildPrompt(sku: string, fields: any[], metadata: Record<string, string>, l4List: string[]) {
  const lines = fields.map((f, i) => {
    if (f.freeText || !f.allowedValues || f.allowedValues.length === 0) {
      return `${i + 1}. Field "${f.label}" (id: ${f.attrId}) — current value: ${
        f.currentValue ? `"${f.currentValue}"` : "MISSING"
      }. This is a FREE-TEXT field: return a short, standard value (e.g. for Color a single colour name like "Orange" or "Navy Blue"). Use the image and the product text below.`;
    }
    const fabricNote =
      String(f.attrId || "").toLowerCase().includes("fabric")
        ? " IMPORTANT: fabric composition is NOT reliably visible in a photo — determine it ONLY from the product text (title/description). If the text does not state a fabric, set confidence below 40 so it is flagged rather than guessed."
        : "";
    return `${i + 1}. Field "${f.label}" (id: ${f.attrId}) — current value: ${
      f.currentValue ? `"${f.currentValue}"` : "MISSING"
    }; issue: ${f.status}. Choose the single best value ONLY from this allowed list: [${f.allowedValues
      .map((v: string) => `"${v}"`)
      .join(", ")}].${fabricNote}`;
  });

  const metaText = Object.keys(metadata || {}).length
    ? "\nProduct text (use this — the title/description often states colour, fit, neck, sleeve, pattern, fabric):\n" +
      Object.entries(metadata).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "";

  const l4Text = l4List && l4List.length
    ? `\nAlso classify this product's L4 category. Pick the single best match ONLY from this list: [${l4List
        .map((v) => `"${v}"`)
        .join(", ")}].`
    : "";

  return `You are a meticulous catalogue data QA expert for an apparel marketplace.
Study the product image(s) for SKU ${sku} AND the product text, then determine the correct value for each field below.

Strict rules:
- For list-constrained fields, pick a value EXACTLY as written in that field's allowed list — copy its spelling, casing and spacing verbatim. Never invent, pluralize, or reformat (e.g. if the list has "Short sleeve", do not return "Short Sleeves").
- For FREE-TEXT fields (like Color), return a concise standard value; prefer a colour explicitly named in the product text if it matches the image.
- Judge ONLY the main garment, not props, models' other clothing, or background.
- For colour, identify the single DOMINANT colour of the garment.
- Cross-check the product text: if the title says "Orange Slim Fit Solid High Neck", that strongly indicates colour=Orange, fit=Slim, pattern=Solid, neck=High Neck.
- Fabric must come from the product text, never guessed from the image.
- Confidence (integer 0-100): 90-100 only when unmistakable; 50-79 when plausible; under 40 when neither image nor text shows the attribute. Never output high confidence for a guess.
${metaText}${l4Text}

Fields:
${lines.join("\n")}

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"results":[{"attrId":"<id>","value":"<value>","confidence":<0-100>,"reasoning":"<short>"}],"l4":"<one L4 from the list>"}`;
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
    const { model, imageUrls = [], sku = "", fields = [], maxImages = 3, metadata = {}, l4List = [] } = body;
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
    parts.push({ text: buildPrompt(sku, fields, metadata, l4List) });

    const payload = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    };

    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    // Free-tier keys are rate-limited (low requests/min). Gemini answers 429 when
    // throttled and sometimes 500/503 transiently. Retry a few times with
    // exponential backoff + jitter, honoring Retry-After when provided.
    const RETRY_STATUSES = new Set([429, 500, 503]);
    const MAX_ATTEMPTS = 5;
    let gres: Response | null = null;
    let lastErrText = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      gres = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (gres.ok) break;
      lastErrText = await gres.text();
      if (!RETRY_STATUSES.has(gres.status) || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(gres.headers.get("retry-after"));
      // 429 on free tier clears when the per-minute window rolls over, so wait
      // longer for rate limits than for transient 5xx.
      const base = gres.status === 429 ? 4000 : 600;
      const backoffMs = retryAfter
        ? retryAfter * 1000
        : Math.min(15000, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    if (!gres || !gres.ok) {
      const status = gres?.status ?? 0;
      const hint =
        status === 429
          ? " (rate limit — lower the Parallel requests setting or enable billing on your key)"
          : "";
      return NextResponse.json(
        { error: `Gemini ${status}${hint}: ${lastErrText.slice(0, 250)}` },
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

    return NextResponse.json({ results, usage, l4: parsed.l4 || null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
