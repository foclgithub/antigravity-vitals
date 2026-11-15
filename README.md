# Antigravity Vitals

**Zero-patch, zero-dependency Native Antigravity 2.0 Sidecar UI Plugin (`v0.2.0`)** for real-time per-model throughput (`tok/s`), TTFT latency, context runway, cache efficiency, and local 5-hour / daily token telemetry.

> Designed to keep `/Applications/Antigravity.app` (and `app.asar`) completely untouched — preserving official code signatures and auto-updates. All metrics are read-only parsed from local `transcript.jsonl` logs and `conversations/<id>.db` (`gen_metadata` SQLite + pure-JS Protobuf decoder).

---

## Key Features

- **Per-Model Breakdown (`byModel`)**: Automatically identifies models per step (such as `Orchestrator (Carbon)`, `Gemini 4 Carbon (High / Medium)`, `Gemini 4 Argon`, `Gemini 4 Hydrogen`, `Gemini Flash`) across Current Session, 5h Window, and Today scopes, comparing step share, end-to-end & streaming `tok/s`, average TTFT, thinking tokens, and total tokens.
- **Real-Time Throughput, TTFT & Thinking Split**: Live activity state (`Idle` / `Generating` / `Running Tool` with `200ms` stopwatch), end-to-end vs post-TTFT streaming speed, TTFT latency, and `thinkingTokens` vs response text split, rendered with a GitHub Primer (light) / Linear (dark) precision engineering UI and step blueprint chart.
- **Multi-Segment Context Runway**: Auto-detects the host context budget (`auto` mode from `gen_metadata` protobuf), visualizes Cache Read / Fresh Input / Output segments, warns at `>= 85%`, and records automatic compaction (`CHECKPOINT`) events.
- **Local 5h Rolling Window & Today Totals**: Scans local conversations with an incremental mtime/size cache, showing 5-hour sliding usage, reset countdown for the oldest step, and daily accumulation.
- **Standalone CLI & Browser Preview**: Inspect live metrics directly in the terminal (`node cli.mjs`) or launch a standalone `127.0.0.1` web UI (`node cli.mjs --serve 0`).

## Requirements

- Node.js `>= 22.5.0` (uses built-in `node:sqlite`, zero external `npm` dependencies).
- Google Antigravity 2.0 desktop client.

## Quick Start

```bash
git clone https://github.com/foclgithub/antigravity-vitals.git
cd antigravity-vitals

# 1. Run unit tests
npm test

# 2. Install/sync plugin to ~/.gemini/config/plugins/antigravity-vitals
npm run sync
```

Reload Antigravity IDE after syncing, then open **Vitals** from the auxiliary pane (or navigate to `sidecar://antigravity-vitals/vitals/`).

## CLI Usage

```bash
# Print telemetry summary for the active or latest conversation
node cli.mjs

# Query a specific conversation in JSON format
node cli.mjs --conv <conversation-id> --json

# Launch standalone browser dashboard on 127.0.0.1
node cli.mjs --serve 0
```

---

# Antigravity Vitals（中文说明）

原生 **Antigravity 2.0 Sidecar 辅助栏插件（v0.2.0）**，零第三方依赖、不修改 `Antigravity.app` 安装包与签名。全部遥测指标均通过只读方式解析本地 `transcript.jsonl` 与 `conversations/<id>.db`（内置零依赖 Protobuf 解码器）获得。

## 核心能力

- **分模型速度与消耗中心**：按步识别当前会话、过去 5 小时与今日累计窗口内调用的每个模型，对比步数占比、端到端与流式 `tok/s`、平均首包延迟（`TTFT`）、思考 Token 与总消耗。
- **实时状态、TTFT 与思考拆分**：实时跟踪生成中 / 工具执行中 / 空闲状态（`200ms` 读秒）、流式生成速率与思考/正文占比，提供 GitHub Primer 浅色 / Linear 深色工程主题与最近 14 步速率点阵图。
- **多段上下文容量跑道**：自动读取宿主 `contextLimit`，按「缓存读取 / 新增输入 / 输出」三段展示占用比例，超过 `85%` 触发预警并追踪 `CHECKPOINT` 自动压缩事件。
- **本地 5 小时与今日汇总**：增量缓存扫描本机各会话，统计过去 5 小时滑动窗口用量、最早一笔滑出倒计时及今日累计消耗。

## 快速使用

```bash
git clone https://github.com/foclgithub/antigravity-vitals.git
cd antigravity-vitals

# 运行单元测试
npm test

# 同步插件到 ~/.gemini/config/plugins/antigravity-vitals
npm run sync

# 命令行查看实时摘要，或启动本地独立预览页
node cli.mjs
node cli.mjs --serve 0
```

同步完成后重载 Antigravity IDE，在右侧辅助栏打开 **Vitals**（或点击 `sidecar://antigravity-vitals/vitals/`）即可使用。

## License

[MIT](./LICENSE)
