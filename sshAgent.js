import { Client } from 'ssh2';
import { getServerConfig } from './sshConfig.js';

/**
 * Agente SSH per connessioni e comandi remoti
 */
class SSHAgent {
  constructor(config = {}) {
    this.defaultConfig = {
      readyTimeout: 20000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      ...config,
    };
  }

  /**
   * Connetti a un host via SSH
   * @param {Object} options - Opzioni di connessione
   * @param {string} options.host - Indirizzo IP o hostname
   * @param {number} options.port - Porta SSH (default: 22)
   * @param {string} options.username - Username
   * @param {string} options.password - Password (opzionale se si usa key)
   * @param {string} options.privateKey - Chiave privata SSH (opzionale)
   * @param {string} options.passphrase - Passphrase per la chiave (opzionale)
   * @returns {Promise<Client>} Client SSH connesso
   */
  async connect(options) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const config = {
        host: options.host,
        port: options.port || 22,
        username: options.username,
        ...this.defaultConfig,
      };

      if (options.password) {
        config.password = options.password;
      }

      if (options.privateKey) {
        config.privateKey = options.privateKey;
        if (options.passphrase) {
          config.passphrase = options.passphrase;
        }
      }

      conn.on('ready', () => {
        resolve(conn);
      });

      conn.on('error', (err) => {
        reject(err);
      });

      conn.connect(config);
    });
  }

  /**
   * Esegui un comando remoto via SSH
   * @param {Object} connectionOptions - Opzioni di connessione (host, port, username, password/key)
   * @param {string} command - Comando da eseguire
   * @param {Object} execOptions - Opzioni per l'esecuzione (timeout, etc.)
   * @returns {Promise<Object>} Risultato con stdout, stderr, code
   */
  async executeCommand(connectionOptions, command, execOptions = {}) {
    let conn = null;
    try {
      conn = await this.connect(connectionOptions);
      return await this._execOnConnection(conn, command, execOptions);
    } finally {
      if (conn) {
        conn.end();
      }
    }
  }

  /**
   * Esegui un comando su una connessione già stabilita
   * @private
   */
  async _execOnConnection(conn, command, execOptions = {}) {
    return new Promise((resolve, reject) => {
      const timeout = execOptions.timeout || 30000;
      let timeoutId = null;

      conn.exec(command, (err, stream) => {
        if (err) {
          if (timeoutId) clearTimeout(timeoutId);
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          if (timeoutId) clearTimeout(timeoutId);
          resolve({
            stdout,
            stderr,
            code,
            signal,
            success: code === 0,
          });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        if (timeout > 0) {
          timeoutId = setTimeout(() => {
            stream.destroy();
            reject(new Error(`Comando timeout dopo ${timeout}ms`));
          }, timeout);
        }
      });
    });
  }

  /**
   * Esegui più comandi in sequenza sulla stessa connessione
   * @param {Object} connectionOptions - Opzioni di connessione
   * @param {string[]} commands - Array di comandi da eseguire
   * @param {Object} execOptions - Opzioni per l'esecuzione
   * @returns {Promise<Array>} Array di risultati
   */
  async executeCommands(connectionOptions, commands, execOptions = {}) {
    let conn = null;
    const results = [];
    try {
      conn = await this.connect(connectionOptions);
      for (const cmd of commands) {
        const result = await this._execOnConnection(conn, cmd, execOptions);
        results.push({ command: cmd, ...result });
        // Se un comando fallisce, interrompi la sequenza (opzionale)
        if (execOptions.stopOnError && !result.success) {
          break;
        }
      }
      return results;
    } finally {
      if (conn) {
        conn.end();
      }
    }
  }

  /**
   * Testa la connettività SSH senza eseguire comandi
   * @param {Object} connectionOptions - Opzioni di connessione
   * @returns {Promise<boolean>} true se la connessione riesce
   */
  async testConnection(connectionOptions) {
    try {
      const conn = await this.connect(connectionOptions);
      conn.end();
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Ottieni informazioni sul sistema remoto
   * @param {Object} connectionOptions - Opzioni di connessione
   * @returns {Promise<Object>} Informazioni sul sistema
   */
  async getSystemInfo(connectionOptions) {
    const commands = [
      'uname -a',
      'hostname',
      'uptime',
      'cat /etc/os-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || echo "OS info not available"',
    ];

    const results = await this.executeCommands(connectionOptions, commands, {
      timeout: 10000,
      stopOnError: false,
    });

    return {
      uname: results[0]?.stdout?.trim() || '',
      hostname: results[1]?.stdout?.trim() || '',
      uptime: results[2]?.stdout?.trim() || '',
      osInfo: results[3]?.stdout?.trim() || '',
    };
  }

  /**
   * Connetti a un server predefinito per nome
   * @param {string} serverName - Nome del server (twiky o ndei)
   * @returns {Promise<Client>} Client SSH connesso
   */
  async connectToServer(serverName) {
    const config = getServerConfig(serverName);
    if (!config) {
      throw new Error(`Server "${serverName}" non trovato nella configurazione`);
    }
    return this.connect(config);
  }

  /**
   * Esegui un comando su un server predefinito
   * @param {string} serverName - Nome del server (twiky o ndei)
   * @param {string} command - Comando da eseguire
   * @param {Object} execOptions - Opzioni per l'esecuzione
   * @returns {Promise<Object>} Risultato con stdout, stderr, code
   */
  async executeOnServer(serverName, command, execOptions = {}) {
    const config = getServerConfig(serverName);
    if (!config) {
      throw new Error(`Server "${serverName}" non trovato nella configurazione`);
    }
    return this.executeCommand(config, command, execOptions);
  }

  /**
   * Esegui più comandi su un server predefinito
   * @param {string} serverName - Nome del server (twiky o ndei)
   * @param {string[]} commands - Array di comandi da eseguire
   * @param {Object} execOptions - Opzioni per l'esecuzione
   * @returns {Promise<Array>} Array di risultati
   */
  async executeCommandsOnServer(serverName, commands, execOptions = {}) {
    const config = getServerConfig(serverName);
    if (!config) {
      throw new Error(`Server "${serverName}" non trovato nella configurazione`);
    }
    return this.executeCommands(config, commands, execOptions);
  }

  /**
   * Testa la connessione a un server predefinito
   * @param {string} serverName - Nome del server (twiky o ndei)
   * @returns {Promise<boolean>} true se la connessione riesce
   */
  async testServerConnection(serverName) {
    const config = getServerConfig(serverName);
    if (!config) {
      return false;
    }
    return this.testConnection(config);
  }

  /**
   * Ottieni informazioni sul sistema di un server predefinito
   * @param {string} serverName - Nome del server (twiky o ndei)
   * @returns {Promise<Object>} Informazioni sul sistema
   */
  async getServerSystemInfo(serverName) {
    const config = getServerConfig(serverName);
    if (!config) {
      throw new Error(`Server "${serverName}" non trovato nella configurazione`);
    }
    return this.getSystemInfo(config);
  }
}

export default SSHAgent;

