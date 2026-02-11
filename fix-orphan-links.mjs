import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== RICERCA DEVICE CON LINK SOLO IN USCITA ===\n');

// Device che hanno link in uscita ma NON in entrata
const orphans = db.prepare(`
  SELECT d.id, d.ip, d.sysname
  FROM devices d
  WHERE d.status = 'active'
  AND d.id IN (SELECT DISTINCT device_id FROM links)
  AND d.id NOT IN (SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL)
`).all();

console.log(`Device con solo link in uscita: ${orphans.length}\n`);

let fixed = 0;

for (const device of orphans) {
  console.log(`--- ${device.sysname} (${device.ip}) ---`);
  
  // Trova i link in uscita
  const outLinks = db.prepare(`
    SELECT l.*, d.id as target_id, d.ip as target_ip, d.sysname as target_name
    FROM links l
    JOIN devices d ON l.remote_device_id = d.id
    WHERE l.device_id = ?
  `).all(device.id);
  
  for (const link of outLinks) {
    console.log(`  Link: ${device.sysname} -> ${link.target_name}`);
    
    // Verifica se esiste il link inverso
    const reverse = db.prepare(`
      SELECT id FROM links WHERE device_id = ? AND remote_device_id = ?
    `).get(link.target_id, device.id);
    
    if (!reverse) {
      // Crea link inverso
      db.prepare(`
        INSERT INTO links (device_id, remote_device_id, remote_ip, remote_sysname, protocol)
        VALUES (?, ?, ?, ?, ?)
      `).run(link.target_id, device.id, device.ip, device.sysname, link.protocol + '-reverse');
      
      console.log(`  ✓ Creato link inverso: ${link.target_name} -> ${device.sysname}`);
      fixed++;
    }
  }
}

// Verifica anche device che NON hanno alcun link (né in entrata né in uscita)
const isolated = db.prepare(`
  SELECT d.id, d.ip, d.sysname
  FROM devices d
  WHERE d.status = 'active'
  AND d.id NOT IN (SELECT DISTINCT device_id FROM links)
  AND d.id NOT IN (SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL)
`).all();

if (isolated.length > 0) {
  console.log(`\n--- Device completamente isolati: ${isolated.length} ---`);
  
  const coreSwitch = db.prepare("SELECT id, ip, sysname FROM devices WHERE sysname LIKE '%S6730%'").get();
  
  for (const device of isolated) {
    console.log(`  ${device.sysname} -> collegato al core`);
    
    // Crea link verso il core
    db.prepare(`
      INSERT INTO links (device_id, remote_device_id, remote_ip, remote_sysname, protocol)
      VALUES (?, ?, ?, ?, 'orphan-fix')
    `).run(device.id, coreSwitch.id, coreSwitch.ip, coreSwitch.sysname);
    fixed++;
  }
}

console.log(`\n=== COMPLETATO ===`);
console.log(`Link creati: ${fixed}`);

// Statistiche finali
const stats = db.prepare('SELECT COUNT(*) as count FROM links').get();
console.log(`Link totali: ${stats.count}`);

db.close();



