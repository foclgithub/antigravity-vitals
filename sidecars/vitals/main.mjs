import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { ID_RE, VitalsTracker } from './vitals-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCH_TTL_MS = 30 * 60 * 1000;
const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const timingsFilePath = join(
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || tmpdir(),
  'vitals-step-timings.json',
);

const app = new SidecarApp();
const tracker = new VitalsTracker({ timingsFilePath });

const watchedConvs = new Map(); // convId -> lastSeenMs
const boundConvId =
  app.config.conversationId && ID_RE.test(app.config.conversationId) ? app.config.conversationId : '';
if (boundConvId) {
  watchedConvs.set(boundConvId, Date.now());
}

function touchWatched(convId, nowMs) {
  if (convId && ID_RE.test(convId)) {
    watchedConvs.set(convId, nowMs);
  }
}

function pruneWatched(nowMs) {
  for (const [convId, lastSeenMs] of watchedConvs.entries()) {
    if (convId === boundConvId) continue;
    if (nowMs - lastSeenMs > WATCH_TTL_MS) {
      watchedConvs.delete(convId);
    }
  }
}

const watchTimer = setInterval(() => {
  const nowMs = Date.now();
  pruneWatched(nowMs);
  for (const convId of watchedConvs.keys()) {
    tracker.observeConversation(convId);
  }
}, 1000);
watchTimer.unref();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf8'));

for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf8'), { contentType }),
    'GET',
  );
}

app.api(
  '/api/vitals',
  (data) => {
    const nowMs = Date.now();
    const requestedConv =
      typeof data?.conversationId === 'string' && ID_RE.test(data.conversationId)
        ? data.conversationId
        : '';

    touchWatched(requestedConv, nowMs);
    touchWatched(boundConvId, nowMs);

    const snapshot = tracker.getSnapshot({
      conversationId: requestedConv,
      contextLimit: data?.contextLimit,
      defaultConversationId: boundConvId,
    });

    touchWatched(snapshot.resolvedConversationId, nowMs);
    pruneWatched(nowMs);
    return snapshot;
  },
  'GET',
);

app.run();
