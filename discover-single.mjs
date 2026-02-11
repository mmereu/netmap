import NetMapSNMP from './libsnmp.js';
import NetMapDB from './libdb.js';

const ip = process.argv[2] || '192.168.10.18';
const snmp = new NetMapSNMP();
const db = new NetMapDB('./netmap.db');

console.log(`=== DISCOVERY COMPLETA DI ${ip} ===\n`);

// 1. Info base
const sysName = await snmp.getSysName(ip);
const sysDescr = await snmp.getSysDescr(ip);
console.log('SysName:', sysName);
console.log('SysDescr:', sysDescr?.substring(0, 80) + '...');

// 2. Discovery protocolli (LLDP/CDP)
console.log('\n--- Discovery LLDP/CDP ---');
const protocols = await snmp.discoverProtocols(ip, 15000);
console.log('Protocolli rilevati:', protocols.protocols.join(', ') || 'Nessuno');
console.log('LLDP neighbors:', protocols.lldp.length);
console.log('CDP neighbors:', protocols.cdp.length);

// 3. Mostra neighbor
if (protocols.lldp.length > 0) {
  console.log('\n--- LLDP Neighbors ---');
  protocols.lldp.forEach((n, i) => {
    console.log(`${i+1}. Port ${n.localPort} -> ${n.sysName || 'N/A'} | ChassisId: ${n.chassisId} | PortId: ${n.portId}`);
  });
}

// 4. Salva/aggiorna device nel DB
console.log('\n--- Salvataggio nel DB ---');
db.upsertDevice({
  ip,
  sysname: sysName,
  sysdescr: sysDescr,
  type: 'L2'
});
const device = db.db.prepare('SELECT * FROM devices WHERE ip = ?').get(ip);
console.log('Device ID:', device.id);

// 5. Rimuovi vecchi link di questo device
const oldLinks = db.db.prepare('DELETE FROM links WHERE device_id = ?').run(device.id);
console.log('Vecchi link rimossi:', oldLinks.changes);

// 6. Salva nuovi link LLDP
let linksSaved = 0;
for (const neighbor of protocols.lldp) {
  // Cerca il device remoto per sysName
  let remoteDevice = null;
  if (neighbor.sysName) {
    remoteDevice = db.db.prepare('SELECT * FROM devices WHERE sysname = ?').get(neighbor.sysName);
  }
  
  db.db.prepare(`
    INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, remote_chassisid, remote_portid, protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    device.id,
    neighbor.localPort,
    neighbor.localPortName || `Port${neighbor.localPort}`,
    remoteDevice?.id || null,
    neighbor.ip || null,
    neighbor.sysName || null,
    neighbor.chassisId || null,
    neighbor.portId || null,
    'LLDP'
  );
  linksSaved++;
}
console.log('Nuovi link LLDP salvati:', linksSaved);

// 7. Verifica finale
console.log('\n--- Link nel DB ---');
const links = db.db.prepare(`
  SELECT l.*, d.sysname as remote_name 
  FROM links l 
  LEFT JOIN devices d ON l.remote_device_id = d.id
  WHERE l.device_id = ?
`).all(device.id);

links.forEach(l => {
  console.log(`Port ${l.local_ifindex} -> ${l.remote_name || l.remote_sysname || 'Unknown'} (${l.remote_chassisid || 'no MAC'})`);
});

db.close();
console.log('\n✅ Discovery completata!');

