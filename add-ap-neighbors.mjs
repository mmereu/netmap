import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== RICERCA IP ACCESS POINT VIA ARP ===\n');

// Link Unknown con dati
const unknownLinks = db.prepare(`
  SELECT l.*, d.ip as local_ip, d.sysname as local_sysname
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE l.remote_device_id IS NULL 
  AND l.remote_chassisid IS NOT NULL
`).all();

console.log(`Trovati ${unknownLinks.length} link Unknown con ChassisId\n`);

const apDevices = new Map(); // MAC -> info AP

for (const link of unknownLinks) {
  const mac = link.remote_chassisid?.replace(/[:.|-]/g, '').toLowerCase();
  if (!mac) continue;
  
  // Cerca IP nella tabella ARP
  const arpEntry = db.prepare(`
    SELECT ip, mac FROM arp 
    WHERE REPLACE(REPLACE(REPLACE(LOWER(mac), ':', ''), '.', ''), '-', '') = ?
    ORDER BY lastseen DESC
    LIMIT 1
  `).get(mac);
  
  // Cerca anche nella tabella FDB per vedere dove è connesso
  const fdbEntry = db.prepare(`
    SELECT f.*, d.ip as device_ip, d.sysname as device_sysname, i.ifname, i.ifdescr
    FROM fdb f
    JOIN devices d ON f.device_id = d.id
    LEFT JOIN interfaces i ON f.interface_id = i.id
    WHERE REPLACE(REPLACE(REPLACE(LOWER(f.mac), ':', ''), '.', ''), '-', '') = ?
    ORDER BY f.lastseen DESC
    LIMIT 1
  `).get(mac);
  
  if (!apDevices.has(mac)) {
    apDevices.set(mac, {
      mac: link.remote_chassisid,
      sysname: link.remote_sysname,
      ip: arpEntry?.ip || null,
      seenOn: link.local_sysname,
      fdbDevice: fdbEntry?.device_sysname || null,
      fdbPort: fdbEntry?.ifname || fdbEntry?.ifdescr || null,
    });
  }
}

console.log('=== ACCESS POINT TROVATI ===\n');

for (const [mac, ap] of apDevices) {
  console.log(`AP: ${ap.sysname}`);
  console.log(`   MAC: ${ap.mac}`);
  console.log(`   IP via ARP: ${ap.ip || 'NON TROVATO'}`);
  console.log(`   Visto su: ${ap.seenOn}`);
  if (ap.fdbDevice) {
    console.log(`   FDB: ${ap.fdbDevice} porta ${ap.fdbPort}`);
  }
  console.log('');
}

// Aggiungi AP come device "neighbor"
console.log('=== AGGIUNTA AP AL DATABASE ===\n');

let added = 0;
let updated = 0;

for (const [mac, ap] of apDevices) {
  // Usa IP se disponibile, altrimenti usa MAC come identificativo
  const deviceIp = ap.ip || `ap-${mac.substring(0, 12)}`;
  
  // Verifica se esiste già
  const existing = db.prepare('SELECT id FROM devices WHERE ip = ? OR sysname = ?').get(deviceIp, ap.sysname);
  
  if (existing) {
    console.log(`✓ ${ap.sysname} già presente (ID: ${existing.id})`);
    
    // Aggiorna link con remote_device_id
    const updateResult = db.prepare(`
      UPDATE links SET remote_device_id = ?, remote_ip = ?
      WHERE remote_chassisid = ? AND remote_device_id IS NULL
    `).run(existing.id, ap.ip, ap.mac);
    
    if (updateResult.changes > 0) {
      console.log(`  → Aggiornati ${updateResult.changes} link`);
      updated += updateResult.changes;
    }
  } else {
    // Aggiungi nuovo device
    const result = db.prepare(`
      INSERT INTO devices (ip, sysname, sysdesc, status, vendor, model)
      VALUES (?, ?, ?, 'neighbor', 'Ubiquiti', 'Access Point')
    `).run(deviceIp, ap.sysname, `WiFi Access Point - MAC: ${ap.mac}`);
    
    const newId = result.lastInsertRowid;
    console.log(`+ ${ap.sysname} aggiunto come neighbor (ID: ${newId}, IP: ${deviceIp})`);
    added++;
    
    // Aggiorna link con remote_device_id
    const updateResult = db.prepare(`
      UPDATE links SET remote_device_id = ?, remote_ip = ?
      WHERE remote_chassisid = ? AND remote_device_id IS NULL
    `).run(newId, ap.ip || deviceIp, ap.mac);
    
    if (updateResult.changes > 0) {
      console.log(`  → Collegati ${updateResult.changes} link`);
      updated += updateResult.changes;
    }
  }
}

console.log('\n=== RIEPILOGO ===');
console.log(`AP aggiunti: ${added}`);
console.log(`Link aggiornati: ${updated}`);

// Verifica finale
const finalStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN remote_device_id IS NOT NULL THEN 1 ELSE 0 END) as resolved
  FROM links
`).get();

console.log(`\nLink totali: ${finalStats.total}`);
console.log(`Link risolti: ${finalStats.resolved} (${Math.round(finalStats.resolved / finalStats.total * 100)}%)`);

db.close();



