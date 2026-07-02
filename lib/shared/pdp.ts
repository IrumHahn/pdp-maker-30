export type AspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
export type PdpImageStyle = "studio" | "lifestyle" | "outdoor";
export type PdpModelGender = "female" | "male";
export type PdpModelAgeRange = "teen" | "20s" | "30s" | "40s" | "50s_plus";
export type PdpModelCountry = "korea" | "japan" | "usa" | "france" | "germany" | "africa";
export type PdpCopyLanguage = "ko" | "en";
export type ReferenceModelUsage = "hero-only" | "all-sections";
export type PdpGuidePriorityMode = "guide-first" | "style-first";
export type PdpAiProvider = "gemini" | "openai";
export type PdpSourceMode = "auto" | "product" | "redesign";
export type PdpOutputMode = "editable" | "full-image";
export type PdpAnalysisImageOptimizationMode =
  | "original"
  | "standard-resize"
  | "long-detail-sampling"
  | "long-detail-strips";
export type PdpSourceMaterialKind = "image" | "pdf";
export type PdpSourceMaterialRole = "primary" | "supporting";

export interface PdpAnalysisImageMetadata {
  mode: PdpAnalysisImageOptimizationMode;
  originalWidth: number;
  originalHeight: number;
  optimizedWidth: number;
  optimizedHeight: number;
  originalBytes: number;
  optimizedBytes: number;
  sampleCount?: number;
  // long-detail-strips mode
  stripCount?: number;
  stripWidth?: number;
  reductionFactor?: number;
  actualReduction?: number;
  generationReferenceWidth?: number;
  generationReferenceHeight?: number;
}

/**
 * One legible vertical strip of a long detail page. Strips are gap-free and
 * non-overlapping in source-Y, so [yStartRatio, yEndRatio] tile [0,1] exactly.
 */
export interface PdpAnalysisStrip {
  base64: string;
  mimeType: string;
  yStartRatio: number; // 0..1 over the original page height
  yEndRatio: number; // 0..1 over the original page height
}

export interface ScorecardItem {
  category: string;
  score: string;
  reason: string;
}

export interface SectionBlueprint {
  section_id: string;
  section_name: string;
  goal: string;
  headline: string;
  headline_en: string;
  subheadline: string;
  subheadline_en: string;
  bullets: string[];
  bullets_en: string[];
  trust_or_objection_line: string;
  trust_or_objection_line_en: string;
  CTA: string;
  CTA_en: string;
  layout_notes: string;
  compliance_notes: string;
  image_id: string;
  purpose: string;
  prompt_ko: string;
  prompt_en: string;
  negative_prompt: string;
  style_guide: string;
  reference_usage: string;
  story_beat?: SectionStoryBeat;
  generatedImage?: string;
}

/** Weakness diagnosis of the uploaded reference detail page (Approach A v2). */
export interface PdpCurrentPageDiagnosis {
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
}

/**
 * Normalized location of the cleanest isolated product packshot on the
 * reference page. Ratios are 0..1 over the page height spanned by the strips.
 * x bounds are null when the full strip width should be used.
 */
export interface PdpProductCutRegion {
  yStartRatio: number;
  yEndRatio: number;
  xStartRatio: number | null;
  xEndRatio: number | null;
  confidence: number; // 0..1
}

export interface LandingPageBlueprint {
  executiveSummary: string;
  scorecard: ScorecardItem[];
  blueprintList: string[];
  sections: SectionBlueprint[];
  narrativeSpine?: NarrativeSpine;
  // Approach A v2 long-detail analysis outputs (optional; absent for non-long inputs / old drafts)
  extractedSellingPoints?: string[];
  currentPageDiagnosis?: PdpCurrentPageDiagnosis;
  productCutRegion?: PdpProductCutRegion;
  // true when the reference page shows more than one distinct product (bundle/related/cross-sell);
  // drives an always-on "verify the intended product" warning under full-auto product-cut.
  multiProductPage?: boolean;
  /**
   * Model-identified clean standalone product photo among the uploaded materials
   * ([업로드 원본 자료 목록]의 자료 번호, 1-based). The client uses it as the hero/section
   * generation reference with top priority — a real product photo beats any crop guessed
   * out of a detail-page capture.
   */
  referenceProductImage?: PdpReferenceProductImage;
}

export interface PdpReferenceProductImage {
  /** 1-based index into the uploaded materials list as presented in the analyze prompt. */
  materialIndex: number;
  /** 0..1 — how confident the model is that this is a clean, text-free, single-product photo. */
  confidence: number;
}

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
    /**
     * Pass-1 transcription of the uploaded long detail page (see PdpTranscribeStripsRequest).
     * Gives body-copy generation the page's actual copy inventory instead of only the
     * hero blueprint's 8-line summary.
     */
    longPageTranscript?: string;
  };
}

export interface PdpExpandResponse {
  ok: true;
  narrativeSpine: NarrativeSpine;
  sections: SectionBlueprint[]; // hero (index 0) + expanded sections
}

export interface GeneratedResult {
  originalImage: string;
  originalImageMimeType?: string;
  originalImageFileName?: string;
  blueprint: LandingPageBlueprint;
}

export interface PdpCustomerReviewAnalysis {
  fileName: string;
  reviewCount: number;
  sampledReviewCount?: number;
  sampleReviews: string[];
  topBenefits: string[];
  painPoints: string[];
  improvementPromises: string[];
  keywordSummary: string[];
}

export interface PdpCustomerReviewInput {
  text: string;
  rating?: number;
}

export interface PdpCustomerReviewSource {
  fileName: string;
  reviewCount: number;
  sampledReviewCount?: number;
  reviews: PdpCustomerReviewInput[];
}

export interface PdpSourceMaterial {
  kind: PdpSourceMaterialKind;
  role?: PdpSourceMaterialRole;
  fileName: string;
  mimeType?: string;
  size?: number;
  pageCount?: number;
  text?: string;
  imageBase64?: string;
  imageMimeType?: string;
  imageOptimization?: PdpAnalysisImageMetadata;
}

export interface ImageGenOptions {
  style: PdpImageStyle;
  withModel: boolean;
  aiProvider?: PdpAiProvider;
  outputMode?: PdpOutputMode;
  imageModel?: string;
  modelGender?: PdpModelGender;
  modelAgeRange?: PdpModelAgeRange;
  modelCountry?: PdpModelCountry;
  guidePriorityMode?: PdpGuidePriorityMode;
  headline?: string;
  subheadline?: string;
  isRegeneration?: boolean;
  referenceModelImageBase64?: string;
  referenceModelImageMimeType?: string;
  referenceModelImageFileName?: string;
}

export interface PdpAnalyzeRequest {
  aiProvider?: PdpAiProvider;
  sourceMode?: PdpSourceMode;
  outputMode?: PdpOutputMode;
  imageBase64: string;
  mimeType: string;
  generationImageBase64?: string;
  generationImageMimeType?: string;
  imageOptimization?: PdpAnalysisImageMetadata;
  /**
   * Ordered legible strips of a long detail page. When present, these are sent
   * to the model as sequential top-to-bottom vision inputs in place of the
   * single squished board, and the server crops productCutRegion from them.
   */
  analysisStrips?: PdpAnalysisStrip[];
  sourceMaterials?: PdpSourceMaterial[];
  modelImageBase64?: string;
  modelImageMimeType?: string;
  modelImageFileName?: string;
  additionalInfo?: string;
  customerReviewAnalysis?: PdpCustomerReviewAnalysis;
  knowledgeText?: string;
  desiredTone?: string;
  aspectRatio: AspectRatio;
  sectionCount?: number;
  benefits?: string[];
  /**
   * Pass-1 full-text transcription of the long detail page (batched vision reads via
   * /pdp/transcribe-strips). When present the blueprint is designed from the page's ACTUAL
   * copy, not from what survives strip downscaling.
   */
  longPageTranscript?: string;
  /**
   * Skip the server-side hero image generation and return the blueprint with sections[0]
   * ungenerated. The client sets this when it holds the ORIGINAL upload file, so it can crop
   * productCutRegion from full-resolution pixels and generate the hero with that reference
   * instead of a low-res strip crop.
   */
  deferHeroGeneration?: boolean;
}

export interface PdpAnalyzeSuccessResponse {
  ok: true;
  result: GeneratedResult;
}

/**
 * Pass-1 of the long-detail-page 2-pass analysis: one batch of strips is transcribed
 * verbatim (copy inventory + section typing). Batches run sequentially on the client so
 * each request stays under Vercel's ~4.5MB body limit.
 */
export interface PdpTranscribeStripsRequest {
  aiProvider?: PdpAiProvider;
  strips: PdpAnalysisStrip[];
  batchIndex: number;
  batchCount: number;
  originalWidth?: number;
  originalHeight?: number;
  /** Section type the previous batch ended on, for continuity across batch boundaries. */
  previousSectionHint?: string;
}

export interface PdpTranscribeStripsSuccessResponse {
  ok: true;
  transcript: string;
  lastSectionType?: string;
}

export type PdpTranscribeStripsResponse = PdpTranscribeStripsSuccessResponse | PdpErrorResponse;

export interface PdpAnalyzeCustomerReviewsRequest {
  source: PdpCustomerReviewSource;
  productContext?: string;
  desiredTone?: string;
}

export interface PdpAnalyzeCustomerReviewsSuccessResponse {
  ok: true;
  analysis: PdpCustomerReviewAnalysis;
  model: string;
}

export interface PdpGenerateImageRequest {
  originalImageBase64: string;
  originalImageMimeType?: string;
  originalImageFileName?: string;
  section: SectionBlueprint;
  aspectRatio: AspectRatio;
  desiredTone?: string;
  options?: ImageGenOptions;
}

export interface PdpGenerateImageSuccessResponse {
  ok: true;
  imageBase64: string;
  mimeType: string;
}

export interface PdpValidateApiKeySuccessResponse {
  ok: true;
  message: string;
  analyzeModel: string;
  imageModel: string;
}

export type PdpErrorCode =
  | "GEMINI_API_KEY_MISSING"
  | "GEMINI_API_KEY_INVALID"
  | "GEMINI_MODEL_ACCESS_DENIED"
  | "OPENAI_API_KEY_MISSING"
  | "OPENAI_API_KEY_INVALID"
  | "OPENAI_MODEL_ACCESS_DENIED"
  | "INVALID_IMAGE_PAYLOAD"
  | "INVALID_REQUEST"
  | "GEMINI_QUOTA_EXCEEDED"
  | "OPENAI_QUOTA_EXCEEDED"
  | "GEMINI_RESPONSE_INVALID"
  | "OPENAI_RESPONSE_INVALID"
  | "PDP_ANALYZE_FAILED"
  | "PDP_IMAGE_GENERATION_FAILED";

export interface PdpErrorResponse {
  ok: false;
  code: PdpErrorCode;
  message: string;
  detail?: string;
}

export type PdpAnalyzeResponse = PdpAnalyzeSuccessResponse | PdpErrorResponse;
export type PdpAnalyzeCustomerReviewsResponse = PdpAnalyzeCustomerReviewsSuccessResponse | PdpErrorResponse;
export type PdpGenerateImageResponse = PdpGenerateImageSuccessResponse | PdpErrorResponse;
export type PdpValidateApiKeyResponse = PdpValidateApiKeySuccessResponse | PdpErrorResponse;
