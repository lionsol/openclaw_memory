# Changelog

All notable changes to the OpenClaw Memory System.

---

## [v1.3] — 2026-05-18

### Added

- **Plugin contracts declarations** — `plugins/memory-engine/index.js` now declares `contracts: { tools: true }`; `openclaw.plugin.json` declares tool names `["memory_engine", "image_vision"]` for proper OpenClaw plugin registration.

- **image_vision tool** — New `image_vision` agent tool registered in memory-engine plugin. Calls `Qwen3-VL-32B-Instruct` via SiliconFlow for image recognition. Supports custom questions; defaults to detailed Chinese description.

- **session-checkpoint.js** — New daily checkpoint script (`scripts/session-checkpoint.js`):
  - Reads raw_log from DB and extracts configuration patterns using SiliconFlow LLM
  - Writes extracted configs as `preference` memories (conf=0.80, tau=90 days)
  - Generates daily episode summary for warm-start injection
  - Auto-marks config conflicts: same-key configs keep the newest, set old ones to `conflict_flag=1`
  - Cron: daily at 03:55 CST (isolated session)

- **detectConfig() auto-promotion** — `smart_add` now detects configuration keywords (API keys, voice IDs, model names, file paths, Chinese config patterns) and auto-promotes `raw_log` → `preference` category.

- **Memory Prompt Supplement** — `registerMemoryPromptSupplement` dynamically injects yesterday's episode + protected memory list into session startup context for warm-start recall.

- **Conflict auto-resolution** — Session-checkpoint includes `autoResolveConfigConflicts()` step that scans all `preference` entries, groups by config key, retains the newest, marks old ones `conflict_flag=1`.

### Changed

- **Memory Engine Nightly Maintenance** cron job timeout increased from 120s → 300s to prevent model-call timeout at 2 AM.
- **Nightly maintenance message** streamlined — direct step-by-step tool calls without intermediate reporting.

### Fixed

- **Nightly maintenance timeout** — Previously timed out at 120s (120.7s actual). Tool execution was completing but the model response phase just barely exceeded the limit.

---

## [v1.2] — 2026-05-16

### Added

- **FTS5 parallel recall** — BM25 full-text search via OpenClaw native `chunks_fts` virtual table. Precise keyword matching for proper nouns, API names, code identifiers.
- **RRF three-channel fusion** — Parallel search across Vector (30 candidates) + FTS5 (20) + KG Concept Bridge (15). Results fused via Reciprocal Rank Fusion (k=60).
- **Episodic Memory layer** — New `episodic` category (conf=0.70, τ=30 days). `summarize` command aggregates raw_log into LLM summaries (keyword fallback). `kg_data` stores `episode_of` links to source chunks. `drill` command for original text expansion. Time-intent words auto-weight +0.1 in RRF.
- **KG Concept Bridge channel** — Knowledge Graph concept names → FTS5 → chunk mapping. Enables concept-driven recall.
- **episodic + kg_node categories** in category routing table.

### Changed

- Search pipeline: single-channel (v1.0) → dual (v1.1) → **triple (v1.2)**.
- RRF short-channel padding (<5 items, unranked items get rank=k+100).
- Weak citation cold-start transition logic.

---

## [v1.1] — 2026-05-15

### Added

- `memory_confidence` parallel table in SQLite.
- Category-based confidence routing: initial confidence + base tau per category.
- Hybrid search (vector similarity + confidence weighting).
- `smart_add` file → reindex → confidence workflow.
- `update --hit` for citation reinforcement.
- `archive` for low-confidence chunk archival.
- `diagnose` for tracking untracked chunks.
- `status` for summary statistics.
- Embedding via `Qwen/Qwen3-Embedding-4B` (SiliconFlow).

---

## [v1.0] — 2026-05-10

### Initial Implementation

- Schema migration with confidence, lifecycle, and status columns on `chunks` table.
- Smart add gateway with category routing.
- Hybrid search with dynamic threshold gating + exponential decay + weighted scoring.
- Update hook for citation reinforcement (hit+1, conf+0.1).
- Pure heartbeat compaction (zero-write to active confidence).
- KG bridge with subgraph packing (`kg_data` column).
- Diagnostic logging and parameter tuning guidance.
