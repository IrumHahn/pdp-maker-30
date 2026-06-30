# Cohesive Story Redesign — Implementation Plan (Stage 1: copy/flow/reviews)

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Project reality (overrides default TDD/commit cadence):** This repo has **no test framework and no git**. So "write failing test" → **write a mock/seed verification script or a typecheck assertion**; "commit" → **checkpoint = `pnpm typecheck` green + stated verification passed**. All work happens in `/Users/irun_hahn/Documents/Codex/pdp-maker-30-redesign` (port 3010), never the original.

**Goal:** Replace the client-side hardcoded section-expansion template engine with a server LLM endpoint (`/pdp/expand`) that generates a shared narrative spine + all sections in one call, so the detail page reads as one cohesive, conversion-focused story that weaves in customer-review insight (or stands strong without it).

**Architecture:** A new `NarrativeSpine` object (target customer, core struggle, transformation, throughline, review insights) plus a per-section `story_beat` (beatGoal, connectionToPrev, reviewAngle) are added to the blueprint types. A new `POST /api/pdp/expand` takes the hero blueprint + chosen style + optional review analysis and returns `{ narrativeSpine, sections[] }` from a single LLM call. The client's `handleApplyExpansionStrategy` calls this endpoint, with the existing template engine kept as a fallback.

**Tech Stack:** Next.js 14 App Router, TypeScript, `@google/genai` (Gemini) + OpenAI, existing `PdpService`/`PdpController` pattern.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/shared/pdp.ts` | Shared contracts | ADD `NarrativeSpine`, `SectionStoryBeat`; extend `LandingPageBlueprint`, `SectionBlueprint`; ADD `PdpExpandRequest`/`PdpExpandResponse` |
| `lib/pdp-server/pdp.service.ts` | Generation logic | ADD `buildExpandPrompt()`, `expandLandingPage()`; reuse existing `sanitizeVisibleCopy`, JSON-parse, provider-call helpers |
| `lib/pdp-server/pdp.controller.ts` | Thin orchestration | ADD `expand()` |
| `app/api/pdp/expand/route.ts` | HTTP boundary | CREATE (clone analyze route's status-mapping + key headers + try/catch) |
| `app/pdp-maker/PdpEditor.tsx` | Editor expansion handler | MODIFY `handleApplyExpansionStrategy` → async `/pdp/expand` call + fallback; pass `flowIntent`/`keyMessage` from `EXPANSION_STRATEGIES` |
| `app/pdp-maker/pdp-utils.ts` | client API helper | (no change — reuse `apiJson` with `GENERATION_API_TIMEOUT_MS`) |

---

## Task 1: Shared types for the narrative spine

**Files:**
- Modify: `lib/shared/pdp.ts` (after `LandingPageBlueprint`, ~line 66)

- [ ] **Step 1: Add the spine + request/response types**

Add to `lib/shared/pdp.ts`:

```ts
export interface SectionStoryBeat {
  beatGoal: string;          // what this section does in the overall sale
  connectionToPrev: string;  // how it picks up from the previous section
  reviewAngle?: string;      // review insight to weave in (when reviews exist)
}

export interface NarrativeSpine {
  targetCustomer: string;
  coreStruggle: string;
  transformation: string;
  throughline: string;       // one line that runs through the whole page
  reviewInsights?: {
    topBenefits: string[];
    painPoints: string[];
    improvementPromises: string[];
  };
}

export type PdpExpansionStyle = "storybrand" | "objection" | "scenario" | "comparison";

export interface PdpExpandStyleGuide {
  id: PdpExpansionStyle;
  title: string;
  flowIntent: string;
  keyMessage: string;
  sectionRoster: Array<{ id: string; name: string; intent: string }>;
}

export interface PdpExpandRequest {
  heroBlueprint: LandingPageBlueprint;
  style: PdpExpandStyleGuide;
  reviewAnalysis?: PdpCustomerReviewAnalysis;
  productContext: {
    additionalInfo?: string;
    desiredTone?: string;
    aspectRatio: AspectRatio;
    aiProvider: PdpAiProvider;
    outputMode: PdpOutputMode;
  };
}

export interface PdpExpandResponse {
  ok: true;
  narrativeSpine: NarrativeSpine;
  sections: SectionBlueprint[]; // hero (index 0) + expanded sections
}
```

- [ ] **Step 2: Extend the existing blueprint types**

In `lib/shared/pdp.ts`, add optional fields (do NOT make required — preserves backward compat with existing drafts):
- `SectionBlueprint` (~line 58, before `generatedImage?`): add `story_beat?: SectionStoryBeat;`
- `LandingPageBlueprint` (~line 65, after `sections`): add `narrativeSpine?: NarrativeSpine;`

- [ ] **Step 3: Verify (checkpoint)**

Run: `cd /Users/irun_hahn/Documents/Codex/pdp-maker-30-redesign && pnpm typecheck`
Expected: PASS (rc 0). New types compile; optional fields don't break existing code.

---

## Task 2: Server — expand prompt + `expandLandingPage`

**Files:**
- Modify: `lib/pdp-server/pdp.service.ts` (add near the analyze helpers; reuse the same Gemini/OpenAI JSON-call + parse + sanitize utilities `analyzeProduct` uses)

- [ ] **Step 1: Add `buildExpandPrompt(request: PdpExpandRequest): string`**

The prompt MUST instruct the model to return strict JSON `{ narrativeSpine, sections }` and MUST include these rules (mirror the existing `buildAnalyzePrompt` anti-leakage/anti-fabrication wording at `pdp.service.ts:1403-1414` and conversion guidance at `:1350-1370`):

1. **Spine first:** derive `targetCustomer`, `coreStruggle`, `transformation`, `throughline` from the hero blueprint (`executiveSummary`, `blueprintList`, hero section copy).
2. **One story:** every section's copy must extend the previous one; fill each section's `story_beat.connectionToPrev` with the actual handoff sentence. The `throughline` must be felt across sections without repeating the same phrase (reuse rule `:1353`).
3. **Style arc:** follow `request.style.flowIntent` / `keyMessage` / `sectionRoster` — generate exactly the roster's sections, in order, with their roles.
4. **Reviews present** (`reviewAnalysis` truthy): set `narrativeSpine.reviewInsights` from topBenefits/painPoints/improvementPromises, and distribute concrete insights into per-section `story_beat.reviewAngle` and the section bullets/trust line. **No fabricated counts/effects/certifications.**
5. **Reviews absent:** build persuasion from product context only; same anti-fabrication rule; `reviewInsights` omitted.
6. **No internal labels** as visible copy (role names like "문제 제기" must never appear as headline/subheadline) — same prohibition as `:1404-1405`.
7. **Full-image mode:** CTA empty (`buildOnImageCopy` rule `:1656-1658`).
8. Output every `SectionBlueprint` field the type requires (headline/subheadline/bullets/trust_or_objection_line/CTA + _en variants + layout_notes/compliance_notes/prompt_ko/prompt_en/negative_prompt/style_guide/reference_usage/purpose/image_id/section_id/section_name/goal), plus `story_beat`.

- [ ] **Step 2: Add `async expandLandingPage(request, geminiKey?, openAiKey?): Promise<PdpExpandResponse>`**

Mirror `analyzeProduct`'s structure (`pdp.service.ts:388-506`):
- Validate required fields (`heroBlueprint.sections[0]` exists, `style.sectionRoster` non-empty) → throw `PdpServiceError("INVALID_REQUEST", ...)` otherwise.
- Resolve provider (gemini default / openai) and key via existing `getRequiredApiKey`.
- Call the model with `buildExpandPrompt(request)` using the SAME generateContent/JSON-extraction path `analyzeProduct` uses (reuse its JSON parse + `retryOperation`).
- Run the parsed sections through the existing `sanitizeBlueprint`/`normalizeSection`/`sanitizeVisibleCopy` pipeline so label-leak/CTA-dup/generic filters apply.
- Return `{ ok: true, narrativeSpine, sections: [hero, ...expanded] }` where `hero = request.heroBlueprint.sections[0]` (preserve the already-generated hero verbatim; only sections 2..N come from the LLM).

- [ ] **Step 3: Verify (checkpoint)**

Run: `pnpm typecheck`
Expected: PASS. Then a seed check: write `output/redesign-verify/expand-shape.mjs` that imports nothing live but asserts the function exists and (with a mocked provider response) returns the right shape — OR defer runtime check to Task 5's mock. Minimum: typecheck green.

---

## Task 3: Controller + route

**Files:**
- Modify: `lib/pdp-server/pdp.controller.ts`
- Create: `app/api/pdp/expand/route.ts`

- [ ] **Step 1: Add `expand` to the controller**

In `pdp.controller.ts`, mirror `analyze` (`pdp.controller.ts:33-43`):

```ts
async expand(body: PdpExpandRequest, geminiApiKeyOverride?: string, openAiApiKeyOverride?: string) {
  try {
    return await this.pdpService.expandLandingPage(body, geminiApiKeyOverride, openAiApiKeyOverride);
  } catch (error) {
    return toPdpErrorResponse(error);
  }
}
```

- [ ] **Step 2: Create the route**

Create `app/api/pdp/expand/route.ts` by cloning `app/api/pdp/analyze/route.ts` exactly (same `dynamic`/`runtime`, key-header reads, `mapErrorCodeToStatus`), swapping the body type to `PdpExpandRequest` and the call to `pdpController.expand(...)`. Wrap `request.json()` in try/catch returning 400 `INVALID_REQUEST` (apply the fix the analyze route still lacks).

- [ ] **Step 3: Verify (checkpoint)**

Run: `pnpm typecheck` → PASS.
Run: start dev on 3010, `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3010/api/pdp/expand -H 'content-type: application/json' -d '{}'` → expect `400` (clean validation, not a 500 stack).

---

## Task 4: Client — call `/pdp/expand` with fallback

**Files:**
- Modify: `app/pdp-maker/PdpEditor.tsx` — `handleApplyExpansionStrategy` (~line 2551) and the `EXPANSION_STRATEGIES` objects (~line 319)

- [ ] **Step 1: Make `handleApplyExpansionStrategy` async and call the endpoint**

Replace the synchronous `selectedExpansionStrategy.sections.map(buildExpansionSectionCopy)` block (`PdpEditor.tsx:2568-2614`) with:
- Build `PdpExpandStyleGuide` from `selectedExpansionStrategy` (id/title/flowIntent/keyMessage + sectionRoster from its `.sections`).
- `const response = await apiJson<PdpExpandResponse | PdpErrorResponse>("/pdp/expand", { method: "POST", body: JSON.stringify({ heroBlueprint: initialResult.blueprint, style, reviewAnalysis: customerReviewAnalysis ?? undefined, productContext: {...} }) }, { geminiApiKey, openAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS });`
- If `response.ok`: `nextSections = response.sections`, store `response.narrativeSpine` on the editor result (so later sections/images can reference it), then the EXISTING tail (`setSections` → `generateMissingImagesForSections`) runs unchanged.

- [ ] **Step 2: Keep the template engine as fallback**

On `!response.ok` OR a thrown error: log it, set a non-blocking notice (`"AI 확장에 실패해 기본 템플릿으로 구성했어요."`), and run the ORIGINAL `buildExpansionSectionCopy` map (keep that code path intact — do not delete `buildExpansionSectionCopy`/`buildRoleFallbackCopy`). This guarantees the feature always produces sections.

- [ ] **Step 3: Guard double-entry / loading state**

The handler now awaits; disable the expansion CTA while in flight (reuse existing loading affordance) so it can't be double-fired. Preserve the existing `sections.length > 1` guard at the top.

- [ ] **Step 4: Verify (checkpoint)**

Run: `pnpm typecheck` → PASS.
Manual on 3010: seed a 1-section hero draft, pick a style, confirm the request fires; with the endpoint mocked to fail, confirm the fallback template still builds sections and shows the notice.

---

## Task 5: Integration verification + adversarial review

- [ ] **Step 1: Mock-driven shape check**

Write `output/redesign-verify/expand-mock.mjs` (or a Playwright route-intercept like the existing `output/playwright/*` scripts) that intercepts `/api/pdp/expand` with a canned `{ narrativeSpine, sections }` and drives the editor expansion, asserting: sections rendered in roster order, `narrativeSpine` stored, no console errors, mobile scrollWidth == viewport.

- [ ] **Step 2: Adversarial prompt review**

Dispatch a subagent to read `buildExpandPrompt` and confirm it cannot produce: visible role labels, fabricated review counts/effects, or duplicated CTAs/headlines across sections. Fix wording if it can.

- [ ] **Step 3: Side-by-side compare (user-facing)**

Run original on 3002 and redesign on 3010. 한이룸님 generates the same product + same style in both and compares flow/copy/review-usage. (Real paid generation uses 한이룸's keys.)

- [ ] **Step 4: Final checkpoint**

`pnpm typecheck` green in redesign folder; no regressions to hero generation or image flow; spine path + fallback path both verified.

---

## Self-review notes
- Spec coverage: spine object (§3.1)→T1; `/pdp/expand` (§3.2)→T2,T3; 4-style→spine (§5)→T2 step1 rule 3 + T4 step1; review branch (§6)→T2 step1 rules 4-5; fallback (§7)→T4 step2; verification (§8)→T5; isolation (§9)→header. All covered.
- Type consistency: `PdpExpandResponse.sections` / `narrativeSpine` names match T1 definitions and T4 usage; `PdpExpandStyleGuide` built in T4 matches T1.
- No git: every "commit" replaced by a typecheck+verify checkpoint.
