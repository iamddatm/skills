#!/usr/bin/env node
// openai-image-gen: text-to-image (gen) / image-to-image (edit) via any
// OpenAI-compatible /v1/images gateway (new-api / sub2api / OpenAI direct).
// Zero dependency, Node >= 18. Config priority: CLI flags > process env > <skill-dir>/.env
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(SKILL_DIR, '.env');
const USAGE = `usage:
  node openai-image-gen.mjs gen  --prompt "..." [--model m] [--size 1024x1024] [--quality auto|low|medium|high] [--n 1] [--out file.png | --out-dir DIR]
  node openai-image-gen.mjs edit --prompt "..." --image <path|url> [--image ...] [--mask <path|url>] [same model/size/out flags]
config: --base-url/--api-key flags, env IMGAPI_BASE_URL/IMGAPI_API_KEY, or ${ENV_FILE}`;

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const KNOWN_FLAGS = ['prompt', 'model', 'size', 'quality', 'n', 'out', 'out-dir', 'base-url', 'api-key', 'mask', 'image'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

// local file -> data URL (OpenAI edits JSON accepts image_url only, no file upload needed)
function toImageRef(spec, label) {
  if (/^(https?:|data:)/i.test(spec)) return { image_url: spec };
  const abs = path.resolve(spec);
  if (!fs.existsSync(abs)) die(`${label} file not found: ${abs}`);
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) die(`${label} unsupported extension (png/jpg/jpeg/webp/gif): ${abs}`);
  return { image_url: `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}` };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (!['gen', 'edit'].includes(cmd)) die(`unknown command: "${cmd ?? ''}"\n${USAGE}`);
  const flags = { image: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument: ${a}\n${USAGE}`);
    const key = a.slice(2);
    if (!KNOWN_FLAGS.includes(key)) die(`unknown flag --${key}\n${USAGE}`);
    const val = argv[++i];
    if (val === undefined) die(`missing value for --${key}`);
    if (key === 'image') flags.image.push(val);
    else flags[key] = val;
  }
  if (!flags.prompt) die(`missing --prompt\n${USAGE}`);
  if (flags.n !== undefined && (!Number.isInteger(Number(flags.n)) || Number(flags.n) <= 0)) die('--n must be a positive integer');

  const env = fs.existsSync(ENV_FILE) ? parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8')) : {};
  const baseUrl = (flags['base-url'] || process.env.IMGAPI_BASE_URL || env.IMGAPI_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = flags['api-key'] || process.env.IMGAPI_API_KEY || env.IMGAPI_API_KEY || '';
  const model = flags.model || process.env.IMGAPI_MODEL || env.IMGAPI_MODEL || 'gpt-image-2';
  if (!baseUrl || !apiKey) die(`IMGAPI_BASE_URL / IMGAPI_API_KEY missing: pass --base-url/--api-key, set env vars, or write ${ENV_FILE}`);

  const endpoint = cmd === 'gen' ? '/v1/images/generations' : '/v1/images/edits';
  const payload = { model, prompt: flags.prompt };
  if (flags.size) payload.size = flags.size;
  if (flags.quality) payload.quality = flags.quality;
  if (flags.n) payload.n = Number(flags.n);
  if (cmd === 'edit') {
    if (!flags.image.length) die('edit requires at least one --image (local path or http(s) URL)');
    payload.images = flags.image.map((s) => toImageRef(s, '--image'));
    if (flags.mask) payload.mask = toImageRef(flags.mask, '--mask');
  }

  let res;
  let text;
  try {
    // no fetch-level timeout: high-quality large images can take minutes, bounded by agent-side terminal timeout
    res = await fetch(baseUrl + endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (e) {
    die(`request failed: ${e.message} (check BASE_URL or network/proxy)`);
  }
  if (!res.ok) die(`HTTP ${res.status}\n${text.slice(0, 2000)}`);
  let data;
  try {
    data = JSON.parse(text).data;
  } catch {
    die(`non-JSON response:\n${text.slice(0, 500)}`);
  }
  if (!Array.isArray(data) || data.length === 0) die('response data[] is empty');
  if (flags.out && data.length > 1) die('--out fits a single image only; use --out-dir for multiple');

  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const outFile = flags.out ? path.resolve(flags.out) : null;
  const outDir = outFile ? path.dirname(outFile) : path.resolve(flags['out-dir'] || process.cwd());
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = cmd === 'gen' ? 't2i' : 'i2i';

  let idx = 0;
  for (const item of data) {
    idx += 1;
    let buf;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const dl = await fetch(item.url).catch((e) => die(`failed to download result image: ${e.message} url=${item.url.slice(0, 120)}`));
      if (!dl.ok) die(`failed to download result image: HTTP ${dl.status} url=${item.url.slice(0, 120)}`);
      buf = Buffer.from(await dl.arrayBuffer());
    } else {
      die('response contains neither b64_json nor url');
    }
    const m = item.url && item.url.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i);
    const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
    const file = outFile || path.join(outDir, `${prefix}-${stamp}${data.length > 1 ? `-${idx}` : ''}.${ext}`);
    fs.writeFileSync(file, buf);
    console.log(`SAVED ${file} (${buf.length} bytes, model=${model})`);
  }
}

main().catch((e) => die(String((e && e.stack) || e)));
