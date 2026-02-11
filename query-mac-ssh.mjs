#!/usr/bin/env node
/**
 * Query SSH live per trovare porta esatta di un MAC address
 */

import { readFileSync } from 'fs';
import { Client } from 'ssh2';

const switchIp = process.argv[2] || '192.168.7.171';
const macInput = process.argv[3] || '00:00:48:1b:a4:a7';

// Normalizza MAC in formato Huawei (xxxx-xxxx-xxxx)
function formatMacHuawei(mac) {
  const clean = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (clean.length !== 12) return null;
  return clean.match(/.{4}/g).join('-');
}

const macHuawei = formatMacHuawei(macInput);

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║              NetMap - Query SSH Live MAC Address                 ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

console.log(`🔍 MAC: ${macInput}`);
console.log(`   Formato Huawei: ${macHuawei}`);
console.log(`   Switch: ${switchIp}\n`);

// Leggi credenziali
const csvPath = './Pdv.CSV';
let credentials = [];

try {
  const csv = readFileSync(csvPath, 'utf-8');
  const lines = csv.split(/\r?\n/).filter(l => l.trim());

  for (const line of lines) {
    const parts = line.split(';');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      credentials.push({
        site: parts[0],
        user: parts[1],
        pass: parts[2]
      });
    }
  }
  console.log(`✓ Caricate ${credentials.length} credenziali\n`);
} catch (err) {
  console.error('❌ Errore lettura credenziali:', err.message);
  process.exit(1);
}

// Funzione per eseguire comando SSH
function execSSH(host, username, password, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let shellReady = false;

    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('Timeout connessione'));
    }, 30000);

    conn.on('ready', () => {
      console.log(`   ✓ Connesso con ${username}`);

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

          // Attendi prompt prima di inviare comando
          if (!shellReady && (text.includes('>') || text.includes('#') || text.includes(']'))) {
            shellReady = true;
            // Disabilita paginazione
            stream.write('screen-length 0 temporary\n');
            setTimeout(() => {
              stream.write(command + '\n');
              setTimeout(() => {
                stream.write('quit\n');
              }, 3000);
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

// Prova le credenziali
console.log('═══ Connessione SSH ═══\n');

let connected = false;
let result = null;

for (const cred of credentials) {
  if (connected) break;

  console.log(`   Provo: ${cred.user}...`);

  try {
    const command = `display mac-address ${macHuawei}`;
    result = await execSSH(switchIp, cred.user, cred.pass, command);
    connected = true;
    console.log(`\n═══ Risultato ═══\n`);

    // Estrai solo la parte rilevante dell'output
    const lines = result.split('\n');
    let inTable = false;
    let relevantLines = [];

    for (const line of lines) {
      // Cerca header tabella MAC
      if (line.includes('MAC Address') && line.includes('VLAN')) {
        inTable = true;
      }
      if (inTable) {
        relevantLines.push(line);
      }
      // Fine tabella
      if (inTable && line.includes('Total matching')) {
        break;
      }
    }

    if (relevantLines.length > 0) {
      console.log(relevantLines.join('\n'));
    } else {
      // Mostra output raw se non parsato
      console.log(result);
    }

    // Parse interfaccia
    const ifMatch = result.match(/(GE|XGE|Eth-Trunk|GigabitEthernet|XGigabitEthernet)[^\s]*\d+\/\d+\/\d+/gi);
    const vlanMatch = result.match(/(\d+)\s+[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i);

    console.log('\n═══ Riepilogo ═══\n');
    if (ifMatch) {
      console.log(`   ✅ PORTA: ${ifMatch[0]}`);
    }
    if (vlanMatch) {
      console.log(`   ✅ VLAN: ${vlanMatch[1]}`);
    }
    console.log(`   ✅ SWITCH: ${switchIp}`);

  } catch (err) {
    // Prova prossima credenziale
    if (err.message.includes('Authentication') || err.message.includes('auth')) {
      continue;
    }
    console.log(`   ⚠ Errore: ${err.message}`);
  }
}

if (!connected) {
  console.log('\n❌ Impossibile connettersi allo switch con le credenziali disponibili');
}

console.log('\n═══════════════════════════════════════════════════════════════════\n');
