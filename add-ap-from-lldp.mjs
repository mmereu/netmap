import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== ESTRAZIONE AP DAI NEIGHBOR LLDP ===\n');

// Trova tutti i link con neighbor che sembrano AP
const apLinks = db.prepare(`
  SELECT DISTINCT 
    l.remote_sysname,
    l.remote_chassisid,
    l.remote_portid,
    d.sysname as switch_name,
    d.ip as switch_ip
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE l.remote_sysname LIKE '%AP%' 
     OR l.remote_sysname LIKE '%PDV%'
     OR l.remote_sysname LIKE '%ap-%'
  ORDER BY l.remote_sysname
`).all();

console.log(`Trovati ${apLinks.length} link verso AP\n`);

// Raggruppa per sysname unico
const uniqueAPs = new Map();
for (const link of apLinks) {
  if (link.remote_sysname && !uniqueAPs.has(link.remote_sysname)) {
    uniqueAPs.set(link.remote_sysname, {
      sysname: link.remote_sysname,
      chassisId: link.remote_chassisid,
      connectedTo: link.switch_name,
      switchIp: link.switch_ip
    });
  }
}

console.log(`AP unici trovati: ${uniqueAPs.size}\n`);

// Aggiungi gli AP al database
let added = 0;
for (const [name, ap] of uniqueAPs) {
  // Crea un ID univoco basato sul chassisId o nome
  const apId = ap.chassisId ? 
    `ap-${ap.chassisId.replace(/:/g, '').substring(0, 12)}` : 
    `ap-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  
  // Verifica se esiste già
  const existing = db.prepare('SELECT id FROM devices WHERE ip = ? OR sysname = ?').get(apId, name);
  
  if (!existing) {
    db.prepare(`
      INSERT INTO devices (ip, sysname, sysdesc, status)
      VALUES (?, ?, ?, 'neighbor')
    `).run(apId, name, `Access Point (ChassisId: ${ap.chassisId || 'N/A'})`);
    
    console.log(`✓ Aggiunto: ${name} (${apId}) - connesso a ${ap.connectedTo}`);
    added++;
  } else {
    console.log(`- Già esistente: ${name}`);
  }
}

// Aggiorna i link per puntare ai nuovi device AP
console.log('\n--- Aggiornamento link ---');
let linksUpdated = 0;

for (const [name, ap] of uniqueAPs) {
  const apDevice = db.prepare('SELECT id FROM devices WHERE sysname = ?').get(name);
  if (apDevice) {
    const updated = db.prepare(`
      UPDATE links 
      SET remote_device_id = ?
      WHERE remote_sysname = ? AND remote_device_id IS NULL
    `).run(apDevice.id, name);
    
    if (updated.changes > 0) {
      console.log(`✓ ${name}: ${updated.changes} link aggiornati`);
      linksUpdated += updated.changes;
    }
  }
}

console.log(`\n=== RISULTATO ===`);
console.log(`AP aggiunti: ${added}`);
console.log(`Link aggiornati: ${linksUpdated}`);

// Statistiche finali
const stats = db.prepare(`
  SELECT 
    (SELECT COUNT(*) FROM devices) as devices,
    (SELECT COUNT(*) FROM devices WHERE sysname LIKE '%AP%' OR sysname LIKE '%PDV%') as aps,
    (SELECT COUNT(*) FROM links) as links
`).get();

console.log(`\nTotale DB: ${stats.devices} device (${stats.aps} AP), ${stats.links} link`);

db.close();
console.log('\n✅ Completato!');

