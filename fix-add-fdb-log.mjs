#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Aggiungi log per vedere output FDB
const oldCode = `    const out = await tryMacCli(host, siteCreds, coreFallback, hyphenMac, altCredsArray);
    if (!out) return null;
    const ifName = parseInterfaceFromMacOutput(out);
    const vlan = parseVlanFromMacOutput(out);
    if (!ifName) return null;
    return { ifName, vlan, source: 'ssh' };`;

const newCode = `    const out = await tryMacCli(host, siteCreds, coreFallback, hyphenMac, altCredsArray);
    if (!out) return null;
    console.log('[FDB-DEBUG] Raw output from', host, ':', out.substring(0, 500));
    const ifName = parseInterfaceFromMacOutput(out);
    const vlan = parseVlanFromMacOutput(out);
    console.log('[FDB-DEBUG] Parsed ifName:', ifName, 'vlan:', vlan);
    if (!ifName) return null;
    return { ifName, vlan, source: 'ssh' };`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Log FDB aggiunto');
} else {
  console.log('⚠ Pattern non trovato');
}
