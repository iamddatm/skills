#!/usr/bin/env node
/**
 * skill-stats — 扫描本机 Claude Code 会话日志，统计 Skill 与 MCP 调用，
 * 生成单文件离线看板（数据内联，双击即开，无任何外部依赖）。
 *
 * 用法:
 *   node skill-stats.mjs [--out <path>] [--projects-dir <dir>] [--codex-dir <dir>] [--pi-dir <dir>]
 *     --out           输出 HTML 路径，默认 <系统临时目录>/skill-stats.html
 *     --projects-dir  Claude Code 会话日志目录，默认 ~/.claude/projects
 *     --codex-dir     Codex 会话日志目录，默认 ~/.codex/sessions
 *     --pi-dir        pi 会话日志目录，默认 ~/.pi/agent/sessions
 *     某个源目录不存在时跳过并提示，全部缺失才报错退出
 *
 * 口径（与用户逐条确认过，勿轻易改动）:
 *  - Claude Code: 模型调用 = name === 'Skill' 的 tool_use（取 input.skill / input.args）；
 *    手动触发 = 真实斜杠命令展开（以 <command-message> 开头、与 <command-name> 成对），
 *    剔除内置命令（clear/model/mcp/compact/handoff/init）；MCP = mcp__ 前缀 tool_use，只按 server 汇总
 *  - Codex: 模型调用（skill 加载）= read_mcp_resource 的 uri 或 exec/shell 命令参数命中
 *    skills/<name>/SKILL.md，同一 turn 内同一 skill 去重（两种加载形态都命中只算一次）；
 *    MCP = event_msg 中 item.type 为 McpToolCall 的条目，按 server 汇总（attempted 即计入，含失败）
 *  - pi: 手动触发 = harness 注入 user 消息的 <skill name="X"> 展开；模型调用 = toolCall 参数命中
 *    skills/<name>/SKILL.md 路径（预留规则，当前数据 0 命中）；MCP = mcp__ 前缀 toolCall（预留）
 *  - 各源递归扫描 *.jsonl（Claude 含子代理轨迹 subagents/*.jsonl），源内按调用 id 去重
 *    （tool_use.id / call_id / 行 id），防镜像轨迹重复计数
 *  - 逐行 JSON.parse，绝不用 grep 计数——正文文本里的技能名/命令字样会自我污染
 *  - 通用工具调用（shell_command / bash 等）不计入 skill 调用——统计对象只有 skill 与 MCP
 *  - 自计数: 生成快照的会话本身也会被计入，页脚已注明
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- 参数 ----------
function parseArgs(argv) {
  const opts = {
    out: path.join(os.tmpdir(), 'skill-stats.html'),
    projectsDir: path.join(os.homedir(), '.claude', 'projects'),
    codexDir: path.join(os.homedir(), '.codex', 'sessions'),
    piDir: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--projects-dir') opts.projectsDir = argv[++i];
    else if (argv[i] === '--codex-dir') opts.codexDir = argv[++i];
    else if (argv[i] === '--pi-dir') opts.piDir = argv[++i];
    else {
      console.error('未知参数: ' + argv[i]);
      process.exit(2);
    }
  }
  return opts;
}

// ---------- 扫描 ----------
function listJsonl(root) {
  const out = [];
  // recursive + withFileTypes: Node 20.12+ 提供 parentPath，v22 可用
  const entries = fs.readdirSync(root, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(path.join(e.parentPath, e.name));
    }
  }
  return out;
}

// 内置斜杠命令：不是技能，不计入手动触发
const BUILTIN_CMDS = new Set(['clear', 'model', 'mcp', 'compact', 'handoff', 'init']);
// 合法命令名：小写字母数字短横，长度≥2。
// 用于挡掉正文里引用的占位样例（如 /X、/xxx、/[a-zA-Z0-9:_-]+ 这类文档片段）
const VALID_CMD = /^[a-z0-9][a-z0-9_-]+$/;

function lastSegment(cwd) {
  if (!cwd) return '(未知)';
  const parts = cwd.split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(未知)';
}

function extractClaude(file, records, seen) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // jsonl 里混有非对象行（mode/file-history-snapshot 等）或半截行
    }
    if (!obj || typeof obj !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    if (!ts) continue; // 无时间戳的条目无法参与按天/按范围统计，舍弃
    const cwd = typeof obj.cwd === 'string' ? obj.cwd : '';
    const proj = lastSegment(cwd);

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const b of obj.message.content) {
        if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        // 按 tool_use.id 去重：防不同版本把子代理轨迹同时镜像进主文件造成双计
        if (b.id && seen.has(b.id)) continue;
        if (b.name === 'Skill') {
          const skill =
            b.input && typeof b.input.skill === 'string' && b.input.skill
              ? b.input.skill
              : '(未知)';
          const args = b.input && typeof b.input.args === 'string' ? b.input.args : '';
          records.push({ ts, cwd, proj, name: skill, ch: 'model', args, src: 'claude' });
        } else if (b.name.startsWith('mcp__')) {
          // mcp__<server>__<tool> 只取 server；畸形名（模型笔误）按前缀归属
          const server = b.name.split('__')[1] || b.name.slice(5) || '(未知)';
          records.push({ ts, cwd, proj, name: server, ch: 'mcp', args: '', src: 'claude' });
        } else {
          continue;
        }
        if (b.id) seen.add(b.id);
      }
    } else if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      let txt = '';
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) {
        txt = c
          .filter((b) => b && b.type === 'text')
          .map((b) => String(b.text || ''))
          .join('\n');
      }
      // 只认真实的斜杠命令展开：正文以 <command-message> 开头，后随成对的
      // <command-name>。普通对话里引用该标签的文本（文档、讨论）不符合此格式，不计入
      const m = /^<command-message>[\s\S]*?<command-name>\/([^<\s]+)<\/command-name>/.exec(
        txt
      );
      if (!m) continue;
      const cmd = m[1];
      if (!VALID_CMD.test(cmd) || BUILTIN_CMDS.has(cmd)) continue;
      // 按行 uuid 去重（同一消息可能出现在多份轨迹文件里）
      const key = obj.uuid || file + ':' + ts + ':' + cmd;
      if (seen.has(key)) continue;
      seen.add(key);
      const am = /<command-args>([\s\S]*?)<\/command-args>/.exec(txt);
      records.push({ ts, cwd, proj, name: cmd, ch: 'slash', args: am ? am[1].trim() : '', src: 'claude' });
    }
  }
}

// ---------- Codex 源 ----------
// skill 加载签名：read_mcp_resource 的 uri，或 exec/shell 命令参数里的 SKILL.md 路径
const SKILL_PATH = /[/\\]skills[/\\]([^/\\\s"']+)[/\\]SKILL\.md/i;

function extractCodex(file, records, seen) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let cwd = '';
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    if (!ts) continue;
    if (obj.type === 'session_meta' && obj.payload && typeof obj.payload.cwd === 'string') {
      cwd = obj.payload.cwd;
    }
    const p = obj.payload;
    if (!p || typeof p !== 'object') continue;
    const proj = lastSegment(cwd);
    // MCP 调用：event_msg 里有显式 McpToolCall 签名，按 server 汇总。
    // 去重键带 mcp: 前缀——同一次调用的 response_item 行（function_call 形态）
    // 与 event_msg 行共享 call_id，不隔开会互相误判重复
    if (obj.type === 'event_msg' && p.type === 'item_completed' && p.item && p.item.type === 'McpToolCall') {
      const key = 'mcp:' + (p.item.id || file + ':' + ts);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ ts, cwd, proj, name: p.item.server || '(未知)', ch: 'mcp', args: '', src: 'codex' });
      continue;
    }
    if (obj.type !== 'response_item' || p.type !== 'function_call') continue;
    if (p.call_id && seen.has('fc:' + p.call_id)) continue;
    if (p.call_id) seen.add('fc:' + p.call_id);
    const argsRaw = typeof p.arguments === 'string' ? p.arguments : '';
    const m = SKILL_PATH.exec(argsRaw);
    if (!m) continue;
    // 只有「读文件」形态的调用才算 skill 加载，排除无关命令里顺带提及路径
    if (p.name !== 'read_mcp_resource' && p.name !== 'exec_command' && p.name !== 'shell_command') continue;
    // 同一 turn 内同一 skill 的多种加载形态只算一次；旧版日志无 turn_id 时
    // 退化为按 ts 跨文件去重（镜像轨迹 ts 相同，不同会话不可能同 ts）
    const turn =
      (p.internal_chat_message_metadata_passthrough && p.internal_chat_message_metadata_passthrough.turn_id) || '';
    const k = 'st:' + (turn || ts) + '|' + m[1];
    if (seen.has(k)) continue;
    seen.add(k);
    records.push({ ts, cwd, proj, name: m[1], ch: 'model', args: '', src: 'codex' });
  }
}

// ---------- pi 源 ----------
function extractPi(file, records, seen) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let cwd = '';
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'session' && typeof obj.cwd === 'string') cwd = obj.cwd;
    if (obj.type !== 'message' || !obj.message) continue;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    if (!ts) continue;
    const proj = lastSegment(cwd);
    const msg = obj.message;
    if (msg.role === 'user') {
      // 手动触发：harness 把 <skill name="X"> 展开注入 user 消息
      const txt =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b) => b && b.type === 'text')
                .map((b) => String(b.text || ''))
                .join('\n')
            : '';
      for (const m of txt.matchAll(/<skill name="([^"]+)"/g)) {
        const key = (obj.id || file + ':' + ts) + '|' + m[1];
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ ts, cwd, proj, name: m[1], ch: 'slash', args: '', src: 'pi' });
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || b.type !== 'toolCall' || typeof b.name !== 'string') continue;
        if (b.id && seen.has(b.id)) continue;
        if (b.id) seen.add(b.id);
        const argsStr = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments || '');
        if (b.name.startsWith('mcp__')) {
          const server = b.name.split('__')[1] || b.name.slice(5) || '(未知)';
          records.push({ ts, cwd, proj, name: server, ch: 'mcp', args: '', src: 'pi' });
          continue;
        }
        const m = SKILL_PATH.exec(argsStr);
        if (m) records.push({ ts, cwd, proj, name: m[1], ch: 'model', args: '', src: 'pi' });
      }
    }
  }
}

// ---------- 页面模板 ----------
// 注意：模板内（页面 JS）不使用反引号与 ${，避免与外层模板字面量冲突
const TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Skill & MCP 调用统计</title>
<style>
  :root {
    --plane: #f5f6f8; --surface: #ffffff;
    --ink-1: #1c2430; --ink-2: #5a6678; --ink-3: #8b96a8;
    --grid: #e8ebf0; --axis: #d5dae3;
    --ring: rgba(42, 120, 214, 0.35);
    --s-model: #2a78d6; --s-slash: #eb6834; --s-mcp: #2a9d6e;
  }
  :root[data-theme="dark"] {
    --plane: #12151a; --surface: #1b2027;
    --ink-1: #e8ecf3; --ink-2: #a5b0c2; --ink-3: #6d7889;
    --grid: #262d38; --axis: #333c4a;
    --ring: rgba(57, 135, 229, 0.4);
    --s-model: #3987e5; --s-slash: #d95926; --s-mcp: #42c08c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --plane: #12151a; --surface: #1b2027;
      --ink-1: #e8ecf3; --ink-2: #a5b0c2; --ink-3: #6d7889;
      --grid: #262d38; --axis: #333c4a;
      --ring: rgba(57, 135, 229, 0.4);
      --s-model: #3987e5; --s-slash: #d95926; --s-mcp: #42c08c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px clamp(16px, 4vw, 48px) 40px;
    background: var(--plane); color: var(--ink-1);
    font: 14px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
  h1 { margin: 0 0 4px; font-size: 21px; }
  .meta { color: var(--ink-2); font-size: 12.5px; }
  #themeBtn {
    border: 1px solid var(--axis); background: var(--surface); color: var(--ink-2);
    border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px;
  }
  #themeBtn:focus-visible { outline: 2px solid var(--ring); }
  #tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .tile { background: var(--surface); border: 1px solid var(--grid); border-radius: 12px; padding: 12px 14px; }
  .tile .v { font-size: 24px; font-weight: 650; }
  .tile .k { color: var(--ink-2); font-size: 12.5px; margin-top: 2px; }
  .tile .p { color: var(--ink-3); font-size: 12px; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 18px; color: var(--ink-2); font-size: 13px; }
  .filters input, .filters select {
    background: var(--surface); color: var(--ink-1);
    border: 1px solid var(--axis); border-radius: 8px; padding: 6px 8px; font-size: 13px;
  }
  .filters input:focus-visible, .filters select:focus-visible { outline: 2px solid var(--ring); }
  #resetBtn { border: 1px solid var(--axis); background: var(--surface); color: var(--ink-2); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  .card { background: var(--surface); border: 1px solid var(--grid); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
  .card h2 { margin: 0; font-size: 15.5px; }
  .card .sub { color: var(--ink-3); font-size: 12.5px; margin: 2px 0 14px; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; color: var(--ink-2); font-size: 12.5px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: baseline; }
  .hrow { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; }
  .hlabel { width: 190px; flex: none; text-align: right; color: var(--ink-2); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .htrack { position: relative; flex: 1; height: 20px; background: transparent; }
  .hseg { position: absolute; top: 2px; bottom: 2px; border-radius: 3px; }
  .hcount { width: 64px; flex: none; color: var(--ink-3); font-size: 12px; }
  .empty { color: var(--ink-3); font-size: 13px; padding: 8px 0; }
  .dwrap { overflow-x: auto; }
  .dchart { display: flex; align-items: stretch; gap: 3px; min-width: 640px; }
  .dcol { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 14px; }
  .dval { color: var(--ink-3); font-size: 10px; margin-bottom: 2px; height: 14px; }
  .dstack { width: 100%; display: flex; flex-direction: column-reverse; }
  .dseg { width: 100%; }
  .dlab { color: var(--ink-3); font-size: 10px; margin-top: 4px; height: 14px; white-space: nowrap; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { text-align: left; color: var(--ink-3); font-weight: 500; border-bottom: 1px solid var(--axis); padding: 6px 8px; }
  .tbl td { border-bottom: 1px solid var(--grid); padding: 5px 8px; color: var(--ink-2); }
  .tbl td:first-child { white-space: nowrap; }
  .tbl .nm { color: var(--ink-1); }
  .tbl .args { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { color: var(--ink-3); font-size: 12px; margin-top: 20px; max-width: 980px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Skill &amp; MCP 调用统计</h1>
    <div class="meta">数据快照 __GEN_DATE__ · 来源 __SOURCES__ · 共 __COUNT__ 条 · 范围 __RANGE__</div>
  </div>
  <button id="themeBtn" title="切换深浅色">🌓 主题</button>
</header>

<section id="tiles"></section>

<section class="filters">
  <span>从</span><input type="date" id="fFrom">
  <span>到</span><input type="date" id="fTo">
  <select id="fSource"></select>
  <select id="fProject"></select>
  <select id="fName"></select>
  <select id="fChannel">
    <option value="">全部渠道</option>
    <option value="model">模型调用</option>
    <option value="slash">手动触发</option>
    <option value="mcp">MCP 调用</option>
  </select>
  <button id="resetBtn">重置</button>
</section>

<section class="card">
  <h2>按 Skill 分布</h2>
  <div class="sub">
    <span class="legend">
      <span><span class="dot" style="background:var(--s-model)"></span>模型调用</span>
      <span><span class="dot" style="background:var(--s-slash)"></span>手动触发</span>
    </span>
  </div>
  <div id="barChart"></div>
</section>

<section class="card">
  <h2>按 MCP Server 分布</h2>
  <div class="sub"><span class="legend"><span><span class="dot" style="background:var(--s-mcp)"></span>MCP 调用（模型发起的 mcp__ 工具调用，只按 server 汇总）</span></span></div>
  <div id="mcpChart"></div>
</section>

<section class="card">
  <h2>按天趋势</h2>
  <div class="sub">
    <span class="legend">
      <span><span class="dot" style="background:var(--s-model)"></span>模型调用</span>
      <span><span class="dot" style="background:var(--s-slash)"></span>手动触发</span>
      <span><span class="dot" style="background:var(--s-mcp)"></span>MCP 调用</span>
    </span>
  </div>
  <div class="dwrap"><div class="dchart" id="dayChart"></div></div>
</section>

<section class="card">
  <h2>明细</h2>
  <div class="sub">按时间倒序</div>
  <table class="tbl">
    <thead><tr><th>时间</th><th>名称</th><th>渠道</th><th>来源</th><th>项目</th><th>参数摘要</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</section>

<footer class="foot">
  口径：「模型调用」= 模型主动发起的 Skill 调用（Claude Code 的 Skill 工具调用；Codex 以 read_mcp_resource 或读文件命令加载 skills/&lt;name&gt;/SKILL.md，同一轮内多种形态去重；pi 以 toolCall 读取技能文件）；「手动触发」= 用户触发的技能展开（Claude Code 的真实斜杠命令展开，已剔除 clear、model、mcp、compact、handoff、init 等内置命令；pi 为 harness 注入的 &lt;skill name&gt; 展开）；「MCP 调用」= 模型发起的 MCP 工具调用（Claude Code 的 mcp__&lt;server&gt;__&lt;tool&gt;；Codex 的 McpToolCall 事件），只按 server 汇总，不按具体工具细分。各源分别按唯一 ID 去重；统计含生成快照时正在进行的会话本身（自计数）；通用工具调用（shell_command、bash 等）不计入。各会话日志只保留近期数据，非全量历史。
</footer>

<script>
var DATA = __DATA__;
var CH_LABEL = { model: '模型调用', slash: '手动触发', mcp: 'MCP 调用' };
DATA.forEach(function (r) { r.day = String(r.ts).slice(0, 10); });

function $(id) { return document.getElementById(id); }

var state = { from: '', to: '', src: '', project: '', name: '', ch: '' };

function filtered() {
  return DATA.filter(function (r) {
    if (state.from && r.day < state.from) return false;
    if (state.to && r.day > state.to) return false;
    if (state.src && r.src !== state.src) return false;
    if (state.project && r.proj !== state.project) return false;
    if (state.name && r.name !== state.name) return false;
    if (state.ch && r.ch !== state.ch) return false;
    return true;
  });
}

function countBy(rows, keyFn) {
  var map = {};
  rows.forEach(function (r) {
    var k = keyFn(r);
    map[k] = (map[k] || 0) + 1;
  });
  return map;
}

function entriesSorted(map) {
  return Object.keys(map)
    .map(function (k) { return [k, map[k]]; })
    .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
}

function fillSelect(sel, pairs, allLabel) {
  var cur = sel.value;
  sel.innerHTML = '';
  var o = document.createElement('option');
  o.value = '';
  o.textContent = allLabel;
  sel.appendChild(o);
  pairs.forEach(function (p) {
    var op = document.createElement('option');
    op.value = p[0];
    op.textContent = p[0] + ' (' + p[1] + ')';
    sel.appendChild(op);
  });
  sel.value = cur;
}

function barRow(container, label, title, segs, max) {
  // segs: [{v, color}]；段间用 border-left 制造 2px 表面缝隙
  var row = document.createElement('div');
  row.className = 'hrow';
  var lab = document.createElement('div');
  lab.className = 'hlabel';
  lab.textContent = label;
  lab.title = title;
  row.appendChild(lab);
  var track = document.createElement('div');
  track.className = 'htrack';
  var left = 0;
  segs.forEach(function (s, i) {
    if (s.v <= 0) return;
    var w = (s.v / max) * 100;
    var seg = document.createElement('div');
    seg.className = 'hseg';
    seg.style.left = left + '%';
    seg.style.width = w + '%';
    seg.style.background = s.color;
    if (i > 0 && left > 0) {
      seg.style.borderLeft = '2px solid var(--surface)';
    }
    seg.title = s.title + '：' + s.v;
    track.appendChild(seg);
    left += w;
  });
  row.appendChild(track);
  var cnt = document.createElement('div');
  cnt.className = 'hcount';
  cnt.textContent = segs.reduce(function (a, s) { return a + s.v; }, 0);
  row.appendChild(cnt);
  container.appendChild(row);
}

function renderTiles(rows) {
  var total = rows.length;
  var m = 0, s = 0, p = 0;
  var projs = {};
  var srcs = {};
  rows.forEach(function (r) {
    if (r.ch === 'model') m++;
    else if (r.ch === 'slash') s++;
    else if (r.ch === 'mcp') p++;
    projs[r.proj] = 1;
    srcs[r.src] = 1;
  });
  var tiles = [
    ['总调用', total, ''],
    ['模型调用', m, total ? Math.round((m / total) * 100) + '%' : ''],
    ['手动触发', s, total ? Math.round((s / total) * 100) + '%' : ''],
    ['MCP 调用', p, total ? Math.round((p / total) * 100) + '%' : ''],
    ['来源数', Object.keys(srcs).length, ''],
    ['项目数', Object.keys(projs).length, ''],
  ];
  var box = $('tiles');
  box.innerHTML = '';
  tiles.forEach(function (t) {
    var d = document.createElement('div');
    d.className = 'tile';
    var v = document.createElement('div');
    v.className = 'v';
    v.textContent = t[1];
    var k = document.createElement('div');
    k.className = 'k';
    k.textContent = t[0];
    d.appendChild(v);
    d.appendChild(k);
    if (t[2]) {
      var pp = document.createElement('div');
      pp.className = 'p';
      pp.textContent = '占比 ' + t[2];
      d.appendChild(pp);
    }
    box.appendChild(d);
  });
}

function renderSkillBars(rows) {
  var box = $('barChart');
  box.innerHTML = '';
  var skills = {};
  rows.forEach(function (r) {
    if (r.ch === 'mcp') return;
    if (!skills[r.name]) skills[r.name] = { model: 0, slash: 0 };
    skills[r.name][r.ch]++;
  });
  var list = Object.keys(skills)
    .map(function (k) { return [k, skills[k]]; })
    .sort(function (a, b) {
      return (b[1].model + b[1].slash) - (a[1].model + a[1].slash) || (a[0] < b[0] ? -1 : 1);
    });
  if (!list.length) {
    box.innerHTML = '<div class="empty">（无数据）</div>';
    return;
  }
  var max = list[0][1].model + list[0][1].slash;
  list.forEach(function (e) {
    barRow(box, e[0], e[0], [
      { v: e[1].model, color: 'var(--s-model)', title: '模型调用' },
      { v: e[1].slash, color: 'var(--s-slash)', title: '手动触发' },
    ], max);
  });
}

function renderMcpBars(rows) {
  var box = $('mcpChart');
  box.innerHTML = '';
  var servers = countBy(rows.filter(function (r) { return r.ch === 'mcp'; }), function (r) { return r.name; });
  var list = entriesSorted(servers);
  if (!list.length) {
    box.innerHTML = '<div class="empty">（无数据）</div>';
    return;
  }
  var max = list[0][1];
  list.forEach(function (e) {
    barRow(box, e[0], e[0], [{ v: e[1], color: 'var(--s-mcp)', title: 'MCP 调用' }], max);
  });
}

function renderDayChart(rows) {
  var box = $('dayChart');
  box.innerHTML = '';
  var days = {};
  rows.forEach(function (r) {
    if (!days[r.day]) days[r.day] = { model: 0, slash: 0, mcp: 0 };
    days[r.day][r.ch]++;
  });
  var active = Object.keys(days).sort();
  if (!active.length) {
    box.innerHTML = '<div class="empty">（无数据）</div>';
    return;
  }
  // 补齐连续日历轴：无调用的日子显示空柱，X 轴才是真实时间
  var keys = [];
  var d = new Date(active[0] + 'T00:00:00Z');
  var end = new Date(active[active.length - 1] + 'T00:00:00Z');
  while (d <= end) {
    var k = d.toISOString().slice(0, 10);
    keys.push(k);
    if (!days[k]) days[k] = { model: 0, slash: 0, mcp: 0 };
    d.setUTCDate(d.getUTCDate() + 1);
  }
  var maxSum = 1;
  keys.forEach(function (k) {
    var d = days[k];
    var sum = d.model + d.slash + d.mcp;
    if (sum > maxSum) maxSum = sum;
  });
  // 约 16 个以内横轴标签可读；超出则等距稀疏
  var step = Math.max(1, Math.ceil(keys.length / 16));
  keys.forEach(function (k, i) {
    var d = days[k];
    var sum = d.model + d.slash + d.mcp;
    var col = document.createElement('div');
    col.className = 'dcol';
    col.title = k + '：共 ' + sum + ' 次';
    var val = document.createElement('div');
    val.className = 'dval';
    val.textContent = sum > 0 ? sum : '';
    col.appendChild(val);
    var stack = document.createElement('div');
    stack.className = 'dstack';
    stack.style.height = '150px';
    stack.style.justifyContent = 'flex-start';
    // column-reverse：第一个子元素在底部。顺序：模型(底)/手动(中)/MCP(顶)
    ['model', 'slash', 'mcp'].forEach(function (ch) {
      var v = d[ch];
      if (v <= 0) return;
      var seg = document.createElement('div');
      seg.className = 'dseg';
      seg.style.height = Math.max(2, Math.round((v / maxSum) * 146)) + 'px';
      seg.style.background = ch === 'model' ? 'var(--s-model)' : ch === 'slash' ? 'var(--s-slash)' : 'var(--s-mcp)';
      stack.appendChild(seg);
    });
    col.appendChild(stack);
    var lab = document.createElement('div');
    lab.className = 'dlab';
    lab.textContent = i % step === 0 ? k.slice(5) : '';
    col.appendChild(lab);
    box.appendChild(col);
  });
}

function renderTable(rows) {
  var tb = $('tbody');
  tb.innerHTML = '';
  rows
    .slice()
    .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; })
    .forEach(function (r) {
      var tr = document.createElement('tr');
      var c1 = document.createElement('td');
      c1.textContent = String(r.ts).replace('T', ' ').slice(0, 16);
      var c2 = document.createElement('td');
      c2.className = 'nm';
      c2.textContent = r.name;
      var c3 = document.createElement('td');
      c3.textContent = CH_LABEL[r.ch] || r.ch;
      var cSrc = document.createElement('td');
      cSrc.textContent = r.src;
      var c4 = document.createElement('td');
      c4.textContent = r.proj;
      c4.title = r.cwd;
      var c5 = document.createElement('td');
      c5.className = 'args';
      c5.textContent = r.args;
      c5.title = r.args;
      tr.appendChild(c1);
      tr.appendChild(c2);
      tr.appendChild(c3);
      tr.appendChild(cSrc);
      tr.appendChild(c4);
      tr.appendChild(c5);
      tb.appendChild(tr);
    });
}

function render() {
  var rows = filtered();
  renderTiles(rows);
  renderSkillBars(rows);
  renderMcpBars(rows);
  renderDayChart(rows);
  renderTable(rows);
}

function bind() {
  $('fFrom').addEventListener('change', function () { state.from = this.value; render(); });
  $('fTo').addEventListener('change', function () { state.to = this.value; render(); });
  $('fSource').addEventListener('change', function () { state.src = this.value; render(); });
  $('fProject').addEventListener('change', function () { state.project = this.value; render(); });
  $('fName').addEventListener('change', function () { state.name = this.value; render(); });
  $('fChannel').addEventListener('change', function () { state.ch = this.value; render(); });
  $('resetBtn').addEventListener('click', function () {
    state = { from: '', to: '', src: '', project: '', name: '', ch: '' };
    $('fFrom').value = '';
    $('fTo').value = '';
    $('fSource').value = '';
    $('fProject').value = '';
    $('fName').value = '';
    $('fChannel').value = '';
    render();
  });
  $('themeBtn').addEventListener('click', function () {
    var root = document.documentElement;
    var cur = root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem('skillStatsTheme', root.getAttribute('data-theme')); } catch (e) {}
  });
  try {
    var saved = localStorage.getItem('skillStatsTheme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}
}

fillSelect($('fSource'), entriesSorted(countBy(DATA, function (r) { return r.src; })), '全部来源');
fillSelect($('fProject'), entriesSorted(countBy(DATA, function (r) { return r.proj; })), '全部项目');
fillSelect($('fName'), entriesSorted(countBy(DATA, function (r) { return r.name; })), '全部名称');
bind();
render();
</script>
</body>
</html>
`;

// ---------- 主流程 ----------
const opts = parseArgs(process.argv);
const SOURCES = [
  { key: 'claude', dir: opts.projectsDir, extract: extractClaude },
  { key: 'codex', dir: opts.codexDir, extract: extractCodex },
  { key: 'pi', dir: opts.piDir, extract: extractPi },
];
const records = [];
const filesBySrc = {};
for (const s of SOURCES) {
  if (!fs.existsSync(s.dir)) {
    console.error('提示: ' + s.key + ' 会话日志目录不存在，已跳过: ' + s.dir);
    filesBySrc[s.key] = 0;
    continue;
  }
  const srcFiles = listJsonl(s.dir);
  filesBySrc[s.key] = srcFiles.length;
  const seen = new Set();
  for (const f of srcFiles) s.extract(f, records, seen);
}
if (SOURCES.every((s) => filesBySrc[s.key] === 0)) {
  console.error('所有源的会话日志目录都不存在');
  process.exit(1);
}
const files = SOURCES.reduce((n, s) => n + filesBySrc[s.key], 0);
records.sort((a, b) => (a.ts < b.ts ? -1 : 1));

const nModel = records.filter((r) => r.ch === 'model').length;
const nSlash = records.filter((r) => r.ch === 'slash').length;
const nMcp = records.filter((r) => r.ch === 'mcp').length;
const nSkills = new Set(records.filter((r) => r.ch !== 'mcp').map((r) => r.name)).size;
const nServers = new Set(records.filter((r) => r.ch === 'mcp').map((r) => r.name)).size;
const nProjects = new Set(records.map((r) => r.proj)).size;
const range = records.length
  ? records[0].ts.slice(0, 10) + ' → ' + records[records.length - 1].ts.slice(0, 10)
  : '(空)';

// < 转义防 </script> 注入；数据由生成器注入，页面内全部用 textContent 渲染
// < 转义防 </script> 注入；数据由生成器注入，页面内全部用 textContent 渲染
const dataJson = JSON.stringify(records).replace(/</g, '\\u003c');
const today = new Date().toISOString().slice(0, 10);
const srcNames = SOURCES.filter((s) => filesBySrc[s.key] > 0)
  .map((s) => s.key)
  .join(' + ') || '(无)';
const html = TEMPLATE.split('__DATA__')
  .join(dataJson)
  .split('__GEN_DATE__')
  .join(today)
  .split('__COUNT__')
  .join(String(records.length))
  .split('__RANGE__')
  .join(range)
  .split('__SOURCES__')
  .join(srcNames);

fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
fs.writeFileSync(opts.out, html, 'utf8');

const srcList = SOURCES.filter((s) => filesBySrc[s.key] > 0)
  .map((s) => s.key + ' ' + records.filter((r) => r.src === s.key).length)
  .join(' · ');
console.log('Skill & MCP 调用统计（快照 ' + today + '）');
console.log('  模型调用 : ' + nModel);
console.log('  手动触发 : ' + nSlash);
console.log('  MCP 调用 : ' + nMcp);
console.log('  合计     : ' + records.length);
console.log('  来源     : ' + srcList);
console.log('  Skill ' + nSkills + ' 个 · MCP server ' + nServers + ' 个 · 项目 ' + nProjects + ' 个');
console.log('  范围     : ' + range);
console.log('  会话文件 : ' + files + ' 个');
console.log('  输出     : ' + opts.out);
