import type { AspectRatio, PdpAnalysisImageMetadata, PdpAnalysisStrip, PdpValidateApiKeyResponse } from "@runacademy/shared";
import { resolveGeminiApiKeyHeaderValue, resolveOpenAiApiKeyHeaderValue } from "./pdp-settings";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

export const RATIO_OPTIONS: Array<{
  value: AspectRatio;
  label: string;
  description: string;
  icon: "square" | "portrait" | "phone" | "landscape" | "wide";
}> = [
  { value: "1:1", label: "정방형", description: "썸네일, 마켓 대표 이미지", icon: "square" },
  { value: "3:4", label: "일반 세로", description: "상세페이지 기본형", icon: "portrait" },
  { value: "9:16", label: "모바일 세로", description: "모바일 집중형 상세페이지", icon: "phone" },
  { value: "4:3", label: "일반 가로", description: "배너, 중간 섹션 컷", icon: "landscape" },
  { value: "16:9", label: "와이드", description: "히어로 배너형", icon: "wide" }
];

export const TONE_OPTIONS = [
  "AI 자동 추천",
  "프리미엄",
  "모던",
  "테크",
  "미니멀",
  "팝아트",
  "인스타감성",
  "레트로"
];

// Default request timeout. Generation calls (analyze/images/customer-reviews) pass
// GENERATION_API_TIMEOUT_MS because paid image generation can legitimately take minutes.
export const DEFAULT_API_TIMEOUT_MS = 120_000;
export const GENERATION_API_TIMEOUT_MS = 240_000;

export async function apiJson<T>(
  path: string,
  init?: RequestInit,
  options?: { geminiApiKey?: string | null; openAiApiKey?: string | null; timeoutMs?: number }
): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Content-Type", "application/json");

  const customGeminiApiKey =
    typeof options?.geminiApiKey === "string"
      ? resolveGeminiApiKeyHeaderValue({
          customGeminiApiKey: options.geminiApiKey,
          customOpenAiApiKey: "",
          preferredAiProvider: ""
        })
      : resolveGeminiApiKeyHeaderValue();
  if (customGeminiApiKey) {
    headers.set("X-Gemini-Api-Key", customGeminiApiKey);
  }

  const customOpenAiApiKey =
    typeof options?.openAiApiKey === "string"
      ? resolveOpenAiApiKeyHeaderValue({
          customGeminiApiKey: "",
          customOpenAiApiKey: options.openAiApiKey,
          preferredAiProvider: ""
        })
      : resolveOpenAiApiKeyHeaderValue();
  if (customOpenAiApiKey) {
    headers.set("X-OpenAI-Api-Key", customOpenAiApiKey);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal
    });
  } catch (error) {
    // A timeout surfaces as an AbortError; turn it into an actionable message instead
    // of a generic network failure so the user knows to retry rather than reload blindly.
    if (controller.signal.aborted) {
      throw new Error(
        `요청이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 자동으로 중단했어요. 잠시 후 다시 시도해 주세요.`
      );
    }
    throw error instanceof Error ? error : new Error("API 서버와 통신하지 못했습니다.");
  } finally {
    clearTimeout(timeoutId);
  }

  // Read the body as text first so a non-JSON response (e.g. a 502/504 HTML gateway
  // page or an empty body) becomes a descriptive error carrying the real HTTP status,
  // instead of a bare `SyntaxError` that hides the actual cause. Valid JSON — including
  // structured `{ ok: false, ... }` error payloads — is returned unchanged so callers
  // that inspect `body.ok` keep working exactly as before.
  const rawBody = await response.text();
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    const snippet = rawBody.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      `API 서버가 올바른 응답(JSON)을 반환하지 않았어요 (HTTP ${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      }).${snippet ? ` 응답 내용: ${snippet}` : ""}`
    );
  }
}

export async function validateGeminiApiKey(geminiApiKey: string) {
  return apiJson<PdpValidateApiKeyResponse>(
    "/pdp/validate-key",
    {
      method: "GET"
    },
    { geminiApiKey }
  );
}

export async function validateOpenAiApiKey(openAiApiKey: string) {
  return apiJson<PdpValidateApiKeyResponse>(
    "/pdp/validate-openai-key",
    {
      method: "GET"
    },
    { openAiApiKey }
  );
}

export function toDataUrl(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
}

const STANDARD_ANALYSIS_MAX_DIMENSION = 1024;
const STANDARD_GENERATION_MAX_DIMENSION = 2048;
const OVERSIZED_STANDARD_MIN_PIXELS = 20_000_000;
const OVERSIZED_STANDARD_MAX_DIMENSION = 4096;
const LONG_DETAIL_MIN_HEIGHT = 3200;
const LONG_DETAIL_MIN_RATIO = 4.5;

export async function prepareImageFile(file: File, options?: { allowLongPageSampling?: boolean }) {
  const headerDimensions = await readImageDimensions(file).catch(() => null);
  const allowLongPageSampling = options?.allowLongPageSampling !== false;

  if (
    headerDimensions &&
    (isOversizedStandardImage(headerDimensions.width, headerDimensions.height) ||
      (allowLongPageSampling && isLongDetailPage(headerDimensions.width, headerDimensions.height)))
  ) {
    return optimizeImageFileOnServer(file, allowLongPageSampling);
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const sourceImage = await loadImage(sourceDataUrl);
  const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
  const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
  const shouldSampleLongPage = allowLongPageSampling && isLongDetailPage(sourceWidth, sourceHeight);

  if (shouldSampleLongPage) {
    // Approach A v2: long detail pages are ALWAYS optimized server-side into legible strips.
    // (The old client-side "sample board" builder has been removed.)
    return optimizeImageFileOnServer(file, allowLongPageSampling);
  }

  if (isOversizedStandardImage(sourceWidth, sourceHeight)) {
    return buildStandardImagePayload(sourceImage, file);
  }

  return buildOriginalImagePayload(sourceDataUrl, sourceWidth, sourceHeight, file);
}

type PreparedImagePayloadLike = {
  base64: string;
  mimeType: string;
  fileName: string;
  analysisMetadata?: PdpAnalysisImageMetadata;
};

export function needsPreparedImageReoptimization(image: PreparedImagePayloadLike) {
  const metadata = image.analysisMetadata;

  if (!metadata || metadata.mode !== "original") {
    return false;
  }

  return (
    isOversizedStandardImage(metadata.originalWidth, metadata.originalHeight) ||
    isOversizedStandardImage(metadata.optimizedWidth, metadata.optimizedHeight)
  );
}

export async function reoptimizePreparedImagePayload(
  image: PreparedImagePayloadLike,
  options?: { allowLongPageSampling?: boolean }
) {
  const blob = base64ToBlob(image.base64, image.mimeType);
  const file = new File([blob], image.fileName || "image", {
    type: image.mimeType
  });

  return prepareImageFile(file, options);
}

/**
 * Reads the legible long-detail strips off a freshly-prepared image (Approach A v2).
 * Strips are transient (only present after a server optimize this session) and are NOT
 * persisted to drafts, so this uses structural access rather than the PreparedImageDraft type.
 */
export function getPreparedImageStrips(image: unknown): PdpAnalysisStrip[] | undefined {
  const strips = (image as { analysisStrips?: PdpAnalysisStrip[] } | null | undefined)?.analysisStrips;
  return Array.isArray(strips) && strips.length > 0 ? strips : undefined;
}

async function optimizeImageFileOnServer(file: File, allowLongPageSampling: boolean) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("allowLongPageSampling", String(allowLongPageSampling));

  const response = await fetch(`${API_BASE_URL}/pdp/optimize-image`, {
    method: "POST",
    body: formData
  });
  const payload = await response.json() as
    | {
        ok: true;
        image: {
          base64: string;
          mimeType: string;
          fileName: string;
          generationBase64?: string;
          generationMimeType?: string;
          analysisStrips?: PdpAnalysisStrip[];
          analysisMetadata?: PdpAnalysisImageMetadata;
        };
      }
    | { ok: false; message?: string; detail?: string };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.ok ? "이미지를 최적화하지 못했습니다." : payload.message ?? "이미지를 최적화하지 못했습니다.");
  }

  return {
    ...payload.image,
    previewUrl: toDataUrl(payload.image.mimeType, payload.image.base64),
    generationPreviewUrl:
      payload.image.generationBase64 && payload.image.generationMimeType
        ? toDataUrl(payload.image.generationMimeType, payload.image.generationBase64)
        : undefined
  };
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType || "image/jpeg" });
}

function buildOriginalImagePayload(sourceDataUrl: string, sourceWidth: number, sourceHeight: number, file: File) {
  const parsed = parseImageDataUrl(sourceDataUrl, file);
  const analysisMetadata: PdpAnalysisImageMetadata = {
    mode: "original",
    originalWidth: sourceWidth,
    originalHeight: sourceHeight,
    optimizedWidth: sourceWidth,
    optimizedHeight: sourceHeight,
    originalBytes: file.size,
    optimizedBytes: file.size
  };

  return {
    base64: parsed.base64,
    mimeType: parsed.mimeType,
    previewUrl: sourceDataUrl,
    fileName: file.name,
    generationBase64: parsed.base64,
    generationMimeType: parsed.mimeType,
    generationPreviewUrl: sourceDataUrl,
    analysisMetadata
  };
}

function buildStandardImagePayload(sourceImage: HTMLImageElement, file: File) {
  const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
  const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
  const analysisPayload = resizeImageToJpegPayload(sourceImage, STANDARD_ANALYSIS_MAX_DIMENSION, 0.84);
  const generationReference = resizeImageToJpegPayload(sourceImage, STANDARD_GENERATION_MAX_DIMENSION, 0.9);
  const analysisMetadata: PdpAnalysisImageMetadata = {
    mode: "standard-resize",
    originalWidth: sourceWidth,
    originalHeight: sourceHeight,
    optimizedWidth: analysisPayload.width,
    optimizedHeight: analysisPayload.height,
    originalBytes: file.size,
    optimizedBytes: analysisPayload.bytes,
    generationReferenceWidth: generationReference.width,
    generationReferenceHeight: generationReference.height
  };

  return {
    base64: analysisPayload.base64,
    mimeType: "image/jpeg" as const,
    previewUrl: analysisPayload.previewUrl,
    fileName: file.name,
    generationBase64: generationReference.base64,
    generationMimeType: "image/jpeg" as const,
    generationPreviewUrl: generationReference.previewUrl,
    analysisMetadata
  };
}

function parseImageDataUrl(sourceDataUrl: string, file: File) {
  const match = sourceDataUrl.match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    throw new Error("이미지 데이터를 읽지 못했습니다.");
  }

  return {
    mimeType: file.type.startsWith("image/") ? file.type : match[1],
    base64: match[2]
  };
}


function resizeImageToJpegPayload(sourceImage: HTMLImageElement, maxDimension: number, quality: number) {
  const sourceWidth = sourceImage.naturalWidth || sourceImage.width;
  const sourceHeight = sourceImage.naturalHeight || sourceImage.height;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight, 1));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("이미지 캔버스를 초기화하지 못했습니다.");
  }

  context.drawImage(sourceImage, 0, 0, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);

  return canvasToJpegPayload(canvas, quality);
}

function isLongDetailPage(width: number, height: number) {
  return height >= LONG_DETAIL_MIN_HEIGHT && height / Math.max(width, 1) >= LONG_DETAIL_MIN_RATIO;
}

function isOversizedStandardImage(width: number, height: number) {
  return width * height >= OVERSIZED_STANDARD_MIN_PIXELS || Math.max(width, height) >= OVERSIZED_STANDARD_MAX_DIMENSION;
}


function canvasToJpegPayload(canvas: HTMLCanvasElement, quality: number) {
  const previewUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = previewUrl.split(",")[1] ?? "";

  if (!base64) {
    throw new Error("이미지 변환 결과가 비어 있습니다.");
  }

  return {
    base64,
    previewUrl,
    width: canvas.width,
    height: canvas.height,
    bytes: estimateBase64Bytes(base64)
  };
}

function estimateBase64Bytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

async function readImageDimensions(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());

  if (isPng(bytes)) {
    return {
      width: readUint32(bytes, 16),
      height: readUint32(bytes, 20)
    };
  }

  if (isJpeg(bytes)) {
    const dimensions = readJpegDimensions(bytes);
    if (dimensions) {
      return dimensions;
    }
  }

  return null;
}

function isPng(bytes: Uint8Array) {
  return (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function readJpegDimensions(bytes: Uint8Array) {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (bytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0x01) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    const segmentLength = readUint16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }

    if (isJpegStartOfFrame(marker)) {
      return {
        height: readUint16(bytes, offset + 3),
        width: readUint16(bytes, offset + 5)
      };
    }

    offset += segmentLength;
  }

  return null;
}

function isJpegStartOfFrame(marker: number) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readUint16(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) + bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 256 ** 3 +
    bytes[offset + 1] * 256 ** 2 +
    bytes[offset + 2] * 256 +
    bytes[offset + 3]
  );
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

async function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    image.src = src;
  });
}
