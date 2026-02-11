#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix 1: Quando ifName è null, prova a cercare il prossimo hop tramite LLDP brief
const oldCode1 = `          if (!ifName) {
            endpoint = hop;
            break;
          }`;

const newCode1 = `          if (!ifName) {
            // MAC non trovato nel FDB - prova a trovare next hop via LLDP brief
            if (hops < 6) {
              console.log(\`[MAC-HYBRID] MAC not in FDB at hop \${hops}, trying LLDP brief to find next switch...\`);
              try {
                const lldpBrief = await runSwitchCommand(currentIp, sshCreds, coreFallback, 'display lldp neighbor brief', sshCredsAlt);
                const sitePrefix = \`\${parts[0]}.\${parts[1]}.\${parts[2]}.\`;
                // Cerca un neighbor nella stessa subnet che non abbiamo già visitato
                const lines = String(lldpBrief || '').split('\\n');
                for (const line of lines) {
                  const ipMatch = line.match(/(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})/);
                  if (ipMatch && ipMatch[1].startsWith(sitePrefix)) {
                    const candidateIp = ipMatch[1];
                    if (!path.some(p => p.ip === candidateIp) && candidateIp !== currentIp) {
                      console.log(\`[MAC-HYBRID] Found potential next hop via LLDP brief: \${candidateIp}\`);
                      hop.nextHop = candidateIp;
                      currentIp = candidateIp;
                      continue;
                    }
                  }
                }
              } catch (e) {
                console.log(\`[MAC-HYBRID] LLDP brief failed: \${e.message}\`);
              }
            }
            endpoint = hop;
            break;
          }`;

// Fix 2: Quando LLDP non trova managed switch, prova alternative
const oldCode2 = `            } else {
              endpoint = hop;
              break;
            }
          }

          if (!nextHop) {
            endpoint = hop;
            break;
          }`;

const newCode2 = `            } else {
              // LLDP non ha trovato switch gestito - prova LLDP brief se sotto minimo hop
              if (hops < 6) {
                console.log(\`[MAC-HYBRID] No managed switch via LLDP at hop \${hops}, trying LLDP brief...\`);
                try {
                  const lldpBrief = await runSwitchCommand(currentIp, sshCreds, coreFallback, 'display lldp neighbor brief', sshCredsAlt);
                  const sitePrefix = \`\${parts[0]}.\${parts[1]}.\${parts[2]}.\`;
                  const lines = String(lldpBrief || '').split('\\n');
                  for (const line of lines) {
                    // Cerca IP management nella stessa subnet
                    const ipMatch = line.match(/(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})/);
                    if (ipMatch && ipMatch[1].startsWith(sitePrefix)) {
                      const candidateIp = ipMatch[1];
                      if (!path.some(p => p.ip === candidateIp) && candidateIp !== currentIp) {
                        nextHop = candidateIp;
                        console.log(\`[MAC-HYBRID] Found next hop via LLDP brief: \${candidateIp}\`);
                        break;
                      }
                    }
                  }
                } catch (e) {
                  console.log(\`[MAC-HYBRID] LLDP brief fallback failed: \${e.message}\`);
                }
              }
              if (!nextHop) {
                endpoint = hop;
                break;
              }
            }
          }

          if (!nextHop) {
            endpoint = hop;
            break;
          }`;

let modified = false;

if (content.includes(oldCode1)) {
  content = content.replace(oldCode1, newCode1);
  console.log('✓ Fix 1: Aggiunto fallback LLDP brief quando MAC non in FDB');
  modified = true;
} else {
  console.log('⚠ Fix 1: Pattern non trovato (forse già applicato?)');
}

if (content.includes(oldCode2)) {
  content = content.replace(oldCode2, newCode2);
  console.log('✓ Fix 2: Aggiunto fallback LLDP brief quando LLDP non trova switch');
  modified = true;
} else {
  console.log('⚠ Fix 2: Pattern non trovato (forse già applicato?)');
}

if (modified) {
  fs.writeFileSync(file, content);
  console.log('✓ File salvato');
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('hops < 6')) {
  console.log('✓ Verifica: Minimo 6 hop presente nel codice');
} else {
  console.log('✗ Verifica fallita');
}
