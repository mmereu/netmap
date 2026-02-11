import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== PULIZIA LINK FDB RIDONDANTI ===\n');

// Statistiche prima
const before = db.prepare('SELECT COUNT(*) as count FROM links').get();
const byProtocol = db.prepare(`
  SELECT protocol, COUNT(*) as count 
  FROM links 
  GROUP BY protocol
`).all();

console.log('Link prima della pulizia:', before.count);
console.log('Per protocollo:');
byProtocol.forEach(p => console.log(`  - ${p.protocol}: ${p.count}`));

// STRATEGIA: Mantieni solo UN link FDB per coppia di device
// Se esiste già un link LLDP/CDP tra due device, rimuovi i link FDB
console.log('\n--- Rimozione link FDB ridondanti ---\n');

// 1. Rimuovi link FDB dove esiste già LLDP/CDP tra gli stessi device
const removedDuplicates = db.prepare(`
  DELETE FROM links 
  WHERE protocol = 'FDB' 
  AND EXISTS (
    SELECT 1 FROM links l2 
    WHERE l2.protocol IN ('LLDP', 'CDP', 'FDP', 'EDP')
    AND l2.device_id = links.device_id 
    AND l2.remote_device_id = links.remote_device_id
  )
`).run();
console.log(`Rimossi ${removedDuplicates.changes} link FDB duplicati (già esisteva LLDP/CDP)`);

// 2. Mantieni solo UN link FDB per coppia di device (il primo)
const fdbPairs = db.prepare(`
  SELECT device_id, remote_device_id, MIN(id) as keep_id, COUNT(*) as count
  FROM links 
  WHERE protocol = 'FDB'
  GROUP BY device_id, remote_device_id
  HAVING count > 1
`).all();

let removedMultiple = 0;
for (const pair of fdbPairs) {
  const result = db.prepare(`
    DELETE FROM links 
    WHERE protocol = 'FDB' 
    AND device_id = ? 
    AND remote_device_id = ?
    AND id != ?
  `).run(pair.device_id, pair.remote_device_id, pair.keep_id);
  removedMultiple += result.changes;
}
console.log(`Rimossi ${removedMultiple} link FDB multipli (mantenuto 1 per coppia)`);

// 3. Rimuovi link FDB inversi se esiste già il diretto
const removedInverse = db.prepare(`
  DELETE FROM links 
  WHERE protocol = 'FDB' 
  AND EXISTS (
    SELECT 1 FROM links l2 
    WHERE l2.device_id = links.remote_device_id 
    AND l2.remote_device_id = links.device_id
    AND l2.id < links.id
  )
`).run();
console.log(`Rimossi ${removedInverse.changes} link FDB inversi`);

// Statistiche dopo
const after = db.prepare('SELECT COUNT(*) as count FROM links').get();
const byProtocolAfter = db.prepare(`
  SELECT protocol, COUNT(*) as count 
  FROM links 
  GROUP BY protocol
`).all();

console.log('\n=== RISULTATO ===');
console.log(`Link totali: ${before.count} → ${after.count} (rimossi ${before.count - after.count})`);
console.log('Per protocollo:');
byProtocolAfter.forEach(p => console.log(`  - ${p.protocol}: ${p.count}`));

// Verifica copertura device
const coverage = db.prepare(`
  SELECT COUNT(DISTINCT d.id) as withLinks
  FROM devices d
  WHERE d.id IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
`).get();
const total = db.prepare("SELECT COUNT(*) as count FROM devices").get();
console.log(`\nDevice con link: ${coverage.withLinks}/${total.count}`);

db.close();



