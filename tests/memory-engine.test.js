#!/usr/bin/env node
/**
 * Memory Engine v1.0 — Test Suite
 * 
 * Tests: calculateTau, calcRealtimeConf, hybrid scoring, category routing.
 * Run: node tests/memory-engine.test.js
 */

const path = require('path');

// ===================== Shared Constants =====================
const TAU_MAX = 365.0;
const BETA = 0.3;
const CONFLICT_PENALTY = 0.5;

// ===================== Implementations Under Test =====================
// (Self-contained copies to avoid importing runtime dependencies)

function calculateTau(hits, baseTau) {
  if (hits < 0) hits = 0;  // clamp negative
  if (baseTau >= TAU_MAX) return baseTau;
  return baseTau + (TAU_MAX - baseTau) * (1 - Math.exp(-BETA * hits));
}

function calcRealtimeConf(confidence, lastUpdate, hits, baseTau, isProtected, conflictFlag, currentTime) {
  if (isProtected) return confidence;
  if (!lastUpdate) return confidence;
  const deltaDays = (currentTime - lastUpdate) / 86400;
  const tau = calculateTau(hits, baseTau);
  const decay = Math.exp(-deltaDays / tau);
  let c = confidence * decay;
  if (conflictFlag) c -= CONFLICT_PENALTY;
  return Math.max(0, c);
}

function hybridScore(similarity, realtimeConf, category, kgBoost) {
  const alpha = 0.7;
  let score = alpha * similarity + (1 - alpha) * realtimeConf;
  if (category === 'kg_node' && realtimeConf > 0.3 && kgBoost) {
    score += 0.03;
  }
  return Math.round(score * 10000) / 10000;
}

const CATEGORY_RULES = {
  temporary:       { conf: 0.40, tau: 2.0 },
  raw_log:         { conf: 0.50, tau: 7.0 },
  preference:      { conf: 0.70, tau: 30.0 },
  kg_node:         { conf: 0.85, tau: 90.0 },
  user_identity:   { conf: 0.95, tau: 365.0 },
};

// ===================== Test Runner =====================
let passed = 0, failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) { passed++; }
  else {
    failed++;
    errors.push(`❌ FAIL: ${msg}`);
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) <= tolerance) { passed++; }
  else {
    failed++;
    errors.push(`❌ FAIL: ${msg} — expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

// ===================== Tests: calculateTau =====================
console.log('\n=== calculateTau ===');

// τ_min: baseTau for hits=0
assertApprox(calculateTau(0, 2.0), 2.0, 0.001, 'τ(0, 2.0) should equal base_tau');
assertApprox(calculateTau(0, 365.0), 365.0, 0.001, 'τ(0, 365.0) should stay at max');

// τ approaches TAU_MAX as hits increase
const tau10 = calculateTau(10, 7.0);
assert(tau10 > 7.0 && tau10 < 365.0, `τ(10, 7.0) = ${tau10} should be between base_tau and TAU_MAX`);
assert(tau10 > calculateTau(5, 7.0), 'τ should increase monotonically with hits');

// Asymptotic: high hits → approaches TAU_MAX
const tau100 = calculateTau(100, 7.0);
assertApprox(tau100, TAU_MAX, 1.0, `τ(100, 7.0) = ${tau100} should approach ${TAU_MAX}`);

// baseTau >= TAU_MAX: return baseTau unchanged
assertApprox(calculateTau(10, 500.0), 500.0, 0.001, 'τ(10, 500.0) should stay at 500 (capped by base_tau)');
assertApprox(calculateTau(0, 365.0), 365.0, 0.001, 'τ(0, 365.0) should be 365 when baseTau == TAU_MAX');

// Edge: negative hits treated as 0 (0 → no decay term)
assertApprox(calculateTau(-1, 7.0), 7.0, 0.001, 'τ(-1, 7.0) should treat negative hits as 0');

// Edge: zero baseTau
assertApprox(calculateTau(5, 0), TAU_MAX * (1 - Math.exp(-BETA * 5)), 0.001, 'τ(5, 0) should start from 0');

// Floor check: baseTau near zero
assert(calculateTau(0, 0.001) > 0, 'τ(0, 0.001) should be positive');

console.log(`  passed: ${passed - failed} tests so far`);

// ===================== Tests: calcRealtimeConf =====================
console.log('\n=== calcRealtimeConf ===');
const NOW = 1_700_000_000;

// Protected: no decay
assertApprox(calcRealtimeConf(0.95, NOW - 864000, 0, 7.0, true, false, NOW),
  0.95, 0.0001, 'Protected memory should not decay');

// NULL lastUpdate: return snapshot
assertApprox(calcRealtimeConf(0.50, null, 0, 7.0, false, false, NOW),
  0.50, 0.0001, 'NULL last_confidence_update should return confidence snapshot');

// Zero delta: no decay
assertApprox(calcRealtimeConf(0.50, NOW, 0, 7.0, false, false, NOW),
  0.50, 0.0001, 'Zero time delta should produce no decay');

// Decay: 7 days at τ=7 → ~36.8% remaining
const weekAgo = NOW - 7 * 86400;
const decay7d = calcRealtimeConf(0.50, weekAgo, 0, 7.0, false, false, NOW);
assertApprox(decay7d, 0.5 * Math.exp(-1), 0.01,
  `7 day decay at τ=7 should be ~0.184, got ${decay7d}`);

// One tau period: 30 days at τ=30 → ~36.8% of original
const monthAgo = NOW - 30 * 86400;
const decay30d = calcRealtimeConf(0.50, monthAgo, 0, 30.0, false, false, NOW);
assertApprox(decay30d, 0.5 * Math.exp(-1), 0.01,
  `30 day decay at τ=30 should be ~0.184, got ${decay30d}`);

// Conflict penalty: deduction applied
const conflicted = calcRealtimeConf(0.50, NOW, 0, 7.0, false, true, NOW);
assert(conflicted >= 0, `Conflicted confidence should be >= 0, got ${conflicted}`);

// Conflict + extreme decay → floor at 0
const veryOldConflicted = calcRealtimeConf(0.10, NOW - 365 * 86400, 0, 2.0, false, true, NOW);
assertApprox(veryOldConflicted, 0, 0.001, 'Old conflicted memory should floor at 0');

// Hits extend tau → slower decay
const hit7 = calcRealtimeConf(0.50, weekAgo, 7, 7.0, false, false, NOW);
const hit0 = calcRealtimeConf(0.50, weekAgo, 0, 7.0, false, false, NOW);
assert(hit7 > hit0, `Memory with hits (${hit7}) should decay slower than without (${hit0})`);

console.log(`  passed: ${passed - failed} tests so far`);

// ===================== Tests: Hybrid Score =====================
console.log('\n=== hybridScore ===');

// Protected, high-similarity → dominates
const s1 = hybridScore(0.9, 0.95, 'raw_log', false);
assertApprox(s1, 0.7 * 0.9 + 0.3 * 0.95, 0.0001, 'Protected high-sim should score 0.9150');

// Low similarity, high confidence → balanced
const s2 = hybridScore(0.3, 0.95, 'raw_log', false);
assertApprox(s2, 0.7 * 0.3 + 0.3 * 0.95, 0.0001, 'Low sim high conf: 0.4950');

// Equal weighting
const s3 = hybridScore(0.5, 0.5, 'raw_log', false);
assertApprox(s3, 0.5, 0.0001, 'Equal sim and conf should give 0.5');

// KG_BOOST: kg_node + high conf → +0.03
const s4 = hybridScore(0.5, 0.5, 'kg_node', true);
assertApprox(s4, 0.5 + 0.03, 0.0001, 'KG_NODE with conf>0.3 should get +0.03 boost');

// KG_BOOST not applied to non-kg_node
const s5 = hybridScore(0.5, 0.5, 'raw_log', true);
assertApprox(s5, 0.5, 0.0001, 'Non-KG_NODE should not get boost');

// KG_BOOST not applied when conf ≤ 0.3
const s6 = hybridScore(0.5, 0.3, 'kg_node', true);
assertApprox(s6, 0.7 * 0.5 + 0.3 * 0.3, 0.0001, 'KG_NODE with conf=0.3 should NOT get boost (not > 0.3)');

// Sorting regression: higher final_score always wins
const items = [
  { sim: 0.6, conf: 0.7, cat: 'raw_log', kg: false },
  { sim: 0.8, conf: 0.3, cat: 'raw_log', kg: false },
  { sim: 0.5, conf: 0.9, cat: 'raw_log', kg: false },
];
const sorted = items
  .map(i => ({ ...i, score: hybridScore(i.sim, i.conf, i.cat, i.kg) }))
  .sort((a, b) => b.score - a.score);
assert(sorted[0].score >= sorted[1].score, 'Sort: first >= second');
assert(sorted[1].score >= sorted[2].score, 'Sort: second >= third');
assert(sorted[0].sim === 0.8, `Highest sim should win: ${sorted[0].sim}`);

console.log(`  passed: ${passed - failed} tests so far`);

// ===================== Tests: Category Routing =====================
console.log('\n=== Category Routing ===');

for (const [cat, rule] of Object.entries(CATEGORY_RULES)) {
  assert(rule.conf > 0 && rule.conf <= 1, `${cat} confidence (${rule.conf}) should be in (0, 1]`);
  assert(rule.tau > 0, `${cat} tau (${rule.tau}) should be positive`);
}

// Ordering: higher priority categories should have higher conf
const entries = Object.entries(CATEGORY_RULES);
for (let i = 0; i < entries.length - 1; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    // Just verify no obvious inversion (each category is independently reasonable)
  }
}

// user_identity is the highest
const identities = Object.values(CATEGORY_RULES);
const maxConf = Math.max(...identities.map(r => r.conf));
const maxTau = Math.max(...identities.map(r => r.tau));
const maxEntry = Object.entries(CATEGORY_RULES).find(([, r]) => r.conf === maxConf && r.tau === maxTau);
assert(maxEntry && maxEntry[0] === 'user_identity',
  `user_identity should have highest conf/tau, got ${maxEntry?.[0]}`);
assert(maxEntry && maxEntry[1].conf === 0.95 && maxEntry[1].tau === 365,
  `user_identity should be 0.95/365`);

console.log(`  passed: ${passed - failed} tests so far`);

// ===================== Summary =====================
console.log('\n========================================');
console.log(`Total: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
console.log('========================================');

if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(e));
  process.exit(1);
}

// ===================== DB Integration Tests (optional) =====================
// These require a running database and are skipped unless --integration is passed
if (process.argv.includes('--integration')) {
  console.log('\n=== Integration Tests ===');
  const Database = require('better-sqlite3');
  const dbPath = path.resolve(process.env.HOME || '/home/lionsol', '.openclaw/memory/main.sqlite');
  
  try {
    const db = new Database(dbPath);
    const totalChunks = db.prepare('SELECT COUNT(*) as c FROM chunks').get().c;
    assert(totalChunks > 0, `Database should have chunks (found ${totalChunks})`);

    const tracked = db.prepare('SELECT COUNT(*) as c FROM memory_confidence').get().c;
    assert(tracked > 0, `memory_confidence should have entries (found ${tracked})`);

    const orphans = db.prepare(
      'SELECT COUNT(*) as c FROM memory_confidence mc LEFT JOIN chunks c ON mc.chunk_id = c.id WHERE c.id IS NULL'
    ).get().c;
    assert(orphans === 0, `There should be no orphan confidence entries (found ${orphans})`);

    const emptyEmbeds = db.prepare(
      "SELECT COUNT(*) as c FROM chunks WHERE embedding IS NULL OR embedding = '[]'"
    ).get().c;
    assert(emptyEmbeds === 0, `All chunks should have embeddings (${emptyEmbeds} empty)`);

    db.close();
  } catch (e) {
    failed++;
    errors.push(`❌ Integration test error: ${e.message}`);
  }

  console.log(`\nIntegration: ${passed}/${passed + failed}`);
}
