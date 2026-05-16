import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { HwpDocument, initSync, version } from '@rhwp/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const [inputPath, outputDirArg] = process.argv.slice(2);

if (!inputPath) {
  console.error('Usage: node scripts/analyze-hwp-form.js input.hwp [output-dir]');
  process.exit(1);
}

const outputDir =
  outputDirArg ??
  path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}-analysis`);

globalThis.measureTextWidth = (font, text) => {
  const fontSize = Number(String(font).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
  return String(text).length * fontSize * 0.56;
};

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

function inferType(label, line) {
  const value = `${label} ${line}`;
  if (/이메일|email|e-mail/i.test(value)) return 'email';
  if (/연락처|전화|휴대|휴대폰|핸드폰|tel|phone/i.test(value)) return 'tel';
  if (/날짜|일자|기간|생년월일|년\s*월\s*일|date/i.test(value)) return 'date';
  if (/인원|수량|금액|나이|점수|횟수|number/i.test(value)) return 'number';
  if (/동의|확인|서약|체크|개인정보/.test(value)) return 'checkbox';
  if (/동기|사유|내용|설명|계획|경력|소개|비고|의견|상세|개요|아이템/.test(value)) return 'textarea';
  if (/□|○|①|②|③|④|⑤|\(.*[,/].*\)/.test(line)) return 'select';
  return 'text';
}

function extractOptions(line) {
  const choiceStart = line.search(/[□■☑☐○●]/);
  const choiceText = choiceStart >= 0 ? line.slice(choiceStart) : line;
  const checkboxOptions = choiceText
    .split(/[□■☑☐○●]/)
    .map((part) => part.replace(/[:：].*$/, '').trim())
    .filter((part) => part.length > 0 && part.length < 30);

  if (checkboxOptions.length > 1) return checkboxOptions;

  const paren = choiceText.match(/[(:（]\s*([^()（）:：]+(?:[,/|ㆍ·]\s*[^()（）:：]+)+)\s*[)）]?/);
  if (!paren) return [];

  return paren[1]
    .split(/[,/|ㆍ·]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanLabel(line) {
  return line
    .replace(/[□■☑☐○●].*$/, '')
    .replace(/\([^)]*[,/][^)]*\)/g, '')
    .replace(/[：:]\s*$/, '')
    .replace(/[_＿]{2,}.*/, '')
    .replace(/\s{2,}.*/, ' ')
    .trim();
}

function inferFields(lines, pageTexts) {
  const seen = new Set();
  const fields = [];

  for (const line of lines) {
    const candidate =
      /[:：]\s*$/.test(line) ||
      /[_＿]{3,}/.test(line) ||
      /□|☐|○/.test(line) ||
      /성명|이름|연락처|이메일|주소|생년월일|소속|학교|회사|기관|분야|동기|사유|내용|설명|개인정보|아이템|대표|팀명|학번|학과|서명/.test(line);

    if (!candidate) continue;

    const label = cleanLabel(line);
    if (!label || label.length > 50 || seen.has(label)) continue;
    seen.add(label);

    fields.push({
      id: `field_${String(fields.length + 1).padStart(3, '0')}`,
      label,
      type: inferType(label, line),
      required: !/선택|해당 시|비고/.test(line),
      options: extractOptions(line),
      page: findPage(label, pageTexts),
      evidence: line,
    });
  }

  return fields;
}

function findPage(label, pageTexts) {
  const normalizedLabel = label.replace(/\s+/g, '');
  const index = pageTexts.findIndex((pageText) => pageText.replace(/\s+/g, '').includes(normalizedLabel));
  return index >= 0 ? index + 1 : null;
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
    .map((run) => ({
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
    }));
}

function buildTablesFromLayout(controlLayout, runs) {
  const tables = (controlLayout.controls ?? [])
    .filter((control) => control.type === 'table')
    .map((table, tableIndex) => {
      const cells = (table.cells ?? []).map((cell) => {
        const cellRuns = runs.filter((run) => bboxContains(cell, run));
        const text = normalizeText(cellRuns.map((run) => run.text).join(' '));
        return {
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

function toCsv(fields) {
  const headers = ['id', 'label', 'type', 'required', 'page', 'options', 'evidence'];
  const rows = fields.map((field) => [
    field.id,
    field.label,
    field.type,
    field.required,
    field.page ?? '',
    field.options.join('|'),
    field.evidence,
  ]);
  return [headers, ...rows]
    .map((row) =>
      row
        .map((value) => {
          const text = String(value ?? '');
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\n');
}

initSync({ module: await fs.readFile(path.join(projectRoot, 'node_modules', '@rhwp', 'core', 'rhwp_bg.wasm')) });

const input = await fs.readFile(inputPath);
const doc = new HwpDocument(new Uint8Array(input));
const baseName = path.basename(inputPath, path.extname(inputPath));
const pagesDir = path.join(outputDir, 'pages');
await fs.mkdir(pagesDir, { recursive: true });

const hwpx = Buffer.from(doc.exportHwpx());
await fs.writeFile(path.join(outputDir, `${baseName}.hwpx`), hwpx);

const pageCount = doc.pageCount();
const pageTexts = [];
const layoutPages = [];
const tablePages = [];
const blankPages = [];
const structurePages = [];
for (let page = 0; page < pageCount; page += 1) {
  const svg = doc.renderPageSvg(page);
  const pageName = `page-${String(page + 1).padStart(2, '0')}`;
  await fs.writeFile(path.join(pagesDir, `${pageName}.svg`), svg);
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(path.join(pagesDir, `${pageName}.jpg`));

  const layout = parseJson(doc.getPageTextLayout(page), { runs: [] });
  const runs = normalizeLayoutRuns(layout);
  const controlLayout = parseJson(doc.getPageControlLayout(page), { controls: [] });
  const renderTree = parseJson(doc.getPageRenderTree(page), {});
  const { tables, blanks } = buildTablesFromLayout(controlLayout, runs);
  const pageText = normalizeText(runs.map((run) => run.text ?? '').join(' '));
  pageTexts.push(pageText);
  layoutPages.push({
    page: page + 1,
    width: layout.width,
    height: layout.height,
    runs,
  });
  tablePages.push({
    page: page + 1,
    tables,
  });
  blankPages.push({
    page: page + 1,
    blanks,
  });
  structurePages.push({
    page: page + 1,
    controlLayout,
    renderTree,
  });
}

const sectionCount = Number(doc.getSectionCount?.() ?? 0);
const paragraphs = [];
for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
  const paragraphCount = Number(doc.getParagraphCount(sectionIndex) ?? 0);
  for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
    const length = Number(doc.getParagraphLength(sectionIndex, paragraphIndex) ?? 0);
    if (length <= 0) continue;
    const text = normalizeText(doc.getTextRange(sectionIndex, paragraphIndex, 0, length));
    if (!text) continue;
    paragraphs.push({ sectionIndex, paragraphIndex, text });
  }
}

const lines = normalizeText(paragraphs.map((paragraph) => paragraph.text).join('\n'))
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const fields = inferFields(lines, pageTexts);

await fs.writeFile(
  path.join(outputDir, 'text.json'),
  JSON.stringify(
    {
      source: inputPath,
      rhwpVersion: version(),
      document: parseJson(doc.getDocumentInfo(), {}),
      paragraphs,
      pageTexts,
    },
    null,
    2,
  ),
);
await fs.writeFile(path.join(outputDir, 'fields.json'), JSON.stringify(fields, null, 2));
await fs.writeFile(path.join(outputDir, 'fields.csv'), `\uFEFF${toCsv(fields)}`);
await fs.writeFile(path.join(outputDir, 'layout.json'), JSON.stringify(layoutPages, null, 2));
await fs.writeFile(path.join(outputDir, 'tables.json'), JSON.stringify(tablePages, null, 2));
await fs.writeFile(path.join(outputDir, 'blanks.json'), JSON.stringify(blankPages, null, 2));
await fs.writeFile(path.join(outputDir, 'structure.json'), JSON.stringify(structurePages, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      outputDir,
      rhwpVersion: version(),
      pageCount,
      hwpx: path.join(outputDir, `${baseName}.hwpx`),
      pagesDir,
      fieldsJson: path.join(outputDir, 'fields.json'),
      fieldsCsv: path.join(outputDir, 'fields.csv'),
      layoutJson: path.join(outputDir, 'layout.json'),
      tablesJson: path.join(outputDir, 'tables.json'),
      blanksJson: path.join(outputDir, 'blanks.json'),
      structureJson: path.join(outputDir, 'structure.json'),
      fieldCount: fields.length,
    },
    null,
    2,
  ),
);
