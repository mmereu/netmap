import SSHAgent from './sshAgent.js';

const agent = new SSHAgent();

async function getConfig() {
  try {
    console.log('[INFO] Lettura configurazione NeDi...\n');

    const commands = [
      // 1. Intero file nedi.conf
      'cat /var/nedi/nedi.conf',
      
      // 2. Sezione LLDP dal file
      'echo "\n=== GREP LLDP ===" && grep -i "lldp" /var/nedi/nedi.conf',
      
      // 3. Contenuto di alcuni .def file di esempio
      'echo "\n=== ESEMPIO HP .def ===" && cat /var/nedi/sysobj/1.3.6.1.4.1.11.2.3.7.11.100.def',
      
      // 4. Ricerca "Other-Defed"
      'echo "\n=== RICERCA OTHER ===" && find /var/nedi -iname "*other*" -type f 2>/dev/null',
      
      // 5. Contenuto conf directory
      'echo "\n=== CONTENUTO /var/nedi/conf ===" && ls -la /var/nedi/conf | head -50'
    ];

    const results = await agent.executeCommandsOnServer('ndei', commands, {
      timeout: 20000,
      stopOnError: false
    });

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

getConfig();
