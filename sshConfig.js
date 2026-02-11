/**
 * Configurazione server SSH predefiniti
 * Le credenziali vengono lette dalle variabili d'ambiente.
 * Copia .env.example in .env e configura i valori.
 */
export const sshServers = {
  twiky: {
    name: 'twiky',
    host: process.env.TWIKY_SSH_HOST || '127.0.0.1',
    port: parseInt(process.env.TWIKY_SSH_PORT || '22', 10),
    username: process.env.TWIKY_SSH_USER || 'user',
    password: process.env.TWIKY_SSH_PASS || '',
  },
  ndei: {
    name: 'ndei',
    host: process.env.NEDI_SSH_HOST || '127.0.0.1',
    port: parseInt(process.env.NEDI_SSH_PORT || '22', 10),
    username: process.env.NEDI_SSH_USER || 'root',
    password: process.env.NEDI_SSH_PASS || '',
  },
};

/**
 * Ottieni la configurazione di un server per nome
 * @param {string} serverName - Nome del server (twiky o ndei)
 * @returns {Object|null} Configurazione del server o null se non trovato
 */
export function getServerConfig(serverName) {
  return sshServers[serverName] || null;
}

/**
 * Ottieni tutte le configurazioni dei server
 * @returns {Object} Oggetto con tutte le configurazioni
 */
export function getAllServers() {
  return sshServers;
}
