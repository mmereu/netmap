import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

const ip = process.argv[2] || '192.168.10.29';

// Cerca device
const device = db.prepare("SELECT * FROM devices WHERE ip = ? OR sysname LIKE ?").get(ip, `%${ip}%`);

if (!device) {
  console.log(`Device ${ip} NON trovato nel database!`);
  console.log('Devi eseguire una discovery su questo device.');
} else {
  console.log('=== DEVICE ===');
  console.log('ID:', device.id);
  console.log('IP:', device.ip);
  console.log('SysName:', device.sysname);
  console.log('Status:', device.status);
  
  // Link del device
  const links = db.prepare(`
    SELECT l.*, d2.ip as remote_ip2, d2.sysname as remote_sysname2
    FROM links l
    LEFT JOIN devices d2 ON l.remote_device_id = d2.id
    WHERE l.device_id = ?
  `).all(device.id);
  
  console.log('\n=== LINK ===');
  console.log('Link totali:', links.length);
  links.forEach((l, i) => {
    console.log(`${i+1}. ifIndex: ${l.local_ifindex} -> ${l.remote_sysname2 || l.remote_sysname || l.remote_chassisid || 'NULL'} (IP: ${l.remote_ip2 || l.remote_ip || 'NULL'})`);
  });
}

// Verifica tutti i device nel database
const allDevices = db.prepare("SELECT ip, sysname FROM devices ORDER BY ip").all();
console.log('\n=== TUTTI I DEVICE ===');
console.log('Totale:', allDevices.length);
allDevices.forEach((d, i) => {
  console.log(`${i+1}. ${d.ip} - ${d.sysname}`);
});

db.close();



