import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

// Trova il device
const device = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%casse-18-19_bis%'").get();
console.log('Device trovato:', device?.sysname, 'ID:', device?.id);

// Link DA questo device
const linksFrom = db.prepare('SELECT * FROM links WHERE device_id = ?').all(device.id);
console.log('\nLink DA questo device:', linksFrom.length);
linksFrom.forEach(l => {
  const remote = db.prepare('SELECT sysname FROM devices WHERE id = ?').get(l.remote_device_id);
  console.log('  ->', remote?.sysname || l.remote_sysname || 'NULL', '| Protocol:', l.protocol);
});

// Link VERSO questo device
const linksTo = db.prepare('SELECT * FROM links WHERE remote_device_id = ?').all(device.id);
console.log('\nLink VERSO questo device:', linksTo.length);
linksTo.forEach(l => {
  const local = db.prepare('SELECT sysname FROM devices WHERE id = ?').get(l.device_id);
  console.log('  <-', local?.sysname || 'NULL', '| Protocol:', l.protocol);
});

// Verifica API map
console.log('\n=== VERIFICA API ===');
const allLinks = db.prepare('SELECT * FROM links').all();
const deviceInLinks = allLinks.filter(l => l.device_id === device.id || l.remote_device_id === device.id);
console.log('Link totali nel DB:', allLinks.length);
console.log('Link che coinvolgono questo device:', deviceInLinks.length);

db.close();



