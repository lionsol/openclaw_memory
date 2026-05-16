#!/usr/bin/env node
/**
 * Knowledge Graph CLI wrapper
 * Persists the graph to a JSON file on disk.
 * Usage:
 *   node kg.js add "概念名" '{"属性":"值"}'         # 添加概念
 *   node kg.js link "来源" "目标" "关系类型"         # 添加关系
 *   node kg.js get "概念名"                          # 获取概念详情
 *   node kg.js related "概念名"                      # 获取关联概念
 *   node kg.js search "关键词"                       # 搜索概念
 *   node kg.js path "起点" "终点"                    # 找路径
 *   node kg.js stats                                 # 统计信息
 *   node kg.js remember "键" '{"data":"值"}'         # 存入短期记忆
 *   node kg.js recall "键"                           # 回忆
 *   node kg.js consolidate                           # 压缩整理
 *   node kg.js summarize                             # 生成会话上下文摘要
 */

const path = require('path');
const fs = require('fs');
const { KnowledgeGraph, Memory, EdgeType } = require('./skills/jpeng-knowledge-graph-memory');

const DATA_FILE = path.join(__dirname, 'knowledge-graph.json');

// Load or create graph
function loadGraph() {
  const kg = new KnowledgeGraph({ maxNodes: 5000, consolidationThreshold: 0.05 });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      const loaded = KnowledgeGraph.fromJSON(data);
      // Copy over the nodes and edges
      kg.nodes = loaded.nodes;
      kg.edges = loaded.edges;
      kg.adjacency = loaded.adjacency;
      kg.temporalReasoner = loaded.temporalReasoner;
      kg.indexCounter = kg.nodes.size;
    } catch (e) {
      console.error('Error loading graph, starting fresh:', e.message);
    }
  }
  return kg;
}

function saveGraph(kg) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(kg.toJSON(), null, 2), 'utf-8');
}

const cmd = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];
const arg3 = process.argv[5];

const kg = loadGraph();
let result;

switch (cmd) {
  case 'add': {
    const name = arg1;
    const props = arg2 ? JSON.parse(arg2) : {};
    kg.addConcept(name, props);
    saveGraph(kg);
    result = `✅ 已添加概念: ${name}`;
    break;
  }
  case 'link': {
    kg.link(arg1, arg2, arg3 || 'related_to');
    saveGraph(kg);
    result = `✅ 已关联: ${arg1} --[${arg3 || 'related_to'}]--> ${arg2}`;
    break;
  }
  case 'get': {
    const concept = kg.getConcept(arg1);
    result = concept ? JSON.stringify({
      name: concept.name,
      type: concept.type,
      properties: concept.properties,
      importance: concept.importance,
      accessCount: concept.accessCount,
      version: concept.version
    }, null, 2) : `❌ 未找到: ${arg1}`;
    break;
  }
  case 'related': {
    const related = kg.getRelated(arg1, arg2 || null);
    if (related.length === 0) {
      result = `ℹ️ ${arg1} 没有关联概念`;
    } else {
      result = related.map(r => ({
        name: r.concept.name,
        relation: r.edge.type,
        properties: r.concept.properties
      }));
      result = JSON.stringify(result, null, 2);
    }
    break;
  }
  case 'search': {
    const results = kg.search({ name: arg1 || '' });
    if (results.length === 0) {
      result = `ℹ️ 未找到匹配: ${arg1}`;
    } else {
      result = results.map(c => ({
        name: c.name,
        type: c.type,
        properties: c.properties,
        importance: c.importance
      }));
      result = JSON.stringify(result, null, 2);
    }
    break;
  }
  case 'path': {
    const foundPath = kg.findPath(arg1, arg2);
    result = foundPath
      ? '路径: ' + foundPath.map(c => c.name).join(' → ')
      : `❌ 未找到 ${arg1} 到 ${arg2} 的路径`;
    break;
  }
  case 'stats': {
    const stats = kg.getStats();
    result = JSON.stringify(stats, null, 2);
    break;
  }
  case 'remember': {
    const memory = new Memory({ shortTermMaxSize: 200 });
    memory.knowledgeGraph = kg;
    memory.remember(arg1, typeof arg2 === 'string' ? JSON.parse(arg2) : arg2, { importance: 0.7 });
    saveGraph(kg);
    result = `✅ 已记忆: ${arg1}`;
    break;
  }
  case 'recall': {
    const memory = new Memory();
    memory.knowledgeGraph = kg;
    const val = memory.recall(arg1);
    result = val !== null ? JSON.stringify(val, null, 2) : `❌ 未找到: ${arg1}`;
    break;
  }
  case 'consolidate': {
    const removed = kg.consolidate();
    saveGraph(kg);
    result = `✅ 已整理，移除了 ${removed} 个低价值概念`;
    break;
  }
  case 'summarize': {
    // Generate a brief summary of what the graph knows about the user
    const stats = kg.getStats();
    const concepts = Array.from(kg.nodes.values())
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 30)
      .map(c => ({
        name: c.name,
        type: c.type,
        importance: c.importance,
        props: c.properties,
        relations: kg.getRelated(c.id).map(r => ({ to: r.concept.name, via: r.edge.type }))
      }));
    result = JSON.stringify({ stats, topConcepts: concepts }, null, 2);
    break;
  }
  default:
    result = `用法:
  node kg.js add "概念名" '{"key":"val"}'     添加概念
  node kg.js link "来源" "目标" "关系类型"      关联概念
  node kg.js get "概念名"                      查看详情
  node kg.js related "概念名"                  查看关联
  node kg.js search "关键词"                   搜索
  node kg.js path "起点" "终点"                查路径
  node kg.js stats                             统计
  node kg.js remember "键" '{"data":"值"}'     短期记忆
  node kg.js recall "键"                       回忆
  node kg.js consolidate                       整理
  node kg.js summarize                         上下文摘要`;
}

console.log(result);
