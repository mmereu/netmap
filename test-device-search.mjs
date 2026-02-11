#!/usr/bin/env node

/**
 * Test endpoint GET /api/devices/search
 *
 * Tests various search scenarios with clear pass/fail output.
 *
 * Usage:
 *   node test-device-search.mjs
 *   node test-device-search.mjs --full
 */

import http from 'http';

const PORT = process.env.PORT || 4000;
const HOST = 'localhost';
const showFull = process.argv.includes('--full');

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

/**
 * Make HTTP request to the search endpoint
 * @param {Object} params - Query parameters
 * @returns {Promise<{status: number, data: Object}>}
 */
function makeRequest(params = {}) {
  return new Promise((resolve, reject) => {
    const queryString = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const path = `/api/devices/search${queryString ? '?' + queryString : ''}`;

    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          resolve({ status: res.statusCode, data: { raw: data, parseError: err.message } });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

/**
 * Run a single test case
 * @param {string} name - Test name
 * @param {Object} params - Query parameters
 * @param {Function} validate - Validation function (response) => { pass: boolean, message: string }
 */
async function runTest(name, params, validate) {
  try {
    const response = await makeRequest(params);
    const result = validate(response);

    if (result.pass) {
      results.passed++;
      results.tests.push({ name, status: 'PASS', message: result.message, response: showFull ? response : null });
      console.log(`  ✅ ${name}`);
      if (result.message) console.log(`     ${result.message}`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', message: result.message, response });
      console.log(`  ❌ ${name}`);
      console.log(`     ${result.message}`);
    }

    if (showFull && response.data) {
      console.log(`     Response: ${JSON.stringify(response.data, null, 2).split('\n').join('\n     ')}`);
    }
  } catch (err) {
    results.failed++;
    results.tests.push({ name, status: 'ERROR', message: err.message });
    console.log(`  ❌ ${name}`);
    console.log(`     Error: ${err.message}`);
  }
}

/**
 * Run all test cases
 */
async function runTests() {
  console.log(`\n🔍 Test endpoint: GET /api/devices/search\n`);
  console.log('─'.repeat(60));

  // ========================================
  // Basic Search Tests
  // ========================================
  console.log('\n📋 Basic Search Tests:');

  await runTest(
    'Search without parameters returns devices',
    {},
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      if (typeof res.data.total !== 'number') {
        return { pass: false, message: 'Response missing total field' };
      }
      if (!Array.isArray(res.data.devices)) {
        return { pass: false, message: 'Response devices should be an array' };
      }
      return { pass: true, message: `Found ${res.data.total} total devices, returned ${res.data.count}` };
    }
  );

  await runTest(
    'Search with text query (q parameter)',
    { q: 'switch' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} matching devices` };
    }
  );

  // ========================================
  // Field-Specific Search Tests
  // ========================================
  console.log('\n📋 Field-Specific Search Tests:');

  await runTest(
    'Search by sysname field',
    { q: 'test', field: 'sysname' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices matching sysname` };
    }
  );

  await runTest(
    'Search by vendor field',
    { q: 'cisco', field: 'vendor' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices matching vendor` };
    }
  );

  await runTest(
    'Search by model field',
    { q: '2960', field: 'model' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices matching model` };
    }
  );

  await runTest(
    'Search all fields (field=all)',
    { q: 'router', field: 'all' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices matching all fields` };
    }
  );

  // ========================================
  // IP Range Filtering Tests
  // ========================================
  console.log('\n📋 IP Range Filtering Tests:');

  await runTest(
    'Filter by IP range (ipStart/ipEnd)',
    { ipStart: '10.0.0.0', ipEnd: '10.255.255.255' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices in IP range` };
    }
  );

  await runTest(
    'Filter by CIDR notation',
    { cidr: '192.168.0.0/16' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices in CIDR range` };
    }
  );

  await runTest(
    'Filter by smaller CIDR (/24)',
    { cidr: '192.168.1.0/24' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices in /24 subnet` };
    }
  );

  // ========================================
  // Pagination Tests
  // ========================================
  console.log('\n📋 Pagination Tests:');

  await runTest(
    'Pagination with limit',
    { limit: 5 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      if (res.data.limit !== 5) {
        return { pass: false, message: `Expected limit 5, got ${res.data.limit}` };
      }
      if (res.data.devices.length > 5) {
        return { pass: false, message: `Expected at most 5 devices, got ${res.data.devices.length}` };
      }
      return { pass: true, message: `Returned ${res.data.count} of ${res.data.total} devices` };
    }
  );

  await runTest(
    'Pagination with offset',
    { limit: 5, offset: 5 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      if (res.data.offset !== 5) {
        return { pass: false, message: `Expected offset 5, got ${res.data.offset}` };
      }
      return { pass: true, message: `Returned ${res.data.count} devices from offset 5` };
    }
  );

  await runTest(
    'Default limit is 100',
    {},
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      if (res.data.limit !== 100) {
        return { pass: false, message: `Expected default limit 100, got ${res.data.limit}` };
      }
      return { pass: true, message: `Default limit is ${res.data.limit}` };
    }
  );

  await runTest(
    'Default offset is 0',
    {},
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      if (res.data.offset !== 0) {
        return { pass: false, message: `Expected default offset 0, got ${res.data.offset}` };
      }
      return { pass: true, message: `Default offset is ${res.data.offset}` };
    }
  );

  // ========================================
  // Combined Filters Tests
  // ========================================
  console.log('\n📋 Combined Filters Tests:');

  await runTest(
    'Combined: text search + limit',
    { q: 'switch', limit: 10 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} total, returned ${res.data.count}` };
    }
  );

  await runTest(
    'Combined: text search + status filter',
    { q: 'core', status: 'active' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} active devices matching 'core'` };
    }
  );

  await runTest(
    'Combined: text search + level filter',
    { q: 'router', level: 1 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} level-1 devices matching 'router'` };
    }
  );

  await runTest(
    'Combined: IP range + text search',
    { cidr: '10.0.0.0/8', q: 'switch' },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} switches in 10.0.0.0/8` };
    }
  );

  await runTest(
    'Combined: multiple filters',
    { q: 'core', field: 'sysname', status: 'active', limit: 20, offset: 0 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      return { pass: true, message: `Found ${res.data.total} devices with combined filters` };
    }
  );

  // ========================================
  // Invalid Parameter Tests (400 responses)
  // ========================================
  console.log('\n📋 Invalid Parameter Tests (expect 400):');

  await runTest(
    'Invalid field parameter returns 400',
    { field: 'invalid_field' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      if (!res.data.error) {
        return { pass: false, message: 'Expected error message in response' };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid limit (negative) returns 400',
    { limit: -1 },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid limit (too large) returns 400',
    { limit: 2000 },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid limit (non-numeric) returns 400',
    { limit: 'abc' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid offset (negative) returns 400',
    { offset: -5 },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid ipStart returns 400',
    { ipStart: 'not.an.ip' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid ipEnd returns 400',
    { ipEnd: 'not.an.ip.address' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid CIDR returns 400',
    { cidr: 'invalid-cidr' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid CIDR (bad prefix) returns 400',
    { cidr: '192.168.1.0/33' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  await runTest(
    'Invalid level (non-numeric) returns 400',
    { level: 'high' },
    (res) => {
      if (res.status !== 400) {
        return { pass: false, message: `Expected status 400, got ${res.status}` };
      }
      return { pass: true, message: `Error: ${res.data.error}` };
    }
  );

  // ========================================
  // Response Format Tests
  // ========================================
  console.log('\n📋 Response Format Tests:');

  await runTest(
    'Response contains required fields',
    { limit: 1 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      const requiredFields = ['total', 'limit', 'offset', 'count', 'devices'];
      const missingFields = requiredFields.filter(f => !(f in res.data));
      if (missingFields.length > 0) {
        return { pass: false, message: `Missing fields: ${missingFields.join(', ')}` };
      }
      return { pass: true, message: 'All required fields present' };
    }
  );

  await runTest(
    'Count matches devices array length',
    { limit: 10 },
    (res) => {
      if (res.status !== 200) {
        return { pass: false, message: `Expected status 200, got ${res.status}` };
      }
      if (res.data.count !== res.data.devices.length) {
        return { pass: false, message: `Count ${res.data.count} does not match devices length ${res.data.devices.length}` };
      }
      return { pass: true, message: `Count (${res.data.count}) matches devices array length` };
    }
  );

  // ========================================
  // Print Summary
  // ========================================
  console.log('\n' + '─'.repeat(60));
  console.log('\n📊 TEST SUMMARY:');
  console.log('─'.repeat(60));
  console.log(`  Total:  ${results.passed + results.failed}`);
  console.log(`  Passed: ${results.passed} ✅`);
  console.log(`  Failed: ${results.failed} ❌`);
  console.log('─'.repeat(60));

  if (results.failed === 0) {
    console.log('\n✅ All tests passed!\n');
  } else {
    console.log('\n❌ Some tests failed.\n');
    console.log('Failed tests:');
    results.tests
      .filter(t => t.status === 'FAIL' || t.status === 'ERROR')
      .forEach(t => {
        console.log(`  - ${t.name}: ${t.message}`);
      });
    console.log('');
  }

  if (!showFull) {
    console.log('💡 Use --full for complete JSON output\n');
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

// Run the tests
runTests().catch(err => {
  console.error('\n❌ Error running tests:', err.message);
  console.error(`\n⚠️  Make sure the server is running on http://localhost:${PORT}`);
  process.exit(1);
});
