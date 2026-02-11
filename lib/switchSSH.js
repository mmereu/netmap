import { Client } from 'ssh2';
import SSHConnectionPool from './sshConnectionPool.js';

/**
 * Client SSH per switch Huawei con gestione shell interattiva
 *
 * Differenze rispetto a sshAgent.js:
 * - Usa shell interattiva invece di exec
 * - Gestisce prompt Huawei (<hostname>, [hostname])
 * - Gestisce paginazione ("---- More ----")
 * - Gestisce richieste di conferma ("Press ENTER to continue")
 *
 * Connection Pooling:
 * - Set usePool: true to enable connection pooling
 * - Use executeCommandPooled() to execute commands with pooled connections
 * - Pool keeps connections alive between commands for better performance
 * - Existing executeCommand() remains unchanged for backward compatibility
 */
class SwitchSSH {
  /**
   * Create a new SwitchSSH instance
   * @param {Object} config - Configuration options
   * @param {number} [config.readyTimeout=20000] - SSH ready timeout in ms
   * @param {number} [config.keepaliveInterval=10000] - Keepalive interval in ms
   * @param {number} [config.keepaliveCountMax=3] - Max keepalive count before disconnect
   * @param {number} [config.shellTimeout=30000] - Shell command timeout in ms
   * @param {number} [config.promptTimeout=5000] - Prompt wait timeout in ms
   * @param {number} [config.pageTimeout=2000] - Pagination timeout in ms
   * @param {boolean} [config.usePool=false] - Enable connection pooling
   * @param {Object} [config.poolConfig] - Pool configuration options
   * @param {number} [config.poolConfig.maxConnections=10] - Maximum pooled connections
   * @param {number} [config.poolConfig.idleTimeout=300000] - Idle timeout in ms (5 min)
   * @param {number} [config.poolConfig.healthCheckInterval=60000] - Health check interval (1 min)
   * @param {boolean} [config.poolConfig.debug=false] - Enable pool debug logging
   */
  constructor(config = {}) {
    // Extract pool config before spreading
    const { usePool = false, poolConfig = {}, ...sshConfig } = config;

    this.defaultConfig = {
      readyTimeout: 20000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      // Configurazione specifica per switch
      shellTimeout: 30000,
      promptTimeout: 5000,
      pageTimeout: 2000,
      ...sshConfig,
    };

    // Connection pooling configuration
    this.usePool = usePool;
    this.poolConfig = {
      maxConnections: 10,
      idleTimeout: 300000,      // 5 minutes
      healthCheckInterval: 60000, // 1 minute
      debug: false,
      ...poolConfig,
    };

    // Create pool if pooling is enabled
    this._pool = null;
    if (this.usePool) {
      this._pool = new SSHConnectionPool(this.poolConfig);
    }

    // Pattern per rilevare prompt Huawei
    this.promptPatterns = [
      /<[^>]+>/,           // <hostname>
      /\[[^\]]+\]/,        // [hostname]
      /<[^>]+-[^>]+>/,     // <hostname-interface>
      /\[[^\]]+-[^\]]+\]/, // [hostname-interface]
    ];

    // Pattern per paginazione
    this.paginationPattern = /----\s*More\s*----/i;

    // Pattern per richieste di conferma
    this.confirmPatterns = [
      /Press ENTER to continue/i,
      /Press any key to continue/i,
      /\(Y\/N\)/i,
    ];
  }

  /**
   * Connetti a uno switch via SSH
   * @param {Object} options - Opzioni di connessione
   * @param {string} options.host - Indirizzo IP dello switch
   * @param {number} options.port - Porta SSH (default: 22)
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @returns {Promise<Client>} Client SSH connesso
   */
  async connect(options) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const config = {
        host: options.host,
        port: options.port || 22,
        username: options.username,
        password: options.password,
        tryKeyboard: true,  // Abilita keyboard-interactive
        algorithms: {
          kex: [
            'curve25519-sha256',
            'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1'
          ],
          cipher: [
            'aes128-ctr',
            'aes192-ctr',
            'aes256-ctr',
            'aes128-gcm',
            'aes128-gcm@openssh.com',
            'aes256-gcm',
            'aes256-gcm@openssh.com',
            'aes128-cbc',
            'aes192-cbc',
            'aes256-cbc',
            '3des-cbc'
          ],
          serverHostKey: [
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'ssh-ed25519'
          ],
          hmac: [
            'hmac-sha2-256',
            'hmac-sha2-512',
            'hmac-sha1',
            'hmac-md5'
          ]
        },
        hostVerifier: () => true,
        ...this.defaultConfig,
      };

      // Gestione keyboard-interactive authentication
      conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish([options.password]);
      });

      conn.on('ready', () => {
        resolve(conn);
      });

      conn.on('error', (err) => {
        reject(new Error(`Connessione SSH fallita a ${options.host}: ${err.message}`));
      });

      conn.connect(config);
    });
  }

  /**
   * Esegui un comando su uno switch Huawei
   * @param {Object} options - Opzioni
   * @param {string} options.host - Indirizzo IP dello switch
   * @param {number} [options.port=22] - Porta SSH
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string} options.command - Comando da eseguire
   * @param {number} [options.timeout] - Timeout in ms (default: shellTimeout)
   * @param {boolean} [options.disablePaging=true] - Disabilita paginazione con "screen-length 0"
   * @returns {Promise<string>} Output del comando
   */
  async executeCommand(options) {
    const {
      host,
      port = 22,
      username,
      password,
      command,
      timeout = this.defaultConfig.shellTimeout,
      disablePaging = true,
    } = options;

    let conn = null;
    let stream = null;

    try {
      // Connetti allo switch
      conn = await this.connect({ host, port, username, password });

      // Apri shell interattiva
      stream = await this._openShell(conn);

      // Attendi prompt iniziale
      await this._waitForPrompt(stream, this.defaultConfig.promptTimeout);

      // Disabilita paginazione se richiesto
      if (disablePaging) {
        await this._sendCommand(stream, 'screen-length 0 temporary', this.defaultConfig.promptTimeout);
      }

      // Esegui comando e raccogli output
      const output = await this._sendCommand(stream, command, timeout);

      return this._cleanOutput(output, command);
    } catch (err) {
      throw new Error(`Errore esecuzione comando su ${host}: ${err.message}`);
    } finally {
      if (stream) {
        stream.end();
      }
      if (conn) {
        conn.end();
      }
    }
  }

  /**
   * Esegui più comandi in sequenza sulla stessa connessione
   * @param {Object} options - Opzioni
   * @param {string} options.host - Indirizzo IP dello switch
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string[]} options.commands - Array di comandi
   * @param {boolean} [options.disablePaging=true] - Disabilita paginazione
   * @returns {Promise<Array>} Array di oggetti {command, output}
   */
  async executeCommands(options) {
    const {
      host,
      port = 22,
      username,
      password,
      commands,
      disablePaging = true,
    } = options;

    let conn = null;
    let stream = null;
    const results = [];

    try {
      // Connetti allo switch
      conn = await this.connect({ host, port, username, password });

      // Apri shell interattiva
      stream = await this._openShell(conn);

      // Attendi prompt iniziale
      await this._waitForPrompt(stream, this.defaultConfig.promptTimeout);

      // Disabilita paginazione se richiesto
      if (disablePaging) {
        await this._sendCommand(stream, 'screen-length 0 temporary', this.defaultConfig.promptTimeout);
      }

      // Esegui comandi in sequenza
      for (const command of commands) {
        try {
          const output = await this._sendCommand(stream, command, this.defaultConfig.shellTimeout);
          results.push({
            command,
            output: this._cleanOutput(output, command),
            success: true,
          });
        } catch (err) {
          results.push({
            command,
            output: '',
            error: err.message,
            success: false,
          });
        }
      }

      return results;
    } catch (err) {
      throw new Error(`Errore esecuzione comandi su ${host}: ${err.message}`);
    } finally {
      if (stream) {
        stream.end();
      }
      if (conn) {
        conn.end();
      }
    }
  }

  // ============================================================
  // POOLED CONNECTION METHODS
  // ============================================================

  /**
   * Execute a command using a pooled connection.
   * Connection is reused between calls for improved performance.
   *
   * Note: Requires usePool: true in constructor config.
   *
   * @param {Object} options - Execution options
   * @param {string} options.host - Switch IP address
   * @param {number} [options.port=22] - SSH port
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string} options.command - Command to execute
   * @param {number} [options.timeout] - Timeout in ms (default: shellTimeout)
   * @param {boolean} [options.disablePaging=true] - Disable paging with "screen-length 0"
   * @returns {Promise<string>} Command output
   * @throws {Error} If pool is not enabled or command fails
   */
  async executeCommandPooled(options) {
    if (!this._pool) {
      throw new Error('Connection pooling is not enabled. Create SwitchSSH with usePool: true');
    }

    const {
      host,
      port = 22,
      username,
      password,
      command,
      timeout = this.defaultConfig.shellTimeout,
      disablePaging = true,
    } = options;

    const key = this._pool.generateKey(host, port, username);
    let conn = null;
    let stream = null;
    let isNewConnection = false;
    let connectionAcquired = false;

    try {
      // Try to acquire existing connection from pool
      conn = await this._pool.acquire(key);

      if (conn) {
        connectionAcquired = true;
        // Check if we have a usable cached shell session
        // isShellUsable checks: shell exists, no errors, stream is writable
        if (this._pool.isShellUsable(key) && this._pool.isShellReady(key)) {
          stream = this._pool.getShell(key);
          // Reuse existing shell - just send the command
          try {
            const output = await this._sendCommand(stream, command, timeout);
            this._pool.release(key);
            return this._cleanOutput(output, command);
          } catch (cmdErr) {
            // Shell command failed - invalidate shell and remove connection
            this._pool.recordError(`Command failed on ${host}: ${cmdErr.message}`);
            this._pool.remove(key);
            throw cmdErr;
          }
        } else if (this._pool.hasShellError(key)) {
          // Shell had an error - invalidate and recreate
          this._pool.invalidateShell(key);
        }
      } else {
        // Create new connection
        conn = await this.connect({ host, port, username, password });
        isNewConnection = true;

        // Add to pool with credentials for potential reconnection
        const added = this._pool.add(key, conn, { host, port, username });
        if (!added) {
          // Pool is full, use connection without pooling
          isNewConnection = false; // Don't return to pool on error
        } else {
          connectionAcquired = true;
        }
      }

      // Open new shell session
      stream = await this._openShell(conn);

      // Store shell in pool for reuse
      if (connectionAcquired) {
        this._pool.setShell(key, stream);
      }

      // Wait for initial prompt
      await this._waitForPrompt(stream, this.defaultConfig.promptTimeout);

      // Disable paging if requested
      if (disablePaging) {
        await this._sendCommand(stream, 'screen-length 0 temporary', this.defaultConfig.promptTimeout);
      }

      // Mark shell as ready
      if (connectionAcquired) {
        this._pool.setShellReady(key, true);
      }

      // Execute command
      const output = await this._sendCommand(stream, command, timeout);

      // Release connection back to pool for reuse
      if (connectionAcquired) {
        this._pool.release(key);
      }

      return this._cleanOutput(output, command);

    } catch (err) {
      // Handle error - remove broken connection from pool
      if (connectionAcquired) {
        this._pool.recordError(`Command failed on ${host}: ${err.message}`);
        this._pool.remove(key);
      } else if (isNewConnection && conn) {
        // Clean up unpooled connection
        conn.end();
      }

      throw new Error(`Errore esecuzione comando (pooled) su ${host}: ${err.message}`);
    }
  }

  /**
   * Execute multiple commands using a pooled connection.
   * Connection is kept alive between commands for improved performance.
   *
   * Note: Requires usePool: true in constructor config.
   *
   * @param {Object} options - Execution options
   * @param {string} options.host - Switch IP address
   * @param {number} [options.port=22] - SSH port
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string[]} options.commands - Array of commands to execute
   * @param {boolean} [options.disablePaging=true] - Disable paging
   * @returns {Promise<Array>} Array of {command, output, success, error?}
   * @throws {Error} If pool is not enabled or connection fails
   */
  async executeCommandsPooled(options) {
    if (!this._pool) {
      throw new Error('Connection pooling is not enabled. Create SwitchSSH with usePool: true');
    }

    const {
      host,
      port = 22,
      username,
      password,
      commands,
      disablePaging = true,
    } = options;

    const key = this._pool.generateKey(host, port, username);
    let conn = null;
    let stream = null;
    let isNewConnection = false;
    let connectionAcquired = false;
    const results = [];

    try {
      // Try to acquire existing connection from pool
      conn = await this._pool.acquire(key);

      if (conn) {
        connectionAcquired = true;
        // Check if we have a usable cached shell session
        if (this._pool.isShellUsable(key) && this._pool.isShellReady(key)) {
          stream = this._pool.getShell(key);
        } else if (this._pool.hasShellError(key)) {
          // Shell had an error - invalidate and recreate
          this._pool.invalidateShell(key);
        }
      }

      if (!conn) {
        // Create new connection
        conn = await this.connect({ host, port, username, password });
        isNewConnection = true;

        // Add to pool
        const added = this._pool.add(key, conn, { host, port, username });
        if (added) {
          connectionAcquired = true;
        }
      }

      // Need to set up shell if we don't have one or it's not usable/ready
      if (!stream || !this._pool.isShellUsable(key) || !this._pool.isShellReady(key)) {
        // Open new shell session
        stream = await this._openShell(conn);

        if (connectionAcquired) {
          this._pool.setShell(key, stream);
        }

        // Wait for initial prompt
        await this._waitForPrompt(stream, this.defaultConfig.promptTimeout);

        // Disable paging if requested
        if (disablePaging) {
          await this._sendCommand(stream, 'screen-length 0 temporary', this.defaultConfig.promptTimeout);
        }

        // Mark shell as ready
        if (connectionAcquired) {
          this._pool.setShellReady(key, true);
        }
      }

      // Execute commands sequentially
      let hasCommandError = false;
      for (const command of commands) {
        try {
          const output = await this._sendCommand(stream, command, this.defaultConfig.shellTimeout);
          results.push({
            command,
            output: this._cleanOutput(output, command),
            success: true,
          });
        } catch (err) {
          results.push({
            command,
            output: '',
            error: err.message,
            success: false,
          });
          hasCommandError = true;
          // Don't break on command errors - continue with next command
        }
      }

      // If any command had an error, invalidate the shell for safety
      // The connection remains in the pool, but the shell will be recreated
      if (hasCommandError && connectionAcquired) {
        this._pool.invalidateShell(key);
      }

      // Release connection back to pool
      if (connectionAcquired) {
        this._pool.release(key);
      }

      return results;

    } catch (err) {
      // Handle connection-level error
      if (connectionAcquired) {
        this._pool.recordError(`Commands failed on ${host}: ${err.message}`);
        this._pool.remove(key);
      } else if (isNewConnection && conn) {
        conn.end();
      }

      throw new Error(`Errore esecuzione comandi (pooled) su ${host}: ${err.message}`);
    }
  }

  /**
   * Get the connection pool instance (for advanced usage or diagnostics)
   * @returns {SSHConnectionPool|null} Pool instance or null if pooling disabled
   */
  getPool() {
    return this._pool;
  }

  /**
   * Get connection pool statistics
   * @returns {Object|null} Pool stats or null if pooling disabled
   */
  getPoolStats() {
    return this._pool ? this._pool.getStats() : null;
  }

  /**
   * Release a specific pooled connection
   * @param {string} host - Host address
   * @param {number} [port=22] - SSH port
   * @param {string} username - Username
   * @returns {boolean} True if released, false if not found or pool disabled
   */
  releasePooledConnection(host, port = 22, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.release(key);
  }

  /**
   * Remove a specific connection from the pool (forcibly close it)
   * @param {string} host - Host address
   * @param {number} [port=22] - SSH port
   * @param {string} username - Username
   * @returns {boolean} True if removed, false if not found or pool disabled
   */
  removePooledConnection(host, port = 22, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.remove(key);
  }

  /**
   * Reset shell session for a pooled connection.
   * This closes the current shell but keeps the connection in the pool.
   * A new shell will be created on the next command execution.
   *
   * Use this when you need to ensure a clean shell state, for example:
   * - After command batches that may leave shell in unexpected state
   * - When switching between configuration modes
   * - After encountering prompt parsing issues
   *
   * @param {string} host - Host address
   * @param {number} [port=22] - SSH port
   * @param {string} username - Username
   * @returns {boolean} True if shell was reset, false if not found or pool disabled
   */
  resetPooledShell(host, port = 22, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.resetShell(key);
  }

  /**
   * Check if a pooled shell is usable for command execution
   * @param {string} host - Host address
   * @param {number} [port=22] - SSH port
   * @param {string} username - Username
   * @returns {boolean} True if shell is usable
   */
  isPooledShellUsable(host, port = 22, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.isShellUsable(key);
  }

  /**
   * Clear all pooled connections
   */
  clearPool() {
    if (this._pool) {
      this._pool.clear();
    }
  }

  /**
   * Shutdown the pool, closing all connections
   */
  shutdownPool() {
    if (this._pool) {
      this._pool.shutdown();
    }
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Apri shell interattiva
   * @private
   */
  async _openShell(conn) {
    return new Promise((resolve, reject) => {
      conn.shell({ term: 'vt100' }, (err, stream) => {
        if (err) {
          return reject(new Error(`Impossibile aprire shell: ${err.message}`));
        }
        resolve(stream);
      });
    });
  }

  /**
   * Attendi il prompt dello switch
   * @private
   */
  async _waitForPrompt(stream, timeout) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let timeoutId = null;

      const onData = (data) => {
        buffer += data.toString();

        // Controlla se c'è il prompt
        if (this._hasPrompt(buffer)) {
          cleanup();
          resolve(buffer);
        }
      };

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        stream.removeListener('data', onData);
      };

      stream.on('data', onData);

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout in attesa del prompt (${timeout}ms)`));
        }, timeout);
      }
    });
  }

  /**
   * Invia comando e attendi risposta
   * @private
   */
  async _sendCommand(stream, command, timeout) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let timeoutId = null;
      let commandSent = false;

      const onData = (data) => {
        buffer += data.toString();

        // Gestisci richieste di conferma
        if (this._needsConfirmation(buffer)) {
          stream.write('\n'); // Premi ENTER per continuare
          return;
        }

        // Gestisci paginazione
        if (this._hasPagination(buffer)) {
          stream.write(' '); // Spazio per mostrare pagina successiva
          return;
        }

        // Controlla se abbiamo ricevuto il prompt (comando completato)
        if (commandSent && this._hasPrompt(buffer)) {
          cleanup();
          resolve(buffer);
        }
      };

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        stream.removeListener('data', onData);
      };

      stream.on('data', onData);

      // Invia comando
      stream.write(command + '\n');
      commandSent = true;

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout esecuzione comando: ${command} (${timeout}ms)`));
        }, timeout);
      }
    });
  }

  /**
   * Controlla se il buffer contiene un prompt
   * @private
   */
  _hasPrompt(buffer) {
    const lastLines = buffer.split('\n').slice(-3).join('\n');
    return this.promptPatterns.some(pattern => pattern.test(lastLines));
  }

  /**
   * Controlla se il buffer contiene paginazione
   * @private
   */
  _hasPagination(buffer) {
    return this.paginationPattern.test(buffer);
  }

  /**
   * Controlla se il buffer richiede conferma
   * @private
   */
  _needsConfirmation(buffer) {
    const lastLines = buffer.split('\n').slice(-3).join('\n');
    return this.confirmPatterns.some(pattern => pattern.test(lastLines));
  }

  /**
   * Pulisce l'output rimuovendo echo del comando e prompt
   * @private
   */
  _cleanOutput(output, command) {
    let cleaned = output;

    // Rimuovi echo del comando (prima riga)
    const lines = cleaned.split('\n');
    if (lines.length > 0 && lines[0].includes(command)) {
      lines.shift();
    }

    // Rimuovi ultima riga (prompt)
    if (lines.length > 0 && this._hasPrompt(lines[lines.length - 1])) {
      lines.pop();
    }

    // Rimuovi marker di paginazione
    cleaned = lines.join('\n').replace(/----\s*More\s*----/gi, '');

    // Rimuovi caratteri di controllo ANSI
    cleaned = cleaned.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // Rimuovi righe vuote all'inizio e alla fine
    return cleaned.trim();
  }

  /**
   * Testa la connessione SSH a uno switch
   * @param {Object} options - Opzioni di connessione
   * @returns {Promise<boolean>} true se la connessione riesce
   */
  async testConnection(options) {
    try {
      const conn = await this.connect(options);
      conn.end();
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Ottieni informazioni di base sullo switch
   * @param {Object} options - Opzioni connessione (host, username, password)
   * @returns {Promise<Object>} Informazioni switch
   */
  async getSwitchInfo(options) {
    const commands = [
      'display version',
      'display device',
      'display current-configuration | include sysname',
    ];

    try {
      const results = await this.executeCommands({
        ...options,
        commands,
      });

      return {
        version: results[0]?.output || '',
        device: results[1]?.output || '',
        sysname: results[2]?.output || '',
        success: results.every(r => r.success),
      };
    } catch (err) {
      throw new Error(`Impossibile ottenere informazioni switch: ${err.message}`);
    }
  }
}

export default SwitchSSH;
