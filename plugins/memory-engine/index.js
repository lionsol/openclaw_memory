import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getMemorySearchManager } from "openclaw/plugin-sdk/memory-core-engine-runtime";
import Database from "better-sqlite3";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const DB_PATH = resolve(homedir(), ".openclaw/memory/main.sqlite");
const WORKSPACE = resolve(homedir(), ".openclaw/workspace");
const SMART_ADD_DIR = "memory/smart-add";
const KG_PATH = resolve(homedir(), ".openclaw/workspace/knowledge-graph.json");

const CATEGORY_MAP = {
  temporary:       { conf: 0.40, tau: 2.0 },
  raw_log:         { conf: 0.50, tau: 7.0 },
  episodic:        { conf: 0.70, tau: 30.0 },
  preference:      { conf: 0.70, tau: 30.0 },
  kg_node:         { conf: 0.85, tau: 90.0 },
  user_identity:   { conf: 0.95, tau: 365.0 },
};

function withDb(fn) {
  const db = new Database(DB_PATH, { readonly: false });
  try { return fn(db); } finally { db.close(); }
}

function calcTau(hits, baseTau) {
  if (baseTau >= 365.0) return baseTau;
  return baseTau + (365.0 - baseTau) * (1 - Math.exp(-0.3 * hits));
}

function catParams(category, isProtected) {
  if (isProtected || category === "user_identity") return { conf: 0.95, tau: 365.0 };
  return CATEGORY_MAP[category] || CATEGORY_MAP.raw_log;
}

function calcRealtimeConf(row, now) {
  if (row.is_protected) return row.confidence;
  if (!row.last_confidence_update) return row.confidence;
  const deltaDays = (now - row.last_confidence_update) / 86400;
  const tau = calcTau(row.hit_count, row.base_tau);
  let c = row.confidence * Math.exp(-deltaDays / tau);
  if (row.conflict_flag) c -= 0.5;
  return Math.max(0, c);
}

function ensureConfidenceTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_confidence (
      chunk_id TEXT PRIMARY KEY,
      initial_confidence REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      last_confidence_update INTEGER,
      base_tau REAL NOT NULL DEFAULT 7.0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      conflict_flag INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'raw_log',
      kg_data TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mc_archived ON memory_confidence(is_archived)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mc_category ON memory_confidence(category)");
}

function batchReinforce(db, ids, nowSec) {
  const stmt = db.prepare([
    "UPDATE memory_confidence SET",
    "hit_count = hit_count + 1,",
    "confidence = MIN(1.0, confidence + 0.1),",
    "last_confidence_update = ?",
    "WHERE chunk_id = ?"
  ].join(" "));
  const txn = db.transaction(() => {
    let count = 0;
    for (const id of ids) {
      stmt.run(nowSec, id);
      if (stmt.changes > 0) count++;
    }
    return count;
  });
  return txn();
}

function resolvePrefixes(db, prefixes) {
  const results = [];
  for (const pf of prefixes) {
    const rows = db.prepare([
      "SELECT chunk_id FROM memory_confidence WHERE chunk_id LIKE ? || '%' LIMIT 1"
    ].join(" ")).all(pf);
    if (rows.length > 0) results.push(rows[0].chunk_id);
  }
  return results;
}

function resolveSFKey() {
  try {
    const cfg = JSON.parse(readFileSync(resolve(homedir(), '.openclaw/openclaw.json'), 'utf-8'));
    return cfg.models?.providers?.siliconflow?.apiKey || '';
  } catch(e) { return ''; }
}

export default definePluginEntry({
  id: "memory-engine",
  name: "Memory Engine",
  description: "Smart memory with confidence scoring, time-decay, and lifecycle management.",
  register(api) {
    // Ensure confidence table exists at startup
    try {
      withDb(db => ensureConfidenceTable(db));
    } catch (e) {
      console.error("[memory-engine] failed to init confidence table:", e.message);
    }

    // Register memory prompt supplement — guides agent to cite memory IDs
    api.registerMemoryPromptSupplement(({ addParagraph }) => {
      addParagraph([
        "## Memory Engine - 记忆置信度系统",
        "",
        "### 工作流",
        "1. **搜索记忆** → `memory_engine` action=`search`, text=`你的问题`",
        "2. **引用强化** → 如果你用了上一步的搜索结果来回答，必须调 `memory_engine` action=`cite`, chunk_ids=[结果中的id]",
        "3. **存储新记忆** → 需要长期记住的事实，用 `memory_engine` action=`add`",
        "",
        "规则：引用搜索结果却不调 `cite`，那些记忆会随时间衰减消失。",
        "每次 `cite` 让记忆更牢固（hit+1, conf+0.1, 半衰期延长）。",
      ].join("\n"));
    });

    api.registerTool({
      name: "memory_engine",
      label: "Memory Engine",
      description: [
        `智能记忆系统 — 置信度评分 + 时间衰减 + 引用强化。\n`,
        `\n=== 最常用操作 ===\n`,
        `search -> 搜索记忆。写 text=你的查询。返回结果带 id/confidence/score。\n`,
        `cite   -> 引用强化。把 search 返回的 id 放入 chunk_ids 数组。巩固记忆。\n`,
        `add    -> 存新记忆。写 text=内容，推荐指定 category（见下）。\n`,
        `\n=== 其他操作 ===\n`,
        `status -> 查看统计。\n`,
        `archive -> 标记低置信度记忆为已归档。\n`,
        `update -> 手动更新某条记忆的字段。\n`,
        `\n=== category 建议 ===\n`,
        `user_identity: 用户身份/职业/核心特征（protected, 不衰减）\n`,
        `preference: 用户偏好/习惯（τ=30天）\n`,
        `kg_node: 知识图谱结构结论（τ=90天）\n`,
        `raw_log: 日常对话/未提炼想法（τ=7天, 默认）\n`,
        `temporary: 临时/一次性（τ=2天）\n`,
        `episodic: 情节摘要（τ=30天）\n`,
        `\n重要：用 search 后必须 cite（或 update --hit），否则记忆会衰减。`,
      ].join(''),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "search", "cite", "update", "status", "archive", "kg-bridge", "detect-conflicts"],
          },
          text: { type: "string" },
          category: {
            type: "string",
            enum: ["temporary", "raw_log", "episodic", "preference", "kg_node", "user_identity"],
          },
          protected: { type: "boolean" },
          chunk_id: { type: "string" },
          chunk_ids: {
            type: "array",
            items: { type: "string" },
            description: "List of chunk ID prefixes to cite/reinforce",
          },
          hit: { type: "boolean" },
          deep: { type: "boolean", description: "Use LLM for semantic contradiction check (slow path)" },
          top_k: { type: "number", default: 5 },
        },
        required: ["action"],
      },
      execute: async (_toolCallId, params) => {
        const { action, text, category, protected: isProtected, chunk_id, hit, top_k, deep } = params;
        const k = top_k || 5;
        const nowSec = Math.floor(Date.now() / 1000);

        try {
          if (action === "add") {
            if (!text) return { error: "text required for add" };
            const cat = category || "raw_log";
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10);
            const ts = now.toISOString().replace(/[:.]/g, "").slice(0, 15);
            const entryId = `${ts}_${cat}`;
            const fileDir = resolve(WORKSPACE, SMART_ADD_DIR);
            const filePath = resolve(fileDir, `${dateStr}.md`);
            mkdirSync(fileDir, { recursive: true });
            const header = !existsSync(filePath) ? "# Smart Added Memory\n\n" : "";
            const entry = `${header}## ${entryId}\n\nCategory: ${cat}${isProtected ? " | Protected" : ""}\n\n${text.trim()}\n\n`;
            appendFileSync(filePath, header ? entry : `\n${entry}`);

            // Sync via manager
            try {
              const { manager } = await getMemorySearchManager({});
              if (manager) await manager.sync();
            } catch (e) {
              // fallback: reindex may happen on next cycle
            }

            // Write confidence
            const result = withDb(db => {
              const fileRel = filePath.replace(WORKSPACE + "/", "");
              const newChunks = db.prepare([
                "SELECT id FROM chunks WHERE path = ?",
                "AND id NOT IN (SELECT chunk_id FROM memory_confidence)"
              ].join(" ")).all(fileRel);
              const { conf, tau } = catParams(cat, isProtected);
              if (newChunks.length > 0) {
                const insert = db.prepare([
                  "INSERT INTO memory_confidence",
                  "(chunk_id, initial_confidence, confidence, last_confidence_update,",
                  "base_tau, hit_count, is_archived, is_protected, conflict_flag, category)",
                  "VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?)"
                ].join(" "));
                const txn = db.transaction(() => {
                  for (const row of newChunks) {
                    insert.run(row.id, conf, conf, nowSec, tau, isProtected ? 1 : 0, cat);
                  }
                });
                txn();
              }
              return { chunks_added: newChunks.length, category: cat, confidence: conf, tau };
            });
            return { success: true, ...result };
          }

          if (action === "search") {
            if (!text) return { error: "query text required for search" };

            // Channel 1: Vector search via OpenClaw manager
            let vectorCandidates = [];
            try {
              const { manager } = await getMemorySearchManager({});
              if (manager) {
                const raw = await manager.search(text, { limit: 30 });
                vectorCandidates = raw?.entries || raw || [];
              }
            } catch (e) {}

            // Channel 2: FTS5 full-text search
            let ftsCandidates = [];
            try {
              const safeQuery = text.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
              if (safeQuery) {
                withDb(db => {
                  ftsCandidates = db.prepare(`
                    SELECT c.id, c.text,
                      COALESCE(mc.confidence, 0.5) as confidence,
                      mc.last_confidence_update, COALESCE(mc.base_tau, 7.0) as base_tau,
                      COALESCE(mc.hit_count, 0) as hit_count, COALESCE(mc.is_protected, 0) as is_protected,
                      COALESCE(mc.conflict_flag, 0) as conflict_flag, COALESCE(mc.category, 'raw_log') as category
                    FROM chunks_fts f
                    JOIN chunks c ON c.id = f.id
                    LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
                    WHERE chunks_fts MATCH ?
                      AND COALESCE(mc.is_archived, 0) = 0
                    ORDER BY bm25(chunks_fts, 0)
                    LIMIT 20
                  `).all(safeQuery);
                });
              }
            } catch (e) {}

            // Channel 3: KG bridge (if kg.js exists)
            let kgCandidates = [];
            let kgActive = false;
            const kgJsonPath = resolve(WORKSPACE, 'knowledge-graph.json');
            const kgModulePath = resolve(WORKSPACE, 'skills/jpeng-knowledge-graph-memory');
            try {
              if (existsSync(kgJsonPath) && existsSync(resolve(kgModulePath, 'index.js'))) {
                const KG = require(kgModulePath);
                const data = JSON.parse(readFileSync(kgJsonPath, 'utf-8'));
                const kg = KG.KnowledgeGraph.fromJSON(data);
                const concepts = kg.search({ name: text });
                if (Array.isArray(concepts) && concepts.length > 0) {
                  kgActive = true;
                  const names = concepts.map(c => c.name).filter(Boolean);
                  if (names.length > 0) {
                    withDb(db => {
                      const seen = new Set();
                      for (const name of names) {
                        const safeName = name.replace(/[^\w\s]/g, ' ').trim();
                        if (!safeName || safeName.length < 2) continue;
                        const rows = db.prepare([
                          'SELECT DISTINCT c.id, c.text,',
                          '  COALESCE(mc.confidence, 0.5) as confidence,',
                          '  mc.last_confidence_update, COALESCE(mc.base_tau, 7.0) as base_tau,',
                          '  COALESCE(mc.hit_count, 0) as hit_count, COALESCE(mc.is_protected, 0) as is_protected,',
                          '  COALESCE(mc.conflict_flag, 0) as conflict_flag, COALESCE(mc.category, \'raw_log\') as category',
                          'FROM chunks_fts f',
                          'JOIN chunks c ON c.id = f.id',
                          'LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id',
                          'WHERE chunks_fts MATCH ?',
                          '  AND COALESCE(mc.is_archived, 0) = 0',
                          'ORDER BY bm25(chunks_fts, 0)',
                          'LIMIT 3'
                        ].join('\n')).all(safeName);
                        for (const row of rows) {
                          if (seen.has(row.id)) continue;
                          seen.add(row.id);
                          kgCandidates.push(row);
                          if (kgCandidates.length >= 15) break;
                        }
                        if (kgCandidates.length >= 15) break;
                      }
                    });
                  }
                }
              }
            } catch (e) {}

            // Build channels from candidates
            const channels = {};

            if (vectorCandidates.length > 0) {
              const scored = withDb(db => {
                const confRows = db.prepare(`SELECT chunk_id, confidence, last_confidence_update, base_tau, hit_count, is_protected, conflict_flag, category, is_archived FROM memory_confidence`).all();
                const confMap = new Map(confRows.map(r => [r.chunk_id, r]));
                const res = [];
                for (const c of vectorCandidates) {
                  const id = c.id || c.chunkId;
                  if (!id) continue;
                  const meta = confMap.get(id);
                  if (!meta || meta.is_archived) continue;
                  const rtConf = meta.is_protected ? meta.confidence : calcRealtimeConf(meta, nowSec);
                  const sim = c.similarity ?? c.score ?? 0.5;
                  res.push({
                    id, text: (c.text || c.content || "").slice(0, 600),
                    category: meta.category,
                    similarity: Math.round(sim * 10000) / 10000,
                    confidence_realtime: Math.round(rtConf * 10000) / 10000,
                    hit_count: meta.hit_count,
                    is_protected: meta.is_protected,
                    conflict_flag: meta.conflict_flag,
                  });
                }
                res.sort((a, b) => b.similarity - a.similarity);
                return res.slice(0, 30);
              });
              if (scored.length > 0) channels.vector = scored;
            }

            if (ftsCandidates.length > 0) {
              channels.fts = ftsCandidates.map(row => ({
                id: row.id, text: row.text.slice(0, 600),
                category: row.category,
                similarity: 0.5,
                confidence_realtime: row.is_protected ? row.confidence
                  : Math.round(calcRealtimeConf(row, nowSec) * 10000) / 10000,
                hit_count: row.hit_count,
                is_protected: row.is_protected,
                conflict_flag: row.conflict_flag,
              }));
            }

            if (kgCandidates.length > 0) {
              channels.kg = kgCandidates.map(row => ({
                id: row.id, text: row.text.slice(0, 600),
                category: row.category,
                similarity: 0.5,
                confidence_realtime: row.is_protected ? row.confidence
                  : Math.round(calcRealtimeConf(row, nowSec) * 10000) / 10000,
                hit_count: row.hit_count,
                is_protected: row.is_protected,
                conflict_flag: row.conflict_flag,
              }));
            }

            const channelCount = Object.keys(channels).length;
            if (channelCount === 0) {
              return { pool: 0, results: [], channels: [], note: "no channels returned results" };
            }

            // RRF fusion
            const fusion = new Map();
            for (const [chName, rankedItems] of Object.entries(channels)) {
              rankedItems.forEach((item, idx) => {
                const exist = fusion.get(item.id) || {
                  id: item.id, text: item.text, category: item.category,
                  sources: [], rrfScore: 0,
                  similarity: item.similarity, confidence_realtime: item.confidence_realtime,
                  hits: item.hit_count,
                };
                exist.sources.push(chName);
                let acc = 0;
                for (const [cn, items] of Object.entries(channels)) {
                  const rank = items.findIndex(i => i.id === item.id);
                  if (rank >= 0) acc += 1 / (60 + rank + 1);
                }
                exist.rrfScore = Math.round(acc * 10000) / 10000;
                fusion.set(item.id, exist);
              });
            }

            const fused = Array.from(fusion.values());
            fused.sort((a, b) => b.rrfScore - a.rrfScore);
            const results = fused.slice(0, k).map(item => ({
              id: item.id.slice(0, 16),
              text: item.text.slice(0, 200),
              category: item.category,
              rrf_score: item.rrfScore,
              sources: item.sources,
              similarity: item.similarity,
              confidence: item.confidence_realtime,
              hits: item.hits,
            }));

            return {
              pool: fused.length,
              channels: Object.keys(channels),
              channel_sizes: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.length])),
              kg_active: kgActive,
              results,
            };
          }
          if (action === "cite") {
            if (!chunk_ids || chunk_ids.length === 0) return { error: "chunk_ids array required" };
            return withDb(db => {
              const fullIds = resolvePrefixes(db, chunk_ids);
              if (fullIds.length === 0) return { success: true, reinforced: 0, note: "no matching chunks found" };
              const count = batchReinforce(db, fullIds, nowSec);
              return {
                success: true,
                reinforced: count,
                ids: fullIds.map(id => id.slice(0, 16)),
                next_confidence: (0.5 + count * 0.1).toFixed(2),
              };
            });
          }

          if (action === "update") {
            if (!chunk_id) return { error: "chunk_id required" };
            return withDb(db => {
              const matches = db.prepare([
                "SELECT chunk_id FROM memory_confidence WHERE chunk_id LIKE ? || '%' LIMIT 2"
              ].join("")).all(chunk_id);
              if (matches.length === 0) return { error: "no match" };
              if (matches.length > 1) return { error: "multiple matches", matches: matches.map(r => r.chunk_id.slice(0, 16)) };
              const fullId = matches[0].chunk_id;
              const sets = ["last_confidence_update = ?"];
              const vals = [nowSec];
              if (category) {
                const rule = CATEGORY_MAP[category];
                if (rule) {
                  sets.push("category = ?", "initial_confidence = ?", "confidence = ?", "base_tau = ?");
                  vals.push(category, rule.conf, rule.conf, rule.tau);
                }
              }
              if (hit) sets.push("hit_count = hit_count + 1");
              if (isProtected !== undefined) { sets.push("is_protected = ?"); vals.push(isProtected ? 1 : 0); }
              vals.push(fullId);
              db.prepare(`UPDATE memory_confidence SET ${sets.join(", ")} WHERE chunk_id = ?`).run(...vals);
              return { success: true, chunk_id: fullId.slice(0, 16) };
            });
          }

          if (action === "status") {
            return withDb(db => {
              const total = db.prepare("SELECT COUNT(*) as c FROM chunks").get();
              const c = db.prepare([
                "SELECT COUNT(*) as total, SUM(is_archived) as archived,",
                "SUM(is_protected) as protected, SUM(conflict_flag) as conflicted,",
                "ROUND(AVG(confidence), 4) as avg_conf, ROUND(AVG(base_tau), 2) as avg_tau,",
                "ROUND(AVG(hit_count), 2) as avg_hits FROM memory_confidence"
              ].join(" ")).get();
              const cat = db.prepare("SELECT category, COUNT(*) as count FROM memory_confidence GROUP BY category ORDER BY count DESC").all();
              const missing = db.prepare("SELECT COUNT(*) as c FROM chunks c LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id WHERE mc.chunk_id IS NULL").get();
              return {
                chunks_total: total.c, confidence_tracked: c.total || 0,
                archived: c.archived || 0, protected: c.protected || 0,
                conflicted: c.conflicted || 0, avg_confidence: c.avg_conf || 0,
                avg_tau: c.avg_tau || 0, avg_hits: c.avg_hits || 0,
                chunks_missing_confidence: missing.c || 0, by_category: cat,
              };
            });
          }

          if (action === "archive") {
            const threshold = api.config?.archiveThreshold ?? 0.15;
            return withDb(db => {
              const rows = db.prepare([
                "SELECT chunk_id, confidence, last_confidence_update, hit_count,",
                "base_tau, is_protected, category FROM memory_confidence",
                "WHERE is_archived = 0 AND is_protected = 0 AND category != 'user_identity'"
              ].join(" ")).all();
              const toArchive = [];
              for (const row of rows) {
                if (!row.last_confidence_update) continue;
                const deltaDays = (nowSec - row.last_confidence_update) / 86400;
                const t = calcTau(row.hit_count, row.base_tau);
                const rc = row.confidence * Math.exp(-deltaDays / t);
                if (rc < threshold) toArchive.push(row.chunk_id);
              }
              if (toArchive.length > 0) {
                const ph = toArchive.map(() => "?").join(",");
                db.prepare(`UPDATE memory_confidence SET is_archived = 1 WHERE chunk_id IN (${ph})`).run(...toArchive);
              }
              return { archived: toArchive.length, threshold };
            });
          }

          if (action === "kg-bridge") {
            // Read knowledge-graph.json and write kg_data for matching chunks
            if (!existsSync(KG_PATH)) return { error: "knowledge-graph.json not found" };
            const kgRaw = JSON.parse(readFileSync(KG_PATH, "utf-8"));
            const nodes = kgRaw.nodes || kgRaw.concepts || [];
            const edges = kgRaw.edges || kgRaw.relationships || [];
            return withDb(db => {
              const subgraph = {
                node_count: nodes.length,
                edge_count: edges.length,
                nodes: nodes.slice(0, 20).map(n => ({
                  id: n.id || n.name,
                  name: n.name || n.id,
                  type: n.type || "concept",
                  properties: n.properties || {},
                })),
                edges: edges.slice(0, 30).map(e => ({
                  source: e.source || e.from,
                  target: e.target || e.to,
                  type: e.type || "RELATED_TO",
                })),
              };
              const kgJson = JSON.stringify(subgraph);
              // Write kg_data for all matching concept chunks
              const chunkMatches = db.prepare([
                "SELECT chunk_id FROM memory_confidence",
                "WHERE category IN ('kg_node', 'raw_log')",
              ].join(" ")).all();
              const update = db.prepare([
                "UPDATE memory_confidence SET kg_data = ? WHERE chunk_id = ?"
              ].join(" "));
              for (const row of chunkMatches.slice(0, 10)) {
                update.run(kgJson, row.chunk_id);
              }
              return {
                success: true,
                nodes: nodes.length,
                edges: edges.length,
                chunks_updated: Math.min(chunkMatches.length, 10),
              };
            });
          }

          if (action === "detect-conflicts") {
            return withDb(db => {
              const now = Math.floor(Date.now() / 1000);
              // Simple heuristic: find chunks with same category that have divergent confidence
              const rows = db.prepare([
                "SELECT m1.chunk_id as id1, m2.chunk_id as id2,",
                "m1.category, m1.confidence as c1, m2.confidence as c2,",
                "m1.hit_count as h1, m2.hit_count as h2",
                "FROM memory_confidence m1",
                "JOIN memory_confidence m2 ON m1.category = m2.category",
                "AND m1.chunk_id < m2.chunk_id",
                "WHERE m1.is_archived = 0 AND m2.is_archived = 0",
                "AND ABS(m1.confidence - m2.confidence) > 0.3",
                "AND ABS(m1.hit_count - m2.hit_count) > 3"
              ].join(" ")).all();

              let flagged = 0;
              const flagStmt = db.prepare([
                "UPDATE memory_confidence SET conflict_flag = 1 WHERE chunk_id = ?"
              ].join(" "));
              for (const row of rows) {
                // Flag the lower-confidence one as possibly outdated
                const lowerId = row.c1 < row.c2 ? row.id1 : row.id2;
                flagStmt.run(lowerId);
                flagged++;
              }
              return {
                success: true,
                pairs_checked: rows.length,
                flagged_as_conflict: flagged,
                note: "Lower-confidence chunks in same category with divergent hit counts flagged",
              };
            });
          }

          return { error: "unknown action", available: ["add", "search", "cite", "update", "status", "archive", "kg-bridge", "detect-conflicts"] };
        } catch (e) {
          return { error: e.message };
        }
      },
    });
  },
});
