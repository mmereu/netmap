#!/usr/bin/env node
/**
 * Test script per verificare la sincronizzazione NeDi con importazione neighbors
 *
 * Usage:
 *   node test-sync-with-neighbors.mjs
 */

import fetch from 'node-fetch';

async function testSyncWithNeighbors() {
  console.log('='.repeat(60));
  console.log('TEST: Sincronizzazione NeDi con Neighbors LLDP');
  console.log('='.repeat(60));

  const apiUrl = 'http://localhost:3000/api/admin/sync-nedi';

  try {
    console.log('\n[1] Invio richiesta di sincronizzazione...');
    console.log(`    POST ${apiUrl}`);

    const startTime = Date.now();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prefix: '',
        fullSync: false
      })
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    console.log(`\n[2] Sincronizzazione completata in ${duration}ms`);
    console.log('-'.repeat(60));

    // Mostra statistiche devices
    console.log('\n📦 DEVICES:');
    console.log(`   Inseriti:      ${result.stats.devices.inserted}`);
    console.log(`   Aggiornati:    ${result.stats.devices.updated}`);
    console.log(`   Totale NeDi:   ${result.stats.devices.total}`);

    // Mostra statistiche links
    console.log('\n🔗 LINKS:');
    console.log(`   Inseriti:      ${result.stats.links.inserted}`);
    console.log(`   Skippati:      ${result.stats.links.skipped}`);
    console.log(`   Eliminati:     ${result.stats.links.deleted}`);
    console.log(`   Totale NeDi:   ${result.stats.links.total}`);

    // Mostra statistiche neighbors (NUOVA FASE 3)
    console.log('\n🌐 NEIGHBORS LLDP:');
    console.log(`   Inseriti:      ${result.stats.neighbors.inserted}`);
    console.log(`   Skippati:      ${result.stats.neighbors.skipped}`);
    console.log(`   Totale NeDi:   ${result.stats.neighbors.total}`);

    // Timing
    console.log('\n⏱️  PERFORMANCE:');
    console.log(`   Durata sync:   ${result.stats.duration}ms`);
    console.log(`   Ultima sync:   ${result.lastSync}`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ TEST COMPLETATO CON SUCCESSO!');
    console.log('='.repeat(60));

    // Verifica che neighbors siano stati importati
    if (result.stats.neighbors.inserted > 0) {
      console.log(`\n✨ ${result.stats.neighbors.inserted} neighbors LLDP importati come devices virtuali`);
      console.log('   Questi dispositivi appariranno nella topologia con:');
      console.log('   - Vendor: "LLDP Neighbor"');
      console.log('   - Status: "discovered"');
      console.log('   - IP: 192.168.255.x (fittizio)');
    } else if (result.stats.neighbors.total === 0) {
      console.log('\n⚠️  Nessun neighbor da importare (tutti già presenti in devices)');
    } else {
      console.log(`\n⚠️  ${result.stats.neighbors.skipped} neighbors skippati (già esistenti)`);
    }

  } catch (error) {
    console.error('\n❌ Errore durante il test:', error.message);
    console.error('\nAssicurati che il server sia avviato:');
    console.error('  node server.js');
    process.exit(1);
  }
}

// Esegui test
testSyncWithNeighbors();
