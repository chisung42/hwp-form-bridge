import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  FormInput,
  LayoutList,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import './styles.css';

type FieldType = 'text' | 'textarea' | 'email' | 'tel' | 'date' | 'number' | 'select' | 'checkbox';
type ProcessingState = 'idle' | 'selected' | 'analyzing' | 'done' | 'error';
type FillState = 'idle' | 'filling' | 'done' | 'error';
type CreditState = 'idle' | 'loading' | 'done' | 'error';

type FormField = {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  helpText?: string;
  page?: number | null;
  group?: string;
  source?: string;
  confidence?: number;
  evidence?: string;
  status?: string;
  needsReview?: boolean;
  hwpTarget?: unknown;
  inputRegion?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

type Submission = {
  id: string;
  createdAt: string;
  values: Record<string, string | boolean>;
};

type StoredForm = {
  id: string;
  title: string;
  sourceName?: string;
  fields: FormField[];
  pageCount?: number;
  createdAt?: string;
  hasSourceFile?: boolean;
};

type StoredResponse = {
  id: string;
  createdAt: string;
  values: Record<string, string | boolean>;
};

type RhwpExtractResponse = {
  ok: boolean;
  fileName?: string;
  engine?: string;
  rhwpVersion?: string;
  text?: string;
  error?: string;
  warning?: string;
};

type RhwpAnalysisField = {
  id?: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  page?: number | null;
  group?: string;
  source?: string;
  confidence?: number;
  evidence?: string;
  status?: string;
  needsReview?: boolean;
  hwpTarget?: unknown;
  inputRegion?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

type RhwpAnalysisPage = {
  page: number;
  type: string;
  textSample: string;
  fieldCandidates: RhwpAnalysisField[];
  image?: string;
  layout?: {
    width?: number;
    height?: number;
  };
};

type RhwpAnalysisResponse = {
  ok: boolean;
  fileName?: string;
  engine?: string;
  rhwpVersion?: string;
  pageCount?: number;
  pages?: RhwpAnalysisPage[];
  fields?: RhwpAnalysisField[];
  text?: string;
  error?: string;
  llm?: {
    enabled?: boolean;
    model?: string;
    error?: string;
    documentType?: string;
    notes?: string;
    mode?: string;
    acceptedCount?: number;
    reviewCount?: number;
    rejectedCount?: number;
  };
};

type LlmCreditResponse = {
  ok: boolean;
  configured?: boolean;
  model?: string;
  checkedAt?: string;
  summary?: Array<{
    key: string;
    label: string;
    value: string | number | boolean;
  }>;
  message?: string;
  error?: string;
};

const fieldTypes: Array<{ value: FieldType; label: string }> = [
  { value: 'text', label: '단답형' },
  { value: 'textarea', label: '장문형' },
  { value: 'email', label: '이메일' },
  { value: 'tel', label: '전화번호' },
  { value: 'date', label: '날짜' },
  { value: 'number', label: '숫자' },
  { value: 'select', label: '선택형' },
  { value: 'checkbox', label: '동의/체크' },
];

function makeId(prefix = 'field') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

async function extractTextFromHwpx(file: File) {
  const zip = await JSZip.loadAsync(file);
  const xmlNames = Object.keys(zip.files)
    .filter((name) => /\.xml$/i.test(name))
    .filter((name) => /(^|\/)(Contents|BodyText|Preview|DocInfo|META-INF)\//i.test(name) || /section\d+\.xml$/i.test(name));

  const sectionNames = xmlNames.filter((name) => /section\d+\.xml$/i.test(name));
  const selected = sectionNames.length > 0 ? sectionNames : xmlNames;
  const chunks: string[] = [];

  for (const name of selected) {
    const raw = await zip.file(name)?.async('text');
    if (!raw) continue;
    const parsed = new DOMParser().parseFromString(raw, 'text/xml');
    const parseError = parsed.querySelector('parsererror');
    if (parseError) {
      chunks.push(raw.replace(/<[^>]+>/g, ' '));
      continue;
    }

    const paragraphLike = Array.from(parsed.querySelectorAll('p, hp\\:p, para, text, hp\\:t, t'));
    if (paragraphLike.length > 0) {
      chunks.push(paragraphLike.map((node) => node.textContent ?? '').join('\n'));
    } else {
      chunks.push(parsed.documentElement.textContent ?? '');
    }
  }

  return normalizeText(chunks.join('\n'));
}

async function extractTextWithRhwpServer(file: File) {
  const data = new FormData();
  data.append('file', file);

  const response = await fetch('/api/rhwp/extract', {
    method: 'POST',
    body: data,
  });
  const payload = (await response.json()) as RhwpExtractResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || 'rhwp 서버가 문서를 읽지 못했습니다.');
  }

  return {
    text: normalizeText(payload.text ?? ''),
    engine: payload.engine ?? 'rhwp',
    rhwpVersion: payload.rhwpVersion,
    warning: payload.warning,
  };
}

async function analyzeWithRhwpServer(file: File, useLlm: boolean) {
  const data = new FormData();
  data.append('file', file);

  const params = new URLSearchParams({
    structure: '1',
    images: '1',
  });
  if (useLlm) params.set('llm', '1');

  const response = await fetch(`/api/rhwp/analyze?${params.toString()}`, {
    method: 'POST',
    body: data,
  });
  const payload = (await response.json()) as RhwpAnalysisResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || 'rhwp 서버가 문서를 분석하지 못했습니다.');
  }

  return payload;
}

function getAnalysisCacheKey(file: File, useLlm: boolean) {
  return `analysis:${file.name}:${file.size}:${file.lastModified}:llm-${useLlm ? '1' : '0'}`;
}

function readAnalysisCache(file: File, useLlm: boolean) {
  try {
    const raw = localStorage.getItem(getAnalysisCacheKey(file, useLlm));
    if (!raw) return null;
    return JSON.parse(raw) as RhwpAnalysisResponse;
  } catch {
    return null;
  }
}

function writeAnalysisCache(file: File, useLlm: boolean, value: RhwpAnalysisResponse) {
  try {
    localStorage.setItem(getAnalysisCacheKey(file, useLlm), JSON.stringify(value));
  } catch {
    // Large page images may exceed localStorage. Analysis still works without cache.
  }
}

async function fetchLlmCredits() {
  const response = await fetch('/api/llm/credits');
  const payload = (await response.json()) as LlmCreditResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || 'LLM 크레딧 정보를 가져오지 못했습니다.');
  }

  return payload;
}

async function createSharedForm(form: { title: string; sourceName: string; fields: FormField[]; pageCount: number }, file: File | null) {
  const data = new FormData();
  data.append('form', JSON.stringify(form));
  if (file && /\.(hwp|hwpx)$/i.test(file.name)) data.append('file', file);

  const response = await fetch('/api/forms', {
    method: 'POST',
    body: data,
  });
  const payload = (await response.json()) as { ok: boolean; id?: string; url?: string; form?: StoredForm; error?: string };

  if (!response.ok || !payload.ok || !payload.id || !payload.url) {
    throw new Error(payload.error || '공유 링크 생성에 실패했습니다.');
  }

  return payload;
}

async function fetchSharedForm(id: string) {
  const response = await fetch(`/api/forms/${id}`);
  const payload = (await response.json()) as { ok: boolean; form?: StoredForm; error?: string };
  if (!response.ok || !payload.ok || !payload.form) throw new Error(payload.error || '폼을 찾을 수 없습니다.');
  return payload.form;
}

async function submitSharedResponse(id: string, values: Record<string, string | boolean>) {
  const response = await fetch(`/api/forms/${id}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  const payload = (await response.json()) as { ok: boolean; response?: StoredResponse; error?: string };
  if (!response.ok || !payload.ok || !payload.response) throw new Error(payload.error || '응답 제출에 실패했습니다.');
  return payload.response;
}

async function fetchSharedResponses(id: string) {
  const response = await fetch(`/api/forms/${id}/responses`);
  const payload = (await response.json()) as { ok: boolean; responses?: StoredResponse[]; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error || '응답 목록을 불러오지 못했습니다.');
  return payload.responses ?? [];
}

function normalizeText(value: string) {
  return value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function splitLines(text: string) {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function inferType(label: string, line: string): FieldType {
  const value = `${label} ${line}`;
  if (/이메일|email|e-mail/i.test(value)) return 'email';
  if (/연락처|전화|휴대|휴대폰|핸드폰|tel|phone/i.test(value)) return 'tel';
  if (/날짜|일자|기간|생년월일|년\s*월\s*일|date/i.test(value)) return 'date';
  if (/인원|수량|금액|나이|점수|횟수|number/i.test(value)) return 'number';
  if (/동의|확인|서약|체크/.test(value)) return 'checkbox';
  if (/동기|사유|내용|설명|계획|경력|소개|비고|의견|상세/.test(value)) return 'textarea';
  if (/□|○|①|②|③|④|⑤|\(.*[,/].*\)/.test(line)) return 'select';
  return 'text';
}

function extractOptions(line: string) {
  const choiceText = /[□■☑☐○●]/.test(line) ? line.slice(line.search(/[□■☑☐○●]/)) : line;
  const checkboxOptions = line
    .slice(/[□■☑☐○●]/.test(line) ? line.search(/[□■☑☐○●]/) : 0)
    .split(/[□■☑☐○●]/)
    .map((part) => part.replace(/[:：].*$/, '').trim())
    .filter((part) => part.length > 0 && part.length < 24);

  if (checkboxOptions.length > 1) return checkboxOptions;

  const paren = choiceText.match(/[(:（]\s*([^()（）:：]+(?:[,/|ㆍ·]\s*[^()（）:：]+)+)\s*[)）]?/);
  if (paren) {
    return paren[1]
      .split(/[,/|ㆍ·]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [];
}

function cleanLabel(line: string) {
  return line
    .replace(/[□■☑☐○●].*$/, '')
    .replace(/\([^)]*[,/][^)]*\)/g, '')
    .replace(/[：:]\s*$/, '')
    .replace(/[_＿]{2,}.*/, '')
    .replace(/\s{2,}.*/, '')
    .trim();
}

function inferFields(text: string): FormField[] {
  const lines = splitLines(text);
  const fields: FormField[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const candidate =
      /[:：]\s*$/.test(line) ||
      /[_＿]{3,}/.test(line) ||
      /□|☐|○/.test(line) ||
      /성명|이름|연락처|이메일|주소|생년월일|소속|학교|회사|기관|분야|동기|사유|내용|설명|개인정보/.test(line);

    if (!candidate) continue;

    const label = cleanLabel(line);
    if (!label || label.length > 36 || seen.has(label)) continue;
    seen.add(label);

    const type = inferType(label, line);
    const options = type === 'select' ? extractOptions(line) : [];
    fields.push({
      id: makeId(),
      label,
      type,
      required: !/선택|해당 시|비고/.test(line),
      options,
      helpText: /개인정보|민감정보|주민등록/.test(line) ? '민감정보 수집 항목은 법적 근거와 보관 기간을 확인하세요.' : undefined,
    });
  }

  return fields.length > 0 ? fields : defaultFields();
}

function mapAnalysisFields(fields: RhwpAnalysisField[]): FormField[] {
  return fields
    .filter((field) => field.label?.trim())
    .map((field, index) => ({
      id: field.id || `field_${index + 1}`,
      label: field.label.trim(),
      type: field.type || 'text',
      required: field.required ?? true,
      options: field.options ?? [],
      page: field.page,
      group: field.group,
      source: field.source,
      confidence: field.confidence,
      evidence: field.evidence,
      status: field.status,
      needsReview: field.needsReview,
      hwpTarget: field.hwpTarget,
      inputRegion: field.inputRegion,
      helpText: /개인정보|민감정보|주민등록/.test(`${field.label} ${field.evidence ?? ''}`)
        ? '민감정보 수집 항목은 법적 근거와 보관 기간을 확인하세요.'
        : undefined,
    }));
}

function defaultFields(): FormField[] {
  return [
    { id: makeId(), label: '성명', type: 'text', required: true, options: [] },
    { id: makeId(), label: '연락처', type: 'tel', required: true, options: [] },
    { id: makeId(), label: '이메일', type: 'email', required: true, options: [] },
    { id: makeId(), label: '신청 내용', type: 'textarea', required: true, options: [] },
  ];
}

function escapeCsv(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function statusLabel(state: ProcessingState) {
  if (state === 'selected') return '파일 확인';
  if (state === 'analyzing') return '분석 중';
  if (state === 'done') return '완료';
  if (state === 'error') return '오류';
  return '대기';
}

function formatCreditSummary(info: LlmCreditResponse | null, state: CreditState) {
  if (state === 'loading') return '잔량 확인 중';
  if (!info) return '아직 확인 전';
  if (!info.ok) return info.error || '확인 실패';

  const primary = info.summary?.find((item) => /remain|remaining|balance|credit|잔여|크레딧/i.test(item.key));
  if (primary) return `${formatCreditLabel(primary.key, primary.label)}: ${String(primary.value)}`;
  if (info.summary?.length) {
    return info.summary
      .slice(0, 2)
      .map((item) => `${formatCreditLabel(item.key, item.label)}: ${String(item.value)}`)
      .join(' · ');
  }

  return info.message || '응답은 받았지만 표시할 잔량 필드가 없습니다.';
}

function formatCreditLabel(key: string, label: string) {
  if (/remain|remaining|balance|잔여/i.test(key)) return '잔여';
  if (/used|usage|사용/i.test(key)) return '사용';
  if (/quota|limit|한도/i.test(key)) return '한도';
  if (/credit|크레딧/i.test(key)) return '크레딧';
  return label;
}

function groupFields(fields: FormField[]) {
  const groups = new Map<string, FormField[]>();
  for (const field of fields) {
    const key = field.group?.trim() || '기본 항목';
    groups.set(key, [...(groups.get(key) ?? []), field]);
  }
  return Array.from(groups.entries()).map(([title, items]) => ({ title, fields: items }));
}

function fieldTypeLabel(type: FieldType) {
  return fieldTypes.find((item) => item.value === type)?.label ?? type;
}

function fieldStatusLabel(field: FormField) {
  if (field.status === 'accepted') return '승인';
  if (field.status === 'review' || field.needsReview) return '검수';
  if (field.status === 'rejected') return '제외';
  return '후보';
}

function SurveyPage({ formId }: { formId: string }) {
  const [form, setForm] = useState<StoredForm | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'submitting' | 'done' | 'error'>('loading');
  const [message, setMessage] = useState('신청서를 불러오는 중입니다.');

  useEffect(() => {
    let cancelled = false;
    fetchSharedForm(formId)
      .then((result) => {
        if (cancelled) return;
        setForm(result);
        setState('ready');
        setMessage('필수 항목을 입력한 뒤 제출하세요.');
      })
      .catch((error) => {
        if (cancelled) return;
        setState('error');
        setMessage(String((error as Error).message ?? error));
      });
    return () => {
      cancelled = true;
    };
  }, [formId]);

  async function submitSurvey(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    const missing = form.fields.find((field) => field.required && !values[field.id]);
    if (missing) {
      setMessage(`필수 항목 '${missing.label}'을 입력해야 합니다.`);
      return;
    }

    try {
      setState('submitting');
      await submitSharedResponse(form.id, values);
      setValues({});
      setState('done');
      setMessage('제출이 완료되었습니다.');
    } catch (error) {
      setState('ready');
      setMessage(`제출 실패: ${String((error as Error).message ?? error)}`);
    }
  }

  if (state === 'loading' || state === 'error' || !form) {
    return (
      <main className="survey-shell">
        <section className="survey-card">
          <div className="brand-mark">
            <FileText size={24} />
          </div>
          <h1>{state === 'error' ? '신청서를 열 수 없습니다' : '신청서 불러오기'}</h1>
          <p>{message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="survey-shell">
      <form className="survey-card" onSubmit={submitSurvey}>
        <div className="public-header">
          <p className="eyebrow">온라인 신청서</p>
          <h1>{form.title.replace(/\.[^.]+$/, '')}</h1>
          <p>{message}</p>
        </div>

        {groupFields(form.fields).map((section) => (
          <section className="survey-section" key={section.title}>
            <h2>{section.title}</h2>
            {section.fields.map((field) => (
              <label className="form-control" key={field.id}>
                <span>
                  {field.label}
                  {field.required && <b>*</b>}
                </span>
                {renderInput(field, values[field.id], (value) => {
                  setValues((current) => ({ ...current, [field.id]: value }));
                })}
                {field.helpText && <small>{field.helpText}</small>}
              </label>
            ))}
          </section>
        ))}

        <button className="submit-button" type="submit" disabled={state === 'submitting' || state === 'done'}>
          {state === 'submitting' ? '제출 중' : state === 'done' ? '제출 완료' : '신청서 제출'}
        </button>
      </form>
    </main>
  );
}

function App() {
  const [sourceName, setSourceName] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [analysisPages, setAnalysisPages] = useState<RhwpAnalysisPage[]>([]);
  const [useLlm, setUseLlm] = useState(true);
  const [processingState, setProcessingState] = useState<ProcessingState>('idle');
  const [processingDetail, setProcessingDetail] = useState('파일 대기 중');
  const [fillState, setFillState] = useState<FillState>('idle');
  const [creditState, setCreditState] = useState<CreditState>('idle');
  const [creditInfo, setCreditInfo] = useState<LlmCreditResponse | null>(null);
  const [shareUrl, setShareUrl] = useState('');
  const [sharedFormId, setSharedFormId] = useState('');
  const [shareState, setShareState] = useState<'idle' | 'creating' | 'done' | 'error'>('idle');
  const [sharedResponses, setSharedResponses] = useState<StoredResponse[]>([]);
  const [responsesState, setResponsesState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [showResponseManager, setShowResponseManager] = useState(false);
  const [notice, setNotice] = useState('HWPX 파일을 올리거나 신청서 텍스트를 붙여넣으면 폼 후보를 생성합니다.');

  const requiredCount = useMemo(() => fields.filter((field) => field.required).length, [fields]);
  const acceptedCount = useMemo(() => fields.filter((field) => field.status === 'accepted').length, [fields]);
  const reviewCount = useMemo(() => fields.filter((field) => field.status === 'review' || field.needsReview).length, [fields]);
  const hwpTargetCount = useMemo(() => fields.filter((field) => field.hwpTarget).length, [fields]);
  const filledValueCount = useMemo(
    () => fields.filter((field) => Boolean(formValues[field.id])).length,
    [fields, formValues],
  );
  const fieldGroups = useMemo(() => groupFields(fields), [fields]);
  const selectedField = useMemo(
    () => fields.find((field) => field.id === selectedFieldId) ?? fields.find((field) => field.inputRegion) ?? fields[0],
    [fields, selectedFieldId],
  );
  const selectedPage = useMemo(
    () => analysisPages.find((page) => page.page === selectedField?.page) ?? analysisPages[0],
    [analysisPages, selectedField],
  );

  useEffect(() => {
    void refreshCredits();
  }, []);

  async function refreshCredits() {
    try {
      setCreditState('loading');
      const result = await fetchLlmCredits();
      setCreditInfo(result);
      setCreditState('done');
    } catch (error) {
      setCreditInfo({
        ok: false,
        error: String((error as Error).message ?? error),
      });
      setCreditState('error');
    }
  }

  async function handleFile(file: File) {
    setSourceName(file.name);
    setSourceFile(file);
    setFillState('idle');
    setProcessingState('selected');
    setProcessingDetail(`${file.name} 선택됨`);
    setNotice('파일을 업로드했고 분석을 준비 중입니다.');
    if (/\.(hwp|hwpx)$/i.test(file.name)) {
      try {
        const cached = readAnalysisCache(file, useLlm);
        if (cached?.ok) {
          const analysisFields = mapAnalysisFields(cached.fields ?? []);
          setSourceText(cached.text ?? '');
          setAnalysisPages(cached.pages ?? []);
          setFields(analysisFields.length > 0 ? analysisFields : inferFields(cached.text ?? ''));
          setSelectedFieldId(analysisFields[0]?.id ?? '');
          setProcessingState('done');
          setProcessingDetail(
            `${cached.pageCount ?? 0}페이지 캐시 사용 · ${analysisFields.length}개 항목${
              cached.llm?.mode ? ` · ${cached.llm.mode}` : ''
            }`,
          );
          setNotice('같은 파일의 이전 분석 결과를 불러왔습니다. 새로 분석하려면 브라우저 캐시를 지우거나 파일을 다시 저장한 뒤 업로드하세요.');
          return;
        }
        setProcessingState('analyzing');
        setProcessingDetail(useLlm ? '원본 구조 추출 및 LLM 정밀 분석 중' : '원본 구조 추출 중');
        const result = await analyzeWithRhwpServer(file, useLlm);
        writeAnalysisCache(file, useLlm, result);
        const analysisFields = mapAnalysisFields(result.fields ?? []);
        if (!result.text && analysisFields.length === 0) {
          throw new Error('추출된 텍스트와 후보 필드가 비어 있습니다.');
        }
        setSourceText(result.text ?? '');
        setAnalysisPages(result.pages ?? []);
        setFields(analysisFields.length > 0 ? analysisFields : inferFields(result.text ?? ''));
        setSelectedFieldId(analysisFields[0]?.id ?? '');
        setProcessingState('done');
        setProcessingDetail(
          `${result.pageCount ?? 0}페이지 분석 완료 · ${analysisFields.length}개 항목${
            result.llm?.mode ? ` · ${result.llm.mode}` : ''
          }`,
        );
        setNotice(
          `${result.llm?.enabled && !result.llm.error ? `LLM(${result.llm.model}) 정제 포함, ` : ''}${
            result.engine ?? 'rhwp-analysis'
          } 서버로 ${result.pageCount ?? 0}페이지를 분석하고 신청 필드 후보 ${
            analysisFields.length
          }개를 생성했습니다.${
            typeof result.llm?.acceptedCount === 'number'
              ? ` accepted ${result.llm.acceptedCount}, review ${result.llm.reviewCount ?? 0}.`
              : ''
          }${result.llm?.error ? ` LLM 오류: ${result.llm.error}` : ''}${
            result.rhwpVersion ? ` rhwp ${result.rhwpVersion}` : ''
          }`,
        );
        return;
      } catch (error) {
        try {
          const result = await extractTextWithRhwpServer(file);
          if (!result.text) {
            throw new Error('추출된 텍스트가 비어 있습니다.');
          }
          setSourceText(result.text);
          setAnalysisPages([]);
          setFields(inferFields(result.text));
          setProcessingState('done');
          setProcessingDetail('기본 텍스트 추출 완료');
          setNotice(
            `${result.engine} 서버로 본문을 읽고 기본 신청 필드 후보를 생성했습니다.${
              result.rhwpVersion ? ` rhwp ${result.rhwpVersion}` : ''
            }${result.warning ? ` 경고: ${result.warning}` : ''}`,
          );
          return;
        } catch {
          setProcessingState('error');
          setProcessingDetail('분석 실패');
          setNotice(
            `rhwp 서버 추출 실패: ${String((error as Error).message ?? error)}. 서버가 켜져 있는지 확인하세요.`,
          );
        }
        return;
      }
    }

    if (/\.hwpx$/i.test(file.name)) {
      setProcessingState('analyzing');
      setProcessingDetail('브라우저에서 HWPX XML 추출 중');
      const text = await extractTextFromHwpx(file);
      setSourceText(text);
      setAnalysisPages([]);
      setFields(inferFields(text));
      setProcessingState('done');
      setProcessingDetail('HWPX 텍스트 분석 완료');
      setNotice('브라우저에서 HWPX 본문을 읽고 신청 필드 후보를 생성했습니다. 오른쪽에서 검토한 뒤 공개용 폼으로 쓰면 됩니다.');
      return;
    }

    if (/\.txt$/i.test(file.name)) {
      setProcessingState('analyzing');
      setProcessingDetail('텍스트 분석 중');
      const text = normalizeText(await file.text());
      setSourceText(text);
      setAnalysisPages([]);
      setFields(inferFields(text));
      setProcessingState('done');
      setProcessingDetail('텍스트 분석 완료');
      setNotice('텍스트에서 신청 필드 후보를 생성했습니다.');
      return;
    }

    setProcessingState('error');
    setProcessingDetail('지원하지 않는 파일');
    setNotice('지원 파일은 HWP, HWPX, TXT입니다.');
  }

  function updateField(id: string, patch: Partial<FormField>) {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  }

  function removeField(id: string) {
    setFields((current) => current.filter((field) => field.id !== id));
  }

  function addField() {
    setFields((current) => [...current, { id: makeId(), label: '새 항목', type: 'text', required: false, options: [] }]);
  }

  function submitForm(event: React.FormEvent) {
    event.preventDefault();
    const missing = fields.find((field) => field.required && !formValues[field.id]);
    if (missing) {
      setNotice(`필수 항목 '${missing.label}'을 입력해야 합니다.`);
      return;
    }

    setSubmissions((current) => [
      { id: makeId('submission'), createdAt: new Date().toLocaleString('ko-KR'), values: formValues },
      ...current,
    ]);
    setFormValues({});
    setNotice('응답이 저장되었습니다. 아래에서 CSV 또는 JSON으로 내보낼 수 있습니다.');
  }

  function downloadCsv() {
    const headers = ['제출일시', ...fields.map((field) => field.label)];
    const rows = submissions.map((submission) => [
      submission.createdAt,
      ...fields.map((field) => submission.values[field.id] ?? ''),
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    downloadFile(`${sourceName.replace(/\.[^.]+$/, '') || 'form'}-responses.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
  }

  function downloadSchema() {
    const payload = JSON.stringify({ title: sourceName, fields, submissions }, null, 2);
    downloadFile(`${sourceName.replace(/\.[^.]+$/, '') || 'form'}-schema.json`, payload, 'application/json');
  }

  async function downloadFilledHwp() {
    if (!sourceFile || !/\.(hwp|hwpx)$/i.test(sourceFile.name)) {
      setNotice('채워진 문서를 만들려면 원본 HWP/HWPX 파일이 필요합니다.');
      return;
    }

    const fillableFields = fields.filter((field) => field.hwpTarget && formValues[field.id]);
    if (fillableFields.length === 0) {
      setNotice('현재 입력값 중 원본 HWP 위치가 확인된 항목이 없습니다.');
      return;
    }

    try {
      setFillState('filling');
      setNotice('입력값을 원본 HWP의 확인된 셀 위치에 삽입하는 중입니다.');
      const data = new FormData();
      data.append('file', sourceFile);
      data.append('fields', JSON.stringify(fields));
      data.append('values', JSON.stringify(formValues));
      data.append('outputFormat', /\.hwpx$/i.test(sourceFile.name) ? 'hwpx' : 'hwp');

      const response = await fetch('/api/rhwp/fill', {
        method: 'POST',
        body: data,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || '채워진 문서 생성에 실패했습니다.');
      }

      const blob = await response.blob();
      const summary = parseHeaderJson(response.headers.get('X-Fill-Summary'));
      const fallbackName = `${sourceName.replace(/\.[^.]+$/, '') || 'document'}-filled.${
        /\.hwpx$/i.test(sourceFile.name) ? 'hwpx' : 'hwp'
      }`;
      downloadBlob(getDownloadName(response.headers.get('Content-Disposition')) || fallbackName, blob);
      setFillState('done');
      setNotice(
        `채워진 문서를 생성했습니다. ${summary?.filledCount ?? fillableFields.length}개 항목을 삽입했고, ${
          summary?.skippedCount ?? fields.length - fillableFields.length
        }개 항목은 값이 없거나 위치가 불확실해 건너뛰었습니다.`,
      );
    } catch (error) {
      setFillState('error');
      setNotice(`HWP 생성 실패: ${String((error as Error).message ?? error)}`);
    }
  }

  async function handleCreateShareLink() {
    if (fields.length === 0) {
      setNotice('공유 링크를 만들려면 먼저 폼 항목이 필요합니다.');
      return;
    }

    try {
      setShareState('creating');
      const title = sourceName || '신청서';
      const result = await createSharedForm(
        {
          title,
          sourceName: sourceName || title,
          fields,
          pageCount: analysisPages.length,
        },
        sourceFile,
      );
      const absoluteUrl = `${window.location.origin}${result.url}`;
      setShareUrl(absoluteUrl);
      setSharedFormId(result.id ?? '');
      setSharedResponses([]);
      setShareState('done');
      setNotice('신청자용 공유 링크를 생성했습니다. 링크로 제출된 응답은 아래 응답 관리에서 확인할 수 있습니다.');
    } catch (error) {
      setShareState('error');
      setNotice(`공유 링크 생성 실패: ${String((error as Error).message ?? error)}`);
    }
  }

  async function refreshSharedResponses() {
    if (!sharedFormId) return;
    try {
      setResponsesState('loading');
      const responses = await fetchSharedResponses(sharedFormId);
      setSharedResponses(responses);
      setResponsesState('done');
    } catch (error) {
      setResponsesState('error');
      setNotice(`응답 목록 조회 실패: ${String((error as Error).message ?? error)}`);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setNotice('공유 링크를 클립보드에 복사했습니다.');
  }

  function downloadSharedResponsesCsv() {
    const headers = ['제출일시', ...fields.map((field) => field.label)];
    const rows = sharedResponses.map((response) => [
      new Date(response.createdAt).toLocaleString('ko-KR'),
      ...fields.map((field) => response.values[field.id] ?? ''),
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    downloadFile(`${sourceName.replace(/\.[^.]+$/, '') || 'form'}-shared-responses.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
  }

  async function downloadSharedFilledHwp(responseId: string) {
    if (!sharedFormId) return;
    const response = await fetch(`/api/forms/${sharedFormId}/responses/${responseId}/fill`);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setNotice(`채워진 HWP 생성 실패: ${payload?.error || response.statusText}`);
      return;
    }
    const blob = await response.blob();
    downloadBlob(getDownloadName(response.headers.get('Content-Disposition')) || `${responseId}-filled.hwp`, blob);
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="left-pane">
          <div className="brand-row">
            <div className="brand-mark">
              <FileText size={24} />
            </div>
            <div>
              <h1>신청서 폼 변환기</h1>
              <p>HWPX 양식을 읽어 모바일 친화적인 신청 폼으로 바꿉니다.</p>
            </div>
          </div>

          <label className="upload-zone">
            <Upload size={28} />
            <strong>HWPX, HWP, TXT 업로드</strong>
            <span>HWPX는 즉시 분석하고 HWP는 rhwp 서버 연동 대상으로 남깁니다.</span>
            <input
              type="file"
              accept=".hwpx,.hwp,.txt"
              disabled={processingState === 'analyzing'}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </label>

          <div className={`processing-status processing-${processingState}`}>
            <span className="status-dot" />
            <strong>{statusLabel(processingState)}</strong>
            <small>{processingDetail}</small>
          </div>

          <div className={`credit-card credit-${creditState}`}>
            <div>
              <strong>LLM 크레딧</strong>
              <span>{formatCreditSummary(creditInfo, creditState)}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => void refreshCredits()}
              disabled={creditState === 'loading'}
              aria-label="LLM 크레딧 새로고침"
            >
              <RefreshCw size={16} />
            </button>
          </div>

          <label className="analysis-toggle">
            <input
              type="checkbox"
              checked={useLlm}
              disabled={processingState === 'analyzing'}
              onChange={(event) => setUseLlm(event.target.checked)}
            />
            <span>LLM 정밀 분석</span>
          </label>

          <div className="source-box">
            <div className="section-title">
              <LayoutList size={18} />
              <span>원문</span>
            </div>
            <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
            <button
              className="primary-button"
              onClick={() => {
                setFields(inferFields(sourceText));
                if (!sourceName) setSourceName('붙여넣은 신청서');
                setNotice('현재 원문 기준으로 폼 후보를 다시 생성했습니다.');
              }}
              disabled={!sourceText.trim()}
            >
              <Sparkles size={18} />
              폼 후보 생성
            </button>
          </div>
        </aside>

        <section className="center-pane">
          <div className="topbar">
            <div>
              <p className="eyebrow">변환 대상</p>
              <h2>{sourceName || '파일을 업로드하세요'}</h2>
            </div>
            {fields.length > 0 && <div className="summary">
                <span>{fields.length}개 항목</span>
                <span>{requiredCount}개 필수</span>
                {acceptedCount > 0 && <span>{acceptedCount}개 승인</span>}
                {reviewCount > 0 && <span>{reviewCount}개 검수</span>}
                {hwpTargetCount > 0 && <span>{hwpTargetCount}개 HWP 위치</span>}
                {analysisPages.length > 0 && <span>{analysisPages.length}페이지 분석</span>}
                <span>{submissions.length}개 응답</span>
            </div>}
          </div>

          <div className="notice">{notice}</div>

          {fields.length > 0 && (
            <section className={`share-panel share-${shareState}`}>
              <div>
                <div className="section-title">
                  <ExternalLink size={18} />
                  <span>신청자 공유</span>
                </div>
                <p>
                  검수한 폼을 별도 신청자 페이지로 공개하고, 제출된 응답을 이 화면에서 관리합니다.
                </p>
              </div>
              <div className="share-actions">
                <button className="ghost-button" onClick={handleCreateShareLink} disabled={shareState === 'creating'}>
                  <ExternalLink size={17} />
                  {shareUrl ? '링크 다시 생성' : '공유 링크 생성'}
                </button>
                {shareUrl && (
                  <>
                    <button className="ghost-button" onClick={copyShareUrl}>
                      <Copy size={17} />
                      복사
                    </button>
                    <a className="ghost-link" href={shareUrl} target="_blank" rel="noreferrer">
                      열기
                    </a>
                  </>
                )}
              </div>
              {shareUrl && <input className="share-url" value={shareUrl} readOnly aria-label="공유 링크" />}
            </section>
          )}

          {fields.length > 0 ? <section className="builder">
            <div className="section-header">
              <div className="section-title">
                <FormInput size={18} />
                <span>폼 빌더</span>
              </div>
              <button className="ghost-button" onClick={addField}>
                <Plus size={17} />
                항목 추가
              </button>
            </div>

            <div className="sectioned-field-list">
              {fieldGroups.map((section) => (
                <section className="field-section" key={section.title}>
                  <div className="field-section-header">
                    <strong>{section.title}</strong>
                    <span>{section.fields.length}개 항목</span>
                  </div>
                  {section.fields.map((field) => (
                <article
                  className={`field-row ${selectedField?.id === field.id ? 'field-row-selected' : ''}`}
                  key={field.id}
                  onClick={() => setSelectedFieldId(field.id)}
                >
                  <input
                    className="label-input"
                    value={field.label}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => updateField(field.id, { label: event.target.value })}
                    aria-label="항목명"
                  />
                  <select
                    value={field.type}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => updateField(field.id, { type: event.target.value as FieldType })}
                    aria-label="항목 유형"
                  >
                    {fieldTypes.map((type) => (
                      <option value={type.value} key={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateField(field.id, { required: event.target.checked })}
                    />
                    필수
                  </label>
                  <input
                    className="options-input"
                    placeholder="선택지: 쉼표로 구분"
                    value={field.options.join(', ')}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      updateField(field.id, {
                        options: event.target.value
                          .split(',')
                          .map((option) => option.trim())
                          .filter(Boolean),
                      })
                    }
                    disabled={field.type !== 'select'}
                  />
                  <div className="field-meta">
                    {field.page && <span>p.{field.page}</span>}
                    {field.group && <span>{field.group}</span>}
                    {field.status && <span>{field.status}</span>}
                    {Boolean(field.hwpTarget) && <span>hwp</span>}
                    {typeof field.confidence === 'number' && <span>{Math.round(field.confidence * 100)}%</span>}
                  </div>
                  <button className="icon-button" onClick={() => removeField(field.id)} aria-label="항목 삭제">
                    <Trash2 size={17} />
                  </button>
                </article>
              ))}
                </section>
              ))}
            </div>
          </section> : (
            <section className="empty-state">
              <FileText size={32} />
              <h3>아직 생성된 항목이 없습니다</h3>
              <p>HWP/HWPX 파일을 업로드하거나 왼쪽 원문에 신청서 내용을 붙여넣은 뒤 폼 후보를 생성하세요.</p>
            </section>
          )}

          {analysisPages.length > 0 && (
            <section className="responses">
              <div className="section-header">
                <div className="section-title">
                  <FileText size={18} />
                  <span>원본 페이지 검수</span>
                </div>
              </div>
              {selectedPage?.image ? (
                <div className="page-inspector">
                  <div className="page-canvas">
                    <img src={selectedPage.image} alt={`page ${selectedPage.page}`} />
                    {selectedField?.inputRegion && selectedPage.layout?.width && selectedPage.layout?.height && (
                      <span
                        className="region-highlight"
                        style={{
                          left: `${(selectedField.inputRegion.x / selectedPage.layout.width) * 100}%`,
                          top: `${(selectedField.inputRegion.y / selectedPage.layout.height) * 100}%`,
                          width: `${(selectedField.inputRegion.w / selectedPage.layout.width) * 100}%`,
                          height: `${(selectedField.inputRegion.h / selectedPage.layout.height) * 100}%`,
                        }}
                      />
                    )}
                  </div>
                  <div className="inspector-detail">
                    <strong>{selectedField?.label ?? '선택된 항목 없음'}</strong>
                    <span>p.{selectedPage.page} · {selectedPage.type}</span>
                    <span>{selectedField ? fieldTypeLabel(selectedField.type) : ''} · {selectedField ? fieldStatusLabel(selectedField) : ''}</span>
                    {selectedField?.inputRegion ? <em>입력 위치 하이라이트 표시</em> : <em>좌표가 없는 항목입니다</em>}
                  </div>
                </div>
              ) : (
                <div className="inspector-empty">페이지 이미지는 새 HWP/HWPX 분석부터 표시됩니다.</div>
              )}
              <div className="page-list">
                {analysisPages.map((page) => (
                  <article className="page-row" key={page.page}>
                    <strong>p.{page.page}</strong>
                    <span>{page.type}</span>
                    <em>{page.fieldCandidates.length}개 후보</em>
                    <p>{page.textSample}</p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {fields.length > 0 && <section className="responses">
            <div className="section-header">
              <div className="section-title">
                <Check size={18} />
                <span>응답</span>
              </div>
              <div className="action-row">
                <button className="ghost-button" onClick={downloadCsv} disabled={submissions.length === 0}>
                  <Download size={17} />
                  CSV
                </button>
                <button className="ghost-button" onClick={downloadSchema}>
                  <Download size={17} />
                  JSON
                </button>
                <button className="ghost-button" onClick={refreshSharedResponses} disabled={!sharedFormId || responsesState === 'loading'}>
                  <RefreshCw size={17} />
                  공유 응답
                </button>
                <button className="ghost-button" onClick={() => setShowResponseManager(true)} disabled={!sharedFormId}>
                  <Eye size={17} />
                  응답 관리
                </button>
              </div>
            </div>

            <div className="response-table">
              <table>
                <thead>
                  <tr>
                    <th>제출일시</th>
                    {fields.slice(0, 4).map((field) => (
                      <th key={field.id}>{field.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {submissions.length === 0 ? (
                    <tr>
                      <td colSpan={5}>아직 저장된 응답이 없습니다.</td>
                    </tr>
                  ) : (
                    submissions.map((submission) => (
                      <tr key={submission.id}>
                        <td>{submission.createdAt}</td>
                        {fields.slice(0, 4).map((field) => (
                          <td key={field.id}>{String(submission.values[field.id] ?? '')}</td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {sharedFormId && (
              <div className="shared-responses">
                <div className="section-header">
                  <div>
                    <strong>공유 링크 응답</strong>
                    <p>{sharedResponses.length}개 응답 저장됨</p>
                  </div>
                  <button className="ghost-button" onClick={downloadSharedResponsesCsv} disabled={sharedResponses.length === 0}>
                    <Download size={17} />
                    공유 CSV
                  </button>
                </div>
                <div className="response-table">
                  <table>
                    <thead>
                      <tr>
                        <th>제출일시</th>
                        {fields.slice(0, 3).map((field) => (
                          <th key={field.id}>{field.label}</th>
                        ))}
                        <th>문서</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sharedResponses.length === 0 ? (
                        <tr>
                          <td colSpan={5}>아직 공유 링크로 제출된 응답이 없습니다.</td>
                        </tr>
                      ) : (
                        sharedResponses.map((response) => (
                          <tr key={response.id}>
                            <td>{new Date(response.createdAt).toLocaleString('ko-KR')}</td>
                            {fields.slice(0, 3).map((field) => (
                              <td key={field.id}>{String(response.values[field.id] ?? '')}</td>
                            ))}
                            <td>
                              <button className="table-action" onClick={() => void downloadSharedFilledHwp(response.id)}>
                                HWP
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>}
        </section>

        <aside className="preview-pane">
          {fields.length > 0 ? <form className="public-form" onSubmit={submitForm}>
            <div className="public-header">
              <p className="eyebrow">공개 신청 화면</p>
              <h2>{(sourceName || '신청서').replace(/\.[^.]+$/, '')}</h2>
            </div>

            <div className={`fill-panel fill-${fillState}`}>
              <span>{hwpTargetCount}개 항목의 HWP 위치 확인</span>
              <strong>{filledValueCount}개 입력됨</strong>
              <button
                className="ghost-button"
                type="button"
                onClick={downloadFilledHwp}
                disabled={fillState === 'filling' || hwpTargetCount === 0 || filledValueCount === 0}
              >
                <Download size={17} />
                채워진 HWP
              </button>
            </div>

            {fieldGroups.map((section) => (
              <section className="preview-section" key={section.title}>
                <h3>{section.title}</h3>
                {section.fields.map((field) => (
                  <label className="form-control" key={field.id}>
                    <span>
                      {field.label}
                      {field.required && <b>*</b>}
                    </span>
                    {renderInput(field, formValues[field.id], (value) => {
                      setFormValues((current) => ({ ...current, [field.id]: value }));
                    })}
                    {field.helpText && <small>{field.helpText}</small>}
                  </label>
                ))}
              </section>
            ))}

            <button className="submit-button" type="submit">
              신청서 제출
            </button>
          </form> : (
            <div className="preview-empty">
              <FormInput size={32} />
              <strong>공개 신청 화면 대기 중</strong>
              <span>분석된 항목이 생기면 이곳에 사용자용 입력 화면이 표시됩니다.</span>
            </div>
          )}
        </aside>
      </section>
      {showResponseManager && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <section className="response-modal">
            <div className="section-header">
              <div>
                <p className="eyebrow">응답 관리</p>
                <h2>{sourceName || '공유 신청서'}</h2>
              </div>
              <button className="icon-button" onClick={() => setShowResponseManager(false)} aria-label="닫기">
                <X size={18} />
              </button>
            </div>
            <div className="modal-actions">
              <button className="ghost-button" onClick={refreshSharedResponses} disabled={!sharedFormId || responsesState === 'loading'}>
                <RefreshCw size={17} />
                새로고침
              </button>
              <button className="ghost-button" onClick={downloadSharedResponsesCsv} disabled={sharedResponses.length === 0}>
                <Download size={17} />
                CSV
              </button>
            </div>
            <div className="response-cards">
              {sharedResponses.length === 0 ? (
                <div className="preview-empty">
                  <FileText size={30} />
                  <strong>아직 공유 응답이 없습니다</strong>
                  <span>신청자 링크로 제출된 응답이 이곳에 표시됩니다.</span>
                </div>
              ) : (
                sharedResponses.map((response) => (
                  <article className="response-card" key={response.id}>
                    <div>
                      <strong>{new Date(response.createdAt).toLocaleString('ko-KR')}</strong>
                      <span>{response.id}</span>
                    </div>
                    <dl>
                      {fields.slice(0, 6).map((field) => (
                        <React.Fragment key={field.id}>
                          <dt>{field.label}</dt>
                          <dd>{String(response.values[field.id] ?? '') || '-'}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                    <button className="ghost-button" onClick={() => void downloadSharedFilledHwp(response.id)}>
                      <Download size={17} />
                      채워진 HWP
                    </button>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function renderInput(field: FormField, value: string | boolean | undefined, onChange: (value: string | boolean) => void) {
  if (field.type === 'textarea') {
    return <textarea value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} rows={5} />;
  }

  if (field.type === 'select') {
    return (
      <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
        <option value="">선택하세요</option>
        {(field.options.length > 0 ? field.options : ['예', '아니오']).map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <label className="checkline">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        확인했습니다
      </label>
    );
  }

  return (
    <input
      type={field.type}
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
      placeholder="입력하세요"
    />
  );
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  downloadBlob(filename, blob);
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function parseHeaderJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function getDownloadName(contentDisposition: string | null) {
  if (!contentDisposition) return '';
  const match = contentDisposition.match(/filename="([^"]+)"/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const surveyMatch = window.location.pathname.match(/^\/survey\/([^/]+)$/);
createRoot(document.getElementById('root')!).render(
  surveyMatch ? <SurveyPage formId={decodeURIComponent(surveyMatch[1])} /> : <App />,
);
