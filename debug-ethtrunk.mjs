#!/usr/bin/env node
/**
 * Debug Eth-Trunk trace per MAC 00:00:48:32:51:e2
 */

import { readFileSync } from 'fs';
import { Client } from 'ssh2';

const switchIp = '192.168.7.251';  // Core switch dove MAC è su Eth-Trunk78
const macHuawei = '0000-4832-51e2';
const trunkNum = 78;

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
} catch (e) {
  console.log('⚠ Usando credenziali default');
}

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║         Debug Eth-Trunk Trace                                    ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

console.log(`📍 Switch: ${switchIp}`);
console.log(`🔍 MAC: ${macHuawei}`);
console.log(`🔗 Eth-Trunk: ${trunkNum}`);
console.log(`👤 User: ${sshCreds.user}\n`);

// Parser membri trunk
function parseTrunkMembers(text) {
  const lines = String(text || '').split(/\r?\n/);
  const members = [];
  for (const line of lines) {
    const m = line.match(/(?:Gigabit|XGigabit|GE|Ethernet)[A-Za-z]*\d+\/\d+\/\d+/i);
    if (m) members.push(m[0]);
  }
  return Array.from(new Set(members));
}

// Parser LLDP neighbor
function parseLldpNeighborIp(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/Management\s+address[:\s]+(\d+\.\d+\.\d+\.\d+)/i);
    if (m) return m[1];
  }
  return null;
}

function parseLldpNeighborName(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/System\s+name[:\s]+(\S+)/i);
    if (m) return m[1];
  }
  return null;
}

// Esegue comando SSH
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
    // Step 1: Conferma MAC su Eth-Trunk
    console.log('═══ Step 1: Verifica MAC su Eth-Trunk ═══\n');
    const macOut = await execSSH(switchIp, sshCreds.user, sshCreds.pass, `display mac-address ${macHuawei}`);

    // Estrai info
    const macLines = macOut.split('\n');
    for (const line of macLines) {
      if (line.includes(macHuawei) || line.includes('Eth-Trunk')) {
        console.log('  ' + line.trim());
      }
    }

    // Step 2: Get trunk members
    console.log('\n═══ Step 2: Membri Eth-Trunk ═══\n');
    const trunkOut = await execSSH(switchIp, sshCreds.user, sshCreds.pass, `display eth-trunk ${trunkNum}`);

    console.log('Raw output (primi 50 righe):');
    const trunkLines = trunkOut.split('\n').slice(0, 50);
    for (const line of trunkLines) {
      if (line.trim()) console.log('  ' + line);
    }

    const members = parseTrunkMembers(trunkOut);
    console.log(`\n✓ Membri parsati: ${members.length}`);
    members.forEach(m => console.log(`  - ${m}`));

    if (members.length === 0) {
      console.log('\n⚠ PROBLEMA: Nessun membro trovato!');
      console.log('   Il parser potrebbe non riconoscere il formato.');
      return;
    }

    // Step 3: LLDP su ogni membro
    console.log('\n═══ Step 3: LLDP Neighbors sui membri ═══\n');

    for (const member of members) {
      console.log(`\n--- ${member} ---`);
      const lldpOut = await execSSH(switchIp, sshCreds.user, sshCreds.pass, `display lldp neighbor interface ${member}`);

      const neighborIp = parseLldpNeighborIp(lldpOut);
      const neighborName = parseLldpNeighborName(lldpOut);

      if (neighborIp || neighborName) {
        console.log(`  ✅ Neighbor trovato:`);
        if (neighborName) console.log(`     Name: ${neighborName}`);
        if (neighborIp) console.log(`     IP: ${neighborIp}`);
      } else {
        console.log(`  ⚠ Nessun neighbor LLDP`);
        // Mostra output raw per debug
        const lldpLines = lldpOut.split('\n').filter(l => l.trim());
        if (lldpLines.length > 3) {
          console.log('  Raw (primi 10 righe):');
          lldpLines.slice(0, 10).forEach(l => console.log('    ' + l.trim()));
        }
      }
    }

    console.log('\n═══ Analisi ═══\n');
    console.log('Se nessun neighbor LLDP è trovato sui membri del trunk,');
    console.log('il trace non può continuare perché non sa dove andare.');
    console.log('\nPossibili cause:');
    console.log('1. Il neighbor è un device che non supporta LLDP');
    console.log('2. LLDP è disabilitato sul neighbor');
    console.log('3. Il trunk porta a un device non gestito (es. AP, server)');

  } catch (err) {
    console.error('❌ Errore:', err.message);
  }
}

main();
