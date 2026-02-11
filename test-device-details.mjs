#!/usr/bin/env node

/**
 * Test per i nuovi metodi di device details in libnedi.js
 *
 * Uso: node test-device-details.mjs [device-name]
 */

import { getNeDiDB } from './libnedi.js';

async function testDeviceDetails() {
  const deviceName = process.argv[2];

  if (!deviceName) {
    console.error('Uso: node test-device-details.mjs <device-name>');
    console.error('Esempio: node test-device-details.mjs SW-CORE-01');
    process.exit(1);
  }

  console.log(`\n========================================`);
  console.log(`Testing Device Details: ${deviceName}`);
  console.log(`========================================\n`);

  try {
    // Connetti al database NeDi
    const nedi = await getNeDiDB();
    console.log('[OK] Connesso a NeDi database\n');

    // Test 1: getDeviceInterfaces
    console.log('1. Testing getDeviceInterfaces...');
    const interfaces = await nedi.getDeviceInterfaces(deviceName);
    console.log(`   ✓ Trovate ${interfaces.length} interfacce`);
    if (interfaces.length > 0) {
      console.log(`   Esempio: ${interfaces[0].ifname} - ${interfaces[0].ifdescr}`);
    }

    // Test 2: getDeviceVlans
    console.log('\n2. Testing getDeviceVlans...');
    const vlans = await nedi.getDeviceVlans(deviceName);
    console.log(`   ✓ Trovate ${vlans.length} VLANs`);
    if (vlans.length > 0) {
      console.log(`   Esempio: VLAN ${vlans[0].vlan_id} - ${vlans[0].vlan_name}`);
    }

    // Test 3: getDeviceConnections
    console.log('\n3. Testing getDeviceConnections...');
    const connections = await nedi.getDeviceConnections(deviceName);
    console.log(`   ✓ Trovate ${connections.length} connessioni`);
    if (connections.length > 0) {
      const conn = connections[0];
      console.log(`   Esempio: ${conn.local_interface} -> ${conn.remote_device} (${conn.remote_interface})`);
    }

    // Test 4: getDeviceEvents
    console.log('\n4. Testing getDeviceEvents...');
    const events = await nedi.getDeviceEvents(deviceName, 5);
    console.log(`   ✓ Trovati ${events.length} eventi recenti`);
    if (events.length > 0) {
      const evt = events[0];
      console.log(`   Esempio: [${evt.severity}] ${evt.description.substring(0, 50)}...`);
    }

    // Test 5: getDeviceStatus
    console.log('\n5. Testing getDeviceStatus...');
    const status = await nedi.getDeviceStatus(deviceName);
    if (status) {
      console.log(`   ✓ Status trovato:`);
      console.log(`     - CPU: ${status.cpu_usage}%`);
      console.log(`     - Memory: ${status.memory_usage}%`);
      console.log(`     - Temperature: ${status.temperature}°C`);
      console.log(`     - Uptime: ${Math.floor(status.uptime_seconds / 86400)} giorni`);
      console.log(`     - Status: ${status.status}`);

      const alerts = Object.entries(status.alerts).filter(([k, v]) => v);
      if (alerts.length > 0) {
        console.log(`     - ALERTS: ${alerts.map(([k]) => k).join(', ')}`);
      }
    } else {
      console.log(`   ⚠ Nessuno status trovato`);
    }

    // Test 6: getDeviceFullStatus
    console.log('\n6. Testing getDeviceFullStatus...');
    const fullStatus = await nedi.getDeviceFullStatus(deviceName);
    console.log(`   ✓ Full status ottenuto:`);
    console.log(`     - Device: ${fullStatus.device.sysname} (${fullStatus.device.ip})`);
    console.log(`     - Interfaces: ${fullStatus.interfaces.count}`);
    console.log(`     - VLANs: ${fullStatus.vlans.count}`);
    console.log(`     - Connections: ${fullStatus.connections.count}`);
    console.log(`     - Events: ${fullStatus.events.count}`);
    console.log(`     - Status: ${fullStatus.status ? 'OK' : 'N/A'}`);

    // Output JSON completo (opzionale - decommentare per vedere tutto)
    // console.log('\n\nFull Status JSON:');
    // console.log(JSON.stringify(fullStatus, null, 2));

    console.log('\n========================================');
    console.log('Tutti i test completati con successo!');
    console.log('========================================\n');

    await nedi.close();
    process.exit(0);

  } catch (error) {
    console.error('\n[ERRORE]', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Esegui i test
testDeviceDetails();
