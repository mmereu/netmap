import Database from 'better-sqlite3';
const db = new Database('./netmap.db');

// Conta link NULL prima del cleanup
const before = db.prepare(`
  SELECT COUNT(*) as count FROM links 
  WHERE remote_device_id IS NULL 
  AND remote_chassisid IS NULL 
  AND remote_sysname IS NULL 
  AND remote_ip IS NULL
`).get();

console.log('=== CLEANUP LINK NULL ===');
console.log('Link NULL prima del cleanup:', before.count);

// Elimina link NULL
const result = db.prepare(`
  DELETE FROM links 
  WHERE remote_device_id IS NULL 
  AND remote_chassisid IS NULL 
  AND remote_sysname IS NULL 
  AND remote_ip IS NULL
`).run();

console.log('Link eliminati:', result.changes);

// Conta link rimanenti
const after = db.prepare('SELECT COUNT(*) as count FROM links').get();
const resolved = db.prepare('SELECT COUNT(*) as count FROM links WHERE remote_device_id IS NOT NULL').get();

console.log('\n=== DOPO CLEANUP ===');
console.log('Link totali:', after.count);
console.log('Link risolti:', resolved.count);
console.log('% Risolti:', Math.round(resolved.count / after.count * 100) + '%');

db.close();
console.log('\n✓ Cleanup completato! Ora puoi ri-eseguire la discovery.');



