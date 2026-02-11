import Database from 'better-sqlite3';

const db = new Database('./netmap.db');
const siteNum = process.argv[2] || '21';

console.log(`\n=== ANALISI SITO ${siteNum} ===\n`);

// Tutti i device del sito
const devices = db.prepare(`
  SELECT sysname, ip, vendor, model
  FROM devices
  WHERE sysname LIKE ? OR sysname LIKE ?
  ORDER BY sysname
`).all(`${siteNum}_%`, `PDV${siteNum.padStart(3, '0')}%`);

console.log(`Device sito ${siteNum}:`, devices.length);

// Pattern per riconoscere AP
const apPatterns = ['ap', 'pdv', 'wifi', 'wireless', 'wlan'];
const isAP = (name) => {
  const lower = name.toLowerCase();
  return apPatterns.some(p => lower.includes(p));
};

const aps = devices.filter(d => isAP(d.sysname));
const switches = devices.filter(d => !isAP(d.sysname));

console.log('- Switch/Router:', switches.length);
console.log('- Access Point:', aps.length);

console.log('\n--- Switch/Router ---');
switches.forEach(d => console.log(`  ${d.sysname} (${d.ip})`));

console.log('\n--- Access Point ---');
if (aps.length === 0) {
  console.log('  NESSUN AP TROVATO!');
} else {
  aps.forEach(d => console.log(`  ${d.sysname} (${d.ip})`));
}

// Verifica link verso AP del sito
console.log('\n--- Link verso AP (da switch del sito) ---');
const linksToAP = db.prepare(`
  SELECT d.sysname as from_dev, l.local_ifname, l.remote_sysname
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE d.sysname LIKE ?
  AND (l.remote_sysname LIKE '%AP%' OR l.remote_sysname LIKE 'PDV%')
  ORDER BY l.remote_sysname
`).all(`${siteNum}_%`);

console.log(`Link verso AP: ${linksToAP.length}`);
linksToAP.forEach(l => console.log(`  ${l.from_dev} [${l.local_ifname}] -> ${l.remote_sysname}`));

db.close();
