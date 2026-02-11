#!/usr/bin/env node
/**
 * Genera dati di test per stress testing NetMap
 *
 * Utilizzo:
 *   node generate-test-data.mjs [devices] [links_per_device]
 *
 * Esempi:
 *   node generate-test-data.mjs 200 4    # 200 devices, ~800 links
 *   node generate-test-data.mjs 500 3    # 500 devices, ~1500 links
 */

import NetMapDB from './libdb.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parametri da CLI
const numDevices = parseInt(process.argv[2]) || 200;
const linksPerDevice = parseInt(process.argv[3]) || 4;

console.log(`🚀 Generazione dati di test:`);
console.log(`   - Devices: ${numDevices}`);
console.log(`   - Links per device: ~${linksPerDevice}`);
console.log(`   - Totale links attesi: ~${numDevices * linksPerDevice}`);
console.log();

// Inizializza DB
const db = new NetMapDB('./netmap.db');

// Helper per generare IP casuali (subnet 10.x.x.x)
function generateIP(index) {
  const subnet = 10;
  const octet2 = Math.floor(index / 65536) % 256;
  const octet3 = Math.floor(index / 256) % 256;
  const octet4 = index % 256;
  return `${subnet}.${octet2}.${octet3}.${octet4}`;
}

// Helper per generare MAC casuali
function generateMAC() {
  const hex = '0123456789ABCDEF';
  let mac = '00:50:56'; // VMware OUI prefix
  for (let i = 0; i < 3; i++) {
    mac += ':' + hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)];
  }
  return mac;
}

// Device types con distribuzione realistica
const deviceTypes = [
  { type: 'l3', prefix: 'l3_sw', weight: 0.05, vendor: 'Huawei', model: 'S6730', level: 0 },
  { type: 'l2', prefix: 'l2_sw', weight: 0.35, vendor: 'Huawei', model: 'S5735', level: 1 },
  { type: 'router', prefix: 'rt', weight: 0.05, vendor: 'Huawei', model: 'NE8000', level: 0 },
  { type: 'ap', prefix: 'ap', weight: 0.45, vendor: 'Ubiquiti', model: 'UAP-AC-PRO', level: 2 },
  { type: 'neighbor', prefix: 'neighbor', weight: 0.10, vendor: 'Unknown', model: 'Unknown', level: 3 },
];

// Funzione per selezionare tipo device basato su peso
function selectDeviceType() {
  const rand = Math.random();
  let cumulativeWeight = 0;
  for (const dt of deviceTypes) {
    cumulativeWeight += dt.weight;
    if (rand <= cumulativeWeight) return dt;
  }
  return deviceTypes[deviceTypes.length - 1];
}

// Genera locations realistiche
const locations = [
  'Sede Centrale', 'Magazzino', 'Uffici Piano 1', 'Uffici Piano 2', 'Uffici Piano 3',
  'Data Center', 'Server Room', 'Reception', 'Sala Riunioni', 'Cafeteria',
  'Laboratorio', 'Produzione', 'Logistica', 'R&D', 'IT Room'
];

// ========== GENERAZIONE DEVICES ==========
console.log(`📦 Generando ${numDevices} devices...`);
const deviceIds = [];
const deviceIPs = [];
const startTime = Date.now();

for (let i = 0; i < numDevices; i++) {
  const deviceType = selectDeviceType();
  const ip = generateIP(i + 1000); // Offset per evitare .0 e .255
  const sysname = `${deviceType.prefix}_${String(i + 1).padStart(4, '0')}`;
  const location = locations[Math.floor(Math.random() * locations.length)];

  const device = {
    ip,
    sysname,
    sysdesc: `${deviceType.vendor} ${deviceType.model} - Test Device`,
    sysuptime: Math.floor(Math.random() * 86400 * 30), // 0-30 giorni uptime
    syslocation: location,
    vendor: deviceType.vendor,
    model: deviceType.model,
    os: deviceType.type === 'ap' ? 'UniFi' : 'VRP V800R021',
    serial: `SN${String(i + 1).padStart(10, '0')}`,
    status: 'active',
    level: deviceType.level,
  };

  const result = db.upsertDevice(device);
  deviceIds.push(result.lastInsertRowid);
  deviceIPs.push(ip);

  if ((i + 1) % 50 === 0) {
    process.stdout.write(`\r   Creati ${i + 1}/${numDevices} devices`);
  }
}

const deviceTime = Date.now() - startTime;
console.log(`\r✅ Creati ${numDevices} devices in ${deviceTime}ms (${(deviceTime / numDevices).toFixed(2)}ms/device)`);
console.log();

// ========== GENERAZIONE INTERFACES ==========
console.log(`🔌 Generando interfaces...`);
const interfaceIds = new Map(); // deviceId -> [interfaceId1, interfaceId2, ...]
const ifStartTime = Date.now();

let totalInterfaces = 0;
for (let i = 0; i < deviceIds.length; i++) {
  const deviceId = deviceIds[i];
  const deviceType = selectDeviceType();

  // Numero interfacce basato su tipo device
  let numInterfaces = 24; // Default
  if (deviceType.type === 'l3') numInterfaces = 48;
  if (deviceType.type === 'router') numInterfaces = 8;
  if (deviceType.type === 'ap') numInterfaces = 2;
  if (deviceType.type === 'neighbor') numInterfaces = 1;

  const ifIds = [];

  for (let ifIndex = 1; ifIndex <= numInterfaces; ifIndex++) {
    const iface = {
      device_id: deviceId,
      ifindex: ifIndex,
      ifname: `GigabitEthernet0/0/${ifIndex}`,
      ifdescr: `Interface ${ifIndex}`,
      iftype: 6, // ethernetCsmacd
      ifspeed: [100, 1000, 10000][Math.floor(Math.random() * 3)] * 1000000, // 100M, 1G, 10G
      ifadminstatus: 1, // up
      ifoperstatus: Math.random() > 0.1 ? 1 : 2, // 90% up, 10% down
      ifalias: `Port ${ifIndex}`,
      ifphysaddress: generateMAC(),
    };

    const result = db.upsertInterface(iface);
    ifIds.push(result.lastInsertRowid);
    totalInterfaces++;
  }

  interfaceIds.set(deviceId, ifIds);

  if ((i + 1) % 50 === 0) {
    process.stdout.write(`\r   Creati ${totalInterfaces} interfaces per ${i + 1}/${deviceIds.length} devices`);
  }
}

const ifTime = Date.now() - ifStartTime;
console.log(`\r✅ Creati ${totalInterfaces} interfaces in ${ifTime}ms`);
console.log();

// ========== GENERAZIONE LINKS ==========
console.log(`🔗 Generando links (~${numDevices * linksPerDevice} attesi)...`);
const linkStartTime = Date.now();

let linksCreated = 0;
const linkedPairs = new Set(); // Track per evitare duplicati

for (let i = 0; i < deviceIds.length; i++) {
  const deviceId = deviceIds[i];
  const deviceIfaces = interfaceIds.get(deviceId) || [];

  // Crea N links casuali per questo device
  const numLinksForDevice = Math.min(linksPerDevice, deviceIfaces.length);

  for (let j = 0; j < numLinksForDevice; j++) {
    // Seleziona device remoto casuale (diverso da se stesso)
    let remoteIdx = Math.floor(Math.random() * deviceIds.length);
    while (remoteIdx === i) {
      remoteIdx = Math.floor(Math.random() * deviceIds.length);
    }

    const remoteDeviceId = deviceIds[remoteIdx];
    const remoteIp = deviceIPs[remoteIdx];

    // Check duplicati (evita A->B e B->A)
    const pairKey1 = `${deviceId}-${remoteDeviceId}`;
    const pairKey2 = `${remoteDeviceId}-${deviceId}`;

    if (linkedPairs.has(pairKey1) || linkedPairs.has(pairKey2)) {
      continue; // Skip se già collegati
    }

    linkedPairs.add(pairKey1);

    // Seleziona interfaccia locale casuale
    const localIfIndex = Math.floor(Math.random() * deviceIfaces.length) + 1;
    const remoteIfaces = interfaceIds.get(remoteDeviceId) || [];
    const remoteIfIndex = Math.floor(Math.random() * remoteIfaces.length) + 1;

    const protocols = ['LLDP', 'CDP', 'FDP', 'EDP'];
    const protocol = protocols[Math.floor(Math.random() * protocols.length)];

    const link = {
      device_id: deviceId,
      local_ifindex: localIfIndex,
      local_ifname: `GigabitEthernet0/0/${localIfIndex}`,
      remote_device_id: remoteDeviceId,
      remote_ip: remoteIp,
      remote_sysname: `test_device_${String(remoteIdx + 1).padStart(4, '0')}`,
      remote_chassisid: generateMAC(),
      remote_portid: `GigabitEthernet0/0/${remoteIfIndex}`,
      remote_portdesc: `Remote Port ${remoteIfIndex}`,
      protocol,
    };

    db.upsertLink(link);
    linksCreated++;
  }

  if ((i + 1) % 50 === 0) {
    process.stdout.write(`\r   Creati ${linksCreated} links per ${i + 1}/${deviceIds.length} devices`);
  }
}

const linkTime = Date.now() - linkStartTime;
console.log(`\r✅ Creati ${linksCreated} links in ${linkTime}ms (${(linkTime / linksCreated).toFixed(2)}ms/link)`);
console.log();

// ========== STATISTICHE FINALI ==========
const totalTime = Date.now() - startTime;

console.log(`📊 Statistiche finali:`);
console.log(`   ✅ Devices: ${numDevices}`);
console.log(`   ✅ Interfaces: ${totalInterfaces}`);
console.log(`   ✅ Links: ${linksCreated}`);
console.log(`   ⏱️  Tempo totale: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
console.log();

// Verifica dati nel DB
const devicesInDB = db.getAllDevices().length;
const linksInDB = db.getAllLinks().length;

console.log(`🔍 Verifica database:`);
console.log(`   📦 Devices nel DB: ${devicesInDB}`);
console.log(`   🔗 Links nel DB: ${linksInDB}`);
console.log();

if (devicesInDB === numDevices && linksInDB >= linksCreated) {
  console.log(`✅ Generazione completata con successo!`);
  console.log();
  console.log(`🚀 Ora puoi testare la performance con:`);
  console.log(`   - http://localhost:4000/topology-nedi-layer.html (originale)`);
  console.log(`   - http://localhost:4000/topology-nedi-layer-optimized.html (ottimizzato)`);
} else {
  console.log(`⚠️  Attenzione: discrepanze nei dati generati`);
}

db.close();
process.exit(0);
