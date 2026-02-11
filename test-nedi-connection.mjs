#!/usr/bin/env node
/**
 * Test connessione a NeDi MySQL
 */

import { getNeDiDB } from './libnedi.js';

async function test() {
  try {
    console.log('Connessione a NeDi...');
    const db = await getNeDiDB();

    // Test stats
    console.log('\n=== STATISTICHE ===');
    const stats = await db.getStats();
    console.log(stats);

    // Test devices
    console.log('\n=== PRIMI 5 DEVICES ===');
    const devices = await db.getDevicesPaginated({ limit: 5 });
    devices.forEach(d => {
      console.log(`  ${d.sysname} - ${d.ip} - ${d.vendor || 'N/A'}`);
    });

    // Test links
    console.log('\n=== PRIMI 10 LINKS ===');
    const links = await db.getLinksForMap({ limit: 10 });
    links.slice(0, 10).forEach(l => {
      console.log(`  ${l.source}:${l.source_port} --> ${l.target}:${l.target_port}`);
    });

    // Test topology
    console.log('\n=== TOPOLOGY DATA (negozio 10) ===');
    const topo = await db.getTopologyData({ deviceFilter: '10_' });
    console.log(`  Nodi: ${topo.nodes.length}`);
    console.log(`  Edges: ${topo.edges.length}`);

    await db.close();
    console.log('\nTest completato!');

  } catch (err) {
    console.error('ERRORE:', err.message);
    process.exit(1);
  }
}

test();
