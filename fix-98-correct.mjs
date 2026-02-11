import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

// Trova i device
const device98 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%casse-18-19_bis_98%'").get();
const device89 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%casse-18-19_89%'").get();
const deviceRackE18 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%RackE_18%'").get();

console.log('=== CORREZIONE LINK bis_98 ===');
console.log('Device bis_98:', device98?.sysname, '| IP:', device98?.ip, '| ID:', device98?.id);
console.log('Device 89:', device89?.sysname, '| IP:', device89?.ip, '| ID:', device89?.id);
console.log('Device RackE_18:', deviceRackE18?.sysname, '| IP:', deviceRackE18?.ip, '| ID:', deviceRackE18?.id);

// Rimuovi link errati verso RackE_18
const deleted = db.prepare(`
  DELETE FROM links 
  WHERE (device_id = ? AND remote_device_id = ?) 
     OR (device_id = ? AND remote_device_id = ?)
`).run(device98.id, deviceRackE18.id, deviceRackE18.id, device98.id);

console.log('\nLink errati rimossi (vers RackE_18):', deleted.changes);

// Verifica se esiste già link verso _89
const existing = db.prepare(`
  SELECT * FROM links 
  WHERE (device_id = ? AND remote_device_id = ?) 
     OR (device_id = ? AND remote_device_id = ?)
`).get(device98.id, device89.id, device89.id, device98.id);

if (!existing) {
  // Crea link corretto: _bis_98 GE0/0/9 --> _89 Ethernet0/0/8
  db.prepare(`
    INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, remote_portid, protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(device98.id, 9, 'GE0/0/9', device89.id, device89.ip, device89.sysname, 'Ethernet0/0/8', 'LLDP');
  
  // Crea link inverso: _89 Ethernet0/0/8 --> _bis_98 GE0/0/9
  db.prepare(`
    INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, remote_portid, protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(device89.id, null, 'Ethernet0/0/8', device98.id, device98.ip, device98.sysname, 'GE0/0/9', 'LLDP');
  
  console.log('Creati link corretti: _bis_98 <--> _89');
} else {
  console.log('Link verso _89 già esistente');
}

// Verifica finale
console.log('\n=== LINK FINALI DI bis_98 ===');
const finalLinks = db.prepare(`
  SELECT l.*, d1.sysname as local_name, d2.sysname as remote_name 
  FROM links l
  LEFT JOIN devices d1 ON l.device_id = d1.id
  LEFT JOIN devices d2 ON l.remote_device_id = d2.id
  WHERE l.device_id = ? OR l.remote_device_id = ?
`).all(device98.id, device98.id);

finalLinks.forEach(l => {
  console.log(l.local_name, '(' + l.local_ifname + ') --[' + l.protocol + ']--> ', l.remote_name || l.remote_sysname);
});

db.close();
console.log('\n✅ Correzione completata!');


