"use client";

import type {
  AspectRatio,
  GeneratedResult,
  ImageGenOptions,
  PdpAiProvider,
  PdpAnalysisImageMetadata,
  PdpAnalysisStrip,
  PdpCopyLanguage,
  PdpCustomerReviewAnalysis,
  PdpOutputMode,
  PdpSourceMaterial,
  PdpSourceMode,
  ReferenceModelUsage,
  SectionBlueprint
} from "@runacademy/shared";

const PDP_DRAFT_DB = "hanirum-pdp-maker";
const PDP_DRAFT_STORE = "drafts";
const PDP_DRAFT_VERSION = 2;
const DEFAULT_DRAFT_TITLE = "상세페이지 초안";

export type PdpAppState = "upload" | "processing" | "editor";
export type OverlayTextAlign = "left" | "center" | "right";
export type WorkbenchTab = "image" | "layer" | "copy" | "guide";
export type CanvasLayerKind = "text" | "shape";

interface CanvasLayerBase {
  id: string;
  kind: CanvasLayerKind;
  x: number;
  y: number;
  width: number | string;
  height: number | string;
}

export interface TextOverlay extends CanvasLayerBase {
  kind: "text";
  text: string;
  language: PdpCopyLanguage;
  translations: Record<PdpCopyLanguage, string>;
  fontSize: number;
  color: string;
  backgroundColor: string;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundRadius: number;
  fontFamily: string;
  fontWeight: string;
  textAlign: OverlayTextAlign;
  lineHeight: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  shadowOffsetY: number;
}

export interface ShapeLayer extends CanvasLayerBase {
  kind: "shape";
  fillColor: string;
  fillOpacity: number;
  borderRadius: number;
}

export type CanvasLayer = TextOverlay | ShapeLayer;

export interface FloatingWorkbenchState {
  x: number;
  y: number;
  width: number;
  height: number;
  isOpen: boolean;
}

export interface PdpEditorDraftState {
  currentSectionIndex: number;
  sections: SectionBlueprint[];
  sectionOptions: Record<number, ImageGenOptions>;
  overlaysBySection: Record<number, CanvasLayer[]>;
  defaultCopyLanguage: PdpCopyLanguage;
  notice: string;
  heroWarning?: string;
  workbenchTab: WorkbenchTab;
  workbenchState: FloatingWorkbenchState;
}

export interface PreparedImageDraft {
  base64: string;
  mimeType: string;
  previewUrl: string;
  fileName: string;
  generationBase64?: string;
  generationMimeType?: string;
  generationPreviewUrl?: string;
  // Long-detail-page strips are persisted so a draft restored later re-analyzes the WHOLE page.
  // Without them the stored base64 is only the topmost band, and re-analysis would silently
  // treat that single banner strip as the entire detail page.
  analysisStrips?: PdpAnalysisStrip[];
  analysisMetadata?: PdpAnalysisImageMetadata;
  /**
   * SESSION-ONLY handle to the user's original upload, kept so productCutRegion can be
   * re-cropped from full-resolution pixels after analysis. Deliberately dropped by
   * normalizePreparedImage so it is never persisted to IndexedDB.
   */
  sourceFile?: File;
}

export interface PdpSourceMaterialDraft extends PdpSourceMaterial {
  id: string;
  previewUrl?: string;
  preparedImage?: PreparedImageDraft;
}

export interface PdpDraftRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  appState: PdpAppState;
  preparedImage: PreparedImageDraft | null;
  sourceMaterials: PdpSourceMaterialDraft[];
  modelImage: PreparedImageDraft | null;
  modelImageUsage: ReferenceModelUsage | null;
  result: GeneratedResult | null;
  additionalInfo: string;
  customerReviewAnalysis: PdpCustomerReviewAnalysis | null;
  desiredTone: string;
  aspectRatio: AspectRatio;
  aiProvider: PdpAiProvider;
  sourceMode: PdpSourceMode;
  outputMode: PdpOutputMode;
  sectionCount: number;
  benefits: string[];
  notice: string;
  editorState: PdpEditorDraftState | null;
  /**
   * Pass-1 transcription of the uploaded long detail page. Persisted so a restored draft
   * keeps its copy inventory for section expansion without re-running transcription.
   */
  longPageTranscript?: string;
  /**
   * True when every batch transcribed successfully. Only complete transcripts may seed the
   * re-analysis cache — partial ones must stay retryable, as the completion notice promises.
   */
  longPageTranscriptComplete?: boolean;
  /**
   * Pages-derived cache key captured WHEN the transcript was made. Restored sessions seed the
   * reuse cache with this stored key (never a recomputed one): if the user added another long
   * page after transcription, the keys diverge and the new page gets transcribed instead of
   * being silently skipped forever.
   */
  longPageTranscriptKey?: string;
}

export interface PdpDraftSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  aspectRatio: AspectRatio;
  sectionCount: number;
  stageLabel: string;
  thumbnailUrl: string | null;
}

export type PdpDraftInput = Omit<PdpDraftRecord, "id" | "title" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: string;
};

export async function listPdpDrafts(): Promise<PdpDraftSummary[]> {
  const records = await withStore("readonly", (store) => requestAsPromise<PdpDraftRecord[]>(store.getAll()));
  return records
    .map((record) => normalizeDraftRecord(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((record) => ({
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      aspectRatio: record.aspectRatio,
      sectionCount: record.editorState?.sections.length ?? record.result?.blueprint.sections.length ?? 0,
      stageLabel: record.result
        ? record.outputMode === "full-image" ? "통이미지 모드" : "텍스트편집 모드"
        : record.sourceMode === "redesign" ? "리디자인 초안" : "설정 초안",
      thumbnailUrl:
        record.editorState?.sections[0]?.generatedImage ??
        record.result?.blueprint.sections[0]?.generatedImage ??
        record.preparedImage?.previewUrl ??
        record.result?.originalImage ??
        null
    }));
}

export async function getPdpDraft(id: string): Promise<PdpDraftRecord | null> {
  return withStore("readonly", (store) =>
    requestAsPromise<PdpDraftRecord | undefined>(store.get(id)).then((record) => (record ? normalizeDraftRecord(record) : null))
  );
}

export async function savePdpDraft(input: PdpDraftInput): Promise<PdpDraftRecord> {
  const now = new Date().toISOString();
  const nextRecord: PdpDraftRecord = {
    id: input.id ?? crypto.randomUUID(),
    title: buildDraftTitle(input),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    appState: input.appState,
    preparedImage: input.preparedImage,
    sourceMaterials: normalizeSourceMaterialDrafts(input.sourceMaterials),
    modelImage: input.modelImage,
    modelImageUsage: input.modelImageUsage,
    result: input.result,
    additionalInfo: input.additionalInfo,
    customerReviewAnalysis: normalizeCustomerReviewAnalysis(input.customerReviewAnalysis),
    desiredTone: input.desiredTone,
    aspectRatio: input.aspectRatio,
    aiProvider: normalizeAiProvider(input.aiProvider),
    sourceMode: normalizeSourceMode(input.sourceMode),
    outputMode: normalizeOutputMode(input.outputMode),
    sectionCount: normalizeSectionCount(input.sectionCount),
    benefits: normalizeBenefitInputs(input.benefits),
    notice: input.notice,
    editorState: input.editorState,
    longPageTranscript: input.longPageTranscript,
    longPageTranscriptComplete: input.longPageTranscriptComplete,
    longPageTranscriptKey: input.longPageTranscriptKey
  };

  const normalizedRecord = normalizeDraftRecord(nextRecord);

  await withStore("readwrite", (store) => requestAsPromise(store.put(normalizedRecord)));
  return normalizedRecord;
}

export async function deletePdpDraft(id: string): Promise<void> {
  await withStore("readwrite", (store) => requestAsPromise(store.delete(id)));
}

function buildDraftTitle(input: PdpDraftInput) {
  return inferDraftProductTitle({
    additionalInfo: input.additionalInfo,
    result: input.result,
    sections: input.editorState?.sections ?? input.result?.blueprint.sections ?? []
  }) || DEFAULT_DRAFT_TITLE;
}

function normalizeDraftRecord(record: PdpDraftRecord): PdpDraftRecord {
  const preparedImage = normalizePreparedImage(record.preparedImage);
  const modelImage = normalizePreparedImage(record.modelImage);
  const result = normalizeGeneratedResult(record.result, preparedImage, record.editorState);
  const normalizedSections = Array.isArray(result?.blueprint.sections)
    ? result.blueprint.sections
    : Array.isArray(record.editorState?.sections)
      ? record.editorState.sections
      : [];

  const inferredTitle = inferDraftProductTitle({
    additionalInfo: record.additionalInfo,
    result,
    sections: normalizedSections
  });
  const existingTitle = normalizeDraftTitleText(record.title);
  const shouldReplaceExistingTitle =
    !existingTitle ||
    isFileNameLikeDraftTitle(existingTitle, preparedImage) ||
    (inferredTitle && isGenericDraftTitle(existingTitle));

  return {
    id: record.id,
    title: shouldReplaceExistingTitle ? inferredTitle || DEFAULT_DRAFT_TITLE : existingTitle,
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
    appState: record.appState === "processing" || record.appState === "editor" ? record.appState : "upload",
    preparedImage,
    sourceMaterials: normalizeSourceMaterialDrafts(record.sourceMaterials),
    modelImage,
    modelImageUsage: record.modelImageUsage === "all-sections" || record.modelImageUsage === "hero-only" ? record.modelImageUsage : null,
    result,
    additionalInfo: record.additionalInfo ?? "",
    customerReviewAnalysis: normalizeCustomerReviewAnalysis(record.customerReviewAnalysis),
    desiredTone: record.desiredTone ?? "",
    aspectRatio: normalizeAspectRatio(record.aspectRatio),
    aiProvider: normalizeAiProvider(record.aiProvider),
    sourceMode: normalizeSourceMode(record.sourceMode),
    outputMode: normalizeOutputMode(record.outputMode),
    sectionCount: normalizeSectionCount(record.sectionCount),
    benefits: normalizeBenefitInputs(record.benefits),
    notice: record.notice ?? "저장된 작업을 불러왔습니다.",
    editorState: normalizeEditorState(record.editorState, result),
    longPageTranscript: normalizeLongPageTranscript(record.longPageTranscript),
    longPageTranscriptComplete: record.longPageTranscriptComplete === true ? true : undefined,
    longPageTranscriptKey:
      typeof record.longPageTranscriptKey === "string" && record.longPageTranscriptKey
        ? record.longPageTranscriptKey.slice(0, 600)
        : undefined
  };
}

function normalizeLongPageTranscript(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80_000) : undefined;
}

function normalizeSourceMaterialDrafts(value: unknown): PdpSourceMaterialDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => normalizeSourceMaterialDraft(item, index))
    .filter((item): item is PdpSourceMaterialDraft => Boolean(item))
    .slice(0, 8);
}

function normalizeSourceMaterialDraft(value: unknown, index: number): PdpSourceMaterialDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Partial<PdpSourceMaterialDraft>;
  const kind = record.kind === "pdf" ? "pdf" : record.kind === "image" ? "image" : null;
  const fileName = String(record.fileName || "").trim().slice(0, 160);

  if (!kind || !fileName) {
    return null;
  }

  const preparedImage = normalizePreparedImage(record.preparedImage);

  return {
    id: String(record.id || `source-${index + 1}`),
    kind,
    role: record.role === "primary" ? "primary" : "supporting",
    fileName,
    mimeType: String(record.mimeType || "").slice(0, 80) || undefined,
    size: Math.max(0, Math.floor(Number(record.size) || 0)),
    pageCount: record.pageCount ? Math.max(1, Math.floor(Number(record.pageCount) || 1)) : undefined,
    text: typeof record.text === "string" ? record.text.slice(0, 18000) : undefined,
    imageBase64: typeof record.imageBase64 === "string" ? record.imageBase64 : undefined,
    imageMimeType: typeof record.imageMimeType === "string" ? record.imageMimeType.slice(0, 80) : undefined,
    imageOptimization: record.imageOptimization,
    previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : preparedImage?.previewUrl,
    preparedImage: preparedImage ?? undefined
  };
}

function normalizeCustomerReviewAnalysis(value: PdpCustomerReviewAnalysis | null | undefined): PdpCustomerReviewAnalysis | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const reviewCount = Math.max(0, Math.min(9999, Math.floor(Number(value.reviewCount) || 0)));
  const sampleReviews = normalizeStringList(value.sampleReviews, 12, 180);
  const topBenefits = normalizeStringList(value.topBenefits, 8, 90);
  const painPoints = normalizeStringList(value.painPoints, 8, 90);
  const improvementPromises = normalizeStringList(value.improvementPromises, 8, 120);
  const keywordSummary = normalizeStringList(value.keywordSummary, 12, 40);

  if (!reviewCount && !sampleReviews.length && !topBenefits.length && !painPoints.length) {
    return null;
  }

  return {
    fileName: String(value.fileName || "고객 후기 파일").slice(0, 120),
    reviewCount,
    sampleReviews,
    topBenefits,
    painPoints,
    improvementPromises,
    keywordSummary
  };
}

function normalizeStringList(values: unknown, limit: number, maxLength: number) {
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

function normalizePreparedImage(image: PreparedImageDraft | null | undefined) {
  if (!image?.base64 || !image.mimeType) {
    return null;
  }

  const previewUrl = image.previewUrl || `data:${image.mimeType};base64,${image.base64}`;
  const analysisStrips = normalizeAnalysisStrips(image.analysisStrips);

  return {
    base64: image.base64,
    mimeType: image.mimeType,
    previewUrl,
    fileName: image.fileName || "image",
    generationBase64: image.generationBase64,
    generationMimeType: image.generationMimeType,
    generationPreviewUrl: image.generationPreviewUrl,
    analysisStrips,
    analysisMetadata: normalizeAnalysisMetadata(image.analysisMetadata, analysisStrips)
  };
}

function normalizeAnalysisStrips(strips: PdpAnalysisStrip[] | null | undefined): PdpAnalysisStrip[] | undefined {
  if (!Array.isArray(strips) || strips.length === 0) {
    return undefined;
  }

  const normalized = strips
    .filter(
      (strip): strip is PdpAnalysisStrip =>
        Boolean(strip) &&
        typeof strip.base64 === "string" &&
        strip.base64.length > 0 &&
        typeof strip.mimeType === "string" &&
        Number.isFinite(strip.yStartRatio) &&
        Number.isFinite(strip.yEndRatio)
    )
    .map((strip) => ({
      base64: strip.base64,
      mimeType: strip.mimeType,
      yStartRatio: strip.yStartRatio,
      yEndRatio: strip.yEndRatio
    }));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAnalysisMetadata(
  metadata: PdpAnalysisImageMetadata | null | undefined,
  analysisStrips?: PdpAnalysisStrip[]
) {
  if (
    !metadata ||
    (metadata.mode !== "original" &&
      metadata.mode !== "standard-resize" &&
      metadata.mode !== "long-detail-sampling" &&
      metadata.mode !== "long-detail-strips")
  ) {
    return undefined;
  }

  // Strip metadata without the strips themselves (legacy drafts saved before strips were
  // persisted) would make the analyze prompt claim "N strips attached, top to bottom" while
  // only the topmost band is actually sent. Drop the metadata so the server treats the image
  // as a plain resized copy instead of lying to the model.
  if (metadata.mode === "long-detail-strips" && (!analysisStrips || analysisStrips.length === 0)) {
    return undefined;
  }

  return {
    mode: metadata.mode,
    originalWidth: Number(metadata.originalWidth) || 0,
    originalHeight: Number(metadata.originalHeight) || 0,
    optimizedWidth: Number(metadata.optimizedWidth) || 0,
    optimizedHeight: Number(metadata.optimizedHeight) || 0,
    originalBytes: Number(metadata.originalBytes) || 0,
    optimizedBytes: Number(metadata.optimizedBytes) || 0,
    sampleCount: typeof metadata.sampleCount === "number" ? metadata.sampleCount : undefined,
    stripCount: typeof metadata.stripCount === "number" ? metadata.stripCount : undefined,
    stripWidth: typeof metadata.stripWidth === "number" ? metadata.stripWidth : undefined,
    reductionFactor: typeof metadata.reductionFactor === "number" ? metadata.reductionFactor : undefined,
    actualReduction: typeof metadata.actualReduction === "number" ? metadata.actualReduction : undefined,
    generationReferenceWidth: typeof metadata.generationReferenceWidth === "number" ? metadata.generationReferenceWidth : undefined,
    generationReferenceHeight: typeof metadata.generationReferenceHeight === "number" ? metadata.generationReferenceHeight : undefined
  };
}

function normalizeGeneratedResult(
  result: GeneratedResult | null | undefined,
  preparedImage: PreparedImageDraft | null,
  editorState: PdpEditorDraftState | null | undefined
): GeneratedResult | null {
  if (result?.blueprint?.sections?.length) {
    return {
      originalImage: result.originalImage || preparedImage?.previewUrl || toDataUrl(preparedImage),
      originalImageMimeType: result.originalImageMimeType || preparedImage?.generationMimeType || preparedImage?.mimeType,
      originalImageFileName: result.originalImageFileName || preparedImage?.fileName,
      blueprint: {
        executiveSummary: result.blueprint.executiveSummary ?? "",
        scorecard: Array.isArray(result.blueprint.scorecard) ? result.blueprint.scorecard : [],
        blueprintList: Array.isArray(result.blueprint.blueprintList) ? result.blueprint.blueprintList : [],
        sections: result.blueprint.sections
      }
    };
  }

  if (preparedImage && editorState?.sections?.length) {
    return {
      originalImage: preparedImage.previewUrl || toDataUrl(preparedImage),
      originalImageMimeType: preparedImage.generationMimeType || preparedImage.mimeType,
      originalImageFileName: preparedImage.fileName,
      blueprint: {
        executiveSummary: "",
        scorecard: [],
        blueprintList: [],
        sections: editorState.sections
      }
    };
  }

  return null;
}

function normalizeEditorState(editorState: PdpEditorDraftState | null | undefined, result: GeneratedResult | null): PdpEditorDraftState | null {
  const sections = Array.isArray(editorState?.sections) && editorState.sections.length
    ? editorState.sections
    : result?.blueprint.sections?.length
      ? result.blueprint.sections
      : [];
  const sectionOptions =
    editorState?.sectionOptions && typeof editorState.sectionOptions === "object" && !Array.isArray(editorState.sectionOptions)
      ? editorState.sectionOptions
      : {};
  const overlaysBySection =
    editorState?.overlaysBySection && typeof editorState.overlaysBySection === "object" && !Array.isArray(editorState.overlaysBySection)
      ? editorState.overlaysBySection
      : {};

  if (!sections.length && !editorState) {
    return null;
  }

  return {
    currentSectionIndex:
      typeof editorState?.currentSectionIndex === "number" ? Math.max(0, Math.min(editorState.currentSectionIndex, Math.max(0, sections.length - 1))) : 0,
    sections,
    sectionOptions,
    overlaysBySection,
    defaultCopyLanguage: editorState?.defaultCopyLanguage === "en" ? "en" : "ko",
    notice: editorState?.notice ?? "저장된 작업을 이어서 편집할 수 있습니다.",
    heroWarning: editorState?.heroWarning ?? "",
    workbenchTab:
      editorState?.workbenchTab === "copy" ||
      editorState?.workbenchTab === "guide" ||
      editorState?.workbenchTab === "layer" ||
      editorState?.workbenchTab === "image"
        ? editorState.workbenchTab
        : "image",
    workbenchState: {
      x: editorState?.workbenchState?.x ?? 756,
      y: editorState?.workbenchState?.y ?? 24,
      width: editorState?.workbenchState?.width ?? 332,
      height: editorState?.workbenchState?.height ?? 500,
      isOpen: editorState?.workbenchState?.isOpen ?? true
    }
  };
}

function inferDraftProductTitle({
  additionalInfo,
  result,
  sections
}: {
  additionalInfo?: string;
  result?: GeneratedResult | null;
  sections?: SectionBlueprint[];
}) {
  const textSources = [
    additionalInfo,
    result?.blueprint.executiveSummary,
    ...(result?.blueprint.blueprintList ?? []),
    ...(result?.blueprint.scorecard ?? []).flatMap((item) => [item.category, item.reason]),
    ...(sections ?? []).flatMap((section) => [
      section.headline,
      section.subheadline,
      section.trust_or_objection_line,
      section.CTA,
      section.goal,
      section.purpose,
      section.layout_notes,
      section.reference_usage,
      ...section.bullets
    ])
  ].filter((value): value is string => Boolean(value));

  for (const source of textSources) {
    const explicitTitle = extractExplicitProductTitle(source);
    if (explicitTitle) {
      return explicitTitle;
    }
  }

  const candidates = textSources
    .flatMap((source) => splitDraftTitleCandidateLines(source))
    .map((line) => extractProductTitleCandidate(line))
    .filter((candidate): candidate is string => Boolean(candidate));

  if (!candidates.length) {
    return "";
  }

  return candidates
    .map((candidate) => ({
      title: candidate,
      score: scoreProductTitleCandidate(candidate)
    }))
    .sort((left, right) => right.score - left.score || left.title.length - right.title.length)[0]?.title ?? "";
}

function extractExplicitProductTitle(source: string) {
  const normalized = normalizeDraftTitleText(source);
  const match = normalized.match(/(?:상품명|제품명)\s*(?:[:：=]\s*|\s+|은\s+|는\s+)([^,，.;；|/\n]{2,70})/);
  return sanitizeDraftProductTitle(match?.[1] ?? "");
}

function splitDraftTitleCandidateLines(source: string) {
  return source
    .split(/[\n\r•·|]+|[.!?。！？]\s+/)
    .map((line) => normalizeDraftTitleText(line))
    .filter((line) => line.length >= 3 && line.length <= 90);
}

function extractProductTitleCandidate(line: string) {
  if (!hasProductTypeToken(line)) {
    return "";
  }

  const narrowedLine =
    line.match(/(?:니까|위해|위한|라면|에는|엔)\s+(.+)/)?.[1] ??
    line.match(/(?:^|\s)([A-Z0-9][A-Z0-9\s+.-]{1,34}(?:선\s*크림|썬\s*크림|선스크린|sunscreen|sun\s*screen|sun\s*cream|sun\s*patch|패치|크림|세럼|앰플|샴푸|양말|삭스|가방|텀블러|의자|조명)[^,，.;；|/\n]*)/i)?.[1] ??
    line.match(/([가-힣A-Za-z0-9+.-]{2,}\s+[가-힣A-Za-z0-9+.\s-]{0,34}(?:선\s*크림|썬\s*크림|선스크린|패치|크림|세럼|앰플|샴푸|양말|삭스|가방|텀블러|의자|조명)[^,，.;；|/\n]*)/i)?.[1] ??
    line;

  return sanitizeDraftProductTitle(narrowedLine);
}

function sanitizeDraftProductTitle(value: string) {
  const normalized = normalizeDraftTitleText(value)
    .replace(/^(?:예|ex|example)\s*[:：]\s*/i, "")
    .replace(/^(?:상품명|제품명)\s*[:：]?\s*/i, "")
    .replace(/^(?:물놀이|서핑|캠핑|등산|운동|야외|외출)(?:\s+[가-힣A-Za-z0-9+.-]+){0,2}(?:엔|에는|에)\s+/i, "")
    .split(/(?:카테고리|타깃|대상|판매처|강조|금지|시즌|용도)\s*[:：]?/)[0]
    .replace(/\s*(?:상세페이지|상품|제품)?\s*(?:분석|초안|기획|전략)\s*$/i, "")
    .replace(/["'“”‘’「」『』()[\]{}]/g, "")
    .replace(/[?!.。！？]+$/g, "")
    .trim();

  if (!normalized || normalized.length < 3 || normalized.length > 54 || isGenericDraftTitle(normalized) || isFileNameLikeDraftTitle(normalized, null)) {
    return "";
  }

  return normalized.slice(0, 42);
}

function normalizeDraftTitleText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hasProductTypeToken(value: string) {
  return /running\s*socks?|run\s*socks?|러닝\s*양말|런닝\s*양말|운동\s*양말|양말|삭스|socks?|선\s*크림|썬\s*크림|선스크린|sunscreen|sun\s*screen|sun\s*cream|sun\s*patch|선\s*패치|썬\s*패치|패치|크림|세럼|앰플|샴푸|가방|텀블러|의자|조명/i.test(value);
}

function isGenericDraftTitle(value: string) {
  return /^(?:상세페이지\s*초안|히어로우?|히어로|메인|문제\s*제기|가이드|제품\s*소개|해결\s*계획|구매\s*제안|사용\s*후\s*변화|마지막\s*확신|섹션\s*\d*)$/i.test(value);
}

function isFileNameLikeDraftTitle(title: string, preparedImage: PreparedImageDraft | null) {
  const normalizedTitle = title.toLowerCase();
  const preparedFileBase = preparedImage?.fileName?.replace(/\.[^.]+$/, "").trim().toLowerCase();

  if (preparedFileBase && normalizedTitle === preparedFileBase) {
    return true;
  }

  return (
    /^(?:screen\s*capture|screencapture|screenshot|cleanshot|image|img[_-]|dcim|kakao|naver|smartstore|product-reference)/i.test(title) ||
    /(?:brand[-_\s]?naver|products?[-_\s]?\d+|[-_]\d{4}[-_]\d{2}[-_]\d{2})/i.test(title) ||
    /\.(?:png|jpe?g|webp|gif|avif|pdf)$/i.test(title)
  );
}

function scoreProductTitleCandidate(candidate: string) {
  let score = 0;
  if (hasProductTypeToken(candidate)) score += 8;
  if (/[A-Z]{2,}|[0-9]/.test(candidate)) score += 3;
  if (/[가-힣]{2,}\s+[가-힣A-Za-z0-9+.-]{2,}/.test(candidate)) score += 2;
  if (/고객|후기|리뷰|고민|문제|해결|구매|선택|상세페이지|섹션|원본|확인|사용|전환|전략|이유|변화|필요|오늘|지금|정말/.test(candidate)) score -= 4;
  if (candidate.length > 34) score -= 1;
  return score;
}

function normalizeAspectRatio(value: AspectRatio | string | undefined): AspectRatio {
  if (value === "1:1" || value === "3:4" || value === "4:3" || value === "9:16" || value === "16:9") {
    return value;
  }

  return "9:16";
}

function normalizeAiProvider(value: PdpAiProvider | string | undefined): PdpAiProvider {
  return value === "openai" ? "openai" : "gemini";
}

function normalizeSourceMode(value: PdpSourceMode | string | undefined): PdpSourceMode {
  if (value === "product" || value === "redesign") {
    return value;
  }

  return "auto";
}

function normalizeOutputMode(value: PdpOutputMode | string | undefined): PdpOutputMode {
  return value === "full-image" ? "full-image" : "editable";
}

function normalizeSectionCount(value: number | undefined) {
  const allowedCounts = [1, 4, 5, 6, 8, 10];
  return allowedCounts.includes(Number(value)) ? Number(value) : 1;
}

function normalizeBenefitInputs(values: string[] | undefined) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, 10)
    : [];
}

function toDataUrl(image: PreparedImageDraft | null) {
  if (!image) {
    return "";
  }

  return `data:${image.mimeType};base64,${image.base64}`;
}

function openDraftDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("이 브라우저에서는 로컬 저장 기능을 사용할 수 없습니다."));
      return;
    }

    const request = indexedDB.open(PDP_DRAFT_DB, PDP_DRAFT_VERSION);

    request.onerror = () => reject(request.error ?? new Error("저장소를 열지 못했습니다."));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PDP_DRAFT_STORE)) {
        database.createObjectStore(PDP_DRAFT_STORE, { keyPath: "id" });
      }
    };
  });
}

function withStore<T>(mode: IDBTransactionMode, handler: (store: IDBObjectStore) => Promise<T>) {
  return openDraftDb().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(PDP_DRAFT_STORE, mode);
        const store = transaction.objectStore(PDP_DRAFT_STORE);
        let resultValue: T;

        transaction.oncomplete = () => {
          database.close();
          resolve(resultValue);
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("저장소 작업에 실패했습니다."));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error ?? new Error("저장소 작업이 중단되었습니다."));
        };

        handler(store)
          .then((result) => {
            resultValue = result;
          })
          .catch((error) => {
            database.close();
            reject(error);
          });
      })
  );
}

function requestAsPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 요청에 실패했습니다."));
  });
}
