import SSHAgent from './sshAgent.js';

const agent = new SSHAgent();

async function finalAnalysis() {
  try {
    console.log('[INFO] Analisi finale - Esame file .def e sezione Dispro...\n');

    const commands = [
      // 1. Ricerca "Dispro" in tutti i .def
      'echo "=== DISPRO PROTOCOL USAGE ===" && grep "^Dispro" /var/nedi/sysobj/*.def | sort | uniq -c | sort -rn',
      
      // 2. File con LLDP configurato
      'echo "\n=== DISPOSITIVI CON LLDP ===" && grep -l "^Dispro.*LLDP" /var/nedi/sysobj/*.def | wc -l && echo "file .def con LLDP"',
      
      // 3. File con CDP
      'echo "\n=== DISPOSITIVI CON CDP ===" && grep -l "^Dispro.*CDP" /var/nedi/sysobj/*.def | wc -l && echo "file .def con CDP"',
      
      // 4. File senza Dispro definito
      'echo "\n=== DISPOSITIVI SENZA DISPRO ===" && grep -L "^Dispro" /var/nedi/sysobj/*.def | wc -l && echo "file .def senza Dispro"',
      
      // 5. Esamina alcuni file importanti (non trovati Huawei 2011, check if any D-Link)
      'echo "\n=== RICERCA VENDOR SPECIFICI ===" && ls /var/nedi/sysobj/1.3.6.1.4.1.* | sed "s/.*1.3.6.1.4.1.//" | sed "s/.def$//" | sort | uniq -c | sort -rn | head -15',
      
      // 6. Stato della directory sysobj
      'echo "\n=== STATO SYSOBJ ===" && ls -lhS /var/nedi/sysobj | head -20',
      
      // 7. Database content - devices table
      'echo "\n=== DEVICES DISCOVERY STATS ===" && mysql -u nedi -p$NEDI_MYSQL_PASS nedi -N -e "SELECT COUNT(*) as total, COUNT(DISTINCT devstatus) as statuses FROM devices;"',
      
      // 8. Links discovery stats
      'echo "\n=== LINKS DISCOVERY STATS ===" && mysql -u nedi -p$NEDI_MYSQL_PASS nedi -N -e "SELECT protocol, COUNT(*) as count FROM links GROUP BY protocol ORDER BY count DESC LIMIT 10;"'
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

finalAnalysis();
