/**
 * Test script for OUI database lazy-loading performance
 *
 * Verifies:
 * 1. Server module import does NOT load OUI database
 * 2. Startup time is reduced by not loading 1.4MB database upfront
 * 3. Database loads only on first use
 * 4. Subsequent lookups use cached database
 */

import { performance } from 'perf_hooks';

console.log('='.repeat(60));
console.log('OUI Database Lazy Loading Performance Test');
console.log('='.repeat(60));
console.log();

// Test 1: Measure module import time without loading database
console.log('TEST 1: Module Import Time (without loading database)');
console.log('-'.repeat(60));

const importStart = performance.now();
const { lookupOui, isDatabaseLoaded, preloadDatabase } = await import('./lib/ouiDatabase.js');
const importEnd = performance.now();
const importTime = importEnd - importStart;

console.log(`Module import time: ${importTime.toFixed(2)}ms`);
console.log(`Database loaded at import: ${isDatabaseLoaded()}`);

if (isDatabaseLoaded()) {
  console.log('FAIL: Database should NOT be loaded at import time');
  process.exit(1);
} else {
  console.log('PASS: Database is NOT loaded at import time');
}
console.log();

// Test 2: Verify memory before first use
console.log('TEST 2: Memory Usage Before First OUI Lookup');
console.log('-'.repeat(60));

const memBefore = process.memoryUsage();
console.log(`Heap used before lookup: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`RSS before lookup: ${(memBefore.rss / 1024 / 1024).toFixed(2)} MB`);
console.log();

// Test 3: Measure first lookup time (triggers database load)
console.log('TEST 3: First OUI Lookup (triggers database load)');
console.log('-'.repeat(60));

const firstLookupStart = performance.now();
const result1 = await lookupOui('00:00:0c:aa:bb:cc'); // Cisco
const firstLookupEnd = performance.now();
const firstLookupTime = firstLookupEnd - firstLookupStart;

console.log(`First lookup time: ${firstLookupTime.toFixed(2)}ms`);
console.log(`Lookup result: ${JSON.stringify(result1)}`);
console.log(`Database loaded after first lookup: ${isDatabaseLoaded()}`);

if (!isDatabaseLoaded()) {
  console.log('FAIL: Database should be loaded after first lookup');
  process.exit(1);
} else {
  console.log('PASS: Database is loaded after first lookup');
}
console.log();

// Test 4: Memory after database load
console.log('TEST 4: Memory Usage After Database Load');
console.log('-'.repeat(60));

const memAfter = process.memoryUsage();
console.log(`Heap used after lookup: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`RSS after lookup: ${(memAfter.rss / 1024 / 1024).toFixed(2)} MB`);
console.log(`Heap increase: ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
console.log();

// Test 5: Subsequent lookup time (cached database)
console.log('TEST 5: Subsequent OUI Lookups (cached database)');
console.log('-'.repeat(60));

const lookupTimes = [];
const testMacs = [
  '00:00:00:aa:bb:cc', // XEROX
  'fc:ff:aa:11:22:33', // IEEE Registration Authority
  '00:1a:2b:cc:dd:ee', // Unknown
  'aa:bb:cc:dd:ee:ff', // Unknown
];

for (const mac of testMacs) {
  const start = performance.now();
  const result = await lookupOui(mac);
  const end = performance.now();
  const time = end - start;
  lookupTimes.push(time);
  console.log(`  ${mac}: ${time.toFixed(3)}ms -> ${result.vendor}`);
}

const avgLookupTime = lookupTimes.reduce((a, b) => a + b, 0) / lookupTimes.length;
console.log(`Average cached lookup time: ${avgLookupTime.toFixed(3)}ms`);
console.log();

// Summary
console.log('='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log();
console.log('Performance Metrics:');
console.log(`  - Module import time: ${importTime.toFixed(2)}ms`);
console.log(`  - First lookup (with DB load): ${firstLookupTime.toFixed(2)}ms`);
console.log(`  - Avg cached lookup: ${avgLookupTime.toFixed(3)}ms`);
console.log(`  - Memory for OUI database: ~${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
console.log();
console.log('Lazy Loading Verification:');
console.log(`  - Database NOT loaded at import: ${!isDatabaseLoaded() ? 'N/A (already loaded)' : 'PASS'}`);
console.log(`  - Database loaded on first use: ${isDatabaseLoaded() ? 'PASS' : 'FAIL'}`);
console.log();

// Compare with expected startup improvement
const expectedStartupSavings = firstLookupTime; // Savings if OUI not used
console.log('Startup Improvement Analysis:');
console.log(`  - Estimated startup savings when OUI not used: ${expectedStartupSavings.toFixed(2)}ms`);
console.log(`  - Memory savings when OUI not used: ~${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
console.log();

// Final verdict
const allPassed = isDatabaseLoaded() && importTime < firstLookupTime;
console.log('='.repeat(60));
if (allPassed) {
  console.log('ALL TESTS PASSED - Lazy loading is working correctly');
} else {
  console.log('SOME TESTS FAILED - Review the results above');
}
console.log('='.repeat(60));

process.exit(allPassed ? 0 : 1);
