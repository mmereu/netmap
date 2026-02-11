#!/usr/bin/env node
/**
 * Ricerca MAC address nel database SQLite locale
 * (sincronizzato da NeDi)
 */

import NetMapDB from './libdb.js';

const macInput = process.argv[2] || '00:00:48:1b:a4:a7';
const networkFilter = process.argv[3] || null;

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
console.log('║           NetMap - Ricerca MAC in SQLite Locale                  ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

const macNorm = normalizeMac(macInput);
const macColon = formatMac(macInput);

console.log(`🔍 MAC cercato: ${macInput}`);
console.log(`   Normalizzato: ${macNorm}`);
console.log(`   Formato colon: ${macColon}`);
if (networkFilter) console.log(`   Network filter: ${networkFilter}`);
console.log('');

if (!macNorm) {
  console.error('❌ MAC address non valido');
  process.exit(1);
}

const db = new NetMapDB('./netmap.db');
let found = false;

try {
  // Cerca nella NODES table (MAC/ARP entries da NeDi)
  console.log('═══ Ricerca in NODES table ═══\n');

  const nodesQuery = db.db.prepare(`
    SELECT n.*, d.sysname, d.ip as device_ip, d.syslocation, d.vendor
    FROM nodes n
    LEFT JOIN devices d ON n.device_id = d.id
    WHERE LOWER(REPLACE(REPLACE(REPLACE(n.mac, ':', ''), '-', ''), '.', '')) = ?
    ORDER BY n.lastseen DESC
    LIMIT 10
  `);

  const nodes = nodesQuery.all(macNorm);

  if (nodes.length > 0) {
    console.log(`✓ Trovato ${nodes.length} record in NODES:\n`);
    for (const node of nodes) {
      console.log(`  📍 Switch: ${node.sysname || 'N/A'}`);
      console.log(`     IP Switch: ${node.device_ip || 'N/A'}`);
      console.log(`     Vendor: ${node.vendor || 'N/A'}`);
      console.log(`     Location: ${node.syslocation || 'N/A'}`);
      console.log(`     Interface: ${node.ifname || node.port || 'N/A'}`);
      console.log(`     VLAN: ${node.vlanid || 'N/A'}`);
      console.log(`     IP Host: ${node.ip || 'N/A'}`);
      console.log(`     Hostname: ${node.name || 'N/A'}`);
      console.log(`     Last seen: ${node.lastseen || 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Nessun risultato in NODES\n');
  }

  // Cerca nella FDB table (Forwarding Database)
  console.log('═══ Ricerca in FDB table ═══\n');

  const fdbQuery = db.db.prepare(`
    SELECT f.*, d.sysname, d.ip as device_ip, d.syslocation, d.vendor
    FROM fdb f
    LEFT JOIN devices d ON f.device_id = d.id
    WHERE LOWER(REPLACE(REPLACE(REPLACE(f.mac, ':', ''), '-', ''), '.', '')) = ?
    ORDER BY f.lastseen DESC
    LIMIT 10
  `);

  const fdbs = fdbQuery.all(macNorm);

  if (fdbs.length > 0) {
    console.log(`✓ Trovato ${fdbs.length} record in FDB:\n`);
    for (const fdb of fdbs) {
      console.log(`  📍 Switch: ${fdb.sysname || 'N/A'}`);
      console.log(`     IP Switch: ${fdb.device_ip || 'N/A'}`);
      console.log(`     Vendor: ${fdb.vendor || 'N/A'}`);
      console.log(`     Location: ${fdb.syslocation || 'N/A'}`);
      console.log(`     Interface: ${fdb.ifname || fdb.port || 'N/A'}`);
      console.log(`     VLAN: ${fdb.vlan || 'N/A'}`);
      console.log(`     Last seen: ${fdb.lastseen || 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Nessun risultato in FDB\n');
  }

  // Cerca nella ARP table
  console.log('═══ Ricerca in ARP table ═══\n');

  const arpQuery = db.db.prepare(`
    SELECT a.*, d.sysname, d.ip as device_ip, d.syslocation
    FROM arp a
    LEFT JOIN devices d ON a.device_id = d.id
    WHERE LOWER(REPLACE(REPLACE(REPLACE(a.mac, ':', ''), '-', ''), '.', '')) = ?
    ORDER BY a.lastseen DESC
    LIMIT 10
  `);

  const arps = arpQuery.all(macNorm);

  if (arps.length > 0) {
    console.log(`✓ Trovato ${arps.length} record in ARP:\n`);
    for (const arp of arps) {
      console.log(`  📍 Router/Switch: ${arp.sysname || 'N/A'}`);
      console.log(`     IP Device: ${arp.device_ip || 'N/A'}`);
      console.log(`     Location: ${arp.syslocation || 'N/A'}`);
      console.log(`     IP associato al MAC: ${arp.ip || 'N/A'}`);
      console.log(`     Interface: ${arp.ifname || 'N/A'}`);
      console.log(`     Last seen: ${arp.lastseen || 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Nessun risultato in ARP\n');
  }

  // Cerca anche nei device (potrebbe essere un dispositivo di rete)
  console.log('═══ Ricerca in DEVICES table ═══\n');

  const devQuery = db.db.prepare(`
    SELECT * FROM devices
    WHERE LOWER(REPLACE(REPLACE(REPLACE(serial, ':', ''), '-', ''), '.', '')) LIKE ?
    LIMIT 5
  `);

  const devs = devQuery.all(`%${macNorm}%`);

  if (devs.length > 0) {
    console.log(`✓ È un device di rete:\n`);
    for (const dev of devs) {
      console.log(`  📍 Nome: ${dev.sysname}`);
      console.log(`     IP: ${dev.ip}`);
      console.log(`     Vendor: ${dev.vendor || 'N/A'}`);
      console.log(`     Model: ${dev.model || 'N/A'}`);
      console.log(`     Location: ${dev.syslocation || 'N/A'}`);
      console.log('');
    }
    found = true;
  } else {
    console.log('   Non è un device di rete conosciuto\n');
  }

  // Vendor OUI Lookup
  console.log('═══ Vendor OUI Lookup ═══\n');

  const oui = macNorm.slice(0, 6).toUpperCase();
  const ouiFormatted = `${oui.slice(0,2)}:${oui.slice(2,4)}:${oui.slice(4,6)}`;

  // Database OUI comune
  const commonOui = {
    '000048': 'Seiko Epson Corporation',
    '000001': 'Xerox Corporation',
    '000002': 'BBN (Bolt Beranek and Newman)',
    '002590': 'Supermicro',
    '00000C': 'Cisco Systems',
    '0050C2': 'IEEE Registration Authority',
    'F48E38': 'Dell',
    '001E68': 'Quanta Computer',
    '001DD8': 'Microsoft Corporation',
    'D4BED9': 'Dell',
    'B8CA3A': 'Dell',
    '000C29': 'VMware',
    '005056': 'VMware',
    '0050BA': 'D-Link',
    '001122': 'Cimsys'
  };

  const vendor = commonOui[oui] || 'Unknown vendor';
  console.log(`   OUI: ${ouiFormatted}`);
  console.log(`   Vendor: ${vendor}\n`);

  if (oui === '000048') {
    console.log('   💡 Questo MAC appartiene a Seiko Epson (stampanti, scanner)\n');
  }

  db.close();

} catch (err) {
  console.error('❌ Errore:', err.message);
  console.error(err.stack);
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════════');
if (found) {
  console.log('✅ MAC address trovato nel database locale');
} else {
  console.log('❌ MAC address NON trovato nel database locale');
  console.log('');
  console.log('   📋 Il MAC 00:00:48:xx:xx:xx è Seiko Epson (stampante)');
  console.log('   📋 Per trovarlo serve ricerca SSH live sugli switch');
}
console.log('═══════════════════════════════════════════════════════════════════\n');
