"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { AlertCircle, Bot, Clock3, Copy, FileText, FolderOpen, KeyRound, Loader2, Menu, RectangleHorizontal, RectangleVertical, Settings2, Smartphone, Sparkles, Square, Trash2, Upload, Wand2, X } from "lucide-react";
import { formatBytesMb, getPdpSectionImageDefaults, summarizeAnalyzeBudget } from "@runacademy/shared";
import type {
  AspectRatio,
  GeneratedResult,
  PdpAiProvider,
  PdpAnalysisStrip,
  PdpAnalyzeCustomerReviewsResponse,
  PdpAnalyzeResponse,
  PdpCustomerReviewAnalysis,
  PdpCustomerReviewSource,
  PdpGenerateImageResponse,
  PdpOutputMode,
  PdpSourceMaterial,
  PdpTranscribeStripsResponse,
  ReferenceModelUsage
} from "@runacademy/shared";
import type { PdpAppState, PdpDraftSummary, PdpEditorDraftState, PdpSourceMaterialDraft, PreparedImageDraft } from "./pdp-drafts";
import { deletePdpDraft, getPdpDraft, listPdpDrafts, savePdpDraft } from "./pdp-drafts";
import { PdpBugReportWidget } from "./PdpBugReportWidget";
import { PdpEditor } from "./PdpEditor";
import { PdpSettingsSheet } from "./PdpSettingsSheet";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import styles from "./pdp-maker.module.css";
import { flushPdpUsageLogs, installPdpUsageLogFlushHandlers, logPdpUsage } from "./pdp-usage-log";
import { PDP_APP_VERSION } from "./pdp-version";
import {
  loadPdpClientSettings,
  resolveGeminiApiKeyHeaderValue,
  resolveOpenAiApiKeyHeaderValue,
  savePdpClientSettings,
  type PdpClientSettings
} from "./pdp-settings";
import {
  RATIO_OPTIONS,
  TONE_OPTIONS,
  apiJson,
  GENERATION_API_TIMEOUT_MS,
  cropProductCutFromOriginalFile,
  getPreparedImageStrips,
  needsPreparedImageReoptimization,
  prepareImageFile,
  reoptimizePreparedImagePayload,
  validateGeminiApiKey,
  validateOpenAiApiKey
} from "./pdp-utils";

type PreparedImage = PreparedImageDraft;
type KnowledgeItem = {
  id: string;
  name: string;
  type: string;
  size: number;
  text: string;
  createdAt: string;
};
type WaitingVideo = {
  videoId: string;
  title: string;
  url: string;
  embedUrl: string;
};

const DEFAULT_WAITING_VIDEO: WaitingVideo = {
  videoId: "ffsqj3Re33E",
  title: "한이룸 유튜브 추천 영상",
  url: "https://www.youtube.com/watch?v=ffsqj3Re33E",
  embedUrl: "https://www.youtube.com/embed/ffsqj3Re33E?rel=0&modestbranding=1"
};
const WAITING_VIDEO_CLIENT_TIMEOUT_MS = 2500;

type SectionImageBatchResult = {
  result: GeneratedResult;
  failedCount: number;
  errorMessage: string;
  errorDetail: string;
};

const INITIAL_HERO_SECTION_COUNT = 1;
const APP_TITLE = "한이룸의 상세페이지 마법사 3.0";
const NOTICE_DISMISSED_STORAGE_KEY = "hanirum-pdp-maker-notice-dismissed";
const KNOWLEDGE_STORAGE_KEY = "hanirum-pdp-maker-knowledge-items";
const MAX_KNOWLEDGE_ITEMS = 5;
const MAX_KNOWLEDGE_TEXT_CHARS = 60000;
const MAX_SOURCE_MATERIAL_FILES = 8;
const MAX_SOURCE_MATERIAL_TEXT_CHARS = 40000;
const MAX_SOURCE_MATERIAL_TEXT_CHARS_PER_FILE = 12000;
const MAX_PDF_TEXT_PAGES = 80;
const MAX_PDF_ANALYSIS_PAGES = 3;
const PDF_ANALYSIS_RENDER_WIDTH = 900;
// Pass-1 transcription (2-pass long-page analysis): strips per vision call. 6 keeps a batch of
// 344px-wide strips inside one model call's attention span; the byte cap guards wide pages
// (strips up to 1536px can reach ~500KB each) against Vercel's ~4.5MB request-body limit.
const TRANSCRIBE_STRIPS_PER_BATCH = 6;
const TRANSCRIBE_BATCH_MAX_BASE64_CHARS = 2_600_000;
const TRANSCRIBE_MAX_TRANSCRIPT_CHARS = 60_000;
// Errors that retrying a transcription batch cannot fix — abort pass 1 immediately.
const TRANSCRIBE_FATAL_ERROR_CODES = new Set([
  "GEMINI_API_KEY_MISSING",
  "GEMINI_API_KEY_INVALID",
  "GEMINI_MODEL_ACCESS_DENIED",
  "GEMINI_QUOTA_EXCEEDED",
  "OPENAI_API_KEY_MISSING",
  "OPENAI_API_KEY_INVALID",
  "OPENAI_MODEL_ACCESS_DENIED",
  "OPENAI_QUOTA_EXCEEDED"
]);

/**
 * Cache key binding a transcript to the exact strips it was read from. JPEG base64 PREFIXES
 * are useless as identity: the first ~80 chars encode only the encoder's quality tables, and
 * every strip comes from the same server pipeline (verified with this project's sharp — two
 * unrelated images share the exact same first 80 chars). The TAIL is image data and differs
 * per image, so the key uses lengths plus tail slices of the first/last strips. A weak key
 * here silently reuses another product's transcript — the sunscreen-contamination class.
 */
function buildLongPageStripsCacheKey(strips: PdpAnalysisStrip[]) {
  const first = strips[0]?.base64 ?? "";
  const last = strips[strips.length - 1]?.base64 ?? "";
  const totalChars = strips.reduce((sum, strip) => sum + strip.base64.length, 0);
  return [strips.length, totalChars, first.length, first.slice(-80), last.length, last.slice(-80)].join(":");
}

type TranscriptionPage = { label: string; strips: PdpAnalysisStrip[] };

// Total long pages transcribed per run (primary + supporting). Each page costs its own batch
// calls, so this bounds worst-case pass-1 time/cost. 5 covers the "한 상세페이지를 여러 장으로
// 나눠 캡처" workflow (실측: 3~4장 분할이 일반적); overflow stays visible in the completion
// notice, never silent.
const MAX_TRANSCRIBE_PAGES = 5;

/**
 * Every long page in the upload set that pass-1 should transcribe, primary first. Used both at
 * analyze time and when seeding the transcript cache from a restored draft — MUST stay the
 * single source of that selection so the cache keys line up.
 */
function selectTranscriptionPages(primaryImage: unknown, materials: PdpSourceMaterialDraft[]): TranscriptionPage[] {
  const pages: TranscriptionPage[] = [];
  const primaryStrips = getPreparedImageStrips(primaryImage);
  if (primaryStrips?.length) {
    pages.push({
      label: (primaryImage as { fileName?: string } | null | undefined)?.fileName || "대표 상세페이지",
      strips: primaryStrips
    });
  }
  for (const material of materials) {
    if (pages.length >= MAX_TRANSCRIBE_PAGES) {
      break;
    }
    if (material.role === "primary" || material.kind !== "image") {
      continue;
    }
    const strips = material.preparedImage?.analysisStrips;
    if (strips?.length) {
      pages.push({ label: material.fileName || "보조 상세페이지", strips });
    }
  }
  return pages;
}

function buildTranscriptionCacheKey(pages: TranscriptionPage[]) {
  return pages.map((page) => buildLongPageStripsCacheKey(page.strips)).join("|");
}
// Client-side gate mirroring the server's PRODUCT_CUT_MIN_CONFIDENCE.
const PRODUCT_CUT_RECROP_MIN_CONFIDENCE = 0.5;
// Higher bar than the crop gate: using a whole attached image as the appearance reference is
// all-or-nothing, so a wrong pick (e.g. a sibling product) is worse than falling back.
const REFERENCE_PRODUCT_IMAGE_MIN_CONFIDENCE = 0.7;
// Mirrors the server's MAX_ANALYZE_SOURCE_IMAGES: only the first 5 supporting image payloads
// reach the model's vision input — a pick beyond that is a reference the model never saw.
const MAX_ANALYZE_SOURCE_IMAGES_SENT = 5;
const OUTPUT_MODE_OPTIONS: Array<{
  value: PdpOutputMode;
  label: string;
  description: string;
  badge: string;
  locked?: boolean;
}> = [
  {
    value: "full-image",
    label: "통이미지 모드",
    description: "카피와 디자인까지 이미지 안에 포함된 섹션으로 만듭니다.",
    badge: "OpenAI 고정"
  },
  {
    value: "editable",
    label: "텍스트편집 모드",
    description: "이번 버전에서는 통이미지 모드 중심으로 먼저 제공합니다.",
    badge: "이번 버전 잠금",
    locked: true
  }
];
const EMPTY_CLIENT_SETTINGS: PdpClientSettings = {
  customGeminiApiKey: "",
  customOpenAiApiKey: "",
  preferredAiProvider: ""
};

const AI_PROVIDER_OPTIONS: Array<{
  value: PdpAiProvider;
  label: string;
  description: string;
  badge: string;
}> = [
  {
    value: "gemini",
    label: "Gemini",
    description: "Gemini 분석과 이미지 생성 경로",
    badge: "기존 안정 경로"
  },
  {
    value: "openai",
    label: "OpenAI Image 2.0",
    description: "OpenAI 분석과 Image 2.0 생성 경로",
    badge: "새 실험 경로"
  }
];

const NOTICE_ITEMS = [
  {
    title: "AI API 키는 개인의 것으로 이용해주세요.",
    description: "생성할 때 사용되는 이미지 비용은 각자 부담합니다."
  },
  {
    title: "생성 속도가 느릴 수도 있습니다.",
    description: "각 API의 서버 상태에 따라가 처리속도가 천차만별이에요."
  },
  {
    title: "API 키 및 작업 내용은 서버에 저장되지 않습니다.",
    description: "API 키는 API 서버로 전달, 작업은 각 PC 브라우저내에만 남습니다."
  },
  {
    title: "시크릿 모드에서는 저장 내용이 사라질 수 있습니다.",
    description: "다시 접속했을 때 저장된 작업이 보이지 않을 수 있습니다."
  }
];

const PRODUCT_CONTEXT_GUIDANCE_MESSAGE = "상품명 또는 카테고리를 추가로 입력하면 더 정확하게 생성됩니다.";

type UploadContextGuidance = {
  tone: "warning" | "ready";
  title: string;
  message: string;
  reason: string;
};

export function PdpMakerClient() {
  const [appState, setAppState] = useState<PdpAppState>("upload");
  const [preparedImage, setPreparedImage] = useState<PreparedImage | null>(null);
  const [sourceMaterials, setSourceMaterials] = useState<PdpSourceMaterialDraft[]>([]);
  const [modelImage, setModelImage] = useState<PreparedImage | null>(null);
  const [modelImageUsage, setModelImageUsage] = useState<ReferenceModelUsage | null>(null);
  const [result, setResult] = useState<GeneratedResult | null>(null);
  // Pass-1 transcript of the uploaded long detail page; feeds analyze AND section expansion.
  const [longPageTranscript, setLongPageTranscript] = useState<string | null>(null);
  // COMPLETE transcripts keyed to their strips — a retried/regenerated analysis of the same
  // image reuses the paid pass-1 result instead of re-billing every batch.
  const longPageTranscriptCacheRef = useRef<{ key: string; transcript: string; batchCount: number } | null>(null);
  const [additionalInfo, setAdditionalInfo] = useState("");
  const [customerReviewSource, setCustomerReviewSource] = useState<PdpCustomerReviewSource | null>(null);
  const [customerReviewAnalysis, setCustomerReviewAnalysis] = useState<PdpCustomerReviewAnalysis | null>(null);
  const [isReadingCustomerReviews, setIsReadingCustomerReviews] = useState(false);
  const [isAnalyzingCustomerReviews, setIsAnalyzingCustomerReviews] = useState(false);
  const [customerReviewAnalysisError, setCustomerReviewAnalysisError] = useState("");
  const [desiredTone, setDesiredTone] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [aiProvider, setAiProvider] = useState<PdpAiProvider>("gemini");
  const [outputMode, setOutputMode] = useState<PdpOutputMode>("full-image");
  const [notice, setNotice] = useState("브라우저에 초안이 저장되며, 저장한 작업은 이 화면에서 이어서 열 수 있습니다.");
  const [errorMessage, setErrorMessage] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [loadingStep, setLoadingStep] = useState("제품 이미지를 분석하는 중입니다.");
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [waitingVideo, setWaitingVideo] = useState<WaitingVideo | null>(null);
  const [isLoadingWaitingVideo, setIsLoadingWaitingVideo] = useState(false);
  const [drafts, setDrafts] = useState<PdpDraftSummary[]>([]);
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(true);
  const [isLoadingDraft, setIsLoadingDraft] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftCreatedAt, setDraftCreatedAt] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [editorDraftState, setEditorDraftState] = useState<PdpEditorDraftState | null>(null);
  const [editorSessionKey, setEditorSessionKey] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [manualSaveToastToken, setManualSaveToastToken] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDraftsOpen, setIsDraftsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<"upload" | "details">("upload");
  const [isNoticeModalOpen, setIsNoticeModalOpen] = useState(false);
  const [doNotShowNoticeAgain, setDoNotShowNoticeAgain] = useState(false);
  const [clientSettings, setClientSettings] = useState<PdpClientSettings>(EMPTY_CLIENT_SETTINGS);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [isKnowledgeOpen, setIsKnowledgeOpen] = useState(false);
  const [isReadingKnowledge, setIsReadingKnowledge] = useState(false);
  const [isReadingSourceMaterials, setIsReadingSourceMaterials] = useState(false);
  const [isKnowledgeHydrated, setIsKnowledgeHydrated] = useState(false);
  const knowledgeInputRef = useRef<HTMLInputElement>(null);
  const customerReviewInputRef = useRef<HTMLInputElement>(null);
  const isApplyingDraftRef = useRef(false);
  const saveInFlightRef = useRef(false);

  const preparedImageDisplayName = preparedImage ? formatCompactFileName(preparedImage.fileName) : "";
  const modelImageDisplayName = modelImage ? formatCompactFileName(modelImage.fileName) : "";
  const visibleSourceMaterials = useMemo(() => getVisibleSourceMaterials(sourceMaterials, preparedImage), [preparedImage, sourceMaterials]);
  const sourceMaterialDropzoneLabel = visibleSourceMaterials.length
    ? `${visibleSourceMaterials.length}개 자료 등록 · ${summarizeSourceMaterialsForUi(visibleSourceMaterials)}`
    : "";
  const sourceMaterialSummaryLabel = visibleSourceMaterials.length
    ? summarizeSourceMaterialsForUi(visibleSourceMaterials)
    : "이미지/PDF 미등록";
  const sourceMaterialTypeLabels = useMemo(
    () => buildSourceMaterialTypeLabels(visibleSourceMaterials),
    [visibleSourceMaterials]
  );
  const uploadContextGuidance = useMemo(() => buildUploadContextGuidance(visibleSourceMaterials, additionalInfo), [additionalInfo, visibleSourceMaterials]);
  const showProductImageGuidance = useMemo(() => needsProductImageGuidance(visibleSourceMaterials), [visibleSourceMaterials]);
  const knowledgeText = useMemo(() => buildKnowledgeText(knowledgeItems), [knowledgeItems]);
  const knowledgeStatusLabel = knowledgeItems.length ? `${knowledgeItems.length}개 등록` : "미등록";
  const knowledgeStatusClassName = knowledgeItems.length ? styles.sidebarBadgeActive : styles.sidebarBadge;
  const hasDraftContent = Boolean(preparedImage || sourceMaterials.length || modelImage || result || additionalInfo.trim() || customerReviewSource || customerReviewAnalysis || desiredTone.trim() || activeDraftId);
  const effectiveGeminiApiKey = resolveGeminiApiKeyHeaderValue(clientSettings);
  const effectiveOpenAiApiKey = resolveOpenAiApiKeyHeaderValue(clientSettings);
  const hasAvailableGeminiKey = Boolean(effectiveGeminiApiKey);
  const hasAvailableOpenAiKey = Boolean(effectiveOpenAiApiKey);
  const processingProvider: PdpAiProvider = outputMode === "full-image" ? "openai" : aiProvider;
  const selectedProviderUsesCodex = processingProvider === "openai" ? !hasAvailableOpenAiKey : !hasAvailableGeminiKey;
  const hasPendingCustomerReviewAnalysis = Boolean(customerReviewSource && !customerReviewAnalysis);
  const canContinueToDetails = Boolean(preparedImage && (!modelImage || modelImageUsage) && !hasPendingCustomerReviewAnalysis);
  const canAnalyze = Boolean(preparedImage && (!modelImage || modelImageUsage) && !hasPendingCustomerReviewAnalysis);
  const apiConnectionLabel = selectedProviderUsesCodex
    ? "Codex CLI"
    : hasAvailableGeminiKey || hasAvailableOpenAiKey
    ? `${hasAvailableGeminiKey ? "Gemini" : ""}${hasAvailableGeminiKey && hasAvailableOpenAiKey ? " + " : ""}${hasAvailableOpenAiKey ? "OpenAI" : ""}`
    : "Codex CLI";
  const selectedProviderLabel = AI_PROVIDER_OPTIONS.find((option) => option.value === processingProvider)?.label ?? "Gemini";
  const selectedOutputMode = OUTPUT_MODE_OPTIONS.find((option) => option.value === outputMode) ?? OUTPUT_MODE_OPTIONS[0];
  const estimatedProcessingSeconds = useMemo(
    () => (selectedProviderUsesCodex ? 540 : processingProvider === "openai" ? 180 : 150) + INITIAL_HERO_SECTION_COUNT * 20 + (modelImage ? 30 : 0),
    [modelImage, processingProvider, selectedProviderUsesCodex]
  );
  const elapsedProcessingSeconds = loadingStartedAt ? Math.max(0, Math.floor((Date.now() - loadingStartedAt) / 1000)) : 0;
  const remainingProcessingSeconds = loadingStartedAt
    ? Math.max(0, estimatedProcessingSeconds - elapsedProcessingSeconds)
    : estimatedProcessingSeconds;
  const remainingProgressPercent = Math.max(0, 100 - loadingProgress);
  const remainingTimeLabel = loadingProgress >= 94 || remainingProcessingSeconds <= 0
    ? "응답 마무리 중"
    : `약 ${formatDuration(remainingProcessingSeconds)} 남음`;
  const logSetupEvent = useCallback(
    (event: string, metadata?: Record<string, unknown>, level: "info" | "warn" | "error" = "info", error?: Error | string) => {
      logPdpUsage({
        event,
        source: "setup",
        level,
        state: {
          appState,
          setupStep,
          aiProvider,
          processingProvider,
          outputMode,
          aspectRatio,
          hasPreparedImage: Boolean(preparedImage),
          sourceMaterialCount: visibleSourceMaterials.length,
          hasModelImage: Boolean(modelImage),
          modelImageUsage: modelImageUsage ?? "none",
          customerReviewCount: customerReviewAnalysis?.reviewCount ?? customerReviewSource?.reviewCount ?? 0,
          knowledgeCount: knowledgeItems.length,
          hasDraft: Boolean(activeDraftId),
          sectionCount: result?.blueprint.sections.length ?? 0
        },
        metadata,
        error
      });
    },
    [activeDraftId, aiProvider, appState, aspectRatio, customerReviewAnalysis, customerReviewSource, knowledgeItems.length, modelImage, modelImageUsage, outputMode, preparedImage, processingProvider, result, setupStep, visibleSourceMaterials.length]
  );

  useEffect(() => {
    const dispose = installPdpUsageLogFlushHandlers();
    logPdpUsage({
      event: "setup.app_opened",
      source: "setup",
      state: {
        appState: "upload",
        setupStep: "upload",
        product: APP_TITLE
      }
    });

    return () => {
      logPdpUsage({
        event: "setup.app_unmounted",
        source: "setup"
      });
      void flushPdpUsageLogs({ preferBeacon: true });
      dispose();
    };
  }, []);

  const previousFlowStateRef = useRef(`${appState}:${setupStep}`);
  useEffect(() => {
    const nextFlowState = `${appState}:${setupStep}`;
    if (previousFlowStateRef.current !== nextFlowState) {
      logSetupEvent("setup.flow_state_changed", {
        from: previousFlowStateRef.current,
        to: nextFlowState
      });
      previousFlowStateRef.current = nextFlowState;
    }
  }, [appState, logSetupEvent, setupStep]);

  const lastLoggedErrorRef = useRef("");
  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    const errorKey = `${errorMessage}\n${errorDetail}`;
    if (lastLoggedErrorRef.current === errorKey) {
      return;
    }

    lastLoggedErrorRef.current = errorKey;
    logSetupEvent(
      "setup.error_visible",
      {
        message: errorMessage,
        hasDetail: Boolean(errorDetail)
      },
      "warn",
      errorDetail || errorMessage
    );
  }, [errorDetail, errorMessage, logSetupEvent]);

  const refreshDrafts = useCallback(async () => {
    setIsLoadingDrafts(true);
    try {
      setDrafts(await listPdpDrafts());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "저장된 작업 목록을 불러오지 못했습니다.");
      logSetupEvent("setup.draft_list_failed", undefined, "warn", error instanceof Error ? error : String(error));
    } finally {
      setIsLoadingDrafts(false);
    }
  }, [logSetupEvent]);

  const scrollErrorIntoView = () => {
    requestAnimationFrame(() => {
      document.getElementById("pdp-error-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const returnToDetailsWithError = (message: string, detail?: string) => {
    setAppState("upload");
    setSetupStep("details");
    setLoadingStartedAt(null);
    setLoadingProgress(0);
    setErrorMessage(message);
    setErrorDetail(detail ?? "");
    setShowErrorDetail(false);
    scrollErrorIntoView();
  };

  const ensureAnalysisSafePreparedImage = async (image: PreparedImage) => {
    if (!needsPreparedImageReoptimization(image)) {
      return image;
    }

    setLoadingStep("큰 이미지를 분석용 크기로 정리하는 중입니다.");
    logSetupEvent("setup.primary_image_reoptimization_started", {
      image: summarizePreparedImageForUsageLog(image)
    });

    try {
      const nextImage = await reoptimizePreparedImagePayload(image, { allowLongPageSampling: true });
      setPreparedImage(nextImage);
      setNotice(buildPreparedImageNotice(nextImage.fileName, nextImage));
      logSetupEvent("setup.primary_image_reoptimized", {
        before: summarizePreparedImageForUsageLog(image),
        after: summarizePreparedImageForUsageLog(nextImage)
      });
      return nextImage;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logSetupEvent(
        "setup.primary_image_reoptimization_failed",
        { image: summarizePreparedImageForUsageLog(image) },
        "error",
        error instanceof Error ? error : String(error)
      );
      returnToDetailsWithError("업로드 이미지가 너무 커서 분석용 이미지로 변환하지 못했습니다. 이미지를 조금 줄여 다시 업로드해 주세요.", detail);
      return null;
    }
  };

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  useEffect(() => {
    const nextSettings = loadPdpClientSettings();
    setClientSettings(nextSettings);
    setAiProvider(clientPreferredProvider(nextSettings));
  }, []);

  useEffect(() => {
    setKnowledgeItems(loadKnowledgeItems());
    setIsKnowledgeHydrated(true);
  }, []);

  useEffect(() => {
    if (!isKnowledgeHydrated) {
      return;
    }

    try {
      window.localStorage.setItem(KNOWLEDGE_STORAGE_KEY, JSON.stringify(knowledgeItems));
    } catch {
      setNotice("지식파일 텍스트가 커서 일부 저장에 실패했습니다. 파일 수나 크기를 줄여주세요.");
    }
  }, [isKnowledgeHydrated, knowledgeItems]);

  useEffect(() => {
    if (window.localStorage.getItem(NOTICE_DISMISSED_STORAGE_KEY) === "true") {
      return;
    }
    setIsNoticeModalOpen(true);
  }, []);

  useEffect(() => {
    if (isApplyingDraftRef.current || !hasDraftContent) {
      return;
    }

    setIsDirty(true);
    setSaveState((current) => (current === "saved" ? "idle" : current));
  }, [additionalInfo, aiProvider, appState, aspectRatio, customerReviewAnalysis, customerReviewSource, desiredTone, editorDraftState, hasDraftContent, modelImage, modelImageUsage, outputMode, preparedImage, result, sourceMaterials]);

  const handleSourceMaterialFiles = async (files: File[]) => {
    const selectedFiles = files.slice(0, MAX_SOURCE_MATERIAL_FILES);
    const skippedCount = Math.max(0, files.length - selectedFiles.length);

    if (!selectedFiles.length) {
      return;
    }

    logSetupEvent("setup.source_materials_selected", {
      totalCount: files.length,
      acceptedCount: selectedFiles.length,
      skippedCount,
      files: selectedFiles.map(summarizeFileForUsageLog)
    });
    setIsReadingSourceMaterials(true);
    setErrorMessage("");
    setErrorDetail("");
    setShowErrorDetail(false);
    setNotice("업로드 자료를 읽고 분석용으로 정리하는 중입니다.");

    try {
      const rejectedFile = selectedFiles.find((file) => !isSupportedSourceMaterialFile(file));
      if (rejectedFile) {
        setErrorMessage("처음 등록 자료는 이미지 파일 또는 PDF만 업로드할 수 있습니다.");
        logSetupEvent("setup.source_materials_rejected", summarizeFileForUsageLog(rejectedFile), "warn");
        return;
      }

      const nextMaterials = await Promise.all(selectedFiles.map((file) => prepareSourceMaterialFile(file)));
      // MERGE with already-registered materials instead of replacing them: the guidance banner
      // tells users to ADD a product photo to what they uploaded, so a second drop must not
      // wipe the first. Re-dropping the same file (name+size) replaces its previous entry.
      // getVisibleSourceMaterials also covers legacy drafts whose materials array is empty but
      // whose primary image exists — without it, adding a photo would silently drop the page.
      // When the 8-slot cap overflows, the NEW files win (the added product photo is the point).
      const incomingKeys = new Set(nextMaterials.map((material) => `${material.fileName}:${material.size ?? 0}`));
      const retainedMaterials = getVisibleSourceMaterials(sourceMaterials, preparedImage).filter(
        (existing) => !incomingKeys.has(`${existing.fileName}:${existing.size ?? 0}`)
      );
      const retainedCapacity = Math.max(0, MAX_SOURCE_MATERIAL_FILES - Math.min(nextMaterials.length, MAX_SOURCE_MATERIAL_FILES));
      const mergedMaterials = [...retainedMaterials.slice(0, retainedCapacity), ...nextMaterials].slice(
        0,
        MAX_SOURCE_MATERIAL_FILES
      );
      const mergedSkippedCount =
        skippedCount + Math.max(0, retainedMaterials.length + nextMaterials.length - mergedMaterials.length);
      const primaryMaterial = pickPrimarySourceMaterial(mergedMaterials);

      if (!primaryMaterial?.preparedImage) {
        setErrorMessage("분석에 사용할 수 있는 이미지/PDF 대표 화면을 만들지 못했습니다.");
        logSetupEvent("setup.source_materials_empty", { count: selectedFiles.length }, "warn");
        return;
      }

      const normalizedMaterials = markPrimarySourceMaterial(mergedMaterials, primaryMaterial.id, primaryMaterial.preparedImage);
      const contextGuidance = buildUploadContextGuidance(normalizedMaterials, additionalInfo);
      setPreparedImage(primaryMaterial.preparedImage);
      setSourceMaterials(normalizedMaterials);
      setNotice(
        contextGuidance?.tone === "warning"
          ? `${buildSourceMaterialsNotice(normalizedMaterials, mergedSkippedCount)} ${contextGuidance.message}`
          : buildSourceMaterialsNotice(normalizedMaterials, mergedSkippedCount)
      );
      logSetupEvent("setup.source_materials_prepared", {
        totalCount: normalizedMaterials.length,
        skippedCount: mergedSkippedCount,
        imageCount: normalizedMaterials.filter((material) => material.kind === "image").length,
        pdfCount: normalizedMaterials.filter((material) => material.kind === "pdf").length,
        primary: summarizePreparedImageForUsageLog(primaryMaterial.preparedImage),
        contextGuidance: contextGuidance?.reason ?? "none"
      });
    } catch (error) {
      // Do NOT wipe already-registered materials: with merge semantics a failed ADD (e.g. a
      // HEIC/corrupt product photo added per the guidance banner) must not nuke the detail
      // pages the user uploaded first. Keep existing state and surface the failure.
      setErrorMessage(
        sourceMaterials.length
          ? "새로 추가한 자료를 읽지 못했습니다. 기존에 등록한 자료는 그대로 유지됩니다."
          : error instanceof Error
            ? error.message
            : "업로드 자료를 준비하지 못했습니다."
      );
      setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      logSetupEvent("setup.source_materials_prepare_failed", { count: selectedFiles.length }, "error", error instanceof Error ? error : String(error));
    } finally {
      setIsReadingSourceMaterials(false);
    }
  };

  const handleModelImage = async (file: File) => {
    logSetupEvent("setup.model_image_selected", summarizeFileForUsageLog(file));
    try {
      if (!file.type.startsWith("image/")) {
        setErrorMessage("이미지 파일만 업로드할 수 있습니다.");
        logSetupEvent("setup.model_image_rejected", summarizeFileForUsageLog(file), "warn");
        return;
      }

      const nextImage = await prepareImageFile(file, { allowLongPageSampling: false });
      setModelImage(nextImage);
      setModelImageUsage(null);
      setErrorMessage("");
      setErrorDetail("");
      setShowErrorDetail(false);
      setNotice(`${file.name} 모델 이미지를 원본 품질로 준비했습니다. 히어로우 전용 또는 전체 일관성 유지 방식을 선택해 주세요.`);
      logSetupEvent("setup.model_image_prepared", {
        file: summarizeFileForUsageLog(file),
        image: summarizePreparedImageForUsageLog(nextImage)
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "모델 이미지를 준비하지 못했습니다.");
      setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      logSetupEvent("setup.model_image_prepare_failed", summarizeFileForUsageLog(file), "error", error instanceof Error ? error : String(error));
    }
  };

  const getCustomerReviewAnalyzerLabel = () => (effectiveOpenAiApiKey ? "ChatGPT" : "Codex CLI");

  const analyzeCustomerReviewSource = async (source: PdpCustomerReviewSource) => {
    const currentOpenAiApiKey = effectiveOpenAiApiKey;
    const analyzerLabel = getCustomerReviewAnalyzerLabel();

    setIsAnalyzingCustomerReviews(true);
    setCustomerReviewAnalysisError("");
    setNotice(`고객 후기 파일을 ${analyzerLabel}로 분석하고 있습니다.`);
    logSetupEvent("setup.customer_review_ai_analysis_started", {
      fileName: source.fileName,
      reviewCount: source.reviewCount,
      sampledReviewCount: source.sampledReviewCount ?? source.reviews.length,
      model: currentOpenAiApiKey ? "gpt-5.4-mini" : "codex-cli"
    });

    try {
      const response = await apiJson<PdpAnalyzeCustomerReviewsResponse>(
        "/pdp/customer-reviews/analyze",
        {
          method: "POST",
          body: JSON.stringify({
            source,
            productContext: additionalInfo.trim() || undefined,
            desiredTone: desiredTone.trim() || undefined
          })
        },
        { openAiApiKey: currentOpenAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS }
      );

      if (!response.ok) {
        const message =
          response.code === "OPENAI_MODEL_ACCESS_DENIED"
            ? "현재 OpenAI API 키로는 gpt-5.4-mini 후기 분석 모델에 접근할 수 없습니다. OpenAI 모델 접근 권한을 확인해 주세요."
            : response.message;
        setCustomerReviewAnalysisError(message);
        setNotice(message);
        logSetupEvent(
          "setup.customer_review_ai_analysis_failed",
          {
            code: response.code,
            reviewCount: source.reviewCount,
            sampledReviewCount: source.sampledReviewCount ?? source.reviews.length
          },
          "error",
          response.detail || response.message
        );
        return;
      }

      setCustomerReviewAnalysis(response.analysis);
      setCustomerReviewAnalysisError("");
      setNotice(`${analyzerLabel}가 후기 파일을 분석했습니다. 결과를 확인한 뒤 다음 단계로 넘어가세요.`);
      logSetupEvent("setup.customer_review_ai_analysis_completed", {
        reviewCount: response.analysis.reviewCount,
        sampledReviewCount: response.analysis.sampledReviewCount ?? response.analysis.reviewCount,
        model: response.model,
        topBenefitCount: response.analysis.topBenefits.length,
        painPointCount: response.analysis.painPoints.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : `${analyzerLabel} 후기 분석 중 오류가 발생했습니다.`;
      setCustomerReviewAnalysisError(message);
      setNotice(message);
      logSetupEvent(
        "setup.customer_review_ai_analysis_failed",
        {
          reviewCount: source.reviewCount,
          sampledReviewCount: source.sampledReviewCount ?? source.reviews.length
        },
        "error",
        error instanceof Error ? error : String(error)
      );
    } finally {
      setIsAnalyzingCustomerReviews(false);
    }
  };

  const handleCustomerReviewFile = async (file: File) => {
    logSetupEvent("setup.customer_review_file_selected", summarizeFileForUsageLog(file));
    setIsReadingCustomerReviews(true);
    setCustomerReviewSource(null);
    setCustomerReviewAnalysis(null);
    setCustomerReviewAnalysisError("");
    setErrorMessage("");
    setErrorDetail("");
    setShowErrorDetail(false);

    try {
      if (!isSupportedCustomerReviewFile(file)) {
        setErrorMessage("고객 후기는 .xlsx, .csv, .tsv, .txt 파일만 업로드할 수 있습니다.");
        logSetupEvent("setup.customer_review_file_rejected", summarizeFileForUsageLog(file), "warn");
        return;
      }

      const rows = uniqueReviewRows(await extractCustomerReviewRows(file));

      if (!rows.length) {
        setErrorMessage("후기 파일에서 읽을 수 있는 후기 문장을 찾지 못했습니다. 후기/리뷰/내용 컬럼이 있는 파일을 올려주세요.");
        logSetupEvent("setup.customer_review_file_empty", summarizeFileForUsageLog(file), "warn");
        return;
      }

      const sampledRows = sampleCustomerReviewRowsEvenly(rows, CUSTOMER_REVIEW_ANALYSIS_SAMPLE_SIZE);
      const source: PdpCustomerReviewSource = {
        fileName: file.name.slice(0, 120),
        reviewCount: rows.length,
        sampledReviewCount: sampledRows.length,
        reviews: sampledRows.map((row) => ({
          text: row.text,
          rating: row.rating
        }))
      };

      setCustomerReviewSource(source);
      setNotice(`고객 후기 파일을 준비했습니다. ${getCustomerReviewAnalyzerLabel()} 분석 결과를 확인한 뒤 다음 단계로 넘어갑니다.`);
      logSetupEvent("setup.customer_review_file_parsed", {
        file: summarizeFileForUsageLog(file),
        reviewCount: source.reviewCount,
        sampledReviewCount: source.sampledReviewCount,
        analyzer: hasAvailableOpenAiKey ? "openai" : "codex-cli"
      });

      await analyzeCustomerReviewSource(source);
    } catch (error) {
      setCustomerReviewSource(null);
      setCustomerReviewAnalysis(null);
      setErrorMessage(error instanceof Error ? error.message : "고객 후기 파일을 읽지 못했습니다.");
      setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      logSetupEvent("setup.customer_review_file_failed", summarizeFileForUsageLog(file), "error", error instanceof Error ? error : String(error));
    } finally {
      setIsReadingCustomerReviews(false);
    }
  };

  const clearCustomerReviewAnalysis = () => {
    setCustomerReviewSource(null);
    setCustomerReviewAnalysis(null);
    setCustomerReviewAnalysisError("");
    if (customerReviewInputRef.current) {
      customerReviewInputRef.current.value = "";
    }
    setNotice("고객 후기 입력을 제거했습니다.");
    logSetupEvent("setup.customer_review_file_cleared");
  };

  const buildDraftInput = useCallback(() => {
    if (!hasDraftContent) {
      return null;
    }

    return {
      id: activeDraftId ?? undefined,
      createdAt: draftCreatedAt ?? undefined,
      appState: result ? "editor" : appState === "processing" ? "upload" : appState,
      preparedImage,
      sourceMaterials: getSourceMaterialsForDraft(sourceMaterials, preparedImage),
      modelImage,
      modelImageUsage,
      result,
      additionalInfo,
      customerReviewAnalysis,
      desiredTone,
      aspectRatio,
      aiProvider,
      sourceMode: "auto" as const,
      outputMode,
      sectionCount: result?.blueprint.sections.length ?? INITIAL_HERO_SECTION_COUNT,
      benefits: [],
      notice: editorDraftState?.notice ?? notice,
      editorState: result ? editorDraftState ?? createDefaultEditorDraftState(result, outputMode) : null,
      longPageTranscript: longPageTranscript ?? undefined,
      // Complete iff it matches the cached (complete-only) transcript; refs are stable, no dep.
      longPageTranscriptComplete: longPageTranscript
        ? longPageTranscriptCacheRef.current?.transcript === longPageTranscript
        : undefined,
      longPageTranscriptKey:
        longPageTranscript && longPageTranscriptCacheRef.current?.transcript === longPageTranscript
          ? longPageTranscriptCacheRef.current.key
          : undefined
    };
  }, [activeDraftId, additionalInfo, aiProvider, appState, aspectRatio, customerReviewAnalysis, desiredTone, draftCreatedAt, editorDraftState, hasDraftContent, longPageTranscript, modelImage, modelImageUsage, notice, outputMode, preparedImage, result, sourceMaterials]);

  const persistDraft = useCallback(
    async (mode: "manual" | "auto" | "switch" = "manual", options?: { showToast?: boolean }) => {
      const input = buildDraftInput();
      if (!input || saveInFlightRef.current) {
        return null;
      }

      saveInFlightRef.current = true;
      setSaveState("saving");

      try {
        const savedDraft = await savePdpDraft(input);
        isApplyingDraftRef.current = true;
        setActiveDraftId(savedDraft.id);
        setDraftCreatedAt(savedDraft.createdAt);
        setLastSavedAt(savedDraft.updatedAt);
        setSaveState("saved");
        setIsDirty(false);
        if (mode === "manual") {
          setNotice("현재 작업을 저장했습니다. 시작 화면에서 이어서 작업할 수 있습니다.");
          if (options?.showToast) {
            setManualSaveToastToken(Date.now());
          }
        }
        await refreshDrafts();
        if (mode !== "auto") {
          logSetupEvent("setup.draft_saved", {
            mode,
            hasResult: Boolean(input.result),
            sectionCount: input.sectionCount
          });
        }
        return savedDraft;
      } catch (error) {
        setSaveState("error");
        setErrorMessage("작업을 저장하지 못했습니다.");
        setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        logSetupEvent("setup.draft_save_failed", { mode }, "error", error instanceof Error ? error : String(error));
        return null;
      } finally {
        saveInFlightRef.current = false;
        requestAnimationFrame(() => {
          isApplyingDraftRef.current = false;
        });
      }
    },
    [buildDraftInput, logSetupEvent, refreshDrafts]
  );

  const confirmSaveBeforeLeaving = useCallback(async () => {
    if (!isDirty || !hasDraftContent) {
      return true;
    }

    const shouldSave = window.confirm("저장되지 않은 작업이 있습니다.\n확인: 저장 후 이동\n취소: 저장하지 않고 이동");
    if (!shouldSave) {
      return true;
    }

    const savedDraft = await persistDraft("manual");
    return Boolean(savedDraft);
  }, [hasDraftContent, isDirty, persistDraft]);

  const resetWorkspace = useCallback(() => {
    isApplyingDraftRef.current = true;
    setAppState("upload");
    setSetupStep("upload");
    setIsDraftsOpen(false);
    setPreparedImage(null);
    setSourceMaterials([]);
    setModelImage(null);
    setModelImageUsage(null);
    setResult(null);
    setLongPageTranscript(null);
    longPageTranscriptCacheRef.current = null;
    setAdditionalInfo("");
    setCustomerReviewSource(null);
    setCustomerReviewAnalysis(null);
    setCustomerReviewAnalysisError("");
    if (customerReviewInputRef.current) {
      customerReviewInputRef.current.value = "";
    }
    setDesiredTone("");
    setAspectRatio("9:16");
    setAiProvider(clientPreferredProvider(clientSettings));
    setOutputMode("full-image");
    setNotice("새 이미지로 다시 시작할 수 있습니다.");
    setErrorMessage("");
    setErrorDetail("");
    setShowErrorDetail(false);
    setEditorDraftState(null);
    setActiveDraftId(null);
    setDraftCreatedAt(null);
    setLastSavedAt(null);
    setSaveState("idle");
    setIsDirty(false);
    setEditorSessionKey((current) => current + 1);
    logSetupEvent("setup.workspace_reset");
    requestAnimationFrame(() => {
      isApplyingDraftRef.current = false;
    });
  }, [clientSettings, logSetupEvent]);

  const handleLoadDraft = useCallback(
    async (draftId: string) => {
      logSetupEvent("setup.draft_load_requested", {
        draftIdPresent: Boolean(draftId)
      });
      const canContinue = await confirmSaveBeforeLeaving();
      if (!canContinue) {
        logSetupEvent("setup.draft_load_cancelled_unsaved_changes");
        return;
      }

      setIsLoadingDraft(true);
      setErrorMessage("");
      setErrorDetail("");
      setShowErrorDetail(false);

      try {
        const draft = await getPdpDraft(draftId);
        if (!draft) {
          setErrorMessage("저장된 작업을 찾지 못했습니다.");
          logSetupEvent("setup.draft_load_not_found", undefined, "warn");
          await refreshDrafts();
          return;
        }

        isApplyingDraftRef.current = true;
        setActiveDraftId(draft.id);
        setDraftCreatedAt(draft.createdAt);
        setLastSavedAt(draft.updatedAt);
        setPreparedImage(draft.preparedImage);
        setSourceMaterials(draft.sourceMaterials ?? []);
        setModelImage(draft.modelImage ?? null);
        setModelImageUsage(draft.modelImageUsage ?? null);
        setResult(draft.result);
        setLongPageTranscript(draft.longPageTranscript ?? null);
        // Seed the re-analysis cache so regenerating a restored draft reuses the paid pass-1
        // transcript. STORED key only (captured when the transcript was made) — recomputing
        // from the restored pages would claim coverage of pages added AFTER transcription and
        // silently skip them forever.
        longPageTranscriptCacheRef.current =
          draft.longPageTranscript && draft.longPageTranscriptComplete && draft.longPageTranscriptKey
            ? {
                key: draft.longPageTranscriptKey,
                transcript: draft.longPageTranscript,
                batchCount: 0
              }
            : null;
        setAdditionalInfo(draft.additionalInfo);
        setCustomerReviewSource(null);
        setCustomerReviewAnalysis(draft.customerReviewAnalysis);
        setCustomerReviewAnalysisError("");
        setDesiredTone(draft.desiredTone);
        setAspectRatio(draft.aspectRatio);
        setAiProvider(draft.aiProvider);
        setOutputMode(draft.outputMode);
        setNotice(draft.notice);
        setEditorDraftState(draft.editorState);
        setSetupStep(draft.preparedImage ? "details" : "upload");
        setAppState(draft.result ? "editor" : "upload");
        setSaveState("saved");
        setIsDirty(false);
        setIsDraftsOpen(false);
        setEditorSessionKey((current) => current + 1);
        logSetupEvent("setup.draft_loaded", {
          hasResult: Boolean(draft.result),
          sectionCount: draft.result?.blueprint.sections.length ?? 0,
          outputMode: draft.outputMode,
          hasModelImage: Boolean(draft.modelImage),
          hasCustomerReviews: Boolean(draft.customerReviewAnalysis)
        });
      } catch (error) {
        setErrorMessage("저장된 작업을 불러오지 못했습니다.");
        setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        logSetupEvent("setup.draft_load_failed", undefined, "error", error instanceof Error ? error : String(error));
      } finally {
        requestAnimationFrame(() => {
          isApplyingDraftRef.current = false;
          setIsLoadingDraft(false);
        });
      }
    },
    [confirmSaveBeforeLeaving, logSetupEvent, refreshDrafts]
  );

  const handleDeleteDraft = useCallback(
    async (draftId: string) => {
      const shouldDelete = window.confirm("이 저장된 작업을 삭제할까요?");
      if (!shouldDelete) {
        logSetupEvent("setup.draft_delete_cancelled");
        return;
      }

      try {
        await deletePdpDraft(draftId);
        if (activeDraftId === draftId) {
          resetWorkspace();
        }
        await refreshDrafts();
        logSetupEvent("setup.draft_deleted", {
          deletedActiveDraft: activeDraftId === draftId
        });
      } catch (error) {
        setErrorMessage("저장된 작업을 삭제하지 못했습니다.");
        setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        logSetupEvent("setup.draft_delete_failed", undefined, "error", error instanceof Error ? error : String(error));
      }
    },
    [activeDraftId, logSetupEvent, refreshDrafts, resetWorkspace]
  );

  useEffect(() => {
    if (!isDirty || !hasDraftContent) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasDraftContent, isDirty]);

  useEffect(() => {
    if (!hasDraftContent) {
      return;
    }

    const timer = window.setInterval(() => {
      if (!isDirty) {
        return;
      }

      void persistDraft("auto");
    }, 30000);

    return () => window.clearInterval(timer);
  }, [hasDraftContent, isDirty, persistDraft]);

  useEffect(() => {
    if (appState !== "processing" || !loadingStartedAt) {
      return;
    }

    const tick = () => {
      const elapsedSeconds = Math.max(0, (Date.now() - loadingStartedAt) / 1000);
      const progressRatio = 1 - Math.exp(-elapsedSeconds / Math.max(24, estimatedProcessingSeconds * 0.46));
      setLoadingProgress(Math.min(94, Math.max(3, Math.round(progressRatio * 94))));
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [appState, estimatedProcessingSeconds, loadingStartedAt]);

  useEffect(() => {
    if (appState !== "processing") {
      return;
    }

    let isCancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), WAITING_VIDEO_CLIENT_TIMEOUT_MS);
    setIsLoadingWaitingVideo(true);
    setWaitingVideo(DEFAULT_WAITING_VIDEO);

    void fetch("/api/pdp/waiting-video", { signal: controller.signal })
      .then((response) => response.json())
      .then((payload: { ok?: boolean; video?: WaitingVideo | null }) => {
        if (!isCancelled && payload.ok && payload.video) {
          setWaitingVideo(payload.video);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setWaitingVideo(DEFAULT_WAITING_VIDEO);
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingWaitingVideo(false);
        }
        window.clearTimeout(timeout);
      });

    return () => {
      isCancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [appState]);

  /**
   * Pass-1 of the 2-pass long-page analysis: run the strips through /pdp/transcribe-strips in
   * sequential batches (each request stays under Vercel's body limit) and stitch the verbatim
   * transcripts. Failures stay VISIBLE: a failed batch leaves an explicit marker in the
   * transcript and is counted, never silently skipped.
   */
  const transcribeLongPageStrips = async ({
    strips,
    provider,
    geminiApiKey,
    openAiApiKey,
    pageIndex = 0,
    pageCount = 1
  }: {
    strips: PdpAnalysisStrip[];
    provider: PdpAiProvider;
    geminiApiKey?: string | null;
    openAiApiKey?: string | null;
    pageIndex?: number;
    pageCount?: number;
  }): Promise<{ transcript: string | null; failedBatchCount: number; batchCount: number; truncated: boolean; fatal: boolean }> => {
    // Greedy batching by count AND payload size: a batch closes at 6 strips or ~2.6MB of
    // base64, whichever comes first, so wide-strip pages never 413 at the Vercel edge.
    const batches: PdpAnalysisStrip[][] = [];
    let currentBatch: PdpAnalysisStrip[] = [];
    let currentBatchChars = 0;
    for (const strip of strips) {
      const stripChars = strip.base64.length;
      const batchFull =
        currentBatch.length >= TRANSCRIBE_STRIPS_PER_BATCH ||
        (currentBatch.length > 0 && currentBatchChars + stripChars > TRANSCRIBE_BATCH_MAX_BASE64_CHARS);
      if (batchFull) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchChars = 0;
      }
      currentBatch.push(strip);
      currentBatchChars += stripChars;
    }
    if (currentBatch.length) {
      batches.push(currentBatch);
    }

    const parts: string[] = [];
    let failedBatchCount = 0;
    let previousSectionHint: string | undefined;
    let fatalError = false;

    for (let index = 0; index < batches.length && !fatalError; index += 1) {
      setLoadingStep(
        pageCount > 1
          ? `상세페이지 원문을 받아쓰는 중입니다 (자료 ${pageIndex + 1}/${pageCount} · 구간 ${index + 1}/${batches.length}).`
          : `상세페이지 원문을 받아쓰는 중입니다 (${index + 1}/${batches.length}).`
      );
      // Functional max keeps the bar monotonic against the elapsed-time ticker; the 10..38
      // span is split across pages, then across batches within the page.
      const pageSpan = 28 / pageCount;
      const targetProgress = Math.min(38, 10 + Math.round(pageIndex * pageSpan + (index / batches.length) * pageSpan));
      setLoadingProgress((current) => Math.max(current, targetProgress));

      let batchTranscript: string | null = null;
      for (let attempt = 0; attempt < 2 && batchTranscript === null && !fatalError; attempt += 1) {
        try {
          const response = await apiJson<PdpTranscribeStripsResponse>("/pdp/transcribe-strips", {
            method: "POST",
            body: JSON.stringify({
              aiProvider: provider,
              strips: batches[index],
              batchIndex: index,
              batchCount: batches.length,
              previousSectionHint
            })
          }, { geminiApiKey, openAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS });

          if (!response.ok) {
            // Key/quota/access errors won't heal on retry — abort the whole pass instead of
            // burning attempt slots per batch; the analyze call surfaces the same error next.
            if (response.code && TRANSCRIBE_FATAL_ERROR_CODES.has(response.code)) {
              fatalError = true;
              logSetupEvent(
                "setup.long_page_transcribe_aborted",
                { batchIndex: index, batchCount: batches.length, code: response.code },
                "warn",
                response.detail || response.message
              );
              break;
            }
            throw new Error(response.detail ? `${response.message}\n${response.detail}` : response.message);
          }
          batchTranscript = response.transcript;
          previousSectionHint = response.lastSectionType;
        } catch (error) {
          if (attempt === 1) {
            failedBatchCount += 1;
            logSetupEvent(
              "setup.long_page_transcribe_batch_failed",
              { batchIndex: index, batchCount: batches.length },
              "warn",
              error instanceof Error ? error : String(error)
            );
          }
        }
      }

      if (fatalError) {
        break;
      }

      parts.push(
        batchTranscript ??
          `### 구간 배치 ${index + 1}/${batches.length}\n(전사 실패 — 이 구간은 스트립 이미지 판독으로만 분석됩니다.)`
      );
    }

    if (fatalError || failedBatchCount >= batches.length) {
      return {
        transcript: null,
        failedBatchCount: fatalError ? batches.length : failedBatchCount,
        batchCount: batches.length,
        truncated: false,
        fatal: fatalError
      };
    }

    const joined = parts.join("\n\n");
    const truncated = joined.length > TRANSCRIBE_MAX_TRANSCRIPT_CHARS;
    return {
      transcript: truncated
        ? `${joined.slice(0, TRANSCRIBE_MAX_TRANSCRIPT_CHARS)}\n(후략 — 분량 제한으로 하단 일부 구간이 생략됨)`
        : joined,
      failedBatchCount,
      batchCount: batches.length,
      truncated,
      fatal: false
    };
  };

  /**
   * Transcribe EVERY long page in the upload set (primary + supporting, capped at
   * MAX_TRANSCRIBE_PAGES). Without this, a detail page split across several captures loses
   * every page but the first — measured on a real 3-capture run where 2/3 of the content
   * never reached the model.
   */
  const transcribeLongPages = async ({
    pages,
    provider,
    geminiApiKey,
    openAiApiKey
  }: {
    pages: TranscriptionPage[];
    provider: PdpAiProvider;
    geminiApiKey?: string | null;
    openAiApiKey?: string | null;
  }): Promise<{ transcript: string | null; failedBatchCount: number; batchCount: number; truncated: boolean }> => {
    const parts: string[] = [];
    let failedBatchCount = 0;
    let batchCount = 0;
    let truncated = false;

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      const result = await transcribeLongPageStrips({
        strips: page.strips,
        provider,
        geminiApiKey,
        openAiApiKey,
        pageIndex,
        pageCount: pages.length
      });
      failedBatchCount += result.failedBatchCount;
      batchCount += result.batchCount;
      truncated = truncated || result.truncated;
      // File-name-only headers: numbering here would collide with the analyze prompt's own
      // "자료 N" numbering (upload order ≠ transcription order) and mislead materialIndex picks.
      if (result.transcript) {
        parts.push(pages.length > 1 ? `# [업로드 자료: ${page.label}]\n${result.transcript}` : result.transcript);
      } else {
        parts.push(`# [업로드 자료: ${page.label}]\n(이 자료는 전사에 실패해 이미지 판독으로만 분석됩니다.)`);
      }
      if (result.fatal) {
        // Key/quota errors hit every subsequent call too — stop instead of burning more time.
        const remaining = pages.length - pageIndex - 1;
        if (remaining > 0) {
          failedBatchCount += remaining;
          batchCount += remaining;
          parts.push(`(남은 자료 ${remaining}개는 동일 오류가 예상되어 전사를 중단했습니다.)`);
        }
        break;
      }
    }

    const successfulParts = parts.length > 0 && failedBatchCount < batchCount;
    if (!successfulParts) {
      return { transcript: null, failedBatchCount, batchCount, truncated: false };
    }

    const joined = parts.join("\n\n");
    if (joined.length > TRANSCRIBE_MAX_TRANSCRIPT_CHARS) {
      return {
        transcript: `${joined.slice(0, TRANSCRIBE_MAX_TRANSCRIPT_CHARS)}\n(후략 — 분량 제한으로 일부 자료 하단이 생략됨)`,
        failedBatchCount,
        batchCount,
        truncated: true
      };
    }
    return { transcript: joined, failedBatchCount, batchCount, truncated };
  };

  const generateMissingSectionImages = async ({
    result,
    provider,
    geminiApiKey,
    openAiApiKey
  }: {
    result: GeneratedResult;
    provider: PdpAiProvider;
    geminiApiKey?: string | null;
    openAiApiKey?: string | null;
  }): Promise<SectionImageBatchResult> => {
    const nextSections = result.blueprint.sections.map((section) => ({ ...section }));
    const sectionsToGenerate = nextSections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => !section.generatedImage);

    if (!sectionsToGenerate.length) {
      setLoadingProgress(92);
      logSetupEvent("setup.section_image_batch_skipped", {
        reason: "all_sections_already_generated",
        sectionCount: nextSections.length
      });
      return {
        result,
        failedCount: 0,
        errorMessage: "",
        errorDetail: ""
      };
    }

    const providerLabel = AI_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? selectedProviderLabel;
    const modeLabel = outputMode === "full-image" ? "통이미지 모드" : "텍스트편집 모드";
    const batchStartedAt = Date.now();
    let completedCount = nextSections.filter((section) => Boolean(section.generatedImage)).length;
    const totalCount = Math.max(nextSections.length, 1);
    const updateBatchProgress = () => {
      setLoadingProgress(Math.min(94, 48 + Math.round((completedCount / totalCount) * 44)));
    };

    setLoadingStep(`${providerLabel}로 ${modeLabel} 미생성 섹션 이미지를 생성하는 중입니다.`);
    updateBatchProgress();
    logSetupEvent("setup.section_image_batch_started", {
      provider,
      outputMode,
      sectionsToGenerate: sectionsToGenerate.length,
      totalSections: nextSections.length,
      withReferenceModel: Boolean(modelImage)
    });

    const generatedSections = await Promise.allSettled(
      sectionsToGenerate.map(async ({ section, index }) => {
        const sectionImageDefaults = getPdpSectionImageDefaults(section, index, nextSections.length, modelImageUsage);
        const shouldUseReferenceModel = Boolean(
          modelImage &&
            sectionImageDefaults.withModel &&
            (modelImageUsage === "all-sections" || (modelImageUsage === "hero-only" && index === 0))
        );
        // An ungenerated hero only reaches this batch as the deferred-hero fallback (the normal
        // flow arrives with sections[0] already generated). Mirror the server analyze path's
        // hero options — always a model cut with the same persona defaults — so a fallback hero
        // looks like a first-attempt hero, not a bare product shot.
        const isDeferredHeroFallback = index === 0;
        const response = await apiJson<PdpGenerateImageResponse>("/pdp/images", {
          method: "POST",
          body: JSON.stringify({
            originalImageBase64: result.originalImage,
            originalImageMimeType: result.originalImageMimeType,
            originalImageFileName: result.originalImageFileName,
            section,
            aspectRatio,
            desiredTone: desiredTone.trim() || undefined,
            options: {
              aiProvider: provider,
              outputMode,
              style: isDeferredHeroFallback ? "studio" : sectionImageDefaults.style,
              withModel: isDeferredHeroFallback ? true : shouldUseReferenceModel,
              ...(isDeferredHeroFallback
                ? { modelGender: "female", modelAgeRange: "20s", modelCountry: "korea" }
                : {}),
              guidePriorityMode: isDeferredHeroFallback ? "guide-first" : sectionImageDefaults.guidePriorityMode,
              headline: section.headline,
              subheadline: section.subheadline,
              referenceModelImageBase64: shouldUseReferenceModel ? modelImage?.base64 : undefined,
              referenceModelImageMimeType: shouldUseReferenceModel ? modelImage?.mimeType : undefined,
              referenceModelImageFileName: shouldUseReferenceModel ? modelImage?.fileName : undefined
            }
          })
        }, { geminiApiKey, openAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS });

        if (!response.ok) {
          const sectionLabel = section.section_name || `섹션 ${index + 1}`;
          throw new Error(response.detail ? `${sectionLabel}: ${response.message}\n${response.detail}` : `${sectionLabel}: ${response.message}`);
        }

        completedCount += 1;
        updateBatchProgress();

        return {
          index,
          section: {
            ...section,
            generatedImage: `data:${response.mimeType};base64,${response.imageBase64}`
          }
        };
      })
    );

    const failureMessages: string[] = [];

    generatedSections.forEach((settledResult, settledIndex) => {
      if (settledResult.status === "fulfilled") {
        const { index, section } = settledResult.value;
        nextSections[index] = section;
        return;
      }

      const fallbackSection = sectionsToGenerate[settledIndex]?.section;
      const fallbackLabel = fallbackSection?.section_name || `섹션 ${sectionsToGenerate[settledIndex]?.index ?? settledIndex + 1}`;
      const reason = settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason);
      failureMessages.push(`${fallbackLabel}: ${reason}`);
    });

    const batchSummary = {
      result: {
        ...result,
        blueprint: {
          ...result.blueprint,
          sections: nextSections
        }
      },
      failedCount: failureMessages.length,
      errorMessage: failureMessages.length
        ? `${failureMessages.length}개 섹션 이미지를 만들지 못했습니다. 편집 화면에서 남은 섹션 이미지를 이어서 생성할 수 있습니다.`
        : "",
      errorDetail: failureMessages.join("\n\n")
    };
    logSetupEvent(
      failureMessages.length ? "setup.section_image_batch_partial_failure" : "setup.section_image_batch_completed",
      {
        failedCount: failureMessages.length,
        generatedCount: sectionsToGenerate.length - failureMessages.length,
        totalRequested: sectionsToGenerate.length,
        durationMs: Date.now() - batchStartedAt
      },
      failureMessages.length ? "warn" : "info",
      failureMessages.length ? failureMessages.join("\n\n") : undefined
    );

    return batchSummary;
  };

  const handleAnalyze = async () => {
    if (!preparedImage) {
      setErrorMessage("먼저 제품 이미지 혹은 상세페이지 이미지를 업로드해 주세요.");
      logSetupEvent("setup.analyze_blocked", { reason: "missing_primary_image" }, "warn");
      return;
    }

    const currentGeminiApiKey = effectiveGeminiApiKey;
    const currentOpenAiApiKey = effectiveOpenAiApiKey;

    if (modelImage && !modelImageUsage) {
      setErrorMessage("모델 이미지를 사용할 방식을 먼저 선택해 주세요.");
      logSetupEvent("setup.analyze_blocked", { reason: "missing_model_usage" }, "warn");
      return;
    }

    if (hasPendingCustomerReviewAnalysis) {
      const message = `고객 후기 파일의 ${getCustomerReviewAnalyzerLabel()} 분석이 끝난 뒤 상세페이지 생성을 시작할 수 있습니다.`;
      setCustomerReviewAnalysisError(message);
      setErrorMessage(message);
      setSetupStep("upload");
      logSetupEvent(
        "setup.analyze_blocked",
        {
          reason: "pending_customer_review_analysis",
          reviewCount: customerReviewSource?.reviewCount ?? 0
        },
        "warn"
      );
      return;
    }

    setAppState("processing");
    const analyzeStartedAt = Date.now();
    setLoadingStartedAt(analyzeStartedAt);
    setLoadingProgress(3);
    setErrorMessage("");
    setErrorDetail("");
    setShowErrorDetail(false);
    setLoadingStep(
      selectedProviderUsesCodex
        ? "Codex CLI 연결 상태를 확인하는 중입니다."
        : `입력한 ${selectedProviderLabel} API 키 연결 상태를 확인하는 중입니다.`
    );
    logSetupEvent("setup.analyze_started", {
      provider: processingProvider,
      outputMode,
      aspectRatio,
      desiredToneSelected: Boolean(desiredTone.trim()),
      additionalInfoLength: additionalInfo.trim().length,
      customerReviewCount: customerReviewAnalysis?.reviewCount ?? 0,
      knowledgeCount: knowledgeItems.length,
      sourceMaterialCount: visibleSourceMaterials.length,
      image: summarizePreparedImageForUsageLog(preparedImage),
      hasModelImage: Boolean(modelImage),
      modelImageUsage: modelImageUsage ?? "none"
    });

    try {
      if (selectedProviderUsesCodex) {
        logSetupEvent("setup.codex_cli_selected", {
          provider: processingProvider
        });
      } else {
        const keyValidation =
          processingProvider === "openai"
            ? await validateOpenAiApiKey(currentOpenAiApiKey ?? "")
            : await validateGeminiApiKey(currentGeminiApiKey ?? "");

        if (!keyValidation.ok) {
          logSetupEvent(
            "setup.api_key_validation_failed",
            {
              provider: processingProvider,
              code: "code" in keyValidation ? keyValidation.code : undefined
            },
            "warn",
            keyValidation.detail || keyValidation.message
          );
          returnToDetailsWithError(keyValidation.message, keyValidation.detail);
          return;
        }

        logSetupEvent("setup.api_key_validation_passed", {
          provider: processingProvider
        });
      }

      const imageForAnalyze = await ensureAnalysisSafePreparedImage(preparedImage);
      if (!imageForAnalyze) {
        return;
      }
      const sourceMaterialsForDraft = syncSourceMaterialsWithPrimary(sourceMaterials, imageForAnalyze);
      const sourceMaterialsForAnalyze = buildAnalyzeSourceMaterials(sourceMaterialsForDraft);
      setSourceMaterials(sourceMaterialsForDraft);

      const analyzeBudget = summarizeAnalyzeBudget({
        imageBase64: imageForAnalyze.base64,
        generationImageBase64: imageForAnalyze.generationBase64 ?? imageForAnalyze.base64,
        modelImageBase64: modelImage?.base64,
        sourceImageBase64s: sourceMaterialsForAnalyze
          ?.map((material) => material.imageBase64)
          .filter((value): value is string => Boolean(value)),
        textChars:
          (knowledgeText?.length ?? 0) +
          additionalInfo.length +
          desiredTone.length +
          (customerReviewAnalysis ? JSON.stringify(customerReviewAnalysis).length : 0) +
          (sourceMaterialsForAnalyze?.reduce((sum, material) => sum + (material.text?.length ?? 0), 0) ?? 0)
      });

      if (analyzeBudget.exceeds) {
        // Vercel rejects request bodies over ~4.5MB at the edge (413 FUNCTION_PAYLOAD_TOO_LARGE)
        // before the function runs. Guard here so the user gets a clear reason instead of an opaque
        // failure. Per-image copies are already bounded in prepareImageFile; this catches the case
        // of too many attached images summing past the ceiling.
        logSetupEvent(
          "setup.analyze_payload_over_budget",
          {
            totalBytes: analyzeBudget.totalBytes,
            displayBytes: analyzeBudget.displayBytes,
            budget: analyzeBudget.budget,
            sourceImageCount: sourceMaterialsForAnalyze?.filter((material) => material.imageBase64).length ?? 0
          },
          "warn"
        );
        returnToDetailsWithError(
          `첨부한 이미지 용량이 커서(약 ${formatBytesMb(analyzeBudget.displayBytes)}) 한 번에 분석할 수 없어요. 대표 이미지 1장과 꼭 필요한 보조 이미지만 남기거나, 더 작은 이미지로 올려주세요.`,
          "한 번의 서버 요청에 담을 수 있는 용량(약 4.5MB)을 넘었습니다. 보조 이미지 수를 줄이면 해결됩니다."
        );
        return;
      }

      // 2-pass long-page analysis, pass 1: transcribe the strips verbatim BEFORE the blueprint
      // call, so the blueprint cites the page's actual copy instead of downscaled pixels. Runs
      // after the budget guard (a rejected request must not burn paid transcription calls); the
      // transcript itself adds at most ~60KB of text to the analyze body — noise vs. the budget.
      const analysisStripsForAnalyze = getPreparedImageStrips(imageForAnalyze);
      // Structural access (like getPreparedImageStrips): imageForAnalyze may be a re-optimized
      // payload shape that lacks the session-only sourceFile field.
      const originalSourceFile = (imageForAnalyze as { sourceFile?: File }).sourceFile;
      let longPageTranscriptForAnalyze: string | null = null;
      let transcriptFailedBatchCount = 0;
      let transcriptBatchCount = 0;
      let transcriptTruncated = false;
      let transcriptReused = false;
      const transcriptionPages = selectTranscriptionPages(imageForAnalyze, sourceMaterialsForDraft);
      // Pages beyond the MAX_TRANSCRIBE_PAGES cap are skipped — count them so the completion
      // notice never claims "전부 받아써서" while silently dropping a capture.
      const totalLongPageCandidates =
        (getPreparedImageStrips(imageForAnalyze)?.length ? 1 : 0) +
        sourceMaterialsForDraft.filter(
          (material) =>
            material.role !== "primary" &&
            material.kind === "image" &&
            (material.preparedImage?.analysisStrips?.length ?? 0) > 0
        ).length;
      const transcriptSkippedPages = Math.max(0, totalLongPageCandidates - transcriptionPages.length);
      if (transcriptionPages.length) {
        const stripsCacheKey = buildTranscriptionCacheKey(transcriptionPages);
        const cachedTranscript = longPageTranscriptCacheRef.current;
        if (cachedTranscript && cachedTranscript.key === stripsCacheKey) {
          // Same pages, complete transcript already paid for — reuse instead of re-billing
          // pass 1 on every retry after an analyze failure (429/timeout) or regeneration.
          longPageTranscriptForAnalyze = cachedTranscript.transcript;
          transcriptBatchCount = cachedTranscript.batchCount;
          transcriptReused = true;
          setLongPageTranscript(cachedTranscript.transcript);
          logSetupEvent("setup.long_page_transcript_reused", {
            batchCount: cachedTranscript.batchCount,
            transcriptChars: cachedTranscript.transcript.length
          });
        } else {
          const transcription = await transcribeLongPages({
            pages: transcriptionPages,
            provider: processingProvider,
            geminiApiKey: currentGeminiApiKey,
            openAiApiKey: currentOpenAiApiKey
          });
          longPageTranscriptForAnalyze = transcription.transcript;
          transcriptFailedBatchCount = transcription.failedBatchCount;
          transcriptBatchCount = transcription.batchCount;
          transcriptTruncated = transcription.truncated;
          setLongPageTranscript(transcription.transcript);
          // Cache only COMPLETE transcripts: a partial one must stay retryable, as the
          // completion notice promises ("다시 생성하면 받아쓰기를 재시도합니다").
          if (transcription.transcript && transcription.failedBatchCount === 0) {
            longPageTranscriptCacheRef.current = {
              key: stripsCacheKey,
              transcript: transcription.transcript,
              batchCount: transcription.batchCount
            };
          }
          logSetupEvent("setup.long_page_transcribed", {
            pageCount: transcriptionPages.length,
            batchCount: transcription.batchCount,
            failedBatchCount: transcription.failedBatchCount,
            truncated: transcription.truncated,
            transcriptChars: transcription.transcript?.length ?? 0
          });
        }
      } else {
        // Not a long page: clear any transcript left from a previous analysis in this session,
        // or it would leak into the new draft and this product's section expansion.
        setLongPageTranscript(null);
        longPageTranscriptCacheRef.current = null;
      }
      // Hero generation is deferred to this client whenever we can upgrade the reference:
      // the original upload still in memory (fresh session — enables the full-res crop) OR an
      // attached product-photo candidate the model may pick (works on restored drafts too —
      // the photo's payload IS persisted, unlike sourceFile). Deferring is always safe: the
      // server still returns its heroReference as the fallback reference.
      const attachedProductImageCandidates = sourceMaterialsForDraft.filter(
        (material) =>
          material.role !== "primary" &&
          material.kind === "image" &&
          Boolean(material.preparedImage?.base64) &&
          material.preparedImage?.analysisMetadata?.mode !== "long-detail-strips"
      );
      const hasAttachedProductImageCandidate = attachedProductImageCandidates.length > 0;
      const deferHeroGeneration = Boolean(
        analysisStripsForAnalyze?.length && (originalSourceFile || hasAttachedProductImageCandidate)
      );

      setLoadingStep("제품을 분석하고 히어로우 첫 장을 설계하는 중입니다.");

      const response = await apiJson<PdpAnalyzeResponse>("/pdp/analyze", {
        method: "POST",
        body: JSON.stringify({
          aiProvider: processingProvider,
          sourceMode: "auto" as const,
          outputMode,
          imageBase64: imageForAnalyze.base64,
          mimeType: imageForAnalyze.mimeType,
          generationImageBase64: imageForAnalyze.generationBase64 ?? imageForAnalyze.base64,
          generationImageMimeType: imageForAnalyze.generationMimeType ?? imageForAnalyze.mimeType,
          imageOptimization: imageForAnalyze.analysisMetadata,
          analysisStrips: analysisStripsForAnalyze,
          longPageTranscript: longPageTranscriptForAnalyze ?? undefined,
          deferHeroGeneration: deferHeroGeneration || undefined,
          sourceMaterials: sourceMaterialsForAnalyze,
          modelImageBase64: modelImage?.base64,
          modelImageMimeType: modelImage?.mimeType,
          modelImageFileName: modelImage?.fileName,
          additionalInfo: additionalInfo.trim() || undefined,
          customerReviewAnalysis: customerReviewAnalysis ?? undefined,
          knowledgeText: knowledgeText || undefined,
          desiredTone: desiredTone.trim() || undefined,
          aspectRatio,
          sectionCount: INITIAL_HERO_SECTION_COUNT
        })
      }, { geminiApiKey: currentGeminiApiKey, openAiApiKey: currentOpenAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS });

      if (!response.ok) {
        logSetupEvent(
          "setup.analyze_api_failed",
          {
            provider: processingProvider,
            code: response.code
          },
          "error",
          response.detail || response.message
        );
        returnToDetailsWithError(response.message, response.detail);
        return;
      }

      let nextResult = response.result;

      // Approach A v2 failure-visibility: when a long detail page was analyzed but no confident
      // product cut was found, the hero used a representative strip — tell the user so they can
      // upload a clean product shot if the hero product looks off.
      const usedLongDetailStrips = imageForAnalyze.analysisMetadata?.mode === "long-detail-strips";
      const productCutConfidence = response.result.blueprint.productCutRegion?.confidence ?? 0;
      const productCutUncertain = usedLongDetailStrips && productCutConfidence < 0.5;
      const multiProductDetected = usedLongDetailStrips && response.result.blueprint.multiProductPage === true;
      const sellingPointCount = response.result.blueprint.extractedSellingPoints?.length ?? 0;
      const weaknessCount = response.result.blueprint.currentPageDiagnosis?.weaknesses?.length ?? 0;
      if (usedLongDetailStrips) {
        logSetupEvent("setup.long_detail_insights", {
          sellingPointCount,
          weaknessCount,
          productCutConfidence,
          productCutUncertain,
          multiProductDetected
        });
      }

      // 2-pass follow-up: the strips located the product ("위치는 축소본에서"), now cut the
      // reference from the ORIGINAL upload at full resolution ("오려내기는 원본에서"). Strip
      // crops are legible enough for text but too blurry as product-appearance references.
      let heroReferenceUpgraded = false;
      let usedAttachedProductImage = false;
      let attachedProductImageFileName = "";
      if (deferHeroGeneration) {
        // 1st priority: a real standalone product photo the model identified among the uploads —
        // an actual photo beats any crop guessed out of a detail-page capture. The pick is
        // re-validated here (image kind, has payload, NOT a long page) so a model mistake can
        // never route a page capture into the appearance reference.
        const referencePick = response.result.blueprint.referenceProductImage;
        if (referencePick && referencePick.confidence >= REFERENCE_PRODUCT_IMAGE_MIN_CONFIDENCE) {
          const pickedIndex = referencePick.materialIndex - 1;
          const pickedMaterial = sourceMaterialsForDraft[pickedIndex];
          const pickedImage = pickedMaterial?.preparedImage;
          // The pick must be an image the model actually SAW: it needs an image payload in the
          // wire request AND must sit within the server's 5-image vision cap — otherwise the
          // model is pointing at a picture it never looked at.
          const imagesSentBeforePicked =
            sourceMaterialsForAnalyze?.slice(0, pickedIndex).filter((material) => material.imageBase64).length ?? 0;
          const pickedWasSeenByModel =
            Boolean(sourceMaterialsForAnalyze?.[pickedIndex]?.imageBase64) &&
            imagesSentBeforePicked < MAX_ANALYZE_SOURCE_IMAGES_SENT;
          const pickedIsUsable =
            pickedWasSeenByModel &&
            pickedMaterial?.kind === "image" &&
            Boolean(pickedImage?.base64) &&
            pickedImage?.analysisMetadata?.mode !== "long-detail-strips";
          if (pickedIsUsable && pickedImage) {
            nextResult = {
              ...nextResult,
              originalImage: pickedImage.generationBase64 ?? pickedImage.base64,
              originalImageMimeType: pickedImage.generationMimeType ?? pickedImage.mimeType,
              originalImageFileName: pickedMaterial.fileName || "product-reference.jpg"
            };
            usedAttachedProductImage = true;
            attachedProductImageFileName = pickedMaterial.fileName || "";
          }
        }

        // User-intent fallback: exactly ONE attached product photo means the user followed the
        // guidance banner ("제품 생김새는 그 사진에서 가져오고") — honor it even when the model
        // didn't pick it confidently. A page-strip reference lets the image model INVENT brands
        // (measured: a competitor logo appeared on a subscriber-style run). Multiple candidates
        // stay model-gated because auto-choosing among them risks the wrong product.
        if (!usedAttachedProductImage && attachedProductImageCandidates.length === 1) {
          const soleCandidate = attachedProductImageCandidates[0];
          const soleImage = soleCandidate.preparedImage;
          if (soleImage?.base64) {
            nextResult = {
              ...nextResult,
              originalImage: soleImage.generationBase64 ?? soleImage.base64,
              originalImageMimeType: soleImage.generationMimeType ?? soleImage.mimeType,
              originalImageFileName: soleCandidate.fileName || "product-reference.jpg"
            };
            usedAttachedProductImage = true;
            attachedProductImageFileName = soleCandidate.fileName || "";
          }
        }

        // 2nd priority: crop productCutRegion out of the ORIGINAL upload at full resolution.
        const region = response.result.blueprint.productCutRegion;
        if (!usedAttachedProductImage && originalSourceFile && region && region.confidence >= PRODUCT_CUT_RECROP_MIN_CONFIDENCE) {
          setLoadingStep("원본 화질로 제품컷을 잘라내는 중입니다.");
          const crop = await cropProductCutFromOriginalFile(originalSourceFile, region);
          if (crop) {
            nextResult = {
              ...nextResult,
              originalImage: crop.base64,
              originalImageMimeType: crop.mimeType,
              originalImageFileName: "product-reference-original.jpg"
            };
            heroReferenceUpgraded = true;
          }
        }
        logSetupEvent("setup.long_page_hero_reference", {
          referenceSource: usedAttachedProductImage
            ? "attached-product-image"
            : heroReferenceUpgraded
              ? "original-crop"
              : "server-fallback",
          attachedPickConfidence: referencePick?.confidence,
          attachedPickIndex: referencePick?.materialIndex,
          upgradedToOriginalCrop: heroReferenceUpgraded,
          productCutConfidence,
          hadOriginalFile: Boolean(originalSourceFile)
        });

        // The server skipped hero generation (deferHeroGeneration); generate it now with the
        // same options the server path would have used, but with the upgraded reference. On
        // failure the hero stays ungenerated and generateMissingSectionImages below retries it,
        // so a persistent failure lands in the existing failedCount UX instead of vanishing.
        const heroSection = nextResult.blueprint.sections[0];
        if (heroSection && !heroSection.generatedImage) {
          setLoadingStep("히어로우 첫 장을 생성하는 중입니다.");
          try {
            const heroResponse = await apiJson<PdpGenerateImageResponse>("/pdp/images", {
              method: "POST",
              body: JSON.stringify({
                originalImageBase64: nextResult.originalImage,
                originalImageMimeType: nextResult.originalImageMimeType,
                originalImageFileName: nextResult.originalImageFileName,
                section: heroSection,
                aspectRatio,
                desiredTone: desiredTone.trim() || undefined,
                options: {
                  aiProvider: processingProvider,
                  outputMode,
                  style: "studio",
                  withModel: true,
                  modelGender: "female",
                  modelAgeRange: "20s",
                  modelCountry: "korea",
                  guidePriorityMode: "guide-first",
                  headline: heroSection.headline,
                  subheadline: heroSection.subheadline,
                  referenceModelImageBase64: modelImage?.base64,
                  referenceModelImageMimeType: modelImage?.mimeType,
                  referenceModelImageFileName: modelImage?.fileName
                }
              })
            }, { geminiApiKey: currentGeminiApiKey, openAiApiKey: currentOpenAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS });

            if (heroResponse.ok) {
              nextResult = {
                ...nextResult,
                blueprint: {
                  ...nextResult.blueprint,
                  sections: nextResult.blueprint.sections.map((section, index) =>
                    index === 0
                      ? { ...section, generatedImage: `data:${heroResponse.mimeType};base64,${heroResponse.imageBase64}` }
                      : section
                  )
                }
              };
            } else {
              logSetupEvent(
                "setup.long_page_hero_generation_failed",
                { code: heroResponse.code },
                "warn",
                heroResponse.detail || heroResponse.message
              );
            }
          } catch (error) {
            logSetupEvent(
              "setup.long_page_hero_generation_failed",
              undefined,
              "warn",
              error instanceof Error ? error : String(error)
            );
          }
        }
      }

      setLoadingProgress(42);
      const batchResult = await generateMissingSectionImages({
        result: nextResult,
        provider: processingProvider,
        geminiApiKey: currentGeminiApiKey,
        openAiApiKey: currentOpenAiApiKey
      });
      nextResult = batchResult.result;

      const baseCompletedNotice = batchResult.failedCount
        ? `${selectedOutputMode.label} 히어로우 분석은 완료되었습니다. ${batchResult.failedCount}개 이미지는 생성에 실패했지만, 편집 화면에서 이어서 만들 수 있습니다.`
        : "히어로우 1장이 준비되었습니다. 먼저 첫 장을 확인한 뒤 왼쪽에서 상세페이지 섹션 타입을 고르고 나머지 섹션을 한 번에 생성하세요.";
      const insightNotice =
        usedLongDetailStrips && (sellingPointCount > 0 || weaknessCount > 0)
          ? ` 업로드한 상세페이지에서 셀링포인트 ${sellingPointCount}개와 개선 포인트 ${weaknessCount}개를 읽어 새 구성에 반영했습니다.`
          : "";
      // Failure-visibility: transcription problems must be readable in the completion notice,
      // not only in usage logs — a page analyzed without its copy inventory is a quality drop
      // the user should know about.
      const transcriptSkippedNote =
        transcriptSkippedPages > 0 ? ` 긴 자료가 많아 ${transcriptSkippedPages}개 자료는 원문 반영에서 제외했습니다.` : "";
      const transcriptNotice = transcriptionPages.length
        ? longPageTranscriptForAnalyze
          ? transcriptReused
            ? ` 이전에 받아쓴 상세페이지 원문을 재사용해 카피 설계에 반영했습니다.${transcriptSkippedNote}`
            : transcriptFailedBatchCount > 0
              ? ` 상세페이지 원문 받아쓰기 중 ${transcriptFailedBatchCount}/${transcriptBatchCount}개 구간은 실패해 해당 구간은 이미지 판독으로 대체했습니다.${transcriptSkippedNote}`
              : transcriptTruncated || transcriptSkippedPages > 0
                ? ` 상세페이지 원문을 받아써 카피 설계에 반영했습니다${transcriptTruncated ? " (분량 제한으로 하단 일부는 생략)" : ""}.${transcriptSkippedNote}`
                : " 상세페이지 원문을 전부 받아써서 카피 설계에 반영했습니다."
          : " 상세페이지 원문 받아쓰기에 실패해 이번 결과는 이미지 판독만으로 생성됐습니다. 다시 생성하면 받아쓰기를 재시도합니다."
        : "";
      const heroReferenceNotice = usedAttachedProductImage
        ? ` 제품 생김새는 함께 올려주신 "${attachedProductImageFileName || "제품 사진"}"을 참조해 생성했습니다.`
        : heroReferenceUpgraded
          ? " 제품 생김새는 상세페이지에서 원본 화질로 잘라낸 제품컷을 참조했습니다."
          : "";
      // Failure-visibility: when the tool could not confidently identify a clean product cut (or the
      // page shows several products), surface a PROMINENT warning banner with a fix action instead of
      // burying it in the success notice — a wrong hero should be obvious, not silent.
      // With an explicit attached product photo as the appearance reference, the "wrong
      // product in hero" warnings no longer apply — the appearance is anchored to a real photo.
      // When photos WERE attached but none could be used (multiple candidates, no confident
      // pick), the advice must not be "add a photo" — the user already did.
      const heroWarning = usedAttachedProductImage
        ? ""
        : hasAttachedProductImageCandidate
          ? "히어로 제품 확인 필요 — 함께 올려주신 제품 이미지 중 어떤 것이 주력 제품인지 확신하지 못해 이번 생성에는 사용하지 못했어요. [추가 정보]에 정확한 제품명을 적거나, 주력 제품 사진 1장만 남기고 다시 생성하면 정확해집니다."
          : multiProductDetected
            ? "히어로 제품 확인 필요 — 업로드한 상세페이지에 제품이 여러 개 보여서, 히어로에 의도와 다른 제품이 들어갔을 수 있어요. 히어로 제품이 실제와 다르면 [추가 정보]에 정확한 제품명을 적거나, 제품만 단독으로 나온 깨끗한 사진 1장을 같은 업로드 칸에 추가해 다시 생성하세요."
            : productCutUncertain
              ? "히어로 제품 확인 필요 — 이 상세페이지에서 ‘깨끗한 제품컷’을 확신하지 못해(배너·연출컷 위주) 대표 구간으로 히어로를 만들었어요. 히어로 제품이 실제와 다르면 [추가 정보]에 정확한 제품명을 적거나, 제품만 단독으로 나온 깨끗한 사진 1장을 같은 업로드 칸에 추가해 다시 생성하세요."
              : "";
      const completedNotice = `${baseCompletedNotice}${insightNotice}${transcriptNotice}${heroReferenceNotice}`;
      const nextEditorDraftState = {
        ...createDefaultEditorDraftState(nextResult, outputMode),
        notice: completedNotice,
        heroWarning
      };

      isApplyingDraftRef.current = true;

      let autosaveFailed = false;
      try {
        const savedDraft = await savePdpDraft({
          id: activeDraftId ?? undefined,
          createdAt: draftCreatedAt ?? undefined,
          appState: "editor",
          preparedImage: imageForAnalyze,
          sourceMaterials: sourceMaterialsForDraft,
          modelImage,
          modelImageUsage,
          result: nextResult,
          additionalInfo,
          customerReviewAnalysis,
          desiredTone,
          aspectRatio,
          aiProvider: processingProvider,
          sourceMode: "auto" as const,
          outputMode,
          sectionCount: nextResult.blueprint.sections.length || INITIAL_HERO_SECTION_COUNT,
          benefits: [],
          notice: completedNotice,
          editorState: nextEditorDraftState,
          longPageTranscript: longPageTranscriptForAnalyze ?? undefined,
          longPageTranscriptComplete: longPageTranscriptForAnalyze
            ? transcriptReused || transcriptFailedBatchCount === 0
            : undefined,
          longPageTranscriptKey:
            longPageTranscriptForAnalyze &&
            longPageTranscriptCacheRef.current?.transcript === longPageTranscriptForAnalyze
              ? longPageTranscriptCacheRef.current.key
              : undefined
        });

        setActiveDraftId(savedDraft.id);
        setDraftCreatedAt(savedDraft.createdAt);
        setLastSavedAt(savedDraft.updatedAt);
        setSaveState("saved");
        setIsDirty(false);
        await refreshDrafts();
      } catch (saveError) {
        // Paid generation succeeded but the draft did not persist. Do NOT swallow this:
        // mark the save errored and keep the work dirty so the editor shows an error state,
        // the beforeunload guard fires, and the notice below tells the user to save manually.
        autosaveFailed = true;
        setSaveState("error");
        setIsDirty(true);
        console.warn("PDP analysis result was not saved as a draft.", saveError);
        logSetupEvent("setup.analyze_autosave_failed", undefined, "warn", saveError instanceof Error ? saveError : String(saveError));
      }

      const completionNotice = autosaveFailed
        ? "이미지는 생성됐지만 자동 저장에 실패했어요. 새로고침하면 사라질 수 있으니 편집 화면에서 '작업 저장하기'로 꼭 저장해 주세요."
        : completedNotice;

      setResult(nextResult);
      setLoadingProgress(100);
      setEditorDraftState(
        autosaveFailed ? { ...nextEditorDraftState, notice: completionNotice } : nextEditorDraftState
      );
      setEditorSessionKey((current) => current + 1);
      setNotice(completionNotice);
      setErrorMessage(batchResult.errorMessage);
      setErrorDetail(batchResult.errorDetail);
      setShowErrorDetail(false);
      setAppState("editor");
      logSetupEvent("setup.analyze_completed", {
        provider: processingProvider,
        outputMode,
        sectionCount: nextResult.blueprint.sections.length,
        failedImageCount: batchResult.failedCount,
        durationMs: Date.now() - analyzeStartedAt
      });
      requestAnimationFrame(() => {
        isApplyingDraftRef.current = false;
      });
    } catch (error) {
      logSetupEvent(
        "setup.analyze_unhandled_failed",
        { durationMs: Date.now() - analyzeStartedAt },
        "error",
        error instanceof Error ? error : String(error)
      );
      returnToDetailsWithError(
        error instanceof Error ? error.message.split("\n")[0] : "API 서버와 통신하지 못했습니다.",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      );
    }
  };

  const handleReset = async () => {
    logSetupEvent("setup.reset_requested");
    const canContinue = await confirmSaveBeforeLeaving();
    if (!canContinue) {
      logSetupEvent("setup.reset_cancelled_unsaved_changes");
      return;
    }

    resetWorkspace();
  };

  const handleGoToMain = async () => {
    logSetupEvent("setup.go_to_main_requested");
    const canContinue = await confirmSaveBeforeLeaving();
    if (!canContinue) {
      logSetupEvent("setup.go_to_main_cancelled_unsaved_changes");
      return;
    }

    resetWorkspace();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleContinueToDetails = () => {
    if (!preparedImage) {
      setErrorMessage("먼저 제품 이미지 혹은 상세페이지 이미지를 업로드해 주세요.");
      document.getElementById("pdp-maker-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
      logSetupEvent("setup.details_step_blocked", { reason: "missing_primary_image" }, "warn");
      return;
    }

    if (modelImage && !modelImageUsage) {
      setErrorMessage("모델 이미지를 업로드했다면 사용 방식을 먼저 선택해 주세요.");
      document.getElementById("model-upload-section")?.scrollIntoView({ behavior: "smooth", block: "center" });
      logSetupEvent("setup.details_step_blocked", { reason: "missing_model_usage" }, "warn");
      return;
    }

    if (hasPendingCustomerReviewAnalysis) {
      const message = `고객 후기 파일을 올렸다면 ${getCustomerReviewAnalyzerLabel()} 분석 결과를 확인한 뒤 다음 단계로 넘어갈 수 있습니다.`;
      setCustomerReviewAnalysisError(message);
      setErrorMessage(message);
      document.getElementById("customer-review-upload-section")?.scrollIntoView({ behavior: "smooth", block: "center" });
      logSetupEvent(
        "setup.details_step_blocked",
        {
          reason: "pending_customer_review_analysis",
          reviewCount: customerReviewSource?.reviewCount ?? 0
        },
        "warn"
      );
      return;
    }

    setErrorMessage("");
    setErrorDetail("");
    setShowErrorDetail(false);
    setSetupStep("details");
    const scrollToWorkspace = () => {
      const workspace = document.getElementById("pdp-maker-workspace");
      if (!workspace) {
        return;
      }

      window.scrollTo({
        top: workspace.getBoundingClientRect().top + window.scrollY,
        behavior: "auto"
      });
    };
    requestAnimationFrame(scrollToWorkspace);
    window.setTimeout(scrollToWorkspace, 120);
    window.setTimeout(scrollToWorkspace, 320);
    logSetupEvent("setup.details_step_entered", {
      image: summarizePreparedImageForUsageLog(preparedImage),
      hasModelImage: Boolean(modelImage),
      modelImageUsage: modelImageUsage ?? "none",
      customerReviewCount: customerReviewAnalysis?.reviewCount ?? 0
    });
  };

  const handleSaveSettings = (nextSettings: PdpClientSettings) => {
    savePdpClientSettings(nextSettings);
    const savedSettings = loadPdpClientSettings();
    const hasSavedOpenAiKey = Boolean(resolveOpenAiApiKeyHeaderValue(savedSettings));
    setClientSettings(savedSettings);
    setAiProvider(clientPreferredProvider(savedSettings));
    if (customerReviewSource && !customerReviewAnalysis && hasSavedOpenAiKey) {
      setCustomerReviewAnalysisError("");
      setNotice("OpenAI API 키 확인을 마쳤습니다. 고객 후기 영역에서 ChatGPT 분석을 다시 실행해 주세요.");
    } else {
      setNotice(
        hasSavedOpenAiKey || Boolean(resolveGeminiApiKeyHeaderValue(savedSettings))
          ? "개인 AI API 키 확인을 마쳤습니다. 이 브라우저에서는 입력한 키로 바로 작업할 수 있습니다."
          : "API 키 사용을 해제했습니다. 기본 Codex CLI 방식으로 작업합니다."
      );
    }
    logSetupEvent("setup.api_settings_saved", {
      hasGeminiKey: Boolean(resolveGeminiApiKeyHeaderValue(savedSettings)),
      hasOpenAiKey: hasSavedOpenAiKey,
      preferredAiProvider: savedSettings.preferredAiProvider || "auto"
    });
  };

  const handleKnowledgeFiles = async (files: File[]) => {
    const selectedFiles = files.filter(isSupportedKnowledgeFile).slice(0, MAX_KNOWLEDGE_ITEMS);
    logSetupEvent("setup.knowledge_files_selected", {
      selectedCount: files.length,
      supportedCount: selectedFiles.length,
      files: files.slice(0, MAX_KNOWLEDGE_ITEMS).map(summarizeFileForUsageLog)
    });

    if (!selectedFiles.length) {
      setErrorMessage("PDF, TXT, MD 지식파일만 등록할 수 있습니다.");
      setIsKnowledgeOpen(true);
      logSetupEvent("setup.knowledge_files_rejected", { selectedCount: files.length }, "warn");
      return;
    }

    setIsReadingKnowledge(true);
    setErrorMessage("");
    setErrorDetail("");
    setShowErrorDetail(false);

    try {
      const nextItems: KnowledgeItem[] = [];

      for (const file of selectedFiles) {
        const text = (await extractKnowledgeText(file)).trim();
        if (!text) {
          continue;
        }

        nextItems.push({
          id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name,
          type: file.type || inferKnowledgeFileType(file.name),
          size: file.size,
          text: text.slice(0, 18000),
          createdAt: new Date().toISOString()
        });
      }

      if (!nextItems.length) {
        setErrorMessage("지식파일에서 읽을 수 있는 텍스트를 찾지 못했습니다.");
        logSetupEvent("setup.knowledge_files_empty", { selectedCount: selectedFiles.length }, "warn");
        return;
      }

      setKnowledgeItems((current) => [...nextItems, ...current].slice(0, MAX_KNOWLEDGE_ITEMS));
      setNotice(`${nextItems.length}개 지식파일을 등록했습니다. 분석 요청 시 사전 지식으로 함께 반영됩니다.`);
      setIsKnowledgeOpen(true);
      logSetupEvent("setup.knowledge_files_registered", {
        registeredCount: nextItems.length,
        totalTextLength: nextItems.reduce((sum, item) => sum + item.text.length, 0),
        totalSize: nextItems.reduce((sum, item) => sum + item.size, 0)
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "지식파일 등록 중 오류가 발생했습니다.");
      setErrorDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      logSetupEvent("setup.knowledge_files_failed", { selectedCount: selectedFiles.length }, "error", error instanceof Error ? error : String(error));
    } finally {
      setIsReadingKnowledge(false);
    }
  };

  const deleteKnowledgeItem = (itemId: string) => {
    setKnowledgeItems((current) => current.filter((item) => item.id !== itemId));
    setNotice("지식파일을 삭제했습니다. 다음 분석 요청부터 제외됩니다.");
    logSetupEvent("setup.knowledge_file_deleted", {
      remainingCount: Math.max(0, knowledgeItems.length - 1),
      itemIdPresent: Boolean(itemId)
    });
  };

  const closeNoticeModal = (options?: { neverShowAgain?: boolean }) => {
    if (options?.neverShowAgain || doNotShowNoticeAgain) {
      window.localStorage.setItem(NOTICE_DISMISSED_STORAGE_KEY, "true");
    }
    setIsNoticeModalOpen(false);
    logSetupEvent("setup.notice_modal_closed", {
      neverShowAgain: Boolean(options?.neverShowAgain || doNotShowNoticeAgain)
    });
  };

  const modelUploadSection = (
    <section className={styles.optionalUploadBlock} id="model-upload-section">
      <div className={styles.optionalUploadHeader}>
        <div className={styles.onboardingBlockHeading}>
          <span className={styles.sectionStep}>2</span>
          <div>
            <span className={styles.panelLabel}>있을 경우</span>
            <h3 className={styles.optionalUploadTitle}>모델 이미지 등록</h3>
            <p className={styles.optionalUploadDescription}>특정 인물을 히어로우나 모델컷 전체에 맞출 때만 업로드하세요.</p>
          </div>
        </div>
        {modelImage ? (
          <button
            className={styles.inlineButton}
            onClick={() => {
              setModelImage(null);
              setModelImageUsage(null);
              setErrorMessage("");
              setErrorDetail("");
              setShowErrorDetail(false);
              setNotice("모델 이미지를 제거했습니다. 일반 페르소나 설정으로 계속 편집할 수 있습니다.");
              logSetupEvent("setup.model_image_removed");
            }}
            type="button"
          >
            <Trash2 size={14} />
            모델 이미지 제거
          </button>
        ) : null}
      </div>

      <UploadDropzone
        compact
        description="선택 사항입니다. 모델컷 생성 시 참조 이미지로 사용됩니다."
        hint={modelImage?.fileName ? `선택됨: ${modelImageDisplayName}` : "권장 최대 10MB"}
        onSelect={async (files) => {
          const file = files[0];
          if (file) {
            await handleModelImage(file);
          }
        }}
        selectedFileName={modelImage?.fileName}
        title="모델 이미지 등록(있을 경우)"
      />

      {modelImage ? (
        <div className={styles.uploadPreviewCard}>
          <div className={styles.previewFrame}>
            <img alt={modelImage.fileName} className={styles.selectedImage} src={modelImage.previewUrl} />
          </div>
          <div className={styles.uploadMeta}>
            <strong title={modelImage.fileName}>{modelImageDisplayName}</strong>
            <div className={styles.metaList}>
              <div className={styles.metaItem}>
                <span>적용 대상</span>
                <strong>{modelImageUsage === "all-sections" ? "전체 모델컷" : modelImageUsage === "hero-only" ? "히어로우" : "선택 필요"}</strong>
              </div>
              <div className={styles.metaItem}>
                <span>활용 방식</span>
                <strong>{formatAnalysisMode(modelImage)}</strong>
              </div>
              <div className={styles.metaItem}>
                <span>분석 크기</span>
                <strong>{formatOptimizedDimensions(modelImage)}</strong>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {modelImage ? (
        <div className={styles.modelUsagePanel}>
          <div className={styles.modelUsageHeader}>
            <strong>모델 이미지 사용 방식</strong>
            <span>업로드했다면 아래 두 옵션 중 하나를 선택해야 합니다.</span>
          </div>
          <div className={styles.modelUsageGrid}>
            <button
              className={modelImageUsage === "hero-only" ? styles.modelUsageCardActive : styles.modelUsageCard}
              onClick={() => {
                setModelImageUsage("hero-only");
                setErrorMessage("");
                logSetupEvent("setup.model_usage_selected", { modelImageUsage: "hero-only" });
              }}
              type="button"
            >
              <strong>히어로우에만 사용</strong>
              <span>첫 히어로우 섹션의 모델컷에 적용합니다.</span>
            </button>
            <button
              className={modelImageUsage === "all-sections" ? styles.modelUsageCardActive : styles.modelUsageCard}
              onClick={() => {
                setModelImageUsage("all-sections");
                setErrorMessage("");
                logSetupEvent("setup.model_usage_selected", { modelImageUsage: "all-sections" });
              }}
              type="button"
            >
              <strong>전체 일관성 유지</strong>
              <span>모델컷 생성 시 같은 인물 기준으로 맞춥니다.</span>
            </button>
          </div>
          {!modelImageUsage ? (
            <div className={styles.inlineWarning}>
              <AlertCircle size={16} />
              모델 이미지 사용 방식을 선택해 주세요.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  const errorPanel = errorMessage ? (
    <div className={styles.errorPanel} id="pdp-error-panel" role="alert">
      <div className={styles.errorBanner}>
        <AlertCircle size={16} />
        {errorMessage}
      </div>
      {errorDetail ? (
        <div className={styles.errorDetailWrap}>
          <button className={styles.inlineButton} onClick={() => setShowErrorDetail((current) => !current)} type="button">
            {showErrorDetail ? "로그 숨기기" : "로그 보기"}
          </button>
          {showErrorDetail ? (
            <div className={styles.errorDetail}>
              <div className={styles.errorDetailHeader}>
                <strong>API Detail</strong>
                <button className={styles.inlineButton} onClick={() => navigator.clipboard.writeText(errorDetail)} type="button">
                  <Copy size={14} />
                  복사
                </button>
              </div>
              <pre>{errorDetail}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  const customerReviewTitle =
    customerReviewAnalysis?.fileName ?? customerReviewSource?.fileName ?? "후기 엑셀 파일을 첨부해 주세요";
  const customerReviewStatusText = customerReviewAnalysis
    ? `후기 파일을 분석했습니다 · 고객 고민/후기 섹션에 실제 문장을 반영`
    : customerReviewSource
      ? isAnalyzingCustomerReviews
        ? `후기 파일을 ${getCustomerReviewAnalyzerLabel()}로 분석 중`
        : `후기 파일 준비 완료 · ${getCustomerReviewAnalyzerLabel()} 분석 결과 확인 후 다음 단계 가능`
      : ".xlsx, .csv, .tsv 지원 · 후기/리뷰/내용 컬럼을 자동으로 찾습니다.";
  const customerReviewActionLabel = customerReviewAnalysis || customerReviewSource ? "후기 파일 교체" : "후기 파일 첨부";
  const customerReviewAnalysisButtonLabel = isAnalyzingCustomerReviews
    ? `${getCustomerReviewAnalyzerLabel()} 분석 중`
    : customerReviewAnalysis
      ? "다시 분석"
      : `${getCustomerReviewAnalyzerLabel()}로 후기 분석`;

  if (appState === "editor" && result) {
    return (
      <>
        <PdpEditor
          key={`${activeDraftId ?? "new"}-${editorSessionKey}`}
          aspectRatio={aspectRatio}
          aiProvider={aiProvider}
          outputMode={outputMode}
          geminiApiKey={effectiveGeminiApiKey}
          openAiApiKey={effectiveOpenAiApiKey}
          desiredTone={desiredTone}
          additionalInfo={additionalInfo}
          customerReviewAnalysis={customerReviewAnalysis}
          longPageTranscript={longPageTranscript}
          initialDraftState={editorDraftState}
          initialResult={result}
          lastSavedAt={lastSavedAt}
          manualSaveToastToken={manualSaveToastToken}
          onDraftStateChange={setEditorDraftState}
          onManualSave={() => void persistDraft("manual", { showToast: true })}
          onOpenSettings={() => {
            setIsSettingsOpen(true);
            logSetupEvent("setup.settings_opened", { trigger: "editor_header" });
          }}
          onReset={() => void handleReset()}
          apiConnectionLabel={apiConnectionLabel}
          referenceModelImage={modelImage}
          referenceModelUsage={modelImageUsage}
          saveState={saveState}
        />
        <PdpSettingsSheet
          onOpenChange={setIsSettingsOpen}
          onSave={handleSaveSettings}
          open={isSettingsOpen}
          settings={clientSettings}
        />
        <div aria-hidden="true" className={styles.versionBadge}>버전 {PDP_APP_VERSION}</div>
      </>
    );
  }

  return (
    <main className={styles.page}>
      <div aria-hidden="true" className={styles.versionBadge}>버전 {PDP_APP_VERSION}</div>
      <section className={styles.shell}>
        <aside className={styles.wizardSidebar}>
          <div className={styles.sidebarTopRow}>
            <button
              className={styles.sidebarBrand}
              onClick={() => {
                setIsMobileMenuOpen(false);
                void handleGoToMain();
              }}
              type="button"
              aria-label="대시보드로 이동"
            >
              <span className={styles.brandMark}>HM</span>
              <h1 className={styles.sidebarTitle}>{APP_TITLE}</h1>
            </button>

            <button
              aria-controls="pdp-maker-navigation-menu"
              aria-expanded={isMobileMenuOpen}
              aria-label={isMobileMenuOpen ? "상단 메뉴 닫기" : "상단 메뉴 열기"}
              className={styles.sidebarMenuButton}
              onClick={() => setIsMobileMenuOpen((current) => !current)}
              title={isMobileMenuOpen ? "메뉴 닫기" : "메뉴 열기"}
              type="button"
            >
              {isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>

          <div
            className={`${styles.sidebarMenuPanel} ${isMobileMenuOpen ? styles.sidebarMenuPanelOpen : ""}`}
            id="pdp-maker-navigation-menu"
          >
            <nav className={styles.sidebarNav} aria-label="상세페이지 마법사 단계">
              <button
                className={styles.sidebarNavButtonActive}
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  void handleGoToMain();
                }}
                type="button"
              >
                <span>대시보드</span>
                <span>01</span>
              </button>
              <button
                className={styles.sidebarNavButton}
              onClick={() => {
                setIsMobileMenuOpen(false);
                logSetupEvent("setup.workspace_nav_clicked", { target: "workspace" });
                document.getElementById("pdp-maker-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
                type="button"
              >
                <span>상세페이지 작업</span>
                <span>02</span>
              </button>
              <button className={styles.sidebarNavButtonDisabled} disabled type="button">
                <span>결과 확인</span>
                <span>03</span>
              </button>
            </nav>

            <div className={styles.sidebarStatusCard}>
              <div className={styles.sidebarStatusRow}>
                <span>Gemini</span>
                <strong className={hasAvailableGeminiKey ? styles.sidebarBadgeActive : styles.sidebarBadge}>
                  {hasAvailableGeminiKey ? "연결 완료" : "Codex 기본"}
                </strong>
              </div>
              <div className={styles.sidebarStatusRow}>
                <span>OpenAI Image 2.0</span>
                <strong className={hasAvailableOpenAiKey ? styles.sidebarBadgeActive : styles.sidebarBadge}>
                  {hasAvailableOpenAiKey ? "연결 완료" : "Codex 기본"}
                </strong>
              </div>
              <div className={styles.sidebarStatusRow}>
                <span>사전 지식</span>
                <strong className={knowledgeStatusClassName}>{knowledgeStatusLabel}</strong>
              </div>
              <div className={styles.sidebarStatusRow}>
                <span>브라우저 저장</span>
                <strong className={styles.sidebarBadgeActive}>자동 저장</strong>
              </div>
            </div>

            <div className={styles.sidebarMenuActions} aria-label="대시보드 작업">
              <button
                className={`${styles.secondaryButton} ${styles.headerActionButton}`}
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  setIsSettingsOpen(true);
                  logSetupEvent("setup.settings_opened", { trigger: "sidebar" });
                }}
                type="button"
              >
                <Settings2 size={16} />
                API 키 설정
              </button>
              <button
                aria-disabled={true}
                className={`${styles.secondaryButton} ${styles.headerActionButton}`}
                disabled
                style={{ cursor: "not-allowed", opacity: 0.58 }}
                title="지식파일 등록은 준비 중입니다."
                type="button"
              >
                <FileText size={16} />
                지식파일 등록
                <KeyRound aria-hidden="true" size={12} style={{ flex: "0 0 auto", marginLeft: 4 }} />
              </button>
              <button
                className={`${styles.secondaryButton} ${styles.headerActionButton}`}
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  setIsDraftsOpen(true);
                  logSetupEvent("setup.drafts_sheet_opened", { trigger: "sidebar" });
                }}
                type="button"
              >
                <FolderOpen size={16} />
                기존작업 열기
              </button>
              <button
                className={`${styles.secondaryButton} ${styles.headerActionButton}`}
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  void handleReset();
                }}
                type="button"
              >
                <Sparkles size={16} />
                새 작업 시작
              </button>
            </div>
          </div>
        </aside>

        <div className={styles.workspaceArea}>
        <div className={styles.workspaceFrame}>
        <header className={styles.toolHeader}>
          <div className={styles.toolHeaderCopy}>
            <span className={styles.workspaceTopbarLabel}>DASHBOARD</span>
          </div>

          <div className={styles.toolHeaderActions}>
            <button
              className={`${styles.secondaryButton} ${styles.headerActionButton}`}
              onClick={() => {
                setIsSettingsOpen(true);
                logSetupEvent("setup.settings_opened", { trigger: "topbar" });
              }}
              type="button"
            >
              <Settings2 size={16} />
              API 키 설정
            </button>
            <button
              aria-disabled={true}
              className={`${styles.secondaryButton} ${styles.headerActionButton}`}
              disabled
              style={{ cursor: "not-allowed", opacity: 0.58 }}
              title="지식파일 등록은 준비 중입니다."
              type="button"
            >
              <FileText size={16} />
              지식파일 등록
              <KeyRound aria-hidden="true" size={12} style={{ flex: "0 0 auto", marginLeft: 4 }} />
            </button>
            <button
              className={`${styles.secondaryButton} ${styles.headerActionButton}`}
              onClick={() => {
                setIsDraftsOpen(true);
                logSetupEvent("setup.drafts_sheet_opened", { trigger: "topbar" });
              }}
              type="button"
            >
              <FolderOpen size={16} />
              기존작업 열기
            </button>
            <button className={`${styles.secondaryButton} ${styles.headerActionButton}`} onClick={() => void handleReset()} type="button">
              <Sparkles size={16} />
              새 작업 시작
            </button>
          </div>
        </header>

        {appState !== "processing" ? (
          <div className={styles.setupProgress} aria-label="작업 단계">
            <button
              className={setupStep === "upload" ? styles.setupProgressItemActive : styles.setupProgressItem}
              onClick={() => {
                setSetupStep("upload");
                logSetupEvent("setup.step_clicked", { step: "upload" });
              }}
              type="button"
            >
              <span>1</span>
              <strong>자료 등록</strong>
            </button>
            <button
              className={setupStep === "details" ? styles.setupProgressItemActive : styles.setupProgressItem}
              disabled={!preparedImage}
              onClick={() => {
                setSetupStep("details");
                logSetupEvent("setup.step_clicked", { step: "details" });
              }}
              type="button"
            >
              <span>2</span>
              <strong>생성 설정</strong>
            </button>
          </div>
        ) : null}

        {appState === "processing" ? (
          <section className={styles.processingPanel}>
            <div className={styles.processingIcon}>
              <Loader2 className={styles.spinIcon} size={32} />
            </div>
            <div>
              <h2>AI가 상세페이지 구조를 만드는 중입니다</h2>
              <p>{loadingStep}</p>
            </div>

            <div className={styles.processingMeter}>
              <div className={styles.processingMeterHeader}>
                <strong>{remainingProgressPercent}% 남음</strong>
                <span>{remainingTimeLabel}</span>
              </div>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${loadingProgress}%` }} />
              </div>
              <div className={styles.processingStats}>
                <span>선택 모델: {selectedProviderLabel}</span>
                <span>생성 범위: 히어로우 1장</span>
                <span>{selectedOutputMode.label}</span>
              </div>
            </div>

            <div className={styles.waitingVideoCard}>
              <div className={styles.waitingVideoCopy}>
                <span className={styles.panelLabel}>기다리는 동안</span>
                <h3>영상보며 기다리세요</h3>
                <p>생성이 끝나면 자동으로 편집 화면으로 넘어갑니다. 이 작은 극장, 꽤 쓸만합니다.</p>
              </div>

              {waitingVideo ? (
                <div className={styles.waitingVideoFrame}>
                  <iframe
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    loading="lazy"
                    src={waitingVideo.embedUrl}
                    title={waitingVideo.title}
                  />
                </div>
              ) : (
                <a
                  className={styles.waitingVideoFallback}
                  href="https://www.youtube.com/@irum_hahn"
                  rel="noreferrer"
                  target="_blank"
                >
                  {isLoadingWaitingVideo ? "추천 영상을 불러오는 중입니다..." : "한이룸 유튜브 채널 열기"}
                </a>
              )}
            </div>
          </section>
        ) : (
          <div className={styles.setupGridSingle} id="pdp-maker-workspace">
            {setupStep === "upload" ? (
            <section className={styles.uploadStage}>
              <div className={styles.panelIntro}>
                <div className={styles.sectionHeading}>
                  <span className={styles.sectionStep}>1</span>
                  <div className={styles.sectionHeadingCopy}>
                    <h2>이미지/PDF 또는 상세페이지 등록</h2>
                    <p>여러 제품컷, 상세페이지 캡처, PDF 자료를 한 번에 올리면 대표 자료와 보조 자료를 함께 분석합니다.</p>
                  </div>
                </div>
              </div>

              <UploadDropzone
                accept="image/*,.pdf,application/pdf"
                description="제품컷, 패키지컷, 기존 상세페이지 캡처 이미지와 PDF를 여러 개 선택할 수 있습니다."
                disabled={isReadingSourceMaterials}
                hint={
                  isReadingSourceMaterials
                    ? "자료를 읽는 중입니다."
                    : `최대 8개 · Ctrl+V 캡처 붙여넣기 가능 · 상세페이지 이미지는 최대 ${MAX_TRANSCRIBE_PAGES}장까지 원문 반영`
                }
                enablePaste
                multiple
                onSelect={handleSourceMaterialFiles}
                selectedFileName={sourceMaterialDropzoneLabel}
                title="상세페이지 자료 업로드"
              />

	              {visibleSourceMaterials.length ? (
	                <div className={styles.sourceMaterialList} aria-label="등록된 상세페이지 자료">
	                  {visibleSourceMaterials.map((material) => (
	                    <div
	                      className={material.role === "primary" ? styles.sourceMaterialItemPrimary : styles.sourceMaterialItem}
	                      key={material.id}
	                    >
	                      {material.previewUrl ? (
	                        <img
	                          alt={material.fileName}
	                          className={styles.sourceMaterialThumb}
	                          src={material.previewUrl}
	                        />
	                      ) : null}
	                      <div className={styles.sourceMaterialMeta}>
	                        <span>{sourceMaterialTypeLabels.get(material.id) ?? formatSourceMaterialKind(material)}</span>
	                        <strong title={material.fileName}>{formatCompactFileName(material.fileName)}</strong>
	                        <small>{formatSourceMaterialDetail(material)}</small>
	                      </div>
	                    </div>
	                  ))}
	                </div>
	              ) : null}

              {showProductImageGuidance ? (
                <div className={styles.uploadContextWarning} role="status">
                  <AlertCircle size={16} />
                  <div>
                    <strong>제품 이미지를 함께 올려주세요</strong>
                    <span>
                      제품 이미지를 별도로 등록해주어야 상세페이지 결과가 좋아집니다. 상단 [1 자료 등록] 단계에서 제품만
                      단독으로 나온 사진 1장을 추가로 올려주세요(기존 자료는 유지됩니다).
                    </span>
                  </div>
                </div>
              ) : null}

              {modelUploadSection}

              {uploadContextGuidance ? (
                <div
                  className={uploadContextGuidance.tone === "ready" ? styles.uploadContextReady : styles.uploadContextWarning}
                  role="status"
                >
                  {uploadContextGuidance.tone === "ready" ? <Sparkles size={16} /> : <AlertCircle size={16} />}
                  <div>
                    <strong>{uploadContextGuidance.title}</strong>
                    <span>{uploadContextGuidance.message}</span>
                  </div>
                </div>
              ) : null}

              <section className={styles.additionalInfoBlock}>
                <div className={styles.onboardingBlockHeading}>
                  <span className={styles.sectionStep}>3</span>
                  <div>
                    <span className={styles.panelLabel}>선택 입력</span>
                    <h3 className={styles.optionalUploadTitle}>추가 정보 등록</h3>
                    <p className={styles.optionalUploadDescription}>상품명/카테고리, 타깃, 판매처, 강조할 장점, 금지 표현처럼 이미지에 없는 정보를 적어두세요.</p>
                  </div>
                </div>
                <textarea
                  className={styles.textarea}
                  id="additionalInfo"
                  onBlur={() => {
                    logSetupEvent("setup.additional_info_blurred", {
                      length: additionalInfo.trim().length
                    });
                  }}
                  onChange={(event) => setAdditionalInfo(event.target.value)}
                  placeholder="예: 상품명 부쉬맨 워터프루프 프로 선크림, 카테고리 선케어, 20대 여성, 여름 시즌, 네이버 스마트스토어용"
                  rows={5}
                  value={additionalInfo}
                />
              </section>

              <section className={styles.customerReviewBlock} id="customer-review-upload-section">
                <div className={styles.onboardingBlockHeading}>
                  <span className={styles.sectionStep}>4</span>
                  <div>
                    <span className={styles.panelLabel}>선택 입력</span>
                    <h3 className={styles.optionalUploadTitle}>고객 후기 입력</h3>
                    <p className={styles.optionalUploadDescription}>
                      엑셀/CSV 후기 데이터를 올리면 {getCustomerReviewAnalyzerLabel()}가 먼저 분석하고, 확인한 결과를 다음 제작 과정과 섹션 전체에 반영합니다.
                    </p>
                  </div>
                </div>

                <div className={styles.reviewUploadPanel}>
                  <input
                    accept=".xlsx,.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className={styles.hiddenInput}
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        await handleCustomerReviewFile(file);
                      }
                      event.target.value = "";
                    }}
                    ref={customerReviewInputRef}
                    type="file"
                  />
                  <div className={styles.reviewUploadCopy}>
                    <strong>{customerReviewTitle}</strong>
                    <span>{customerReviewStatusText}</span>
                  </div>
                  <div className={styles.reviewUploadActions}>
                    <button
                      className={styles.inlineButton}
                      disabled={isReadingCustomerReviews || isAnalyzingCustomerReviews}
                      onClick={() => customerReviewInputRef.current?.click()}
                      type="button"
                    >
                      {isReadingCustomerReviews ? <Loader2 className={styles.spinIcon} size={14} /> : <FileText size={14} />}
                      {customerReviewActionLabel}
                    </button>
                    {customerReviewSource ? (
                      <button
                        className={styles.inlineButton}
                        disabled={isReadingCustomerReviews || isAnalyzingCustomerReviews}
                        onClick={() => void analyzeCustomerReviewSource(customerReviewSource)}
                        type="button"
                      >
                        {isAnalyzingCustomerReviews ? <Loader2 className={styles.spinIcon} size={14} /> : <Sparkles size={14} />}
                        {customerReviewAnalysisButtonLabel}
                      </button>
                    ) : null}
                    {customerReviewAnalysis || customerReviewSource ? (
                      <button className={styles.inlineButton} onClick={clearCustomerReviewAnalysis} type="button">
                        <Trash2 size={14} />
                        제거
                      </button>
                    ) : null}
                  </div>
                </div>

                {isAnalyzingCustomerReviews ? (
                  <div className={styles.reviewAnalysisStatus}>
                    <Loader2 className={styles.spinIcon} size={16} />
                    <div>
                      <strong>{getCustomerReviewAnalyzerLabel()}가 실제 후기 데이터를 분석 중입니다.</strong>
                      <span>장점, 반복된 아쉬움, 고객 고민/후기 섹션에 쓸 실제 문장을 분리하고 있습니다.</span>
                    </div>
                  </div>
                ) : null}

                {customerReviewAnalysisError ? (
                  <div className={styles.reviewAnalysisWarning} role="status">
                    <AlertCircle size={16} />
                    <span>{customerReviewAnalysisError}</span>
                  </div>
                ) : null}

                {customerReviewAnalysis ? (
                  <div className={styles.reviewInsightPanel}>
                    <div className={styles.reviewInsightColumn}>
                      <span>부각할 장점</span>
                      <ul>
                        {customerReviewAnalysis.topBenefits.slice(0, 3).map((benefit) => (
                          <li key={benefit}>{benefit}</li>
                        ))}
                      </ul>
                    </div>
                    <div className={styles.reviewInsightColumn}>
                      <span>개선할 아쉬움</span>
                      <ul>
                        {(customerReviewAnalysis.improvementPromises.length
                          ? customerReviewAnalysis.improvementPromises
                          : customerReviewAnalysis.painPoints
                        ).slice(0, 3).map((painPoint) => (
                          <li key={painPoint}>{painPoint}</li>
                        ))}
                      </ul>
                    </div>
                    <div className={styles.reviewQuotePanel}>
                      <span>실제 후기 샘플</span>
                      {customerReviewAnalysis.sampleReviews.slice(0, 3).map((review) => (
                        <blockquote key={review}>{review}</blockquote>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>

              {errorPanel}

              <div className={styles.setupActions}>
                <button
                  className={styles.primaryButtonWide}
                  disabled={!canContinueToDetails}
                  onClick={handleContinueToDetails}
                  type="button"
                >
                  다음: 생성 설정
                </button>
              </div>
            </section>
            ) : (
            <section className={styles.detailsStage}>
              <div className={styles.panelIntro}>
                <div className={styles.sectionHeading}>
                  <span className={styles.sectionStep}>2</span>
                  <div className={styles.sectionHeadingCopy}>
                    <h2>생성 설정</h2>
                    <p>먼저 히어로우 1장을 만든 뒤, 결과를 보고 상세페이지 섹션 타입을 고를 수 있습니다.</p>
                  </div>
                </div>
              </div>

              <div className={styles.materialSummaryPanel}>
                <div className={styles.materialSummaryHeader}>
                  <div>
                    <span className={styles.panelLabel}>등록 자료</span>
                    <strong>첫 화면에서 등록한 자료를 기준으로 생성합니다.</strong>
                  </div>
                  <button
                    className={styles.inlineButton}
                    onClick={() => {
                      setSetupStep("upload");
                      logSetupEvent("setup.material_edit_clicked");
                    }}
                    type="button"
                  >
                    <Upload size={14} />
                    자료 수정
                  </button>
                </div>

                <div className={styles.materialSummaryGrid}>
	                  <div className={styles.materialSummaryItem}>
	                    <span>분석 자료</span>
	                    <strong title={preparedImage?.fileName}>{preparedImageDisplayName || "이미지를 먼저 업로드해 주세요"}</strong>
	                    {preparedImage ? <small>{sourceMaterialSummaryLabel}</small> : null}
	                  </div>
                  <div className={styles.materialSummaryItem}>
                    <span>모델 이미지</span>
                    <strong>{modelImage ? modelImageDisplayName : "등록 안 함"}</strong>
                    {modelImage ? <small>{modelImageUsage === "all-sections" ? "전체 모델컷" : "히어로우 참고"}</small> : null}
                  </div>
                  <div className={styles.materialSummaryItem}>
                    <span>추가 정보</span>
                    <strong>{additionalInfo.trim() ? additionalInfo.trim() : "비워둠"}</strong>
                  </div>
                  <div className={styles.materialSummaryItem}>
                    <span>고객 후기</span>
                    <strong>
                      {customerReviewAnalysis
                        ? `후기 파일 분석 완료`
                        : customerReviewSource
                          ? `후기 파일 분석 대기`
                          : "등록 안 함"}
                    </strong>
                    {customerReviewAnalysis ? <small>{customerReviewAnalysis.topBenefits.slice(0, 2).join(" · ")}</small> : null}
                  </div>
                </div>
              </div>

              {showProductImageGuidance ? (
                <div className={styles.uploadContextWarning} role="status">
                  <AlertCircle size={16} />
                  <div>
                    <strong>제품 이미지를 함께 올려주세요</strong>
                    <span>
                      제품 이미지를 별도로 등록해주어야 상세페이지 결과가 좋아집니다. [자료 수정]을 눌러 제품만 단독으로
                      나온 사진 1장을 추가로 올려주세요(기존 자료는 유지됩니다).
                    </span>
                  </div>
                </div>
              ) : null}

              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>출력 방식</span>
                <div className={styles.modeGridCompact}>
                  {OUTPUT_MODE_OPTIONS.map((option) => {
                    const isLocked = Boolean(option.locked);
                    const isActive = outputMode === option.value;

                    return (
                      <button
                        aria-disabled={isLocked}
                        className={isActive ? styles.modeCardActive : styles.modeCard}
                        disabled={isLocked}
                        key={option.value}
                        onClick={() => {
                          if (isLocked) {
                            return;
                          }
                          setOutputMode(option.value);
                          if (option.value === "full-image") {
                            setAiProvider("openai");
                          }
                          setErrorMessage("");
                          setErrorDetail("");
                          setShowErrorDetail(false);
                          logSetupEvent("setup.output_mode_selected", {
                            outputMode: option.value,
                            forcedProvider: option.value === "full-image" ? "openai" : null
                          });
                        }}
                        style={isLocked ? { cursor: "not-allowed", opacity: 0.58 } : undefined}
                        title={isLocked ? "이번 버전에서는 통이미지 모드만 선택할 수 있습니다." : undefined}
                        type="button"
                      >
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                        <em style={isLocked ? { alignItems: "center", display: "inline-flex", gap: 5, lineHeight: 1.1, whiteSpace: "nowrap" } : undefined}>
                          {isLocked ? <KeyRound aria-hidden="true" size={12} style={{ flex: "0 0 auto" }} /> : null}
                          {option.badge}
                        </em>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>AI 모델</span>
                <div className={styles.providerGrid}>
                  {AI_PROVIDER_OPTIONS.map((option) => {
                    const isLocked = outputMode === "full-image" && option.value !== "openai";
                    const isActive = processingProvider === option.value;
                    const hasKey = option.value === "openai" ? hasAvailableOpenAiKey : hasAvailableGeminiKey;

                    return (
                      <button
                        className={isLocked ? styles.providerCardDisabled : isActive ? styles.providerCardActive : styles.providerCard}
                        disabled={isLocked}
                        key={option.value}
                        onClick={() => {
                          setAiProvider(option.value);
                          logSetupEvent("setup.ai_provider_selected", {
                            aiProvider: option.value,
                            hasKey
                          });
                        }}
                        type="button"
                      >
                        <span className={styles.providerIcon}>
                          {option.value === "openai" ? <Bot size={18} /> : <Sparkles size={18} />}
                        </span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                        <em>{isLocked ? "통이미지는 OpenAI" : hasKey ? option.badge : "Codex CLI"}</em>
                      </button>
                    );
                  })}
                </div>
                {selectedProviderUsesCodex ? (
                  <div className={styles.inlineWarning}>
                    <AlertCircle size={16} />
                    개인 API 키가 없어 기본 Codex CLI로 처리합니다.
                  </div>
                ) : null}
              </div>

              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>원하는 톤</span>
                <div className={styles.toneGrid}>
                  {TONE_OPTIONS.map((tone) => {
                    const value = tone === "AI 자동 추천" ? "" : tone;
                    const isActive = desiredTone === value;

                    return (
                      <button
                        className={isActive ? styles.toneButtonActive : styles.toneButton}
                        key={tone}
                        onClick={() => {
                          setDesiredTone(value);
                          logSetupEvent("setup.tone_selected", {
                            tone: value || "auto"
                          });
                        }}
                        type="button"
                      >
                        {tone}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>이미지 비율</span>
                <div className={styles.ratioGrid}>
                  {RATIO_OPTIONS.map((option) => (
                    <button
                      className={option.value === aspectRatio ? styles.ratioButtonActive : styles.ratioButton}
                      key={option.value}
                      onClick={() => {
                        setAspectRatio(option.value);
                        logSetupEvent("setup.aspect_ratio_selected", {
                          aspectRatio: option.value
                        });
                      }}
                      type="button"
                    >
                      <span className={styles.ratioIcon}>{renderRatioIcon(option.icon)}</span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </button>
                  ))}
                </div>
              </div>

              {errorPanel}

              <button className={styles.primaryButtonWide} disabled={!canAnalyze} onClick={handleAnalyze} type="button">
                <Wand2 size={16} />
                {outputMode === "full-image" ? "통이미지 모드로 히어로우 1장 만들기" : "텍스트편집 모드로 히어로우 1장 만들기"}
              </button>
            </section>
            )}
          </div>
        )}

        </div>
        </div>
      </section>

      <DialogPrimitive.Root
        onOpenChange={(open) => {
          if (!open) {
            setIsNoticeModalOpen(false);
          }
        }}
        open={isNoticeModalOpen}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={styles.noticeModalOverlay} />
          <DialogPrimitive.Content className={styles.noticeModalContent}>
            <div className={styles.noticeModalHeader}>
              <div>
                <span className={styles.panelLabel}>안내 사항</span>
                <DialogPrimitive.Title className={styles.noticeModalTitle}>
                  사용 전 꼭 확인해 주세요
                </DialogPrimitive.Title>
              </div>
              <span className={styles.announcementBadge}>3.0 저장/보안 기준</span>
            </div>

            <DialogPrimitive.Description className={styles.noticeModalDescription}>
              API 키와 저장 방식은 개인 PC 기준으로 동작합니다.
            </DialogPrimitive.Description>

            <div className={styles.noticeModalList}>
              {NOTICE_ITEMS.map((item) => (
                <article className={styles.noticeModalItem} key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>

            <label className={styles.noticeModalCheck}>
              <input
                checked={doNotShowNoticeAgain}
                onChange={(event) => setDoNotShowNoticeAgain(event.target.checked)}
                type="checkbox"
              />
              <span>다시 보지 않기</span>
            </label>

            <div className={styles.noticeModalActions}>
              <button className={styles.secondaryButton} onClick={() => closeNoticeModal()} type="button">
                확인했습니다
              </button>
              <button className={styles.primaryButton} onClick={() => closeNoticeModal({ neverShowAgain: true })} type="button">
                다시 보지 않기
              </button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <DialogPrimitive.Root onOpenChange={setIsKnowledgeOpen} open={isKnowledgeOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={styles.noticeModalOverlay} />
          <DialogPrimitive.Content className={styles.knowledgeModalContent}>
            <div className={styles.noticeModalHeader}>
              <div>
                <span className={styles.panelLabel}>사전 지식</span>
                <DialogPrimitive.Title className={styles.noticeModalTitle}>
                  사전 지식 파일 등록
                </DialogPrimitive.Title>
              </div>
              <span className={styles.announcementBadge}>{knowledgeItems.length}개 등록</span>
            </div>

            <DialogPrimitive.Description className={styles.noticeModalDescription}>
              PDF/TXT/MD 지식파일은 이 브라우저에 저장되며, 생성할 때만 분석 프롬프트에 함께 반영됩니다.
            </DialogPrimitive.Description>

            <button
              className={styles.knowledgeDropzone}
              disabled={isReadingKnowledge}
              onClick={() => knowledgeInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void handleKnowledgeFiles(Array.from(event.dataTransfer.files || []));
              }}
              type="button"
            >
              <span className={styles.dropzoneIcon}>
                {isReadingKnowledge ? <Loader2 className={styles.spinIcon} size={24} /> : <FileText size={24} />}
              </span>
              <strong>{isReadingKnowledge ? "지식파일을 읽는 중입니다" : "PDF, TXT, MD 지식파일 등록"}</strong>
              <p>최대 5개까지 등록됩니다. 긴 문서는 분석에 필요한 텍스트만 압축해 저장합니다.</p>
            </button>
            <input
              accept=".pdf,.txt,.md,text/*,application/pdf"
              className={styles.hiddenInput}
              multiple
              onChange={(event) => {
                void handleKnowledgeFiles(Array.from(event.target.files || []));
                event.target.value = "";
              }}
              ref={knowledgeInputRef}
              type="file"
            />

            <div className={styles.knowledgeInfoBox}>
              <FileText size={16} />
              <p>API 키처럼 서버에 따로 저장하지 않습니다. 다만 분석 요청 시 등록한 지식 텍스트가 선택한 AI 모델로 전달됩니다.</p>
            </div>

            {knowledgeItems.length ? (
              <div className={styles.knowledgeFileList}>
                {knowledgeItems.map((item) => (
                  <article className={styles.knowledgeFileItem} key={item.id}>
                    <div className={styles.knowledgeFileIcon}>
                      <FileText size={16} />
                    </div>
                    <div className={styles.knowledgeFileCopy}>
                      <strong title={item.name}>{formatCompactFileName(item.name, 34)}</strong>
                      <span>
                        {formatBytes(item.size)} · {item.text.length.toLocaleString()}자 · {formatSavedDraftDate(item.createdAt)}
                      </span>
                    </div>
                    <button className={styles.inlineDangerButton} onClick={() => deleteKnowledgeItem(item.id)} type="button">
                      <Trash2 size={14} />
                      삭제
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className={styles.knowledgeModalEmpty}>
                등록된 지식파일이 없습니다. 브랜드 가이드, 금지 표현, 상세페이지 작성 기준을 올려두면 다음 분석부터 함께 반영됩니다.
              </p>
            )}

            <div className={styles.noticeModalActions}>
              <button className={styles.primaryButton} onClick={() => setIsKnowledgeOpen(false)} type="button">
                완료
              </button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <PdpSettingsSheet
        onOpenChange={setIsSettingsOpen}
        onSave={handleSaveSettings}
        open={isSettingsOpen}
        settings={clientSettings}
      />
      <SavedDraftsSheet
        drafts={drafts}
        isLoadingDraft={isLoadingDraft}
        isLoadingDrafts={isLoadingDrafts}
        lastSavedAt={lastSavedAt}
        onDeleteDraft={(draftId) => void handleDeleteDraft(draftId)}
        onLoadDraft={(draftId) => void handleLoadDraft(draftId)}
        onOpenChange={setIsDraftsOpen}
        open={isDraftsOpen}
      />
      <PdpBugReportWidget
        context={{
          surface: "setup",
          appState,
          setupStep,
          outputMode,
          aiProvider: processingProvider,
          selectedProviderLabel,
          hasPreparedImage: Boolean(preparedImage),
          hasModelImage: Boolean(modelImage),
          modelImageUsage: modelImageUsage ?? "",
          knowledgeItemCount: knowledgeItems.length,
          hasActiveDraft: Boolean(activeDraftId),
          saveState,
          errorMessage: errorMessage || undefined
        }}
      />
    </main>
  );
}

function SavedDraftsSheet({
  drafts,
  isLoadingDraft,
  isLoadingDrafts,
  lastSavedAt,
  onDeleteDraft,
  onLoadDraft,
  onOpenChange,
  open
}: {
  drafts: PdpDraftSummary[];
  isLoadingDraft: boolean;
  isLoadingDrafts: boolean;
  lastSavedAt: string | null;
  onDeleteDraft: (draftId: string) => void;
  onLoadDraft: (draftId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className={`${styles.settingsSheet} ${styles.draftsSheet}`} side="right">
        <SheetHeader className={styles.settingsSheetHeader}>
          <div className={styles.settingsSheetKicker}>
            <FolderOpen size={14} />
            저장된 작업
          </div>
          <SheetTitle className={styles.settingsSheetTitle}>이전 작업 선택</SheetTitle>
          <SheetDescription className={styles.settingsSheetDescription}>
            브라우저에 저장된 초안을 선택해 이어서 작업할 수 있습니다.
          </SheetDescription>
        </SheetHeader>

        <div className={styles.draftsSheetBody}>
          <div className={styles.draftsSheetSummary}>
            <span>저장된 작업</span>
            <strong>{isLoadingDrafts ? "확인 중" : `${drafts.length}개`}</strong>
            {lastSavedAt ? <small>최근 저장 {formatSavedDraftDate(lastSavedAt)}</small> : null}
          </div>

          {isLoadingDrafts ? (
            <div className={styles.savedDraftsEmpty}>
              <Loader2 className={styles.spinIcon} size={16} />
              저장된 작업을 불러오는 중입니다.
            </div>
          ) : drafts.length ? (
            <div className={styles.draftsSheetList}>
              {drafts.map((draft) => (
                <article className={styles.draftsSheetCard} key={draft.id}>
                  <div className={styles.savedDraftPreviewFrame}>
                    {draft.thumbnailUrl ? <img alt={draft.title} src={draft.thumbnailUrl} /> : <Sparkles size={18} />}
                  </div>
                  <div className={styles.savedDraftCopy}>
                    <div className={styles.savedDraftHeaderRow}>
                      <strong title={draft.title}>{draft.title}</strong>
                      <span className={styles.savedDraftCountBadge}>{draft.sectionCount}섹션</span>
                    </div>
                    <p className={styles.savedDraftTimestamp}>{formatSavedDraftDate(draft.updatedAt)}</p>
                    <div className={styles.savedDraftPreviewMeta}>
                      <span className={styles.savedDraftStageBadge}>{draft.stageLabel}</span>
                      <span className={styles.savedDraftAspectBadge}>{draft.aspectRatio}</span>
                    </div>
                    <div className={styles.savedDraftActions}>
                      <button className={styles.inlineButton} disabled={isLoadingDraft} onClick={() => onLoadDraft(draft.id)} type="button">
                        <FolderOpen size={14} />
                        불러오기
                      </button>
                      <button className={styles.inlineDangerButton} onClick={() => onDeleteDraft(draft.id)} type="button">
                        <Trash2 size={14} />
                        삭제
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.savedDraftsEmpty}>
              <Clock3 size={16} />
              아직 저장된 작업이 없습니다.
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function UploadDropzone({
  accept = "image/*",
  compact = false,
  description,
  disabled = false,
  enablePaste = false,
  hint,
  multiple = false,
  onSelect,
  selectedFileName,
  title
}: {
  accept?: string;
  compact?: boolean;
  description: string;
  disabled?: boolean;
  enablePaste?: boolean;
  hint: string;
  multiple?: boolean;
  onSelect: (files: File[]) => Promise<void>;
  selectedFileName?: string;
  title: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    if (!enablePaste || disabled) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditablePasteTarget(event.target)) {
        return;
      }

      const files = getImageFilesFromClipboard(event.clipboardData);
      if (!files.length) {
        return;
      }

      event.preventDefault();
      void onSelect(multiple ? files : files.slice(0, 1));
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [disabled, enablePaste, multiple, onSelect]);

  const handleDrag = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragenter" || event.type === "dragover") {
      setDragActive(true);
    } else if (event.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) {
      await onSelect(multiple ? files : files.slice(0, 1));
    }
  };

  return (
    <>
      <input
        accept={accept}
        className={styles.hiddenInput}
        multiple={multiple}
        onChange={async (event) => {
          const files = Array.from(event.target.files || []);
          if (files.length) {
            await onSelect(multiple ? files : files.slice(0, 1));
          }
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />

      <button
        className={`${compact ? styles.dropzoneCompact : ""} ${dragActive ? styles.dropzoneActive : styles.dropzone}`.trim()}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            inputRef.current?.click();
          }
        }}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        type="button"
      >
        <div className={styles.dropzoneIcon}>
          <Upload size={24} />
        </div>
        <strong>{title}</strong>
        <p>{description}</p>
        <span className={styles.dropzoneHint}>{selectedFileName ? `선택됨: ${selectedFileName}` : hint}</span>
      </button>
    </>
  );
}

function getImageFilesFromClipboard(clipboardData: DataTransfer | null) {
  const itemFiles = Array.from(clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  const files = itemFiles.length
    ? itemFiles
    : Array.from(clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));

  return files.map((file, index) => normalizeClipboardImageFile(file, index));
}

function normalizeClipboardImageFile(file: File, index: number) {
  const mimeType = file.type || "image/png";
  const genericName = !file.name || /^image\.(png|jpe?g|webp|gif|avif)$/i.test(file.name);
  if (!genericName) {
    return file;
  }

  const extension = extensionFromImageMimeType(mimeType);
  return new File([file], `clipboard-image-${Date.now()}-${index + 1}.${extension}`, {
    type: mimeType,
    lastModified: Date.now()
  });
}

function extensionFromImageMimeType(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/avif") return "avif";
  return "png";
}

function isEditablePasteTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']"));
}

function renderRatioIcon(icon: "square" | "portrait" | "phone" | "landscape" | "wide") {
  if (icon === "square") {
    return <Square size={18} />;
  }
  if (icon === "portrait") {
    return <RectangleVertical size={18} />;
  }
  if (icon === "phone") {
    return <Smartphone size={18} />;
  }
  if (icon === "wide") {
    return <RectangleHorizontal size={18} style={{ transform: "scaleX(1.2)" }} />;
  }
  return <RectangleHorizontal size={18} />;
}

function summarizeFileForUsageLog(file: File) {
  return {
    size: file.size,
    type: file.type || "unknown",
    extension: getFileExtension(file.name)
  };
}

function summarizePreparedImageForUsageLog(image: PreparedImage) {
  const metadata = image.analysisMetadata;
  return {
    mimeType: image.mimeType,
    hasGenerationImage: Boolean(image.generationBase64),
    analysisMode: metadata?.mode ?? "unknown",
    originalWidth: metadata?.originalWidth,
    originalHeight: metadata?.originalHeight,
    optimizedWidth: metadata?.optimizedWidth,
    optimizedHeight: metadata?.optimizedHeight,
    originalBytes: metadata?.originalBytes,
    optimizedBytes: metadata?.optimizedBytes,
    sampleCount: metadata?.sampleCount
  };
}

function isSupportedSourceMaterialFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("image/")
    || /\.(png|jpe?g|webp|gif|avif)$/i.test(name)
    || file.type === "application/pdf"
    || name.endsWith(".pdf");
}

async function prepareSourceMaterialFile(file: File): Promise<PdpSourceMaterialDraft> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return preparePdfSourceMaterial(file);
  }

  const preparedImage = await prepareImageFile(file, { allowLongPageSampling: true });
  return {
    id: createSourceMaterialId(file),
    kind: "image",
    role: "supporting",
    fileName: file.name.slice(0, 160),
    mimeType: file.type || preparedImage.mimeType,
    size: file.size,
    // Keep the original upload handle for the session so productCutRegion can be re-cropped
    // from full-resolution pixels after analysis (dropped at draft-save by normalization).
    preparedImage: { ...preparedImage, sourceFile: file },
    previewUrl: preparedImage.previewUrl
  };
}

async function preparePdfSourceMaterial(file: File): Promise<PdpSourceMaterialDraft> {
  const source = await extractPdfSourceData(file);
  return {
    id: createSourceMaterialId(file),
    kind: "pdf",
    role: "supporting",
    fileName: file.name.slice(0, 160),
    mimeType: "application/pdf",
    size: file.size,
    pageCount: source.pageCount,
    text: source.text.slice(0, MAX_SOURCE_MATERIAL_TEXT_CHARS_PER_FILE),
    preparedImage: source.preparedImage,
    previewUrl: source.preparedImage.previewUrl
  };
}

async function extractPdfSourceData(file: File) {
  const pdfjs = await import("pdfjs-dist");
  // Self-hosted worker (public/pdf.worker.min.mjs). The `new URL(..., import.meta.url)` form forces
  // webpack to bundle the worker and breaks `next build`; a static path avoids it. Re-copy from
  // node_modules/pdfjs-dist/build/pdf.worker.min.mjs whenever pdfjs-dist is upgraded.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const textPages: string[] = [];
  const renderedPages: HTMLCanvasElement[] = [];
  const pageCount = pdf.numPages;
  const readPageCount = Math.min(pageCount, MAX_PDF_TEXT_PAGES);

  for (let pageNumber = 1; pageNumber <= readPageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);

    if (pageNumber <= MAX_PDF_ANALYSIS_PAGES) {
      renderedPages.push(await renderPdfPageToCanvas(page));
    }

    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (text) {
      textPages.push(`[${file.name} p.${pageNumber}] ${text}`);
    }

    if (textPages.join("\n").length >= MAX_SOURCE_MATERIAL_TEXT_CHARS_PER_FILE) {
      break;
    }
  }

  if (!renderedPages.length) {
    throw new Error("PDF 대표 페이지를 이미지로 변환하지 못했습니다.");
  }

  const combined = combinePdfPageCanvases(renderedPages);
  const dataUrl = combined.canvas.toDataURL("image/jpeg", 0.86);
  const parsed = parseDataUrlParts(dataUrl);
  const optimizedBytes = estimateBase64Bytes(parsed.base64);
  const preparedImage: PreparedImage = {
    base64: parsed.base64,
    mimeType: parsed.mimeType,
    previewUrl: dataUrl,
    fileName: file.name,
    generationBase64: parsed.base64,
    generationMimeType: parsed.mimeType,
    generationPreviewUrl: dataUrl,
    analysisMetadata: {
      mode: "standard-resize",
      originalWidth: combined.width,
      originalHeight: combined.height,
      optimizedWidth: combined.width,
      optimizedHeight: combined.height,
      originalBytes: file.size,
      optimizedBytes
    }
  };

  return {
    pageCount,
    text: textPages.join("\n").slice(0, MAX_SOURCE_MATERIAL_TEXT_CHARS_PER_FILE),
    preparedImage
  };
}

async function renderPdfPageToCanvas(page: any) {
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.6, PDF_ANALYSIS_RENDER_WIDTH / Math.max(viewport.width, 1));
  const scaledViewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(scaledViewport.width));
  canvas.height = Math.max(1, Math.ceil(scaledViewport.height));
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new Error("PDF 렌더링 캔버스를 만들지 못했습니다.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
  return canvas;
}

function combinePdfPageCanvases(pages: HTMLCanvasElement[]) {
  const gap = pages.length > 1 ? 18 : 0;
  const width = Math.max(...pages.map((page) => page.width));
  const height = pages.reduce((sum, page) => sum + page.height, 0) + gap * Math.max(0, pages.length - 1);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new Error("PDF 대표 이미지를 합치지 못했습니다.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  let y = 0;
  pages.forEach((page) => {
    const x = Math.floor((width - page.width) / 2);
    context.drawImage(page, x, y);
    y += page.height + gap;
  });

  return { canvas, width, height };
}

function parseDataUrlParts(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("분석용 이미지 데이터 형식이 올바르지 않습니다.");
  }

  return {
    mimeType: match[1],
    base64: match[2]
  };
}

function estimateBase64Bytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function createSourceMaterialId(file: File) {
  return `${Date.now()}-${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Role auto-assignment: a long detail page always owns the PRIMARY role (strips + verbatim
 * transcription = the content source), regardless of upload order. A clean product photo
 * uploaded first therefore stays a supporting appearance reference instead of silently
 * demoting the detail page and killing its content capture. No UI change — the upload zone
 * and slot count stay exactly as shown in the published tutorial video.
 */
function pickPrimarySourceMaterial(materials: PdpSourceMaterialDraft[]) {
  return (
    materials.find((material) => material.preparedImage?.analysisMetadata?.mode === "long-detail-strips") ??
    materials.find((material) => material.preparedImage)
  );
}

/**
 * True when the upload set has a long detail page but NO standalone product image candidate
 * (a non-long, non-PDF image). Drives the "제품 이미지를 별도로 등록" guidance — without it
 * most users upload only the detail page and hero appearance becomes a coin flip
 * (measured: productCutConfidence 0.22 on a real subscriber-style page).
 */
function needsProductImageGuidance(materials: PdpSourceMaterialDraft[]) {
  const hasLongPage = materials.some(
    (material) => material.preparedImage?.analysisMetadata?.mode === "long-detail-strips"
  );
  const hasProductImageCandidate = materials.some(
    (material) =>
      material.kind === "image" &&
      material.preparedImage &&
      material.preparedImage.analysisMetadata?.mode !== "long-detail-strips"
  );
  return hasLongPage && !hasProductImageCandidate;
}

function markPrimarySourceMaterial(
  materials: PdpSourceMaterialDraft[],
  primaryId: string,
  primaryImage: PreparedImage
) {
  return materials.map((material) => ({
    ...material,
    role: material.id === primaryId ? "primary" as const : "supporting" as const,
    preparedImage: material.id === primaryId ? primaryImage : material.preparedImage,
    previewUrl: material.id === primaryId ? primaryImage.previewUrl : material.previewUrl
  }));
}

function getVisibleSourceMaterials(materials: PdpSourceMaterialDraft[], preparedImage: PreparedImage | null) {
  if (materials.length) {
    return materials;
  }

  return preparedImage ? [buildFallbackSourceMaterial(preparedImage)] : [];
}

function buildFallbackSourceMaterial(preparedImage: PreparedImage): PdpSourceMaterialDraft {
  return {
    id: "primary-source-material",
    kind: isPdfPreparedImage(preparedImage) ? "pdf" : "image",
    role: "primary",
    fileName: preparedImage.fileName,
    mimeType: isPdfPreparedImage(preparedImage) ? "application/pdf" : preparedImage.mimeType,
    size: preparedImage.analysisMetadata?.originalBytes ?? 0,
    preparedImage,
    previewUrl: preparedImage.previewUrl
  };
}

function getSourceMaterialsForDraft(materials: PdpSourceMaterialDraft[], preparedImage: PreparedImage | null) {
  return getVisibleSourceMaterials(materials, preparedImage).slice(0, MAX_SOURCE_MATERIAL_FILES);
}

function syncSourceMaterialsWithPrimary(materials: PdpSourceMaterialDraft[], primaryImage: PreparedImage) {
  const draftMaterials = getSourceMaterialsForDraft(materials, primaryImage);
  const primaryIndex = Math.max(0, draftMaterials.findIndex((material) => material.role === "primary"));

  return draftMaterials.map((material, index) => ({
    ...material,
    role: index === primaryIndex ? "primary" as const : "supporting" as const,
    kind: index === primaryIndex && isPdfPreparedImage(primaryImage) ? "pdf" as const : material.kind,
    fileName: index === primaryIndex ? primaryImage.fileName : material.fileName,
    mimeType: index === primaryIndex && isPdfPreparedImage(primaryImage) ? "application/pdf" : material.mimeType,
    preparedImage: index === primaryIndex ? primaryImage : material.preparedImage,
    previewUrl: index === primaryIndex ? primaryImage.previewUrl : material.previewUrl
  }));
}

function buildAnalyzeSourceMaterials(materials: PdpSourceMaterialDraft[]): PdpSourceMaterial[] | undefined {
  let remainingTextBudget = MAX_SOURCE_MATERIAL_TEXT_CHARS;
  const result = materials.slice(0, MAX_SOURCE_MATERIAL_FILES).map((material) => {
    const text = material.text && remainingTextBudget > 0
      ? material.text.slice(0, Math.min(MAX_SOURCE_MATERIAL_TEXT_CHARS_PER_FILE, remainingTextBudget))
      : undefined;
    if (text) {
      remainingTextBudget -= text.length;
    }

    const includeImagePayload = material.role !== "primary" && material.preparedImage;
    return {
      kind: material.kind,
      role: material.role,
      fileName: material.fileName,
      mimeType: material.mimeType,
      size: material.size,
      pageCount: material.pageCount,
      text,
      imageBase64: includeImagePayload ? material.preparedImage?.base64 : undefined,
      imageMimeType: includeImagePayload ? material.preparedImage?.mimeType : undefined,
      imageOptimization: material.preparedImage?.analysisMetadata
    };
  });

  return result.length ? result : undefined;
}

function buildSourceMaterialsNotice(materials: PdpSourceMaterialDraft[], skippedCount: number) {
  const summary = summarizeSourceMaterialsForUi(materials);
  const skipped = skippedCount ? ` 최대 ${MAX_SOURCE_MATERIAL_FILES}개까지만 반영되어 ${skippedCount}개는 제외했습니다.` : "";
  return `${summary}를 준비했습니다. 상세페이지 이미지는 최대 ${MAX_TRANSCRIBE_PAGES}장까지 원문을 읽고, 제품 이미지는 제품 생김새 참조로 사용합니다.${skipped}`;
}

function buildUploadContextGuidance(materials: PdpSourceMaterialDraft[], additionalInfo: string): UploadContextGuidance | null {
  if (!materials.length) {
    return null;
  }

  const normalizedAdditionalInfo = normalizeProductContextText(additionalInfo);
  if (hasUsefulProductContext(normalizedAdditionalInfo)) {
    return {
      tone: "ready",
      title: "추가 정보가 판단에 반영됩니다",
      message: "입력한 상품명/카테고리 정보가 분석과 섹션 확장 보조 판단에 함께 반영됩니다.",
      reason: "additional_info_present"
    };
  }

  const extractedTextLength = materials
    .map((material) => normalizeProductContextText(material.text ?? ""))
    .join(" ")
    .replace(/\s/g, "").length;
  const imageOnlyCount = materials.filter((material) => material.kind === "image" && !material.text?.trim()).length;
  const hasTextContext = extractedTextLength >= 36;
  const hasOnlyImageContext = imageOnlyCount === materials.length;

  if (hasOnlyImageContext || !hasTextContext) {
    return {
      tone: "warning",
      title: "입력 정보가 조금 부족할 수 있습니다",
      message: PRODUCT_CONTEXT_GUIDANCE_MESSAGE,
      reason: hasOnlyImageContext ? "image_only_context" : "weak_text_context"
    };
  }

  return null;
}

function normalizeProductContextText(value: string) {
  return value.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function hasUsefulProductContext(value: string) {
  if (value.length < 4) {
    return false;
  }

  return /[가-힣A-Za-z]/.test(value);
}

function summarizeSourceMaterialsForUi(materials: PdpSourceMaterialDraft[]) {
  const longPageCount = materials.filter(
    (material) => material.kind === "image" && material.preparedImage?.analysisMetadata?.mode === "long-detail-strips"
  ).length;
  const productImageCount = materials.filter(
    (material) => material.kind === "image" && material.preparedImage?.analysisMetadata?.mode !== "long-detail-strips"
  ).length;
  const pdfCount = materials.filter((material) => material.kind === "pdf").length;
  const parts = [
    longPageCount ? `상세페이지 ${longPageCount}장` : "",
    productImageCount ? `제품 이미지 ${productImageCount}장` : "",
    pdfCount ? `PDF ${pdfCount}개` : ""
  ].filter(Boolean);

  return parts.join(" · ") || `${materials.length}개 자료`;
}

/**
 * 자료 카드 라벨 — 내용 유형 기준. "대표 분석 자료/보조 이미지"는 대표만 분석하는 것처럼
 * 읽혀 혼동을 부르므로(한이룸 피드백), 긴 상세페이지는 "상세페이지 이미지 N"으로 번호를
 * 매기고 제품 사진은 "제품 이미지"로 표시한다.
 */
function buildSourceMaterialTypeLabels(materials: PdpSourceMaterialDraft[]): Map<string, string> {
  const longPageIds = materials
    .filter(
      (material) => material.kind === "image" && material.preparedImage?.analysisMetadata?.mode === "long-detail-strips"
    )
    .map((material) => material.id);
  const labels = new Map<string, string>();
  materials.forEach((material) => {
    if (material.kind === "pdf") {
      labels.set(material.id, "PDF 자료");
      return;
    }
    if (material.preparedImage?.analysisMetadata?.mode === "long-detail-strips") {
      const index = longPageIds.indexOf(material.id);
      labels.set(material.id, longPageIds.length > 1 ? `상세페이지 이미지 ${index + 1}` : "상세페이지 이미지");
      return;
    }
    labels.set(material.id, "제품 이미지");
  });
  return labels;
}

function formatSourceMaterialKind(material: PdpSourceMaterialDraft) {
  return material.kind === "pdf" ? "PDF 자료" : "보조 이미지";
}

function formatSourceMaterialDetail(material: PdpSourceMaterialDraft) {
  if (material.kind === "pdf") {
    const pageLabel = material.pageCount ? `${material.pageCount}p` : "PDF";
    return `${pageLabel} · ${material.text ? "텍스트 반영" : "대표 화면 반영"}`;
  }

  return material.preparedImage
    ? `${formatAnalysisMode(material.preparedImage)} · ${formatOptimizedDimensions(material.preparedImage)}`
    : formatBytes(material.size ?? 0);
}

type CustomerReviewRow = {
  text: string;
  rating?: number;
};

const CUSTOMER_REVIEW_ANALYSIS_SAMPLE_SIZE = 250;
const CUSTOMER_REVIEW_TEXT_HEADER = /(후기|리뷰|상품평|구매평|내용|평가|comment|review|message|opinion|content|body)/i;
const CUSTOMER_REVIEW_RATING_HEADER = /(평점|별점|점수|rating|score|star)/i;

function isSupportedCustomerReviewFile(file: File) {
  return /\.(xlsx|csv|tsv|txt)$/i.test(file.name)
    || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || file.type === "text/csv"
    || file.type === "text/tab-separated-values"
    || file.type === "text/plain";
}

async function extractCustomerReviewRows(file: File): Promise<CustomerReviewRow[]> {
  const name = file.name.toLowerCase();
  const matrix = name.endsWith(".xlsx") || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ? await extractXlsxMatrix(file)
    : parseDelimitedText(await file.text(), name.endsWith(".tsv") ? "\t" : undefined);

  return matrixToCustomerReviewRows(matrix);
}

async function extractXlsxMatrix(file: File) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sharedStrings = await extractXlsxSharedStrings(zip);
  const worksheetPaths = Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  for (const path of worksheetPaths) {
    const xml = await zip.file(path)?.async("text");
    if (!xml) {
      continue;
    }

    const rows = parseXlsxWorksheet(xml, sharedStrings);
    if (rows.some((row) => row.some(Boolean))) {
      return rows;
    }
  }

  return [];
}

async function extractXlsxSharedStrings(zip: JSZip) {
  const xml = await zip.file("xl/sharedStrings.xml")?.async("text");
  if (!xml) {
    return [];
  }

  const doc = parseXmlDocument(xml);
  return Array.from(doc.getElementsByTagName("si")).map((item) =>
    Array.from(item.getElementsByTagName("t"))
      .map((node) => node.textContent || "")
      .join("")
  );
}

function parseXlsxWorksheet(xml: string, sharedStrings: string[]) {
  const doc = parseXmlDocument(xml);
  return Array.from(doc.getElementsByTagName("row")).map((row) => {
    const cells: string[] = [];

    Array.from(row.getElementsByTagName("c")).forEach((cell, fallbackIndex) => {
      const cellReference = cell.getAttribute("r") || "";
      const columnName = cellReference.replace(/\d+/g, "");
      const columnIndex = columnName ? getSpreadsheetColumnIndex(columnName) : fallbackIndex;
      const cellType = cell.getAttribute("t") || "";
      const rawValue = cell.getElementsByTagName("v")[0]?.textContent || "";
      let value = rawValue;

      if (cellType === "s") {
        value = sharedStrings[Number(rawValue)] || "";
      } else if (cellType === "inlineStr") {
        value = Array.from(cell.getElementsByTagName("t"))
          .map((node) => node.textContent || "")
          .join("");
      }

      cells[columnIndex] = normalizeReviewCell(value);
    });

    return cells.map((cell) => cell || "");
  });
}

function parseXmlDocument(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("엑셀 파일 구조를 읽지 못했습니다. 파일을 다시 저장한 뒤 업로드해 주세요.");
  }
  return doc;
}

function getSpreadsheetColumnIndex(columnName: string) {
  return columnName
    .toUpperCase()
    .split("")
    .reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseDelimitedText(text: string, forcedDelimiter?: string) {
  const delimiter = forcedDelimiter ?? (text.includes("\t") ? "\t" : ",");
  const rows: string[][] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        currentCell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      currentRow.push(normalizeReviewCell(currentCell));
      currentCell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      currentRow.push(normalizeReviewCell(currentCell));
      if (currentRow.some(Boolean)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  currentRow.push(normalizeReviewCell(currentCell));
  if (currentRow.some(Boolean)) {
    rows.push(currentRow);
  }

  return rows;
}

function matrixToCustomerReviewRows(matrix: string[][]): CustomerReviewRow[] {
  const rows = matrix
    .map((row) => row.map(normalizeReviewCell))
    .filter((row) => row.some(Boolean));
  const headerIndex = rows.findIndex((row) => row.some((cell) => CUSTOMER_REVIEW_TEXT_HEADER.test(cell)));
  const header = headerIndex >= 0 ? rows[headerIndex] : [];
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const reviewColumnIndexes = header
    .map((cell, index) => CUSTOMER_REVIEW_TEXT_HEADER.test(cell) ? index : -1)
    .filter((index) => index >= 0);
  const ratingColumnIndexes = header
    .map((cell, index) => CUSTOMER_REVIEW_RATING_HEADER.test(cell) ? index : -1)
    .filter((index) => index >= 0);
  const inferredReviewIndexes = reviewColumnIndexes.length ? reviewColumnIndexes : inferLikelyReviewColumns(dataRows);

  return dataRows
    .map((row) => {
      const textCells = inferredReviewIndexes.length
        ? inferredReviewIndexes.map((index) => row[index]).filter(Boolean)
        : row.filter((cell) => isLikelyReviewText(cell));
      const text = normalizeReviewText(textCells.join(" "));
      const rating = ratingColumnIndexes
        .map((index) => parseReviewRating(row[index]))
        .find((value): value is number => typeof value === "number")
        ?? row.map(parseReviewRating).find((value): value is number => typeof value === "number");

      return { text, rating };
    })
    .filter((row) => row.text.length >= 4);
}

function inferLikelyReviewColumns(rows: string[][]) {
  const maxColumns = Math.max(0, ...rows.map((row) => row.length));
  const scores = Array.from({ length: maxColumns }, (_, columnIndex) => {
    const cells = rows.map((row) => row[columnIndex] || "").filter(isLikelyReviewText);
    const averageLength = cells.length ? cells.reduce((sum, cell) => sum + cell.length, 0) / cells.length : 0;
    return { columnIndex, score: cells.length * 4 + averageLength };
  });

  return scores
    .filter((item) => item.score > 16)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((item) => item.columnIndex);
}

function uniqueReviewRows(rows: CustomerReviewRow[]) {
  const seen = new Set<string>();
  const result: CustomerReviewRow[] = [];

  rows.forEach((row) => {
    const text = normalizeReviewText(row.text);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push({ text, rating: row.rating });
  });

  return result;
}

function sampleCustomerReviewRowsEvenly(rows: CustomerReviewRow[], maxCount: number) {
  if (rows.length <= maxCount) {
    return rows;
  }

  if (maxCount <= 1) {
    return rows.slice(0, Math.max(0, maxCount));
  }

  const result: CustomerReviewRow[] = [];
  const usedIndexes = new Set<number>();
  const maxIndex = rows.length - 1;

  for (let sampleIndex = 0; sampleIndex < maxCount; sampleIndex += 1) {
    const rowIndex = Math.round((sampleIndex * maxIndex) / (maxCount - 1));

    if (usedIndexes.has(rowIndex)) {
      continue;
    }

    usedIndexes.add(rowIndex);
    result.push(rows[rowIndex]);
  }

  return result;
}

function normalizeReviewCell(value: string | undefined) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeReviewText(value: string) {
  return normalizeReviewCell(value)
    .replace(/^(후기|리뷰|내용|comment|review)\s*[:：-]?\s*/i, "")
    .trim();
}

function isLikelyReviewText(value: string | undefined) {
  const text = normalizeReviewCell(value);
  return text.length >= 8 && /[가-힣A-Za-z]/.test(text) && !CUSTOMER_REVIEW_TEXT_HEADER.test(text);
}

function parseReviewRating(value: string | undefined) {
  const text = normalizeReviewCell(value);
  const match = text.match(/([1-5](?:\.\d)?)/);
  if (!match) {
    return undefined;
  }
  const rating = Number(match[1]);
  return rating >= 1 && rating <= 5 ? rating : undefined;
}


function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "none";
}

function createDefaultEditorDraftState(result: GeneratedResult, outputMode: PdpOutputMode): PdpEditorDraftState {
  const isHeroOnly = result.blueprint.sections.length === 1;

  return {
    currentSectionIndex: 0,
    sections: result.blueprint.sections.map((section) => ({ ...section })),
    sectionOptions: {},
    overlaysBySection: {},
    defaultCopyLanguage: "ko",
    notice: isHeroOnly
      ? "히어로우 1장을 확인한 뒤 왼쪽에서 상세페이지 섹션 타입을 고르고 나머지 섹션을 한 번에 생성하세요."
      : outputMode === "full-image"
        ? "통이미지 모드 전체 섹션을 확인하고, 필요한 컷만 이미지 옵션에서 다시 조정할 수 있습니다."
        : "전체 섹션 컷과 기본 텍스트 레이아웃을 확인한 뒤 바로 편집하거나 다운로드할 수 있습니다.",
    heroWarning: "",
    workbenchTab: "image",
    workbenchState: {
      x: 756,
      y: 24,
      width: 332,
      height: 500,
      isOpen: true
    }
  };
}

function clientPreferredProvider(settings: PdpClientSettings): PdpAiProvider {
  if (settings.preferredAiProvider) {
    return settings.preferredAiProvider;
  }

  if (settings.customOpenAiApiKey.trim() && !settings.customGeminiApiKey.trim()) {
    return "openai";
  }

  return "gemini";
}

function loadKnowledgeItems() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const savedValue = window.localStorage.getItem(KNOWLEDGE_STORAGE_KEY);
    if (!savedValue) {
      return [];
    }

    const parsed = JSON.parse(savedValue) as KnowledgeItem[];
    return parsed
      .filter((item) => item?.id && item.name && item.text)
      .slice(0, MAX_KNOWLEDGE_ITEMS)
      .map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type || inferKnowledgeFileType(item.name),
        size: Number(item.size) || 0,
        text: item.text.slice(0, 18000),
        createdAt: item.createdAt || new Date().toISOString()
      }));
  } catch {
    window.localStorage.removeItem(KNOWLEDGE_STORAGE_KEY);
    return [];
  }
}

function buildKnowledgeText(items: KnowledgeItem[]) {
  return items
    .map((item, index) => `# 등록 지식파일 ${index + 1}: ${item.name}\n${item.text}`)
    .join("\n\n")
    .slice(0, MAX_KNOWLEDGE_TEXT_CHARS);
}

function isSupportedKnowledgeFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type === "application/pdf"
    || file.type.startsWith("text/")
    || name.endsWith(".pdf")
    || name.endsWith(".txt")
    || name.endsWith(".md")
    || name.endsWith(".markdown");
}

function inferKnowledgeFileType(fileName: string) {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (name.endsWith(".md") || name.endsWith(".markdown")) {
    return "text/markdown";
  }
  return "text/plain";
}

async function extractKnowledgeText(file: File) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return extractPdfText(file);
  }

  if (file.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(file.name)) {
    return file.text();
  }

  return "";
}

async function extractPdfText(file: File) {
  const pdfjs = await import("pdfjs-dist");
  // Self-hosted worker (public/pdf.worker.min.mjs). The `new URL(..., import.meta.url)` form forces
  // webpack to bundle the worker and breaks `next build`; a static path avoids it. Re-copy from
  // node_modules/pdfjs-dist/build/pdf.worker.min.mjs whenever pdfjs-dist is upgraded.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageCount = Math.min(pdf.numPages, 80);
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ");

    if (text.trim()) {
      pages.push(`[${file.name} p.${pageNumber}] ${text}`);
    }

    if (pages.join("\n").length > MAX_KNOWLEDGE_TEXT_CHARS) {
      break;
    }
  }

  return pages.join("\n");
}

function formatDuration(totalSeconds: number) {
  const normalizedSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(normalizedSeconds / 60);
  const seconds = normalizedSeconds % 60;

  if (!minutes) {
    return `${seconds}초`;
  }

  return `${minutes}분 ${String(seconds).padStart(2, "0")}초`;
}

function buildPreparedImageNotice(fileName: string, image: PreparedImage) {
  const metadata = image.analysisMetadata;

  if (isPdfPreparedImage(image)) {
    return `${fileName} PDF에서 텍스트와 대표 페이지 이미지를 추출했습니다. 다른 이미지/PDF와 함께 상세페이지 분석에 반영할 수 있습니다.`;
  }

  if (metadata?.mode === "long-detail-sampling") {
    return `${fileName} 상세페이지를 분석용으로 ${metadata.sampleCount ?? 0}컷 샘플링했습니다. LLM에는 ${formatDimensions(metadata.optimizedWidth, metadata.optimizedHeight)} / ${formatBytes(metadata.optimizedBytes)}만 전송합니다.`;
  }

  if (metadata?.mode === "standard-resize") {
    return `${fileName} 이미지가 매우 커서 분석용 ${formatDimensions(metadata.optimizedWidth, metadata.optimizedHeight)} / 생성참조 ${formatDimensions(metadata.generationReferenceWidth ?? 0, metadata.generationReferenceHeight ?? 0)}로 정리했습니다.`;
  }

  return `${fileName} 이미지는 원본 품질로 준비했습니다. 초대형 이미지나 긴 상세페이지일 때만 분석용으로 줄입니다.`;
}

function formatAnalysisMode(image: PreparedImage) {
  const metadata = image.analysisMetadata;

  if (isPdfPreparedImage(image)) {
    return "PDF 대표 화면";
  }

  if (metadata?.mode === "long-detail-sampling") {
    return `장문 샘플 ${metadata.sampleCount ?? 0}컷`;
  }

  if (metadata?.mode === "standard-resize") {
    return "분석용 JPEG";
  }

  return "원본 이미지";
}

function isLongDetailSampling(image: PreparedImage) {
  return image.analysisMetadata?.mode === "long-detail-sampling";
}

function isOriginalImage(image: PreparedImage) {
  return image.analysisMetadata?.mode === "original";
}

function formatOptimizationSavings(image: PreparedImage) {
  const metadata = image.analysisMetadata;

  if (isPdfPreparedImage(image)) {
    return "PDF 텍스트 반영";
  }

  if (!metadata) {
    return "원본 유지";
  }

  if (isOriginalImage(image)) {
    return "원본 유지";
  }

  if (metadata?.mode === "standard-resize") {
    return "분석용 축소";
  }

  if (!metadata?.originalBytes || !metadata.optimizedBytes) {
    return "상세페이지만 절감";
  }

  const ratio = metadata.originalBytes / metadata.optimizedBytes;

  if (ratio < 1.05) {
    return "상세페이지만 절감";
  }

  return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}배 절감`;
}

function formatGenerationReference(image: PreparedImage) {
  const metadata = image.analysisMetadata;

  if (isPdfPreparedImage(image)) {
    return "PDF 대표 페이지";
  }

  if (metadata?.mode === "long-detail-sampling" && metadata.generationReferenceWidth && metadata.generationReferenceHeight) {
    return `상단 ${formatDimensions(metadata.generationReferenceWidth, metadata.generationReferenceHeight)}`;
  }

  if (metadata?.mode === "standard-resize" && metadata.generationReferenceWidth && metadata.generationReferenceHeight) {
    return formatDimensions(metadata.generationReferenceWidth, metadata.generationReferenceHeight);
  }

  return "원본 이미지";
}

function formatOptimizedDimensions(image: PreparedImage) {
  const metadata = image.analysisMetadata;

  if (!metadata) {
    return "원본 전송";
  }

  return `${formatDimensions(metadata.optimizedWidth, metadata.optimizedHeight)} · ${formatBytes(metadata.optimizedBytes)}`;
}

function isPdfPreparedImage(image: PreparedImage) {
  return image.fileName.toLowerCase().endsWith(".pdf");
}

function formatDimensions(width: number, height: number) {
  return `${Math.max(0, Math.round(width))}x${Math.max(0, Math.round(height))}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "크기 미상";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatSavedDraftDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "방금";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatCompactFileName(fileName: string, maxBaseLength = 30) {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return fileName;
  }

  const lastDotIndex = trimmed.lastIndexOf(".");
  const hasExtension = lastDotIndex > 0 && lastDotIndex < trimmed.length - 1;
  const extension = hasExtension ? trimmed.slice(lastDotIndex) : "";
  const baseName = hasExtension ? trimmed.slice(0, lastDotIndex) : trimmed;

  if (baseName.length <= maxBaseLength) {
    return trimmed;
  }

  const leadingLength = Math.max(14, Math.floor(maxBaseLength * 0.58));
  const trailingLength = Math.max(8, maxBaseLength - leadingLength);
  return `${baseName.slice(0, leadingLength)}…${baseName.slice(-trailingLength)}${extension}`;
}
