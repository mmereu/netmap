/**
 * Test suite for lib/macUtils.js
 */
import {
  normalizeMac,
  isValidMac,
  formatMac,
  formatMacColon,
  formatMacHuawei,
  formatMacCisco,
  compareMac,
  extractOui,
  isBroadcast,
  isMulticast,
  isUnicast,
  createMacSearchPattern
} from './lib/macUtils.js';

let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('\n=== MAC Utils Test Suite ===\n');

// normalizeMac tests
console.log('normalizeMac:');
test('colon format', normalizeMac('aa:bb:cc:dd:ee:ff') === 'aabbccddeeff');
test('dash format', normalizeMac('aa-bb-cc-dd-ee-ff') === 'aabbccddeeff');
test('dot format', normalizeMac('aabb.ccdd.eeff') === 'aabbccddeeff');
test('huawei format', normalizeMac('aabb-ccdd-eeff') === 'aabbccddeeff');
test('uppercase', normalizeMac('AA:BB:CC:DD:EE:FF') === 'aabbccddeeff');
test('mixed case', normalizeMac('Aa:Bb:Cc:Dd:Ee:Ff') === 'aabbccddeeff');
test('no separator', normalizeMac('aabbccddeeff') === 'aabbccddeeff');
test('invalid - too short', normalizeMac('aabbccdd') === null);
test('invalid - too long', normalizeMac('aabbccddeeff00') === null);
test('invalid - null', normalizeMac(null) === null);
test('invalid - undefined', normalizeMac(undefined) === null);

// isValidMac tests
console.log('\nisValidMac:');
test('valid', isValidMac('aa:bb:cc:dd:ee:ff') === true);
test('invalid', isValidMac('invalid') === false);
test('null', isValidMac(null) === false);

// formatMac tests
console.log('\nformatMac:');
test('default colon', formatMac('aabbccddeeff') === 'aa:bb:cc:dd:ee:ff');
test('with dash', formatMac('aabbccddeeff', '-') === 'aa-bb-cc-dd-ee-ff');
test('huawei style', formatMac('aabbccddeeff', '-', 4) === 'aabb-ccdd-eeff');
test('cisco style', formatMac('aabbccddeeff', '.', 4) === 'aabb.ccdd.eeff');
test('from colon format', formatMac('aa:bb:cc:dd:ee:ff', '-') === 'aa-bb-cc-dd-ee-ff');
test('invalid returns null', formatMac('invalid') === null);

// formatMacColon tests
console.log('\nformatMacColon:');
test('from raw', formatMacColon('aabbccddeeff') === 'aa:bb:cc:dd:ee:ff');
test('from huawei', formatMacColon('aabb-ccdd-eeff') === 'aa:bb:cc:dd:ee:ff');

// formatMacHuawei tests
console.log('\nformatMacHuawei:');
test('from raw', formatMacHuawei('aabbccddeeff') === 'aabb-ccdd-eeff');
test('from colon', formatMacHuawei('aa:bb:cc:dd:ee:ff') === 'aabb-ccdd-eeff');

// formatMacCisco tests
console.log('\nformatMacCisco:');
test('from raw', formatMacCisco('aabbccddeeff') === 'aabb.ccdd.eeff');
test('from colon', formatMacCisco('aa:bb:cc:dd:ee:ff') === 'aabb.ccdd.eeff');

// compareMac tests
console.log('\ncompareMac:');
test('same format', compareMac('aa:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff') === true);
test('different format', compareMac('aa:bb:cc:dd:ee:ff', 'aabb-ccdd-eeff') === true);
test('different case', compareMac('AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff') === true);
test('different mac', compareMac('aa:bb:cc:dd:ee:ff', 'ff:ee:dd:cc:bb:aa') === false);
test('invalid first', compareMac('invalid', 'aa:bb:cc:dd:ee:ff') === false);
test('invalid second', compareMac('aa:bb:cc:dd:ee:ff', 'invalid') === false);

// extractOui tests
console.log('\nextractOui:');
test('extract oui', extractOui('aa:bb:cc:dd:ee:ff') === 'aabbcc');
test('from huawei', extractOui('aabb-ccdd-eeff') === 'aabbcc');
test('invalid', extractOui('invalid') === null);

// isBroadcast tests
console.log('\nisBroadcast:');
test('broadcast colon', isBroadcast('ff:ff:ff:ff:ff:ff') === true);
test('broadcast raw', isBroadcast('ffffffffffff') === true);
test('not broadcast', isBroadcast('aa:bb:cc:dd:ee:ff') === false);

// isMulticast tests
console.log('\nisMulticast:');
test('multicast 01', isMulticast('01:00:5e:00:00:01') === true);
test('multicast 33', isMulticast('33:33:00:00:00:01') === true);
test('unicast', isMulticast('00:11:22:33:44:55') === false);
test('broadcast is multicast', isMulticast('ff:ff:ff:ff:ff:ff') === true);

// isUnicast tests
console.log('\nisUnicast:');
test('unicast', isUnicast('00:11:22:33:44:55') === true);
test('broadcast not unicast', isUnicast('ff:ff:ff:ff:ff:ff') === false);
test('multicast not unicast', isUnicast('01:00:5e:00:00:01') === false);

// createMacSearchPattern tests
console.log('\ncreateMacSearchPattern:');
test('full mac', createMacSearchPattern('aa:bb:cc:dd:ee:ff') === '%aabbccddeeff%');
test('partial mac', createMacSearchPattern('aa:bb') === '%aabb%');
test('empty', createMacSearchPattern('') === '%');
test('null', createMacSearchPattern(null) === '%');

// Summary
console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
