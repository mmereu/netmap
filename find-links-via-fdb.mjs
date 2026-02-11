import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== RICERCA LINK VIA FDB (METODO NEDI) ===\n');

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
  
  // Ottieni tutti i MAC delle interfacce di questo device
  const deviceMacs = db.prepare(`
    SELECT ifindex, ifname, ifphysaddress 
    FROM interfaces 
    WHERE device_id = ? AND ifphysaddress IS NOT NULL AND ifphysaddress != ''
  `).all(device.id);
  
  if (deviceMacs.length === 0) {
    console.log('  ✗ Nessun MAC trovato per questo device');
    continue;
  }
  
  console.log(`  MAC interfaces: ${deviceMacs.length}`);
  
  let foundConnection = false;
  
  for (const iface of deviceMacs) {
    const normalizedMAC = iface.ifphysaddress?.replace(/[:.|-]/g, '').toLowerCase();
    if (!normalizedMAC || normalizedMAC.length < 12) continue;
    
    // Cerca questo MAC nella FDB di altri device
    const fdbEntries = db.prepare(`
      SELECT f.*, d.id as switch_id, d.ip as switch_ip, d.sysname as switch_sysname,
             i.ifindex as port_ifindex, i.ifname as port_name, i.ifdescr as port_descr
      FROM fdb f
      JOIN devices d ON f.device_id = d.id
      LEFT JOIN interfaces i ON f.interface_id = i.id
      WHERE REPLACE(REPLACE(REPLACE(LOWER(f.mac), ':', ''), '.', ''), '-', '') = ?
      AND f.device_id != ?
    `).all(normalizedMAC, device.id);
    
    if (fdbEntries.length > 0) {
      console.log(`  ✓ MAC ${iface.ifphysaddress} trovato in FDB:`);
      
      for (const fdb of fdbEntries) {
        console.log(`    - Switch: ${fdb.switch_sysname} (${fdb.switch_ip}), porta: ${fdb.port_name || fdb.port_ifindex || 'N/A'}`);
        
        // Verifica se esiste già un link
        const existingLink = db.prepare(`
          SELECT id FROM links 
          WHERE device_id = ? AND remote_device_id = ?
        `).get(fdb.switch_id, device.id);
        
        if (!existingLink) {
          // Crea link dallo switch verso questo device
          db.prepare(`
            INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, protocol)
            VALUES (?, ?, ?, ?, ?, ?, 'FDB')
          `).run(fdb.switch_id, fdb.port_ifindex, fdb.port_name, device.id, device.ip, device.sysname);
          
          console.log(`    → Link creato: ${fdb.switch_sysname} -> ${device.sysname}`);
          linksCreated++;
          foundConnection = true;
        }
        
        // Crea anche link inverso
        const reverseLink = db.prepare(`
          SELECT id FROM links WHERE device_id = ? AND remote_device_id = ?
        `).get(device.id, fdb.switch_id);
        
        if (!reverseLink) {
          db.prepare(`
            INSERT INTO links (device_id, remote_device_id, remote_ip, remote_sysname, protocol)
            VALUES (?, ?, ?, ?, 'FDB')
          `).run(device.id, fdb.switch_id, fdb.switch_ip, fdb.switch_sysname);
          
          console.log(`    → Link inverso creato: ${device.sysname} -> ${fdb.switch_sysname}`);
          linksCreated++;
        }
      }
    }
  }
  
  if (!foundConnection) {
    console.log('  ✗ MAC non trovato in nessuna FDB');
  }
}

console.log(`\n=== COMPLETATO ===`);
console.log(`Link creati via FDB: ${linksCreated}`);

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
} else {
  console.log('\n✓ Tutti i device hanno almeno un link!');
}

db.close();



