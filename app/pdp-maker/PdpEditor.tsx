"use client";

import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas";
import JSZip from "jszip";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy as CopyIcon,
  Download,
  Globe2,
  GripVertical,
  Image as ImageIcon,
  Loader2,
  Lock,
  Palette,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Type,
  User
} from "lucide-react";
import { Rnd } from "react-rnd";
import type {
  AspectRatio,
  GeneratedResult,
  ImageGenOptions,
  PdpAiProvider,
  PdpCopyLanguage,
  PdpCustomerReviewAnalysis,
  PdpOutputMode,
  PdpGenerateImageResponse,
  PdpExpandResponse,
  PdpExpandStyleGuide,
  PdpExpansionStyle,
  SectionBlueprint,
  ReferenceModelUsage
} from "@runacademy/shared";
import { getPdpSectionImageDefaults, normalizePdpReviewBenefitSalesCopyList } from "@runacademy/shared";
import type {
  CanvasLayer,
  FloatingWorkbenchState,
  OverlayTextAlign,
  PdpEditorDraftState,
  PreparedImageDraft,
  ShapeLayer,
  TextOverlay,
  WorkbenchTab
} from "./pdp-drafts";
import { PdpBugReportWidget } from "./PdpBugReportWidget";
import { WaitingMiniGame } from "./WaitingMiniGames";
import styles from "./pdp-maker.module.css";
import { logPdpUsage } from "./pdp-usage-log";
import { apiJson, GENERATION_API_TIMEOUT_MS, toDataUrl } from "./pdp-utils";

interface PdpEditorProps {
  initialResult: GeneratedResult;
  aspectRatio: AspectRatio;
  aiProvider?: PdpAiProvider;
  outputMode?: PdpOutputMode;
  geminiApiKey?: string | null;
  openAiApiKey?: string | null;
  desiredTone: string;
  additionalInfo?: string;
  customerReviewAnalysis?: PdpCustomerReviewAnalysis | null;
  initialDraftState?: PdpEditorDraftState | null;
  lastSavedAt?: string | null;
  manualSaveToastToken?: number;
  onOpenSettings?: () => void;
  onReset: () => void;
  onDraftStateChange?: (draftState: PdpEditorDraftState) => void;
  onManualSave?: () => void;
  apiConnectionLabel?: string;
  referenceModelImage?: PreparedImageDraft | null;
  referenceModelUsage?: ReferenceModelUsage | null;
  saveState?: "idle" | "saving" | "saved" | "error";
}

interface ImageColorRecommendations {
  photoColors: string[];
  recommendedTextColors: string[];
  recommendedShapeColors: string[];
  accentColor: string;
  darkColor: string;
  lightColor: string;
}

type WaitingVideo = {
  videoId: string;
  title: string;
  url: string;
  embedUrl: string;
};

type WaitingActivity = "video" | "game";

const DEFAULT_WAITING_VIDEO: WaitingVideo = {
  videoId: "ffsqj3Re33E",
  title: "한이룸 유튜브 추천 영상",
  url: "https://www.youtube.com/watch?v=ffsqj3Re33E",
  embedUrl: "https://www.youtube.com/embed/ffsqj3Re33E?rel=0&modestbranding=1"
};
const WAITING_VIDEO_CLIENT_TIMEOUT_MS = 2500;
const WAITING_PROGRESS_INTERVAL_MS = 650;
const WAITING_SINGLE_IMAGE_ESTIMATE_MS = 42000;
const WAITING_BATCH_IMAGE_ESTIMATE_MS = 32000;
const WAITING_REGENERATION_ESTIMATE_MS = 52000;

type PdpSection = GeneratedResult["blueprint"]["sections"][number];
type TextLayoutTemplateKind =
  | "hero"
  | "question"
  | "concernList"
  | "problem"
  | "bridge"
  | "value"
  | "plan"
  | "proof"
  | "compare"
  | "detail"
  | "lifestyle"
  | "composition"
  | "disclosure"
  | "cta"
  | "generic";

const FONT_OPTIONS = [
  { label: "Pretendard", value: "'Pretendard', sans-serif" },
  { label: "Noto Sans KR", value: "'Noto Sans KR', sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Monospace", value: "monospace" }
];

const STYLE_OPTIONS: Array<{ value: NonNullable<ImageGenOptions["style"]>; label: string; description: string }> = [
  { value: "studio", label: "스튜디오컷", description: "정제된 배경과 집중도 높은 제품 연출" },
  { value: "lifestyle", label: "라이프스타일컷", description: "실사용 장면과 감정선이 느껴지는 연출" },
  { value: "outdoor", label: "아웃도어컷", description: "씬이 살아있는 외부 공간 연출" }
];

const MODEL_GENDER_OPTIONS: Array<{ value: NonNullable<ImageGenOptions["modelGender"]>; label: string }> = [
  { value: "female", label: "여자 모델" },
  { value: "male", label: "남자 모델" }
];

const MODEL_AGE_OPTIONS: Array<{ value: NonNullable<ImageGenOptions["modelAgeRange"]>; label: string }> = [
  { value: "teen", label: "10대 후반" },
  { value: "20s", label: "20대" },
  { value: "30s", label: "30대" },
  { value: "40s", label: "40대" },
  { value: "50s_plus", label: "50대+" }
];

const MODEL_COUNTRY_OPTIONS: Array<{ value: NonNullable<ImageGenOptions["modelCountry"]>; label: string }> = [
  { value: "korea", label: "한국" },
  { value: "japan", label: "일본" },
  { value: "usa", label: "미국" },
  { value: "france", label: "프랑스" },
  { value: "germany", label: "독일" },
  { value: "africa", label: "아프리카" }
];

const FONT_WEIGHT_OPTIONS = [
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "700", label: "Bold" },
  { value: "900", label: "Black" }
];

const ALIGN_OPTIONS: Array<{ value: OverlayTextAlign; label: string; Icon: typeof AlignLeft }> = [
  { value: "left", label: "왼쪽", Icon: AlignLeft },
  { value: "center", label: "가운데", Icon: AlignCenter },
  { value: "right", label: "오른쪽", Icon: AlignRight }
];

const DEFAULT_COLOR_RECOMMENDATIONS: ImageColorRecommendations = {
  photoColors: ["#e8ddcb", "#102532", "#7a6b5a", "#d5b692"],
  recommendedTextColors: ["#ffffff", "#102532", "#f4efe6", "#4cb7aa"],
  recommendedShapeColors: ["#102532", "#1d3748", "#f4efe6", "#85735e", "#c8474d"],
  accentColor: "#4cb7aa",
  darkColor: "#102532",
  lightColor: "#f4efe6"
};
const BASIC_SOLID_COLORS = [
  "#ffffff",
  "#f4efe6",
  "#d9d2c3",
  "#c4b8a0",
  "#c8474d",
  "#e05a63",
  "#102532",
  "#1d3748",
  "#4cb7aa",
  "#cf6f52",
  "#d8b65b",
  "#111111"
];
const APP_TITLE = "한이룸의 상세페이지 마법사 3.0";
const EDITOR_CANVAS_BASE_WIDTH = 460;
const EXPORT_CANVAS_WIDTH = 1080;
const TEXT_LAYOUT_COLORS = {
  ink: "#102532",
  dark: "#0c161e",
  navy: "#1d3748",
  cream: "#f4efe6",
  surface: "#fbfaf6",
  line: "#d9e1de",
  muted: "#5f6b73",
  white: "#ffffff",
  accent: "#4cb7aa",
  blue: "#2f6bff",
  softBlue: "#eaf1ff",
  coral: "#c8474d",
  gold: "#d8b65b"
};
const EXPANSION_STRATEGIES = [
  {
    id: "storybrand",
    locked: false,
    title: "스토리브랜드 판매 서사",
    range: "7~8장",
    description: "고객 공감, 문제 제기, 제품 가이드, 해결 계획, 구매 제안, 사용 후 변화, 손실 회피로 이어집니다.",
    bestFor: "처음 보는 고객에게 제품 필요성을 차근차근 설득할 때",
    focus: "제품을 단순 소개하지 않고 고객 문제를 해결해주는 가이드로 세웁니다.",
    keyMessage: "이 불편은 반복될 문제가 아니라, 이 제품으로 줄일 수 있는 문제입니다.",
    flowIntent: "공감 -> 문제 확대 -> 제품 등장 -> 해결 계획 -> 구매 제안 -> 사용 후 변화 -> 마지막 확신",
    sections: [
      { id: "S2_Problem", name: "문제 제기", intent: "고객이 이미 느끼는 불편을 생활 장면으로 선명하게 드러냅니다." },
      { id: "S3_Guide", name: "가이드/제품 소개", intent: "그 불편을 줄여줄 제품의 역할을 자연스럽게 등장시킵니다." },
      { id: "S4_Plan", name: "해결 계획", intent: "제품이 어떻게 문제를 줄이는지 짧은 순서로 납득시킵니다." },
      { id: "S5_CTA", name: "구매 제안", intent: "준비가 필요한 순간과 구매 행동을 직접 연결합니다." },
      { id: "S6_Success", name: "사용 후 변화", intent: "구매 후 달라지는 장면을 후기형 메시지로 보여줍니다." },
      { id: "S7_Failure", name: "놓쳤을 때 손실", intent: "구매를 미뤘을 때 반복될 불편을 과장 없이 상기시킵니다." },
      { id: "S8_Close", name: "마지막 확신", intent: "문제와 해결을 한 번 더 묶어 선택을 마무리합니다." }
    ]
  },
  {
    id: "objection",
    locked: true,
    title: "구매저항 해소형",
    range: "7~8장",
    description: "고민, 전환 선언, 비교, 디테일, 근거, FAQ/고시로 구매 불안을 먼저 제거합니다.",
    bestFor: "가격, 효과, 구성, 신뢰 때문에 망설일 가능성이 큰 제품",
    focus: "구매 전 의심과 확인 욕구를 먼저 다루며 안심할 근거를 전면에 둡니다.",
    keyMessage: "고민했던 지점까지 확인했기 때문에 더 안전하게 선택할 수 있습니다.",
    flowIntent: "망설임 인정 -> 전환 선언 -> 비교 기준 -> 디테일 확인 -> 신뢰 근거 -> 마지막 확인",
    sections: [
      { id: "S2_Concern", name: "구매 전 고민", intent: "고객이 망설이는 이유를 먼저 끄집어냅니다." },
      { id: "S3_Bridge", name: "전환 선언", intent: "그 고민을 이해하고 개선했다는 짧은 선언으로 흐름을 바꿉니다." },
      { id: "S4_Compare", name: "비교 기준", intent: "일반 선택지와 다른 점을 좌우 비교로 보여줍니다." },
      { id: "S5_Detail", name: "제품 디테일", intent: "소재, 마감, 형태처럼 구매자가 확인하고 싶은 지점을 짚습니다." },
      { id: "S6_Proof", name: "근거/신뢰", intent: "과장 없이 확인 가능한 정보로 신뢰를 만듭니다." },
      { id: "S7_Disclosure", name: "FAQ/고시", intent: "구매 전 마지막 확인 항목과 주의사항을 정리합니다." }
    ]
  },
  {
    id: "scenario",
    locked: true,
    title: "사용 시나리오형",
    range: "6~7장",
    description: "상황 질문, 사용 장면, 루틴, 디테일, 구성으로 구매 후 장면을 선명하게 만듭니다.",
    bestFor: "사용 장면이 예뻐 보이거나 라이프스타일 전환이 중요한 제품",
    focus: "제품 스펙보다 고객이 실제로 쓰는 순간과 루틴을 먼저 상상하게 만듭니다.",
    keyMessage: "이 제품은 사는 순간보다 쓰는 장면에서 더 확실히 이해됩니다.",
    flowIntent: "상황 질문 -> 사용 장면 -> 루틴 제안 -> 디테일 확인 -> 구성 정리 -> 구매 제안",
    sections: [
      { id: "S2_Question", name: "상황 질문", intent: "제품이 필요한 순간을 한 줄 질문으로 열어줍니다." },
      { id: "S3_Lifestyle", name: "사용 장면", intent: "제품이 생활 속에서 쓰이는 모습을 보여줍니다." },
      { id: "S4_Routine", name: "사용 루틴", intent: "구매 후 바로 이해되는 간단한 사용 흐름을 제시합니다." },
      { id: "S5_Detail", name: "제품 디테일", intent: "형태, 소재, 마감처럼 눈으로 확인할 지점을 정리합니다." },
      { id: "S6_Composition", name: "제품 구성", intent: "구성품, 컬러, 사이즈처럼 선택 전에 필요한 정보를 묶습니다." },
      { id: "S7_CTA", name: "구매 제안", intent: "상황과 혜택을 묶어 행동을 유도합니다." }
    ]
  },
  {
    id: "comparison",
    locked: true,
    title: "비교/근거 강화형",
    range: "7~8장",
    description: "왜 지금 필요한지, 무엇이 다른지, 어떤 근거로 안심할지 차례로 설득합니다.",
    bestFor: "비슷한 대체재가 많고 선택 기준을 분명히 잡아야 하는 제품",
    focus: "제품 차별점과 확인 가능한 근거를 기준표처럼 선명하게 정리합니다.",
    keyMessage: "비슷해 보여도 선택 기준을 놓고 보면 이 제품을 고를 이유가 분명합니다.",
    flowIntent: "필요성 제시 -> 비교 포인트 -> 핵심 기능 -> 디테일 -> 근거 -> 상품정보 -> 오퍼",
    sections: [
      { id: "S2_WhyNow", name: "왜 지금 필요한가", intent: "구매 필요성을 상황 중심으로 제시합니다." },
      { id: "S3_Compare", name: "비교 포인트", intent: "경쟁 대안 대비 선택 기준을 정리합니다." },
      { id: "S4_Feature", name: "핵심 기능", intent: "기능을 체감 언어와 사용 장면으로 바꿉니다." },
      { id: "S5_Detail", name: "디테일 확인", intent: "사진에서 확인해야 할 소재, 마감, 형태를 짚습니다." },
      { id: "S6_Evidence", name: "확인 근거", intent: "원본에 있는 구성, 리뷰, 인증 단서만 안전하게 배치합니다." },
      { id: "S7_Disclosure", name: "상품정보 확인", intent: "구매 전 확인해야 할 구성/주의사항을 정리합니다." },
      { id: "S8_Offer", name: "오퍼/마무리", intent: "마지막 혜택과 CTA를 명확하게 제안합니다." }
    ]
  }
] as const;

const MANUAL_SECTION_OPTIONS = [
  {
    id: "hero",
    idToken: "Hero",
    sectionName: "히어로우",
    goal: "상세페이지의 첫인상을 다시 잡고 제품의 핵심 약속을 가장 크게 보여줍니다.",
    description: "첫 화면용 큰 약속과 제품 대표 장면",
    keyMessage: "이 제품을 볼 이유를 첫 3초 안에 만듭니다."
  },
  {
    id: "problem",
    idToken: "Problem",
    sectionName: "문제제기",
    goal: "고객이 이미 느끼는 불편과 망설임을 먼저 꺼내 다음 장면의 설득력을 높입니다.",
    description: "고객 고민, 불편, 구매 전 망설임",
    keyMessage: "고객의 지금 불편을 제품 필요성으로 연결합니다."
  },
  {
    id: "concernList",
    idToken: "ConcernList",
    sectionName: "고객 고민 리스팅",
    goal: "구매 전 고객이 속으로 묻는 고민을 채팅 말풍선처럼 먼저 보여주어 공감과 몰입을 만듭니다.",
    description: "채팅 말풍선형 고객 고민 청취",
    keyMessage: "고객이 망설이는 말을 먼저 들려주고 다음 설득으로 연결합니다."
  },
  {
    id: "value",
    idToken: "Value",
    sectionName: "제품 특장점",
    goal: "제품이 선택받아야 하는 핵심 장점과 차이를 고객 언어로 압축합니다.",
    description: "기능보다 구매 이유가 보이는 장점",
    keyMessage: "기능을 고객이 얻는 변화로 번역합니다."
  },
  {
    id: "review",
    idToken: "Review",
    sectionName: "고객 후기",
    goal: "실제 고객이 사용 후 남길 법한 후기 문장을 별점, 인용문, 마스킹 ID가 있는 리뷰 카드로 정리해 선택 불안을 줄입니다.",
    description: "실사용 후기, 별점, 인용 리뷰 카드",
    keyMessage: "고객의 목소리처럼 읽히는 리뷰로 마지막 의심을 낮춥니다."
  }
] as const;

type ManualSectionOption = (typeof MANUAL_SECTION_OPTIONS)[number];

function getWaitingEstimateMs(sectionCount: number, isBatch: boolean, isRegeneration: boolean) {
  if (isRegeneration) {
    return WAITING_REGENERATION_ESTIMATE_MS;
  }

  if (isBatch) {
    return Math.min(180000, Math.max(46000, sectionCount * WAITING_BATCH_IMAGE_ESTIMATE_MS));
  }

  return WAITING_SINGLE_IMAGE_ESTIMATE_MS;
}

function getWaitingProgressPercent(startedAt: number, durationMs: number, generatedSinceStart: number, targetCount: number) {
  const elapsedRatio = Math.min(1, Math.max(0, (Date.now() - startedAt) / durationMs));
  const easedTimeProgress = 8 + (1 - Math.pow(1 - elapsedRatio, 2.4)) * 84;
  const countProgress = targetCount > 1 ? (generatedSinceStart / targetCount) * 92 : 0;

  return Math.round(Math.min(94, Math.max(easedTimeProgress, countProgress)));
}

export function PdpEditor({
  initialResult,
  aspectRatio,
  aiProvider = "gemini",
  outputMode = "editable",
  geminiApiKey,
  openAiApiKey,
  desiredTone,
  additionalInfo = "",
  customerReviewAnalysis = null,
  initialDraftState,
  lastSavedAt,
  manualSaveToastToken = 0,
  onOpenSettings,
  onReset,
  onDraftStateChange,
  onManualSave,
  apiConnectionLabel = "키 필요",
  referenceModelImage = null,
  referenceModelUsage = null,
  saveState = "idle"
}: PdpEditorProps) {
  const isCompleteMode = outputMode === "full-image";
  const outputModeLabel = isCompleteMode ? "통이미지 모드" : "텍스트편집 모드";
  const defaultEditorNotice = initialResult.blueprint.sections.length === 1
    ? "히어로우 1장을 먼저 확인한 뒤 상세페이지 섹션 타입을 고르면 나머지 섹션을 한 번에 생성할 수 있습니다."
    : isCompleteMode
      ? "통이미지 모드 전체 섹션을 확인하고 필요한 컷만 이미지 옵션에서 다시 조정할 수 있습니다."
      : "전체 섹션 컷과 텍스트 레이아웃을 확인한 뒤 바로 편집하거나 다운로드할 수 있습니다.";
  const [currentSectionIndex, setCurrentSectionIndex] = useState(() => initialDraftState?.currentSectionIndex ?? 0);
  const [sections, setSections] = useState(() => {
    const loadedSections = (
      initialDraftState?.sections?.length
        ? initialDraftState.sections
        : initialResult.blueprint.sections
    ).map((section) => normalizeSectionCopyFields({ ...section }));

    // Re-derive sections that older drafts baked with running-socks local-fallback copy when
    // the product is actually a non-sock category, so full-image regeneration stops re-baking
    // sock wording into sunscreen/sun-care/beauty pages.
    return healLocalFallbackSectionCopy(loadedSections, {
      blueprintSummary: initialResult.blueprint.executiveSummary,
      blueprintList: initialResult.blueprint.blueprintList,
      additionalInfo,
      customerReviewAnalysis
    });
  });
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingAllImages, setIsGeneratingAllImages] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [waitingVideo, setWaitingVideo] = useState<WaitingVideo | null>(null);
  const [isLoadingWaitingVideo, setIsLoadingWaitingVideo] = useState(false);
  const [waitingProgress, setWaitingProgress] = useState(0);
  const [waitingActivity, setWaitingActivity] = useState<WaitingActivity>("video");
  const [errorMessage, setErrorMessage] = useState("");
  const [sectionImageErrorsById, setSectionImageErrorsById] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState(
    () => initialDraftState?.notice ?? defaultEditorNotice
  );
  const [heroWarning, setHeroWarning] = useState(() => initialDraftState?.heroWarning ?? "");
  const [sectionOptions, setSectionOptions] = useState<Record<number, ImageGenOptions>>(
    () => normalizeSectionOptions(initialDraftState?.sectionOptions ?? {}, referenceModelUsage)
  );
  const [overlaysBySection, setOverlaysBySection] = useState<Record<number, CanvasLayer[]>>(
    () => normalizeOverlayRecord(initialDraftState?.overlaysBySection ?? {})
  );
  const [defaultCopyLanguage, setDefaultCopyLanguage] = useState<PdpCopyLanguage>(
    () => initialDraftState?.defaultCopyLanguage ?? "ko"
  );
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);
  const [selectedExpansionStrategyId, setSelectedExpansionStrategyId] = useState<(typeof EXPANSION_STRATEGIES)[number]["id"]>("storybrand");
  const [isSectionPickerOpen, setIsSectionPickerOpen] = useState(false);
  const [draggedSectionIndex, setDraggedSectionIndex] = useState<number | null>(null);
  const [activeColorPalette, setActiveColorPalette] = useState<null | { layerId: string; role: "text" | "shape" | "shadow" }>(null);
  const [colorRecommendations, setColorRecommendations] = useState<ImageColorRecommendations>(DEFAULT_COLOR_RECOMMENDATIONS);
  const [inspectorSections, setInspectorSections] = useState({
    shotMood: true,
    persona: true
  });
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>(() =>
    getAllowedWorkbenchTab(initialDraftState?.workbenchTab ?? "image", isCompleteMode)
  );
  const [workbenchState, setWorkbenchState] = useState<FloatingWorkbenchState>(
    () =>
      initialDraftState?.workbenchState ?? {
        x: 756,
        y: 24,
        width: 332,
        height: 500,
        isOpen: true
      }
  );
  const [showSaveToast, setShowSaveToast] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [pendingDeleteSectionIndex, setPendingDeleteSectionIndex] = useState<number | null>(null);
  const [canvasScale, setCanvasScale] = useState(1);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const previewStageRef = useRef<HTMLDivElement>(null);
  const resizeSessionRef = useRef<Record<string, { width: number; height: number; fontSize: number }>>({});
  const didRefreshLegacyTextLayoutsRef = useRef(false);
  const generatedCountRef = useRef(0);
  const waitingProgressSessionRef = useRef<null | {
    durationMs: number;
    generatedAtStart: number;
    startedAt: number;
    targetCount: number;
  }>(null);

  const currentSection = sections[currentSectionIndex];
  const savedLayers = overlaysBySection[currentSectionIndex] ?? [];
  const currentLayers = isCompleteMode ? [] : savedLayers;
  const currentTextLayers = currentLayers.filter(isTextLayer);
  const currentShapeLayers = currentLayers.filter(isShapeLayer);
  const selectedLayer = currentLayers.find((overlay) => overlay.id === selectedOverlayId) ?? null;
  const selectedTextLayer = selectedLayer && isTextLayer(selectedLayer) ? selectedLayer : null;
  const selectedShapeLayer = selectedLayer && isShapeLayer(selectedLayer) ? selectedLayer : null;
  const generatedCount = sections.filter((section) => Boolean(section.generatedImage)).length;
  const missingImageCount = Math.max(0, sections.length - generatedCount);
  const pendingDeleteSection =
    pendingDeleteSectionIndex === null ? null : sections[pendingDeleteSectionIndex] ?? null;
  const selectedExpansionStrategy =
    EXPANSION_STRATEGIES.find((strategy) => strategy.id === selectedExpansionStrategyId) ?? EXPANSION_STRATEGIES[0];
  const activeWorkbenchLabel = getWorkbenchTabLabel(workbenchTab, isCompleteMode);
  const isEditorGeneratingImage = isGeneratingImage || isGeneratingAllImages;
  const isCurrentImageRegeneration = isGeneratingImage && Boolean(currentSection.generatedImage);
  const isCurrentImageLoading = !currentSection.generatedImage && (isGeneratingImage || isGeneratingAllImages);
  const currentSectionImageError = currentSection ? sectionImageErrorsById[currentSection.section_id] ?? "" : "";

  useEffect(() => {
    generatedCountRef.current = generatedCount;
  }, [generatedCount]);

  useEffect(() => {
    if (!isEditorGeneratingImage) {
      waitingProgressSessionRef.current = null;
      setWaitingProgress(0);
      setWaitingActivity("video");
      return;
    }

    const targetCount = isGeneratingAllImages ? Math.max(1, missingImageCount) : 1;
    waitingProgressSessionRef.current = {
      durationMs: getWaitingEstimateMs(targetCount, isGeneratingAllImages, isCurrentImageRegeneration),
      generatedAtStart: generatedCountRef.current,
      startedAt: Date.now(),
      targetCount
    };
    setWaitingActivity(Math.random() < 0.5 ? "video" : "game");
    setWaitingProgress(8);

    const updateProgress = () => {
      const session = waitingProgressSessionRef.current;
      if (!session) {
        return;
      }

      const generatedSinceStart = Math.max(0, generatedCountRef.current - session.generatedAtStart);
      setWaitingProgress(
        getWaitingProgressPercent(session.startedAt, session.durationMs, generatedSinceStart, session.targetCount)
      );
    };

    updateProgress();
    const timer = window.setInterval(updateProgress, WAITING_PROGRESS_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [isEditorGeneratingImage]);

  const logEditorEvent = (
    event: string,
    metadata?: Record<string, unknown>,
    level: "info" | "warn" | "error" = "info",
    error?: Error | string
  ) => {
    logPdpUsage({
      event,
      source: "editor",
      level,
      state: {
        aiProvider,
        outputMode,
        aspectRatio,
        currentSectionIndex,
        sectionCount: sections.length,
        sectionId: currentSection?.section_id ?? "missing",
        sectionName: currentSection?.section_name ?? "missing",
        generatedCount,
        missingImageCount,
        hasCurrentImage: Boolean(currentSection?.generatedImage),
        layerCount: currentLayers.length,
        workbenchTab,
        workbenchOpen: workbenchState.isOpen
      },
      metadata,
      error
    });
  };

  useEffect(() => {
    logPdpUsage({
      event: "editor.opened",
      source: "editor",
      state: {
        aiProvider,
        outputMode,
        aspectRatio,
        sectionCount: sections.length,
        generatedCount,
        missingImageCount
      }
    });
  }, []);

  useEffect(() => {
    if (!isEditorGeneratingImage || waitingActivity !== "video") {
      setIsLoadingWaitingVideo(false);
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
  }, [isEditorGeneratingImage, waitingActivity]);

  const lastLoggedEditorErrorRef = useRef("");
  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    const errorKey = `${currentSectionIndex}:${errorMessage}`;
    if (lastLoggedEditorErrorRef.current === errorKey) {
      return;
    }

    lastLoggedEditorErrorRef.current = errorKey;
    logEditorEvent(
      "editor.error_visible",
      {
        message: errorMessage
      },
      "warn",
      errorMessage
    );
  }, [currentSectionIndex, errorMessage]);

  useEffect(() => {
    setSelectedOverlayId(null);
    setEditingOverlayId(null);
    setActiveColorPalette(null);
    setErrorMessage("");
  }, [currentSectionIndex]);

  useEffect(() => {
    setWorkbenchTab((current) => getAllowedWorkbenchTab(current, isCompleteMode));
    if (isCompleteMode) {
      setSelectedOverlayId(null);
      setEditingOverlayId(null);
      setActiveColorPalette(null);
    }
  }, [isCompleteMode]);

  useEffect(() => {
    if (!selectedLayer) {
      return;
    }

    setWorkbenchState((current) => ({
      ...current,
      isOpen: true
    }));
  }, [currentSectionIndex, selectedLayer]);

  useEffect(() => {
    const element = imageContainerRef.current;
    if (!element) {
      setCanvasScale(1);
      return;
    }

    const updateScale = () => {
      const width = element.clientWidth || EDITOR_CANVAS_BASE_WIDTH;
      setCanvasScale(clampValue(width / EDITOR_CANVAS_BASE_WIDTH, 0.3, 1));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(element);
    return () => observer.disconnect();
  }, [currentSection.generatedImage, currentSectionIndex]);

  useEffect(() => {
    onDraftStateChange?.({
      currentSectionIndex,
      sections,
      sectionOptions,
      overlaysBySection,
      defaultCopyLanguage,
      notice,
      heroWarning,
      workbenchTab,
      workbenchState
    });
  }, [currentSectionIndex, defaultCopyLanguage, heroWarning, notice, onDraftStateChange, overlaysBySection, sectionOptions, sections, workbenchState, workbenchTab]);

  useEffect(() => {
    let isCancelled = false;

    if (!currentSection.generatedImage) {
      setColorRecommendations(DEFAULT_COLOR_RECOMMENDATIONS);
      return;
    }

    void extractImageColorRecommendations(currentSection.generatedImage).then((next) => {
      if (!isCancelled) {
        setColorRecommendations(next);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [currentSection.generatedImage]);

  useEffect(() => {
    if (!manualSaveToastToken) {
      return;
    }

    setShowSaveToast(true);
    const timeout = window.setTimeout(() => {
      setShowSaveToast(false);
    }, 2200);

    return () => window.clearTimeout(timeout);
  }, [manualSaveToastToken]);

  const deleteOverlay = (overlayId: string, trigger: "button" | "keyboard" = "button") => {
    const deletedOverlay = currentLayers.find((overlay) => overlay.id === overlayId);
    if (!deletedOverlay) {
      return;
    }

    setOverlaysBySection((current) => ({
      ...current,
      [currentSectionIndex]: (current[currentSectionIndex] ?? []).filter((overlay) => overlay.id !== overlayId)
    }));
    if (selectedOverlayId === overlayId) {
      setSelectedOverlayId(null);
      setEditingOverlayId(null);
    }
    setActiveColorPalette((current) => (current?.layerId === overlayId ? null : current));
    logEditorEvent("editor.layer_deleted", {
      kind: deletedOverlay.kind,
      layerCount: Math.max(0, currentLayers.length - 1),
      trigger
    });
  };

  useEffect(() => {
    if (!selectedOverlayId || editingOverlayId || pendingDeleteSection || isCompleteMode) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.key !== "Delete" && event.key !== "Backspace")) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey || isEditableKeyboardTarget(event.target)) {
        return;
      }

      event.preventDefault();
      deleteOverlay(selectedOverlayId, "keyboard");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteOverlay, editingOverlayId, isCompleteMode, pendingDeleteSection, selectedOverlayId]);

  useEffect(() => {
    if (isCompleteMode) {
      return;
    }

    const hasGeneratedSectionWithoutLayout = sections.some(
      (section, index) => section.generatedImage && !hasOverlayEntry(overlaysBySection, index)
    );

    if (!hasGeneratedSectionWithoutLayout) {
      return;
    }

    setOverlaysBySection((current) => {
      let didApplyTemplate = false;
      const next: Record<number, CanvasLayer[]> = { ...current };

      sections.forEach((section, index) => {
        if (!section.generatedImage || hasOverlayEntry(current, index)) {
          return;
        }

        next[index] = buildDefaultTextLayout(section, index, sections.length, aspectRatio, defaultCopyLanguage);
        didApplyTemplate = true;
      });

      return didApplyTemplate ? next : current;
    });
    setNotice((current) =>
      current.includes("생성에 실패") || current.includes("만들지 못했습니다")
        ? current.includes("기본 텍스트 레이아웃도 배치했습니다")
          ? current
          : `${current} 기본 텍스트 레이아웃도 배치했습니다.`
        : "텍스트편집 모드 섹션에 기본 텍스트 레이아웃 템플릿을 배치했습니다."
    );
  }, [aspectRatio, defaultCopyLanguage, isCompleteMode, overlaysBySection, sections]);

  useEffect(() => {
    if (isCompleteMode || didRefreshLegacyTextLayoutsRef.current) {
      return;
    }

    didRefreshLegacyTextLayoutsRef.current = true;
    setOverlaysBySection((current) =>
      refreshLegacyTemplateLayouts(current, sections, aspectRatio, defaultCopyLanguage)
    );
  }, [aspectRatio, defaultCopyLanguage, isCompleteMode, sections]);

  const textColorRecommendations = useMemo(
    () => sortColorsByContrast(colorRecommendations.recommendedTextColors, selectedTextLayer?.color ?? null),
    [colorRecommendations.recommendedTextColors, selectedTextLayer?.color]
  );
  const shapeColorRecommendations = useMemo(
    () => sortColorsByContrast(colorRecommendations.recommendedShapeColors, selectedShapeLayer?.fillColor ?? null),
    [colorRecommendations.recommendedShapeColors, selectedShapeLayer?.fillColor]
  );
  const photoColorRecommendations = useMemo(() => uniqueColors(colorRecommendations.photoColors), [colorRecommendations.photoColors]);

  const currentOptions = useMemo(() => {
    const sectionImageDefaults = getPdpSectionImageDefaults(
      currentSection,
      currentSectionIndex,
      sections.length,
      referenceModelUsage
    );

    return normalizeImageOptions(sectionOptions[currentSectionIndex], sectionImageDefaults);
  }, [currentSection, currentSectionIndex, referenceModelUsage, sectionOptions, sections.length]);
  const referenceModelAppliesToCurrentSection = Boolean(
    referenceModelImage &&
      referenceModelUsage &&
      (referenceModelUsage === "all-sections" || currentSectionIndex === 0)
  );
  const usesReferenceModel = Boolean(currentOptions.withModel && referenceModelAppliesToCurrentSection);
  const personaLockedMessage = usesReferenceModel
    ? referenceModelUsage === "all-sections"
      ? "모델 일관성 유지 선택으로 타깃 페르소나가 비활성화되었습니다."
      : "히어로우 전용 업로드 모델이 적용되어 타깃 페르소나가 비활성화되었습니다."
    : "";

  if (!currentSection) {
    return (
      <main className={styles.page}>
        <section className={styles.editorShell}>
          <div className={styles.errorBanner}>섹션 정보를 불러오지 못했습니다.</div>
        </section>
      </main>
    );
  }

  const setCurrentOptions = (updates: Partial<ImageGenOptions>) => {
    setSectionOptions((current) => ({
      ...current,
      [currentSectionIndex]: {
        ...currentOptions,
        ...updates
      }
    }));
    logEditorEvent("editor.image_options_changed", {
      changedKeys: Object.keys(updates),
      updates
    });
  };

  const updateTextOverlayContent = (overlayId: string, nextText: string) => {
    setOverlaysBySection((current) => ({
      ...current,
      [currentSectionIndex]: (current[currentSectionIndex] ?? []).map((overlay) => {
        if (overlay.id !== overlayId || !isTextLayer(overlay)) {
          return overlay;
        }

        return normalizeTextOverlay({
          ...overlay,
          text: nextText,
          translations: {
            ...overlay.translations,
            [overlay.language]: nextText
          }
        });
      })
    }));
  };

  const handleOverlayLanguageChange = (overlay: TextOverlay, nextLanguage: PdpCopyLanguage) => {
    if (overlay.language === nextLanguage) {
      return;
    }

    setDefaultCopyLanguage(nextLanguage);
    updateOverlay(overlay.id, applyLanguageToTextOverlay(overlay, nextLanguage));
  };

  const handleTextAlignChange = (overlay: TextOverlay, nextAlign: OverlayTextAlign) => {
    const currentWidth = toNumericSize(overlay.width, 320);
    const recommendedWidth = clampValue(Math.round(overlay.fontSize * 10), 220, 520);
    const nextWidth = Math.max(currentWidth, recommendedWidth);

    updateOverlay(overlay.id, {
      textAlign: nextAlign,
      width: nextWidth
    });

    if (nextWidth > currentWidth) {
      setNotice("줄맞춤이 잘 보이도록 텍스트 박스 폭도 함께 넓혔습니다.");
    }
  };

  const stopShellClick = (event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const clearLayerSelection = () => {
    setSelectedOverlayId(null);
    setEditingOverlayId(null);
    setActiveColorPalette(null);
  };

  const toggleInspectorSection = (key: keyof typeof inspectorSections) => {
    setInspectorSections((current) => ({
      ...current,
      [key]: !current[key]
    }));
  };

  const openWorkbench = (tab: WorkbenchTab) => {
    setWorkbenchTab(getAllowedWorkbenchTab(tab, isCompleteMode));
    setWorkbenchState((current) => ({
      ...current,
      isOpen: true
    }));
    logEditorEvent("editor.workbench_opened", {
      tab: getAllowedWorkbenchTab(tab, isCompleteMode)
    });
  };

  const handleApplyTextLayoutTemplate = () => {
    if (isCompleteMode) {
      setErrorMessage("통이미지 모드는 텍스트가 이미지 안에 포함된 결과입니다. 문구 변경은 이미지 옵션에서 다시 생성해 주세요.");
      logEditorEvent("editor.text_template_blocked", { reason: "full_image_mode" }, "warn");
      return;
    }

    if (!currentSection.generatedImage) {
      setErrorMessage("이미지를 먼저 생성해야 텍스트 레이아웃 템플릿을 적용할 수 있습니다.");
      logEditorEvent("editor.text_template_blocked", { reason: "missing_generated_image" }, "warn");
      return;
    }

    const nextLayers = buildDefaultTextLayout(
      currentSection,
      currentSectionIndex,
      sections.length,
      aspectRatio,
      defaultCopyLanguage
    );

    setOverlaysBySection((current) => ({
      ...current,
      [currentSectionIndex]: nextLayers
    }));
    setSelectedOverlayId(nextLayers.find(isTextLayer)?.id ?? null);
    setEditingOverlayId(null);
    setWorkbenchTab("layer");
    setWorkbenchState((current) => ({
      ...current,
      isOpen: true
    }));
    setNotice(`${getDisplaySectionName(currentSection)}에 ${getTextLayoutTemplateLabel(inferTextLayoutTemplate(currentSection, currentSectionIndex, sections.length))} 템플릿을 적용했습니다.`);
    logEditorEvent("editor.text_template_applied", {
      template: inferTextLayoutTemplate(currentSection, currentSectionIndex, sections.length),
      layerCount: nextLayers.length
    });
  };

  const renderColorPaletteField = ({
    label,
    layerId,
    role,
    currentColor,
    recommendedColors,
    onSelect
  }: {
    label: string;
    layerId: string;
    role: "text" | "shape" | "shadow";
    currentColor: string;
    recommendedColors: string[];
    onSelect: (color: string) => void;
  }) => {
    const isOpen = activeColorPalette?.layerId === layerId && activeColorPalette.role === role;

    return (
      <label className={styles.floatingField}>
        <span className={styles.optionMiniLabel}>{label}</span>
        <div className={styles.colorFieldStack}>
          <button
            className={styles.colorTriggerButton}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setActiveColorPalette((current) =>
                current?.layerId === layerId && current.role === role ? null : { layerId, role }
              );
            }}
            style={{ ["--swatch-color" as string]: currentColor }}
            type="button"
          >
            <span className={styles.colorTriggerPreview} />
            <code>{currentColor}</code>
          </button>

          {isOpen ? (
            <div className={styles.colorPopover}>
              <div className={styles.paletteSection}>
                <span className={styles.optionMiniLabel}>사진 색상</span>
                <div className={styles.swatchGridWide}>
                  {photoColorRecommendations.map((color) => (
                    <button
                      className={styles.swatchButton}
                      key={`${role}-photo-${color}`}
                      onClick={() => {
                        onSelect(color);
                        setActiveColorPalette(null);
                      }}
                      style={{ ["--swatch-color" as string]: color }}
                      type="button"
                    >
                      <span className={styles.swatchPreview} />
                      <code>{color}</code>
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.paletteSection}>
                <span className={styles.optionMiniLabel}>기본 단색</span>
                <div className={styles.swatchGridWide}>
                  {BASIC_SOLID_COLORS.map((color) => (
                    <button
                      className={styles.swatchButton}
                      key={`${role}-basic-${color}`}
                      onClick={() => {
                        onSelect(color);
                        setActiveColorPalette(null);
                      }}
                      style={{ ["--swatch-color" as string]: color }}
                      type="button"
                    >
                      <span className={styles.swatchPreview} />
                      <code>{color}</code>
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.paletteSection}>
                <span className={styles.optionMiniLabel}>어울리는 컬러 추천</span>
                <div className={styles.swatchGridWide}>
                  {recommendedColors.map((color) => (
                    <button
                      className={styles.swatchButton}
                      key={`${role}-recommended-${color}`}
                      onClick={() => {
                        onSelect(color);
                        setActiveColorPalette(null);
                      }}
                      style={{ ["--swatch-color" as string]: color }}
                      type="button"
                    >
                      <span className={styles.swatchPreview} />
                      <code>{color}</code>
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.colorInputRow}>
                <input
                  className={styles.colorInputLarge}
                  onChange={(event) => onSelect(event.target.value)}
                  type="color"
                  value={currentColor}
                />
                <button className={styles.inlineButton} onClick={() => setActiveColorPalette(null)} type="button">
                  닫기
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </label>
    );
  };

  const renderWorkbenchBody = () => {
    switch (workbenchTab) {
      case "image":
        return (
          <div className={styles.workbenchSectionStack}>
            <div className={styles.optionSummaryBar}>
              <span className={styles.summaryChip}>
                {STYLE_OPTIONS.find((option) => option.value === currentOptions.style)?.label ?? "스튜디오컷"}
              </span>
              <span className={styles.summaryChip}>{selectedModelSummary}</span>
              <span className={styles.summaryChip}>
                {currentOptions.guidePriorityMode === "guide-first" ? "디자인 가이드 우선" : "컷 타입 우선"}
              </span>
            </div>

            <div className={styles.optionSurface}>
              <div className={styles.optionSectionHeader}>
                <div>
                  <span className={styles.optionSectionEyebrow}>샷 타입</span>
                  <strong>배경과 연출 무드</strong>
                </div>
                <button className={styles.sectionToggleButton} onClick={() => toggleInspectorSection("shotMood")} type="button">
                  {inspectorSections.shotMood ? "숨기기" : "보이기"}
                  {inspectorSections.shotMood ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {inspectorSections.shotMood ? (
                <>
                  <div className={styles.styleOptionGrid}>
                    {STYLE_OPTIONS.map((style) => (
                      <button
                        className={currentOptions.style === style.value ? styles.styleCardActive : styles.styleCard}
                        key={style.value}
                        onClick={() => setCurrentOptions({ style: style.value })}
                        type="button"
                      >
                        <strong>{style.label}</strong>
                        <small>{style.description}</small>
                      </button>
                    ))}
                  </div>

                  <label className={styles.toggleCard}>
                    <div className={styles.toggleCardCopy}>
                      <strong>디자인 가이드 우선</strong>
                      <span>
                        {currentOptions.guidePriorityMode === "guide-first"
                          ? "Image Purpose, Layout Notes, Style Guide를 함께 반영합니다."
                          : "Image Purpose만 유지하고, 선택한 컷 타입을 우선해 이미지를 설계합니다."}
                      </span>
                    </div>
                    <input
                      checked={currentOptions.guidePriorityMode === "guide-first"}
                      onChange={(event) =>
                        setCurrentOptions({
                          guidePriorityMode: event.target.checked ? "guide-first" : "style-first"
                        })
                      }
                      type="checkbox"
                    />
                  </label>
                </>
              ) : (
                <p className={styles.collapsedHint}>
                  현재 선택: {STYLE_OPTIONS.find((style) => style.value === currentOptions.style)?.label ?? "스튜디오컷"} ·{" "}
                  {currentOptions.guidePriorityMode === "guide-first" ? "디자인 가이드 우선" : "컷 타입 우선"}
                </p>
              )}
            </div>

            <div className={styles.optionSurface}>
              <div className={styles.optionSectionHeader}>
                <div>
                  <span className={styles.optionSectionEyebrow}>모델 설정</span>
                  <strong>타깃 페르소나 지정</strong>
                </div>
                <div className={styles.optionHeaderTools}>
                  <User size={16} />
                  <button className={styles.sectionToggleButton} onClick={() => toggleInspectorSection("persona")} type="button">
                    {inspectorSections.persona ? "숨기기" : "보이기"}
                    {inspectorSections.persona ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>
              {inspectorSections.persona ? (
                <>
                  <label className={styles.toggleCard}>
                    <div className={styles.toggleCardCopy}>
                      <strong>모델컷 포함</strong>
                      <span>
                        {referenceModelImage
                          ? "제품과 함께 연출되는 인물컷이 필요하면 켜 두세요. 업로드 모델이 적용되는 구간에서는 동일 인물이 유지됩니다."
                          : "제품과 함께 연출되는 인물컷이 필요한 경우 켜 두세요."}
                      </span>
                    </div>
                    <input
                      checked={currentOptions.withModel}
                      onChange={(event) => setCurrentOptions({ withModel: event.target.checked })}
                      type="checkbox"
                    />
                  </label>

                  {currentOptions.withModel ? (
                    <div className={styles.optionStack}>
                      {usesReferenceModel ? (
                        <div className={styles.lockedHint}>
                          <AlertCircle size={15} />
                          <div>
                            <strong>{referenceModelUsage === "all-sections" ? "전체 일관성 유지 적용 중" : "히어로우 업로드 모델 적용 중"}</strong>
                            <span>{personaLockedMessage}</span>
                          </div>
                        </div>
                      ) : null}

                      <div className={styles.optionFieldBlock}>
                        <span className={styles.optionMiniLabel}>성별</span>
                        <div className={styles.segmentedRow}>
                          {MODEL_GENDER_OPTIONS.map((option) => (
                            <button
                              className={currentOptions.modelGender === option.value ? styles.segmentedButtonActive : styles.segmentedButton}
                              disabled={usesReferenceModel}
                              key={option.value}
                              onClick={() => setCurrentOptions({ modelGender: option.value })}
                              type="button"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className={styles.optionFieldBlock}>
                        <span className={styles.optionMiniLabel}>연령대</span>
                        <div className={styles.segmentedGridCompact}>
                          {MODEL_AGE_OPTIONS.map((option) => (
                            <button
                              className={currentOptions.modelAgeRange === option.value ? styles.segmentedButtonActive : styles.segmentedButton}
                              disabled={usesReferenceModel}
                              key={option.value}
                              onClick={() => setCurrentOptions({ modelAgeRange: option.value })}
                              type="button"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className={styles.optionFieldBlock}>
                        <div className={styles.optionFieldHeader}>
                          <span className={styles.optionMiniLabel}>국가</span>
                          <Globe2 size={14} />
                        </div>
                        <div className={styles.countryGrid}>
                          {MODEL_COUNTRY_OPTIONS.map((option) => (
                            <button
                              className={currentOptions.modelCountry === option.value ? styles.countryCardActive : styles.countryCard}
                              disabled={usesReferenceModel}
                              key={option.value}
                              onClick={() => setCurrentOptions({ modelCountry: option.value })}
                              type="button"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className={styles.collapsedHint}>현재 설정: {selectedModelSummary}</p>
              )}
            </div>

            <button className={styles.primaryButtonWide} disabled={isGeneratingImage || isGeneratingAllImages} onClick={handleGenerateImage} type="button">
              {isGeneratingImage ? <Loader2 className={styles.spinIcon} size={16} /> : currentSection.generatedImage ? <RefreshCw size={16} /> : <ImageIcon size={16} />}
              {currentSection.generatedImage ? "이미지 다시 만들기" : "이미지 생성하기"}
            </button>

            <p className={styles.inspectorHelper}>
              {isGeneratingAllImages
                ? "전체 미생성 섹션 이미지를 한 번에 생성하는 중입니다."
                : usesReferenceModel
                ? "업로드한 모델 이미지를 참조하면서 현재 섹션 컷만 다시 생성합니다."
                : "섹션 헤드라인과 지금 선택한 모델 조건을 반영해 현재 컷만 다시 생성합니다."}
            </p>
          </div>
        );
      case "layer":
        return selectedTextLayer ? (
            <div className={styles.workbenchSectionStack}>
              <div className={styles.toolbarRow}>
                <button className={styles.inlineDangerButton} onClick={() => deleteOverlay(selectedTextLayer.id)} type="button">
                  <Trash2 size={14} />
                  삭제
                </button>
              </div>

            <label className={styles.floatingField}>
              <div className={styles.fieldHeaderInline}>
                <span className={styles.optionMiniLabel}>텍스트 내용</span>
                <div className={styles.languageControlRow}>
                  <select
                    className={styles.miniSelect}
                    onChange={(event) => handleOverlayLanguageChange(selectedTextLayer, event.target.value as PdpCopyLanguage)}
                    value={selectedTextLayer.language}
                  >
                    <option value="ko">한국어</option>
                    <option value="en">영어</option>
                  </select>
                </div>
              </div>
              <textarea
                className={styles.floatingTextarea}
                onChange={(event) => updateTextOverlayContent(selectedTextLayer.id, event.target.value)}
                rows={3}
                value={selectedTextLayer.text}
              />
            </label>

            <div className={styles.floatingCompactGrid}>
              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>폰트</span>
                <select
                  className={styles.select}
                  onChange={(event) => updateOverlay(selectedTextLayer.id, { fontFamily: event.target.value })}
                  value={selectedTextLayer.fontFamily}
                >
                  {FONT_OPTIONS.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>굵기</span>
                <select
                  className={styles.select}
                  onChange={(event) => updateOverlay(selectedTextLayer.id, { fontWeight: event.target.value })}
                  value={selectedTextLayer.fontWeight}
                >
                  {FONT_WEIGHT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className={styles.floatingCompactGrid}>
              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>폭</span>
                <input
                  className={styles.input}
                  min={80}
                  onChange={(event) =>
                    updateOverlay(selectedTextLayer.id, {
                      width: clampValue(Number(event.target.value) || 320, 80, 1200)
                    })
                  }
                  type="number"
                  value={toNumericSize(selectedTextLayer.width, 320)}
                />
              </label>

              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>크기</span>
                <div className={styles.rangeField}>
                  <input
                    className={styles.rangeInput}
                    max={180}
                    min={10}
                    onChange={(event) => updateOverlay(selectedTextLayer.id, { fontSize: Number(event.target.value) || 16 })}
                    type="range"
                    value={selectedTextLayer.fontSize}
                  />
                  <input
                    className={styles.input}
                    min={10}
                    onChange={(event) => updateOverlay(selectedTextLayer.id, { fontSize: Number(event.target.value) || 16 })}
                    type="number"
                    value={selectedTextLayer.fontSize}
                  />
                </div>
              </label>

              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>줄 간격</span>
                <div className={styles.rangeField}>
                  <input
                    className={styles.rangeInput}
                    max={3}
                    min={0.8}
                    onChange={(event) => updateOverlay(selectedTextLayer.id, { lineHeight: Number(event.target.value) || 1.2 })}
                    step={0.1}
                    type="range"
                    value={selectedTextLayer.lineHeight}
                  />
                  <input
                    className={styles.input}
                    max={3}
                    min={0.8}
                    onChange={(event) => updateOverlay(selectedTextLayer.id, { lineHeight: Number(event.target.value) || 1.2 })}
                    step={0.1}
                    type="number"
                    value={selectedTextLayer.lineHeight}
                  />
                </div>
              </label>
            </div>

            <div className={styles.optionSurface}>
              <div className={styles.optionSectionHeader}>
                <div>
                  <span className={styles.optionSectionEyebrow}>Color palette</span>
                  <strong>글자색</strong>
                </div>
                <Palette size={16} />
              </div>
              {renderColorPaletteField({
                label: "글자색",
                layerId: selectedTextLayer.id,
                role: "text",
                currentColor: selectedTextLayer.color,
                recommendedColors: textColorRecommendations,
                onSelect: (color) => updateOverlay(selectedTextLayer.id, { color })
              })}
            </div>

            <div className={styles.optionSurface}>
              <div className={styles.optionSectionHeader}>
                <div>
                  <span className={styles.optionSectionEyebrow}>Shadow</span>
                  <strong>가독성 그림자</strong>
                </div>
                <Sparkles size={16} />
              </div>
              <label className={styles.toggleCard}>
                <div className={styles.toggleCardCopy}>
                  <strong>그림자 사용</strong>
                  <span>밝은 이미지 위에서도 텍스트가 묻히지 않도록 깊이를 더합니다.</span>
                </div>
                <input
                  checked={selectedTextLayer.shadowEnabled}
                  onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowEnabled: event.target.checked })}
                  type="checkbox"
                />
              </label>

              {selectedTextLayer.shadowEnabled ? (
                <>
                  {renderColorPaletteField({
                    label: "그림자색",
                    layerId: selectedTextLayer.id,
                    role: "shadow",
                    currentColor: selectedTextLayer.shadowColor,
                    recommendedColors: [colorRecommendations.darkColor, "#000000", colorRecommendations.accentColor],
                    onSelect: (color) => updateOverlay(selectedTextLayer.id, { shadowColor: color })
                  })}
                  <div className={styles.floatingCompactGrid}>
                    <label className={styles.floatingField}>
                      <span className={styles.optionMiniLabel}>강도</span>
                      <div className={styles.rangeField}>
                        <input className={styles.rangeInput} max={1} min={0} step={0.05} type="range" value={selectedTextLayer.shadowOpacity} onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowOpacity: Number(event.target.value) || 0 })} />
                        <input className={styles.input} max={1} min={0} step={0.05} type="number" value={selectedTextLayer.shadowOpacity} onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowOpacity: Number(event.target.value) || 0 })} />
                      </div>
                    </label>
                    <label className={styles.floatingField}>
                      <span className={styles.optionMiniLabel}>흐림</span>
                      <div className={styles.rangeField}>
                        <input className={styles.rangeInput} max={40} min={0} step={1} type="range" value={selectedTextLayer.shadowBlur} onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowBlur: Number(event.target.value) || 0 })} />
                        <input className={styles.input} max={40} min={0} step={1} type="number" value={selectedTextLayer.shadowBlur} onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowBlur: Number(event.target.value) || 0 })} />
                      </div>
                    </label>
                    <label className={styles.floatingField}>
                      <span className={styles.optionMiniLabel}>거리</span>
                      <div className={styles.rangeField}>
                        <input className={styles.rangeInput} max={24} min={-24} step={1} type="range" value={selectedTextLayer.shadowOffsetY} onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowOffsetY: Number(event.target.value) || 0 })} />
                        <input className={styles.input} max={24} min={-24} step={1} type="number" value={selectedTextLayer.shadowOffsetY} onChange={(event) => updateOverlay(selectedTextLayer.id, { shadowOffsetY: Number(event.target.value) || 0 })} />
                      </div>
                    </label>
                  </div>
                </>
              ) : null}
            </div>

            <div className={styles.floatingField}>
              <span className={styles.optionMiniLabel}>정렬</span>
              <div className={styles.alignButtonGroup}>
                {ALIGN_OPTIONS.map(({ value, label, Icon }) => (
                  <button
                    className={selectedTextLayer.textAlign === value ? styles.alignButtonActive : styles.alignButton}
                    key={value}
                    onClick={() => handleTextAlignChange(selectedTextLayer, value)}
                    type="button"
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : selectedShapeLayer ? (
          <div className={styles.workbenchSectionStack}>
            <div className={styles.toolbarRow}>
              <p className={styles.floatingHint}>사각형은 이미지 위, 텍스트 아래에 깔리는 독립 배경 오브젝트입니다.</p>
              <button className={styles.inlineDangerButton} onClick={() => deleteOverlay(selectedShapeLayer.id)} type="button">
                <Trash2 size={14} />
                삭제
              </button>
            </div>

            <div className={styles.optionSurface}>
              <div className={styles.optionSectionHeader}>
                <div>
                  <span className={styles.optionSectionEyebrow}>Shape fill</span>
                  <strong>배경 사각형 색상</strong>
                </div>
                <Palette size={16} />
              </div>
              {renderColorPaletteField({
                label: "채우기 색상",
                layerId: selectedShapeLayer.id,
                role: "shape",
                currentColor: selectedShapeLayer.fillColor,
                recommendedColors: shapeColorRecommendations,
                onSelect: (color) => updateOverlay(selectedShapeLayer.id, { fillColor: color })
              })}
            </div>

            <div className={styles.floatingCompactGrid}>
              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>투명도</span>
                <div className={styles.rangeField}>
                  <input className={styles.rangeInput} max={1} min={0} step={0.05} type="range" value={selectedShapeLayer.fillOpacity} onChange={(event) => updateOverlay(selectedShapeLayer.id, { fillOpacity: Number(event.target.value) || 0 })} />
                  <input className={styles.input} max={1} min={0} step={0.05} type="number" value={selectedShapeLayer.fillOpacity} onChange={(event) => updateOverlay(selectedShapeLayer.id, { fillOpacity: Number(event.target.value) || 0 })} />
                </div>
              </label>
              <label className={styles.floatingField}>
                <span className={styles.optionMiniLabel}>모서리</span>
                <div className={styles.rangeField}>
                  <input className={styles.rangeInput} max={48} min={0} step={1} type="range" value={selectedShapeLayer.borderRadius} onChange={(event) => updateOverlay(selectedShapeLayer.id, { borderRadius: Number(event.target.value) || 0 })} />
                  <input className={styles.input} max={48} min={0} step={1} type="number" value={selectedShapeLayer.borderRadius} onChange={(event) => updateOverlay(selectedShapeLayer.id, { borderRadius: Number(event.target.value) || 0 })} />
                </div>
              </label>
            </div>
          </div>
        ) : (
          <div className={styles.inspectorEmpty}>
            <Type size={18} />
            <div>
              <strong>텍스트나 사각형을 선택해 주세요</strong>
              <p>캔버스의 텍스트나 배경 사각형을 클릭하면 이 패널에서 바로 편집할 수 있습니다.</p>
              <div className={styles.inspectorEmptyActions}>
                <button className={styles.copyUtilityButton} onClick={handleAddShapeLayer} type="button">
                  <Square size={15} />
                  배경 사각형 추가
                </button>
              </div>
            </div>
          </div>
        );
      case "copy":
        return (
          <div className={styles.copyLibrary}>
            <div className={styles.copySection}>
              <p className={styles.cardLabel}>Layout Object</p>
              <button className={styles.copyUtilityButtonStrong} onClick={handleApplyTextLayoutTemplate} type="button">
                <Sparkles size={15} />
                현재 섹션 템플릿 적용
              </button>
              <button className={styles.copyUtilityButton} onClick={handleAddShapeLayer} type="button">
                <Palette size={15} />
                배경 사각형 추가
              </button>
            </div>

            <div className={styles.copySection}>
              <p className={styles.cardLabel}>Headline</p>
              <button
                className={styles.copyBlock}
                onClick={() =>
                  handleAddTextOverlay(
                    {
                      ko: currentSection.headline,
                      en: currentSection.headline_en
                    },
                    "headline"
                  )
                }
                type="button"
              >
                {getLocalizedCopy(currentSection.headline, currentSection.headline_en, defaultCopyLanguage)}
              </button>
            </div>

            <div className={styles.copySection}>
              <p className={styles.cardLabel}>Subheadline</p>
              <button
                className={styles.copyBlockSoft}
                onClick={() =>
                  handleAddTextOverlay(
                    {
                      ko: currentSection.subheadline,
                      en: currentSection.subheadline_en
                    },
                    "subheadline"
                  )
                }
                type="button"
              >
                {getLocalizedCopy(currentSection.subheadline, currentSection.subheadline_en, defaultCopyLanguage)}
              </button>
            </div>

            {currentSection.bullets.length ? (
              <div className={styles.copySection}>
                <p className={styles.cardLabel}>Key Points</p>
                <div className={styles.bulletStack}>
                  {getLocalizedBullets(currentSection, defaultCopyLanguage).map((bullet, index) => (
                    <button
                      className={styles.bulletButton}
                      key={`${bullet}-${index}`}
                      onClick={() =>
                        handleAddTextOverlay(
                          {
                            ko: currentSection.bullets[index] ?? bullet,
                            en: currentSection.bullets_en[index] ?? currentSection.bullets[index] ?? bullet
                          },
                          "keypoint"
                        )
                      }
                      type="button"
                    >
                      <CheckCircle2 size={14} />
                      {bullet}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {currentSection.trust_or_objection_line ? (
              <div className={styles.trustBox}>
                <p className={styles.cardLabel}>Trust / Objection</p>
                <p>
                  {getLocalizedCopy(
                    currentSection.trust_or_objection_line,
                    currentSection.trust_or_objection_line_en,
                    defaultCopyLanguage
                  )}
                </p>
              </div>
            ) : null}

            {currentSection.CTA ? (
              <button className={styles.ctaPreview} type="button">
                {getLocalizedCopy(currentSection.CTA, currentSection.CTA_en, defaultCopyLanguage)}
              </button>
            ) : null}
          </div>
        );
      case "guide":
      default:
        return (
          <div className={styles.workbenchSectionStack}>
            <div className={styles.guidelineGrid}>
              <div>
                <strong>Guide Mode</strong>
                <p>{currentOptions.guidePriorityMode === "guide-first" ? "디자인 가이드 우선" : "컷 타입 우선"}</p>
              </div>
              <div>
                <strong>Image Purpose</strong>
                <p>{currentSection.purpose}</p>
              </div>
              <div>
                <strong>Layout Notes</strong>
                <p>{currentOptions.guidePriorityMode === "guide-first" ? currentSection.layout_notes : "이번 생성에는 적용하지 않음"}</p>
              </div>
              <div>
                <strong>Style Guide</strong>
                <p>{currentOptions.guidePriorityMode === "guide-first" ? currentSection.style_guide : "이번 생성에는 적용하지 않음"}</p>
              </div>
            </div>

            {currentSection.compliance_notes ? (
              <div className={styles.warningBox}>
                <strong>Compliance Notes</strong>
                <p>{currentSection.compliance_notes}</p>
              </div>
            ) : null}
          </div>
        );
    }
  };

  const selectedModelSummary = currentOptions.withModel
    ? usesReferenceModel
      ? referenceModelUsage === "all-sections"
        ? "업로드 모델 일관성 유지"
        : "히어로우 업로드 모델 사용"
      : `${getModelCountryLabel(currentOptions.modelCountry)} ${getModelAgeLabel(currentOptions.modelAgeRange)} ${getModelGenderLabel(currentOptions.modelGender)}`
    : "모델 없이 제품 중심";

  const generateMissingImagesForSections = async (targetSections: PdpSection[]) => {
    const sectionsToGenerate = targetSections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => !section.generatedImage);

    if (!sectionsToGenerate.length) {
      setNotice("모든 섹션 이미지가 이미 준비되어 있습니다.");
      logEditorEvent("editor.missing_images_generation_skipped", {
        reason: "all_sections_already_generated"
      });
      return;
    }

    setIsGeneratingAllImages(true);
    setErrorMessage("");
    setSectionImageErrorsById((current) => {
      const next = { ...current };
      sectionsToGenerate.forEach(({ section }) => {
        delete next[section.section_id];
      });
      return next;
    });
    setNotice(`${sectionsToGenerate.length}개 미생성 섹션 이미지를 한 번에 생성합니다.`);
    const batchStartedAt = Date.now();
    logEditorEvent("editor.missing_images_generation_started", {
      sectionsToGenerate: sectionsToGenerate.length,
      totalSections: targetSections.length
    });

    let completedCount = 0;

    try {
      const settledSections = await Promise.allSettled(
        sectionsToGenerate.map(async ({ section, index }) => {
          const sectionImageDefaults = getPdpSectionImageDefaults(section, index, targetSections.length, referenceModelUsage);
          const sectionSpecificOptions = normalizeImageOptions(
            sectionOptions[index],
            sectionImageDefaults
          );
          const referenceModelApplies = Boolean(
            referenceModelImage &&
              referenceModelUsage &&
              (referenceModelUsage === "all-sections" || index === 0)
          );
          const shouldUseReferenceModel = Boolean(sectionSpecificOptions.withModel && referenceModelApplies);
          const response = await apiJson<PdpGenerateImageResponse>("/pdp/images", {
            method: "POST",
            body: JSON.stringify({
              originalImageBase64: initialResult.originalImage,
              originalImageMimeType: initialResult.originalImageMimeType,
              originalImageFileName: initialResult.originalImageFileName,
              section,
              aspectRatio,
              desiredTone: desiredTone || undefined,
              options: {
                ...sectionSpecificOptions,
                aiProvider,
                outputMode,
                headline: section.headline,
                subheadline: section.subheadline,
                isRegeneration: false,
                referenceModelImageBase64: shouldUseReferenceModel ? referenceModelImage?.base64 : undefined,
                referenceModelImageMimeType: shouldUseReferenceModel ? referenceModelImage?.mimeType : undefined,
                referenceModelImageFileName: shouldUseReferenceModel ? referenceModelImage?.fileName : undefined
              }
            })
          }, { geminiApiKey, openAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS });

          if (!response.ok) {
            const detail = response.detail ? ` ${response.detail}` : "";
            throw new Error(`${getDisplaySectionName(section)}: ${response.message}${detail}`);
          }

          completedCount += 1;
          setNotice(`${completedCount}/${sectionsToGenerate.length}개 섹션 이미지 생성 완료`);

          return {
            index,
            sectionId: section.section_id,
            generatedImage: toDataUrl(response.mimeType, response.imageBase64)
          };
        })
      );

      const generatedSections: Array<{ index: number; sectionId: string; generatedImage: string }> = [];
      const failureEntries: Array<{ sectionId: string; message: string }> = [];

      settledSections.forEach((result, settledIndex) => {
        if (result.status === "fulfilled") {
          generatedSections.push(result.value);
          return;
        }

        const failedSection = sectionsToGenerate[settledIndex]?.section;
        const failedSectionName = failedSection ? getDisplaySectionName(failedSection) : `섹션 ${settledIndex + 1}`;
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failureEntries.push({
          sectionId: failedSection?.section_id ?? `missing-${settledIndex}`,
          message: reason.includes(":") ? reason : `${failedSectionName}: ${reason}`
        });
      });

      const generatedImageByIndex = new Map(generatedSections.map(({ index, generatedImage }) => [index, generatedImage]));
      if (generatedImageByIndex.size) {
        setSections((current) =>
          current.map((section, index) => {
            const generatedImage = generatedImageByIndex.get(index);
            return generatedImage ? { ...section, generatedImage } : section;
          })
        );
      }

      if (generatedSections.length || failureEntries.length) {
        setSectionImageErrorsById((current) => {
          const next = { ...current };
          generatedSections.forEach(({ sectionId }) => {
            delete next[sectionId];
          });
          failureEntries.forEach(({ sectionId, message }) => {
            next[sectionId] = message;
          });
          return next;
        });
      }

      const failureMessages = failureEntries.map(({ message }) => message);
      if (failureMessages.length) {
        const firstFailure = failureMessages[0] ?? "알 수 없는 오류";
        const failureSummary = generatedSections.length
          ? `${generatedSections.length}개는 생성했고 ${failureMessages.length}개는 실패했습니다. ${firstFailure}`
          : `${failureMessages.length}개 섹션 이미지를 만들지 못했습니다. ${firstFailure}`;
        setErrorMessage(failureSummary);
        setNotice(
          generatedSections.length
            ? `${generatedSections.length}개 섹션 이미지는 저장했습니다. 남은 섹션은 API 한도나 일시 오류가 풀리면 다시 생성하세요.`
            : "섹션 이미지를 만들지 못했습니다. 아래 오류를 확인한 뒤 API 한도나 키 상태를 점검해 주세요."
        );
        logEditorEvent(
          generatedSections.length
            ? "editor.missing_images_generation_partial_failure"
            : "editor.missing_images_generation_failed",
          {
            generatedCount: generatedSections.length,
            failedCount: failureMessages.length,
            totalRequested: sectionsToGenerate.length,
            durationMs: Date.now() - batchStartedAt
          },
          generatedSections.length ? "warn" : "error",
          failureMessages.join("\n\n")
        );
        return;
      }

      setNotice(`${generatedSections.length}개 섹션 이미지를 한 번에 생성했습니다.`);
      logEditorEvent("editor.missing_images_generation_completed", {
        generatedCount: generatedSections.length,
        failedCount: 0,
        totalRequested: sectionsToGenerate.length,
        durationMs: Date.now() - batchStartedAt
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "섹션 이미지를 한 번에 생성하지 못했습니다.");
      logEditorEvent("editor.missing_images_generation_failed", {
        totalRequested: sectionsToGenerate.length,
        completedCount,
        durationMs: Date.now() - batchStartedAt
      }, "error", error instanceof Error ? error : String(error));
    } finally {
      setIsGeneratingAllImages(false);
    }
  };

  const handleGenerateMissingImages = () => {
    void generateMissingImagesForSections(sections);
  };

  const handleGenerateImage = async () => {
    if (isGeneratingAllImages) {
      return;
    }

    setIsGeneratingImage(true);
    setErrorMessage("");
    setSectionImageErrorsById((current) => {
      const next = { ...current };
      delete next[currentSection.section_id];
      return next;
    });
    const generationStartedAt = Date.now();
    logEditorEvent("editor.current_image_generation_started", {
      isRegeneration: Boolean(currentSection.generatedImage),
      withModel: Boolean(currentOptions.withModel),
      usesReferenceModel,
      guidePriorityMode: currentOptions.guidePriorityMode,
      style: currentOptions.style
    });

    try {
      const response = await apiJson<PdpGenerateImageResponse>("/pdp/images", {
        method: "POST",
        body: JSON.stringify({
          originalImageBase64: initialResult.originalImage,
          originalImageMimeType: initialResult.originalImageMimeType,
          originalImageFileName: initialResult.originalImageFileName,
          section: currentSection,
          aspectRatio,
          desiredTone: desiredTone || undefined,
          options: {
            ...currentOptions,
            aiProvider,
            outputMode,
            headline: currentSection.headline,
            subheadline: currentSection.subheadline,
            isRegeneration: Boolean(currentSection.generatedImage),
            referenceModelImageBase64: usesReferenceModel ? referenceModelImage?.base64 : undefined,
            referenceModelImageMimeType: usesReferenceModel ? referenceModelImage?.mimeType : undefined,
            referenceModelImageFileName: usesReferenceModel ? referenceModelImage?.fileName : undefined
          }
        })
      }, { geminiApiKey, openAiApiKey });

      setIsGeneratingImage(false);

      if (!response.ok) {
        setErrorMessage(response.message);
        setSectionImageErrorsById((current) => ({
          ...current,
          [currentSection.section_id]: response.message
        }));
        logEditorEvent("editor.current_image_generation_api_failed", {
          code: response.code,
          isRegeneration: Boolean(currentSection.generatedImage),
          durationMs: Date.now() - generationStartedAt
        }, "error", response.detail || response.message);
        return;
      }

      setSections((current) =>
        current.map((section, index) =>
          index === currentSectionIndex
            ? {
                ...section,
                generatedImage: toDataUrl(response.mimeType, response.imageBase64)
              }
            : section
        )
      );
      setSectionImageErrorsById((current) => {
        const next = { ...current };
        delete next[currentSection.section_id];
        return next;
      });
      setNotice(`${getDisplaySectionName(currentSection)} 이미지를 새 옵션으로 업데이트했습니다.`);
      logEditorEvent("editor.current_image_generation_completed", {
        isRegeneration: Boolean(currentSection.generatedImage),
        durationMs: Date.now() - generationStartedAt
      });
    } catch (error) {
      setIsGeneratingImage(false);
      const message = error instanceof Error ? error.message : "이미지를 다시 만들지 못했습니다.";
      setErrorMessage(message);
      setSectionImageErrorsById((current) => ({
        ...current,
        [currentSection.section_id]: message
      }));
      logEditorEvent(
        "editor.current_image_generation_failed",
        { durationMs: Date.now() - generationStartedAt },
        "error",
        error instanceof Error ? error : String(error)
      );
    }
  };

  const handleAddTextOverlay = (
    translations: Record<PdpCopyLanguage, string>,
    type: "headline" | "subheadline" | "keypoint" | "default" = "default"
  ) => {
    if (isCompleteMode) {
      setErrorMessage("통이미지 모드는 텍스트가 이미지 안에 포함된 결과입니다. 문구 변경은 이미지 옵션에서 다시 생성해 주세요.");
      logEditorEvent("editor.text_layer_add_blocked", { reason: "full_image_mode", type }, "warn");
      return;
    }

    if (!currentSection.generatedImage) {
      setErrorMessage("이미지를 먼저 생성해야 텍스트를 올릴 수 있습니다.");
      logEditorEvent("editor.text_layer_add_blocked", { reason: "missing_generated_image", type }, "warn");
      return;
    }

    const defaultFontSize =
      type === "headline" ? 42 : type === "subheadline" ? 24 : type === "keypoint" ? 18 : 20;
    const normalizedTranslations = type === "keypoint"
      ? {
          ko: `• ${translations.ko}`,
          en: `• ${translations.en}`
        }
      : translations;
    const displayText = normalizedTranslations[defaultCopyLanguage] || normalizedTranslations.ko;
    const defaultFontWeight = type === "subheadline" ? "500" : "700";
    const estimatedBox = estimateOverlayBox(displayText, {
      fontSize: defaultFontSize,
      fontWeight: defaultFontWeight,
      fontFamily: "'Pretendard', sans-serif",
      lineHeight: 1.2,
      maxWidth: type === "headline" ? 360 : type === "subheadline" ? 320 : 280
    });

    const newOverlay: TextOverlay = {
      id: crypto.randomUUID(),
      kind: "text",
      text: displayText,
      language: defaultCopyLanguage,
      translations: normalizedTranslations,
      x: 52,
      y: 52,
      width: estimatedBox.width,
      height: estimatedBox.height,
      fontSize: defaultFontSize,
      color: "#ffffff",
      backgroundColor: shapeColorRecommendations[0] ?? "#102532",
      backgroundEnabled: false,
      backgroundOpacity: 0.72,
      backgroundRadius: 18,
      fontFamily: "'Pretendard', sans-serif",
      fontWeight: defaultFontWeight,
      textAlign: "left",
      lineHeight: 1.2,
      shadowEnabled: true,
      shadowColor: colorRecommendations.darkColor,
      shadowOpacity: 0.42,
      shadowBlur: 18,
      shadowOffsetY: 6
    };

    setOverlaysBySection((current) => ({
      ...current,
      [currentSectionIndex]: [...(current[currentSectionIndex] ?? []), normalizeTextOverlay(newOverlay)]
    }));
    setSelectedOverlayId(newOverlay.id);
    setWorkbenchState((current) => ({
      ...current,
      isOpen: true
    }));
    setNotice("텍스트를 추가했습니다. 위치와 크기를 직접 조절해 레이아웃을 완성해 보세요.");
    logEditorEvent("editor.text_layer_added", {
      type,
      layerCount: currentLayers.length + 1
    });
  };

  const handleAddShapeLayer = () => {
    if (isCompleteMode) {
      setErrorMessage("통이미지 모드는 배경 오브젝트를 별도 레이어로 올리지 않습니다. 이미지 옵션에서 다시 생성해 주세요.");
      logEditorEvent("editor.shape_layer_add_blocked", { reason: "full_image_mode" }, "warn");
      return;
    }

    if (!currentSection.generatedImage) {
      setErrorMessage("이미지를 먼저 생성해야 배경 사각형을 배치할 수 있습니다.");
      logEditorEvent("editor.shape_layer_add_blocked", { reason: "missing_generated_image" }, "warn");
      return;
    }

    const newShape: ShapeLayer = normalizeShapeLayer({
      id: crypto.randomUUID(),
      kind: "shape",
      x: 64,
      y: 64,
      width: 260,
      height: 120,
      fillColor: shapeColorRecommendations[0] ?? colorRecommendations.darkColor,
      fillOpacity: 1,
      borderRadius: 0
    });

    setOverlaysBySection((current) => ({
      ...current,
      [currentSectionIndex]: [...(current[currentSectionIndex] ?? []), newShape]
    }));
    setSelectedOverlayId(newShape.id);
    setEditingOverlayId(null);
    setWorkbenchTab("layer");
    setWorkbenchState((current) => ({
      ...current,
      isOpen: true
    }));
    setNotice("배경 사각형을 추가했습니다. 드래그와 리사이즈로 자유롭게 레이아웃을 만들 수 있습니다.");
    logEditorEvent("editor.shape_layer_added", {
      layerCount: currentLayers.length + 1
    });
  };

  const handleAddSection = (manualDefinition: ManualSectionOption) => {
    const insertIndex = currentSectionIndex + 1;
    const heroSection = sections[0] ?? currentSection;
    const previousSection = sections[Math.max(0, insertIndex - 1)] ?? currentSection;
    const nextSection = sections[insertIndex];
    const sectionId = `S${insertIndex + 1}_${manualDefinition.idToken}_${Date.now().toString(36)}`;
    const sectionCopy = buildExpansionSectionCopy({
      heroSection,
      sectionId,
      sectionName: manualDefinition.sectionName,
      goal: manualDefinition.goal,
      strategyTitle: "상세페이지 서사 보강",
      sectionIndex: insertIndex + 1,
      totalSections: sections.length + 1,
      isLastSection: insertIndex >= sections.length,
      additionalInfo,
      blueprintSummary: initialResult.blueprint.executiveSummary,
      blueprintList: initialResult.blueprint.blueprintList,
      customerReviewAnalysis,
      contextSections: uniqueSectionsById([heroSection, previousSection, currentSection, nextSection, ...sections])
    });
    const isConcernListSection = manualDefinition.id === "concernList";
    const isReviewSection = manualDefinition.id === "review";
    const reviewDataNote = customerReviewAnalysis
      ? `입력된 후기 파일 "${customerReviewAnalysis.fileName}"의 ${customerReviewAnalysis.reviewCount}건 분석 결과를 반영합니다. 부각할 장점: ${customerReviewAnalysis.topBenefits.slice(0, 3).join(" / ") || "후기 만족 포인트"}. 개선할 아쉬움: ${(customerReviewAnalysis.improvementPromises.length ? customerReviewAnalysis.improvementPromises : customerReviewAnalysis.painPoints).slice(0, 3).join(" / ") || "구매 전 불안 해소"}.`
      : "";
    const newSection = normalizeSectionCopyFields({
      section_id: sectionId,
      section_name: manualDefinition.sectionName,
      goal: sectionCopy.goal,
      headline: sectionCopy.headline,
      headline_en: sectionCopy.headline_en,
      subheadline: sectionCopy.subheadline,
      subheadline_en: sectionCopy.subheadline_en,
      bullets: sectionCopy.bullets,
      bullets_en: sectionCopy.bullets_en,
      trust_or_objection_line: sectionCopy.trust_or_objection_line,
      trust_or_objection_line_en: sectionCopy.trust_or_objection_line_en,
      CTA: sectionCopy.CTA,
      CTA_en: sectionCopy.CTA_en,
      layout_notes: sectionCopy.layout_notes,
      compliance_notes: isReviewSection
        ? `실제 리뷰 수, 100% 리얼 리뷰, 인증된 후기, 특정 효능 수치처럼 검증되지 않은 표현은 쓰지 않습니다. 후기 문장은 제품 맥락에서 가능한 사용감 중심으로만 구성합니다.${reviewDataNote ? ` ${reviewDataNote}` : ""}`
        : isConcernListSection
          ? `고객 고민은 실제 후기의 아쉬움이나 구매 전 흔한 질문을 짧은 말풍선 문장으로만 구성합니다. 효능, 부작용, 수치, 인증을 새로 단정하지 않습니다.${reviewDataNote ? ` ${reviewDataNote}` : ""}`
          : "",
      image_id: `IMG_${sectionId}`,
      purpose: sectionCopy.purpose,
      prompt_ko: sectionCopy.prompt_ko,
      prompt_en: sectionCopy.prompt_en,
      negative_prompt: isCompleteMode
        ? isReviewSection
          ? "일반 라이프스타일 광고컷, 제품 장점 칩만 나열한 구성, 모델이 제품을 들고 있는 단순 포즈, 작은 글씨, 워터마크, 왜곡된 제품, 잘못된 제품 디테일, 섹션마다 다른 한글 폰트, 손글씨체, 장식 서체, 검증되지 않은 100% 리얼 리뷰 문구"
          : isConcernListSection
            ? "일반 라이프스타일 광고컷, 모델이 제품을 들고 있는 단순 포즈, 별점 후기 카드, 밝은 정보 카드 위주의 구성, 작은 글씨, 워터마크, 왜곡된 제품, 잘못된 제품 디테일, 섹션마다 다른 한글 폰트, 손글씨체, 장식 서체, 검증되지 않은 효능 또는 부작용 단정"
          : "작은 글씨, 워터마크, 왜곡된 제품, 잘못된 제품 디테일, 섹션마다 다른 한글 폰트, 손글씨체, 장식 서체"
        : "내부 섹션명, 플레이스홀더 문구, 새 마케팅 문구, 워터마크, 왜곡된 제품, 잘못된 제품 디테일",
      style_guide: isReviewSection
        ? `현재 상세페이지 톤과 이어지는 고객 후기 섹션. 큰 제목 + 별점/마스킹 ID/인용부호가 있는 후기 카드 3~4개 또는 UGC 포스트형 카드 1개를 중심으로 구성합니다. ${reviewDataNote || "후기 문장은 제품 맥락에서 가능한 사용감 중심으로 구성합니다."} 통이미지 문구는 Pretendard/Noto Sans KR 계열의 현대적인 한글 산세리프 한 계열로 통일합니다.`
        : isConcernListSection
          ? `첨부 참고처럼 깊은 블랙 배경 위에 큰 제목과 좌우로 엇갈린 흰색 채팅 말풍선 4~5개를 배치하는 고객 고민 리스팅 섹션. ${reviewDataNote || "구매 전 망설임을 먼저 보여주고 다음 섹션에서 답을 제시합니다."} 제품은 작은 보조 오브젝트로만 두거나 생략하고, 통이미지 문구는 Pretendard/Noto Sans KR 계열의 현대적인 한글 산세리프 한 계열로 통일합니다.`
        : "현재 상세페이지의 톤과 이어지는 고급스러운 광고 사진. 통이미지 문구는 Pretendard/Noto Sans KR 계열의 현대적인 한글 산세리프 한 계열로 통일합니다.",
      reference_usage: "원본 제품 이미지의 형태, 색상, 재질, 로고와 주요 디테일을 유지합니다."
    });

    setSections((current) => [...current.slice(0, insertIndex), newSection, ...current.slice(insertIndex)]);
    setSectionOptions((current) => shiftIndexedRecordForInsert(current, insertIndex));
    setOverlaysBySection((current) => shiftIndexedRecordForInsert(current, insertIndex));
    setCurrentSectionIndex(insertIndex);
    setSelectedOverlayId(null);
    setWorkbenchTab("image");
    setIsSectionPickerOpen(false);
    setNotice(`${manualDefinition.sectionName} 섹션을 추가했습니다. 기존 상세페이지 카피 흐름을 이어 만든 문구를 확인한 뒤 이미지를 생성하세요.`);
    logEditorEvent("editor.section_added", {
      insertIndex,
      sectionType: manualDefinition.id,
      sectionName: manualDefinition.sectionName,
      nextSectionCount: sections.length + 1
    });
  };

  const isExpandingRef = useRef(false);

  const handleApplyExpansionStrategy = async () => {
    if (sections.length > 1) {
      setNotice("이미 섹션이 확장되어 있습니다. 필요한 섹션은 직접 추가하거나 복제해서 조정하세요.");
      logEditorEvent("editor.expansion_blocked", {
        reason: "already_expanded",
        sectionCount: sections.length
      }, "warn");
      return;
    }

    const heroSection = sections[0];
    if (!heroSection) {
      setNotice("기준 섹션을 먼저 준비한 뒤 전체 섹션을 생성할 수 있습니다.");
      logEditorEvent("editor.expansion_blocked", { reason: "missing_hero_section" }, "warn");
      return;
    }

    if (isExpandingRef.current) {
      return;
    }
    isExpandingRef.current = true;
    setIsExpanding(true);

    // No silent client-template fallback here anymore: it used to replace every non-hero
    // section with keyword-guessed sample copy when /pdp/expand failed, which is how
    // another product's template text ended up mixed into user pages. Expansion failure
    // is now surfaced to the user with a retry path instead.
    let expandedSections: SectionBlueprint[] = [];

    setNotice(`${selectedExpansionStrategy.title} 흐름으로 전체 섹션 카피를 설계하는 중입니다...`);

    try {
      const style: PdpExpandStyleGuide = {
        id: selectedExpansionStrategy.id as PdpExpansionStyle,
        title: selectedExpansionStrategy.title,
        flowIntent: selectedExpansionStrategy.flowIntent,
        keyMessage: selectedExpansionStrategy.keyMessage,
        sectionRoster: selectedExpansionStrategy.sections.map((strategySection) => ({
          id: strategySection.id,
          name: strategySection.name,
          intent: strategySection.intent
        }))
      };
      const response = await apiJson<
        PdpExpandResponse | { ok: false; code?: string; message?: string; detail?: string }
      >(
        "/pdp/expand",
        {
          method: "POST",
          body: JSON.stringify({
            heroBlueprint: {
              ...initialResult.blueprint,
              // Strip the multi-MB hero generatedImage data URL: the server only reads the
              // hero's text fields, and the client keeps its own hero section for the canvas.
              sections: initialResult.blueprint.sections.map(({ generatedImage, ...rest }) => rest)
            },
            style,
            reviewAnalysis: customerReviewAnalysis ?? undefined,
            productContext: {
              desiredTone: desiredTone || undefined,
              aspectRatio,
              aiProvider,
              outputMode
            }
          })
        },
        { geminiApiKey, openAiApiKey, timeoutMs: GENERATION_API_TIMEOUT_MS }
      );

      if (!response.ok) {
        throw new Error(response.message || "AI 확장 응답이 올바르지 않습니다.");
      }

      // Server returns [hero, ...expanded]; keep our existing hero and take the rest.
      expandedSections = response.sections
        .slice(1)
        .map((section) => normalizeSectionCopyFields({ ...section }));

      if (!expandedSections.length) {
        throw new Error("확장된 섹션이 비어 있습니다.");
      }

      logEditorEvent("editor.expansion_llm_succeeded", {
        strategyId: selectedExpansionStrategy.id,
        addedSectionCount: expandedSections.length,
        throughline: response.narrativeSpine?.throughline?.slice(0, 80)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      setNotice(
        `AI 전체 섹션 생성에 실패했습니다 (${reason}). 기존 섹션은 그대로 두었어요. 네트워크와 API 키를 확인한 뒤 '전체 섹션 생성'을 다시 눌러주세요.`
      );
      logEditorEvent(
        "editor.expansion_failed",
        {
          strategyId: selectedExpansionStrategy.id,
          reason
        },
        "error"
      );
      return;
    } finally {
      isExpandingRef.current = false;
      setIsExpanding(false);
    }

    const nextSections = [heroSection, ...expandedSections];
    setSections(nextSections);
    setSectionOptions({});
    setOverlaysBySection((current) => {
      const next: Record<number, CanvasLayer[]> = { 0: current[0] ?? [] };
      return next;
    });
    setCurrentSectionIndex(1);
    setSelectedOverlayId(null);
    setWorkbenchTab("image");
    setNotice(
      `${selectedExpansionStrategy.title} 흐름으로 ${expandedSections.length}개 섹션을 만들었습니다. 나머지 섹션 이미지를 한 번에 생성합니다.`
    );
    logEditorEvent("editor.expansion_strategy_applied", {
      strategyId: selectedExpansionStrategy.id,
      strategyTitle: selectedExpansionStrategy.title,
      addedSectionCount: expandedSections.length,
      nextSectionCount: nextSections.length
    });
    void generateMissingImagesForSections(nextSections);
  };

  const handleDuplicateCurrentSection = () => {
    const insertIndex = currentSectionIndex + 1;
    const sectionId = `${currentSection.section_id}_Copy_${Date.now().toString(36)}`;
    const duplicatedSection = normalizeSectionCopyFields({
      ...currentSection,
      section_id: sectionId,
      image_id: `IMG_${sectionId}`,
      section_name: `${getDisplaySectionName(currentSection)} 복제`
    });
    const clonedLayers = currentLayers.map(cloneCanvasLayer);

    setSections((current) => [...current.slice(0, insertIndex), duplicatedSection, ...current.slice(insertIndex)]);
    setSectionOptions((current) => shiftIndexedRecordForInsert(current, insertIndex, currentOptions));
    setOverlaysBySection((current) => shiftIndexedRecordForInsert(current, insertIndex, clonedLayers));
    setCurrentSectionIndex(insertIndex);
    setSelectedOverlayId(null);
    setWorkbenchTab("image");
    setNotice("현재 섹션을 복제했습니다. 같은 레이아웃에서 문구와 이미지만 빠르게 바꿀 수 있습니다.");
    logEditorEvent("editor.section_duplicated", {
      insertIndex,
      clonedLayerCount: clonedLayers.length,
      nextSectionCount: sections.length + 1
    });
  };

  const handleSectionDragStart = (event: ReactDragEvent<HTMLDivElement>, index: number) => {
    if (isEditorGeneratingImage || sections.length <= 1) {
      event.preventDefault();
      return;
    }

    setDraggedSectionIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  };

  const handleSectionDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (draggedSectionIndex === null || isEditorGeneratingImage) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleSectionDrop = (event: ReactDragEvent<HTMLDivElement>, dropIndex: number) => {
    event.preventDefault();
    const rawIndex = event.dataTransfer.getData("text/plain");
    const fromIndex = rawIndex ? Number(rawIndex) : Number.NaN;
    const resolvedFromIndex = Number.isFinite(fromIndex) ? fromIndex : draggedSectionIndex;

    setDraggedSectionIndex(null);

    if (
      resolvedFromIndex === null ||
      !Number.isInteger(resolvedFromIndex) ||
      resolvedFromIndex < 0 ||
      resolvedFromIndex >= sections.length ||
      dropIndex < 0 ||
      dropIndex >= sections.length ||
      resolvedFromIndex === dropIndex
    ) {
      return;
    }

    setSections((current) => moveArrayItem(current, resolvedFromIndex, dropIndex));
    setSectionOptions((current) => moveIndexedRecordItem(current, resolvedFromIndex, dropIndex, sections.length));
    setOverlaysBySection((current) => moveIndexedRecordItem(current, resolvedFromIndex, dropIndex, sections.length));
    setCurrentSectionIndex((current) => getIndexAfterMove(current, resolvedFromIndex, dropIndex));
    setSelectedOverlayId(null);
    setEditingOverlayId(null);
    setActiveColorPalette(null);
    setNotice(`${getDisplaySectionName(sections[resolvedFromIndex])} 섹션을 ${dropIndex + 1}번째 위치로 이동했습니다.`);
    logEditorEvent("editor.section_reordered", {
      fromIndex: resolvedFromIndex,
      toIndex: dropIndex,
      sectionId: sections[resolvedFromIndex]?.section_id ?? "unknown"
    });
  };

  const handleSectionDragEnd = () => {
    setDraggedSectionIndex(null);
  };

  const requestDeleteSection = (sectionIndex: number) => {
    if (sections.length <= 1) {
      setNotice("마지막 섹션은 삭제할 수 없습니다. 상세페이지에는 최소 1개 섹션이 필요합니다.");
      logEditorEvent("editor.section_delete_blocked", {
        reason: "last_section",
        sectionIndex
      }, "warn");
      return;
    }

    setPendingDeleteSectionIndex(sectionIndex);
  };

  const cancelDeleteSection = () => {
    setPendingDeleteSectionIndex(null);
  };

  const confirmDeleteSection = () => {
    if (pendingDeleteSectionIndex === null) {
      return;
    }

    if (sections.length <= 1) {
      cancelDeleteSection();
      setNotice("마지막 섹션은 삭제할 수 없습니다.");
      return;
    }

    const deleteIndex = pendingDeleteSectionIndex;
    const deletedSection = sections[deleteIndex];

    setSections((current) => current.filter((_, index) => index !== deleteIndex));
    setSectionOptions((current) => shiftIndexedRecordForDelete(current, deleteIndex));
    setOverlaysBySection((current) => shiftIndexedRecordForDelete(current, deleteIndex));
    setCurrentSectionIndex((current) => {
      if (current > deleteIndex) {
        return current - 1;
      }

      return Math.min(current, sections.length - 2);
    });
    setSelectedOverlayId(null);
    setEditingOverlayId(null);
    setActiveColorPalette(null);
    setWorkbenchTab("image");
    setPendingDeleteSectionIndex(null);
    setNotice(`${deletedSection ? getDisplaySectionName(deletedSection) : "선택한"} 섹션을 삭제했습니다.`);
    logEditorEvent("editor.section_deleted", {
      deletedSectionId: deletedSection?.section_id ?? "unknown",
      deletedSectionName: deletedSection ? getDisplaySectionName(deletedSection) : "unknown",
      nextSectionCount: Math.max(0, sections.length - 1)
    });
  };

  const updateOverlay = (overlayId: string, updates: Partial<CanvasLayer>) => {
    setOverlaysBySection((current) => ({
      ...current,
      [currentSectionIndex]: (current[currentSectionIndex] ?? []).map((overlay) =>
        overlay.id === overlayId ? normalizeCanvasLayer({ ...overlay, ...updates }) : overlay
      )
    }));
  };

  const handleResizeStart = (overlay: CanvasLayer) => {
    resizeSessionRef.current[overlay.id] = {
      width: toNumericSize(overlay.width, 320),
      height: toNumericSize(overlay.height, 92),
      fontSize: isTextLayer(overlay) ? overlay.fontSize : 0
    };
  };

  const handleResize = (
    overlay: CanvasLayer,
    direction: string,
    ref: HTMLElement,
    position: { x: number; y: number },
    displayScale = 1
  ) => {
    const normalizedScale = displayScale > 0 ? displayScale : 1;
    const base = resizeSessionRef.current[overlay.id] ?? {
      width: toNumericSize(overlay.width, 320),
      height: toNumericSize(overlay.height, 92),
      fontSize: isTextLayer(overlay) ? overlay.fontSize : 0
    };

    const nextWidth = ref.offsetWidth / normalizedScale;
    const nextHeight = ref.offsetHeight / normalizedScale;
    const nextPosition = {
      x: position.x / normalizedScale,
      y: position.y / normalizedScale
    };
    const isHorizontalOnly = direction === "left" || direction === "right";
    const isVerticalOnly = direction === "top" || direction === "bottom";

    if (isHorizontalOnly) {
      updateOverlay(overlay.id, {
        width: nextWidth,
        x: nextPosition.x
      });
      return;
    }

    if (isVerticalOnly) {
      updateOverlay(overlay.id, {
        height: nextHeight,
        y: nextPosition.y
      });
      return;
    }

    if (isShapeLayer(overlay)) {
      updateOverlay(overlay.id, {
        width: nextWidth,
        height: nextHeight,
        x: nextPosition.x,
        y: nextPosition.y
      });
      return;
    }

    const resizeScale = Math.max(nextWidth / Math.max(base.width, 1), nextHeight / Math.max(base.height, 1));
    const nextFontSize = clampValue(Math.round(base.fontSize * resizeScale), 10, 180);

    updateOverlay(overlay.id, {
      width: nextWidth,
      height: nextHeight,
      x: nextPosition.x,
      y: nextPosition.y,
      fontSize: nextFontSize
    });
  };

  const handleResizeStop = (overlayId: string) => {
    delete resizeSessionRef.current[overlayId];
  };

  const handleOverlayDrag = (overlay: CanvasLayer, x: number, y: number) => {
    const normalizedScale = canvasScale > 0 ? canvasScale : 1;
    updateOverlay(overlay.id, {
      x: x / normalizedScale,
      y: y / normalizedScale
    });
  };

  const captureSectionBlob = async (sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section?.generatedImage) {
      throw new Error("이미지가 없는 섹션은 다운로드할 수 없습니다.");
    }

    const width = EXPORT_CANVAS_WIDTH;
    const layers = isCompleteMode ? [] : overlaysBySection[sectionIndex] ?? [];
    const exportNode = await buildExportNode({
      imageSrc: section.generatedImage,
      width,
      layers,
      layerScale: width / EDITOR_CANVAS_BASE_WIDTH
    });

    document.body.appendChild(exportNode);

    try {
      // Wait for Pretendard (loaded via a remote CDN @import) to finish loading before
      // rasterizing. Otherwise html2canvas can capture fallback-font glyphs/metrics,
      // which shifts and re-wraps Korean text in the exported image. FONT_WEIGHT_OPTIONS
      // only exposes 400/500/700/900, so preloading those covers every selectable weight.
      if (typeof document !== "undefined" && document.fonts) {
        try {
          await Promise.all(
            ["400", "500", "700", "900"].map((weight) => document.fonts.load(`${weight} 16px Pretendard`))
          );
        } catch {
          // Ignore individual font-load failures; fall back to whatever is already available.
        }
        try {
          await document.fonts.ready;
        } catch {
          // Never block the export on font readiness.
        }
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      const canvas = await html2canvas(exportNode, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: null,
        scale: 2
      });

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.92);
      });

      if (!blob) {
        throw new Error("다운로드용 이미지를 만들지 못했습니다.");
      }

      return blob;
    } finally {
      exportNode.remove();
    }
  };

  const handleDownload = async () => {
    if (!currentSection.generatedImage) {
      logEditorEvent("editor.current_section_download_blocked", { reason: "missing_generated_image" }, "warn");
      return;
    }

    try {
      logEditorEvent("editor.current_section_download_started");
      setSelectedOverlayId(null);
      setEditingOverlayId(null);
      setActiveColorPalette(null);
      const blob = await captureSectionBlob(currentSectionIndex);
      downloadBlob(blob, `pdp-${sanitizeSectionFileName(currentSection.section_id)}.jpg`);
      setNotice(`${getDisplaySectionName(currentSection)} 컷을 다운로드했습니다.`);
      logEditorEvent("editor.current_section_downloaded", {
        blobSize: blob.size
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "이미지를 다운로드하지 못했습니다.");
      logEditorEvent("editor.current_section_download_failed", undefined, "error", error instanceof Error ? error : String(error));
    }
  };

  const handleDownloadAll = async () => {
    const downloadableSections = sections
      .map((section, index) => ({ section, index }))
      .filter((entry) => Boolean(entry.section.generatedImage));

    if (!downloadableSections.length) {
      setErrorMessage("다운로드할 이미지가 아직 없습니다.");
      logEditorEvent("editor.all_sections_download_blocked", { reason: "no_downloadable_sections" }, "warn");
      return;
    }

    try {
      setIsDownloadingAll(true);
      logEditorEvent("editor.all_sections_download_started", {
        downloadableCount: downloadableSections.length
      });
      setSelectedOverlayId(null);
      setEditingOverlayId(null);
      setActiveColorPalette(null);

      const zip = new JSZip();

      for (const { section, index } of downloadableSections) {
        const blob = await captureSectionBlob(index);
        zip.file(`pdp-${String(index + 1).padStart(2, "0")}-${sanitizeSectionFileName(section.section_id)}.jpg`, blob);
      }

      const archive = await zip.generateAsync({ type: "blob" });
      downloadBlob(archive, `pdp-sections-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice(`${downloadableSections.length}개 섹션 이미지를 ZIP으로 다운로드했습니다.`);
      logEditorEvent("editor.all_sections_downloaded", {
        downloadableCount: downloadableSections.length,
        zipSize: archive.size
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "전체 이미지를 ZIP으로 다운로드하지 못했습니다.");
      logEditorEvent("editor.all_sections_download_failed", {
        downloadableCount: downloadableSections.length
      }, "error", error instanceof Error ? error : String(error));
    } finally {
      setIsDownloadingAll(false);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.editorShell} onClick={clearLayerSelection}>
        <header className={styles.editorHeader} onClick={stopShellClick}>
          <div>
            <h1 className={styles.editorHeading}>
              <button className={styles.brandHomeButton} onClick={onReset} type="button">
                {APP_TITLE}
              </button>
            </h1>
            {lastSavedAt ? <span className={styles.editorSavedAt}>최근 저장 {formatSavedAt(lastSavedAt)}</span> : null}
          </div>

          <div className={styles.topbarActions}>
            {onManualSave ? (
              <button className={`${styles.secondaryButton} ${styles.headerActionButton} ${styles.headerSaveButton}`} disabled={saveState === "saving"} onClick={onManualSave} type="button">
                {saveState === "saving" ? <Loader2 className={styles.spinIcon} size={14} /> : <Save size={14} />}
                작업 저장하기
              </button>
            ) : null}
            <button
              className={`${styles.secondaryButton} ${styles.headerActionButton} ${styles.zipDownloadButton}`}
              disabled={!generatedCount || isDownloadingAll}
              onClick={handleDownloadAll}
              type="button"
            >
              {isDownloadingAll ? <Loader2 className={styles.spinIcon} size={14} /> : <Download size={14} />}
              전체 이미지 다운
            </button>
            <button
              className={`${styles.primaryButton} ${styles.headerActionButton} ${styles.currentDownloadButton}`}
              onClick={handleDownload}
              type="button"
              disabled={!currentSection.generatedImage}
            >
              <Download size={14} />
              현재 이미지 다운
            </button>
          </div>
        </header>

        {showSaveToast ? <div className={styles.saveToast}>저장되었습니다.</div> : null}

        <div className={styles.noticeRow} onClick={stopShellClick}>
          {heroWarning ? (
            <div className={styles.heroWarningBanner} role="alert">
              <AlertCircle size={18} />
              <span className={styles.heroWarningText}>{heroWarning}</span>
              <button
                className={styles.heroWarningDismiss}
                onClick={() => setHeroWarning("")}
                type="button"
                aria-label="경고 닫기"
              >
                확인함
              </button>
            </div>
          ) : null}
          <div className={styles.noticeBanner}>{notice}</div>
          {errorMessage ? (
            <div className={styles.errorBanner}>
              <AlertCircle size={16} />
              {errorMessage}
            </div>
          ) : null}
        </div>

        <div className={styles.editorLayout}>
          <aside className={styles.sectionRail} onClick={stopShellClick}>
            <div className={styles.railCard}>
              <p className={styles.sidebarLabel}>현재 섹션</p>
              <h2 className={styles.railTitle}>{getDisplaySectionName(currentSection)}</h2>
              <p className={styles.railDescription}>{getDisplaySectionGoal(currentSection)}</p>
                <div className={styles.metricGrid}>
                  <div className={styles.metricCard}>
                    <span>현재 섹션</span>
                  <strong>
                    {currentSectionIndex + 1}/{sections.length}
                  </strong>
                  </div>
                  <div className={styles.metricCard}>
                    <span>{isCompleteMode ? "모드" : "레이어"}</span>
                    <strong>{isCompleteMode ? "통이미지" : currentLayers.length}</strong>
                  </div>
                </div>
              </div>

            {sections.length === 1 ? (
              <div className={styles.expansionPanel}>
                <div className={styles.expansionHeader}>
                  <p className={styles.sidebarLabel}>다음 단계</p>
                  <h2 className={styles.railTitle}>섹션 타입 선택</h2>
                  <p className={styles.railDescription}>히어로우를 확인한 뒤 상세페이지 흐름을 고르면 나머지 섹션을 한 번에 생성합니다.</p>
                </div>
                <div className={styles.expansionStrategyGrid}>
                  {EXPANSION_STRATEGIES.map((strategy) => {
                    const isActive = selectedExpansionStrategyId === strategy.id;
                    if (strategy.locked) {
                      return (
                        <button
                          className={styles.expansionStrategyLocked}
                          key={strategy.id}
                          onClick={() => undefined}
                          aria-disabled={true}
                          disabled
                          type="button"
                        >
                          <strong>{strategy.title}</strong>
                          <span className={styles.expansionStrategyLockBadge}>
                            <Lock size={11} />
                            추후 공개됩니다
                          </span>
                          <small>{strategy.description}</small>
                        </button>
                      );
                    }
                    return (
                      <button
                        className={isActive ? styles.expansionStrategyActive : styles.expansionStrategy}
                        key={strategy.id}
                        onClick={() => setSelectedExpansionStrategyId(strategy.id)}
                        aria-pressed={isActive}
                        type="button"
                      >
                        <strong>{strategy.title}</strong>
                        <span>{strategy.range}</span>
                        <small>{strategy.description}</small>
                        <em>{strategy.bestFor}</em>
                      </button>
                    );
                  })}
                </div>
                <button className={styles.primaryButtonWide} disabled={isExpanding || isGeneratingAllImages} onClick={handleApplyExpansionStrategy} type="button">
                  {isExpanding || isGeneratingAllImages ? <Loader2 className={styles.spinIcon} size={15} /> : <Sparkles size={15} />}
                  {isExpanding ? "전체 흐름 설계 중..." : isGeneratingAllImages ? "나머지 섹션 생성 중" : "전체 섹션 만들기"}
                </button>
              </div>
            ) : null}

            <div className={styles.sectionRailCard}>
              <p className={styles.sidebarLabel}>섹션 목록</p>
              <div className={styles.sectionRailActions}>
                <button
                  className={styles.inlineButton}
                  disabled={isEditorGeneratingImage}
                  onClick={() => setIsSectionPickerOpen((current) => !current)}
                  type="button"
                >
                  <Sparkles size={14} />
                  섹션 추가
                  {isSectionPickerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                <button className={styles.inlineButton} disabled={isEditorGeneratingImage} onClick={handleDuplicateCurrentSection} type="button">
                  <CopyIcon size={14} />
                  현재 복제
                </button>
                {missingImageCount ? (
                  <button
                    className={styles.inlineButton}
                    disabled={isGeneratingAllImages || isGeneratingImage}
                    onClick={handleGenerateMissingImages}
                    type="button"
                  >
                    {isGeneratingAllImages ? <Loader2 className={styles.spinIcon} size={14} /> : <ImageIcon size={14} />}
                    미생성 {missingImageCount}개 생성
                  </button>
                ) : null}
              </div>
              {isSectionPickerOpen ? (
                <div className={styles.manualSectionPicker}>
                  <p className={styles.manualSectionPickerLabel}>세부 섹션 선택</p>
                  {MANUAL_SECTION_OPTIONS.map((option) => (
                    <button
                      className={styles.manualSectionOption}
                      disabled={isEditorGeneratingImage}
                      key={option.id}
                      onClick={() => handleAddSection(option)}
                      type="button"
                    >
                      <strong>{option.sectionName}</strong>
                      <small>{option.description}</small>
                      <span className={styles.manualSectionKeyMessage}>{option.keyMessage}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className={styles.sectionList}>
                {sections.map((section, index) => (
                  <div
                    className={`${styles.sectionListItem} ${draggedSectionIndex === index ? styles.sectionListItemDragging : ""}`}
                    draggable={sections.length > 1 && !isEditorGeneratingImage}
                    key={section.section_id}
                    onDragEnd={handleSectionDragEnd}
                    onDragOver={handleSectionDragOver}
                    onDragStart={(event) => handleSectionDragStart(event, index)}
                    onDrop={(event) => handleSectionDrop(event, index)}
                  >
                    <button
                      className={index === currentSectionIndex ? styles.sectionButtonActive : styles.sectionButton}
                      onClick={() => setCurrentSectionIndex(index)}
                      type="button"
                    >
                      <span aria-hidden="true" className={styles.sectionDragHandle} title="드래그해서 순서 변경">
                        <GripVertical size={14} />
                      </span>
                      <span className={styles.sectionStep}>
                        {section.generatedImage && index !== currentSectionIndex ? <CheckCircle2 size={12} /> : index + 1}
                      </span>
                      <span className={styles.sectionButtonCopy}>
                        <strong>{getDisplaySectionName(section)}</strong>
                      </span>
                    </button>
                    {sections.length > 1 ? (
                      <button
                        aria-label={`${getDisplaySectionName(section)} 섹션 삭제`}
                        className={styles.sectionDeleteButton}
                        disabled={isEditorGeneratingImage}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDeleteSection(index);
                        }}
                        title="섹션 삭제"
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </aside>

          <section className={styles.canvasColumn}>
            <article className={styles.canvasPanel}>
              <div className={styles.canvasHeader}>
                <div>
                  <p className={styles.panelLabel}>편집 섹션</p>
                  <h2 className={styles.panelTitle}>{getDisplaySectionName(currentSection)}</h2>
                  <p className={styles.panelDescription}>{getDisplaySectionGoal(currentSection)}</p>
                </div>

                <div className={styles.canvasActions}>
                  {!workbenchState.isOpen ? (
                    <button
                      aria-label={`${activeWorkbenchLabel} 패널 열기`}
                      className={styles.reopenWorkbenchButton}
                      onClick={() => openWorkbench(workbenchTab)}
                      type="button"
                    >
                      <Settings2 size={16} />
                      옵션 패널 열기
                    </button>
                  ) : null}
                  <button
                    className={styles.navButton}
                    disabled={currentSectionIndex === 0}
                    onClick={() => setCurrentSectionIndex((current) => Math.max(0, current - 1))}
                    type="button"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span className={styles.metaPill}>
                    {currentSectionIndex + 1}/{sections.length}
                  </span>
                  <button
                    className={styles.navButton}
                    disabled={currentSectionIndex === sections.length - 1}
                    onClick={() => setCurrentSectionIndex((current) => Math.min(sections.length - 1, current + 1))}
                    type="button"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>

              <div className={workbenchState.isOpen ? styles.canvasWorkbenchFrame : styles.canvasWorkbenchFrameClosed}>
                <div className={styles.previewStage} ref={previewStageRef}>
                  {currentSection.generatedImage ? (
                    <div className={styles.imageCanvas} ref={imageContainerRef}>
                    <img
                      alt={currentSection.section_name}
                      className={styles.sectionImage}
                      draggable={false}
                      src={currentSection.generatedImage}
                    />

                    {[...currentShapeLayers, ...currentTextLayers].map((overlay) => (
                      <Rnd
                        bounds="parent"
                        className={`${styles.overlayBox} ${isShapeLayer(overlay) ? styles.shapeLayerBox : styles.textLayerBox} ${selectedOverlayId === overlay.id ? styles.overlaySelected : ""}`}
                        enableUserSelectHack={false}
                        enableResizing={
                          selectedOverlayId === overlay.id
                            ? {
                                top: true,
                                right: true,
                                bottom: true,
                                left: true,
                                topRight: true,
                                bottomRight: true,
                                bottomLeft: true,
                                topLeft: true
                              }
                            : false
                        }
                        key={overlay.id}
                        onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
                          event.stopPropagation();
                          setSelectedOverlayId(overlay.id);
                        }}
                        onDragStart={() => {
                          setSelectedOverlayId(overlay.id);
                          setActiveColorPalette(null);
                        }}
                        onDrag={(_, data) => handleOverlayDrag(overlay, data.x, data.y)}
                        onDragStop={(_, data) => handleOverlayDrag(overlay, data.x, data.y)}
                        onResize={(_, direction, ref, __, position) => handleResize(overlay, direction, ref, position, canvasScale)}
                        onResizeStart={() => {
                          handleResizeStart(overlay);
                        }}
                        onResizeStop={(_, direction, ref, __, position) => {
                          handleResize(overlay, direction, ref, position, canvasScale);
                          handleResizeStop(overlay.id);
                        }}
                        position={{ x: overlay.x * canvasScale, y: overlay.y * canvasScale }}
                        resizeHandleClasses={{
                          top: styles.resizeHandleTop,
                          bottom: styles.resizeHandleBottom,
                          left: styles.resizeHandleLeft,
                          right: styles.resizeHandleRight,
                          topLeft: styles.resizeHandleTopLeft,
                          topRight: styles.resizeHandleTopRight,
                          bottomLeft: styles.resizeHandleBottomLeft,
                          bottomRight: styles.resizeHandleBottomRight
                        }}
                        style={{
                          zIndex: isShapeLayer(overlay)
                            ? selectedOverlayId === overlay.id
                              ? 2
                              : 1
                            : selectedOverlayId === overlay.id
                              ? 5
                              : 4
                        }}
                        size={{
                          width: toNumericSize(overlay.width, 320) * canvasScale,
                          height: toNumericSize(overlay.height, 92) * canvasScale
                        }}
                      >
                        {isShapeLayer(overlay) ? (
                          <div className={`${styles.overlayContent} ${styles.overlayDragSurface}`}>
                            <div className={styles.shapeLayerSurface} style={buildShapeLayerStyle(overlay, canvasScale)} />
                          </div>
                        ) : (
                          <div
                            className={`${editingOverlayId === overlay.id ? styles.overlayEditing : styles.overlayContent} ${styles.overlayDragSurface}`}
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              setSelectedOverlayId(overlay.id);
                              setEditingOverlayId(overlay.id);
                            }}
                            style={buildOverlayShellStyle(overlay, canvasScale)}
                          >
                            {overlay.backgroundEnabled ? (
                              <div className={styles.overlayBackdrop} style={buildOverlayBackgroundStyle(overlay, canvasScale)} />
                            ) : null}
                            {editingOverlayId === overlay.id ? (
                              <textarea
                                autoFocus
                                className={styles.overlayTextarea}
                                onBlur={() => setEditingOverlayId(null)}
                                onChange={(event) => updateTextOverlayContent(overlay.id, event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    setEditingOverlayId(null);
                                  }
                                }}
                                style={buildOverlayTextStyle(overlay, canvasScale)}
                                value={overlay.text}
                              />
                            ) : (
                              <div className={styles.overlayTextLayer} style={buildOverlayTextStyle(overlay, canvasScale)}>
                                {overlay.text}
                              </div>
                            )}
                          </div>
                        )}
                      </Rnd>
                    ))}

                    </div>
                  ) : (
                    <div className={isCurrentImageLoading ? styles.placeholderPanelLoading : styles.placeholderPanel}>
                      <div className={isCurrentImageLoading ? styles.placeholderLoadingIcon : styles.placeholderIcon}>
                        {isCurrentImageLoading ? <Loader2 className={styles.spinIcon} size={30} /> : <ImageIcon size={28} />}
                      </div>
                      <div>
                        <strong>
                          {isCurrentImageLoading
                            ? "이미지 생성중입니다. 잠시만 기다려주세요."
                            : "이 섹션의 이미지를 아직 만들지 않았습니다."}
                        </strong>
                        <p>
                          {isCurrentImageLoading
                            ? "섹션 이미지를 만드는 동안 이 화면에서 진행 상태를 확인할 수 있습니다."
                            : isCompleteMode
                              ? "이미지 옵션을 정하고 완성형 섹션 이미지를 생성할 수 있습니다."
                              : "이미지 생성 옵션을 정하고 이미지를 만들면, 캔버스 안에서 바로 텍스트를 얹고 편집할 수 있습니다."}
                        </p>
                        {!isCurrentImageLoading && (currentSectionImageError || errorMessage) ? (
                          <div className={styles.placeholderError}>
                            <AlertCircle size={15} />
                            <span>{currentSectionImageError || errorMessage}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>

                {workbenchState.isOpen ? (
                  <aside className={styles.workbenchDockPanel} onClick={(event: ReactMouseEvent<HTMLElement>) => event.stopPropagation()}>
                    <div className={styles.workbenchPanel}>
                      <div className={styles.workbenchHandle}>
                        <div className={styles.workbenchHandleCopy}>
                          <span className={styles.optionMiniLabel}>Canvas Workbench</span>
                          <strong>{activeWorkbenchLabel}</strong>
                        </div>
                        <div className={styles.workbenchHeaderActions}>
                          <span className={styles.dockStatusPill}>오른쪽 고정</span>
                          <button
                            className={styles.inlineButton}
                            onClick={() =>
                              {
                                setWorkbenchState((current) => ({
                                  ...current,
                                  isOpen: false
                                }));
                                logEditorEvent("editor.workbench_closed", {
                                  tab: workbenchTab
                                });
                              }
                            }
                            type="button"
                          >
                            닫기
                          </button>
                        </div>
                      </div>

                      <div className={styles.workbenchTabs}>
                        <button
                          className={workbenchTab === "image" ? styles.workbenchTabActive : styles.workbenchTab}
                          onClick={() => {
                            setWorkbenchTab("image");
                            logEditorEvent("editor.workbench_tab_selected", { tab: "image" });
                          }}
                          type="button"
                        >
                          <Settings2 size={15} />
                          이미지
                        </button>
                        {!isCompleteMode ? (
                          <>
                            <button
                              className={workbenchTab === "layer" ? styles.workbenchTabActive : styles.workbenchTab}
                              onClick={() => {
                                setWorkbenchTab("layer");
                                logEditorEvent("editor.workbench_tab_selected", { tab: "layer" });
                              }}
                              type="button"
                            >
                              <Type size={15} />
                              텍스트 편집
                            </button>
                            <button
                              className={workbenchTab === "copy" ? styles.workbenchTabActive : styles.workbenchTab}
                              onClick={() => {
                                setWorkbenchTab("copy");
                                logEditorEvent("editor.workbench_tab_selected", { tab: "copy" });
                              }}
                              type="button"
                            >
                              <Sparkles size={15} />
                              카피
                            </button>
                          </>
                        ) : null}
                        <button
                          className={workbenchTab === "guide" ? styles.workbenchTabActive : styles.workbenchTab}
                          onClick={() => {
                            setWorkbenchTab("guide");
                            logEditorEvent("editor.workbench_tab_selected", { tab: "guide" });
                          }}
                          type="button"
                        >
                          <Palette size={15} />
                          가이드
                        </button>
                      </div>

                      <div className={styles.workbenchBody}>{renderWorkbenchBody()}</div>
                    </div>
                  </aside>
                ) : null}
              </div>

              <div className={styles.canvasFooter}>
                <span className={styles.footerStatus}>페이지 편집 · {outputModeLabel}</span>
                <span className={styles.footerStatus}>{currentSection.generatedImage ? "이미지 준비 완료" : "이미지 생성 필요"}</span>
                <span className={styles.footerStatus}>{isCompleteMode ? `생성됨 ${generatedCount}/${sections.length}` : `레이어 ${currentLayers.length}개`}</span>
                {workbenchState.isOpen ? (
                  <span className={styles.footerStatus}>옵션 패널 열림</span>
                ) : (
                  <button className={styles.footerReopenButton} onClick={() => openWorkbench(workbenchTab)} type="button">
                    <Settings2 size={14} />
                    {activeWorkbenchLabel} 열기
                  </button>
                )}
              </div>
            </article>
          </section>
        </div>
      </section>
      {pendingDeleteSection ? (
        <div aria-modal="true" className={styles.editorConfirmOverlay} onClick={cancelDeleteSection} role="dialog">
          <div className={styles.editorConfirmDialog} onClick={stopShellClick}>
            <div className={styles.editorConfirmIcon}>
              <AlertCircle size={20} />
            </div>
            <div>
              <p className={styles.panelLabel}>섹션 삭제</p>
              <h2 className={styles.editorConfirmTitle}>이 섹션을 삭제하시겠습니까?</h2>
              <p className={styles.editorConfirmCopy}>
                {getDisplaySectionName(pendingDeleteSection)} 섹션과 이 섹션의 이미지 옵션, 편집 레이어가 함께 삭제됩니다.
              </p>
            </div>
            <div className={styles.editorConfirmActions}>
              <button className={styles.secondaryButton} onClick={cancelDeleteSection} type="button">
                취소
              </button>
              <button className={styles.inlineDangerButton} onClick={confirmDeleteSection} type="button">
                <Trash2 size={14} />
                삭제
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isEditorGeneratingImage ? (
        <div aria-modal="true" className={styles.editorWaitingOverlay} role="dialog">
          <div className={styles.editorWaitingDialog}>
            <div className={styles.editorWaitingHeader}>
              <div className={styles.processingIcon}>
                <Loader2 className={styles.spinIcon} size={32} />
              </div>
              <div>
                <p className={styles.panelLabel}>이미지 생성 대기</p>
                <h2>AI가 섹션 이미지를 만드는 중입니다</h2>
                <p>
                  {isGeneratingAllImages
                    ? `${missingImageCount}개 남은 섹션 이미지를 생성하고 있습니다. 완료되면 자동으로 편집 화면으로 돌아옵니다.`
                    : isCurrentImageRegeneration
                      ? `${getDisplaySectionName(currentSection)} 이미지를 새 옵션으로 다시 만들고 있습니다. 완료되면 자동으로 팝업이 닫힙니다.`
                      : `${getDisplaySectionName(currentSection)} 이미지를 생성하고 있습니다. 완료되면 자동으로 팝업이 닫힙니다.`}
                </p>
              </div>
            </div>

            <div className={styles.editorWaitingProgress}>
              <div className={styles.editorWaitingProgressTop}>
                <span>예상 진행률</span>
                <strong>{Math.max(0, waitingProgress)}%</strong>
              </div>
              <div
                aria-label="이미지 생성 예상 진행률"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.max(0, waitingProgress)}
                className={styles.editorWaitingProgressTrack}
                role="progressbar"
              >
                <span
                  className={styles.editorWaitingProgressFill}
                  style={{ width: `${Math.max(4, waitingProgress)}%` }}
                />
              </div>
              <div className={styles.editorWaitingProgressMeta}>
                <span>
                  {isGeneratingAllImages
                    ? `생성됨 ${generatedCount}/${sections.length}`
                    : isCurrentImageRegeneration
                      ? "새 옵션 적용 중"
                      : "현재 섹션 생성 중"}
                </span>
                <span>{waitingActivity === "game" ? "미니게임 진행 중" : "추천 영상 재생"}</span>
              </div>
            </div>

            <div className={styles.waitingVideoCard}>
              <div className={styles.waitingVideoCopy}>
                <span className={styles.panelLabel}>{waitingActivity === "game" ? "가볍게 한 판" : "기다리는 동안"}</span>
                <h3>{waitingActivity === "game" ? "미니게임하며 기다리세요" : "영상보며 기다리세요"}</h3>
                <p>
                  {waitingActivity === "game"
                    ? "빛나는 패치를 눌러 점수를 올려보세요. 생성이 끝나면 자동으로 편집 화면으로 돌아옵니다."
                    : "이미지 생성은 시간이 조금 걸립니다. 생성이 끝나면 이 화면은 자동으로 사라집니다."}
                </p>
              </div>

              {waitingActivity === "game" ? (
                <WaitingMiniGame progress={waitingProgress} />
              ) : waitingVideo ? (
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
          </div>
        </div>
      ) : null}
      <PdpBugReportWidget
        context={{
          surface: "editor",
          outputMode,
          aiProvider,
          apiConnectionLabel,
          sectionName: getDisplaySectionName(currentSection),
          sectionIndex: currentSectionIndex + 1,
          sectionCount: sections.length,
          generatedCount,
          missingImageCount,
          workbenchTab,
          isWorkbenchOpen: workbenchState.isOpen,
          saveState,
          errorMessage: errorMessage || undefined
        }}
      />
    </main>
  );
}

function getAllowedWorkbenchTab(tab: WorkbenchTab, isCompleteMode: boolean): WorkbenchTab {
  if (isCompleteMode && (tab === "layer" || tab === "copy")) {
    return "image";
  }

  return tab;
}

function getWorkbenchTabLabel(tab: WorkbenchTab, isCompleteMode: boolean) {
  if (tab === "image") {
    return isCompleteMode ? "이미지 수정" : "이미지 옵션";
  }

  if (tab === "layer") {
    return "텍스트 편집";
  }

  if (tab === "copy") {
    return "카피 라이브러리";
  }

  return "섹션 가이드";
}

function buildOverlayShellStyle(overlay: TextOverlay, scale = 1): CSSProperties {
  const padding = getOverlayPadding(overlay.fontSize);
  const normalizedScale = scale > 0 ? scale : 1;

  return {
    position: "relative",
    width: "100%",
    height: "100%",
    padding: `${padding.vertical * normalizedScale}px ${padding.horizontal * normalizedScale}px`
  };
}

function buildOverlayBackgroundStyle(overlay: TextOverlay, scale = 1): CSSProperties {
  const normalizedScale = scale > 0 ? scale : 1;

  return {
    backgroundColor: toRgba(overlay.backgroundColor, overlay.backgroundOpacity),
    borderRadius: `${overlay.backgroundRadius * normalizedScale}px`
  };
}

function buildShapeLayerStyle(layer: ShapeLayer, scale = 1): CSSProperties {
  const normalizedScale = scale > 0 ? scale : 1;

  return {
    width: "100%",
    height: "100%",
    backgroundColor: toRgba(layer.fillColor, layer.fillOpacity),
    borderRadius: `${layer.borderRadius * normalizedScale}px`
  };
}

function shiftIndexedRecordForInsert<T>(record: Record<number, T>, insertIndex: number, insertedValue?: T): Record<number, T> {
  const nextRecord: Record<number, T> = {};

  for (const [key, value] of Object.entries(record)) {
    const index = Number(key);
    if (!Number.isFinite(index)) {
      continue;
    }

    nextRecord[index >= insertIndex ? index + 1 : index] = value;
  }

  if (typeof insertedValue !== "undefined") {
    nextRecord[insertIndex] = insertedValue;
  }

  return nextRecord;
}

function shiftIndexedRecordForDelete<T>(record: Record<number, T>, deleteIndex: number): Record<number, T> {
  const nextRecord: Record<number, T> = {};

  for (const [key, value] of Object.entries(record)) {
    const index = Number(key);
    if (!Number.isFinite(index) || index === deleteIndex) {
      continue;
    }

    nextRecord[index > deleteIndex ? index - 1 : index] = value;
  }

  return nextRecord;
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function moveIndexedRecordItem<T>(record: Record<number, T>, fromIndex: number, toIndex: number, itemCount: number): Record<number, T> {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= itemCount || toIndex >= itemCount) {
    return record;
  }

  const orderedValues = Array.from({ length: itemCount }, (_, index) => record[index]);
  const [movedValue] = orderedValues.splice(fromIndex, 1);
  orderedValues.splice(toIndex, 0, movedValue);

  return orderedValues.reduce<Record<number, T>>((nextRecord, value, index) => {
    if (typeof value !== "undefined") {
      nextRecord[index] = value;
    }

    return nextRecord;
  }, {});
}

function getIndexAfterMove(currentIndex: number, fromIndex: number, toIndex: number) {
  if (currentIndex === fromIndex) {
    return toIndex;
  }

  if (fromIndex < toIndex && currentIndex > fromIndex && currentIndex <= toIndex) {
    return currentIndex - 1;
  }

  if (fromIndex > toIndex && currentIndex >= toIndex && currentIndex < fromIndex) {
    return currentIndex + 1;
  }

  return currentIndex;
}

function cloneCanvasLayer(layer: CanvasLayer): CanvasLayer {
  return normalizeCanvasLayer({
    ...layer,
    id: crypto.randomUUID(),
    x: layer.x + 12,
    y: layer.y + 12
  });
}

async function buildExportNode(input: {
  imageSrc: string;
  width: number;
  layers: CanvasLayer[];
  layerScale?: number;
}) {
  const image = await loadImage(input.imageSrc);
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round((image.naturalHeight / Math.max(image.naturalWidth, 1)) * width));
  const layerScale = input.layerScale && input.layerScale > 0 ? input.layerScale : 1;

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-100000px";
  container.style.top = "0";
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  container.style.background = "transparent";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  container.style.zIndex = "-1";

  const imageEl = document.createElement("img");
  imageEl.src = input.imageSrc;
  imageEl.alt = "";
  imageEl.draggable = false;
  imageEl.style.display = "block";
  imageEl.style.width = "100%";
  imageEl.style.height = "100%";
  imageEl.style.objectFit = "cover";
  container.appendChild(imageEl);

  const shapeLayers = input.layers.filter(isShapeLayer);
  const textLayers = input.layers.filter(isTextLayer);

  for (const layer of [...shapeLayers, ...textLayers]) {
    const layerEl = document.createElement("div");
    layerEl.style.position = "absolute";
    layerEl.style.left = `${layer.x * layerScale}px`;
    layerEl.style.top = `${layer.y * layerScale}px`;
    layerEl.style.width = `${toNumericSize(layer.width, width) * layerScale}px`;
    layerEl.style.height = `${toNumericSize(layer.height, height) * layerScale}px`;

    if (isShapeLayer(layer)) {
      const shapeSurface = document.createElement("div");
      shapeSurface.style.width = "100%";
      shapeSurface.style.height = "100%";
      shapeSurface.style.backgroundColor = toRgba(layer.fillColor, layer.fillOpacity);
      shapeSurface.style.borderRadius = `${layer.borderRadius * layerScale}px`;
      shapeSurface.style.border = "1px solid rgba(255, 255, 255, 0.18)";
      shapeSurface.style.boxShadow = "inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 12px 28px rgba(8, 16, 28, 0.18)";
      layerEl.appendChild(shapeSurface);
    } else {
      const shell = document.createElement("div");
      const shellStyle = buildOverlayShellStyle(layer, layerScale);
      applyInlineStyle(shell, shellStyle);
      shell.style.overflow = "visible";

      if (layer.backgroundEnabled) {
        const backdrop = document.createElement("div");
        backdrop.style.position = "absolute";
        backdrop.style.inset = "0";
        const backdropStyle = buildOverlayBackgroundStyle(layer, layerScale);
        applyInlineStyle(backdrop, backdropStyle);
        shell.appendChild(backdrop);
      }

      const textEl = document.createElement("div");
      textEl.textContent = layer.text;
      const textStyle = buildOverlayTextStyle(layer, layerScale);
      applyInlineStyle(textEl, textStyle);
      textEl.style.position = "relative";
      textEl.style.zIndex = "1";
      shell.appendChild(textEl);
      layerEl.appendChild(shell);
    }

    container.appendChild(layerEl);
  }

  return container;
}

function applyInlineStyle(target: HTMLElement, style: CSSProperties) {
  Object.entries(style).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    const cssKey = key.replace(/[A-Z]/g, (segment) => `-${segment.toLowerCase()}`);
    target.style.setProperty(cssKey, String(value));
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sanitizeSectionFileName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function buildOverlayTextStyle(overlay: TextOverlay, scale = 1): CSSProperties {
  const normalizedScale = scale > 0 ? scale : 1;

  return {
    display: "block",
    width: "100%",
    height: "100%",
    color: overlay.color,
    fontFamily: overlay.fontFamily,
    fontSize: `${overlay.fontSize * normalizedScale}px`,
    fontWeight: overlay.fontWeight,
    lineHeight: overlay.lineHeight,
    textAlign: overlay.textAlign,
    whiteSpace: "pre-wrap",
    wordBreak: "keep-all",
    textShadow: overlay.shadowEnabled
      ? `0px ${overlay.shadowOffsetY * normalizedScale}px ${overlay.shadowBlur * normalizedScale}px ${toRgba(overlay.shadowColor, overlay.shadowOpacity)}`
      : "none"
  };
}

function normalizeOverlayRecord(record: Record<number, CanvasLayer[]>) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, overlays]) => [
      Number(key),
      (Array.isArray(overlays) ? overlays : []).map((overlay) => normalizeCanvasLayer(overlay))
    ])
  ) as Record<number, CanvasLayer[]>;
}

function normalizeCanvasLayer(layer: Partial<CanvasLayer> & Pick<CanvasLayer, "id" | "x" | "y" | "width" | "height">) {
  if (layer.kind === "shape") {
    return normalizeShapeLayer(layer as Partial<ShapeLayer> & Pick<ShapeLayer, "id" | "x" | "y" | "width" | "height">);
  }

  return normalizeTextOverlay(
    layer as Partial<TextOverlay> &
      Pick<TextOverlay, "id" | "text" | "x" | "y" | "width" | "height" | "fontSize" | "color" | "fontFamily" | "fontWeight" | "textAlign" | "lineHeight" | "backgroundColor">
  );
}

function normalizeTextOverlay(overlay: Partial<TextOverlay> & Pick<TextOverlay, "id" | "text" | "x" | "y" | "width" | "height" | "fontSize" | "color" | "fontFamily" | "fontWeight" | "textAlign" | "lineHeight" | "backgroundColor">): TextOverlay {
  const hasLegacyBackground = Boolean(overlay.backgroundColor && overlay.backgroundColor !== "transparent");
  const translations = normalizeOverlayTranslations(overlay.translations, overlay.text);
  const language = overlay.language === "en" ? "en" : "ko";

  return {
    ...overlay,
    kind: "text",
    language,
    text: translations[language] || translations.ko,
    translations,
    color: overlay.color ?? "#ffffff",
    backgroundColor: overlay.backgroundColor === "transparent" ? "#102532" : overlay.backgroundColor,
    backgroundEnabled: overlay.backgroundEnabled ?? hasLegacyBackground,
    backgroundOpacity: overlay.backgroundOpacity ?? 0.72,
    backgroundRadius: overlay.backgroundRadius ?? 18,
    shadowEnabled: overlay.shadowEnabled ?? false,
    shadowColor: overlay.shadowColor ?? "#102532",
    shadowOpacity: overlay.shadowOpacity ?? 0.4,
    shadowBlur: overlay.shadowBlur ?? 18,
    shadowOffsetY: overlay.shadowOffsetY ?? 6
  };
}

function applyLanguageToTextOverlay(overlay: TextOverlay, nextLanguage: PdpCopyLanguage): TextOverlay {
  const translations = normalizeOverlayTranslations(
    {
      ...overlay.translations,
      [overlay.language]: overlay.text
    },
    overlay.text
  );
  const nextText = translations[nextLanguage] || translations.ko;

  return normalizeTextOverlay({
    ...overlay,
    language: nextLanguage,
    text: nextText,
    translations: {
      ...translations,
      [nextLanguage]: nextText
    }
  });
}

function normalizeShapeLayer(layer: Partial<ShapeLayer> & Pick<ShapeLayer, "id" | "x" | "y" | "width" | "height">): ShapeLayer {
  return {
    ...layer,
    kind: "shape",
    fillColor: layer.fillColor ?? "#102532",
    fillOpacity: layer.fillOpacity ?? 1,
    borderRadius: layer.borderRadius ?? 0
  };
}

function getOverlayPadding(fontSize: number) {
  return {
    horizontal: clampValue(Math.round(fontSize * 0.32), 10, 24),
    vertical: clampValue(Math.round(fontSize * 0.18), 8, 18)
  };
}

function normalizeOverlayTranslations(
  translations: Partial<Record<PdpCopyLanguage, string>> | undefined,
  fallbackText: string
) {
  const ko = translations?.ko?.trim() ? translations.ko : fallbackText;
  const en = translations?.en?.trim() ? translations.en : ko;

  return {
    ko,
    en
  } satisfies Record<PdpCopyLanguage, string>;
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toNumericSize(value: number | string, fallback: number) {
  if (typeof value === "number") {
    return value;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function estimateOverlayBox(
  text: string,
  options: {
    fontSize: number;
    fontWeight: string;
    fontFamily: string;
    lineHeight: number;
    maxWidth: number;
  }
) {
  const horizontalPadding = 20;
  const verticalPadding = 12;
  const availableLineWidth = Math.max(120, options.maxWidth - horizontalPadding);
  const lines = text.split("\n").map((line) => line.trimEnd());
  const measure = createTextMeasure(options);

  let wrappedLineCount = 0;
  let widestLine = 0;

  lines.forEach((line) => {
    const targetLine = line || " ";
    const measuredWidth = measure(targetLine);
    widestLine = Math.max(widestLine, Math.min(measuredWidth, availableLineWidth));
    wrappedLineCount += Math.max(1, Math.ceil(measuredWidth / availableLineWidth));
  });

  const lineHeightPx = options.fontSize * options.lineHeight;

  return {
    width: Math.round(
      clampValue(
        Math.max(widestLine + horizontalPadding, Math.min(options.maxWidth, Math.max(220, options.fontSize * 8))),
        96,
        options.maxWidth
      )
    ),
    height: Math.round(clampValue(wrappedLineCount * lineHeightPx + verticalPadding, 40, 220))
  };
}

function createTextMeasure(options: { fontSize: number; fontWeight: string; fontFamily: string }) {
  if (typeof document === "undefined") {
    return (text: string) => Math.max(options.fontSize * 1.6, text.length * options.fontSize * 0.58);
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return (text: string) => Math.max(options.fontSize * 1.6, text.length * options.fontSize * 0.58);
  }

  context.font = `${options.fontWeight} ${options.fontSize}px ${options.fontFamily}`;
  return (text: string) => context.measureText(text).width;
}

async function extractImageColorRecommendations(imageSrc: string): Promise<ImageColorRecommendations> {
  if (typeof document === "undefined") {
    return DEFAULT_COLOR_RECOMMENDATIONS;
  }

  try {
    const image = await loadImage(imageSrc);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      return DEFAULT_COLOR_RECOMMENDATIONS;
    }

    const width = 48;
    const height = Math.max(48, Math.round((image.naturalHeight / Math.max(image.naturalWidth, 1)) * 48));
    canvas.width = width;
    canvas.height = height;
    context.drawImage(image, 0, 0, width, height);

    const { data } = context.getImageData(0, 0, width, height);
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();

    for (let index = 0; index < data.length; index += 16) {
      const alpha = data[index + 3];
      if (alpha < 24) {
        continue;
      }

      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const key = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;
      const current = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      current.count += 1;
      current.r += r;
      current.g += g;
      current.b += b;
      buckets.set(key, current);
    }

    const swatches = Array.from(buckets.values())
      .map((bucket) => ({
        count: bucket.count,
        color: {
          r: Math.round(bucket.r / bucket.count),
          g: Math.round(bucket.g / bucket.count),
          b: Math.round(bucket.b / bucket.count)
        }
      }))
      .sort((left, right) => right.count - left.count);

    if (!swatches.length) {
      return DEFAULT_COLOR_RECOMMENDATIONS;
    }

    const dominant = swatches[0]?.color ?? hexToRgb(DEFAULT_COLOR_RECOMMENDATIONS.darkColor);
    const accent =
      swatches
        .slice(0, 8)
        .sort((left, right) => getSaturation(right.color) - getSaturation(left.color))[0]?.color ?? dominant;
    const dark = swatches.find((swatch) => getRelativeLuminance(swatch.color) < 0.34)?.color ?? darkenRgb(dominant, 0.58);
    const light = swatches.find((swatch) => getRelativeLuminance(swatch.color) > 0.72)?.color ?? lightenRgb(dominant, 0.68);

    const accentHex = rgbToHex(boostColorPresence(accent));
    const darkHex = rgbToHex(darkenRgb(dark, 0.08));
    const lightHex = rgbToHex(lightenRgb(light, 0.04));
    const complementHex = rgbToHex(rotateHue(accent, 180));
    const mutedAccentHex = rgbToHex(mixRgb(accent, dark, 0.36));
    const warmTintHex = rgbToHex(lightenRgb(mixRgb(accent, light, 0.5), 0.12));
    const deepContrastHex = rgbToHex(darkenRgb(mixRgb(dominant, accent, 0.22), 0.22));

    return {
      photoColors: uniqueColors(swatches.slice(0, 6).map((swatch) => rgbToHex(swatch.color))),
      recommendedTextColors: uniqueColors([
        "#ffffff",
        getRelativeLuminance(dominant) < 0.48 ? "#f9f7f1" : "#102532",
        lightHex,
        darkHex,
        accentHex
      ]),
      recommendedShapeColors: uniqueColors([
        darkHex,
        mutedAccentHex,
        rgbToHex(mixRgb(light, dark, 0.2)),
        warmTintHex,
        deepContrastHex,
        complementHex
      ]),
      accentColor: accentHex,
      darkColor: darkHex,
      lightColor: lightHex
    };
  } catch {
    return DEFAULT_COLOR_RECOMMENDATIONS;
  }
}

function sortColorsByContrast(colors: string[], against: string | null) {
  if (!against) {
    return uniqueColors(colors);
  }

  const target = hexToRgb(against);
  return uniqueColors(colors).sort(
    (left, right) => contrastScore(hexToRgb(right), target) - contrastScore(hexToRgb(left), target)
  );
}

function uniqueColors(colors: string[]) {
  return Array.from(new Set(colors.map((color) => color.toLowerCase())));
}

function contrastScore(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }) {
  return Math.abs(getRelativeLuminance(left) - getRelativeLuminance(right));
}

function getRelativeLuminance(color: { r: number; g: number; b: number }) {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getSaturation(color: { r: number; g: number; b: number }) {
  const [r, g, b] = [color.r / 255, color.g / 255, color.b / 255];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function lightenRgb(color: { r: number; g: number; b: number }, amount: number) {
  return {
    r: Math.round(color.r + (255 - color.r) * amount),
    g: Math.round(color.g + (255 - color.g) * amount),
    b: Math.round(color.b + (255 - color.b) * amount)
  };
}

function darkenRgb(color: { r: number; g: number; b: number }, amount: number) {
  return {
    r: Math.round(color.r * (1 - amount)),
    g: Math.round(color.g * (1 - amount)),
    b: Math.round(color.b * (1 - amount))
  };
}

function mixRgb(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }, ratio: number) {
  return {
    r: Math.round(left.r * (1 - ratio) + right.r * ratio),
    g: Math.round(left.g * (1 - ratio) + right.g * ratio),
    b: Math.round(left.b * (1 - ratio) + right.b * ratio)
  };
}

function boostColorPresence(color: { r: number; g: number; b: number }) {
  const saturation = getSaturation(color);
  if (saturation > 0.3) {
    return color;
  }

  const max = Math.max(color.r, color.g, color.b);
  const next = { ...color };
  if (max === color.r) {
    next.r = clampValue(next.r + 28, 0, 255);
  } else if (max === color.g) {
    next.g = clampValue(next.g + 28, 0, 255);
  } else {
    next.b = clampValue(next.b + 28, 0, 255);
  }
  return next;
}

function rotateHue(color: { r: number; g: number; b: number }, degrees: number) {
  const { h, s, l } = rgbToHsl(color);
  return hslToRgb({
    h: (h + degrees + 360) % 360,
    s,
    l
  });
}

function rgbToHsl(color: { r: number; g: number; b: number }) {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  return {
    h: h < 0 ? h + 360 : h,
    s,
    l
  };
}

function hslToRgb(color: { h: number; s: number; l: number }) {
  const c = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const x = c * (1 - Math.abs(((color.h / 60) % 2) - 1));
  const m = color.l - c / 2;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (color.h < 60) {
    rPrime = c;
    gPrime = x;
  } else if (color.h < 120) {
    rPrime = x;
    gPrime = c;
  } else if (color.h < 180) {
    gPrime = c;
    bPrime = x;
  } else if (color.h < 240) {
    gPrime = x;
    bPrime = c;
  } else if (color.h < 300) {
    rPrime = x;
    bPrime = c;
  } else {
    rPrime = c;
    bPrime = x;
  }

  return {
    r: Math.round((rPrime + m) * 255),
    g: Math.round((gPrime + m) * 255),
    b: Math.round((bPrime + m) * 255)
  };
}

function hexToRgb(value: string) {
  const normalized = value.replace("#", "");
  const hex = normalized.length === 3 ? normalized.split("").map((segment) => `${segment}${segment}`).join("") : normalized;
  const numeric = Number.parseInt(hex, 16);

  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255
  };
}

function rgbToHex(color: { r: number; g: number; b: number }) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => clampValue(channel, 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function toRgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clampValue(alpha, 0, 1)})`;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지 색상을 분석하지 못했습니다."));
    image.src = src;
  });
}

function formatSavedAt(value: string) {
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

function anchorWorkbenchToOverlay(
  overlay: CanvasLayer,
  canvasEl: HTMLDivElement | null,
  stageEl: HTMLDivElement | null,
  workbench: FloatingWorkbenchState
) {
  const workbenchWidth = workbench.width;
  const workbenchHeight = workbench.height;
  const gap = 18;
  const stageWidth = stageEl?.clientWidth ?? 1240;
  const stageHeight = stageEl?.clientHeight ?? 720;
  const canvasLeft = canvasEl?.offsetLeft ?? 0;
  const canvasTop = canvasEl?.offsetTop ?? 0;
  const overlayWidth = toNumericSize(overlay.width, 320);

  let x = canvasLeft + overlay.x + overlayWidth + gap;
  if (x + workbenchWidth > stageWidth - 16) {
    x = canvasLeft + overlay.x - workbenchWidth - gap;
  }
  if (x < 12) {
    x = clampValue(canvasLeft + overlay.x + 12, 12, Math.max(12, stageWidth - workbenchWidth - 16));
  }

  const y = clampValue(canvasTop + overlay.y, 12, Math.max(12, stageHeight - workbenchHeight - 16));

  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

function isTextLayer(layer: CanvasLayer): layer is TextOverlay {
  return layer.kind === "text";
}

function isShapeLayer(layer: CanvasLayer): layer is ShapeLayer {
  return layer.kind === "shape";
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function getWorkbenchPosition(stageEl: HTMLDivElement | null) {
  const width = 332;
  const height = 500;
  const stageWidth = stageEl?.clientWidth ?? 1240;
  const stageHeight = stageEl?.clientHeight ?? 720;

  return {
    x: Math.max(16, stageWidth - width - 20),
    y: 20,
    width,
    height: Math.min(height, Math.max(420, stageHeight - 40)),
    isOpen: true
  };
}

function clampWorkbenchToStage(workbench: FloatingWorkbenchState, stageEl: HTMLDivElement | null) {
  if (!stageEl) {
    return workbench;
  }

  const maxX = Math.max(16, stageEl.clientWidth - workbench.width - 16);
  const maxY = Math.max(16, stageEl.clientHeight - workbench.height - 16);

  return {
    ...workbench,
    x: clampValue(workbench.x, 16, maxX),
    y: clampValue(workbench.y, 16, maxY)
  };
}

function normalizeImageOptions(
  options: ImageGenOptions | undefined,
  defaults: Pick<ImageGenOptions, "style" | "withModel" | "guidePriorityMode">
): ImageGenOptions & { guidePriorityMode: NonNullable<ImageGenOptions["guidePriorityMode"]> } {
  return {
    style: options?.style ?? defaults.style ?? "studio",
    withModel: options?.withModel ?? defaults.withModel ?? false,
    aiProvider: options?.aiProvider,
    imageModel: options?.imageModel,
    modelGender: options?.modelGender ?? "female",
    modelAgeRange: options?.modelAgeRange ?? "20s",
    modelCountry: options?.modelCountry ?? "korea",
    guidePriorityMode: options?.guidePriorityMode ?? defaults.guidePriorityMode ?? "guide-first",
    headline: options?.headline,
    subheadline: options?.subheadline,
    isRegeneration: options?.isRegeneration,
    referenceModelImageBase64: options?.referenceModelImageBase64,
    referenceModelImageMimeType: options?.referenceModelImageMimeType,
    referenceModelImageFileName: options?.referenceModelImageFileName
  };
}

function normalizeSectionOptions(
  record: Record<number, ImageGenOptions>,
  referenceModelUsage: ReferenceModelUsage | null
) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {} as Record<number, ImageGenOptions>;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, options]) => [
      Number(key),
      normalizeImageOptions(
        options,
        getPdpSectionImageDefaults(null, Number(key), Object.keys(record).length || 1, referenceModelUsage)
      )
    ])
  ) as Record<number, ImageGenOptions>;
}

function buildDefaultTextLayout(
  section: PdpSection,
  sectionIndex: number,
  totalSections: number,
  aspectRatio: AspectRatio,
  language: PdpCopyLanguage
): CanvasLayer[] {
  const template = inferTextLayoutTemplate(section, sectionIndex, totalSections);
  const canvasHeight = getCanvasBaseHeight(aspectRatio);
  const compact = canvasHeight < 430;
  const text = (input: TextLayerInput) => createTemplateTextLayer(input, language);
  const shape = (input: ShapeLayerInput) => createTemplateShapeLayer(input);
  const panelHeight = Math.min(compact ? 174 : 232, Math.max(150, canvasHeight - 58));
  const panelY = bottomY(canvasHeight, panelHeight, compact ? 20 : 36);
  const headline = {
    ko: compactText(section.headline, getDisplaySectionName(section), compact ? 52 : 72),
    en: compactText(section.headline_en, section.headline, compact ? 58 : 78)
  };
  const subheadline = {
    ko: compactText(section.subheadline, getDisplaySectionGoal(section), compact ? 70 : 112),
    en: compactText(section.subheadline_en, section.subheadline, compact ? 78 : 122)
  };
  const bulletCopy = {
    ko: formatTemplateBullets(section.bullets, subheadline.ko, compact ? 2 : 3),
    en: formatTemplateBullets(section.bullets_en, subheadline.en, compact ? 2 : 3)
  };
  const stepCopy = {
    ko: formatTemplateSteps(section.bullets, subheadline.ko),
    en: formatTemplateSteps(section.bullets_en, subheadline.en)
  };
  const listCopy = {
    ko: normalizeTemplateList(section.bullets, subheadline.ko, 3),
    en: normalizeTemplateList(section.bullets_en, subheadline.en, 3)
  };
  const trustLine = {
    ko: compactText(section.trust_or_objection_line, section.compliance_notes || subheadline.ko, compact ? 76 : 118),
    en: compactText(section.trust_or_objection_line_en, section.trust_or_objection_line || subheadline.en, compact ? 84 : 128)
  };
  if (template === "hero") {
    const heroHeight = Math.min(compact ? 188 : 246, Math.max(168, canvasHeight - 46));
    const heroY = bottomY(canvasHeight, heroHeight, compact ? 18 : 32);

    return [
      shape({
        x: 26,
        y: heroY,
        width: 408,
        height: heroHeight,
        fillColor: TEXT_LAYOUT_COLORS.dark,
        fillOpacity: 0.76,
        borderRadius: compact ? 20 : 28
      }),
      text({
        ko: getDisplaySectionName(section),
        en: getDisplaySectionName(section),
        x: 50,
        y: heroY + 24,
        width: 310,
        height: compact ? 24 : 28,
        fontSize: compact ? 11 : 12,
        color: TEXT_LAYOUT_COLORS.accent,
        fontWeight: "900",
        lineHeight: 1.15
      }),
      text({
        ...headline,
        x: 48,
        y: heroY + (compact ? 52 : 62),
        width: 354,
        height: compact ? 74 : 108,
        fontSize: compact ? 29 : 42,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        lineHeight: 1.04
      }),
      text({
        ...subheadline,
        x: 50,
        y: heroY + (compact ? 126 : 174),
        width: 340,
        height: compact ? 44 : 54,
        fontSize: compact ? 14 : 18,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        lineHeight: 1.36
      })
    ];
  }

  if (template === "concernList") {
    const bubbleLimit = compact ? 3 : 5;
    const concernItemsKo = uniqueCopyLines([
      ...(section.bullets ?? []),
      section.trust_or_objection_line,
      subheadline.ko
    ].filter((item): item is string => Boolean(item)))
      .map((item) => compactText(item, "구매 전 고민이 남아요", compact ? 26 : 34))
      .slice(0, bubbleLimit);
    const concernItemsEn = uniqueCopyLines([
      ...(section.bullets_en ?? []),
      section.trust_or_objection_line_en,
      subheadline.en
    ].filter((item): item is string => Boolean(item)))
      .map((item) => compactText(item, "I still have questions before buying", compact ? 30 : 40))
      .slice(0, bubbleLimit);
    const chatItems = concernItemsKo.length
      ? concernItemsKo
      : ["정말 효과가 있을지 모르겠어요", "나에게 맞을지 걱정돼요", "꾸준히 쓸 수 있을까요?"];
    const bubbleHeight = compact ? 40 : 58;
    const bubbleGap = compact ? 10 : 22;
    const totalBubbleHeight = chatItems.length * bubbleHeight + Math.max(0, chatItems.length - 1) * bubbleGap;
    const bubbleStartY = clampValue(
      Math.round(canvasHeight * (compact ? 0.42 : 0.37)),
      compact ? 150 : 270,
      Math.max(compact ? 150 : 270, canvasHeight - totalBubbleHeight - (compact ? 22 : 46))
    );

    return [
      shape({
        x: 0,
        y: 0,
        width: 460,
        height: canvasHeight,
        fillColor: "#080a10",
        fillOpacity: 0.98,
        borderRadius: 0
      }),
      text({
        ko: "고객의 고민을 먼저 듣습니다",
        en: "Listen before selling",
        x: 70,
        y: compact ? 48 : 88,
        width: 320,
        height: compact ? 20 : 24,
        fontSize: compact ? 11 : 14,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        textAlign: "center",
        lineHeight: 1.16,
        shadowEnabled: false
      }),
      text({
        ...headline,
        ko: compactText(headline.ko, "왜 망설이세요?", compact ? 30 : 42),
        en: compactText(headline.en, "Why are they hesitating?", compact ? 34 : 46),
        x: 36,
        y: compact ? 74 : 126,
        width: 388,
        height: compact ? 54 : 72,
        fontSize: compact ? 31 : 46,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        textAlign: "center",
        lineHeight: 1.08
      }),
      text({
        ...subheadline,
        x: 72,
        y: compact ? 126 : 208,
        width: 316,
        height: compact ? 22 : 30,
        fontSize: compact ? 10 : 12,
        color: TEXT_LAYOUT_COLORS.gold,
        fontWeight: "900",
        textAlign: "center",
        lineHeight: 1.16,
        shadowEnabled: false
      }),
      ...chatItems.flatMap((item, index) => {
        const isRight = index % 2 === 1;
        const bubbleWidth = compact ? (isRight ? 318 : 330) : (isRight ? 334 : 360);
        const x = isRight ? 460 - bubbleWidth - (compact ? 20 : 30) : compact ? 20 : 34;
        const y = bubbleStartY + index * (bubbleHeight + bubbleGap);

        return [
          shape({
            x,
            y,
            width: bubbleWidth,
            height: bubbleHeight,
            fillColor: TEXT_LAYOUT_COLORS.white,
            fillOpacity: 0.98,
            borderRadius: 999
          }),
          text({
            ko: item,
            en: concernItemsEn[index] ?? item,
            x: x + (compact ? 18 : 24),
            y: y + (compact ? 10 : 15),
            width: bubbleWidth - (compact ? 36 : 48),
            height: bubbleHeight - (compact ? 14 : 20),
            fontSize: compact ? 12 : 17,
            color: TEXT_LAYOUT_COLORS.ink,
            fontWeight: "800",
            textAlign: "center",
            lineHeight: 1.24,
            shadowEnabled: false
          })
        ];
      })
    ];
  }

  if (template === "problem") {
    const problemHeight = Math.min(compact ? 184 : 294, Math.max(170, canvasHeight - 72));

    return [
      shape({
        x: 24,
        y: 36,
        width: 412,
        height: problemHeight,
        fillColor: TEXT_LAYOUT_COLORS.cream,
        fillOpacity: 0.94,
        borderRadius: 24
      }),
      shape({
        x: 24,
        y: 36,
        width: 9,
        height: problemHeight,
        fillColor: TEXT_LAYOUT_COLORS.coral,
        fillOpacity: 1,
        borderRadius: 8
      }),
      text({
        ko: "구매 전 고민",
        en: "Pain point",
        x: 50,
        y: 58,
        width: 220,
        height: 22,
        fontSize: 12,
        color: TEXT_LAYOUT_COLORS.coral,
        fontWeight: "900",
        lineHeight: 1.1
      }),
      text({
        ...headline,
        x: 48,
        y: compact ? 86 : 90,
        width: 352,
        height: compact ? 62 : 92,
        fontSize: compact ? 25 : 34,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.08
      }),
      text({
        ko: bulletCopy.ko || trustLine.ko,
        en: bulletCopy.en || trustLine.en,
        x: 52,
        y: compact ? 150 : 198,
        width: 340,
        height: compact ? 58 : 84,
        fontSize: compact ? 13 : 16,
        color: TEXT_LAYOUT_COLORS.navy,
        fontWeight: "600",
        lineHeight: 1.42
      })
    ];
  }

  if (template === "question") {
    const questionPanelHeight = Math.min(compact ? 188 : 270, Math.max(172, canvasHeight - 96));
    const questionPanelY = Math.round((canvasHeight - questionPanelHeight) / 2);
    const questionCopy = {
      ko: formatQuestionCopy(headline.ko),
      en: formatQuestionCopy(headline.en)
    };

    return [
      shape({
        x: 28,
        y: questionPanelY,
        width: 404,
        height: questionPanelHeight,
        fillColor: TEXT_LAYOUT_COLORS.surface,
        fillOpacity: 0.94,
        borderRadius: compact ? 24 : 32
      }),
      shape({
        x: 72,
        y: questionPanelY + 30,
        width: 54,
        height: 6,
        fillColor: TEXT_LAYOUT_COLORS.accent,
        fillOpacity: 1,
        borderRadius: 999
      }),
      text({
        ko: "공감 질문",
        en: "Question",
        x: 70,
        y: questionPanelY + (compact ? 48 : 58),
        width: 190,
        height: 24,
        fontSize: compact ? 11 : 12,
        color: TEXT_LAYOUT_COLORS.accent,
        fontWeight: "900",
        lineHeight: 1.12
      }),
      text({
        ...questionCopy,
        x: 66,
        y: questionPanelY + (compact ? 78 : 94),
        width: 328,
        height: compact ? 80 : 112,
        fontSize: compact ? 27 : 39,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        textAlign: "center",
        lineHeight: 1.08
      }),
      text({
        ...subheadline,
        x: 72,
        y: questionPanelY + (compact ? 160 : 216),
        width: 316,
        height: compact ? 38 : 42,
        fontSize: compact ? 12 : 15,
        color: TEXT_LAYOUT_COLORS.muted,
        fontWeight: "600",
        textAlign: "center",
        lineHeight: 1.38,
        shadowEnabled: false
      })
    ];
  }

  if (template === "bridge") {
    const bridgeY = bottomY(canvasHeight, compact ? 220 : 322, compact ? 18 : 32);
    const bridgeHeight = Math.min(compact ? 220 : 322, Math.max(190, canvasHeight - 48));

    return [
      shape({
        x: 0,
        y: Math.max(0, bridgeY - 34),
        width: 460,
        height: bridgeHeight + 58,
        fillColor: TEXT_LAYOUT_COLORS.dark,
        fillOpacity: 0.76,
        borderRadius: 0
      }),
      shape({
        x: 32,
        y: bridgeY,
        width: 396,
        height: bridgeHeight,
        fillColor: TEXT_LAYOUT_COLORS.ink,
        fillOpacity: 0.84,
        borderRadius: compact ? 22 : 28
      }),
      text({
        ko: "그래서, 직접 고쳤습니다",
        en: "Built to fix it",
        x: 54,
        y: bridgeY + 26,
        width: 230,
        height: 24,
        fontSize: compact ? 12 : 13,
        color: TEXT_LAYOUT_COLORS.gold,
        fontWeight: "900",
        lineHeight: 1.12
      }),
      text({
        ...headline,
        x: 52,
        y: bridgeY + (compact ? 64 : 78),
        width: 348,
        height: compact ? 76 : 116,
        fontSize: compact ? 28 : 40,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        lineHeight: 1.06
      }),
      text({
        ...subheadline,
        x: 54,
        y: bridgeY + (compact ? 144 : 210),
        width: 326,
        height: compact ? 48 : 66,
        fontSize: compact ? 13 : 17,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        lineHeight: 1.44
      })
    ];
  }

  if (template === "value") {
    const panelTop = compact ? 34 : 54;
    const valuePanelHeight = Math.min(compact ? 190 : 314, Math.max(178, canvasHeight - panelTop - 46));

    return [
      shape({
        x: 32,
        y: panelTop,
        width: 258,
        height: valuePanelHeight,
        fillColor: TEXT_LAYOUT_COLORS.ink,
        fillOpacity: 0.8,
        borderRadius: 24
      }),
      shape({
        x: 306,
        y: compact ? 52 : Math.min(canvasHeight - 210, 118),
        width: 112,
        height: 112,
        fillColor: TEXT_LAYOUT_COLORS.accent,
        fillOpacity: 0.88,
        borderRadius: 56
      }),
      text({
        ko: "핵심 포인트",
        en: "Key point",
        x: 54,
        y: panelTop + 24,
        width: 180,
        height: 22,
        fontSize: 12,
        color: TEXT_LAYOUT_COLORS.accent,
        fontWeight: "900",
        lineHeight: 1.1
      }),
      text({
        ...headline,
        x: 52,
        y: panelTop + (compact ? 52 : 62),
        width: 212,
        height: compact ? 62 : 102,
        fontSize: compact ? 25 : 34,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        lineHeight: 1.06
      }),
      text({
        ko: bulletCopy.ko || subheadline.ko,
        en: bulletCopy.en || subheadline.en,
        x: 54,
        y: panelTop + (compact ? 120 : 184),
        width: 210,
        height: compact ? 58 : 100,
        fontSize: compact ? 12 : 15,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        lineHeight: 1.46
      }),
      text({
        ko: "POINT",
        en: "POINT",
        x: 318,
        y: compact ? 86 : Math.min(canvasHeight - 172, 154),
        width: 88,
        height: 34,
        fontSize: compact ? 16 : 18,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        textAlign: "center",
        lineHeight: 1.1
      })
    ];
  }

  if (template === "plan") {
    const cardY = bottomY(canvasHeight, compact ? 104 : 150, compact ? 24 : 42);
    const cardHeight = compact ? 92 : 136;
    const cardWidth = 122;

    return [
      text({
        ...headline,
        x: 36,
        y: compact ? 30 : 54,
        width: 376,
        height: compact ? 62 : 92,
        fontSize: compact ? 26 : 36,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        lineHeight: 1.06
      }),
      text({
        ...subheadline,
        x: 38,
        y: compact ? 98 : 152,
        width: 340,
        height: compact ? 42 : 62,
        fontSize: compact ? 13 : 17,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        lineHeight: 1.42
      }),
      ...[0, 1, 2].flatMap((index) => {
        const x = 36 + index * 128;
        const step = splitTemplateSteps(stepCopy.ko, stepCopy.en)[index] ?? splitTemplateSteps(stepCopy.ko, stepCopy.en)[0];
        return [
          shape({
            x,
            y: cardY,
            width: cardWidth,
            height: cardHeight,
            fillColor: index === 1 ? TEXT_LAYOUT_COLORS.accent : TEXT_LAYOUT_COLORS.cream,
            fillOpacity: index === 1 ? 0.9 : 0.92,
            borderRadius: 18
          }),
          text({
            ko: step?.ko ?? `${String(index + 1).padStart(2, "0")} ${subheadline.ko}`,
            en: step?.en ?? `${String(index + 1).padStart(2, "0")} ${subheadline.en}`,
            x: x + 12,
            y: cardY + 14,
            width: cardWidth - 24,
            height: cardHeight - 26,
            fontSize: compact ? 11 : 13,
            color: TEXT_LAYOUT_COLORS.ink,
            fontWeight: "800",
            lineHeight: 1.28
          })
        ];
      })
    ];
  }

  if (template === "proof") {
    const proofHeight = Math.min(compact ? 180 : 250, Math.max(164, canvasHeight - 76));
    const proofY = clampValue(Math.round(canvasHeight * 0.28), 38, Math.max(38, canvasHeight - proofHeight - 32));

    return [
      shape({
        x: 32,
        y: proofY,
        width: 396,
        height: proofHeight,
        fillColor: TEXT_LAYOUT_COLORS.white,
        fillOpacity: 0.92,
        borderRadius: 24
      }),
      text({
        ko: "신뢰 근거",
        en: "Trust proof",
        x: 58,
        y: proofY + 24,
        width: 180,
        height: 22,
        fontSize: 12,
        color: TEXT_LAYOUT_COLORS.accent,
        fontWeight: "900",
        lineHeight: 1.1
      }),
      text({
        ...headline,
        x: 56,
        y: proofY + (compact ? 52 : 58),
        width: 340,
        height: compact ? 58 : 82,
        fontSize: compact ? 24 : 32,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.08
      }),
      text({
        ko: trustLine.ko || bulletCopy.ko,
        en: trustLine.en || bulletCopy.en,
        x: 58,
        y: proofY + (compact ? 114 : 154),
        width: 326,
        height: compact ? 48 : 66,
        fontSize: compact ? 13 : 16,
        color: TEXT_LAYOUT_COLORS.navy,
        fontWeight: "600",
        lineHeight: 1.42
      })
    ];
  }

  if (template === "compare") {
    const columnY = bottomY(canvasHeight, compact ? 102 : 158, compact ? 22 : 40);
    const columnHeight = compact ? 92 : 144;

    return [
      text({
        ...headline,
        x: 36,
        y: compact ? 34 : 58,
        width: 372,
        height: compact ? 62 : 92,
        fontSize: compact ? 25 : 35,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        lineHeight: 1.06
      }),
      text({
        ...subheadline,
        x: 38,
        y: compact ? 104 : 158,
        width: 338,
        height: compact ? 38 : 56,
        fontSize: compact ? 13 : 16,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        lineHeight: 1.4
      }),
      shape({
        x: 32,
        y: columnY,
        width: 188,
        height: columnHeight,
        fillColor: TEXT_LAYOUT_COLORS.cream,
        fillOpacity: 0.94,
        borderRadius: 20
      }),
      shape({
        x: 240,
        y: columnY,
        width: 188,
        height: columnHeight,
        fillColor: TEXT_LAYOUT_COLORS.accent,
        fillOpacity: 0.9,
        borderRadius: 20
      }),
      text({
        ko: firstTemplateBullet(section.bullets, "비슷한 상품과 헷갈리는 지점"),
        en: firstTemplateBullet(section.bullets_en, "Common alternative"),
        x: 50,
        y: columnY + 18,
        width: 150,
        height: columnHeight - 26,
        fontSize: compact ? 12 : 15,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "800",
        lineHeight: 1.32
      }),
      text({
        ko: firstTemplateBullet(section.bullets.slice(1), "이 제품을 선택할 이유"),
        en: firstTemplateBullet(section.bullets_en.slice(1), "Why this product"),
        x: 258,
        y: columnY + 18,
        width: 150,
        height: columnHeight - 26,
        fontSize: compact ? 12 : 15,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.32
      })
    ];
  }

  if (template === "detail") {
    const calloutY = bottomY(canvasHeight, compact ? 112 : 168, compact ? 22 : 36);
    const calloutHeight = compact ? 46 : 62;

    return [
      shape({
        x: 24,
        y: compact ? 28 : 46,
        width: 248,
        height: compact ? 168 : 250,
        fillColor: TEXT_LAYOUT_COLORS.white,
        fillOpacity: 0.9,
        borderRadius: compact ? 20 : 26
      }),
      text({
        ko: "디테일",
        en: "Detail",
        x: 48,
        y: compact ? 50 : 72,
        width: 160,
        height: 22,
        fontSize: compact ? 11 : 12,
        color: TEXT_LAYOUT_COLORS.blue,
        fontWeight: "900",
        lineHeight: 1.12
      }),
      text({
        ...headline,
        x: 46,
        y: compact ? 78 : 106,
        width: 206,
        height: compact ? 62 : 92,
        fontSize: compact ? 24 : 32,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.08
      }),
      text({
        ...subheadline,
        x: 48,
        y: compact ? 142 : 206,
        width: 204,
        height: compact ? 38 : 54,
        fontSize: compact ? 12 : 14,
        color: TEXT_LAYOUT_COLORS.muted,
        fontWeight: "600",
        lineHeight: 1.35,
        shadowEnabled: false
      }),
      ...listCopy.ko.slice(0, compact ? 2 : 3).flatMap((item, index) => {
        const y = calloutY + index * (calloutHeight + (compact ? 8 : 12));
        return [
          shape({
            x: 48,
            y,
            width: 364,
            height: calloutHeight,
            fillColor: index === 0 ? TEXT_LAYOUT_COLORS.softBlue : TEXT_LAYOUT_COLORS.surface,
            fillOpacity: 0.94,
            borderRadius: 16
          }),
          text({
            ko: item,
            en: listCopy.en[index] ?? item,
            x: 68,
            y: y + (compact ? 10 : 14),
            width: 324,
            height: calloutHeight - 16,
            fontSize: compact ? 12 : 15,
            color: TEXT_LAYOUT_COLORS.ink,
            fontWeight: index === 0 ? "900" : "700",
            lineHeight: 1.22,
            shadowEnabled: false
          })
        ];
      })
    ];
  }

  if (template === "lifestyle") {
    const lifestyleY = bottomY(canvasHeight, compact ? 190 : 278, compact ? 18 : 34);

    return [
      shape({
        x: 26,
        y: lifestyleY,
        width: 408,
        height: compact ? 190 : 278,
        fillColor: TEXT_LAYOUT_COLORS.cream,
        fillOpacity: 0.92,
        borderRadius: compact ? 24 : 30
      }),
      text({
        ko: "스타일",
        en: "Lifestyle",
        x: 52,
        y: lifestyleY + 24,
        width: 170,
        height: 22,
        fontSize: compact ? 11 : 12,
        color: TEXT_LAYOUT_COLORS.coral,
        fontWeight: "900",
        lineHeight: 1.12
      }),
      text({
        ...headline,
        x: 50,
        y: lifestyleY + (compact ? 54 : 64),
        width: 338,
        height: compact ? 72 : 104,
        fontSize: compact ? 28 : 38,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.08
      }),
      text({
        ...subheadline,
        x: 52,
        y: lifestyleY + (compact ? 132 : 184),
        width: 316,
        height: compact ? 46 : 58,
        fontSize: compact ? 13 : 16,
        color: TEXT_LAYOUT_COLORS.navy,
        fontWeight: "600",
        lineHeight: 1.42,
        shadowEnabled: false
      }),
      text({
        ko: trustLine.ko,
        en: trustLine.en,
        x: 52,
        y: lifestyleY + (compact ? 172 : 244),
        width: 310,
        height: compact ? 24 : 28,
        fontSize: compact ? 10 : 12,
        color: TEXT_LAYOUT_COLORS.muted,
        fontWeight: "600",
        lineHeight: 1.2,
        shadowEnabled: false
      })
    ];
  }

  if (template === "composition") {
    const cardTop = compact ? 118 : 188;
    const rowHeight = compact ? 48 : 62;

    return [
      shape({
        x: 28,
        y: 34,
        width: 404,
        height: Math.min(canvasHeight - 68, compact ? 256 : 420),
        fillColor: TEXT_LAYOUT_COLORS.white,
        fillOpacity: 0.93,
        borderRadius: compact ? 22 : 28
      }),
      text({
        ko: "제품 구성",
        en: "Configuration",
        x: 52,
        y: compact ? 56 : 68,
        width: 180,
        height: 22,
        fontSize: compact ? 11 : 12,
        color: TEXT_LAYOUT_COLORS.blue,
        fontWeight: "900",
        lineHeight: 1.12
      }),
      text({
        ...headline,
        x: 50,
        y: compact ? 84 : 104,
        width: 340,
        height: compact ? 54 : 78,
        fontSize: compact ? 24 : 32,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.08,
        shadowEnabled: false
      }),
      ...listCopy.ko.map((item, index) => {
        const y = cardTop + index * (rowHeight + (compact ? 10 : 14));
        return [
          shape({
            x: 52,
            y,
            width: 356,
            height: rowHeight,
            fillColor: index === 0 ? TEXT_LAYOUT_COLORS.softBlue : TEXT_LAYOUT_COLORS.surface,
            fillOpacity: 1,
            borderRadius: 16
          }),
          text({
            ko: item,
            en: listCopy.en[index] ?? item,
            x: 72,
            y: y + (compact ? 13 : 16),
            width: 308,
            height: rowHeight - 18,
            fontSize: compact ? 12 : 15,
            color: TEXT_LAYOUT_COLORS.ink,
            fontWeight: "800",
            lineHeight: 1.2,
            shadowEnabled: false
          })
        ];
      }).flat()
    ];
  }

  if (template === "disclosure") {
    const tableTop = compact ? 116 : 184;
    const rowHeight = compact ? 42 : 58;
    const rows = [
      { ko: "구매 전 확인", en: "Before buying", valueKo: firstTemplateBullet(section.bullets, trustLine.ko), valueEn: firstTemplateBullet(section.bullets_en, trustLine.en) },
      { ko: "구성/주의", en: "Composition", valueKo: listCopy.ko[1] ?? subheadline.ko, valueEn: listCopy.en[1] ?? subheadline.en },
      { ko: "안내", en: "Notice", valueKo: trustLine.ko, valueEn: trustLine.en }
    ];

    return [
      shape({
        x: 24,
        y: 36,
        width: 412,
        height: Math.min(canvasHeight - 72, compact ? 250 : 382),
        fillColor: TEXT_LAYOUT_COLORS.surface,
        fillOpacity: 0.96,
        borderRadius: compact ? 22 : 28
      }),
      text({
        ko: "상품정보 확인",
        en: "Product notice",
        x: 48,
        y: compact ? 58 : 70,
        width: 200,
        height: 22,
        fontSize: compact ? 11 : 12,
        color: TEXT_LAYOUT_COLORS.blue,
        fontWeight: "900",
        lineHeight: 1.12
      }),
      text({
        ...headline,
        x: 46,
        y: compact ? 84 : 104,
        width: 342,
        height: compact ? 52 : 72,
        fontSize: compact ? 23 : 30,
        color: TEXT_LAYOUT_COLORS.ink,
        fontWeight: "900",
        lineHeight: 1.1,
        shadowEnabled: false
      }),
      ...rows.flatMap((row, index) => {
        const y = tableTop + index * rowHeight;
        return [
          shape({
            x: 48,
            y,
            width: 114,
            height: rowHeight,
            fillColor: TEXT_LAYOUT_COLORS.ink,
            fillOpacity: 0.9,
            borderRadius: index === 0 ? 14 : 8
          }),
          shape({
            x: 162,
            y,
            width: 250,
            height: rowHeight,
            fillColor: TEXT_LAYOUT_COLORS.white,
            fillOpacity: 0.92,
            borderRadius: index === 0 ? 14 : 8
          }),
          text({
            ko: row.ko,
            en: row.en,
            x: 60,
            y: y + (compact ? 11 : 15),
            width: 90,
            height: rowHeight - 16,
            fontSize: compact ? 10 : 12,
            color: TEXT_LAYOUT_COLORS.white,
            fontWeight: "900",
            lineHeight: 1.15,
            shadowEnabled: false
          }),
          text({
            ko: row.valueKo,
            en: row.valueEn,
            x: 180,
            y: y + (compact ? 9 : 13),
            width: 210,
            height: rowHeight - 14,
            fontSize: compact ? 10 : 13,
            color: TEXT_LAYOUT_COLORS.ink,
            fontWeight: "700",
            lineHeight: 1.22,
            shadowEnabled: false
          })
        ];
      })
    ];
  }

  if (template === "cta") {
    return [
      shape({
        x: 24,
        y: panelY,
        width: 412,
        height: panelHeight,
        fillColor: TEXT_LAYOUT_COLORS.dark,
        fillOpacity: 0.82,
        borderRadius: compact ? 22 : 30
      }),
      text({
        ko: "마지막 제안",
        en: "Final offer",
        x: 50,
        y: panelY + 24,
        width: 200,
        height: 22,
        fontSize: 12,
        color: TEXT_LAYOUT_COLORS.gold,
        fontWeight: "900",
        lineHeight: 1.1
      }),
      text({
        ...headline,
        x: 48,
        y: panelY + (compact ? 54 : 66),
        width: 354,
        height: compact ? 62 : 94,
        fontSize: compact ? 26 : 36,
        color: TEXT_LAYOUT_COLORS.white,
        fontWeight: "900",
        lineHeight: 1.06
      }),
      text({
        ...subheadline,
        x: 50,
        y: panelY + (compact ? 122 : 168),
        width: 328,
        height: compact ? 38 : 50,
        fontSize: compact ? 13 : 16,
        color: TEXT_LAYOUT_COLORS.cream,
        fontWeight: "500",
        lineHeight: 1.38
      })
    ];
  }

  return [
    shape({
      x: 28,
      y: panelY,
      width: 404,
      height: panelHeight,
      fillColor: TEXT_LAYOUT_COLORS.ink,
      fillOpacity: 0.74,
      borderRadius: 24
    }),
    text({
      ko: getDisplaySectionName(section),
      en: getDisplaySectionName(section),
      x: 52,
      y: panelY + 24,
      width: 220,
      height: 22,
      fontSize: 12,
      color: TEXT_LAYOUT_COLORS.accent,
      fontWeight: "900",
      lineHeight: 1.1
    }),
    text({
      ...headline,
      x: 50,
      y: panelY + (compact ? 54 : 64),
      width: 350,
      height: compact ? 62 : 92,
      fontSize: compact ? 25 : 34,
      color: TEXT_LAYOUT_COLORS.white,
      fontWeight: "900",
      lineHeight: 1.08
    }),
    text({
      ko: bulletCopy.ko || subheadline.ko,
      en: bulletCopy.en || subheadline.en,
      x: 52,
      y: panelY + (compact ? 122 : 170),
      width: 328,
      height: compact ? 44 : 60,
      fontSize: compact ? 13 : 16,
      color: TEXT_LAYOUT_COLORS.cream,
      fontWeight: "500",
      lineHeight: 1.42
    })
  ];
}

interface TextLayerInput {
  ko: string;
  en: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  fontSize: number;
  color: string;
  fontWeight: string;
  lineHeight: number;
  textAlign?: OverlayTextAlign;
  backgroundEnabled?: boolean;
  backgroundColor?: string;
  backgroundOpacity?: number;
  backgroundRadius?: number;
  shadowEnabled?: boolean;
  shadowColor?: string;
  shadowOpacity?: number;
  shadowBlur?: number;
  shadowOffsetY?: number;
}

interface ShapeLayerInput {
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  fillOpacity: number;
  borderRadius: number;
}

function createTemplateTextLayer(input: TextLayerInput, language: PdpCopyLanguage): TextOverlay {
  const translations = {
    ko: input.ko || input.en,
    en: input.en || input.ko
  };
  const displayText = translations[language] || translations.ko;
  const height =
    input.height ??
    estimateOverlayBox(displayText, {
      fontSize: input.fontSize,
      fontWeight: input.fontWeight,
      fontFamily: "'Pretendard', sans-serif",
      lineHeight: input.lineHeight,
      maxWidth: input.width
    }).height;

  return normalizeTextOverlay({
    id: createCanvasLayerId("text-template"),
    kind: "text",
    text: displayText,
    language,
    translations,
    x: input.x,
    y: input.y,
    width: input.width,
    height,
    fontSize: input.fontSize,
    color: input.color,
    backgroundColor: input.backgroundColor ?? TEXT_LAYOUT_COLORS.ink,
    backgroundEnabled: input.backgroundEnabled ?? false,
    backgroundOpacity: input.backgroundOpacity ?? 0.72,
    backgroundRadius: input.backgroundRadius ?? 18,
    fontFamily: "'Pretendard', sans-serif",
    fontWeight: input.fontWeight,
    textAlign: input.textAlign ?? "left",
    lineHeight: input.lineHeight,
    shadowEnabled: input.shadowEnabled ?? true,
    shadowColor: input.shadowColor ?? TEXT_LAYOUT_COLORS.dark,
    shadowOpacity: input.shadowOpacity ?? 0.36,
    shadowBlur: input.shadowBlur ?? 14,
    shadowOffsetY: input.shadowOffsetY ?? 5
  });
}

function createTemplateShapeLayer(input: ShapeLayerInput): ShapeLayer {
  return normalizeShapeLayer({
    id: createCanvasLayerId("shape-template"),
    kind: "shape",
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    fillColor: input.fillColor,
    fillOpacity: input.fillOpacity,
    borderRadius: input.borderRadius
  });
}

function inferTextLayoutTemplate(section: PdpSection, sectionIndex: number, totalSections: number): TextLayoutTemplateKind {
  const roleText = [
    section.section_id,
    section.section_name,
    section.purpose
  ].join(" ").toLowerCase();
  const haystack = [
    section.section_id,
    section.section_name,
    section.goal,
    section.purpose,
    section.headline,
    section.subheadline,
    section.layout_notes
  ].join(" ").toLowerCase();

  if (sectionIndex === 0 || /hero|히어로|첫\s*화면|메인/.test(haystack)) {
    return "hero";
  }
  if (/concern\s*list|customer\s*concern|chat|bubble|고객\s*고민\s*리스팅|고민\s*리스팅|채팅|말풍선|망설임\s*리스트/.test(roleText)) {
    return "concernList";
  }
  if (/question|공감\s*질문|상황\s*질문|질문|적\s*없으|나요|까요/.test(roleText)) {
    return "question";
  }
  if (/bridge|전환|선언|직접\s*고쳤|개선\s*선언|해결\s*흐름/.test(roleText)) {
    return "bridge";
  }
  if (/compare|comparison|vs|비교|경쟁|대안|차이/.test(roleText)) {
    return "compare";
  }
  if (/disclosure|spec|고시|상품정보|주의|faq|보증/.test(roleText)) {
    return "disclosure";
  }
  if (/composition|configuration|구성|구성품|세트|컬러|색상|사이즈/.test(roleText)) {
    return "composition";
  }
  if (/detail|디테일|소재|마감|원단|클로즈|부위/.test(roleText)) {
    return "detail";
  }
  if (/success|lifestyle|스타일|라이프|사용\s*후|사용\s*장면|기대\s*장면|생활|착용\s*장면|변화|달라/.test(roleText)) {
    return "lifestyle";
  }
  if (/proof|evidence|trust|review|신뢰|근거|후기|리뷰|인증/.test(roleText)) {
    return "proof";
  }
  if (/failure|loss|problem|concern|objection|pain|고민|문제|불편|저항|불안|장벽|손실|놓쳤|후회|미루/.test(roleText)) {
    return "problem";
  }
  if (/plan|routine|use|situation|사용|루틴|방법|계획|상황|순서/.test(roleText)) {
    return "plan";
  }
  if (/guide|value|feature|benefit|point|detail|why|핵심|장점|기능|디테일|선택|이유|가이드|제품\s*소개|해결책/.test(roleText)) {
    return "value";
  }
  if (/cta|action|offer|구매\s*제안|마무리|행동\s*유도|오퍼|마지막|확신/.test(roleText)) {
    return "cta";
  }
  if (/concern\s*list|customer\s*concern|chat|bubble|고객\s*고민\s*리스팅|고민\s*리스팅|채팅|말풍선|망설임\s*리스트/.test(haystack)) {
    return "concernList";
  }
  if (/question|공감\s*질문|상황\s*질문|질문|적\s*없으|나요|까요/.test(haystack)) {
    return "question";
  }
  if (/bridge|전환|선언|직접\s*고쳤|개선\s*선언|해결\s*흐름/.test(haystack)) {
    return "bridge";
  }
  if (/compare|comparison|vs|비교|경쟁|대안|차이/.test(haystack)) {
    return "compare";
  }
  if (/disclosure|spec|고시|상품정보|주의|faq|보증/.test(haystack)) {
    return "disclosure";
  }
  if (/composition|configuration|구성|구성품|세트|컬러|색상|사이즈/.test(haystack)) {
    return "composition";
  }
  if (/detail|디테일|소재|마감|원단|클로즈|부위/.test(haystack)) {
    return "detail";
  }
  if (/success|lifestyle|스타일|라이프|사용\s*후|사용\s*장면|기대\s*장면|생활|착용\s*장면|변화|달라/.test(haystack)) {
    return "lifestyle";
  }
  if (/guide|value|feature|benefit|point|detail|why|핵심|장점|기능|디테일|선택|이유|가이드|제품\s*소개|해결책/.test(haystack)) {
    return "value";
  }
  if (/proof|evidence|trust|review|신뢰|근거|후기|리뷰|인증/.test(haystack)) {
    return "proof";
  }
  if (/failure|loss|problem|concern|objection|pain|고민|문제|불편|저항|불안|장벽|손실|놓쳤|후회|미루/.test(haystack)) {
    return "problem";
  }
  if (/plan|routine|use|situation|사용|루틴|방법|계획|상황|순서/.test(haystack)) {
    return "plan";
  }
  if (/cta|action|offer|구매\s*제안|마무리|행동\s*유도|오퍼|마지막|확신/.test(haystack) || sectionIndex === totalSections - 1) {
    return "cta";
  }

  return "generic";
}

function getTextLayoutTemplateLabel(template: TextLayoutTemplateKind) {
  const labels: Record<TextLayoutTemplateKind, string> = {
    hero: "히어로우",
    question: "공감 질문",
    concernList: "고객 고민 리스팅",
    problem: "문제 공감",
    bridge: "전환 선언",
    value: "핵심 포인트",
    plan: "사용 흐름",
    proof: "신뢰 근거",
    compare: "비교/근거",
    detail: "디테일",
    lifestyle: "사용 장면",
    composition: "제품 구성",
    disclosure: "상품정보 확인",
    cta: "마지막 제안",
    generic: "기본 상세페이지"
  };

  return labels[template];
}

function hasOverlayEntry(record: Record<number, CanvasLayer[]>, index: number) {
  return Object.prototype.hasOwnProperty.call(record, index);
}

function refreshLegacyTemplateLayouts(
  record: Record<number, CanvasLayer[]>,
  sections: PdpSection[],
  aspectRatio: AspectRatio,
  language: PdpCopyLanguage
) {
  let didRefresh = false;
  const nextRecord: Record<number, CanvasLayer[]> = { ...record };

  sections.forEach((section, index) => {
    const layers = record[index];
    if (!section.generatedImage || !shouldRefreshLegacyTemplateLayout(layers, section, index, sections.length)) {
      return;
    }

    nextRecord[index] = buildDefaultTextLayout(section, index, sections.length, aspectRatio, language);
    didRefresh = true;
  });

  return didRefresh ? nextRecord : record;
}

function shouldRefreshLegacyTemplateLayout(
  layers: CanvasLayer[] | undefined,
  section: PdpSection,
  sectionIndex: number,
  totalSections: number
) {
  if (!Array.isArray(layers) || layers.length === 0) {
    return false;
  }

  const expectedTemplate = inferTextLayoutTemplate(section, sectionIndex, totalSections);
  const shapes = layers.filter(isShapeLayer);
  const textLabels = layers.filter(isTextLayer).map((layer) => layer.text).join(" ");
  const hasNewHeroScrim = shapes.some(
    (layer) => layer.x === 0 && toNumericSize(layer.width, 0) === EDITOR_CANVAS_BASE_WIDTH
  );
  const hasNarrowProblemCard = shapes.some(
    (layer) => layer.x === 26 && (toNumericSize(layer.width, 0) === 292 || toNumericSize(layer.width, 0) === 304)
  );
  const hasReducedValueCard =
    expectedTemplate === "value" &&
    shapes.length === 1 &&
    shapes.some((layer) => layer.x === 32 && toNumericSize(layer.width, 0) === 258);
  const lastSectionUsesWrongTemplate =
    expectedTemplate === "cta" && /구매 전 고민|Pain point|핵심 포인트|Key point|DETAIL|원본 기준/.test(textLabels);

  return hasNewHeroScrim || hasNarrowProblemCard || hasReducedValueCard || lastSectionUsesWrongTemplate;
}

function getCanvasBaseHeight(aspectRatio: AspectRatio) {
  const [rawWidth, rawHeight] = aspectRatio.split(":").map((value) => Number(value));
  const ratioWidth = rawWidth || 9;
  const ratioHeight = rawHeight || 16;
  return Math.round((EDITOR_CANVAS_BASE_WIDTH * ratioHeight) / ratioWidth);
}

function bottomY(canvasHeight: number, elementHeight: number, margin: number) {
  return Math.max(18, canvasHeight - elementHeight - margin);
}

function compactText(value: string | undefined, fallback: string, maxLength: number) {
  const normalized = String(value || fallback || "")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}|…/g, "")
    .trim();

  if (!normalized) {
    return fallback;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const clipped = normalized.slice(0, maxLength).trim();
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.6)) {
    return clipped.slice(0, lastSpace).trim();
  }

  return clipped;
}

function formatTemplateBullets(values: string[] | undefined, fallback: string, limit: number) {
  const items = normalizeTemplateList(values, fallback, limit);
  return items.map((item) => `• ${item}`).join("\n");
}

function formatTemplateSteps(values: string[] | undefined, fallback: string) {
  const items = normalizeTemplateList(values, fallback, 3);
  return items.map((item, index) => `${String(index + 1).padStart(2, "0")} ${item}`).join("\n");
}

function splitTemplateSteps(koText: string, enText: string) {
  const koItems = koText.split("\n").filter(Boolean);
  const enItems = enText.split("\n").filter(Boolean);

  return koItems.map((ko, index) => ({
    ko,
    en: enItems[index] ?? ko
  }));
}

function firstTemplateBullet(values: string[] | undefined, fallback: string) {
  return normalizeTemplateList(values, fallback, 1)[0] ?? fallback;
}

function formatQuestionCopy(value: string) {
  const compact = compactText(value, "이런 적 없으세요?", 54).replace(/[.!。！]+$/g, "").trim();
  if (/[?？]$/.test(compact) || /(?:나요|세요|까요|습니까)$/.test(compact)) {
    return compact;
  }

  return `${compact}?`;
}

function normalizeTemplateList(values: string[] | undefined, fallback: string, limit: number) {
  const items = (Array.isArray(values) ? values : [])
    .map((value) => compactText(value, "", 38))
    .filter(Boolean);

  if (!items.length) {
    return [compactText(fallback, "핵심 메시지를 입력하세요", 42)];
  }

  return items.slice(0, limit);
}

function createCanvasLayerId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type ExpansionCopyRole =
  | "hero"
  | "question"
  | "concernList"
  | "problem"
  | "bridge"
  | "guide"
  | "value"
  | "plan"
  | "proof"
  | "compare"
  | "detail"
  | "lifestyle"
  | "success"
  | "review"
  | "composition"
  | "disclosure"
  | "cta"
  | "failure"
  | "generic";

type SalesNarrativeContext = {
  // Category-specific hardcoded copy decks were removed on 2026-07-02: keyword-based
  // category guessing kept injecting another product's sample copy (sunscreen, socks,
  // sun patch, beauty) into user output. Narrative context is now always derived from
  // the user's own copy/blueprint, so the only category is "generic".
  category: "generic";
  productRef: string;
  productName: string;
  heroPromise: string;
  customerPain: string;
  solutionLine: string;
  planSteps: string[];
  successLine: string;
  failureLine: string;
  ctaLine: string;
  proofLine: string;
  detailLine: string;
  compositionLine: string;
  supportBullets: string[];
};

type ExpansionSectionCopyInput = {
  heroSection: PdpSection;
  contextSections?: PdpSection[];
  sectionId: string;
  sectionName: string;
  goal: string;
  strategyTitle: string;
  sectionIndex: number;
  totalSections: number;
  isLastSection: boolean;
  additionalInfo?: string;
  blueprintSummary?: string;
  blueprintList?: string[];
  customerReviewAnalysis?: PdpCustomerReviewAnalysis | null;
};

const INTERNAL_SECTION_COPY_LABELS = [
  "히어로",
  "히어로우",
  "고객 공감",
  "공감 질문",
  "상황 질문",
  "문제 제기",
  "문제제기",
  "문제 공감",
  "가이드 제안",
  "가이드/제품 소개",
  "제품 소개",
  "전환 선언",
  "해결 계획",
  "해결 포인트",
  "사용 계획",
  "신뢰 근거",
  "행동 유도",
  "사용 후 변화",
  "놓쳤을 때 손실",
  "마지막 확신",
  "구매 전 고민",
  "고객 고민",
  "고객 고민 리스팅",
  "고민 리스팅",
  "선택 이유",
  "제품 특장점",
  "근거/신뢰",
  "고객 후기",
  "사용법",
  "FAQ/보증",
  "FAQ/고시",
  "사용 상황",
  "사용 장면",
  "루틴",
  "사용 루틴",
  "제품 디테일",
  "디테일 확인",
  "기대 장면",
  "제품 구성",
  "상품정보 확인",
  "구매 제안",
  "왜 지금 필요한가",
  "비교 포인트",
  "핵심 기능",
  "확인 근거",
  "오퍼/마무리",
  "새 섹션"
];

const GENERIC_COPY_PATTERNS = [
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
  /사용자가\s*히어로우를\s*보고/,
  /직접\s*추가한\s*전환\s*섹션/,
  /새\s*헤드라인을\s*입력/,
  /conversion-focused/i,
  /extend\s+the\s+hero/i
];

const PROBLEM_COPY_HINT = /고민|불편|걱정|불안|망설|부담|어렵|어려|번거|아쉽|필요|찾|원하|싫|못|없|힘들|헷갈|\?/;
const REVIEW_COPY_HINT = /고객|후기|리뷰|별점|만족|써보|써\s*보|사용해|구매해|좋았|편했|쉬웠|추천|재구매/;
const PROOF_COPY_HINT = /근거|확인|검증|인증|원본|구성|성분|소재|리뷰|후기|안심|신뢰|보증/;
const PLAN_COPY_HINT = /사용|루틴|방법|단계|순서|받|열|시작|바로|쉽게|간편/;
const DETAIL_COPY_HINT = /디테일|소재|마감|원단|형태|패키지|구성|컬러|사이즈|클로즈|확인/;
const LIFESTYLE_COPY_HINT = /생활|장면|착용|외출|출근|운동|일상|스타일|분위기|기대/;
const BRIDGE_COPY_HINT = /그래서|직접|고쳤|개선|해결|바꿨|준비|알아서|이제/;
const CTA_COPY_HINT = /지금|선택|구매|확인|혜택|마지막|시작|바로/;

function buildExpansionSectionCopy(input: ExpansionSectionCopyInput) {
  const role = inferExpansionCopyRole(input.sectionId, input.sectionName);
  const copyPool = buildExpansionCopyPool(input);
  const context = buildSalesNarrativeContext(input, copyPool);
  const defaults = buildRoleFallbackCopy(role, context, input.isLastSection, input.customerReviewAnalysis);
  const headline = sanitizeCustomerCopy(defaults.headline, input.sectionName) || defaults.headline;
  const subheadline = sanitizeCustomerCopy(defaults.subheadline, input.sectionName) || defaults.subheadline;
  const bullets = buildExpansionBullets(role, copyPool, context, [headline, subheadline], defaults.bullets);
  const trustLine = sanitizeCustomerCopy(defaults.trustLine, input.sectionName) || context.proofLine;
  const cta = "";
  const rolePromptDirective = getExpansionRolePromptDirective(role);

  return {
    goal: subheadline,
    headline,
    headline_en: defaults.headline_en,
    subheadline,
    subheadline_en: defaults.subheadline_en,
    bullets,
    bullets_en: defaults.bullets_en,
    trust_or_objection_line: trustLine,
    trust_or_objection_line_en: "Use only claims that are grounded in the reference product.",
    CTA: cta,
    CTA_en: "",
    layout_notes: [
      `${input.strategyTitle} ${input.sectionIndex}/${input.totalSections} 장면. 이전 문구를 반복하지 말고 "${headline}" 메시지가 다음 구매 판단으로 이어지게 구성합니다.`,
      rolePromptDirective.layoutNote
    ].filter(Boolean).join(" "),
    purpose: `${defaults.storyBeat}: ${headline}`,
    prompt_ko: [
      `${input.strategyTitle}의 ${input.sectionIndex}/${input.totalSections}번째 장면을 만든다.`,
      `이 장면의 역할은 ${defaults.storyBeat}이며, 이미지 안의 제목은 섹션명 "${input.sectionName}"이 아니라 "${headline}"을 사용한다.`,
      `서브카피 "${subheadline}"이 이전 장면에서 다음 구매 판단으로 자연스럽게 이어지게 연출한다.`,
      rolePromptDirective.ko,
      "히어로우 문구를 반복하지 말고, 같은 제품 톤 안에서 새로운 장면/구도/정보 위계를 만든다."
    ].filter(Boolean).join(" "),
    prompt_en: [
      `Create scene ${input.sectionIndex} of ${input.totalSections} in one continuous ecommerce sales narrative.`,
      `Story beat: ${defaults.storyBeat}.`,
      `Do not render the internal section label as visible copy; use the consumer-facing headline "${headline}".`,
      rolePromptDirective.en,
      `Do not repeat the hero tagline. Visually reinforce the subheadline "${subheadline}" with a distinct scene that still belongs to the same product page.`
    ].filter(Boolean).join(" ")
  };
}

function getExpansionRolePromptDirective(role: ExpansionCopyRole) {
  if (role === "concernList") {
    return {
      layoutNote: "검은 배경, 중앙 큰 제목, 좌우로 엇갈린 흰색 채팅 말풍선 4~5개를 사용합니다.",
      ko: "첨부 참고처럼 어두운 배경 위에 큰 제목과 흰색 채팅 말풍선 4~5개를 배치하고, 각 말풍선은 고객이 속으로 묻는 짧은 고민 문장으로 만든다.",
      en: "Use a dark background with a large centered headline and 4-5 white chat bubbles alternating left and right; each bubble should be a short pre-purchase customer concern."
    };
  }

  if (role === "review") {
    return {
      layoutNote: "후기 섹션은 일반 제품 장점컷이 아니라 별점, 마스킹 ID, 큰 인용문이 있는 후기 카드형 레이아웃으로 만듭니다.",
      ko: "첨부 참고처럼 큰 제목 아래에 별점과 마스킹 ID가 있는 후기 카드 3~4개, 또는 제품 사용 사진과 큰 인용문 카드 1개, 또는 UGC 포스트형 카드 구성을 사용한다. 문장은 고객이 직접 말하는 1인칭 후기처럼 짧고 크게 배치한다.",
      en: "Use a testimonial layout, not a generic benefit scene: 3-4 review cards with stars and masked user IDs, or one large quote card beside a product-use photo, or an Instagram/UGC-style post card. The visible copy should read like short first-person customer comments."
    };
  }

  return {
    layoutNote: "",
    ko: "",
    en: ""
  };
}

function buildSalesNarrativeContext(input: ExpansionSectionCopyInput, copyPool: string[]): SalesNarrativeContext {
  const contextSectionCopy = (input.contextSections ?? []).flatMap((section) => [
    section.headline,
    section.subheadline,
    ...section.bullets,
    section.trust_or_objection_line,
    section.CTA,
    section.goal,
    section.purpose
  ]);
  const allCopy = uniqueCopyLines([
    ...copyPool,
    input.heroSection.headline,
    input.heroSection.subheadline,
    ...input.heroSection.bullets,
    input.heroSection.trust_or_objection_line,
    input.heroSection.CTA,
    input.additionalInfo ?? "",
    ...contextSectionCopy,
    input.blueprintSummary ?? "",
    ...(input.blueprintList ?? [])
  ].flatMap(splitCopyFragments).map((value) => sanitizeCustomerCopy(value)).filter(Boolean));
  const productName = inferProductName(allCopy);
  const heroPromise = sanitizeCustomerCopy(input.heroSection.headline) || allCopy[0] || "필요한 순간을 더 가볍게";

  // No keyword-based category decks here anymore. Every product gets the neutral
  // narrative derived from its own copy pool; product-specific claims must come from
  // the user's data (hero copy, blueprint, reviews), never from a built-in sample.
  const resolvedProductRef = productName || "이 제품";

  return {
    category: "generic",
    productRef: resolvedProductRef,
    productName: resolvedProductRef,
    heroPromise,
    customerPain: "좋아 보여도 구매 직전에는 정말 나에게 맞을지 망설임이 남습니다.",
    solutionLine: `${resolvedProductRef}는 필요한 순간의 불편을 줄이고 선택 기준을 더 선명하게 만듭니다.`,
    planSteps: ["필요한 순간 확인", "간단히 사용", "달라진 장면 경험"],
    successLine: "사용 후에는 구매 전 망설였던 지점이 줄고 제품을 쓰는 장면이 더 분명해집니다.",
    failureLine: "미루면 해결해야 할 불편은 그대로 남고, 다음 선택에서도 같은 고민을 다시 하게 됩니다.",
    ctaLine: `${resolvedProductRef}를 선택해야 하는 이유를 확인하세요`,
    proofLine: "확인 가능한 구성과 디테일 중심으로 선택하세요.",
    detailLine: "제품이 어떤 불편을 줄여주는지 형태, 소재, 구성으로 확인하세요.",
    compositionLine: "구성, 옵션, 사용 전 확인할 정보를 한 번에 살펴보세요.",
    supportBullets: ["구매 전 남는 고민", "제품에서 확인되는 장점", "사용 후 기대되는 변화"]
  };
}

function inferProductName(copyLines: string[]) {
  const productTypeLine = copyLines.find((line) =>
    /running\s*socks?|run\s*socks?|러닝\s*양말|런닝\s*양말|운동\s*양말|양말|삭스|socks?|선\s*크림|썬\s*크림|선스크린|sunscreen|sun\s*screen|sun\s*cream|sun\s*patch|선\s*패치|썬\s*패치|패치|크림|세럼|앰플|샴푸|가방|텀블러|의자|조명/i.test(line) &&
    !PROBLEM_COPY_HINT.test(line) &&
    line.length <= 42
  );

  if (productTypeLine) {
    return shortenCopyLine(productTypeLine.replace(/[?!.。！？]+$/g, ""), 34);
  }

  const brandLikeLine = copyLines.find((line) =>
    /[A-Z]{2,}|[0-9]/.test(line) &&
    !/[?？]/.test(line) &&
    line.length >= 4 &&
    line.length <= 42
  );

  return brandLikeLine ? shortenCopyLine(brandLikeLine.replace(/[?!.。！？]+$/g, ""), 34) : "";
}

function inferExpansionCopyRole(sectionId: string, sectionName: string): ExpansionCopyRole {
  const key = `${sectionId} ${sectionName}`.toLowerCase();

  if (/hero|히어로|첫\s*화면|메인/.test(key)) {
    return "hero";
  }
  if (/concern\s*list|customer\s*concern|chat|bubble|고객\s*고민\s*리스팅|고민\s*리스팅|채팅|말풍선|망설임\s*리스트/.test(key)) {
    return "concernList";
  }
  if (/question|공감\s*질문|상황\s*질문|질문/.test(key)) {
    return "question";
  }
  if (/bridge|전환|선언/.test(key)) {
    return "bridge";
  }
  if (/failure|loss|손실|놓쳤|후회|미루/.test(key)) {
    return "failure";
  }
  if (/testimonial|customer\s*review|review|고객\s*후기|실사용\s*후기|사용\s*후기|구매\s*후기|리얼\s*후기|후기(?!형)|리뷰|별점/.test(key)) {
    return "review";
  }
  if (/concern\s*list|customer\s*concern|chat|bubble|고객\s*고민\s*리스팅|고민\s*리스팅|채팅|말풍선|망설임\s*리스트/.test(key)) {
    return "concernList";
  }
  if (/success|after|change|review|사용\s*후|변화|후기|달라|고객\s*후기/.test(key)) {
    return "success";
  }
  if (/guide|가이드|제품\s*소개|solution|해결책|소개/.test(key)) {
    return "guide";
  }
  if (/compare|비교/.test(key)) {
    return "compare";
  }
  if (/disclosure|spec|고시|상품정보|faq|보증/.test(key)) {
    return "disclosure";
  }
  if (/composition|configuration|구성|구성품|세트|컬러|사이즈/.test(key)) {
    return "composition";
  }
  if (/detail|디테일|소재|마감/.test(key)) {
    return "detail";
  }
  if (/lifestyle|라이프|스타일|사용\s*장면|기대\s*장면|생활/.test(key)) {
    return "lifestyle";
  }
  if (/problem|concern|whynow|situation|문제|문제제기|고민|상황|필요/.test(key)) {
    return "problem";
  }
  if (/value|feature|선택|장점|특장점|특징|기능/.test(key)) {
    return "value";
  }
  if (/plan|use|routine|사용|루틴|계획/.test(key)) {
    return "plan";
  }
  if (/proof|evidence|trust|근거|신뢰/.test(key)) {
    return "proof";
  }
  if (/action|cta|offer|close|구매|행동|오퍼|마무리|마지막|확신/.test(key)) {
    return "cta";
  }

  return "generic";
}

function buildExpansionCopyPool(input: ExpansionSectionCopyInput) {
  const contextSectionCopy = (input.contextSections ?? []).flatMap((section) => [
    section.headline,
    section.subheadline,
    ...section.bullets,
    section.trust_or_objection_line,
    section.CTA,
    section.goal,
    section.purpose
  ]);
  const rawValues = [
    input.heroSection.headline,
    input.heroSection.subheadline,
    ...input.heroSection.bullets,
    input.heroSection.trust_or_objection_line,
    input.heroSection.CTA,
    ...contextSectionCopy,
    input.blueprintSummary,
    ...(input.blueprintList ?? []),
    ...(input.customerReviewAnalysis?.sampleReviews ?? []),
    ...(input.customerReviewAnalysis?.topBenefits ?? []),
    ...(input.customerReviewAnalysis?.painPoints ?? []),
    ...(input.customerReviewAnalysis?.improvementPromises ?? []),
    ...(input.customerReviewAnalysis?.keywordSummary ?? []),
    input.goal
  ];

  return uniqueCopyLines(
    rawValues
      .flatMap(splitCopyFragments)
      .map((value) => sanitizeCustomerCopy(value, input.sectionName))
      .filter(Boolean)
  );
}

function uniqueSectionsById(sections: Array<PdpSection | undefined>) {
  const seen = new Set<string>();
  const result: PdpSection[] = [];

  sections.forEach((section) => {
    if (!section || seen.has(section.section_id)) {
      return;
    }

    seen.add(section.section_id);
    result.push(section);
  });

  return result;
}

function splitCopyFragments(value?: string) {
  if (!value) {
    return [];
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n|[;；]/)
    .flatMap((fragment) => fragment.split(/(?<=[.!?。！？])\s+/))
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

function sanitizeCustomerCopy(value?: string, sectionName?: string) {
  const normalized = (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}|…/g, "")
    .replace(/^[-•\d.]+\s*/, "")
    .trim();

  if (!normalized || isInternalSectionCopy(normalized, sectionName)) {
    return "";
  }

  return shortenCopyLine(normalized, 52);
}

function isInternalSectionCopy(value: string, sectionName?: string) {
  const key = normalizeCopyKey(value);
  if (!key) {
    return true;
  }

  if (sectionName && key === normalizeCopyKey(sectionName)) {
    return true;
  }

  if (INTERNAL_SECTION_COPY_LABELS.some((label) => key === normalizeCopyKey(label))) {
    return true;
  }

  return GENERIC_COPY_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeCopyKey(value: string) {
  return value
    .replace(/[\s·.,!?'"“”‘’()[\]{}:;_/\-]+/g, "")
    .toLowerCase();
}

function shortenCopyLine(value: string, maxLength: number) {
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

function buildCopyAnchor(value?: string) {
  const normalized = sanitizeCustomerCopy(value);
  if (!normalized) {
    return "이 제품";
  }

  return shortenCopyLine(normalized.replace(/[?!.。！？]+$/g, ""), 24);
}

function buildRoleFallbackCopy(
  role: ExpansionCopyRole,
  context: SalesNarrativeContext,
  isFinalBeat = false,
  customerReviewAnalysis?: PdpCustomerReviewAnalysis | null
) {
  const productLabel = context.productRef === "이 제품" ? "이 제품" : context.productRef;
  const productNameLabel = context.productName || productLabel;
  const planLine = context.planSteps.join(" · ");
  const reviewSamples = normalizeCustomerReviewCopyList(customerReviewAnalysis?.sampleReviews, 4, 64);
  const reviewBenefits = normalizePdpReviewBenefitSalesCopyList(customerReviewAnalysis?.topBenefits, "generic", 4, 58);
  const reviewPainPoints = normalizeCustomerReviewCopyList(customerReviewAnalysis?.painPoints, 5, 58);
  const reviewImprovements = normalizeCustomerReviewCopyList(customerReviewAnalysis?.improvementPromises, 4, 68);
  const reviewBackedConcerns = buildReviewBackedConcernLines(reviewBenefits);
  const reviewBenefitSummary = reviewBenefits.slice(0, 2).join(" · ");

  const copyByRole = {
    hero: {
      headline: context.heroPromise || `${productLabel}, 선택이 쉬워지는 순간`,
      headline_en: "A clear first promise",
      subheadline: context.solutionLine,
      subheadline_en: "Restate the main promise as a strong opening scene.",
      bullets: context.supportBullets,
      bullets_en: ["Product promise", "Reason to keep reading", "Clear first impression"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "제품의 핵심 약속을 첫 화면처럼 다시 고정하는 장면"
    },
    question: {
      headline: "이런 불편, 매번 참아야 할까요?",
      headline_en: "Have you felt this before?",
      subheadline: context.customerPain,
      subheadline_en: "Open with a question that makes the customer recognize their own situation.",
      bullets: context.supportBullets,
      bullets_en: ["A real moment before purchase", "A clear source of hesitation", "A reason to keep reading"],
      trustLine: context.failureLine,
      CTA: "",
      storyBeat: "고객이 자기 상황을 알아차리는 첫 장면"
    },
    concernList: {
      headline: "이런 고민 한 적 있지 않으세요?",
      headline_en: "Why are they hesitating?",
      subheadline: reviewPainPoints.length
        ? "구매 전 망설였던 포인트를 먼저 공감하고, 다음 섹션에서 답을 보여드립니다."
        : productLabel === "이 제품"
          ? "구매 전 고객이 속으로 묻는 고민을 먼저 보여줍니다."
          : `${productLabel} 구매 전 고객이 속으로 묻는 고민을 먼저 보여줍니다.`,
      subheadline_en: "List the customer's pre-purchase doubts as short chat bubbles.",
      bullets: reviewPainPoints.length
        ? reviewPainPoints
        : reviewBackedConcerns.length
          ? reviewBackedConcerns
          : ["정말 나에게 필요한지 모르겠어요", "써보고 후회하면 어떡하죠?", "가격만큼 만족할지 걱정돼요", "비슷한 제품이 많아 못 고르겠어요", "꾸준히 쓸 수 있을지 모르겠어요"],
      bullets_en: ["Will it really work?", "What if it does not fit me?", "Can I keep using it?", "Why is the price so different?", "How do I choose?"],
      trustLine: reviewImprovements[0] ?? "고객이 망설이는 말을 먼저 듣고, 다음 섹션에서 답을 제시하세요.",
      CTA: "",
      storyBeat: "고객의 구매 전 고민을 채팅 말풍선으로 미리 들려주는 장면"
    },
    problem: {
      headline: "구매 직전 망설임이 남는 이유",
      headline_en: "When hesitation begins",
      subheadline: context.customerPain,
      subheadline_en: "Start from the customer's real hesitation and reveal why this choice matters.",
      bullets: reviewPainPoints.length
        ? reviewPainPoints
        : reviewBackedConcerns.length
          ? reviewBackedConcerns
          : ["반복되는 불편", "구매 전 남는 망설임", "나에게 맞을지 모르는 불안"],
      bullets_en: ["The repeated pain", "The purchase hesitation", "The unresolved concern"],
      trustLine: context.failureLine,
      CTA: "",
      storyBeat: "고객의 문제를 크게 꺼내는 장면"
    },
    bridge: {
      headline: "그래서 기준을 더 분명하게",
      headline_en: "So we fixed it",
      subheadline: context.solutionLine,
      subheadline_en: "Move from empathy into a clear promise of improvement.",
      bullets: [context.customerPain, context.solutionLine, context.proofLine],
      bullets_en: ["The pain is understood", "The solution appears", "The proof stays grounded"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "문제에서 해결책으로 장면이 전환되는 순간"
    },
    guide: {
      headline: `${productLabel}가 해결책이 되는 이유`,
      headline_en: "A simple guide to the solution",
      subheadline: context.solutionLine,
      subheadline_en: "Introduce the product as the guide that reduces the customer's problem.",
      bullets: [productNameLabel, context.detailLine, context.compositionLine],
      bullets_en: ["Product role", "How it helps", "Why it is easy to choose"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "가이드가 등장해 제품을 해결책으로 제시하는 장면"
    },
    value: {
      headline: "선택 이유가 분명해집니다",
      headline_en: "A clearer reason to choose",
      subheadline: context.solutionLine,
      subheadline_en: "Move beyond looking nice and make the core reason easy to understand.",
      bullets: context.supportBullets,
      bullets_en: ["Core value", "Visible product detail", "A reason to choose"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "제품 장점이 고객의 문제와 연결되는 장면"
    },
    plan: {
      headline: "받고 나서 바로 쓰는 간단한 순서",
      headline_en: "Easy from the first moment",
      subheadline: `${planLine}으로 구매 후 사용 장면이 바로 그려집니다.`,
      subheadline_en: "Lower the usage barrier and make the after-purchase moment easy to imagine.",
      bullets: context.planSteps,
      bullets_en: ["Step one", "Step two", "Step three"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "어떻게 해결되는지 구체적으로 보여주는 장면"
    },
    proof: {
      headline: "확인 가능한 정보로 더 안심하게",
      headline_en: "Confidence from visible proof",
      subheadline: context.proofLine,
      subheadline_en: "Build trust only from details that are visible in the reference.",
      bullets: [context.detailLine, context.compositionLine, "구매 전 필요한 정보만 선명하게"],
      bullets_en: ["Visible details", "Verifiable composition", "Information before purchase"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "근거와 확인 정보로 불안을 낮추는 장면"
    },
    compare: {
      headline: "비교할수록 기준은 단순해집니다",
      headline_en: "A clearer standard when compared",
      subheadline: "여러 선택지 사이에서도 무엇을 보고 고르면 되는지 분명해집니다.",
      subheadline_en: "Give shoppers a standard that holds up against alternatives.",
      bullets: ["헷갈리는 대안", "보이는 차이", "후회를 줄이는 기준"],
      bullets_en: ["A standard that reduces confusing alternatives", "Compare by visible differences", "Points that reduce regret"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "비슷한 대안과 비교해 선택 기준을 좁히는 장면"
    },
    detail: {
      headline: "눈으로 확인되는 디테일까지",
      headline_en: "Details you can inspect",
      subheadline: context.detailLine,
      subheadline_en: "Make the material, finish, and shape easy to inspect before purchase.",
      bullets: [context.detailLine, context.compositionLine, context.proofLine],
      bullets_en: ["Detail check", "Product shape", "Visible evidence"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "구매자가 확대해서 보고 싶은 디테일을 확인하는 장면"
    },
    lifestyle: {
      headline: "사용 장면에서 자연스럽게 이해되는 제품",
      headline_en: "A scene that fits real life",
      subheadline: context.successLine,
      subheadline_en: "Help customers imagine the moment after purchase.",
      bullets: ["사용 상황을 한눈에", "제품이 놓일 생활 맥락", "과장 없는 만족 장면"],
      bullets_en: ["A clear usage moment", "The context where the product belongs", "A grounded satisfaction scene"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "구매 후 생활 장면을 상상하게 만드는 장면"
    },
    success: {
      headline: "사용 후 달라지는 장면을 구체적으로",
      headline_en: "The after-purchase change",
      subheadline: context.successLine,
      subheadline_en: "Show the positive change after use through review-like messages.",
      bullets: reviewBenefits.length
        ? reviewBenefits
        : ["사용 전 망설임이 줄어요", "필요한 순간 바로 떠올라요", "일상에서 자연스럽게 쓰여요"],
      bullets_en: ["Review-style change", "Easy to carry", "A moment after use"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "사용 후 변화와 후기형 만족을 보여주는 장면"
    },
    review: {
      headline: customerReviewAnalysis?.reviewCount ? "후기에서 반복된 만족 포인트" : "실제로 써본 고객은 이렇게 말해요",
      headline_en: "Real customer-style testimonials",
      subheadline: reviewBenefitSummary
        ? reviewBenefitSummary
        : `${productLabel}를 사용한 뒤 느낀 만족 포인트를 고객의 말투로 정리합니다.`,
      subheadline_en: "Summarize post-use satisfaction in testimonial cards.",
      bullets: reviewSamples.length
        ? reviewSamples
        : ["생각보다 쓰기 쉬웠어요", "구매 전 고민이 줄었어요", "매일 쓰기 부담이 적었어요", "주변에도 추천하게 됐어요"],
      bullets_en: ["Easy to use", "Reduced hesitation", "Comfortable in daily use", "Worth recommending"],
      trustLine: customerReviewAnalysis?.reviewCount
        ? "반복된 만족 포인트를 짧은 후기 카드로 확인하세요."
        : "별점과 인용문 카드로 사용감을 확인하세요.",
      CTA: "",
      storyBeat: "고객의 실제 사용 후기처럼 별점과 인용문을 정리하는 장면"
    },
    composition: {
      headline: "구성까지 한 번에 확인하세요",
      headline_en: "Check the full configuration",
      subheadline: context.compositionLine,
      subheadline_en: "Group the configuration, colors, and sizes into an easy pre-purchase check.",
      bullets: [context.compositionLine, "옵션과 구성 확인", "구매 전 필요한 정보"],
      bullets_en: ["Included items", "Colors and options", "Information needed before purchase"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "구성품과 옵션을 확인해 마지막 불안을 줄이는 장면"
    },
    disclosure: {
      headline: "구매 전 확인할 정보",
      headline_en: "Information to check before buying",
      subheadline: "주의사항과 구성 정보를 차분하게 확인하고 선택하세요.",
      subheadline_en: "Reduce final hesitation with calm FAQ and product information.",
      bullets: ["주의사항 확인", "구성 및 옵션 안내", "구매 전 마지막 점검"],
      bullets_en: ["Important notices", "Configuration and options", "Editable disclosure information"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "구매 전 확인 정보를 정리하는 장면"
    },
    cta: {
      headline: isFinalBeat ? "지금 선택해야 하는 이유" : context.ctaLine,
      headline_en: "One last reason to choose now",
      subheadline: isFinalBeat
        ? `${productLabel}로 같은 불편을 다시 미루지 마세요.`
        : "바로 쓸 수 있는 이유가 분명할 때 선택하세요.",
      subheadline_en: "Tie the hesitation and value together into a natural purchase action.",
      bullets: isFinalBeat
        ? [context.customerPain, context.solutionLine, context.successLine]
        : [context.planSteps[0], context.planSteps[1], context.planSteps[2]],
      bullets_en: ["Summary of the core value", "Final check before purchase", "A short action-oriented offer"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: isFinalBeat ? "문제와 해결을 묶어 마지막 확신을 주는 장면" : "구매 행동을 제안하는 장면"
    },
    failure: {
      headline: "미루면 해결되지 않는 비용이 남습니다",
      headline_en: "The cost of waiting",
      subheadline: context.failureLine,
      subheadline_en: "Show what the customer loses by not solving the problem.",
      bullets: ["반복되는 불편", "계속되는 선택 피로", "놓치는 사용 장면"],
      bullets_en: ["The repeated discomfort", "The cost of waiting", "The missed moment"],
      trustLine: context.failureLine,
      CTA: "",
      storyBeat: "구매하지 않았을 때 잃는 것을 상기시키는 장면"
    },
    generic: {
      headline: productLabel === "이 제품" ? "이 제품을 선택해야 하는 이유" : `${productLabel}, 선택해야 하는 이유`,
      headline_en: "Why this product is worth choosing",
      subheadline: context.solutionLine,
      subheadline_en: "Connect product context with customer hesitation and guide the next action.",
      bullets: context.supportBullets,
      bullets_en: ["The first hesitation customers feel", "Benefits visible in the product", "A message that makes purchase easier"],
      trustLine: context.proofLine,
      CTA: "",
      storyBeat: "제품 맥락과 구매 이유를 연결하는 장면"
    }
  } satisfies Record<ExpansionCopyRole, {
    headline: string;
    headline_en: string;
    subheadline: string;
    subheadline_en: string;
    bullets: string[];
    bullets_en: string[];
    trustLine: string;
    CTA: string;
    storyBeat: string;
  }>;

  return copyByRole[role];
}

function normalizeCustomerReviewCopyList(values: string[] | undefined, limit: number, maxLength: number) {
  if (!Array.isArray(values)) {
    return [];
  }

  return uniqueCopyLines(
    values
      .map((value) => shortenCopyLine(sanitizeCustomerCopy(value), maxLength))
      .filter(Boolean)
  ).slice(0, limit);
}

// Category-specific concern templates were removed together with the narrative decks:
// they turned another category's usage scenario (sunscreen, socks) into "customer
// concerns" for unrelated products. Only product-neutral conversions remain.
function buildReviewBackedConcernLines(reviewBenefits: string[]) {
  const concerns = reviewBenefits.flatMap((benefit) => {
    const copy = benefit.toLowerCase();

    if (/쿠션|편안|편했|편함/.test(copy)) {
      return ["이전에는 착용감이나 사용감이 오래 신경 쓰이지 않았나요?"];
    }
    if (/쫀쫀|핏|고정|잡아/.test(copy)) {
      return ["사용 중 쉽게 흐트러지거나 맞지 않을까 걱정되지 않았나요?"];
    }
    if (/간편|쉬웠|편리|빠르/.test(copy)) {
      return ["구매해도 막상 쓰기 번거로울까 망설이지 않았나요?"];
    }

    return [];
  });

  return uniqueCopyLines(concerns).slice(0, 5);
}

function pickExpansionHeadline(
  role: ExpansionCopyRole,
  copyPool: string[],
  fallback: string,
  sectionName: string
) {
  const hint = getExpansionRoleHint(role);
  const roleMatchedCopy = hint
    ? copyPool.find((copy) => hint.test(copy))
    : copyPool.find((copy) => !PROBLEM_COPY_HINT.test(copy)) ?? copyPool[0];

  return sanitizeCustomerCopy(roleMatchedCopy, sectionName) || fallback;
}

function pickExpansionSubheadline(
  role: ExpansionCopyRole,
  copyPool: string[],
  headline: string,
  fallback: string,
  sectionName: string
) {
  const hint = getExpansionRoleHint(role);
  const matched = hint
    ? copyPool.find((copy) => copy !== headline && hint.test(copy))
    : copyPool.find((copy) => copy !== headline);
  const next = matched ?? copyPool.find((copy) => copy !== headline);

  return sanitizeCustomerCopy(next, sectionName) || fallback;
}

function getExpansionRoleHint(role: ExpansionCopyRole) {
  if (role === "question" || role === "concernList" || role === "problem" || role === "failure") {
    return PROBLEM_COPY_HINT;
  }
  if (role === "bridge" || role === "guide") {
    return BRIDGE_COPY_HINT;
  }
  if (role === "plan") {
    return PLAN_COPY_HINT;
  }
  if (role === "proof" || role === "disclosure" || role === "success") {
    return PROOF_COPY_HINT;
  }
  if (role === "review") {
    return REVIEW_COPY_HINT;
  }
  if (role === "detail" || role === "composition") {
    return DETAIL_COPY_HINT;
  }
  if (role === "lifestyle") {
    return LIFESTYLE_COPY_HINT;
  }
  if (role === "cta") {
    return CTA_COPY_HINT;
  }

  return null;
}

function buildExpansionBullets(
  role: ExpansionCopyRole,
  copyPool: string[],
  context: SalesNarrativeContext,
  usedCopy: string[],
  fallbackBullets: string[]
) {
  const usedKeys = new Set(usedCopy.map(normalizeCopyKey));
  const heroKeys = new Set([
    normalizeCopyKey(context.heroPromise),
    normalizeCopyKey(context.ctaLine)
  ]);
  const hint = getExpansionRoleHint(role);
  const candidates = uniqueCopyLines(copyPool)
    .filter((copy) => !usedKeys.has(normalizeCopyKey(copy)))
    .filter((copy) => !heroKeys.has(normalizeCopyKey(copy)))
    .filter((copy) => {
      if (!hint) {
        return true;
      }

      return hint.test(copy);
    });

  return uniqueCopyLines([...fallbackBullets, ...candidates, ...context.supportBullets])
    .filter((copy) => !usedKeys.has(normalizeCopyKey(copy)))
    .slice(0, role === "review" ? 4 : role === "concernList" ? 5 : 3);
}

function uniqueCopyLines(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const key = normalizeCopyKey(value);
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(value);
  });

  return result;
}

// Legacy `고객 고민 리스팅`(concernList) copy that older drafts may still store.
// Full-image regeneration reuses the saved headline/subheadline, so we upgrade the
// known stale strings to the current empathetic default on load/add so the next
// regeneration bakes the new copy. Matching is exact (whitespace-collapsed) so user
// edits or already-current copy are never touched.
const LEGACY_CONCERN_LIST_HEADLINE = "후기에서 먼저 보인 고민";
const LEGACY_CONCERN_LIST_SUBHEADLINE = "반복된 아쉬움은 숨기지 않고, 구매 전 확인 포인트로 먼저 풀어줍니다";
const UPGRADED_CONCERN_LIST_COPY = {
  headline: "이런 고민 한 적 있지 않으세요?",
  headline_en: "Why are they hesitating?",
  subheadline: "구매 전 망설였던 포인트를 먼저 공감하고, 다음 섹션에서 답을 보여드립니다.",
  subheadline_en: "List the customer's pre-purchase doubts as short chat bubbles."
};

function collapseWhitespace(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

// Period-tolerant compare: older drafts stored the legacy subheadline both with and
// without a trailing period, so normalize trailing punctuation before matching.
function isLegacyConcernSubheadline(value: string | undefined) {
  const normalize = (text: string | undefined) => collapseWhitespace(text).replace(/[.]+$/, "");
  return normalize(value) === normalize(LEGACY_CONCERN_LIST_SUBHEADLINE);
}

function upgradeLegacyConcernListCopy(section: PdpSection): PdpSection {
  const headlineIsLegacy =
    collapseWhitespace(section.headline) === collapseWhitespace(LEGACY_CONCERN_LIST_HEADLINE);
  const subheadlineIsLegacy = isLegacyConcernSubheadline(section.subheadline);
  const goalIsLegacy = isLegacyConcernSubheadline(section.goal);

  if (!headlineIsLegacy && !subheadlineIsLegacy && !goalIsLegacy) {
    return section;
  }

  const next = { ...section };
  if (headlineIsLegacy) {
    next.headline = UPGRADED_CONCERN_LIST_COPY.headline;
    next.headline_en = UPGRADED_CONCERN_LIST_COPY.headline_en;
  }
  // When the headline is the legacy concern-list line, the whole copy block is legacy,
  // so refresh the subheadline/goal even if their stored punctuation drifted.
  if (headlineIsLegacy || subheadlineIsLegacy) {
    next.subheadline = UPGRADED_CONCERN_LIST_COPY.subheadline;
    next.subheadline_en = UPGRADED_CONCERN_LIST_COPY.subheadline_en;
  }
  if (headlineIsLegacy || goalIsLegacy) {
    next.goal = UPGRADED_CONCERN_LIST_COPY.subheadline;
  }
  return next;
}

function normalizeSectionCopyFields(section: PdpSection) {
  const upgraded = upgradeLegacyConcernListCopy(section);
  const { on_image_text: _legacyOnImageText, ...rest } =
    upgraded as PdpSection & { on_image_text?: string };

  return {
    ...rest,
    headline_en: upgraded.headline_en || upgraded.headline,
    subheadline_en: upgraded.subheadline_en || upgraded.subheadline,
    bullets_en: Array.isArray(upgraded.bullets_en) && upgraded.bullets_en.length ? upgraded.bullets_en : upgraded.bullets,
    trust_or_objection_line_en: upgraded.trust_or_objection_line_en || upgraded.trust_or_objection_line,
    CTA_en: upgraded.CTA_en || upgraded.CTA
  };
}

// Older drafts expanded by the local fallback baked another category's template copy —
// running-socks lines (e.g. "발을 잡아주는 쫀쫀한 핏") or the retired waterproof-sunscreen
// deck (e.g. "야외 활동 전, 선크림부터 챙기세요") — into unrelated products.
// `handleGenerateImage` reuses the saved section copy verbatim, so regeneration keeps
// re-baking the wrong copy. We re-derive ONLY the contaminated sections from clean context
// (hero + blueprint); the narrative context is now always generic, so the re-derived copy
// cannot carry foreign-category claims again.
//
// Sock detection is two-tier to avoid false positives on legitimate foot-care/beauty copy:
//  - DISTINCTIVE tokens (양말/삭스/socks/"쫀쫀한 핏") never appear in sunscreen/beauty copy.
//  - FOOT-ANATOMY tokens (착지/발바닥/뒤꿈치…) CAN appear in real foot-care products, so they
//    only count as contamination when a running keyword (러닝/마라톤…) is in the same section.
const SOCK_DISTINCTIVE_PATTERN = /양말|삭스|socks?|쫀쫀한?\s*핏/i;
const SOCK_FOOT_ANATOMY_PATTERN = /착지|발바닥|뒤꿈치|물집|발을\s*잡아|발\s*안에서\s*밀/;
const SOCK_RUNNING_PATTERN = /러닝|런닝|마라톤|조깅|러너/;

// Fixed sentences that only the retired sunscreen/sun-patch decks produced. LLM copy for a
// real sunscreen product does not reproduce these template lines verbatim, and the hero
// product-term guard below keeps genuine sun-care drafts untouched anyway.
const SUNSCREEN_DECK_PATTERN =
  /워터프루프\s*선크림|물놀이와\s*야외\s*활동\s*전\s*챙기기\s*좋은|선크림부터\s*챙기세요|물놀이\s*전,?\s*선크림이\s*먼저|물과\s*땀\s*앞에서도\s*챙기는|야외\s*활동\s*전\s*바르는\s*선크림|패키지에서\s*확인하는\s*spf\/pa|spf\/pa\s*표기와\s*워터프루프|선크림\s*걱정보다|선크림이\s*쉽게\s*지워질까|물놀이\s*중\s*쉽게\s*지워지면|spf\/pa\s*표기를\s*믿고|the\s*panol|얼굴에\s*붙이는\s*선\s*패치|붙여\s*쓰는\s*데일리\s*선\s*패치/i;
const SUNSCREEN_PRODUCT_TERM_PATTERN =
  /선\s*크림|썬\s*크림|선스크린|sunscreen|sun\s*cream|자외선\s*차단제|선\s*케어|sun\s*care|선\s*패치|썬\s*패치|sun\s*patch/i;

function sectionCopyHaystack(section: PdpSection) {
  return [
    section.headline,
    section.subheadline,
    section.goal,
    ...(Array.isArray(section.bullets) ? section.bullets : []),
    section.trust_or_objection_line,
    section.CTA
  ]
    .filter(Boolean)
    .join(" ");
}

function sectionHasSockFallbackContamination(section: PdpSection) {
  const haystack = sectionCopyHaystack(section);

  if (SOCK_DISTINCTIVE_PATTERN.test(haystack)) {
    return true;
  }

  return SOCK_FOOT_ANATOMY_PATTERN.test(haystack) && SOCK_RUNNING_PATTERN.test(haystack);
}

function sectionHasSunscreenFallbackContamination(section: PdpSection) {
  return SUNSCREEN_DECK_PATTERN.test(sectionCopyHaystack(section));
}

type DraftCopyHealDeps = {
  blueprintSummary?: string;
  blueprintList?: string[];
  additionalInfo?: string;
  customerReviewAnalysis?: PdpCustomerReviewAnalysis | null;
};

function healLocalFallbackSectionCopy<T extends PdpSection>(sections: T[], deps: DraftCopyHealDeps): T[] {
  if (sections.length <= 1) {
    return sections;
  }

  const heroSection = sections[0];
  // The hero is server-generated from the user's real product and anchors re-derivation.
  // If the hero (or the user's own additionalInfo) carries a category's markers, the
  // product probably IS that category — never treat that marker class as contamination.
  const heroHaystack = `${sectionCopyHaystack(heroSection)} ${deps.additionalInfo ?? ""}`;
  const canHealSock =
    !SOCK_DISTINCTIVE_PATTERN.test(heroHaystack) && !SOCK_RUNNING_PATTERN.test(heroHaystack);
  const canHealSunscreen =
    !SUNSCREEN_PRODUCT_TERM_PATTERN.test(heroHaystack) && !SUNSCREEN_DECK_PATTERN.test(heroHaystack);

  if (!canHealSock && !canHealSunscreen) {
    return sections;
  }

  const isContaminated = (section: PdpSection) =>
    (canHealSock && sectionHasSockFallbackContamination(section)) ||
    (canHealSunscreen && sectionHasSunscreenFallbackContamination(section));

  // Non-contaminated sections (always incl. the server-generated hero) form the clean copy
  // pool used for re-derivation, so template phrases are never fed back into the new copy.
  const cleanContextSections = sections.filter((section) => !isContaminated(section));
  const contextSections: PdpSection[] = cleanContextSections.length ? cleanContextSections : [heroSection];

  let healed = false;
  const next = sections.map((section, index) => {
    // Hero copy is server-generated and anchors the clean pool; never re-derive it.
    if (index === 0 || !isContaminated(section)) {
      return section;
    }

    const rederived = buildExpansionSectionCopy({
      heroSection,
      contextSections,
      sectionId: section.section_id,
      sectionName: section.section_name,
      goal: section.goal,
      strategyTitle: "상세페이지 서사 보강",
      sectionIndex: index + 1,
      totalSections: sections.length,
      isLastSection: index === sections.length - 1,
      additionalInfo: deps.additionalInfo,
      blueprintSummary: deps.blueprintSummary,
      blueprintList: deps.blueprintList,
      customerReviewAnalysis: deps.customerReviewAnalysis
    });

    healed = true;
    // Replace only the copy + image-prompt fields; keep section_id/section_name/image_id,
    // style_guide, negative_prompt, reference_usage, compliance_notes and the already-baked
    // generatedImage (한이룸님 presses 이미지 다시 만들기 to re-bake the corrected copy).
    return {
      ...section,
      goal: rederived.goal,
      headline: rederived.headline,
      headline_en: rederived.headline_en,
      subheadline: rederived.subheadline,
      subheadline_en: rederived.subheadline_en,
      bullets: rederived.bullets,
      bullets_en: rederived.bullets_en ?? rederived.bullets,
      trust_or_objection_line: rederived.trust_or_objection_line,
      trust_or_objection_line_en: rederived.trust_or_objection_line_en,
      CTA: rederived.CTA,
      CTA_en: rederived.CTA_en,
      layout_notes: rederived.layout_notes,
      purpose: rederived.purpose,
      prompt_ko: rederived.prompt_ko,
      prompt_en: rederived.prompt_en
    } as T;
  });

  return healed ? next : sections;
}

function getLocalizedCopy(korean: string, english: string | undefined, language: PdpCopyLanguage) {
  if (language === "en") {
    return english?.trim() || korean;
  }

  return korean;
}

function getLocalizedBullets(section: GeneratedResult["blueprint"]["sections"][number], language: PdpCopyLanguage) {
  if (language === "en" && Array.isArray(section.bullets_en) && section.bullets_en.length) {
    return section.bullets_en;
  }

  return section.bullets;
}

function getDisplaySectionName(section: GeneratedResult["blueprint"]["sections"][number]) {
  if (containsHangul(section.section_name)) {
    return section.section_name;
  }

  const normalized = section.section_name.replace(/^S\d+[_-]?/i, "");
  const tokens = normalized.split(/[_-]+/).filter(Boolean);

  if (!tokens.length) {
    return section.section_name;
  }

  const mappedTokens = tokens.map((token) => translateSectionToken(token));

  if (mappedTokens.length >= 2 && mappedTokens[0] === "핵심 장점" && /^\d+$/.test(tokens[1] ?? "")) {
    const descriptor = mappedTokens.slice(2).join(" ");
    return descriptor ? `핵심 장점 ${tokens[1]} · ${descriptor}` : `핵심 장점 ${tokens[1]}`;
  }

  return mappedTokens.join(" ");
}

function getDisplaySectionGoal(section: GeneratedResult["blueprint"]["sections"][number]) {
  if (containsHangul(section.goal)) {
    return section.goal;
  }

  if (containsHangul(section.headline)) {
    return section.headline;
  }

  if (containsHangul(section.subheadline)) {
    return section.subheadline;
  }

  return section.goal;
}

function getModelGenderLabel(gender?: ImageGenOptions["modelGender"]) {
  return gender === "male" ? "남자 모델" : "여자 모델";
}

function getModelAgeLabel(ageRange?: ImageGenOptions["modelAgeRange"]) {
  if (ageRange === "teen") {
    return "10대 후반";
  }
  if (ageRange === "30s") {
    return "30대";
  }
  if (ageRange === "40s") {
    return "40대";
  }
  if (ageRange === "50s_plus") {
    return "50대+";
  }

  return "20대";
}

function getModelCountryLabel(country?: ImageGenOptions["modelCountry"]) {
  if (country === "japan") {
    return "일본";
  }
  if (country === "usa") {
    return "미국";
  }
  if (country === "france") {
    return "프랑스";
  }
  if (country === "germany") {
    return "독일";
  }
  if (country === "africa") {
    return "아프리카";
  }

  return "한국";
}

function containsHangul(value: string) {
  return /[가-힣]/.test(value);
}

function translateSectionToken(token: string) {
  const normalized = token.trim().toLowerCase();

  if (normalized === "hero") {
    return "히어로";
  }
  if (normalized === "question") {
    return "공감 질문";
  }
  if (normalized === "bridge") {
    return "전환 선언";
  }
  if (normalized === "benefit") {
    return "핵심 장점";
  }
  if (normalized === "problem" || normalized === "concern") {
    return "문제 공감";
  }
  if (normalized === "concernlist" || normalized === "customerconcern") {
    return "고객 고민";
  }
  if (normalized === "evidence") {
    return "근거";
  }
  if (normalized === "review" || normalized === "reviews") {
    return "후기";
  }
  if (normalized === "routine" || normalized === "howto" || normalized === "usage") {
    return "사용법";
  }
  if (normalized === "lifestyle") {
    return "사용 장면";
  }
  if (normalized === "detail") {
    return "디테일";
  }
  if (normalized === "composition" || normalized === "configuration") {
    return "제품 구성";
  }
  if (normalized === "disclosure" || normalized === "spec") {
    return "상품정보 확인";
  }
  if (normalized === "checklist") {
    return "체크리스트";
  }
  if (normalized === "cta") {
    return "구매 유도";
  }
  if (normalized === "windproof") {
    return "방풍";
  }
  if (normalized === "lightweight") {
    return "경량";
  }
  if (normalized === "style") {
    return "스타일";
  }
  if (normalized === "waterproof") {
    return "방수";
  }
  if (normalized === "comfort") {
    return "편안함";
  }
  if (normalized === "fit") {
    return "핏";
  }

  return /^\d+$/.test(token) ? token : token;
}
