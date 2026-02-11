import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

console.log('=== DEVICE SENZA LINK ===\n');

// Device senza link (né come source né come destination)
const devicesNoLinks = db.prepare(`
  SELECT d.id, d.ip, d.sysname, d.status, d.vendor
  FROM devices d
  WHERE d.id NOT IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
  ORDER BY d.ip
`).all();

console.log(`Trovati ${devicesNoLinks.length} device senza link:\n`);

devicesNoLinks.forEach((d, i) => {
  console.log(`${i+1}. ${d.ip} - ${d.sysname} (status: ${d.status}, vendor: ${d.vendor || 'N/A'})`);
});

// Statistiche
const totalDevices = db.prepare('SELECT COUNT(*) as count FROM devices').get();
const devicesWithLinks = db.prepare(`
  SELECT COUNT(DISTINCT d.id) as count
  FROM devices d
  WHERE d.id IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
`).get();

console.log('\n=== STATISTICHE ===');
console.log(`Device totali: ${totalDevices.count}`);
console.log(`Device CON link: ${devicesWithLinks.count}`);
console.log(`Device SENZA link: ${devicesNoLinks.length}`);
console.log(`Copertura: ${Math.round(devicesWithLinks.count / totalDevices.count * 100)}%`);

db.close();



