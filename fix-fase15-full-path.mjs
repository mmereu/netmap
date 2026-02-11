#!/usr/bin/env node
import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Fix: Dopo aver trovato la porta, fai anche il trace dal core per mostrare il path completo
const oldCode = `              result.sshResult = {
                method: 'direct-device-query',
                deviceIp: vlanDeviceIp,
                physicalPort: physicalIfName,
                lldpNeighbor: lldpInfo.name,
                elapsed: \`\${Date.now() - t15}ms\`
              };

              result.elapsed = \`\${Date.now() - t0}ms\`;
              console.log(\`[MAC-HYBRID-FASE1.5] SUCCESS: \${vlanDevice} \${physicalIfName} -> LLDP: \${lldpInfo.name || 'none'} (\${Date.now() - t15}ms)\`);
              return res.json(result);`;

const newCode = `              // Ora fai il trace dal core per mostrare il path completo
              console.log(\`[MAC-HYBRID-FASE1.5] Building full path from core to \${vlanDevice}...\`);
              const path = [];
              const coreIp = \`\${parts[0]}.\${parts[1]}.\${parts[2]}.251\`;
              let currentIp = coreIp;
              let pathHops = 0;
              const maxPathHops = 10;
              const targetIp = vlanDeviceIp;

              try {
                while (pathHops < maxPathHops && currentIp !== targetIp) {
                  let pathCreds = /\\.251$/.test(currentIp) ? coreFallback : siteCreds;
                  if (!pathCreds) pathCreds = coreFallback;

                  const pathSysName = await getSysNameSSH(currentIp, pathCreds, coreFallback, sshCredsAlt);
                  const pathFdb = await findMacInFdbSSH(currentIp, hyphenMac, pathCreds, coreFallback, sshCredsAlt);
                  const pathIfName = pathFdb?.ifName || null;

                  const hop = {
                    ip: currentIp,
                    sysName: pathSysName,
                    ifName: pathIfName,
                    vlan: pathFdb?.vlan || null
                  };
                  path.push(hop);
                  pathHops++;

                  if (!pathIfName) break;

                  // Trova next hop via LLDP
                  let nextHop = null;
                  const variants = interfaceCommandVariants(pathIfName);
                  for (const v of variants) {
                    const lldpOut = await runSwitchCommand(currentIp, pathCreds, coreFallback, \`display lldp neighbor interface \${v}\`, sshCredsAlt);
                    if (lldpOut && lldpOut.length > 100) {
                      const neighborIp = parseLldpNeighborIp(lldpOut);
                      if (neighborIp) {
                        nextHop = neighborIp;
                        hop.nextHop = neighborIp;
                        break;
                      }
                    }
                  }

                  if (!nextHop) break;
                  currentIp = nextHop;
                }

                // Aggiungi il device finale con la porta corretta
                if (currentIp === targetIp || path.length === 0 || path[path.length - 1]?.ip !== targetIp) {
                  path.push({
                    ip: targetIp,
                    sysName: vlanDevice,
                    ifName: physicalIfName,
                    vlan: fdbResult.vlan || result.vlanResult.vlan
                  });
                }
              } catch (pathErr) {
                console.log(\`[MAC-HYBRID-FASE1.5] Path trace error: \${pathErr.message}\`);
                // Fallback: aggiungi solo il device finale
                if (path.length === 0) {
                  path.push({
                    ip: targetIp,
                    sysName: vlanDevice,
                    ifName: physicalIfName,
                    vlan: fdbResult.vlan || result.vlanResult.vlan
                  });
                }
              }

              result.sshResult = {
                method: 'direct-device-query-with-path',
                deviceIp: vlanDeviceIp,
                physicalPort: physicalIfName,
                lldpNeighbor: lldpInfo.name,
                path: path,
                hops: path.length,
                elapsed: \`\${Date.now() - t15}ms\`
              };

              result.elapsed = \`\${Date.now() - t0}ms\`;
              console.log(\`[MAC-HYBRID-FASE1.5] SUCCESS: \${vlanDevice} \${physicalIfName} -> LLDP: \${lldpInfo.name || 'none'}, path: \${path.length} hops (\${Date.now() - t15}ms)\`);
              return res.json(result);`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Fix applicato: FASE 1.5 ora include il trace completo dal core');
} else {
  console.log('⚠ Pattern non trovato');
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('Building full path from core')) {
  console.log('✓ Verifica: Nuovo codice presente');
} else {
  console.log('✗ Verifica fallita');
}
