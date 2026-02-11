/**
 * Telnet-specific connection pool for managing reusable raw socket connections.
 *
 * Extends the generic ConnectionPool with:
 * - Telnet-specific connection validation (socket state, writable)
 * - Proper handling of socket events (error, close, end)
 * - Connection key generation with host:port:username
 * - Session state tracking (authenticated, at prompt, etc.)
 *
 * Session State Tracking:
 * - Each pooled connection maintains authentication state
 * - Authenticated connections can skip login sequence on reuse
 * - Session state can be verified before reuse
 * - Stage tracking for state machine position (init, username, password, ready, command)
 *
 * Usage:
 *   const pool = new TelnetConnectionPool({ maxConnections: 10 });
 *   const key = pool.generateKey('192.168.1.1', 23, 'admin');
 *   const conn = await pool.acquire(key);
 *   // Use connection...
 *   pool.release(key);
 */

import ConnectionPool from './connectionPool.js';

/**
 * Telnet session stage enumeration
 * @enum {string}
 */
export const TelnetStage = {
  INIT: 'init',
  USERNAME: 'username',
  PASSWORD: 'password',
  SCREEN_LENGTH: 'screen-length',
  READY: 'ready',
  COMMAND: 'command',
};

/**
 * Telnet connection pool entry metadata
 * @typedef {Object} TelnetConnectionMeta
 * @property {net.Socket} connection - The raw socket connection
 * @property {string} stage - Current session stage (from TelnetStage enum)
 * @property {boolean} authenticated - Whether login was successful
 * @property {boolean} atPrompt - Whether session is waiting at prompt
 * @property {boolean} hasError - Whether socket has encountered an error
 * @property {Object} credentials - Original connection credentials
 * @property {string} buffer - Current receive buffer
 * @property {Function[]} cleanupHandlers - Event handlers to remove on cleanup
 */

class TelnetConnectionPool extends ConnectionPool {
  /**
   * Create a new TelnetConnectionPool instance
   * @param {Object} options - Pool configuration options
   * @param {number} [options.maxConnections=10] - Maximum connections in pool
   * @param {number} [options.idleTimeout=300000] - Idle timeout in ms (default: 5 minutes)
   * @param {number} [options.healthCheckInterval=60000] - Health check interval in ms (default: 1 minute)
   * @param {number} [options.healthCheckTimeout=5000] - Timeout for health checks in ms
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {string} [options.name='TelnetConnectionPool'] - Pool name for logging
   * @param {Function} [options.logger] - Custom logger function
   */
  constructor(options = {}) {
    super({
      ...options,
      name: options.name || 'TelnetConnectionPool',
    });

    // Additional Telnet-specific tracking
    // Maps connection key to TelnetConnectionMeta
    this._telnetMeta = new Map();
  }

  /**
   * Generate unique key for Telnet connection identification
   * @param {string} host - Host address
   * @param {number} port - Telnet port (default: 23)
   * @param {string} username - Username for authentication
   * @returns {string} Unique connection key
   */
  generateKey(host, port = 23, username) {
    return `${host}:${port}:${username}`;
  }

  /**
   * Check if a Telnet socket connection is still alive.
   *
   * Performs connection validation by checking:
   * 1. Socket object exists
   * 2. Socket is writable
   * 3. Socket is not destroyed
   *
   * @param {net.Socket} connection - Socket to check
   * @returns {boolean} True if connection is alive
   */
  isConnectionAlive(connection) {
    if (!connection) {
      return false;
    }

    // Check socket state
    if (connection.destroyed) {
      return false;
    }

    if (!connection.writable) {
      return false;
    }

    return true;
  }

  /**
   * Close a Telnet socket connection properly
   * @param {net.Socket} connection - Socket to close
   */
  closeConnection(connection) {
    if (!connection) {
      return;
    }

    try {
      // Try graceful quit first
      if (connection.writable && !connection.destroyed) {
        connection.write('quit\r\n');
      }
      // End the socket gracefully
      connection.end();
    } catch (err) {
      // If end() fails, try destroy()
      try {
        connection.destroy();
      } catch (destroyErr) {
        // Ignore - connection is already gone
      }
    }
  }

  /**
   * Add a Telnet socket connection to the pool with event handlers
   * @param {string} key - Connection key
   * @param {net.Socket} connection - Socket connection
   * @param {Object} [credentials] - Original credentials used to create connection
   * @param {string} [credentials.host] - Host address
   * @param {number} [credentials.port] - Telnet port
   * @param {string} [credentials.username] - Username
   * @param {string} [credentials.password] - Password (optional, for reference)
   * @returns {boolean} True if added, false if pool is full
   */
  add(key, connection, credentials = null) {
    // Call parent add first
    const added = super.add(key, connection);

    if (added) {
      // Set up Telnet-specific metadata
      this._telnetMeta.set(key, {
        stage: TelnetStage.INIT,
        authenticated: false,
        atPrompt: false,
        hasError: false,
        credentials: credentials,
        buffer: '',
        eventsBound: false,
        cleanupHandlers: [],
      });

      // Bind socket event handlers for automatic cleanup
      this._bindConnectionEvents(key, connection);
    }

    return added;
  }

  /**
   * Remove a Telnet connection from the pool
   * @param {string} key - Connection key
   * @returns {boolean} True if removed, false if not found
   */
  remove(key) {
    // Clean up Telnet metadata first
    const meta = this._telnetMeta.get(key);
    if (meta) {
      // Remove event handlers to prevent memory leaks
      this._cleanupEventHandlers(key, meta);
      this._telnetMeta.delete(key);
    }

    // Call parent remove
    return super.remove(key);
  }

  /**
   * Clear all connections from the pool
   */
  clear() {
    // Clean up all Telnet metadata first (properly removes event handlers)
    for (const [key, meta] of this._telnetMeta.entries()) {
      this._cleanupEventHandlers(key, meta);
    }
    this._telnetMeta.clear();

    // Call parent clear
    super.clear();
  }

  /**
   * Bind socket event handlers for automatic cleanup
   * @param {string} key - Connection key
   * @param {net.Socket} connection - Socket connection
   * @private
   */
  _bindConnectionEvents(key, connection) {
    const meta = this._telnetMeta.get(key);
    if (!meta || meta.eventsBound) {
      return;
    }

    const handleClose = () => {
      this._log('debug', `Telnet socket closed event for key "${key}"`, { key });
      this.remove(key);
    };

    const handleEnd = () => {
      this._log('debug', `Telnet socket end event for key "${key}"`, { key });
      this.remove(key);
    };

    const handleError = (err) => {
      this._log('warn', `Telnet socket error for key "${key}": ${err.message}`, { key, error: err.message });
      if (meta) {
        meta.hasError = true;
      }
      this.recordError(`Telnet socket error: ${err.message}`);
      this.remove(key);
    };

    const handleTimeout = () => {
      this._log('debug', `Telnet socket timeout event for key "${key}"`, { key });
      this.remove(key);
    };

    // Store handlers for later cleanup
    meta.cleanupHandlers = [
      { event: 'close', handler: handleClose },
      { event: 'end', handler: handleEnd },
      { event: 'error', handler: handleError },
      { event: 'timeout', handler: handleTimeout },
    ];

    // Bind handlers
    connection.on('close', handleClose);
    connection.on('end', handleEnd);
    connection.on('error', handleError);
    connection.on('timeout', handleTimeout);

    meta.eventsBound = true;
  }

  /**
   * Remove event handlers from a socket to prevent memory leaks
   * @param {string} key - Connection key
   * @param {Object} meta - Telnet metadata object
   * @private
   */
  _cleanupEventHandlers(key, meta) {
    if (!meta || !meta.cleanupHandlers || meta.cleanupHandlers.length === 0) {
      return;
    }

    const entry = this._connections.get(key);
    if (!entry || !entry.connection) {
      return;
    }

    const socket = entry.connection;

    for (const { event, handler } of meta.cleanupHandlers) {
      try {
        socket.removeListener(event, handler);
      } catch (err) {
        // Ignore - handler may already be removed
      }
    }
    meta.cleanupHandlers = [];

    this._log('debug', `Event handlers cleaned up for key "${key}"`, { key });
  }

  /**
   * Get Telnet-specific metadata for a connection
   * @param {string} key - Connection key
   * @returns {Object|null} Telnet metadata or null if not found
   */
  getTelnetMeta(key) {
    return this._telnetMeta.get(key) || null;
  }

  /**
   * Set the session stage for a connection
   * @param {string} key - Connection key
   * @param {string} stage - Session stage (from TelnetStage enum)
   */
  setStage(key, stage) {
    const meta = this._telnetMeta.get(key);
    if (meta) {
      meta.stage = stage;
      this._log('debug', `Session stage changed to "${stage}" for key "${key}"`, { key, stage });
    }
  }

  /**
   * Get the current session stage
   * @param {string} key - Connection key
   * @returns {string|null} Current stage or null if not found
   */
  getStage(key) {
    const meta = this._telnetMeta.get(key);
    return meta ? meta.stage : null;
  }

  /**
   * Mark a connection as authenticated
   * @param {string} key - Connection key
   * @param {boolean} authenticated - Whether authentication succeeded
   */
  setAuthenticated(key, authenticated) {
    const meta = this._telnetMeta.get(key);
    if (meta) {
      meta.authenticated = authenticated;
      this._log('debug', `Authentication state set to ${authenticated} for key "${key}"`, { key, authenticated });
    }
  }

  /**
   * Check if a connection is authenticated
   * @param {string} key - Connection key
   * @returns {boolean} True if authenticated
   */
  isAuthenticated(key) {
    const meta = this._telnetMeta.get(key);
    return meta ? meta.authenticated : false;
  }

  /**
   * Set whether the session is at a prompt and ready for commands
   * @param {string} key - Connection key
   * @param {boolean} atPrompt - Whether at prompt
   */
  setAtPrompt(key, atPrompt) {
    const meta = this._telnetMeta.get(key);
    if (meta) {
      meta.atPrompt = atPrompt;
      if (atPrompt) {
        meta.stage = TelnetStage.READY;
      }
    }
  }

  /**
   * Check if a connection is at the prompt and ready
   * @param {string} key - Connection key
   * @returns {boolean} True if at prompt
   */
  isAtPrompt(key) {
    const meta = this._telnetMeta.get(key);
    return meta ? meta.atPrompt : false;
  }

  /**
   * Check if a connection has encountered an error
   * @param {string} key - Connection key
   * @returns {boolean} True if has error
   */
  hasError(key) {
    const meta = this._telnetMeta.get(key);
    return meta ? meta.hasError : false;
  }

  /**
   * Get credentials for a connection (useful for reconnection)
   * @param {string} key - Connection key
   * @returns {Object|null} Credentials object or null
   */
  getCredentials(key) {
    const meta = this._telnetMeta.get(key);
    return meta ? meta.credentials : null;
  }

  /**
   * Update the receive buffer for a connection
   * @param {string} key - Connection key
   * @param {string} buffer - Buffer content
   */
  setBuffer(key, buffer) {
    const meta = this._telnetMeta.get(key);
    if (meta) {
      meta.buffer = buffer;
    }
  }

  /**
   * Append data to the receive buffer
   * @param {string} key - Connection key
   * @param {string} data - Data to append
   */
  appendBuffer(key, data) {
    const meta = this._telnetMeta.get(key);
    if (meta) {
      meta.buffer += data;
    }
  }

  /**
   * Get the current receive buffer
   * @param {string} key - Connection key
   * @returns {string} Current buffer content
   */
  getBuffer(key) {
    const meta = this._telnetMeta.get(key);
    return meta ? meta.buffer : '';
  }

  /**
   * Clear the receive buffer
   * @param {string} key - Connection key
   */
  clearBuffer(key) {
    const meta = this._telnetMeta.get(key);
    if (meta) {
      meta.buffer = '';
    }
  }

  /**
   * Check if a pooled session is usable for command execution.
   *
   * A session is usable when:
   * - Connection exists and is alive
   * - Connection is authenticated
   * - Connection has no errors
   * - Connection is at a command prompt
   *
   * @param {string} key - Connection key
   * @returns {boolean} True if session is usable
   */
  isSessionUsable(key) {
    const meta = this._telnetMeta.get(key);

    if (!meta) {
      return false;
    }

    // Check for error state
    if (meta.hasError) {
      return false;
    }

    // Check if authenticated
    if (!meta.authenticated) {
      return false;
    }

    // Check if at prompt and ready
    if (!meta.atPrompt || meta.stage !== TelnetStage.READY) {
      return false;
    }

    // Check connection is still alive
    const entry = this._connections.get(key);
    if (!entry) {
      return false;
    }

    if (!this.isConnectionAlive(entry.connection)) {
      return false;
    }

    return true;
  }

  /**
   * Reset session state for a connection.
   * Does not close the connection, just resets the session state.
   *
   * Use this when session state becomes inconsistent or after errors.
   *
   * @param {string} key - Connection key
   * @returns {boolean} True if reset was performed, false if not found
   */
  resetSession(key) {
    const meta = this._telnetMeta.get(key);

    if (!meta) {
      return false;
    }

    this._log('debug', `Resetting session state for key "${key}"`, { key });

    meta.stage = TelnetStage.INIT;
    meta.authenticated = false;
    meta.atPrompt = false;
    meta.hasError = false;
    meta.buffer = '';

    return true;
  }

  /**
   * Invalidate a session, marking it for reconnection.
   * The connection will be removed from the pool.
   *
   * @param {string} key - Connection key
   * @returns {boolean} True if session was invalidated, false if not found
   */
  invalidateSession(key) {
    this._log('debug', `Invalidating session for key "${key}"`, { key });
    return this.remove(key);
  }

  /**
   * Get extended statistics including Telnet-specific metrics
   * @returns {Object} Extended statistics object
   */
  getStats() {
    const baseStats = super.getStats();

    // Add Telnet-specific stats
    let authenticatedSessions = 0;
    let readySessions = 0;
    let sessionsWithErrors = 0;

    for (const meta of this._telnetMeta.values()) {
      if (meta.authenticated) {
        authenticatedSessions++;
      }
      if (meta.atPrompt && meta.stage === TelnetStage.READY) {
        readySessions++;
      }
      if (meta.hasError) {
        sessionsWithErrors++;
      }
    }

    return {
      ...baseStats,
      authenticatedSessions,
      readySessions,
      sessionsWithErrors,
    };
  }
}

export default TelnetConnectionPool;
