#!/usr/bin/env node
/**
 * Test suite per Extended Vendor Support
 *
 * Verifica:
 * - Registry vendor funzionante
 * - Lookup per nome, ID, enterprise ID
 * - Parser Huawei (non-regressione)
 * - Stub behavior per altri vendor
 *
 * Uso: node test-vendor-parsers.mjs [--verbose]
 */

import {
  getSupportedVendors,
  getParserByVendor,
  getParserByVendorId,
  getParserByEnterpriseId,
  createParserForDevice,
  extractEnterpriseId,
  isVendorSupported,
  isVendorImplemented,
  HuaweiParser
} from './lib/vendors/index.js';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;

function log(msg) {
  console.log(msg);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    log(`  ✗ ${name}`);
    log(`    Error: ${err.message}`);
    if (VERBOSE) {
      console.error(err.stack);
    }
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotNull(value, msg) {
  if (value === null || value === undefined) {
    throw new Error(`${msg || 'Value is null/undefined'}`);
  }
}

function assertThrows(fn, msg) {
  try {
    fn();
    throw new Error(`${msg || 'Expected function to throw'}`);
  } catch (err) {
    // Expected
    if (err.message.includes('Expected function to throw')) {
      throw err;
    }
  }
}

// ============================================
// Test Suite
// ============================================

log('\n=== Test Vendor Registry ===\n');

test('getSupportedVendors returns array', () => {
  const vendors = getSupportedVendors();
  assertEqual(Array.isArray(vendors), true, 'Should return array');
  assertEqual(vendors.length >= 4, true, 'Should have at least 4 vendors');
});

test('Huawei is registered', () => {
  const vendors = getSupportedVendors();
  const huawei = vendors.find(v => v.id === 'huawei');
  assertNotNull(huawei, 'Huawei should be registered');
  assertEqual(huawei.implemented, true, 'Huawei should be implemented');
});

test('Cisco is registered as stub', () => {
  const vendors = getSupportedVendors();
  const cisco = vendors.find(v => v.id === 'cisco');
  assertNotNull(cisco, 'Cisco should be registered');
  assertEqual(cisco.implemented, false, 'Cisco should be stub');
});

test('Arista is registered as stub', () => {
  const vendors = getSupportedVendors();
  const arista = vendors.find(v => v.id === 'arista');
  assertNotNull(arista, 'Arista should be registered');
  assertEqual(arista.implemented, false, 'Arista should be stub');
});

test('Juniper is registered as stub', () => {
  const vendors = getSupportedVendors();
  const juniper = vendors.find(v => v.id === 'juniper');
  assertNotNull(juniper, 'Juniper should be registered');
  assertEqual(juniper.implemented, false, 'Juniper should be stub');
});

log('\n=== Test Parser Lookup ===\n');

test('getParserByVendor("Huawei")', () => {
  const Parser = getParserByVendor('Huawei');
  assertNotNull(Parser, 'Should find Huawei parser');
  assertEqual(Parser.vendorId, 'huawei', 'vendorId should be huawei');
});

test('getParserByVendor("huawei") case-insensitive', () => {
  const Parser = getParserByVendor('huawei');
  assertNotNull(Parser, 'Should find huawei parser (lowercase)');
  assertEqual(Parser.vendorId, 'huawei');
});

test('getParserByVendor("HUAWEI") case-insensitive', () => {
  const Parser = getParserByVendor('HUAWEI');
  assertNotNull(Parser, 'Should find HUAWEI parser (uppercase)');
  assertEqual(Parser.vendorId, 'huawei');
});

test('getParserByVendor("H3C") maps to Huawei', () => {
  const Parser = getParserByVendor('H3C');
  assertNotNull(Parser, 'Should find H3C parser');
  assertEqual(Parser.vendorId, 'huawei', 'H3C should map to huawei');
});

test('getParserByVendor("Cisco")', () => {
  const Parser = getParserByVendor('Cisco');
  assertNotNull(Parser, 'Should find Cisco parser');
  assertEqual(Parser.vendorId, 'cisco');
});

test('getParserByVendor("Unknown") returns null', () => {
  const Parser = getParserByVendor('Unknown');
  assertEqual(Parser, null, 'Unknown vendor should return null');
});

test('getParserByEnterpriseId("2011") → Huawei', () => {
  const Parser = getParserByEnterpriseId('2011');
  assertNotNull(Parser, 'Should find parser for enterprise 2011');
  assertEqual(Parser.vendorId, 'huawei');
});

test('getParserByEnterpriseId("9") → Cisco', () => {
  const Parser = getParserByEnterpriseId('9');
  assertNotNull(Parser, 'Should find parser for enterprise 9');
  assertEqual(Parser.vendorId, 'cisco');
});

test('getParserByEnterpriseId("30065") → Arista', () => {
  const Parser = getParserByEnterpriseId('30065');
  assertNotNull(Parser, 'Should find parser for enterprise 30065');
  assertEqual(Parser.vendorId, 'arista');
});

test('getParserByEnterpriseId("2636") → Juniper', () => {
  const Parser = getParserByEnterpriseId('2636');
  assertNotNull(Parser, 'Should find parser for enterprise 2636');
  assertEqual(Parser.vendorId, 'juniper');
});

log('\n=== Test Enterprise ID Extraction ===\n');

test('extractEnterpriseId("1.3.6.1.4.1.2011.2.23.69") → "2011"', () => {
  const id = extractEnterpriseId('1.3.6.1.4.1.2011.2.23.69');
  assertEqual(id, '2011');
});

test('extractEnterpriseId("1.3.6.1.4.1.9.1.516") → "9"', () => {
  const id = extractEnterpriseId('1.3.6.1.4.1.9.1.516');
  assertEqual(id, '9');
});

test('extractEnterpriseId(null) → null', () => {
  const id = extractEnterpriseId(null);
  assertEqual(id, null);
});

test('extractEnterpriseId("invalid") → null', () => {
  const id = extractEnterpriseId('invalid');
  assertEqual(id, null);
});

log('\n=== Test Utility Functions ===\n');

test('isVendorSupported("Huawei") → true', () => {
  assertEqual(isVendorSupported('Huawei'), true);
});

test('isVendorSupported("Cisco") → true', () => {
  assertEqual(isVendorSupported('Cisco'), true);
});

test('isVendorSupported("Unknown") → false', () => {
  assertEqual(isVendorSupported('Unknown'), false);
});

test('isVendorImplemented("Huawei") → true', () => {
  assertEqual(isVendorImplemented('Huawei'), true);
});

test('isVendorImplemented("Cisco") → false (stub)', () => {
  assertEqual(isVendorImplemented('Cisco'), false);
});

log('\n=== Test Device Parser Factory ===\n');

test('createParserForDevice with vendor', () => {
  const parser = createParserForDevice({ vendor: 'Huawei' });
  assertNotNull(parser, 'Should create parser');
  assertEqual(parser.constructor.vendorId, 'huawei');
});

test('createParserForDevice with sysobjectid', () => {
  const parser = createParserForDevice({
    sysobjectid: '1.3.6.1.4.1.2011.2.23.69'
  });
  assertNotNull(parser, 'Should create parser from sysObjectID');
  assertEqual(parser.constructor.vendorId, 'huawei');
});

test('createParserForDevice with unknown returns null', () => {
  const parser = createParserForDevice({ vendor: 'Unknown' });
  assertEqual(parser, null);
});

log('\n=== Test Huawei Parser ===\n');

test('HuaweiParser.isImplemented === true', () => {
  assertEqual(HuaweiParser.isImplemented, true);
});

test('HuaweiParser.getLldpCommand()', () => {
  const parser = new HuaweiParser();
  assertEqual(parser.getLldpCommand(), 'display lldp neighbor');
});

test('HuaweiParser.getDisablePagingCommand()', () => {
  const parser = new HuaweiParser();
  assertEqual(parser.getDisablePagingCommand(), 'screen-length 0 temporary');
});

test('HuaweiParser.getCdpCommand() → null', () => {
  const parser = new HuaweiParser();
  assertEqual(parser.getCdpCommand(), null);
});

test('HuaweiParser.parseLldpOutput() works', () => {
  const parser = new HuaweiParser();
  const sampleOutput = `
GE0/0/1 has 1 neighbor(s):
Neighbor index : 1
Chassis type   : MAC address
Chassis ID     : 00e0-fc12-3456
Port ID type   : Interface name
Port ID        : GigabitEthernet0/0/2
System name    : switch-02
System description: Huawei S5720
`;

  const neighbors = parser.parseLldpOutput(sampleOutput);
  assertEqual(Array.isArray(neighbors), true, 'Should return array');
  assertEqual(neighbors.length >= 1, true, 'Should parse at least 1 neighbor');
  assertNotNull(neighbors[0].localPort, 'Should have localPort');
  assertNotNull(neighbors[0].remoteDevice, 'Should have remoteDevice');
});

test('HuaweiParser chassis ID normalization', () => {
  const parser = new HuaweiParser();
  // Test internal method if accessible
  const normalized = parser._normalizeChassisId('00e0-fc12-3456');
  assertEqual(normalized, '00:e0:fc:12:34:56', 'Should normalize Huawei MAC format');
});

log('\n=== Test Stub Behavior ===\n');

test('CiscoParser.isImplemented === false', () => {
  const Parser = getParserByVendor('Cisco');
  assertEqual(Parser.isImplemented, false);
});

test('CiscoParser.getLldpCommand() returns command', () => {
  const Parser = getParserByVendor('Cisco');
  const parser = new Parser();
  assertEqual(parser.getLldpCommand(), 'show lldp neighbors detail');
});

test('CiscoParser.getCdpCommand() returns command', () => {
  const Parser = getParserByVendor('Cisco');
  const parser = new Parser();
  assertEqual(parser.getCdpCommand(), 'show cdp neighbors detail');
});

test('CiscoParser.parseLldpOutput() throws error', () => {
  const Parser = getParserByVendor('Cisco');
  const parser = new Parser();
  assertThrows(() => parser.parseLldpOutput('test'), 'Stub should throw');
});

test('AristaParser.parseLldpOutput() throws error', () => {
  const Parser = getParserByVendor('Arista');
  const parser = new Parser();
  assertThrows(() => parser.parseLldpOutput('test'), 'Stub should throw');
});

test('JuniperParser.parseLldpOutput() throws error', () => {
  const Parser = getParserByVendor('Juniper');
  const parser = new Parser();
  assertThrows(() => parser.parseLldpOutput('test'), 'Stub should throw');
});

// ============================================
// Summary
// ============================================

log('\n========================================');
log(`Tests completed: ${passed + failed}`);
log(`  Passed: ${passed}`);
log(`  Failed: ${failed}`);
log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
