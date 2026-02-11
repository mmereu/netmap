#!/usr/bin/env node

/**
 * Test endpoint GET /api/devices/:deviceName/detail
 *
 * Uso:
 *   node test-device-detail.mjs <deviceName>
 *   node test-device-detail.mjs 192.168.1.1
 *   node test-device-detail.mjs SWITCH-CORE-01
 */

import http from 'http';

const PORT = 3000;
const HOST = 'localhost';
const deviceName = process.argv[2];

if (!deviceName) {
  console.error('Errore: Specificare il nome o IP del device');
  console.error('Uso: node test-device-detail.mjs <deviceName>');
  console.error('Esempio: node test-device-detail.mjs 192.168.1.1');
  process.exit(1);
}

console.log(`\n🔍 Test endpoint: GET /api/devices/${deviceName}/detail\n`);

const options = {
  hostname: HOST,
  port: PORT,
  path: `/api/devices/${encodeURIComponent(deviceName)}/detail`,
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`Status: ${res.statusCode} ${res.statusMessage}\n`);

    try {
      const json = JSON.parse(data);

      // Mostra sommario
      console.log('📊 SOMMARIO RISPOSTA:');
      console.log('─'.repeat(60));
      console.log(`Source:      ${json.source || 'N/A'}`);
      console.log(`Device:      ${json.device?.sysname || 'N/A'} (${json.device?.ip || 'N/A'})`);
      console.log(`Model:       ${json.device?.vendor || 'N/A'} ${json.device?.model || 'N/A'}`);
      console.log(`Interfaces:  ${json.interfaces?.count || 0}`);
      console.log(`VLANs:       ${json.vlans?.count || 0}`);
      console.log(`Connections: ${json.connections?.count || 0}`);
      console.log(`Events:      ${json.events?.count || 0}`);
      console.log(`Status:      ${json.status?.status || 'N/A'}`);

      if (json.status) {
        console.log(`\n📈 MONITORING:`);
        console.log(`  CPU:        ${json.status.cpu_usage !== null ? json.status.cpu_usage + '%' : 'N/A'}`);
        console.log(`  Memory:     ${json.status.memory_usage !== null ? json.status.memory_usage + '%' : 'N/A'}`);
        console.log(`  Temperature: ${json.status.temperature !== null ? json.status.temperature + '°C' : 'N/A'}`);
        console.log(`  Latency:    ${json.status.latency !== null ? json.status.latency + 'ms' : 'N/A'}`);
      }

      console.log('\n' + '─'.repeat(60));
      console.log('\n✅ Test completato con successo\n');

      // Mostra JSON completo se richiesto
      if (process.argv.includes('--full')) {
        console.log('\n📄 JSON COMPLETO:');
        console.log(JSON.stringify(json, null, 2));
      } else {
        console.log('💡 Usa --full per vedere il JSON completo');
      }

    } catch (err) {
      console.error('❌ Errore parsing JSON:', err.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Errore richiesta HTTP:', error.message);
  console.error('\n⚠️  Assicurati che il server sia avviato su http://localhost:3000');
  process.exit(1);
});

req.end();
