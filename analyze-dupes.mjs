import Database from 'better-sqlite3';

const db = new Database('netmap.db');

console.log('=== ANALISI PATTERN DUPLICATI ===\n');

// Coppie duplicate
const dupes = db.prepare(`
  SELECT device_id, local_ifname, remote_sysname, COUNT(*) as cnt
  FROM links
  GROUP BY device_id, local_ifname, remote_sysname
  HAVING COUNT(*) > 1
`).all();

console.log('Statistiche generali:');
console.log('  Coppie (device, ifname, remote) duplicate:', dupes.length);

// Breakdown by NULL pattern
let nullNull = 0;
let mixedNull = 0;
let noNull = 0;
let occNullNull = 0;
let occMixed = 0;
let occNoNull = 0;

dupes.forEach(d => {
  if (d.local_ifname === null && d.remote_sysname === null) {
    nullNull++;
    occNullNull += d.cnt;
  } else if (d.local_ifname === null || d.remote_sysname === null) {
    mixedNull++;
    occMixed += d.cnt;
  } else {
    noNull++;
    occNoNull += d.cnt;
  }
});

console.log('\nBreakdown by NULL pattern:');
console.log(`  BOTH NULL: ${nullNull} coppie (${occNullNull} occorrenze)`);
console.log(`  UNO NULL:  ${mixedNull} coppie (${occMixed} occorrenze)`);
console.log(`  NO NULL:   ${noNull} coppie (${occNoNull} occorrenze)`);
console.log(`  TOTALE:    ${dupes.length} coppie (${occNullNull + occMixed + occNoNull} occorrenze)`);

// Dettagli link con both NULL - un campione
console.log('\n=== CAMPIONE LINK WITH BOTH NULL ===\n');
const nullNullLinks = db.prepare(`
  SELECT l.*, d.sysname
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE l.local_ifname IS NULL AND l.remote_sysname IS NULL
  LIMIT 5
`).all();

nullNullLinks.forEach(l => {
  console.log(`Device: ${l.sysname}`);
  console.log(`  remote_device: ${l.remote_device}`);
  console.log(`  remote_ifname: ${l.remote_ifname}`);
  console.log(`  protocol: ${l.protocol}`);
  console.log(`  bandwidth: ${l.bandwidth}`);
  console.log();
});

// Link con uno NULL
console.log('=== CAMPIONE LINK WITH UNO NULL ===\n');
const mixedLinks = db.prepare(`
  SELECT l.*, d.sysname
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE (l.local_ifname IS NULL OR l.remote_sysname IS NULL)
    AND NOT (l.local_ifname IS NULL AND l.remote_sysname IS NULL)
  LIMIT 3
`).all();

mixedLinks.forEach(l => {
  console.log(`Device: ${l.sysname}`);
  console.log(`  local_ifname: ${l.local_ifname}`);
  console.log(`  remote_sysname: ${l.remote_sysname}`);
  console.log(`  remote_device: ${l.remote_device}`);
  console.log(`  remote_ifname: ${l.remote_ifname}`);
  console.log();
});

// Top device con link NULL
console.log('=== TOP DEVICE CON LINK NULL ===\n');
const topNullDevices = db.prepare(`
  SELECT d.sysname, COUNT(*) as cnt
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE l.local_ifname IS NULL OR l.remote_sysname IS NULL
  GROUP BY d.id
  ORDER BY cnt DESC
  LIMIT 10
`).all();

topNullDevices.forEach(r => {
  console.log(`  ${r.sysname}: ${r.cnt} link`);
});

db.close();
