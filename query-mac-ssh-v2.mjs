#!/usr/bin/env node
/**
 * Query SSH live - versione con credenziali hardcoded comuni
 */

import { Client } from 'ssh2';

const switchIp = process.argv[2] || '192.168.1.1';
const macInput = process.argv[3] || '00:00:00:00:00:01';

// Normalizza MAC in formato Huawei
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

// Credenziali da provare (configurabili via env)
const credentials = [
  { user: process.env.SSH_USERNAME || 'admin', pass: process.env.SWITCH_PASSWORD || 'changeme' },
];

// Funzione per eseguire comando SSH con shell interattiva
function execSSH(host, username, password, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let commandSent = false;

    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('Timeout'));
    }, 20000);

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

          // Quando vediamo il prompt, inviamo i comandi
          if (!commandSent && (text.includes('>') || text.includes('#') || text.includes(']'))) {
            commandSent = true;
            // Disabilita paging
            stream.write('screen-length 0 temporary\n');
            setTimeout(() => {
              console.log(`   ⚡ Eseguo: ${command}`);
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
      readyTimeout: 8000,
      algorithms: {
        kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group1-sha1'],
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc', 'aes256-cbc'],
        hmac: ['hmac-sha1', 'hmac-sha2-256', 'hmac-sha2-512']
      }
    });
  });
}

// Prova le credenziali
console.log('═══ Connessione SSH ═══\n');

let connected = false;

for (const cred of credentials) {
  if (connected) break;
  if (!cred.pass) continue;

  console.log(`   Provo: ${cred.user}...`);

  try {
    const command = `display mac-address ${macHuawei}`;
    const result = await execSSH(switchIp, cred.user, cred.pass, command);
    connected = true;

    console.log(`\n═══ Output Completo ═══\n`);

    // Filtra output rilevante
    const lines = result.split('\n');
    let capture = false;

    for (const line of lines) {
      // Inizia a catturare dal comando
      if (line.includes('display mac-address')) {
        capture = true;
        continue;
      }
      // Stop al prompt successivo
      if (capture && (line.match(/^<.*>/) || line.match(/^\[.*\]/))) {
        break;
      }
      if (capture && line.trim()) {
        console.log(line);
      }
    }

    // Parse risultato
    console.log('\n═══ Analisi ═══\n');

    // Cerca pattern porta
    const portMatch = result.match(/(GE|XGE|Eth-Trunk|GigabitEthernet|XGigabitEthernet)[0-9\/]+/gi);
    const vlanMatch = result.match(/^\s*(\d+)\s+[0-9a-f]{4}-/im);

    if (portMatch && portMatch.length > 0) {
      // Prendi l'ultima occorrenza (quella della tabella MAC)
      const port = portMatch[portMatch.length - 1];
      console.log(`   ✅ PORTA TROVATA: ${port}`);
    } else {
      console.log('   ⚠ Porta non trovata nell\'output');
    }

    if (vlanMatch) {
      console.log(`   ✅ VLAN: ${vlanMatch[1]}`);
    }

    console.log(`   📍 SWITCH: ${switchIp}`);

  } catch (err) {
    if (!err.message.includes('auth') && !err.message.includes('Auth')) {
      console.log(`   ⚠ ${err.message}`);
    }
  }
}

if (!connected) {
  console.log('\n❌ Nessuna credenziale funzionante');
  console.log('\n   Prova manualmente:');
  console.log(`   ssh admin@${switchIp}`);
  console.log(`   display mac-address ${macHuawei}`);
}

console.log('\n═══════════════════════════════════════════════════════════════════\n');
