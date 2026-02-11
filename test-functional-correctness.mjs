#!/usr/bin/env node
/**
 * Functional Correctness Test for Optimization Changes
 *
 * This test verifies that the optimization changes (replacing getAllDevices() with
 * Map-based lookups) maintain functional correctness for:
 *
 * 1. Device lookup maps creation and usage
 * 2. Neighbor device finding via findDeviceInMaps()
 * 3. Map updating when new devices are created (simulating discovery flow)
 * 4. Map endpoint data retrieval
 *
 * Usage:
 *   node test-functional-correctness.mjs
 */

import NetMapDB from './libdb.js';
import fs from 'fs';

const testDbPath = './test-functional-correctness.db';
let db;
let testsPassed = 0;
let testsFailed = 0;

// Test helper functions
function pass(testName, details) {
  testsPassed++;
  console.log(`  ✓ ${testName}`);
  if (details) console.log(`    ${details}`);
}

function fail(testName, expected, actual) {
  testsFailed++;
  console.log(`  ✗ ${testName}`);
  console.log(`    Expected: ${expected}`);
  console.log(`    Actual: ${actual}`);
}

function assertEqual(testName, expected, actual) {
  if (expected === actual) {
    pass(testName);
    return true;
  } else {
    fail(testName, expected, actual);
    return false;
  }
}

function assertTruthy(testName, value, message) {
  if (value) {
    pass(testName, message);
    return true;
  } else {
    fail(testName, 'truthy', value);
    return false;
  }
}

function assertFalsy(testName, value) {
  if (!value) {
    pass(testName);
    return true;
  } else {
    fail(testName, 'falsy/null/undefined', value);
    return false;
  }
}

// ============================================================
// Test Suite: Device Lookup Maps Creation
// ============================================================
function testDeviceLookupMapsCreation() {
  console.log('\n=== Test Suite: Device Lookup Maps Creation ===');

  // Create test devices
  db.upsertDevice({ ip: '10.0.0.1', sysname: 'switch-core-1', status: 'active' });
  db.upsertDevice({ ip: '10.0.0.2', sysname: 'switch-access-2', status: 'active' });
  db.upsertDevice({ ip: '10.0.0.3', sysname: 'Router-Main', status: 'active' });

  // Get lookup maps
  const maps = db.getDeviceLookupMaps();

  // Test 1: Maps are created
  assertTruthy('Maps object is created', maps);
  assertTruthy('ipMap exists', maps.ipMap);
  assertTruthy('sysnameMap exists', maps.sysnameMap);

  // Test 2: Maps are Map instances
  assertTruthy('ipMap is a Map', maps.ipMap instanceof Map);
  assertTruthy('sysnameMap is a Map', maps.sysnameMap instanceof Map);

  // Test 3: Maps contain correct number of entries
  assertEqual('ipMap has 3 entries', 3, maps.ipMap.size);
  assertEqual('sysnameMap has 3 entries', 3, maps.sysnameMap.size);

  // Test 4: IP lookup works
  const device1 = maps.ipMap.get('10.0.0.1');
  assertTruthy('IP lookup finds device', device1);
  assertEqual('IP lookup returns correct sysname', 'switch-core-1', device1?.sysname);

  // Test 5: Sysname lookup is case-insensitive
  const device3 = maps.sysnameMap.get('router-main');
  assertTruthy('Sysname lookup (lowercase) finds device', device3);
  assertEqual('Sysname lookup returns correct IP', '10.0.0.3', device3?.ip);
}

// ============================================================
// Test Suite: findDeviceInMaps() Function
// ============================================================
function testFindDeviceInMaps() {
  console.log('\n=== Test Suite: findDeviceInMaps() Function ===');

  // Create lookup maps
  const maps = db.getDeviceLookupMaps();

  // Test 1: Find by IP
  const deviceByIp = db.findDeviceInMaps(maps, '10.0.0.1');
  assertTruthy('Find by IP returns device', deviceByIp);
  assertEqual('Find by IP returns correct sysname', 'switch-core-1', deviceByIp?.sysname);

  // Test 2: Find by sysname (exact case)
  const deviceBySysname = db.findDeviceInMaps(maps, 'switch-access-2');
  assertTruthy('Find by sysname returns device', deviceBySysname);
  assertEqual('Find by sysname returns correct IP', '10.0.0.2', deviceBySysname?.ip);

  // Test 3: Find by sysname (case-insensitive)
  const deviceBySysnameUpper = db.findDeviceInMaps(maps, 'SWITCH-ACCESS-2');
  assertTruthy('Find by sysname (uppercase) returns device', deviceBySysnameUpper);
  assertEqual('Find by sysname (uppercase) returns correct IP', '10.0.0.2', deviceBySysnameUpper?.ip);

  // Test 4: Non-existent device returns null
  const nonExistent = db.findDeviceInMaps(maps, '10.0.0.99');
  assertFalsy('Non-existent IP returns null', nonExistent);

  // Test 5: Null/undefined input handling
  const nullInput = db.findDeviceInMaps(maps, null);
  assertFalsy('Null input returns null', nullInput);

  const undefinedInput = db.findDeviceInMaps(maps, undefined);
  assertFalsy('Undefined input returns null', undefinedInput);

  // Test 6: Null maps handling
  const nullMaps = db.findDeviceInMaps(null, '10.0.0.1');
  assertFalsy('Null maps returns null', nullMaps);
}

// ============================================================
// Test Suite: Map Updates During Discovery Simulation
// ============================================================
function testMapUpdatesDuringDiscovery() {
  console.log('\n=== Test Suite: Map Updates During Discovery Simulation ===');

  // This simulates the discovery flow where:
  // 1. Maps are created at start
  // 2. New neighbors are discovered and added to DB
  // 3. Maps are updated with new devices
  // 4. Subsequent lookups find new devices

  // Create initial maps
  const deviceMaps = db.getDeviceLookupMaps();
  const initialCount = deviceMaps.ipMap.size;

  // Simulate discovering a new neighbor
  const newNeighborIp = '10.0.0.10';
  const newNeighborSysname = 'new-neighbor-switch';

  // Verify neighbor doesn't exist yet
  const beforeCreate = db.findDeviceInMaps(deviceMaps, newNeighborIp);
  assertFalsy('New neighbor not in maps before creation', beforeCreate);

  // Create the neighbor device (simulates upsertDevice during discovery)
  db.upsertDevice({ ip: newNeighborIp, sysname: newNeighborSysname, status: 'active' });

  // Get the device from DB to update maps (simulates what server.js does)
  const newDevice = db.getDevice(newNeighborIp);
  assertTruthy('New device created in DB', newDevice);

  // Update maps with new device (this is what server.js does after upsertDevice)
  if (newDevice) {
    if (newDevice.ip) {
      deviceMaps.ipMap.set(newDevice.ip, newDevice);
    }
    if (newDevice.sysname) {
      deviceMaps.sysnameMap.set(newDevice.sysname.toLowerCase(), newDevice);
    }
  }

  // Verify neighbor can now be found via Map lookup
  const afterCreate = db.findDeviceInMaps(deviceMaps, newNeighborIp);
  assertTruthy('New neighbor found in maps after update', afterCreate);
  assertEqual('Found neighbor has correct sysname', newNeighborSysname, afterCreate?.sysname);

  // Verify sysname lookup also works
  const bySysname = db.findDeviceInMaps(deviceMaps, newNeighborSysname);
  assertTruthy('New neighbor found by sysname', bySysname);

  // Verify map size increased
  assertEqual('ipMap size increased by 1', initialCount + 1, deviceMaps.ipMap.size);
}

// ============================================================
// Test Suite: Link Creation and Retrieval
// ============================================================
function testLinkCreationAndRetrieval() {
  console.log('\n=== Test Suite: Link Creation and Retrieval ===');

  // Get device IDs
  const device1 = db.getDevice('10.0.0.1');
  const device2 = db.getDevice('10.0.0.2');

  assertTruthy('Device 1 exists', device1);
  assertTruthy('Device 2 exists', device2);

  // Create a link between devices
  db.upsertLink({
    device_id: device1.id,
    remote_device_id: device2.id,
    local_ifindex: 1,
    local_ifname: 'Gi0/1',
    remote_portid: 'Gi0/2',
    remote_sysname: device2.sysname,
    protocol: 'lldp'
  });

  // Retrieve all links
  const links = db.getAllLinks();
  assertTruthy('Links retrieved', links.length > 0, `Found ${links.length} links`);

  // Find our test link
  const testLink = links.find(l => l.device_id === device1.id && l.remote_device_id === device2.id);
  assertTruthy('Test link found', testLink);
  assertEqual('Link has correct local_ifname', 'Gi0/1', testLink?.local_ifname);
  assertEqual('Link has correct protocol', 'lldp', testLink?.protocol);
}

// ============================================================
// Test Suite: Map Endpoint Data Preparation
// ============================================================
function testMapEndpointDataPreparation() {
  console.log('\n=== Test Suite: Map Endpoint Data Preparation ===');

  // This simulates the /api/map-nedi endpoint data preparation

  // Create lookup maps
  const deviceLookupMaps = db.getDeviceLookupMaps();
  let devices = Array.from(deviceLookupMaps.ipMap.values());

  assertTruthy('Devices array created from ipMap', devices.length > 0, `Found ${devices.length} devices`);

  // Test filtering by sysname (simulates ?device= parameter)
  const filterSysname = 'switch';
  const filteredDevices = devices.filter(d =>
    d.sysname?.includes(filterSysname)
  );
  assertTruthy('Filter by sysname works', filteredDevices.length >= 2, `Found ${filteredDevices.length} matching devices`);

  // Create deviceIdToDevice map for O(1) lookups
  const deviceIdToDevice = new Map();
  for (const device of devices) {
    deviceIdToDevice.set(device.id, device);
  }
  assertEqual('deviceIdToDevice map created with correct size', devices.length, deviceIdToDevice.size);

  // Test lookup by device ID
  const someDevice = devices[0];
  const foundById = deviceIdToDevice.get(someDevice.id);
  assertEqual('Device lookup by ID returns correct device', someDevice.ip, foundById?.ip);

  // Test link retrieval for map
  const links = db.getAllLinks();
  assertTruthy('Links available for map rendering', Array.isArray(links));
}

// ============================================================
// Test Suite: Neighbor Discovery Simulation
// ============================================================
function testNeighborDiscoverySimulation() {
  console.log('\n=== Test Suite: Neighbor Discovery Simulation ===');

  // This simulates the flow in /api/discover-full where:
  // 1. A device is scanned
  // 2. Neighbors are found via LLDP/CDP
  // 3. Neighbor devices are created if they don't exist
  // 4. Links are created between devices

  // Create main device (the one being scanned)
  const mainDeviceIp = '10.1.0.1';
  db.upsertDevice({ ip: mainDeviceIp, sysname: 'main-scanner', status: 'active' });
  const mainDevice = db.getDevice(mainDeviceIp);

  // Create device lookup maps (optimization)
  const deviceMaps = db.getDeviceLookupMaps();

  // Simulate discovering 3 LLDP neighbors
  const lldpNeighbors = [
    { sysName: 'neighbor-1', chassisId: 'aa:bb:cc:dd:ee:01', localPort: 'Gi0/1', remotePort: 'Gi0/2' },
    { sysName: 'neighbor-2', chassisId: 'aa:bb:cc:dd:ee:02', localPort: 'Gi0/2', remotePort: 'Gi0/1' },
    { sysName: 'NEIGHBOR-3', chassisId: 'aa:bb:cc:dd:ee:03', localPort: 'Gi0/3', remotePort: 'Gi0/1' }, // Mixed case
  ];

  for (const neighbor of lldpNeighbors) {
    // Use findDeviceInMaps for O(1) lookup (simulates the optimized code)
    let remoteDevice = db.findDeviceInMaps(deviceMaps, neighbor.sysName);

    if (!remoteDevice) {
      // Create neighbor device
      const neighborIp = `10.1.0.${100 + lldpNeighbors.indexOf(neighbor)}`;
      db.upsertDevice({ ip: neighborIp, sysname: neighbor.sysName, status: 'active' });
      remoteDevice = db.getDevice(neighborIp);

      // Update maps with new device (key optimization)
      if (remoteDevice) {
        if (remoteDevice.ip) {
          deviceMaps.ipMap.set(remoteDevice.ip, remoteDevice);
        }
        if (remoteDevice.sysname) {
          deviceMaps.sysnameMap.set(remoteDevice.sysname.toLowerCase(), remoteDevice);
        }
      }
    }

    // Create link
    if (remoteDevice) {
      db.upsertLink({
        device_id: mainDevice.id,
        remote_device_id: remoteDevice.id,
        local_ifindex: parseInt(neighbor.localPort.replace(/\D/g, '')),
        local_ifname: neighbor.localPort,
        remote_portid: neighbor.remotePort,
        remote_sysname: neighbor.sysName,
        remote_chassisid: neighbor.chassisId,
        protocol: 'lldp'
      });
    }
  }

  // Verify all neighbors were created
  for (const neighbor of lldpNeighbors) {
    const foundDevice = db.findDeviceInMaps(deviceMaps, neighbor.sysName);
    assertTruthy(`Neighbor ${neighbor.sysName} found in maps`, foundDevice);
  }

  // Verify links were created
  const links = db.getAllLinks().filter(l => l.device_id === mainDevice.id);
  assertEqual('Correct number of links created', 3, links.length);
}

// ============================================================
// Test Suite: Recursive Discovery Simulation
// ============================================================
function testRecursiveDiscoverySimulation() {
  console.log('\n=== Test Suite: Recursive Discovery Simulation ===');

  // Create a chain of devices: A -> B -> C -> D
  // This simulates recursive BFS discovery

  const devices = [
    { ip: '10.2.0.1', sysname: 'level-0-seed', level: 0 },
    { ip: '10.2.0.2', sysname: 'level-1-neighbor', level: 1 },
    { ip: '10.2.0.3', sysname: 'level-2-neighbor', level: 2 },
    { ip: '10.2.0.4', sysname: 'level-3-neighbor', level: 3 },
  ];

  // Create all devices
  for (const d of devices) {
    db.upsertDevice({ ip: d.ip, sysname: d.sysname, status: 'active', level: d.level });
  }

  // Create device lookup maps
  const deviceMaps = db.getDeviceLookupMaps();

  // Simulate BFS discovery from seed
  const seedDevice = db.findDeviceInMaps(deviceMaps, '10.2.0.1');
  assertTruthy('Seed device found', seedDevice);
  assertEqual('Seed device has correct sysname', 'level-0-seed', seedDevice?.sysname);

  // Create links between levels
  for (let i = 0; i < devices.length - 1; i++) {
    const fromDevice = db.getDevice(devices[i].ip);
    const toDevice = db.getDevice(devices[i + 1].ip);

    db.upsertLink({
      device_id: fromDevice.id,
      remote_device_id: toDevice.id,
      local_ifindex: 1,
      local_ifname: `Gi0/${i + 1}`,
      remote_portid: 'Gi0/1',
      remote_sysname: toDevice.sysname,
      protocol: 'lldp'
    });
  }

  // Create a deviceId to device map for O(1) lookups
  const deviceIdToDevice = new Map();
  const allDevices = db.getAllDevices();
  for (const d of allDevices) {
    deviceIdToDevice.set(d.id, d);
  }

  // Simulate BFS: find all devices reachable from seed
  const discovered = new Set([devices[0].ip]);
  let currentLevel = new Set([devices[0].ip]);
  let maxLevels = 4; // Need 4 levels to reach all 4 devices (0->1->2->3)

  for (let level = 0; level < maxLevels && currentLevel.size > 0; level++) {
    const nextLevel = new Set();
    const allLinks = db.getAllLinks();

    for (const ip of currentLevel) {
      const device = db.findDeviceInMaps(deviceMaps, ip);

      if (device) {
        // Find neighbors via links
        for (const link of allLinks) {
          // Check outgoing links from this device
          if (link.device_id === device.id && link.remote_device_id) {
            // Use O(1) Map lookup
            const remoteDevice = deviceIdToDevice.get(link.remote_device_id);
            if (remoteDevice && !discovered.has(remoteDevice.ip)) {
              discovered.add(remoteDevice.ip);
              nextLevel.add(remoteDevice.ip);
            }
          }
          // Check incoming links to this device
          if (link.remote_device_id === device.id && link.device_id) {
            const fromDevice = deviceIdToDevice.get(link.device_id);
            if (fromDevice && !discovered.has(fromDevice.ip)) {
              discovered.add(fromDevice.ip);
              nextLevel.add(fromDevice.ip);
            }
          }
        }
      }
    }
    currentLevel = nextLevel;
  }

  assertEqual('BFS discovered correct number of devices', 4, discovered.size);
  assertTruthy('BFS found level-3 neighbor', discovered.has('10.2.0.4'));
}

// ============================================================
// Test Suite: Edge Cases
// ============================================================
function testEdgeCases() {
  console.log('\n=== Test Suite: Edge Cases ===');

  // Test 1: Empty database
  const emptyDb = new NetMapDB(':memory:');
  const emptyMaps = emptyDb.getDeviceLookupMaps();
  assertEqual('Empty DB returns empty ipMap', 0, emptyMaps.ipMap.size);
  assertEqual('Empty DB returns empty sysnameMap', 0, emptyMaps.sysnameMap.size);
  emptyDb.close();

  // Test 2: Device with null sysname
  db.upsertDevice({ ip: '10.3.0.1', sysname: null, status: 'active' });
  const maps2 = db.getDeviceLookupMaps();
  const deviceNullSysname = maps2.ipMap.get('10.3.0.1');
  assertTruthy('Device with null sysname found by IP', deviceNullSysname);

  // Test 3: Device with empty string sysname
  db.upsertDevice({ ip: '10.3.0.2', sysname: '', status: 'active' });
  const maps3 = db.getDeviceLookupMaps();
  const deviceEmptySysname = maps3.ipMap.get('10.3.0.2');
  assertTruthy('Device with empty sysname found by IP', deviceEmptySysname);

  // Test 4: Multiple devices with same sysname (edge case - should keep last one)
  db.upsertDevice({ ip: '10.3.0.10', sysname: 'duplicate-name', status: 'active' });
  db.upsertDevice({ ip: '10.3.0.11', sysname: 'duplicate-name', status: 'active' });
  const maps4 = db.getDeviceLookupMaps();
  const duplicateDevice = maps4.sysnameMap.get('duplicate-name');
  assertTruthy('Duplicate sysname lookup returns a device', duplicateDevice);
  // Note: behavior depends on iteration order, just verify it returns something

  // Test 5: Special characters in sysname
  db.upsertDevice({ ip: '10.3.0.20', sysname: 'device_with-special.chars', status: 'active' });
  const maps5 = db.getDeviceLookupMaps();
  const specialDevice = db.findDeviceInMaps(maps5, 'device_with-special.chars');
  assertTruthy('Device with special chars found', specialDevice);

  // Test 6: Very long sysname
  const longSysname = 'a'.repeat(255);
  db.upsertDevice({ ip: '10.3.0.21', sysname: longSysname, status: 'active' });
  const maps6 = db.getDeviceLookupMaps();
  const longDevice = db.findDeviceInMaps(maps6, longSysname);
  assertTruthy('Device with long sysname found', longDevice);
}

// ============================================================
// Main Test Runner
// ============================================================
async function runTests() {
  console.log('='.repeat(70));
  console.log('Functional Correctness Tests for Optimization Changes');
  console.log('='.repeat(70));

  try {
    // Clean up any existing test database
    try {
      fs.unlinkSync(testDbPath);
    } catch (e) { /* ignore */ }
    try {
      fs.unlinkSync(testDbPath + '-wal');
    } catch (e) { /* ignore */ }
    try {
      fs.unlinkSync(testDbPath + '-shm');
    } catch (e) { /* ignore */ }

    // Initialize test database
    db = new NetMapDB(testDbPath);

    // Run test suites
    testDeviceLookupMapsCreation();
    testFindDeviceInMaps();
    testMapUpdatesDuringDiscovery();
    testLinkCreationAndRetrieval();
    testMapEndpointDataPreparation();
    testNeighborDiscoverySimulation();
    testRecursiveDiscoverySimulation();
    testEdgeCases();

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));
    console.log(`  Passed: ${testsPassed}`);
    console.log(`  Failed: ${testsFailed}`);
    console.log(`  Total:  ${testsPassed + testsFailed}`);
    console.log('='.repeat(70));

    if (testsFailed > 0) {
      console.log('\n❌ SOME TESTS FAILED');
      process.exitCode = 1;
    } else {
      console.log('\n✅ ALL TESTS PASSED');
      console.log('The optimization changes maintain functional correctness.');
    }

  } finally {
    // Cleanup
    if (db) {
      db.close();
    }
    try {
      fs.unlinkSync(testDbPath);
    } catch (e) { /* ignore */ }
    try {
      fs.unlinkSync(testDbPath + '-wal');
    } catch (e) { /* ignore */ }
    try {
      fs.unlinkSync(testDbPath + '-shm');
    } catch (e) { /* ignore */ }
    console.log('\nTest database cleaned up.');
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
