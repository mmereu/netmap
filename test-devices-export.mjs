#!/usr/bin/env node

/**
 * Test endpoint GET /api/devices/export
 *
 * Tests:
 * 1. JSON export format
 * 2. CSV export format
 * 3. Error handling for invalid fmt parameter
 * 4. Verifies exported files are created correctly
 *
 * Uso:
 *   node test-devices-export.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3000;
const HOST = 'localhost';

let testsRun = 0;
let testsPassed = 0;

/**
 * Make an HTTP GET request and return a promise
 */
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: urlPath,
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
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Test JSON export format
 */
async function testJsonExport() {
  testsRun++;
  const testName = 'JSON Export';

  try {
    const response = await httpGet('/api/devices/export?fmt=json');

    if (response.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${response.statusCode}`);
    }

    const json = JSON.parse(response.body);

    // Verify response structure
    if (!json.success) {
      throw new Error('Response should have success: true');
    }
    if (!json.file) {
      throw new Error('Response should include file path');
    }
    if (!json.timestamp) {
      throw new Error('Response should include timestamp');
    }

    // Verify file was created
    if (!fs.existsSync(json.file)) {
      throw new Error(`Exported file not found: ${json.file}`);
    }

    // Verify file content
    const fileContent = fs.readFileSync(json.file, 'utf8');
    const exportData = JSON.parse(fileContent);

    if (!exportData.metadata) {
      throw new Error('JSON export should have metadata');
    }
    if (typeof exportData.metadata.count !== 'number') {
      throw new Error('Metadata should have count as number');
    }
    if (!exportData.metadata.exportDate) {
      throw new Error('Metadata should have exportDate');
    }
    if (!Array.isArray(exportData.devices)) {
      throw new Error('Export should have devices array');
    }

    testsPassed++;
    return { success: true, testName, file: json.file, deviceCount: exportData.metadata.count };

  } catch (err) {
    return { success: false, testName, error: err.message };
  }
}

/**
 * Test CSV export format
 */
async function testCsvExport() {
  testsRun++;
  const testName = 'CSV Export';

  try {
    const response = await httpGet('/api/devices/export?fmt=csv');

    if (response.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${response.statusCode}`);
    }

    const json = JSON.parse(response.body);

    // Verify response structure
    if (!json.success) {
      throw new Error('Response should have success: true');
    }
    if (!json.file) {
      throw new Error('Response should include file path');
    }
    if (!json.timestamp) {
      throw new Error('Response should include timestamp');
    }

    // Verify file was created
    if (!fs.existsSync(json.file)) {
      throw new Error(`Exported file not found: ${json.file}`);
    }

    // Verify file content
    const fileContent = fs.readFileSync(json.file, 'utf8');
    const lines = fileContent.split('\n');

    if (lines.length === 0) {
      throw new Error('CSV file should not be empty');
    }

    // Verify headers
    const expectedHeaders = ['ip', 'sysname', 'sysdesc', 'vendor', 'model', 'os', 'serial', 'status', 'syslocation', 'lastseen'];
    const actualHeaders = lines[0].split(',');

    if (actualHeaders.length !== expectedHeaders.length) {
      throw new Error(`Expected ${expectedHeaders.length} headers, got ${actualHeaders.length}`);
    }

    for (let i = 0; i < expectedHeaders.length; i++) {
      if (actualHeaders[i] !== expectedHeaders[i]) {
        throw new Error(`Header mismatch at position ${i}: expected "${expectedHeaders[i]}", got "${actualHeaders[i]}"`);
      }
    }

    testsPassed++;
    const dataRows = lines.filter(line => line.trim()).length - 1; // subtract header row
    return { success: true, testName, file: json.file, dataRows };

  } catch (err) {
    return { success: false, testName, error: err.message };
  }
}

/**
 * Test error handling for missing fmt parameter
 */
async function testMissingFmt() {
  testsRun++;
  const testName = 'Missing fmt Parameter';

  try {
    const response = await httpGet('/api/devices/export');

    if (response.statusCode !== 400) {
      throw new Error(`Expected status 400, got ${response.statusCode}`);
    }

    const json = JSON.parse(response.body);

    if (!json.error) {
      throw new Error('Error response should have error field');
    }

    testsPassed++;
    return { success: true, testName, errorMessage: json.error };

  } catch (err) {
    return { success: false, testName, error: err.message };
  }
}

/**
 * Test error handling for invalid fmt parameter
 */
async function testInvalidFmt() {
  testsRun++;
  const testName = 'Invalid fmt Parameter';

  try {
    const response = await httpGet('/api/devices/export?fmt=xml');

    if (response.statusCode !== 400) {
      throw new Error(`Expected status 400, got ${response.statusCode}`);
    }

    const json = JSON.parse(response.body);

    if (!json.error) {
      throw new Error('Error response should have error field');
    }

    testsPassed++;
    return { success: true, testName, errorMessage: json.error };

  } catch (err) {
    return { success: false, testName, error: err.message };
  }
}

/**
 * Test custom filename parameter
 */
async function testCustomFilename() {
  testsRun++;
  const testName = 'Custom Filename';
  const customFilename = `test-export-${Date.now()}.json`;

  try {
    const response = await httpGet(`/api/devices/export?fmt=json&filename=${customFilename}`);

    if (response.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${response.statusCode}`);
    }

    const json = JSON.parse(response.body);

    if (!json.file.includes(customFilename)) {
      throw new Error(`File path should include custom filename: ${customFilename}`);
    }

    // Verify file was created
    if (!fs.existsSync(json.file)) {
      throw new Error(`Exported file not found: ${json.file}`);
    }

    testsPassed++;
    return { success: true, testName, file: json.file };

  } catch (err) {
    return { success: false, testName, error: err.message };
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('  Test: GET /api/devices/export');
  console.log('='.repeat(60) + '\n');

  const results = [];

  // Test 1: JSON export
  console.log('1. Testing JSON export format...');
  const jsonResult = await testJsonExport();
  results.push(jsonResult);
  if (jsonResult.success) {
    console.log(`   ${'\u2713'} JSON export successful`);
    console.log(`     File: ${jsonResult.file}`);
    console.log(`     Devices: ${jsonResult.deviceCount}`);
  } else {
    console.log(`   ${'\u2717'} JSON export failed: ${jsonResult.error}`);
  }

  // Test 2: CSV export
  console.log('\n2. Testing CSV export format...');
  const csvResult = await testCsvExport();
  results.push(csvResult);
  if (csvResult.success) {
    console.log(`   ${'\u2713'} CSV export successful`);
    console.log(`     File: ${csvResult.file}`);
    console.log(`     Data rows: ${csvResult.dataRows}`);
  } else {
    console.log(`   ${'\u2717'} CSV export failed: ${csvResult.error}`);
  }

  // Test 3: Missing fmt parameter
  console.log('\n3. Testing error handling (missing fmt)...');
  const missingFmtResult = await testMissingFmt();
  results.push(missingFmtResult);
  if (missingFmtResult.success) {
    console.log(`   ${'\u2713'} Correct error returned: "${missingFmtResult.errorMessage}"`);
  } else {
    console.log(`   ${'\u2717'} Error handling failed: ${missingFmtResult.error}`);
  }

  // Test 4: Invalid fmt parameter
  console.log('\n4. Testing error handling (invalid fmt=xml)...');
  const invalidFmtResult = await testInvalidFmt();
  results.push(invalidFmtResult);
  if (invalidFmtResult.success) {
    console.log(`   ${'\u2713'} Correct error returned: "${invalidFmtResult.errorMessage}"`);
  } else {
    console.log(`   ${'\u2717'} Error handling failed: ${invalidFmtResult.error}`);
  }

  // Test 5: Custom filename
  console.log('\n5. Testing custom filename parameter...');
  const customFilenameResult = await testCustomFilename();
  results.push(customFilenameResult);
  if (customFilenameResult.success) {
    console.log(`   ${'\u2713'} Custom filename successful`);
    console.log(`     File: ${customFilenameResult.file}`);
  } else {
    console.log(`   ${'\u2717'} Custom filename failed: ${customFilenameResult.error}`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${testsPassed}/${testsRun} tests passed`);
  console.log('='.repeat(60) + '\n');

  if (testsPassed === testsRun) {
    console.log('All tests completed successfully!\n');
    process.exit(0);
  } else {
    console.log('Some tests failed. Check output above for details.\n');
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('\nFatal error during tests:', err.message);
  console.error('\nMake sure the server is running on http://localhost:3000');
  process.exit(1);
});
