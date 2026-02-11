#!/usr/bin/env node
import fs from 'fs';

const file = './server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix FASE 1B - Non restituire subito se è VLAN interface
const oldCode = `            result.elapsed = \`\${Date.now() - t0}ms\`;
            console.log(\`[MAC-HYBRID] Found in NeDi DB: \${result.endpoint?.device} \${result.endpoint?.ifName}\`);
            return res.json(result);
          }
        }
      } catch (dbErr) {
        console.error(\`[MAC-HYBRID] NeDi error:\`, dbErr.message);
        // Continua con SSH fallback
      }
    }

    // =========================================================================
    // FASE 2: Fallback SSH trace (lenta, ~30-60s)
    // =========================================================================
    if (!skipSsh && network) {`;

const newCode = `            // Verifica se l'endpoint è una porta fisica
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
            }
          }
        }
      } catch (dbErr) {
        console.error(\`[MAC-HYBRID] NeDi error:\`, dbErr.message);
        // Continua con SSH fallback
      }
    }

    // =========================================================================
    // FASE 2: Fallback SSH trace (lenta, ~30-60s)
    // =========================================================================
    // Esegui SSH trace se: (1) network specificata E (2) non abbiamo ancora una porta fisica
    const havePhysicalPort = result.endpoint && /^(GE|XGE|10GE|Eth|Ethernet|Gi|Fa|Te|fo|ge|xe)/i.test(result.endpoint.ifName) && !/^(Vl|VLAN|Vlanif|Vlif)/i.test(result.endpoint.ifName);
    if (!skipSsh && network && !havePhysicalPort) {`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ FASE 1B e FASE 2 modificate con successo');
} else {
  console.log('⚠ Pattern non trovato - potrebbe essere già modificato');
  console.log('Cercando pattern alternativo...');
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('endpointIsPhysical')) {
  console.log('✓ Modifica applicata correttamente');
} else {
  console.log('✗ Modifica NON applicata - verificare manualmente');
}
