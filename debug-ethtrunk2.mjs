#!/usr/bin/env node
/**
 * Debug Eth-Trunk trace - Step 2: Trova IP del neighbor
 */

import { readFileSync } from 'fs';
import { Client } from 'ssh2';
import Database from 'better-sqlite3';

const switchIp = '192.168.7.251';
const neighborName = '07_L2_Rack11_Barriera_NEW_178';
const macHuawei = '0000-4832-51e2';

// Leggi credenziali sito 7 (Seriate)
const csvPath = './Pdv.CSV';
let sshCreds = { user: process.env.SSH_USERNAME || 'admin', pass: process.env.SWITCH_PASSWORD || 'changeme' };

try {
  const csv = readFileSync(csvPath, 'utf-8');
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  for (const line of lines) {
    const parts = line.split(';');
    if (parts[0] === '7' && parts[3] && parts[4]) {
      sshCreds = { user: parts[3], pass: parts[4] };
      break;
    }
  }
} catch (e) {}

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║         Debug Eth-Trunk - Trova IP Neighbor                      ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

console.log(`📍 Neighbor: ${neighborName}`);

// Step 1: Cerca nel database locale
console.log('\n═══ Step 1: Database Locale ═══\n');

try {
  const db = new Database('./netmap.db', { readonly: true });

  // Cerca device per nome
  const device = db.prepare(`
    SELECT id, sysname, ip, device_type
    FROM devices
    WHERE sysname LIKE ?
  `).get(`%${neighborName}%`);

  if (device) {
    console.log(`✅ Trovato in DB:`);
    console.log(`   ID: ${device.id}`);
    console.log(`   Name: ${device.sysname}`);
    console.log(`   IP: ${device.ip}`);
    console.log(`   Type: ${device.device_type}`);
  } else {
    console.log('⚠ Non trovato nel database locale');

    // Cerca device simili
    const similar = db.prepare(`
      SELECT sysname, ip FROM devices
      WHERE sysname LIKE '%Rack11%' OR sysname LIKE '%178%'
    `).all();

    if (similar.length > 0) {
      console.log('\nDevice simili:');
      similar.forEach(d => console.log(`  - ${d.sysname} (${d.ip})`));
    }
  }

  db.close();
} catch (e) {
  console.log('⚠ Errore database:', e.message);
}

// Step 2: Cerca via SSH (display ip interface brief)
console.log('\n═══ Step 2: SSH - Cerca IP nel neighbor ═══\n');

function execSSH(host, username, password, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let commandSent = false;

    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('Timeout'));
    }, 25000);

    conn.on('ready', () => {
      conn.shell((err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          return reject(err);
        }

        stream.on('close', () => {
          clearTimeout(timeout);
          conn.end();
          resolve(output);
        });

        stream.on('data', (data) => {
          const text = data.toString();
          output += text;

          if (!commandSent && (text.includes('>') || text.includes('#') || text.includes(']'))) {
            commandSent = true;
            stream.write('screen-length 0 temporary\n');
            setTimeout(() => {
              stream.write(command + '\n');
              setTimeout(() => {
                stream.write('quit\n');
              }, 2000);
            }, 500);
          }
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect({
      host,
      port: 22,
      username,
      password,
      readyTimeout: 10000,
      algorithms: {
        kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group1-sha1'],
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc'],
        hmac: ['hmac-sha1', 'hmac-sha2-256']
      }
    });
  });
}

async function main() {
  try {
    // Cerca IP del neighbor dal LLDP neighbor detail
    console.log('Eseguo: display lldp neighbor interface XGigabitEthernet1/0/4 (completo)\n');

    const lldpOut = await execSSH(switchIp, sshCreds.user, sshCreds.pass, 'display lldp neighbor interface XGigabitEthernet1/0/4');

    // Mostra tutto l'output per vedere se c'è management IP
    const lines = lldpOut.split('\n');
    let inLldp = false;

    for (const line of lines) {
      if (line.includes('display lldp neighbor')) {
        inLldp = true;
        continue;
      }
      if (inLldp && line.trim().startsWith('<')) {
        break;
      }
      if (inLldp && line.trim()) {
        console.log('  ' + line);
      }
    }

    // Cerca management address
    const mgmtMatch = lldpOut.match(/Management\s+address[:\s]+type[:\s]+(\w+)[,\s]+address[:\s]+(\S+)/i);
    if (mgmtMatch) {
      console.log(`\n✅ Management Address: ${mgmtMatch[2]} (${mgmtMatch[1]})`);
    } else {
      // Altro pattern
      const mgmtMatch2 = lldpOut.match(/Management\s+address[:\s]+(\d+\.\d+\.\d+\.\d+)/i);
      if (mgmtMatch2) {
        console.log(`\n✅ Management Address: ${mgmtMatch2[1]}`);
      } else {
        console.log('\n⚠ Nessun Management Address nell\'output LLDP');
      }
    }

    // Step 3: Se troviamo l'IP nel DB, verifica che il MAC sia lì
    console.log('\n═══ Step 3: Verifica MAC sul neighbor switch ═══\n');

    // IP del neighbor dovrebbe essere 192.168.7.178 basato sul nome (178)
    const neighborIp = '192.168.7.178';
    console.log(`Provo IP inferito dal nome: ${neighborIp}\n`);

    try {
      const macOut = await execSSH(neighborIp, sshCreds.user, sshCreds.pass, `display mac-address ${macHuawei}`);

      const macLines = macOut.split('\n');
      let found = false;
      for (const line of macLines) {
        if (line.includes(macHuawei)) {
          console.log('✅ MAC trovato:');
          console.log('  ' + line);
          found = true;
        }
      }

      if (found) {
        console.log('\n🎯 SOLUZIONE: Il MAC è sul neighbor switch!');
        console.log('   Il trace dovrebbe continuare da qui.');
      } else {
        console.log('⚠ MAC non trovato su questo switch');
      }
    } catch (e) {
      console.log(`⚠ Impossibile connettersi a ${neighborIp}: ${e.message}`);
    }

  } catch (err) {
    console.error('❌ Errore:', err.message);
  }
}

main();
