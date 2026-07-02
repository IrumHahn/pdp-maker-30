import { createHash } from "crypto";
import sharp from "sharp";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import {
  inferPdpSectionVisualRole,
  inferPdpCopyProductKind,
  normalizePdpReviewBenefitSalesCopy,
  normalizePdpReviewBenefitSalesCopyList
} from "../shared";
import type {
  AspectRatio,
  ImageGenOptions,
  LandingPageBlueprint,
  PdpAiProvider,
  PdpAnalysisImageMetadata,
  PdpAnalysisStrip,
  PdpCurrentPageDiagnosis,
  PdpProductCutRegion,
  PdpReferenceProductImage,
  PdpAnalyzeCustomerReviewsRequest,
  PdpOutputMode,
  PdpCustomerReviewAnalysis,
  PdpCustomerReviewInput,
  PdpCustomerReviewSource,
  PdpGuidePriorityMode,
  PdpAnalyzeRequest,
  PdpErrorCode,
  PdpSourceMaterial,
  PdpSourceMode,
  PdpSectionVisualRole,
  PdpExpandRequest,
  PdpExpandResponse,
  PdpTranscribeStripsRequest,
  NarrativeSpine,
  SectionStoryBeat,
  SectionBlueprint
} from "../shared";

const ANALYZE_MODEL = "gemini-3.1-pro-preview";
const IMAGE_MODEL = "gemini-3-pro-image-preview";
const OPENAI_ANALYZE_MODEL = "gpt-5.5";
const OPENAI_CUSTOMER_REVIEW_MODEL = "gpt-5.4-mini";
const OPENAI_IMAGE_MODEL = "gpt-image-2-2026-04-21";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_IMAGE_MIME = "image/jpeg";
const REFERENCE_MODEL_MAX_ATTEMPTS = 3;
const MAX_CUSTOMER_REVIEW_ANALYSIS_ROWS = 250;
const MAX_ANALYZE_SOURCE_MATERIALS = 8;
const MAX_ANALYZE_SOURCE_IMAGES = 5;
const MAX_ANALYZE_STRIPS = 16;
const PRODUCT_CUT_MIN_CONFIDENCE = 0.5;
// Pass-1 transcription (2-pass long-page analysis): per-batch strip cap keeps one request well
// under Vercel's body limit; transcript caps bound the text injected into later prompts.
const MAX_TRANSCRIBE_STRIPS_PER_BATCH = 8;
const MAX_LONG_PAGE_TRANSCRIPT_CHARS = 60_000;
const MAX_EXPAND_TRANSCRIPT_CHARS = 14_000;
const MAX_ANALYZE_SOURCE_TEXT_CHARS = 40000;
const MAX_ANALYZE_SOURCE_TEXT_CHARS_PER_FILE = 12000;
const MODEL_ACCESS_CACHE_TTL_MS = 10 * 60 * 1000;
const REFERENCE_MODEL_PROFILE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_MODEL_ACCESS_CACHE_ENTRIES = 48;
const MAX_REFERENCE_MODEL_PROFILE_CACHE_ENTRIES = 24;

type GeneratedImagePayload = {
  base64: string;
  mimeType: string;
};

type ReferenceModelProfile = {
  genderPresentation: string;
  ageImpression: string;
  faceShape: string;
  hairstyle: string;
  skinTone: string;
  eyeDetails: string;
  browDetails: string;
  lipDetails: string;
  overallVibe: string;
  distinctiveFeatures: string[];
  keepTraits: string[];
  flexibleTraits: string[];
};

type GeneratedImageValidation = {
  isSamePerson: boolean;
  genderPresentationPreserved: boolean;
  styleMatch: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  correctionFocus: string[];
};

type InternalImageGenOptions = ImageGenOptions & {
  guidePriorityMode: PdpGuidePriorityMode;
  outputMode: PdpOutputMode;
  referenceModelProfile?: ReferenceModelProfile | null;
  retryDirective?: string;
  imageModel?: string;
};

type NormalizedReferenceModelImage = {
  base64: string;
  mimeType: string;
};

type NormalizedAnalysisStrip = {
  base64: string;
  mimeType: string;
  yStartRatio: number;
  yEndRatio: number;
};

type ModelAccessCheck = {
  accessible: boolean;
  status: number;
  detail?: string;
};

type PromiseCacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const modelAccessCache = new Map<string, PromiseCacheEntry<ModelAccessCheck>>();
const referenceModelProfileCache = new Map<string, PromiseCacheEntry<ReferenceModelProfile>>();

type OpenAiResponsePayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

type OpenAiRequestOptions = {
  method: "GET" | "POST";
  body?: unknown;
};

const OPENAI_BLUEPRINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "executiveSummary",
    "scorecard",
    "blueprintList",
    "sections",
    "extractedSellingPoints",
    "currentPageDiagnosis",
    "productCutRegion",
    "multiProductPage",
    "referenceProductImage"
  ],
  properties: {
    multiProductPage: { type: "boolean" },
    referenceProductImage: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["materialIndex", "confidence"],
      properties: {
        materialIndex: { type: "number" },
        confidence: { type: "number" }
      }
    },
    extractedSellingPoints: {
      type: "array",
      items: { type: "string" }
    },
    currentPageDiagnosis: {
      type: "object",
      additionalProperties: false,
      required: ["strengths", "weaknesses", "improvements"],
      properties: {
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: { type: "string" } }
      }
    },
    productCutRegion: {
      type: "object",
      additionalProperties: false,
      required: ["yStartRatio", "yEndRatio", "xStartRatio", "xEndRatio", "confidence"],
      properties: {
        yStartRatio: { type: "number" },
        yEndRatio: { type: "number" },
        xStartRatio: { type: ["number", "null"] },
        xEndRatio: { type: ["number", "null"] },
        confidence: { type: "number" }
      }
    },
    executiveSummary: { type: "string" },
    scorecard: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "score", "reason"],
        properties: {
          category: { type: "string" },
          score: { type: "string" },
          reason: { type: "string" }
        }
      }
    },
    blueprintList: {
      type: "array",
      items: { type: "string" }
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "section_id",
          "section_name",
          "goal",
          "headline",
          "headline_en",
          "subheadline",
          "subheadline_en",
          "bullets",
          "bullets_en",
          "trust_or_objection_line",
          "trust_or_objection_line_en",
          "CTA",
          "CTA_en",
          "layout_notes",
          "compliance_notes",
          "image_id",
          "purpose",
          "prompt_ko",
          "prompt_en",
          "negative_prompt",
          "style_guide",
          "reference_usage"
        ],
        properties: {
          section_id: { type: "string" },
          section_name: { type: "string" },
          goal: { type: "string" },
          headline: { type: "string" },
          headline_en: { type: "string" },
          subheadline: { type: "string" },
          subheadline_en: { type: "string" },
          bullets: {
            type: "array",
            items: { type: "string" }
          },
          bullets_en: {
            type: "array",
            items: { type: "string" }
          },
          trust_or_objection_line: { type: "string" },
          trust_or_objection_line_en: { type: "string" },
          CTA: { type: "string" },
          CTA_en: { type: "string" },
          layout_notes: { type: "string" },
          compliance_notes: { type: "string" },
          image_id: { type: "string" },
          purpose: { type: "string" },
          prompt_ko: { type: "string" },
          prompt_en: { type: "string" },
          negative_prompt: { type: "string" },
          style_guide: { type: "string" },
          reference_usage: { type: "string" }
        }
      }
    }
  }
} as const;

const OPENAI_REFERENCE_MODEL_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "genderPresentation",
    "ageImpression",
    "faceShape",
    "hairstyle",
    "skinTone",
    "eyeDetails",
    "browDetails",
    "lipDetails",
    "overallVibe",
    "distinctiveFeatures",
    "keepTraits",
    "flexibleTraits"
  ],
  properties: {
    genderPresentation: { type: "string" },
    ageImpression: { type: "string" },
    faceShape: { type: "string" },
    hairstyle: { type: "string" },
    skinTone: { type: "string" },
    eyeDetails: { type: "string" },
    browDetails: { type: "string" },
    lipDetails: { type: "string" },
    overallVibe: { type: "string" },
    distinctiveFeatures: {
      type: "array",
      items: { type: "string" }
    },
    keepTraits: {
      type: "array",
      items: { type: "string" }
    },
    flexibleTraits: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

const OPENAI_CUSTOMER_REVIEW_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "fileName",
    "reviewCount",
    "sampleReviews",
    "topBenefits",
    "painPoints",
    "improvementPromises",
    "keywordSummary"
  ],
  properties: {
    fileName: { type: "string" },
    reviewCount: { type: "number" },
    sampleReviews: {
      type: "array",
      items: { type: "string" }
    },
    topBenefits: {
      type: "array",
      items: { type: "string" }
    },
    painPoints: {
      type: "array",
      items: { type: "string" }
    },
    improvementPromises: {
      type: "array",
      items: { type: "string" }
    },
    keywordSummary: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

export class PdpServiceError extends Error {
  constructor(
    readonly code: PdpErrorCode,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = "PdpServiceError";
  }
}

export class PdpService {
  async validateGeminiApiKey(geminiApiKeyOverride?: string) {
    const apiKey = this.getRequiredApiKey(geminiApiKeyOverride);
    const analyzeModelAccess = await getCachedModelAccess("gemini", apiKey, ANALYZE_MODEL, () =>
      checkModelAccess(apiKey, ANALYZE_MODEL)
    );

    if (!analyzeModelAccess.accessible) {
      throw createModelAccessError(ANALYZE_MODEL, analyzeModelAccess);
    }

    const imageModelAccess = await getCachedModelAccess("gemini", apiKey, IMAGE_MODEL, () =>
      checkModelAccess(apiKey, IMAGE_MODEL)
    );

    if (!imageModelAccess.accessible) {
      throw createModelAccessError(IMAGE_MODEL, imageModelAccess);
    }

    return {
      message: "입력한 Gemini API 키가 텍스트 분석과 이미지 생성 모델 모두에 연결되었습니다.",
      analyzeModel: ANALYZE_MODEL,
      imageModel: IMAGE_MODEL
    };
  }

  async validateOpenAiApiKey(openAiApiKeyOverride?: string) {
    const apiKey = this.getRequiredOpenAiApiKey(openAiApiKeyOverride);
    const analyzeModelAccess = await getCachedModelAccess("openai", apiKey, OPENAI_ANALYZE_MODEL, () =>
      checkOpenAiModelAccess(apiKey, OPENAI_ANALYZE_MODEL)
    );

    if (!analyzeModelAccess.accessible) {
      throw createOpenAiModelAccessError(OPENAI_ANALYZE_MODEL, analyzeModelAccess);
    }

    const imageModelAccess = await getCachedModelAccess("openai", apiKey, OPENAI_IMAGE_MODEL, () =>
      checkOpenAiModelAccess(apiKey, OPENAI_IMAGE_MODEL)
    );

    if (!imageModelAccess.accessible) {
      throw createOpenAiModelAccessError(OPENAI_IMAGE_MODEL, imageModelAccess);
    }

    return {
      message: "입력한 OpenAI API 키가 GPT-5.5 분석과 GPT Image 2 생성 모델에 연결되었습니다.",
      analyzeModel: OPENAI_ANALYZE_MODEL,
      imageModel: OPENAI_IMAGE_MODEL
    };
  }

  async analyzeCustomerReviews(request: PdpAnalyzeCustomerReviewsRequest, openAiApiKeyOverride?: string) {
    const apiKey = this.getRequiredOpenAiApiKey(openAiApiKeyOverride);
    const source = normalizeCustomerReviewSource(request.source);

    if (!source.reviews.length) {
      throw new PdpServiceError(
        "INVALID_REQUEST",
        "후기 파일에서 분석할 수 있는 문장을 찾지 못했습니다.",
        "Customer review source has no usable review rows."
      );
    }

    const modelAccess = await getCachedModelAccess("openai", apiKey, OPENAI_CUSTOMER_REVIEW_MODEL, () =>
      checkOpenAiModelAccess(apiKey, OPENAI_CUSTOMER_REVIEW_MODEL)
    );

    if (!modelAccess.accessible) {
      throw createOpenAiModelAccessError(OPENAI_CUSTOMER_REVIEW_MODEL, modelAccess);
    }

    const response = await openAiJsonRequest<OpenAiResponsePayload>(apiKey, "/responses", {
      method: "POST",
      body: {
        model: OPENAI_CUSTOMER_REVIEW_MODEL,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content:
              "You are a Korean ecommerce customer-review analyst. Use only the provided review rows. Return only valid JSON matching the schema."
          },
          {
            role: "user",
            content: buildCustomerReviewAnalysisPrompt(source, request.productContext, request.desiredTone)
          }
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "hanirum_customer_review_analysis",
            schema: OPENAI_CUSTOMER_REVIEW_ANALYSIS_SCHEMA,
            strict: true
          }
        }
      }
    });

    return parseCustomerReviewAnalysisResponse(response, source);
  }

  async analyzeProduct(request: PdpAnalyzeRequest, geminiApiKeyOverride?: string, openAiApiKeyOverride?: string) {
    const aiProvider = normalizeAiProvider(request.aiProvider);

    if (aiProvider === "openai") {
      return this.analyzeProductWithOpenAi(request, openAiApiKeyOverride);
    }

    const apiKey = this.getRequiredApiKey(geminiApiKeyOverride);
    const normalizedImage = sanitizeBase64Payload(request.imageBase64);
    const mimeType = normalizeMimeType(request.mimeType);
    const generationImage = request.generationImageBase64
      ? sanitizeBase64Payload(request.generationImageBase64)
      : normalizedImage;
    const generationMimeType = resolveImageMimeType(
      generationImage,
      request.generationImageMimeType ?? request.mimeType
    );
    const referenceModelImage = normalizeReferenceModelImage(request.modelImageBase64, request.modelImageMimeType);
    const sourceMaterials = normalizeAnalyzeSourceMaterials(request.sourceMaterials);
    const sourceMaterialImageParts = buildGeminiSourceMaterialImageParts(sourceMaterials);
    const analysisStrips = normalizeAnalysisStrips(request.analysisStrips);
    const stripImageParts = buildGeminiStripImageParts(analysisStrips);
    const client = this.createClient(apiKey);
    const imageModelAccess = await getCachedModelAccess("gemini", apiKey, IMAGE_MODEL, () =>
      checkModelAccess(apiKey, IMAGE_MODEL)
    );

    if (!imageModelAccess.accessible) {
      throw createModelAccessError(IMAGE_MODEL, imageModelAccess);
    }
    const referenceModelProfile =
      referenceModelImage ? await this.getGeminiReferenceModelProfile(client, referenceModelImage) : null;

	    const blueprint = await retryOperation(async () => {
	      const response = await client.models.generateContent({
	        model: ANALYZE_MODEL,
	        contents: [
	          {
	            parts: [
	              ...(stripImageParts.length
	                ? stripImageParts
	                : [buildHighResolutionInlinePart(mimeType, normalizedImage)]),
	              ...sourceMaterialImageParts,
	              ...(referenceModelImage ? [buildHighResolutionInlinePart(referenceModelImage.mimeType, referenceModelImage.base64)] : []),
	              {
	                text: buildAnalyzePrompt(
	                  normalizeSourceMode(request.sourceMode),
	                  normalizeOutputMode(request.outputMode),
	                  request.additionalInfo,
	                  request.desiredTone,
	                  referenceModelProfile,
	                  request.sectionCount,
	                  request.benefits,
	                  request.imageOptimization,
	                  sourceMaterials,
	                  request.knowledgeText,
	                  request.customerReviewAnalysis,
	                  request.longPageTranscript
	                )
	              }
	            ]
	          }
        ] as any,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              multiProductPage: { type: Type.BOOLEAN },
              extractedSellingPoints: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              currentPageDiagnosis: {
                type: Type.OBJECT,
                properties: {
                  strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
                  weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
                  improvements: { type: Type.ARRAY, items: { type: Type.STRING } }
                }
              },
              productCutRegion: {
                type: Type.OBJECT,
                properties: {
                  yStartRatio: { type: Type.NUMBER },
                  yEndRatio: { type: Type.NUMBER },
                  xStartRatio: { type: Type.NUMBER, nullable: true },
                  xEndRatio: { type: Type.NUMBER, nullable: true },
                  confidence: { type: Type.NUMBER }
                }
              },
              referenceProductImage: {
                type: Type.OBJECT,
                nullable: true,
                properties: {
                  materialIndex: { type: Type.NUMBER },
                  confidence: { type: Type.NUMBER }
                }
              },
              executiveSummary: { type: Type.STRING },
              scorecard: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: { type: Type.STRING },
                    score: { type: Type.STRING },
                    reason: { type: Type.STRING }
                  }
                }
              },
              blueprintList: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              sections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    section_id: { type: Type.STRING },
                    section_name: { type: Type.STRING },
                    goal: { type: Type.STRING },
                    headline: { type: Type.STRING },
                    headline_en: { type: Type.STRING },
                    subheadline: { type: Type.STRING },
                    subheadline_en: { type: Type.STRING },
                    bullets: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    },
                    bullets_en: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    },
                    trust_or_objection_line: { type: Type.STRING },
                    trust_or_objection_line_en: { type: Type.STRING },
                    CTA: { type: Type.STRING },
                    CTA_en: { type: Type.STRING },
                    layout_notes: { type: Type.STRING },
                    compliance_notes: { type: Type.STRING },
                    image_id: { type: Type.STRING },
                    purpose: { type: Type.STRING },
                    prompt_ko: { type: Type.STRING },
                    prompt_en: { type: Type.STRING },
                    negative_prompt: { type: Type.STRING },
                    style_guide: { type: Type.STRING },
                    reference_usage: { type: Type.STRING }
                  }
                }
              }
            }
          }
        }
      });

      return parseBlueprintResponse(response);
    });

    const firstSection = blueprint.sections[0];

    if (!firstSection) {
      throw new PdpServiceError(
        "GEMINI_RESPONSE_INVALID",
        "상세페이지 섹션을 생성하지 못했습니다.",
        "No sections returned from analyze response."
      );
    }

    // Approach A v2: crop the real product region from the legible strips (server-side, BEFORE the
    // hero is generated). Falls back to a mid-document strip / the provisional reference when no
    // confident productCutRegion is available — never the old top-18% crop.
    const heroReference = await resolveLongDetailHeroReference({
      strips: analysisStrips,
      productCutRegion: blueprint.productCutRegion,
      fallbackBase64: generationImage,
      fallbackMimeType: generationMimeType
    });

    if (request.deferHeroGeneration && analysisStrips.length) {
      // 2-pass mode: the client holds the ORIGINAL upload and generates the hero itself from a
      // full-resolution productCutRegion crop. Return the blueprint with sections[0] ungenerated;
      // heroReference stays as originalImage so the client has a working fallback reference.
      return {
        originalImage: heroReference.base64,
        originalImageMimeType: heroReference.mimeType,
        originalImageFileName: buildImageFileName("product-reference", heroReference.mimeType),
        blueprint
      };
    }

    const firstImage = await this.generateSectionImageInternal({
      originalImageBase64: heroReference.base64,
      originalImageMimeType: heroReference.mimeType,
      originalImageFileName: buildImageFileName("product-reference", heroReference.mimeType),
      section: firstSection,
      aspectRatio: request.aspectRatio,
      desiredTone: request.desiredTone,
      options: {
        style: "studio",
        withModel: true,
        modelGender: "female",
        modelAgeRange: "20s",
        modelCountry: "korea",
        guidePriorityMode: "guide-first",
        outputMode: normalizeOutputMode(request.outputMode),
        headline: firstSection.headline,
        subheadline: firstSection.subheadline,
        referenceModelImageBase64: referenceModelImage?.base64,
        referenceModelImageMimeType: referenceModelImage?.mimeType,
        referenceModelProfile,
        imageModel: IMAGE_MODEL
      },
      client
    });

    blueprint.sections[0] = {
      ...firstSection,
      generatedImage: toDataUrl(firstImage.mimeType, firstImage.base64)
    };

    return {
      originalImage: heroReference.base64,
      originalImageMimeType: heroReference.mimeType,
      originalImageFileName: buildImageFileName("product-reference", heroReference.mimeType),
      blueprint
    };
  }

  /**
   * Pass-1 of the 2-pass long-page analysis: transcribe ONE batch of strips verbatim.
   * The client runs batches sequentially (each request stays under Vercel's body limit)
   * and stitches the transcripts; the stitched text then feeds analyze/expand prompts.
   */
  async transcribeStrips(
    request: PdpTranscribeStripsRequest,
    geminiApiKeyOverride?: string,
    openAiApiKeyOverride?: string
  ): Promise<{ transcript: string; lastSectionType?: string }> {
    const strips = normalizeAnalysisStrips(request.strips).slice(0, MAX_TRANSCRIBE_STRIPS_PER_BATCH);
    if (!strips.length) {
      throw new PdpServiceError("INVALID_REQUEST", "전사할 스트립 이미지가 없습니다.", "transcribe: empty strips");
    }

    const batchIndex = Number.isFinite(request.batchIndex) ? Math.max(0, Math.floor(request.batchIndex)) : 0;
    const batchCount = Number.isFinite(request.batchCount)
      ? Math.max(batchIndex + 1, Math.floor(request.batchCount))
      : batchIndex + 1;
    const prompt = buildTranscribeStripsPrompt(
      strips,
      batchIndex,
      batchCount,
      request.previousSectionHint
    );
    const aiProvider = normalizeAiProvider(request.aiProvider);

    if (aiProvider === "openai") {
      return retryOperation(async () => {
        const apiKey = this.getRequiredOpenAiApiKey(openAiApiKeyOverride);
        const response = await openAiJsonRequest<OpenAiResponsePayload>(apiKey, "/responses", {
          method: "POST",
          body: {
            model: OPENAI_ANALYZE_MODEL,
            input: [
              {
                role: "system",
                content:
                  "You are a meticulous Korean ecommerce detail-page transcriber. Transcribe every visible character faithfully and return only valid JSON shaped as { transcript, lastSectionType }."
              },
              {
                role: "user",
                content: [{ type: "input_text", text: prompt }, ...buildOpenAiStripImageInputs(strips)]
              }
            ],
            text: {
              format: {
                type: "json_schema",
                name: "hanirum_pdp_transcript",
                schema: {
                  type: "object",
                  properties: {
                    transcript: { type: "string" },
                    lastSectionType: { type: "string" }
                  },
                  required: ["transcript", "lastSectionType"],
                  additionalProperties: false
                },
                strict: true
              }
            }
          }
        });
        const text = extractOpenAiResponseText(response);
        return parseTranscriptPayload(extractJsonCandidate(text) ?? text, "openai");
      });
    }

    return retryOperation(async () => {
      const apiKey = this.getRequiredApiKey(geminiApiKeyOverride);
      const client = this.createClient(apiKey);
      const response = await client.models.generateContent({
        model: ANALYZE_MODEL,
        contents: [
          {
            parts: [...buildGeminiStripImageParts(strips), { text: prompt }]
          }
        ] as any,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              transcript: { type: Type.STRING },
              lastSectionType: { type: Type.STRING }
            }
          }
        }
      });
      return parseTranscriptPayload(extractResponseText(response), "gemini");
    });
  }

  async expandLandingPage(
    request: PdpExpandRequest,
    geminiApiKeyOverride?: string,
    openAiApiKeyOverride?: string
  ): Promise<PdpExpandResponse> {
    const hero = request?.heroBlueprint?.sections?.[0];
    if (!hero) {
      throw new PdpServiceError(
        "INVALID_REQUEST",
        "히어로 섹션을 먼저 생성한 뒤 확장할 수 있습니다.",
        "expand: missing hero section"
      );
    }
    const roster = request?.style?.sectionRoster;
    if (!Array.isArray(roster) || roster.length === 0) {
      throw new PdpServiceError(
        "INVALID_REQUEST",
        "확장 스타일 정보가 비어 있습니다.",
        "expand: empty section roster"
      );
    }

    const aiProvider = normalizeAiProvider(request.productContext?.aiProvider);
    const outputMode: PdpOutputMode =
      request.productContext?.outputMode === "full-image" ? "full-image" : "editable";
    const prompt = buildExpandPrompt(request);

    const payload =
      aiProvider === "openai"
        ? await retryOperation(async () => {
            const apiKey = this.getRequiredOpenAiApiKey(openAiApiKeyOverride);
            const response = await openAiJsonRequest<OpenAiResponsePayload>(apiKey, "/responses", {
              method: "POST",
              body: {
                model: OPENAI_ANALYZE_MODEL,
                input: [
                  {
                    role: "system",
                    content:
                      "You are a senior Korean ecommerce landing-page strategist. Build ONE cohesive conversion story and return only valid JSON shaped as { narrativeSpine, sections }."
                  },
                  { role: "user", content: [{ type: "input_text", text: prompt }] }
                ],
                text: { format: { type: "json_object" } }
              }
            });
            const text = extractOpenAiResponseText(response);
            return parseExpandPayload(extractJsonCandidate(text) ?? text, "openai", outputMode);
          })
        : await retryOperation(async () => {
            const apiKey = this.getRequiredApiKey(geminiApiKeyOverride);
            const client = this.createClient(apiKey);
            const response = await client.models.generateContent({
              model: ANALYZE_MODEL,
              contents: [{ parts: [{ text: prompt }] }] as any,
              config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: "application/json",
                responseSchema: EXPAND_RESPONSE_SCHEMA
              }
            });
            return parseExpandPayload(extractResponseText(response), "gemini", outputMode);
          });

    return {
      ok: true,
      narrativeSpine: payload.narrativeSpine,
      sections: [hero, ...payload.sections]
    };
  }

  async generateSectionImage(request: {
    originalImageBase64: string;
    originalImageMimeType?: string;
    originalImageFileName?: string;
    section: SectionBlueprint;
    aspectRatio: AspectRatio;
    desiredTone?: string;
    options?: ImageGenOptions;
  }, geminiApiKeyOverride?: string, openAiApiKeyOverride?: string) {
    const aiProvider = normalizeAiProvider(request.options?.aiProvider);

    if (aiProvider === "openai") {
      return this.generateSectionImageWithOpenAi(request, openAiApiKeyOverride);
    }

    const apiKey = this.getRequiredApiKey(geminiApiKeyOverride);
    const client = this.createClient(apiKey);
    const imageModelAccess = await getCachedModelAccess("gemini", apiKey, IMAGE_MODEL, () =>
      checkModelAccess(apiKey, IMAGE_MODEL)
    );

    if (!imageModelAccess.accessible) {
      throw createModelAccessError(IMAGE_MODEL, imageModelAccess);
    }
    const normalizedReferenceModel = normalizeReferenceModelImage(
      request.options?.referenceModelImageBase64,
      request.options?.referenceModelImageMimeType
    );
    const referenceModelProfile =
      normalizedReferenceModel && request.options?.withModel
        ? await this.getGeminiReferenceModelProfile(client, normalizedReferenceModel)
        : null;

    const image = await this.generateSectionImageInternal({
      ...request,
      client,
      options: request.options
        ? {
            ...request.options,
            guidePriorityMode: request.options.guidePriorityMode ?? "guide-first",
            outputMode: normalizeOutputMode(request.options.outputMode),
            referenceModelImageBase64: normalizedReferenceModel?.base64,
            referenceModelImageMimeType: normalizedReferenceModel?.mimeType,
            referenceModelProfile,
            imageModel: IMAGE_MODEL
          }
        : undefined
    });

    return {
      imageBase64: image.base64,
      mimeType: image.mimeType
    };
  }

  private async analyzeProductWithOpenAi(request: PdpAnalyzeRequest, openAiApiKeyOverride?: string) {
    const apiKey = this.getRequiredOpenAiApiKey(openAiApiKeyOverride);
    const normalizedImage = sanitizeBase64Payload(request.imageBase64);
    const mimeType = normalizeMimeType(request.mimeType);
    const generationImage = request.generationImageBase64
      ? sanitizeBase64Payload(request.generationImageBase64)
      : normalizedImage;
    const generationMimeType = resolveImageMimeType(
      generationImage,
      request.generationImageMimeType ?? request.mimeType
    );
    const referenceModelImage = normalizeReferenceModelImage(request.modelImageBase64, request.modelImageMimeType);
    const referenceModelProfile =
      referenceModelImage ? await this.getOpenAiReferenceModelProfile(apiKey, referenceModelImage) : null;
    const sourceMaterials = normalizeAnalyzeSourceMaterials(request.sourceMaterials);
    const sourceMaterialImageInputs = buildOpenAiSourceMaterialImageInputs(sourceMaterials);
    const analysisStrips = normalizeAnalysisStrips(request.analysisStrips);
    const stripImageInputs = buildOpenAiStripImageInputs(analysisStrips);

    const prompt = buildAnalyzePrompt(
      normalizeSourceMode(request.sourceMode),
      normalizeOutputMode(request.outputMode),
      request.additionalInfo,
      request.desiredTone,
      referenceModelProfile,
      request.sectionCount,
      request.benefits,
      request.imageOptimization,
      sourceMaterials,
      request.knowledgeText,
      request.customerReviewAnalysis,
      request.longPageTranscript
    );

    const response = await openAiJsonRequest<OpenAiResponsePayload>(apiKey, "/responses", {
      method: "POST",
      body: {
        model: OPENAI_ANALYZE_MODEL,
        input: [
          {
            role: "system",
            content:
              "You are a senior Korean ecommerce landing-page strategist. Analyze product imagery and return only valid JSON matching the provided schema."
          },
          {
	            role: "user",
	            content: [
	              { type: "input_text", text: prompt },
	              ...(stripImageInputs.length
	                ? stripImageInputs
	                : [{ type: "input_image", image_url: toDataUrl(mimeType, normalizedImage) }]),
	              ...sourceMaterialImageInputs,
	              ...(referenceModelImage
	                ? [{ type: "input_image", image_url: toDataUrl(referenceModelImage.mimeType, referenceModelImage.base64) }]
	                : [])
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "hanirum_pdp_blueprint",
            schema: OPENAI_BLUEPRINT_SCHEMA,
            strict: true
          }
        }
      }
    });

    const blueprint = parseOpenAiBlueprintResponse(response);
    const firstSection = blueprint.sections[0];

    if (!firstSection) {
      throw new PdpServiceError(
        "OPENAI_RESPONSE_INVALID",
        "상세페이지 섹션을 생성하지 못했습니다.",
        "No sections returned from OpenAI analyze response."
      );
    }

    // Approach A v2: crop the real product region from the legible strips server-side before the
    // hero is generated (fallback = mid-document strip / provisional reference, never top-18%).
    const heroReference = await resolveLongDetailHeroReference({
      strips: analysisStrips,
      productCutRegion: blueprint.productCutRegion,
      fallbackBase64: generationImage,
      fallbackMimeType: generationMimeType
    });

    if (request.deferHeroGeneration && analysisStrips.length) {
      // 2-pass mode: the client generates the hero from a full-resolution productCutRegion crop
      // of the original upload (see the Gemini path for details).
      return {
        originalImage: heroReference.base64,
        originalImageMimeType: heroReference.mimeType,
        originalImageFileName: buildImageFileName("product-reference", heroReference.mimeType),
        blueprint
      };
    }

    const firstImage = await this.generateSectionImageWithOpenAi(
      {
        originalImageBase64: heroReference.base64,
        originalImageMimeType: heroReference.mimeType,
        originalImageFileName: buildImageFileName("product-reference", heroReference.mimeType),
        section: firstSection,
        aspectRatio: request.aspectRatio,
        desiredTone: request.desiredTone,
        options: {
          aiProvider: "openai",
          style: "studio",
          withModel: true,
          modelGender: "female",
          modelAgeRange: "20s",
          modelCountry: "korea",
          guidePriorityMode: "guide-first",
          outputMode: normalizeOutputMode(request.outputMode),
          headline: firstSection.headline,
          subheadline: firstSection.subheadline,
          referenceModelImageBase64: referenceModelImage?.base64,
          referenceModelImageMimeType: referenceModelImage?.mimeType,
          imageModel: OPENAI_IMAGE_MODEL
        }
      },
      apiKey
    );

    blueprint.sections[0] = {
      ...firstSection,
      generatedImage: toDataUrl(firstImage.mimeType, firstImage.imageBase64)
    };

    return {
      originalImage: heroReference.base64,
      originalImageMimeType: heroReference.mimeType,
      originalImageFileName: buildImageFileName("product-reference", heroReference.mimeType),
      blueprint
    };
  }

  private async generateSectionImageWithOpenAi(request: {
    originalImageBase64: string;
    originalImageMimeType?: string;
    originalImageFileName?: string;
    section: SectionBlueprint;
    aspectRatio: AspectRatio;
    desiredTone?: string;
    options?: ImageGenOptions;
  }, openAiApiKeyOverride?: string) {
    const apiKey = this.getRequiredOpenAiApiKey(openAiApiKeyOverride);
    const originalImageBase64 = sanitizeBase64Payload(request.originalImageBase64);
    const originalImageMimeType = resolveImageMimeType(originalImageBase64, request.originalImageMimeType);
    const section = normalizeSection(request.section, 0);
    const normalizedReferenceModel = normalizeReferenceModelImage(
      request.options?.referenceModelImageBase64,
      request.options?.referenceModelImageMimeType
    );
    const options = normalizeImageOptions({
      ...request.options,
      aiProvider: "openai",
      imageModel: OPENAI_IMAGE_MODEL
    });
    const referenceModelProfile =
      normalizedReferenceModel && options.withModel
        ? await this.getOpenAiReferenceModelProfile(apiKey, normalizedReferenceModel)
        : null;
    const prompt = buildImagePrompt(section, request.desiredTone, {
      ...options,
      referenceModelImageBase64: normalizedReferenceModel?.base64,
      referenceModelImageMimeType: normalizedReferenceModel?.mimeType,
      referenceModelProfile
    });
    const generatedImage = await openAiImageEditRequest(apiKey, {
      model: OPENAI_IMAGE_MODEL,
      prompt,
      aspectRatio: request.aspectRatio,
      originalImage: {
        base64: originalImageBase64,
        mimeType: originalImageMimeType,
        fileName: buildImageFileName(request.originalImageFileName, originalImageMimeType, "product-reference")
      },
      referenceModelImage: normalizedReferenceModel
        ? {
            base64: normalizedReferenceModel.base64,
            mimeType: normalizedReferenceModel.mimeType,
            fileName: request.options?.referenceModelImageFileName || "model-reference.jpg"
          }
        : null
    });

    return {
      imageBase64: generatedImage.base64,
      mimeType: generatedImage.mimeType
    };
  }

  private async generateSectionImageInternal(request: {
    originalImageBase64: string;
    originalImageMimeType?: string;
    originalImageFileName?: string;
    section: SectionBlueprint;
    aspectRatio: AspectRatio;
    desiredTone?: string;
    options?: InternalImageGenOptions;
    client?: GoogleGenAI;
  }): Promise<GeneratedImagePayload> {
    const client = request.client ?? this.getClient();
    const originalImageBase64 = sanitizeBase64Payload(request.originalImageBase64);
    const originalImageMimeType = resolveImageMimeType(originalImageBase64, request.originalImageMimeType);
    const section = normalizeSection(request.section, 0);
    const normalizedReferenceModel = normalizeReferenceModelImage(
      request.options?.referenceModelImageBase64,
      request.options?.referenceModelImageMimeType
    );
    const options = normalizeImageOptions(request.options);
    const referenceModelProfile =
      normalizedReferenceModel && options.withModel
        ? request.options?.referenceModelProfile ?? (await this.getGeminiReferenceModelProfile(client, normalizedReferenceModel))
        : null;

    if (!section.prompt_en) {
      throw new PdpServiceError(
        "INVALID_REQUEST",
        "이미지 프롬프트가 없는 섹션입니다.",
        "Section prompt_en is missing."
      );
    }

    const maxAttempts = normalizedReferenceModel && options.withModel ? REFERENCE_MODEL_MAX_ATTEMPTS : 1;
    let lastGeneratedImage: GeneratedImagePayload | null = null;
    let retryDirective = options.retryDirective;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const prompt = buildImagePrompt(section, request.desiredTone, {
        ...options,
        isRegeneration: options.isRegeneration || attempt > 0,
        referenceModelImageBase64: normalizedReferenceModel?.base64,
        referenceModelImageMimeType: normalizedReferenceModel?.mimeType,
        referenceModelProfile,
        retryDirective
      });

      const generatedImage = await retryOperation(async () => {
        const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [
          {
            inlineData: {
              mimeType: originalImageMimeType,
              data: originalImageBase64
            }
          }
        ];

        if (normalizedReferenceModel && options.withModel) {
          parts.push({
            inlineData: {
              mimeType: normalizedReferenceModel.mimeType,
              data: normalizedReferenceModel.base64
            }
          });
        }

        parts.push({
          text: prompt
        });

        const response = await client.models.generateContent({
          model: options.imageModel ?? IMAGE_MODEL,
          contents: {
            parts
          },
          config: {
            imageConfig: {
              aspectRatio: request.aspectRatio
            }
          }
        });

        const nextImage = extractGeneratedImage(response);

        if (!nextImage) {
          throw new PdpServiceError(
            "PDP_IMAGE_GENERATION_FAILED",
            "이미지를 생성하지 못했습니다.",
            "Gemini image response did not include inline image data."
          );
        }

        return nextImage;
      });

      lastGeneratedImage = generatedImage;

      if (!normalizedReferenceModel || !options.withModel || !referenceModelProfile) {
        return generatedImage;
      }

      const validation = await this.validateGeneratedImage(client, {
        generatedImage,
        referenceModelImage: normalizedReferenceModel,
        referenceModelProfile,
        expectedStyle: options.style
      });

      if (validation.isSamePerson && validation.genderPresentationPreserved && validation.styleMatch) {
        return generatedImage;
      }

      retryDirective = buildRetryDirective(validation, referenceModelProfile, options.style);
    }

    if (!lastGeneratedImage) {
      throw new PdpServiceError(
        "PDP_IMAGE_GENERATION_FAILED",
        "이미지를 생성하지 못했습니다.",
        "No image was generated during the retry loop."
      );
    }

    return lastGeneratedImage;
  }

  private getClient(geminiApiKeyOverride?: string) {
    return this.createClient(this.getRequiredApiKey(geminiApiKeyOverride));
  }

  private createClient(apiKey: string) {
    return new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
  }

  private async getGeminiReferenceModelProfile(
    client: GoogleGenAI,
    referenceModelImage: NormalizedReferenceModelImage
  ) {
    return getCachedReferenceModelProfile("gemini", referenceModelImage, () =>
      this.extractReferenceModelProfile(client, referenceModelImage)
    );
  }

  private async getOpenAiReferenceModelProfile(
    apiKey: string,
    referenceModelImage: NormalizedReferenceModelImage
  ) {
    return getCachedReferenceModelProfile("openai", referenceModelImage, () =>
      this.extractReferenceModelProfileWithOpenAi(apiKey, referenceModelImage)
    );
  }

  private getRequiredApiKey(geminiApiKeyOverride?: string) {
    const apiKey = geminiApiKeyOverride?.trim();

    if (!apiKey) {
      throw new PdpServiceError(
        "GEMINI_API_KEY_MISSING",
        "설정 메뉴에서 본인 Gemini API 키를 입력해 주세요."
      );
    }

    return apiKey;
  }

  private getRequiredOpenAiApiKey(openAiApiKeyOverride?: string) {
    const apiKey = openAiApiKeyOverride?.trim();

    if (!apiKey) {
      throw new PdpServiceError(
        "OPENAI_API_KEY_MISSING",
        "설정 메뉴에서 본인 OpenAI API 키를 입력해 주세요."
      );
    }

    return apiKey;
  }

  private async extractReferenceModelProfile(client: GoogleGenAI, referenceModelImage: NormalizedReferenceModelImage) {
    const response = await client.models.generateContent({
      model: ANALYZE_MODEL,
      contents: [
        {
          parts: [
            {
              text:
                "Analyze the uploaded reference person image and describe the same identifiable person for future commercial image generation. Focus on stable visual identity traits, not styling suggestions. Return JSON only."
            },
            buildHighResolutionInlinePart(referenceModelImage.mimeType, referenceModelImage.base64)
          ]
        }
      ] as any,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            genderPresentation: { type: Type.STRING },
            ageImpression: { type: Type.STRING },
            faceShape: { type: Type.STRING },
            hairstyle: { type: Type.STRING },
            skinTone: { type: Type.STRING },
            eyeDetails: { type: Type.STRING },
            browDetails: { type: Type.STRING },
            lipDetails: { type: Type.STRING },
            overallVibe: { type: Type.STRING },
            distinctiveFeatures: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            keepTraits: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            flexibleTraits: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        }
      }
    });

    return parseReferenceModelProfileResponse(response);
  }

  private async extractReferenceModelProfileWithOpenAi(apiKey: string, referenceModelImage: NormalizedReferenceModelImage) {
    const response = await openAiJsonRequest<OpenAiResponsePayload>(apiKey, "/responses", {
      method: "POST",
      body: {
        model: OPENAI_ANALYZE_MODEL,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Analyze the uploaded reference person image and describe the same identifiable person for future commercial image generation. Focus on stable visual identity traits, not styling suggestions. Return JSON only."
              },
              {
                type: "input_image",
                image_url: toDataUrl(referenceModelImage.mimeType, referenceModelImage.base64)
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "hanirum_reference_model_profile",
            schema: OPENAI_REFERENCE_MODEL_PROFILE_SCHEMA,
            strict: true
          }
        }
      }
    });

    return parseReferenceModelProfileResponse({ text: extractOpenAiResponseText(response) });
  }

  private async validateGeneratedImage(
    client: GoogleGenAI,
    input: {
      generatedImage: GeneratedImagePayload;
      referenceModelImage: NormalizedReferenceModelImage;
      referenceModelProfile: ReferenceModelProfile;
      expectedStyle: NonNullable<ImageGenOptions["style"]>;
    }
  ) {
    const response = await client.models.generateContent({
      model: ANALYZE_MODEL,
      contents: [
        {
          parts: [
            {
              text: buildValidationPrompt(input.referenceModelProfile, input.expectedStyle)
            },
            buildHighResolutionInlinePart(input.referenceModelImage.mimeType, input.referenceModelImage.base64),
            buildHighResolutionInlinePart(input.generatedImage.mimeType, input.generatedImage.base64)
          ]
        }
      ] as any,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isSamePerson: { type: Type.BOOLEAN },
            genderPresentationPreserved: { type: Type.BOOLEAN },
            styleMatch: { type: Type.BOOLEAN },
            confidence: { type: Type.STRING },
            reason: { type: Type.STRING },
            correctionFocus: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        }
      }
    });

    return parseGeneratedImageValidationResponse(response);
  }
}

export function toPdpErrorResponse(error: unknown) {
  if (error instanceof PdpServiceError) {
    return {
      ok: false as const,
      code: error.code,
      message: error.message,
      detail: error.detail
    };
  }

  const detail = stringifyError(error);
  const message = error instanceof Error ? error.message : "상세페이지 마법사 처리 중 오류가 발생했습니다.";

  if (isOpenAiInvalidApiKeyError(message)) {
    return {
      ok: false as const,
      code: "OPENAI_API_KEY_INVALID" as const,
      message: "입력한 OpenAI API 키를 확인할 수 없습니다. 키가 올바른지 다시 확인해 주세요.",
      detail
    };
  }

  if (isInvalidApiKeyError(message)) {
    return {
      ok: false as const,
      code: "GEMINI_API_KEY_INVALID" as const,
      message: "입력한 Gemini API 키를 확인할 수 없습니다. 키가 올바른지 다시 확인해 주세요.",
      detail
    };
  }

  if (isPermissionError(message)) {
    return {
      ok: false as const,
      code: "GEMINI_MODEL_ACCESS_DENIED" as const,
      message:
        "입력한 Gemini API 키로는 현재 상세페이지 생성에 필요한 모델을 사용할 수 없습니다. Gemini 3.1 Pro Preview와 Gemini 3 Pro Image Preview 접근 권한을 확인해 주세요.",
      detail
    };
  }

  if (isQuotaError(message)) {
    return {
      ok: false as const,
      code: "GEMINI_QUOTA_EXCEEDED" as const,
      message: isGeminiFreeTierBlockedError(message)
        ? GEMINI_FREE_TIER_BLOCKED_MESSAGE
        : "AI 사용량이 초과되었습니다. 잠시 후 다시 시도하거나 quota 상태를 확인해 주세요.",
      detail
    };
  }

  if (isJsonError(message)) {
    return {
      ok: false as const,
      code: "GEMINI_RESPONSE_INVALID" as const,
      message: "AI 응답을 해석하지 못했습니다. 같은 이미지로 다시 시도해 주세요.",
      detail
    };
  }

  if (message.toLowerCase().includes("maximum call stack size exceeded")) {
    return {
      ok: false as const,
      code: "PDP_ANALYZE_FAILED" as const,
      message: "업로드 이미지가 너무 커서 분석 요청을 만들지 못했습니다. 이미지를 분석용 크기로 줄인 뒤 다시 시도해 주세요.",
      detail
    };
  }

  return {
    ok: false as const,
    code: "PDP_ANALYZE_FAILED" as const,
    message: "상세페이지 마법사 처리 중 오류가 발생했습니다.",
    detail
  };
}

function normalizeMimeType(mimeType: string) {
  const normalized = mimeType.trim().toLowerCase();

  if (!normalized.startsWith("image/")) {
    throw new PdpServiceError(
      "INVALID_IMAGE_PAYLOAD",
      "이미지 파일만 업로드할 수 있습니다.",
      `Unsupported mime type: ${mimeType}`
    );
  }

  if (normalized === "image/jpg") {
    return "image/jpeg";
  }

  return normalized;
}

function sanitizeBase64Payload(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^data:[^;]+;base64,(.+)$/);
  const normalized = (match ? match[1] : trimmed).replace(/\s/g, "");

  if (!normalized || !/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
    throw new PdpServiceError(
      "INVALID_IMAGE_PAYLOAD",
      "이미지 데이터가 올바르지 않습니다.",
      "Malformed base64 payload."
    );
  }

  try {
    const bytes = Buffer.from(normalized, "base64");
    if (!bytes.byteLength) {
      throw new Error("empty payload");
    }
  } catch {
    throw new PdpServiceError(
      "INVALID_IMAGE_PAYLOAD",
      "이미지 데이터를 읽을 수 없습니다.",
      "Buffer.from failed for image payload."
    );
  }

  return normalized;
}

function resolveImageMimeType(base64: string, providedMimeType?: string) {
  if (providedMimeType?.trim()) {
    return normalizeMimeType(providedMimeType);
  }

  return detectImageMimeType(base64) ?? DEFAULT_IMAGE_MIME;
}

function detectImageMimeType(base64: string) {
  const bytes = Buffer.from(sanitizeBase64Payload(base64), "base64");

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (bytes.length >= 6) {
    const signature = bytes.toString("ascii", 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }

  return null;
}

function buildImageFileName(fileName: string | undefined, mimeType: string, fallbackBase = "image") {
  const safeBase = (fileName ?? fallbackBase)
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "")
    .trim() || fallbackBase;
  const extension = getImageFileExtension(mimeType);

  return `${safeBase}.${extension}`;
}

function getImageFileExtension(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    default:
      return "jpg";
  }
}

const EXPAND_SECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    section_id: { type: Type.STRING },
    section_name: { type: Type.STRING },
    goal: { type: Type.STRING },
    headline: { type: Type.STRING },
    headline_en: { type: Type.STRING },
    subheadline: { type: Type.STRING },
    subheadline_en: { type: Type.STRING },
    bullets: { type: Type.ARRAY, items: { type: Type.STRING } },
    bullets_en: { type: Type.ARRAY, items: { type: Type.STRING } },
    trust_or_objection_line: { type: Type.STRING },
    trust_or_objection_line_en: { type: Type.STRING },
    CTA: { type: Type.STRING },
    CTA_en: { type: Type.STRING },
    layout_notes: { type: Type.STRING },
    compliance_notes: { type: Type.STRING },
    image_id: { type: Type.STRING },
    purpose: { type: Type.STRING },
    prompt_ko: { type: Type.STRING },
    prompt_en: { type: Type.STRING },
    negative_prompt: { type: Type.STRING },
    style_guide: { type: Type.STRING },
    reference_usage: { type: Type.STRING },
    story_beat: {
      type: Type.OBJECT,
      properties: {
        beatGoal: { type: Type.STRING },
        connectionToPrev: { type: Type.STRING },
        reviewAngle: { type: Type.STRING }
      }
    }
  }
};

const EXPAND_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    narrativeSpine: {
      type: Type.OBJECT,
      properties: {
        targetCustomer: { type: Type.STRING },
        coreStruggle: { type: Type.STRING },
        transformation: { type: Type.STRING },
        throughline: { type: Type.STRING },
        reviewInsights: {
          type: Type.OBJECT,
          properties: {
            topBenefits: { type: Type.ARRAY, items: { type: Type.STRING } },
            painPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
            improvementPromises: { type: Type.ARRAY, items: { type: Type.STRING } }
          }
        }
      }
    },
    sections: { type: Type.ARRAY, items: EXPAND_SECTION_SCHEMA }
  }
};

function buildExpandPrompt(request: PdpExpandRequest): string {
  const hero = request.heroBlueprint.sections[0];
  const style = request.style;
  const review = request.reviewAnalysis;
  const ctx = request.productContext;
  const isFullImage = ctx.outputMode === "full-image";
  const hasReviews = Boolean(review && review.reviewCount > 0);

  const rosterLines = style.sectionRoster
    .map((section, index) => `${index + 1}. [${section.id}] ${section.name} — ${section.intent}`)
    .join("\n");

  const transcriptSource = ctx.longPageTranscript?.trim() ?? "";
  const transcriptBlock = transcriptSource
    ? [
        "[원본 상세페이지 카피 인벤토리 — 전사]: 아래는 사용자가 올린 기존 상세페이지에서 실제로 받아쓴 전체 카피와 섹션 구성입니다. 이 페이지가 무엇을 어떤 순서로 약속했는지가 여기 담겨 있으니, 각 섹션의 headline/subheadline/bullets/trust 라인은 이 인벤토리의 사실 범위 안에서 더 강하게 재구성하세요.",
        "전사에 없는 수치/인증/효능/후기를 새로 만들지 마세요. 전사에서 반복 강조된 셀링포인트는 새 페이지에서도 누락하지 마세요.",
        "<상세페이지_전사>",
        transcriptSource.length > MAX_EXPAND_TRANSCRIPT_CHARS
          ? `${transcriptSource.slice(0, MAX_EXPAND_TRANSCRIPT_CHARS)}\n(후략 — 전사가 길어 일부 생략됨)`
          : transcriptSource,
        "</상세페이지_전사>"
      ].join("\n")
    : "";

  const reviewBlock = hasReviews
    ? [
        `[고객 후기 인사이트 — ${review!.reviewCount}건]`,
        `- 반복된 장점: ${review!.topBenefits.slice(0, 6).join(" / ") || "(명시 없음)"}`,
        `- 반복된 아쉬움/불안: ${review!.painPoints.slice(0, 6).join(" / ") || "(명시 없음)"}`,
        `- 개선/약속 포인트: ${review!.improvementPromises.slice(0, 6).join(" / ") || "(명시 없음)"}`,
        `- 후기 샘플: ${review!.sampleReviews.slice(0, 6).map((sample) => `"${sample}"`).join(" / ") || "(명시 없음)"}`,
        "이 후기 인사이트를 narrativeSpine.reviewInsights에 정리하고, 각 섹션 story_beat.reviewAngle과 bullets/trust_or_objection_line에 자연스럽게 녹이세요. 단, 입력에 없는 수치/효능/인증/후기 개수를 새로 만들지 마세요."
      ].join("\n")
    : [
        "[고객 후기 없음]",
        "후기 데이터가 없으므로 제품 맥락과 카테고리 공감만으로 강한 구매 설득을 구성하세요. 가짜 후기, 가짜 수치, 가짜 효능/인증을 절대 만들지 마세요. narrativeSpine.reviewInsights는 생략합니다."
      ].join("\n");

  return `당신은 한국 이커머스 상세페이지 판매 카피 전략가입니다. 이미 생성된 히어로(1번 섹션)를 이어받아, 선택된 판매 스타일에 맞춰 상세페이지 전체를 "하나의 끊김 없는 판매 스토리"로 확장하세요. 각 섹션이 따로 노는 것이 아니라 앞 섹션을 감정·논리적으로 이어받아야 합니다.

[이미 확정된 히어로]
- 헤드라인: ${hero?.headline ?? ""}
- 서브헤드라인: ${hero?.subheadline ?? ""}
- 핵심 요약: ${request.heroBlueprint.executiveSummary || hero?.goal || ""}
- 블루프린트 메모: ${(request.heroBlueprint.blueprintList || []).slice(0, 8).join(" / ")}

[선택된 판매 스타일: ${style.title}]
- 흐름 의도(flowIntent): ${style.flowIntent}
- 핵심 메시지(keyMessage): ${style.keyMessage}
- 생성할 섹션 로스터(이 순서·역할 그대로, 정확히 ${style.sectionRoster.length}개, 히어로는 제외):
${rosterLines}

${transcriptBlock}

${reviewBlock}

${ctx.additionalInfo ? `[추가 정보]: ${ctx.additionalInfo}` : ""}
${ctx.desiredTone ? `[원하는 톤]: ${ctx.desiredTone}` : ""}
[출력 모드]: ${isFullImage ? "통이미지(full-image)" : "텍스트편집(editable)"}

# 반드시 지킬 서사 원칙
- 작성 전에 narrativeSpine을 먼저 고정하세요: targetCustomer(누구를 위한 페이지인지), coreStruggle(고객이 겪는 핵심 갈등), transformation(사용 후 변화), throughline(페이지 전체를 관통하는 한 줄 메시지).
- 모든 섹션은 throughline을 공유하되 같은 문구를 반복하지 마세요.
- 각 섹션 story_beat.connectionToPrev에 "앞 섹션의 어떤 감정·판단을 이어받아 이 섹션으로 넘어가는지"를 실제 문장으로 적고, headline/subheadline도 그 흐름이 느껴지게 쓰세요.
- 로스터의 역할(intent)을 그 순서대로 따르되, 히어로에서 꺼낸 약속을 점점 구체화하며 구매 확신으로 수렴시키세요(원하는 결과 → 막는 불편 → 해결 메커니즘 → 사야 하는 이유 → 사용 후 변화 → 미룰 때의 손실 → 마지막 확신).

# 카피 작성 원칙(강제)
- section_name은 내부 역할명입니다. headline/subheadline/bullets/CTA에 "문제 제기", "가이드 소개", "신뢰 근거", "사용 장면" 같은 역할명을 그대로 쓰지 마세요.
- 모든 visible copy는 제작자 설명문이 아니라, 이미지·페이지에 그대로 들어가도 자연스러운 고객-facing 문장이어야 합니다.
- 금지 추상 문구: "불편은 늘 같은 순간에 다시 옵니다", "구매 전 디테일을 가까이에서 확인하세요", "필요한 순간을 놓치기 전에 확인하세요", "사용 후 일상이 조금 더 가벼워집니다", "미루면 같은 불편이 다시 남습니다". 제품 카테고리와 근거가 보이는 문장으로 다시 쓰세요.
- 근거 없는 효능/인증/수치/후기 개수를 만들지 마세요.
${isFullImage ? "- 통이미지 모드: 모든 섹션 CTA와 CTA_en은 빈 문자열로 두고, '구매하기/자세히 보기/지금 확인하기/클릭/버튼/>' 같은 링크·버튼 유도 문구를 visible copy에 쓰지 마세요." : "- 텍스트편집 모드에서만 실제 행동을 유도하는 CTA를 한국어 1줄로 쓰되, 섹션마다 다른 문구로 작성하세요."}

# 출력 형식 — 아래 JSON 구조 하나만 반환(다른 설명 텍스트 금지)
{
  "narrativeSpine": {
    "targetCustomer": "...", "coreStruggle": "...", "transformation": "...", "throughline": "..."${hasReviews ? ',\n    "reviewInsights": { "topBenefits": ["..."], "painPoints": ["..."], "improvementPromises": ["..."] }' : ""}
  },
  "sections": [
    {
      "section_id": "(로스터의 id)", "section_name": "(로스터의 name)", "goal": "역할 한 문장",
      "headline": "한국어 1줄", "headline_en": "영어 1줄",
      "subheadline": "한국어 1줄", "subheadline_en": "영어 1줄",
      "bullets": ["한국어 3개"], "bullets_en": ["영어 3개"],
      "trust_or_objection_line": "불안 제거·신뢰 1문장", "trust_or_objection_line_en": "영어 1문장",
      "CTA": "${isFullImage ? "" : "텍스트편집일 때만 1줄"}", "CTA_en": "",
      "layout_notes": "이미지 레이아웃 지시(짧게)", "compliance_notes": "근거 없는 효능·인증·수치·후기 표현 금지",
      "image_id": "IMG_(section_id)", "purpose": "이미지가 전달할 메시지 한 문장",
      "prompt_ko": "한국어 이미지 프롬프트(구도·거리감·제품 비중 포함)", "prompt_en": "English image prompt with composition/framing/product prominence",
      "negative_prompt": "피해야 할 요소",
      "style_guide": "히어로와 통일된 커머스 상세페이지 스타일",
      "reference_usage": "히어로·원본 제품의 형태·색감·패키지·재질 유지",
      "story_beat": { "beatGoal": "이 섹션이 판매에서 하는 일", "connectionToPrev": "앞 섹션을 이어받는 실제 문장"${hasReviews ? ', "reviewAngle": "이 섹션에 녹일 후기 인사이트"' : ""} }
    }
  ]
}

로스터에 있는 ${style.sectionRoster.length}개 섹션만, 그 순서대로 생성하세요. 히어로는 포함하지 마세요(이미 존재합니다).`;
}

function buildAnalyzePrompt(
  sourceMode: PdpSourceMode,
  outputMode: PdpOutputMode,
  additionalInfo?: string,
  desiredTone?: string,
  referenceModelProfile?: ReferenceModelProfile | null,
  sectionCount?: number,
  benefits?: string[],
  imageOptimization?: PdpAnalysisImageMetadata,
  sourceMaterials?: PdpSourceMaterial[],
  knowledgeText?: string,
  customerReviewAnalysis?: PdpCustomerReviewAnalysis,
  longPageTranscript?: string
) {
  const targetSectionCount = normalizeSectionCount(sectionCount);
  const manualBenefits = normalizeBenefitInputs(benefits);
  const imageOptimizationPrompt = buildImageOptimizationPrompt(imageOptimization);
  const longPageTranscriptPrompt = buildLongPageTranscriptPrompt(longPageTranscript);
  const sourceMaterialsPrompt = buildSourceMaterialsPrompt(sourceMaterials);
  const knowledgePrompt = buildKnowledgePrompt(knowledgeText);
  const customerReviewPrompt = buildCustomerReviewPrompt(customerReviewAnalysis);
  const storyBrandPrompt = buildStoryBrandSellingPrompt(customerReviewAnalysis);
  const referenceModelPrompt = referenceModelProfile
    ? `[참고 모델 이미지가 함께 제공됨]: 모델이 포함되는 컷은 업로드된 동일 인물의 정체성을 유지해야 합니다.
- 유지할 핵심 특성: ${referenceModelProfile.keepTraits.join(", ")}
- 식별 포인트: ${referenceModelProfile.distinctiveFeatures.join(", ")}
- 전체 인상: ${referenceModelProfile.overallVibe}`
    : "";
  const manualBenefitsPrompt = manualBenefits.length
    ? `[사용자 수동 장점]: 아래 장점을 상세페이지 섹션 구성과 카피에 우선 반영하세요.
${manualBenefits.map((benefit, index) => `${index + 1}. ${benefit}`).join("\n")}`
    : "";
  const sourceModePrompt = sourceMode === "redesign"
    ? [
        "입력 자료는 기존 상세페이지 이미지입니다. 제품 카테고리, USP, 타겟, 근거, 이미 좋은 점, 전환을 막는 문제를 먼저 진단한 뒤 더 높은 전환을 노리는 새 상세페이지 구조로 재설계하세요.",
        "기존 상세페이지에서 확인되는 제품명, 가격, 인증, 수치, 구성, 리뷰, 사용법은 근거가 있는 정보로만 유지하고, 원본에 없는 브랜드명/효과/수치를 새로 만들지 마세요."
      ].join("\n")
    : sourceMode === "product"
      ? [
          "입력 자료는 제품 이미지와 선택 모델컷입니다. 제품 형태와 패키지 정보를 근거로 새 상세페이지 구조와 카피를 설계하세요.",
          "제품 이미지에 없는 수치, 인증, 리뷰, 효능은 만들지 말고, 부족한 근거는 FAQ/보증/사용법 같은 안전한 구조로 대체하세요."
        ].join("\n")
      : [
          "입력 자료는 제품 이미지 또는 기존 상세페이지 이미지입니다. 먼저 업로드 이미지가 제품컷인지 기존 상세페이지인지 판단하고, 그 판단을 근거로 상세페이지 전체 흐름을 설계하세요.",
          "제품컷이면 제품 형태와 패키지 정보를 근거로 새 상세페이지를 구성하고, 기존 상세페이지면 현재 구성의 좋은 점과 전환 저해 요소를 반영해 리디자인하세요.",
          "원본에 없는 브랜드명, 효과, 인증, 수치, 리뷰는 만들지 마세요."
        ].join("\n");
  const outputModePrompt = outputMode === "full-image"
    ? [
        "출력 목표는 OpenAI Image 2.0 통이미지 상세페이지입니다. 각 섹션은 이미지 자체에 한국어 헤드라인, 짧은 서브카피, 최대 2개의 짧은 포인트만 포함된 완성형 디자인으로 생성될 수 있게 작성하세요.",
        "한국 쇼핑몰 상세페이지 통이미지는 실제 링크를 걸 수 없습니다. 이미지 안에 버튼, 화살표 버튼, 링크처럼 보이는 CTA, '제품 확인하기', '지금 확인하기', '구매하기', '자세히 보기' 같은 문구를 만들지 마세요.",
        "모바일폰 가독성이 최우선입니다. 1080px 폭 결과물이 390px 스마트폰 화면에 축소되어도 확대 없이 읽혀야 하므로, 긴 문장/작은 본문/복잡한 표/촘촘한 설명 박스/각주형 텍스트는 만들지 마세요.",
        "문구가 카드나 배너 안에서 잘리거나 말줄임표로 끝나면 실패입니다. 공간이 부족하면 문구를 줄이거나 보조 카드 자체를 빼고, 절대 잘린 텍스트를 남기지 마세요.",
        "전 섹션의 한글 타이포그래피는 Pretendard 또는 Noto Sans KR 같은 현대적인 산세리프 한 계열로 통일하세요. 섹션마다 손글씨체, 세리프체, 장식 서체, 서로 다른 폰트 계열을 섞지 마세요.",
        "디자인은 단순 사진 위 문구가 아니라 1080px 모바일 상세페이지 섹션처럼 보이게 설계하세요: 풀블리드 히어로 스크림, 비대칭 그리드, 라벨 행, 얇은 구분선, 넓은 화이트 정보 카드, 큰 콜아웃 칩, 비교 카드, 제품 디테일 박스 등 섹션 역할에 맞는 구조를 포함하세요.",
        "정보형 섹션도 작은 설명을 많이 넣지 말고 큰 라벨 1개와 짧은 보조문구 1개 정도로 압축하세요."
      ].join("\n")
    : [
      "출력 목표는 텍스트 수정 가능한 편집모드입니다. 생성 이미지는 새 광고 문구/헤드라인을 이미지에 합성하지 않는 고품질 배경/제품/모델컷으로 만들고, 헤드라인과 카피는 편집기에서 별도 텍스트 레이어로 배치될 수 있게 작성하세요.",
      "다만 제품 패키지, 라벨, 로고처럼 원본 제품에 이미 인쇄된 글자와 브랜드 표기는 제품 정체성으로 보존해야 합니다.",
      "편집 가능한 텍스트 레이어가 올라갈 위치를 고려해 사진 안에 의도적인 여백, 어두운/밝은 면, 제품 주변의 호흡을 남기세요. 인물 얼굴이나 제품 핵심이 헤드라인 영역과 겹치지 않게 섹션별로 좌/우/하단 여백을 설계하세요."
    ].join("\n");
  const sectionStructureRules = targetSectionCount === 1
    ? [
        `- 전체 섹션 개수는 반드시 1개로 맞출 것`,
        "- 이 1장은 히어로우 페이지만 설계할 것",
        "- 3초 안에 제품/대상/핵심 약속/구매 이유가 보이게 할 것",
        "- 이후 확장은 사용자가 히어로우를 보고 확정한 뒤 선택하므로, 다른 섹션을 미리 만들지 말 것",
        "- 핵심 장점은 1~3개로 압축하고, 짧은 문구 중심으로 작성할 것"
      ].join("\n")
    : [
        `- 전체 섹션 개수는 반드시 ${targetSectionCount}개로 맞출 것`,
        "- 전체 상세페이지는 섹션별 숙제가 아니라 하나의 판매 영화처럼 이어질 것",
        "- 작성 전에 내부적으로 한 줄 판매 스레드를 먼저 고정할 것: 고객이 원하는 결과 -> 지금 막는 제품/카테고리별 불편 -> 이 제품의 해결 메커니즘 -> 구매해야 하는 구체적 이유",
        "- 기본 서사는 Hero(고객이 원하는 결과) -> Problem(제품/카테고리의 구체적 불편) -> Guide(우리 제품을 해결 가이드로 소개) -> Plan(제품 특성이 어떻게 해결하는지) -> Purchase Reason(왜 이 제품을 사야 하는지) -> Success(사용 후 카테고리별 변화/후기형 만족) -> Failure(계속 미룰 때의 실제 손실) -> Close(후기 장점과 해결 이유로 마지막 확신) 순서를 따를 것",
        "- 각 섹션의 headline/subheadline은 바로 이전 섹션의 감정이나 판단을 받아 다음 장면으로 넘겨야 하며, 같은 문구를 반복하지 말 것",
        "- Problem 섹션은 반드시 해당 제품을 쓰는 상황에서 생기는 외적 문제와 내적 감정을 같이 짚을 것. 예: 러닝 양말이면 러닝 중 양말 밀림, 쓸림, 땀 답답함, 발바닥 충격, 발 피로, 페이스 저하 걱정처럼 제품과 직접 연결된 문제를 말할 것",
        "- Guide 섹션에서는 제품명을 단순 노출하거나 구매 전 디테일 확인으로 흐리지 말고, 직전 Problem에서 꺼낸 불편을 줄여주는 가이드/해결책으로 제품을 소개할 것",
        "- Plan 섹션은 제품의 핵심 특성이 문제를 어떻게 줄이는지 설명할 것. 예: 러닝 양말이면 쫀쫀한 핏이 발을 잡아주고, 쿠션감이 착지 충격과 마찰 부담을 덜어주는 흐름을 말할 것",
        "- Purchase 섹션은 '필요한 순간을 놓치기 전에 확인하세요'처럼 흐리지 말고 이 제품을 사야 하는 명확한 이유를 쓰되, 버튼형 CTA나 링크 유도 문구로 만들지 말 것",
        "- Success 섹션은 카테고리 밖의 막연한 일상 변화가 아니라 실제 사용 장면의 변화로 쓸 것. 예: 러닝 양말이면 양말 신경을 덜 쓰고 보폭, 페이스, 훈련 집중에 더 신경 쓸 수 있다는 장면",
        "- Failure 섹션은 공포 조장이 아니라 기존 대안을 계속 쓸 때의 실제 손실을 차분하게 제시할 것. 예: 낡은 일반 양말로 계속 뛰면 밀림, 쓸림, 물집, 발 피로 때문에 페이스나 기록 관리가 흔들릴 수 있음",
        "- Close/마지막 확신 섹션은 후기에서 반복된 장점과 앞의 문제 해결을 다시 묶어 '그래서 이 제품을 놓치면 안 되는 이유'를 분명하게 만들 것",
        "- 사용자가 수동 장점을 입력했다면 해당 장점을 누락하지 말고 자연스럽게 배치할 것",
        "- 수동 장점이 없다면 핵심 장점은 3개 안팎으로 압축할 것",
        "- 근거 섹션은 반드시 결과→조건→해석 3단으로 작성",
        "- 리뷰 섹션은 전/후 사진보다 사용감 문장 후기 카드 6~12개 우선",
        "- 사용법/루틴은 선택지를 2~3개로 줄여 선택 피로를 없앨 것",
        "- 구매 이유/결정 근거는 필요한 섹션에 반복해도 되지만, 통이미지 안에는 버튼형 CTA나 링크 유도 문구를 배치하지 말 것",
        "- 상품정보/FAQ/고시 섹션은 '주의사항 확인', '구성 및 옵션 안내' 같은 자리표시 문구로 끝내지 말고, 원본에서 보이는 제품명/패키지/구성품/형태/재질감/사용 전 확인점을 상품별 디테일 정보로 정리할 것",
        "- 원본에서 정확히 읽히지 않는 용량, 수량, 인증, 효능, 소재명은 새로 만들지 말고 '패키지 구성', '제품 형태', '사용 전 확인 포인트'처럼 사실 범위를 넘지 않는 라벨로 대체할 것",
        "- 각 섹션의 이미지는 단순한 제품 누끼나 그래픽이 아닌 소비자의 구매 전환을 유도할 수 있는 고품질 광고 사진 느낌으로 기획할 것",
        "- 첫 번째 섹션은 구매 전환에 가장 중요하므로 반드시 매력적인 모델이 제품과 함께 연출된 컷으로 프롬프트를 작성할 것",
        "- 각 섹션 이미지는 해당 헤드라인과 서브헤드라인의 메시지를 시각적으로 전달해야 함"
      ].join("\n");

  return `
${sourceModePrompt}
${outputModePrompt}

정확히 ${targetSectionCount}개의 핵심 섹션으로 구성된 상세페이지 전체 블루프린트를 설계해주세요.
${additionalInfo ? `[사용자 추가 정보]: ${additionalInfo}` : ""}
${desiredTone ? `[원하는 디자인 톤]: ${desiredTone}` : ""}
${imageOptimizationPrompt}
${longPageTranscriptPrompt}
${sourceMaterialsPrompt}
${referenceModelPrompt}
${manualBenefitsPrompt}
${knowledgePrompt}
${customerReviewPrompt}
${storyBrandPrompt}

# 섹션 템플릿(필수 필드)
- section_id: S1~S${targetSectionCount}
- section_name: (예: 히어로/체크리스트/핵심 장점/근거/사용법/후기 등)
- goal: 이 섹션의 역할(짧은 한 문장)
- headline: 한국어 1줄(강하게)
- headline_en: headline의 자연스러운 영어 번역 1줄
- subheadline: 한국어 1줄(명확하게)
- subheadline_en: subheadline의 자연스러운 영어 번역 1줄
- bullets: 한국어 3개(스캔용, 각 1줄)
- bullets_en: bullets의 자연스러운 영어 번역 3개
- trust_or_objection_line: 한국어 불안 제거/신뢰 1문장
- trust_or_objection_line_en: trust_or_objection_line의 자연스러운 영어 번역 1문장
- CTA: 통이미지 모드에서는 빈 문자열. 텍스트편집 모드에서만 실제 버튼/행동 문구가 필요할 때 한국어 1줄
- CTA_en: CTA의 자연스러운 영어 번역 1줄. CTA가 비어 있으면 빈 문자열
- layout_notes: 이미지 레이아웃 지시(짧게)
- compliance_notes: 카테고리별 규제/표현 주의(짧게)

# 카피 작성 원칙(강제)
- section_name은 내부 편집용 역할명입니다. headline, subheadline, CTA, bullets에 section_name을 그대로 복사하지 마세요.
- 금지 예시: headline "문제 공감", "가이드 제안", "신뢰 근거", "사용 장면" / subheadline "히어로우의 흐름을 이어 전환 설득을 강화합니다.", "원본 상세페이지에 보이는 제품명과 사용 장면을 기준으로 표현했습니다."
- 좋은 예시: 실제 업로드 제품과 타깃 고객의 불편, 욕구, 망설임, 선택 이유가 드러나는 판매 카피.
- 문제 공감/구매 전 고민 섹션은 특히 고객이 실제로 겪는 상황형 문장이나 질문형 헤드라인으로 작성하세요.
- 고객 후기 데이터가 제공되었다면 고객 고민/문제/구매 전 고민 섹션은 반복된 아쉬움과 실제 후기 표현을 짧은 고민 문장으로 바꾸고, 후기/리뷰/사용 후 변화 섹션은 실제 입력 후기 샘플을 짧게 다듬어 카드 문장으로 사용하세요.
- 후기가 장점 위주라면 그 장점을 역으로 문제 제기에 사용하세요. 후기에서 반복된 장점이 "OO"라면 "OO이 아쉬워서 망설인 적 없으신가요?"처럼 구매 전 불편 질문으로 바꾸고, 다음 섹션에서 그 장점을 해결책으로 연결하세요.
- 히어로/선택 이유/혜택 카드에서는 후기 근거를 그대로 라벨화하지 마세요. "OO 인정 후기", "OO 적다는 후기"처럼 어색한 표현은 금지입니다. 후기 라벨만 떼고 그 장점 OO 자체를 고객이 얻는 혜택 문장으로 다시 쓰세요. 이때 업로드된 제품에서 확인되지 않는 다른 카테고리의 기능이나 혜택(예: 다른 제품군의 기능성 문구)을 새로 만들지 마세요.
- 모든 visible copy는 섹션 설명문이 아니라 이미지에 그대로 들어가도 어색하지 않은 고객-facing 문장이어야 합니다.
- 같은 히어로 태그라인이나 구매 유도 문구를 여러 섹션에 반복하지 마세요. 반복 대신 문제, 해결, 사용법, 변화, 손실을 각각 다른 문장으로 전개하세요.
- "고객이...", "이 섹션은...", "페이지 흐름..."처럼 제작자에게 설명하는 문장은 visible copy에 쓰지 마세요.
- 금지되는 추상 문구: "불편은 늘 같은 순간에 다시 옵니다", "구매 전 디테일을 가까이에서 확인하세요", "필요한 순간을 놓치기 전에 확인하세요", "사용 후 일상이 조금 더 가벼워집니다", "미루면 같은 불편이 다시 남습니다". 이런 문구는 반드시 제품 카테고리와 후기 근거가 보이는 문장으로 다시 쓰세요.
- 통이미지 visible copy 금지: "제품 확인하기", "지금 확인하기", "구매하기", "바로가기", "자세히 보기", "클릭", "버튼", ">"처럼 링크나 버튼 행동을 암시하는 문구를 쓰지 마세요.

# 섹션 구성 원칙(강제)
${sectionStructureRules}

# 섹션별 이미지 생성 프롬프트
- image_id: IMG_S1~IMG_S${targetSectionCount}
- purpose: 이 이미지가 전달해야 하는 메시지(짧은 한 문장)
- prompt_ko: 한국어 이미지 생성 프롬프트(1~2문장). 구도, 거리감, 시선 높이, 제품이 프레임에서 차지하는 비중을 함께 명시할 것.
- prompt_en: 영어 프롬프트(실제 이미지 생성용). Include composition, framing distance, camera angle, product prominence, and the key subject action. Keep it neutral enough that studio/lifestyle/outdoor priority can still be controlled at generation time.
- negative_prompt: 피해야 할 요소${outputMode === "full-image" ? ". 통이미지 모드에서는 작은 글씨, 촘촘한 설명문, 복잡한 표, 각주형 텍스트, 모바일에서 읽히지 않는 캡션, 말줄임표, 잘린 텍스트, CTA 버튼, 화살표 버튼, 링크형 문구, 섹션마다 다른 한글 폰트, 손글씨체, 장식 서체를 반드시 포함할 것" : ""}
- style_guide: 전체 통일 스타일. 스튜디오는 정제된 세트/조명/질감, 라이프스타일은 현실감 있는 공간/행동, 아웃도어는 위치감/공기감/활동성을 분명히 적을 것. 이 값은 디자인 가이드 우선 모드에서만 강하게 적용될 수 있도록 작성할 것.
- reference_usage: 업로드된 기존 제품 이미지를 어떻게 참고할지. 제품 형태, 라벨, 재질, 색감을 유지하는 기준을 명시할 것.
- section_name, goal, layout_notes, compliance_notes, purpose, style_guide, reference_usage는 반드시 한국어로 작성할 것
- 영어는 *_en 필드와 prompt_en에만 사용할 것

# 이미지 생성 공통 규칙
- 세로형 상세페이지용
- ${outputMode === "full-image" ? "이미지 안에 들어갈 한국어 문구는 모바일폰에서도 크게 읽히도록 짧게 설계하되, 제품 브랜드/수치/효과는 원본 근거가 있을 때만 사용할 것. 버튼, 화살표 버튼, 링크형 CTA, 클릭 유도 문구는 만들지 말 것" : "새 광고 문구, 헤드라인, 워터마크를 이미지 안에 합성하지 말 것. 단, 원본 제품의 패키지 라벨/로고/브랜드 글자는 보존할 것"}
- ${outputMode === "full-image" ? "통이미지 모드에서는 헤드라인 1개, 보조문구 1개, 큰 포인트 카드 최대 2개까지만 권장하고, 더 많은 정보를 넣기 위해 글씨를 줄이지 말 것" : "텍스트편집 모드에서는 편집 텍스트가 올라갈 좌측/하단/상단 여백을 명확히 남기고, 인물 얼굴과 제품 핵심 디테일이 예상 텍스트 영역 뒤에 오지 않게 구도를 계획할 것"}
- ${outputMode === "full-image" ? "카드, 배너, 칩 안의 모든 한국어 문구는 끝까지 보여야 합니다. 말줄임표, 잘린 단어, 카드 밖으로 넘친 텍스트, 하단에 눌린 버튼형 바를 만들지 말 것" : "편집 텍스트가 올라갈 수 있도록 배경과 제품 구도를 안정적으로 둘 것"}
- ${outputMode === "full-image" ? "전 섹션의 한글 폰트는 같은 현대적 산세리프 계열로 보이게 유지할 것. 굵기와 크기는 위계만 다르게 하고 폰트 가족 자체가 달라 보이면 안 됨" : "편집 텍스트가 올라갈 수 있도록 배경과 제품 구도를 안정적으로 둘 것"}
- 배경은 단순하게 유지하고 제품/핵심 오브젝트에 시선을 집중시킬 것
- 한 장에 메시지 하나만 전달할 것
- 섹션마다 촬영 역할을 반드시 다르게 설계할 것: 히어로우는 모델+제품 대표컷, 문제/질문은 생활 속 불편 장면, 가이드/가치 제안은 제품을 해결책으로 보여주는 장면, 계획은 손동작/순서/루틴, 디테일/구성/고시는 제품 클로즈업 또는 구성컷, 사용 후/마지막 확신은 구매 후 생활 장면으로 분리할 것
- 참고 모델 이미지를 전체 일관성에 쓰더라도 모든 섹션을 얼굴 중심 모델컷으로 만들지 말 것. 정보/디테일/구성/고시 섹션은 모델 얼굴보다 제품, 손, 구성품, 질감, 여백을 우선할 것
- 규제 리스크가 있으면 안전한 표현으로 수정할 것
- extractedSellingPoints / currentPageDiagnosis / productCutRegion / multiProductPage 필드는 긴 참조 상세페이지(여러 가로 스트립)를 분석할 때만 채웁니다. 분석할 기존 상세페이지가 없으면(단일 제품컷 등) 빈 배열·confidence 0·multiProductPage=false로 두고, 페이지에 실제로 적힌 내용이 아닌 값을 지어내지 말 것
- JSON 외 텍스트를 붙이지 말고 모든 필드는 간결하게 작성할 것

응답은 반드시 제공된 JSON 스키마를 준수해야 합니다.
`.trim();
}

function buildStoryBrandSellingPrompt(customerReviewAnalysis?: PdpCustomerReviewAnalysis) {
  const hasReviews = Boolean(customerReviewAnalysis?.reviewCount);

  return [
    "# StoryBrand 판매 서사 기준(강제)",
    "- 고객이 주인공입니다. 브랜드/제품 자랑보다 고객이 원하는 결과와 지금 겪는 불편을 먼저 말하세요.",
    "- 문제는 외적 문제(상황/불편), 내적 문제(불안/짜증/망설임), 철학적 문제(좋은 선택이라면 이 불편을 남기면 안 됨)를 함께 잡으세요.",
    "- 제품은 영웅이 아니라 가이드입니다. 공감(그 불편을 안다)과 권위(그래서 이 제품이 어떻게 줄여준다)를 동시에 보여주세요.",
    "- 계획은 3단계 안팎으로 단순하게 쓰고, 제품의 물성/구조/사용법이 어떻게 문제를 줄이는지 연결하세요.",
    "- 구매 제안은 추상 명령이 아니라 구매 이유입니다. 버튼 문구처럼 '지금 확인하기'를 쓰지 말고 어떤 문제를 피하고 어떤 장점을 얻기 위해 사야 하는지 말하세요.",
    "- 손실 회피는 과장 공포가 아니라 기존 선택을 유지할 때의 실제 비용입니다. 카테고리와 연결된 불편, 시간 낭비, 선택 실패, 성과 저하 가능성을 구체적으로 쓰세요.",
    "- 성공 장면은 카테고리 바깥의 막연한 일상 변화가 아니라 제품 사용 후 바로 떠오르는 장면으로 쓰세요.",
    hasReviews
      ? "- 후기 데이터가 있으므로 모든 섹션은 후기에서 나온 장점/아쉬움/샘플 문장을 눈에 보이게 활용하세요. 장점은 문제 제기에서 역질문으로, 해결/확신에서는 구매 이유로 다시 사용하세요."
      : "- 후기 데이터가 없다면 카테고리의 일반적인 구매 전 불편을 구체적으로 다루세요. 단, 검증되지 않은 효능, 수치, 인증, 실제 후기처럼 보이는 문장은 만들지 마세요."
  ].join("\n");
}

/**
 * Pass-1 transcription prompt (adapted from the detail-page-analyzer PASS1 system prompt).
 * Transcription completeness beats analysis: the transcript becomes the factual copy
 * inventory every later prompt (blueprint, expand) cites.
 */
function buildTranscribeStripsPrompt(
  strips: NormalizedAnalysisStrip[],
  batchIndex: number,
  batchCount: number,
  previousSectionHint?: string
) {
  const stripLines = strips
    .map(
      (strip, index) =>
        `- ${index + 1}번째 이미지 = 페이지 세로 ${(strip.yStartRatio * 100).toFixed(1)}%~${(strip.yEndRatio * 100).toFixed(1)}% 구간`
    )
    .join("\n");
  const hint = previousSectionHint?.trim()
    ? `이전 배치의 마지막 섹션 유형: ${previousSectionHint.trim().slice(0, 80)} (이 흐름이 첫 구간으로 이어질 수 있습니다.)`
    : "";

  return `당신은 한국 이커머스 상세페이지 전사 전문가입니다. 지금 전달되는 이미지들은 하나의 상품 상세페이지를 위에서 아래로 자른 연속 구간이며, 이번 배치는 전체 ${batchCount}개 중 ${batchIndex + 1}번째입니다.

[구간 위치]
${stripLines}
${hint}

각 구간에 대해 transcript 필드에 아래 형식의 마크다운을 작성하세요.

### 구간 N (세로 X%~Y%)
[전사] 이미지 안의 모든 한국어/영어 텍스트를 빠짐없이 그대로 받아쓰세요. 요약·의역 금지. 작은 글씨(성분표, 주의사항, 인증번호, 시험 수치, 고시정보)도 모두 포함하고, 읽을 수 없는 글자는 (판독불가)로 표시하세요. 구간 경계에서 잘린 문장은 보이는 부분까지만 적고 끝에 (절단)을 붙이세요. 텍스트가 없으면 "(텍스트 없음 — 이미지 연출만)"으로 표시하세요.
[섹션 유형] 후킹 / 문제제기 / 혜택·약속 / 신뢰요소(리뷰·인증·수상·시험데이터) / 스펙·상세정보 / 비교 / FAQ / CTA·프로모션 / 배송·교환·법정정보 / 기타 중에서 판정.
[연출] 실사·모델컷·제품단독컷·인포그래픽·도표 여부와 색감·톤을 1문장으로.

규칙:
1. 전사의 완전성이 최우선입니다. 분석·평가보다 받아쓰기가 중요합니다.
2. 가격, 수치, 단위, 브랜드명, 제품명은 보이는 표기 그대로 적으세요. 추측으로 채우지 마세요.
3. lastSectionType 필드에는 이번 배치 마지막 구간의 섹션 유형 하나만 적으세요.`;
}

function parseTranscriptPayload(
  raw: string,
  provider: "gemini" | "openai"
): { transcript: string; lastSectionType?: string } {
  const errorCode: PdpErrorCode = provider === "openai" ? "OPENAI_RESPONSE_INVALID" : "GEMINI_RESPONSE_INVALID";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PdpServiceError(
      errorCode,
      "상세페이지 전사 응답을 해석하지 못했습니다.",
      `transcribe: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const transcript = asString((parsed as Record<string, unknown>)?.transcript).trim();
  if (!transcript) {
    throw new PdpServiceError(errorCode, "상세페이지 전사 결과가 비어 있습니다.", "transcribe: empty transcript");
  }
  const lastSectionType = asString((parsed as Record<string, unknown>)?.lastSectionType).trim().slice(0, 80);

  return {
    transcript: transcript.slice(0, MAX_LONG_PAGE_TRANSCRIPT_CHARS),
    lastSectionType: lastSectionType || undefined
  };
}

/**
 * Injects the pass-1 transcript into the analyze prompt as the authoritative copy source.
 * Without it the model can only use glyphs that survived strip downscaling.
 */
function buildLongPageTranscriptPrompt(transcript?: string) {
  const trimmed = transcript?.trim();
  if (!trimmed) {
    return "";
  }
  const capped =
    trimmed.length > MAX_LONG_PAGE_TRANSCRIPT_CHARS
      ? `${trimmed.slice(0, MAX_LONG_PAGE_TRANSCRIPT_CHARS)}\n(후략 — 전사가 길어 일부 생략됨)`
      : trimmed;
  return [
    "[상세페이지 전문 전사]: 아래는 업로드된 상세페이지를 구간별로 실제로 받아쓴 전체 텍스트와 섹션 구성입니다. 스트립 이미지에서 작아서 읽기 어려운 글자도 이 전사에는 담겨 있으므로, 제품명/스펙/효능/인증/카피의 사실 근거로는 이 전사를 최우선으로 사용하세요. 이미지와 전사가 다르게 읽히면 전사를 우선하세요.",
    "단, 전사에 없는 수치/인증/효능/후기를 새로 만들지 마세요. extractedSellingPoints와 currentPageDiagnosis도 이 전사를 근거로 작성하세요.",
    "<상세페이지_전사>",
    capped,
    "</상세페이지_전사>"
  ].join("\n");
}

function buildImageOptimizationPrompt(imageOptimization?: PdpAnalysisImageMetadata) {
  if (!imageOptimization) {
    return "";
  }

  if (imageOptimization.mode === "original") {
    return "";
  }

  if (imageOptimization.mode === "long-detail-strips") {
    return [
      `[분석 입력 형식]: 업로드 원본은 ${imageOptimization.originalWidth}x${imageOptimization.originalHeight}px의 긴 상세페이지이고, 가독성을 위해 위에서 아래로 순서대로 잘린 ${imageOptimization.stripCount ?? 0}장의 가로 스트립으로 제공됩니다. 첫 이미지가 페이지 최상단, 마지막 이미지가 최하단입니다. 이 스트립들을 한 장의 연속된 상세페이지로 읽으세요.`,
      "글자가 읽히도록 확대되어 있으니, 제품명/스펙/효능/인증/카피를 실제로 읽어서 근거로 사용하세요. 단, 명확히 읽히지 않는 작은 글씨는 추측하지 말고 사용자가 입력한 추가 정보만 보강 근거로 쓰세요.",
      "[주력 제품(primary SKU) 잠금]: 페이지에서 가장 크고 일관되게 반복 등장하는 '주력 제품' 1개를 먼저 확정하세요. 단, 사용자가 추가 정보에 제품명/카테고리를 적었다면 그 제품을 주력 SKU로 우선 확정하세요(크기·반복보다 사용자가 지정한 제품명이 우선). 페이지에 번들/세트/연관상품/타 제품 컷이나 카피가 함께 있어도, 그 다른 제품의 문구·수치·효능·후기를 주력 제품의 것으로 절대 가져오지 마세요. extractedSellingPoints에는 오직 주력 제품에 해당하는, 페이지에 실제로 적힌 셀링포인트/약속/카피만 담으세요. 그리고 주력 제품 외에 다른 제품(번들/세트/연관상품/형제 제품/크로스셀)이 함께 보이면 multiProductPage를 true로, 단일 제품만 있으면 false로 설정하세요. [브랜드·제품명 출처 규칙]: 브랜드명·제품명은 반드시 '실제 제품 자체'(용기·튜브·보틀·박스·파우치·라벨·기기 본체 등 물리적 제품 표면)에 인쇄된 글자에서 읽으세요. 페이지의 헤드라인 카피, 판촉/이벤트/할인 배너, 섹션 제목, 연출(라이프스타일) 문구처럼 '제품 표면이 아닌 곳'의 큰 글자는 — 아무리 크고 눈에 띄어도 — 브랜드·제품명이 아닙니다. 그런 마케팅 문구를 제품명으로 절대 채택하지 마세요.",
      "[현재 페이지 진단]: currentPageDiagnosis에 이 상세페이지의 강점(strengths)/약점(weaknesses)/개선안(improvements)을 적으세요. 그리고 그 약점을 고친 '더 나은 새 상세페이지'를 sections로 설계하세요. improvements는 새 페이지 구성 전략에만 반영하고, 이미지 안에 사실처럼 합성하지 마세요.",
      "[제품컷 위치]: productCutRegion에 주력 제품이 가장 또렷하게 단독으로 보이는 구간의 세로 위치를 0~1 비율(yStartRatio/yEndRatio, 전체 페이지 높이 기준)로 알려주세요. 좌우를 좁힐 수 있으면 xStartRatio/xEndRatio도 0~1로, 아니면 null. confidence는 그 구간에 '깨끗한 제품컷'이 있을 확신도(0~1)입니다. 여기서 깨끗한 제품컷이란, 실제 제품 자체가 단독으로 — 헤드라인/카피 텍스트, 그래픽 요소, 가격·할인·배지 콜아웃, 배경 합성, 인물·상황 연출과 겹치지 않고 — 실물 그대로 또렷하게 찍힌 컷을 말합니다. 텍스트나 그래픽이 얹힌 마케팅 합성 컷·배너·스타일화된 히어로 목업·라이프스타일 연출 컷은, 제품이 크게 보여도 '깨끗한 제품컷'이 아니므로 confidence를 낮게 주세요. 이 판단은 특정 문구가 아니라 '제품이 단독·실물로 격리되어 있는가'라는 성질로 하세요. 페이지 전체에 그런 깨끗한 단독 제품컷이 없으면 억지로 고르지 말고 confidence를 0에 가깝게 두세요(없으면 없다고 정직하게 낮은 값). 제품컷 구간(yStartRatio~yEndRatio)은 제품이 또렷이 담기는 범위로 너무 길지 않게 좁게 잡으세요."
    ].join("\n");
  }

  if (imageOptimization.mode === "long-detail-sampling") {
    return [
      `[분석 이미지 최적화 정보]: 업로드 원본은 ${imageOptimization.originalWidth}x${imageOptimization.originalHeight}px의 긴 상세페이지였고, 비용/속도 절감을 위해 ${imageOptimization.optimizedWidth}x${imageOptimization.optimizedHeight}px 분석용 샘플 보드로 변환되었습니다.`,
      `왼쪽 좁은 열은 전체 페이지 흐름 요약이고, 오른쪽 패널들은 상단부터 하단까지 균등하게 뽑은 대표 구간 ${imageOptimization.sampleCount ?? 0}개입니다.`,
      "이 보드를 실제 상세페이지 디자인 요소로 복제하지 말고, 제품 카테고리/주요 약속/시각 톤/전환 흐름을 추론하는 분석 자료로만 사용하세요.",
      "작은 글자는 누락될 수 있으므로 이미지에서 명확히 보이는 정보와 사용자가 입력한 추가 정보만 사실로 취급하세요."
    ].join("\n");
  }

  return `[분석 이미지 최적화 정보]: 업로드 원본은 ${imageOptimization.originalWidth}x${imageOptimization.originalHeight}px였고, 분석 비용 절감을 위해 ${imageOptimization.optimizedWidth}x${imageOptimization.optimizedHeight}px JPEG로 축소되었습니다. 명확히 보이는 정보만 근거로 사용하세요.`;
}

function normalizeAnalyzeSourceMaterials(sourceMaterials?: PdpSourceMaterial[]): PdpSourceMaterial[] {
  if (!Array.isArray(sourceMaterials)) {
    return [];
  }

  let remainingTextBudget = MAX_ANALYZE_SOURCE_TEXT_CHARS;
  let imageCount = 0;
  const normalizedMaterials: PdpSourceMaterial[] = [];

  sourceMaterials
    .slice(0, MAX_ANALYZE_SOURCE_MATERIALS)
    .forEach((material, index) => {
      const kind = material?.kind === "pdf" ? "pdf" : material?.kind === "image" ? "image" : null;
      const fileName = asString(material?.fileName).slice(0, 160) || `source-${index + 1}`;

      if (!kind) {
        return;
      }

      const text = asString(material?.text);
      const normalizedText = text && remainingTextBudget > 0
        ? text.slice(0, Math.min(MAX_ANALYZE_SOURCE_TEXT_CHARS_PER_FILE, remainingTextBudget))
        : "";
      if (normalizedText) {
        remainingTextBudget -= normalizedText.length;
      }

      let imageBase64: string | undefined;
      let imageMimeType: string | undefined;
      if (material?.role !== "primary" && material?.imageBase64 && imageCount < MAX_ANALYZE_SOURCE_IMAGES) {
        imageBase64 = sanitizeBase64Payload(material.imageBase64);
        imageMimeType = normalizeMimeType(material.imageMimeType || material.mimeType || DEFAULT_IMAGE_MIME);
        imageCount += 1;
      }

      normalizedMaterials.push({
        kind,
        role: material?.role === "primary" ? "primary" as const : "supporting" as const,
        fileName,
        mimeType: asString(material?.mimeType).slice(0, 80) || undefined,
        size: Math.max(0, Math.floor(Number(material?.size) || 0)) || undefined,
        pageCount: material?.pageCount ? Math.max(1, Math.floor(Number(material.pageCount) || 1)) : undefined,
        text: normalizedText || undefined,
        imageBase64,
        imageMimeType,
        imageOptimization: material?.imageOptimization
      });
    });

  return normalizedMaterials;
}

function buildGeminiSourceMaterialImageParts(sourceMaterials: PdpSourceMaterial[]) {
  return sourceMaterials
    .filter((material) => material.role !== "primary" && material.imageBase64 && material.imageMimeType)
    .map((material) => buildHighResolutionInlinePart(material.imageMimeType || DEFAULT_IMAGE_MIME, material.imageBase64 || ""));
}

function buildOpenAiSourceMaterialImageInputs(sourceMaterials: PdpSourceMaterial[]) {
  return sourceMaterials
    .filter((material) => material.role !== "primary" && material.imageBase64 && material.imageMimeType)
    .map((material) => ({
      type: "input_image" as const,
      image_url: toDataUrl(material.imageMimeType || DEFAULT_IMAGE_MIME, material.imageBase64 || "")
    }));
}

// ===== Approach A v2: long-detail legible strips =====

function clampRatio(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Sanitize + cap the ordered legible strips sent for a long detail page. */
function normalizeAnalysisStrips(strips?: PdpAnalysisStrip[]): NormalizedAnalysisStrip[] {
  if (!Array.isArray(strips)) {
    return [];
  }

  return strips
    .slice(0, MAX_ANALYZE_STRIPS)
    .map((strip) => {
      const base64 = sanitizeBase64Payload(asString(strip?.base64));
      if (!base64) {
        return null;
      }
      const yStartRatio = clampRatio(Number(strip?.yStartRatio));
      const yEndRaw = clampRatio(Number(strip?.yEndRatio));
      const yEndRatio = yEndRaw > yStartRatio ? yEndRaw : Math.min(1, yStartRatio + 0.0001);
      return {
        base64,
        mimeType: normalizeMimeType(asString(strip?.mimeType) || DEFAULT_IMAGE_MIME),
        yStartRatio,
        yEndRatio
      } satisfies NormalizedAnalysisStrip;
    })
    .filter((strip): strip is NormalizedAnalysisStrip => Boolean(strip));
}

function buildGeminiStripImageParts(strips: NormalizedAnalysisStrip[]) {
  return strips.map((strip) => buildHighResolutionInlinePart(strip.mimeType, strip.base64));
}

function buildOpenAiStripImageInputs(strips: NormalizedAnalysisStrip[]) {
  return strips.map((strip) => ({
    type: "input_image" as const,
    image_url: toDataUrl(strip.mimeType, strip.base64)
  }));
}

function sanitizeProductCutRegion(region: unknown): PdpProductCutRegion | undefined {
  if (!region || typeof region !== "object") {
    return undefined;
  }
  const value = region as Record<string, unknown>;
  const yStartRatio = clampRatio(Number(value.yStartRatio));
  const yEndRatio = clampRatio(Number(value.yEndRatio));
  const confidenceRaw = Number(value.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0;
  const xStartRatio = Number.isFinite(Number(value.xStartRatio)) ? clampRatio(Number(value.xStartRatio)) : null;
  const xEndRatio = Number.isFinite(Number(value.xEndRatio)) ? clampRatio(Number(value.xEndRatio)) : null;
  const validX = xStartRatio != null && xEndRatio != null && xEndRatio > xStartRatio;
  return {
    yStartRatio,
    yEndRatio,
    xStartRatio: validX ? xStartRatio : null,
    xEndRatio: validX ? xEndRatio : null,
    // Geometry must be top<bottom to be usable; otherwise force low confidence so we fall back.
    confidence: yEndRatio > yStartRatio ? confidence : 0
  };
}

function sanitizeCurrentPageDiagnosis(input: unknown): PdpCurrentPageDiagnosis | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const strengths = asStringArray(value.strengths);
  const weaknesses = asStringArray(value.weaknesses);
  const improvements = asStringArray(value.improvements);
  if (!strengths.length && !weaknesses.length && !improvements.length) {
    return undefined;
  }
  return { strengths, weaknesses, improvements };
}

/**
 * Resolve the hero/section generation reference for a long detail page: crop the model-identified
 * product region out of the legible strips. Falls back to a mid-document strip (never the top, to
 * avoid banners) or the provisional reference when no confident region is available.
 */
async function resolveLongDetailHeroReference(input: {
  strips: NormalizedAnalysisStrip[];
  productCutRegion?: PdpProductCutRegion;
  fallbackBase64: string;
  fallbackMimeType: string;
}): Promise<{ base64: string; mimeType: string; usedFallback: boolean }> {
  const { strips, productCutRegion, fallbackBase64, fallbackMimeType } = input;

  if (!strips.length) {
    return { base64: fallbackBase64, mimeType: fallbackMimeType, usedFallback: true };
  }

  const midStrip = strips[Math.floor(strips.length / 2)];
  const region = productCutRegion;
  const usable =
    !!region && region.confidence >= PRODUCT_CUT_MIN_CONFIDENCE && region.yEndRatio > region.yStartRatio;

  if (usable) {
    try {
      const cropped = await cropProductRegionFromStrips(strips, region!);
      if (cropped) {
        return { base64: cropped, mimeType: "image/jpeg", usedFallback: false };
      }
      console.warn("[pdp.analyze] product-cut crop returned no overlapping strip; using mid-strip fallback");
    } catch (error) {
      console.warn(`[pdp.analyze] product-cut crop failed, using mid-strip fallback: ${stringifyError(error)}`);
    }
  } else {
    console.warn(
      `[pdp.analyze] productCutRegion missing/low-confidence (confidence=${region?.confidence ?? "n/a"}); using mid-strip fallback`
    );
  }

  return { base64: midStrip.base64, mimeType: midStrip.mimeType, usedFallback: true };
}

/** Crop the product region from the single strip with the largest vertical overlap. */
async function cropProductRegionFromStrips(
  strips: NormalizedAnalysisStrip[],
  region: PdpProductCutRegion
): Promise<string | null> {
  let best: NormalizedAnalysisStrip | null = null;
  let bestOverlap = 0;
  for (const strip of strips) {
    const overlap = Math.min(strip.yEndRatio, region.yEndRatio) - Math.max(strip.yStartRatio, region.yStartRatio);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = strip;
    }
  }
  if (!best || bestOverlap <= 0) {
    return null;
  }

  const buffer = Buffer.from(best.base64, "base64");
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) {
    return null;
  }

  const span = best.yEndRatio - best.yStartRatio || 1;
  const relStart = Math.max(0, (region.yStartRatio - best.yStartRatio) / span);
  const relEnd = Math.min(1, (region.yEndRatio - best.yStartRatio) / span);
  let top = Math.max(0, Math.min(height - 1, Math.floor(relStart * height)));
  let cropHeight = Math.max(1, Math.ceil(relEnd * height) - top);
  cropHeight = Math.min(cropHeight, height - top);

  let left = 0;
  let cropWidth = width;
  if (region.xStartRatio != null && region.xEndRatio != null && region.xEndRatio > region.xStartRatio) {
    left = Math.max(0, Math.min(width - 1, Math.floor(region.xStartRatio * width)));
    cropWidth = Math.max(1, Math.ceil(region.xEndRatio * width) - left);
    cropWidth = Math.min(cropWidth, width - left);
  }

  const out = await sharp(buffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return out.toString("base64");
}

function buildSourceMaterialsPrompt(sourceMaterials?: PdpSourceMaterial[]) {
  const normalized = normalizeAnalyzeSourceMaterials(sourceMaterials);

  if (!normalized.length) {
    return "";
  }

  const lines = normalized.map((material, index) => {
    const roleLabel = material.role === "primary" ? "대표 분석 자료" : "보조 자료";
    const kindLabel = material.kind === "pdf" ? `PDF${material.pageCount ? ` ${material.pageCount}p` : ""}` : "이미지";
    const imageLabel = material.imageBase64 ? "보조 이미지가 별도 비전 입력으로 제공됨" : material.role === "primary" ? "대표 이미지는 기본 입력으로 제공됨" : "이미지 입력 없음";
    const text = material.text ? `\n추출 텍스트:\n${material.text}` : "";
    return `## 자료 ${index + 1}: ${material.fileName}
- 역할: ${roleLabel}
- 유형: ${kindLabel}
- 분석 방식: ${imageLabel}${text}`;
  });

  return [
    "[업로드 원본 자료 목록]: 사용자가 첫 단계에서 여러 이미지/PDF를 함께 등록했습니다.",
    "대표 분석 자료는 기본 이미지 입력입니다. 보조 이미지가 있으면 별도 비전 입력으로 함께 제공됩니다.",
    "PDF 텍스트는 원본 자료에서 추출한 근거입니다. PDF나 보조 이미지에서 확인되는 제품명, 구성, 사용법, 톤, 금지 표현은 상세페이지 전략에 반영하되, 명확히 확인되지 않는 수치/인증/효능/리뷰는 만들지 마세요.",
    lines.join("\n\n"),
    "",
    "[제품 참조 이미지 지목]: 위 자료들 중 '주력 제품이 헤드라인/배지/가격/합성 그래픽/모델 연출 없이 실물 그대로 또렷하게 나온 깨끗한 제품 사진'이 있으면 referenceProductImage에 그 자료 번호(materialIndex, 위 목록의 '자료 N' 번호)와 확신도(confidence 0~1)를 채우세요. 같은 주력 제품이 여러 개(앞면/뒷면, 다른 각도, 겹쳐 놓은 컷)로 나온 사진은 좋은 참조이므로 지목 가능합니다.",
    "지목 금지: 상세페이지 캡처(세로로 긴 페이지), 세일/이벤트 배너, 서로 다른 제품이 섞여 나온 라인업 컷, 텍스트가 얹힌 마케팅 합성 컷, 주력 제품이 아닌 다른 제품(번들/형제 제품) 사진. 이미지가 비전 입력으로 제공되지 않은 자료도 지목하지 마세요.",
    "확실한 후보가 없으면 referenceProductImage를 null로 두거나 confidence를 0.3 이하로 주세요. 애매하면 낮게 — 잘못 지목하면 다른 제품 외형으로 페이지가 생성됩니다."
  ].join("\n");
}

function buildKnowledgePrompt(knowledgeText?: string) {
  const normalizedKnowledge = (knowledgeText || "").trim().slice(0, 60000);

  if (!normalizedKnowledge) {
    return "";
  }

  return [
    "[등록 사전 지식]: 사용자가 브라우저에 등록한 PDF/TXT/MD 지식파일에서 추출한 내용입니다.",
    "아래 지식은 상세페이지 전략, 브랜드 톤, 금지 표현, 카피 기준, 카테고리 주의사항으로 우선 참고하세요.",
    "단, 업로드 이미지나 사용자 추가 정보와 충돌하면 업로드 이미지에서 명확히 확인되는 사실을 우선합니다.",
    "사전 지식만 근거로 원본에 없는 효능, 인증, 수치, 리뷰, 가격, 브랜드명을 새로 만들지 마세요.",
    normalizedKnowledge
  ].join("\n");
}

function buildCustomerReviewPrompt(customerReviewAnalysis?: PdpCustomerReviewAnalysis) {
  if (!customerReviewAnalysis?.reviewCount) {
    return "";
  }

  const productKind = inferPdpCopyProductKind([
    customerReviewAnalysis.fileName,
    ...customerReviewAnalysis.topBenefits,
    ...customerReviewAnalysis.keywordSummary,
    ...customerReviewAnalysis.sampleReviews
  ]);
  const topBenefits = normalizePdpReviewBenefitSalesCopyList(customerReviewAnalysis.topBenefits, productKind, 6, 90);
  const painPoints = normalizePromptList(customerReviewAnalysis.painPoints, 6, 90);
  const improvementPromises = normalizePromptList(customerReviewAnalysis.improvementPromises, 6, 120);
  const sampleReviews = normalizePromptList(customerReviewAnalysis.sampleReviews, 12, 140);
  const keywords = normalizePromptList(customerReviewAnalysis.keywordSummary, 10, 40);
  const sampledReviewCount = customerReviewAnalysis.sampledReviewCount ?? customerReviewAnalysis.reviewCount;
  const reviewCountLine = sampledReviewCount < customerReviewAnalysis.reviewCount
    ? `전체 ${customerReviewAnalysis.reviewCount}건 중 대표 ${sampledReviewCount}건 균등 샘플 분석`
    : `${customerReviewAnalysis.reviewCount}건 분석`;

  return `
[고객 후기 엑셀 분석]
- 파일명: ${customerReviewAnalysis.fileName}
- 후기 분석 범위: ${reviewCountLine}
- 고객이 가장 필요로 한 장점/만족 포인트: ${topBenefits.join(" / ") || "후기에서 반복된 만족 포인트"}
- 반복된 단점/아쉬움/구매 전 고민: ${painPoints.join(" / ") || "명시된 단점 없음"}
- 개선 메시지로 전환할 내용: ${improvementPromises.join(" / ") || "구매 전 확인 포인트를 먼저 안내"}
- 반복 키워드: ${keywords.join(" / ") || "없음"}
- 실제 후기 샘플:
${sampleReviews.map((review, index) => `  ${index + 1}. "${review}"`).join("\n")}

고객 후기 데이터 사용 규칙:
- 전체 섹션 설계에서 후기 데이터의 장점은 더 크게 부각하고, 단점/아쉬움은 "우리가 개선했다/구매 전 먼저 안내한다/선택 실패를 줄인다"는 메시지로 전환하세요.
- 후기 장점은 히어로/혜택/확신 섹션에서 "후기/리뷰/인정" 라벨로 쓰지 말고 판매 카피로 바꾸세요. "OO 인정 후기", "OO 적다는 후기" 같은 표현은 금지하고, 라벨만 뗀 뒤 그 장점 OO을 이 제품의 혜택 문장으로 다시 쓰세요. 이 제품과 무관한 다른 카테고리의 혜택 문구를 가져오면 안 됩니다.
- 고객 고민, 문제 제기, 구매 전 고민 섹션에는 반복된 단점/아쉬움과 실제 후기 표현을 짧은 말풍선 또는 질문형 문장으로 사용하세요.
- 단점/아쉬움이 적고 장점만 많다면 장점을 역으로 구매 전 불편 질문으로 바꾸세요. 후기 장점이 "OO이 좋다"라면 "OO이 부족해서 불편했던 적 없으신가요?"처럼 이 제품의 사용 맥락 안에서 질문으로 바꿉니다.
- 고객 후기, 리뷰, 사용 후 변화 섹션에는 실제 후기 샘플을 짧게 다듬어 후기 카드 문장으로 사용하세요.
- 입력 후기에서 확인되지 않은 별점 평균, 인증된 리뷰 수, 100% 리얼 리뷰, 인플루언서명, 과장된 효능/수치/전후 변화는 만들지 마세요.
`;
}

function normalizePromptList(values: string[] | undefined, limit: number, maxLength: number) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(normalized);
  });

  return result.slice(0, limit);
}

const INTERNAL_VISIBLE_COPY_LABELS = [
  "히어로",
  "고객 공감",
  "문제 제기",
  "문제 공감",
  "가이드 제안",
  "가이드/제품 소개",
  "제품 소개",
  "해결 계획",
  "사용 계획",
  "신뢰 근거",
  "행동 유도",
  "사용 후 변화",
  "놓쳤을 때 손실",
  "마지막 확신",
  "구매 전 고민",
  "선택 이유",
  "근거/신뢰",
  "사용법",
  "FAQ/보증",
  "사용 상황",
  "루틴",
  "제품 디테일",
  "기대 장면",
  "구매 제안",
  "왜 지금 필요한가",
  "비교 포인트",
  "핵심 기능",
  "확인 근거",
  "오퍼/마무리",
  "새 섹션"
];

const GENERIC_VISIBLE_COPY_PATTERNS = [
  /원본\s*상세페이지/,
  /보이는\s*제품명.*사용\s*장면/,
  /기준으로\s*표현/,
  /기준으로\s*작성/,
  /이\s*페이지/,
  /이\s*상세페이지/,
  /이\s*섹션/,
  /섹션\s*역할/,
  /페이지\s*몰입/,
  /구매\s*흐름을\s*만듭/,
  /해결\s*흐름을\s*엽/,
  /히어로우?.*흐름.*전환.*설득/,
  /전환\s*설득을\s*강화/,
  /고객이\s*지금\s*겪는\s*불편과\s*욕구/,
  /자기\s*이야기처럼\s*느끼게/,
  /제품이\s*문제\s*해결을\s*도와주는\s*이유/,
  /불편은\s*늘\s*같은\s*순간/,
  /구매\s*전\s*(궁금한\s*)?디테일.*가까이/,
  /구매\s*전\s*확인할\s*정보/,
  /구매\s*전\s*확인\s*정보/,
  /구매\s*전\s*마지막\s*점검/,
  /주의사항과\s*구성\s*정보/,
  /주의사항\s*확인/,
  /구성\s*및\s*옵션\s*안내/,
  /상품정보\s*확인/,
  /필요한\s*순간을\s*놓치기\s*전/,
  /일상이\s*조금\s*더\s*가벼워/,
  /미루면\s*같은\s*불편/,
  /같은\s*불편이\s*다시\s*남/,
  /제품\s*확인/,
  /지금\s*확인/,
  /구매\s*하기/,
  /구매하러/,
  /바로\s*가기/,
  /자세히\s*보기/,
  /클릭/,
  /버튼/,
  />\s*$/,
  /이\s*섹션에서\s*강조할\s*메시지/,
  /직접\s*추가한\s*전환\s*섹션/,
  /새\s*헤드라인을\s*입력/,
  /conversion-focused/i,
  /extend\s+the\s+hero/i
];

function buildOnImageCopy(section: SectionBlueprint, options?: InternalImageGenOptions) {
  const copyRole = inferVisibleCopyRole(section);
  const isReviewCopy = copyRole === "review";
  const productKind = inferPdpCopyProductKind([
    section.section_id,
    section.section_name,
    section.goal,
    section.headline,
    section.subheadline,
    ...(section.bullets ?? []),
    section.trust_or_objection_line,
    section.purpose,
    section.prompt_ko,
    section.layout_notes,
    section.reference_usage
  ]);
  const headline = constrainVisibleCopyForImage(
    normalizeVisibleBenefitCopy(
      sanitizeVisibleCopy(section.headline, section.section_name) ||
      sanitizeVisibleCopy(options?.headline, section.section_name) ||
      buildFallbackVisibleHeadline(section),
      copyRole,
      productKind
    ),
    options,
    30
  );
  const subheadline = constrainVisibleCopyForImage(
    normalizeVisibleBenefitCopy(
      sanitizeVisibleCopy(section.subheadline, section.section_name) ||
      sanitizeVisibleCopy(options?.subheadline, section.section_name) ||
      buildFallbackVisibleSubheadline(section, headline),
      copyRole,
      productKind
    ),
    options,
    34
  );
  const maxBullets = options?.outputMode === "full-image" ? (isReviewCopy ? 3 : 2) : 3;
  const bulletMaxLength = options?.outputMode === "full-image" ? (isReviewCopy ? 26 : 16) : 56;
  const bullets = section.bullets
    .map((copy) => sanitizeVisibleCopy(copy, section.section_name))
    .filter(Boolean)
    .concat(buildFallbackVisibleBullets(section, copyRole))
    .filter((copy, index, values) => values.findIndex((value) => normalizeVisibleCopyKey(value) === normalizeVisibleCopyKey(copy)) === index)
    .map((copy) => normalizeVisibleBenefitCopy(copy, copyRole, productKind))
    .filter(Boolean)
    .filter((copy, index, values) => values.findIndex((value) => normalizeVisibleCopyKey(value) === normalizeVisibleCopyKey(copy)) === index)
    .map((copy) => constrainVisibleCopyForImage(copy, options, bulletMaxLength))
    .filter((copy) => normalizeVisibleCopyKey(copy) !== normalizeVisibleCopyKey(headline))
    .filter((copy) => normalizeVisibleCopyKey(copy) !== normalizeVisibleCopyKey(subheadline))
    .slice(0, maxBullets);
  const shouldUseTrustLine = options?.outputMode !== "full-image" || isReviewCopy;
  const trustLine = shouldUseTrustLine
    ? constrainVisibleCopyForImage(sanitizeVisibleCopy(section.trust_or_objection_line, section.section_name), options, isReviewCopy ? 24 : 18)
    : "";
  const cta = options?.outputMode === "full-image"
    ? ""
    : constrainVisibleCopyForImage(sanitizeVisibleCopy(section.CTA, section.section_name), options, 24);

  return {
    headline,
    subheadline,
    bullets,
    trustLine,
    cta
  };
}

function normalizeVisibleBenefitCopy(
  copy: string,
  copyRole: string,
  productKind: ReturnType<typeof inferPdpCopyProductKind>
) {
  if (!copy || copyRole === "review" || copyRole === "concernList") {
    return copy;
  }

  return normalizePdpReviewBenefitSalesCopy(copy, productKind, 56) || copy;
}

function constrainVisibleCopyForImage(value: string, options: InternalImageGenOptions | undefined, maxLength: number) {
  if (!value || options?.outputMode !== "full-image") {
    return value;
  }

  return shortenVisibleCopy(value, maxLength);
}

function sanitizeVisibleCopy(value?: string, sectionName?: string) {
  const normalized = (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}|…/g, "")
    .replace(/^[-•\d.]+\s*/, "")
    .trim();

  if (!normalized || isInternalVisibleCopy(normalized, sectionName)) {
    return "";
  }

  return shortenVisibleCopy(normalized, 56);
}

function isInternalVisibleCopy(value: string, sectionName?: string) {
  const key = normalizeVisibleCopyKey(value);
  if (!key) {
    return true;
  }

  if (sectionName && key === normalizeVisibleCopyKey(sectionName)) {
    return true;
  }

  if (INTERNAL_VISIBLE_COPY_LABELS.some((label) => key === normalizeVisibleCopyKey(label))) {
    return true;
  }

  return GENERIC_VISIBLE_COPY_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeVisibleCopyKey(value: string) {
  return value
    .replace(/[\s·.,!?'"“”‘’()[\]{}:;_/\-]+/g, "")
    .toLowerCase();
}

function shortenVisibleCopy(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value.replace(/[.,;:]+$/g, "");
  }

  const clipped = value.slice(0, maxLength).replace(/[\s.,;:]+$/g, "");
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.6)) {
    return clipped.slice(0, lastSpace).replace(/[\s.,;:]+$/g, "");
  }

  return clipped;
}

function buildFallbackVisibleHeadline(section: SectionBlueprint) {
  const role = inferVisibleCopyRole(section);
  const goalCopy = sanitizeVisibleCopy(section.goal, section.section_name);
  const purposeCopy = sanitizeVisibleCopy(section.purpose, section.section_name);

  if (role === "disclosure") {
    return buildProductInfoFallbackCopy().headline;
  }

  if (goalCopy && role !== "problem") {
    return shortenVisibleCopy(goalCopy, 34);
  }

  if (purposeCopy && role !== "problem") {
    return shortenVisibleCopy(purposeCopy, 34);
  }

  if (role === "problem") {
    return "선택 앞에서 망설이는 순간";
  }
  if (role === "value") {
    return "선택 이유가 분명해집니다";
  }
  if (role === "plan") {
    return "받는 순간부터 바로 이해되는 흐름";
  }
  if (role === "review") {
    return "실제로 써본 고객은 이렇게 말해요";
  }
  if (role === "proof") {
    return "확인 가능한 정보로 더 안심하게";
  }
  if (role === "compare") {
    return "비교할수록 분명해지는 기준";
  }
  if (role === "cta") {
    return "마지막으로, 선택할 이유";
  }

  return "이 제품을 선택해야 하는 이유";
}

function buildFallbackVisibleSubheadline(section: SectionBlueprint, headline: string) {
  const role = inferVisibleCopyRole(section);
  const purposeCopy = sanitizeVisibleCopy(section.purpose, section.section_name);
  const goalCopy = sanitizeVisibleCopy(section.goal, section.section_name);
  const concreteCopy = purposeCopy || goalCopy;

  if (role === "disclosure") {
    return buildProductInfoFallbackCopy().subheadline;
  }

  if (concreteCopy && normalizeVisibleCopyKey(concreteCopy) !== normalizeVisibleCopyKey(headline)) {
    return shortenVisibleCopy(concreteCopy, 52);
  }

  if (role === "problem") {
    return "좋아 보여도 구매 직전에는 정말 나에게 맞을지 망설임이 남습니다.";
  }
  if (role === "value") {
    return "필요한 순간의 불편을 줄이고 선택 기준을 더 선명하게 만듭니다.";
  }
  if (role === "plan") {
    return "복잡한 설명 없이 사용 순서와 구매 후 장면이 바로 그려집니다.";
  }
  if (role === "review") {
    return "별점과 인용문 카드로 사용 후 만족 포인트를 직접 확인하게 합니다.";
  }
  if (role === "proof") {
    return "확인 가능한 구성과 디테일만 보고 안심하고 판단할 수 있습니다.";
  }
  if (role === "compare") {
    return "여러 선택지 사이에서도 무엇을 보고 고를지 분명해집니다.";
  }
  if (role === "cta") {
    return "같은 고민을 다음으로 미루지 않도록 선택 이유를 분명하게 보여줍니다.";
  }

  return "필요한 순간에 맞는 선택인지 한눈에 판단하게 합니다.";
}

function buildFallbackVisibleBullets(section: SectionBlueprint, role: string) {
  if (role !== "disclosure") {
    return [];
  }

  return buildProductInfoFallbackCopy().bullets;
}

// Disclosure-section fallback copy is intentionally category-neutral. Keyword-based
// category guessing here previously injected sunscreen/sock/patch sample copy (and even
// third-party brand names) into unrelated products whenever a section's own copy was empty.
function buildProductInfoFallbackCopy() {
  return {
    headline: "제품 구성과 디테일 체크",
    subheadline: "패키지, 구성품, 사용 전 확인점을 한눈에",
    bullets: ["제품 형태", "구성품"]
  };
}

function inferVisibleCopyRole(section: Pick<SectionBlueprint, "section_id" | "section_name" | "goal" | "purpose">) {
  const haystack = [section.section_id, section.section_name, section.goal, section.purpose].join(" ").toLowerCase();

  if (/failure|loss|problem|concern|whynow|situation|문제|고민|상황|필요|손실|놓쳤|후회|미루/.test(haystack)) {
    return "problem";
  }
  if (/guide|value|feature|detail|solution|선택|가이드|제품\s*소개|해결책|장점|기능|디테일/.test(haystack)) {
    return "value";
  }
  if (/plan|use|routine|사용|루틴|계획/.test(haystack)) {
    return "plan";
  }
  if (/testimonial|customer\s*review|review|고객\s*후기|실사용\s*후기|사용\s*후기|구매\s*후기|리얼\s*후기|후기(?!형)|리뷰|별점/.test(haystack)) {
    return "review";
  }
  if (/disclosure|spec|고시|상품정보|상품\s*정보|주의|faq|보증|구성\s*정보|옵션\s*안내|사용\s*전\s*확인/.test(haystack)) {
    return "disclosure";
  }
  if (/success|proof|evidence|faq|trust|review|근거|신뢰|보증|faq|후기|사용\s*후|변화|달라/.test(haystack)) {
    return "proof";
  }
  if (/compare|비교/.test(haystack)) {
    return "compare";
  }
  if (/action|cta|offer|구매|행동|오퍼|마무리/.test(haystack)) {
    return "cta";
  }

  return "generic";
}

function buildImagePrompt(
  section: SectionBlueprint,
  desiredTone?: string,
  options?: InternalImageGenOptions
) {
  const visualRole = inferPdpSectionVisualRole(section);
  const baseSceneDirection = getBaseSceneDirection(section, options?.guidePriorityMode ?? "guide-first");
  const onImageCopy = buildOnImageCopy(section, options);
  const mobileReadabilityPrompt = buildMobileReadabilityPrompt(visualRole);
  const contextHeadline = sanitizeVisibleCopy(options?.headline, section.section_name) || onImageCopy.headline;
  const contextSubheadline = sanitizeVisibleCopy(options?.subheadline, section.section_name) || onImageCopy.subheadline;
  let enhancedPrompt = "Create a high-end, conversion-optimized commercial advertising photograph. ";

  if (contextHeadline) {
    enhancedPrompt += `Context: The image should visually represent the advertising headline "${contextHeadline}"`;
    if (contextSubheadline) {
      enhancedPrompt += ` and subheadline "${contextSubheadline}"`;
    }
    enhancedPrompt += ". ";
  }

  if (options?.withModel && options.referenceModelImageBase64) {
    enhancedPrompt +=
      "Reference Inputs: image 1 is the original product reference and must preserve the exact product. image 2 is the mandatory model identity reference. ";
    enhancedPrompt +=
      "The final image MUST use the same person from image 2. Do not switch to a different model, do not change gender, and do not drift to a generic portrait face. ";
    if (options.referenceModelProfile) {
      enhancedPrompt += buildReferenceModelProfilePrompt(options.referenceModelProfile);
    }
  }

  if (options?.isRegeneration) {
    enhancedPrompt += "\n[USER OVERRIDE INSTRUCTIONS - STRICTLY FOLLOW THESE OVER ANY CONFLICTING BASE INSTRUCTIONS]\n";
    enhancedPrompt += buildImageStyleInstructions(options, visualRole);
    enhancedPrompt += "[END USER OVERRIDE INSTRUCTIONS]\n\n";
  } else {
    enhancedPrompt += "\nBase Instructions: ";
  }

  if (options?.withModel && options.referenceModelImageBase64) {
    enhancedPrompt +=
      `Using image 1 as the exact product reference and image 2 as the exact person reference, create a new commercial scene based on this direction: ${baseSceneDirection}. `;
    enhancedPrompt +=
      "The person in the final image must be the same person from image 2, with the same face, gender presentation, hairstyle, skin tone, and overall identity. ";
    enhancedPrompt +=
      "Do not replace the person with a different model, do not masculinize or feminize them differently, and do not drift to a generic fashion face. Treat this as the same person in a new pose, new framing, and new environment. ";
  } else {
    enhancedPrompt += `Keep the product exactly as is. Build the scene from this direction: ${baseSceneDirection}. `;
  }

  if (desiredTone) {
    enhancedPrompt += `The overall style and tone should be ${desiredTone}. `;
  }

  enhancedPrompt += buildGuidePriorityInstructions(section, options);
  enhancedPrompt += buildSectionRoleSceneInstructions(visualRole, options);
  if (section.negative_prompt) {
    enhancedPrompt += ` Negative constraints: avoid ${section.negative_prompt}. `;
  }

  if (!options?.isRegeneration) {
    enhancedPrompt += buildImagePreferenceInstructions(section, options);
  }

  if (options?.retryDirective) {
    enhancedPrompt += ` Retry correction: ${options.retryDirective} `;
  }

  enhancedPrompt += "\nComposition Rules: ";
  enhancedPrompt +=
    "use a varied, intentional camera distance that matches the scene instead of defaulting to a chest-up portrait. ";
  enhancedPrompt +=
    "Depending on the section, use wide shots, medium shots, tabletop/product detail shots, hands-in-frame moments, over-the-shoulder angles, seated scenes, or environment-led framing when they improve product storytelling. ";
  enhancedPrompt +=
    "Keep the product readable, prominent, and beautifully lit, but allow the frame to breathe with negative space, props, and surrounding context when useful. ";
  enhancedPrompt += "\nCRITICAL: The final image must look like a top-tier magazine advertisement or a premium brand's landing page hero shot. ";
  enhancedPrompt += "It should be highly attractive and induce purchase conversion. ";
  if (options?.outputMode === "full-image") {
    enhancedPrompt += [
      "IMPORTANT: This is a complete ecommerce detail-page section image, not a blank photo for later editing.",
      "Include only a few clean, large, legible Korean typography elements directly inside the image using the provided copy.",
      mobileReadabilityPrompt,
      "Korean marketplace detail-page sections are static full images. Never draw fake clickable controls: no CTA buttons, no black rounded button bars, no white action buttons, no arrow buttons, no chevrons, no link labels, and no phrases such as 제품 확인하기, 지금 확인하기, 구매하기, 자세히 보기, or 클릭.",
      "Every visible Korean phrase must fit fully inside its card, badge, or banner. Do not use ellipses, cropped letters, clipped line endings, overflowing text, or tiny footer captions. If the phrase will not fit, remove the support card or use a shorter non-clickable benefit phrase.",
      "Avoid bottom horizontal CTA/trust bars. If the lower area needs emphasis, use one short benefit chip without any button shape or arrow.",
      "Do not make it look like plain text pasted over a generic background photo. Build a polished section layout with a clear editorial grid, intentional margins, typographic hierarchy, accent rules, large chips, roomy callout cards, product/detail frames, or comparison/info cards as appropriate to the section role.",
      visualRole === "disclosure"
        ? "Product-information section lock: this section must be detailed product information, not a generic notice or confirmation graphic. Show the actual product/package from the reference prominently, then use two large callout cards for visibly inspectable details such as patch shape, package 구성, included items, texture, use area, or storage/usage cues. Never use standalone placeholder labels like 주의사항 확인, 구성 및 옵션 안내, 구매 전 마지막 점검, or 상품정보 확인 as the main visible content."
        : visualRole === "review"
          ? "Review section lock: this section must look like customer testimonials, not a generic product benefit scene. Use one of these structures: a large quote testimonial beside a product/use photo, an Instagram/UGC-style post card, or a clean stack/grid of 3-4 review cards with star icons, anonymized IDs, and short first-person customer comments."
          : visualRole === "concernList"
            ? "Concern-list section lock: this section must look like a dark chat-style pre-purchase hesitation board. Use a black or near-black background, a large centered Korean headline, and 4-5 white rounded chat bubbles alternating left and right. Do not turn it into a generic lifestyle photo, proof grid, or review/star-rating section."
          : "",
      "Never render internal section role labels as visible text, such as 문제 공감, 문제 제기, 가이드 제안, 가이드/제품 소개, 전환 선언, 신뢰 근거, 행동 유도, 사용 장면, 사용 후 변화, 놓쳤을 때 손실, 구매 전 고민, or 비교 포인트.",
      "If any provided copy still sounds like an internal planning note, rewrite it into a short customer-facing Korean sales phrase grounded in the product reference and section goal before placing it on the image.",
      "For hero, value, lifestyle, success, or proof chips, never write review-evidence labels such as 후기, 리뷰, 인정 후기, or 적다는 후기. Convert review evidence into a direct benefit claim by dropping the review label and keeping the benefit wording itself. Never introduce benefit claims or product-type words that belong to a different product category than the referenced product.",
      options.isRegeneration
        ? "This is an image-mode revision of a complete design: keep the section as a finished ad page and do not erase the on-image marketing text."
        : "",
      "Typography consistency lock: all Korean text should look like one modern Korean sans-serif family across sections, similar to Pretendard or Noto Sans KR. Vary only weight and size for hierarchy; do not mix handwritten, serif, decorative, or unrelated font families.",
      `On-image headline: ${onImageCopy.headline}.`,
      onImageCopy.subheadline ? `On-image subheadline: ${onImageCopy.subheadline}.` : "",
      onImageCopy.bullets.length
        ? visualRole === "review"
          ? `On-image review snippets, use as large testimonial cards with stars and masked user IDs: ${onImageCopy.bullets.join(" / ")}.`
          : visualRole === "concernList"
            ? `On-image chat bubbles, use 4-5 short concern bubbles if space allows: ${onImageCopy.bullets.join(" / ")}.`
            : visualRole === "disclosure"
              ? `On-image product detail cards, maximum 2 large cards: ${onImageCopy.bullets.join(" / ")}.`
          : `On-image support points, maximum 2 large chips or cards: ${onImageCopy.bullets.join(" / ")}.`
        : "",
      onImageCopy.trustLine ? `Trust line, only if it fits as a short non-clickable note: ${onImageCopy.trustLine}.` : "",
      "Use modern Korean ecommerce typography hierarchy, generous spacing, clear visual grouping, and avoid tiny body text.",
      "Preserve product packaging labels, logos, and printed product text that exist on the reference product.",
      visualRole === "review"
        ? "Do not invent verified review counts, 100% real review claims, influencer names, exact ratings, medical/beauty results, or dramatic before-after effects. Mask user IDs and keep testimonial wording grounded in the provided section copy and visible product use context."
        : visualRole === "disclosure"
          ? "Do not invent exact size, count, capacity, material name, certification, effect, or caution text. If a fact is not readable in the reference image or section copy, use broad inspectable labels instead, such as 패치 형태, 패키지 구성, 제품 형태, or 사용 전 확인."
          : visualRole === "concernList"
            ? "Do not present these chat bubbles as verified customer quotes or reviews. They are pre-purchase concerns only; avoid star ratings, user IDs, review counts, medical/beauty result claims, and ungrounded efficacy or side-effect conclusions."
        : "Do not invent a brand name, logo, certification, review, result number, or effect that is not grounded in the reference image or section copy."
    ].filter(Boolean).join(" ");
  } else {
    enhancedPrompt +=
      "IMPORTANT: Do NOT add new advertising copy, headlines, captions, watermarks, or decorative typography in the generated image. Preserve product packaging labels, logos, and printed product text that already exist on the reference product. Compose the photo like the background layer for a premium editable detail-page template: leave a deliberate copy zone, use clean negative space, avoid busy textures behind future text, and position the product/model so overlay cards can feel integrated rather than pasted on top.";
  }

  return enhancedPrompt;
}

function buildMobileReadabilityPrompt(role: PdpSectionVisualRole) {
  if (role === "review") {
    return [
      "Mobile readability is mandatory: judge the final 1080px-wide image as if it will be viewed at about 390px phone width.",
      "For a review section, use one bold headline plus either one large quote card or 3-4 roomy review cards.",
      "Each review card may include five star icons, an anonymized user ID such as min****, and one short Korean testimonial sentence.",
      "Review card text must be large and readable on mobile; do not shrink reviews into tiny app screenshots, dense comments, or paragraph blocks.",
      "Minimum visual type scale: headline around 72-96px on a 1080px canvas; review card text at least 34-44px; user IDs and star rows must remain readable.",
      "No visible text may be truncated, clipped, or end with ellipses. Remove extra review cards before shrinking or cutting text.",
      "Do not include CTA buttons, arrow buttons, link labels, or fake clickable controls in the section image.",
      "Use high contrast, generous card padding, clear dividers, and one clean Korean sans-serif family similar to Pretendard or Noto Sans KR.",
      "Do not claim 100% real reviews, verified review counts, exact ratings, influencer endorsements, or dramatic result numbers unless those facts are provided in the section copy."
    ].join(" ");
  }

  const informationHeavyRole =
    role === "detail" ||
    role === "composition" ||
    role === "disclosure" ||
    role === "proof" ||
    role === "concernList" ||
    role === "compare" ||
    role === "plan";
  if (role === "concernList") {
    return [
      "Mobile readability is mandatory: judge the final 1080px-wide image as if it will be viewed at about 390px phone width.",
      "Use one large Korean headline and 4-5 short chat bubbles only; each bubble should be a brief customer concern, not a paragraph.",
      "Bubble text must be large enough to read on mobile, roughly 38-52px on a 1080px canvas, with strong black-on-white contrast.",
      "No bubble text may be truncated, clipped, or end with ellipses. Use fewer bubbles instead of cutting text.",
      "Keep the bubble count readable by using roomy spacing, alternating left/right placement, and no tiny captions, footnotes, dense tables, or extra labels.",
      "Do not include CTA buttons, arrow buttons, link labels, or fake clickable controls in the section image.",
      "Use one clean modern Korean sans-serif family across all text, similar to Pretendard or Noto Sans KR."
    ].join(" ");
  }
  if (role === "disclosure") {
    return [
      "Mobile readability is mandatory: judge the final 1080px-wide image as if it will be viewed at about 390px phone width.",
      "For a product-information section, show one large product/package visual plus at most two roomy detail cards.",
      "Each detail card should use one large Korean label and one short phrase only; avoid dense specifications, tiny caution text, FAQ paragraphs, or table-like microtext.",
      "Use inspectable, product-specific labels from the reference, such as patch shape, package configuration, included items, texture, use area, or visible packaging cues.",
      "No text may be truncated, clipped, or end with ellipses. If specific details will not fit, use fewer cards instead of shrinking text.",
      "Do not include CTA buttons, arrow buttons, link labels, or fake clickable controls in the section image."
    ].join(" ");
  }
  const roleNote = informationHeavyRole
    ? "For detail, proof, review, composition, comparison, plan, or disclosure sections, convert dense information into one large label plus one short phrase per card; never use paragraph-style specifications or table-like microtext."
    : "For lifestyle or hero sections, prioritize one bold message and enough quiet space around it instead of adding extra explanatory labels.";

  return [
    "Mobile readability is mandatory: judge the final 1080px-wide image as if it will be viewed at about 390px phone width.",
    "Every intentional Korean text element must remain readable without zoom. Use high contrast, short line lengths, and large type.",
    "Use at most three visible text groups total: a headline, an optional one-line subheadline, and at most two large support chips/cards.",
    "Minimum visual type scale: headline around 72-96px on a 1080px canvas; subheadline and support text at least 34-44px; never create intentional fine print below roughly 30px.",
    "Keep Korean font styling consistent: one clean sans-serif family, consistent letter shapes, and no mixed font families between headline, subheadline, and support chips.",
    "If extra copy will not fit at that size, omit it rather than shrinking it. No text may be truncated, clipped, or end with ellipses.",
    "Do not include CTA buttons, arrow buttons, link labels, or fake clickable controls in the section image.",
    "Avoid footnotes, dense bullet lists, long paragraphs, small captions, tiny icon labels, and compact comparison tables.",
    roleNote
  ].join(" ");
}

function buildSectionRoleSceneInstructions(role: PdpSectionVisualRole, options?: InternalImageGenOptions) {
  const editableCopyZone =
    options?.outputMode === "editable"
      ? "This is editable text mode: leave a clean, intentional copy zone for later text layers and keep faces, eyes, hands, and product labels outside that future copy zone. "
      : "";
  const referenceModelNote =
    options?.withModel && options.referenceModelImageBase64
      ? "When a person appears, preserve the uploaded model identity, but vary pose, crop, camera distance, and scene purpose instead of repeating the same smiling product-hold portrait. "
      : "";

  const roleInstructions: Record<PdpSectionVisualRole, string> = {
    hero:
      "Hero art direction: create the strongest first impression with product and person both readable, face unobstructed, product packaging clear, and a premium landing-page opening composition. Reserve a top-left or lower-left copy area if editable mode is used. ",
    question:
      "Question art direction: show a real pre-purchase hesitation moment, not a product pose. Use environmental context, an off-center subject, and visible negative space for copy. ",
    concernList:
      "Concern-list art direction: create a finished ecommerce section graphic, not a lifestyle photograph. Use a deep black background, one large centered Korean headline, and 4-5 white chat bubbles alternating left and right like a customer conversation. The bubbles should list pre-purchase concerns in short Korean phrases. Keep typography bold, high-contrast, and mobile-readable; product can appear only as a small supporting anchor or be omitted. ",
    problem:
      "Problem art direction: show the customer's discomfort or busy moment through lifestyle context, hands, posture, or surrounding objects. Avoid a centered beauty portrait; keep the model face away from the planned text card area. ",
    bridge:
      "Bridge art direction: transition from problem to solution with a deliberate product-reveal scene. Use diagonal composition, product in the foreground, and a clean side copy zone. ",
    guide:
      "Guide art direction: present the product as the helper or solution. Place the product and model interaction on the right or lower third, leaving the opposite side calm for an editorial information panel. ",
    value:
      "Value art direction: make one benefit visually obvious with product prominence, controlled props, and a clear text-safe area. Do not default to a centered model holding the product. ",
    plan:
      "Plan art direction: show routine or steps through hands-in-frame, tabletop sequencing, before-going-out preparation, or small repeated objects. Prefer action detail over face-forward portrait. ",
    proof:
      "Proof art direction: product-first evidence shot. Use packaging, texture, included items, or visible details; avoid model face unless absolutely necessary, and keep labels readable. ",
    compare:
      "Compare art direction: build a structured comparison-ready scene with two zones, product alternatives, or clear left/right composition. Avoid glamour portrait framing. ",
    detail:
      "Detail art direction: use close-up product detail, texture, material, patch shape, package label, or usage detail. No face-led portrait; the product detail must be the hero. ",
    lifestyle:
      "Lifestyle art direction: show the product naturally fitting into a believable daily scene. Use wider context or candid movement, not another studio product-hold shot. ",
    success:
      "Success art direction: show the after-purchase relief or changed day through an optimistic lifestyle scene, open framing, and a visible product connection. ",
    review:
      "Review art direction: build a direct customer testimonial section. Prioritize large review cards, star ratings, masked user IDs, quotation marks, and short first-person comments. You may include a product/use photo or UGC-style social post card, but the main visual hierarchy must be the customer review content, not a generic lifestyle model pose or product benefit chips. ",
    composition:
      "Composition art direction: create a clean set or flat-lay of the package, included items, sizes, and options. People are unnecessary; prioritize product clarity and structured spacing. ",
    disclosure:
      "Disclosure art direction: create a finished product-information section. Use the actual product package, included items, product shape, texture, label, or use-area closeups from the reference, then add two large detail cards with product-specific information. Avoid faces, generic warning icons, empty FAQ blocks, and placeholder notice graphics. ",
    cta:
      "Purchase-reason art direction: finish with a confident product-and-lifestyle scene where the face and product stay visible beside a short reason-to-buy message. Do not create a button, arrow, or fake clickable call-to-action zone. ",
    failure:
      "Failure art direction: show the cost of waiting or repeating inconvenience through mood, environment, and action detail. Avoid fear-mongering and avoid a centered smiling model portrait. ",
    generic:
      "Generic section art direction: vary the shot type based on the message; choose product detail, routine, lifestyle context, or structured information rather than repeating a model portrait. "
  };

  return ` Section Art Direction: ${roleInstructions[role]}${editableCopyZone}${referenceModelNote}`;
}

function buildImageStyleInstructions(options?: InternalImageGenOptions, role?: PdpSectionVisualRole) {
  if (!options) {
    return "";
  }

  let instructions = "";

  if (options.style === "studio") {
    instructions +=
      "- Setting: Professional studio lighting, seamless paper or premium studio set, controlled backdrop, and no lived-in domestic context unless explicitly required.\n";
    instructions +=
      "- Composition: Avoid a default chest-up portrait. Prefer a mix of product-centric wide frames, half-body frames, seated or standing full-figure compositions, tabletop layouts, hand interactions, and close detail inserts depending on the section goal.\n";
    instructions +=
      "- Art Direction: Crisp controlled light, subtle shadows, refined color balance, and a clearly designed studio set that feels intentional rather than empty.\n";
    instructions += "- Scene Guardrail: If any lifestyle or outdoor guidance conflicts, keep the result unmistakably studio-led.\n";
  } else if (options.style === "lifestyle") {
    instructions +=
      "- Setting: Authentic, aspirational lifestyle environment with natural lighting, lived-in textures, and everyday context that feels believable.\n";
    instructions +=
      "- Composition: Use candid moments, on-location interaction, room context, hands using the product, and gentle movement. Vary distance between environmental wide shots, medium shots, and close usage details.\n";
    instructions +=
      "- Art Direction: Warm, human, relatable, and editorial, with enough context to explain why the product fits into daily life.\n";
    instructions += "- Scene Guardrail: Do not collapse the result into a blank studio set unless guide priority explicitly demands it.\n";
  } else if (options.style === "outdoor") {
    instructions +=
      "- Setting: Beautiful outdoor environment with cinematic natural lighting, location depth, airiness, and scene-based storytelling.\n";
    instructions +=
      "- Composition: Use wide scenic frames, dynamic movement, environmental close-ups, and product-in-use storytelling that feels active and open.\n";
    instructions +=
      "- Art Direction: Fresh, expansive, airy, and energetic, with the location helping explain the product mood or usage context.\n";
    instructions += "- Scene Guardrail: Keep the result clearly outdoors, not a studio imitation or an indoor lifestyle room.\n";
  }

  if (options.withModel) {
    if (options.referenceModelImageBase64) {
      instructions += "- Subject: MUST feature the exact same person shown in the attached reference model image.\n";
      instructions += "- Identity Lock: Preserve the face, hairstyle, skin tone, gender presentation, and overall appearance of that same person while adapting pose, styling, and composition to the scene.\n";
      instructions += "- Casting Rule: Never swap to another person. Never reinterpret the reference as a different male or female model.\n";
      if (options.referenceModelProfile) {
        instructions += `- Stable Traits: ${options.referenceModelProfile.keepTraits.join(", ")}.\n`;
        instructions += `- Flexible Traits: ${options.referenceModelProfile.flexibleTraits.join(", ")}.\n`;
      }
    } else {
      const modelDescriptor = buildModelDescriptor(options);
      instructions += `- Subject: MUST feature an attractive, professional model (${modelDescriptor}) posing with and interacting naturally with the product.\n`;
    }
  } else if (role === "review") {
    instructions += "- Subject: People are optional only as cropped hands, body parts, product-use moments, or UGC-style photo content inside the review layout. Do not make a generic model portrait the main subject.\n";
  } else {
    instructions += "- Subject: Do NOT include any people or models. Focus entirely on the product and background.\n";
  }

  return instructions;
}

function buildImagePreferenceInstructions(section: SectionBlueprint, options?: InternalImageGenOptions) {
  if (!options) {
    return "";
  }

  const visualRole = inferPdpSectionVisualRole(section);
  const parts: string[] = [];

  if (options.style === "studio") {
    parts.push("Use a polished studio set with controlled light and flexible framing, not a fixed upper-body portrait.");
  } else if (options.style === "lifestyle") {
    parts.push("Use an authentic lifestyle setting with natural interaction and believable context.");
  } else if (options.style === "outdoor") {
    parts.push("Use an outdoor environment with scenic depth and active visual storytelling.");
  }

  if (options.withModel && options.referenceModelImageBase64) {
    parts.push("Use the attached reference model as the same person for this scene, with identity locked and no model swap.");
  } else if (options.withModel) {
    const modelDescriptor = buildModelDescriptor(options);
    parts.push(`If appropriate for the scene, feature a model (${modelDescriptor}).`);
  }

  parts.push("Keep the product central to the story and avoid collapsing the scene into a generic portrait.");
  parts.push(`Preserve the product using this guidance: ${section.reference_usage || "keep shape, material, color, and branding accurate."}`);
  if (visualRole === "disclosure") {
    parts.push("For this product-information section, derive the detail cards from the attached reference product only: visible package label, product shape, included items, texture, use area, and packaging cues. Do not turn it into a generic warning, FAQ, or options 안내 graphic.");
  }

  return parts.length ? `Style Preferences: ${parts.join(" ")}` : "";
}

function buildModelDescriptor(options: ImageGenOptions) {
  const nationalityDescriptor = getModelCountryDescriptor(options.modelCountry);
  const ageDescriptor = getModelAgeDescriptor(options.modelAgeRange);
  const genderDescriptor = options.modelGender === "male" ? "man" : "woman";

  return `${nationalityDescriptor} ${genderDescriptor} ${ageDescriptor}`.trim();
}

function getModelCountryDescriptor(country?: ImageGenOptions["modelCountry"]) {
  if (country === "japan") {
    return "Japanese";
  }
  if (country === "usa") {
    return "American";
  }
  if (country === "france") {
    return "French";
  }
  if (country === "germany") {
    return "German";
  }
  if (country === "africa") {
    return "African";
  }

  return "Korean";
}

function getModelAgeDescriptor(ageRange?: ImageGenOptions["modelAgeRange"]) {
  if (ageRange === "teen") {
    return "in the late teens";
  }
  if (ageRange === "30s") {
    return "in the 30s";
  }
  if (ageRange === "40s") {
    return "in the 40s";
  }
  if (ageRange === "50s_plus") {
    return "in the 50s or older";
  }

  return "in the 20s";
}

function parseExpandPayload(
  text: string,
  provider: "gemini" | "openai",
  outputMode: PdpOutputMode
): { narrativeSpine: NarrativeSpine; sections: SectionBlueprint[] } {
  try {
    const parsed = JSON.parse(text) as {
      narrativeSpine?: Partial<NarrativeSpine>;
      sections?: Array<Partial<SectionBlueprint> & { story_beat?: Partial<SectionStoryBeat> }>;
    };
    const isFullImage = outputMode === "full-image";
    const sections = Array.isArray(parsed.sections)
      ? parsed.sections.map((section, index) => {
          const normalized = normalizeSection(section, index);
          const withBeat = section.story_beat
            ? { ...normalized, story_beat: normalizeStoryBeat(section.story_beat) }
            : normalized;
          // Full-image sections render on a flat image with no clickable links, so a real
          // CTA must never reach the canvas — force it empty (mirrors buildOnImageCopy's rule).
          return isFullImage ? { ...withBeat, CTA: "", CTA_en: "" } : withBeat;
        })
      : [];
    if (!sections.length) {
      throw new Error("Expand payload contained no sections.");
    }
    return { narrativeSpine: normalizeNarrativeSpine(parsed.narrativeSpine), sections };
  } catch (error) {
    throw new PdpServiceError(
      provider === "openai" ? "OPENAI_RESPONSE_INVALID" : "GEMINI_RESPONSE_INVALID",
      "AI 확장 응답을 해석하지 못했습니다. 다시 시도해 주세요.",
      stringifyError(error)
    );
  }
}

function normalizeStoryBeat(beat: Partial<SectionStoryBeat>): SectionStoryBeat {
  const reviewAngle = asString(beat?.reviewAngle);
  return {
    beatGoal: asString(beat?.beatGoal),
    connectionToPrev: asString(beat?.connectionToPrev),
    reviewAngle: reviewAngle || undefined
  };
}

function normalizeNarrativeSpine(spine?: Partial<NarrativeSpine>): NarrativeSpine {
  const reviewInsights = spine?.reviewInsights;
  return {
    targetCustomer: asString(spine?.targetCustomer),
    coreStruggle: asString(spine?.coreStruggle),
    transformation: asString(spine?.transformation),
    throughline: asString(spine?.throughline),
    reviewInsights: reviewInsights
      ? {
          topBenefits: normalizePromptList(reviewInsights.topBenefits, 8, 90),
          painPoints: normalizePromptList(reviewInsights.painPoints, 8, 90),
          improvementPromises: normalizePromptList(reviewInsights.improvementPromises, 8, 120)
        }
      : undefined
  };
}

function parseBlueprintResponse(response: { text?: string }) {
  try {
    const parsed = JSON.parse(extractResponseText(response)) as Partial<LandingPageBlueprint>;
    return sanitizeBlueprint(parsed);
  } catch (error) {
    throw new PdpServiceError(
      "GEMINI_RESPONSE_INVALID",
      "AI 응답을 해석하지 못했습니다.",
      stringifyError(error)
    );
  }
}

function parseOpenAiBlueprintResponse(response: OpenAiResponsePayload) {
  try {
    const parsed = JSON.parse(extractJsonCandidate(extractOpenAiResponseText(response)) ?? extractOpenAiResponseText(response)) as Partial<LandingPageBlueprint>;
    return sanitizeBlueprint(parsed);
  } catch (error) {
    throw new PdpServiceError(
      "OPENAI_RESPONSE_INVALID",
      "OpenAI 응답을 해석하지 못했습니다. 같은 이미지로 다시 시도해 주세요.",
      stringifyError(error)
    );
  }
}

function parseCustomerReviewAnalysisResponse(response: OpenAiResponsePayload, source: PdpCustomerReviewSource) {
  try {
    const parsed = JSON.parse(
      extractJsonCandidate(extractOpenAiResponseText(response)) ?? extractOpenAiResponseText(response)
    ) as Partial<PdpCustomerReviewAnalysis>;
    const analysis = normalizeCustomerReviewAnalysisResponse(parsed, source);

    if (!analysis.topBenefits.length || (!analysis.painPoints.length && !analysis.improvementPromises.length)) {
      throw new Error("Customer review analysis did not include enough benefits or pain points.");
    }

    return analysis;
  } catch (error) {
    throw new PdpServiceError(
      "OPENAI_RESPONSE_INVALID",
      "ChatGPT 후기 분석 응답을 해석하지 못했습니다. 같은 파일로 다시 시도해 주세요.",
      stringifyError(error)
    );
  }
}

function normalizeCustomerReviewAnalysisResponse(
  input: Partial<PdpCustomerReviewAnalysis>,
  source: PdpCustomerReviewSource
): PdpCustomerReviewAnalysis {
  const sourceSamples = source.reviews.map((review) => shortenVisibleCopy(review.text, 140)).filter(Boolean);
  const sampleReviews = normalizePromptList(input.sampleReviews, 12, 160);
  const productKind = inferPdpCopyProductKind([
    source.fileName,
    ...source.reviews.map((review) => review.text),
    ...(input.topBenefits ?? []),
    ...(input.keywordSummary ?? [])
  ]);

  return {
    fileName: source.fileName,
    reviewCount: source.reviewCount,
    sampledReviewCount: source.sampledReviewCount ?? source.reviews.length,
    sampleReviews: sampleReviews.length ? sampleReviews : sourceSamples.slice(0, 6),
    topBenefits: normalizePdpReviewBenefitSalesCopyList(input.topBenefits, productKind, 8, 90),
    painPoints: normalizePromptList(input.painPoints, 8, 90),
    improvementPromises: normalizePromptList(input.improvementPromises, 8, 120),
    keywordSummary: normalizePromptList(input.keywordSummary, 12, 40)
  };
}

function sanitizeBlueprint(input: Partial<LandingPageBlueprint>) {
  const sections = Array.isArray(input.sections)
    ? input.sections.map((section, index) => normalizeSection(section, index))
    : [];

  return {
    executiveSummary: asString(input.executiveSummary),
    scorecard: Array.isArray(input.scorecard)
      ? input.scorecard.map((item) => ({
          category: asString(item?.category),
          score: asString(item?.score),
          reason: asString(item?.reason)
        }))
      : [],
    blueprintList: Array.isArray(input.blueprintList)
      ? input.blueprintList.map((item) => asString(item)).filter(Boolean)
      : sections.map((section) => section.section_name),
    sections,
    // Approach A v2 long-detail analysis outputs (optional; undefined for non-long / older inputs)
    extractedSellingPoints: asStringArray(input.extractedSellingPoints),
    currentPageDiagnosis: sanitizeCurrentPageDiagnosis(input.currentPageDiagnosis),
    productCutRegion: sanitizeProductCutRegion(input.productCutRegion),
    multiProductPage: input.multiProductPage === true,
    referenceProductImage: sanitizeReferenceProductImage(input.referenceProductImage)
  } satisfies LandingPageBlueprint;
}

// Shape-only validation; the CLIENT re-validates the index against its own material list
// (kind, image payload, not-a-long-page) before using the pick as a generation reference.
function sanitizeReferenceProductImage(input: unknown): PdpReferenceProductImage | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const materialIndex = Number(value.materialIndex);
  const confidenceRaw = Number(value.confidence);
  if (!Number.isInteger(materialIndex) || materialIndex < 1) {
    return undefined;
  }
  return {
    materialIndex,
    confidence: Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0
  };
}

function normalizeSection(section: Partial<SectionBlueprint>, index: number): SectionBlueprint {
  const normalized = {
    section_id: asString(section.section_id) || `S${index + 1}`,
    section_name: asString(section.section_name) || `섹션 ${index + 1}`,
    goal: asString(section.goal),
    headline: asString(section.headline),
    headline_en: asString(section.headline_en) || asString(section.headline),
    subheadline: asString(section.subheadline),
    subheadline_en: asString(section.subheadline_en) || asString(section.subheadline),
    bullets: Array.isArray(section.bullets) ? section.bullets.map((item) => asString(item)).filter(Boolean) : [],
    bullets_en: Array.isArray(section.bullets_en)
      ? section.bullets_en.map((item) => asString(item)).filter(Boolean)
      : Array.isArray(section.bullets)
        ? section.bullets.map((item) => asString(item)).filter(Boolean)
        : [],
    trust_or_objection_line: asString(section.trust_or_objection_line),
    trust_or_objection_line_en:
      asString(section.trust_or_objection_line_en) || asString(section.trust_or_objection_line),
    CTA: asString(section.CTA),
    CTA_en: asString(section.CTA_en) || asString(section.CTA),
    layout_notes: asString(section.layout_notes),
    compliance_notes: asString(section.compliance_notes),
    image_id: asString(section.image_id) || `IMG_S${index + 1}`,
    purpose: asString(section.purpose),
    prompt_ko: asString(section.prompt_ko),
    prompt_en: asString(section.prompt_en),
    negative_prompt: asString(section.negative_prompt),
    style_guide: asString(section.style_guide),
    reference_usage: asString(section.reference_usage),
    generatedImage: section.generatedImage
  };

  return normalizeVisibleSectionCopyFields(normalized);
}

function normalizeVisibleSectionCopyFields(section: SectionBlueprint): SectionBlueprint {
  const visibleCopy = buildOnImageCopy(section);
  const bullets = section.bullets
    .map((copy) => sanitizeVisibleCopy(copy, section.section_name))
    .filter(Boolean)
    .filter((copy) => normalizeVisibleCopyKey(copy) !== normalizeVisibleCopyKey(visibleCopy.headline))
    .filter((copy) => normalizeVisibleCopyKey(copy) !== normalizeVisibleCopyKey(visibleCopy.subheadline));

  return {
    ...section,
    headline: visibleCopy.headline,
    headline_en: sanitizeVisibleCopy(section.headline_en, section.section_name) || visibleCopy.headline,
    subheadline: visibleCopy.subheadline,
    subheadline_en: sanitizeVisibleCopy(section.subheadline_en, section.section_name) || visibleCopy.subheadline,
    bullets,
    bullets_en: section.bullets_en
      .map((copy) => sanitizeVisibleCopy(copy, section.section_name))
      .filter(Boolean)
  };
}

function normalizeImageOptions(options?: Partial<InternalImageGenOptions>): InternalImageGenOptions {
  return {
    style: options?.style ?? "studio",
    withModel: options?.withModel ?? false,
    aiProvider: normalizeAiProvider(options?.aiProvider),
    outputMode: normalizeOutputMode(options?.outputMode),
    modelGender: options?.modelGender ?? "female",
    modelAgeRange: options?.modelAgeRange ?? "20s",
    modelCountry: options?.modelCountry ?? "korea",
    guidePriorityMode: options?.guidePriorityMode ?? "guide-first",
    headline: options?.headline,
    subheadline: options?.subheadline,
    isRegeneration: options?.isRegeneration,
    referenceModelImageBase64: options?.referenceModelImageBase64,
    referenceModelImageMimeType: options?.referenceModelImageMimeType,
    referenceModelImageFileName: options?.referenceModelImageFileName,
    referenceModelProfile: options?.referenceModelProfile ?? null,
    retryDirective: options?.retryDirective,
    imageModel: options?.imageModel
  };
}

function buildReferenceModelProfilePrompt(profile: ReferenceModelProfile) {
  const stableTraits = uniqueStrings(profile.keepTraits).join(", ");
  const flexibleTraits = uniqueStrings(profile.flexibleTraits).join(", ");
  const distinctiveFeatures = uniqueStrings(profile.distinctiveFeatures).join(", ");

  return [
    "Reference identity profile:",
    `gender presentation ${profile.genderPresentation};`,
    `age impression ${profile.ageImpression};`,
    `face shape ${profile.faceShape};`,
    `hairstyle ${profile.hairstyle};`,
    `skin tone ${profile.skinTone};`,
    `eye details ${profile.eyeDetails};`,
    `brow details ${profile.browDetails};`,
    `lip details ${profile.lipDetails};`,
    `overall vibe ${profile.overallVibe}.`,
    stableTraits ? `Keep fixed: ${stableTraits}.` : "",
    distinctiveFeatures ? `Identifying markers: ${distinctiveFeatures}.` : "",
    flexibleTraits ? `May vary: ${flexibleTraits}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function buildGuidePriorityInstructions(section: SectionBlueprint, options?: InternalImageGenOptions) {
  const mode = options?.guidePriorityMode ?? "guide-first";

  if (mode === "guide-first") {
    return [
      "Design Guide Priority: ON.",
      `Image Purpose: ${section.purpose}.`,
      section.layout_notes ? `Layout Notes: ${section.layout_notes}.` : "",
      section.style_guide ? `Style Guide: ${section.style_guide}.` : "",
      "If the selected shot type and guide conflict, respect the guide first and use the shot type as a supporting constraint."
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "Design Guide Priority: OFF.",
    `Image Purpose: ${section.purpose}.`,
    "Ignore Layout Notes and Style Guide whenever they conflict with the selected shot type.",
    "Use the selected shot type as the main scene-defining instruction."
  ].join(" ");
}

function getBaseSceneDirection(section: SectionBlueprint, mode: PdpGuidePriorityMode) {
  if (mode === "guide-first") {
    return [section.prompt_en, section.layout_notes, section.style_guide, section.reference_usage]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `Communicate this purpose clearly: ${section.purpose}.`,
    "Build a fresh scene from the selected shot type.",
    "Do not inherit conflicting layout or style-guide assumptions from the section metadata."
  ].join(" ");
}

function buildValidationPrompt(profile: ReferenceModelProfile, expectedStyle: NonNullable<ImageGenOptions["style"]>) {
  return `
You will compare two images.
- image 1: the uploaded reference person image
- image 2: the newly generated candidate image

Judge whether image 2 preserves the same identifiable person from image 1 while allowing new pose, styling, framing, and environment.

Reference person profile:
- gender presentation: ${profile.genderPresentation}
- age impression: ${profile.ageImpression}
- face shape: ${profile.faceShape}
- hairstyle: ${profile.hairstyle}
- skin tone: ${profile.skinTone}
- eye details: ${profile.eyeDetails}
- brow details: ${profile.browDetails}
- lip details: ${profile.lipDetails}
- overall vibe: ${profile.overallVibe}
- keep traits: ${profile.keepTraits.join(", ")}
- distinctive features: ${profile.distinctiveFeatures.join(", ")}

Expected shot type: ${getStyleLabel(expectedStyle)}.

Return JSON only with:
- isSamePerson: boolean
- genderPresentationPreserved: boolean
- styleMatch: boolean
- confidence: high | medium | low
- reason: short explanation
- correctionFocus: array of short phrases explaining what must be corrected
`.trim();
}

function buildRetryDirective(
  validation: GeneratedImageValidation,
  profile: ReferenceModelProfile,
  expectedStyle: NonNullable<ImageGenOptions["style"]>
) {
  return [
    `The previous attempt did not pass identity/style validation: ${validation.reason}.`,
    `Keep the same person using these fixed traits: ${uniqueStrings(profile.keepTraits).join(", ")}.`,
    `Preserve these identifying markers: ${uniqueStrings(profile.distinctiveFeatures).join(", ")}.`,
    validation.correctionFocus.length ? `Correct these issues: ${validation.correctionFocus.join(", ")}.` : "",
    `The retried image must clearly read as a ${getStyleLabel(expectedStyle)} scene.`
  ]
    .filter(Boolean)
    .join(" ");
}

function parseReferenceModelProfileResponse(response: { text?: string }) {
  try {
    const parsed = JSON.parse(extractResponseText(response)) as Partial<ReferenceModelProfile>;

    return {
      genderPresentation: asString(parsed.genderPresentation) || "same as reference image",
      ageImpression: asString(parsed.ageImpression) || "same age impression as reference image",
      faceShape: asString(parsed.faceShape) || "same face shape as reference image",
      hairstyle: asString(parsed.hairstyle) || "same hairstyle impression as reference image",
      skinTone: asString(parsed.skinTone) || "same skin tone as reference image",
      eyeDetails: asString(parsed.eyeDetails) || "same eye shape and gaze impression",
      browDetails: asString(parsed.browDetails) || "same brow shape and thickness",
      lipDetails: asString(parsed.lipDetails) || "same lip shape and expression impression",
      overallVibe: asString(parsed.overallVibe) || "same overall vibe as the reference person",
      distinctiveFeatures: asStringArray(parsed.distinctiveFeatures),
      keepTraits: asStringArray(parsed.keepTraits),
      flexibleTraits: asStringArray(parsed.flexibleTraits)
    } satisfies ReferenceModelProfile;
  } catch (error) {
    throw new PdpServiceError(
      "GEMINI_RESPONSE_INVALID",
      "참조 모델 이미지를 해석하지 못했습니다.",
      stringifyError(error)
    );
  }
}

function parseGeneratedImageValidationResponse(response: { text?: string }) {
  try {
    const parsed = JSON.parse(extractResponseText(response)) as Partial<GeneratedImageValidation>;

    return {
      isSamePerson: Boolean(parsed.isSamePerson),
      genderPresentationPreserved: Boolean(parsed.genderPresentationPreserved),
      styleMatch: Boolean(parsed.styleMatch),
      confidence: parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low",
      reason: asString(parsed.reason) || "identity validation failed",
      correctionFocus: asStringArray(parsed.correctionFocus)
    } satisfies GeneratedImageValidation;
  } catch (error) {
    throw new PdpServiceError(
      "GEMINI_RESPONSE_INVALID",
      "생성된 이미지 검증 응답을 해석하지 못했습니다.",
      stringifyError(error)
    );
  }
}

function extractResponseText(response: { text?: string }) {
  if (!response.text) {
    throw new PdpServiceError(
      "GEMINI_RESPONSE_INVALID",
      "AI 응답이 비어 있습니다.",
      "Gemini did not return response.text."
    );
  }

  let text = response.text.trim();
  if (text.startsWith("```json")) {
    text = text.slice(7);
  } else if (text.startsWith("```")) {
    text = text.slice(3);
  }
  if (text.endsWith("```")) {
    text = text.slice(0, -3);
  }

  const normalized = text.trim().replace(/^\uFEFF/, "");
  const extractedJson = extractJsonCandidate(normalized);
  return extractedJson ?? normalized;
}

function extractJsonCandidate(input: string) {
  if (!input) {
    return null;
  }

  const objectStart = input.indexOf("{");
  const arrayStart = input.indexOf("[");
  const startIndexCandidates = [objectStart, arrayStart].filter((value) => value >= 0);

  if (!startIndexCandidates.length) {
    return null;
  }

  const startIndex = Math.min(...startIndexCandidates);

  for (let endIndex = input.length; endIndex > startIndex; endIndex -= 1) {
    const candidate = input.slice(startIndex, endIndex).trim();

    if (!candidate) {
      continue;
    }

    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function buildHighResolutionInlinePart(mimeType: string, data: string) {
  return {
    inlineData: {
      mimeType,
      data
    },
    mediaResolution: {
      level: "media_resolution_high"
    }
  } as any;
}

function getStyleLabel(style: NonNullable<ImageGenOptions["style"]>) {
  if (style === "lifestyle") {
    return "lifestyle shot";
  }
  if (style === "outdoor") {
    return "outdoor shot";
  }

  return "studio shot";
}

function normalizeReferenceModelImage(base64?: string, mimeType?: string) {
  if (!base64?.trim()) {
    return null;
  }

  if (!mimeType?.trim()) {
    throw new PdpServiceError(
      "INVALID_IMAGE_PAYLOAD",
      "모델 이미지 형식이 올바르지 않습니다.",
      "Reference model image is missing mime type."
    );
  }

  return {
    base64: sanitizeBase64Payload(base64),
    mimeType: normalizeMimeType(mimeType)
  };
}

function extractGeneratedImage(response: {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
}) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    if (part.inlineData?.data && part.inlineData.mimeType) {
      return {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType
      };
    }
  }

  return null;
}

async function retryOperation<T>(operation: () => Promise<T>, retries = 2, delay = 1500): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      retries > 0 &&
      !isGeminiFreeTierBlockedError(message) &&
      (isQuotaError(message) || isJsonError(message))
    ) {
      await wait(delay);
      return retryOperation(operation, retries - 1, delay * 2);
    }

    if (error instanceof PdpServiceError) {
      throw error;
    }

    if (isQuotaError(message)) {
      throw new PdpServiceError(
        "GEMINI_QUOTA_EXCEEDED",
        isGeminiFreeTierBlockedError(message)
          ? GEMINI_FREE_TIER_BLOCKED_MESSAGE
          : "AI 사용량이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
        message
      );
    }

    if (isJsonError(message)) {
      throw new PdpServiceError(
        "GEMINI_RESPONSE_INVALID",
        "AI 응답을 해석하지 못했습니다.",
        message
      );
    }

    throw error;
  }
}

function isQuotaError(message: string) {
  const lowered = message.toLowerCase();
  return lowered.includes("429") || lowered.includes("quota") || lowered.includes("resource_exhausted");
}

// Google returns 429 with `free_tier` metrics and `limit: 0` when the key has no paid tier
// for the requested model — retrying never helps; the user must enable billing.
const GEMINI_FREE_TIER_BLOCKED_MESSAGE =
  "사용 중인 Gemini API 키가 무료 등급(free tier)이라 이미지 생성 모델을 사용할 수 없습니다. Google AI Studio(aistudio.google.com)의 결제 설정(Billing)에서 유료 등급으로 전환한 뒤 다시 시도해 주세요.";

function isGeminiFreeTierBlockedError(message: string) {
  const lowered = message.toLowerCase();
  return lowered.includes("free_tier") && lowered.includes("limit: 0");
}

function isInvalidApiKeyError(message: string) {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("api key not valid") ||
    lowered.includes("invalid api key") ||
    lowered.includes("api_key_invalid") ||
    lowered.includes("authentication credentials were not provided")
  );
}

function isOpenAiInvalidApiKeyError(message: string) {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("invalid api key") ||
    lowered.includes("incorrect api key") ||
    lowered.includes("api_key_invalid") ||
    lowered.includes("invalid_api_key") ||
    lowered.includes("unauthorized")
  );
}

function isPermissionError(message: string) {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("permission denied") ||
    lowered.includes("does not have permission") ||
    lowered.includes("forbidden") ||
    lowered.includes("model access") ||
    lowered.includes("not found for api version")
  );
}

function isJsonError(message: string) {
  return message.includes("JSON") || message.includes("Unexpected token") || message.includes("Unterminated string");
}

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAiProvider(provider?: PdpAiProvider | string | null): PdpAiProvider {
  return provider === "openai" ? "openai" : "gemini";
}

function normalizeSourceMode(mode?: PdpSourceMode | string | null): PdpSourceMode {
  if (mode === "product" || mode === "redesign") {
    return mode;
  }

  return "auto";
}

function normalizeOutputMode(mode?: PdpOutputMode | string | null): PdpOutputMode {
  return mode === "full-image" ? "full-image" : "editable";
}

function normalizeSectionCount(sectionCount?: number) {
  const allowedCounts = [1, 4, 5, 6, 8, 10];
  return allowedCounts.includes(Number(sectionCount)) ? Number(sectionCount) : 1;
}

function normalizeBenefitInputs(benefits?: string[]) {
  return Array.isArray(benefits)
    ? uniqueStrings(benefits.map((benefit) => benefit.trim()).filter(Boolean)).slice(0, 10)
    : [];
}

function normalizeCustomerReviewSource(source: PdpAnalyzeCustomerReviewsRequest["source"]): PdpCustomerReviewSource {
  if (!source || typeof source !== "object") {
    throw new PdpServiceError(
      "INVALID_REQUEST",
      "후기 분석에 필요한 파일 데이터가 없습니다.",
      "Missing customer review source."
    );
  }

  const seen = new Set<string>();
  const reviews: PdpCustomerReviewInput[] = [];

  (Array.isArray(source.reviews) ? source.reviews : []).forEach((review) => {
    const text = asString(review?.text).replace(/\s+/g, " ").slice(0, 420);
    const key = text.toLowerCase();

    if (text.length < 4 || seen.has(key)) {
      return;
    }

    seen.add(key);
    reviews.push({
      text,
      rating: typeof review?.rating === "number" && Number.isFinite(review.rating) ? review.rating : undefined
    });
  });

  const sampledReviews = reviews.slice(0, MAX_CUSTOMER_REVIEW_ANALYSIS_ROWS);

  return {
    fileName: asString(source.fileName).slice(0, 120) || "고객 후기 파일",
    reviewCount: Math.max(Number(source.reviewCount) || reviews.length, reviews.length),
    sampledReviewCount: Math.min(
      Math.max(Number(source.sampledReviewCount) || sampledReviews.length, sampledReviews.length),
      sampledReviews.length
    ),
    reviews: sampledReviews
  };
}

function buildCustomerReviewAnalysisPrompt(
  source: PdpCustomerReviewSource,
  productContext?: string,
  desiredTone?: string
) {
  const rowsForPrompt = source.reviews
    .slice(0, MAX_CUSTOMER_REVIEW_ANALYSIS_ROWS)
    .map((review, index) => {
      const rating = typeof review.rating === "number" ? ` / rating: ${review.rating}` : "";
      return `${index + 1}. ${review.text}${rating}`;
    })
    .join("\n");

  return `
Analyze the uploaded customer review data for a Korean ecommerce PDP.

Outcome:
- Identify the benefits customers most need and phrase them so the PDP can emphasize them more strongly.
- Identify repeated drawbacks, hesitations, or complaints and convert them into truthful improvement or pre-purchase guidance messages.
- If the review rows are mostly positive, infer buyer-facing pre-purchase concerns by reversing those positives, without inventing product defects. Example: strong cushioning means buyers may have worried about landing impact; snug fit means buyers may have worried about sock slipping.
- Select sample review quotes only from the provided rows. Do not invent reviews, review counts, star averages, user names, dates, or verified-review claims.
- The later PDP sections named 고객 고민 리스팅 and 고객 후기 will use your output directly, so write concise Korean phrases that can be placed on design cards.

Context:
- fileName: ${source.fileName}
- parsedReviewCount: ${source.reviewCount}
- rowsProvidedToModel: ${source.reviews.length}
- productContext: ${asString(productContext).slice(0, 900) || "not provided"}
- desiredTone: ${asString(desiredTone).slice(0, 120) || "AI automatic recommendation"}

Return JSON:
- fileName: same source file name
- reviewCount: parsedReviewCount
- sampleReviews: 6-12 short real review quotes from the provided rows
- topBenefits: 4-8 customer-valued strengths
- painPoints: 3-8 repeated drawbacks, hesitations, or usage frictions
- improvementPromises: 3-8 truthful PDP messages that reduce those drawbacks without pretending the product has changed
- keywordSummary: 6-12 repeated short keywords

Provided review rows:
${rowsForPrompt}
`.trim();
}

async function openAiJsonRequest<T>(apiKey: string, path: string, options: OpenAiRequestOptions): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${OPENAI_BASE_URL}${path}`, {
      method: options.method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw createOpenAiTransportError(error);
  }

  const text = await response.text();
  const payload = parseMaybeJson(text);

  if (!response.ok) {
    throw createOpenAiApiError(response.status, payload, text);
  }

  return payload as T;
}

async function openAiImageEditRequest(
  apiKey: string,
  input: {
    model: string;
    prompt: string;
    aspectRatio: AspectRatio;
    originalImage: {
      base64: string;
      mimeType: string;
      fileName: string;
    };
    referenceModelImage?: {
      base64: string;
      mimeType: string;
      fileName: string;
    } | null;
  }
) {
  const formData = new FormData();
  formData.append("model", input.model);
  formData.append("prompt", input.prompt);
  formData.append("size", getOpenAiImageSize(input.aspectRatio));
  formData.append("quality", "medium");
  formData.append("output_format", "jpeg");
  formData.append("output_compression", "92");
  formData.append(
    "image[]",
    base64ToBlob(input.originalImage.base64, input.originalImage.mimeType),
    input.originalImage.fileName
  );

  if (input.referenceModelImage) {
    formData.append(
      "image[]",
      base64ToBlob(input.referenceModelImage.base64, input.referenceModelImage.mimeType),
      input.referenceModelImage.fileName
    );
  }

  let response: Response;

  try {
    response = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });
  } catch (error) {
    throw createOpenAiTransportError(error);
  }
  const text = await response.text();
  const payload = parseMaybeJson(text) as {
    data?: Array<{
      b64_json?: string;
      mime_type?: string;
    }>;
  };

  if (!response.ok) {
    throw createOpenAiApiError(response.status, payload, text);
  }

  const base64 = payload.data?.[0]?.b64_json;
  if (!base64) {
    throw new PdpServiceError(
      "PDP_IMAGE_GENERATION_FAILED",
      "OpenAI 이미지 응답이 비어 있습니다.",
      text
    );
  }

  return {
    base64,
    mimeType: payload.data?.[0]?.mime_type || "image/jpeg"
  };
}

function base64ToBlob(base64: string, mimeType: string) {
  const buffer = Buffer.from(sanitizeBase64Payload(base64), "base64");
  const bytes = new Uint8Array(buffer);
  return new Blob([bytes], { type: mimeType });
}

function getOpenAiImageSize(aspectRatio: AspectRatio) {
  if (aspectRatio === "16:9" || aspectRatio === "4:3") {
    return "1536x1024";
  }
  if (aspectRatio === "3:4" || aspectRatio === "9:16") {
    return "1024x1536";
  }

  return "1024x1024";
}

function extractOpenAiResponseText(response: OpenAiResponsePayload) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const text = response.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .trim();

  if (!text) {
    throw new PdpServiceError(
      "OPENAI_RESPONSE_INVALID",
      "OpenAI 응답이 비어 있습니다.",
      "OpenAI response did not include output_text."
    );
  }

  return text;
}

function getCachedModelAccess(
  provider: PdpAiProvider,
  apiKey: string,
  model: string,
  loader: () => Promise<ModelAccessCheck>
) {
  const cacheKey = `${provider}:${model}:${hashForCache(apiKey)}`;
  return getCachedPromise(
    modelAccessCache,
    cacheKey,
    MODEL_ACCESS_CACHE_TTL_MS,
    loader,
    MAX_MODEL_ACCESS_CACHE_ENTRIES,
    (access) => access.accessible
  );
}

function getCachedReferenceModelProfile(
  provider: PdpAiProvider,
  referenceModelImage: NormalizedReferenceModelImage,
  loader: () => Promise<ReferenceModelProfile>
) {
  const cacheKey = [
    provider,
    referenceModelImage.mimeType,
    referenceModelImage.base64.length,
    hashForCache(referenceModelImage.base64)
  ].join(":");

  return getCachedPromise(
    referenceModelProfileCache,
    cacheKey,
    REFERENCE_MODEL_PROFILE_CACHE_TTL_MS,
    loader,
    MAX_REFERENCE_MODEL_PROFILE_CACHE_ENTRIES
  );
}

function getCachedPromise<T>(
  cache: Map<string, PromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  maxEntries: number,
  shouldCacheResult: (result: T) => boolean = () => true
) {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  if (cached) {
    cache.delete(key);
  }

  const entry: PromiseCacheEntry<T> = {
    expiresAt: now + ttlMs,
    promise: Promise.resolve()
      .then(loader)
      .then(
        (result) => {
          if (!shouldCacheResult(result) && cache.get(key) === entry) {
            cache.delete(key);
          }
          return result;
        },
        (error) => {
          if (cache.get(key) === entry) {
            cache.delete(key);
          }
          throw error;
        }
      )
  };

  cache.set(key, entry);
  prunePromiseCache(cache, maxEntries);
  return entry.promise;
}

function prunePromiseCache<T>(cache: Map<string, PromiseCacheEntry<T>>, maxEntries: number) {
  const now = Date.now();

  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function hashForCache(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

async function checkModelAccess(apiKey: string, model: string): Promise<ModelAccessCheck> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json"
    }
  });

  if (response.ok) {
    return {
      accessible: true,
      status: response.status
    };
  }

  const detail = extractGoogleApiErrorMessage(await response.text());
  return {
    accessible: false,
    status: response.status,
    detail
  };
}

async function checkOpenAiModelAccess(apiKey: string, model: string): Promise<ModelAccessCheck> {
  let response: Response;

  try {
    response = await fetch(`${OPENAI_BASE_URL}/models/${encodeURIComponent(model)}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
  } catch (error) {
    return {
      accessible: false,
      status: 0,
      detail: stringifyError(error)
    };
  }

  const text = await response.text();

  if (response.ok) {
    return {
      accessible: true,
      status: response.status
    };
  }

  return {
    accessible: false,
    status: response.status,
    detail: extractOpenAiErrorMessage(parseMaybeJson(text), text)
  };
}

function createModelAccessError(model: string, access: ModelAccessCheck) {
  if (access.status === 400 && access.detail && isInvalidApiKeyError(access.detail)) {
    return new PdpServiceError(
      "GEMINI_API_KEY_INVALID",
      "입력한 Gemini API 키가 올바르지 않습니다. 다시 확인해 주세요.",
      `${model}: ${access.detail}`
    );
  }

  if (access.status === 401) {
    return new PdpServiceError(
      "GEMINI_API_KEY_INVALID",
      "입력한 Gemini API 키가 인증되지 않았습니다. 키를 다시 확인해 주세요.",
      `${model}: ${access.detail ?? "unauthorized"}`
    );
  }

  if (access.status === 403 || access.status === 404) {
    return new PdpServiceError(
      "GEMINI_MODEL_ACCESS_DENIED",
      `입력한 Gemini API 키로는 ${model} 모델에 접근할 수 없습니다.`,
      access.detail
        ? `${model}: ${access.detail}`
        : `${model}: permission denied or model unavailable for this key`
    );
  }

  return new PdpServiceError(
    "PDP_ANALYZE_FAILED",
    "Gemini API 키 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    access.detail ? `${model}: ${access.detail}` : `${model}: HTTP ${access.status}`
  );
}

function createOpenAiModelAccessError(model: string, access: ModelAccessCheck) {
  if (access.status === 401 || (access.detail && isOpenAiInvalidApiKeyError(access.detail))) {
    return new PdpServiceError(
      "OPENAI_API_KEY_INVALID",
      "입력한 OpenAI API 키가 올바르지 않습니다. 키를 다시 확인해 주세요.",
      `${model}: ${access.detail ?? "unauthorized"}`
    );
  }

  if (access.status === 403 || access.status === 404) {
    return new PdpServiceError(
      "OPENAI_MODEL_ACCESS_DENIED",
      `입력한 OpenAI API 키로는 ${model} 모델에 접근할 수 없습니다.`,
      access.detail
        ? `${model}: ${access.detail}`
        : `${model}: permission denied or model unavailable for this key`
    );
  }

  if (access.status === 429) {
    return new PdpServiceError(
      "OPENAI_QUOTA_EXCEEDED",
      "OpenAI 사용량 또는 rate limit이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
      access.detail
    );
  }

  return new PdpServiceError(
    "PDP_ANALYZE_FAILED",
    "OpenAI API 키 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    access.detail ? `${model}: ${access.detail}` : `${model}: HTTP ${access.status}`
  );
}

function createOpenAiApiError(status: number, payload: unknown, fallbackText: string) {
  const detail = extractOpenAiErrorMessage(payload, fallbackText);

  if (status === 401 || isOpenAiInvalidApiKeyError(detail)) {
    return new PdpServiceError(
      "OPENAI_API_KEY_INVALID",
      "입력한 OpenAI API 키가 올바르지 않습니다. 키를 다시 확인해 주세요.",
      detail
    );
  }

  if (status === 403 || status === 404) {
    return new PdpServiceError(
      "OPENAI_MODEL_ACCESS_DENIED",
      "입력한 OpenAI API 키로 선택한 OpenAI 모델에 접근할 수 없습니다.",
      detail
    );
  }

  if (status === 429 || isQuotaError(detail)) {
    return new PdpServiceError(
      "OPENAI_QUOTA_EXCEEDED",
      "OpenAI 사용량 또는 rate limit이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
      detail
    );
  }

  return new PdpServiceError(
    "PDP_ANALYZE_FAILED",
    "OpenAI 요청 처리 중 오류가 발생했습니다.",
    detail
  );
}

function createOpenAiTransportError(error: unknown) {
  return new PdpServiceError(
    "PDP_ANALYZE_FAILED",
    "OpenAI API에 연결하지 못했습니다. 네트워크 상태나 OpenAI 프로젝트 접근 상태를 확인해 주세요.",
    stringifyError(error)
  );
}

function extractGoogleApiErrorMessage(rawText: string) {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: {
        message?: string;
        status?: string;
      };
    };
    const status = parsed.error?.status?.trim();
    const message = parsed.error?.message?.trim();
    return [status, message].filter(Boolean).join(": ");
  } catch {
    return trimmed;
  }
}

function extractOpenAiErrorMessage(payload: unknown, fallbackText: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: string; code?: string; type?: string } }).error;
    return [error?.type, error?.code, error?.message].filter(Boolean).join(": ");
  }

  return fallbackText.trim();
}

function parseMaybeJson(rawText: string): unknown {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      raw: trimmed
    };
  }
}

function toDataUrl(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
}
