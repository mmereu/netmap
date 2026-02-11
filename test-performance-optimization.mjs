#!/usr/bin/env node
/**
 * Performance Benchmark: getAllDevices() vs getDeviceLookupMaps()
 *
 * This test compares the performance of the old O(n) approach (repeated getAllDevices()
 * calls inside loops) versus the new O(1) approach (pre-built Map lookups).
 *
 * The optimization addresses the issue where each neighbor processed during discovery
 * triggered a full getAllDevices() call, causing O(n*m) complexity.
 *
 * Usage:
 *   node test-performance-optimization.mjs [devices] [neighbors_per_device]
 *
 * Examples:
 *   node test-performance-optimization.mjs 100 10    # 100 devices, 10 neighbors each
 *   node test-performance-optimization.mjs 500 20    # 500 devices, 20 neighbors each
 */

import NetMapDB from './libdb.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parameters from CLI
const numDevices = parseInt(process.argv[2]) || 200;
const neighborsPerDevice = parseInt(process.argv[3]) || 15;

console.log('='.repeat(70));
console.log('Performance Benchmark: getAllDevices() vs getDeviceLookupMaps()');
console.log('='.repeat(70));
console.log();
console.log(`Configuration:`);
console.log(`  - Simulated devices: ${numDevices}`);
console.log(`  - Neighbors per device: ${neighborsPerDevice}`);
console.log(`  - Total lookups: ${numDevices * neighborsPerDevice}`);
console.log();

// Initialize DB (use test database to not affect production)
const testDbPath = './test-performance-benchmark.db';
const db = new NetMapDB(testDbPath);

// ========== GENERATE TEST DATA ==========
console.log('Phase 1: Generating test data...');
const generateStart = Date.now();

// Generate IP address
function generateIP(index) {
  const octet2 = Math.floor(index / 65536) % 256;
  const octet3 = Math.floor(index / 256) % 256;
  const octet4 = (index % 256) || 1; // Avoid .0
  return `10.${octet2}.${octet3}.${octet4}`;
}

// Generate test devices
const testDevices = [];
for (let i = 0; i < numDevices; i++) {
  const ip = generateIP(i + 1);
  const sysname = `test_device_${String(i + 1).padStart(4, '0')}`;

  const device = {
    ip,
    sysname,
    sysdesc: 'Test Device for Performance Benchmark',
    vendor: 'TestVendor',
    model: 'TestModel',
    status: 'active',
    level: Math.floor(Math.random() * 3),
  };

  db.upsertDevice(device);
  testDevices.push({ ip, sysname });
}

// Generate simulated neighbor lookups (mix of IP and sysname lookups)
const neighborLookups = [];
for (let i = 0; i < numDevices; i++) {
  for (let j = 0; j < neighborsPerDevice; j++) {
    // Randomly pick another device as neighbor
    const neighborIdx = Math.floor(Math.random() * numDevices);
    const neighbor = testDevices[neighborIdx];

    // Mix of IP lookups (60%) and sysname lookups (40%)
    if (Math.random() < 0.6) {
      neighborLookups.push({ type: 'ip', value: neighbor.ip });
    } else {
      neighborLookups.push({ type: 'sysname', value: neighbor.sysname });
    }
  }
}

const generateTime = Date.now() - generateStart;
console.log(`  Generated ${numDevices} devices and ${neighborLookups.length} neighbor lookups in ${generateTime}ms`);
console.log();

// ========== BENCHMARK: OLD APPROACH (O(n) per lookup) ==========
console.log('Phase 2: Benchmarking OLD approach (getAllDevices() + Array.find per lookup)...');

function oldApproachLookup(ipOrSysname) {
  // This simulates the old code pattern:
  // const devices = db.getAllDevices();
  // const found = devices.find(d => d.ip === ipOrSysname || d.sysname === ipOrSysname);
  const devices = db.getAllDevices();
  return devices.find(d => d.ip === ipOrSysname || d.sysname === ipOrSysname);
}

// Warm-up run
for (let i = 0; i < Math.min(10, neighborLookups.length); i++) {
  oldApproachLookup(neighborLookups[i].value);
}

// Timed run - OLD approach
const oldStart = Date.now();
let oldFoundCount = 0;

for (const lookup of neighborLookups) {
  const device = oldApproachLookup(lookup.value);
  if (device) oldFoundCount++;
}

const oldTime = Date.now() - oldStart;
const oldPerLookup = (oldTime / neighborLookups.length).toFixed(4);

console.log(`  OLD approach completed:`);
console.log(`    - Total time: ${oldTime}ms`);
console.log(`    - Time per lookup: ${oldPerLookup}ms`);
console.log(`    - Devices found: ${oldFoundCount}/${neighborLookups.length}`);
console.log();

// ========== BENCHMARK: NEW APPROACH (O(1) per lookup) ==========
console.log('Phase 3: Benchmarking NEW approach (getDeviceLookupMaps() + findDeviceInMaps)...');

// Warm-up run
const warmupMaps = db.getDeviceLookupMaps();
for (let i = 0; i < Math.min(10, neighborLookups.length); i++) {
  db.findDeviceInMaps(warmupMaps, neighborLookups[i].value);
}

// Timed run - NEW approach (including Map creation)
const newStart = Date.now();
const deviceMaps = db.getDeviceLookupMaps();
const mapCreationTime = Date.now() - newStart;

let newFoundCount = 0;
const lookupStart = Date.now();

for (const lookup of neighborLookups) {
  const device = db.findDeviceInMaps(deviceMaps, lookup.value);
  if (device) newFoundCount++;
}

const lookupTime = Date.now() - lookupStart;
const newTotalTime = Date.now() - newStart;
const newPerLookup = (lookupTime / neighborLookups.length).toFixed(4);

console.log(`  NEW approach completed:`);
console.log(`    - Map creation time: ${mapCreationTime}ms`);
console.log(`    - Lookup time: ${lookupTime}ms`);
console.log(`    - Total time: ${newTotalTime}ms`);
console.log(`    - Time per lookup: ${newPerLookup}ms`);
console.log(`    - Devices found: ${newFoundCount}/${neighborLookups.length}`);
console.log();

// ========== RESULTS SUMMARY ==========
console.log('='.repeat(70));
console.log('RESULTS SUMMARY');
console.log('='.repeat(70));
console.log();

const speedup = (oldTime / newTotalTime).toFixed(2);
const timeSaved = oldTime - newTotalTime;
const percentImprovement = ((timeSaved / oldTime) * 100).toFixed(1);

console.log(`Performance Comparison:`);
console.log(`  OLD approach (getAllDevices + find): ${oldTime}ms`);
console.log(`  NEW approach (Map lookups):          ${newTotalTime}ms`);
console.log();
console.log(`Improvement:`);
console.log(`  Speed-up factor: ${speedup}x faster`);
console.log(`  Time saved: ${timeSaved}ms (${percentImprovement}% reduction)`);
console.log();

// Verify correctness
if (oldFoundCount === newFoundCount) {
  console.log(`Correctness: PASSED (both approaches found ${oldFoundCount} devices)`);
} else {
  console.log(`Correctness: FAILED (old=${oldFoundCount}, new=${newFoundCount})`);
}
console.log();

// Theoretical analysis
console.log('Theoretical Analysis:');
console.log(`  OLD approach complexity: O(n) per lookup, O(n*m) total`);
console.log(`    where n=${numDevices} devices, m=${neighborsPerDevice} neighbors`);
console.log(`    Total operations: ~${numDevices * neighborsPerDevice * numDevices} comparisons`);
console.log();
console.log(`  NEW approach complexity: O(1) per lookup, O(n + m) total`);
console.log(`    Map creation: O(n) = ${numDevices} inserts`);
console.log(`    Lookups: O(1) * ${neighborLookups.length} = ${neighborLookups.length} operations`);
console.log();

// Real-world impact estimation
const realWorldDevices = 500;
const realWorldNeighbors = 20;
const estimatedOldTime = (oldTime / neighborLookups.length) * realWorldDevices * realWorldNeighbors;
const estimatedNewTime = (newTotalTime / neighborLookups.length) * realWorldDevices * realWorldNeighbors + mapCreationTime;

console.log('Real-world Impact Estimation (500 devices, 20 neighbors each):');
console.log(`  OLD approach estimated time: ${Math.round(estimatedOldTime)}ms`);
console.log(`  NEW approach estimated time: ${Math.round(estimatedNewTime)}ms`);
console.log(`  Estimated time savings: ${Math.round(estimatedOldTime - estimatedNewTime)}ms`);
console.log();

// Cleanup
console.log('Cleaning up test database...');
db.close();

// Remove test database
import fs from 'fs';
try {
  fs.unlinkSync(testDbPath);
  fs.unlinkSync(testDbPath + '-wal');
  fs.unlinkSync(testDbPath + '-shm');
} catch (e) {
  // Files may not exist, ignore errors
}

console.log();
console.log('='.repeat(70));

// Final verdict
if (parseFloat(speedup) >= 2) {
  console.log('BENCHMARK PASSED: Significant performance improvement achieved!');
} else if (parseFloat(speedup) >= 1.2) {
  console.log('BENCHMARK PASSED: Measurable performance improvement achieved.');
} else {
  console.log('BENCHMARK NOTE: Improvement may be more significant with larger datasets.');
}

console.log('='.repeat(70));
console.log();

// Exit with appropriate code
process.exit(oldFoundCount === newFoundCount ? 0 : 1);
