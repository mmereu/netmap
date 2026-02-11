/**
 * Benchmark script for huaweiLldpParser.js
 *
 * Measures parser performance before and after optimizations.
 * Run with: node lib/__tests__/huaweiLldpParser.bench.js
 *
 * Reports:
 * - Execution time per iteration (ms)
 * - Average execution time (ms)
 * - Operations per second (ops/sec)
 * - Min/Max execution times
 * - Standard deviation
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseHuaweiLldpNeighbors } from '../huaweiLldpParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Benchmark configuration
const CONFIG = {
  warmupIterations: 10,     // Warm-up runs (not counted)
  benchmarkIterations: 100, // Actual benchmark runs
  showProgress: true        // Show progress during benchmark
};

/**
 * Load test fixture from file
 * @param {string} filename - Fixture filename
 * @returns {string} File contents
 */
function loadFixture(filename) {
  const fixturePath = join(__dirname, 'fixtures', filename);
  return readFileSync(fixturePath, 'utf-8');
}

/**
 * Calculate statistics from timing array
 * @param {number[]} times - Array of execution times in ms
 * @returns {object} Statistics object
 */
function calculateStats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const avg = sum / times.length;

  // Standard deviation
  const squaredDiffs = times.map(t => Math.pow(t - avg, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / times.length;
  const stdDev = Math.sqrt(avgSquaredDiff);

  // Percentiles
  const p50Index = Math.floor(times.length * 0.5);
  const p95Index = Math.floor(times.length * 0.95);
  const p99Index = Math.floor(times.length * 0.99);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: avg,
    median: sorted[p50Index],
    p95: sorted[p95Index],
    p99: sorted[p99Index],
    stdDev: stdDev,
    opsPerSec: 1000 / avg,
    totalTime: sum,
    iterations: times.length
  };
}

/**
 * Run a single benchmark
 * @param {string} name - Benchmark name
 * @param {string} input - Input data to parse
 * @param {number} warmupIterations - Number of warmup runs
 * @param {number} benchmarkIterations - Number of benchmark runs
 * @returns {object} Benchmark results
 */
function runBenchmark(name, input, warmupIterations, benchmarkIterations) {
  const times = [];
  let result = null;

  // Warm-up phase (allows JIT optimization)
  for (let i = 0; i < warmupIterations; i++) {
    parseHuaweiLldpNeighbors(input);
  }

  // Benchmark phase
  for (let i = 0; i < benchmarkIterations; i++) {
    const start = performance.now();
    result = parseHuaweiLldpNeighbors(input);
    const end = performance.now();
    times.push(end - start);

    if (CONFIG.showProgress && (i + 1) % 25 === 0) {
      process.stdout.write(`\r  Progress: ${i + 1}/${benchmarkIterations}`);
    }
  }

  if (CONFIG.showProgress) {
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  const stats = calculateStats(times);
  stats.name = name;
  stats.inputLines = input.split('\n').length;
  stats.neighborsFound = result ? result.length : 0;

  return stats;
}

/**
 * Format a number with fixed decimals
 * @param {number} num - Number to format
 * @param {number} decimals - Decimal places
 * @returns {string} Formatted number
 */
function formatNumber(num, decimals = 3) {
  return num.toFixed(decimals);
}

/**
 * Print benchmark results in a formatted table
 * @param {object} stats - Statistics object
 */
function printResults(stats) {
  console.log(`\n  ${stats.name}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  Input:        ${stats.inputLines} lines`);
  console.log(`  Neighbors:    ${stats.neighborsFound} found`);
  console.log(`  Iterations:   ${stats.iterations}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  Avg time:     ${formatNumber(stats.avg)} ms`);
  console.log(`  Min time:     ${formatNumber(stats.min)} ms`);
  console.log(`  Max time:     ${formatNumber(stats.max)} ms`);
  console.log(`  Median:       ${formatNumber(stats.median)} ms`);
  console.log(`  P95:          ${formatNumber(stats.p95)} ms`);
  console.log(`  P99:          ${formatNumber(stats.p99)} ms`);
  console.log(`  Std Dev:      ${formatNumber(stats.stdDev)} ms`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  Ops/sec:      ${formatNumber(stats.opsPerSec, 1)}`);
  console.log(`  Total time:   ${formatNumber(stats.totalTime)} ms`);
}

/**
 * Print comparison between two benchmark results
 * @param {object} before - Before optimization stats
 * @param {object} after - After optimization stats
 */
function printComparison(before, after) {
  const improvement = ((before.avg - after.avg) / before.avg) * 100;
  const opsImprovement = ((after.opsPerSec - before.opsPerSec) / before.opsPerSec) * 100;

  console.log('\n  Comparison');
  console.log('  ' + '-'.repeat(50));
  console.log(`  Before avg:   ${formatNumber(before.avg)} ms`);
  console.log(`  After avg:    ${formatNumber(after.avg)} ms`);
  console.log(`  Improvement:  ${formatNumber(improvement, 1)}%`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  Before ops:   ${formatNumber(before.opsPerSec, 1)} ops/sec`);
  console.log(`  After ops:    ${formatNumber(after.opsPerSec, 1)} ops/sec`);
  console.log(`  Improvement:  ${formatNumber(opsImprovement, 1)}%`);
}

/**
 * Export results to JSON format for later comparison
 * @param {object[]} results - Array of benchmark results
 * @returns {string} JSON string
 */
function exportResults(results) {
  const exportData = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    config: CONFIG,
    results: results.map(r => ({
      name: r.name,
      inputLines: r.inputLines,
      neighborsFound: r.neighborsFound,
      iterations: r.iterations,
      avgMs: r.avg,
      minMs: r.min,
      maxMs: r.max,
      medianMs: r.median,
      p95Ms: r.p95,
      p99Ms: r.p99,
      stdDevMs: r.stdDev,
      opsPerSec: r.opsPerSec
    }))
  };
  return JSON.stringify(exportData, null, 2);
}

/**
 * Main benchmark runner
 */
async function main() {
  console.log('\n========================================');
  console.log('  Huawei LLDP Parser Benchmark');
  console.log('========================================');
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`  Warmup iterations: ${CONFIG.warmupIterations}`);
  console.log(`  Benchmark iterations: ${CONFIG.benchmarkIterations}`);

  const results = [];

  // Load test fixtures
  let detailedInput, compactInput;
  try {
    detailedInput = loadFixture('lldp-large-detailed.txt');
    compactInput = loadFixture('lldp-large-compact.txt');
  } catch (err) {
    console.error('\n  Error loading fixtures:', err.message);
    console.error('  Make sure fixture files exist in lib/__tests__/fixtures/');
    process.exit(1);
  }

  // Benchmark detailed format
  console.log('\n  Running: Detailed Format (large)...');
  const detailedStats = runBenchmark(
    'Detailed Format (large)',
    detailedInput,
    CONFIG.warmupIterations,
    CONFIG.benchmarkIterations
  );
  printResults(detailedStats);
  results.push(detailedStats);

  // Benchmark compact format
  console.log('\n  Running: Compact Format (large)...');
  const compactStats = runBenchmark(
    'Compact Format (large)',
    compactInput,
    CONFIG.warmupIterations,
    CONFIG.benchmarkIterations
  );
  printResults(compactStats);
  results.push(compactStats);

  // Summary
  console.log('\n========================================');
  console.log('  Summary');
  console.log('========================================');
  console.log(`  Detailed format: ${formatNumber(detailedStats.avg)} ms avg (${formatNumber(detailedStats.opsPerSec, 1)} ops/sec)`);
  console.log(`  Compact format:  ${formatNumber(compactStats.avg)} ms avg (${formatNumber(compactStats.opsPerSec, 1)} ops/sec)`);

  // Export results to stdout if requested
  if (process.argv.includes('--json')) {
    console.log('\n========================================');
    console.log('  JSON Export');
    console.log('========================================');
    console.log(exportResults(results));
  }

  // Save baseline if requested
  if (process.argv.includes('--save-baseline')) {
    const baselinePath = join(__dirname, 'fixtures', 'benchmark-baseline.json');
    const { writeFileSync } = await import('fs');
    writeFileSync(baselinePath, exportResults(results));
    console.log(`\n  Baseline saved to: ${baselinePath}`);
  }

  // Compare with baseline if exists
  if (process.argv.includes('--compare')) {
    try {
      const baselinePath = join(__dirname, 'fixtures', 'benchmark-baseline.json');
      const baselineData = JSON.parse(readFileSync(baselinePath, 'utf-8'));

      console.log('\n========================================');
      console.log('  Comparison with Baseline');
      console.log('========================================');
      console.log(`  Baseline from: ${baselineData.timestamp}`);

      for (const current of results) {
        const baseline = baselineData.results.find(r => r.name === current.name);
        if (baseline) {
          console.log(`\n  ${current.name}:`);
          printComparison(
            { avg: baseline.avgMs, opsPerSec: baseline.opsPerSec },
            { avg: current.avg, opsPerSec: current.opsPerSec }
          );
        }
      }
    } catch (err) {
      console.log('\n  No baseline found. Run with --save-baseline first.');
    }
  }

  console.log('\n========================================');
  console.log('  Usage');
  console.log('========================================');
  console.log('  node lib/__tests__/huaweiLldpParser.bench.js');
  console.log('  node lib/__tests__/huaweiLldpParser.bench.js --json');
  console.log('  node lib/__tests__/huaweiLldpParser.bench.js --save-baseline');
  console.log('  node lib/__tests__/huaweiLldpParser.bench.js --compare');
  console.log('');
}

// Run if executed directly
main().catch(console.error);
