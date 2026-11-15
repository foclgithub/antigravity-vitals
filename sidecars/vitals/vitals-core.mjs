import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch {
  DatabaseSync = null;
}

export const ID_RE = /^[0-9a-f-]{8,}$/i;
export const DEFAULT_CONTEXT_LIMIT = 256000;
export const COMPACTION_DROP_THRESHOLD = 5000;

const FIVE_HOURS_MS = 5 * 3600 * 1000;
const GENERATING_TIMEOUT_MS = 180_000;
const TOOL_TIMEOUT_MS = 300_000;

/**
 * Parse JSONL lines from transcript.jsonl, ignoring blank or truncated trailing lines.
 */
export function parseTranscriptLines(rawText) {
  const steps = [];
  let skippedLines = 0;
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { steps, skippedLines };
  }
  const lines = rawText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        steps.push(parsed);
      } else {
        skippedLines += 1;
      }
    } catch {
      skippedLines += 1;
    }
  }
  return { steps, skippedLines };
}

/**
 * Extract "Completed At: <ISO>" timestamp from a GENERIC tool result step.
 */
export function extractToolCompletedMs(step) {
  if (!step || typeof step.content !== 'string') return 0;
  const match = step.content.match(/Completed At:\s*(\S+)/);
  if (!match) return 0;
  const ms = Date.parse(match[1]);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Extract "Created At: <ISO>" timestamp from a GENERIC tool result step, falling back to step.created_at.
 */
export function extractToolCreatedMs(step) {
  if (step && typeof step.content === 'string') {
    const match = step.content.match(/Created At:\s*(\S+)/);
    if (match) {
      const ms = Date.parse(match[1]);
      if (Number.isFinite(ms)) return ms;
    }
  }
  if (step && typeof step.created_at === 'string') {
    const ms = Date.parse(step.created_at);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function parseIsoMs(isoStr) {
  if (typeof isoStr !== 'string' || !isoStr) return 0;
  const ms = Date.parse(isoStr);
  return Number.isFinite(ms) ? ms : 0;
}

function roundOne(val) {
  return Math.round(val * 10) / 10;
}

function roundTwo(val) {
  return Math.round(val * 100) / 100;
}

function roundThree(val) {
  return Math.round(val * 1000) / 1000;
}

/**
 * Normalize raw model identifiers from gen_metadata into display label, compact badge, and family.
 */
export function classifyModel({ modelDisplayName = '', modelId = '', modelEnum = '' } = {}) {
  const display = String(modelDisplayName || '').trim();
  const id = String(modelId || '').trim();
  const enumName = String(modelEnum || '').trim();

  const label = display || id || enumName || 'Unknown';
  const modelKey = display || id || enumName || 'Unknown';
  const hay = `${display} ${id} ${enumName}`.toLowerCase();

  let family = 'other';
  if (hay.includes('carbon') || hay.includes('pro-orchestrator')) {
    family = 'carbon';
  } else if (hay.includes('hydrogen') || hay.includes('flash')) {
    family = 'hydrogen';
  } else if (hay.includes('argon') || hay.includes('claude') || hay.includes('opus') || hay.includes('sonnet')) {
    family = 'argon';
  }

  let shortLabel = label;
  const low = label.toLowerCase();
  if (low === 'orchestrator (carbon)') {
    shortLabel = 'Carbon · Orch';
  } else if (low === 'gemini 4 hydrogen (orchestrator)') {
    shortLabel = 'Hydrogen · Orch';
  } else if (low === 'orchestrator (argon)') {
    shortLabel = 'Argon · Orch';
  } else if (low.includes('carbon') && low.includes('high')) {
    shortLabel = 'Carbon High';
  } else if (low.includes('carbon') && low.includes('medium')) {
    shortLabel = 'Carbon Med';
  } else if (low.includes('carbon') && low.includes('low')) {
    shortLabel = 'Carbon Low';
  } else if (low.includes('hydrogen') && low.includes('high')) {
    shortLabel = 'Hydrogen High';
  } else if (low.includes('hydrogen') && low.includes('medium')) {
    shortLabel = 'Hydrogen Med';
  } else if (low.includes('argon') && low.includes('high')) {
    shortLabel = 'Argon High';
  } else if (low === 'gemini flash') {
    shortLabel = 'Gemini Flash';
  } else if (label.length > 16) {
    shortLabel = `${label.slice(0, 15)}…`;
  }

  return {
    modelKey,
    modelLabel: label,
    modelShort: shortLabel,
    modelFamily: family,
    modelId: id || enumName || '',
  };
}

function readVarint(buf, pos, end) {
  let val = 0;
  let factor = 1;
  let count = 0;
  while (pos < end && count < 10) {
    const b = buf[pos];
    pos += 1;
    count += 1;
    if (count <= 7) {
      val += (b & 0x7f) * factor;
      factor *= 128;
    }
    if ((b & 0x80) === 0) {
      return { value: val, pos, ok: true };
    }
  }
  return { value: 0, pos: end, ok: false };
}

function skipWireField(wireType, buf, pos, end) {
  if (wireType === 0) {
    return readVarint(buf, pos, end).pos;
  }
  if (wireType === 1) {
    return Math.min(end, pos + 8);
  }
  if (wireType === 5) {
    return Math.min(end, pos + 4);
  }
  if (wireType === 2) {
    const lenRes = readVarint(buf, pos, end);
    if (!lenRes.ok || lenRes.value < 0) return end;
    return Math.min(end, lenRes.pos + lenRes.value);
  }
  return end;
}

function decodeUtf8(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

function decodeDuration(buf, start, end) {
  let sec = 0;
  let nanos = 0;
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos, end);
    if (!tagRes.ok) break;
    pos = tagRes.pos;
    const fn = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x07;
    if (wire === 0) {
      const valRes = readVarint(buf, pos, end);
      if (!valRes.ok) break;
      pos = valRes.pos;
      if (fn === 1) sec = valRes.value;
      else if (fn === 2) nanos = valRes.value;
    } else {
      pos = skipWireField(wire, buf, pos, end);
    }
  }
  return roundThree(sec + nanos / 1e9);
}

function decodeUsageMessage(buf, start, end) {
  const usage = {
    modelCode: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
  };
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos, end);
    if (!tagRes.ok) break;
    pos = tagRes.pos;
    const fn = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x07;
    if (wire === 0) {
      const valRes = readVarint(buf, pos, end);
      if (!valRes.ok) break;
      pos = valRes.pos;
      if (fn === 1) usage.modelCode = valRes.value;
      else if (fn === 2) usage.inputTokens = valRes.value;
      else if (fn === 3) usage.outputTokens = valRes.value;
      else if (fn === 5) usage.cacheReadTokens = valRes.value;
      else if (fn === 9) usage.thinkingTokens = valRes.value;
      else if (fn === 10) usage.responseTokens = valRes.value;
    } else {
      pos = skipWireField(wire, buf, pos, end);
    }
  }
  return usage;
}

function decodeContextInfo(buf, start, end) {
  let contextUsed = 0;
  let contextLimit = 0;
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos, end);
    if (!tagRes.ok) break;
    pos = tagRes.pos;
    const fn = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x07;
    if (wire === 2) {
      const lenRes = readVarint(buf, pos, end);
      if (!lenRes.ok || lenRes.value < 0) break;
      const subStart = lenRes.pos;
      const subEnd = Math.min(end, subStart + lenRes.value);
      pos = subEnd;
      if (fn === 10) {
        let sp = subStart;
        while (sp < subEnd) {
          const st = readVarint(buf, sp, subEnd);
          if (!st.ok) break;
          sp = st.pos;
          const sfn = Math.floor(st.value / 8);
          const swire = st.value & 0x07;
          if (swire === 0) {
            const sv = readVarint(buf, sp, subEnd);
            if (!sv.ok) break;
            sp = sv.pos;
            if (sfn === 1) contextUsed = sv.value;
            else if (sfn === 4) contextLimit = sv.value;
          } else {
            sp = skipWireField(swire, buf, sp, subEnd);
          }
        }
      }
    } else {
      pos = skipWireField(wire, buf, pos, end);
    }
  }
  return { contextUsed, contextLimit };
}

function decodeKvPair(buf, start, end) {
  let key = '';
  let val = '';
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos, end);
    if (!tagRes.ok) break;
    pos = tagRes.pos;
    const fn = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x07;
    if (wire === 2) {
      const lenRes = readVarint(buf, pos, end);
      if (!lenRes.ok || lenRes.value < 0) break;
      const subStart = lenRes.pos;
      const subEnd = Math.min(end, subStart + lenRes.value);
      pos = subEnd;
      const text = decodeUtf8(buf.subarray(subStart, subEnd));
      if (fn === 1) key = text;
      else if (fn === 2) val = text;
    } else {
      pos = skipWireField(wire, buf, pos, end);
    }
  }
  return { key, val };
}

/**
 * Pure-JS Protobuf wire decoder for Antigravity SQLite `gen_metadata.data` blobs.
 */
export function decodeGenMetadataBlob(rawBuf) {
  if (!rawBuf || typeof rawBuf.length !== 'number' || rawBuf.length === 0) {
    return null;
  }
  const buf = rawBuf instanceof Uint8Array ? rawBuf : Uint8Array.from(rawBuf);
  const end = buf.length;

  let genStart = -1;
  let genEnd = -1;
  let pos = 0;

  while (pos < end) {
    const tagRes = readVarint(buf, pos, end);
    if (!tagRes.ok) break;
    pos = tagRes.pos;
    const fn = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x07;
    if (wire === 2) {
      const lenRes = readVarint(buf, pos, end);
      if (!lenRes.ok || lenRes.value < 0) break;
      const subStart = lenRes.pos;
      const subEnd = Math.min(end, subStart + lenRes.value);
      pos = subEnd;
      if (fn === 1) {
        genStart = subStart;
        genEnd = subEnd;
        break;
      }
    } else {
      pos = skipWireField(wire, buf, pos, end);
    }
  }

  if (genStart < 0 || genEnd <= genStart) {
    return null;
  }

  let modelCode = 0;
  let modelId = '';
  let modelDisplayName = '';
  let ttftSec = 0;
  let streamSec = 0;
  let hasDuration11 = false;
  let hasDuration12 = false;
  let usage = {
    modelCode: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
  };
  let contextUsed = 0;
  let contextLimit = 0;
  const kv = {};

  let gp = genStart;
  while (gp < genEnd) {
    const tagRes = readVarint(buf, gp, genEnd);
    if (!tagRes.ok) break;
    gp = tagRes.pos;
    const fn = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x07;
    if (wire === 0) {
      const valRes = readVarint(buf, gp, genEnd);
      if (!valRes.ok) break;
      gp = valRes.pos;
      if (fn === 3) modelCode = valRes.value;
    } else if (wire === 2) {
      const lenRes = readVarint(buf, gp, genEnd);
      if (!lenRes.ok || lenRes.value < 0) break;
      const subStart = lenRes.pos;
      const subEnd = Math.min(genEnd, subStart + lenRes.value);
      gp = subEnd;
      if (fn === 4) {
        usage = decodeUsageMessage(buf, subStart, subEnd);
      } else if (fn === 9) {
        const ctx = decodeContextInfo(buf, subStart, subEnd);
        contextUsed = ctx.contextUsed;
        contextLimit = ctx.contextLimit;
      } else if (fn === 11) {
        ttftSec = decodeDuration(buf, subStart, subEnd);
        hasDuration11 = true;
      } else if (fn === 12) {
        streamSec = decodeDuration(buf, subStart, subEnd);
        hasDuration12 = true;
      } else if (fn === 19) {
        modelId = decodeUtf8(buf.subarray(subStart, subEnd));
      } else if (fn === 20) {
        const { key, val } = decodeKvPair(buf, subStart, subEnd);
        if (key) kv[key] = val;
      } else if (fn === 21) {
        modelDisplayName = decodeUtf8(buf.subarray(subStart, subEnd));
      }
    } else {
      gp = skipWireField(wire, buf, gp, genEnd);
    }
  }

  const rawLastStep = kv.last_step_index;
  const parsedLastStep = rawLastStep !== undefined && rawLastStep !== '' ? Number(rawLastStep) : NaN;
  const targetStepIndex = Number.isFinite(parsedLastStep) ? parsedLastStep + 1 : null;

  const modelEnum = kv.model_enum || '';
  const classified = classifyModel({ modelDisplayName, modelId, modelEnum });

  return {
    targetStepIndex,
    lastStepIndex: Number.isFinite(parsedLastStep) ? parsedLastStep : null,
    modelCode: modelCode || usage.modelCode || 0,
    modelEnum,
    modelId: classified.modelId,
    modelDisplayName: modelDisplayName || classified.modelLabel,
    modelKey: classified.modelKey,
    modelLabel: classified.modelLabel,
    modelShort: classified.modelShort,
    modelFamily: classified.modelFamily,
    ttftSec: hasDuration11 ? ttftSec : 0,
    streamSec: hasDuration12 ? streamSec : 0,
    hasHostTiming: hasDuration11 || hasDuration12,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    thinkingTokens: usage.thinkingTokens,
    responseTokens: usage.responseTokens,
    contextUsed,
    contextLimit,
    usedClaude: kv.used_claude === 'true',
  };
}

/**
 * Resolve <appData>/conversations/<conversationId>.db if present.
 */
export function findConversationDbPath(conversationId, appDataDirs) {
  if (!conversationId || !ID_RE.test(conversationId) || !Array.isArray(appDataDirs)) return '';
  for (const appData of appDataDirs) {
    const p = join(appData, 'conversations', `${conversationId}.db`);
    if (existsSync(p)) return p;
  }
  return '';
}

function statSignature(filePath) {
  try {
    const st = statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/**
 * Read-only incremental cache over Antigravity per-conversation SQLite `gen_metadata` table.
 */
export class GenMetadataCache {
  constructor() {
    this.cache = new Map(); // dbPath -> { dbSig, walSig, maxIdx, byStep, latestModel, detectedContextLimit }
  }

  getDbSignature(dbPath) {
    if (!dbPath) return '';
    const dbSig = statSignature(dbPath);
    if (!dbSig) return '';
    const walSig = statSignature(`${dbPath}-wal`);
    return `${dbSig}|${walSig}`;
  }

  readConversation(dbPath) {
    const empty = {
      signature: '',
      byStep: new Map(),
      latestModel: null,
      detectedContextLimit: 0,
    };
    if (!dbPath || !DatabaseSync) return empty;

    const sig = this.getDbSignature(dbPath);
    if (!sig) return empty;

    const cached = this.cache.get(dbPath);
    if (cached && cached.signature === sig) {
      return cached;
    }

    const byStep = cached ? cached.byStep : new Map();
    let maxIdx = cached ? cached.maxIdx : -1;
    let latestModel = cached ? cached.latestModel : null;
    let detectedContextLimit = cached ? cached.detectedContextLimit : 0;

    // Re-read from previous maxIdx (inclusive) because active tail row changes as generation settles.
    const startIdx = maxIdx >= 0 ? maxIdx : 0;

    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC').all(startIdx);
      for (const row of rows) {
        if (Number.isFinite(row?.idx) && row.idx > maxIdx) {
          maxIdx = row.idx;
        }
        const meta = decodeGenMetadataBlob(row?.data);
        if (!meta) continue;
        if (meta.targetStepIndex !== null) {
          byStep.set(meta.targetStepIndex, meta);
        }
        if (meta.modelKey && meta.modelKey !== 'Unknown') {
          latestModel = {
            modelKey: meta.modelKey,
            modelLabel: meta.modelLabel,
            modelShort: meta.modelShort,
            modelFamily: meta.modelFamily,
            modelId: meta.modelId,
          };
        }
        if (meta.contextLimit > 0) {
          detectedContextLimit = meta.contextLimit;
        }
      }
      const nextEntry = {
        signature: sig,
        maxIdx,
        byStep,
        latestModel,
        detectedContextLimit,
      };
      this.cache.set(dbPath, nextEntry);
      return nextEntry;
    } catch {
      return cached || empty;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors on read-only handle
        }
      }
    }
  }

  pruneExcept(activeDbPaths) {
    for (const key of this.cache.keys()) {
      if (!activeDbPaths.has(key)) {
        this.cache.delete(key);
      }
    }
  }
}

function createModelEntry(rec) {
  return {
    modelKey: rec.modelKey || 'Unknown',
    modelLabel: rec.modelLabel || 'Unknown',
    modelShort: rec.modelShort || 'Unknown',
    modelFamily: rec.modelFamily || 'other',
    modelId: rec.modelId || '',
    steps: 0,
    timedSteps: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    _sumTimedOut: 0,
    _sumTimedDur: 0,
    _sumStreamOut: 0,
    _sumStreamDur: 0,
    _sumTtft: 0,
    _ttftCount: 0,
  };
}

function addRecordToModelMap(map, rec) {
  const key = rec.modelKey || 'Unknown';
  let entry = map.get(key);
  if (!entry) {
    entry = createModelEntry(rec);
    map.set(key, entry);
  }
  entry.steps += 1;
  entry.inputTokens += rec.inputTokens;
  entry.cacheReadTokens += rec.cacheReadTokens;
  entry.cacheCreationTokens += rec.cacheCreationTokens;
  entry.outputTokens += rec.outputTokens;
  entry.thinkingTokens += rec.thinkingTokens;
  entry.responseTokens += rec.responseTokens;
  entry.totalTokens +=
    rec.inputTokens + rec.cacheReadTokens + rec.cacheCreationTokens + rec.outputTokens;

  if (rec.durationKnown && rec.durationSec > 0 && rec.outputTokens > 0) {
    entry.timedSteps += 1;
    entry._sumTimedOut += rec.outputTokens;
    entry._sumTimedDur += rec.durationSec;
  }
  if (rec.streamSec !== null && rec.streamSec > 0 && rec.outputTokens > 0) {
    entry._sumStreamOut += rec.outputTokens;
    entry._sumStreamDur += rec.streamSec;
  }
  if (rec.ttftSec !== null && rec.ttftSec >= 0) {
    entry._sumTtft += rec.ttftSec;
    entry._ttftCount += 1;
  }
}

function finalizeModelBreakdown(map, grandTotalTokens, grandSteps) {
  const list = [];
  for (const entry of map.values()) {
    const sharePercent =
      grandTotalTokens > 0
        ? roundOne((entry.totalTokens / grandTotalTokens) * 100)
        : grandSteps > 0
          ? roundOne((entry.steps / grandSteps) * 100)
          : 0;
    list.push({
      modelKey: entry.modelKey,
      modelLabel: entry.modelLabel,
      modelShort: entry.modelShort,
      modelFamily: entry.modelFamily,
      modelId: entry.modelId,
      steps: entry.steps,
      timedSteps: entry.timedSteps,
      inputTokens: entry.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      responseTokens: entry.responseTokens,
      totalTokens: entry.totalTokens,
      sharePercent,
      avgTokPerSec: entry._sumTimedDur > 0 ? roundOne(entry._sumTimedOut / entry._sumTimedDur) : null,
      avgStreamTokPerSec:
        entry._sumStreamDur > 0 ? roundOne(entry._sumStreamOut / entry._sumStreamDur) : null,
      avgTtftSec: entry._ttftCount > 0 ? roundTwo(entry._sumTtft / entry._ttftCount) : null,
    });
  }
  list.sort(
    (a, b) =>
      b.totalTokens - a.totalTokens ||
      b.steps - a.steps ||
      a.modelLabel.localeCompare(b.modelLabel),
  );
  return list;
}

function extractTitlePreview(steps) {
  for (const step of steps) {
    if (step?.type === 'USER_INPUT' && typeof step.content === 'string') {
      const cleaned = step.content
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
        .replace(/<\/?USER_REQUEST>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
      }
    }
  }
  return '';
}

function detectActivityState(steps, fileMtimeMs, nowMs) {
  if (!steps.length) {
    return { state: 'idle', label: '空闲', activeSinceMs: 0, elapsedSec: 0, activeTools: [] };
  }

  const lastStep = steps[steps.length - 1];
  const lastCreatedMs = parseIsoMs(lastStep?.created_at);
  const lastType = String(lastStep?.type || '');
  const lastStatus = String(lastStep?.status || '');

  if (lastType === 'ERROR_MESSAGE' || lastStatus === 'ERROR') {
    return {
      state: 'error',
      label: '异常',
      activeSinceMs: lastCreatedMs || fileMtimeMs || 0,
      elapsedSec: 0,
      activeTools: [],
    };
  }

  if (lastType === 'USER_INPUT') {
    if (lastCreatedMs > 0 && nowMs - lastCreatedMs < GENERATING_TIMEOUT_MS) {
      return {
        state: 'generating',
        label: '生成中',
        activeSinceMs: lastCreatedMs,
        elapsedSec: Math.max(0, roundOne((nowMs - lastCreatedMs) / 1000)),
        activeTools: [],
      };
    }
    return { state: 'idle', label: '空闲', activeSinceMs: 0, elapsedSec: 0, activeTools: [] };
  }

  if (lastType === 'PLANNER_RESPONSE') {
    if (lastStatus && lastStatus !== 'DONE') {
      const since = lastCreatedMs || fileMtimeMs || nowMs;
      return {
        state: 'generating',
        label: '生成中',
        activeSinceMs: since,
        elapsedSec: Math.max(0, roundOne((nowMs - since) / 1000)),
        activeTools: [],
      };
    }
    const toolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];
    const refMs = fileMtimeMs || lastCreatedMs;
    if (toolCalls.length > 0 && refMs > 0 && nowMs - refMs < TOOL_TIMEOUT_MS) {
      const activeTools = toolCalls
        .map((tc) => tc?.name || tc?.function?.name || 'tool')
        .filter(Boolean);
      return {
        state: 'tool_running',
        label: '工具运行中',
        activeSinceMs: refMs,
        elapsedSec: Math.max(0, roundOne((nowMs - refMs) / 1000)),
        activeTools,
      };
    }
    return { state: 'idle', label: '空闲', activeSinceMs: 0, elapsedSec: 0, activeTools: [] };
  }

  if (lastType === 'GENERIC') {
    let runningSince = 0;
    let batchEndMs = 0;
    let hasRunning = false;

    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const s = steps[i];
      if (s?.type !== 'GENERIC') break;
      if (s.status && s.status !== 'DONE') {
        hasRunning = true;
        const t = extractToolCreatedMs(s);
        if (t > 0 && (runningSince === 0 || t < runningSince)) {
          runningSince = t;
        }
      }
      const completed = extractToolCompletedMs(s) || parseIsoMs(s.created_at);
      if (completed > batchEndMs) {
        batchEndMs = completed;
      }
    }

    if (hasRunning) {
      const since = runningSince || fileMtimeMs || lastCreatedMs || nowMs;
      if (nowMs - since < TOOL_TIMEOUT_MS) {
        return {
          state: 'tool_running',
          label: '工具运行中',
          activeSinceMs: since,
          elapsedSec: Math.max(0, roundOne((nowMs - since) / 1000)),
          activeTools: [],
        };
      }
      return { state: 'idle', label: '空闲', activeSinceMs: 0, elapsedSec: 0, activeTools: [] };
    }

    const effectiveEnd = batchEndMs || fileMtimeMs;
    if (effectiveEnd > 0 && nowMs - effectiveEnd < GENERATING_TIMEOUT_MS) {
      return {
        state: 'generating',
        label: '生成中',
        activeSinceMs: effectiveEnd,
        elapsedSec: Math.max(0, roundOne((nowMs - effectiveEnd) / 1000)),
        activeTools: [],
      };
    }
  }

  return { state: 'idle', label: '空闲', activeSinceMs: 0, elapsedSec: 0, activeTools: [] };
}

/**
 * Analyze a single conversation's transcript.jsonl content, optionally enriched with gen_metadata.
 */
export function analyzeConversation(rawText, options = {}) {
  const {
    conversationId = '',
    contextLimit,
    detectedContextLimit = 0,
    fileMtimeMs = 0,
    stepFinishTimes = null,
    genMetaByStep = null,
    latestGenModel = null,
    nowMs = Date.now(),
  } = options;

  const explicitLimit =
    contextLimit !== undefined && contextLimit !== null && contextLimit !== 'auto' && Number(contextLimit) > 0
      ? Number(contextLimit)
      : 0;
  const safeLimit = explicitLimit || (detectedContextLimit > 0 ? detectedContextLimit : DEFAULT_CONTEXT_LIMIT);

  const { steps, skippedLines } = parseTranscriptLines(rawText);
  const titlePreview = extractTitlePreview(steps);
  const compactions = [];
  const plannerRecords = [];
  const modelMap = new Map();

  let prevPromptTotal = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let totalToolCalls = 0;
  let sumTimedOutputTokens = 0;
  let sumTimedDurationSec = 0;
  let sumStreamOutputTokens = 0;
  let sumStreamDurationSec = 0;
  let sumTtftSec = 0;
  let ttftCount = 0;
  let timedStepsCount = 0;
  let latestSnapshot = null;
  let lastMeasuredSpeed = null;
  let lastKnownModel = null;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step?.type !== 'PLANNER_RESPONSE') continue;

    const stepIndex = Number.isFinite(step.step_index) ? step.step_index : i;
    const gm = genMetaByStep instanceof Map ? genMetaByStep.get(stepIndex) || null : null;
    const modelInfo = gm
      ? {
          modelKey: gm.modelKey,
          modelLabel: gm.modelLabel,
          modelShort: gm.modelShort,
          modelFamily: gm.modelFamily,
          modelId: gm.modelId,
        }
      : {
          modelKey: 'Unknown',
          modelLabel: 'Unknown',
          modelShort: 'Unknown',
          modelFamily: 'other',
          modelId: '',
        };

    if (modelInfo.modelKey !== 'Unknown') {
      lastKnownModel = modelInfo;
    }

    const startMs = parseIsoMs(step.created_at);
    const nextStep = i + 1 < steps.length ? steps[i + 1] : null;

    let durationSec = null;
    let durationKnown = false;
    let durationSource = 'none';
    let ttftSec = null;
    let streamSec = null;

    const hostSum = gm && gm.hasHostTiming ? (gm.ttftSec || 0) + (gm.streamSec || 0) : 0;
    if (gm && hostSum >= 0.15 && hostSum < 900) {
      ttftSec = roundTwo(gm.ttftSec || 0);
      streamSec = roundTwo(gm.streamSec || 0);
      durationSec = roundTwo(ttftSec + streamSec);
      durationKnown = true;
      durationSource = 'gen_metadata';
    } else {
      let endMs = 0;
      if (nextStep && nextStep.source !== 'USER_EXPLICIT' && nextStep.type !== 'USER_INPUT') {
        endMs = extractToolCreatedMs(nextStep) || parseIsoMs(nextStep.created_at) || 0;
      } else if (stepFinishTimes && stepFinishTimes.has(stepIndex)) {
        endMs = stepFinishTimes.get(stepIndex) || 0;
      } else if (i === steps.length - 1 && step.status === 'DONE' && fileMtimeMs > 0) {
        endMs = fileMtimeMs;
        if (stepFinishTimes && startMs > 0 && endMs >= startMs) {
          stepFinishTimes.set(stepIndex, endMs);
        }
      }
      const rawDurationSec = startMs > 0 && endMs > startMs ? (endMs - startMs) / 1000 : null;
      if (rawDurationSec !== null && rawDurationSec >= 0.2 && rawDurationSec < 900) {
        durationSec = roundTwo(rawDurationSec);
        durationKnown = true;
        durationSource = 'transcript';
      }
    }

    const hasTokens =
      step.input_tokens != null ||
      step.cache_read_tokens != null ||
      step.cache_creation_tokens != null ||
      step.output_tokens != null;

    const inTok = hasTokens ? Math.max(0, Number(step.input_tokens || 0) || 0) : 0;
    const cacheRead = hasTokens ? Math.max(0, Number(step.cache_read_tokens || 0) || 0) : 0;
    const cacheCreate = hasTokens ? Math.max(0, Number(step.cache_creation_tokens || 0) || 0) : 0;
    const outTok = hasTokens ? Math.max(0, Number(step.output_tokens || 0) || 0) : 0;
    const promptTotal = inTok + cacheRead + cacheCreate;
    const snapshotTotal = promptTotal + outTok;

    const thinkingTokens = gm ? Math.max(0, Number(gm.thinkingTokens || 0) || 0) : 0;
    const responseTokens = gm && gm.responseTokens > 0
      ? gm.responseTokens
      : Math.max(0, outTok - thinkingTokens);

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const toolNames = toolCalls.map((tc) => tc?.name || tc?.function?.name || 'tool').filter(Boolean);
    totalToolCalls += toolCalls.length;

    const tokPerSec = durationKnown && durationSec > 0 && outTok > 0 ? roundOne(outTok / durationSec) : null;
    const streamTokPerSec =
      gm && gm.streamSec >= 0.08 && outTok > 0 ? roundOne(outTok / gm.streamSec) : null;

    if (tokPerSec !== null) {
      sumTimedOutputTokens += outTok;
      sumTimedDurationSec += durationSec;
      timedStepsCount += 1;
      lastMeasuredSpeed = {
        tokPerSec,
        durationSec,
        ttftSec,
        streamSec,
        streamTokPerSec,
        outputTokens: outTok,
        thinkingTokens,
        responseTokens,
        stepIndex,
        modelShort: modelInfo.modelShort,
        modelLabel: modelInfo.modelLabel,
        modelFamily: modelInfo.modelFamily,
      };
    }

    if (gm && gm.streamSec >= 0.08 && outTok > 0) {
      sumStreamOutputTokens += outTok;
      sumStreamDurationSec += gm.streamSec;
    }
    if (ttftSec !== null && ttftSec >= 0) {
      sumTtftSec += ttftSec;
      ttftCount += 1;
    }

    if (hasTokens) {
      totalInputTokens += inTok;
      totalCacheReadTokens += cacheRead;
      totalCacheCreationTokens += cacheCreate;
      totalOutputTokens += outTok;
      totalThinkingTokens += thinkingTokens;
      totalResponseTokens += responseTokens;

      if (prevPromptTotal > 0 && prevPromptTotal - promptTotal > COMPACTION_DROP_THRESHOLD) {
        compactions.push({
          stepIndex,
          beforeTokens: prevPromptTotal,
          afterTokens: promptTotal,
          droppedTokens: prevPromptTotal - promptTotal,
          createdAt: step.created_at || '',
        });
      }
      if (promptTotal > 0) {
        prevPromptTotal = promptTotal;
      }
      latestSnapshot = {
        stepIndex,
        inTok,
        cacheRead,
        cacheCreate,
        outTok,
        thinkingTokens,
        responseTokens,
        promptTotal,
        snapshotTotal,
      };
    }

    const record = {
      stepIndex,
      createdAt: step.created_at || '',
      createdMs: startMs,
      inputTokens: inTok,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
      outputTokens: outTok,
      thinkingTokens,
      responseTokens,
      contextTotal: snapshotTotal,
      durationSec,
      durationKnown,
      durationSource,
      ttftSec,
      streamSec,
      tokPerSec,
      streamTokPerSec,
      toolNames,
      ...modelInfo,
    };

    plannerRecords.push(record);
    addRecordToModelMap(modelMap, record);
  }

  const contextUsed = latestSnapshot ? latestSnapshot.snapshotTotal : 0;
  const usagePercent = safeLimit > 0 ? roundOne((contextUsed / safeLimit) * 100) : 0;
  const remainTokens = Math.max(0, safeLimit - contextUsed);
  const nearCompaction = usagePercent >= 85;
  const cacheHitRate =
    latestSnapshot && latestSnapshot.promptTotal > 0
      ? roundOne((latestSnapshot.cacheRead / latestSnapshot.promptTotal) * 100)
      : 0;

  const sessionPromptTokens = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens;
  const sessionTotalTokens = sessionPromptTokens + totalOutputTokens;
  const sessionCacheHitRate =
    sessionPromptTokens > 0 ? roundOne((totalCacheReadTokens / sessionPromptTokens) * 100) : 0;
  const avgTokPerSec =
    sumTimedDurationSec > 0 ? roundOne(sumTimedOutputTokens / sumTimedDurationSec) : null;
  const avgStreamTokPerSec =
    sumStreamDurationSec > 0 ? roundOne(sumStreamOutputTokens / sumStreamDurationSec) : null;
  const avgTtftSec = ttftCount > 0 ? roundTwo(sumTtftSec / ttftCount) : null;

  const activity = detectActivityState(steps, fileMtimeMs, nowMs);
  const latestPlanner = plannerRecords.length ? plannerRecords[plannerRecords.length - 1] : null;
  const activeModel =
    latestPlanner && latestPlanner.modelKey !== 'Unknown'
      ? {
          modelKey: latestPlanner.modelKey,
          modelLabel: latestPlanner.modelLabel,
          modelShort: latestPlanner.modelShort,
          modelFamily: latestPlanner.modelFamily,
          modelId: latestPlanner.modelId,
        }
      : lastKnownModel || latestGenModel || null;

  const byModel = finalizeModelBreakdown(modelMap, sessionTotalTokens, plannerRecords.length);

  return {
    conversationId,
    titlePreview,
    fileMtimeMs,
    skippedLines,
    contextLimit: safeLimit,
    detectedContextLimit: detectedContextLimit > 0 ? detectedContextLimit : null,
    contextUsed,
    usagePercent,
    remainTokens,
    nearCompaction,
    cacheHitRate,
    latestInputTokens: latestSnapshot ? latestSnapshot.inTok : 0,
    latestCacheReadTokens: latestSnapshot ? latestSnapshot.cacheRead : 0,
    latestCacheCreationTokens: latestSnapshot ? latestSnapshot.cacheCreate : 0,
    latestOutputTokens: latestSnapshot ? latestSnapshot.outTok : 0,
    latestThinkingTokens: latestSnapshot ? latestSnapshot.thinkingTokens : 0,
    latestResponseTokens: latestSnapshot ? latestSnapshot.responseTokens : 0,
    lastTokPerSec: lastMeasuredSpeed ? lastMeasuredSpeed.tokPerSec : null,
    lastDurationSec: lastMeasuredSpeed ? lastMeasuredSpeed.durationSec : null,
    lastTtftSec: lastMeasuredSpeed ? lastMeasuredSpeed.ttftSec : null,
    lastStreamSec: lastMeasuredSpeed ? lastMeasuredSpeed.streamSec : null,
    lastStreamTokPerSec: lastMeasuredSpeed ? lastMeasuredSpeed.streamTokPerSec : null,
    lastSpeedStepIndex: lastMeasuredSpeed ? lastMeasuredSpeed.stepIndex : null,
    lastSpeedOutputTokens: lastMeasuredSpeed ? lastMeasuredSpeed.outputTokens : 0,
    lastSpeedThinkingTokens: lastMeasuredSpeed ? lastMeasuredSpeed.thinkingTokens : 0,
    lastSpeedModelShort: lastMeasuredSpeed ? lastMeasuredSpeed.modelShort : '',
    lastSpeedModelFamily: lastMeasuredSpeed ? lastMeasuredSpeed.modelFamily : 'other',
    latestPlannerHasSpeed: Boolean(latestPlanner && latestPlanner.tokPerSec !== null),
    activeModel,
    byModel,
    compactions,
    activity,
    totals: {
      plannerSteps: plannerRecords.length,
      totalSteps: steps.length,
      toolCallCount: totalToolCalls,
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      outputTokens: totalOutputTokens,
      thinkingTokens: totalThinkingTokens,
      responseTokens: totalResponseTokens,
      totalTokens: sessionTotalTokens,
      sessionCacheHitRate,
      avgTokPerSec,
      avgStreamTokPerSec,
      avgTtftSec,
      timedStepsCount,
    },
    recentPlannerSteps: plannerRecords.slice(-24),
    plannerRecords,
    tailSteps: steps.slice(-12),
  };
}

/**
 * Locate Antigravity app data directories containing brain/.
 */
export function findAppDataDirs(env = process.env, home = homedir()) {
  const execDataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }

  if (env.ANTIGRAVITY_APP_DATA_DIR) {
    return existsSync(join(env.ANTIGRAVITY_APP_DATA_DIR, 'brain'))
      ? [env.ANTIGRAVITY_APP_DATA_DIR]
      : [];
  }

  const root = join(home, '.gemini');
  let entries = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }

  const dirs = [];
  for (const name of entries) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'brain'))) {
      dirs.push(candidate);
    }
  }
  dirs.sort((a, b) => {
    const aMain = basename(a) === 'antigravity' ? 0 : 1;
    const bMain = basename(b) === 'antigravity' ? 0 : 1;
    return aMain - bMain || a.localeCompare(b);
  });
  return dirs;
}

/**
 * Resolve transcript.jsonl path for a specific conversation ID.
 */
export function findTranscriptPath(conversationId, appDataDirs) {
  if (!conversationId || !ID_RE.test(conversationId)) return '';
  for (const appData of appDataDirs) {
    const p = join(appData, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return '';
}

function getLocalMidnightMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Cached scanner across all local conversations for rolling 5h, today totals, per-model stats, and recent sessions.
 */
export class AggregateScanner {
  constructor(options = {}) {
    this.fixedAppDataDirs = Array.isArray(options.appDataDirs) ? options.appDataDirs : null;
    this.scanThrottleMs = Number.isFinite(options.scanThrottleMs) ? options.scanThrottleMs : 3000;
    this.getStepFinishTimes = typeof options.getStepFinishTimes === 'function' ? options.getStepFinishTimes : null;
    this.genCache = options.genCache instanceof GenMetadataCache ? options.genCache : new GenMetadataCache();
    this.fileCache = new Map(); // transcriptPath -> { conversationId, mtimeMs, size, dbSig, analysis }
    this.lastDirScanMs = 0;
    this.discoveredEntries = []; // [{ conversationId, transcriptPath, dbPath }]
  }

  #getAppDataDirs() {
    return this.fixedAppDataDirs || findAppDataDirs();
  }

  #discoverConversations(nowMs) {
    if (this.discoveredEntries.length > 0 && nowMs - this.lastDirScanMs < this.scanThrottleMs) {
      return this.discoveredEntries;
    }
    this.lastDirScanMs = nowMs;
    const seen = new Set();
    const entries = [];
    for (const appData of this.#getAppDataDirs()) {
      const brainDir = join(appData, 'brain');
      let convDirs = [];
      try {
        convDirs = readdirSync(brainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of convDirs) {
        if (!dirent.isDirectory()) continue;
        const convId = dirent.name;
        if (!ID_RE.test(convId) || seen.has(convId)) continue;
        const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(transcriptPath)) {
          seen.add(convId);
          const dbCandidate = join(appData, 'conversations', `${convId}.db`);
          entries.push({
            conversationId: convId,
            transcriptPath,
            dbPath: existsSync(dbCandidate) ? dbCandidate : '',
          });
        }
      }
    }
    this.discoveredEntries = entries;
    return entries;
  }

  scan(nowMs = Date.now(), forceDirScan = false) {
    if (forceDirScan) {
      this.lastDirScanMs = 0;
    }
    const entries = this.#discoverConversations(nowMs);
    const activePaths = new Set();
    const activeDbPaths = new Set();

    const fiveHourStart = nowMs - FIVE_HOURS_MS;
    const todayStart = getLocalMidnightMs(nowMs);

    const rolling5h = {
      conversations: 0,
      plannerSteps: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      oldestStepMs: 0,
      resetInMs: 0,
      byModel: [],
    };
    const today = {
      conversations: 0,
      plannerSteps: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      byModel: [],
    };

    const map5h = new Map();
    const mapToday = new Map();
    const convSummaries = [];

    for (const entry of entries) {
      const { conversationId, transcriptPath } = entry;
      let { dbPath } = entry;
      if (!dbPath) {
        dbPath = findConversationDbPath(conversationId, this.#getAppDataDirs());
        if (dbPath) entry.dbPath = dbPath;
      }
      activePaths.add(transcriptPath);
      if (dbPath) activeDbPaths.add(dbPath);

      let stat;
      try {
        stat = statSync(transcriptPath);
      } catch {
        continue;
      }

      const dbSig = dbPath ? this.genCache.getDbSignature(dbPath) : '';
      let cached = this.fileCache.get(transcriptPath);
      if (
        !cached ||
        cached.mtimeMs !== stat.mtimeMs ||
        cached.size !== stat.size ||
        cached.dbSig !== dbSig
      ) {
        let raw = '';
        try {
          raw = readFileSync(transcriptPath, 'utf8');
        } catch {
          continue;
        }
        const genMeta = dbPath ? this.genCache.readConversation(dbPath) : null;
        const finishMap = this.getStepFinishTimes ? this.getStepFinishTimes(conversationId) : null;
        const analysis = analyzeConversation(raw, {
          conversationId,
          fileMtimeMs: stat.mtimeMs,
          stepFinishTimes: finishMap,
          genMetaByStep: genMeta ? genMeta.byStep : null,
          latestGenModel: genMeta ? genMeta.latestModel : null,
          detectedContextLimit: genMeta ? genMeta.detectedContextLimit : 0,
          nowMs,
        });
        cached = {
          conversationId,
          transcriptPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          dbSig,
          analysis,
        };
        this.fileCache.set(transcriptPath, cached);
      }

      const a = cached.analysis;
      const liveActivity =
        a.activity.state === 'idle'
          ? a.activity
          : detectActivityState(a.tailSteps || [], stat.mtimeMs, nowMs);
      convSummaries.push({
        conversationId,
        mtimeMs: stat.mtimeMs,
        titlePreview: a.titlePreview,
        contextUsed: a.contextUsed,
        lastTokPerSec: a.lastTokPerSec,
        activeModel: a.activeModel,
        activityState: liveActivity.state,
      });

      let in5h = false;
      let inToday = false;
      for (const rec of a.plannerRecords) {
        if (!rec.createdMs) continue;
        if (rec.createdMs >= fiveHourStart && rec.createdMs <= nowMs + 60_000) {
          in5h = true;
          rolling5h.plannerSteps += 1;
          rolling5h.inputTokens += rec.inputTokens;
          rolling5h.cacheReadTokens += rec.cacheReadTokens;
          rolling5h.cacheCreationTokens += rec.cacheCreationTokens;
          rolling5h.outputTokens += rec.outputTokens;
          rolling5h.thinkingTokens += rec.thinkingTokens;
          rolling5h.totalTokens +=
            rec.inputTokens + rec.cacheReadTokens + rec.cacheCreationTokens + rec.outputTokens;
          if (rolling5h.oldestStepMs === 0 || rec.createdMs < rolling5h.oldestStepMs) {
            rolling5h.oldestStepMs = rec.createdMs;
          }
          addRecordToModelMap(map5h, rec);
        }
        if (rec.createdMs >= todayStart && rec.createdMs <= nowMs + 60_000) {
          inToday = true;
          today.plannerSteps += 1;
          today.inputTokens += rec.inputTokens;
          today.cacheReadTokens += rec.cacheReadTokens;
          today.cacheCreationTokens += rec.cacheCreationTokens;
          today.outputTokens += rec.outputTokens;
          today.thinkingTokens += rec.thinkingTokens;
          today.totalTokens +=
            rec.inputTokens + rec.cacheReadTokens + rec.cacheCreationTokens + rec.outputTokens;
          addRecordToModelMap(mapToday, rec);
        }
      }
      if (in5h) rolling5h.conversations += 1;
      if (inToday) today.conversations += 1;
    }

    for (const cachedPath of this.fileCache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }
    this.genCache.pruneExcept(activeDbPaths);

    if (rolling5h.oldestStepMs > 0) {
      rolling5h.resetInMs = Math.max(0, rolling5h.oldestStepMs + FIVE_HOURS_MS - nowMs);
    }

    rolling5h.byModel = finalizeModelBreakdown(map5h, rolling5h.totalTokens, rolling5h.plannerSteps);
    today.byModel = finalizeModelBreakdown(mapToday, today.totalTokens, today.plannerSteps);

    convSummaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      recentConversations: convSummaries.slice(0, 12),
      rolling5h,
      today,
    };
  }
}

export function clampContextLimit(rawLimit) {
  const n = Number(rawLimit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONTEXT_LIMIT;
  return Math.max(32000, Math.min(2000000, Math.round(n)));
}

/**
 * Shared live tracker & snapshot builder for both Sidecar backend and standalone CLI/server.
 */
export class VitalsTracker {
  constructor(options = {}) {
    this.fixedAppDataDirs = Array.isArray(options.appDataDirs) ? options.appDataDirs : null;
    this.timingsFilePath = typeof options.timingsFilePath === 'string' ? options.timingsFilePath : '';
    this.stepFinishTimesByConv = new Map(); // convId -> { updatedAt, steps: Map<number, number> }
    this.lastStatByConv = new Map(); // convId -> { mtimeMs, size }
    this.genCache = new GenMetadataCache();
    this.scanner = new AggregateScanner({
      appDataDirs: this.fixedAppDataDirs,
      scanThrottleMs: options.scanThrottleMs,
      getStepFinishTimes: (convId) => this.getStepFinishMap(convId),
      genCache: this.genCache,
    });
    this.#loadTimings();
  }

  #loadTimings() {
    if (!this.timingsFilePath || !existsSync(this.timingsFilePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.timingsFilePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      for (const [convId, entry] of Object.entries(parsed)) {
        if (!ID_RE.test(convId) || !entry || typeof entry !== 'object') continue;
        const map = new Map();
        const rawSteps = entry.steps && typeof entry.steps === 'object' ? entry.steps : {};
        for (const [idxStr, ms] of Object.entries(rawSteps)) {
          const idx = Number(idxStr);
          const finishMs = Number(ms);
          if (Number.isFinite(idx) && Number.isFinite(finishMs) && finishMs > 0) {
            map.set(idx, finishMs);
          }
        }
        this.stepFinishTimesByConv.set(convId, {
          updatedAt: Number(entry.updatedAt) || 0,
          steps: map,
        });
      }
    } catch {
      // Ignore corrupt timings cache
    }
  }

  #saveTimings() {
    if (!this.timingsFilePath) return;
    try {
      const entries = [...this.stepFinishTimesByConv.entries()]
        .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
        .slice(0, 50);
      const out = {};
      for (const [convId, entry] of entries) {
        out[convId] = {
          updatedAt: entry.updatedAt || Date.now(),
          steps: Object.fromEntries(entry.steps.entries()),
        };
      }
      mkdirSync(dirname(this.timingsFilePath), { recursive: true });
      writeFileSync(this.timingsFilePath, JSON.stringify(out), 'utf8');
    } catch {
      // Best-effort persistence
    }
  }

  getStepFinishMap(conversationId, createIfMissing = false) {
    let entry = this.stepFinishTimesByConv.get(conversationId);
    if (!entry && createIfMissing) {
      entry = { updatedAt: Date.now(), steps: new Map() };
      this.stepFinishTimesByConv.set(conversationId, entry);
    }
    return entry ? entry.steps : null;
  }

  #getAppDataDirs() {
    return this.fixedAppDataDirs || findAppDataDirs();
  }

  observeConversation(conversationId) {
    if (!conversationId || !ID_RE.test(conversationId)) return false;
    const transcriptPath = findTranscriptPath(conversationId, this.#getAppDataDirs());
    if (!transcriptPath) return false;
    let stat;
    try {
      stat = statSync(transcriptPath);
    } catch {
      return false;
    }
    const prev = this.lastStatByConv.get(conversationId);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      return false;
    }
    this.lastStatByConv.set(conversationId, { mtimeMs: stat.mtimeMs, size: stat.size });

    let raw = '';
    try {
      raw = readFileSync(transcriptPath, 'utf8');
    } catch {
      return false;
    }
    const { steps } = parseTranscriptLines(raw);
    if (!steps.length) return false;

    const last = steps[steps.length - 1];
    if (last?.type === 'PLANNER_RESPONSE' && last?.status === 'DONE') {
      const idx = Number.isFinite(last.step_index) ? last.step_index : steps.length - 1;
      const startMs = parseIsoMs(last.created_at);
      const map = this.getStepFinishMap(conversationId, true);
      if (!map.has(idx) && startMs > 0 && stat.mtimeMs >= startMs) {
        map.set(idx, stat.mtimeMs);
        this.stepFinishTimesByConv.get(conversationId).updatedAt = Date.now();
        this.#saveTimings();
        return true;
      }
    }
    return false;
  }

  getSnapshot(options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const isAutoLimit =
      options.contextLimit === undefined ||
      options.contextLimit === null ||
      options.contextLimit === '' ||
      options.contextLimit === 'auto' ||
      Number(options.contextLimit) <= 0;
    const manualLimit = isAutoLimit ? 0 : clampContextLimit(options.contextLimit);
    const defaultConv =
      options.defaultConversationId && ID_RE.test(options.defaultConversationId)
        ? options.defaultConversationId
        : '';
    const requestedConv =
      options.conversationId && ID_RE.test(options.conversationId) ? options.conversationId : '';

    const appDataDirs = this.#getAppDataDirs();
    const aggregate = this.scanner.scan(nowMs);

    let resolvedConversationId = requestedConv || defaultConv;
    let resolvedMode = requestedConv ? 'selected' : defaultConv ? 'bound' : 'latest_active';

    let transcriptPath = resolvedConversationId
      ? findTranscriptPath(resolvedConversationId, appDataDirs)
      : '';

    if (!transcriptPath) {
      const fallback = aggregate.recentConversations[0]?.conversationId || '';
      if (fallback) {
        resolvedConversationId = fallback;
        transcriptPath = findTranscriptPath(fallback, appDataDirs);
        resolvedMode = 'latest_active';
      } else {
        resolvedMode = 'empty';
      }
    }

    let conversation = null;
    let detectedContextLimit = 0;
    if (transcriptPath && resolvedConversationId) {
      this.observeConversation(resolvedConversationId);
      try {
        const stat = statSync(transcriptPath);
        const raw = readFileSync(transcriptPath, 'utf8');
        const dbPath = findConversationDbPath(resolvedConversationId, appDataDirs);
        const genMeta = dbPath ? this.genCache.readConversation(dbPath) : null;
        detectedContextLimit = genMeta?.detectedContextLimit || 0;
        const finishMap = this.getStepFinishMap(resolvedConversationId, true);
        const prevSize = finishMap.size;
        const full = analyzeConversation(raw, {
          conversationId: resolvedConversationId,
          contextLimit: manualLimit > 0 ? manualLimit : undefined,
          detectedContextLimit,
          fileMtimeMs: stat.mtimeMs,
          stepFinishTimes: finishMap,
          genMetaByStep: genMeta ? genMeta.byStep : null,
          latestGenModel: genMeta ? genMeta.latestModel : null,
          nowMs,
        });
        if (finishMap.size !== prevSize) {
          this.stepFinishTimesByConv.get(resolvedConversationId).updatedAt = nowMs;
          this.#saveTimings();
        }
        const { plannerRecords: _drop1, tailSteps: _drop2, ...publicConv } = full;
        conversation = publicConv;
      } catch {
        conversation = null;
      }
    }

    const effectiveContextLimit =
      manualLimit > 0
        ? manualLimit
        : clampContextLimit(detectedContextLimit || DEFAULT_CONTEXT_LIMIT);

    return {
      serverTimeMs: nowMs,
      resolvedConversationId: resolvedConversationId || '',
      resolvedMode,
      contextLimit: effectiveContextLimit,
      contextLimitMode: manualLimit > 0 ? 'manual' : 'auto',
      detectedContextLimit: detectedContextLimit > 0 ? detectedContextLimit : null,
      conversation,
      recentConversations: aggregate.recentConversations,
      rolling5h: aggregate.rolling5h,
      today: aggregate.today,
    };
  }
}
