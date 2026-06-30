# 긴 상세페이지 가독 스트립 분석 (Approach A v2) — Design Spec

- Date: 2026-06-30
- Folder (source of truth): `pdp-maker-30-redesign` (port 3010), designated by 한이룸님
- Status: Design approved; implementation pending plan
- Verified: adversarially reviewed by a 5-lens code review against the real codebase before this spec (2 blockers + two-SKU-leak risk caught and folded in)

## 1. Problem

When a tall detail page is uploaded (e.g. `3840×28800px`), the optimizer does NOT send the
real image to the model. `app/api/pdp/optimize-image/route.ts` classifies it as a "long detail
page" (`isLongDetailPage`: `height ≥ 3200 && height/width ≥ 4.5`) and:

1. `buildLongDetailPagePayload` squishes 14 source slices (each `3840×5180`) ~9.5× into `404×545`
   tiles on a single `1024×3903` board. At that scale the product label text is ~1px → illegible.
   The AI cannot read **which** product it is, nor the page copy/selling points, and anchors on the
   biggest/most-repeated visual.
2. `buildGenerationReferencePayload` crops **only the top ~5184px (≈18%)** of the page
   (`extract({left:0, top:0, width, height: round(width*1.35)})`) as the hero generation reference.
   So the new hero is drawn from a banner/lifestyle region, not a clean product shot.

Both files are byte-identical to the sibling `pdp-maker-30`, so this bug exists in both folders.

User-reported symptom: a Bushman 워터프루프 선크림 detail page produces a hero showing the **wrong
product**, because (a) the label is unreadable and (b) the page contains more than one SKU.

## 2. Goals / Non-goals

Goals (한이룸님 priorities: output quality > cost; failure-visibility):
- Read product identity + **selling points / real copy** off the reference page (legibly).
- Extract a clean **product cut** from the real product region (not the top banner).
- Produce a user-visible **current-page weakness diagnosis** and use it to design a better new page.
- Lock the **primary SKU** so a second product's copy never leaks into the new page.

Non-goals:
- No change to the `460px` canvas coordinate system or `1080px` export width.
- No change to standard/oversized/original image paths (only the long-detail path changes).
- `PdpEditor.tsx` is intentionally untouched (see §9).

## 3. Architecture — 4 stages, 1 analyze AI call, 0 extra uploads

```
upload → ① optimize (sharp): page → ordered legible strips[]  (drop board + top-18% crop)
       → ② analyze (1 AI call): strips as ordered vision inputs →
              blueprint(sections, SKU-locked copy) + extractedSellingPoints[]
              + currentPageDiagnosis{strengths,weaknesses,improvements} + productCutRegion{...}
       → ③ SERVER-side crop (between blueprint parse and hero gen): crop productCutRegion from
              the strips → use as the hero/section generation reference
       → ④ grounding: selling points flow into section copy (trusted channel); improvements shape
              blueprint STRATEGY only (never on-image facts); result.originalImage = product cut
```

Critical correction from review (blocker): the hero image is generated **inside** the single
`/analyze` server call (`analyzeProduct` → `generateSectionImageInternal` at
`pdp.service.ts:531`, returns `originalImage: generationImage` at `:562`; OpenAI path `:673/:803`).
Therefore the product crop **must be server-side, after the blueprint (incl. `productCutRegion`)
is parsed and before `generateSectionImageInternal` runs** — NOT a post-analyze client step. This
keeps "1 AI call" honest.

## 4. Component changes (redesign file:line)

### 4.1 `app/api/pdp/optimize-image/route.ts`  (byte-identical to sibling; safe to edit — not locked)
- Replace `buildLongDetailPagePayload` with `buildLongDetailStrips`:
  - Strip geometry: width `= min(LONG_DETAIL_STRIP_WIDTH=1536, round(sourceWidth/2.5))`; each strip's
    **shortest side ≤ 768** (wide-short, e.g. `1536×768`) so neither Gemini nor OpenAI re-downscales
    (OpenAI high caps shortest side to 768 → would otherwise undo the 2.5× gain).
  - **Derived** strip count (not a fixed range): `stripCount = clamp(ceil((sourceHeight/2.5)/stripHeight), 4, 16)`.
    For `3840×28800` → ~15 strips at true 2.5×.
  - Each strip carries `{ base64, mimeType, yStartRatio, yEndRatio }`, gap-free and non-overlapping in
    source-Y so ratios tile `[0,1]` exactly (enables clean region→strip mapping).
  - Record `analysisMetadata` mode `long-detail-strips` with `stripCount`, `stripWidth`, `reductionFactor`,
    `actualReduction = sourceHeight/(stripCount*stripHeight)`. If `actualReduction > 3.0`, log a visible
    warning and allow stripCount up to 16 before reduction grows further.
  - **Delete** the `buildGenerationReferencePayload` top-18% crop. The hero reference now comes from the
    server-side `productCutRegion` crop (§4.3); provisional reference = a mid-document strip.
- Payload gains `analysisStrips: { base64, mimeType, yStartRatio, yEndRatio }[]` (full per-strip base64).

### 4.2 `app/pdp-maker/pdp-utils.ts`  (byte-identical to sibling; not locked)
- **Force all long-detail pages to the server strip path.** Today `prepareImageFile` falls through to a
  client-side `buildLongDetailPagePayload` for some long-but-not-oversized pages → old board, zero strips.
  Route `isLongDetailPage` unconditionally to `optimizeImageFileOnServer`; retire the client board builder
  for long pages. Align the duplicated `LONG_DETAIL_*` constants.
- Pass `analysisStrips[]` from the server payload through `PreparedImage`.

### 4.3 `lib/pdp-server/pdp.service.ts`  (free — not locked)
- **Multi-image input**: add `buildStripImageParts` (Gemini) / `buildStripImageInputs` (OpenAI),
  mirroring `buildGeminiSourceMaterialImageParts`/`buildOpenAiSourceMaterialImageInputs` but with
  **no role filter and no `MAX_ANALYZE_SOURCE_IMAGES=5` cap** (`:38`). Insert strip parts in array order in
  place of the single primary image part. Add a separate server-side `MAX_ANALYZE_STRIPS = 16`.
- **Prompt rewrite** (the `long-detail` branch of `buildImageOptimizationPrompt`): tell the model the
  N images are **sequential top→bottom strips of ONE page**; (1) lock the PRIMARY product (dominant,
  consistent packshot); (2) extract `extractedSellingPoints` **for that SKU only** — if the page shows
  other products/bundles/cross-sells, do NOT attribute their copy/claims to the primary; (3) diagnose
  current-page weaknesses; (4) design a NEW page that fixes those weaknesses; (5) return `productCutRegion`
  ratios normalized over the page height spanned by the strips.
- **Output fields** added to `LandingPageBlueprint`/`GeneratedResult`:
  - `extractedSellingPoints: string[]` (SKU-scoped, literally-read copy/claims/specs)
  - `currentPageDiagnosis: { strengths: string[]; weaknesses: string[]; improvements: string[] }`
  - `productCutRegion: { yStartRatio:number; yEndRatio:number; xStartRatio:number|null; xEndRatio:number|null; confidence:number }`
- **Schema edits (THREE coordinated, both providers)**:
  - Gemini `responseSchema` (`Type.OBJECT` in `analyzeProduct`): add the new properties.
  - `OPENAI_BLUEPRINT_SCHEMA` (`:117`, used `strict:true` at `:388/:752`): add properties **and** to
    `required[]` (strict mode requires every property be required); nested `productCutRegion` needs its own
    `additionalProperties:false` + full `required`; optional x-bounds as `{type:['number','null']}` (not omission).
  - `sanitizeBlueprint` (`:2738`): surface + normalize the 3 fields (clamp ratios to `0..1`, default
    `confidence`, cap string lists), or they are dropped after parse.
- **Server-side product crop (§3 stage 3)**: after blueprint parse, before `generateSectionImageInternal`
  (`:531` Gemini / `:673` OpenAI), map `productCutRegion` → strip(s) by `yStart/yEnd` ratio overlap, crop
  with sharp from the strip base64 the request already carries, and use the crop as
  `originalImageBase64` for hero/section generation; set `originalImage` to it (`:562/:803`).
  - Fallback: if `confidence < 0.5` (tunable), region invalid (`yEnd≤yStart` / implausible area), or missing →
    use a **mid-document** strip (never the top, to avoid banners) and emit a visible notice.
  - Spanning case (region crosses 2 strips): compose a temp canvas across both, then crop.
  - Mixed upload: if a clean standalone product image exists (primary or supporting), prefer it as the
    reference over a strip crop.
- **Grounding (§3 stage 4)**: extend the grounding clause (`~:2200` "grounded in the reference image or
  section copy") to also whitelist `extractedSellingPoints`; keep the explicit ban on invented
  수치/효능/인증/후기 verbatim. Route `extractedSellingPoints` into section copy fields (the already-trusted
  channel) via the existing `pdp-copy-normalization`. **`improvements` go ONLY into blueprint/copy strategy
  reasoning — never into image generation** (they are AI-suggested changes, not on-page facts).

### 4.4 `app/pdp-maker/PdpMakerClient.tsx`  (free — not locked)
- Send `analysisStrips[]` in the `/analyze` request (alongside existing `imageBase64`/`generationImageBase64`
  at `:1242/:1244`; strips are the new field, NOT `sourceMaterials` at `:1247`).
- Render a new **"현재 페이지 진단 + 추출 셀링포인트"** panel from `result.currentPageDiagnosis` /
  `result.extractedSellingPoints` after analyze (the existing blueprint diagnostics are not rendered today,
  so this is new read-only UI). Wire failure-visibility notices (low-confidence productCut fallback,
  strip-build failure) using the existing `setNotice`/`logSetupEvent` patterns.

### 4.5 `lib/shared/pdp.ts` + `index.ts`  (free — not locked)
- Add `analysisStrips` to `PdpAnalyzeRequest`; add the 3 new fields to the analyze result type
  (`GeneratedResult.blueprint` / `LandingPageBlueprint`). Export new types.

## 5. Deferred (do LAST, after the active 21:54 lock on `pdp-drafts.ts` reaches Done)
- `app/pdp-maker/pdp-drafts.ts`: `normalizeGeneratedResult` (`:393`) rebuilds `blueprint` field-by-field
  (`:403/:417`) and will **silently drop** the 3 new fields on every load/save. Thread them through with
  validation/clamping; decide store-vs-recompute; **bump `PDP_DRAFT_VERSION`** (`:20`) with a
  backward-compatible path (old drafts load with the fields empty). This is the AGENTS.md
  "schema change needs a backward-compatible normalization path" requirement.

## 6. Out of scope
- `app/pdp-maker/PdpEditor.tsx`: untouched. Because the server sets `result.originalImage` to the cropped
  product cut and bakes SKU-grounded copy into sections, section regeneration (`PdpMakerClient.tsx:1045`
  uses `result.originalImage`) and the editor inherit the fix automatically. This also avoids the recent
  23:19/23:28 PdpEditor edits.
- Canvas `460px` / export `1080px`: unaffected (input-side change only).

## 7. Cost
~12–16 legible strips per long page → analyze input image tokens ≈ 3–5× the current single board.
Accepted under 한이룸님's "quality-first" choice; bounded by `MAX_ANALYZE_STRIPS=16` + `actualReduction`
logging. Consider `thinkingLevel` MEDIUM if copy-reading across strips needs it.

## 8. Verification
- `pnpm typecheck` in this folder (3010 dev server live → do NOT run `pnpm build`).
- Deterministic strip-geometry unit check (count/width/reduction for `3840×28800` → ~15 strips, 2.5×, shortest side ≤768).
- Long-image fixture through `optimize-image` → confirm strips are legible and the product region crops correctly; verify the wrong-SKU copy is excluded.
- Standard image + original small image paths unchanged.
- Manual: before/after of the hero reference (top-banner crop → real product cut).

## 9. Open risks
- Small legal/spec footnote text at 2.5× (~13px) is borderline; validate on 2–3 real Korean pages.
- `productCutRegion` reliability is model-dependent; mitigated by confidence threshold + visible fallback.
- Strip crop fidelity (~1536-wide source) is comparable to today's 1024-wide long-page reference (not a
  regression) but lower than the 2048 standard path; guard: if crop longest side < ~1024px, fall back to
  the full representative strip.
- Two diverged folders remain; 한이룸님 should consolidate to a single canonical folder later.
