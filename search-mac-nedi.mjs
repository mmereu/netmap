#!/usr/bin/env node
/**
 * Ricerca MAC address in NeDi DB
 */

import NeDiDB from './libnedi.js';

const macInput = process.argv[2] || '00:00:48:1b:a4:a7';

function normalizeMac(mac) {
  if (!mac) return null;
  const clean = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return clean.length === 12 ? clean : null;
}

function formatMac(mac, sep = ':') {
  const clean = normalizeMac(mac);
  if (!clean) return null;
  return clean.match(/.{2}/g).join(sep);
}

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║               NetMap - Ricerca MAC in NeDi DB                    ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

const macNorm = normalizeMac(macInput);
const macColon = formatMac(macInput);

console.log(`🔍 MAC cercato: ${macInput}`);
console.log(`   Normalizzato: ${macNorm}`);
console.log(`   Formato colon: ${macColon}\n`);

if (!macNorm) {
  console.error('❌ MAC address non valido');
  process.exit(1);
}

const nedi = new NeDiDB();
let found = false;

try {
  await nedi.init();
  console.log('✓ Connesso a NeDi MySQL\n');

  // Cerca in nodes table
  console.log('═══ Ricerca in NODES table ═══\n');

  const nodesQuery = `
    SELECT n.mac, n.device, n.ifname, n.vlanid, n.ip, n.name, n.lastseen,
           d.device as device_name, d.devip, d.type as device_type, d.location
    FROM nodes n
    LEFT JOIN devices d ON n.device = d.device
    WHERE REPLACE(REPLACE(REPLACE(LOWER(n.mac), ':', ''), '-', ''), '.', '') = '${macNorm}'
    ORDER BY n.lastseen DESC
    LIMIT 10
  `;

  const nodes = await nedi.execQuery(nodesQuery);

  if (nodes.length > 0) {
    console.log(`✓ Trovato ${nodes.length} record:\n`);
    for (const node of nodes) {
      const devIp = nedi.longToIp(node.devip);
      console.log(`  📍 Switch: ${node.device_name || node.device}`);
      console.log(`     IP Switch: ${devIp || 'N/A'}`);
      console.log(`     Location: ${node.location || 'N/A'}`);
      console.log(`     Porta: ${node.ifname || 'N/A'}`);
      console.log(`     VLAN: ${node.vlanid || 'N/A'}`);
      console.log(`     IP Host: ${node.ip || 'N/A'}`);
      console.log(`     Nome Host: ${node.name || 'N/A'}`);
      console.log(`     Last seen: ${node.lastseen ? new Date(node.lastseen * 1000).toISOString() : 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Nessun risultato in nodes\n');
  }

  // Cerca in nodarp table
  console.log('═══ Ricerca in NODARP table ═══\n');

  const arpQuery = `
    SELECT na.mac, na.device, na.nodip, na.lastseen,
           d.device as device_name, d.devip, d.location
    FROM nodarp na
    LEFT JOIN devices d ON na.device = d.device
    WHERE REPLACE(REPLACE(REPLACE(LOWER(na.mac), ':', ''), '-', ''), '.', '') = '${macNorm}'
    ORDER BY na.lastseen DESC
    LIMIT 10
  `;

  const arps = await nedi.execQuery(arpQuery);

  if (arps.length > 0) {
    console.log(`✓ Trovato ${arps.length} record:\n`);
    for (const arp of arps) {
      const devIp = nedi.longToIp(arp.devip);
      const hostIp = nedi.longToIp(arp.nodip);
      console.log(`  📍 Router/Switch: ${arp.device_name || arp.device}`);
      console.log(`     IP Device: ${devIp || 'N/A'}`);
      console.log(`     Location: ${arp.location || 'N/A'}`);
      console.log(`     IP associato al MAC: ${hostIp || 'N/A'}`);
      console.log(`     Last seen: ${arp.lastseen ? new Date(arp.lastseen * 1000).toISOString() : 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Nessun risultato in nodarp\n');
  }

  // Cerca nei devices (caso in cui sia il MAC di uno switch)
  console.log('═══ Ricerca in DEVICES table ═══\n');

  // Il MAC dei device in NeDi potrebbe essere in formato diverso
  const devQuery = `
    SELECT device, devip, type, vendor, devos, location, serial
    FROM devices
    WHERE REPLACE(REPLACE(REPLACE(LOWER(serial), ':', ''), '-', ''), '.', '') LIKE '%${macNorm}%'
       OR LOWER(device) LIKE '%${macNorm.slice(-6)}%'
    LIMIT 5
  `;

  const devs = await nedi.execQuery(devQuery);

  if (devs.length > 0) {
    console.log(`✓ Potrebbe essere un device di rete:\n`);
    for (const dev of devs) {
      const devIp = nedi.longToIp(dev.devip);
      console.log(`  📍 Nome: ${dev.device}`);
      console.log(`     IP: ${devIp}`);
      console.log(`     Tipo: ${dev.type || 'N/A'}`);
      console.log(`     Vendor: ${dev.vendor || 'N/A'}`);
      console.log(`     OS: ${dev.devos || 'N/A'}`);
      console.log(`     Location: ${dev.location || 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Non è un device di rete conosciuto\n');
  }

  // Chiudi pool
  if (nedi.pool) {
    await nedi.pool.end();
  }

} catch (err) {
  console.error('❌ Errore:', err.message);
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════════');
if (found) {
  console.log('✅ MAC address trovato nel database NeDi');
} else {
  console.log('❌ MAC address NON trovato nel database NeDi');
  console.log('   Il MAC potrebbe essere:');
  console.log('   - Offline o mai connesso');
  console.log('   - Su una rete non monitorata da NeDi');
  console.log('   - Scaduto dal database (entry vecchia)');
}
console.log('═══════════════════════════════════════════════════════════════════\n');
