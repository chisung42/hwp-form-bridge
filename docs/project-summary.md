# HWP 신청서 웹폼 변환 프로젝트 정리

## 1. 프로젝트 목표

이 프로젝트의 목표는 사용자가 기존 HWP/HWPX 신청 양식을 업로드하면, 시스템이 문서를 분석해 Google Form처럼 접근성이 높은 웹 신청 화면을 자동 생성하는 것이다.

최종적으로 지향하는 흐름은 다음과 같다.

```text
HWP/HWPX 신청서 업로드
→ 원본 문서 구조 분석
→ 사용자가 입력해야 할 항목 추출
→ 웹폼 자동 생성
→ 사용자가 웹에서 신청
→ 응답 CSV/JSON 저장
→ 선택적으로 원본 HWP에 입력값 되채우기
```

핵심 가치는 HWP 신청서 작성의 진입장벽을 낮추는 것이다. 사용자는 한컴오피스나 복잡한 문서 편집 없이 웹폼으로 신청서를 작성할 수 있어야 한다.

## 2. 중요한 설계 원칙

### 2.1 HWP 원본 우선 분석

HWP 파일은 `rhwp`로 HWPX 변환이 가능하지만, 변환된 HWPX는 원본 HWP와 완전히 동일하지 않을 수 있다. 조판, 표 높이, 폰트, 배치, 일부 객체에서 차이가 생길 수 있다.

따라서 HWP 입력 파일은 반드시 원본 HWP를 기준으로 분석한다.

```text
HWP 입력 → original-hwp 분석
HWPX 입력 → original-hwpx 분석
```

HWP에서 HWPX로 변환한 파일은 다음 용도로만 사용한다.

```text
다운로드용
비교용
디버깅용
fallback용
```

필드 판단의 1차 근거로 변환된 HWPX를 사용하지 않는다.

### 2.2 규칙은 정답이 아니라 증거를 만든다

특정 문서에 맞춘 규칙은 다른 양식에서 오히려 오탐을 만들 수 있다. 따라서 규칙은 가능한 한 문서 중립적인 증거 추출에 집중한다.

좋은 규칙:

```text
텍스트 좌표 추출
표/셀 구조 추출
빈 셀 탐지
체크박스/선택지 후보 탐지
페이지 이미지 생성
폰트/크기/스타일 추출
```

위험한 규칙:

```text
"창업동아리 신청서"면 무조건 신청서 페이지
"성명"이 있으면 무조건 입력 필드
"개인정보"가 있으면 무조건 동의서
```

최종 판단은 LLM과 검증 단계가 담당하고, 규칙은 증거를 제공하는 역할로 제한한다.

## 3. 현재 구현된 기술 스택

프론트엔드:

```text
React
Vite
TypeScript
lucide-react
```

서버:

```text
Express
Multer
@rhwp/core
sharp
JSZip
```

LLM:

```text
Mindlogic 학교 게이트웨이
OpenAI 호환 chat/completions API
기본 모델: gpt-5.3-chat-latest
```

비밀키:

```text
keys.env
SCHOOL_API_KEY
```

`keys.env`는 `.gitignore`에 포함되어 있다.

## 4. 현재 처리 파이프라인

현재 구현된 분석 흐름은 다음과 같다.

```text
1. 사용자가 HWP/HWPX/TXT 파일 업로드
2. 파일 형식 판별
3. HWP/HWPX는 rhwp 서버로 전송
4. 원본 문서를 rhwp로 직접 파싱
5. 페이지별 텍스트, 레이아웃, 표, 빈칸, 선택지 후보 추출
6. evidence id 부여
7. LLM direct evidence extraction 실행
8. 서버에서 evidence 검증
9. confidence/status/needsReview 계산
10. 웹폼 빌더에 반영
11. 사용자가 폼 항목 검수/수정
12. 공개 신청 화면에서 입력
13. 응답 CSV/JSON 내보내기
```

현재 LLM 분석이 켜져 있으면 기본적으로 `direct-evidence` 모드가 사용된다.

```text
규칙 후보를 정답처럼 넘기는 방식이 아니라,
원본 HWP에서 추출한 evidence를 LLM에 제공하고
LLM이 직접 필드를 추출한다.
```

기존 방식도 fallback으로 남아 있다.

```bash
curl -F file=@input.hwp "http://localhost:8787/api/rhwp/analyze?llm=1&llmMode=refine"
```

## 5. Evidence 기반 분석 구조

정확도를 높이기 위해 각 문서에서 다음 데이터를 추출한다.

```text
page text
layout runs
lines
tables
cells
blanks
choices
page images
page svg
```

각 증거에는 ID가 부여된다.

예:

```json
{
  "id": "p4_table_2_cell_28",
  "kind": "table_cell",
  "page": 4,
  "text": "대표자 성명",
  "x": 75.6,
  "y": 310,
  "w": 90,
  "h": 24
}
```

빈 입력 영역도 별도 evidence로 저장된다.

```json
{
  "id": "p4_blank_8",
  "kind": "blank_region",
  "page": 4,
  "nearLabel": "대표자 성명",
  "cellId": "p4_table_2_cell_29",
  "labelDirection": "left"
}
```

LLM은 필드를 만들 때 가능한 한 `evidenceIds`와 `inputRegionId`를 포함해야 한다.

```json
{
  "label": "대표자 성명",
  "type": "text",
  "page": 4,
  "group": "대표자",
  "evidenceIds": ["p4_table_2_cell_28"],
  "inputRegionId": "p4_blank_8",
  "confidence": 0.97
}
```

## 6. Validator와 Confidence Scorer

LLM 결과는 그대로 사용하지 않는다. 서버에서 다시 검증한다.

검증 항목:

```text
evidenceIds가 실제 존재하는가
inputRegionId가 실제 blank region인가
필드가 공고문/참고자료 페이지에서 나온 것은 아닌가
select 타입에 options가 있는가
label이 안내문/작성요령처럼 보이지 않는가
중복 필드가 아닌가
HWP 되채우기 대상 위치를 찾을 수 있는가
```

검증 후 필드에는 다음 값이 붙는다.

```json
{
  "status": "accepted",
  "needsReview": false,
  "validation": {
    "passed": true,
    "signals": [
      "llm_extracted",
      "evidence_ids_exist",
      "blank_region_match",
      "table_structure_match",
      "hwp_target_resolved"
    ],
    "warnings": []
  }
}
```

상태는 세 가지다.

```text
accepted: 자동 사용 가능
review: 관리자 검수 필요
rejected: 기본적으로 숨기거나 후보로만 표시
```

## 7. HWP 되채우기 기반

웹폼 입력값을 원본 HWP에 다시 채우려면, 각 필드가 원본 HWP의 실제 위치와 연결되어야 한다.

현재 서버는 `inputRegionId`를 바탕으로 가능한 경우 `hwpTarget`을 생성한다.

예:

```json
{
  "sectionIndex": 0,
  "parentParaIndex": 57,
  "controlIndex": 0,
  "cellIndex": 4,
  "cellParaIndex": 0,
  "charOffset": 0,
  "sourceRegionId": "p4_blank_5",
  "sourceCellId": "p4_table_2_cell_4",
  "method": "insertTextInCell"
}
```

이 값은 실제 문서 채우기 API에서 사용된다.

```js
doc.insertTextInCell(
  sectionIndex,
  parentParaIndex,
  controlIndex,
  cellIndex,
  cellParaIndex,
  charOffset,
  value
);
```

현재 구현된 `POST /api/rhwp/fill`은 원본 HWP/HWPX 파일, 분석된 `fields`, 사용자의 `values`를 받아 `hwpTarget.method === "insertTextInCell"`인 항목만 채운다. 값이 비어 있거나 위치가 불확실하거나 같은 셀을 중복으로 가리키는 항목은 건너뛰며, 응답 헤더 `X-Fill-Summary`로 삽입/건너뜀/실패 개수를 반환한다.

이 방식은 정확도를 우선한 1차 구현이다. 밑줄 위 삽입, 글상자, 도형, 서명 이미지, 긴 장문으로 인한 표 높이 변경은 아직 보수적으로 제외하거나 추가 검증 대상으로 남긴다.

## 8. 현재 웹 UI 기능

현재 웹페이지는 다음 기능을 제공한다.

```text
HWP/HWPX/TXT 업로드
LLM 정밀 분석 토글
업로드/분석 상태 표시
폼 후보 리스트 표시
항목명 수정
타입 수정
필수 여부 수정
선택지 수정
항목 삭제/추가
페이지 분석 요약 표시
공개 신청 화면 미리보기
사용자 응답 저장
CSV/JSON 내보내기
```

파일 업로드 전 초기화면에서는 샘플 항목을 보여주지 않는다.

업로드 상태 표시는 다음 상태를 가진다.

```text
대기
파일 확인
분석 중
완료
오류
```

분석 중에는 파일 업로드 input과 LLM 토글이 비활성화된다.

## 9. API 정리

### 9.1 Health Check

```bash
curl http://localhost:8787/api/rhwp/health
```

### 9.2 기본 추출

```bash
curl -F file=@input.hwp http://localhost:8787/api/rhwp/extract
```

### 9.3 분석

```bash
curl -F file=@input.hwp http://localhost:8787/api/rhwp/analyze
```

### 9.4 LLM direct evidence 분석

```bash
curl -F file=@input.hwp "http://localhost:8787/api/rhwp/analyze?llm=1"
```

### 9.5 구조 데이터 포함

```bash
curl -F file=@input.hwp "http://localhost:8787/api/rhwp/analyze?structure=1"
```

### 9.6 HWP → HWPX 변환

```bash
curl -F file=@input.hwp http://localhost:8787/api/rhwp/convert/hwpx -o output.hwpx
```

주의: HWP→HWPX 변환본은 분석 기준이 아니라 보조 산출물이다.

## 10. CLI 명령

### 10.1 개발 서버

```bash
npm run dev -- --port 5173
npm run dev:server
```

### 10.2 HWP → HWPX 변환

```bash
npm run convert:hwp-to-hwpx -- input.hwp output.hwpx
```

### 10.3 HWP 분석 산출물 생성

```bash
npm run analyze:hwp-form -- input.hwp ./analysis-output
```

생성되는 산출물:

```text
fields.json
fields.csv
text.json
layout.json
tables.json
blanks.json
structure.json
pages/page-*.jpg
pages/page-*.svg
```

## 11. 예시 파일 검증 결과

예시 파일:

```text
2026년도 창업동아리 모집 공고문 및 신청서.hwp
```

검증된 내용:

```text
HWP 원본 직접 파싱 성공
문서 14페이지 인식
HWP → HWPX 변환 성공
페이지 JPG/SVG 생성 성공
layout/tables/blanks 생성 성공
LLM direct evidence extraction 성공
HWP target 매핑 생성 성공
```

최근 검증 결과:

```text
fieldCount: 35
hwpTarget 연결: 31개
accepted: 34
review: 1
```

## 12. 현재 한계

현재 구현에는 다음 한계가 있다.

```text
LLM direct evidence 모드는 토큰 사용량이 큼
choices 추출은 아직 단순 패턴 기반
페이지 이미지와 LLM 비전 입력은 아직 직접 결합하지 않음
Review UI에서 원본 위치 하이라이트는 아직 없음
긴 텍스트 입력 시 HWP 표 높이/페이지 흐름 재조판 검증 필요
중첩 표, 도형, 글상자, 이미지 서명은 추가 검증 필요
```

특히 LLM direct evidence 모드는 정확도는 좋아졌지만 문서 전체 evidence를 넣기 때문에 비용이 크다. 다음 단계에서는 페이지/섹션 단위 호출로 비용을 줄여야 한다.

## 13. 다음 구현 우선순위

정확도와 제품 완성도를 높이기 위한 다음 과제는 다음 순서가 좋다.

```text
1. LLM 호출을 페이지/섹션 단위로 분할
2. notice/reference 페이지를 LLM 입력에서 더 강하게 제외
3. choices.json 고도화
4. Review UI에서 원본 페이지 이미지 표시
5. 필드 클릭 시 inputRegion 하이라이트
6. accepted/review/rejected 필터 UI
7. 검수 결과 저장
8. HWP fill-back API 구현
9. 서명 이미지 삽입 기능
10. 템플릿 메모리/기관별 재사용 기능
```

## 14. 최종 지향 구조

최종적으로 지향하는 아키텍처는 다음과 같다.

```text
HWP/HWPX
  ↓
Original Parser
  ↓
Universal Evidence Extractor
  ├─ page images
  ├─ text layout
  ├─ lines
  ├─ tables
  ├─ blanks
  ├─ choices
  └─ hwp targets
  ↓
LLM Direct Evidence Extractor
  ↓
Evidence Validator
  ↓
Confidence Scorer
  ↓
Human Review UI
  ↓
Final Form Schema
  ↓
Web Form
  ↓
Optional HWP Fill-back
```

핵심 원칙:

```text
LLM이 판단하되,
반드시 원본 HWP에서 나온 evidence와 연결되게 한다.
```

이 방식이 특정 문서 규칙에 과적합되지 않으면서, 다양한 HWP 양식에서 높은 정확도를 유지할 수 있는 구조다.
