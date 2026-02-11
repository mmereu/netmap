#!/usr/bin/env node
/**
 * Cache Performance Benchmark
 *
 * Measures:
 * - Cold cache response time (first request after cache clear)
 * - Warm cache response time (subsequent requests)
 * - Cache invalidation behavior
 * - Performance improvement comparison report
 *
 * Usage:
 *   node benchmark-cache.mjs [options]
 *
 * Options:
 *   --base-url <url>   Server URL (default: http://localhost:4000)
 *   --iterations <n>   Number of iterations for warm cache tests (default: 10)
 *   --help             Show help message
 */

import { performance } from 'perf_hooks';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  baseUrl: 'http://localhost:4000',
  iterations: 10,
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base-url' && args[i + 1]) {
    options.baseUrl = args[++i];
  } else if (args[i] === '--iterations' && args[i + 1]) {
    options.iterations = parseInt(args[++i], 10);
  } else if (args[i] === '--help') {
    console.log(`
Cache Performance Benchmark

Usage:
  node benchmark-cache.mjs [options]

Options:
  --base-url <url>   Server URL (default: http://localhost:4000)
  --iterations <n>   Number of iterations for warm cache tests (default: 10)
  --help             Show help message

This script measures the performance improvement from database query caching
by comparing cold cache vs warm cache response times for map API endpoints.
`);
    process.exit(0);
  }
}

const BASE_URL = options.baseUrl;
const ITERATIONS = options.iterations;
const DEBUG_TOKEN = 'netmap-debug-2024';

// Results storage
const results = {
  endpoints: {},
  invalidation: {},
  summary: {},
};

/**
 * Helper to format bytes
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Helper to format duration
 */
function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Make HTTP request with timing
 */
async function timedFetch(url, fetchOptions = {}) {
  const start = performance.now();
  const response = await fetch(url, fetchOptions);
  const end = performance.now();

  const data = await response.json();
  const headers = Object.fromEntries(response.headers.entries());

  return {
    duration: end - start,
    status: response.status,
    data,
    headers,
    cacheStatus: headers['x-cache-status'],
    queryTime: headers['x-query-time'] ? parseFloat(headers['x-query-time']) : null,
    responseTime: headers['x-response-time'] ? parseFloat(headers['x-response-time']) : null,
  };
}

/**
 * Clear all caches
 */
async function clearCaches(type = 'all') {
  try {
    const response = await fetch(`${BASE_URL}/api/cache/clear?type=${type}`, {
      method: 'POST',
      headers: { 'X-Debug-Token': DEBUG_TOKEN },
    });
    if (!response.ok) {
      throw new Error(`Failed to clear cache: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error(`   Warning: Could not clear cache - ${err.message}`);
    return null;
  }
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
  try {
    const response = await fetch(`${BASE_URL}/api/cache/stats`);
    if (!response.ok) {
      throw new Error(`Failed to get stats: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error(`   Warning: Could not get cache stats - ${err.message}`);
    return null;
  }
}

/**
 * Run benchmark for a single endpoint
 */
async function benchmarkEndpoint(name, endpoint) {
  console.log(`\n  Testing ${name}...`);

  const result = {
    endpoint,
    coldCache: null,
    warmCache: [],
    warmCacheAvg: null,
    warmCacheMin: null,
    warmCacheMax: null,
    improvement: null,
    improvementPercent: null,
  };

  // Clear caches first
  await clearCaches();

  // Small delay to ensure cache is cleared
  await new Promise(resolve => setTimeout(resolve, 100));

  // Cold cache test (first request after clear)
  console.log(`     Cold cache request...`);
  try {
    const coldResult = await timedFetch(`${BASE_URL}${endpoint}`);
    result.coldCache = coldResult.duration;
    console.log(`     Cold: ${formatDuration(result.coldCache)} (cache: ${coldResult.cacheStatus || 'N/A'})`);
  } catch (err) {
    console.error(`     Error: ${err.message}`);
    return result;
  }

  // Warm cache tests (subsequent requests)
  console.log(`     Warm cache requests (${ITERATIONS} iterations)...`);
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const warmResult = await timedFetch(`${BASE_URL}${endpoint}`);
      result.warmCache.push(warmResult.duration);
    } catch (err) {
      console.error(`     Iteration ${i + 1} error: ${err.message}`);
    }
  }

  if (result.warmCache.length > 0) {
    result.warmCacheAvg = result.warmCache.reduce((a, b) => a + b, 0) / result.warmCache.length;
    result.warmCacheMin = Math.min(...result.warmCache);
    result.warmCacheMax = Math.max(...result.warmCache);

    console.log(`     Warm avg: ${formatDuration(result.warmCacheAvg)} (min: ${formatDuration(result.warmCacheMin)}, max: ${formatDuration(result.warmCacheMax)})`);

    // Calculate improvement
    if (result.coldCache > 0 && result.warmCacheAvg > 0) {
      result.improvement = result.coldCache - result.warmCacheAvg;
      result.improvementPercent = ((result.improvement / result.coldCache) * 100).toFixed(1);
      console.log(`     Improvement: ${formatDuration(result.improvement)} (${result.improvementPercent}% faster)`);
    }
  }

  return result;
}

/**
 * Test cache invalidation correctness
 */
async function testCacheInvalidation() {
  console.log('\n  Testing cache invalidation...');

  const result = {
    dbCache: { tested: false, passed: false },
    mapCache: { tested: false, passed: false },
  };

  try {
    // Test 1: Clear DB cache, verify miss on next request
    console.log('     Test 1: DB cache invalidation...');
    await clearCaches('db');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get initial stats
    const statsBefore = await getCacheStats();
    const hitsBefore = statsBefore?.databaseQueryCache?.hits || 0;

    // Make request (should be cache miss)
    await timedFetch(`${BASE_URL}/api/map-db`);

    // Get stats after
    const statsAfter = await getCacheStats();
    const hitsAfter = statsAfter?.databaseQueryCache?.hits || 0;

    // On cache miss, hits should not have increased
    // (or increased by 0-1 depending on implementation details)
    result.dbCache.tested = true;
    result.dbCache.hitsBefore = hitsBefore;
    result.dbCache.hitsAfter = hitsAfter;

    // Make another request (should be cache hit now)
    await timedFetch(`${BASE_URL}/api/map-db`);
    const statsAfterSecond = await getCacheStats();
    const hitsAfterSecond = statsAfterSecond?.databaseQueryCache?.hits || 0;

    // Second request should show hits increasing (cache hit)
    result.dbCache.hitsAfterSecond = hitsAfterSecond;
    result.dbCache.passed = hitsAfterSecond > hitsAfter;
    console.log(`     DB cache: ${result.dbCache.passed ? 'PASS' : 'FAIL'} (hits: ${hitsBefore} -> ${hitsAfter} -> ${hitsAfterSecond})`);

    // Test 2: Map cache invalidation
    console.log('     Test 2: Map cache invalidation...');
    await clearCaches('map');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Make request (should populate map cache)
    const mapResult1 = await timedFetch(`${BASE_URL}/api/map-db`);
    const cacheStatus1 = mapResult1.cacheStatus;

    // Make another request (should be cache hit)
    const mapResult2 = await timedFetch(`${BASE_URL}/api/map-db`);
    const cacheStatus2 = mapResult2.cacheStatus;

    result.mapCache.tested = true;
    result.mapCache.status1 = cacheStatus1;
    result.mapCache.status2 = cacheStatus2;
    result.mapCache.passed = cacheStatus2 === 'HIT';
    console.log(`     Map cache: ${result.mapCache.passed ? 'PASS' : 'FAIL'} (status: ${cacheStatus1 || 'N/A'} -> ${cacheStatus2 || 'N/A'})`);

  } catch (err) {
    console.error(`     Error during invalidation test: ${err.message}`);
  }

  return result;
}

/**
 * Calculate statistics summary
 */
function calculateSummary(endpointResults) {
  const summary = {
    totalEndpoints: 0,
    avgColdTime: 0,
    avgWarmTime: 0,
    avgImprovement: 0,
    avgImprovementPercent: 0,
    meetsTarget: false,
  };

  const validResults = Object.values(endpointResults).filter(
    r => r.coldCache !== null && r.warmCacheAvg !== null
  );

  if (validResults.length === 0) return summary;

  summary.totalEndpoints = validResults.length;
  summary.avgColdTime = validResults.reduce((a, b) => a + b.coldCache, 0) / validResults.length;
  summary.avgWarmTime = validResults.reduce((a, b) => a + b.warmCacheAvg, 0) / validResults.length;
  summary.avgImprovement = summary.avgColdTime - summary.avgWarmTime;
  summary.avgImprovementPercent = ((summary.avgImprovement / summary.avgColdTime) * 100).toFixed(1);
  // Target: 50%+ improvement for cached requests
  summary.meetsTarget = parseFloat(summary.avgImprovementPercent) >= 50;

  return summary;
}

/**
 * Print final report
 */
function printReport(results) {
  console.log('\n' + '='.repeat(70));
  console.log('                    CACHE PERFORMANCE BENCHMARK REPORT');
  console.log('='.repeat(70));

  // Endpoint Results
  console.log('\n--- ENDPOINT RESPONSE TIMES ---\n');
  console.log('Endpoint'.padEnd(25) + 'Cold'.padStart(12) + 'Warm Avg'.padStart(12) + 'Improvement'.padStart(15));
  console.log('-'.repeat(64));

  for (const [name, data] of Object.entries(results.endpoints)) {
    const cold = data.coldCache !== null ? formatDuration(data.coldCache) : 'N/A';
    const warm = data.warmCacheAvg !== null ? formatDuration(data.warmCacheAvg) : 'N/A';
    const improvement = data.improvementPercent !== null ? `${data.improvementPercent}%` : 'N/A';
    console.log(name.padEnd(25) + cold.padStart(12) + warm.padStart(12) + improvement.padStart(15));
  }

  // Cache Invalidation Results
  console.log('\n--- CACHE INVALIDATION TESTS ---\n');
  for (const [name, data] of Object.entries(results.invalidation)) {
    const status = data.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${name}: ${status}`);
  }

  // Summary
  console.log('\n--- SUMMARY ---\n');
  const s = results.summary;
  console.log(`Endpoints tested:        ${s.totalEndpoints}`);
  console.log(`Average cold cache:      ${formatDuration(s.avgColdTime)}`);
  console.log(`Average warm cache:      ${formatDuration(s.avgWarmTime)}`);
  console.log(`Average improvement:     ${formatDuration(s.avgImprovement)} (${s.avgImprovementPercent}%)`);
  console.log();
  console.log(`Target (50%+ improvement): ${s.meetsTarget ? '✓ ACHIEVED' : '✗ NOT MET'}`);

  console.log('\n' + '='.repeat(70));
}

/**
 * Main benchmark execution
 */
async function main() {
  console.log('='.repeat(70));
  console.log('                    CACHE PERFORMANCE BENCHMARK');
  console.log('='.repeat(70));
  console.log(`\nConfiguration:`);
  console.log(`  Base URL:    ${BASE_URL}`);
  console.log(`  Iterations:  ${ITERATIONS}`);

  // Check server connectivity
  console.log('\n--- SERVER CONNECTIVITY ---');
  try {
    const healthCheck = await fetch(`${BASE_URL}/api/cache/stats`);
    if (!healthCheck.ok) {
      throw new Error(`Server returned ${healthCheck.status}`);
    }
    console.log('  Server is reachable');
  } catch (err) {
    console.error(`  Error: Cannot connect to server at ${BASE_URL}`);
    console.error(`  Make sure the server is running: node server.js`);
    process.exit(1);
  }

  // Get initial cache stats
  console.log('\n--- INITIAL CACHE STATE ---');
  const initialStats = await getCacheStats();
  if (initialStats) {
    console.log(`  MapCache entries:     ${initialStats.mapCache?.size || 0}`);
    console.log(`  DB Cache entries:     ${initialStats.databaseQueryCache?.entries?.length || 0}`);
    console.log(`  DB Cache hit rate:    ${((initialStats.databaseQueryCache?.hitRate || 0) * 100).toFixed(1)}%`);
    if (initialStats.nediCache) {
      console.log(`  NeDi Cache entries:   ${initialStats.nediCache?.entries?.length || 0}`);
    }
  }

  // Benchmark endpoints
  console.log('\n--- ENDPOINT BENCHMARKS ---');

  // Map endpoints to test
  const endpoints = {
    '/api/map-db': '/api/map-db',
    '/api/map-nedi': '/api/map-nedi',
  };

  for (const [name, endpoint] of Object.entries(endpoints)) {
    results.endpoints[name] = await benchmarkEndpoint(name, endpoint);
  }

  // Test cache invalidation
  console.log('\n--- CACHE INVALIDATION TESTS ---');
  results.invalidation = await testCacheInvalidation();

  // Calculate summary
  results.summary = calculateSummary(results.endpoints);

  // Get final cache stats
  console.log('\n--- FINAL CACHE STATE ---');
  const finalStats = await getCacheStats();
  if (finalStats) {
    console.log(`  MapCache entries:     ${finalStats.mapCache?.size || 0}`);
    console.log(`  DB Cache entries:     ${finalStats.databaseQueryCache?.entries?.length || 0}`);
    console.log(`  DB Cache hit rate:    ${((finalStats.databaseQueryCache?.hitRate || 0) * 100).toFixed(1)}%`);
    console.log(`  DB Cache memory:      ${formatBytes((finalStats.databaseQueryCache?.memoryEstimateKB || 0) * 1024)}`);
    if (finalStats.nediCache) {
      console.log(`  NeDi Cache entries:   ${finalStats.nediCache?.entries?.length || 0}`);
      console.log(`  NeDi Cache hit rate:  ${((finalStats.nediCache?.hitRate || 0) * 100).toFixed(1)}%`);
    }
  }

  // Print final report
  printReport(results);

  // Exit with appropriate code
  const passed = results.summary.meetsTarget &&
                 results.invalidation.dbCache?.passed &&
                 results.invalidation.mapCache?.passed;
  process.exit(passed ? 0 : 1);
}

// Run benchmark
main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
