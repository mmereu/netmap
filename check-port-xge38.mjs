#!/usr/bin/env node
// Verifica cosa è collegato a XGE1/0/38 su 08_L3_Rack-A_251

import Database from 'better-sqlite3';

const db = new Database('./netmap.db', { readonly: true });

console.log('=== Ricerca collegamenti porta XGE1/0/38 ===\n');

// 1. Trova il device
const device = db.prepare(`
  SELECT id, sysname, ip FROM devices
  WHERE sysname LIKE '%08_L3%251%' OR ip = '192.168.8.251'
`).get();

console.log('Device:', device);

if (device) {
  // 2. Cerca link su quella porta
  console.log('\n--- Link sulla porta XGE1/0/38 ---');
  const links = db.prepare(`
    SELECT local_ifname, remote_sysname, remote_ip, remote_ifname, linktype
    FROM links
    WHERE device_id = ? AND (local_ifname LIKE '%38%' OR local_ifname LIKE '%XGE%38%')
  `).all(device.id);

  if (links.length > 0) {
    links.forEach(l => console.log(l));
  } else {
    console.log('Nessun link trovato su porta 38');
  }

  // 3. Cerca tutti i link del device per vedere pattern porte
  console.log('\n--- Tutti i link LLDP del device (prime 20) ---');
  const allLinks = db.prepare(`
    SELECT local_ifname, remote_sysname, remote_ip, linktype
    FROM links
    WHERE device_id = ?
    ORDER BY local_ifname
    LIMIT 20
  `).all(device.id);

  allLinks.forEach(l => console.log(`${l.local_ifname} -> ${l.remote_sysname} (${l.remote_ip})`));

  // 4. Cerca MAC sulla porta (nella tabella nodes/fdb)
  console.log('\n--- MAC visti su porte XGE del device ---');
  const macs = db.prepare(`
    SELECT n.mac, n.ifname, n.vlan, n.source
    FROM nodes n
    WHERE n.device_id = ? AND n.ifname LIKE '%XGE%'
    LIMIT 10
  `).all(device.id);

  if (macs.length > 0) {
    macs.forEach(m => console.log(m));
  } else {
    console.log('Nessun MAC su porte XGE');
  }
}

// 5. Cerca switch L2 del sito 8
console.log('\n--- Switch L2 sito 8 ---');
const l2switches = db.prepare(`
  SELECT sysname, ip FROM devices
  WHERE sysname LIKE '08_L2_%' OR sysname LIKE '8_L2_%'
  ORDER BY sysname
`).all();

l2switches.forEach(s => console.log(`${s.sysname} - ${s.ip}`));

db.close();
console.log('\n=== Fine ===');
