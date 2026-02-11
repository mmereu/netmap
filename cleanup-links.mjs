#!/usr/bin/env node
import Database from 'better-sqlite3';

const db = new Database('netmap.db');

console.log('=== CLEANUP LINK DATABASE ===\n');

// Statistiche prima
const before = {
  total: db.prepare('SELECT COUNT(*) as cnt FROM links').get().cnt,
  nullIfname: db.prepare("SELECT COUNT(*) as cnt FROM links WHERE local_ifname IS NULL").get().cnt,
  nullRemote: db.prepare("SELECT COUNT(*) as cnt FROM links WHERE remote_sysname IS NULL").get().cnt,
};

console.log('PRIMA:');
console.log('  Link totali:', before.total);
console.log('  Link con ifname NULL:', before.nullIfname);
console.log('  Link con remote NULL:', before.nullRemote);

// 1. Elimina link con ifname NULL
const del1 = db.prepare("DELETE FROM links WHERE local_ifname IS NULL").run();
console.log('\nEliminati link con ifname NULL:', del1.changes);

// 2. Elimina link con remote_sysname NULL
const del2 = db.prepare("DELETE FROM links WHERE remote_sysname IS NULL").run();
console.log('Eliminati link con remote NULL:', del2.changes);

// 3. Elimina duplicati (tiene il primo)
const del3 = db.prepare(`
  DELETE FROM links WHERE id NOT IN (
    SELECT MIN(id) FROM links
    GROUP BY device_id, local_ifname, remote_sysname
  )
`).run();
console.log('Eliminati duplicati:', del3.changes);

// Statistiche dopo
const after = db.prepare('SELECT COUNT(*) as cnt FROM links').get().cnt;
console.log('\nDOPO:');
console.log('  Link totali:', after);
console.log('  Eliminati:', before.total - after);

db.close();
console.log('\n=== CLEANUP COMPLETATO ===');
