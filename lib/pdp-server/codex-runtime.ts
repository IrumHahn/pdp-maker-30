import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CodexReference = { name: string; mimeType: string; buffer: Buffer };

let availabilityCache: { value: boolean; checkedAt: number } | null = null;

export function isCodexImageGenerationAvailable() {
  const now = Date.now();
  if (availabilityCache && now - availabilityCache.checkedAt < 30_000) {
    return availabilityCache.value;
  }

  const command = codexInvocation([...codexGlobalArgs(), "--enable", "image_generation", "features", "list"]);
  const result = spawnSync(command.bin, command.args, {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const value = result.status === 0 && /^\s*image_generation\s+\S+\s+true\s*$/m.test(output);
  availabilityCache = { value, checkedAt: now };
  return value;
}

export async function runCodexJson({
  prompt,
  references,
  workspaceDir = process.cwd()
}: {
  prompt: string;
  references: CodexReference[];
  workspaceDir?: string;
}) {
  const jobId = randomUUID();
  const jobDir = path.join(workspaceDir, ".tmp-codex-pdp", jobId);
  const messagePath = path.join(jobDir, "last-message.txt");
  await mkdir(jobDir, { recursive: true });

  try {
    const referencePaths = await writeReferenceFiles(jobDir, references);
    const result = await runCodexExec({
      prompt: buildJsonPrompt(prompt, referencePaths),
      imagePaths: referencePaths,
      messagePath,
      workspaceDir,
      sandbox: "read-only"
    });

    if (result.code !== 0) {
      throw new Error(trimForError(result.stderr || result.stdout || `Codex CLI 종료 코드 ${result.code}`));
    }

    return readFile(messagePath, "utf8").catch(() => result.stdout);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateCodexImage({
  prompt,
  references,
  workspaceDir = process.cwd()
}: {
  prompt: string;
  references: CodexReference[];
  workspaceDir?: string;
}) {
  if (!isCodexImageGenerationAvailable()) {
    throw new Error("Codex CLI image_generation 기능이 활성화되어 있지 않습니다.");
  }

  const jobId = randomUUID();
  const startedAt = Date.now();
  const jobDir = path.join(workspaceDir, ".tmp-codex-pdp", jobId);
  const outputPath = path.join(jobDir, "result.png");
  const messagePath = path.join(jobDir, "last-message.txt");
  await mkdir(jobDir, { recursive: true });

  try {
    const referencePaths = await writeReferenceFiles(jobDir, references);
    const result = await runCodexExec({
      prompt: buildImagePrompt(prompt, referencePaths, outputPath),
      imagePaths: referencePaths,
      messagePath,
      workspaceDir,
      sandbox: "workspace-write"
    });

    if (result.code !== 0) {
      throw new Error(trimForError(result.stderr || result.stdout || `Codex CLI 종료 코드 ${result.code}`));
    }

    let imagePath = outputPath;
    if (!(await hasPngSignature(imagePath))) {
      const generatedPath = await findLatestGeneratedImage(startedAt);
      if (!generatedPath) {
        throw new Error("Codex CLI가 생성한 이미지 파일을 찾지 못했습니다.");
      }
      await copyFile(generatedPath, outputPath);
      imagePath = outputPath;
    }

    return {
      mimeType: "image/png",
      buffer: await readFile(imagePath)
    };
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeReferenceFiles(jobDir: string, references: CodexReference[]) {
  const paths: string[] = [];
  for (const [index, reference] of references.entries()) {
    const extension = extensionFor(reference.mimeType, reference.name);
    const baseName = reference.name.replace(/\.[^.]+$/, "") || `reference-${index + 1}`;
    const safeName = sanitizeFileName(`${index + 1}-${baseName}${extension}`);
    const filePath = path.join(jobDir, safeName);
    await writeFile(filePath, reference.buffer);
    paths.push(filePath);
  }
  return paths;
}

function buildJsonPrompt(prompt: string, referencePaths: string[]) {
  return [
    "첨부 이미지와 텍스트를 분석해서 요청한 JSON만 반환한다.",
    "설명 문장, 마크다운 코드펜스, 주석을 붙이지 않는다.",
    `입력 이미지 파일: ${referencePaths.join(", ") || "없음"}`,
    "",
    prompt
  ].join("\n");
}

function buildImagePrompt(prompt: string, referencePaths: string[], outputPath: string) {
  return [
    "imagegen 스킬의 기본 built-in image generation 흐름을 사용한다.",
    "API 키를 요구하지 말고 Codex의 image_generation 기능으로 처리한다.",
    "SVG, HTML, CSS, 캔버스, 수동 합성으로 대체하지 않는다.",
    "첨부된 참조 이미지를 바탕으로 새 상세페이지 섹션 PNG를 만든다.",
    "프롬프트가 통이미지 모드나 온이미지 문구를 요구하면, 프롬프트에 지정된 한국어 문구만 크게 읽히게 넣는다.",
    "근거 없는 수치, 인증, 리뷰, 효능, 순위, 배송 약속을 만들지 않는다.",
    `입력 이미지 파일: ${referencePaths.join(", ") || "없음"}`,
    `최종 PNG 저장 경로: ${outputPath}`,
    "생성 후 반드시 최종 PNG를 위 경로로 복사 또는 이동하고 PNG 시그니처를 확인한다.",
    "마지막 응답은 JSON 한 줄만 작성한다: {\"ok\":true,\"path\":\"<저장 경로>\"}",
    "",
    prompt
  ].join("\n");
}

function runCodexExec({
  prompt,
  imagePaths,
  messagePath,
  workspaceDir,
  sandbox
}: {
  prompt: string;
  imagePaths: string[];
  messagePath: string;
  workspaceDir: string;
  sandbox: "read-only" | "workspace-write";
}) {
  const args = [
    ...codexGlobalArgs(),
    "--enable",
    "image_generation",
    "-s",
    sandbox,
    "-a",
    "never",
    "exec",
    "-C",
    workspaceDir,
    "--output-last-message",
    messagePath
  ];

  for (const imagePath of imagePaths) {
    args.push("--image", imagePath);
  }
  args.push("-");

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const command = codexInvocation(args);
    const child = spawn(command.bin, command.args, {
      cwd: workspaceDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error("Codex CLI 처리 시간이 초과되었습니다."));
    }, Number(process.env.CODEX_IMAGE_TIMEOUT_MS || 300_000));

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString());
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function codexGlobalArgs() {
  const serviceTier = process.env.CODEX_SERVICE_TIER_OVERRIDE === "flex" ? "flex" : "fast";
  return ["-c", `service_tier=${serviceTier}`];
}

function killProcessTree(pid?: number) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

async function hasPngSignature(filePath: string) {
  try {
    const buffer = await readFile(filePath);
    return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  } catch {
    return false;
  }
}

async function findLatestGeneratedImage(startedAt: number) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images");
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  await collectGeneratedImages(root, candidates, startedAt - 10_000, 0);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || "";
}

async function collectGeneratedImages(
  dir: string,
  candidates: Array<{ filePath: string; mtimeMs: number }>,
  minMtimeMs: number,
  depth: number
) {
  if (depth > 2) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectGeneratedImages(filePath, candidates, minMtimeMs, depth + 1);
      continue;
    }
    if (!/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) continue;
    const info = await stat(filePath).catch(() => null);
    if (info && info.mtimeMs >= minMtimeMs) {
      candidates.push({ filePath, mtimeMs: info.mtimeMs });
    }
  }
}

function codexInvocation(args: string[]) {
  if (process.platform !== "win32") {
    return { bin: "codex", args };
  }
  return { bin: "cmd.exe", args: ["/d", "/c", ["codex", ...args.map(quoteCmdArg)].join(" ")] };
}

function quoteCmdArg(value: string) {
  if (/^[a-zA-Z0-9_./:=@\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function extensionFor(mimeType: string, name: string) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return path.extname(name).toLowerCase() || ".png";
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "reference.png";
}

function appendLimited(current: string, next: string) {
  return `${current}${next}`.slice(-20_000);
}

function trimForError(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 800);
}
