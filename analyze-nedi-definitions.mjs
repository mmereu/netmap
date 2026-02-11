import SSHAgent from './sshAgent.js';

const agent = new SSHAgent();

async function analyze() {
  try {
    console.log('[INFO] Analisi dettagliata delle definizioni NeDi...\n');

    const commands = [
      // 1. File other.def (default per dispositivi non riconosciuti)
      'echo "=== FILE other.def ===" && cat /var/nedi/sysobj/other.def',
      
      // 2. Statistiche .def files
      'echo "\n=== STATISTICHE .def FILES ===" && find /var/nedi/sysobj -name "*.def" | wc -l && echo "file .def totali"',
      
      // 3. Dimensioni file .def
      'echo "\n=== TOP 20 FILE .def PIU GRANDI ===" && find /var/nedi/sysobj -name "*.def" -exec ls -lh {} \; | sort -k5 -hr | head -20',
      
      // 4. File legati a Huawei (ricerca per OID Huawei 1.3.6.1.4.1.2011)
      'echo "\n=== FILE HUAWEI ===" && find /var/nedi/sysobj -name "*2011*" -exec ls -la {} \;',
      
      // 5. Definizioni Cisco/HP/D-Link
      'echo "\n=== FILE PRINCIPALI VENDOR ===" && ls -la /var/nedi/sysobj/*9.def /var/nedi/sysobj/*11.* /var/nedi/sysobj/*3526.def 2>/dev/null | head -20',
      
      // 6. Search for "LLDP" in .def files
      'echo "\n=== LLDP IN .def FILES ===" && grep -l "LLDP" /var/nedi/sysobj/*.def 2>/dev/null | head -10',
      
      // 7. Contenuto di alcuni file HP/ProCurve
      'echo "\n=== HP ProCurve 5412 ===" && cat /var/nedi/sysobj/1.3.6.1.4.1.11.2.3.7.11.18.def 2>/dev/null || echo "Not found"',
      
      // 8. Log di discovery
      'echo "\n=== LOG DISCOVERY (ultimi) ===" && ls -lat /var/nedi/log/*.log 2>/dev/null | head -10 || echo "No logs"',
      
      // 9. Content of Defgen (generatore di definizioni)
      'echo "\n=== DEFGEN DETAILS ===" && ls -la /var/nedi/html/*efgen* /var/nedi/html/*efed* 2>/dev/null'
    ];

    const results = await agent.executeCommandsOnServer('ndei', commands, {
      timeout: 25000,
      stopOnError: false
    });

    for (const result of results) {
      console.log(result.stdout);
      if (result.stderr && !result.stderr.includes('cannot access') && !result.stderr.includes('No such')) {
        console.error('[STDERR]', result.stderr);
      }
    }

  } catch (err) {
    console.error('[ERRORE]', err.message);
    process.exit(1);
  }
}

analyze();
