#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix: mac_current_position NON deve restituire subito, deve continuare a FASE 1.5
const oldCode = `                const best = physicalPorts[0];
                result.source = 'nedi-mac-current';
                result.found = true;
                result.endpoint = {
                  device: best.device,
                  deviceIp: null, // Da recuperare se necessario
                  ifName: best.ifname,
                  vlan: best.vlan,
                  vendor: best.vendor,
                  source: 'mac_current_position',
                  lastseen: best.lastseen
                };
                result.dbResult = {
                  mac_current: { count: physicalPorts.length, data: physicalPorts }
                };
                result.elapsed = \`\${Date.now() - t0}ms\`;
                console.log(\`[MAC-HYBRID] Found in mac_current_position: \${best.device} \${best.ifname} (\${Date.now() - t1}ms)\`);
                return res.json(result);`;

const newCode = `                const best = physicalPorts[0];
                // NON restituire subito! Salva info e continua a FASE 1.5 per verifica SSH live
                console.log(\`[MAC-HYBRID] Found in mac_current_position: \${best.device} \${best.ifname}, will verify with SSH...\`);
                result.dbResult = {
                  mac_current: { count: physicalPorts.length, data: physicalPorts }
                };
                // Salva come vlanResult per FASE 1.5
                if (!result.vlanResult) {
                  result.vlanResult = {
                    device: best.device,
                    deviceIp: null, // Sarà recuperato in FASE 1.5
                    vlanInterface: best.ifname,
                    vlan: best.vlan
                  };
                }
                // Salva come fallback se SSH fallisce
                if (!result.dbFallback) {
                  result.dbFallback = {
                    device: best.device,
                    deviceIp: null,
                    ifName: best.ifname,
                    vlan: best.vlan,
                    vendor: best.vendor,
                    lastseen: best.lastseen,
                    source: 'mac_current_position-unverified'
                  };
                }
                // CONTINUA a FASE 1.5 invece di restituire`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Fix applicato: mac_current_position non restituisce più subito');
} else {
  console.log('⚠ Pattern non trovato - cercando variante...');
  // Prova pattern semplificato
  if (content.includes("source: 'mac_current_position'") && content.includes('return res.json(result);')) {
    console.log('Pattern parziale trovato, controlla manualmente');
  }
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('mac_current_position-unverified')) {
  console.log('✓ Verifica: Nuovo codice presente');
} else {
  console.log('✗ Verifica fallita');
}
