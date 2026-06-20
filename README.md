# Catalogue Enrichment (In-house)

An MVP replacement for the third-party enrichment tool. It does three things:

1. **Build incorrect data** — degrade a clean golden sheet into realistic seller
   data (missing + image-conflicting values) so you have test inputs.
2. **Enrich seller data** — auto-detect any seller file layout, find mandatory
   fields, and fill/fix them from the product image using Gemini vision, applying
   a value only when confidence clears your threshold.
3. **Score accuracy** — optionally upload the golden sheet to measure how many of
   the tool's changes match the truth, with per-attribute breakdown, token usage
   and cost.

The MDD LOV dictionary is embedded in the backend (`data/mdd_lov.json`) — no need
to upload it.

## Run locally

```bash
npm install
cp .env.local.example .env.local      # then paste your Gemini key
npm run dev                            # http://localhost:3000
```

Get a key from Google AI Studio (https://aistudio.google.com/apikey).

## Deploy on Vercel

1. Push this folder to a GitHub repo.
2. Import the repo in Vercel (it auto-detects Next.js).
3. In **Project → Settings → Environment Variables**, add:
   - `GEMINI_API_KEY` = your key
4. Deploy. The Gemini call runs server-side in `app/api/enrich/route.ts`, so the
   key is never exposed to the browser.

## How it works

- `lib/parseWorkbook.ts` — reads CSV/XLSX, scores candidate header rows to find the
  real one (handles merged brand cells, stacked header rows, or a single header),
  and maps columns to MDD attribute IDs (via the golden `#ATTR_` row when present,
  else name/synonym matching).
- `lib/enrichClient.ts` — classifies each mandatory cell as missing / not-LOV-valid
  / conflict, sends one request per product to the API route, and applies the
  threshold.
- `app/api/enrich/route.ts` — fetches the product images server-side, sends them
  plus the allowed LOV values to Gemini, and returns a value + confidence per field.
- `lib/accuracy.ts` — aligns rows by SKU and scores only the cells the tool changed.
- `lib/cost.ts` — model list + pricing. **Update the rates here if Google changes
  pricing.** Current (June 2026): Flash $0.30/$2.50, Pro $1.25/$10.00 per 1M tokens.

## Things you may want to tune

- **Models / pricing**: `lib/cost.ts` (`MODELS`, `USD_TO_INR`).
- **Which attributes count as visual**: `VISUAL_ATTR_IDS` in `lib/referenceData.ts`.
- **Column synonyms** for non-standard seller headers: `HEADER_SYNONYMS` in the same file.
- **SKU matching key** for accuracy: `SKU_HEADER_KEYS` in `lib/referenceData.ts`.

## Notes

- One Gemini call is made per product (all of that product's problem fields in a
  single prompt) to keep cost and latency down.
- Image fetching happens on the server, which also sidesteps browser CORS issues.
  If an image host blocks server fetches, those fields are flagged, not filled.
