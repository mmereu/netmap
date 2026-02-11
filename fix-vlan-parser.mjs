#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix: parseVlanFromMacOutput deve gestire formato tabulare Huawei
// Formato Huawei: 0000-481a-c6f1 247       GE3/0/16      dynamic
// La VLAN è il numero dopo il MAC address

const oldCode = `function parseVlanFromMacOutput(text) {
  const lines = String(text || '').split(/\\r?\\n/);
  for (const line of lines) {
    const m =
      line.match(/VLAN\\s*ID\\s*:?\\s*(\\d+)/i) ||
      line.match(/VLAN\\s*:?\\s*(\\d+)/i) ||
      line.match(/VlanId\\s*:?\\s*(\\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}`;

const newCode = `function parseVlanFromMacOutput(text) {
  const lines = String(text || '').split(/\\r?\\n/);
  for (const line of lines) {
    // Pattern 1: Formato esplicito "VLAN ID: 123" o "VLAN: 123"
    const m =
      line.match(/VLAN\\s*ID\\s*:?\\s*(\\d+)/i) ||
      line.match(/VLAN\\s*:?\\s*(\\d+)/i) ||
      line.match(/VlanId\\s*:?\\s*(\\d+)/i);
    if (m) return Number(m[1]);

    // Pattern 2: Formato tabulare Huawei
    // "0000-481a-c6f1 247       GE3/0/16      dynamic"
    // Il numero dopo il MAC (4 gruppi hex separati da -) è la VLAN
    const huaweiMatch = line.match(/[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\\s+(\\d+)\\s+/i);
    if (huaweiMatch) return Number(huaweiMatch[1]);

    // Pattern 3: Formato con MAC colon-separated
    // "00:00:48:1a:c6:f1  247  GE3/0/16"
    const colonMatch = line.match(/[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}\\s+(\\d+)\\s+/i);
    if (colonMatch) return Number(colonMatch[1]);
  }
  return null;
}`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Fix applicato: parseVlanFromMacOutput ora gestisce formato tabulare Huawei');
} else {
  console.log('⚠ Pattern non trovato');
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('Formato tabulare Huawei')) {
  console.log('✓ Verifica: Nuovo codice presente');
} else {
  console.log('✗ Verifica fallita');
}
