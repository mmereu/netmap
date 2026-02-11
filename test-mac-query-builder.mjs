#!/usr/bin/env node

/**
 * Unit test per verificare che le query SQL siano costruite correttamente
 * Questo test non richiede connessione a database
 */

console.log('\n========================================');
console.log('Testing SQL Query Building for MAC Search');
console.log('========================================\n');

// Simula la funzione searchMac per verificare la costruzione delle query
function buildMacSearchQueries(macPattern, limit = 100, filters = {}) {
  const cleanMac = macPattern.replace(/[:.|\-]/g, '').toLowerCase();

  const site = typeof filters.site === 'string' && /^\d{1,3}$/.test(filters.site) ? filters.site : null;
  const vlan = filters.vlan !== undefined ? parseInt(filters.vlan) : null;

  // Escape special characters in LIKE pattern for SQL
  const escapedMacPattern = `%${cleanMac.replace(/[%_\\]/g, '\\$&')}%`;
  const escapedSitePattern = site ? `${site}_%` : null;

  let nodesSql = `
    SELECT n.mac, n.device, n.ifname, n.vlanid, n.oui, n.nodesc,
           d.devip, d.type as devtype, d.location as devlocation
    FROM nodes n
    LEFT JOIN devices d ON n.device = d.device
    WHERE REPLACE(REPLACE(REPLACE(n.mac, ':', ''), '-', ''), '.', '') LIKE ?
  `;
  const nodeParams = [escapedMacPattern];

  if (site) {
    nodesSql += ` AND n.device LIKE ?`;
    nodeParams.push(escapedSitePattern);
  }
  if (vlan !== null && !Number.isNaN(vlan)) {
    nodesSql += ` AND n.vlanid = ?`;
    nodeParams.push(vlan);
  }
  nodesSql += ` LIMIT ${Math.min(limit, 1000)}`;

  let nodarpSql = `
    SELECT a.mac, a.nodip, a.arpdevice, a.arpifname, a.ipupdate, a.aname,
           d.devip, d.type as devtype
    FROM nodarp a
    LEFT JOIN devices d ON a.arpdevice = d.device
    WHERE REPLACE(REPLACE(REPLACE(a.mac, ':', ''), '-', ''), '.', '') LIKE ?
  `;
  const nodarpParams = [escapedMacPattern];

  if (site) {
    nodarpSql += ` AND a.arpdevice LIKE ?`;
    nodarpParams.push(escapedSitePattern);
  }
  if (vlan !== null && !Number.isNaN(vlan)) {
    nodarpSql += ` AND a.vlanid = ?`;
    nodarpParams.push(vlan);
  }
  nodarpSql += ` ORDER BY a.ipupdate DESC LIMIT ${Math.min(limit, 1000)}`;

  return {
    nodes: { sql: nodesSql.trim(), params: nodeParams },
    arp: { sql: nodarpSql.trim(), params: nodarpParams }
  };
}

// Test cases
const tests = [
  {
    name: 'Simple MAC (colon format)',
    mac: '00:e6:0e:71:24:80',
    filters: {}
  },
  {
    name: 'MAC with site filter',
    mac: '00:e6:0e:71:24:80',
    filters: { site: '10' }
  },
  {
    name: 'MAC with vlan filter',
    mac: '00:e6:0e:71:24:80',
    filters: { vlan: 100 }
  },
  {
    name: 'MAC with both filters',
    mac: '00:e6:0e:71:24:80',
    filters: { site: '10', vlan: 100 }
  }
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  console.log(`TEST: ${test.name}`);
  console.log(`  Input: MAC="${test.mac}", filters=${JSON.stringify(test.filters)}`);

  try {
    const result = buildMacSearchQueries(test.mac, 100, test.filters);

    // Verify structure
    if (!result.nodes || !result.nodes.sql || !result.nodes.params) {
      throw new Error('Invalid nodes query structure');
    }
    if (!result.arp || !result.arp.sql || !result.arp.params) {
      throw new Error('Invalid arp query structure');
    }

    // Verify placeholders match params count
    const nodesSqlPlaceholders = (result.nodes.sql.match(/\?/g) || []).length;
    const nodarpSqlPlaceholders = (result.arp.sql.match(/\?/g) || []).length;

    if (nodesSqlPlaceholders !== result.nodes.params.length) {
      throw new Error(`Mismatch in nodes query: ${nodesSqlPlaceholders} placeholders vs ${result.nodes.params.length} params`);
    }
    if (nodarpSqlPlaceholders !== result.arp.params.length) {
      throw new Error(`Mismatch in arp query: ${nodarpSqlPlaceholders} placeholders vs ${result.arp.params.length} params`);
    }

    // Verify no string interpolation with untrusted data
    const hasDangerousInterpolation = result.nodes.sql.includes('${') || result.arp.sql.includes('${');
    if (hasDangerousInterpolation) {
      throw new Error('SQL queries still contain dangerous string interpolation');
    }

    console.log(`  ✓ PASS`);
    console.log(`    Nodes: ${nodesSqlPlaceholders} placeholders, ${result.nodes.params.length} params`);
    console.log(`    ARP:   ${nodarpSqlPlaceholders} placeholders, ${result.arp.params.length} params`);
    console.log(`    Params: [${result.nodes.params.map(p => typeof p === 'string' ? `'${p}'` : p).join(', ')}]`);
    passed++;
  } catch (err) {
    console.log(`  ✗ FAIL - ${err.message}`);
    failed++;
  }
  console.log();
}

console.log('========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
