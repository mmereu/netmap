#!/usr/bin/env node
/**
 * Test performance ricerca MAC - verifica fix REPLACE()
 * Confronta query pre e post fix
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const NeDiDB = require('./libnedi.js');

async function main() {
  const testMac = process.argv[2] || '00e60e61d8c0';

  console.log('='.repeat(60));
  console.log('Test Performance Ricerca MAC');
  console.log('='.repeat(60));
  console.log(`MAC da cercare: ${testMac}`);
  console.log('');

  const nedi = new NeDiDB();

  try {
    await nedi.connect();
    console.log('✓ Connesso a NeDi MySQL\n');

    // Test 1: searchMac
    console.log('1. Test searchMac()');
    let t0 = Date.now();
    const searchResult = await nedi.searchMac(testMac, 10);
    let elapsed = Date.now() - t0;
    console.log(`   ⏱️  Tempo: ${elapsed}ms`);
    console.log(`   📊 Risultati nodes: ${searchResult.nodes?.count || 0}`);
    console.log(`   📊 Risultati arp: ${searchResult.arp?.count || 0}`);
    console.log('');

    // Test 2: getArpInfo
    console.log('2. Test getArpInfo()');
    t0 = Date.now();
    const arpInfo = await nedi.getArpInfo(testMac);
    elapsed = Date.now() - t0;
    console.log(`   ⏱️  Tempo: ${elapsed}ms`);
    console.log(`   📊 Risultato: ${arpInfo ? 'trovato' : 'non trovato'}`);
    if (arpInfo) console.log(`   📊 IP: ${arpInfo.ip}`);
    console.log('');

    // Test 3: getMacHistory
    console.log('3. Test getMacHistory()');
    t0 = Date.now();
    const history = await nedi.getMacHistory(testMac, 30);
    elapsed = Date.now() - t0;
    console.log(`   ⏱️  Tempo: ${elapsed}ms`);
    console.log(`   📊 Record storici: ${history.length}`);
    console.log('');

    // Test 4: getVlanHistory
    console.log('4. Test getVlanHistory()');
    t0 = Date.now();
    const vlanHistory = await nedi.getVlanHistory(testMac);
    elapsed = Date.now() - t0;
    console.log(`   ⏱️  Tempo: ${elapsed}ms`);
    console.log(`   📊 VLAN storiche: ${vlanHistory.length}`);
    console.log('');

    // Test 5: getAllSwitchesForMac
    console.log('5. Test getAllSwitchesForMac()');
    t0 = Date.now();
    const switches = await nedi.getAllSwitchesForMac(testMac);
    elapsed = Date.now() - t0;
    console.log(`   ⏱️  Tempo: ${elapsed}ms`);
    console.log(`   📊 Switch trovati: ${switches.length}`);
    console.log('');

    // Test 6: searchMacInstant (aggregato)
    console.log('6. Test searchMacInstant() - AGGREGATO');
    t0 = Date.now();
    const instantResult = await nedi.searchMacInstant(testMac);
    elapsed = Date.now() - t0;
    console.log(`   ⏱️  Tempo TOTALE: ${elapsed}ms`);
    console.log(`   📊 Trovato: ${instantResult.found}`);
    console.log(`   📊 Endpoint: ${instantResult.endpoint?.switch || 'N/A'}`);
    console.log(`   📊 Porta: ${instantResult.endpoint?.port || 'N/A'}`);
    console.log('');

    console.log('='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`searchMacInstant totale: ${elapsed}ms`);
    if (elapsed < 500) {
      console.log('✅ PERFORMANCE OK - Ricerca sotto 500ms');
    } else if (elapsed < 2000) {
      console.log('⚠️  PERFORMANCE ACCETTABILE - Ricerca sotto 2s');
    } else {
      console.log('❌ PERFORMANCE CRITICA - Ricerca sopra 2s');
    }

    await nedi.close();

  } catch (err) {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  }
}

main();
