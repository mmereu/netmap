import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== CREAZIONE VISTA LINK ESSENZIALI ===\n');

// Statistiche attuali
const current = db.prepare('SELECT COUNT(*) as count FROM links').get();
console.log('Link attuali:', current.count);

// STRATEGIA:
// 1. Mantieni TUTTI i link LLDP/CDP (sono i link reali)
// 2. Mantieni link FDB SOLO per device che NON hanno link LLDP/CDP

// Device che hanno già link LLDP/CDP
const devicesWithLLDP = db.prepare(`
  SELECT DISTINCT device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP')
  UNION
  SELECT DISTINCT remote_device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP') AND remote_device_id IS NOT NULL
`).all().map(d => d.device_id);

console.log(`Device con link LLDP/CDP: ${devicesWithLLDP.length}`);

// Rimuovi link FDB per device che hanno già LLDP
const removeFDBforLLDP = db.prepare(`
  DELETE FROM links 
  WHERE protocol = 'FDB' 
  AND device_id IN (
    SELECT DISTINCT device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP')
  )
  AND remote_device_id IN (
    SELECT DISTINCT device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP')
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP') AND remote_device_id IS NOT NULL
  )
`).run();

console.log(`Rimossi ${removeFDBforLLDP.changes} link FDB tra device che hanno già LLDP`);

// Per i device senza LLDP, mantieni SOLO UN link FDB (verso il device più importante/centrale)
// Trova device senza LLDP
const devicesNoLLDP = db.prepare(`
  SELECT d.id, d.ip, d.sysname
  FROM devices d
  WHERE d.id NOT IN (
    SELECT DISTINCT device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP')
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE protocol IN ('LLDP', 'CDP', 'FDP', 'EDP') AND remote_device_id IS NOT NULL
  )
`).all();

console.log(`Device senza LLDP: ${devicesNoLLDP.length}`);

// Per ogni device senza LLDP, mantieni solo il link FDB verso il device con più connessioni
for (const device of devicesNoLLDP) {
  // Trova tutti i link FDB di questo device
  const fdbLinks = db.prepare(`
    SELECT l.id, l.remote_device_id, 
           (SELECT COUNT(*) FROM links WHERE device_id = l.remote_device_id) as remote_links
    FROM links l
    WHERE l.device_id = ? AND l.protocol = 'FDB' AND l.remote_device_id IS NOT NULL
    ORDER BY remote_links DESC
  `).all(device.id);
  
  if (fdbLinks.length > 1) {
    // Mantieni solo il primo (verso device più connesso), elimina gli altri
    const keepId = fdbLinks[0].id;
    const deleteResult = db.prepare(`
      DELETE FROM links WHERE device_id = ? AND protocol = 'FDB' AND id != ?
    `).run(device.id, keepId);
    
    if (deleteResult.changes > 0) {
      console.log(`  ${device.sysname}: mantenuto 1 link FDB, rimossi ${deleteResult.changes}`);
    }
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
console.log(`Link totali: ${current.count} → ${after.count}`);
console.log('Per protocollo:');
byProtocol.forEach(p => console.log(`  - ${p.protocol}: ${p.count}`));

// Verifica copertura
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



