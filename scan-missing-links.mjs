import Database from 'better-sqlite3';
import NetMapSNMP from './libsnmp.js';

const db = new Database('./netmap.db');
const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public');

console.log('=== SCANSIONE DEVICE SENZA LINK ===\n');

// Device senza link
const devicesNoLinks = db.prepare(`
  SELECT d.id, d.ip, d.sysname
  FROM devices d
  WHERE d.status = 'active' AND d.id NOT IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
  ORDER BY d.ip
`).all();

console.log(`Trovati ${devicesNoLinks.length} device senza link. Scansione LLDP...\n`);

let totalLinksAdded = 0;

for (const device of devicesNoLinks) {
  console.log(`\n--- ${device.ip} (${device.sysname}) ---`);
  
  try {
    const discovery = await snmp.discoverProtocols(device.ip, 8000);
    
    const neighbors = [
      ...discovery.lldp.map(n => ({ ...n, protocol: 'LLDP' })),
      ...discovery.cdp.map(n => ({ ...n, protocol: 'CDP' })),
    ];
    
    console.log(`LLDP neighbors: ${discovery.lldp.length}, CDP neighbors: ${discovery.cdp.length}`);
    
    if (neighbors.length === 0) {
      console.log('→ Nessun neighbor trovato (LLDP potrebbe essere disabilitato)');
      continue;
    }
    
    // Salva i link
    let linksAdded = 0;
    for (const neighbor of neighbors) {
      // Trova remote device
      let remoteDevice = null;
      let remoteIp = neighbor.ip || null;
      let neighborName = neighbor.sysName || null;
      
      if (neighborName) {
        remoteDevice = db.prepare('SELECT * FROM devices WHERE sysname = ?').get(neighborName);
      }
      if (!remoteDevice && remoteIp) {
        remoteDevice = db.prepare('SELECT * FROM devices WHERE ip = ?').get(remoteIp);
      }
      
      // Cross-reference con MAC
      if (!remoteDevice && neighbor.chassisId && /^[0-9a-fA-F:.-]{12,17}$/.test(neighbor.chassisId)) {
        const normalizedMAC = neighbor.chassisId.replace(/[:.|-]/g, '').toLowerCase();
        const iface = db.prepare(`
          SELECT d.* FROM interfaces i
          JOIN devices d ON i.device_id = d.id
          WHERE REPLACE(REPLACE(REPLACE(LOWER(i.ifphysaddress), ':', ''), '.', ''), '-', '') = ?
          LIMIT 1
        `).get(normalizedMAC);
        if (iface) remoteDevice = iface;
      }
      
      console.log(`  → ${neighbor.sysName || neighbor.chassisId || 'unknown'} (porta ${neighbor.localPort || neighbor.ifIndex}) → ${remoteDevice ? 'RISOLTO: ' + remoteDevice.sysname : 'NON RISOLTO'}`);
      
      // Salva link
      db.prepare(`
        INSERT INTO links (device_id, local_ifindex, remote_device_id, remote_ip, remote_sysname, remote_chassisid, remote_portid, remote_portdesc, protocol)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          remote_device_id = COALESCE(excluded.remote_device_id, remote_device_id),
          lastseen = strftime('%s', 'now')
      `).run(
        device.id,
        parseInt(neighbor.localPort) || neighbor.ifIndex || null,
        remoteDevice?.id || null,
        remoteDevice?.ip || remoteIp || null,
        neighborName || null,
        neighbor.chassisId || null,
        neighbor.portId || null,
        neighbor.sysDesc || null,
        neighbor.protocol
      );
      
      linksAdded++;
    }
    
    console.log(`  ✓ ${linksAdded} link salvati`);
    totalLinksAdded += linksAdded;
    
  } catch (err) {
    console.log(`  ✗ Errore: ${err.message}`);
  }
}

console.log(`\n=== COMPLETATO ===`);
console.log(`Link totali aggiunti: ${totalLinksAdded}`);

// Verifica finale
const stats = db.prepare(`
  SELECT 
    COUNT(DISTINCT d.id) as withLinks
  FROM devices d
  WHERE d.id IN (
    SELECT DISTINCT device_id FROM links
    UNION
    SELECT DISTINCT remote_device_id FROM links WHERE remote_device_id IS NOT NULL
  )
`).get();

const total = db.prepare('SELECT COUNT(*) as count FROM devices WHERE status = "active"').get();
console.log(`Device con link: ${stats.withLinks}/${total.count} (${Math.round(stats.withLinks / total.count * 100)}%)`);

db.close();



