import NetMapSNMP from './libsnmp.js';
import NetMapDB from './libdb.js';

const snmp = new NetMapSNMP();
const db = new NetMapDB('./netmap.db');

// Subnet da scansionare
const subnet = '10.10.4';
const startIp = 1;
const endIp = 254;

console.log(`=== DISCOVERY RETE ${subnet}.0/24 ===\n`);

let discovered = 0;
let failed = 0;
let aps = 0;

for (let i = startIp; i <= endIp; i++) {
  const ip = `${subnet}.${i}`;
  
  try {
    // Prova a ottenere sysName con timeout breve
    const sysName = await Promise.race([
      snmp.getSysName(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
    ]);
    
    if (sysName && sysName !== 'timeout') {
      console.log(`✓ ${ip}: ${sysName}`);
      
      // Salva nel database
      db.upsertDevice({
        ip,
        sysname: sysName,
        type: sysName.toLowerCase().includes('l3') ? 'L3' : 
              sysName.toLowerCase().includes('ap') || sysName.toLowerCase().includes('pdv') ? 'neighbor' : 'L2'
      });
      
      discovered++;
      if (sysName.toLowerCase().includes('ap') || sysName.toLowerCase().includes('pdv')) {
        aps++;
      }
      
      // Discovery LLDP per questo device
      const protocols = await snmp.discoverProtocols(ip, 5000);
      if (protocols.lldp.length > 0) {
        console.log(`  → ${protocols.lldp.length} LLDP neighbors`);
        
        // Salva link
        const device = db.db.prepare('SELECT id FROM devices WHERE ip = ?').get(ip);
        if (device) {
          for (const neighbor of protocols.lldp) {
            // Cerca device remoto
            let remoteDevice = null;
            if (neighbor.sysName) {
              remoteDevice = db.db.prepare('SELECT * FROM devices WHERE sysname = ?').get(neighbor.sysName);
            }
            
            // Upsert link
            db.db.prepare(`
              INSERT OR REPLACE INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_sysname, remote_chassisid, remote_portid, protocol)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              device.id,
              neighbor.localPort,
              `Port${neighbor.localPort}`,
              remoteDevice?.id || null,
              neighbor.sysName || null,
              neighbor.chassisId || null,
              neighbor.portId || null,
              'LLDP'
            );
          }
        }
      }
    }
  } catch (err) {
    // Device non raggiungibile
    failed++;
  }
  
  // Progress ogni 50 IP
  if (i % 50 === 0) {
    console.log(`\n--- Progresso: ${i}/${endIp} (${discovered} trovati, ${aps} AP) ---\n`);
  }
}

console.log(`\n=== RISULTATO ===`);
console.log(`Device trovati: ${discovered}`);
console.log(`Access Point: ${aps}`);
console.log(`Non raggiungibili: ${failed}`);

// Conta totale nel DB
const total = db.db.prepare('SELECT COUNT(*) as count FROM devices').get();
const totalLinks = db.db.prepare('SELECT COUNT(*) as count FROM links').get();
console.log(`\nTotale nel DB: ${total.count} device, ${totalLinks.count} link`);

db.close();
console.log('\n✅ Discovery completata!');


