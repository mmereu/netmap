import NetMapDB from './libdb.js';
import NetMapSNMP from './libsnmp.js';
import NetMapMap from './libmap.js';

/**
 * Script di test per le nuove funzionalità NetMap
 */

async function testDatabase() {
  console.log('=== Test Database ===\n');
  
  const db = new NetMapDB('./test_netmap.db');
  
  // Test inserimento device
  console.log('1. Inserimento device...');
  const deviceResult = db.upsertDevice({
    ip: '192.168.1.1',
    sysname: 'test-switch',
    sysdesc: 'Test Switch',
    status: 'active',
  });
  console.log(`   ✓ Device inserito con ID: ${deviceResult.lastInsertRowid}`);
  
  // Test query device
  console.log('2. Query device...');
  const device = db.getDevice('192.168.1.1');
  console.log(`   ✓ Device trovato: ${device.sysname} (${device.ip})`);
  
  // Test inserimento link
  console.log('3. Inserimento link...');
  db.upsertLink({
    device_id: device.id,
    local_ifindex: 1,
    local_ifname: 'GigabitEthernet0/1',
    remote_sysname: 'neighbor-switch',
    remote_chassisid: 'aa:bb:cc:dd:ee:ff',
    remote_portid: 'Gi0/24',
    protocol: 'LLDP',
  });
  console.log('   ✓ Link inserito');
  
  // Test query links
  console.log('4. Query links...');
  const links = db.getDeviceLinks(device.id);
  console.log(`   ✓ Trovati ${links.length} link`);
  
  // Test eventi
  console.log('5. Inserimento evento...');
  db.addEvent({
    device_id: device.id,
    type: 'discovery',
    severity: 'info',
    message: 'Test discovery event',
  });
  console.log('   ✓ Evento inserito');
  
  // Test query eventi
  const events = db.getEvents(10);
  console.log(`   ✓ Trovati ${events.length} eventi`);
  
  db.close();
  console.log('\n✓ Test database completato\n');
}

async function testSNMP() {
  console.log('=== Test SNMP Esteso ===\n');
  
  const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public', { timeout: 3000 });
  
  // Test su un IP (usa un IP valido nella tua rete)
  const testIP = process.env.TEST_IP || '127.0.0.1';
  console.log(`Test su IP: ${testIP} (usa TEST_IP env per cambiare)\n`);
  
  try {
    console.log('1. Test getSysName...');
    const sysName = await snmp.getSysName(testIP);
    console.log(`   ${sysName ? `✓ SysName: ${sysName}` : '✗ Nessuna risposta SNMP'}`);
    
    if (sysName) {
      console.log('2. Test discoverProtocols...');
      const discovery = await snmp.discoverProtocols(testIP);
      console.log(`   ✓ Protocolli trovati: ${discovery.protocols.join(', ') || 'nessuno'}`);
      console.log(`   ✓ LLDP neighbors: ${discovery.lldp.length}`);
      console.log(`   ✓ CDP neighbors: ${discovery.cdp.length}`);
      console.log(`   ✓ FDP neighbors: ${discovery.fdp.length}`);
      console.log(`   ✓ EDP neighbors: ${discovery.edp.length}`);
    }
  } catch (err) {
    console.log(`   ⚠ Errore (normale se IP non raggiungibile): ${err.message}`);
  }
  
  console.log('\n✓ Test SNMP completato\n');
}

async function testMaps() {
  console.log('=== Test Map Generator ===\n');
  
  const mapGen = new NetMapMap();
  
  // Dati di esempio
  const nodes = [
    { id: '1', label: 'Switch1', type: 'device', status: 'active' },
    { id: '2', label: 'Switch2', type: 'device', status: 'active' },
    { id: '3', label: 'Router1', type: 'device', status: 'active' },
    { id: '4', label: 'Neighbor', type: 'neighbor', status: 'active' },
  ];
  
  const links = [
    { from: '1', to: '2', protocol: 'LLDP', label: 'Gi0/1' },
    { from: '2', to: '3', protocol: 'CDP', label: 'Gi0/24' },
    { from: '1', to: '4', protocol: 'LLDP', label: 'Gi0/10' },
  ];
  
  console.log('1. Generazione JSON...');
  const jsonData = mapGen.generateJSON(nodes, links);
  console.log(`   ✓ JSON generato: ${jsonData.nodes.length} nodi, ${jsonData.links.length} link`);
  
  console.log('2. Applicazione layout...');
  mapGen.forceDirectedLayout(nodes, links, 20);
  console.log(`   ✓ Layout applicato`);
  
  console.log('3. Generazione SVG...');
  const svg = mapGen.generateSVG(nodes, links, {
    width: 800,
    height: 600,
    title: 'Test Network Map',
  });
  console.log(`   ✓ SVG generato (${svg.length} bytes)`);
  
  console.log('4. Salvataggio file...');
  mapGen.saveJSON(jsonData, './test_map.json');
  mapGen.saveSVG(svg, './test_map.svg');
  console.log('   ✓ File salvati: test_map.json, test_map.svg');
  
  console.log('\n✓ Test Map completato\n');
}

// Esegui tutti i test
async function runAllTests() {
  console.log('🚀 Test Funzionalità NetMap Estese\n');
  console.log('='.repeat(50) + '\n');
  
  try {
    await testDatabase();
    await testSNMP();
    await testMaps();
    
    console.log('='.repeat(50));
    console.log('✅ Tutti i test completati con successo!');
    console.log('='.repeat(50));
  } catch (err) {
    console.error('❌ Errore durante i test:', err);
    process.exit(1);
  }
}

runAllTests();









