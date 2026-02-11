/**
 * Generic connection pool manager for reusing network connections.
 *
 * Manages pooled connections with:
 * - Connection storage by unique key (host:port:username)
 * - Maximum pool size configuration
 * - Connection idle timeout tracking
 * - Automatic cleanup of stale connections
 * - Thread-safe acquire/release pattern
 * - Health checking mechanism to verify connections are alive
 * - Debug logging for pool operations
 *
 * Health Checking:
 * - Periodic health checks run at configurable intervals
 * - Subclasses must override isConnectionAlive() for protocol-specific validation
 * - Dead connections are automatically removed from pool
 * - Connection metadata tracks last activity and health check times
 *
 * Debug Logging:
 * - Enable with debug: true option in constructor
 * - Logs acquire/release/cleanup operations
 * - Custom logger can be provided via logger option
 */
class ConnectionPool {
  /**
   * Create a new ConnectionPool instance
   * @param {Object} options - Pool configuration options
   * @param {number} [options.maxConnections=10] - Maximum connections in pool
   * @param {number} [options.idleTimeout=300000] - Idle timeout in ms (default: 5 minutes)
   * @param {number} [options.healthCheckInterval=60000] - Health check interval in ms (default: 1 minute)
   * @param {number} [options.healthCheckTimeout=5000] - Timeout for individual health checks in ms (default: 5 seconds)
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {string} [options.name='ConnectionPool'] - Pool name for logging
   * @param {Function} [options.logger] - Custom logger function (receives level, message, data)
   */
  constructor(options = {}) {
    this.options = {
      maxConnections: options.maxConnections || 10,
      idleTimeout: options.idleTimeout || 300000,
      healthCheckInterval: options.healthCheckInterval || 60000,
      healthCheckTimeout: options.healthCheckTimeout || 5000,
      debug: options.debug || false,
      name: options.name || 'ConnectionPool',
      logger: options.logger || null,
    };

    // Connection storage: Map<key, ConnectionEntry>
    // ConnectionEntry: { connection, lastActivity, inUse, createdAt, lastHealthCheck, healthCheckPassed }
    this._connections = new Map();

    // Health check interval reference
    this._healthCheckIntervalId = null;

    // Track if health check is currently running to prevent overlap
    this._healthCheckRunning = false;

    // Statistics tracking
    this._stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      evictions: 0,
      healthChecks: 0,
      healthCheckFailures: 0,
    };

    // Start health check interval
    this._startHealthCheck();

    this._log('debug', 'Pool initialized', {
      maxConnections: this.options.maxConnections,
      idleTimeout: this.options.idleTimeout,
      healthCheckInterval: this.options.healthCheckInterval,
    });
  }

  /**
   * Internal logging method
   * @param {string} level - Log level ('debug', 'info', 'warn', 'error')
   * @param {string} message - Log message
   * @param {Object} [data] - Optional structured data to include
   * @private
   */
  _log(level, message, data = null) {
    if (!this.options.debug) {
      return;
    }

    const prefix = `[${this.options.name}]`;
    const timestamp = new Date().toISOString();

    // Use custom logger if provided
    if (this.options.logger && typeof this.options.logger === 'function') {
      this.options.logger(level, message, data, { prefix, timestamp });
      return;
    }

    // Default console logging
    const logFn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
        : console.log;

    if (data) {
      logFn(`${prefix} ${message}`, data);
    } else {
      logFn(`${prefix} ${message}`);
    }
  }

  /**
   * Generate unique key for connection identification
   * @param {string} host - Host address
   * @param {number} port - Port number
   * @param {string} username - Username for authentication
   * @returns {string} Unique connection key
   */
  generateKey(host, port, username) {
    return `${host}:${port}:${username}`;
  }

  /**
   * Acquire an existing connection from the pool
   * Validates connection is alive before returning it.
   *
   * @param {string} key - Connection key (host:port:username)
   * @param {Object} [options] - Acquire options
   * @param {boolean} [options.skipHealthCheck=false] - Skip health check (use cached result)
   * @returns {Promise<Object|null>} Connection object or null if not available
   */
  async acquire(key, options = {}) {
    const entry = this._connections.get(key);

    if (!entry) {
      this._stats.misses++;
      this._log('debug', `Acquire miss: no connection for key "${key}"`, { key, poolSize: this._connections.size });
      return null;
    }

    // Check if connection is already in use
    if (entry.inUse) {
      this._stats.misses++;
      this._log('debug', `Acquire miss: connection in use for key "${key}"`, { key });
      return null;
    }

    // Check if connection is still alive (subclasses should override isConnectionAlive)
    // Support both sync and async isConnectionAlive implementations
    const skipHealthCheck = options.skipHealthCheck || false;

    if (!skipHealthCheck) {
      try {
        const isAlive = await Promise.resolve(this.isConnectionAlive(entry.connection));
        if (!isAlive) {
          this._log('warn', `Acquire: connection dead for key "${key}", removing`, { key });
          this.remove(key);
          this._stats.misses++;
          this._stats.healthCheckFailures++;
          entry.healthCheckPassed = false;
          return null;
        }
        // Update health check tracking
        entry.lastHealthCheck = Date.now();
        entry.healthCheckPassed = true;
      } catch (err) {
        // Health check threw an error - connection is dead
        this._log('warn', `Acquire: health check error for key "${key}", removing`, { key, error: err.message });
        this.remove(key);
        this._stats.misses++;
        this._stats.healthCheckFailures++;
        return null;
      }
    }

    // Mark as in use and update activity timestamp
    entry.inUse = true;
    entry.lastActivity = Date.now();
    this._stats.hits++;

    this._log('debug', `Acquire hit: reusing connection for key "${key}"`, {
      key,
      poolSize: this._connections.size,
      hitRate: this._stats.hits + this._stats.misses > 0
        ? ((this._stats.hits / (this._stats.hits + this._stats.misses)) * 100).toFixed(1) + '%'
        : '0%',
    });

    return entry.connection;
  }

  /**
   * Release a connection back to the pool
   * @param {string} key - Connection key
   * @returns {boolean} True if connection was released, false if not found
   */
  release(key) {
    const entry = this._connections.get(key);

    if (!entry) {
      this._log('warn', `Release: no connection found for key "${key}"`, { key });
      return false;
    }

    entry.inUse = false;
    entry.lastActivity = Date.now();

    this._log('debug', `Released connection for key "${key}"`, {
      key,
      poolSize: this._connections.size,
      idleConnections: Array.from(this._connections.values()).filter(e => !e.inUse).length,
    });

    return true;
  }

  /**
   * Add a new connection to the pool
   * @param {string} key - Connection key
   * @param {Object} connection - Connection object to store
   * @returns {boolean} True if added, false if pool is full
   */
  add(key, connection) {
    // Check pool size limit
    if (this._connections.size >= this.options.maxConnections) {
      this._log('debug', `Pool at capacity (${this.options.maxConnections}), attempting eviction`, { key });
      // Try to evict idle connections first
      this._evictIdleConnections();

      // If still at capacity, reject
      if (this._connections.size >= this.options.maxConnections) {
        this._log('warn', `Pool full, cannot add connection for key "${key}"`, {
          key,
          maxConnections: this.options.maxConnections,
        });
        return false;
      }
    }

    const now = Date.now();
    const entry = {
      connection,
      lastActivity: now,
      createdAt: now,
      inUse: false,
      // Health check tracking
      lastHealthCheck: now, // New connections are assumed healthy
      healthCheckPassed: true,
    };

    this._connections.set(key, entry);

    this._log('debug', `Added new connection for key "${key}"`, {
      key,
      poolSize: this._connections.size,
      maxConnections: this.options.maxConnections,
    });

    return true;
  }

  /**
   * Remove a connection from the pool
   * @param {string} key - Connection key
   * @returns {boolean} True if removed, false if not found
   */
  remove(key) {
    const entry = this._connections.get(key);

    if (!entry) {
      return false;
    }

    // Close connection before removing (subclasses should override closeConnection)
    this.closeConnection(entry.connection);
    this._connections.delete(key);

    this._log('debug', `Removed connection for key "${key}"`, {
      key,
      poolSize: this._connections.size,
    });

    return true;
  }

  /**
   * Check if a connection is still alive.
   *
   * IMPORTANT: Subclasses MUST override this method with protocol-specific validation.
   *
   * For SSH connections, this should check:
   * - SSH client connection state (client.connected)
   * - Optionally send a keepalive or simple command
   *
   * For Telnet/socket connections, this should check:
   * - Socket writable state
   * - Socket destroyed state
   *
   * This method can be synchronous or asynchronous (return a Promise).
   * The acquire() method will await the result.
   *
   * @param {Object} connection - Connection to check
   * @returns {boolean|Promise<boolean>} True if connection is alive
   *
   * @example
   * // SSH connection check (sync)
   * isConnectionAlive(sshClient) {
   *   return sshClient && sshClient._sock && !sshClient._sock.destroyed;
   * }
   *
   * @example
   * // Socket connection check (sync)
   * isConnectionAlive(socket) {
   *   return socket && socket.writable && !socket.destroyed;
   * }
   *
   * @example
   * // Async connection check with command
   * async isConnectionAlive(connection) {
   *   try {
   *     await this._sendKeepAlive(connection);
   *     return true;
   *   } catch {
   *     return false;
   *   }
   * }
   */
  isConnectionAlive(connection) {
    // Default implementation - subclasses should override with protocol-specific checks
    return connection !== null && connection !== undefined;
  }

  /**
   * Close a connection
   * Subclasses should override this method with protocol-specific cleanup
   * @param {Object} connection - Connection to close
   */
  closeConnection(connection) {
    // Default implementation - subclasses should override
    if (connection && typeof connection.end === 'function') {
      connection.end();
    }
  }

  /**
   * Cleanup idle connections based on timeout
   * @returns {number} Number of connections cleaned up
   */
  cleanup() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this._connections.entries()) {
      // Skip connections currently in use
      if (entry.inUse) {
        continue;
      }

      // Check if connection has exceeded idle timeout
      const idleTime = now - entry.lastActivity;
      if (idleTime >= this.options.idleTimeout) {
        this._log('debug', `Evicting idle connection for key "${key}"`, {
          key,
          idleTime,
          idleTimeout: this.options.idleTimeout,
        });
        this.remove(key);
        this._stats.evictions++;
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this._log('info', `Cleanup completed: evicted ${cleanedCount} idle connection(s)`, {
        evicted: cleanedCount,
        remaining: this._connections.size,
      });
    }

    return cleanedCount;
  }

  /**
   * Get current pool statistics
   * @returns {Object} Statistics object with hits, misses, errors, evictions, health checks
   */
  getStats() {
    const totalConnections = this._connections.size;
    let activeConnections = 0;
    let idleConnections = 0;

    for (const entry of this._connections.values()) {
      if (entry.inUse) {
        activeConnections++;
      } else {
        idleConnections++;
      }
    }

    return {
      hits: this._stats.hits,
      misses: this._stats.misses,
      errors: this._stats.errors,
      evictions: this._stats.evictions,
      healthChecks: this._stats.healthChecks,
      healthCheckFailures: this._stats.healthCheckFailures,
      totalConnections,
      activeConnections,
      idleConnections,
      hitRate: this._stats.hits + this._stats.misses > 0
        ? (this._stats.hits / (this._stats.hits + this._stats.misses) * 100).toFixed(2) + '%'
        : '0%',
      healthCheckSuccessRate: this._stats.healthChecks > 0
        ? (((this._stats.healthChecks - this._stats.healthCheckFailures) / this._stats.healthChecks) * 100).toFixed(2) + '%'
        : '100%',
    };
  }

  /**
   * Reset statistics counters (useful for testing)
   */
  resetStats() {
    this._stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      evictions: 0,
      healthChecks: 0,
      healthCheckFailures: 0,
    };
  }

  /**
   * Get number of connections in the pool
   * @returns {number} Number of connections
   */
  size() {
    return this._connections.size;
  }

  /**
   * Check if pool has a connection for the given key
   * @param {string} key - Connection key
   * @returns {boolean} True if connection exists
   */
  has(key) {
    return this._connections.has(key);
  }

  /**
   * Get all connection keys in the pool
   * @returns {string[]} Array of connection keys
   */
  keys() {
    return Array.from(this._connections.keys());
  }

  /**
   * Clear all connections from the pool
   */
  clear() {
    const count = this._connections.size;
    if (count > 0) {
      this._log('info', `Clearing all ${count} connection(s) from pool`, { count });
    }
    for (const [key] of this._connections.entries()) {
      this.remove(key);
    }
  }

  /**
   * Shutdown the pool, closing all connections and stopping health checks
   */
  shutdown() {
    this._log('info', 'Shutting down pool', { stats: this.getStats() });
    this._stopHealthCheck();
    this.clear();
  }

  /**
   * Start the health check interval
   * @private
   */
  _startHealthCheck() {
    if (this._healthCheckIntervalId) {
      return;
    }

    this._healthCheckIntervalId = setInterval(() => {
      this._performHealthCheck();
    }, this.options.healthCheckInterval);

    // Ensure interval doesn't prevent process exit
    if (this._healthCheckIntervalId.unref) {
      this._healthCheckIntervalId.unref();
    }
  }

  /**
   * Stop the health check interval
   * @private
   */
  _stopHealthCheck() {
    if (this._healthCheckIntervalId) {
      clearInterval(this._healthCheckIntervalId);
      this._healthCheckIntervalId = null;
    }
  }

  /**
   * Perform health check on all connections
   * Supports both sync and async isConnectionAlive implementations.
   * @private
   */
  async _performHealthCheck() {
    // Prevent overlapping health checks
    if (this._healthCheckRunning) {
      return;
    }

    this._healthCheckRunning = true;
    let failedCount = 0;
    let checkedCount = 0;

    try {
      const keysToCheck = [];

      // Collect keys of idle connections to check
      for (const [key, entry] of this._connections.entries()) {
        if (!entry.inUse) {
          keysToCheck.push(key);
        }
      }

      if (keysToCheck.length > 0) {
        this._log('debug', `Starting health check on ${keysToCheck.length} idle connection(s)`, {
          idleConnections: keysToCheck.length,
          totalConnections: this._connections.size,
        });
      }

      // Check each connection
      for (const key of keysToCheck) {
        const entry = this._connections.get(key);

        // Entry may have been removed or acquired while we were checking others
        if (!entry || entry.inUse) {
          continue;
        }

        this._stats.healthChecks++;
        checkedCount++;

        try {
          // Support both sync and async isConnectionAlive
          const isAlive = await Promise.race([
            Promise.resolve(this.isConnectionAlive(entry.connection)),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Health check timeout')), this.options.healthCheckTimeout)
            ),
          ]);

          entry.lastHealthCheck = Date.now();
          entry.healthCheckPassed = isAlive;

          if (!isAlive) {
            this._log('debug', `Health check failed for key "${key}", removing`, { key });
            this.remove(key);
            this._stats.evictions++;
            this._stats.healthCheckFailures++;
            failedCount++;
          }
        } catch (err) {
          // Health check failed (timeout or error) - connection is considered dead
          this._log('debug', `Health check error for key "${key}": ${err.message}, removing`, { key, error: err.message });
          entry.healthCheckPassed = false;
          this.remove(key);
          this._stats.evictions++;
          this._stats.healthCheckFailures++;
          failedCount++;
        }
      }

      // Also run idle cleanup
      this.cleanup();

      if (checkedCount > 0) {
        this._log('debug', `Health check completed: ${checkedCount} checked, ${failedCount} failed`, {
          checked: checkedCount,
          failed: failedCount,
          remaining: this._connections.size,
        });
      }
    } finally {
      this._healthCheckRunning = false;
    }
  }

  /**
   * Evict idle connections to make room for new ones
   * @private
   */
  _evictIdleConnections() {
    // Sort entries by last activity (oldest first)
    const entries = Array.from(this._connections.entries())
      .filter(([, entry]) => !entry.inUse)
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity);

    let evictedCount = 0;

    // Evict oldest idle connections until we have room
    for (const [key] of entries) {
      if (this._connections.size < this.options.maxConnections) {
        break;
      }
      this._log('debug', `Evicting oldest idle connection for key "${key}" to make room`, { key });
      this.remove(key);
      this._stats.evictions++;
      evictedCount++;
    }

    if (evictedCount > 0) {
      this._log('debug', `Evicted ${evictedCount} connection(s) to make room`, {
        evicted: evictedCount,
        remaining: this._connections.size,
      });
    }
  }

  /**
   * Increment error counter (for external use when connection operations fail)
   * @param {string} [context] - Optional context about the error
   */
  recordError(context = null) {
    this._stats.errors++;
    if (context) {
      this._log('warn', `Error recorded: ${context}`, { totalErrors: this._stats.errors });
    }
  }

  /**
   * Enable or disable debug logging at runtime
   * @param {boolean} enabled - Whether to enable debug logging
   */
  setDebug(enabled) {
    this.options.debug = Boolean(enabled);
    this._log('info', `Debug logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get connection metadata for debugging
   * @param {string} key - Connection key
   * @returns {Object|null} Metadata object or null if not found
   */
  getConnectionMeta(key) {
    const entry = this._connections.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();

    return {
      key,
      inUse: entry.inUse,
      lastActivity: entry.lastActivity,
      createdAt: entry.createdAt,
      idleTime: now - entry.lastActivity,
      age: now - entry.createdAt,
      // Health check metadata
      lastHealthCheck: entry.lastHealthCheck,
      healthCheckPassed: entry.healthCheckPassed,
      timeSinceHealthCheck: now - entry.lastHealthCheck,
    };
  }

  /**
   * Manually trigger a health check on all connections
   * Useful for testing or when recovering from network issues.
   * @returns {Promise<void>}
   */
  async runHealthCheck() {
    await this._performHealthCheck();
  }

  /**
   * Check if health check is currently running
   * @returns {boolean} True if health check is in progress
   */
  isHealthCheckRunning() {
    return this._healthCheckRunning;
  }
}

export default ConnectionPool;
