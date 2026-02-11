import fs from 'fs';

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

const oldCode = `          } else {
            // Porta access - check LLDP
            const lldpOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, \`display lldp neighbor interface \${ifName}\`, sshCredsAlt);
            const lldpInfo = parseLldpFullInfo(lldpOut);

            if (lldpInfo && isLldpManagedSwitch(lldpInfo)) {`;

const newCode = `          } else {
            // Porta access - check LLDP con varianti nome interfaccia
            let lldpOut = '';
            let lldpInfo = null;
            const variants = interfaceCommandVariants(ifName);
            for (const v of variants) {
              lldpOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, \`display lldp neighbor interface \${v}\`, sshCredsAlt);
              if (lldpOut && lldpOut.length > 100) {
                lldpInfo = parseLldpFullInfo(lldpOut);
                if (lldpInfo && (lldpInfo.name || lldpInfo.ip)) break;
              }
            }

            if (lldpInfo && isLldpManagedSwitch(lldpInfo)) {`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(file, content);
  console.log('✓ Fix LLDP variants applicato');
} else {
  console.log('⚠ Pattern non trovato');
}
