/**
 * Client Telnet per switch Huawei con gestione sessione interattiva
 *
 * Usa socket raw invece della libreria telnet-client (che ritorna null su Huawei).
 * Gestisce:
 * - Login username/password
 * - Prompt Huawei (<hostname>, [hostname])
 * - Paginazione ("---- More ----")
 * - Richieste di conferma
 *
 * Connection Pooling:
 * - Set usePool: true to enable connection pooling
 * - Use executeCommandPooled() to execute commands with pooled connections
 * - Pool keeps connections alive between commands for better performance
 * - Existing executeCommand() remains unchanged for backward compatibility
 */
import net from 'net';
import TelnetConnectionPool, { TelnetStage } from './telnetConnectionPool.js';

class SwitchTelnet {
  /**
   * Create a new SwitchTelnet instance
   * @param {Object} config - Configuration options
   * @param {number} [config.port=23] - Default Telnet port
   * @param {number} [config.timeout=30000] - Default command timeout in ms
   * @param {boolean} [config.usePool=false] - Enable connection pooling
   * @param {Object} [config.poolConfig] - Pool configuration options
   * @param {number} [config.poolConfig.maxConnections=10] - Maximum pooled connections
   * @param {number} [config.poolConfig.idleTimeout=300000] - Idle timeout in ms (5 min)
   * @param {number} [config.poolConfig.healthCheckInterval=60000] - Health check interval (1 min)
   * @param {boolean} [config.poolConfig.debug=false] - Enable pool debug logging
   */
  constructor(config = {}) {
    // Extract pool config before spreading
    const { usePool = false, poolConfig = {}, ...telnetConfig } = config;

    this.defaultConfig = {
      port: 23,
      timeout: 30000,
      ...telnetConfig,
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
      this._pool = new TelnetConnectionPool(this.poolConfig);
    }

    // Pattern per rilevare prompt Huawei
    this.promptPattern = /[<\[][^\]>]+[>\]]\s*$/;
  }

  /**
   * Esegui un comando su uno switch Huawei via Telnet
   * @param {Object} options - Opzioni
   * @param {string} options.host - Indirizzo IP dello switch
   * @param {number} [options.port=23] - Porta Telnet
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string} options.command - Comando da eseguire
   * @param {number} [options.timeout] - Timeout in ms
   * @param {boolean} [options.disablePaging=true] - Disabilita paginazione
   * @returns {Promise<string>} Output del comando
   */
  async executeCommand(options) {
    const {
      host,
      port = 23,
      username,
      password,
      command,
      timeout = this.defaultConfig.timeout,
      disablePaging = true,
    } = options;

    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let buffer = '';
      let stage = 'init';
      let commandOutput = '';
      const promptPattern = /[<\[][^\]>]+[>\]]\s*$/;
      let resolved = false;

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          // Se abbiamo già output parziale, ritorniamolo
          if (commandOutput.length > 50) {
            resolve(this._cleanOutput(commandOutput, command));
          } else {
            reject(new Error(`Timeout su ${host}`));
          }
        }
      }, timeout);

      const finish = (output) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          client.write('quit\r\n');
          setTimeout(() => client.destroy(), 500);
          resolve(output);
        }
      };

      const handleError = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          client.destroy();
          reject(new Error(`Errore Telnet su ${host}: ${err.message}`));
        }
      };

      client.connect(port, host, () => {
        // Connesso, attendi login prompt
      });

      client.on('data', (data) => {
        const str = data.toString();
        // Rimuovi caratteri Telnet IAC negotiation
        const clean = str.replace(/[\xff][\xfb\xfc\xfd\xfe]./g, '').replace(/\x00/g, '');
        buffer += clean;

        // State machine per login Huawei
        if (stage === 'init' && /Username:/i.test(buffer)) {
          stage = 'username';
          client.write(username + '\r\n');
          buffer = '';
        }
        else if (stage === 'username' && /Password:/i.test(buffer)) {
          stage = 'password';
          client.write(password + '\r\n');
          buffer = '';
        }
        else if (stage === 'password') {
          // Verifica errore login
          if (/Error|failed|incorrect|denied/i.test(buffer)) {
            handleError(new Error('Login fallito - credenziali errate'));
            return;
          }
          // Attendi prompt
          if (promptPattern.test(buffer)) {
            stage = disablePaging ? 'screen-length' : 'ready';
            if (disablePaging) {
              client.write('screen-length 0 temporary\r\n');
            } else {
              client.write(command + '\r\n');
              stage = 'command';
            }
            buffer = '';
          }
        }
        else if (stage === 'screen-length' && promptPattern.test(buffer)) {
          stage = 'command';
          client.write(command + '\r\n');
          buffer = '';
        }
        else if (stage === 'command') {
          commandOutput += clean;

          // Gestisci paginazione "---- More ----"
          if (/----\s*More\s*----/i.test(commandOutput)) {
            client.write(' ');  // Spazio per continuare
            commandOutput = commandOutput.replace(/----\s*More\s*----/gi, '');
          }

          // Verifica se abbiamo ricevuto il prompt finale (fine output)
          if (promptPattern.test(commandOutput)) {
            const cleaned = this._cleanOutput(commandOutput, command);
            finish(cleaned);
          }
        }
      });

      client.on('error', handleError);

      client.on('close', () => {
        if (!resolved) {
          // Se abbiamo output, consideralo successo
          if (commandOutput.length > 20) {
            finish(this._cleanOutput(commandOutput, command));
          }
        }
      });
    });
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
      port = 23,
      username,
      password,
      commands,
      timeout = this.defaultConfig.timeout,
      disablePaging = true,
    } = options;

    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let buffer = '';
      let stage = 'init';
      let commandOutput = '';
      const promptPattern = /[<\[][^\]>]+[>\]]\s*$/;
      let resolved = false;
      let currentCommandIndex = 0;
      const results = [];

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          resolve(results);  // Ritorna risultati parziali
        }
      }, timeout);

      const finish = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          client.write('quit\r\n');
          setTimeout(() => client.destroy(), 500);
          resolve(results);
        }
      };

      const handleError = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          client.destroy();
          reject(new Error(`Errore Telnet su ${host}: ${err.message}`));
        }
      };

      const sendNextCommand = () => {
        if (currentCommandIndex >= commands.length) {
          finish();
          return;
        }
        const cmd = commands[currentCommandIndex];
        client.write(cmd + '\r\n');
        commandOutput = '';
        buffer = '';
        stage = 'command';
      };

      client.connect(port, host, () => {});

      client.on('data', (data) => {
        const str = data.toString();
        const clean = str.replace(/[\xff][\xfb\xfc\xfd\xfe]./g, '').replace(/\x00/g, '');
        buffer += clean;

        if (stage === 'init' && /Username:/i.test(buffer)) {
          stage = 'username';
          client.write(username + '\r\n');
          buffer = '';
        }
        else if (stage === 'username' && /Password:/i.test(buffer)) {
          stage = 'password';
          client.write(password + '\r\n');
          buffer = '';
        }
        else if (stage === 'password') {
          if (/Error|failed|incorrect|denied/i.test(buffer)) {
            handleError(new Error('Login fallito'));
            return;
          }
          if (promptPattern.test(buffer)) {
            stage = disablePaging ? 'screen-length' : 'ready';
            if (disablePaging) {
              client.write('screen-length 0 temporary\r\n');
            } else {
              sendNextCommand();
            }
            buffer = '';
          }
        }
        else if (stage === 'screen-length' && promptPattern.test(buffer)) {
          sendNextCommand();
        }
        else if (stage === 'command') {
          commandOutput += clean;

          if (/----\s*More\s*----/i.test(commandOutput)) {
            client.write(' ');
            commandOutput = commandOutput.replace(/----\s*More\s*----/gi, '');
          }

          if (promptPattern.test(commandOutput)) {
            const cmd = commands[currentCommandIndex];
            results.push({
              command: cmd,
              output: this._cleanOutput(commandOutput, cmd),
              success: true,
            });
            currentCommandIndex++;
            sendNextCommand();
          }
        }
      });

      client.on('error', handleError);
      client.on('close', () => {
        if (!resolved && results.length > 0) {
          resolved = true;
          clearTimeout(timeoutHandle);
          resolve(results);
        }
      });
    });
  }

  /**
   * Testa la connessione Telnet a uno switch
   * @param {Object} options - Opzioni di connessione
   * @returns {Promise<boolean>} true se la connessione riesce
   */
  async testConnection(options) {
    try {
      // Prova un comando semplice per verificare connessione
      await this.executeCommand({
        ...options,
        command: 'display version',
        timeout: options.timeout || 10000,
      });
      return true;
    } catch (err) {
      return false;
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
   * @param {number} [options.port=23] - Telnet port
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string} options.command - Command to execute
   * @param {number} [options.timeout] - Timeout in ms (default: this.defaultConfig.timeout)
   * @param {boolean} [options.disablePaging=true] - Disable paging with "screen-length 0"
   * @returns {Promise<string>} Command output
   * @throws {Error} If pool is not enabled or command fails
   */
  async executeCommandPooled(options) {
    if (!this._pool) {
      throw new Error('Connection pooling is not enabled. Create SwitchTelnet with usePool: true');
    }

    const {
      host,
      port = 23,
      username,
      password,
      command,
      timeout = this.defaultConfig.timeout,
      disablePaging = true,
    } = options;

    const key = this._pool.generateKey(host, port, username);
    let client = null;
    let isNewConnection = false;
    let connectionAcquired = false;

    try {
      // Try to acquire existing connection from pool
      client = await this._pool.acquire(key);

      if (client) {
        connectionAcquired = true;
        // Check if we have a usable session (authenticated and at prompt)
        if (this._pool.isSessionUsable(key)) {
          // Reuse existing session - just send the command
          try {
            const output = await this._sendPooledCommand(client, key, command, timeout);
            this._pool.release(key);
            return this._cleanOutput(output, command);
          } catch (cmdErr) {
            // Command failed - invalidate session and remove connection
            this._pool.recordError(`Command failed on ${host}: ${cmdErr.message}`);
            this._pool.remove(key);
            throw cmdErr;
          }
        } else if (this._pool.hasError(key)) {
          // Session had an error - remove and create new
          this._pool.remove(key);
          client = null;
          connectionAcquired = false;
        }
      }

      if (!client) {
        // Create new connection
        client = await this._createPooledConnection(host, port, username, password, disablePaging, timeout);
        isNewConnection = true;

        // Add to pool with credentials for potential reconnection
        const added = this._pool.add(key, client, { host, port, username });
        if (!added) {
          // Pool is full, use connection without pooling
          isNewConnection = false; // Don't return to pool on error
        } else {
          connectionAcquired = true;
          // Mark session as authenticated and ready
          this._pool.setAuthenticated(key, true);
          this._pool.setAtPrompt(key, true);
          this._pool.setStage(key, TelnetStage.READY);
        }
      }

      // Execute command
      const output = await this._sendPooledCommand(client, key, command, timeout);

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
      } else if (isNewConnection && client) {
        // Clean up unpooled connection
        try {
          client.destroy();
        } catch (destroyErr) {
          // Ignore - connection may already be closed
        }
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
   * @param {number} [options.port=23] - Telnet port
   * @param {string} options.username - Username
   * @param {string} options.password - Password
   * @param {string[]} options.commands - Array of commands to execute
   * @param {number} [options.timeout] - Timeout in ms (default: this.defaultConfig.timeout)
   * @param {boolean} [options.disablePaging=true] - Disable paging
   * @returns {Promise<Array>} Array of {command, output, success, error?}
   * @throws {Error} If pool is not enabled or connection fails
   */
  async executeCommandsPooled(options) {
    if (!this._pool) {
      throw new Error('Connection pooling is not enabled. Create SwitchTelnet with usePool: true');
    }

    const {
      host,
      port = 23,
      username,
      password,
      commands,
      timeout = this.defaultConfig.timeout,
      disablePaging = true,
    } = options;

    const key = this._pool.generateKey(host, port, username);
    let client = null;
    let isNewConnection = false;
    let connectionAcquired = false;
    const results = [];

    try {
      // Try to acquire existing connection from pool
      client = await this._pool.acquire(key);

      if (client) {
        connectionAcquired = true;
        // Check if we have a usable session
        if (!this._pool.isSessionUsable(key)) {
          if (this._pool.hasError(key)) {
            // Session had an error - remove and create new
            this._pool.remove(key);
            client = null;
            connectionAcquired = false;
          }
        }
      }

      if (!client) {
        // Create new connection
        client = await this._createPooledConnection(host, port, username, password, disablePaging, timeout);
        isNewConnection = true;

        // Add to pool
        const added = this._pool.add(key, client, { host, port, username });
        if (added) {
          connectionAcquired = true;
          // Mark session as authenticated and ready
          this._pool.setAuthenticated(key, true);
          this._pool.setAtPrompt(key, true);
          this._pool.setStage(key, TelnetStage.READY);
        }
      }

      // Execute commands sequentially
      let hasCommandError = false;
      for (const command of commands) {
        try {
          const output = await this._sendPooledCommand(client, key, command, timeout);
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

      // If any command had an error, reset session state
      // The connection remains in the pool, but will need re-authentication
      if (hasCommandError && connectionAcquired) {
        this._pool.resetSession(key);
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
      } else if (isNewConnection && client) {
        try {
          client.destroy();
        } catch (destroyErr) {
          // Ignore
        }
      }

      throw new Error(`Errore esecuzione comandi (pooled) su ${host}: ${err.message}`);
    }
  }

  /**
   * Get the connection pool instance (for advanced usage or diagnostics)
   * @returns {TelnetConnectionPool|null} Pool instance or null if pooling disabled
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
   * @param {number} [port=23] - Telnet port
   * @param {string} username - Username
   * @returns {boolean} True if released, false if not found or pool disabled
   */
  releasePooledConnection(host, port = 23, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.release(key);
  }

  /**
   * Remove a specific connection from the pool (forcibly close it)
   * @param {string} host - Host address
   * @param {number} [port=23] - Telnet port
   * @param {string} username - Username
   * @returns {boolean} True if removed, false if not found or pool disabled
   */
  removePooledConnection(host, port = 23, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.remove(key);
  }

  /**
   * Reset session state for a pooled connection.
   * This resets authentication state but keeps the socket connection.
   * A new login will be required on the next command execution.
   *
   * Use this when you need to ensure a clean session state, for example:
   * - After encountering authentication issues
   * - When switching users
   * - After encountering prompt parsing issues
   *
   * @param {string} host - Host address
   * @param {number} [port=23] - Telnet port
   * @param {string} username - Username
   * @returns {boolean} True if session was reset, false if not found or pool disabled
   */
  resetPooledSession(host, port = 23, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.resetSession(key);
  }

  /**
   * Check if a pooled session is usable for command execution
   * @param {string} host - Host address
   * @param {number} [port=23] - Telnet port
   * @param {string} username - Username
   * @returns {boolean} True if session is usable
   */
  isPooledSessionUsable(host, port = 23, username) {
    if (!this._pool) {
      return false;
    }
    const key = this._pool.generateKey(host, port, username);
    return this._pool.isSessionUsable(key);
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
  // PRIVATE POOLED CONNECTION HELPERS
  // ============================================================

  /**
   * Create and authenticate a new Telnet connection for pooling.
   * Handles the full login sequence and screen-length setup.
   *
   * @param {string} host - Host address
   * @param {number} port - Telnet port
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {boolean} disablePaging - Whether to disable paging
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<net.Socket>} Connected and authenticated socket
   * @private
   */
  async _createPooledConnection(host, port, username, password, disablePaging, timeout) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let buffer = '';
      let stage = 'init';
      let resolved = false;

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          reject(new Error(`Timeout durante connessione a ${host}`));
        }
      }, timeout);

      const finish = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          // Remove the 'data' listener to prevent conflicts
          client.removeAllListeners('data');
          resolve(client);
        }
      };

      const handleError = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          client.destroy();
          reject(new Error(`Errore connessione Telnet a ${host}: ${err.message}`));
        }
      };

      client.connect(port, host, () => {
        // Connected, wait for login prompt
      });

      client.on('data', (data) => {
        const str = data.toString();
        // Remove Telnet IAC negotiation characters
        const clean = str.replace(/[\xff][\xfb\xfc\xfd\xfe]./g, '').replace(/\x00/g, '');
        buffer += clean;

        // State machine for Huawei login
        if (stage === 'init' && /Username:/i.test(buffer)) {
          stage = 'username';
          client.write(username + '\r\n');
          buffer = '';
        }
        else if (stage === 'username' && /Password:/i.test(buffer)) {
          stage = 'password';
          client.write(password + '\r\n');
          buffer = '';
        }
        else if (stage === 'password') {
          // Check for login error
          if (/Error|failed|incorrect|denied/i.test(buffer)) {
            handleError(new Error('Login fallito - credenziali errate'));
            return;
          }
          // Wait for prompt
          if (this.promptPattern.test(buffer)) {
            stage = disablePaging ? 'screen-length' : 'ready';
            if (disablePaging) {
              client.write('screen-length 0 temporary\r\n');
            } else {
              finish();
            }
            buffer = '';
          }
        }
        else if (stage === 'screen-length' && this.promptPattern.test(buffer)) {
          finish();
        }
      });

      client.on('error', handleError);

      client.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          reject(new Error(`Connessione chiusa durante setup su ${host}`));
        }
      });
    });
  }

  /**
   * Send a command on a pooled connection and collect output.
   *
   * @param {net.Socket} client - Socket connection
   * @param {string} key - Connection pool key
   * @param {string} command - Command to execute
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<string>} Command output
   * @private
   */
  async _sendPooledCommand(client, key, command, timeout) {
    return new Promise((resolve, reject) => {
      let commandOutput = '';
      let resolved = false;

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          // If we have partial output, return it
          if (commandOutput.length > 50) {
            resolve(commandOutput);
          } else {
            reject(new Error(`Timeout esecuzione comando: ${command}`));
          }
        }
      }, timeout);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        client.removeListener('data', onData);
        client.removeListener('error', onError);
      };

      const onData = (data) => {
        const str = data.toString();
        // Remove Telnet IAC negotiation characters
        const clean = str.replace(/[\xff][\xfb\xfc\xfd\xfe]./g, '').replace(/\x00/g, '');
        commandOutput += clean;

        // Handle pagination "---- More ----"
        if (/----\s*More\s*----/i.test(commandOutput)) {
          client.write(' ');  // Space to continue
          commandOutput = commandOutput.replace(/----\s*More\s*----/gi, '');
        }

        // Check if we received the final prompt (end of output)
        if (this.promptPattern.test(commandOutput)) {
          if (!resolved) {
            resolved = true;
            cleanup();
            // Update pool state - mark as at prompt
            if (this._pool && key) {
              this._pool.setAtPrompt(key, true);
              this._pool.clearBuffer(key);
            }
            resolve(commandOutput);
          }
        }
      };

      const onError = (err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Errore socket durante comando: ${err.message}`));
        }
      };

      // Add listeners
      client.on('data', onData);
      client.on('error', onError);

      // Update pool state - mark as in command mode
      if (this._pool && key) {
        this._pool.setStage(key, TelnetStage.COMMAND);
        this._pool.setAtPrompt(key, false);
      }

      // Send command
      client.write(command + '\r\n');
    });
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Pulisce l'output rimuovendo echo del comando e caratteri di controllo
   * @private
   */
  _cleanOutput(output, command) {
    if (!output) return '';

    let cleaned = String(output);

    // Rimuovi echo del comando
    const lines = cleaned.split(/\r?\n/);
    const filteredLines = lines.filter((line, idx) => {
      // Rimuovi prima riga se contiene il comando
      if (idx === 0 && command && line.includes(command.substring(0, 20))) {
        return false;
      }
      // Rimuovi righe che sono solo prompt
      if (/^[<\[][^\]>]+[>\]]\s*$/.test(line.trim())) {
        return false;
      }
      return true;
    });

    cleaned = filteredLines.join('\n');

    // Rimuovi marker di paginazione residui
    cleaned = cleaned.replace(/----\s*More\s*----/gi, '');

    // Rimuovi caratteri ANSI
    cleaned = cleaned.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // Rimuovi backspace
    cleaned = cleaned.replace(/.\x08/g, '');

    // Rimuovi righe vuote multiple
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }
}

export default SwitchTelnet;
