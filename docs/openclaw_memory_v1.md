

# OpenClaw 记忆系统 v1.2 架构与开发文档 (SQLite 增强版)

## 1. 架构核心哲学 (Design Philosophy)

本系统以agentmemory和knowledge graph为基础，采用“存算分离、惰性衰减、实证强化”体系，并在工程细节上加固了边缘防护与可观测性。

- **统一底座与双轨融合**：SQLite 为全局唯一持久化存储；Node.js Knowledge Graph 作为内存抽象引擎，图谱结论打包写回 SQLite，启动时从 SQLite 瞬间重建。
- **惰性计算**：不在后台任务中刷新活跃数据的置信度。时间流逝不消耗 I/O，仅在“检索召回”或“归档判定”时实时计算衰减。
- **基于引用的实证主义**：检索召回 ≠ 记忆强化。仅 LLM 实际输出的 `cited_memory_ids` 触发强化，杜绝噪音虚假繁荣。冷启动阶段引入**弱引用**（排名第一的隐式采纳）平滑过渡。
- **防御性设计**：所有参数可配置，所有关键链路均有诊断日志。

## 2. 数据库设计 (Schema & Migration)

在agentmemory数据库现有`chunks` 表基础上增加元数据字段。**注意：`base_tau` 为该记忆的初始半衰期（天），即 τ_min；最大半衰期 τ_max 固定为 365 天。**

### 2.1 变更脚本

```sql
-- 1. 置信度与生命周期追踪
ALTER TABLE chunks ADD COLUMN initial_confidence REAL DEFAULT 0.5;
ALTER TABLE chunks ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE chunks ADD COLUMN last_confidence_update INTEGER;         -- Unix 秒
ALTER TABLE chunks ADD COLUMN base_tau REAL DEFAULT 7.0;              -- 该记忆专属的最小半衰期 (天)
ALTER TABLE chunks ADD COLUMN hit_count INTEGER DEFAULT 0;

-- 2. 状态与权限控制
ALTER TABLE chunks ADD COLUMN is_archived BOOLEAN DEFAULT 0;
ALTER TABLE chunks ADD COLUMN is_protected BOOLEAN DEFAULT 0;
ALTER TABLE chunks ADD COLUMN conflict_flag BOOLEAN DEFAULT 0;

-- 3. 类别与图谱支撑
ALTER TABLE chunks ADD COLUMN category TEXT DEFAULT 'raw_log';
ALTER TABLE chunks ADD COLUMN kg_data TEXT;                           -- JSON 子图容器
```

初始化脚本：将历史数据的 `last_confidence_update` 设置为 `updated_at`，`confidence` 和 `initial_confidence` 维持默认或手动评估。

## 3. 核心写入流：智能分级路由 (Smart Add)

在 `agentmemory.add` 外层封装网关，根据类别自动注入初始物理参数。

### 3.1 类别法则基准表

| Category       | initial_confidence | base_tau (天) | 适用场景                         |
|----------------|--------------------|---------------|----------------------------------|
| temporary      | 0.40               | 2.0           | 临时变量、单次任务               |
| raw_log        | 0.50               | 7.0           | 日常对话、未提炼想法             |
| episodic       | 0.70               | 30.0          | 情节摘要、会话总结               |
| preference     | 0.70               | 30.0          | 用户习惯、格式要求               |
| kg_node        | 0.85               | 90.0          | 经图谱提炼的结构化结论           |
| user_identity  | 0.95               | 365.0         | 核心身份、职业、受保护数据       |

### 3.2 写入网关实现

```python
import time

def smart_add_memory(text, metadata=None):
    if metadata is None:
        metadata = {}
    
    category = metadata.get('category', 'raw_log')
    is_protected = metadata.get('is_protected', False)
    
    # 路由分配
    if is_protected or category == 'user_identity':
        init_c, tau = 0.95, 365.0
    elif category == 'kg_node':
        init_c, tau = 0.85, 90.0
    elif category == 'preference':
        init_c, tau = 0.70, 30.0
    elif category == 'temporary':
        init_c, tau = 0.40, 2.0
    else:  # raw_log
        init_c, tau = 0.50, 7.0

    metadata['initial_confidence'] = metadata.get('initial_confidence', init_c)
    metadata['confidence'] = metadata['initial_confidence']
    metadata['base_tau'] = metadata.get('base_tau', tau)
    metadata['last_confidence_update'] = int(time.time())
    metadata['hit_count'] = 0
    metadata['conflict_flag'] = 0

    return agentmemory.add(text, metadata)
```

## 4. 核心检索流：混合门控排序 (Hybrid Search)

采用**动态阈值门控 + 动态指数衰减 + 加权求和**，参数可通过配置文件调整。

### 4.1 配置项

```python
CONFIG = {
    "MIN_SIMILARITY_THRESHOLD": 0.55,   # 门控阈值（需根据嵌入模型分布调整）
    "ALPHA_VECTOR_WEIGHT": 0.7,         # 语义权重（剩余 0.3 归置信度）
    "TAU_MAX": 365.0,                   # 最大半衰期
    "BETA": 0.3,                        # 巩固速率因子
    "CONFLICT_PENALTY": 0.5,            # 冲突惩罚固定值
    "ARCHIVE_THRESHOLD": 0.15           # 归档置信度冰点
}
```

### 4.2 数学公式

**动态半衰期：**
$$
\tau(\text{hits}) = \text{base\_tau} + (365 - \text{base\_tau}) \cdot (1 - e^{-0.3 \cdot \text{hits}})
$$

**实时置信度（带冲突惩罚）：**
$$
\text{Conf}_{realtime} = \max(0, \, \text{Conf}_{snapshot} \cdot e^{-\frac{\Delta t_{days}}{\tau(\text{hits})}} - \text{Penalty}_{conflict})
$$

### 4.3 检索拦截器

```python
import math
import time

def calculate_tau(hits, base_tau, tau_max=CONFIG["TAU_MAX"], beta=CONFIG["BETA"]):
    if base_tau >= tau_max:
        return base_tau
    return base_tau + (tau_max - base_tau) * (1 - math.exp(-beta * hits))

def hybrid_search(query_text, top_k=5):
    candidates = agentmemory.search(query_text, limit=30)
    current_time = int(time.time())
    results = []
    
    alpha = CONFIG["ALPHA_VECTOR_WEIGHT"]
    threshold = CONFIG["MIN_SIMILARITY_THRESHOLD"]
    penalty = CONFIG["CONFLICT_PENALTY"]
    
    for chunk in candidates:
        if chunk.is_archived:
            continue
        
        vector_score = chunk.similarity
        if vector_score < threshold:
            continue  # 门控拦截
        
        # 惰性衰减计算
        if chunk.is_protected:
            real_time_conf = chunk.confidence
        else:
            # 防御：last_confidence_update 为空时视作刚更新
            if not chunk.last_confidence_update:
                delta_days = 0.0
            else:
                delta_days = (current_time - chunk.last_confidence_update) / 86400.0
            
            tau = calculate_tau(chunk.hit_count, chunk.base_tau)
            decay = math.exp(-delta_days / tau)
            real_time_conf = max(0.0, chunk.confidence * decay - (penalty if chunk.conflict_flag else 0.0))
        
        final_score = (alpha * vector_score) + ((1 - alpha) * real_time_conf)
        
        # 附加诊断信息
        chunk.current_score = final_score
        chunk.real_time_conf = real_time_conf
        results.append(chunk)
    
    results.sort(key=lambda x: x.current_score, reverse=True)
    top_results = results[:top_k]
    
    # 诊断日志（影子测试阶段）
    log_search_diagnostics(query_text, candidates, top_results)
    
    return top_results
```

## 5. 记忆演化流：强化、冲突与归档

### 5.1 引用强化闭环 (Update Hook)

LLM 响应必须包含 `cited_memory_ids`。系统仅对这些 ID 执行强化。

```sql
UPDATE chunks 
SET hit_count = hit_count + 1,
    confidence = MIN(1.0, <real_time_conf> + 0.1),
    last_confidence_update = strftime('%s', 'now')
WHERE id IN (?, ?);
```

**冷启动过渡**：在系统初期 LLM 引用率不稳定时，可启用**弱引用模式**（默认关闭）。即：若 LLM 未提供任何引用，则将本次检索排名第一的记忆视为隐式采纳，给予 `+0.03` 的微小强化并更新命中次数。此模式通过 `ENABLE_WEAK_CITATION = True` 开关控制，待引用率稳定后关闭。

### 5.2 冲突标记生成

冲突判定双链路：

- **快速链路（图谱驱动）**：Knowledge Graph 检测到 Concept Drift 后，通过向量检索定位相关的 `raw_log` 记忆，直接将其 `conflict_flag` 置为 1。
- **慢速链路（心跳扫描）**：每日定时任务，提取近 24 小时的高置信度新记忆，检索语义相似但时间久远的记忆，调用轻量 LLM 判断是否矛盾。若矛盾，将旧记忆的 `conflict_flag` 置为 1。

未来优化方向：冲突惩罚量可根据新事实的置信度动态计算（如 `penalty = 0.5 * Conf(new_fact)`），v3.1 暂用固定值。

### 5.3 纯净心跳归档 (Zero-Write Compaction)

**绝对禁止**更新活跃记忆的 `confidence` 或时间戳。仅计算内存中的实时置信度，对跌破冰点的记忆标记 `is_archived`。

```python
def heartbeat_compaction():
    active = db.query(
        "SELECT id, confidence, last_confidence_update, hit_count, base_tau, is_protected, category "
        "FROM chunks WHERE is_archived = 0 AND is_protected = 0"
    )
    current_time = get_unix_timestamp()
    to_archive = []
    
    for chunk in active:
        # 额外防护：user_identity 即使未设保护也不归档
        if chunk.category == 'user_identity':
            continue
        
        if not chunk.last_confidence_update:
            continue  # 数据异常，跳过
        
        delta_days = (current_time - chunk.last_confidence_update) / 86400.0
        tau = calculate_tau(chunk.hit_count, chunk.base_tau)
        real_conf = chunk.confidence * math.exp(-delta_days / tau)
        
        if real_conf < CONFIG["ARCHIVE_THRESHOLD"]:
            to_archive.append(chunk.id)
    
    if to_archive:
        db.execute("UPDATE chunks SET is_archived = 1 WHERE id IN (?)", to_archive)
```

## 6. 图谱桥接：子图打包方案 (KG Integration)

为保留结构化信息，`kg_data` 采用“节点为中心”的子图容器，三元组可附带置信度。

**Node.js 写入示例：**

```javascript
agentmemory.add({
  text: "用户倾向使用 Rust 开发系统层级应用，极其看重内存安全。",
  metadata: {
     category: "kg_node",
     kg_data: JSON.stringify({
         "core_concept": "Rust_Preference",
         "triplets": [
             {"s": "User", "p": "prefers", "o": "Rust", "confidence": 0.9},
             {"s": "User", "p": "applies_to", "o": "System_Programming", "confidence": 0.7},
             {"s": "Rust", "p": "provides", "o": "Memory_Safety", "confidence": 0.85}
         ]
     }),
     is_protected: 1
  }
});
```

**启动重建流：** Node.js 服务启动时，查询 `SELECT kg_data FROM chunks WHERE category='kg_node' AND is_archived=0`，解析 JSON 并调用 `GraphMemory.rebuild(triplets)` 恢复内存图谱。

## 7. 可观测性与调参

### 7.1 诊断日志

在 `hybrid_search` 中输出每次检索的关键指标：

- 候选池大小
- 经门控过滤后数量
- 每条返回结果的 `vector_score`、`real_time_conf`、`final_score`、`hit_count`
- 阈值命中率

### 7.2 调参指引

- **MIN_SIMILARITY_THRESHOLD**：观察向量相似度的整体分布，通常取 **下四分位数** 附近。若大部分查询候选 >0.7，可上调至 0.65；若模型区分度低，可下调至 0.5。
- **ALPHA_VECTOR_WEIGHT**：若 Agent 回答过度受低置信度记忆干扰，增大 α（加大语义权重）；若受高语义但低置信度误导，可适当降低 α，使置信度发挥更大过滤作用。
- **BETA**：根据实际命中分布调整。若用户频繁确认相同事实，可降低 β 使巩固更平缓；若希望快速巩固核心信息，可提高至 0.5。
- **弱引用模式**：仅冷启动阶段使用，一旦 `cited_memory_ids` 稳定输出即关闭。

## 8. 实施路线图

### 里程碑 1：底层与门控
- 执行 SQL Schema 变更
- 部署 `smart_add_memory` 网关
- 实现 `hybrid_search`，配置诊断日志，运行影子测试（收集参数分布）

### 里程碑 2：强化闭环
- 修改 Agent Prompt，要求输出 `cited_memory_ids`
- 开发 Update Hook，支持弱引用冷启动选项
- 验证高频记忆衰减减缓效果

### 里程碑 3：图谱自净与归档
- 更新 Node.js 模块，采用子图 Schema 写入 SQLite
- 部署图谱漂移触发的 Conflict 打标链路
- 上线纯净心跳归档任务
- 关闭弱引用（若 LLM 引用率合格）

### 后续迭代（v1.0+）
- 动态冲突惩罚（与置信度挂钩）
- 基于显著性 Saliency 的强化增量调整
- 记忆质量监控仪表盘

---

## 9. v1.2 新增特性 (2026-05-16)

### 9.1 FTS5 并行召回

利用 OpenClaw 原生 `chunks_fts`（FTS5 虚拟表，100% 覆盖率），在向量搜索同时并行执行 BM25 全文搜索。专有名词、代码库名、API 名称精准命中，弥补纯语义搜索短板。

### 9.2 RRF 三通道融合

检索请求并行发送至三个独立通道：

| 通道 | 候选数 | 方式 |
|:---|:---:|:---|
| 向量语义 | 30 | cosine similarity + 置信度衰减 |
| FTS5 关键词 | 20 | BM25 排序 |
| KG 概念桥 | 15 | 知识图谱概念 → FTS5 chunks 映射 |

结果以 **Reciprocal Rank Fusion** (k=60) 等权融合排序：$\text{RRF}(d) = \sum_{i} \frac{1}{60 + r_i(d)}$

### 9.3 情节摘要中间层 (Episodic Memory)

新增 `episodic` 类别（conf=0.70, τ=30 天），`summarize` 命令汇聚 raw_log 通过 LLM 生成摘要（失败时关键词回退），`kg_data` 存储 `episode_of` 链接源 chunk ID，`drill <chunk_id>` 下钻查看原文。搜索含时间意向词时自动 RRF 加权 +0.1。

### 9.4 检索管线演进

| 版本 | 检索方式 |
|:---|:---|
| v1.0 | 单通道：向量 + 置信度加权 |
| **v1.2** | **三通道：向量 + FTS5 + KG → RRF 融合** |

**版本记录**

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v1.0 | 2026-05-15 | 整合审查建议：防御性NULL处理、子图置信度字段、弱引用冷启动、归档二次确认、可配置参数、诊断日志 |
| **v1.2** | **2026-05-16** | **FTS5 并行召回 + RRF 三通道融合 + KG 概念桥 + `episodic` 情节摘要 |
| **v1.3** | **2026-05-18** | **Plugin contracts + image_vision + session-checkpoint + detectConfig + 冲突标记** |

---

## 10. v1.3 新增特性 (2026-05-18)

### 10.1 Plugin Contracts 声明

插件入口增加 `contracts: { tools: true }`，`openclaw.plugin.json` 增加工具名声明 `["memory_engine", "image_vision"]`，确保 OpenClaw 插件系统正确注册工具。

### 10.2 image_vision 工具

新注册 agent 工具，调用 SiliconFlow 的 Qwen3-VL-32B-Instruct 进行图片识别。参数：`image_path`（必填）+ `question`（可选），默认输出中文详细描述。

### 10.3 自动配置检测 (detectConfig)

`smart_add` 写入流程中增加自动分类探测：检测 API Key、Voice ID、模型名、文件路径、长哈希、中文配置关键词（"设置声音为…"等）时自动将 `raw_log` 提升为 `preference`（conf=0.80, tau=90天）。

### 10.4 Session 检查点 (session-checkpoint.js)

`scripts/session-checkpoint.js`，每日 03:55 CST 执行：

1. 从 DB 读取昨日 raw_log + episodic 的文本
2. 调用 SiliconFlow API 提取 `<key> = <value>` 形式的新配置
3. 每条配置写入 preference 记忆
4. 原始日志 → LLM 摘要（150-200字）→ 写入 episodic 类别
5. **自动冲突标记**：同 key 配置保留最新，旧条目设 `conflict_flag=1`；唯一条目误标则自动解除

### 10.5 Memory Prompt Supplement

`registerMemoryPromptSupplement` 在 session 启动时动态注入：
- `[昨日概要]` — 昨日 episode 摘要
- `[受保护记忆]` — `user_identity` + `protected` 标记的记忆列表
- 仅主 session 和 heartbeat session 生效

此文档可直接交付工程团队执行。
