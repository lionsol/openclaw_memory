-- ============================================================
-- Memory Engine v1.0 — Schema Definition
-- 
-- Usage:
--   sqlite3 ~/.openclaw/memory/main.sqlite < schemas.sql
-- ============================================================

-- memory_confidence: Parallel confidence/time-decay table.
-- Each row maps 1:1 to a chunk in the OpenClaw-owned `chunks` table.
-- chunk_id is the SHA-256 primary key from chunks.id.
CREATE TABLE IF NOT EXISTS memory_confidence (
    chunk_id              TEXT    PRIMARY KEY,              -- FK to chunks.id
    initial_confidence    REAL    NOT NULL DEFAULT 0.5,     -- initial confidence snapshot
    confidence            REAL    NOT NULL DEFAULT 0.5,     -- last-reinforced confidence
    last_confidence_update INTEGER,                         -- last reinforce/update time (Unix sec)
    base_tau              REAL    NOT NULL DEFAULT 7.0,     -- minimum half-life in days
    hit_count             INTEGER NOT NULL DEFAULT 0,       -- citation count
    is_archived           INTEGER NOT NULL DEFAULT 0,       -- 1 = below archive threshold
    is_protected          INTEGER NOT NULL DEFAULT 0,       -- 1 = exempt from decay/archival
    conflict_flag         INTEGER NOT NULL DEFAULT 0,       -- 1 = flagged as potentially contradictory
    category              TEXT    NOT NULL DEFAULT 'raw_log', -- memory category for routing
    kg_data               TEXT                              -- JSON subgraph container (KG bridge)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_mc_archived  ON memory_confidence(is_archived);
CREATE INDEX IF NOT EXISTS idx_mc_category  ON memory_confidence(category);
CREATE INDEX IF NOT EXISTS idx_mc_protected ON memory_confidence(is_protected);

-- ============================================================
-- Category Routing Parameters (for reference, not SQL)
-- ============================================================
-- Category        | Init Confidence | Base τ (days) | Protected
-- ----------------|-----------------|---------------|----------
-- temporary      | 0.40            | 2             | no
-- raw_log        | 0.50            | 7             | no
-- preference     | 0.70            | 30            | no
-- kg_node        | 0.85            | 90            | yes
-- user_identity  | 0.95            | 365           | yes

-- ============================================================
-- Diagnostic Queries (for reference)
-- ============================================================

-- Orphan check: confidence entries without a matching chunk
-- SELECT mc.chunk_id FROM memory_confidence mc
-- LEFT JOIN chunks c ON mc.chunk_id = c.id
-- WHERE c.id IS NULL;

-- Missing check: chunks without confidence entries
-- SELECT c.id FROM chunks c
-- LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
-- WHERE mc.chunk_id IS NULL;

-- Category distribution
-- SELECT category, COUNT(*) as count,
--   ROUND(AVG(confidence), 4) as avg_conf,
--   ROUND(AVG(hit_count), 2) as avg_hits
-- FROM memory_confidence
-- GROUP BY category
-- ORDER BY count DESC;

-- Archive candidates (real-time confidence < 0.15)
-- SELECT chunk_id, confidence, hit_count, base_tau,
--   ROUND(confidence * exp(-(strftime('%s','now') - last_confidence_update) / (base_tau * 86400)), 4) as real_conf
-- FROM memory_confidence
-- WHERE is_archived = 0 AND is_protected = 0
--   AND category != 'user_identity';
