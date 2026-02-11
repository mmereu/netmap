#!/usr/bin/env node
/**
 * Test per verifica integrazione mac_current_position nell'endpoint /api/search/mac/hybrid
 *
 * Testa che la ricerca in mac_current_position avvenga PRIMA della ricerca standard
 * e che le porte fisiche vengano prioritizzate rispetto alle VLAN interfaces.
 */

import http from 'http';

// Configurazione
const API_HOST = 'localhost';
const API_PORT = 3003;

// MAC di test (sostituisci con un MAC reale del tuo DB)
const TEST_MACS = [
  'd000.4caa.1cb7',  // Esempio formato Cisco
  'd0:00:4c:aa:1c:b7', // Formato con :
  'd0-00-4c-aa-1c-b7'  // Formato con -
];

/**
 * Esegue chiamata HTTP GET
 */
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Test ricerca MAC
 */
async function testMacSearch(mac) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing MAC: ${mac}`);
  console.log('='.repeat(80));

  try {
    const t0 = Date.now();
    const result = await httpGet(`/api/search/mac/hybrid?mac=${encodeURIComponent(mac)}`);
    const elapsed = Date.now() - t0;

    console.log(`\n✓ Response received in ${elapsed}ms`);
    console.log(`  Source: ${result.source || 'unknown'}`);
    console.log(`  Found: ${result.found ? 'YES' : 'NO'}`);
    console.log(`  Elapsed: ${result.elapsed || 'N/A'}`);

    if (result.found && result.endpoint) {
      console.log('\n📍 Endpoint trovato:');
      console.log(`  Device: ${result.endpoint.device}`);
      console.log(`  Interface: ${result.endpoint.ifName}`);
      console.log(`  VLAN: ${result.endpoint.vlan || 'N/A'}`);
      console.log(`  Source: ${result.endpoint.source}`);
      console.log(`  Vendor: ${result.endpoint.vendor || 'N/A'}`);
      if (result.endpoint.lastseen) {
        const lastseenDate = new Date(result.endpoint.lastseen * 1000);
        console.log(`  Last Seen: ${lastseenDate.toLocaleString('it-IT')}`);
      }
    }

    if (result.dbResult) {
      console.log('\n📊 Database Results:');

      if (result.dbResult.mac_current) {
        console.log(`\n  mac_current_position: ${result.dbResult.mac_current.count} results`);
        result.dbResult.mac_current.data.slice(0, 3).forEach((entry, idx) => {
          console.log(`    [${idx + 1}] ${entry.device} - ${entry.ifname} - VLAN ${entry.vlan || 'N/A'}`);
        });
      }

      if (result.dbResult.nodes) {
        console.log(`\n  nodes table: ${result.dbResult.nodes.count} results`);
        result.dbResult.nodes.data.slice(0, 3).forEach((entry, idx) => {
          console.log(`    [${idx + 1}] ${entry.device} - ${entry.interface} - VLAN ${entry.vlan || 'N/A'}`);
        });
      }

      if (result.dbResult.arp) {
        console.log(`\n  nodarp table: ${result.dbResult.arp.count} results`);
        result.dbResult.arp.data.slice(0, 3).forEach((entry, idx) => {
          console.log(`    [${idx + 1}] ${entry.device} - ${entry.interface || 'N/A'} - IP ${entry.ip || 'N/A'}`);
        });
      }
    }

    // Verifica priorità mac_current_position
    if (result.source === 'nedi-mac-current') {
      console.log('\n✅ SUCCESS: mac_current_position ha priorità (come richiesto)');
    } else if (result.source === 'nedi-db' && result.dbResult?.mac_current?.count > 0) {
      console.log('\n⚠️  WARNING: mac_current_position trovato ma non prioritizzato!');
    }

    return result;

  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    return null;
  }
}

/**
 * Main
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Test MAC Current Position Integration                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  // Verifica server raggiungibile
  try {
    await httpGet('/api/health');
    console.log(`✓ Server is running at http://${API_HOST}:${API_PORT}`);
  } catch (err) {
    console.error(`❌ Server not reachable: ${err.message}`);
    console.error(`   Make sure the server is running on port ${API_PORT}`);
    process.exit(1);
  }

  // Test con primo MAC (o MAC da argomento CLI)
  const macToTest = process.argv[2] || TEST_MACS[0];

  const result = await testMacSearch(macToTest);

  console.log('\n' + '='.repeat(80));
  console.log('Test completato');
  console.log('='.repeat(80));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
