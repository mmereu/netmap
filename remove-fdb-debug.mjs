#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Rimuovi log debug FDB
const debugLog1 = `    console.log('[FDB-DEBUG] Raw output from', host, 'length:', out.length, 'content:', JSON.stringify(out.substring(0, 1000)));\n`;
const debugLog2 = `    console.log('[FDB-DEBUG] Parsed ifName:', ifName, 'vlan:', vlan);\n`;

if (content.includes(debugLog1)) {
  content = content.replace(debugLog1, '');
  console.log('✓ Rimosso log debug 1');
}
if (content.includes(debugLog2)) {
  content = content.replace(debugLog2, '');
  console.log('✓ Rimosso log debug 2');
}

fs.writeFileSync(file, content);
console.log('✓ Log debug rimossi');
