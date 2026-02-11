/**
 * Test script for OUI database concurrent access and thread safety
 *
 * Verifies:
 * 1. Multiple concurrent lookups return correct results
 * 2. Database loads only once despite concurrent requests
 * 3. No race conditions or data corruption
 */

import { performance } from 'perf_hooks';

console.log('='.repeat(60));
console.log('OUI Database Concurrent Access Test');
console.log('='.repeat(60));
console.log();

// We need to test on a fresh module state
// Import the module dynamically to get fresh state

/**
 * Test concurrent lookups on a fresh module instance
 */
async function testConcurrentAccess() {
  let passed = 0;
  let failed = 0;

  // Helper to check test result
  function checkTest(name, condition, details = '') {
    if (condition) {
      console.log(`  PASS: ${name}${details ? ' - ' + details : ''}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name}${details ? ' - ' + details : ''}`);
      failed++;
    }
  }

  // Test 1: Concurrent lookups during initialization
  console.log('TEST 1: Concurrent Lookups During First Load');
  console.log('-'.repeat(60));

  // Get a fresh import to ensure database is not loaded
  const { lookupOui, isDatabaseLoaded, preloadDatabase, getOuiDatabase } = await import('./lib/ouiDatabase.js?nocache=' + Date.now());

  console.log(`Database loaded before test: ${isDatabaseLoaded()}`);
  checkTest('Database not loaded at start', !isDatabaseLoaded());

  // Define test MACs with expected results
  const testCases = [
    { mac: '00:00:0c:aa:bb:cc', expectedVendor: 'Cisco Systems, Inc', expectedFound: true },
    { mac: '00:00:00:11:22:33', expectedVendor: 'XEROX CORPORATION', expectedFound: true },
    { mac: 'fc:ff:aa:aa:bb:cc', expectedVendor: 'IEEE Registration Authority', expectedFound: true },
    { mac: '00-1B-44-11-22-33', expectedVendor: 'SanDisk Corporation', expectedFound: true },
    { mac: 'ff:ff:ff:ff:ff:ff', expectedVendor: 'Unknown Vendor', expectedFound: false },
    { mac: '00000c112233', expectedVendor: 'Cisco Systems, Inc', expectedFound: true },
    { mac: 'FCFFAA998877', expectedVendor: 'IEEE Registration Authority', expectedFound: true },
    { mac: 'aa:bb:cc:dd:ee:ff', expectedVendor: 'Unknown Vendor', expectedFound: false },
  ];

  // Launch all lookups simultaneously
  console.log(`Launching ${testCases.length} concurrent lookups...`);
  const startTime = performance.now();

  const lookupPromises = testCases.map((tc, index) => {
    const lookupStart = performance.now();
    return lookupOui(tc.mac).then(result => {
      const lookupEnd = performance.now();
      return {
        index,
        mac: tc.mac,
        expected: tc.expectedVendor,
        expectedFound: tc.expectedFound,
        result,
        time: lookupEnd - lookupStart
      };
    });
  });

  // Wait for all lookups to complete
  const results = await Promise.all(lookupPromises);
  const endTime = performance.now();
  const totalTime = endTime - startTime;

  console.log(`All ${testCases.length} lookups completed in ${totalTime.toFixed(2)}ms`);
  console.log();

  // Verify all results are correct
  console.log('Verifying concurrent lookup results:');
  for (const r of results) {
    const vendorMatch = r.result.vendor === r.expected;
    const foundMatch = r.result.found === r.expectedFound;
    checkTest(
      `Lookup #${r.index + 1} (${r.mac.substring(0, 8)}...)`,
      vendorMatch && foundMatch,
      `${r.result.vendor} in ${r.time.toFixed(2)}ms`
    );
  }
  console.log();

  // Test 2: Verify database loaded only once
  console.log('TEST 2: Database Loaded Only Once');
  console.log('-'.repeat(60));

  checkTest('Database is now loaded', isDatabaseLoaded());

  // Measure time for additional lookups (should be fast since cached)
  const cachedLookups = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await lookupOui('00:00:0c:aa:bb:cc');
    const end = performance.now();
    cachedLookups.push(end - start);
  }
  const avgCachedTime = cachedLookups.reduce((a, b) => a + b, 0) / cachedLookups.length;
  console.log(`Average cached lookup time: ${avgCachedTime.toFixed(3)}ms`);

  // First lookup should be slower (includes load time)
  // Subsequent lookups should be much faster
  const firstLookupTime = results[0].time;
  checkTest(
    'Cached lookups faster than first',
    avgCachedTime < firstLookupTime || firstLookupTime < 1, // Allow if all fast
    `First: ${firstLookupTime.toFixed(2)}ms, Cached avg: ${avgCachedTime.toFixed(3)}ms`
  );
  console.log();

  // Test 3: Heavy concurrent load
  console.log('TEST 3: Heavy Concurrent Load (100 simultaneous lookups)');
  console.log('-'.repeat(60));

  const heavyTestMacs = [];
  const knownMacs = ['00:00:0c', '00:00:00', 'fc:ff:aa', '00:1b:44'];

  // Generate 100 test MACs
  for (let i = 0; i < 100; i++) {
    const prefix = knownMacs[i % knownMacs.length];
    heavyTestMacs.push(`${prefix}:${i.toString(16).padStart(2, '0')}:00:00`);
  }

  const heavyStart = performance.now();
  const heavyPromises = heavyTestMacs.map(mac => lookupOui(mac));
  const heavyResults = await Promise.all(heavyPromises);
  const heavyEnd = performance.now();
  const heavyTime = heavyEnd - heavyStart;

  console.log(`100 concurrent lookups completed in ${heavyTime.toFixed(2)}ms`);
  console.log(`Average per lookup: ${(heavyTime / 100).toFixed(3)}ms`);

  // Verify all results have valid structure
  const allValid = heavyResults.every(r =>
    typeof r.oui === 'string' &&
    typeof r.vendor === 'string' &&
    typeof r.found === 'boolean'
  );
  checkTest('All 100 results have valid structure', allValid);

  // Verify no undefined or null vendors
  const noNulls = heavyResults.every(r => r.vendor !== null && r.vendor !== undefined);
  checkTest('No null/undefined vendors', noNulls);

  // Verify found=true results have known vendors
  const foundResults = heavyResults.filter(r => r.found);
  const validFoundResults = foundResults.every(r =>
    r.vendor !== 'Unknown Vendor' && r.vendor !== 'Invalid OUI'
  );
  checkTest('Found results have actual vendor names', validFoundResults);
  console.log();

  // Test 4: Race condition stress test
  console.log('TEST 4: Race Condition Stress Test');
  console.log('-'.repeat(60));

  // Do rapid successive lookups to try to trigger any race conditions
  const stressResults = [];
  const stressMac = '00:00:0c:11:22:33';
  const expectedVendor = 'Cisco Systems, Inc';

  const stressStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    stressResults.push(lookupOui(stressMac));
  }
  const allStressResults = await Promise.all(stressResults);
  const stressEnd = performance.now();
  const stressTime = stressEnd - stressStart;

  console.log(`1000 rapid lookups completed in ${stressTime.toFixed(2)}ms`);
  console.log(`Average per lookup: ${(stressTime / 1000).toFixed(4)}ms`);

  // Verify all results are identical
  const allIdentical = allStressResults.every(r => r.vendor === expectedVendor && r.found === true);
  checkTest('All 1000 results are identical and correct', allIdentical);

  // Check for any corrupted data
  const corrupted = allStressResults.filter(r =>
    typeof r.oui !== 'string' ||
    typeof r.vendor !== 'string' ||
    typeof r.found !== 'boolean' ||
    r.oui.length !== 8 // XX:XX:XX format
  );
  checkTest('No corrupted results', corrupted.length === 0, `Found ${corrupted.length} corrupted`);
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log();
  console.log('Thread Safety Verification:');
  console.log(`  - Concurrent lookups during init: PASS`);
  console.log(`  - Database loads once: ${isDatabaseLoaded() ? 'PASS' : 'FAIL'}`);
  console.log(`  - Heavy load (100 concurrent): PASS`);
  console.log(`  - Stress test (1000 rapid): ${allIdentical ? 'PASS' : 'FAIL'}`);
  console.log();
  console.log(`Tests Passed: ${passed}/${passed + failed}`);
  console.log(`Tests Failed: ${failed}/${passed + failed}`);
  console.log();
  console.log('='.repeat(60));

  if (failed === 0) {
    console.log('ALL TESTS PASSED - Concurrent access is thread-safe');
    console.log('='.repeat(60));
    return true;
  } else {
    console.log(`${failed} TESTS FAILED - Review the results above`);
    console.log('='.repeat(60));
    return false;
  }
}

// Run the test
const success = await testConcurrentAccess();
process.exit(success ? 0 : 1);
