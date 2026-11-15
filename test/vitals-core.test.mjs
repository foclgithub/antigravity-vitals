import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  AggregateScanner,
  VitalsTracker,
  analyzeConversation,
  decodeGenMetadataBlob,
  parseTranscriptLines,
} from '../sidecars/vitals/vitals-core.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

test('calculates exact tok/s when PLANNER_RESPONSE is followed by GENERIC tool step', () => {
  const lines = [
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-15T00:00:00Z',
      content: '<USER_REQUEST>\nHello\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:00:00Z',
      input_tokens: 1000,
      cache_read_tokens: 9000,
      output_tokens: 539,
      tool_calls: [{ name: 'run_command' }],
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-15T00:00:10Z',
      content: 'Created At: 2026-11-15T00:00:10Z\nCompleted At: 2026-11-15T00:00:12Z',
    }),
    JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:00:12Z',
      input_tokens: 1500,
      cache_read_tokens: 9500,
      output_tokens: 1007,
      tool_calls: [{ name: 'read_file' }],
    }),
    JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-15T00:00:29Z',
      content: 'Created At: 2026-11-15T00:00:29Z\nCompleted At: 2026-11-15T00:00:30Z',
    }),
  ].join('\n');

  const res = analyzeConversation(lines, {
    conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    nowMs: Date.parse('2026-11-15T00:10:00Z'),
  });

  assert.equal(res.titlePreview, 'Hello');
  assert.equal(res.recentPlannerSteps.length, 2);
  assert.equal(res.recentPlannerSteps[0].durationSec, 10);
  assert.equal(res.recentPlannerSteps[0].tokPerSec, 53.9);
  assert.equal(res.recentPlannerSteps[1].durationSec, 17);
  assert.equal(res.recentPlannerSteps[1].tokPerSec, 59.2);
  assert.equal(res.lastTokPerSec, 59.2);
  assert.equal(res.totals.avgTokPerSec, 57.3); // (539+1007)/27 = 57.259 -> 57.3
});

test('turn-ending PLANNER_RESPONSE uses stepFinishTimes/fileMtimeMs and never subtracts USER_INPUT idle time', () => {
  const lines = [
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:00:00Z',
      input_tokens: 500,
      cache_read_tokens: 4500,
      output_tokens: 400,
    }),
    // User replied 1 hour later
    JSON.stringify({
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-15T01:00:00Z',
      content: 'Next turn',
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T01:00:00Z',
      input_tokens: 600,
      cache_read_tokens: 5400,
      output_tokens: 500,
    }),
  ].join('\n');

  const finishMap = new Map();
  const tailMtime = Date.parse('2026-11-15T01:00:10Z');
  const res = analyzeConversation(lines, {
    fileMtimeMs: tailMtime,
    stepFinishTimes: finishMap,
    nowMs: Date.parse('2026-11-15T01:01:00Z'),
  });

  // Step 1 had no recorded finish time and was followed by USER_INPUT -> unknown duration
  assert.equal(res.recentPlannerSteps[0].durationKnown, false);
  assert.equal(res.recentPlannerSteps[0].tokPerSec, null);

  // Step 3 was the DONE tail -> used fileMtimeMs and persisted into finishMap
  assert.equal(res.recentPlannerSteps[1].durationKnown, true);
  assert.equal(res.recentPlannerSteps[1].durationSec, 10);
  assert.equal(res.recentPlannerSteps[1].tokPerSec, 50);
  assert.equal(finishMap.get(3), tailMtime);

  // When a new USER_INPUT arrives later, step 3 keeps its recorded finish time
  const linesAfterUser =
    lines +
    '\n' +
    JSON.stringify({
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-15T01:05:00Z',
      content: 'Another turn',
    });
  const res2 = analyzeConversation(linesAfterUser, {
    fileMtimeMs: Date.parse('2026-11-15T01:05:00Z'),
    stepFinishTimes: finishMap,
    nowMs: Date.parse('2026-11-15T01:05:02Z'),
  });
  assert.equal(res2.recentPlannerSteps[1].durationSec, 10);
  assert.equal(res2.recentPlannerSteps[1].tokPerSec, 50);
});

test('computes context %, nearCompaction, cacheHitRate, and auto-compaction drop', () => {
  const lines = [
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:00:00Z',
      input_tokens: 10000,
      cache_read_tokens: 210000,
      output_tokens: 2000,
    }),
    // Compaction drop > 5000, then fills up past 85%
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:01:00Z',
      input_tokens: 5000,
      cache_read_tokens: 75000,
      output_tokens: 1000,
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:02:00Z',
      input_tokens: 20000,
      cache_read_tokens: 200000,
      output_tokens: 1000,
    }),
  ].join('\n');

  const res = analyzeConversation(lines, { contextLimit: 256000 });
  assert.equal(res.compactions.length, 1);
  assert.equal(res.compactions[0].stepIndex, 2);
  assert.equal(res.compactions[0].beforeTokens, 220000);
  assert.equal(res.compactions[0].afterTokens, 80000);
  assert.equal(res.compactions[0].droppedTokens, 140000);

  // Latest context = 20000 + 200000 + 1000 = 221000 -> 86.3%
  assert.equal(res.contextUsed, 221000);
  assert.equal(res.usagePercent, 86.3);
  assert.equal(res.remainTokens, 35000);
  assert.equal(res.nearCompaction, true);
  // Cache hit rate = 200000 / 220000 = 90.9%
  assert.equal(res.cacheHitRate, 90.9);
});

test('detects live activity states: generating, tool_running, and idle', () => {
  const nowMs = Date.parse('2026-11-15T00:00:20Z');

  const afterUser = JSON.stringify({
    step_index: 1,
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-11-15T00:00:15Z',
    content: 'hi',
  });
  const s1 = analyzeConversation(afterUser, { nowMs });
  assert.equal(s1.activity.state, 'generating');
  assert.equal(s1.activity.elapsedSec, 5);

  const runningTool = JSON.stringify({
    step_index: 2,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-15T00:00:10Z',
    tool_calls: [{ name: 'run_command' }],
  });
  const s2 = analyzeConversation(runningTool, {
    fileMtimeMs: Date.parse('2026-11-15T00:00:12Z'),
    nowMs,
  });
  assert.equal(s2.activity.state, 'tool_running');
  assert.deepEqual(s2.activity.activeTools, ['run_command']);
  assert.equal(s2.activity.elapsedSec, 8);

  const afterGeneric = [
    runningTool,
    JSON.stringify({
      step_index: 3,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-15T00:00:13Z',
      content: 'Completed At: 2026-11-15T00:00:16Z',
    }),
  ].join('\n');
  const s3 = analyzeConversation(afterGeneric, { nowMs });
  assert.equal(s3.activity.state, 'generating');
  assert.equal(s3.activity.elapsedSec, 4);

  const finalDone = [
    afterGeneric,
    JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:00:18Z',
      output_tokens: 100,
    }),
  ].join('\n');
  const s4 = analyzeConversation(finalDone, {
    fileMtimeMs: Date.parse('2026-11-15T00:00:20Z'),
    nowMs,
  });
  assert.equal(s4.activity.state, 'idle');
});

test('tolerates corrupted or truncated trailing JSONL lines without throwing', () => {
  const raw = [
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-15T00:00:00Z',
      input_tokens: 100,
      cache_read_tokens: 900,
      output_tokens: 50,
    }),
    '{"step_index":2,"type":"PLANNER_RESPONSE","trun',
  ].join('\n');

  const parsed = parseTranscriptLines(raw);
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.skippedLines, 1);

  const res = analyzeConversation(raw);
  assert.equal(res.skippedLines, 1);
  assert.equal(res.contextUsed, 1050);
});

test('AggregateScanner computes 5h rolling window, today totals, and reuses mtime cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'vitals-test-'));
  try {
    const appData = join(root, 'antigravity');
    const c1 = '11111111-1111-1111-1111-111111111111';
    const c2 = '22222222-2222-2222-2222-222222222222';
    mkdirSync(join(appData, 'brain', c1, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(appData, 'brain', c2, '.system_generated', 'logs'), { recursive: true });

    const nowMs = new Date(2026, 10, 15, 10, 0, 0).getTime();
    const tWithin2h = new Date(nowMs - 2 * 3600 * 1000).toISOString();
    const tWithin4h = new Date(nowMs - 4 * 3600 * 1000).toISOString();
    const tToday7hAgo = new Date(nowMs - 7 * 3600 * 1000).toISOString(); // 03:00 local, today but >5h
    const tYesterday = new Date(nowMs - 24 * 3600 * 1000).toISOString();

    const p1 = join(appData, 'brain', c1, '.system_generated', 'logs', 'transcript.jsonl');
    writeFileSync(
      p1,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: tYesterday,
          input_tokens: 1000,
          cache_read_tokens: 0,
          output_tokens: 100,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: tToday7hAgo,
          input_tokens: 200,
          cache_read_tokens: 800,
          output_tokens: 100,
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: tWithin2h,
          input_tokens: 300,
          cache_read_tokens: 700,
          output_tokens: 50,
        }),
      ].join('\n'),
    );

    const p2 = join(appData, 'brain', c2, '.system_generated', 'logs', 'transcript.jsonl');
    writeFileSync(
      p2,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: tWithin4h,
        input_tokens: 400,
        cache_read_tokens: 1600,
        output_tokens: 200,
      }),
    );

    utimesSync(p1, new Date(nowMs - 1000), new Date(nowMs - 1000));
    utimesSync(p2, new Date(nowMs - 2000), new Date(nowMs - 2000));

    const scanner = new AggregateScanner({ appDataDirs: [appData], scanThrottleMs: 10000 });
    const agg1 = scanner.scan(nowMs);

    // 5h window: c1 step3 (1050) + c2 step1 (2200) = 3250
    assert.equal(agg1.rolling5h.conversations, 2);
    assert.equal(agg1.rolling5h.plannerSteps, 2);
    assert.equal(agg1.rolling5h.totalTokens, 3250);
    // Earliest in 5h is 4h ago -> resets in ~1h
    assert.equal(agg1.rolling5h.resetInMs, 1 * 3600 * 1000);

    // Today: c1 step2 (1100) + c1 step3 (1050) + c2 step1 (2200) = 4350
    assert.equal(agg1.today.conversations, 2);
    assert.equal(agg1.today.plannerSteps, 3);
    assert.equal(agg1.today.totalTokens, 4350);

    // Recent sorted newest mtime first -> c1 then c2
    assert.equal(agg1.recentConversations[0].conversationId, c1);
    assert.equal(agg1.recentConversations[1].conversationId, c2);

    // Cache entry exists and is reused when mtime/size unchanged
    const cachedRef = scanner.fileCache.get(p1);
    const agg2 = scanner.scan(nowMs + 500);
    assert.equal(scanner.fileCache.get(p1), cachedRef);
    assert.equal(agg2.rolling5h.totalTokens, 3250);

    // VitalsTracker also works end-to-end
    const tracker = new VitalsTracker({
      appDataDirs: [appData],
      timingsFilePath: join(root, 'timings.json'),
    });
    const snap = tracker.getSnapshot({ nowMs });
    assert.equal(snap.resolvedConversationId, c1);
    assert.equal(snap.resolvedMode, 'latest_active');
    assert.equal(snap.conversation.totals.plannerSteps, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function pbVarint(n) {
  const bytes = [];
  let v = Math.floor(n);
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

function pbFieldVarint(fieldNo, val) {
  return Buffer.concat([pbVarint(fieldNo * 8), pbVarint(val)]);
}

function pbFieldBytes(fieldNo, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([pbVarint(fieldNo * 8 + 2), pbVarint(buf.length), buf]);
}

function pbDuration(sec, nanos) {
  return Buffer.concat([pbFieldVarint(1, sec), pbFieldVarint(2, nanos)]);
}

function pbKv(key, val) {
  return Buffer.concat([pbFieldBytes(1, key), pbFieldBytes(2, val)]);
}

function makeGenMetadataBlob({
  lastStepIndex,
  modelCode,
  modelId,
  modelDisplayName,
  modelEnum,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  thinkingTokens,
  responseTokens,
  contextUsed,
  contextLimit,
  ttftSec,
  ttftNanos = 0,
  streamSec,
  streamNanos = 0,
}) {
  const usage = Buffer.concat([
    pbFieldVarint(1, modelCode),
    pbFieldVarint(2, inputTokens),
    pbFieldVarint(3, outputTokens),
    pbFieldVarint(5, cacheReadTokens),
    pbFieldVarint(9, thinkingTokens),
    pbFieldVarint(10, responseTokens),
  ]);
  const ctxInner = Buffer.concat([pbFieldVarint(1, contextUsed), pbFieldVarint(4, contextLimit)]);
  const ctxOuter = pbFieldBytes(10, ctxInner);
  const genMeta = Buffer.concat([
    pbFieldVarint(3, modelCode),
    pbFieldBytes(4, usage),
    pbFieldBytes(9, ctxOuter),
    pbFieldBytes(11, pbDuration(ttftSec, ttftNanos)),
    pbFieldBytes(12, pbDuration(streamSec, streamNanos)),
    pbFieldBytes(19, modelId),
    pbFieldBytes(20, pbKv('last_step_index', String(lastStepIndex))),
    pbFieldBytes(20, pbKv('model_enum', modelEnum)),
    pbFieldBytes(21, modelDisplayName),
  ]);
  return pbFieldBytes(1, genMeta);
}

test('decodes gen_metadata protobuf & attributes per-model speed, TTFT, thinking, and budget from SQLite', () => {
  const root = mkdtempSync(join(tmpdir(), 'vitals-sql-test-'));
  try {
    const appData = join(root, 'antigravity');
    const convId = '33333333-3333-3333-3333-333333333333';
    mkdirSync(join(appData, 'brain', convId, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(appData, 'conversations'), { recursive: true });

    const blobCarbon = makeGenMetadataBlob({
      lastStepIndex: 1, // maps to targetStepIndex = 2
      modelCode: 1667,
      modelId: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      modelEnum: 'MODEL_PLACEHOLDER_M667',
      inputTokens: 2000,
      outputTokens: 600,
      cacheReadTokens: 8000,
      thinkingTokens: 400,
      responseTokens: 200,
      contextUsed: 10600,
      contextLimit: 512000,
      ttftSec: 4,
      streamSec: 6,
    });

    const decoded = decodeGenMetadataBlob(blobCarbon);
    assert.equal(decoded.targetStepIndex, 2);
    assert.equal(decoded.modelId, 'gemini-pro-orchestrator');
    assert.equal(decoded.modelDisplayName, 'Orchestrator (Carbon)');
    assert.equal(decoded.modelFamily, 'carbon');
    assert.equal(decoded.ttftSec, 4);
    assert.equal(decoded.streamSec, 6);
    assert.equal(decoded.thinkingTokens, 400);
    assert.equal(decoded.responseTokens, 200);
    assert.equal(decoded.contextLimit, 512000);

    const blobHydrogen = makeGenMetadataBlob({
      lastStepIndex: 3, // maps to targetStepIndex = 4 (turn-ending step, NO stepFinishTimes!)
      modelCode: 1669,
      modelId: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      modelEnum: 'MODEL_PLACEHOLDER_M669',
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 9000,
      thinkingTokens: 300,
      responseTokens: 700,
      contextUsed: 11000,
      contextLimit: 512000,
      ttftSec: 1,
      streamSec: 4,
    });

    const dbPath = join(appData, 'conversations', `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0)');
    const stmt = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
    stmt.run(0, blobCarbon, blobCarbon.length);
    stmt.run(1, blobHydrogen, blobHydrogen.length);
    db.close();

    const nowMs = Date.now();
    const tStep2 = new Date(nowMs - 60_000).toISOString();
    const tStep4 = new Date(nowMs - 10_000).toISOString();

    const transcriptPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 1,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: tStep2,
          content: 'Model benchmark',
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: tStep2,
          input_tokens: 2000,
          cache_read_tokens: 8000,
          output_tokens: 600,
          tool_calls: [{ name: 'run_command' }],
        }),
        JSON.stringify({
          step_index: 4,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: tStep4,
          input_tokens: 1000,
          cache_read_tokens: 9000,
          output_tokens: 1000,
        }),
      ].join('\n'),
    );

    const tracker = new VitalsTracker({
      appDataDirs: [appData],
      timingsFilePath: join(root, 'timings.json'),
    });
    const snap = tracker.getSnapshot({ conversationId: convId, contextLimit: 'auto', nowMs });

    assert.equal(snap.contextLimitMode, 'auto');
    assert.equal(snap.detectedContextLimit, 512000);
    assert.equal(snap.contextLimit, 512000);

    const c = snap.conversation;
    assert.equal(c.activeModel.modelLabel, 'Gemini 4 Hydrogen (Orchestrator)');
    assert.equal(c.activeModel.modelFamily, 'hydrogen');
    assert.equal(c.totals.thinkingTokens, 700);
    // Turn-ending step 4 got duration 1 + 4 = 5s from gen_metadata without stepFinishTimes!
    assert.equal(c.lastTokPerSec, 200);
    assert.equal(c.lastStreamTokPerSec, 250);
    assert.equal(c.lastTtftSec, 1);

    assert.equal(c.byModel.length, 2);
    // Hydrogen total = 11000, Carbon total = 10600 -> sorted descending by totalTokens
    const mH = c.byModel[0];
    const mC = c.byModel[1];
    assert.equal(mH.modelLabel, 'Gemini 4 Hydrogen (Orchestrator)');
    assert.equal(mH.steps, 1);
    assert.equal(mH.avgTokPerSec, 200);
    assert.equal(mH.avgStreamTokPerSec, 250);
    assert.equal(mH.avgTtftSec, 1);
    assert.equal(mH.thinkingTokens, 300);

    assert.equal(mC.modelLabel, 'Orchestrator (Carbon)');
    assert.equal(mC.steps, 1);
    assert.equal(mC.avgTokPerSec, 60); // 600 / (4+6)
    assert.equal(mC.avgStreamTokPerSec, 100); // 600 / 6
    assert.equal(mC.avgTtftSec, 4);
    assert.equal(mC.thinkingTokens, 400);

    // Aggregate today & 5h window also expose byModel breakdown
    assert.equal(snap.rolling5h.byModel.length, 2);
    assert.equal(snap.today.byModel.length, 2);
    assert.equal(snap.today.thinkingTokens, 700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('falls back gracefully to Unknown model when conversation .db is missing', () => {
  const lines = JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-15T00:00:00Z',
    input_tokens: 100,
    cache_read_tokens: 900,
    output_tokens: 50,
  });

  const res = analyzeConversation(lines);
  assert.equal(res.byModel.length, 1);
  assert.equal(res.byModel[0].modelKey, 'Unknown');
  assert.equal(res.byModel[0].modelFamily, 'other');
  assert.equal(res.byModel[0].sharePercent, 100);
  assert.equal(res.activeModel, null);
});
