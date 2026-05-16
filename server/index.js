import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import JSZip from 'jszip';
import sharp from 'sharp';
import { HwpDocument, initSync, version } from '@rhwp/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const wasmPath = path.join(projectRoot, 'node_modules', '@rhwp', 'core', 'rhwp_bg.wasm');
const keysPath = path.join(projectRoot, 'keys.env');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

let rhwpReady = false;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const index = cleaned.indexOf('=');
    if (index < 0) continue;
    const key = cleaned.slice(0, index).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    env[key] = cleaned
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function getGatewayConfig() {
  const env = { ...loadEnvFile(keysPath), ...process.env };
  return {
    apiKey: env.SCHOOL_API_KEY || env.FACTCHAT_API_KEY || env.OPENAI_API_KEY,
    baseUrl: env.SCHOOL_LLM_BASE_URL || env.FACTCHAT_BASE_URL || 'https://factchat-cloud.mindlogic.ai/v1/gateway',
    model: env.SCHOOL_LLM_MODEL || env.FACTCHAT_MODEL || 'gpt-5.3-chat-latest',
  };
}

function ensureRhwp() {
  if (rhwpReady) return;

  // rhwp expects a browser text measurement hook for layout paths. Text
  // extraction does not need pixel-perfect metrics, so a deterministic
  // approximation is enough for this test server.
  globalThis.measureTextWidth = (font, text) => {
    const fontSize = Number(String(font).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
    return String(text).length * fontSize * 0.56;
  };

  initSync({ module: fs.readFileSync(wasmPath) });
  rhwpReady = true;
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractWithRhwp(buffer) {
  ensureRhwp();
  const doc = new HwpDocument(new Uint8Array(buffer));
  const info = parseJson(doc.getDocumentInfo(), {});
  const sectionCount = Number(doc.getSectionCount?.() ?? info.sectionCount ?? 0);
  const paragraphs = [];

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const paragraphCount = Number(doc.getParagraphCount(sectionIndex) ?? 0);

    for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
      const length = Number(doc.getParagraphLength(sectionIndex, paragraphIndex) ?? 0);
      if (length <= 0) continue;

      const text = normalizeText(doc.getTextRange(sectionIndex, paragraphIndex, 0, length));
      if (!text) continue;

      paragraphs.push({
        sectionIndex,
        paragraphIndex,
        text,
      });
    }
  }

  return {
    engine: 'rhwp',
    rhwpVersion: version(),
    info,
    fields: parseJson(doc.getFieldList?.() ?? '[]', []),
    text: normalizeText(paragraphs.map((paragraph) => paragraph.text).join('\n')),
    paragraphs,
  };
}

function convertWithRhwp(buffer, target) {
  ensureRhwp();
  const doc = new HwpDocument(new Uint8Array(buffer));
  const bytes = target === 'hwp' ? doc.exportHwp() : doc.exportHwpx();
  const info = parseJson(doc.getDocumentInfo(), {});

  return {
    bytes: Buffer.from(bytes),
    rhwpVersion: version(),
    info,
  };
}

function safeFileBaseName(fileName) {
  return (path.basename(fileName).replace(/\.[^.]+$/, '') || 'document').replace(/[^\p{L}\p{N}_ -]+/gu, '_');
}

function normalizeFillValue(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') {
    if (field?.type === 'checkbox') return value ? '동의' : '';
    return value ? '예' : '아니오';
  }

  return String(value)
    .replace(/\r/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function isFiniteIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function isSupportedHwpTarget(target) {
  return (
    target?.method === 'insertTextInCell' &&
    isFiniteIndex(target.sectionIndex) &&
    isFiniteIndex(target.parentParaIndex) &&
    isFiniteIndex(target.controlIndex) &&
    isFiniteIndex(target.cellIndex) &&
    isFiniteIndex(target.cellParaIndex) &&
    isFiniteIndex(target.charOffset)
  );
}

function fillHwpWithResponses(buffer, fields, values, outputFormat = 'hwp') {
  ensureRhwp();
  const doc = new HwpDocument(new Uint8Array(buffer));
  const results = [];
  const usedTargets = new Set();

  for (const field of fields) {
    const value = normalizeFillValue(values?.[field.id], field);
    const target = field.hwpTarget;

    if (!value) {
      results.push({
        fieldId: field.id,
        label: field.label,
        status: 'skipped',
        reason: 'empty_value',
      });
      continue;
    }

    if (!isSupportedHwpTarget(target)) {
      results.push({
        fieldId: field.id,
        label: field.label,
        status: 'skipped',
        reason: 'unsupported_or_missing_hwp_target',
      });
      continue;
    }

    const targetKey = [
      target.sectionIndex,
      target.parentParaIndex,
      target.controlIndex,
      target.cellIndex,
      target.cellParaIndex,
    ].join(':');

    if (usedTargets.has(targetKey)) {
      results.push({
        fieldId: field.id,
        label: field.label,
        status: 'skipped',
        reason: 'duplicate_target_cell',
      });
      continue;
    }

    try {
      const rawResult = doc.insertTextInCell(
        target.sectionIndex,
        target.parentParaIndex,
        target.controlIndex,
        target.cellIndex,
        target.cellParaIndex,
        target.charOffset,
        value,
      );
      const insertResult = parseJson(rawResult, { ok: true, raw: rawResult });
      usedTargets.add(targetKey);
      results.push({
        fieldId: field.id,
        label: field.label,
        status: insertResult.ok === false ? 'failed' : 'filled',
        valueLength: value.length,
        target,
        result: insertResult,
      });
    } catch (error) {
      results.push({
        fieldId: field.id,
        label: field.label,
        status: 'failed',
        reason: String(error?.message ?? error),
      });
    }
  }

  const filledCount = results.filter((result) => result.status === 'filled').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  const skippedCount = results.filter((result) => result.status === 'skipped').length;
  const bytes = outputFormat === 'hwpx' ? doc.exportHwpx() : doc.exportHwp();

  return {
    bytes: Buffer.from(bytes),
    rhwpVersion: version(),
    outputFormat,
    summary: {
      total: fields.length,
      filledCount,
      skippedCount,
      failedCount,
      fillRate: fields.length > 0 ? Number((filledCount / fields.length).toFixed(3)) : 0,
    },
    results,
  };
}

function getInputFormat(fileName) {
  if (/\.hwpx$/i.test(fileName)) return 'hwpx';
  if (/\.hwp$/i.test(fileName)) return 'hwp';
  return 'unknown';
}

function inferFieldType(label, evidence) {
  const value = `${label} ${evidence}`;
  if (/^구분$|^지원부문$|^사업분야$|^학적상태$/i.test(label)) return 'select';
  if (/사업자등록번호|학번/.test(label)) return 'text';
  if (/이메일|email|e-mail|E-mail/i.test(value)) return 'email';
  if (/연락처|전화|휴대|휴대폰|핸드폰|휴대전화|tel|phone/i.test(value)) return 'tel';
  if (/날짜|일자|기간|생년월일|창업예정일|년\s*월\s*일|date/i.test(value)) return 'date';
  if (/인원|수량|금액|나이|점수|횟수|사업비|단가|계|비율|number/i.test(value)) return 'number';
  if (/동의|확인|서약|체크|개인정보|서명/.test(value)) return 'checkbox';
  if (/개요|목표|배경|동기|필요성|효과|전략|계획|내용|설명|아이템|경쟁력|시장성|팀빌딩/.test(value)) return 'textarea';
  if (/□|☐|○|①|②|③|④|⑤/.test(evidence)) return 'select';
  return 'text';
}

function extractFieldOptions(evidence) {
  const choiceStart = String(evidence).search(/[□■☑☐○●]/);
  if (choiceStart < 0) return [];

  return String(evidence)
    .slice(choiceStart)
    .split(/[□■☑☐○●]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 30);
}

function asBbox(item) {
  return {
    x: Number(item.x ?? 0),
    y: Number(item.y ?? 0),
    w: Number(item.w ?? 0),
    h: Number(item.h ?? 0),
  };
}

function bboxIntersects(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function bboxContains(container, child) {
  if (!container || !child) return false;
  const cx = child.x + child.w / 2;
  const cy = child.y + child.h / 2;
  return cx >= container.x && cx <= container.x + container.w && cy >= container.y && cy <= container.y + container.h;
}

function normalizeLayoutRuns(layout) {
  return (layout.runs ?? [])
    .filter((run) => String(run.text ?? '').trim())
    .map((run, index) => ({
      id: '',
      kind: 'text_run',
      text: String(run.text ?? ''),
      x: Number(run.x ?? 0),
      y: Number(run.y ?? 0),
      w: Number(run.w ?? 0),
      h: Number(run.h ?? 0),
      fontFamily: run.fontFamily,
      fontSize: run.fontSize,
      bold: Boolean(run.bold),
      paraIdx: run.paraIdx,
      charStart: run.charStart,
      runIndex: index,
    }));
}

function buildLinesFromRuns(runs, page) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];

  for (const run of sorted) {
    const group = groups.find((candidate) => Math.abs(candidate.y - run.y) <= Math.max(3, run.h * 0.35));
    if (group) {
      group.runs.push(run);
      group.y = Math.min(group.y, run.y);
      group.x = Math.min(group.x, run.x);
      group.maxY = Math.max(group.maxY, run.y + run.h);
      group.maxX = Math.max(group.maxX, run.x + run.w);
    } else {
      groups.push({
        y: run.y,
        x: run.x,
        maxY: run.y + run.h,
        maxX: run.x + run.w,
        runs: [run],
      });
    }
  }

  return groups
    .map((group, index) => {
      const lineRuns = group.runs.sort((a, b) => a.x - b.x);
      return {
        id: `p${page}_line_${index + 1}`,
        kind: 'line',
        text: normalizeText(lineRuns.map((run) => run.text).join(' ')),
        x: group.x,
        y: group.y,
        w: group.maxX - group.x,
        h: group.maxY - group.y,
        runIds: lineRuns.map((run) => run.id),
      };
    })
    .filter((line) => line.text);
}

function buildChoicesFromLines(lines, page) {
  const choices = [];
  const markerPattern = /[□☐○●■☑]\s*([^□☐○●■☑\n]{1,40})/g;

  for (const line of lines) {
    const options = [];
    let match;
    markerPattern.lastIndex = 0;
    while ((match = markerPattern.exec(line.text))) {
      const text = match[1].trim().replace(/[,:：;；]$/, '');
      if (!text || text.length > 30) continue;
      options.push({
        text,
        marker: match[0].trim()[0],
      });
    }

    if (options.length < 2) continue;
    const label = line.text.slice(0, line.text.indexOf(options[0].marker ?? '□')).trim();
    choices.push({
      id: `p${page}_choice_${choices.length + 1}`,
      kind: 'choice_group',
      page,
      labelHint: label.length <= 40 ? label : '',
      options,
      evidenceText: line.text,
      x: line.x,
      y: line.y,
      w: line.w,
      h: line.h,
      lineId: line.id,
    });
  }

  return choices;
}

function buildTablesFromLayout(controlLayout, runs) {
  const tables = (controlLayout.controls ?? [])
    .filter((control) => control.type === 'table')
    .map((table, tableIndex) => {
      const cells = (table.cells ?? []).map((cell) => {
        const cellRuns = runs.filter((run) => bboxContains(cell, run));
        const text = normalizeText(cellRuns.map((run) => run.text).join(' '));
        return {
          id: '',
          kind: 'table_cell',
          row: cell.row,
          col: cell.col,
          rowSpan: cell.rowSpan,
          colSpan: cell.colSpan,
          cellIdx: cell.cellIdx,
          x: cell.x,
          y: cell.y,
          w: cell.w,
          h: cell.h,
          text,
          isBlank: !text,
        };
      });

      return {
        id: '',
        kind: 'table',
        tableIndex,
        x: table.x,
        y: table.y,
        w: table.w,
        h: table.h,
        rowCount: table.rowCount,
        colCount: table.colCount,
        secIdx: table.secIdx,
        paraIdx: table.paraIdx,
        controlIdx: table.controlIdx,
        cells,
      };
    });

  const blanks = [];
  for (const table of tables) {
    for (const cell of table.cells) {
      if (!cell.isBlank) continue;
      const leftLabel = table.cells.find(
        (candidate) =>
          candidate.row === cell.row &&
          candidate.col + (candidate.colSpan ?? 1) === cell.col &&
          candidate.text &&
          candidate.text.length <= 40,
      );
      const aboveLabel = table.cells.find(
        (candidate) =>
          candidate.col === cell.col &&
          candidate.row + (candidate.rowSpan ?? 1) === cell.row &&
          candidate.text &&
          candidate.text.length <= 40,
      );
      blanks.push({
        id: '',
        kind: 'blank_region',
        tableIndex: table.tableIndex,
        row: cell.row,
        col: cell.col,
        x: cell.x,
        y: cell.y,
        w: cell.w,
        h: cell.h,
        nearLabel: leftLabel?.text || aboveLabel?.text || '',
        labelDirection: leftLabel ? 'left' : aboveLabel ? 'above' : 'unknown',
      });
    }
  }

  return { tables, blanks };
}

function assignEvidenceIds(page, layoutRuns, lines, tables, blanks, choices) {
  layoutRuns.forEach((run, index) => {
    run.id = `p${page}_run_${index + 1}`;
    run.page = page;
  });
  tables.forEach((table, tableIndex) => {
    table.id = `p${page}_table_${tableIndex + 1}`;
    table.page = page;
    table.cells.forEach((cell) => {
      cell.id = `${table.id}_cell_${cell.cellIdx}`;
      cell.page = page;
      cell.tableId = table.id;
    });
  });
  blanks.forEach((blank, index) => {
    blank.id = `p${page}_blank_${index + 1}`;
    blank.page = page;
    const table = tables.find((candidate) => candidate.tableIndex === blank.tableIndex);
    blank.tableId = table?.id ?? '';
    const cell = table?.cells.find((candidate) => candidate.row === blank.row && candidate.col === blank.col);
    blank.cellId = cell?.id ?? '';
  });
  choices.forEach((choice, index) => {
    choice.id = `p${page}_choice_${index + 1}`;
    choice.page = page;
  });
}

function buildEvidenceIndex(pages) {
  const index = new Map();
  for (const page of pages) {
    for (const run of page.layout?.runs ?? []) index.set(run.id, run);
    for (const line of page.lines ?? []) index.set(line.id, line);
    for (const table of page.tables ?? []) {
      index.set(table.id, table);
      for (const cell of table.cells ?? []) index.set(cell.id, cell);
    }
    for (const blank of page.blanks ?? []) index.set(blank.id, blank);
    for (const choice of page.choices ?? []) index.set(choice.id, choice);
  }
  return index;
}

function resolveHwpTarget(field, evidenceIndex) {
  const region = field.inputRegionId ? evidenceIndex.get(field.inputRegionId) : null;
  const evidenceCells = (field.evidenceIds ?? []).map((id) => evidenceIndex.get(id)).filter((item) => item?.kind === 'table_cell');
  const targetCell =
    region?.kind === 'blank_region'
      ? evidenceIndex.get(region.cellId)
      : region?.kind === 'table_cell'
        ? region
        : evidenceCells[0];
  if (!targetCell?.tableId) return null;

  const table = evidenceIndex.get(targetCell.tableId);
  if (!table) return null;

  return {
    sectionIndex: table.secIdx,
    parentParaIndex: table.paraIdx,
    controlIndex: table.controlIdx,
    cellIndex: targetCell.cellIdx,
    cellParaIndex: 0,
    charOffset: 0,
    sourceRegionId: region?.id ?? '',
    sourceCellId: targetCell.id,
    method: 'insertTextInCell',
  };
}

function isLikelyInstruction(line) {
  return /공고|사업목적|지원대상|지원규모|지원내용|모집기간|신청방법|접수처|문의처|제출서류|신청자격|선정절차|선정방법|지원사항|세부 일정|참고|작성요령|작성설명|제출 시 삭제|전화:|이메일:|https?:\/\//i.test(
    line,
  );
}

function classifyPage(text) {
  if (/\[\s*붙임\s*4\]|＜\s*개인정보 수집|위 사항을 숙지하고 개인정보 수집/.test(text)) return 'privacy_consent';
  if (/사업개요|신청 및 접수|제출서류|신청자격|선정절차|선정방법|지원 내용|세부 일정/.test(text)) return 'notice';
  if (/서\s*약\s*서|서약합니다|대표자만 제출/.test(text)) return 'pledge';
  if (/재학\/?\s*휴학 증명서|증명서/.test(text)) return 'certificate';
  if (/\[\s*참고|집행기준|제외대상 업종/.test(text)) return 'reference';
  if (/\[\s*붙임\s*1\]|2026\s*년\s*충남대학교\s*창업동아리\s*신청서|지원부문.*대표자 성명/s.test(text)) {
    return 'application_form';
  }
  if (/\[\s*붙임\s*2\]|2026\s*년\s*창업동아리\s*사업계획서|󰊱|󰊲|󰊳|󰊴|󰊵|아이템 개요|문제인식|실현가능성|성장 전략|사업비 산정내역/.test(text)) {
    return 'business_plan';
  }
  return 'notice';
}

function pushField(fields, seen, field) {
  const key = `${field.page}:${field.label}`.replace(/\s+/g, '');
  if (!field.label || seen.has(key)) return;
  seen.add(key);
  fields.push({
    id: `field_${String(fields.length + 1).padStart(3, '0')}`,
    required: true,
    options: [],
    confidence: 0.68,
    ...field,
  });
}

function inferFieldsFromPage(page, text) {
  const fields = [];
  const seen = new Set();
  const normalized = normalizeText(text).replace(/[ \t]{2,}/g, ' ');
  const pageType = classifyPage(normalized);
  const lines = normalized
    .split(/\n|(?<=\])\s+|(?=지원부문|사업자등록번호|구분|동아리명|아이템명|사업분야|대표자 성명|지도 교수 성명|창업예정일|성 명|소 속|연 락 처|E-mail|학번|학적상태|대표자명|팀원\s*\d|창업동아리명|동아리대표명|대표자 성명:|성명:)/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (pageType === 'application_form') {
    const directLabels = [
      '지원부문',
      '사업자등록번호',
      '사업자등록일',
      '구분',
      '동아리명',
      '아이템명',
      '사업분야',
      '대표자 성명',
      '대표자 소속',
      '대표자 휴대전화',
      '대표자 E-mail',
      '지도 교수 성명',
      '지도 교수 소속',
      '지도 교수 휴대전화',
      '지도 교수 E-mail',
      '창업예정일',
    ];

    for (const label of directLabels) {
      if (normalized.replace(/\s+/g, '').includes(label.replace(/\s+/g, ''))) {
        pushField(fields, seen, {
          label,
          type: inferFieldType(label, label),
          page,
          group: '창업동아리 신청서',
          source: 'page_text',
          evidence: /지원부문/.test(label) ? '□ 학부 □ 대학원' : label,
          confidence: 0.76,
        });
      }
    }

    for (const member of ['대표자명', '팀원 1', '팀원 2', '팀원 3', '팀원 4']) {
      for (const label of ['성명', '학교', '학과(부)', '학번', '학적상태', '연락처', 'E-mail']) {
        pushField(fields, seen, {
          label: `${member} ${label}`,
          type: inferFieldType(label, label),
          page,
          group: '창업동아리 명단',
          source: 'table_header',
          evidence: `${member} / ${label}`,
          confidence: member === '대표자명' ? 0.78 : 0.7,
        });
      }
    }
  }

  if (pageType === 'business_plan') {
    const labels = [
      '동아리 명',
      '대표자 명',
      '아이템명',
      '아이템 한줄 소개',
      '아이템/아이디어 기능',
      '아이템 관련 보유기술',
      '창업목표',
      '창업 배경 및 개발동기',
      '창업 아이템의 목적 및 필요성',
      '보유한 아이디어/아이템의 파급효과',
      '사업화 전략',
      '시장성 및 아이템 경쟁력',
      '자금조달 계획',
      '시장진입 및 성과창출 전략',
      '팀빌딩',
      '사업비 산정내역',
    ];

    for (const label of labels) {
      if (normalized.replace(/\s+/g, '').includes(label.replace(/\s+/g, ''))) {
        pushField(fields, seen, {
          label,
          type: ['동아리 명', '대표자 명', '아이템명'].includes(label) ? 'text' : 'textarea',
          page,
          group: '사업계획서',
          source: 'section_heading',
          evidence: label,
          confidence: 0.72,
        });
      }
    }
  }

  if (pageType === 'pledge') {
    for (const label of ['구분', '학과', '학번', '성명', '생년월일', '창업동아리명', '동아리대표명', '대표자 서명']) {
      if (normalized.replace(/\s+/g, '').includes(label.replace(/\s+/g, ''))) {
        pushField(fields, seen, {
          label,
          type: inferFieldType(label, label),
          page,
          group: '서약서',
          source: 'page_text',
          evidence: label,
          confidence: 0.74,
        });
      }
    }
  }

  if (pageType === 'privacy_consent') {
    for (let index = 1; index <= 10; index += 1) {
      pushField(fields, seen, {
        label: `개인정보 동의자 ${index} 성명`,
        type: 'text',
        page,
        group: '개인정보 수집 및 이용 동의서',
        source: 'repeated_signature_line',
        evidence: '성명: (서명)',
        confidence: 0.65,
      });
      pushField(fields, seen, {
        label: `개인정보 동의자 ${index} 서명`,
        type: 'checkbox',
        page,
        group: '개인정보 수집 및 이용 동의서',
        source: 'repeated_signature_line',
        evidence: '성명: (서명)',
        confidence: 0.65,
      });
    }
  }

  if (fields.length > 0 && pageType !== 'notice') {
    return fields;
  }

  if (['notice', 'reference', 'certificate'].includes(pageType)) {
    return [];
  }

  for (const line of lines) {
    if (isLikelyInstruction(line)) continue;
    const hasBlank = /[:：]\s*$|[_＿]{2,}|□|☐|○/.test(line);
    const hasFormLabel = /성명|이름|연락처|휴대전화|이메일|E-mail|주소|생년월일|소속|학교|학과|학번|분야|동아리|아이템|서명|동의/.test(line);
    if (!hasBlank && !hasFormLabel) continue;
    if (line.length > 80) continue;

    const label = line
      .replace(/[□■☑☐○●].*$/, '')
      .replace(/[：:]\s*$/, '')
      .replace(/[_＿]{2,}.*/, '')
      .trim();
    if (!label) continue;

    const type = inferFieldType(label, line);
    pushField(fields, seen, {
      label,
      type,
      options: type === 'select' ? extractFieldOptions(line) : [],
      page,
      group: pageType,
      source: 'rule',
      evidence: line,
      confidence: 0.58,
    });
  }

  return fields;
}

function normalizeLlmField(field, index) {
  return {
    id: `llm_field_${String(index + 1).padStart(3, '0')}`,
    label: String(field.label ?? '').trim(),
    type: ['text', 'textarea', 'email', 'tel', 'date', 'number', 'select', 'checkbox'].includes(field.type)
      ? field.type
      : 'text',
    required: Boolean(field.required),
    options: Array.isArray(field.options) ? field.options.map(String) : [],
    page: Number(field.page) || null,
    group: String(field.group ?? 'LLM 분석'),
    source: 'llm',
    confidence: Math.max(0, Math.min(1, Number(field.confidence) || 0.75)),
    evidence: String(field.evidence ?? ''),
    evidenceIds: Array.isArray(field.evidenceIds) ? field.evidenceIds.map(String) : [],
    inputRegionId: typeof field.inputRegionId === 'string' ? field.inputRegionId : '',
    needsReview: Boolean(field.needsReview),
    status: 'candidate',
    validation: { passed: false, signals: [], warnings: [] },
  };
}

function compactPageForLlm(page) {
  return {
    page: page.page,
    typeHint: page.type,
    text: page.text.slice(0, 4500),
    lines: (page.lines ?? []).slice(0, 80).map((line) => ({
      id: line.id,
      text: line.text,
      bbox: asBbox(line),
    })),
    tables: (page.tables ?? []).slice(0, 8).map((table) => ({
      id: table.id,
      bbox: asBbox(table),
      rowCount: table.rowCount,
      colCount: table.colCount,
      cells: (table.cells ?? [])
        .filter((cell) => cell.text || cell.isBlank)
        .filter((cell) => cell.text || (page.blanks ?? []).some((blank) => blank.cellId === cell.id))
        .slice(0, 120)
        .map((cell) => ({
          id: cell.id,
          row: cell.row,
          col: cell.col,
          rowSpan: cell.rowSpan,
          colSpan: cell.colSpan,
          text: cell.text,
          isBlank: cell.isBlank,
          bbox: asBbox(cell),
        })),
    })),
    blanks: (page.blanks ?? [])
      .filter((blank) => blank.nearLabel || blank.labelDirection !== 'unknown')
      .slice(0, 80)
      .map((blank) => ({
      id: blank.id,
      nearLabel: blank.nearLabel,
      labelDirection: blank.labelDirection,
      bbox: asBbox(blank),
      cellId: blank.cellId,
    })),
    choices: (page.choices ?? []).map((choice) => ({
      id: choice.id,
      labelHint: choice.labelHint,
      options: choice.options,
      evidenceText: choice.evidenceText,
      lineId: choice.lineId,
      bbox: asBbox(choice),
    })),
  };
}

function fieldSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      documentType: { type: 'string' },
      notes: { type: 'string' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            type: { type: 'string', enum: ['text', 'textarea', 'email', 'tel', 'date', 'number', 'select', 'checkbox'] },
            required: { type: 'boolean' },
            options: { type: 'array', items: { type: 'string' } },
            page: { type: 'integer' },
            group: { type: 'string' },
            confidence: { type: 'number' },
            evidence: { type: 'string' },
            evidenceIds: { type: 'array', items: { type: 'string' } },
            inputRegionId: { type: 'string' },
            needsReview: { type: 'boolean' },
          },
          required: [
            'label',
            'type',
            'required',
            'options',
            'page',
            'group',
            'confidence',
            'evidence',
            'evidenceIds',
            'inputRegionId',
            'needsReview',
          ],
        },
      },
    },
    required: ['documentType', 'notes', 'fields'],
  };
}

function validateAndScoreFields(fields, analysis) {
  const evidenceIndex = buildEvidenceIndex(analysis.pages);
  const pageTypes = new Map(analysis.pages.map((page) => [page.page, page.type]));
  const seen = new Map();

  return fields.map((field, index) => {
    const evidenceObjects = (field.evidenceIds ?? []).map((id) => evidenceIndex.get(id)).filter(Boolean);
    const inputRegion = field.inputRegionId ? evidenceIndex.get(field.inputRegionId) : null;
    const hwpTarget = resolveHwpTarget(field, evidenceIndex);
    const pageType = pageTypes.get(field.page);
    const signals = [];
    const warnings = [];
    let score = 0.18;

    if (field.source === 'llm-direct' || field.source === 'llm') {
      score += 0.2;
      signals.push('llm_extracted');
    }
    if ((field.confidence ?? 0) >= 0.8) {
      score += 0.12;
      signals.push('llm_high_confidence');
    }
    if (evidenceObjects.length > 0) {
      score += 0.16;
      signals.push('evidence_ids_exist');
    } else {
      warnings.push('no_evidence_id');
      score -= 0.12;
    }
    if (inputRegion?.kind === 'blank_region') {
      score += 0.22;
      signals.push('blank_region_match');
    } else if (field.inputRegionId) {
      warnings.push('input_region_not_blank');
    } else {
      warnings.push('no_input_region');
    }
    if (evidenceObjects.some((item) => item.kind === 'table_cell') || inputRegion?.cellId) {
      score += 0.14;
      signals.push('table_structure_match');
    }
    if (hwpTarget) {
      score += 0.08;
      signals.push('hwp_target_resolved');
    } else if (['text', 'email', 'tel', 'date', 'number'].includes(field.type)) {
      warnings.push('no_hwp_target');
    }
    if (field.type === 'select') {
      if ((field.options ?? []).length > 0) {
        score += 0.08;
        signals.push('select_options_present');
      } else {
        warnings.push('select_without_options');
        score -= 0.1;
      }
    }
    if (['application_form', 'business_plan', 'pledge', 'privacy_consent'].includes(pageType)) {
      score += 0.1;
      signals.push('form_like_page');
    }
    if (['notice', 'reference', 'certificate'].includes(pageType)) {
      warnings.push(`non_form_page:${pageType}`);
      score -= 0.28;
    }
    if (field.label.length > 42 || /작성요령|작성설명|제출|공고|문의|참고|삭제/.test(field.label)) {
      warnings.push('label_looks_instructional');
      score -= 0.18;
    }

    const duplicateKey = `${field.page}:${field.group}:${field.label}`.replace(/\s+/g, '').toLowerCase();
    if (seen.has(duplicateKey)) {
      warnings.push('duplicate_label');
      score -= 0.2;
    } else {
      seen.set(duplicateKey, true);
    }

    const finalConfidence = Math.max(0, Math.min(0.99, Number(((field.confidence ?? 0.75) * 0.45 + score * 0.55).toFixed(3))));
    const status = finalConfidence >= 0.82 && warnings.length <= 1 ? 'accepted' : finalConfidence >= 0.58 ? 'review' : 'rejected';

    return {
      ...field,
      id: field.id || `field_${String(index + 1).padStart(3, '0')}`,
      confidence: finalConfidence,
      status,
      needsReview: field.needsReview || status !== 'accepted',
      inputRegion: inputRegion ? asBbox(inputRegion) : undefined,
      hwpTarget: hwpTarget ?? undefined,
      validation: {
        passed: status !== 'rejected',
        signals,
        warnings,
      },
    };
  });
}

async function extractFieldsDirectWithLlm(analysis) {
  const { apiKey, baseUrl, model } = getGatewayConfig();
  if (!apiKey) {
    return {
      enabled: false,
      mode: 'direct-evidence',
      model,
      error: 'SCHOOL_API_KEY가 없습니다.',
      fields: analysis.fields,
    };
  }

  const pages = analysis.pages
    .filter((page) => !['notice', 'reference', 'certificate'].includes(page.type) || (page.blanks?.length ?? 0) > 0)
    .map(compactPageForLlm);

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You convert Korean HWP/HWPX application documents into web form schemas. Use only provided evidence. Extract fields users must fill in. Exclude announcements, instructions, references, examples, and submission guidelines. Every field should cite evidenceIds and, when possible, an inputRegionId from blanks. Mark uncertain fields needsReview=true.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              task: 'Directly extract form fields from neutral document evidence.',
              fieldTypes: ['text', 'textarea', 'email', 'tel', 'date', 'number', 'select', 'checkbox'],
              evidenceRules: [
                'Prefer blank cells and blank regions as input regions.',
                'Use table cells, lines, choices, and blanks as evidence IDs.',
                'Do not invent fields without evidence.',
                'Business plan section headings can be textarea fields even when no blank cell is explicit.',
                'For select fields, include options.',
              ],
              pages,
            },
            null,
            2,
          ),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'hwp_direct_evidence_fields',
          strict: true,
          schema: fieldSchema(),
        },
      },
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM gateway error ${response.status}: ${raw.slice(0, 500)}`);
  }

  const completion = JSON.parse(raw);
  const content = completion.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content);
  const rawFields = (parsed.fields ?? [])
    .map((field, index) => ({
      ...normalizeLlmField(field, index),
      source: 'llm-direct',
    }))
    .filter((field) => field.label && field.page);
  const fields = validateAndScoreFields(rawFields, analysis);

  return {
    enabled: true,
    mode: 'direct-evidence',
    model,
    usage: completion.usage,
    documentType: parsed.documentType,
    notes: parsed.notes,
    fields,
    acceptedCount: fields.filter((field) => field.status === 'accepted').length,
    reviewCount: fields.filter((field) => field.status === 'review').length,
    rejectedCount: fields.filter((field) => field.status === 'rejected').length,
  };
}

async function refineFieldsWithLlm(analysis) {
  const { apiKey, baseUrl, model } = getGatewayConfig();
  if (!apiKey) {
    return {
      enabled: false,
      model,
      error: 'SCHOOL_API_KEY가 없습니다.',
      fields: analysis.fields,
    };
  }

  const relevantPages = analysis.pages
    .filter((page) => !['notice', 'reference', 'certificate'].includes(page.type) || page.fieldCandidates.length > 0)
    .map((page) => ({
      page: page.page,
      type: page.type,
      text: page.text.slice(0, 2500),
      ruleCandidates: page.fieldCandidates.map((field) => ({
        label: field.label,
        type: field.type,
        page: field.page,
        group: field.group,
        evidence: field.evidence,
      })),
    }));

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You extract web form fields from Korean HWP application documents. Return only fields a user must fill in. Exclude announcement text, instructions, references, and submission guidelines. Prefer concise labels suitable for a Google Form-like UI.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              task: 'Refine rule-based HWP form analysis into accurate form fields.',
              fieldTypes: ['text', 'textarea', 'email', 'tel', 'date', 'number', 'select', 'checkbox'],
              pages: relevantPages,
            },
            null,
            2,
          ),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'hwp_form_fields',
          strict: true,
          schema: fieldSchema(),
        },
      },
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM gateway error ${response.status}: ${raw.slice(0, 500)}`);
  }

  const completion = JSON.parse(raw);
  const content = completion.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content);
  const fields = (parsed.fields ?? [])
    .map(normalizeLlmField)
    .filter((field) => field.label && field.page);

  return {
    enabled: true,
    mode: 'refine-rule-candidates',
    model,
    usage: completion.usage,
    documentType: parsed.documentType,
    notes: parsed.notes,
    fields: fields.length > 0 ? fields : analysis.fields,
  };
}

async function analyzeWithRhwp(buffer, fileName, options = {}) {
  ensureRhwp();
  const inputFormat = getInputFormat(fileName);
  const doc = new HwpDocument(new Uint8Array(buffer));
  const info = parseJson(doc.getDocumentInfo(), {});
  const pageCount = doc.pageCount();
  const pages = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const svg = doc.renderPageSvg(pageIndex);
    const layout = parseJson(doc.getPageTextLayout(pageIndex), { runs: [] });
    const layoutRuns = normalizeLayoutRuns(layout);
    const controlLayout = parseJson(doc.getPageControlLayout(pageIndex), { controls: [] });
    const { tables, blanks } = buildTablesFromLayout(controlLayout, layoutRuns);
    const lines = buildLinesFromRuns(layoutRuns, pageIndex + 1);
    const choices = buildChoicesFromLines(lines, pageIndex + 1);
    assignEvidenceIds(pageIndex + 1, layoutRuns, lines, tables, blanks, choices);
    const text = normalizeText(layoutRuns.map((run) => run.text ?? '').join(' '));
    const pageType = classifyPage(text);
    const page = {
      page: pageIndex + 1,
      type: pageType,
      text,
      textSample: text.slice(0, 700),
      lines,
      choices,
      fieldCandidates: inferFieldsFromPage(pageIndex + 1, text),
    };

    if (options.includeStructure) {
      page.layout = {
        width: layout.width,
        height: layout.height,
        runs: layoutRuns,
      };
      page.tables = tables;
      page.blanks = blanks;
    }

    if (options.useLlm) {
      page.layout = {
        width: layout.width,
        height: layout.height,
        runs: layoutRuns,
      };
      page.tables = tables;
      page.blanks = blanks;
    }

    if (options.includeImages) {
      const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
      page.image = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    }

    pages.push(page);
  }

  const fields = pages.flatMap((page) => page.fieldCandidates);
  fields.forEach((field, index) => {
    field.id = `field_${String(index + 1).padStart(3, '0')}`;
  });
  const paragraphs = extractWithRhwp(buffer).paragraphs;

  const analysis = {
    ok: true,
    fileName,
    engine: 'rhwp-analysis',
    inputFormat,
    analysisSource:
      inputFormat === 'hwp'
        ? 'original-hwp'
        : inputFormat === 'hwpx'
          ? 'original-hwpx'
          : 'original-document',
    conversionPolicy:
      inputFormat === 'hwp'
        ? 'HWP 입력은 원본 HWP에서 추출 가능한 데이터를 우선 사용합니다. HWPX 변환본은 다운로드/보조 산출물로만 취급하며 분석의 기준으로 삼지 않습니다.'
        : 'HWPX 입력은 원본 HWPX를 직접 분석합니다.',
    rhwpVersion: version(),
    info,
    pageCount,
    pages,
    fields,
    text: normalizeText(paragraphs.map((paragraph) => paragraph.text).join('\n')),
    paragraphs,
    hwpxBase64: options.includeHwpx ? Buffer.from(doc.exportHwpx()).toString('base64') : undefined,
    hwpxWarning:
      options.includeHwpx && inputFormat === 'hwp'
        ? '이 HWPX는 rhwp가 HWP 원본에서 내보낸 보조 변환본입니다. 원본 HWP와 레이아웃/조판 차이가 있을 수 있습니다.'
        : undefined,
  };

  if (options.useLlm) {
    try {
      const llm =
        options.llmMode === 'refine'
          ? await refineFieldsWithLlm(analysis)
          : await extractFieldsDirectWithLlm(analysis);
      analysis.llm = llm;
      analysis.fields = llm.fields;
    } catch (error) {
      analysis.llm = {
        enabled: true,
        model: getGatewayConfig().model,
        error: String(error?.message ?? error),
      };
    }
  }

  return analysis;
}

async function extractHwpxXml(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((name) => /\.xml$/i.test(name))
    .filter((name) => /section\d+\.xml$/i.test(name) || /(^|\/)(Contents|BodyText)\//i.test(name));
  const sections = names.filter((name) => /section\d+\.xml$/i.test(name));
  const selected = sections.length > 0 ? sections : names;
  const chunks = [];

  for (const name of selected) {
    const raw = await zip.file(name)?.async('text');
    if (!raw) continue;
    chunks.push(
      raw
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    );
  }

  return {
    engine: 'hwpx-xml-fallback',
    rhwpVersion: version(),
    info: { sectionCount: selected.length },
    fields: [],
    text: normalizeText(chunks.join('\n')),
    paragraphs: [],
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/rhwp/health', (_req, res) => {
  ensureRhwp();
  res.json({
    ok: true,
    rhwpVersion: version(),
    maxUploadMb: 25,
  });
});

app.post('/api/rhwp/extract', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'file 필드로 HWP/HWPX 파일을 업로드하세요.' });
    return;
  }

  try {
    const result = extractWithRhwp(req.file.buffer);
    res.json({
      ok: true,
      fileName: req.file.originalname,
      ...result,
    });
  } catch (error) {
    if (/\.hwpx$/i.test(req.file.originalname)) {
      try {
        const result = await extractHwpxXml(req.file.buffer);
        res.json({
          ok: true,
          fileName: req.file.originalname,
          warning: String(error?.message ?? error),
          ...result,
        });
        return;
      } catch {
        // Fall through to the primary rhwp error below.
      }
    }

    res.status(422).json({
      ok: false,
      fileName: req.file.originalname,
      error: String(error?.message ?? error),
    });
  }
});

app.post('/api/rhwp/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'file 필드로 HWP/HWPX 파일을 업로드하세요.' });
    return;
  }

  try {
    const includeImages = req.query.images === '1';
    const includeHwpx = req.query.hwpx === '1';
    const includeStructure = req.query.structure === '1';
    const useLlm = req.query.llm === '1';
    const llmMode = req.query.llmMode === 'refine' ? 'refine' : 'direct';
    const result = await analyzeWithRhwp(req.file.buffer, req.file.originalname, {
      includeImages,
      includeHwpx,
      includeStructure,
      useLlm,
      llmMode,
    });
    res.json(result);
  } catch (error) {
    res.status(422).json({
      ok: false,
      fileName: req.file.originalname,
      error: String(error?.message ?? error),
    });
  }
});

app.post('/api/rhwp/convert/hwpx', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'file 필드로 HWP 파일을 업로드하세요.' });
    return;
  }

  try {
    const result = convertWithRhwp(req.file.buffer, 'hwpx');
    const baseName = path.basename(req.file.originalname).replace(/\.[^.]+$/, '') || 'document';

    res.setHeader('Content-Type', 'application/hwp+zip');
    res.setHeader('X-Rhwp-Version', result.rhwpVersion);
    res.setHeader('X-Document-Info', encodeURIComponent(JSON.stringify(result.info)));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.hwpx"`);
    res.send(result.bytes);
  } catch (error) {
    res.status(422).json({
      ok: false,
      fileName: req.file.originalname,
      error: String(error?.message ?? error),
    });
  }
});

app.post('/api/rhwp/fill', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'file 필드로 원본 HWP/HWPX 파일을 업로드하세요.' });
    return;
  }

  try {
    const fields = parseJson(req.body.fields ?? '[]', []);
    const values = parseJson(req.body.values ?? '{}', {});
    const outputFormat = req.body.outputFormat === 'hwpx' ? 'hwpx' : 'hwp';

    if (!Array.isArray(fields) || fields.length === 0) {
      res.status(400).json({ ok: false, error: 'fields JSON 배열이 필요합니다.' });
      return;
    }

    const result = fillHwpWithResponses(req.file.buffer, fields, values, outputFormat);
    const baseName = safeFileBaseName(req.file.originalname);
    const extension = outputFormat === 'hwpx' ? 'hwpx' : 'hwp';

    res.setHeader(
      'Content-Type',
      outputFormat === 'hwpx' ? 'application/hwp+zip' : 'application/x-hwp',
    );
    res.setHeader('X-Rhwp-Version', result.rhwpVersion);
    res.setHeader('X-Fill-Summary', encodeURIComponent(JSON.stringify(result.summary)));
    res.setHeader('X-Fill-Results', encodeURIComponent(JSON.stringify(result.results.slice(0, 120))));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(`${baseName}-filled.${extension}`)}"`);
    res.send(result.bytes);
  } catch (error) {
    res.status(422).json({
      ok: false,
      fileName: req.file.originalname,
      error: String(error?.message ?? error),
    });
  }
});

const port = Number(process.env.RHWP_SERVER_PORT ?? 8787);
app.listen(port, () => {
  ensureRhwp();
  console.log(`rhwp test server listening on http://localhost:${port}`);
});
