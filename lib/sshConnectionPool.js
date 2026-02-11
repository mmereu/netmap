/**
 * SSH-specific connection pool for managing reusable SSH connections.
 *
 * Extends the generic ConnectionPool with:
 * - SSH-specific connection validation (socket state, keepalive)
 * - Proper handling of SSH connection events (error, close, end)
 * - Connection key generation with host:port:username
 * - Shell session tracking per connection
 * - Shell state management (ready, EOF/close handling)
 *
 * Shell Session Caching:
 * - Each pooled connection can maintain an associated shell session
 * - Shell sessions are reused across command executions for performance
 * - Shell EOF/close events trigger automatic cleanup
 * - Shell state can be verified before reuse
 *
 * Usage:
 *   const pool = new SSHConnectionPool({ maxConnections: 10 });
 *   const key = pool.generateKey('192.168.1.1', 22, 'admin');
 *   const conn = await pool.acquire(key);
 *   // Use connection...
 *   pool.release(key);
 */

import ConnectionPool from './connectionPool.js';

/**
 * SSH connection pool entry metadata
 * @typedef {Object} SSHConnectionMeta
 * @property {import('ssh2').Client} connection - The SSH client
 * @property {import('stream').Duplex} [shell] - Active shell stream if any
 * @property {boolean} shellReady - Whether shell is ready at prompt
 * @property {boolean} shellError - Whether shell has encountered an error
 * @property {Object} credentials - Original connection credentials
 * @property {Function[]} shellCleanupHandlers - Event handlers to remove on shell close
 */

class SSHConnectionPool extends ConnectionPool {
  /**
   * Create a new SSHConnectionPool instance
   * @param {Object} options - Pool configuration options
   * @param {number} [options.maxConnections=10] - Maximum connections in pool
   * @param {number} [options.idleTimeout=300000] - Idle timeout in ms (default: 5 minutes)
   * @param {number} [options.healthCheckInterval=60000] - Health check interval in ms (default: 1 minute)
   * @param {number} [options.healthCheckTimeout=5000] - Timeout for health checks in ms
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {string} [options.name='SSHConnectionPool'] - Pool name for logging
   * @param {Function} [options.logger] - Custom logger function
   */
  constructor(options = {}) {
    super({
      ...options,
      name: options.name || 'SSHConnectionPool',
    });

    // Additional SSH-specific tracking
    // Maps connection key to { shell, shellReady, credentials, eventsBound }
    this._sshMeta = new Map();
  }

  /**
   * Generate unique key for SSH connection identification
   * @param {string} host - Host address
   * @param {number} port - SSH port (default: 22)
   * @param {string} username - Username for authentication
   * @returns {string} Unique connection key
   */
  generateKey(host, port = 22, username) {
    return `${host}:${port}:${username}`;
  }

  /**
   * Check if an SSH connection is still alive.
   *
   * Performs connection validation by checking:
   * 1. SSH client object exists
   * 2. Underlying socket exists and is writable
   * 3. Socket is not destroyed
   *
   * @param {import('ssh2').Client} connection - SSH client to check
   * @returns {boolean} True if connection is alive
   */
  isConnectionAlive(connection) {
    if (!connection) {
      return false;
    }

    // Check if the SSH client has an active socket
    // ssh2 Client stores socket in _sock property
    const socket = connection._sock;
    if (!socket) {
      return false;
    }

    // Check socket state
    if (socket.destroyed) {
      return false;
    }

    if (!socket.writable) {
      return false;
    }

    return true;
  }

  /**
   * Close an SSH connection properly
   * @param {import('ssh2').Client} connection - SSH client to close
   */
  closeConnection(connection) {
    if (!connection) {
      return;
    }

    try {
      // End the SSH connection gracefully
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
   * Add an SSH connection to the pool with event handlers
   * @param {string} key - Connection key
   * @param {import('ssh2').Client} connection - SSH client
   * @param {Object} [credentials] - Original credentials used to create connection
   * @param {string} [credentials.host] - Host address
   * @param {number} [credentials.port] - SSH port
   * @param {string} [credentials.username] - Username
   * @returns {boolean} True if added, false if pool is full
   */
  add(key, connection, credentials = null) {
    // Call parent add first
    const added = super.add(key, connection);

    if (added) {
      // Set up SSH-specific metadata
      this._sshMeta.set(key, {
        shell: null,
        shellReady: false,
        shellError: false,
        credentials: credentials,
        eventsBound: false,
        shellCleanupHandlers: [],
      });

      // Bind connection event handlers for automatic cleanup
      this._bindConnectionEvents(key, connection);
    }

    return added;
  }

  /**
   * Remove an SSH connection from the pool
   * @param {string} key - Connection key
   * @returns {boolean} True if removed, false if not found
   */
  remove(key) {
    // Clean up SSH metadata first
    const meta = this._sshMeta.get(key);
    if (meta) {
      // Clean up shell properly (removes event handlers and closes stream)
      this._cleanupShell(key, meta);
      this._sshMeta.delete(key);
    }

    // Call parent remove
    return super.remove(key);
  }

  /**
   * Clear all connections from the pool
   */
  clear() {
    // Clean up all SSH metadata first (properly removes event handlers)
    for (const [key, meta] of this._sshMeta.entries()) {
      this._cleanupShell(key, meta);
    }
    this._sshMeta.clear();

    // Call parent clear
    super.clear();
  }

  /**
   * Bind SSH connection event handlers for automatic cleanup
   * @param {string} key - Connection key
   * @param {import('ssh2').Client} connection - SSH client
   * @private
   */
  _bindConnectionEvents(key, connection) {
    const meta = this._sshMeta.get(key);
    if (!meta || meta.eventsBound) {
      return;
    }

    const handleClose = () => {
      this._log('debug', `SSH connection closed event for key "${key}"`, { key });
      this.remove(key);
    };

    const handleEnd = () => {
      this._log('debug', `SSH connection end event for key "${key}"`, { key });
      this.remove(key);
    };

    const handleError = (err) => {
      this._log('warn', `SSH connection error for key "${key}": ${err.message}`, { key, error: err.message });
      this.recordError(`SSH connection error: ${err.message}`);
      this.remove(key);
    };

    // Bind handlers
    connection.on('close', handleClose);
    connection.on('end', handleEnd);
    connection.on('error', handleError);

    meta.eventsBound = true;
  }

  /**
   * Get SSH-specific metadata for a connection
   * @param {string} key - Connection key
   * @returns {Object|null} SSH metadata or null if not found
   */
  getSSHMeta(key) {
    return this._sshMeta.get(key) || null;
  }

  /**
   * Store a shell session for a connection
   * @param {string} key - Connection key
   * @param {import('stream').Duplex} shell - Shell stream
   */
  setShell(key, shell) {
    const meta = this._sshMeta.get(key);
    if (!meta) {
      return;
    }

    // Clean up existing shell if any
    if (meta.shell && meta.shell !== shell) {
      this._cleanupShell(key, meta);
    }

    meta.shell = shell;
    meta.shellReady = false;
    meta.shellError = false;
    meta.shellCleanupHandlers = [];

    // Bind shell events for automatic cleanup and state tracking
    if (shell) {
      const handleClose = () => {
        this._log('debug', `Shell closed for key "${key}"`, { key });
        if (meta.shell === shell) {
          meta.shell = null;
          meta.shellReady = false;
        }
      };

      const handleEnd = () => {
        this._log('debug', `Shell EOF/end for key "${key}"`, { key });
        if (meta.shell === shell) {
          meta.shell = null;
          meta.shellReady = false;
        }
      };

      const handleError = (err) => {
        this._log('warn', `Shell error for key "${key}": ${err.message}`, { key, error: err.message });
        if (meta.shell === shell) {
          meta.shellError = true;
          meta.shellReady = false;
        }
      };

      // Store handlers for later cleanup
      meta.shellCleanupHandlers = [
        { event: 'close', handler: handleClose },
        { event: 'end', handler: handleEnd },
        { event: 'error', handler: handleError },
      ];

      // Bind handlers
      shell.on('close', handleClose);
      shell.on('end', handleEnd);
      shell.on('error', handleError);
    }
  }

  /**
   * Clean up a shell session, removing event handlers and closing the stream
   * @param {string} key - Connection key
   * @param {Object} meta - SSH metadata object
   * @private
   */
  _cleanupShell(key, meta) {
    if (!meta || !meta.shell) {
      return;
    }

    const shell = meta.shell;

    // Remove event handlers to prevent memory leaks
    if (meta.shellCleanupHandlers && meta.shellCleanupHandlers.length > 0) {
      for (const { event, handler } of meta.shellCleanupHandlers) {
        try {
          shell.removeListener(event, handler);
        } catch (err) {
          // Ignore - handler may already be removed
        }
      }
      meta.shellCleanupHandlers = [];
    }

    // Close the shell stream
    try {
      shell.end();
    } catch (err) {
      // Ignore close errors
    }

    meta.shell = null;
    meta.shellReady = false;
    meta.shellError = false;

    this._log('debug', `Shell cleaned up for key "${key}"`, { key });
  }

  /**
   * Get the shell session for a connection
   * @param {string} key - Connection key
   * @returns {import('stream').Duplex|null} Shell stream or null
   */
  getShell(key) {
    const meta = this._sshMeta.get(key);
    return meta ? meta.shell : null;
  }

  /**
   * Set shell ready state
   * @param {string} key - Connection key
   * @param {boolean} ready - Whether shell is at prompt and ready
   */
  setShellReady(key, ready) {
    const meta = this._sshMeta.get(key);
    if (meta) {
      meta.shellReady = ready;
    }
  }

  /**
   * Check if shell is ready (at prompt)
   * @param {string} key - Connection key
   * @returns {boolean} True if shell is ready
   */
  isShellReady(key) {
    const meta = this._sshMeta.get(key);
    return meta ? meta.shellReady : false;
  }

  /**
   * Get credentials for a connection (useful for reconnection)
   * @param {string} key - Connection key
   * @returns {Object|null} Credentials object or null
   */
  getCredentials(key) {
    const meta = this._sshMeta.get(key);
    return meta ? meta.credentials : null;
  }

  /**
   * Check if shell has encountered an error
   * @param {string} key - Connection key
   * @returns {boolean} True if shell has an error
   */
  hasShellError(key) {
    const meta = this._sshMeta.get(key);
    return meta ? meta.shellError : false;
  }

  /**
   * Check if a cached shell is usable for command execution.
   *
   * A shell is usable when:
   * - It exists in the pool
   * - It has no errors
   * - The underlying stream is writable
   *
   * @param {string} key - Connection key
   * @returns {boolean} True if shell is usable
   */
  isShellUsable(key) {
    const meta = this._sshMeta.get(key);

    if (!meta || !meta.shell) {
      return false;
    }

    // Check for error state
    if (meta.shellError) {
      return false;
    }

    // Check stream state
    const shell = meta.shell;
    if (shell.destroyed || !shell.writable) {
      return false;
    }

    return true;
  }

  /**
   * Invalidate a shell session, marking it for recreation.
   * Does not close the connection, just the shell.
   *
   * Use this when shell state becomes inconsistent (e.g., unexpected output,
   * prompts not matching, or after certain error conditions).
   *
   * @param {string} key - Connection key
   * @returns {boolean} True if shell was invalidated, false if not found
   */
  invalidateShell(key) {
    const meta = this._sshMeta.get(key);

    if (!meta) {
      return false;
    }

    if (meta.shell) {
      this._log('debug', `Invalidating shell for key "${key}"`, { key });
      this._cleanupShell(key, meta);
      return true;
    }

    return false;
  }

  /**
   * Force reset a shell to initial state by closing it.
   * A new shell will need to be created on next command execution.
   *
   * This is useful for ensuring clean state between command batches
   * or when shell state becomes unpredictable.
   *
   * @param {string} key - Connection key
   * @returns {boolean} True if reset was performed, false if not found
   */
  resetShell(key) {
    return this.invalidateShell(key);
  }

  /**
   * Get extended statistics including SSH-specific metrics
   * @returns {Object} Extended statistics object
   */
  getStats() {
    const baseStats = super.getStats();

    // Add SSH-specific stats
    let connectionsWithShell = 0;
    let readyShells = 0;
    let shellsWithErrors = 0;

    for (const meta of this._sshMeta.values()) {
      if (meta.shell) {
        connectionsWithShell++;
        if (meta.shellReady) {
          readyShells++;
        }
      }
      if (meta.shellError) {
        shellsWithErrors++;
      }
    }

    return {
      ...baseStats,
      connectionsWithShell,
      readyShells,
      shellsWithErrors,
    };
  }
}

export default SSHConnectionPool;
