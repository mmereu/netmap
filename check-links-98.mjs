import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

const device98 = db.prepare("SELECT * FROM devices WHERE sysname LIKE '%casse-18-19_bis_98%'").get();
console.log('Device bis_98:', device98?.sysname, '| IP:', device98?.ip);

const links = db.prepare(`
  SELECT l.*, 
         d1.sysname as local_name,
         d2.sysname as remote_name 
  FROM links l
  LEFT JOIN devices d1 ON l.device_id = d1.id
  LEFT JOIN devices d2 ON l.remote_device_id = d2.id
  WHERE l.device_id = ? OR l.remote_device_id = ?
`).all(device98.id, device98.id);

console.log('Link totali:', links.length);
links.forEach(l => {
  console.log(l.local_name, '(' + l.local_ifname + ') --[' + l.protocol + ']--> ', l.remote_name || l.remote_sysname || 'N/A');
});
db.close();


