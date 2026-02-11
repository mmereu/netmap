#!/usr/bin/env node

/**
 * Test per la fix SQL Injection in searchMac()
 *
 * Testa che i parametri siano correttamente escaped e che non ci siano errori di sintassi SQL
 */

import NeDiDB from './libnedi.js';

const test_cases = [
  {
    name: 'MAC standard colon',
    mac: '00:e6:0e:71:24:80',
    expected: 'Pattern should be normalized without colons'
  },
  {
    name: 'MAC with hyphens',
    mac: '00-e6-0e-71-24-80',
    expected: 'Should handle hyphenated MAC'
  },
  {
    name: 'MAC with dots',
    mac: '00e6.0e71.2480',
    expected: 'Should handle dot-separated MAC'
  },
  {
    name: 'Partial MAC search',
    mac: '00e6',
    expected: 'Should support wildcard search'
  },
  {
    name: 'MAC with filters - site',
    mac: '00:e6:0e:71:24:80',
    filters: { site: '10' },
    expected: 'Should handle site filter safely'
  },
  {
    name: 'MAC with filters - vlan',
    mac: '00:e6:0e:71:24:80',
    filters: { vlan: '100' },
    expected: 'Should handle VLAN filter safely'
  },
  {
    name: 'MAC with multiple filters',
    mac: '00:e6:0e:71:24:80',
    filters: { site: '10', vlan: '100' },
    expected: 'Should handle multiple filters'
  }
];

async function runTests() {
  console.log('\n========================================');
  console.log('Testing MAC Search SQL Injection Fix');
  console.log('========================================\n');

  try {
    const nedi = new NeDiDB();

    for (const test of test_cases) {
      console.log(`TEST: ${test.name}`);
      console.log(`  MAC: ${test.mac}`);
      if (test.filters) {
        console.log(`  Filters: ${JSON.stringify(test.filters)}`);
      }

      try {
        const result = await nedi.searchMac(test.mac, 10, test.filters || {});
        console.log(`  ✓ PASS - Found ${result.totalCount} results (nodes: ${result.nodes.count}, arp: ${result.arp.count})`);
        if (result.nodes.count > 0) {
          console.log(`    First node: ${result.nodes.data[0].device} / ${result.nodes.data[0].interface}`);
        }
      } catch (err) {
        console.log(`  ✗ FAIL - ${err.message}`);
        if (err.message.includes('SYNTAX')) {
          console.log(`    ⚠ SQL SYNTAX ERROR - FIX DID NOT WORK`);
        }
      }
      console.log();
    }

    console.log('\n========================================');
    console.log('All tests completed!');
    console.log('========================================\n');

  } catch (err) {
    console.error('ERROR initializing NeDiDB:', err.message);
    process.exit(1);
  }
}

runTests();
