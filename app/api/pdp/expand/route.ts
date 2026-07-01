import type { PdpExpandRequest } from "@runacademy/shared";
import { PdpController } from "../../../../lib/pdp-server/pdp.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const pdpController = new PdpController();

export async function POST(request: Request) {
  let body: PdpExpandRequest;
  try {
    body = (await request.json()) as PdpExpandRequest;
  } catch {
    return Response.json(
      { ok: false, code: "INVALID_REQUEST", message: "요청 본문을 해석하지 못했습니다." },
      { status: 400 }
    );
  }

  const geminiApiKeyOverride = request.headers.get("x-gemini-api-key") ?? undefined;
  const openAiApiKeyOverride = request.headers.get("x-openai-api-key") ?? undefined;
  const response = await pdpController.expand(body, geminiApiKeyOverride, openAiApiKeyOverride);

  return Response.json(response, {
    status: response.ok ? 200 : mapErrorCodeToStatus((response as { code?: string }).code)
  });
}

function mapErrorCodeToStatus(code?: string) {
  switch (code) {
    case "INVALID_IMAGE_PAYLOAD":
    case "INVALID_REQUEST":
      return 400;
    case "GEMINI_API_KEY_MISSING":
    case "GEMINI_API_KEY_INVALID":
    case "OPENAI_API_KEY_MISSING":
    case "OPENAI_API_KEY_INVALID":
      return 401;
    case "GEMINI_MODEL_ACCESS_DENIED":
    case "OPENAI_MODEL_ACCESS_DENIED":
      return 403;
    case "GEMINI_QUOTA_EXCEEDED":
    case "OPENAI_QUOTA_EXCEEDED":
      return 429;
    default:
      return 500;
  }
}
