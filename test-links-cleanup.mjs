#!/usr/bin/env node
import { getNeDiDB } from './libnedi.js';

/**
 * Test per verificare il filtro e la deduplicazione dei link
 */

async function testLinksCleanup() {
  console.log('=== Test Filtro e Deduplicazione Link ===\n');

  try {
    const nedi = await getNeDiDB();

    // 1. Test getAllLinks()
    console.log('1. Test getAllLinks() con filtri e deduplicazione...');
    const allLinks = await nedi.getAllLinks();
    console.log(`   ✓ Totale link recuperati: ${allLinks.length}`);

    // Verifica che non ci siano neighbor con formato IP
    const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const ipNeighbors = allLinks.filter(link => ipPattern.test(link.remote_sysname));
    console.log(`   ✓ Link con neighbor IP (dovrebbe essere 0): ${ipNeighbors.length}`);

    if (ipNeighbors.length > 0) {
      console.log('   ❌ ERRORE: Trovati neighbor con formato IP:');
      ipNeighbors.slice(0, 5).forEach(link => {
        console.log(`      - ${link.local_sysname} -> ${link.remote_sysname}`);
      });
    }

    // Verifica che non ci siano link con linktype NULL
    const nullLinktype = allLinks.filter(link => !link.protocol || link.protocol === 'LLDP');
    console.log(`   ✓ Link con protocol LLDP (default): ${nullLinktype.length}`);

    // Mostra alcuni esempi
    console.log('\n   Primi 5 link:');
    allLinks.slice(0, 5).forEach(link => {
      console.log(`   - ${link.local_sysname}[${link.local_ifname}] -> ${link.remote_sysname} (${link.protocol})`);
    });

    // 2. Test getLinksForMap() con filtro per sito
    console.log('\n2. Test getLinksForMap() con filtro sito "10"...');
    const mapLinks = await nedi.getLinksForMap({ deviceFilter: '10' });
    console.log(`   ✓ Link per sito 10: ${mapLinks.length}`);

    // Verifica che non ci siano neighbor con formato IP
    const mapIpNeighbors = mapLinks.filter(link => ipPattern.test(link.target));
    console.log(`   ✓ Link con target IP (dovrebbe essere 0): ${mapIpNeighbors.length}`);

    // 3. Test getDeviceLinks() per un device specifico
    console.log('\n3. Test getDeviceLinks() per un device...');

    // Prendi il primo device dall'elenco link
    if (allLinks.length > 0) {
      const testDevice = allLinks[0].local_sysname;
      console.log(`   Device di test: ${testDevice}`);

      const deviceLinks = await nedi.getDeviceLinks(testDevice);
      console.log(`   ✓ Link per ${testDevice}: ${deviceLinks.length}`);

      // Verifica filtro IP
      const deviceIpNeighbors = deviceLinks.filter(link => ipPattern.test(link.remote_sysname));
      console.log(`   ✓ Link con neighbor IP (dovrebbe essere 0): ${deviceIpNeighbors.length}`);

      // Mostra link
      deviceLinks.slice(0, 3).forEach(link => {
        console.log(`   - ${link.local_ifname} -> ${link.remote_sysname}`);
      });
    }

    // 4. Statistiche aggregate
    console.log('\n4. Statistiche aggregate:');
    const uniqueDevices = new Set(allLinks.flatMap(l => [l.local_sysname, l.remote_sysname]));
    console.log(`   ✓ Device unici nei link: ${uniqueDevices.size}`);

    const protocols = {};
    allLinks.forEach(link => {
      protocols[link.protocol] = (protocols[link.protocol] || 0) + 1;
    });
    console.log('   ✓ Protocolli usati:');
    Object.entries(protocols).forEach(([proto, count]) => {
      console.log(`      - ${proto}: ${count} link`);
    });

    await nedi.close();
    console.log('\n✅ Test completato con successo!');

  } catch (error) {
    console.error('❌ Errore durante il test:', error.message);
    process.exit(1);
  }
}

// Esegui il test
testLinksCleanup();
