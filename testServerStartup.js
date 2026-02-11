/**
 * Test script to verify server startup does NOT load OUI database
 *
 * This test imports the server dependencies (without starting the server)
 * and verifies that the OUI database is not loaded until explicitly used.
 */

import { performance } from 'perf_hooks';

console.log('='.repeat(60));
console.log('Server Startup OUI Lazy Loading Verification');
console.log('='.repeat(60));
console.log();

// Record baseline memory
const memBaseline = process.memoryUsage();
console.log(`Baseline heap: ${(memBaseline.heapUsed / 1024 / 1024).toFixed(2)} MB`);

// Simulate server module imports (same as server.js lines 1-45)
console.log('\nImporting server dependencies (simulating server.js imports)...');
const importStart = performance.now();

// Import the same modules as server.js
const { default: express } = await import('express');
const { default: bodyParser } = await import('body-parser');
const { default: Cidr } = await import('ip-cidr');
const { default: path } = await import('path');
const { default: fs } = await import('fs');
const { default: os } = await import('os');
const { default: crypto } = await import('crypto');

// Import project modules like server.js does
const { default: SSHAgent } = await import('./sshAgent.js');
const { getAllServers } = await import('./sshConfig.js');
const { default: NetMapDB } = await import('./libdb.js');
const { getNeDiDB } = await import('./libnedi.js');
const { default: NetMapMap } = await import('./libmap.js');
const { default: NetMapPing } = await import('./libping.js');
const { extractDeviceFacts, getDeviceType, getDeviceIcon } = await import('./lib/sysObjectIDMap.js');
const { default: LldpSshDiscovery } = await import('./lib/lldpSshDiscovery.js');

// Import OUI module (the module under test)
const { lookupOui, isDatabaseLoaded } = await import('./lib/ouiDatabase.js');

const { default: SwitchSSH } = await import('./lib/switchSSH.js');
const { default: SwitchTelnet } = await import('./lib/switchTelnet.js');
const { parseHuaweiLldpNeighbors } = await import('./lib/huaweiLldpParser.js');

const importEnd = performance.now();
const totalImportTime = importEnd - importStart;

console.log(`All imports completed in: ${totalImportTime.toFixed(2)}ms`);
console.log();

// Check if OUI database was loaded during imports
console.log('Checking OUI database status...');
const ouiLoadedAtStartup = isDatabaseLoaded();
console.log(`OUI database loaded at startup: ${ouiLoadedAtStartup}`);

const memAfterImport = process.memoryUsage();
console.log(`Heap after imports: ${(memAfterImport.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`Heap increase from imports: ${((memAfterImport.heapUsed - memBaseline.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
console.log();

// Now trigger OUI database load
console.log('Triggering first OUI lookup...');
const lookupStart = performance.now();
const result = await lookupOui('00:00:0c:11:22:33');
const lookupEnd = performance.now();
const lookupTime = lookupEnd - lookupStart;

console.log(`First lookup time: ${lookupTime.toFixed(2)}ms`);
console.log(`Result: ${JSON.stringify(result)}`);
console.log();

const memAfterOui = process.memoryUsage();
console.log(`Heap after OUI load: ${(memAfterOui.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`Memory used by OUI database: ${((memAfterOui.heapUsed - memAfterImport.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
console.log();

// Summary
console.log('='.repeat(60));
console.log('RESULTS');
console.log('='.repeat(60));
console.log();

if (!ouiLoadedAtStartup) {
  console.log('PASS: OUI database is NOT loaded at server startup');
  console.log();
  console.log('Startup Performance Improvement:');
  console.log(`  - Startup time saved: ${lookupTime.toFixed(2)}ms (JSON parse + file read)`);
  console.log(`  - Memory saved at startup: ${((memAfterOui.heapUsed - memAfterImport.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
  console.log();
  console.log('When OUI feature IS used:');
  console.log(`  - First lookup adds: ${lookupTime.toFixed(2)}ms latency (one-time)`);
  console.log(`  - Memory consumption: ${((memAfterOui.heapUsed - memAfterImport.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
  console.log();
  console.log('When OUI feature is NOT used:');
  console.log(`  - Startup time: ${totalImportTime.toFixed(2)}ms faster`);
  console.log(`  - Memory consumption: ${((memAfterOui.heapUsed - memAfterImport.heapUsed) / 1024 / 1024).toFixed(2)} MB saved`);
  console.log();
  console.log('='.repeat(60));
  console.log('VERIFICATION COMPLETE - Lazy loading working as expected');
  console.log('='.repeat(60));
  process.exit(0);
} else {
  console.log('FAIL: OUI database was loaded at server startup');
  console.log('The lazy loading implementation is not working correctly.');
  console.log('='.repeat(60));
  process.exit(1);
}
