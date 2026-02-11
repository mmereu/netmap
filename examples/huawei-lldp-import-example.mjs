#!/usr/bin/env node
/**
 * Esempio di import LLDP da switch Huawei
 *
 * Scenario:
 * 1. Connessione SSH a switch Huawei
 * 2. Esecuzione comando "display lldp neighbor"
 * 3. Parsing output con huaweiLldpParser
 * 4. Import link in database NetMap
 *
 * NOTA: Questo è un esempio di codice. Per un utilizzo reale serve:
 * - Modulo SSH (es: node-ssh, ssh2)
 * - Credenziali switch configurate
 * - Database NetMap attivo
 */

import { parseHuaweiLldpNeighbors, convertToNeDiLinks } from '../lib/huaweiLldpParser.js';

// ============================================================================
// SIMULAZIONE OUTPUT SSH (in produzione sostituire con vera connessione SSH)
// ============================================================================

/**
 * Simula output comando SSH "display lldp neighbor"
 * @param {string} deviceIp - IP dello switch
 * @returns {Promise<string>} - Output comando
 */
async function executeSSHCommand(deviceIp, command) {
    console.log(`📡 [SSH] Connessione a ${deviceIp}...`);
    console.log(`📡 [SSH] Esecuzione: ${command}`);

    // Simulazione: output reale da switch Huawei
    const mockOutput = `
Local Interface   HoldTime   Neighbor Port            Neighbor Device

10GE1/0/1                     101  XGigabitEthernet1/0/25        21_L3-CORE_251
10GE1/0/2                     120  10GE1/0/48                    CORE-SW-01
GE1/0/1                        95  GE0/0/1                       PDV021-DIST-01
GE1/0/5                        67  mgt0                          PDV021-GR-AP035
GE1/0/6                        72  mgt0                          PDV021-GR-AP036
GE1/0/17                       85  mgt0                          PDV021-GR-AP039
GE1/0/20                     2874  50eb-f675-275a
GE1/0/28                      105  e430-22ba-e408                HTW_e43022bae408
Eth-Trunk1                     90  Eth-Trunk2                    DISTRIB-SW-23
Eth-Trunk2                     95  Eth-Trunk1                    DISTRIB-SW-24
`;

    // Simula delay rete
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log(`✅ [SSH] Comando completato\n`);
    return mockOutput;
}

/**
 * Import LLDP da singolo switch Huawei
 * @param {string} deviceIp - IP dello switch
 * @param {string} deviceName - Nome dello switch
 */
async function importLldpFromHuawei(deviceIp, deviceName) {
    console.log('═'.repeat(70));
    console.log(`  Import LLDP da ${deviceName} (${deviceIp})`);
    console.log('═'.repeat(70) + '\n');

    try {
        // STEP 1: Esegui comando SSH
        const output = await executeSSHCommand(deviceIp, 'display lldp neighbor');

        // STEP 2: Parsing output
        console.log('📋 Parsing output LLDP...');
        const neighbors = parseHuaweiLldpNeighbors(output);
        console.log(`   Trovati ${neighbors.length} neighbors\n`);

        if (neighbors.length === 0) {
            console.log('⚠️  Nessun neighbor LLDP trovato\n');
            return { success: true, links: 0 };
        }

        // STEP 3: Mostra neighbors trovati
        console.log('🔗 Neighbors LLDP:\n');
        neighbors.forEach((n, idx) => {
            console.log(`   [${idx + 1}] ${n.localPort.padEnd(15)} → ${n.remoteSysname}`);
            console.log(`       Remote Port: ${n.remotePort}`);
            if (n.remoteChassisId) {
                console.log(`       Chassis ID: ${n.remoteChassisId}`);
            }
            console.log('');
        });

        // STEP 4: Conversione a formato NeDi
        console.log('🔄 Conversione a formato NeDi...');
        const links = convertToNeDiLinks(neighbors, deviceName);
        console.log(`   ${links.length} link pronti per import\n`);

        // STEP 5: Import in database (simulato)
        console.log('💾 Import in database...\n');
        for (const link of links) {
            // In produzione: await db.insertLink(link);
            console.log(`   ✅ Link: ${link.device}:${link.ifname} ↔ ${link.neighbor}:${link.nbrifname}`);
        }

        console.log(`\n✅ Import completato: ${links.length} link importati\n`);

        return {
            success: true,
            links: links.length,
            details: links
        };

    } catch (error) {
        console.error(`❌ Errore durante import da ${deviceName}:`, error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Import LLDP da lista di switch Huawei
 */
async function importLldpFromMultipleSwitches() {
    console.log('\n' + '═'.repeat(70));
    console.log('  Batch Import LLDP da Switch Huawei');
    console.log('═'.repeat(70) + '\n');

    // Lista switch da processare
    const switches = [
        { ip: '192.168.100.1', name: 'SW-HUAWEI-PDV021' },
        { ip: '192.168.100.2', name: 'SW-HUAWEI-PDV022' },
        { ip: '192.168.100.3', name: 'SW-HUAWEI-CORE-01' }
    ];

    const results = {
        total: switches.length,
        success: 0,
        failed: 0,
        totalLinks: 0
    };

    for (const sw of switches) {
        const result = await importLldpFromHuawei(sw.ip, sw.name);

        if (result.success) {
            results.success++;
            results.totalLinks += result.links;
        } else {
            results.failed++;
        }

        // Delay tra switch per evitare sovraccarico
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Riepilogo finale
    console.log('\n' + '═'.repeat(70));
    console.log('  Riepilogo Import');
    console.log('═'.repeat(70) + '\n');
    console.log(`Switch processati:  ${results.total}`);
    console.log(`✅ Successi:        ${results.success}`);
    console.log(`❌ Falliti:         ${results.failed}`);
    console.log(`🔗 Link importati:  ${results.totalLinks}`);
    console.log('\n' + '═'.repeat(70) + '\n');
}

/**
 * Esempio di integrazione con vera libreria SSH
 */
function exampleRealSSHIntegration() {
    console.log('\n' + '═'.repeat(70));
    console.log('  Esempio Integrazione SSH Reale');
    console.log('═'.repeat(70) + '\n');

    console.log(`
Per usare una vera connessione SSH, sostituire executeSSHCommand con:

\`\`\`javascript
import { NodeSSH } from 'node-ssh';
import { parseHuaweiLldpNeighbors, convertToNeDiLinks } from '../lib/huaweiLldpParser.js';

async function getLldpFromHuawei(deviceIp, username, password) {
    const ssh = new NodeSSH();

    try {
        // Connessione
        await ssh.connect({
            host: deviceIp,
            username: username,
            password: password,
            port: 22,
            readyTimeout: 10000
        });

        // Esegui comando
        const result = await ssh.execCommand('display lldp neighbor');

        // Parsing
        const neighbors = parseHuaweiLldpNeighbors(result.stdout);

        // Chiudi connessione
        ssh.dispose();

        return neighbors;

    } catch (error) {
        ssh.dispose();
        throw error;
    }
}
\`\`\`

Installazione dipendenze:
\`\`\`bash
npm install node-ssh
\`\`\`

Configurazione credenziali (usa variabili ambiente o vault):
\`\`\`javascript
const config = {
    username: process.env.HUAWEI_SSH_USER,
    password: process.env.HUAWEI_SSH_PASS,
    // Meglio ancora: usa chiavi SSH invece di password
};
\`\`\`
`);
}

// ============================================================================
// ESECUZIONE ESEMPIO
// ============================================================================

async function main() {
    // Esempio 1: Import da singolo switch
    await importLldpFromHuawei('192.168.100.1', 'SW-HUAWEI-PDV021');

    // Esempio 2: Import batch da più switch
    // await importLldpFromMultipleSwitches();

    // Esempio 3: Mostra integrazione SSH reale
    exampleRealSSHIntegration();
}

// Esegui se lanciato come script
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { importLldpFromHuawei, importLldpFromMultipleSwitches };
