#!/usr/bin/env node
import mysql from 'mysql2/promise';

const testMac = process.argv[2] || '00e60e749740';
const cleanMac = testMac.replace(/[:.|-]/g, '').toLowerCase();

const conn = await mysql.createConnection({
  host: process.env.NEDI_MYSQL_HOST || 'localhost',
  user: process.env.NEDI_MYSQL_USER || 'nedi',
  password: process.env.NEDI_MYSQL_PASS || '',
  database: process.env.NEDI_MYSQL_DB || 'nedi'
});

console.log('RICERCA COMPLETA PER MAC:', testMac);
console.log('='.repeat(60));

// 1. mac_movements - prima verifica struttura
console.log('\n1. MAC_MOVEMENTS (storico spostamenti):');
const [moveCols] = await conn.query('DESCRIBE mac_movements');
console.log('   Colonne:', moveCols.map(c => c.Field).join(', '));
const [movements] = await conn.query(`
  SELECT * FROM mac_movements
  WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
  ORDER BY id DESC
  LIMIT 10
`);
console.log(`   Trovati: ${movements.length}`);
movements.forEach(m => console.log(`   ${JSON.stringify(m)}`));

// 2. iftrack
console.log('\n2. IFTRACK (associazioni MAC-porta):');
const [iftrack] = await conn.query(`
  SELECT * FROM iftrack
  WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
`);
console.log(`   Trovati: ${iftrack.length}`);
iftrack.forEach(i => console.log(`   ${i.device} ${i.ifname} - MAC: ${i.mac} - lastchg: ${i.lastchg}`));

// 3. nbrtrack (neighbors)
console.log('\n3. NBRTRACK (neighbors):');
const [nbrtrack] = await conn.query(`
  SELECT * FROM nbrtrack
  WHERE neighbor LIKE '%${cleanMac}%' OR device LIKE '%${cleanMac}%'
  LIMIT 10
`);
console.log(`   Trovati: ${nbrtrack.length}`);
nbrtrack.forEach(n => console.log(`   ${n.device} ${n.ifname} -> ${n.neighbor}`));

// 4. nodarp
console.log('\n4. NODARP (ARP entries):');
const [nodarp] = await conn.query(`
  SELECT * FROM nodarp
  WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
`);
console.log(`   Trovati: ${nodarp.length}`);
nodarp.forEach(n => console.log(`   ${n.name} - ${n.ip} - MAC: ${n.mac} - device: ${n.device} ${n.arpifname}`));

// 5. Cerca altri MAC sullo stesso device per vedere le porte fisiche
const [macOnSameDevice] = await conn.query(`
  SELECT device, ifname FROM mac_current_position
  WHERE mac = '${testMac}'
`);
if (macOnSameDevice.length > 0) {
  const device = macOnSameDevice[0].device;
  console.log(`\n5. ALTRE PORTE FISICHE SU ${device}:`);
  const [otherMacs] = await conn.query(`
    SELECT mac, ifname, vlanid
    FROM mac_current_position
    WHERE device = '${device}'
      AND ifname REGEXP '^(GE|XGE|Gi|Eth|Te|fo)'
    LIMIT 10
  `);
  console.log(`   Porte fisiche trovate: ${otherMacs.length}`);
  otherMacs.forEach(o => console.log(`   ${o.mac} - ${o.ifname} (VLAN ${o.vlanid})`));
}

// 6. Cerca nella tabella nodes la struttura del device per vedere se ha porte fisiche
console.log('\n6. TUTTE LE ENTRY PER QUESTO MAC IN nodes:');
const [nodesAll] = await conn.query(`
  SELECT DISTINCT device, ifname, vlanid
  FROM nodes
  WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
`);
console.log(`   Entry: ${nodesAll.length}`);
nodesAll.forEach(n => console.log(`   ${n.device} - ${n.ifname} (VLAN ${n.vlanid})`));

// 7. Cerca IP associato al MAC nella tabella iptrack o nodarp
console.log('\n7. IP ASSOCIATO AL MAC:');
const [ipFromArp] = await conn.query(`
  SELECT name, ip, mac, device, arpifname
  FROM nodarp
  WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
`);
const [ipFromTrack] = await conn.query(`
  SELECT * FROM iptrack
  WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
`);
console.log(`   Da nodarp: ${ipFromArp.length}`);
ipFromArp.forEach(a => console.log(`     IP: ${a.ip} - name: ${a.name} - device: ${a.device} ${a.arpifname}`));
console.log(`   Da iptrack: ${ipFromTrack.length}`);
ipFromTrack.forEach(t => console.log(`     IP: ${t.ip} - device: ${t.device} ${t.arpifname}`));

await conn.end();
console.log('\n' + '='.repeat(60));
