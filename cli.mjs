#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE, VitalsTracker } from './sidecars/vitals/vitals-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VITALS_UI_DIR = join(__dirname, 'sidecars', 'vitals');
const WATCH_TTL_MS = 30 * 60 * 1000;

function parseArgs(argv) {
  const opts = {
    conv: '',
    limit: undefined,
    json: false,
    serve: false,
    port: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--conv' && argv[i + 1]) {
      opts.conv = argv[++i];
    } else if (arg === '--limit' && argv[i + 1]) {
      const val = argv[++i];
      opts.limit = val === 'auto' ? 'auto' : Number(val);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--serve') {
      opts.serve = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--') && Number.isFinite(Number(next))) {
        opts.port = Number(argv[++i]);
      }
    }
  }
  return opts;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function fmtDurationMs(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function printModelRows(title, byModel) {
  if (!Array.isArray(byModel) || byModel.length === 0) return;
  console.log(`\n${title}:`);
  for (const m of byModel) {
    const spd = m.avgTokPerSec !== null ? `${m.avgTokPerSec} tok/s` : '-';
    const stream = m.avgStreamTokPerSec !== null ? ` (流式 ${m.avgStreamTokPerSec})` : '';
    const ttft = m.avgTtftSec !== null ? `TTFT ${m.avgTtftSec}s` : 'TTFT -';
    const think = m.thinkingTokens > 0 ? ` | 思考 ${fmtNum(m.thinkingTokens)}` : '';
    console.log(
      `  - ${m.modelLabel} [${m.steps} 步, ${m.sharePercent}%]: ${spd}${stream} | ${ttft} | 总计 ${fmtNum(m.totalTokens)} tok (输出 ${fmtNum(m.outputTokens)}${think})`,
    );
  }
}

function startStandaloneServer(tracker, port) {
  const watchedConvs = new Map();
  const envConv =
    process.env.ANTIGRAVITY_CONVERSATION_ID && ID_RE.test(process.env.ANTIGRAVITY_CONVERSATION_ID)
      ? process.env.ANTIGRAVITY_CONVERSATION_ID
      : '';
  if (envConv) watchedConvs.set(envConv, Date.now());

  const watchTimer = setInterval(() => {
    const nowMs = Date.now();
    for (const [id, ts] of watchedConvs.entries()) {
      if (id !== envConv && nowMs - ts > WATCH_TTL_MS) {
        watchedConvs.delete(id);
        continue;
      }
      tracker.observeConversation(id);
    }
  }, 1000);
  watchTimer.unref();

  const staticRoutes = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ]);

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('/* standalone mode */\n');
      return;
    }
    if (req.method === 'GET' && staticRoutes.has(url.pathname)) {
      const [file, contentType] = staticRoutes.get(url.pathname);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(readFileSync(join(VITALS_UI_DIR, file), 'utf8'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/vitals') {
      const nowMs = Date.now();
      const convParam = url.searchParams.get('conversationId') || '';
      if (convParam && ID_RE.test(convParam)) watchedConvs.set(convParam, nowMs);
      const snapshot = tracker.getSnapshot({
        conversationId: convParam,
        contextLimit: url.searchParams.get('contextLimit'),
        defaultConversationId: envConv,
      });
      if (snapshot.resolvedConversationId && ID_RE.test(snapshot.resolvedConversationId)) {
        watchedConvs.set(snapshot.resolvedConversationId, nowMs);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`Antigravity Vitals standalone UI: http://127.0.0.1:${addr.port}/`);
  });
}

const opts = parseArgs(process.argv.slice(2));
const timingsFilePath = join(
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || tmpdir(),
  'vitals-step-timings.json',
);
const tracker = new VitalsTracker({ timingsFilePath });

if (opts.serve) {
  startStandaloneServer(tracker, opts.port);
} else {
  const snapshot = tracker.getSnapshot({
    conversationId: opts.conv,
    contextLimit: opts.limit,
    defaultConversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
  });
  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    const c = snapshot.conversation;
    if (!c) {
      console.log('未找到本地 Antigravity 会话日志 (transcript.jsonl)。');
      process.exit(0);
    }
    const modelStr = c.activeModel ? c.activeModel.modelLabel : 'Unknown';
    const speedStr = c.lastTokPerSec !== null ? `${c.lastTokPerSec} tok/s (${c.lastDurationSec}s)` : '暂无已测速步骤';
    const streamStr = c.lastStreamTokPerSec !== null ? ` · 流式 ${c.lastStreamTokPerSec} tok/s` : '';
    const ttftStr = c.lastTtftSec !== null ? ` · TTFT ${c.lastTtftSec}s` : '';
    const avgStr = c.totals.avgTokPerSec !== null ? `${c.totals.avgTokPerSec} tok/s` : '-';
    console.log(`会话 ID:   ${c.conversationId} (${snapshot.resolvedMode})`);
    if (c.titlePreview) console.log(`会话标题:  ${c.titlePreview}`);
    console.log(`当前模型:  ${modelStr}`);
    console.log(`运行状态:  ${c.activity.label}`);
    console.log(`最近速度:  ${speedStr}${streamStr}${ttftStr} | 会话均速: ${avgStr}`);
    console.log(`上下文:    ${fmtNum(c.contextUsed)} / ${fmtNum(c.contextLimit)} (${c.usagePercent}%) · 剩余 ${fmtNum(c.remainTokens)}`);
    console.log(`缓存命中:  最近步 ${c.cacheHitRate}% | 整段会话 ${c.totals.sessionCacheHitRate}%`);
    console.log(`过去 5 小时: ${fmtNum(snapshot.rolling5h.totalTokens)} tokens (${snapshot.rolling5h.conversations} 个会话, 最早一笔于 ${fmtDurationMs(snapshot.rolling5h.resetInMs)} 后滑出)`);
    console.log(`今日累计:  ${fmtNum(snapshot.today.totalTokens)} tokens (${snapshot.today.conversations} 个会话)`);
    printModelRows('分模型统计 (当前会话)', c.byModel);
    printModelRows('分模型统计 (今日累计)', snapshot.today.byModel);
  }
}
