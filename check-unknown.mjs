import Database from 'better-sqlite3';

const db = new Database('./netmap.db');

// Links senza remote_device_id (Unknown)
const unknownLinks = db.prepare('SELECT COUNT(*) as count FROM links WHERE remote_device_id IS NULL').get();
const totalLinks = db.prepare('SELECT COUNT(*) as count FROM links').get();
const resolvedLinks = db.prepare('SELECT COUNT(*) as count FROM links WHERE remote_device_id IS NOT NULL').get();

// Device totali
const devices = db.prepare('SELECT COUNT(*) as count FROM devices').get();
const neighbors = db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'neighbor'").get();

console.log('=== STATISTICHE DATABASE ===');
console.log('Device totali:', devices.count);
console.log('Device neighbor:', neighbors.count);
console.log('Link totali:', totalLinks.count);
console.log('Link risolti:', resolvedLinks.count);
console.log('Link Unknown:', unknownLinks.count);
console.log('% Risolti:', Math.round(resolvedLinks.count / totalLinks.count * 100) + '%');

// Mostra alcuni link Unknown
const samples = db.prepare('SELECT remote_chassisid, remote_sysname, remote_ip, protocol FROM links WHERE remote_device_id IS NULL LIMIT 10').all();
console.log('');
console.log('=== ESEMPI LINK UNKNOWN ===');
samples.forEach((l, i) => {
  console.log((i+1) + '. ChassisId:', l.remote_chassisid, '| SysName:', l.remote_sysname, '| IP:', l.remote_ip);
});

// Interfacce con MAC
const ifmacs = db.prepare("SELECT COUNT(*) as count FROM interfaces WHERE ifphysaddress IS NOT NULL AND ifphysaddress != ''").get();
console.log('');
console.log('=== DATI RISOLUZIONE ===');
console.log('Interfacce con MAC (ifPhysAddress):', ifmacs.count);

const arpCount = db.prepare('SELECT COUNT(*) as count FROM arp').get();
const fdbCount = db.prepare('SELECT COUNT(*) as count FROM fdb').get();
console.log('Entry ARP:', arpCount.count);
console.log('Entry FDB:', fdbCount.count);

// Analisi dettagliata link Unknown
const linksWithData = db.prepare(`
  SELECT COUNT(*) as count FROM links 
  WHERE remote_device_id IS NULL 
  AND (remote_chassisid IS NOT NULL OR remote_sysname IS NOT NULL OR remote_ip IS NOT NULL)
`).get();
const linksNoData = db.prepare(`
  SELECT COUNT(*) as count FROM links 
  WHERE remote_device_id IS NULL 
  AND remote_chassisid IS NULL AND remote_sysname IS NULL AND remote_ip IS NULL
`).get();

console.log('');
console.log('=== ANALISI LINK UNKNOWN ===');
console.log('Unknown CON dati (chassisid/sysname/ip):', linksWithData.count);
console.log('Unknown SENZA dati (tutti NULL):', linksNoData.count);

// Esempi link con dati
const samplesWithData = db.prepare(`
  SELECT l.*, d.ip as device_ip, d.sysname as device_sysname 
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE l.remote_device_id IS NULL 
  AND (l.remote_chassisid IS NOT NULL OR l.remote_sysname IS NOT NULL OR l.remote_ip IS NOT NULL)
  LIMIT 10
`).all();

if (samplesWithData.length > 0) {
  console.log('');
  console.log('=== ESEMPI LINK UNKNOWN CON DATI ===');
  samplesWithData.forEach((l, i) => {
    console.log((i+1) + '. Da', l.device_ip, '| ChassisId:', l.remote_chassisid, '| SysName:', l.remote_sysname, '| IP:', l.remote_ip, '| Porta:', l.local_ifname);
  });
}

// Verifica link risolti (con remote_device_id)
const resolvedSamples = db.prepare(`
  SELECT l.*, d1.ip as local_ip, d1.sysname as local_sysname, d2.ip as remote_ip2, d2.sysname as remote_sysname2
  FROM links l
  JOIN devices d1 ON l.device_id = d1.id
  JOIN devices d2 ON l.remote_device_id = d2.id
  LIMIT 5
`).all();

console.log('');
console.log('=== ESEMPI LINK RISOLTI ===');
resolvedSamples.forEach((l, i) => {
  console.log((i+1) + '.', l.local_sysname || l.local_ip, '->', l.remote_sysname2 || l.remote_ip2);
});

// Da quali device provengono i link NULL?
const nullLinksByDevice = db.prepare(`
  SELECT d.ip, d.sysname, COUNT(*) as null_links
  FROM links l
  JOIN devices d ON l.device_id = d.id
  WHERE l.remote_device_id IS NULL 
  AND l.remote_chassisid IS NULL AND l.remote_sysname IS NULL AND l.remote_ip IS NULL
  GROUP BY l.device_id
  ORDER BY null_links DESC
  LIMIT 10
`).all();

console.log('');
console.log('=== DEVICE CON PIÙ LINK NULL ===');
nullLinksByDevice.forEach((d, i) => {
  console.log((i+1) + '.', d.sysname || d.ip, '-', d.null_links, 'link NULL');
});

// Dettaglio link NULL del primo device
if (nullLinksByDevice.length > 0) {
  const firstDevice = nullLinksByDevice[0];
  const nullDetails = db.prepare(`
    SELECT l.*
    FROM links l
    JOIN devices d ON l.device_id = d.id
    WHERE d.ip = ? AND l.remote_device_id IS NULL
    LIMIT 5
  `).all(firstDevice.ip);
  
  console.log('');
  console.log('=== DETTAGLIO LINK NULL DI', firstDevice.sysname || firstDevice.ip, '===');
  nullDetails.forEach((l, i) => {
    console.log((i+1) + '. ifIndex:', l.local_ifindex, '| ifName:', l.local_ifname, '| Protocol:', l.protocol);
  });
}

// Quando sono stati creati i link NULL?
const linkDates = db.prepare(`
  SELECT 
    datetime(firstseen, 'unixepoch', 'localtime') as created,
    datetime(lastseen, 'unixepoch', 'localtime') as updated,
    COUNT(*) as count
  FROM links
  WHERE remote_device_id IS NULL AND remote_chassisid IS NULL AND remote_sysname IS NULL
  GROUP BY firstseen
  ORDER BY firstseen DESC
  LIMIT 5
`).all();

console.log('');
console.log('=== DATE CREAZIONE LINK NULL ===');
linkDates.forEach((d, i) => {
  console.log((i+1) + '. Creati:', d.created, '| Aggiornati:', d.updated, '| Count:', d.count);
});

// Opzione: eliminare i link NULL vecchi
console.log('');
console.log('=== OPZIONE CLEANUP ===');
console.log('Puoi eliminare i link NULL con:');
console.log('  DELETE FROM links WHERE remote_device_id IS NULL AND remote_chassisid IS NULL AND remote_sysname IS NULL AND remote_ip IS NULL');

db.close();

