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
  episodic:        { conf: 0.70, tau: 30.0 },  // 情节摘要
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
  const kgData = opts.kgData || null;
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
  const kgMeta = kgData ? `kg_data: ${JSON.stringify(kgData)}\n` : '';
  const entry = `${header}## ${entryId}\n\nCategory: ${category}${isProtected ? ' | Protected' : ''}\n${kgMeta}\n${entryText}\n\n`;

  fs.appendFileSync(filePath, header ? entry : `\n${entry}`);

  console.log(JSON.stringify({
    action: 'add', status: 'file_written',
    file: `${SMART_ADD_DIR}/${dateStr}.md`, entry_id: entryId,
    category, is_protected: isProtected ? 1 : 0,
    has_kg_data: kgData ? true : false,
  }));

  // Reindex
  try {
    execSync('openclaw memory index --agent main 2>&1', { encoding: 'utf-8', timeout: 120000 });
  } catch (e) {
    console.log(JSON.stringify({ action: 'add', status: 'reindex_warn', message: e.message }));
  }

  // Find newly indexed chunks and add confidence entries
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
           base_tau, hit_count, is_archived, is_protected, conflict_flag, category, kg_data)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)
      `);
      const txn = db.transaction(ids => {
        for (const row of ids) {
          insert.run(row.id, conf, conf, nowSec, tau, isProtected ? 1 : 0, category,
            kgData ? JSON.stringify(kgData) : null);
        }
      });
      txn(newChunks);

      console.log(JSON.stringify({
        action: 'add', status: 'confidence_initialized',
        chunks: newChunks.length,
        category, confidence: conf, base_tau: tau,
        has_kg_data: kgData ? true : false,
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

// === FTS5 Search — 精准命中专有名词/代码/API名称 ===
function ftsSearch(queryText, limit = 20) {
  // 清理查询：FTS5 特殊字符转义
  const safeQuery = queryText.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safeQuery) return [];

  return withDb(db => {
    const rows = db.prepare(`
      SELECT c.id, c.text, rank as bm25_score,
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
      LIMIT ?
    `).all(safeQuery, limit);
    return rows;
  });
}

// === RRF Fusion — 等权融合多通道排序结果 ===
// 对每个候选：RRF(d) = Σ 1/(k + rᵢ(d))
// k=60 是标准值，rᵢ(d) 是 d 在第 i 个通道的排位（0-based → 1-based）
// 支持 padded 通道：短通道未覆盖的候选视为 rank = padRank
function rrfFuse(channels, k = 60) {
  const allIds = new Set();
  const padInfo = {}; // channel → {padded, padRank}

  for (const [chName, rankedItems] of Object.entries(channels)) {
    // 检查是否标记为 padded
    const isPadded = rankedItems.__padded === true;
    const padRank = rankedItems.__padRank || (k + 100);
    padInfo[chName] = { padded: isPadded, padRank };

    // 收集所有出现的 ID
    const effectiveItems = Array.isArray(rankedItems) ? rankedItems : [];
    for (const item of effectiveItems) {
      if (item && item.id) allIds.add(item.id);
    }
  }

  // 构建融合结果
  const fusion = new Map();

  for (const [chName, rankedItems] of Object.entries(channels)) {
    // 跳过元属性
    if (chName.startsWith('__')) continue;

    const effectiveItems = Array.isArray(rankedItems) ? rankedItems : [];
    const { padded, padRank } = padInfo[chName];

    // 处理本通道实际返回的条目
    effectiveItems.forEach((item, idx) => {
      if (!item || !item.id) return;
      const exist = fusion.get(item.id) || {
        id: item.id,
        text: item.text,
        category: item.category,
        hit_count: item.hit_count,
        is_protected: item.is_protected,
        conflict_flag: item.conflict_flag,
        confidence_realtime: item.confidence_realtime || 0,
        similarity: item.similarity || 0,
        sources: [],
        ranks: {},
        rrfScore: 0,
      };
      exist.sources.push(chName);
      exist.ranks[chName] = idx + 1;
      let acc = 0;
      for (const ch of Object.keys(exist.ranks)) {
        acc += 1 / (k + exist.ranks[ch]);
      }
      // 对 padded 通道中未出现但仍计入的候选
      for (const [pch, info] of Object.entries(padInfo)) {
        if (pch.startsWith('__')) continue;
        if (!exist.ranks[pch] && info.padded) {
          exist.ranks[pch] = info.padRank;
          exist.sources.push(pch + '(pad)');
          acc += 1 / (k + info.padRank);
        }
      }
      exist.rrfScore = Math.round(acc * 10000) / 10000;
      fusion.set(item.id, exist);
    });
  }

  const results = Array.from(fusion.values());
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}

// === RRF 通道 padding — 短通道结果不足时排除孤例膨胀 ===
// 某个通道返回远少于其他通道时，RRF 对该通道低排位候选贡献异常放大
// 策略：通道结果 < padMin 时，对未覆盖的候选视为 rank = k + padOffset
function rrfPad(channels, k = 60, padMin = 5, padOffset = 100) {
  // 找出需要 padding 的通道
  const channelNames = Object.keys(channels);
  for (const name of channelNames) {
    if (channels[name].length < padMin) {
      // 该通道结果太少 → 其他通道有但此通道没有的候选，排名视为 k+padOffset
      // 此函数在融合前调用，标记通道为 "padded"
      channels[name].__padded = true;
      channels[name].__padRank = k + padOffset;
    }
  }
  return channels;
}

// === KG 召回桥 — 知识图谱概念 → chunks 映射 ===
// 直接加载 KG 模块，无需 execSync
function kgRecall(queryText, limit = 15) {
  const KG_PATH = path.resolve(WORKSPACE, 'knowledge-graph.json');
  const KG_MODULE = path.resolve(WORKSPACE, 'skills/jpeng-knowledge-graph-memory');
  if (!fs.existsSync(KG_PATH) || !fs.existsSync(path.join(KG_MODULE, 'index.js'))) return [];

  try {
    // 直接加载 KG 模块并搜索
    const { KnowledgeGraph } = require(KG_MODULE);
    const data = JSON.parse(fs.readFileSync(KG_PATH, 'utf-8'));
    const kg = KnowledgeGraph.fromJSON(data);
    const concepts = kg.search({ name: queryText });

    if (!Array.isArray(concepts) || concepts.length === 0) return [];

    // 提取概念名列表
    const conceptNames = concepts.map(c => c.name).filter(Boolean);
    if (conceptNames.length === 0) return [];

    // 用 FTS5 搜索这些概念名在 chunks 中的匹配
    const now = Math.floor(Date.now() / 1000);
    return withDb(db => {
      const seen = new Set();
      const results = [];

      for (const name of conceptNames) {
        // 每个概念名搜索 chunks_fts，取 top 3
        const safeName = name.replace(/[^\w\s]/g, ' ').trim();
        if (!safeName || safeName.length < 2) continue;

        const rows = db.prepare(`
          SELECT DISTINCT c.id, c.text, c.embedding,
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
          LIMIT 3
        `).all(safeName);

        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          const rtConf = row.is_protected ? row.confidence
            : calcRtConf(row, now, row.conflict_flag);
          results.push({
            id: row.id, text: row.text, category: row.category,
            similarity: 0.5,  // 保守分
            confidence_realtime: Math.round(rtConf * 10000) / 10000,
            hit_count: row.hit_count,
            is_protected: row.is_protected,
            conflict_flag: row.conflict_flag,
            kg_concepts: conceptNames,
          });
        }

        if (results.length >= limit) break;
      }

      return results.slice(0, limit);
    });
  } catch (e) {
    return [];
  }
}

// === 向量搜索（内部）— cosine similarity + confidence decay ===
function vectorSearch(queryEmbedding, now, db, topK = 30) {
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
      if (similarity < 0.35) continue; // gate
      const rtConf = row.is_protected ? row.confidence : calcRtConf(row, now, row.conflict_flag);
      const finalScore = alpha * similarity + (1 - alpha) * rtConf;
      scored.push({
        id: row.id, text: row.text, category: row.category,
        similarity: Math.round(similarity * 10000) / 10000,
        confidence_realtime: Math.round(rtConf * 10000) / 10000,
        final_score: Math.round(finalScore * 10000) / 10000,
        hit_count: row.hit_count,
        is_protected: row.is_protected,
        conflict_flag: row.conflict_flag,
      });
    } catch (e) {}
  }
  scored.sort((a, b) => b.final_score - a.final_score);
  return scored.slice(0, topK);
}

// === 多通道并行混合搜索（向量 + FTS5），RRF 融合 ===
function hybridSearch(queryText, topK = 5) {
  const vectorLimit = 30;  // 向量池：30 个候选
  const ftsLimit = 20;     // FTS5 池：20 个候选
  const rrfK = 60;         // RRF 常数

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

  // Embed query text
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

  const now = Math.floor(Date.now() / 1000);

  const channels = {};
  const FUSION_METHOD = Object.keys(channels).length >= 3 ? 'rrf' : (Object.keys(channels).length === 2 ? 'rrf' : 'pass');

  // 通道 1：向量搜索（含 confidence decay）
  if (queryEmbedding) {
    const vecResults = withDb(db => vectorSearch(queryEmbedding, now, db, vectorLimit));
    if (vecResults.length > 0) channels.vector = vecResults;
  }

  // 通道 2：FTS5 全文搜索
  const ftsResults = ftsSearch(queryText, ftsLimit);
  if (ftsResults.length > 0) {
    // 归一化 BM25 分数：1/(1+|score|)，将 [-inf, 0] 映射到 (0, 1]
    const maxAbsBm25 = Math.max(...ftsResults.map(r => Math.abs(r.bm25_score || 0)), 0.001);
    channels.fts = ftsResults.map(row => ({
      id: row.id, text: row.text, category: row.category,
      similarity: Math.round((1 / (1 + Math.abs(row.bm25_score || 0))) * 10000) / 10000,
      confidence_realtime: row.is_protected ? row.confidence
        : Math.round(calcRtConf(row, now, row.conflict_flag) * 10000) / 10000,
      hit_count: row.hit_count,
      is_protected: row.is_protected,
      conflict_flag: row.conflict_flag,
    }));
  }

  // 通道 3：KG 图谱召回桥
  const kgResults = kgRecall(queryText, 15);
  if (kgResults.length > 0) {
    channels.kg = kgResults;
  }

  const channelCount = Object.keys(channels).length;

  // 无通道
  if (channelCount === 0) {
    console.log(JSON.stringify({ action: 'search', diagnostics: { query: queryText, mode: 'empty', pool_size: 0 } }));
    console.log('---RESULTS---');
    return;
  }

  // 单通道：直接输出
  if (channelCount === 1) {
    const single = Object.values(channels)[0];
    const top = single.slice(0, topK);
    const channelName = Object.keys(channels)[0];
    console.log(JSON.stringify({
      action: 'search',
      diagnostics: {
        query: queryText, mode: channelName + '_only',
        pool_size: single.length, returned: top.length,
        top_scores: top.map(r => ({
          id: r.id.slice(0, 16),
          sim: r.similarity,
          conf: r.confidence_realtime,
          score: r.final_score || r.confidence_realtime,
          hits: r.hit_count,
          cat: r.category,
          summary: (r.text || '').slice(0, 60).replace(/\n/g, ' '),
        })),
      },
    }));
    console.log('---RESULTS---');
    top.forEach(r => console.log(JSON.stringify({ id: r.id, text: r.text, category: r.category, confidence_realtime: r.confidence_realtime, hit_count: r.hit_count, is_protected: r.is_protected, conflict_flag: r.conflict_flag })));
    return;
  }

  // ≥2 通道：RRF 融合
  const fusionMode = channelCount >= 3 ? 'rrf_multi' : 'rrf_dual';
  // RRF padding + fusion
  rrfPad(channels, rrfK);
  let fused = rrfFuse(channels, rrfK);

  // 时间意向检测 → episode 加权
  const episodeBoost = hasTimeIntent(queryText) ? 0.1 : 0;
  if (episodeBoost > 0) {
    for (const item of fused) {
      if (item.category === 'episodic') {
        item.rrfScore += episodeBoost;
      }
    }
    // 重新排序
    fused.sort((a, b) => b.rrfScore - a.rrfScore);
  }

  const top = fused.slice(0, topK);

  console.log(JSON.stringify({
    action: 'search',
    diagnostics: {
      query: queryText,
      mode: fusionMode,
      fusion: 'rrf',
      episode_boost: episodeBoost > 0,
      channels: Object.keys(channels),
      channel_sizes: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.length])),
      pool_size: fused.length,
      returned: top.length,
      top_scores: top.map(r => ({
        id: r.id.slice(0, 16),
        rrf: r.rrfScore,
        sources: r.sources,
        sim: r.similarity,
        conf: r.confidence_realtime,
        hits: r.hit_count,
        cat: r.category,
        summary: (r.text || '').slice(0, 60).replace(/\n/g, ' '),
      })),
    },
  }));
  console.log('---RESULTS---');
  top.forEach(r => console.log(JSON.stringify({
    id: r.id,
    text: r.text,
    category: r.category,
    similarity: r.similarity,
    confidence_realtime: r.confidence_realtime,
    rrf_score: r.rrfScore,
    sources: r.sources,
    hit_count: r.hit_count,
    is_protected: r.is_protected,
    conflict_flag: r.conflict_flag,
  })));
}

// === 情节摘要生成 — 汇聚时间段内的 raw_log 为摘要 ===
function generateEpisode(startTimestamp, endTimestamp) {
  console.log(JSON.stringify({
    action: 'summarize', status: 'start',
    start: new Date(startTimestamp * 1000).toISOString(),
    end: new Date(endTimestamp * 1000).toISOString(),
  }));

  const llmApiKey = getApiKey();
  if (!llmApiKey) {
    // 无 API Key 也生成伪摘要，供 Agent 后续手动填充
    console.log(JSON.stringify({ action: 'summarize', status: 'no_llm', fallback: true }));
  }

  withDb(db => {
    // 获取 raw_log chunks（不限路径，取所有未被归档的）
    const logs = db.prepare(`
      SELECT c.id, c.text
      FROM chunks c
      JOIN memory_confidence mc ON c.id = mc.chunk_id
      WHERE mc.category = 'raw_log'
        AND mc.is_archived = 0
      ORDER BY c.path, c.start_line
    `).all();

    if (logs.length === 0) {
      console.log(JSON.stringify({ action: 'summarize', status: 'no_logs' }));
      return;
    }

    const chunkIds = logs.map(l => l.id);
    const combined = logs.map(l => l.text).join('\n---\n').slice(0, 8000);

    // 调用 LLM 生成摘要
    let summary = '';
    if (llmApiKey) {
      try {
                // 用临时文件避免 shell 转义问题
        const payload = JSON.stringify({
          model: 'deepseek-ai/DeepSeek-V4-Flash',
          messages: [{ role: 'user', content: combined.slice(0, 6000) }],
          max_tokens: 512,
        });
        const tmpFile = '/tmp/memory-episode-' + Date.now() + '.json';
        fs.writeFileSync(tmpFile, payload, 'utf-8');

        const resp = JSON.parse(execSync(
          'curl -s -X POST "https://api.siliconflow.cn/v1/chat/completions" ' +
          '-H "Authorization: Bearer ' + llmApiKey + '" ' +
          '-H "Content-Type: application/json" ' +
          '-d @' + tmpFile,
          { encoding: 'utf-8', timeout: 30000 }
        ));
        fs.unlinkSync(tmpFile);
        summary = (resp.choices?.[0]?.message?.content || '').trim();
      } catch (e) {
        console.log(JSON.stringify({ action: 'summarize', status: 'llm_error', message: e.message }));
      }
    }

    if (!summary) {
      // 无 LLM 或失败时，生成关键词摘要
      const words = combined.split(/[\s,，。.\n]+/).filter(w => w.length >= 2);
      const freq = {};
      words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(e => e[0]);
      summary = `[关键词摘要] ${top.slice(0, 10).join('、')}`;
    }

    // 写入摘要到记忆库（category = episodic）
    smartAdd(summary, {
      category: 'episodic',
      kgData: { episode_of: chunkIds },
    });

    console.log(JSON.stringify({
      action: 'summarize', status: 'done',
      source_chunks: chunkIds.length,
      summary_length: summary.length,
      summary_preview: summary.slice(0, 100),
    }));
  });
}

// === 情节下钻 — 通过摘要 chunk_id 获取原文 chunks ===
function drillDown(chunkId, topK = 20) {
  withDb(db => {
    // 支持部分 ID 前缀匹配
    const rows = db.prepare(`
      SELECT chunk_id, kg_data, category FROM memory_confidence
      WHERE chunk_id LIKE ?
      LIMIT 2
    `).all(chunkId + '%');

    if (rows.length === 0) {
      console.log(JSON.stringify({ action: 'drill', status: 'no_match', chunk_id: chunkId.slice(0, 16) }));
      return;
    }
    if (rows.length > 1) {
      console.log(JSON.stringify({ action: 'drill', status: 'multiple_matches', chunk_id: chunkId.slice(0, 16), matches: rows.length }));
      return;
    }

    const row = rows[0];
    if (!row.kg_data) {
      console.log(JSON.stringify({ action: 'drill', status: 'no_kg_data', chunk_id: chunkId.slice(0, 16) }));
      return;
    }

    let kgData;
    try { kgData = JSON.parse(row.kg_data); } catch (e) {
      console.log(JSON.stringify({ action: 'drill', status: 'invalid_kg_data' }));
      return;
    }

    const sourceIds = kgData.episode_of;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      console.log(JSON.stringify({ action: 'drill', status: 'no_source_ids' }));
      return;
    }

    // 批量获取原文
    const placeholders = sourceIds.map(() => '?').join(',');
    const chunks = db.prepare(`
      SELECT c.id, c.text,
        COALESCE(mc.category, 'raw_log') as category,
        COALESCE(mc.hit_count, 0) as hit_count
      FROM chunks c
      LEFT JOIN memory_confidence mc ON c.id = mc.chunk_id
      WHERE c.id IN (${placeholders})
      ORDER BY c.path, c.start_line
      LIMIT ?
    `).all(...sourceIds, topK);

    console.log(JSON.stringify({
      action: 'drill',
      chunk_id: chunkId.slice(0, 16),
      category: row.category,
      source_count: sourceIds.length,
      returned: chunks.length,
    }));
    console.log('---DETAILS---');
    chunks.forEach(c => console.log(JSON.stringify({
      id: c.id.slice(0, 16),
      text: c.text.slice(0, 300),
      category: c.category,
      hit_count: c.hit_count,
    })));
  });
}

// === 时间意向检测 — 用于 episode 加权 ===
const TIME_KEYWORDS = /\b(上次|昨天|上周|之前|回顾|总结|做了什么|发生了什么|才做的|回顾一下|摘要|总结一下|当天|前一天|前几天|前些天|之前几天)\b/;

function hasTimeIntent(query) {
  return TIME_KEYWORDS.test(query);
}

function getApiKey() {
  const configPath = path.resolve(HOME, '.openclaw/openclaw.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const providers = cfg.models?.providers || {};
    return providers.siliconflow?.apiKey || providers['siliconflow-embed']?.apiKey || '';
  } catch (e) { return ''; }
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

  case 'summarize':
    // 生成最近24小时的情节摘要
    const now = Math.floor(Date.now() / 1000);
    const windowHours = args.includes('--hours') ? parseInt(args[args.indexOf('--hours') + 1]) : 24;
    generateEpisode(now - windowHours * 3600, now);
    break;

  case 'drill':
    if (!args[1]) { console.log('Usage: node memory-engine.js drill <chunk-id> [--top-k <n>]'); process.exit(1); }
    drillDown(args[1], parseInt(args.includes('--top-k') ? args[args.indexOf('--top-k') + 1] : '20'));
    break;

  default:
    console.log('Usage:');
    console.log('  add <text> [--category <cat>] [--protected]     write file → index → confidence');
    console.log('  update <partial-id> [--category <cat>] [--hit]  update confidence fields');
    console.log('  search <query> [--top-k <n>]                     multi-channel RRF search');
    console.log('  archive                                           mark low-conf chunks');
    console.log('  diagnose                                          find untracked chunks');
    console.log('  status                                            show stats');
    console.log('  summarize [--hours <n>]                           generate episodic summary');
    console.log('  drill <chunk-id> [--top-k <n>]                    drill down into episode details');
    process.exit(1);
}
