#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix: Non restituire subito dal DB, sempre verificare con SSH
const oldCode = `          // Se la migliore porta è FISICA, restituisci subito
          if (bestIsPhysical) {
            result.source = 'local-db';
            result.found = true;
            result.endpoint = {
              device: best.device,
              deviceIp: best.device_ip,
              ifName: best.interface,
              vlan: best.vlan,
              source: 'local-nodes'
            };
            result.elapsed = \`\${Date.now() - t0}ms\`;
            console.log(\`[MAC-HYBRID] Found PHYSICAL PORT in LOCAL DB: \${result.endpoint?.device} \${result.endpoint?.ifName} (\${localElapsed}ms)\`);
            return res.json(result);
          }

          // Se è VLAN interface, salva info e continua per trovare porta fisica
          console.log(\`[MAC-HYBRID] Local DB has only VLAN interface (\${best.interface}), continuing to find physical port...\`);
          result.vlanResult = {
            device: best.device,
            deviceIp: best.device_ip,
            vlanInterface: best.interface,
            vlan: best.vlan
          };`;

const newCode = `          // Salva info DB e continua a FASE 1.5 per verifica SSH live
          // (i dati DB potrebbero essere vecchi, sempre verificare!)
          console.log(\`[MAC-HYBRID] Found in LOCAL DB: \${best.device} \${best.interface}, verifying with live SSH...\`);
          result.vlanResult = {
            device: best.device,
            deviceIp: best.device_ip,
            vlanInterface: best.interface,
            vlan: best.vlan
          };
          // Salva come fallback se SSH fallisce
          result.dbFallback = {
            device: best.device,
            deviceIp: best.device_ip,
            ifName: best.interface,
            vlan: best.vlan,
            source: 'local-db-unverified'
          };`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Fix applicato: FASE 0 non restituisce più subito, sempre verifica SSH');
} else {
  console.log('⚠ Pattern non trovato');
  // Prova pattern alternativo
  if (content.includes('Found PHYSICAL PORT in LOCAL DB')) {
    console.log('Il vecchio codice sembra presente ma con formato diverso');
  }
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('verifying with live SSH')) {
  console.log('✓ Verifica: Nuovo codice presente');
} else {
  console.log('✗ Verifica fallita');
}
