#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix: FASE 1 non deve restituire subito, deve continuare a FASE 1.5
const oldCode = `            // Verifica se l'endpoint è una porta fisica
            const endpointIsPhysical = result.endpoint && isPhysicalPort(result.endpoint.ifName);

            if (endpointIsPhysical) {
              result.elapsed = \`\${Date.now() - t0}ms\`;
              console.log(\`[MAC-HYBRID] Found PHYSICAL PORT in NeDi DB: \${result.endpoint?.device} \${result.endpoint?.ifName}\`);
              return res.json(result);
            }

            // Se è VLAN interface, salva info e continua per trovare porta fisica
            console.log(\`[MAC-HYBRID] NeDi DB has only VLAN interface (\${result.endpoint?.ifName}), continuing to SSH trace...\`);
            if (result.endpoint && !result.vlanResult) {
              result.vlanResult = {
                device: result.endpoint.device,
                deviceIp: result.endpoint.deviceIp,
                vlanInterface: result.endpoint.ifName,
                vlan: result.endpoint.vlan
              };
            }`;

const newCode = `            // Salva info NeDi e continua a FASE 1.5 per verifica SSH live
            // (i dati NeDi potrebbero essere vecchi!)
            console.log(\`[MAC-HYBRID] Found in NeDi DB: \${result.endpoint?.device} \${result.endpoint?.ifName}, verifying with live SSH...\`);
            if (result.endpoint && !result.vlanResult) {
              result.vlanResult = {
                device: result.endpoint.device,
                deviceIp: result.endpoint.deviceIp,
                vlanInterface: result.endpoint.ifName,
                vlan: result.endpoint.vlan
              };
            }
            // Salva come fallback se SSH fallisce
            if (!result.dbFallback) {
              result.dbFallback = {
                device: result.endpoint.device,
                deviceIp: result.endpoint.deviceIp,
                ifName: result.endpoint.ifName,
                vlan: result.endpoint.vlan,
                source: 'nedi-db-unverified'
              };
            }`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Fix applicato: FASE 1 NeDi non restituisce più subito, continua a FASE 1.5');
} else {
  console.log('⚠ Pattern non trovato');
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('nedi-db-unverified')) {
  console.log('✓ Verifica: Nuovo codice presente');
} else {
  console.log('✗ Verifica fallita');
}
