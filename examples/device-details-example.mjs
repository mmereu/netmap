#!/usr/bin/env node

/**
 * Esempio di utilizzo dei metodi di device details
 *
 * Dimostra come ottenere informazioni dettagliate su un device
 * usando i nuovi metodi aggiunti a NeDiDB
 */

import { getNeDiDB } from '../libnedi.js';

async function main() {
  try {
    // Inizializza connessione NeDi
    const nedi = await getNeDiDB();
    console.log('Connesso a NeDi database\n');

    // Esempio 1: Ottieni VLANs di un device
    console.log('=== Esempio 1: VLANs del device ===');
    const vlans = await nedi.getDeviceVlans('SW-CORE-01');
    console.log(`Trovate ${vlans.length} VLANs:`);
    vlans.forEach(vlan => {
      console.log(`  - VLAN ${vlan.vlan_id}: ${vlan.vlan_name}`);
    });

    // Esempio 2: Ottieni connessioni LLDP/CDP
    console.log('\n=== Esempio 2: Connessioni del device ===');
    const connections = await nedi.getDeviceConnections('SW-CORE-01');
    console.log(`Trovate ${connections.length} connessioni:`);
    connections.slice(0, 3).forEach(conn => {
      console.log(`  - ${conn.local_interface} -> ${conn.remote_device} (${conn.remote_interface})`);
      console.log(`    Vendor: ${conn.remote_vendor}, Protocol: ${conn.protocol}`);
    });

    // Esempio 3: Ultimi eventi
    console.log('\n=== Esempio 3: Ultimi eventi ===');
    const events = await nedi.getDeviceEvents('SW-CORE-01', 3);
    console.log(`Ultimi ${events.length} eventi:`);
    events.forEach(evt => {
      const date = new Date(evt.timestamp * 1000);
      console.log(`  [${evt.severity}] ${date.toISOString()}`);
      console.log(`    ${evt.description}`);
    });

    // Esempio 4: Status operativo
    console.log('\n=== Esempio 4: Status operativo ===');
    const status = await nedi.getDeviceStatus('SW-CORE-01');
    if (status) {
      console.log('Status del device:');
      console.log(`  - CPU: ${status.cpu_usage}%`);
      console.log(`  - Memoria: ${status.memory_usage}%`);
      console.log(`  - Temperatura: ${status.temperature}°C`);
      console.log(`  - Uptime: ${Math.floor(status.uptime_seconds / 86400)} giorni`);

      // Verifica alerts
      const activeAlerts = Object.entries(status.alerts)
        .filter(([key, value]) => value)
        .map(([key]) => key);

      if (activeAlerts.length > 0) {
        console.log(`  - ⚠️ ALERTS ATTIVI: ${activeAlerts.join(', ')}`);
      } else {
        console.log(`  - ✓ Nessun alert attivo`);
      }
    }

    // Esempio 5: Full status aggregato
    console.log('\n=== Esempio 5: Full status (aggregato) ===');
    const fullStatus = await nedi.getDeviceFullStatus('SW-CORE-01');
    console.log('Riepilogo completo:');
    console.log(`  Device: ${fullStatus.device.sysname} (${fullStatus.device.ip})`);
    console.log(`  Vendor: ${fullStatus.device.vendor}`);
    console.log(`  Model: ${fullStatus.device.model}`);
    console.log(`  OS: ${fullStatus.device.os}`);
    console.log(`  Interfacce: ${fullStatus.interfaces.count}`);
    console.log(`  VLANs: ${fullStatus.vlans.count}`);
    console.log(`  Connessioni: ${fullStatus.connections.count}`);
    console.log(`  Eventi recenti: ${fullStatus.events.count}`);

    // Esempio 6: Uso in un API endpoint (pseudocodice)
    console.log('\n=== Esempio 6: Uso in API REST ===');
    console.log('// Express endpoint example:');
    console.log(`
app.get('/api/devices/:name/details', async (req, res) => {
  try {
    const nedi = await getNeDiDB();
    const details = await nedi.getDeviceFullStatus(req.params.name);
    res.json(details);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});
    `);

    await nedi.close();
    console.log('\nEsempi completati con successo!');

  } catch (error) {
    console.error('Errore:', error.message);
    process.exit(1);
  }
}

main();
