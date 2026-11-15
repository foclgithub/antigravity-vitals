#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST_ROOT = join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-vitals');
const INCLUDE_ITEMS = ['plugin.json', 'README.md', 'assets', 'sidecars'];

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function collectFiles(srcPath, relBase, out) {
  const st = statSync(srcPath);
  if (st.isDirectory()) {
    for (const entry of readdirSync(srcPath)) {
      collectFiles(join(srcPath, entry), join(relBase, entry), out);
    }
  } else if (st.isFile()) {
    out.push({ srcPath, relPath: relBase });
  }
}

function syncPlugin() {
  const files = [];
  for (const item of INCLUDE_ITEMS) {
    const src = join(__dirname, item);
    if (!existsSync(src)) {
      throw new Error(`Missing required plugin entry: ${src}`);
    }
    collectFiles(src, item, files);
  }

  if (existsSync(DEST_ROOT)) {
    rmSync(DEST_ROOT, { recursive: true, force: true });
  }
  mkdirSync(DEST_ROOT, { recursive: true });

  const verified = [];
  for (const { srcPath, relPath } of files) {
    const destPath = join(DEST_ROOT, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    const srcHash = sha256(srcPath);
    const destHash = sha256(destPath);
    if (srcHash !== destHash) {
      throw new Error(`SHA-256 mismatch on ${relPath}: ${srcHash} !== ${destHash}`);
    }
    verified.push({ relPath, sha256: destHash });
  }

  console.log(`Synced ${verified.length} files to ${DEST_ROOT}`);
  for (const item of verified) {
    console.log(`  [OK] ${item.relPath} (${item.sha256.slice(0, 12)})`);
  }
}

syncPlugin();
