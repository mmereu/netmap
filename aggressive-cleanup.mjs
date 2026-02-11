import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== PULIZIA AGGRESSIVA - SOLO LINK ESSENZIALI ===\n');

const before = db.prepare('SELECT COUNT(*) as count FROM links').get();
console.log('Link prima:', before.count);

// 1. Trova i 12 device che NON hanno link LLDP (né come source né come dest)
const isolatedDevices = db.prepare(`
  SELECT d.id, d.ip, d.sysname
  FROM devices d
  WHERE d.status = 'active' 
  AND d.id NOT IN (
    SELECT DISTINCT device_id FROM links WHERE protocol IN ('LLDP', 'CDP')
  )
  AND d.id NOT IN (
    SELECT DISTINCT remote_device_id FROM links WHERE protocol IN ('LLDP', 'CDP') AND remote_device_id IS NOT NULL
  )
`).all();

console.log(`Device isolati (senza LLDP): ${isolatedDevices.length}`);
isolatedDevices.forEach(d => console.log(`  - ${d.sysname}`));

// 2. Rimuovi TUTTI i link FDB
const removedAll = db.prepare("DELETE FROM links WHERE protocol = 'FDB'").run();
console.log(`\nRimossi TUTTI i link FDB: ${removedAll.changes}`);

// 3. Ricrea UN SOLO link FDB per ogni device isolato (verso lo switch core S6730)
const coreSwitch = db.prepare("SELECT id, ip, sysname FROM devices WHERE sysname LIKE '%S6730%'").get();
console.log(`\nCore switch: ${coreSwitch?.sysname || 'NON TROVATO'}`);

if (coreSwitch) {
  for (const device of isolatedDevices) {
    // Crea link dal device isolato verso il core
    db.prepare(`
      INSERT INTO links (device_id, remote_device_id, remote_ip, remote_sysname, protocol)
      VALUES (?, ?, ?, ?, 'FDB-essential')
    `).run(device.id, coreSwitch.id, coreSwitch.ip, coreSwitch.sysname);
    
    console.log(`  + ${device.sysname} -> ${coreSwitch.sysname}`);
  }
}

// Statistiche finali
const after = db.prepare('SELECT COUNT(*) as count FROM links').get();
const byProtocol = db.prepare(`
  SELECT protocol, COUNT(*) as count 
  FROM links 
  GROUP BY protocol
`).all();

console.log('\n=== RISULTATO ===');
console.log(`Link totali: ${before.count} → ${after.count}`);
console.log('Per protocollo:');
byProtocol.forEach(p => console.log(`  - ${p.protocol}: ${p.count}`));

// Verifica copertura
const coverage = db.prepare(`
  SELECT COUNT(DISTINCT d.id) as withLinks
  FROM devices d
  WHERE d.status = 'active' AND d.id IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
`).get();
const total = db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'active'").get();
console.log(`\nDevice con link: ${coverage.withLinks}/${total.count}`);

db.close();



