"use client";

import { useEffect, useState } from "react";
import { Bot, KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import styles from "./pdp-maker.module.css";
import { type PdpClientSettings, maskGeminiApiKey, maskOpenAiApiKey } from "./pdp-settings";
import { validateGeminiApiKey, validateOpenAiApiKey } from "./pdp-utils";

interface PdpSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: PdpClientSettings;
  onSave: (settings: PdpClientSettings) => void;
}

export function PdpSettingsSheet({
  open,
  onOpenChange,
  settings,
  onSave
}: PdpSettingsSheetProps) {
  const [localSettings, setLocalSettings] = useState(settings);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isValidating, setIsValidating] = useState(false);

  useEffect(() => {
    if (open) {
      setLocalSettings(settings);
      setErrorMessage("");
      setSuccessMessage("");
      setIsValidating(false);
    }
  }, [open, settings]);

  const maskedGeminiApiKey = localSettings.customGeminiApiKey ? maskGeminiApiKey(localSettings.customGeminiApiKey) : "";
  const maskedOpenAiApiKey = localSettings.customOpenAiApiKey ? maskOpenAiApiKey(localSettings.customOpenAiApiKey) : "";
  const hasGeminiKey = Boolean(localSettings.customGeminiApiKey.trim());
  const hasOpenAiKey = Boolean(localSettings.customOpenAiApiKey.trim());

  const handleSave = async () => {
    const candidateGeminiKey = localSettings.customGeminiApiKey.trim();
    const candidateOpenAiKey = localSettings.customOpenAiApiKey.trim();

    if (!candidateGeminiKey && !candidateOpenAiKey) {
      onSave({
        customGeminiApiKey: "",
        customOpenAiApiKey: "",
        preferredAiProvider: ""
      });
      setSuccessMessage("API 키 사용을 해제했습니다. 기본 Codex CLI 방식으로 작업합니다.");
      onOpenChange(false);
      return;
    }

    setIsValidating(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const messages: string[] = [];

      if (candidateGeminiKey) {
        const geminiValidation = await validateGeminiApiKey(candidateGeminiKey);

        if (!geminiValidation.ok) {
          setErrorMessage(geminiValidation.message);
          return;
        }

        messages.push(geminiValidation.message);
      }

      if (candidateOpenAiKey) {
        const openAiValidation = await validateOpenAiApiKey(candidateOpenAiKey);

        if (!openAiValidation.ok) {
          setErrorMessage(openAiValidation.message);
          return;
        }

        messages.push(openAiValidation.message);
      }

      let preferredAiProvider = localSettings.preferredAiProvider;
      if (preferredAiProvider === "openai" && !candidateOpenAiKey) {
        preferredAiProvider = candidateGeminiKey ? "gemini" : "";
      }
      if (preferredAiProvider === "gemini" && !candidateGeminiKey) {
        preferredAiProvider = candidateOpenAiKey ? "openai" : "";
      }
      if (!preferredAiProvider) {
        preferredAiProvider = candidateOpenAiKey && !candidateGeminiKey ? "openai" : "gemini";
      }

      onSave({
        customGeminiApiKey: candidateGeminiKey,
        customOpenAiApiKey: candidateOpenAiKey,
        preferredAiProvider
      });
      setSuccessMessage(messages.join(" "));
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "API 키 연결 상태를 확인하지 못했습니다.");
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className={styles.settingsSheet} side="right">
        <SheetHeader className={styles.settingsSheetHeader}>
          <div className={styles.settingsSheetKicker}>
            <KeyRound size={14} />
            설정
          </div>
          <SheetTitle className={styles.settingsSheetTitle}>AI API 키 설정</SheetTitle>
          <SheetDescription className={styles.settingsSheetDescription}>
            기본은 Codex CLI로 실행합니다. 직접 Gemini 또는 OpenAI API를 쓰고 싶을 때만 개인 키를 저장하세요.
          </SheetDescription>
        </SheetHeader>

        <div className={styles.settingsSheetBody}>
          <section className={styles.settingsCard}>
            <div className={styles.settingsCardHeader}>
              <div>
                <span className={styles.panelLabel}>현재 연결</span>
                <h3 className={styles.settingsCardTitle}>개인 AI API 키</h3>
              </div>
              <span className={hasGeminiKey || hasOpenAiKey ? styles.settingsStatusStrong : styles.settingsStatusSoft}>
                {hasGeminiKey || hasOpenAiKey ? "저장됨" : "미설정"}
              </span>
            </div>

            <div className={styles.settingsKeyPreview}>
              <strong>현재 표시</strong>
              {hasGeminiKey || hasOpenAiKey ? (
                <div className={styles.settingsKeyPreviewRows}>
                  {hasGeminiKey ? (
                    <div className={styles.settingsKeyPreviewRow}>
                      <span>Gemini</span>
                      <code>{maskedGeminiApiKey}</code>
                    </div>
                  ) : null}
                  {hasOpenAiKey ? (
                    <div className={styles.settingsKeyPreviewRow}>
                      <span>OpenAI</span>
                      <code>{maskedOpenAiApiKey}</code>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className={styles.settingsEmptyKey}>아직 저장된 개인 API 키가 없습니다.</p>
              )}
            </div>

            <div className={styles.settingsStatusList}>
              <div className={styles.settingsStatusRow}>
                <UserRound size={14} />
                <span>Gemini</span>
                <strong>{maskedGeminiApiKey || "아직 없음"}</strong>
              </div>
              <div className={styles.settingsStatusRow}>
                <Bot size={14} />
                <span>OpenAI</span>
                <strong>{maskedOpenAiApiKey || "아직 없음"}</strong>
              </div>
            </div>
          </section>

          <section className={styles.settingsCard}>
            <div className={styles.settingsLockedNotice}>
              <ShieldCheck size={16} />
              키를 비워 저장하면 기본 Codex CLI 방식으로 돌아갑니다. 개인 키는 localStorage에만 저장됩니다.
            </div>

            <div className={styles.settingsModeGrid}>
              <button
                className={localSettings.preferredAiProvider === "gemini" ? styles.settingsModeButtonActive : styles.settingsModeButton}
                disabled={isValidating}
                onClick={() => setLocalSettings((current) => ({ ...current, preferredAiProvider: "gemini" }))}
                type="button"
              >
                Gemini 기본
              </button>
              <button
                className={localSettings.preferredAiProvider === "openai" ? styles.settingsModeButtonActive : styles.settingsModeButton}
                disabled={isValidating}
                onClick={() => setLocalSettings((current) => ({ ...current, preferredAiProvider: "openai" }))}
                type="button"
              >
                OpenAI 기본
              </button>
            </div>

            <label className={styles.settingsField}>
              <span className={styles.fieldLabel}>Gemini API 키</span>
              <input
                autoComplete="off"
                className={styles.settingsInput}
                disabled={isValidating}
                onChange={(event) => {
                  setLocalSettings((current) => ({ ...current, customGeminiApiKey: event.target.value }));
                  if (errorMessage) {
                    setErrorMessage("");
                  }
                  if (successMessage) {
                    setSuccessMessage("");
                  }
                }}
                placeholder="AIza..."
                type="password"
                value={localSettings.customGeminiApiKey}
              />
            </label>

            <label className={styles.settingsField}>
              <span className={styles.fieldLabel}>OpenAI API 키</span>
              <input
                autoComplete="off"
                className={styles.settingsInput}
                disabled={isValidating}
                onChange={(event) => {
                  setLocalSettings((current) => ({ ...current, customOpenAiApiKey: event.target.value }));
                  if (errorMessage) {
                    setErrorMessage("");
                  }
                  if (successMessage) {
                    setSuccessMessage("");
                  }
                }}
                placeholder="sk-..."
                type="password"
                value={localSettings.customOpenAiApiKey}
              />
            </label>

            <p className={styles.settingsHelper}>
              개인 키를 입력하면 해당 API를 직접 사용하고, 비워두면 이 PC의 Codex CLI 로그인으로 처리합니다.
            </p>

            {errorMessage ? <div className={styles.settingsError}>{errorMessage}</div> : null}
            {successMessage ? <div className={styles.settingsSuccess}>{successMessage}</div> : null}

            <div className={styles.settingsActions}>
              <button className={styles.secondaryButton} disabled={isValidating} onClick={() => onOpenChange(false)} type="button">
                닫기
              </button>
              <button className={styles.primaryButton} disabled={isValidating} onClick={() => void handleSave()} type="button">
                {isValidating ? "키 확인 중..." : "설정 저장"}
              </button>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
