# Memory Engine v1.0

带置信度评分、时间衰减和引用强化的 OpenClaw 记忆系统。

## 架构

```
chunks (OpenClaw 所有)          memory_confidence (引擎所有)
├─ id (SHA-256)                 ├─ chunk_id → PK, FK to chunks.id
├─ text                         ├─ confidence / base_tau
├─ embedding (Qwen3-Embedding)  ├─ hit_count / category
└─ ...                          ├─ is_archived / is_protected
                                └─ conflict_flag / kg_data
```

详细架构：`docs/openclaw_memory_v1.md`

## 快速开始

```bash
# 1. 创建或更新 memory_confidence 表
sqlite3 ~/.openclaw/memory/main.sqlite < schemas.sql

# 2. 注册 OpenClaw 插件
openclaw plugins install ./plugins/memory-engine
openclaw gateway restart

# 3. 使用测试
node scripts/memory-engine.js add "用户偏好使用中文" --category preference
node scripts/memory-engine.js search "用户偏好" --top-k 5
```

## 文件结构

```
├── schemas.sql                    # memory_confidence 表定义
├── plugins/memory-engine/         # OpenClaw 插件 (推荐使用)
│   ├── index.js                   # 插件入口: memory_engine tool
│   ├── openclaw.plugin.json       # 插件清单
│   └── package.json
├── skills/memory-engine/          # Skill (备用)
│   ├── SKILL.md
│   └── scripts/memory-engine.js
├── scripts/
│   ├── memory-engine.js           # CLI 版
│   ├── memory-schema-v2.py        # Schema 迁移脚本 (Python)
│   └── memory-migration-v1.py     # 旧版迁移 (已废弃)
├── tests/
│   └── memory-engine.test.js      # 测试套件 (43 tests)
└── docs/
    └── openclaw_memory_v1.md      # 架构设计文档
```

## 命令速查

| 命令 | 功能 |
|------|------|
| `memory_engine add "..." --category preference` | 存记忆 (文件→索引→置信度) |
| `memory_engine search "..." --top-k 5` | 语义搜索 + 置信度排序 |
| `memory_engine cite --chunk_ids [...]` | 引用强化 (hit+1, conf+0.1) |
| `memory_engine status` | 统计审计 |
| `memory_engine archive` | 低置信度归档 |
| `memory_engine detect-conflicts` | 冲突检测 (fast/统计) |
| `memory_engine detect-conflicts --deep` | 冲突检测 (deep/LLM) |
| `memory_engine kg-bridge` | KG → 置信度桥接 |

## 分类参数

| Category | Init Confidence | Base τ (days) | Protected |
|----------|----------------|---------------|-----------|
| temporary | 0.40 | 2 | no |
| raw_log | 0.50 | 7 | no |
| preference | 0.70 | 30 | no |
| kg_node | 0.85 | 90 | yes |
| user_identity | 0.95 | 365 | yes |

## 测试

```bash
node tests/memory-engine.test.js          # 单元测试
node tests/memory-engine.test.js --integration  # + 集成测试
```

## 版本

- v1.0.2 — detect-conflicts 双模式 + LLM 语义检测
- v1.0.1 — CLI search 真实向量相似度 + 测试套件
- v1.0.0 — 初始发布
