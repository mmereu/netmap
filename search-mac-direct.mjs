#!/usr/bin/env node
/**
 * Ricerca MAC address diretta (senza server)
 * Usa NeDi DB first, poi SSH fallback
 */

import NeDiDB from './libnedi.js';
import { readFileSync } from 'fs';
import { NodeSSH } from 'node-ssh';

// Parametri
const macInput = process.argv[2] || '00:00:48:1b:a4:a7';
const network = process.argv[3] || '192.168.7.0/24';

// Normalizza MAC
function normalizeMac(mac) {
  if (!mac) return null;
  const clean = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return clean.length === 12 ? clean : null;
}

function formatMac(mac, sep = ':') {
  const clean = normalizeMac(mac);
  if (!clean) return null;
  return clean.match(/.{2}/g).join(sep);
}

function formatMacHuawei(mac) {
  const clean = normalizeMac(mac);
  if (!clean) return null;
  return clean.match(/.{4}/g).join('-');
}

// Estrai subnet base dalla network
function getNetworkBase(network) {
  const [ip] = network.split('/');
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║               NetMap - Ricerca MAC Address Diretta               ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

const macNorm = normalizeMac(macInput);
const macColon = formatMac(macInput);
const macHuawei = formatMacHuawei(macInput);

console.log(`🔍 MAC cercato: ${macInput}`);
console.log(`   Normalizzato: ${macNorm}`);
console.log(`   Formato colon: ${macColon}`);
console.log(`   Formato Huawei: ${macHuawei}`);
console.log(`   Network: ${network}\n`);

if (!macNorm) {
  console.error('❌ MAC address non valido');
  process.exit(1);
}

// FASE 1: Cerca in NeDi DB
console.log('═══ FASE 1: Ricerca in NeDi DB ═══\n');

const nedi = new NeDiDB();
let found = false;

try {
  await nedi.connect();
  console.log('✓ Connesso a NeDi MySQL\n');

  // Cerca in nodes table
  const nodesQuery = `
    SELECT n.*, d.name as device_name, d.ip as device_ip, d.type as device_type
    FROM nodes n
    LEFT JOIN devices d ON n.device = d.name
    WHERE REPLACE(REPLACE(REPLACE(n.mac, ':', ''), '-', ''), '.', '') = ?
    ORDER BY n.lastseen DESC
    LIMIT 10
  `;

  const nodes = await nedi.query(nodesQuery, [macNorm]);

  if (nodes.length > 0) {
    console.log(`✓ Trovato in nodes table (${nodes.length} record):\n`);
    for (const node of nodes) {
      console.log(`  📍 Device: ${node.device_name || node.device}`);
      console.log(`     IP Device: ${node.device_ip || 'N/A'}`);
      console.log(`     Interface: ${node.ifname || node.port}`);
      console.log(`     VLAN: ${node.vlanid || 'N/A'}`);
      console.log(`     IP Host: ${node.ip || 'N/A'}`);
      console.log(`     Last seen: ${node.lastseen || 'N/A'}`);
      console.log('');
    }
    found = true;
  }

  // Cerca in nodarp table
  const arpQuery = `
    SELECT na.*, d.name as device_name, d.ip as device_ip
    FROM nodarp na
    LEFT JOIN devices d ON na.device = d.name
    WHERE REPLACE(REPLACE(REPLACE(na.mac, ':', ''), '-', ''), '.', '') = ?
    ORDER BY na.lastseen DESC
    LIMIT 10
  `;

  const arps = await nedi.query(arpQuery, [macNorm]);

  if (arps.length > 0) {
    console.log(`✓ Trovato in nodarp table (${arps.length} record):\n`);
    for (const arp of arps) {
      console.log(`  📍 Device: ${arp.device_name || arp.device}`);
      console.log(`     IP Device: ${arp.device_ip || 'N/A'}`);
      console.log(`     IP associato: ${arp.nodip || 'N/A'}`);
      console.log(`     Last seen: ${arp.lastseen || 'N/A'}`);
      console.log('');
    }
    found = true;
  }

  await nedi.close();
} catch (err) {
  console.error('⚠ Errore NeDi DB:', err.message);
}

// FASE 2: SSH fallback se non trovato
if (!found) {
  console.log('\n═══ FASE 2: Ricerca SSH sugli switch ═══\n');

  // Leggi credenziali
  const csvPath = './Pdv.CSV';
  let credentials = [];

  try {
    const csv = readFileSync(csvPath, 'utf-8');
    const lines = csv.split(/\r?\n/).filter(l => l.trim());

    for (const line of lines) {
      const [site, user, pass] = line.split(';');
      if (user && pass) {
        credentials.push({ site, user, pass });
      }
    }
  } catch (err) {
    console.error('⚠ Errore lettura credenziali:', err.message);
  }

  // Trova switch nella network
  const networkBase = getNetworkBase(network);
  console.log(`🔍 Cerco switch nella rete ${networkBase}.*\n`);

  // Prova alcuni IP comuni per switch (gateway)
  const switchIps = [
    `${networkBase}.251`,
    `${networkBase}.252`,
    `${networkBase}.1`,
    `${networkBase}.254`
  ];

  for (const switchIp of switchIps) {
    console.log(`\n📡 Provo switch ${switchIp}...`);

    for (const cred of credentials) {
      const ssh = new NodeSSH();

      try {
        await ssh.connect({
          host: switchIp,
          username: cred.user,
          password: cred.pass,
          timeout: 8000,
          tryKeyboard: true,
          algorithms: {
            kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha256'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc'],
            hmac: ['hmac-sha1', 'hmac-sha2-256']
          }
        });

        console.log(`   ✓ Connesso con ${cred.user}`);

        // Comando display mac-address
        const cmd = `display mac-address ${macHuawei}`;
        console.log(`   ⚡ Eseguo: ${cmd}`);

        const result = await ssh.execCommand(cmd);

        if (result.stdout) {
          console.log('\n   📋 Output:');
          console.log('   ' + result.stdout.split('\n').join('\n   '));

          // Parse output
          const lines = result.stdout.split(/\r?\n/);
          for (const line of lines) {
            // Cerca pattern interfaccia
            const ifMatch = line.match(/(GE|XGE|Eth-Trunk|GigabitEthernet|XGigabitEthernet)[^\s]*\d+\/\d+\/\d+/i);
            const vlanMatch = line.match(/(\d+)\s+/);

            if (ifMatch) {
              console.log(`\n   ✅ TROVATO!`);
              console.log(`      Switch: ${switchIp}`);
              console.log(`      Interface: ${ifMatch[0]}`);
              if (vlanMatch) console.log(`      VLAN: ${vlanMatch[1]}`);
              found = true;
            }
          }
        }

        if (result.stderr && result.stderr.includes('not found')) {
          console.log('   ℹ MAC non presente su questo switch');
        }

        ssh.dispose();
        break; // Credenziale funzionata, passa al prossimo switch

      } catch (err) {
        ssh.dispose();
        // Prova prossima credenziale
      }
    }

    if (found) break;
  }
}

// Riepilogo
console.log('\n═══════════════════════════════════════════════════════════════════');
if (found) {
  console.log('✅ MAC address trovato! Vedi dettagli sopra.');
} else {
  console.log('❌ MAC address non trovato nella rete specificata.');
  console.log('   Possibili cause:');
  console.log('   - Il dispositivo è offline');
  console.log('   - Il MAC è stato appreso su una rete diversa');
  console.log('   - Il MAC è troppo vecchio (entry scaduta)');
}
console.log('═══════════════════════════════════════════════════════════════════\n');
