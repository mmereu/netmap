import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== RICERCA LINK INVERSI ===\n');

// Device senza link
const devicesNoLinks = db.prepare(`
  SELECT d.id, d.ip, d.sysname
  FROM devices d
  WHERE d.status = 'active' AND d.id NOT IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
  ORDER BY d.ip
`).all();

console.log(`Device senza link: ${devicesNoLinks.length}\n`);

let linksCreated = 0;

for (const device of devicesNoLinks) {
  console.log(`\n--- ${device.ip} (${device.sysname}) ---`);
  
  // Cerca se questo device è visto come neighbor da altri
  // Match per sysname (esatto o parziale)
  const asNeighbor = db.prepare(`
    SELECT l.*, d.ip as source_ip, d.sysname as source_sysname
    FROM links l
    JOIN devices d ON l.device_id = d.id
    WHERE l.remote_device_id IS NULL
    AND (
      l.remote_sysname = ?
      OR l.remote_sysname LIKE ?
      OR LOWER(l.remote_sysname) = LOWER(?)
    )
  `).all(device.sysname, `%${device.sysname}%`, device.sysname);
  
  if (asNeighbor.length > 0) {
    console.log(`  ✓ Trovato come neighbor in ${asNeighbor.length} link:`);
    for (const link of asNeighbor) {
      console.log(`    - Da ${link.source_sysname} porta ${link.local_ifindex}`);
      
      // Aggiorna il link con remote_device_id
      db.prepare(`
        UPDATE links SET remote_device_id = ?, remote_ip = ?
        WHERE id = ?
      `).run(device.id, device.ip, link.id);
      
      // Crea link inverso se non esiste
      const reverseExists = db.prepare(`
        SELECT id FROM links WHERE device_id = ? AND remote_device_id = ?
      `).get(device.id, link.device_id);
      
      if (!reverseExists) {
        db.prepare(`
          INSERT INTO links (device_id, remote_device_id, remote_ip, remote_sysname, protocol)
          VALUES (?, ?, ?, ?, 'LLDP-reverse')
        `).run(device.id, link.device_id, link.source_ip, link.source_sysname);
        linksCreated++;
        console.log(`    → Link inverso creato`);
      }
    }
  } else {
    // Cerca per IP nel remote_ip
    const byIP = db.prepare(`
      SELECT l.*, d.ip as source_ip, d.sysname as source_sysname
      FROM links l
      JOIN devices d ON l.device_id = d.id
      WHERE l.remote_ip = ? AND l.remote_device_id IS NULL
    `).all(device.ip);
    
    if (byIP.length > 0) {
      console.log(`  ✓ Trovato per IP in ${byIP.length} link:`);
      for (const link of byIP) {
        console.log(`    - Da ${link.source_sysname}`);
        db.prepare('UPDATE links SET remote_device_id = ? WHERE id = ?').run(device.id, link.id);
      }
    } else {
      console.log(`  ✗ Non trovato come neighbor da nessun device`);
      
      // Ultima risorsa: cerca per MAC nelle interfacce
      const deviceMacs = db.prepare(`
        SELECT ifphysaddress FROM interfaces WHERE device_id = ? AND ifphysaddress IS NOT NULL
      `).all(device.id);
      
      for (const mac of deviceMacs) {
        const normalizedMAC = mac.ifphysaddress?.replace(/[:.|-]/g, '').toLowerCase();
        if (!normalizedMAC || normalizedMAC.length < 12) continue;
        
        const byMAC = db.prepare(`
          SELECT l.*, d.ip as source_ip, d.sysname as source_sysname
          FROM links l
          JOIN devices d ON l.device_id = d.id
          WHERE REPLACE(REPLACE(REPLACE(LOWER(l.remote_chassisid), ':', ''), '.', ''), '-', '') = ?
          AND l.remote_device_id IS NULL
        `).all(normalizedMAC);
        
        if (byMAC.length > 0) {
          console.log(`  ✓ Trovato per MAC ${mac.ifphysaddress} in ${byMAC.length} link`);
          for (const link of byMAC) {
            db.prepare('UPDATE links SET remote_device_id = ?, remote_ip = ? WHERE id = ?').run(device.id, device.ip, link.id);
          }
          break;
        }
      }
    }
  }
}

console.log(`\n=== COMPLETATO ===`);
console.log(`Link inversi creati: ${linksCreated}`);

// Verifica finale
const stats = db.prepare(`
  SELECT COUNT(DISTINCT d.id) as withLinks
  FROM devices d
  WHERE d.id IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
`).get();

const total = db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'active'").get();
console.log(`Device con link: ${stats.withLinks}/${total.count} (${Math.round(stats.withLinks / total.count * 100)}%)`);

// Lista device ancora senza link
const stillNoLinks = db.prepare(`
  SELECT d.ip, d.sysname
  FROM devices d
  WHERE d.status = 'active' AND d.id NOT IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
`).all();

if (stillNoLinks.length > 0) {
  console.log(`\nDevice ancora senza link: ${stillNoLinks.length}`);
  stillNoLinks.forEach(d => console.log(`  - ${d.ip} (${d.sysname})`));
}

db.close();



