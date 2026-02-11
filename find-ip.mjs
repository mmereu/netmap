import Database from 'better-sqlite3';
const db = new Database('./netmap.db');
const devices = db.prepare("SELECT ip, sysname FROM devices WHERE sysname LIKE '%S6730%' OR sysname LIKE '%251%'").all();
devices.forEach(d => console.log(d.ip, '-', d.sysname));
db.close();



