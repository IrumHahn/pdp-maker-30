import type { PdpAnalyzeCustomerReviewsRequest, PdpAnalyzeRequest, PdpExpandRequest, PdpGenerateImageRequest } from "../shared";
import { PdpService, PdpServiceError, toPdpErrorResponse } from "./pdp.service";

export class PdpController {
  constructor(private readonly pdpService = new PdpService()) {}

  async validateApiKey(geminiApiKeyOverride?: string) {
    try {
      const result = await this.pdpService.validateGeminiApiKey(geminiApiKeyOverride);
      return {
        ok: true as const,
        ...result
      };
    } catch (error) {
      return toPdpErrorResponse(error);
    }
  }

  async validateOpenAiApiKey(openAiApiKeyOverride?: string) {
    try {
      const result = await this.pdpService.validateOpenAiApiKey(openAiApiKeyOverride);
      return {
        ok: true as const,
        ...result
      };
    } catch (error) {
      return toPdpErrorResponse(error);
    }
  }

  async analyze(body: PdpAnalyzeRequest, geminiApiKeyOverride?: string, openAiApiKeyOverride?: string) {
    try {
      const result = await this.pdpService.analyzeProduct(body, geminiApiKeyOverride, openAiApiKeyOverride);
      return {
        ok: true as const,
        result
      };
    } catch (error) {
      return toPdpErrorResponse(error);
    }
  }

  async expand(body: PdpExpandRequest, geminiApiKeyOverride?: string, openAiApiKeyOverride?: string) {
    try {
      return await this.pdpService.expandLandingPage(body, geminiApiKeyOverride, openAiApiKeyOverride);
    } catch (error) {
      return toPdpErrorResponse(error);
    }
  }

  async analyzeCustomerReviews(body: PdpAnalyzeCustomerReviewsRequest, openAiApiKeyOverride?: string) {
    try {
      const analysis = await this.pdpService.analyzeCustomerReviews(body, openAiApiKeyOverride);
      return {
        ok: true as const,
        analysis,
        model: "gpt-5.4-mini"
      };
    } catch (error) {
      return toPdpErrorResponse(error);
    }
  }

  async generateImage(body: PdpGenerateImageRequest, geminiApiKeyOverride?: string, openAiApiKeyOverride?: string) {
    try {
      const result = await this.pdpService.generateSectionImage(body, geminiApiKeyOverride, openAiApiKeyOverride);
      return {
        ok: true as const,
        ...result
      };
    } catch (error) {
      return toPdpErrorResponse(
        error instanceof PdpServiceError
          ? error
          : new PdpServiceError(
              "PDP_IMAGE_GENERATION_FAILED",
              "이미지 생성 중 오류가 발생했습니다.",
              error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            )
      );
    }
  }
}
