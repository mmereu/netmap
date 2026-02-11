#!/usr/bin/env node
/**
 * Query SSH diretta con credenziali specifiche
 */

import { Client } from 'ssh2';

const switchIp = process.argv[2] || '192.168.1.1';
const macHuawei = process.argv[3] || '0000-0000-0001';
const username = process.env.SSH_USERNAME || 'admin';
const password = process.env.SWITCH_PASSWORD || 'changeme';

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║         Query MAC via SSH                                        ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

console.log(`🔍 MAC Huawei format: ${macHuawei}`);
console.log(`📡 Switch: ${switchIp}`);
console.log(`👤 User: ${username}\n`);

const conn = new Client();
let output = '';
let commandSent = false;

const timeout = setTimeout(() => {
  console.log('❌ Timeout connessione');
  conn.end();
  process.exit(1);
}, 25000);

conn.on('ready', () => {
  console.log('✓ Connessione SSH stabilita\n');

  conn.shell((err, stream) => {
    if (err) {
      clearTimeout(timeout);
      console.error('❌ Errore shell:', err.message);
      conn.end();
      process.exit(1);
    }

    stream.on('close', () => {
      clearTimeout(timeout);
      conn.end();

      // Analizza output
      console.log('═══ Analisi Risultato ═══\n');

      const lines = output.split('\n');
      let inMacTable = false;
      let macFound = false;

      for (const line of lines) {
        // Header tabella MAC
        if (line.includes('MAC Address') && line.includes('VLAN')) {
          inMacTable = true;
          console.log(line);
          continue;
        }

        // Separatore
        if (inMacTable && line.includes('---')) {
          console.log(line);
          continue;
        }

        // Riga con MAC
        if (inMacTable && line.includes('0000-481b-a4a7')) {
          console.log(line);
          macFound = true;

          // Parse
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            console.log('\n═══ RISULTATO FINALE ═══\n');
            console.log(`   ✅ MAC:    ${parts[0]}`);
            console.log(`   ✅ VLAN:   ${parts[1]}`);
            console.log(`   ✅ PORTA:  ${parts[parts.length - 1]}`);
            console.log(`   📍 SWITCH: ${switchIp}`);
          }
        }

        // Fine tabella
        if (inMacTable && line.includes('Total')) {
          console.log(line);
          break;
        }
      }

      if (!macFound) {
        console.log('⚠ MAC non trovato nella tabella');
        console.log('\nOutput raw:');
        console.log(output.substring(output.indexOf('display mac-address')));
      }

      console.log('\n═══════════════════════════════════════════════════════════════════\n');
    });

    stream.on('data', (data) => {
      const text = data.toString();
      output += text;

      // Invia comandi al primo prompt
      if (!commandSent && (text.includes('>') || text.includes(']'))) {
        commandSent = true;
        console.log('⚡ Eseguo comandi...\n');

        // Disabilita paging
        stream.write('screen-length 0 temporary\n');

        setTimeout(() => {
          stream.write(`display mac-address ${macHuawei}\n`);

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
  console.error('❌ Errore SSH:', err.message);

  if (err.message.includes('auth') || err.message.includes('Auth')) {
    console.log('\n   Credenziali non valide. Prova manualmente:');
    console.log(`   ssh admin@${switchIp}`);
    console.log(`   display mac-address ${macHuawei}`);
  }

  process.exit(1);
});

console.log('Connessione in corso...\n');

conn.connect({
  host: switchIp,
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
