#!/usr/bin/env node
import fs from 'fs';

const file = './server.js';
let content = fs.readFileSync(file, 'utf8');

// Il codice FASE 1.5 da inserire
const fase15Code = `
    // =========================================================================
    // FASE 1.5: Direct SSH to VLAN Device (~1-3s) - OTTIMIZZAZIONE
    // =========================================================================
    // Se NeDi trovò MAC su VLAN interface, SSH diretto al device per porta fisica
    // Molto più veloce del full trace dal core!

    const haveVlanOnly = result.vlanResult && result.vlanResult.deviceIp;

    if (!skipSsh && haveVlanOnly && network) {
      const t15 = Date.now();
      const vlanDevice = result.vlanResult.device;
      const vlanDeviceIp = result.vlanResult.deviceIp;
      const vlanInterfaceName = result.vlanResult.vlanInterface;

      console.log(\`[MAC-HYBRID-FASE1.5] Direct SSH to VLAN device: \${vlanDevice} (\${vlanDeviceIp})\`);

      try {
        // Setup credenziali SSH
        const credsMap = loadCsvCredentials();
        const parts = network.split('/')[0].split('.');
        const siteKey = String(parts[1]);
        const siteCredsArray = credsMap.byNetwork.get(network) || credsMap.bySite.get(siteKey) || [];
        const siteCreds = siteCredsArray[0] || null;
        const sshCredsAlt = siteCredsArray.slice(1);
        const coreFallback = credsMap.coreFallback || null;

        // Seleziona credenziali
        let sshCreds = /\\.251$/.test(vlanDeviceIp) ? coreFallback : siteCreds;
        if (!sshCreds) sshCreds = coreFallback;

        if (sshCreds) {
          // Query MAC table sul device VLAN
          const hyphenMac = formatMacHyphen(mac);
          const fdbResult = await findMacInFdbSSH(vlanDeviceIp, hyphenMac, sshCreds, coreFallback, sshCredsAlt);

          if (fdbResult && fdbResult.ifName) {
            const physicalIfName = fdbResult.ifName;

            // Verifica che sia porta fisica (non Vlan/Vlif)
            const isPhysical = /^(GE|XGE|10GE|Eth|Ethernet|Gi|Fa|Te|fo|ge|xe)/i.test(physicalIfName);
            const isVlan = /^(Vl|VLAN|Vlanif|Vlif)/i.test(physicalIfName);

            if (isPhysical && !isVlan) {
              console.log(\`[MAC-HYBRID-FASE1.5] Found physical port: \${physicalIfName}\`);

              // Query LLDP neighbor sulla porta fisica
              let lldpInfo = { isEndpoint: true, name: null, deviceType: 'unknown' };
              try {
                const lldpCmd = \`display lldp neighbor interface \${physicalIfName}\`;
                const lldpOutput = await runSwitchCommand(vlanDeviceIp, sshCreds, coreFallback, lldpCmd, sshCredsAlt);
                if (lldpOutput) {
                  lldpInfo = parseLldpFullInfo(lldpOutput) || lldpInfo;
                }
              } catch (lldpErr) {
                console.log(\`[MAC-HYBRID-FASE1.5] LLDP query failed: \${lldpErr.message}\`);
              }

              // Prepara risultato
              result.endpoint = {
                device: vlanDevice,
                deviceIp: vlanDeviceIp,
                ifName: physicalIfName,
                vlan: fdbResult.vlan || result.vlanResult.vlan,
                vlanInterface: vlanInterfaceName,
                lldpNeighbor: lldpInfo.name || null,
                lldpDeviceType: lldpInfo.deviceType || 'unknown',
                source: 'ssh-direct-vlan'
              };

              result.source = 'ssh-direct-vlan';
              result.found = true;
              result.sshResult = {
                method: 'direct-device-query',
                deviceIp: vlanDeviceIp,
                physicalPort: physicalIfName,
                lldpNeighbor: lldpInfo.name,
                elapsed: \`\${Date.now() - t15}ms\`
              };

              result.elapsed = \`\${Date.now() - t0}ms\`;
              console.log(\`[MAC-HYBRID-FASE1.5] SUCCESS: \${vlanDevice} \${physicalIfName} -> LLDP: \${lldpInfo.name || 'none'} (\${Date.now() - t15}ms)\`);
              return res.json(result);
            } else {
              console.log(\`[MAC-HYBRID-FASE1.5] FDB returned \${physicalIfName} (not physical), trying FASE 2...\`);
            }
          } else {
            console.log(\`[MAC-HYBRID-FASE1.5] MAC not in FDB of \${vlanDevice}, trying FASE 2...\`);
          }
        } else {
          console.log(\`[MAC-HYBRID-FASE1.5] No SSH credentials for \${vlanDevice}, trying FASE 2...\`);
        }
      } catch (fase15Err) {
        console.error(\`[MAC-HYBRID-FASE1.5] Error: \${fase15Err.message}, trying FASE 2...\`);
      }
    }

`;

// Pattern per trovare dove inserire (dopo FASE 1, prima di FASE 2)
const insertMarker = `    // =========================================================================
    // FASE 2: Fallback SSH trace (lenta, ~30-60s)
    // =========================================================================`;

if (content.includes(insertMarker)) {
  // Inserisci FASE 1.5 prima di FASE 2
  content = content.replace(insertMarker, fase15Code + insertMarker);
  fs.writeFileSync(file, content);
  console.log('✓ FASE 1.5 inserita con successo');
} else {
  console.log('⚠ Marker FASE 2 non trovato');

  // Prova pattern alternativo
  const altMarker = '// FASE 2: Fallback SSH trace';
  if (content.includes(altMarker)) {
    const idx = content.indexOf(altMarker);
    // Trova inizio riga
    const lineStart = content.lastIndexOf('\n', idx);
    content = content.slice(0, lineStart) + '\n' + fase15Code + content.slice(lineStart);
    fs.writeFileSync(file, content);
    console.log('✓ FASE 1.5 inserita (pattern alternativo)');
  } else {
    console.log('✗ Impossibile trovare punto di inserimento');
    process.exit(1);
  }
}

// Verifica
const check = fs.readFileSync(file, 'utf8');
if (check.includes('FASE1.5') && check.includes('ssh-direct-vlan')) {
  console.log('✓ Verifica: FASE 1.5 presente nel codice');
} else {
  console.log('✗ Verifica fallita');
}
