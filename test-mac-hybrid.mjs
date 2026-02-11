#!/usr/bin/env node
/**
 * Test MAC Hybrid Search
 * Testa il nuovo endpoint /api/search/mac/hybrid
 *
 * Usage:
 *   node test-mac-hybrid.mjs <mac> [network]
 *   node test-mac-hybrid.mjs 00e6-0e5c-9540 192.168.26.0/24
 *   node test-mac-hybrid.mjs 00e6-0e5c-9540                 # Solo DB
 */

const API_URL = process.env.NETMAP_API || 'http://localhost:4000';

async function testHybridSearch(mac, network = null) {
  console.log('='.repeat(60));
  console.log('TEST MAC HYBRID SEARCH');
  console.log('='.repeat(60));
  console.log(`MAC: ${mac}`);
  console.log(`Network: ${network || '(solo DB)'}`);
  console.log(`API: ${API_URL}/api/search/mac/hybrid`);
  console.log('='.repeat(60));

  const body = { mac };
  if (network) body.network = network;

  const t0 = Date.now();

  try {
    const response = await fetch(`${API_URL}/api/search/mac/hybrid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    const elapsed = Date.now() - t0;

    console.log('\n--- RISULTATO ---');
    console.log(`Status: ${response.status}`);
    console.log(`Tempo totale: ${elapsed}ms`);
    console.log(`Source: ${result.source || 'N/A'}`);
    console.log(`Found: ${result.found}`);
    console.log(`Server elapsed: ${result.elapsed}`);

    if (result.endpoint) {
      console.log('\n--- ENDPOINT ---');
      console.log(`Device: ${result.endpoint.device || 'N/A'}`);
      console.log(`Device IP: ${result.endpoint.deviceIp || result.endpoint.ip || 'N/A'}`);
      console.log(`Interface: ${result.endpoint.ifName || 'N/A'}`);
      console.log(`VLAN: ${result.endpoint.vlan || 'N/A'}`);
      if (result.endpoint.lldpNeighbor) {
        console.log(`LLDP Neighbor: ${result.endpoint.lldpNeighbor}`);
      }
      if (result.endpoint.endpointDevice) {
        console.log(`Endpoint Device: ${result.endpoint.endpointDevice}`);
      }
    }

    if (result.dbResult) {
      console.log('\n--- DB RESULTS ---');
      console.log(`Nodes: ${result.dbResult.nodes?.count || 0}`);
      console.log(`ARP: ${result.dbResult.arp?.count || 0}`);
      if (result.dbResult.nodes?.data?.length > 0) {
        console.log('\nTop 3 nodes:');
        result.dbResult.nodes.data.slice(0, 3).forEach((n, i) => {
          console.log(`  ${i + 1}. ${n.device} ${n.interface} VLAN:${n.vlan} (${n.vendor || '-'})`);
        });
      }
    }

    if (result.sshResult) {
      console.log('\n--- SSH TRACE ---');
      console.log(`Hops: ${result.sshResult.hops}`);
      console.log(`SSH elapsed: ${result.sshResult.elapsed}`);
      if (result.sshResult.path?.length > 0) {
        console.log('\nPath:');
        result.sshResult.path.forEach((hop, i) => {
          console.log(`  ${i + 1}. ${hop.ip} (${hop.sysName || '-'}) → ${hop.ifName || '-'} VLAN:${hop.vlan || '-'}`);
        });
      }
    }

    if (result.error) {
      console.log(`\nError: ${result.error}`);
    }

    console.log('\n--- RAW JSON ---');
    console.log(JSON.stringify(result, null, 2));

    return result;

  } catch (err) {
    console.error('\nERRORE:', err.message);
    return null;
  }
}

// Main
const mac = process.argv[2];
const network = process.argv[3] || null;

if (!mac) {
  console.log('Usage: node test-mac-hybrid.mjs <mac> [network]');
  console.log('');
  console.log('Examples:');
  console.log('  node test-mac-hybrid.mjs 00e6-0e5c-9540 192.168.26.0/24');
  console.log('  node test-mac-hybrid.mjs 00:e6:0e:5c:95:40');
  console.log('  node test-mac-hybrid.mjs 00e60e5c9540');
  process.exit(1);
}

testHybridSearch(mac, network);
