# HWP 신청서 폼 변환기

기존 HWP/HWPX 신청 양식의 진입 장벽을 낮추기 위한 MVP입니다. HWPX 파일이나 붙여넣은 신청서 원문을 분석해 구글폼과 비슷한 웹 신청 화면을 만들고, 제출 응답을 CSV/JSON으로 내려받을 수 있습니다.

## 기능

- `.hwpx` 파일을 브라우저에서 직접 읽어 본문 텍스트 추출
- 신청서 원문에서 이름, 연락처, 이메일, 주소, 선택지, 동의 항목 등 폼 후보 자동 생성
- 생성된 항목명, 유형, 필수 여부, 선택지 수정
- 공개 신청 화면 미리보기 및 응답 저장
- 응답 CSV 내보내기, 폼 스키마 JSON 내보내기
- 원본 HWP/HWPX의 확인된 셀 위치에 입력값을 삽입해 채워진 문서 다운로드

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다.

HWP 바이너리까지 테스트하려면 별도 터미널에서 rhwp 서버도 실행합니다.

```bash
npm run dev:server
```

서버 확인:

```bash
curl http://localhost:8787/api/rhwp/health
```

프론트 개발 서버는 `/api/rhwp/*` 요청을 `http://localhost:8787`로 프록시합니다.

HWP 파일을 HWPX로 변환하는 CLI도 제공합니다.

```bash
npm run convert:hwp-to-hwpx -- input.hwp output.hwpx
```

서버 API로 변환:

```bash
curl -F file=@input.hwp http://localhost:8787/api/rhwp/convert/hwpx -o output.hwpx
```

웹 폼에서 입력한 값으로 원본 문서를 채우는 API도 제공합니다. 현재는 분석 결과의 `hwpTarget.method`가 `insertTextInCell`인 항목만 보수적으로 채웁니다. 값이 비어 있거나 HWP 위치가 불확실한 필드는 건너뜁니다.

```bash
curl \
  -F file=@input.hwp \
  -F fields=@fields.json \
  -F values=@values.json \
  -F outputFormat=hwp \
  http://localhost:8787/api/rhwp/fill \
  -o filled.hwp
```

응답 헤더 `X-Fill-Summary`에는 삽입/건너뜀/실패 개수가 들어갑니다.

HWP 신청서를 분석해 페이지 이미지, HWPX, 텍스트 JSON, 필드 후보 CSV/JSON을 한 번에 만들 수 있습니다.

```bash
npm run analyze:hwp-form -- input.hwp ./analysis-output
```

## LLM 정밀 분석

학교 Mindlogic 게이트웨이의 OpenAI 호환 API를 사용할 수 있습니다. `keys.env`에 키를 넣으면 `/api/rhwp/analyze?llm=1` 요청에서 규칙 기반 후보를 LLM이 한 번 더 정리합니다.

```bash
export SCHOOL_API_KEY=...
```

기본 설정:

```text
baseUrl: https://factchat-cloud.mindlogic.ai/v1/gateway
model: gpt-5.3-chat-latest
```

옵션으로 모델을 바꾸려면 `keys.env`에 추가합니다.

```bash
export SCHOOL_LLM_MODEL=gpt-5.3-chat-latest
```

현재 기본 LLM 모드는 `direct-evidence`입니다. 규칙 후보를 정답처럼 넘기지 않고, 원본 HWP에서 뽑은 중립 증거를 LLM에 제공합니다.

```text
page text
line ids
table/cell ids
blank input region ids
choice candidates
```

LLM 결과는 다시 서버에서 검증합니다.

```text
evidenceIds 존재 여부
inputRegionId가 실제 blank인지
페이지 유형 적합성
선택지 존재 여부
중복/안내문 라벨 여부
```

응답 필드에는 `status`, `needsReview`, `validation.signals`, `validation.warnings`, `inputRegion`이 포함됩니다.

기존 규칙 후보 정제 방식으로 되돌리고 싶으면:

```bash
curl -F file=@input.hwp "http://localhost:8787/api/rhwp/analyze?llm=1&llmMode=refine"
```

## 현재 한계와 확장 지점

- HWPX는 ZIP/XML 포맷이라 브라우저에서 직접 처리합니다.
- `.hwp` 바이너리는 `server/index.js`의 rhwp 테스트 서버로 추출합니다. 실제 운영에서는 파일 크기 제한, 인증, 악성 파일 격리, 작업 큐, 보관 정책을 추가해야 합니다.
- HWP 입력은 원본 HWP에서 추출 가능한 데이터가 기준입니다. `rhwp`의 HWP→HWPX 변환은 원본과 거의 비슷하지만 조판/레이아웃 차이가 생길 수 있으므로, 변환된 HWPX는 다운로드나 보조 확인용으로만 사용하고 필드 판단의 1차 근거로 삼지 않습니다.
- 처음부터 HWPX로 입력된 파일은 원본 HWPX를 직접 분석합니다.
- 현재 자동 생성은 로컬 규칙 기반입니다. 운영 버전에서는 추출된 텍스트를 LLM에 보내 `{ title, fields }` JSON 스키마로 정규화한 뒤 이 앱의 `fields` 구조에 주입하면 됩니다.

## 폼 필드 구조

```ts
type FormField = {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'email' | 'tel' | 'date' | 'number' | 'select' | 'checkbox';
  required: boolean;
  options: string[];
  helpText?: string;
};
```
