#!/usr/bin/env node
import { readFileSync } from 'fs';
import { NodeSSH } from 'node-ssh';

const mac = process.argv[2] || '00:00:00:00:00:01';
const hyphenMac = mac.replace(/:/g, '-').replace(/-/g, '').match(/.{4}/g).join('-');
const switchIp = process.argv[3] || '192.168.1.251';
const username = process.env.SSH_USERNAME || 'admin';

// Password da env
const password = process.env.SWITCH_PASSWORD;

if (!password) {
  console.error('Set SWITCH_PASSWORD env variable');
  process.exit(1);
}

console.log('MAC:', mac);
console.log('Hyphen MAC:', hyphenMac);
console.log('Switch IP:', switchIp);
console.log('Username:', username);

const ssh = new NodeSSH();

try {
  console.log('\n=== Connessione SSH ===');
  await ssh.connect({
    host: switchIp,
    username,
    password,
    timeout: 10000,
    tryKeyboard: true
  });

  console.log('Connesso!');

  const command = `display mac-address ${hyphenMac}`;
  console.log('\n=== Esecuzione comando ===');
  console.log('Command:', command);

  const result = await ssh.execCommand(command);

  console.log('\n=== OUTPUT COMPLETO ===');
  console.log('Length:', result.stdout.length);
  console.log('---');
  console.log(result.stdout);
  console.log('---');

  console.log('\n=== PARSE TEST ===');

  // Test regex esistente
  const parseInterfaceFromMacOutput = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/((?:[A-Za-z]+[A-Za-z]*)?(?:Eth|GE|Gigabit|XGigabit|Ethernet)[^\s]*\d+\/\d+\/\d+|Eth-?Trunk\d+)/i);
      if (m) return m[1];
    }
    return null;
  };

  const parseVlanFromMacOutput = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines) {
      const m =
        line.match(/VLAN\s*ID\s*:?\s*(\d+)/i) ||
        line.match(/VLAN\s*:?\s*(\d+)/i) ||
        line.match(/VlanId\s*:?\s*(\d+)/i);
      if (m) return m[1];
    }
    return null;
  };

  const ifName = parseInterfaceFromMacOutput(result.stdout);
  const vlan = parseVlanFromMacOutput(result.stdout);

  console.log('Interface parsed:', ifName);
  console.log('VLAN parsed:', vlan);

  if (!ifName) {
    console.log('\n=== ANALISI LINEE ===');
    const lines = result.stdout.split(/\r?\n/);
    lines.forEach((line, idx) => {
      console.log(`Line ${idx}:`, JSON.stringify(line));
    });
  }

  ssh.dispose();
} catch (err) {
  console.error('Errore:', err.message);
  process.exit(1);
}
