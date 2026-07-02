// Vercel serverless functions reject request bodies over ~4.5MB at the edge (HTTP 413
// FUNCTION_PAYLOAD_TOO_LARGE) BEFORE the function code runs. The /api/pdp/analyze request
// bundles several base64 image copies (primary analysis + primary generation + optional model +
// up to 8 source-material images) plus text into ONE JSON body. Without a total-byte budget a
// handful of ordinary photos (e.g. 1.9MB x4) trivially exceed 4.5MB. This module is the pure,
// DOM-free math the client uses to (a) size each base64 copy and (b) refuse/shrink a request
// before it 413s. Keep it dependency-free so it stays Node-testable.

// Safe ceiling for a whole request body, well under Vercel's 4.5MB so JSON overhead, headers,
// text fields, and multipart boundaries never tip it over.
export const REQUEST_SAFE_BODY_BYTES = 3_800_000;

// Per-copy targets used by the client when re-encoding images before upload.
export const ANALYSIS_IMAGE_MAX_BYTES = 700_000; // 1024px-ish analysis JPEG
export const GENERATION_IMAGE_MAX_BYTES = 1_400_000; // 2048px-ish generation reference JPEG

export interface AnalyzePayloadParts {
  imageBase64?: string;
  generationImageBase64?: string;
  modelImageBase64?: string;
  sourceImageBase64s?: string[];
  /** Approx character count of all text fields (knowledge/reviews/additionalInfo/tone). */
  textChars?: number;
}

export interface AnalyzeBudgetSummary {
  /** Approx raw request-body size (what Vercel weighs against the 4.5MB limit). */
  totalBytes: number;
  /** Approx decoded image size, for human-facing "총 N MB" messages. */
  displayBytes: number;
  budget: number;
  overBy: number;
  exceeds: boolean;
}

/** Decoded byte length of a base64 string (accounts for `=` padding). Content is not read. */
export function estimateBase64Bytes(base64: string | undefined | null): number {
  if (!base64) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Wire cost a base64 field adds to the JSON request body. The body literally contains the base64
 * STRING, so each character is ~1 body byte — i.e. ~1.33x the decoded image size. This (not the
 * decoded size) is what Vercel's 4.5MB body limit measures.
 */
export function base64BodyCost(base64: string | undefined | null): number {
  return base64 ? base64.length : 0;
}

function allImageBase64(parts: AnalyzePayloadParts): (string | undefined)[] {
  return [parts.imageBase64, parts.generationImageBase64, parts.modelImageBase64].concat(
    parts.sourceImageBase64s ?? []
  );
}

/** Approx raw request-body bytes an analyze request will carry (every base64 copy + text). */
export function measureAnalyzePayloadBytes(parts: AnalyzePayloadParts): number {
  const images = allImageBase64(parts).reduce((sum, base64) => sum + base64BodyCost(base64), 0);
  // Text is UTF-8; JSON-escaped Korean can exceed 1 byte/char, but text is capped elsewhere
  // (MAX_SOURCE_MATERIAL_TEXT_CHARS) and small next to images — a 1:1 estimate is enough headroom.
  return images + Math.max(0, parts.textChars ?? 0);
}

export function summarizeAnalyzeBudget(
  parts: AnalyzePayloadParts,
  budget: number = REQUEST_SAFE_BODY_BYTES
): AnalyzeBudgetSummary {
  const totalBytes = measureAnalyzePayloadBytes(parts);
  const displayBytes = allImageBase64(parts).reduce((sum, base64) => sum + estimateBase64Bytes(base64), 0);
  const overBy = Math.max(0, totalBytes - budget);
  return { totalBytes, displayBytes, budget, overBy, exceeds: totalBytes > budget };
}

export function analyzePayloadExceedsBudget(
  parts: AnalyzePayloadParts,
  budget: number = REQUEST_SAFE_BODY_BYTES
): boolean {
  return measureAnalyzePayloadBytes(parts) > budget;
}

/** Bytes as a short human string (MB with one decimal) for user-facing Korean messages. */
export function formatBytesMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}
