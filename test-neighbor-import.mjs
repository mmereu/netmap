#!/usr/bin/env node
/**
 * Test script per verificare l'importazione dei neighbors LLDP
 *
 * Usage:
 *   node test-neighbor-import.mjs
 */

import { getNeDiDB } from './libnedi.js';

async function testNeighborImport() {
  console.log('='.repeat(60));
  console.log('TEST: Importazione Neighbors LLDP');
  console.log('='.repeat(60));

  try {
    // 1. Connetti a NeDi
    console.log('\n[1] Connessione a NeDi...');
    const nedi = await getNeDiDB();
    console.log('✓ Connesso a NeDi MySQL');

    // 2. Ottieni neighbors LLDP
    console.log('\n[2] Recupero neighbors LLDP non presenti in devices...');
    const neighbors = await nedi.getNeighborDevices();
    console.log(`✓ Trovati ${neighbors.length} neighbors LLDP non ancora in devices`);

    if (neighbors.length === 0) {
      console.log('\n⚠ Nessun neighbor da importare (tutti già presenti in devices)');
      await nedi.disconnect();
      return;
    }

    // 3. Mostra primi 10 neighbors
    console.log('\n[3] Primi 10 neighbors da importare:');
    console.log('-'.repeat(60));
    neighbors.slice(0, 10).forEach((neighbor, idx) => {
      console.log(`${idx + 1}. ${neighbor.sysname}`);
      console.log(`   IP: ${neighbor.ip || 'N/A (verrà generato IP fittizio)'}`);
    });

    if (neighbors.length > 10) {
      console.log(`... e altri ${neighbors.length - 10} neighbors`);
    }

    // 4. Statistiche
    console.log('\n[4] Statistiche:');
    console.log('-'.repeat(60));
    const withIp = neighbors.filter(n => n.ip).length;
    const withoutIp = neighbors.filter(n => !n.ip).length;
    console.log(`Neighbors con IP reale:    ${withIp}`);
    console.log(`Neighbors senza IP:        ${withoutIp} (riceveranno IP fittizi 192.168.255.x)`);
    console.log(`Totale da importare:       ${neighbors.length}`);

    console.log('\n✓ Test completato con successo!');

    console.log('\n' + '='.repeat(60));
    console.log('PROSSIMO PASSO:');
    console.log('  Esegui sync NeDi dal web UI o via API:');
    console.log('  POST http://localhost:3000/api/admin/sync-nedi');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ Errore durante il test:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Esegui test
testNeighborImport();
