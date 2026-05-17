# HWP 신청서 폼 변환기

기존 HWP/HWPX 신청 양식의 진입 장벽을 낮추기 위한 MVP입니다. HWPX 파일이나 붙여넣은 신청서 원문을 분석해 구글폼과 비슷한 웹 신청 화면을 만들고, 제출 응답을 CSV/JSON으로 내려받을 수 있습니다.

## 기능

- `.hwpx` 파일을 브라우저에서 직접 읽어 본문 텍스트 추출
- 신청서 원문에서 이름, 연락처, 이메일, 주소, 선택지, 동의 항목 등 폼 후보 자동 생성
- 생성된 항목명, 유형, 필수 여부, 선택지 수정
- 공개 신청 화면 미리보기 및 응답 저장
- 응답 CSV 내보내기, 폼 스키마 JSON 내보내기
- 원본 HWP/HWPX의 확인된 셀 위치에 입력값을 삽입해 채워진 문서 다운로드
- 검수된 폼의 공유 링크 생성, 신청자 전용 페이지(`/survey/:id`) 제공
- 공유 링크로 제출된 응답 조회, CSV 다운로드, 응답별 HWP 생성
- 섹션별 폼 빌더/미리보기, 원본 페이지 이미지와 입력 위치 하이라이트
- 동일 파일 재업로드 시 브라우저 분석 캐시 사용

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

검수한 폼을 신청자에게 공유하려면 웹페이지의 `신청자 공유` 영역에서 공유 링크를 생성합니다. 서버 API는 다음 흐름을 제공합니다.

```text
POST /api/forms
GET /api/forms/:id
POST /api/forms/:id/responses
GET /api/forms/:id/responses
GET /api/forms/:id/responses/:responseId/fill
```

기본 저장소는 개발용 인메모리 방식입니다. 서버를 재시작하면 생성된 공유 링크와 응답은 초기화됩니다. 아래 Supabase 설정을 추가하면 DB와 Storage에 영구 저장합니다.

## Supabase 영구 저장

`keys.env`에 Supabase 설정을 추가하면 공유 폼, 응답, 원본 HWP/HWPX 파일을 Supabase에 저장합니다. 설정이 없으면 기존처럼 개발용 인메모리 저장소를 사용합니다.

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...
export SUPABASE_STORAGE_BUCKET=form-documents
```

초기 스키마는 [docs/supabase-schema.sql](docs/supabase-schema.sql)을 Supabase SQL Editor에서 실행합니다. Storage에는 private bucket `form-documents`를 생성하세요.

브라우저는 Supabase에 직접 접근하지 않습니다.

```text
브라우저 → Express 서버 → Supabase DB/Storage
```

따라서 service role key는 서버의 `keys.env`에만 두고 프론트엔드 환경변수로 넣지 않습니다.

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

크레딧 잔량은 서버가 `keys.env`의 토큰으로 Mindlogic 게이트웨이를 호출해 확인합니다. 브라우저에는 토큰을 내려보내지 않습니다.

```bash
curl http://localhost:8787/api/llm/credits
```

웹페이지 왼쪽 패널의 `LLM 크레딧` 카드에서 잔량을 간단히 확인하고 새로고침할 수 있습니다.

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
