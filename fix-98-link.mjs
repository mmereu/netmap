import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

// Trova i device
const device98 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%casse-18-19_bis_98%'").get();
const deviceRackE18 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%RackE_18%'").get();
const device89 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%casse-18-19_89%'").get();

console.log('=== DEVICE ===');
console.log('10_L2_casse-18-19_bis_98:', device98?.id, device98?.ip);
console.log('10_L2_RackE_18:', deviceRackE18?.id, deviceRackE18?.ip);
console.log('10_L2_casse-18-19_89:', device89?.id, device89?.ip);

// Link attuali del device 98
console.log('\n=== LINK ATTUALI DI _bis_98 ===');
const links98 = db.prepare('SELECT * FROM links WHERE device_id = ? OR remote_device_id = ?').all(device98.id, device98.id);
links98.forEach(l => {
  const localDev = db.prepare('SELECT sysname FROM devices WHERE id = ?').get(l.device_id);
  const remoteDev = db.prepare('SELECT sysname FROM devices WHERE id = ?').get(l.remote_device_id);
  console.log('ID:', l.id, '|', localDev?.sysname, '->', remoteDev?.sysname || l.remote_sysname, '| Protocol:', l.protocol);
});

// Il link corretto dovrebbe essere: _bis_98 <-> RackE_18
console.log('\n=== CORREZIONE LINK ===');

// Rimuovi link errati verso _89
const deleteResult = db.prepare('DELETE FROM links WHERE (device_id = ? AND remote_device_id = ?) OR (device_id = ? AND remote_device_id = ?)').run(
  device98.id, device89?.id,
  device89?.id, device98.id
);
console.log('Link rimossi verso _89:', deleteResult.changes);

// Crea link corretto verso RackE_18 se non esiste
const existingLink = db.prepare('SELECT id FROM links WHERE (device_id = ? AND remote_device_id = ?) OR (device_id = ? AND remote_device_id = ?)').get(
  device98.id, deviceRackE18?.id,
  deviceRackE18?.id, device98.id
);

if (!existingLink && deviceRackE18) {
  // Link da _bis_98 a RackE_18
  db.prepare(`
    INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, remote_portid, protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(device98.id, null, 'GE0/0/1', deviceRackE18.id, deviceRackE18.ip, deviceRackE18.sysname, 'GE0/0/10', 'LLDP-fix');
  
  // Link inverso da RackE_18 a _bis_98
  db.prepare(`
    INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, remote_portid, protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(deviceRackE18.id, null, 'GE0/0/10', device98.id, device98.ip, device98.sysname, 'GE0/0/1', 'LLDP-fix');
  
  console.log('Creato link: _bis_98 <-> RackE_18');
} else if (existingLink) {
  console.log('Link verso RackE_18 già esistente');
} else {
  console.log('RackE_18 non trovato nel database!');
}

// Verifica finale
console.log('\n=== LINK AGGIORNATI DI _bis_98 ===');
const newLinks = db.prepare('SELECT * FROM links WHERE device_id = ? OR remote_device_id = ?').all(device98.id, device98.id);
newLinks.forEach(l => {
  const localDev = db.prepare('SELECT sysname FROM devices WHERE id = ?').get(l.device_id);
  const remoteDev = db.prepare('SELECT sysname FROM devices WHERE id = ?').get(l.remote_device_id);
  console.log(localDev?.sysname, '->', remoteDev?.sysname || l.remote_sysname, '| Protocol:', l.protocol);
});

db.close();



