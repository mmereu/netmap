#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix: mostra output completo (non troncato)
const oldCode = `    console.log('[FDB-DEBUG] Raw output from', host, ':', out.substring(0, 500));`;
const newCode = `    console.log('[FDB-DEBUG] Raw output from', host, 'length:', out.length, 'content:', JSON.stringify(out.substring(0, 1000)));`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Log esteso');
} else {
  console.log('⚠ Pattern non trovato');
}
