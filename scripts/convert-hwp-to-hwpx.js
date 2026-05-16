import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDocument, initSync, version } from '@rhwp/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const [inputPath, outputPathArg] = process.argv.slice(2);

if (!inputPath) {
  console.error('Usage: node scripts/convert-hwp-to-hwpx.js input.hwp [output.hwpx]');
  process.exit(1);
}

globalThis.measureTextWidth = (font, text) => {
  const fontSize = Number(String(font).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
  return String(text).length * fontSize * 0.56;
};

const wasmPath = path.join(projectRoot, 'node_modules', '@rhwp', 'core', 'rhwp_bg.wasm');
initSync({ module: fs.readFileSync(wasmPath) });

const input = fs.readFileSync(inputPath);
const document = new HwpDocument(new Uint8Array(input));
const output = Buffer.from(document.exportHwpx());
const outputPath =
  outputPathArg ??
  path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.hwpx`);

fs.writeFileSync(outputPath, output);

console.log(
  JSON.stringify(
    {
      ok: true,
      rhwpVersion: version(),
      inputPath,
      outputPath,
      inputBytes: input.length,
      outputBytes: output.length,
      info: JSON.parse(document.getDocumentInfo()),
    },
    null,
    2,
  ),
);
