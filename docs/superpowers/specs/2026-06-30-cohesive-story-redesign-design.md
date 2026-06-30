# 유기적 스토리 재설계 (1단계: 카피·흐름·후기)

- 날짜: 2026-06-30
- 상태: 설계 승인됨 (한이룸님), 구현 계획 대기
- 작업 공간: `pdp-maker-30-redesign` (원본 `pdp-maker-30`의 격리 사본, 포트 3010)
- 접근: **A — 새 `/pdp/expand` LLM 엔드포인트 + narrative spine**

## 1. 배경 / 문제 진단

현재 시스템은 페이지를 **두 개의 분리된 엔진**으로 만든다:

1. **히어로(섹션 1)** — 서버 LLM이 `analyzeProduct`로 생성 (`sectionCount = 1`). 카피가 설득력 있고 후기도 반영됨.
2. **섹션 2~N** — 클라이언트의 **하드코딩 템플릿 엔진**(`EXPANSION_STRATEGIES` + `buildExpansionSectionCopy` → `buildRoleFallbackCopy`). **LLM 미사용.** 4가지 스타일은 고정 섹션 목록 + 카테고리별(운동양말/선패치/뷰티/generic) 정해진 문구뿐.

이 분리가 핵심 증상의 근본 원인이다:

- **섹션이 따로 논다**: 각 섹션이 앞뒤·전체 흐름을 모른 채 독립 생성. 진짜 핸드오프 없음.
- **카피가 약하다**: 카테고리 3종 밖 제품은 밋밋한 `generic`으로 떨어짐. 서버에 있는 멀티섹션 내러티브 프롬프트는 `sectionCount===1` 때문에 한 번도 실행 안 됨.
- **후기 활용 부족**: 확장 섹션엔 "후기 역할" 칸에만 슬롯처럼 끼워짐.
- (별도/2단계) 비주얼이 제각각: 섹션 이미지가 독립 생성, 공유 디자인 시스템 없음 — **본 1단계 범위 밖**.

조사 근거: `lib/pdp-server/pdp.service.ts`(`analyzeProduct` ~388, `buildAnalyzePrompt` ~1282, hero-only 룰 ~1340), `app/pdp-maker/PdpEditor.tsx`(`EXPANSION_STRATEGIES` ~319, `buildExpansionSectionCopy` ~6029, `buildRoleFallbackCopy` ~6420, `buildSalesNarrativeContext` ~6099), `lib/shared/pdp.ts`(`LandingPageBlueprint` ~59, `SectionBlueprint` ~33).

## 2. 목표 / 비범위

**목표 (1단계)**
- 히어로부터 마지막 섹션까지 **하나의 유기적 스토리**로 이어지게 — 각 섹션이 앞 섹션을 이어받고(`connectionToPrev`) 전체를 관통하는 메시지(`throughline`)를 공유.
- 섹션 카피를 **카테고리 무관 LLM 생성**으로 — 전환 지향, 라벨 누출·CTA 중복 없음.
- 후기를 **반반 대응**: 있으면 섹션마다 인사이트를 녹이고, 없으면 제품 맥락만으로 강한 설득(날조 금지).
- 4가지 스타일(스토리브랜드/구매저항/사용시나리오/비교근거)이 **서로 다른 spine**을 만들도록.

**비범위 (2단계 이후)**
- 공유 비주얼 시스템(색·조명·레이아웃·여백) — 이미지 프롬프트 재설계는 2단계.
- 4가지 스타일의 섹션 구조 자체 재편 — 본 1단계는 기존 스타일별 섹션 로스터를 유지하되 카피/흐름만 LLM화.
- 원본 폴더 반영/배포 — 재설계본에서 검증 후 별도 결정.

## 3. 아키텍처

### 3.1 NarrativeSpine 객체 (신규)

페이지 전체를 관통하는 "척추". `LandingPageBlueprint`에 `narrativeSpine?: NarrativeSpine` 추가, `SectionBlueprint`에 `story_beat?: SectionStoryBeat` 추가 (`lib/shared/pdp.ts`).

```ts
interface NarrativeSpine {
  targetCustomer: string;        // 누구를 위한 페이지인가
  coreStruggle: string;          // 고객이 겪는 진짜 문제/갈등
  transformation: string;        // 사용 후 변화된 모습
  throughline: string;           // 페이지 전체를 관통하는 한 줄 메시지
  reviewInsights?: {             // 후기 있을 때만
    topBenefits: string[];
    painPoints: string[];
    improvementPromises: string[];
  };
}

interface SectionStoryBeat {
  beatGoal: string;              // 이 섹션이 스토리에서 하는 일
  connectionToPrev: string;      // 앞 섹션을 어떻게 이어받는가 (유기성 핵심)
  reviewAngle?: string;          // 이 섹션에 녹일 후기 인사이트 (있을 때)
}
```

### 3.2 새 엔드포인트 `/pdp/expand`

```
POST /api/pdp/expand
  body: {
    heroBlueprint: LandingPageBlueprint,   // 히어로 생성 결과
    style: "storybrand" | "objection" | "scenario" | "comparison",
    reviewAnalysis?: PdpCustomerReviewAnalysis,
    productContext: { additionalInfo?, desiredTone?, aspectRatio, aiProvider, ... }
  }
  → 200 { ok: true, narrativeSpine, sections: SectionBlueprint[] }   // 히어로 포함 전체 로스터
  → 4xx/5xx { ok: false, code, message, detail }                    // 기존 에러 규약 동일
```

- 서버: `PdpService.expandLandingPage(...)` 신설 (`lib/pdp-server/pdp.service.ts`) + `PdpController.expand` + `app/api/pdp/expand/route.ts` (기존 analyze/images 라우트의 상태코드 매핑·키 헤더 패턴 재사용).
- **LLM이 narrativeSpine + 전체 섹션 카피를 한 번의 호출로** 생성 → 모든 섹션이 같은 컨텍스트 안에서 만들어져 유기적으로 연결.
- 입력 검증·요청 크기·타임아웃은 기존 라우트와 동일 수준(현재 클라이언트 `apiJson`은 이미 타임아웃/JSON가드 적용됨).

### 3.3 데이터 흐름 (현재 UX 그대로)

```
[변경 없음]  히어로 생성  POST /pdp/analyze (sectionCount=1)  → heroBlueprint
[변경 없음]  사용자가 스타일 선택 (4종 그리드)
[신규]       POST /pdp/expand { heroBlueprint, style, reviewAnalysis?, productContext }
               → { narrativeSpine, sections[] }
[변경 없음]  섹션별 이미지 생성  POST /pdp/images (Promise.allSettled, 섹션마다)
```

히어로를 먼저 보고 스타일을 고르는 현재 흐름은 보존된다. 바뀌는 건 "스타일 선택 후 확장"이 클라이언트 템플릿 → 서버 LLM으로 교체되는 부분뿐.

## 4. 컴포넌트별 변경

| 영역 | 파일 | 변경 |
|------|------|------|
| 타입 | `lib/shared/pdp.ts` | `NarrativeSpine`, `SectionStoryBeat` 추가; `LandingPageBlueprint.narrativeSpine?`, `SectionBlueprint.story_beat?` 추가 |
| 서버 | `lib/pdp-server/pdp.service.ts` | `expandLandingPage()` + `buildExpandPrompt()` (스타일별 아크 가이드 + 후기 분기 + 안티-라벨/안티-날조 규칙) 신설; 기존 sanitizer 재사용 |
| 서버 | `lib/pdp-server/pdp.controller.ts` | `expand()` 메서드 추가 |
| 라우트 | `app/api/pdp/expand/route.ts` (신규) | analyze 라우트 패턴 복제(상태코드 매핑, 키 헤더, try/catch) |
| 클라이언트 | `app/pdp-maker/PdpEditor.tsx` | 확장 핸들러가 `buildExpansionSectionCopy` 대신 `/pdp/expand` 호출; 응답의 `sections` + `narrativeSpine`을 에디터 상태로; **기존 템플릿 함수는 폴백으로 보존** |
| 스타일 가이드 | `app/pdp-maker/PdpEditor.tsx` `EXPANSION_STRATEGIES` | 죽어 있던 `flowIntent`/`keyMessage`를 expand 요청에 실어 보냄 (UI는 그대로) |

## 5. 4가지 스타일 → spine

`EXPANSION_STRATEGIES[style].flowIntent` / `keyMessage` / 섹션 로스터(role 목록)를 `buildExpandPrompt`에 아크 가이드로 전달. LLM은 그 박자에 맞춰 spine과 섹션을 생성:

- **storybrand** — 고객 공감 → 문제 → 가이드 → 계획 → 구매 제안 → 변화 → 손실 회피 → 확신
- **objection** — 고민 → 전환 선언 → 비교 → 디테일 → 근거 → FAQ/고시
- **scenario** — 상황 질문 → 사용 장면 → 루틴 → 디테일 → 구성
- **comparison** — 비교/근거 강화 중심

같은 제품이라도 선택 스타일에 따라 다른 spine·다른 섹션 카피가 나온다.

## 6. 후기 분기 (반반)

- **있을 때**: `reviewAnalysis`(topBenefits/painPoints/improvementPromises)를 `narrativeSpine.reviewInsights`로 넣고, LLM이 각 섹션 `story_beat.reviewAngle`에 인사이트를 분배 → 후기가 섹션마다 자연스럽게 녹음.
- **없을 때**: LLM이 제품 맥락만으로 설득 비트 생성. **가짜 후기·수치·효능 날조 금지** 규칙을 프롬프트에 명시(기존 anti-fabrication 가드 계승).

## 7. 에러 처리 / 폴백 (안전망)

- `/pdp/expand` 실패·타임아웃·검증 실패 시 → **기존 클라이언트 템플릿(`buildExpansionSectionCopy`)으로 폴백**하여 항상 동작 보장. 폴백 발동 시 사용자에게 비차단 안내("AI 확장에 실패해 기본 템플릿으로 구성했어요").
- 카피 라벨 누출/CTA 중복/generic 차단 sanitizer(`sanitizeVisibleCopy` 등)는 expand 결과에도 적용.
- 부분 실패(일부 섹션 누락) 시 기존 `generateMissingImagesForSections` 재시도 경로 재사용.

## 8. 검증

- 재설계본에서 `pnpm typecheck`.
- 핵심 흐름(엔드포인트 계약·폴백·상태 전이)은 mock/seed로 검증.
- 실제 생성 품질은 유료 API(본인 키)라, **3002(원본) vs 3010(재설계)을 같은 제품·같은 스타일로 나란히 비교**해 한이룸님이 최종 확인.
- 어드버서리얼 리뷰: expand 프롬프트가 라벨 누출/날조/CTA 중복을 유발하지 않는지 독립 검토.

## 9. 격리 환경

- `pdp-maker-30-redesign/` = `pdp-maker-30/`의 소스 사본(node_modules·.next·output 제외, `pnpm install`로 재구성). 포트 **3010**.
- 원본 폴더와 Codex 작업에 **0 영향**. 만족 시 원본 반영 방식(폴더 교체/선택 머지)은 추후 결정.

## 10. 리스크 / 미해결

- expand LLM 호출 1회 추가 → 생성 시간·비용 증가 (히어로+확장 2회 호출). 허용 가능 범위로 판단.
- 스타일별 섹션 로스터는 1단계에서 유지(LLM이 카피만 채움); 로스터 자체 최적화는 후속.
- 비주얼 일관성은 2단계 과제로 명시(본 1단계는 카피/흐름/후기만).
