#!/usr/bin/env node

/**
 * Script per inserire link di test con stati asimmetrici nel database NetMap
 *
 * Uso:
 *   node test-asymmetric-data.mjs insert   # Inserisce dati test
 *   node test-asymmetric-data.mjs remove   # Rimuove dati test
 *   node test-asymmetric-data.mjs status   # Mostra stato dei dati test
 */

import NetMapDB from './libdb.js';

const db = new NetMapDB('./netmap.db');

// Tag per identificare i device test
const TEST_TAG = '[TEST-ASYM]';

// Stati asimmetrici da testare
const testScenarios = [
  { name: 'Up → Down', forward: 'up', reverse: 'down' },
  { name: 'Up → Degraded', forward: 'up', reverse: 'degraded' },
  { name: 'Degraded → Down', forward: 'degraded', reverse: 'down' },
  { name: 'Up → Unknown', forward: 'up', reverse: 'unknown' },
  { name: 'Down → Unknown', forward: 'down', reverse: 'unknown' },
  { name: 'Degraded → Unknown', forward: 'degraded', reverse: 'unknown' },
];

/**
 * Inserisce device di test nel database
 */
function insertTestDevices() {
  console.log('📦 Inserimento device di test...');

  const devices = [];

  // Crea 2 device per ogni scenario (source e destination)
  testScenarios.forEach((scenario, index) => {
    const baseIp = `192.168.255.${100 + (index * 2)}`;

    // Device source
    const sourceDevice = {
      ip: baseIp,
      sysname: `${TEST_TAG} Source-${index + 1}`,
      sysdesc: `Test device for scenario: ${scenario.name}`,
      vendor: 'TEST',
      model: 'Virtual Switch',
      os: 'TestOS',
      status: 'active',
      level: 1,
    };

    // Device destination
    const destDevice = {
      ip: `192.168.255.${101 + (index * 2)}`,
      sysname: `${TEST_TAG} Dest-${index + 1}`,
      sysdesc: `Test device for scenario: ${scenario.name}`,
      vendor: 'TEST',
      model: 'Virtual Switch',
      os: 'TestOS',
      status: 'active',
      level: 2,
    };

    devices.push(sourceDevice, destDevice);
  });

  // Inserisci nel database
  const insertedDevices = [];
  devices.forEach(device => {
    const result = db.upsertDevice(device);
    insertedDevices.push({
      ...device,
      id: result.lastInsertRowid
    });
    console.log(`   ✓ Device ${device.sysname} (${device.ip}) - ID: ${result.lastInsertRowid}`);
  });

  return insertedDevices;
}

/**
 * Inserisce link di test con stati asimmetrici
 */
function insertTestLinks(devices) {
  console.log('\n🔗 Inserimento link di test con stati asimmetrici...');

  const links = [];

  // Per ogni scenario, crea un link tra source e dest
  testScenarios.forEach((scenario, index) => {
    const sourceDevice = devices[index * 2];
    const destDevice = devices[index * 2 + 1];

    if (!sourceDevice || !destDevice) {
      console.warn(`   ⚠ Skip scenario ${index}: device non trovati`);
      return;
    }

    // Ottieni gli ID dei device (lastInsertRowid o cerca nel DB)
    const sourceId = sourceDevice.id || db.getDevice(sourceDevice.ip)?.id;
    const destId = destDevice.id || db.getDevice(destDevice.ip)?.id;

    if (!sourceId || !destId) {
      console.warn(`   ⚠ Skip scenario ${index}: device ID non trovati`);
      return;
    }

    // Crea interfacce fittizie
    const sourceIfIndex = 100 + index;
    const destIfIndex = 200 + index;

    db.upsertInterface({
      device_id: sourceId,
      ifindex: sourceIfIndex,
      ifname: `GigabitEthernet0/${index}`,
      ifdescr: `Test interface ${scenario.name}`,
      iftype: 6,
      ifspeed: 1000000000, // 1 Gbps
      ifadminstatus: 1,
      ifoperstatus: 1,
    });

    db.upsertInterface({
      device_id: destId,
      ifindex: destIfIndex,
      ifname: `GigabitEthernet0/${index}`,
      ifdescr: `Test interface ${scenario.name}`,
      iftype: 6,
      ifspeed: 1000000000,
      ifadminstatus: 1,
      ifoperstatus: 1,
    });

    // Inserisci link (forward direction)
    const linkForward = {
      device_id: sourceId,
      local_ifindex: sourceIfIndex,
      local_ifname: `GigabitEthernet0/${index}`,
      remote_device_id: destId,
      remote_ip: destDevice.ip,
      remote_sysname: destDevice.sysname,
      remote_portid: `GigabitEthernet0/${index}`,
      remote_portdesc: `Test port ${scenario.name}`,
      protocol: 'LLDP',
    };

    const resultForward = db.upsertLink(linkForward);

    console.log(`   ✓ Link ${scenario.name}: ${sourceDevice.sysname} → ${destDevice.sysname}`);
    console.log(`      Forward: ${scenario.forward} | Reverse: ${scenario.reverse}`);
    console.log(`      Link ID: ${resultForward.lastInsertRowid}`);

    links.push({
      ...linkForward,
      id: resultForward.lastInsertRowid,
      forward_status: scenario.forward,
      reverse_status: scenario.reverse,
    });
  });

  return links;
}

/**
 * Rimuove tutti i device e link di test
 */
function removeTestData() {
  console.log('🗑️  Rimozione dati di test...');

  const devices = db.getAllDevices().filter(d => d.sysname?.includes(TEST_TAG));

  if (devices.length === 0) {
    console.log('   ℹ Nessun device di test trovato');
    return;
  }

  devices.forEach(device => {
    // I link verranno eliminati automaticamente per CASCADE
    db.db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
    console.log(`   ✓ Rimosso device ${device.sysname} (${device.ip})`);
  });

  console.log(`\n✅ Rimossi ${devices.length} device di test e relativi link`);
}

/**
 * Mostra stato dei dati test
 */
function showStatus() {
  console.log('📊 Stato dati di test:\n');

  const devices = db.getAllDevices().filter(d => d.sysname?.includes(TEST_TAG));
  const allLinks = db.getAllLinks();
  const testLinks = allLinks.filter(l =>
    l.local_sysname?.includes(TEST_TAG) || l.remote_device_sysname?.includes(TEST_TAG)
  );

  console.log(`Device di test: ${devices.length}`);
  console.log(`Link di test: ${testLinks.length}\n`);

  if (devices.length > 0) {
    console.log('Device:');
    devices.forEach(d => {
      console.log(`  - ${d.sysname} (${d.ip}) - Level ${d.level}`);
    });
  }

  if (testLinks.length > 0) {
    console.log('\nLink:');
    testLinks.forEach(l => {
      console.log(`  - ${l.local_sysname} → ${l.remote_device_sysname}`);
      console.log(`    ${l.local_ifname} ↔ ${l.remote_portdesc || l.remote_portid}`);
    });
  }

  if (devices.length === 0 && testLinks.length === 0) {
    console.log('ℹ Nessun dato di test presente');
  } else {
    console.log('\n💡 Per testare:');
    console.log('   1. Avvia il server: npm start');
    console.log('   2. Apri http://localhost:4000/topology-nedi-layer.html');
    console.log('   3. Oppure usa endpoint API: http://localhost:4000/api/test/asymmetric-links');
  }
}

// Main execution
const command = process.argv[2] || 'status';

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║         NetMap - Test Dati Asimmetrici per Gradients             ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

try {
  switch (command) {
    case 'insert':
      const devices = insertTestDevices();
      const links = insertTestLinks(devices);
      console.log(`\n✅ Inseriti ${devices.length} device e ${links.length} link di test`);
      console.log('\n💡 Usa "node test-asymmetric-data.mjs status" per verificare');
      console.log('💡 Usa "node test-asymmetric-data.mjs remove" per rimuovere i dati test');
      break;

    case 'remove':
      removeTestData();
      break;

    case 'status':
      showStatus();
      break;

    default:
      console.log('❌ Comando non valido. Usa: insert | remove | status');
      process.exit(1);
  }
} catch (error) {
  console.error('\n❌ Errore:', error.message);
  console.error(error.stack);
  process.exit(1);
} finally {
  db.close();
}
