/**
 * Unit tests for huaweiLldpParser.js
 *
 * Tests both detailed and compact LLDP output formats, edge cases,
 * and helper functions to ensure parser correctness before and after
 * regex optimizations.
 *
 * Run with: npm test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  parseHuaweiLldpNeighbors,
  convertToNeDiLinks,
  normalizeInterfaceName
} from '../huaweiLldpParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load test fixture from file
 * @param {string} filename - Fixture filename
 * @returns {string} File contents
 */
function loadFixture(filename) {
  const fixturePath = join(__dirname, 'fixtures', filename);
  return readFileSync(fixturePath, 'utf-8');
}

// =============================================================================
// normalizeInterfaceName tests
// =============================================================================

describe('normalizeInterfaceName', () => {
  it('should return empty string for null/undefined input', () => {
    assert.strictEqual(normalizeInterfaceName(null), '');
    assert.strictEqual(normalizeInterfaceName(undefined), '');
    assert.strictEqual(normalizeInterfaceName(''), '');
  });

  it('should normalize GigabitEthernet to GE', () => {
    assert.strictEqual(normalizeInterfaceName('GigabitEthernet0/0/1'), 'GE0/0/1');
    assert.strictEqual(normalizeInterfaceName('GigabitEthernet1/0/24'), 'GE1/0/24');
  });

  it('should normalize XGigabitEthernet to XGE', () => {
    assert.strictEqual(normalizeInterfaceName('XGigabitEthernet1/0/1'), 'XGE1/0/1');
    assert.strictEqual(normalizeInterfaceName('XGigabitEthernet2/0/4'), 'XGE2/0/4');
  });

  it('should normalize TenGigabitEthernet to 10GE', () => {
    assert.strictEqual(normalizeInterfaceName('TenGigabitEthernet0/0/1'), '10GE0/0/1');
    assert.strictEqual(normalizeInterfaceName('TenGigabitEthernet1/0/2'), '10GE1/0/2');
  });

  it('should normalize Ethernet to Eth', () => {
    assert.strictEqual(normalizeInterfaceName('Ethernet0/0/1'), 'Eth0/0/1');
    assert.strictEqual(normalizeInterfaceName('Ethernet1/0/2'), 'Eth1/0/2');
  });

  it('should preserve already normalized names', () => {
    assert.strictEqual(normalizeInterfaceName('GE1/0/1'), 'GE1/0/1');
    assert.strictEqual(normalizeInterfaceName('XGE1/0/1'), 'XGE1/0/1');
    assert.strictEqual(normalizeInterfaceName('10GE1/0/1'), '10GE1/0/1');
    assert.strictEqual(normalizeInterfaceName('Eth-Trunk1'), 'Eth-Trunk1');
  });

  it('should be case-insensitive for interface prefixes', () => {
    assert.strictEqual(normalizeInterfaceName('gigabitethernet0/0/1'), 'GE0/0/1');
    assert.strictEqual(normalizeInterfaceName('GIGABITETHERNET0/0/1'), 'GE0/0/1');
  });

  it('should handle non-interface strings', () => {
    assert.strictEqual(normalizeInterfaceName('mgt0'), 'mgt0');
    assert.strictEqual(normalizeInterfaceName('eth0'), 'eth0');
  });

  it('should trim whitespace', () => {
    assert.strictEqual(normalizeInterfaceName('  GE1/0/1  '), 'GE1/0/1');
    assert.strictEqual(normalizeInterfaceName('\tGigabitEthernet1/0/1\n'), 'GE1/0/1');
  });
});

// =============================================================================
// parseHuaweiLldpNeighbors - Edge cases
// =============================================================================

describe('parseHuaweiLldpNeighbors - Edge cases', () => {
  it('should return empty array for null input', () => {
    const result = parseHuaweiLldpNeighbors(null);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for undefined input', () => {
    const result = parseHuaweiLldpNeighbors(undefined);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for empty string', () => {
    const result = parseHuaweiLldpNeighbors('');
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for non-string input', () => {
    const result = parseHuaweiLldpNeighbors(12345);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for whitespace-only input', () => {
    const result = parseHuaweiLldpNeighbors('   \n\t\n   ');
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array for random text', () => {
    const result = parseHuaweiLldpNeighbors('This is not LLDP output at all');
    assert.deepStrictEqual(result, []);
  });
});

// =============================================================================
// parseHuaweiLldpNeighbors - Detailed format
// =============================================================================

describe('parseHuaweiLldpNeighbors - Detailed format', () => {
  it('should parse a single neighbor correctly', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
Chassis type                       :MAC address
Chassis ID                         :a0b3-ccf1-2341
Port ID type                       :Interface name
Port ID                            :XGigabitEthernet1/0/1
Port description                   :10GE uplink to CORE-SW-001
System name                        :CORE-SW-001
System description                 :Huawei VRP Software
Management address type            :IPv4
Management address                 :10.10.1.1
Expired time                       :120s`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].localPort, '10GE1/0/1');
    assert.strictEqual(result[0].chassisId, 'a0b3-ccf1-2341');
    assert.strictEqual(result[0].portId, 'XGE1/0/1');
    assert.strictEqual(result[0].portDescr, '10GE uplink to CORE-SW-001');
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
    assert.strictEqual(result[0].sysDescr, 'Huawei VRP Software');
    assert.strictEqual(result[0].mgmtAddr, '10.10.1.1');
    assert.strictEqual(result[0].holdTime, 120);
  });

  it('should parse multiple neighbors on same port', () => {
    const input = `GE1/0/41 has 2 neighbor(s):

Neighbor index                     :1
Chassis ID                         :4a5d-667b-defc
Port ID                            :eth0
System name                        :WS-ENG-001

Neighbor index                     :2
Chassis ID                         :5b6e-778c-ef0d
Port ID                            :eth0
System name                        :WS-ENG-002`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].localPort, 'GE1/0/41');
    assert.strictEqual(result[0].sysName, 'WS-ENG-001');
    assert.strictEqual(result[1].localPort, 'GE1/0/41');
    assert.strictEqual(result[1].sysName, 'WS-ENG-002');
  });

  it('should handle port with zero neighbors', () => {
    const input = `GE1/0/44 has 0 neighbor(s):
GE1/0/45 has 0 neighbor(s):
GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
Chassis ID                         :a0b3-ccf1-2341
Port ID                            :XGigabitEthernet1/0/1
System name                        :CORE-SW-001`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
  });

  it('should handle all interface types in detailed format', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaa
Port ID :eth0
System name :DEV1

XGE1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :bbb
Port ID :eth0
System name :DEV2

GE1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :ccc
Port ID :eth0
System name :DEV3

Eth-Trunk1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :ddd
Port ID :eth0
System name :DEV4

Ethernet0/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :eee
Port ID :eth0
System name :DEV5

XGigabitEthernet1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :fff
Port ID :eth0
System name :DEV6

GigabitEthernet1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :ggg
Port ID :eth0
System name :DEV7

TenGigabitEthernet1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :hhh
Port ID :eth0
System name :DEV8`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 8);

    // Check normalized port names
    assert.strictEqual(result[0].localPort, '10GE1/0/1');
    assert.strictEqual(result[1].localPort, 'XGE1/0/1');
    assert.strictEqual(result[2].localPort, 'GE1/0/1');
    assert.strictEqual(result[3].localPort, 'Eth-Trunk1');
    assert.strictEqual(result[4].localPort, 'Eth0/0/1');
    assert.strictEqual(result[5].localPort, 'XGE1/0/1');
    assert.strictEqual(result[6].localPort, 'GE1/0/1');
    assert.strictEqual(result[7].localPort, '10GE1/0/1');
  });

  it('should filter neighbors without useful data', () => {
    const input = `GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
Port description                   :Some port`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 0);
  });

  it('should handle Windows line endings (CRLF)', () => {
    const input = '10GE1/0/1 has 1 neighbor(s):\r\n\r\nNeighbor index                     :1\r\nChassis ID                         :a0b3-ccf1-2341\r\nPort ID                            :eth0\r\nSystem name                        :CORE-SW-001\r\n';

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
  });

  it('should parse expired time with seconds suffix correctly', () => {
    const input = `GE1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaa
Port ID :eth0
System name :DEV1
Expired time :95s`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result[0].holdTime, 95);
  });

  it('should parse expired time with just number', () => {
    const input = `GE1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaa
Port ID :eth0
System name :DEV1
Expired time :120`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result[0].holdTime, 120);
  });

  it('should handle large fixture file correctly', () => {
    const input = loadFixture('lldp-large-detailed.txt');
    const result = parseHuaweiLldpNeighbors(input);

    // The fixture has 56 neighbors (including multi-neighbor port GE1/0/41 with 2 neighbors)
    assert.ok(result.length >= 50, `Expected at least 50 neighbors, got ${result.length}`);

    // Verify some specific entries
    const firstNeighbor = result.find(n => n.sysName === 'CORE-SW-001');
    assert.ok(firstNeighbor, 'Should find CORE-SW-001');
    assert.strictEqual(firstNeighbor.localPort, '10GE1/0/1');
    assert.strictEqual(firstNeighbor.mgmtAddr, '10.10.1.1');

    // Check multi-neighbor port (GE1/0/41 has 2 neighbors)
    const multiNeighborPort = result.filter(n => n.localPort === 'GE1/0/41');
    assert.strictEqual(multiNeighborPort.length, 2, 'GE1/0/41 should have 2 neighbors');

    // Check Eth-Trunk entries
    const ethTrunkNeighbors = result.filter(n => n.localPort.startsWith('Eth-Trunk'));
    assert.ok(ethTrunkNeighbors.length >= 2, 'Should have Eth-Trunk neighbors');
  });
});

// =============================================================================
// parseHuaweiLldpNeighbors - Compact format
// =============================================================================

describe('parseHuaweiLldpNeighbors - Compact format', () => {
  it('should parse basic compact format line', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
10GE1/0/1                           120     XGigabitEthernet1/0/1          CORE-SW-001`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].localPort, '10GE1/0/1');
    assert.strictEqual(result[0].holdTime, 120);
    assert.strictEqual(result[0].portId, 'XGigabitEthernet1/0/1');
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
  });

  it('should parse multiple lines correctly', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
10GE1/0/1                           120     XGigabitEthernet1/0/1          CORE-SW-001
GE1/0/1                             95      GigabitEthernet0/0/1           SERVER-SW-A1
Eth-Trunk1                          119     Eth-Trunk1                     DISTRIB-SW-MAIN`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
    assert.strictEqual(result[1].sysName, 'SERVER-SW-A1');
    assert.strictEqual(result[2].sysName, 'DISTRIB-SW-MAIN');
  });

  it('should skip header lines correctly', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
Interface       HoldTime  Port              Neighbor
Port            TTL       Remote            Device
Neighbor information table:
10GE1/0/1                           120     XGigabitEthernet1/0/1          CORE-SW-001`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
  });

  it('should handle all interface types in compact format', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
10GE1/0/1                           120     eth0                           DEV1
XGE1/0/1                            120     eth0                           DEV2
GE1/0/1                             95      eth0                           DEV3
Eth-Trunk1                          119     eth0                           DEV4
Ethernet0/0/1                       95      eth0                           DEV5
XGigabitEthernet1/0/1               120     eth0                           DEV6
GigabitEthernet1/0/1                111     eth0                           DEV7
TenGigabitEthernet1/0/1             115     eth0                           DEV8`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 8);

    // Check normalized port names
    assert.strictEqual(result[0].localPort, '10GE1/0/1');
    assert.strictEqual(result[1].localPort, 'XGE1/0/1');
    assert.strictEqual(result[2].localPort, 'GE1/0/1');
    assert.strictEqual(result[3].localPort, 'Eth-Trunk1');
    assert.strictEqual(result[4].localPort, 'Eth0/0/1');
    assert.strictEqual(result[5].localPort, 'XGE1/0/1');
    assert.strictEqual(result[6].localPort, 'GE1/0/1');
    assert.strictEqual(result[7].localPort, '10GE1/0/1');
  });

  it('should handle entry without neighbor device name', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface
---------------------------------------------------------------------------------------------
10GE1/0/1                           120     a0b3-ccf1-2341`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    // When no device name, portId becomes sysName
    assert.strictEqual(result[0].portId, 'a0b3-ccf1-2341');
  });

  it('should handle MAC address as neighbor device', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
10GE1/0/1                           120     eth0                           a0b3-ccf1-2341`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].chassisId, 'a0b3-ccf1-2341');
  });

  it('should skip lines with too few fields', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
10GE1/0/1                           120
GE1/0/1                             95      GigabitEthernet0/0/1           SERVER-SW-A1`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sysName, 'SERVER-SW-A1');
  });

  it('should handle large fixture file correctly', () => {
    const input = loadFixture('lldp-large-compact.txt');
    const result = parseHuaweiLldpNeighbors(input);

    // The fixture has 186+ entries
    assert.ok(result.length >= 100, `Expected at least 100 neighbors, got ${result.length}`);

    // Verify some specific entries
    const coreSwitch = result.find(n => n.sysName === 'CORE-SW-001');
    assert.ok(coreSwitch, 'Should find CORE-SW-001');
    assert.strictEqual(coreSwitch.localPort, '10GE1/0/1');

    // Check Eth-Trunk entries
    const ethTrunkNeighbors = result.filter(n => n.localPort.startsWith('Eth-Trunk'));
    assert.ok(ethTrunkNeighbors.length >= 4, 'Should have Eth-Trunk neighbors');
  });
});

// =============================================================================
// Format detection
// =============================================================================

describe('Format detection', () => {
  it('should detect detailed format', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaa
Port ID :eth0
System name :DEV1`;

    const result = parseHuaweiLldpNeighbors(input);
    // If detected as detailed, we get proper neighbor structure
    assert.strictEqual(result[0].localPort, '10GE1/0/1');
    assert.strictEqual(result[0].sysName, 'DEV1');
  });

  it('should detect compact format', () => {
    const input = `Local Interface     Expd(s) Neighbor Interface    Neighbor Device
---------------------------------------------------------------------------------------------
10GE1/0/1           120     eth0                  DEV1`;

    const result = parseHuaweiLldpNeighbors(input);
    // If detected as compact, we get proper neighbor structure
    assert.strictEqual(result[0].localPort, '10GE1/0/1');
    assert.strictEqual(result[0].sysName, 'DEV1');
  });
});

// =============================================================================
// convertToNeDiLinks
// =============================================================================

describe('convertToNeDiLinks', () => {
  it('should convert empty array to empty array', () => {
    const result = convertToNeDiLinks([], 'SWITCH-01');
    assert.deepStrictEqual(result, []);
  });

  it('should convert single neighbor to NeDi link format', () => {
    const neighbors = [{
      localPort: '10GE1/0/1',
      portId: 'XGE1/0/1',
      portDescr: '10GE uplink',
      chassisId: 'a0b3-ccf1-2341',
      sysName: 'CORE-SW-001',
      sysDescr: 'Huawei VRP',
      mgmtAddr: '10.10.1.1',
      holdTime: 120
    }];

    const result = convertToNeDiLinks(neighbors, 'LOCAL-SWITCH');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].device, 'LOCAL-SWITCH');
    assert.strictEqual(result[0].ifname, '10GE1/0/1');
    assert.strictEqual(result[0].neighbor, 'CORE-SW-001');
    assert.strictEqual(result[0].nbrifname, 'XGE1/0/1');
    assert.strictEqual(result[0].linktype, 'LLDP');
    assert.strictEqual(result[0].bandwidth, 0);
    assert.ok(result[0].time > 0, 'Should have timestamp');
  });

  it('should use chassisId when sysName is missing', () => {
    const neighbors = [{
      localPort: '10GE1/0/1',
      portId: 'eth0',
      portDescr: null,
      chassisId: 'a0b3-ccf1-2341',
      sysName: null,
      sysDescr: null,
      mgmtAddr: null,
      holdTime: 120
    }];

    const result = convertToNeDiLinks(neighbors, 'LOCAL-SWITCH');
    assert.strictEqual(result[0].neighbor, 'a0b3-ccf1-2341');
  });

  it('should use portId when sysName and chassisId are missing', () => {
    const neighbors = [{
      localPort: '10GE1/0/1',
      portId: 'eth0',
      portDescr: null,
      chassisId: null,
      sysName: null,
      sysDescr: null,
      mgmtAddr: null,
      holdTime: 120
    }];

    const result = convertToNeDiLinks(neighbors, 'LOCAL-SWITCH');
    assert.strictEqual(result[0].neighbor, 'eth0');
  });

  it('should use portDescr when portId is missing', () => {
    const neighbors = [{
      localPort: '10GE1/0/1',
      portId: null,
      portDescr: 'Uplink port',
      chassisId: 'a0b3-ccf1-2341',
      sysName: 'CORE-SW-001',
      sysDescr: null,
      mgmtAddr: null,
      holdTime: 120
    }];

    const result = convertToNeDiLinks(neighbors, 'LOCAL-SWITCH');
    assert.strictEqual(result[0].nbrifname, 'Uplink port');
  });

  it('should convert multiple neighbors correctly', () => {
    const neighbors = [
      { localPort: 'GE1/0/1', portId: 'eth0', chassisId: null, sysName: 'DEV1', portDescr: null, sysDescr: null, mgmtAddr: null, holdTime: 120 },
      { localPort: 'GE1/0/2', portId: 'eth1', chassisId: null, sysName: 'DEV2', portDescr: null, sysDescr: null, mgmtAddr: null, holdTime: 115 },
      { localPort: 'GE1/0/3', portId: 'eth2', chassisId: null, sysName: 'DEV3', portDescr: null, sysDescr: null, mgmtAddr: null, holdTime: 110 }
    ];

    const result = convertToNeDiLinks(neighbors, 'SWITCH-01');
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].neighbor, 'DEV1');
    assert.strictEqual(result[1].neighbor, 'DEV2');
    assert.strictEqual(result[2].neighbor, 'DEV3');
  });
});

// =============================================================================
// Regression tests - specific edge cases from production
// =============================================================================

describe('Regression tests', () => {
  it('should handle multiline system description in detailed format', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
Chassis ID                         :a0b3-ccf1-2341
Port ID                            :XGigabitEthernet1/0/1
System name                        :CORE-SW-001
System description                 :Huawei Versatile Routing Platform Software
                                    VRP (R) software, Version 8.180
                                    Copyright (C) 2012-2022 Huawei Technologies Co., Ltd.
Management address                 :10.10.1.1`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    // Should capture first line of system description
    assert.strictEqual(result[0].sysDescr, 'Huawei Versatile Routing Platform Software');
    // Should still parse management address after multiline description
    assert.strictEqual(result[0].mgmtAddr, '10.10.1.1');
  });

  it('should handle ports with complex slot/subslot numbering', () => {
    const input = `GE3/0/48 has 1 neighbor(s):
Neighbor index :1
Chassis ID :aaa
Port ID :eth0
System name :DEV1`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].localPort, 'GE3/0/48');
  });

  it('should handle neighbor device names with spaces', () => {
    const input = `Local Interface                     Expd(s) Neighbor Interface             Neighbor Device
---------------------------------------------------------------------------------------------
GE1/0/1                             95      eth0                           Conference Room A`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sysName, 'Conference Room A');
  });

  it('should handle case variations in field names', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
CHASSIS ID                         :a0b3-ccf1-2341
port id                            :eth0
SYSTEM NAME                        :CORE-SW-001
management address                 :10.10.1.1`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].chassisId, 'a0b3-ccf1-2341');
    assert.strictEqual(result[0].sysName, 'CORE-SW-001');
    assert.strictEqual(result[0].mgmtAddr, '10.10.1.1');
  });

  it('should handle colons in values correctly', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
Chassis ID                         :a0b3-ccf1-2341
Port ID                            :eth0
System name                        :Device:With:Colons
Port description                   :Port:Description:With:Many:Colons`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sysName, 'Device:With:Colons');
    assert.strictEqual(result[0].portDescr, 'Port:Description:With:Many:Colons');
  });

  it('should normalize remote port ID in detailed format', () => {
    const input = `10GE1/0/1 has 1 neighbor(s):

Neighbor index                     :1
Chassis ID                         :a0b3-ccf1-2341
Port ID                            :GigabitEthernet0/0/1
System name                        :CORE-SW-001`;

    const result = parseHuaweiLldpNeighbors(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].portId, 'GE0/0/1');
  });
});

// =============================================================================
// Performance sanity check
// =============================================================================

describe('Performance sanity check', () => {
  it('should parse large detailed fixture in reasonable time', () => {
    const input = loadFixture('lldp-large-detailed.txt');
    const start = performance.now();

    for (let i = 0; i < 10; i++) {
      parseHuaweiLldpNeighbors(input);
    }

    const elapsed = performance.now() - start;
    const avgTime = elapsed / 10;

    // Should complete each parse in under 10ms (very generous)
    assert.ok(avgTime < 10, `Average parse time ${avgTime.toFixed(2)}ms exceeds 10ms threshold`);
  });

  it('should parse large compact fixture in reasonable time', () => {
    const input = loadFixture('lldp-large-compact.txt');
    const start = performance.now();

    for (let i = 0; i < 10; i++) {
      parseHuaweiLldpNeighbors(input);
    }

    const elapsed = performance.now() - start;
    const avgTime = elapsed / 10;

    // Should complete each parse in under 10ms (very generous)
    assert.ok(avgTime < 10, `Average parse time ${avgTime.toFixed(2)}ms exceeds 10ms threshold`);
  });
});
