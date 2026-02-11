import SSHAgent from './sshAgent.js';

const agent = new SSHAgent();

async function exploreDirs() {
  try {
    console.log('[INFO] Connessione al server NeDi...\n');

    // Comandi di esplorazione
    const commands = [
      // 1. Struttura /var/nedi
      'echo "=== STRUTTURA /var/nedi ===" && ls -la /var/nedi/',
      
      // 2. Directory sysobj
      'echo "\n=== DIRECTORY /var/nedi/sysobj ===" && ls -la /var/nedi/sysobj/ 2>/dev/null || echo "Directory non trovata"',
      
      // 3. Directory def
      'echo "\n=== DIRECTORY /var/nedi/def ===" && ls -la /var/nedi/def/ 2>/dev/null || echo "Directory non trovata"',
      
      // 4. Directory log
      'echo "\n=== DIRECTORY /var/nedi/log ===" && ls -la /var/nedi/log/ 2>/dev/null || echo "Directory non trovata"',
      
      // 5. File di configurazione
      'echo "\n=== FILE CONFIGURAZIONE ===" && ls -la /var/nedi/*.conf 2>/dev/null || echo "Nessun file .conf trovato"',
      
      // 6. File nedi.conf
      'echo "\n=== CONTENUTO nedi.conf ===" && cat /var/nedi/nedi.conf 2>/dev/null || echo "File non trovato"',
      
      // 7. Struttura completa /var/nedi
      'echo "\n=== TREE /var/nedi (primi 50 livelli) ===" && find /var/nedi -type f -o -type d | head -100',
      
      // 8. Devices Other-Defed
      'echo "\n=== RICERCA Other-Defed ===" && find /var/nedi -name "*Other*" -o -name "*defed*" 2>/dev/null',
      
      // 9. File di definizione
      'echo "\n=== FILE DI DEFINIZIONE ===" && find /var/nedi -name "*.def" -o -name "*.defs" 2>/dev/null | head -20',
      
      // 10. LLDP logs
      'echo "\n=== LOG LLDP/DISCOVERY ===" && find /var/nedi/log -name "*lldp*" -o -name "*discover*" 2>/dev/null',
      
      // 11. Dimensioni directory
      'echo "\n=== DIMENSIONI ===" && du -sh /var/nedi/* 2>/dev/null'
    ];

    const results = await agent.executeCommandsOnServer('ndei', commands, {
      timeout: 15000,
      stopOnError: false
    });

    // Stampa risultati
    for (const result of results) {
      console.log(result.stdout);
      if (result.stderr && !result.stderr.includes('cannot access')) {
        console.error('[STDERR]', result.stderr);
      }
    }

  } catch (err) {
    console.error('[ERRORE]', err.message);
    process.exit(1);
  }
}

exploreDirs();
