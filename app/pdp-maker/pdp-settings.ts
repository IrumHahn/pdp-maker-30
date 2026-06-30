"use client";

import type { PdpAiProvider } from "@runacademy/shared";

export interface PdpClientSettings {
  customGeminiApiKey: string;
  customOpenAiApiKey: string;
  preferredAiProvider: PdpAiProvider | "";
}

const PDP_SETTINGS_STORAGE_KEY = "hanirum-pdp-maker-settings-v1";

const DEFAULT_SETTINGS: PdpClientSettings = {
  customGeminiApiKey: "",
  customOpenAiApiKey: "",
  preferredAiProvider: ""
};

export function loadPdpClientSettings(): PdpClientSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const rawValue = window.localStorage.getItem(PDP_SETTINGS_STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(rawValue) as Partial<PdpClientSettings>;
    return normalizePdpClientSettings(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function savePdpClientSettings(settings: PdpClientSettings) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PDP_SETTINGS_STORAGE_KEY, JSON.stringify(normalizePdpClientSettings(settings)));
}

export function resolveGeminiApiKeyHeaderValue(settings?: PdpClientSettings) {
  const nextSettings = settings ?? loadPdpClientSettings();
  const trimmed = nextSettings.customGeminiApiKey.trim();
  return trimmed || null;
}

export function resolveOpenAiApiKeyHeaderValue(settings?: PdpClientSettings) {
  const nextSettings = settings ?? loadPdpClientSettings();
  const trimmed = nextSettings.customOpenAiApiKey.trim();
  return trimmed || null;
}

export function maskApiKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= 18) {
    const visiblePrefixLength = Math.min(8, trimmed.length);
    return `${trimmed.slice(0, visiblePrefixLength)}${"•".repeat(Math.max(4, trimmed.length - visiblePrefixLength))}`;
  }

  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

export const maskGeminiApiKey = maskApiKey;
export const maskOpenAiApiKey = maskApiKey;

function normalizePdpClientSettings(settings?: Partial<PdpClientSettings> | null): PdpClientSettings {
  const preferredAiProvider =
    settings?.preferredAiProvider === "gemini" || settings?.preferredAiProvider === "openai"
      ? settings.preferredAiProvider
      : "";

  return {
    customGeminiApiKey: settings?.customGeminiApiKey?.trim() ?? "",
    customOpenAiApiKey: settings?.customOpenAiApiKey?.trim() ?? "",
    preferredAiProvider
  };
}
