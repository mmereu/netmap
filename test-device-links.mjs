import Database from 'better-sqlite3';

const db = new Database('./netmap.db');
const deviceName = process.argv[2] || '32_L2_Cassa_31-32_108';

console.log(`\n=== Test Link per device: ${deviceName} ===\n`);

// Trova il device
const device = db.prepare('SELECT id, sysname, ip FROM devices WHERE sysname = ?').get(deviceName);

if (!device) {
  console.log('Device non trovato!');
  process.exit(1);
}

console.log('Device:', device);

// Conta i link per questo device
const links = db.prepare(`
  SELECT l.id, l.local_ifname, l.remote_sysname, d.sysname as remote_name, d.ip as remote_ip
  FROM links l
  LEFT JOIN devices d ON l.remote_device_id = d.id
  WHERE l.device_id = ?
  ORDER BY l.remote_sysname
`).all(device.id);

console.log('\nNumero link totali:', links.length);

// Raggruppa per remote_sysname per vedere duplicati
const grouped = {};
links.forEach(l => {
  const key = l.remote_sysname || 'NULL';
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(l);
});

console.log('\n--- Link per neighbor ---');
const duplicates = [];
Object.keys(grouped).sort().forEach(key => {
  const count = grouped[key].length;
  if (count > 1) {
    duplicates.push({ neighbor: key, count });
    console.log(`  [DUPLICATO x${count}] ${key}`);
  } else {
    console.log(`  ${key}`);
  }
});

console.log('\n--- Riepilogo ---');
console.log('Neighbor distinti:', Object.keys(grouped).length);
console.log('Link duplicati:', duplicates.length > 0 ? duplicates : 'Nessuno');

// Verifica se ci sono link con IP come neighbor
const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ipNeighbors = Object.keys(grouped).filter(k => ipPattern.test(k));
if (ipNeighbors.length > 0) {
  console.log('\n[ATTENZIONE] Neighbor con formato IP:', ipNeighbors);
}

db.close();
