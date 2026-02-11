import SSHAgent from './sshAgent.js';
import { getAllServers } from './sshConfig.js';

const sshAgent = new SSHAgent();

async function testAllServers() {
  console.log('=== Test connessioni SSH ai server configurati ===\n');
  
  const servers = getAllServers();
  
  for (const [name, config] of Object.entries(servers)) {
    console.log(`\n📡 Test connessione a ${name} (${config.host})...`);
    
    try {
      // Test connessione
      const connected = await sshAgent.testServerConnection(name);
      console.log(`   ✓ Connessione: ${connected ? 'OK' : 'FALLITA'}`);
      
      if (connected) {
        // Test comando semplice
        console.log(`   🔍 Esecuzione comando 'hostname'...`);
        const result = await sshAgent.executeOnServer(name, 'hostname', { timeout: 5000 });
        console.log(`   ✓ Hostname: ${result.stdout.trim()}`);
        console.log(`   ✓ Exit code: ${result.code}`);
        
        // Test informazioni sistema
        console.log(`   📊 Recupero informazioni sistema...`);
        const sysInfo = await sshAgent.getServerSystemInfo(name);
        console.log(`   ✓ Hostname: ${sysInfo.hostname}`);
        console.log(`   ✓ Uptime: ${sysInfo.uptime}`);
        console.log(`   ✓ OS: ${sysInfo.uname}`);
      }
    } catch (err) {
      console.error(`   ✗ Errore: ${err.message}`);
    }
  }
  
  console.log('\n=== Test completato ===\n');
}

// Esegui test
testAllServers().catch((err) => {
  console.error('Errore durante i test:', err);
  process.exit(1);
});









