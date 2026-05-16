---
name: memory-engine
description: Memory confidence scoring + time-decay + FTS5 parallel recall engine. Smart add (file → reindex → category-routed confidence), hybrid search (vector + FTS5 parallel, RRF fusion). Use when storing important facts or searching with keyword precision.
commands:
  - /memory add <text> [--category <temporary|raw_log|preference|kg_node|user_identity>] [--protected]
  - /memory search <query> [--top-k <n>]
  - /memory update <partial-chunk-id> [--category <cat>] [--hit]
  - /memory archive
  - /memory status
---

# Memory Engine v1.2

Confidence + time-decay system with parallel storage and multi-channel RRF search.

## Architecture

- **chunks**（OpenClaw 所有）— embedding + text
- **chunks_fts**（OpenClaw 原生）— FTS5 全文索引，自动同步
- **memory_confidence**（引擎所有）— 并行表，存储置信度、命中、分类、归档状态
- **写入路径**：写文件 → `openclaw memory index`（生成向量 + FTS5）→ 写入 `memory_confidence`
- **Embedding**: Qwen/Qwen3-Embedding-4B via SiliconFlow
- **Search**: 双通道并行（向量 + FTS5）→ RRF 融合（≥2通道, k=60）
- **Script**: `scripts/memory-engine.js`

## Category Routing

| Category | Init Confidence | Base τ (days) |
|----------|----------------|---------------|
| temporary | 0.40 | 2 |
| raw_log | 0.50 | 7 |
| preference | 0.70 | 30 |
| kg_node | 0.85 | 90 |
| user_identity | 0.95 | 365 |

## Commands

### Add Memory (recommended)
```bash
node scripts/memory-engine.js add "用户偏好使用中文交流" --category preference
node scripts/memory-engine.js add "Sol是开发者" --category user_identity --protected
```
Writes to `memory/smart-add/YYYY-MM-DD.md` → reindex → writes confidence.

### Search by Confidence
```bash
node scripts/memory-engine.js search "用户偏好" --top-k 5
```

### Update (e.g., after LLM citation)
```bash
node scripts/memory-engine.js update <chunk-id-prefix> --hit
node scripts/memory-engine.js update <chunk-id-prefix> --category preference
```

### Archive / Diagnose / Status
```bash
node scripts/memory-engine.js archive
node scripts/memory-engine.js diagnose
node scripts/memory-engine.js status
```
