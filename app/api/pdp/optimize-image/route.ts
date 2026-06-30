import { NextResponse } from "next/server";
import sharp from "sharp";
import type { PdpAnalysisImageMetadata, PdpAnalysisStrip } from "@runacademy/shared";

export const runtime = "nodejs";

const STANDARD_ANALYSIS_MAX_DIMENSION = 1024;
const STANDARD_GENERATION_MAX_DIMENSION = 2048;
const OVERSIZED_STANDARD_MIN_PIXELS = 20_000_000;
const OVERSIZED_STANDARD_MAX_DIMENSION = 4096;
const LONG_DETAIL_MIN_HEIGHT = 3200;
const LONG_DETAIL_MIN_RATIO = 4.5;
// Approach A v2: legible vertical strips replace the lossy "sample board".
const LONG_DETAIL_STRIP_WIDTH = 1536; // max strip pixel width
const LONG_DETAIL_STRIP_REDUCTION = 2.5; // target downscale of source width
const LONG_DETAIL_STRIP_SHORT_SIDE_MAX = 768; // keep shortest side <=768 so OpenAI does not re-downscale
const LONG_DETAIL_MIN_STRIPS = 4;
const LONG_DETAIL_MAX_STRIPS = 16;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const MAX_INPUT_PIXELS = 260_000_000;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const allowLongPageSampling = formData.get("allowLongPageSampling") !== "false";

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, message: "이미지 파일이 없습니다." }, { status: 400 });
    }

    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ ok: false, message: "이미지 파일만 업로드할 수 있습니다." }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, message: "이미지 파일이 너무 큽니다. 60MB 이하 파일로 다시 시도해 주세요." },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();

    if (!metadata.width || !metadata.height) {
      return NextResponse.json({ ok: false, message: "이미지 크기를 읽지 못했습니다." }, { status: 400 });
    }

    const optimized = allowLongPageSampling && isLongDetailPage(metadata.width, metadata.height)
      ? await buildLongDetailStrips(buffer, file.name, file.size, metadata.width, metadata.height)
      : isOversizedStandardImage(metadata.width, metadata.height)
        ? await buildStandardImagePayload(buffer, file.name, file.size, metadata.width, metadata.height)
        : buildOriginalImagePayload(buffer, file.name, file.size, file.type, metadata.width, metadata.height);

    return NextResponse.json({ ok: true, image: optimized });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: "이미지를 최적화하지 못했습니다.",
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      },
      { status: 500 }
    );
  }
}

function buildOriginalImagePayload(
  source: Buffer,
  fileName: string,
  originalBytes: number,
  mimeType: string,
  originalWidth: number,
  originalHeight: number
) {
  const normalizedMimeType = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  const base64 = source.toString("base64");
  const analysisMetadata: PdpAnalysisImageMetadata = {
    mode: "original",
    originalWidth,
    originalHeight,
    optimizedWidth: originalWidth,
    optimizedHeight: originalHeight,
    originalBytes,
    optimizedBytes: originalBytes
  };

  return {
    base64,
    mimeType: normalizedMimeType,
    fileName,
    generationBase64: base64,
    generationMimeType: normalizedMimeType,
    analysisMetadata
  };
}

async function buildStandardImagePayload(
  source: Buffer,
  fileName: string,
  originalBytes: number,
  sourceWidth: number,
  sourceHeight: number
) {
  const analysis = await resizeToJpegPayload(source, sourceWidth, sourceHeight, STANDARD_ANALYSIS_MAX_DIMENSION, 84);
  const generationReference = await resizeToJpegPayload(source, sourceWidth, sourceHeight, STANDARD_GENERATION_MAX_DIMENSION, 90);
  const analysisMetadata: PdpAnalysisImageMetadata = {
    mode: "standard-resize",
    originalWidth: sourceWidth,
    originalHeight: sourceHeight,
    optimizedWidth: analysis.width,
    optimizedHeight: analysis.height,
    originalBytes,
    optimizedBytes: analysis.buffer.byteLength,
    generationReferenceWidth: generationReference.width,
    generationReferenceHeight: generationReference.height
  };

  return {
    base64: analysis.buffer.toString("base64"),
    mimeType: "image/jpeg" as const,
    fileName,
    generationBase64: generationReference.buffer.toString("base64"),
    generationMimeType: "image/jpeg" as const,
    analysisMetadata
  };
}

/**
 * Approach A v2: split a long detail page into ORDER-PRESERVING legible strips instead of
 * squishing it into one tiny board. Each strip downscales the source width by ~2.5x and keeps
 * its shortest side <= 768 so neither Gemini nor OpenAI re-downscales it. Strips are gap-free and
 * non-overlapping in source-Y, so [yStartRatio, yEndRatio] tile [0,1] exactly — the analyze server
 * uses those ratios to attach the strips top-to-bottom AND to crop productCutRegion for the hero
 * reference. The old "top 18% crop" generation reference is gone.
 */
async function buildLongDetailStrips(
  source: Buffer,
  fileName: string,
  originalBytes: number,
  sourceWidth: number,
  sourceHeight: number
) {
  // Downscale width by ~LONG_DETAIL_STRIP_REDUCTION (never upscale), capped at LONG_DETAIL_STRIP_WIDTH.
  const stripWidth = Math.max(
    1,
    Math.min(LONG_DETAIL_STRIP_WIDTH, Math.round(sourceWidth / LONG_DETAIL_STRIP_REDUCTION))
  );
  const widthReduction = sourceWidth / stripWidth;
  // Keep each strip's shortest side <= LONG_DETAIL_STRIP_SHORT_SIDE_MAX (wide-short tile); derive
  // the strip count from that, then split the height into equal gap-free bands.
  const maxBandHeight = Math.max(1, Math.round(LONG_DETAIL_STRIP_SHORT_SIDE_MAX * widthReduction));
  const stripCount = Math.min(
    LONG_DETAIL_MAX_STRIPS,
    Math.max(LONG_DETAIL_MIN_STRIPS, Math.ceil(sourceHeight / maxBandHeight))
  );
  const bandHeight = Math.ceil(sourceHeight / stripCount);

  const strips: PdpAnalysisStrip[] = [];
  let optimizedBytes = 0;
  let totalStripHeight = 0;
  let maxStripHeight = 0;

  for (let index = 0; index < stripCount; index += 1) {
    const top = index * bandHeight;
    if (top >= sourceHeight) {
      break;
    }
    const bandPx = Math.min(bandHeight, sourceHeight - top);
    const stripHeight = Math.max(1, Math.round((bandPx * stripWidth) / sourceWidth));
    const buffer = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
      .extract({ left: 0, top, width: sourceWidth, height: bandPx })
      .resize(stripWidth, stripHeight, { fit: "fill" })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    optimizedBytes += buffer.byteLength;
    totalStripHeight += stripHeight;
    maxStripHeight = Math.max(maxStripHeight, stripHeight);
    strips.push({
      base64: buffer.toString("base64"),
      mimeType: "image/jpeg",
      yStartRatio: top / sourceHeight,
      yEndRatio: (top + bandPx) / sourceHeight
    });
  }

  if (maxStripHeight > LONG_DETAIL_STRIP_SHORT_SIDE_MAX) {
    // Ultra-tall page: the capped strip count forces taller strips; OpenAI may re-downscale these.
    console.warn(
      `[optimize-image] long-detail strips exceed short-side cap: ${maxStripHeight}px > ${LONG_DETAIL_STRIP_SHORT_SIDE_MAX}px ` +
        `(source ${sourceWidth}x${sourceHeight}, ${strips.length} strips, ~${widthReduction.toFixed(2)}x width reduction)`
    );
  }

  // Primary single-image fallback = first strip. Provisional generation reference = a mid-document
  // strip (NOT the top, to avoid banners). The analyze server crops productCutRegion from the strips
  // for the real hero reference; these are only used if strips/region are unavailable downstream.
  const firstStrip = strips[0];
  const midStrip = strips[Math.floor(strips.length / 2)] ?? firstStrip;
  const analysisMetadata: PdpAnalysisImageMetadata = {
    mode: "long-detail-strips",
    originalWidth: sourceWidth,
    originalHeight: sourceHeight,
    optimizedWidth: stripWidth,
    optimizedHeight: totalStripHeight,
    originalBytes,
    optimizedBytes,
    stripCount: strips.length,
    stripWidth,
    reductionFactor: LONG_DETAIL_STRIP_REDUCTION,
    actualReduction: widthReduction
  };

  return {
    base64: firstStrip?.base64 ?? "",
    mimeType: "image/jpeg" as const,
    fileName,
    generationBase64: midStrip?.base64 ?? firstStrip?.base64 ?? "",
    generationMimeType: "image/jpeg" as const,
    analysisStrips: strips,
    analysisMetadata
  };
}

async function resizeToJpegPayload(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
  quality: number
) {
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight, 1));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const buffer = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(width, height, { fit: "fill" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  return { buffer, width, height };
}

function isLongDetailPage(width: number, height: number) {
  return height >= LONG_DETAIL_MIN_HEIGHT && height / Math.max(width, 1) >= LONG_DETAIL_MIN_RATIO;
}

function isOversizedStandardImage(width: number, height: number) {
  return width * height >= OVERSIZED_STANDARD_MIN_PIXELS || Math.max(width, height) >= OVERSIZED_STANDARD_MAX_DIMENSION;
}
