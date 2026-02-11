#!/usr/bin/env node
import Database from 'better-sqlite3';

const db = new Database('./netmap.db');

console.log('\n=== VERIFICA NEIGHBORS LLDP IMPORTATI ===\n');

// Conta neighbors LLDP
const result = db.prepare(`
  SELECT COUNT(*) as total
  FROM devices
  WHERE vendor = 'LLDP Neighbor'
`).get();

console.log(`Neighbors LLDP importati: ${result.total}`);

// Mostra primi 10 esempi
console.log('\nPrimi 10 esempi:\n');
const examples = db.prepare(`
  SELECT sysname, ip, vendor, status, level
  FROM devices
  WHERE vendor = 'LLDP Neighbor'
  LIMIT 10
`).all();

examples.forEach((dev, idx) => {
  console.log(`${idx + 1}. ${dev.sysname}`);
  console.log(`   IP: ${dev.ip}`);
  console.log(`   Vendor: ${dev.vendor}`);
  console.log(`   Status: ${dev.status}`);
  console.log(`   Level: ${dev.level}`);
  console.log('');
});

db.close();
