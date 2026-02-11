/**
 * Cache Endpoints Test Script
 *
 * This script tests all cached endpoints to verify CACHE HIT/MISS behavior.
 * It requires the server to be running on localhost:4000.
 *
 * Usage: node test-cache-endpoints.js
 *
 * Prerequisites:
 * - Server must be running (npm run dev)
 * - Database must have at least one device
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:4000';

// Helper function to make HTTP requests
async function fetchJSON(url) {
  const response = await fetch(url);
  const data = await response.json();
  return { status: response.status, data };
}

// Helper to wait for specified milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Color codes for terminal output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTestResult(testName, passed, details = '') {
  const status = passed ? `${colors.green}✓ PASS${colors.reset}` : `${colors.red}✗ FAIL${colors.reset}`;
  console.log(`  ${status} - ${testName}${details ? ` (${details})` : ''}`);
}

// Test results tracking
const testResults = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: []
};

function recordTest(name, passed, details = '') {
  testResults.tests.push({ name, passed, details });
  if (passed) testResults.passed++;
  else testResults.failed++;
  logTestResult(name, passed, details);
}

// Main test function
async function runTests() {
  log('\n========================================', 'bold');
  log('  CACHE ENDPOINTS TEST SUITE', 'bold');
  log('========================================\n', 'bold');

  // Check if server is running
  try {
    await fetchJSON(`${BASE_URL}/api/health`);
    log('Server is running on port 4000\n', 'green');
  } catch (error) {
    log('ERROR: Server is not running. Please start the server first with: npm run dev\n', 'red');
    process.exit(1);
  }

  // Get a sample device IP for testing device-specific endpoints
  let sampleDeviceIP = null;
  try {
    const { data } = await fetchJSON(`${BASE_URL}/api/devices`);
    if (data.devices && data.devices.length > 0) {
      sampleDeviceIP = data.devices[0].ip || data.devices[0].ip_address;
      log(`Using sample device IP: ${sampleDeviceIP}\n`, 'blue');
    }
  } catch (error) {
    log('WARNING: Could not fetch devices list. Device-specific tests will be skipped.\n', 'yellow');
  }

  // ========================================
  // Test 1: Cache Stats Endpoint
  // ========================================
  log('--- Test 1: Cache Stats Endpoint ---', 'yellow');

  try {
    const { status, data } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
    const hasMapCache = data.mapCache !== undefined;
    const hasDeviceCache = data.deviceCache !== undefined;
    const hasTimestamp = data.timestamp !== undefined;

    recordTest('Cache stats returns mapCache', hasMapCache);
    recordTest('Cache stats returns deviceCache', hasDeviceCache);
    recordTest('Cache stats returns timestamp', hasTimestamp);

    if (hasMapCache) {
      recordTest('mapCache has size property', data.mapCache.size !== undefined);
      recordTest('mapCache has ttlMs property', data.mapCache.ttlMs !== undefined);
    }

    if (hasDeviceCache) {
      recordTest('deviceCache has size property', data.deviceCache.size !== undefined);
      recordTest('deviceCache has ttlMs property', data.deviceCache.ttlMs !== undefined);
    }

    log(`  Initial cache stats: mapCache.size=${data.mapCache?.size}, deviceCache.size=${data.deviceCache?.size}`, 'blue');
  } catch (error) {
    recordTest('Cache stats endpoint accessible', false, error.message);
  }

  console.log('');

  // ========================================
  // Test 2: GET /api/devices - Cache HIT/MISS
  // ========================================
  log('--- Test 2: GET /api/devices Caching ---', 'yellow');

  try {
    // Get initial cache stats
    const { data: statsBefore } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
    const sizeBefore = statsBefore.deviceCache?.size || 0;

    // First request - should be CACHE MISS
    const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices`);
    recordTest('/api/devices - First request succeeds', status1 === 200);

    // Check cache size increased
    const { data: statsAfter1 } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
    const sizeAfter1 = statsAfter1.deviceCache?.size || 0;
    recordTest('/api/devices - Cache populated after first request', sizeAfter1 > sizeBefore);

    // Second request - should be CACHE HIT
    const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices`);
    recordTest('/api/devices - Second request succeeds', status2 === 200);
    recordTest('/api/devices - Same data returned on cache hit', JSON.stringify(data1) === JSON.stringify(data2));

  } catch (error) {
    recordTest('/api/devices endpoint test', false, error.message);
  }

  console.log('');

  // ========================================
  // Test 3: Device-specific endpoints (if sample device available)
  // ========================================
  if (sampleDeviceIP) {
    // Test GET /api/devices/:ip
    log('--- Test 3: GET /api/devices/:ip Caching ---', 'yellow');
    try {
      const { data: statsBefore } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
      const sizeBefore = statsBefore.deviceCache?.size || 0;

      const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}`);

      if (status1 === 200) {
        recordTest('/api/devices/:ip - First request succeeds', true);

        const { data: statsAfter } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
        const sizeAfter = statsAfter.deviceCache?.size || 0;
        recordTest('/api/devices/:ip - Cache entry created', sizeAfter > sizeBefore);

        const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}`);
        recordTest('/api/devices/:ip - Second request succeeds', status2 === 200);
        recordTest('/api/devices/:ip - Same data on cache hit', JSON.stringify(data1) === JSON.stringify(data2));
      } else if (status1 === 404) {
        log('  Device not found (404) - test skipped', 'yellow');
        testResults.skipped++;
      }
    } catch (error) {
      recordTest('/api/devices/:ip endpoint test', false, error.message);
    }

    console.log('');

    // Test GET /api/devices/:ip/summary
    log('--- Test 4: GET /api/devices/:ip/summary Caching ---', 'yellow');
    try {
      const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/summary`);

      if (status1 === 200) {
        recordTest('/api/devices/:ip/summary - First request succeeds', true);

        const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/summary`);
        recordTest('/api/devices/:ip/summary - Second request succeeds', status2 === 200);
        recordTest('/api/devices/:ip/summary - Same data on cache hit', JSON.stringify(data1) === JSON.stringify(data2));
      } else if (status1 === 404) {
        log('  Device not found (404) - test skipped', 'yellow');
        testResults.skipped++;
      }
    } catch (error) {
      recordTest('/api/devices/:ip/summary endpoint test', false, error.message);
    }

    console.log('');

    // Test GET /api/devices/:ip/port-stats
    log('--- Test 5: GET /api/devices/:ip/port-stats Caching ---', 'yellow');
    try {
      const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/port-stats`);

      if (status1 === 200) {
        recordTest('/api/devices/:ip/port-stats - First request succeeds', true);

        const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/port-stats`);
        recordTest('/api/devices/:ip/port-stats - Second request succeeds', status2 === 200);
        recordTest('/api/devices/:ip/port-stats - Same data on cache hit', JSON.stringify(data1) === JSON.stringify(data2));
      } else if (status1 === 404) {
        log('  Device not found (404) - test skipped', 'yellow');
        testResults.skipped++;
      }
    } catch (error) {
      recordTest('/api/devices/:ip/port-stats endpoint test', false, error.message);
    }

    console.log('');

    // Test GET /api/devices/:ip/addresses
    log('--- Test 6: GET /api/devices/:ip/addresses Caching ---', 'yellow');
    try {
      const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/addresses`);

      if (status1 === 200) {
        recordTest('/api/devices/:ip/addresses - First request succeeds', true);

        const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/addresses`);
        recordTest('/api/devices/:ip/addresses - Second request succeeds', status2 === 200);
        recordTest('/api/devices/:ip/addresses - Same data on cache hit', JSON.stringify(data1) === JSON.stringify(data2));
      } else if (status1 === 404) {
        log('  Device not found (404) - test skipped', 'yellow');
        testResults.skipped++;
      }
    } catch (error) {
      recordTest('/api/devices/:ip/addresses endpoint test', false, error.message);
    }

    console.log('');

    // Test GET /api/devices/:ip/vlans
    log('--- Test 7: GET /api/devices/:ip/vlans Caching ---', 'yellow');
    try {
      const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/vlans`);

      if (status1 === 200) {
        recordTest('/api/devices/:ip/vlans - First request succeeds', true);

        const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/vlans`);
        recordTest('/api/devices/:ip/vlans - Second request succeeds', status2 === 200);
        recordTest('/api/devices/:ip/vlans - Same data on cache hit', JSON.stringify(data1) === JSON.stringify(data2));
      } else if (status1 === 404) {
        log('  Device not found (404) - test skipped', 'yellow');
        testResults.skipped++;
      }
    } catch (error) {
      recordTest('/api/devices/:ip/vlans endpoint test', false, error.message);
    }

    console.log('');

    // Test GET /api/devices/:ip/lags
    log('--- Test 8: GET /api/devices/:ip/lags Caching ---', 'yellow');
    try {
      const { status: status1, data: data1 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/lags`);

      if (status1 === 200) {
        recordTest('/api/devices/:ip/lags - First request succeeds', true);

        const { status: status2, data: data2 } = await fetchJSON(`${BASE_URL}/api/devices/${sampleDeviceIP}/lags`);
        recordTest('/api/devices/:ip/lags - Second request succeeds', status2 === 200);
        recordTest('/api/devices/:ip/lags - Same data on cache hit', JSON.stringify(data1) === JSON.stringify(data2));
      } else if (status1 === 404) {
        log('  Device not found (404) - test skipped', 'yellow');
        testResults.skipped++;
      }
    } catch (error) {
      recordTest('/api/devices/:ip/lags endpoint test', false, error.message);
    }

    console.log('');
  } else {
    log('--- Device-specific endpoint tests skipped (no devices in DB) ---', 'yellow');
    testResults.skipped += 6; // 6 device-specific endpoint groups
  }

  // ========================================
  // Test 9: 404 responses are NOT cached
  // ========================================
  log('--- Test 9: 404 Responses Not Cached ---', 'yellow');
  try {
    const fakeIP = '192.0.2.1'; // Reserved IP for documentation, won't exist

    // Get cache size before
    const { data: statsBefore } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
    const sizeBefore = statsBefore.deviceCache?.size || 0;

    // Request non-existent device
    const { status } = await fetchJSON(`${BASE_URL}/api/devices/${fakeIP}`);
    recordTest('Non-existent device returns 404', status === 404);

    // Check cache size didn't increase for 404
    const { data: statsAfter } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
    const sizeAfter = statsAfter.deviceCache?.size || 0;
    recordTest('404 response not cached (size unchanged)', sizeAfter === sizeBefore);

  } catch (error) {
    recordTest('404 not cached test', false, error.message);
  }

  console.log('');

  // ========================================
  // Test 10: Final Cache Stats Summary
  // ========================================
  log('--- Test 10: Final Cache Stats ---', 'yellow');
  try {
    const { data } = await fetchJSON(`${BASE_URL}/api/cache/stats`);
    log(`  mapCache: size=${data.mapCache?.size}, ttlMs=${data.mapCache?.ttlMs}`, 'blue');
    log(`  deviceCache: size=${data.deviceCache?.size}, ttlMs=${data.deviceCache?.ttlMs}`, 'blue');
    recordTest('Final cache stats accessible', true);
  } catch (error) {
    recordTest('Final cache stats', false, error.message);
  }

  // ========================================
  // Summary
  // ========================================
  console.log('\n========================================');
  log('  TEST SUMMARY', 'bold');
  console.log('========================================');
  log(`  Passed:  ${testResults.passed}`, 'green');
  if (testResults.failed > 0) {
    log(`  Failed:  ${testResults.failed}`, 'red');
  }
  if (testResults.skipped > 0) {
    log(`  Skipped: ${testResults.skipped}`, 'yellow');
  }
  console.log('========================================\n');

  // Exit with appropriate code
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Test suite error:', error);
  process.exit(1);
});
