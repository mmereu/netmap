#!/usr/bin/env node
import fs from 'fs';

const file = './server.js';
let content = fs.readFileSync(file, 'utf8');

const oldCode = `        if (localResults.length > 0) {
          const best = localResults[0];
          result.source = 'local-db';
          result.found = true;
          result.endpoint = {
            device: best.device,
            deviceIp: best.device_ip,
            ifName: best.interface,
            vlan: best.vlan,
            source: 'local-nodes'
          };
          result.dbResult = {
            local: { count: localResults.length, data: localResults }
          };
          result.elapsed = \`\${Date.now() - t0}ms\`;
          console.log(\`[MAC-HYBRID] Found in LOCAL DB: \${result.endpoint?.device} \${result.endpoint?.ifName} (\${localElapsed}ms)\`);
          return res.json(result);
        }
      } catch (localErr) {`;

const newCode = `        if (localResults.length > 0) {
          const best = localResults[0];
          const bestIsPhysical = isPhysicalPort(best.interface);

          // Salva i risultati DB
          result.dbResult = {
            local: { count: localResults.length, data: localResults }
          };

          // Se la migliore porta è FISICA, restituisci subito
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
          };
        }
      } catch (localErr) {`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ FASE 0 modificata con successo');
} else {
  console.log('⚠ FASE 0 non trovata o già modificata');
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('bestIsPhysical')) {
  console.log('✓ Modifica applicata correttamente');
} else {
  console.log('✗ Modifica NON applicata');
}
