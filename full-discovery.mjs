import NetMapSNMP from './libsnmp.js';
import Database from 'better-sqlite3';

const db = new Database('./netmap.db');
const snmp = new NetMapSNMP();

console.log('=== FULL NETWORK DISCOVERY ===\n');

// 1. Get all existing devices
const devices = db.prepare('SELECT * FROM devices WHERE ip IS NOT NULL').all();
console.log(`Found ${devices.length} existing devices\n`);

// 2. Scan each device for LLDP neighbors
const allNeighbors = new Map();
let totalNeighbors = 0;

for (const device of devices) {
  console.log(`Scanning ${device.sysname} (${device.ip})...`);
  
  try {
    const result = await snmp.discoverProtocols(device.ip, 15000);
    
    if (result.lldp.length > 0) {
      console.log(`  Found ${result.lldp.length} LLDP neighbors`);
      
      for (const n of result.lldp) {
        const key = n.chassisId || n.sysName || n.ip;
        if (key && !allNeighbors.has(key)) {
          allNeighbors.set(key, {
            ...n,
            discoveredFrom: device.sysname,
            discoveredFromIp: device.ip
          });
          totalNeighbors++;
        }
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

console.log(`\n=== DISCOVERED ${totalNeighbors} UNIQUE NEIGHBORS ===\n`);

// 3. Identify Access Points
const accessPoints = [];
const switches = [];
const unknown = [];

for (const [key, n] of allNeighbors) {
  const name = (n.sysName || '').toLowerCase();
  const portId = (n.portId || '').toLowerCase();
  
  if (name.includes('ap') || name.includes('pdv') || portId.includes('mgt')) {
    accessPoints.push(n);
  } else if (name.includes('l2') || name.includes('l3') || name.includes('rack')) {
    switches.push(n);
  } else {
    unknown.push(n);
  }
}

console.log(`Access Points: ${accessPoints.length}`);
console.log(`Switches: ${switches.length}`);
console.log(`Unknown: ${unknown.length}`);

// 4. Show Access Points
console.log('\n=== ACCESS POINTS ===');
accessPoints.forEach((ap, i) => {
  console.log(`${i+1}. ${ap.sysName || 'N/A'}`);
  console.log(`   ChassisId: ${ap.chassisId}`);
  console.log(`   PortId: ${ap.portId}`);
  console.log(`   IP: ${ap.ip || 'N/A'}`);
  console.log(`   Discovered from: ${ap.discoveredFrom}`);
  console.log('');
});

// 5. Add Access Points as neighbor devices
console.log('\n=== ADDING ACCESS POINTS TO DATABASE ===');
let added = 0;

for (const ap of accessPoints) {
  const sysName = ap.sysName || `AP-${ap.chassisId}`;
  const chassisId = ap.chassisId;
  
  // Check if already exists
  const existing = db.prepare('SELECT id FROM devices WHERE sysname = ? OR ip = ?').get(sysName, ap.ip);
  
  if (!existing) {
    // Create neighbor device
    const nodeId = `ap-${chassisId?.replace(/:/g, '')}`;
    db.prepare(`
      INSERT INTO devices (ip, sysname, type, first_seen, last_seen)
      VALUES (?, ?, 'neighbor', datetime('now'), datetime('now'))
    `).run(ap.ip || nodeId, sysName);
    
    console.log(`Added: ${sysName}`);
    added++;
  }
}

console.log(`\nAdded ${added} new Access Points`);

// 6. Update links for Access Points
console.log('\n=== UPDATING LINKS ===');
let linksAdded = 0;

for (const ap of accessPoints) {
  const sysName = ap.sysName || `AP-${ap.chassisId}`;
  
  // Find source device
  const sourceDevice = db.prepare('SELECT id FROM devices WHERE sysname = ?').get(ap.discoveredFrom);
  const targetDevice = db.prepare('SELECT id FROM devices WHERE sysname = ?').get(sysName);
  
  if (sourceDevice && targetDevice) {
    // Check if link exists
    const existingLink = db.prepare(`
      SELECT id FROM links 
      WHERE (device_id = ? AND remote_device_id = ?)
         OR (device_id = ? AND remote_device_id = ?)
    `).get(sourceDevice.id, targetDevice.id, targetDevice.id, sourceDevice.id);
    
    if (!existingLink) {
      db.prepare(`
        INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_sysname, remote_chassisid, remote_portid, protocol)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'LLDP')
      `).run(sourceDevice.id, ap.localPort, `Port${ap.localPort}`, targetDevice.id, sysName, ap.chassisId, ap.portId);
      
      linksAdded++;
    }
  }
}

console.log(`Added ${linksAdded} new links`);

// Final stats
const finalDevices = db.prepare('SELECT COUNT(*) as count FROM devices').get();
const finalLinks = db.prepare('SELECT COUNT(*) as count FROM links').get();

console.log(`\n=== FINAL STATS ===`);
console.log(`Total Devices: ${finalDevices.count}`);
console.log(`Total Links: ${finalLinks.count}`);

db.close();
console.log('\n✅ Discovery completed!');

