#!/usr/bin/env node
// 회귀 체크: 카테고리 샘플 카피 오염 방지 (2026-07-02 도입)
//
// 배경: 하드코딩된 제품별 샘플 카피(워터프루프 선크림/러닝 양말/선 패치 덱)가 폴백으로
// 남아 있으면, 키워드 오분류나 AI 실패 시 다른 제품의 상세페이지에 그 카피가 섞여 나간다
// (실제 구독자 오염 사고 2026-07-02). 이 스크립트는 그 패턴이 소스에 다시 들어오는 순간
// 실패해서 재발을 막는다.
//
// 실행: node scripts/check-copy-contamination.mjs
// (의존성 없음. pnpm typecheck와 함께 배포 전 확인용.)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 라인 주석 제거: 오염 "감지용" 정규식/주석에 남은 설명 문구는 위반이 아니다.
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

const violations = [];

function checkBanned(relPath, bannedList) {
  const source = stripLineComments(readFileSync(join(root, relPath), "utf8"));
  bannedList.forEach((banned) => {
    if (source.includes(banned)) {
      violations.push(`${relPath}: 금지 문자열 재등장 → ${JSON.stringify(banned)}`);
    }
  });
}

function checkRequired(relPath, requiredList) {
  const source = readFileSync(join(root, relPath), "utf8");
  requiredList.forEach((required) => {
    if (!source.includes(required)) {
      violations.push(`${relPath}: 필수 안전장치 누락 → ${JSON.stringify(required)}`);
    }
  });
}

// 1) 에디터: 카테고리 덱/분기/조용한 폴백이 되살아나면 실패.
//    (감지용 SUNSCREEN_DECK_PATTERN 정규식은 \s* 이스케이프 형태라 평문 매칭에 걸리지 않는다)
checkBanned("app/pdp-maker/PdpEditor.tsx", [
  '"워터프루프 선크림"',
  "워터프루프 선크림입니다",
  "선크림부터 챙기세요\"",
  "물놀이 전, 선크림이 먼저 걱정되나요",
  "물과 땀 앞에서도 챙기는 선크림",
  "야외 활동 전 바르는 선크림",
  "패키지에서 확인하는 SPF/PA",
  "THE PANOL",
  "쫀쫀한 핏과 도톰한 쿠션감",
  "착지 부담을 덜어주는 쿠션감",
  "isSunCare",
  "isSunPatch",
  "isRunningSocks",
  'category === "sunCare"',
  'category: "sunCare"',
  'category: "sunPatch"',
  'category: "runningSocks"',
  'category: "beauty"',
  "buildFallbackExpandedSections",
  "expansion_fallback_used"
]);

// 2) 에디터: expand 실패는 반드시 눈에 보이는 에러로 처리되어야 한다.
checkRequired("app/pdp-maker/PdpEditor.tsx", [
  "editor.expansion_failed",
  "AI 전체 섹션 생성에 실패했습니다"
]);

// 3) 서버: 프롬프트/폴백에 선크림·타사 브랜드 문구가 다시 들어오면 실패.
checkBanned("lib/pdp-server/pdp.service.ts", [
  "선크림",
  "워터프루프",
  "백탁",
  "물과 땀에 강한",
  "THE PANOL",
  "멜라이드",
  "에어뮤즈",
  "airmuse",
  "melide"
]);

// 4) 공유 정규화: 선크림 재작성 문구는 반드시 sunCare 게이트 뒤에만 존재해야 한다.
//    (설명 주석 속 단어가 걸리지 않도록 주석 제거 후 검사)
{
  const relPath = "lib/shared/pdp-copy-normalization.ts";
  const source = stripLineComments(readFileSync(join(root, relPath), "utf8"));
  const gateIndex = source.indexOf('productKind === "sunCare"');
  ["하얗게 뜨지 않는 백탁 방지", "물과 땀에 강한 워터프루프", "햇빛 강한 날 챙기는 차단 루틴", "야외 활동 전 간편한 휴대"].forEach(
    (phrase) => {
      const phraseIndex = source.indexOf(phrase);
      if (phraseIndex !== -1 && (gateIndex === -1 || phraseIndex < gateIndex)) {
        violations.push(`${relPath}: 선크림 재작성 문구가 sunCare 게이트 앞(무게이트)에 있음 → ${JSON.stringify(phrase)}`);
      }
    }
  );

  // 분류 정규식이 다시 느슨해지면(사용 상황 단어로 카테고리 추측) 실패.
  const classifierStart = source.indexOf("function inferPdpCopyProductKind");
  const classifierEnd = source.indexOf("export function", classifierStart + 1);
  const classifierBody = source.slice(classifierStart, classifierEnd === -1 ? undefined : classifierEnd);
  ["물놀이", "waterproof", "워터", "spf", "마라톤", "조깅", "|러닝|", "|런닝|"].forEach((loose) => {
    if (classifierBody.includes(loose)) {
      violations.push(`${relPath}: inferPdpCopyProductKind 분류 정규식에 느슨한 트리거 재등장 → ${JSON.stringify(loose)}`);
    }
  });
}

if (violations.length) {
  console.error("✗ 카피 오염 회귀 체크 실패:\n");
  violations.forEach((violation) => console.error(`  - ${violation}`));
  console.error("\n하드코딩 샘플 카피/무게이트 재작성/조용한 폴백은 다른 제품 출력에 섞여 나갑니다 (2026-07-02 사고 참조).");
  process.exit(1);
}

console.log("✓ 카피 오염 회귀 체크 통과 (금지 문자열 0건, 안전장치 유지)");
