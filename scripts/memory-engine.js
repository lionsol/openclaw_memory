#!/usr/bin/env node
/**
 * Memory Engine v1.1
 * Smart Add (file → reindex → confidence) + Hybrid Search + Confidence Management
 * Uses parallel memory_confidence table (chunks table is OpenClaw-owned).
 * 
 * Usage:
 *   node memory-engine.js add <text> [--category <cat>] [--protected]
 *   node memory-engine.js search <query> [--top-k <n>]
 *   node memory-engine.js update <partial-chunk-id> [--category <cat>] [--hit]
 *   node memory-engine.js archive
 *   node memory-engine.js status
 *   node memory-engine.js diagnose   — find chunks missing confidence entries
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const HOME = process.env.HOME || '/home/lionsol';
const WORKSPACE = HOME + '/.openclaw/workspace';
const DB_PATH = path.resolve(HOME, '.openclaw/memory/main.sqlite');
const SMART_ADD_DIR = 'memory/smart-add';

const CONFIG = {
  TAU_MAX: 365.0,
  BETA: 0.3,
  CONFLICT_PENALTY: 0.5,
  ARCHIVE_THRESHOLD: 0.15,
};

const CATEGORY_RULES = {
  temporary:       { conf: 0.40, tau: 2.0 },
  raw_log:         { conf: 0.50, tau: 7.0 },
  preference:      { conf: 0.70, tau: 30.0 },
  kg_node:         { conf: 0.85, tau: 90.0 },
  user_identity:   { conf: 0.95, tau: 365.0 },
};

function withDb(fn) {
  const db = new Database(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

function calculateTau(hits, baseTau) {
  if (hits < 0) hits = 0;  // clamp negative
  if (baseTau >= CONFIG.TAU_MAX) return baseTau;
  return baseTau + (CONFIG.TAU_MAX - baseTau) * (1 - Math.exp(-CONFIG.BETA * hits));
}

function getCategoryParams(category, isProtected) {
  if (isProtected || category === 'user_identity') return { conf: 0.95, tau: 365.0 };
  return CATEGORY_RULES[category] || CATEGORY_RULES.raw_log;
}

// === Smart Add: write file → reindex → insert confidence ===
function smartAdd(text, opts = {}) {
  const category = opts.category || 'raw_log';
  const isProtected = opts.isProtected || false;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const ts = now.toISOString().replace(/[:.]/g, '').slice(0, 15);
  const entryId = `${ts}_${category}`;
  const fileDir = path.join(WORKSPACE, SMART_ADD_DIR);
  const filePath = path.join(fileDir, `${dateStr}.md`);

  fs.mkdirSync(fileDir, { recursive: true });

  const header = !fs.existsSync(filePath)
    ? '# Smart Added Memory\n\n' : '';
  const entryText = text.trim();
  const entry = `${header}## ${entryId}\n\nCategory: ${category}${isProtected ? ' | Protected' : ''}\n\n${entryText}\n\n`;

  fs.appendFileSync(filePath, header ? entry : `\n${entry}`);

  console.log(JSON.stringify({
    action: 'add', status: 'file_written',
    file: `${SMART_ADD_DIR}/${dateStr}.md`, entry_id: entryId,
    category, is_protected: isProtected ? 1 : 0,
  }));

  // Reindex (without --force to preserve our table)
  try {
    execSync('openclaw memory index --agent main 2>&1', { encoding: 'utf-8', timeout: 120000 });
  } catch (e) {
    console.log(JSON.stringify({ action: 'add', status: 'reindex_warn', message: e.message }));
  }

  // Find newly indexed chunks for this file and add confidence entries
  const filePattern = `memory/smart-add/${dateStr}.md`;
  withDb(db => {
    const newChunks = db.prepare(`
      SELECT id FROM chunks
      WHERE path = ? AND id NOT IN (SELECT chunk_id FROM memory_confidence)
    `).all(filePattern);

    if (newChunks.length > 0) {
      const { conf, tau } = getCategoryParams(category, isProtected);
      const nowSec = Math.floor(Date.now() / 1000);
      const insert = db.prepare(`
        INSERT INTO memory_confidence
          (chunk_id, initial_confidence, confidence, last_confidence_update,
           base_tau, hit_count, is_archived, is_protected, conflict_flag, category)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?)
      `);
      const txn = db.transaction(ids => {
        for (const row of ids) {
          insert.run(row.id, conf, conf, nowSec, tau, isProtected ? 1 : 0, category);
        }
      });
      txn(newChunks);

      console.log(JSON.stringify({
        action: 'add', status: 'confidence_initialized',
        chunks: newChunks.length,
        category, confidence: conf, base_tau: tau,
      }));
    } else {
      console.log(JSON.stringify({
        action: 'add', status: 'no_new_chunks_found',
        expected_path: filePattern,
      }));
    }
  });
}

// === Update confidence: find by partial ID prefix ===
function updateChunk(partialId, opts = {}) {
  withDb(db => {
    // Resolve partial ID to full ID
    const rows = db.prepare(`
      SELECT chunk_id FROM memory_confidence
      WHERE chunk_id LIKE ? || '%'
      LIMIT 2
    `).all(partialId);

    if (rows.length === 0) {
      console.log(JSON.stringify({ action: 'update', error: 'no match', partial_id: partialId }));
      return;
    }
    if (rows.length > 1) {
      console.log(JSON.stringify({
        action: 'update', error: 'multiple matches',
        partial_id: partialId, matches: rows.map(r => r.chunk_id.slice(0, 16)),
      }));
      return;
    }

    const chunkId = rows[0].chunk_id;
    const now = Math.floor(Date.now() / 1000);
    const sets = ['last_confidence_update = ?'];
    const params = [now];

    if (opts.category) {
      const rule = CATEGORY_RULES[opts.category];
      if (rule) {
        sets.push('category = ?', 'initial_confidence = ?', 'confidence = ?', 'base_tau = ?');
        params.push(opts.category, rule.conf, rule.conf, rule.tau);
      }
    }
    if (opts.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(opts.confidence);
    }
    if (opts.hit) {
      sets.push('hit_count = hit_count + 1');
    }
    if (opts.protected !== undefined) {
      sets.push('is_protected = ?');
      params.push(opts.protected ? 1 : 0);
    }

    params.push(chunkId);
    const sql = `UPDATE memory_confidence SET ${sets.join(', ')} WHERE chunk_id = ?`;
    db.prepare(sql).run(...params);

    console.log(JSON.stringify({
      action: 'update',
      chunk_id: chunkId.slice(0, 16),
      updated_fields: sets.length,
    }));
  });
}

// === Hybrid Search (real vector similarity + confidence) ===
function hybridSearch(queryText, topK = 5) {
  // Get API key from config
  let apiKey = '';
  const configPath = path.resolve(HOME, '.openclaw/openclaw.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const providers = cfg.models?.providers || {};
    apiKey = providers.siliconflow?.apiKey
      || providers['siliconflow-embed']?.apiKey
      || '';
  } catch (e) {}

  // Embed query text via SiliconFlow
  let queryEmbedding = null;
  try {
    const resp = JSON.parse(execSync(
      `curl -s -X POST "https://api.siliconflow.cn/v1/embeddings" ` +
      `-H "Authorization: Bearer ${apiKey}" ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"model":"Qwen/Qwen3-Embedding-4B","input":${JSON.stringify(queryText)},"encoding_format":"float"}'`,
      { encoding: 'utf-8', timeout: 15000 }
    ));
    queryEmbedding = resp.data?.[0]?.embedding;
  } catch (e) {
    console.log(JSON.stringify({ action: 'search', error: 'embedding_failed', message: e.message }));
  }

  if (!queryEmbedding) {
    // Fallback: confidence-only sort
    withDb(db => {
      const now = Math.floor(Date.now() / 1000);
      const rows = db.prepare(`
        SELECT c.id, c.text, COALESCE(mc.confidence, 0.5) as confidence,
          mc.last_confidence_update, COALESCE(mc.base_tau, 7.0) as base_tau,
          COALESCE(mc.hit_count, 0) as hit_count, COALESCE(mc.is_protected, 0) as is_protected,
          COALESCE(mc.conflict_flag, 0) as conflict_flag, COALESCE(mc.category, 'raw_log') as category
        FROM chunks c LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
        WHERE COALESCE(mc.is_archived, 0) = 0
      `).all();
      const scored = rows.map(row => {
        const rtConf = row.is_protected ? row.confidence
          : calcRtConf(row, now, row.conflict_flag);
        return { id: row.id, text: row.text, category: row.category, confidence_realtime: Math.round(rtConf * 10000) / 10000, hit_count: row.hit_count, is_protected: row.is_protected, conflict_flag: row.conflict_flag };
      });
      scored.sort((a, b) => b.confidence_realtime - a.confidence_realtime);
      const top = scored.slice(0, topK);
      console.log(JSON.stringify({ action: 'search', diagnostics: { query: queryText, mode: 'confidence_only', pool_size: rows.length, returned: top.length, top_scores: top.map(r => ({ id: r.id.slice(0, 16), conf: r.confidence_realtime, hits: r.hit_count, cat: r.category, summary: r.text.slice(0, 60).replace(/\n/g, ' ') })) } }));
      console.log('---RESULTS---');
      top.forEach(r => console.log(JSON.stringify(r)));
    });
    return;
  }

  // Full hybrid search: cosine similarity + confidence decay
  const now = Math.floor(Date.now() / 1000);
  const alpha = 0.7;

  function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  withDb(db => {
    const rows = db.prepare(`
      SELECT c.id, c.text, c.embedding,
        COALESCE(mc.confidence, 0.5) as confidence,
        mc.last_confidence_update, COALESCE(mc.base_tau, 7.0) as base_tau,
        COALESCE(mc.hit_count, 0) as hit_count, COALESCE(mc.is_protected, 0) as is_protected,
        COALESCE(mc.conflict_flag, 0) as conflict_flag, COALESCE(mc.category, 'raw_log') as category
      FROM chunks c LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
      WHERE COALESCE(mc.is_archived, 0) = 0
    `).all();

    const scored = [];
    for (const row of rows) {
      try {
        const storedEmb = JSON.parse(row.embedding);
        if (!storedEmb || storedEmb.length < 100) continue;
        const similarity = cosineSim(queryEmbedding, storedEmb);
        if (similarity < 0.35) continue; // gate (Qwen3-Embedding-4B threshold)
        const rtConf = row.is_protected ? row.confidence : calcRtConf(row, now, row.conflict_flag);
        const finalScore = alpha * similarity + (1 - alpha) * rtConf;
        scored.push({
          id: row.id, text: row.text, category: row.category,
          similarity: Math.round(similarity * 10000) / 10000,
          confidence_realtime: Math.round(rtConf * 10000) / 10000,
          final_score: Math.round(finalScore * 10000) / 10000,
          hit_count: row.hit_count, is_protected: row.is_protected,
        });
      } catch (e) {}
    }

    scored.sort((a, b) => b.final_score - a.final_score);
    const top = scored.slice(0, topK);

    console.log(JSON.stringify({
      action: 'search',
      diagnostics: {
        query: queryText, mode: 'hybrid', alpha,
        pool_size: rows.length, gated: scored.length, returned: top.length,
        top_scores: top.map(r => ({
          id: r.id.slice(0, 16), sim: r.similarity, conf: r.confidence_realtime,
          score: r.final_score, hits: r.hit_count, cat: r.category,
          summary: r.text.slice(0, 60).replace(/\n/g, ' '),
        })),
      },
    }));
    console.log('---RESULTS---');
    top.forEach(r => console.log(JSON.stringify(r)));
  });
}

function calcRtConf(row, now, conflictFlag) {
  const deltaDays = row.last_confidence_update
    ? (now - row.last_confidence_update) / 86400 : 0;
  const tau = calculateTau(row.hit_count, row.base_tau);
  const decay = Math.exp(-deltaDays / tau);
  return Math.max(0, row.confidence * decay - (conflictFlag ? CONFIG.CONFLICT_PENALTY : 0));
}

// === Archive ===
function runArchive() {
  withDb(db => {
    const now = Math.floor(Date.now() / 1000);
    const threshold = CONFIG.ARCHIVE_THRESHOLD;

    const rows = db.prepare(`
      SELECT chunk_id, confidence, last_confidence_update, hit_count, base_tau, is_protected, category
      FROM memory_confidence
      WHERE is_archived = 0 AND is_protected = 0 AND category != 'user_identity'
    `).all();

    const toArchive = [];
    for (const row of rows) {
      if (!row.last_confidence_update) continue;
      const deltaDays = (now - row.last_confidence_update) / 86400;
      const tau = calculateTau(row.hit_count, row.base_tau);
      const realConf = row.confidence * Math.exp(-deltaDays / tau);
      if (realConf < threshold) toArchive.push(row.chunk_id);
    }

    if (toArchive.length > 0) {
      const placeholders = toArchive.map(() => '?').join(',');
      db.prepare(`UPDATE memory_confidence SET is_archived = 1 WHERE chunk_id IN (${placeholders})`).run(...toArchive);
    }

    console.log(JSON.stringify({ action: 'archive', archived: toArchive.length, threshold }));
  });
}

// === Diagnose chunks missing confidence ===
function diagnose() {
  withDb(db => {
    const missing = db.prepare(`
      SELECT c.id, c.path, substr(c.text, 1, 40) as excerpt
      FROM chunks c
      LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
      WHERE mc.chunk_id IS NULL
    `).all();

    const orphans = db.prepare(`
      SELECT mc.chunk_id, mc.category
      FROM memory_confidence mc
      LEFT JOIN chunks c ON mc.chunk_id = c.id
      WHERE c.id IS NULL
    `).all();

    console.log(JSON.stringify({
      action: 'diagnose',
      chunks_without_confidence: missing.length,
      orphans_without_chunks: orphans.length,
      missing_details: missing.map(m => ({
        id: m.id.slice(0, 16), path: m.path, excerpt: m.excerpt,
      })),
    }));
  });
}

// === Status ===
function showStatus() {
  withDb(db => {
    const totalChunks = db.prepare('SELECT COUNT(*) FROM chunks').get()['COUNT(*)'];
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(is_archived) as archived,
        SUM(is_protected) as protected,
        SUM(conflict_flag) as conflicted,
        ROUND(AVG(confidence), 4) as avg_confidence,
        ROUND(AVG(initial_confidence), 4) as avg_initial,
        ROUND(AVG(base_tau), 2) as avg_tau,
        ROUND(AVG(hit_count), 2) as avg_hits
      FROM memory_confidence
    `).get();

    const catStats = db.prepare(`
      SELECT category, COUNT(*) as count, ROUND(AVG(confidence), 4) as avg_conf
      FROM memory_confidence GROUP BY category ORDER BY count DESC
    `).all();

    const missing = db.prepare(`
      SELECT COUNT(*) as c FROM chunks c
      LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
      WHERE mc.chunk_id IS NULL
    `).get();

    console.log(JSON.stringify({
      action: 'status',
      chunks_total: totalChunks,
      confidence_tracked: stats.total,
      ...stats,
      chunks_missing_confidence: missing.c,
      by_category: catStats,
    }));
  });
}

// === CLI ===
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'add':
    if (!args[1]) { console.log('Usage: node memory-engine.js add <text> [--category <cat>] [--protected]'); process.exit(1); }
    smartAdd(args[1], {
      category: args.includes('--category') ? args[args.indexOf('--category') + 1] : undefined,
      isProtected: args.includes('--protected'),
    });
    break;

  case 'update':
    if (!args[1]) { console.log('Usage: node memory-engine.js update <partial-id> [--category <cat>] [--confidence <n>] [--tau <n>] [--hit] [--protected <0|1>]'); process.exit(1); }
    updateChunk(args[1], {
      category: args.includes('--category') ? args[args.indexOf('--category') + 1] : undefined,
      confidence: args.includes('--confidence') ? parseFloat(args[args.indexOf('--confidence') + 1]) : undefined,
      hit: args.includes('--hit'),
      protected: args.includes('--protected') ? parseInt(args[args.indexOf('--protected') + 1]) === 1 : undefined,
    });
    break;

  case 'search':
    if (!args[1]) { console.log('Usage: node memory-engine.js search <query> [--top-k <n>]'); process.exit(1); }
    hybridSearch(args[1], parseInt(args.includes('--top-k') ? args[args.indexOf('--top-k') + 1] : '5'));
    break;

  case 'archive':
    runArchive();
    break;

  case 'diagnose':
    diagnose();
    break;

  case 'status':
    showStatus();
    break;

  default:
    console.log('Usage:');
    console.log('  add <text> [--category <cat>] [--protected]     write file → index → confidence');
    console.log('  update <partial-id> [--category <cat>] [--hit]  update confidence fields');
    console.log('  search <query> [--top-k <n>]                     list by confidence');
    console.log('  archive                                           mark low-conf chunks');
    console.log('  diagnose                                          find untracked chunks');
    console.log('  status                                            show stats');
    process.exit(1);
}
