#!/usr/bin/env node
/**
 * session-checkpoint.js — 每日 Session 结束前的强制检查点
 *
 * 运行方式：cron 每日 03:55（系统切 session 前）
 * 功能：
 *   1. 检查今天的 raw_log，提取潜在配置信息
 *   2. 未识别的配置自动写入 preference 记忆
 *   3. 生成今日摘要（episode），供新 session 注入
 */

const https = require("node:https");
const { homedir } = require("node:os");
const { resolve } = require("node:path");
const { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const Database = require("better-sqlite3");
const zlib = require("node:zlib");

// Paths
const HOME = homedir();
const DB_PATH = resolve(HOME, ".openclaw/memory/main.sqlite");
const WORKSPACE = resolve(HOME, ".openclaw/workspace");
const SMART_ADD_DIR = "memory/smart-add";
const CONFIG_JSON = resolve(HOME, ".openclaw/openclaw.json");
const EPISODES_DIR = "memory/episodes";

// Config cache
let config = null;
function getConfig() {
  if (!config) config = JSON.parse(readFileSync(CONFIG_JSON, "utf-8"));
  return config;
}

function getSFKey() {
  try {
    return getConfig().models?.providers?.siliconflow?.apiKey || "";
  } catch (e) {
    return "";
  }
}

function getSFBaseUrl() {
  try {
    return getConfig().models?.providers?.siliconflow?.baseUrl || "https://api.siliconflow.cn/v1";
  } catch (e) {
    return "https://api.siliconflow.cn/v1";
  }
}

// ── DB helpers ──

function withDb(fn) {
  const db = new Database(DB_PATH, { readonly: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── LLM call via SiliconFlow ──

function llmComplete(prompt, systemPrompt, options = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = getSFKey();
    if (!apiKey) return reject(new Error("SiliconFlow API key not found"));

    const baseUrl = getSFBaseUrl();
    const url = new URL("/chat/completions", baseUrl);
    const model = options.model || "deepseek-ai/DeepSeek-V4-Flash";
    const temperature = options.temperature ?? 0.1;
    const maxTokens = options.maxTokens ?? 1024;

    const body = JSON.stringify({
      model,
      messages: [
        ...(systemPrompt
          ? [{ role: "system", content: systemPrompt }]
          : []),
        { role: "user", content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false,
    });

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = "";
        const isGzip = res.headers["content-encoding"] === "gzip";
        const stream = isGzip ? res.pipe(zlib.createGunzip()) : res;
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            resolve(parsed.choices?.[0]?.message?.content || "");
          } catch (e) {
            reject(new Error(`Parse failed: ${e.message}\nRaw: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Read today's raw content ──

function readTodayRawLogs() {
  const today = todayDateStr();
  const logs = [];

  // Source 1: smart-add file
  const smartAddPath = resolve(WORKSPACE, SMART_ADD_DIR, `${today}.md`);
  if (existsSync(smartAddPath)) {
    const content = readFileSync(smartAddPath, "utf-8");
    // Parse entries: ## timestamp_category\n\nCategory: xxx\n\ntext
    const entries = content.split(/\n## /);
    for (const entry of entries) {
      const catMatch = entry.match(/Category:\s*(\S+)/);
      const textMatch = entry.split(/\n\n/).slice(1).join("\n\n").trim();
      if (catMatch && textMatch) {
        logs.push({ category: catMatch[1], text: textMatch });
      }
    }
  }

  // Source 2: raw_log from confidence DB
  try {
    withDb((db) => {
      const todayMs = new Date();
      todayMs.setHours(0, 0, 0, 0);
      const startOfDay = todayMs.getTime();

      const rows = db
        .prepare(
          `SELECT c.text, mc.category
           FROM chunks c
           JOIN memory_confidence mc ON c.id = mc.chunk_id
           WHERE mc.category = 'raw_log'
           ORDER BY c.updated_at DESC
           LIMIT 100`
        )
        .all();

      for (const row of rows) {
        logs.push({ category: "raw_log", text: row.text });
      }
    });
  } catch (e) {
    console.error("[checkpoint] DB read warning:", e.message);
  }

  return logs;
}

// ── Extract configs via LLM ──

async function extractConfigs(rawLogs) {
  if (rawLogs.length === 0) {
    console.log("[checkpoint] No raw logs found today.");
    return [];
  }

  const combined = rawLogs
    .filter((l) => l.text && l.text.trim())
    .map((l) => l.text.trim())
    .slice(0, 20) // keep it manageable
    .join("\n---\n");

  if (!combined.trim()) return [];

  const systemPrompt = [
    "你是一个配置信息提取助手。从以下对话/日志中提取所有可能的重要配置信息。",
    "配置信息包括但不限于：API key、文件路径、模型参数、工具选择、声音/语言设置、用户偏好等。",
    "如果没有发现任何配置信息，直接返回空数组 []。",
    "",
    "返回严格合法的 JSON 数组，格式：",
    '[{"key": "配置项名称", "value": "配置值", "context": "简短来源说明"}]',
    "",
    "注意：",
    "- key 用英文，简短描述",
    "- value 用实际值（敏感内容可模糊化）",
    "- context 用中文说明来源",
    "- 最多返回 10 条",
  ].join("\n");

  console.log(`[checkpoint] Sending ${combined.length} chars to LLM for config extraction...`);

  try {
    const result = await llmComplete(combined, systemPrompt, {
      temperature: 0.1,
      maxTokens: 2048,
    });

    // Parse JSON from response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[checkpoint] LLM response didn't contain JSON array:", result.slice(0, 200));
      return [];
    }

    const configs = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(configs)) return [];
    console.log(`[checkpoint] Extracted ${configs.length} config(s)`);
    return configs.slice(0, 10);
  } catch (e) {
    console.error("[checkpoint] LLM extraction failed:", e.message);
    return [];
  }
}

// ── Write configs as preference memories ──

function writeConfigMemories(configs) {
  if (configs.length === 0) {
    console.log("[checkpoint] No configs to write.");
    return 0;
  }

  const today = todayDateStr();
  const fileDir = resolve(WORKSPACE, SMART_ADD_DIR);
  const filePath = resolve(fileDir, `${today}.md`);
  mkdirSync(fileDir, { recursive: true });

  const entries = [];
  let written = 0;

  for (const cfg of configs) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "").slice(0, 15);
    const entryId = `${ts}_preference_checkpoint`;
    const text = `配置：${cfg.key} = ${cfg.value}（来源：${cfg.context}）`;
    entries.push(`## ${entryId}\n\nCategory: preference\n\n${text.trim()}`);
    written++;

    try {
      writeConfidence(entryId, text.trim(), "preference");
    } catch (e) {
      console.error(`[checkpoint] DB write failed for ${entryId}:`, e.message);
    }
  }

  if (entries.length > 0) {
    const header = !existsSync(filePath) ? "# Smart Added Memory\n\n" : "\n";
    const entryBlock = header + entries.join("\n\n");
    appendFileSync(filePath, entryBlock);
  }

  console.log(`[checkpoint] Wrote ${written} config(s) to smart-add.`);
  return written;
}

function writeConfidence(entryId, text, category) {
  withDb((db) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const catParams = {
      preference: { conf: 0.8, tau: 90.0 },
      episodic: { conf: 0.7, tau: 30.0 },
    };
    const params = catParams[category] || { conf: 0.5, tau: 7.0 };
    console.log(`[checkpoint] Confidence metadata ready: ${category} conf=${params.conf} tau=${params.tau}`);
  });
}

// ── 配置冲突自动标记 ──

function extractConfigKey(text) {
  // 匹配 "配置：<key> = <value>（来源：...）"
  const match = text.match(/配置[：:]\s*(\S[^=\n]*?)\s*[=:=]\s*\S/);
  if (match) return match[1].trim().toLowerCase();
  // 回退：匹配 "<key> = <value>" 或 "<key>: <value>"
  const fallback = text.match(/^\s*(\S[\w\-\/]+)\s*[=:=]\s*\S/);
  if (fallback) return fallback[1].trim().toLowerCase();
  return null;
}

function resolveConfigConflicts() {
  console.log("[checkpoint] Resolving config conflicts...");
  let flagged = 0;

  withDb((db) => {
    // 读取所有 preference 和非 archived 的条目
    const rows = db.prepare([
      "SELECT mc.chunk_id, c.text, mc.last_confidence_update, mc.conflict_flag",
      "FROM memory_confidence mc",
      "JOIN chunks c ON c.id = mc.chunk_id",
      "WHERE mc.category = 'preference'",
      "AND mc.is_archived = 0",
      "ORDER BY mc.last_confidence_update DESC",
    ].join(" ")).all();

    // 按配置 key 分组
    const groups = {};
    for (const row of rows) {
      const key = extractConfigKey(row.text || "");
      if (!key) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push({
        chunk_id: row.chunk_id,
        text: (row.text || "").slice(0, 80),
        updated: row.last_confidence_update || 0,
        already_flagged: row.conflict_flag === 1,
      });
    }

    const updateStmt = db.prepare("UPDATE memory_confidence SET conflict_flag = 1 WHERE chunk_id = ?");
    const unflagStmt = db.prepare("UPDATE memory_confidence SET conflict_flag = 0 WHERE chunk_id = ?");

    for (const [key, entries] of Object.entries(groups)) {
      if (entries.length <= 1) {
        // 只有一条，确保没有误标记
        if (entries[0].already_flagged) {
          unflagStmt.run(entries[0].chunk_id);
          console.log(`  ↳ 解除冲突标记: ${key}（唯一条目）`);
        }
        continue;
      }

      // 按更新时间降序排列，第一条是最新的
      entries.sort((a, b) => b.updated - a.updated);
      const newest = entries[0];

      // 如果最新条目已被标记冲突，先解除
      if (newest.already_flagged) {
        unflagStmt.run(newest.chunk_id);
        console.log(`  ↳ 解除最新条目冲突标记: ${key}`);
      }

      // 标记所有旧条目
      for (let i = 1; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.already_flagged) {
          updateStmt.run(entry.chunk_id);
          flagged++;
          console.log(`  ⚠️  冲突标记: ${key} | 旧: ${entry.text.slice(0, 50)} | 新: ${newest.text.slice(0, 50)}`);
        }
      }
    }
  });

  console.log(`[checkpoint] Config conflict resolution: ${flagged} conflict(s) flagged`);
  return flagged;
}

// ── Generate today's episode ──

async function generateEpisode(rawLogs, configsExtracted) {
  const today = todayDateStr();

  if (rawLogs.length === 0 && configsExtracted.length === 0) {
    console.log("[checkpoint] No content for episode generation.");
    return;
  }

  // Build a compact summary of what happened today
  const summaryLines = [];

  if (configsExtracted.length > 0) {
    summaryLines.push("### 配置记忆");
    for (const c of configsExtracted) {
      summaryLines.push(`- ${c.key} = ${c.value}（${c.context}）`);
    }
  }

  // Extract key aspects from raw logs
  const sampleTexts = rawLogs
    .map((l) => l.text?.trim())
    .filter(Boolean)
    .slice(0, 15)
    .join("\n");

  let summary = "";
  if (sampleTexts) {
    const sysPrompt = [
      "你是一个每日摘要生成助手。从以下今天的对话/日志中，生成一段简洁的英文/中文摘要（50-100字）。",
      "摘要应涵盖：主要话题、重要决策、新增配置、值得记住的偏好。",
      "如果不确定不要编造，写你确定看到的内容。",
    ].join("\n");

    console.log("[checkpoint] Generating episode summary...");
    try {
      summary = await llmComplete(
        `今天（${today}）的日志内容：\n\n${sampleTexts}`,
        sysPrompt,
        { temperature: 0.3, maxTokens: 512 }
      );
    } catch (e) {
      console.warn("[checkpoint] Episode generation failed:", e.message);
      summary = "（摘要生成失败）";
    }
  }

  // Write episode file
  const episodeDir = resolve(WORKSPACE, EPISODES_DIR);
  const episodePath = resolve(episodeDir, `${today}.md`);
  mkdirSync(episodeDir, { recursive: true });

  // Also update the daily memory file
  const dailyDir = resolve(WORKSPACE, "memory");
  const dailyPath = resolve(dailyDir, `${today}.md`);
  mkdirSync(dailyDir, { recursive: true });

  const episodeContent = [
    `# Episode: ${today}`,
    "",
    summary,
    "",
    summaryLines.join("\n"),
    "",
    "---",
    `_Generated at ${new Date().toISOString()}_`,
    "",
  ].join("\n");

  writeFileSync(episodePath, episodeContent);

  // Append to daily memory file
  if (!existsSync(dailyPath)) {
    writeFileSync(
      dailyPath,
      [
        `# ${today}`,
        "",
        summary.trim() ? summary : "（无今日摘要）",
        "",
        summaryLines.length > 0 ? summaryLines.join("\n") : "",
        "",
        "---",
        "",
      ].join("\n")
    );
  } else {
    // If daily file exists, check if it already has an episode section
    const existing = readFileSync(dailyPath, "utf-8");
    if (!existing.includes("## Episode")) {
      appendFileSync(
        dailyPath,
        [
          "",
          "## Episode",
          "",
          summary.trim() ? summary : "（无今日摘要）",
          "",
          summaryLines.length > 0 ? summaryLines.join("\n") : "",
          "",
        ].join("\n")
      );
    }
  }

  console.log(`[checkpoint] Episode written to ${episodePath}`);
}

// ── Main ──

async function main() {
  const start = Date.now();
  console.log(`[checkpoint] === Session Checkpoint ${todayDateStr()} ===`);

  try {
    // Step 1: Gather raw logs
    const rawLogs = readTodayRawLogs();
    console.log(`[checkpoint] Found ${rawLogs.length} raw log entries`);

    // Step 2: Extract configs
    const configs = await extractConfigs(rawLogs);

    // Step 3: Write config memories
    const written = writeConfigMemories(configs);

    // Step 4: Generate episode
    await generateEpisode(rawLogs, configs);

    // Step 5: Resolve config conflicts (标记同一配置键的旧条目)
    const conflicts = resolveConfigConflicts();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[checkpoint] ✅ Completed in ${elapsed}s — ${configs.length} configs, ${written} written, ${conflicts} conflicts flagged`);
  } catch (e) {
    console.error("[checkpoint] ❌ Failed:", e.message);
    process.exit(1);
  }
}

main();
