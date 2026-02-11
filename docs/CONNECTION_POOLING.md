# Connection Pooling for SSH/Telnet Switch Connections

## Overview

Connection pooling optimizes network switch operations by reusing established SSH and Telnet connections across multiple command executions. This eliminates the overhead of creating new connections for each command, significantly improving performance for batch operations.

### Performance Benefits

| Scenario | Without Pooling | With Pooling | Improvement |
|----------|-----------------|--------------|-------------|
| Single command | ~500ms overhead | ~500ms (first) / ~0ms (reuse) | - |
| 10 commands to same switch | ~5s overhead | ~500ms overhead | ~90% faster |
| 50 device batch discovery | ~25s overhead | ~2-5s overhead | ~80-90% faster |

**Key insight**: Each SSH connection involves TCP handshake, SSH key exchange, and authentication (~500ms). Connection pooling eliminates this overhead for subsequent commands.

## Quick Start

### SwitchSSH with Pooling

```javascript
import SwitchSSH from './lib/switchSSH.js';

// Create instance with pooling enabled
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: {
    maxConnections: 10,
    idleTimeout: 300000,  // 5 minutes
    debug: false
  }
});

// Execute commands using pooled connections
const output = await ssh.executeCommandPooled({
  host: '192.168.1.1',
  username: 'admin',
  password: 'password',
  command: 'display version'
});

// Connection is automatically reused for next command
const output2 = await ssh.executeCommandPooled({
  host: '192.168.1.1',
  username: 'admin',
  password: 'password',
  command: 'display lldp neighbor'
});

// Cleanup when done
ssh.shutdownPool();
```

### SwitchTelnet with Pooling

```javascript
import SwitchTelnet from './lib/switchTelnet.js';

// Create instance with pooling enabled
const telnet = new SwitchTelnet({
  usePool: true,
  poolConfig: {
    maxConnections: 10,
    idleTimeout: 300000,
    debug: false
  }
});

// Execute commands using pooled connections
const output = await telnet.executeCommandPooled({
  host: '192.168.1.1',
  username: 'admin',
  password: 'password',
  command: 'display version'
});

// Cleanup when done
telnet.shutdownPool();
```

## Architecture

### Component Hierarchy

```
ConnectionPool (base class)
├── SSHConnectionPool
│   └── Used by SwitchSSH
└── TelnetConnectionPool
    └── Used by SwitchTelnet
```

### Files

| File | Description |
|------|-------------|
| `lib/connectionPool.js` | Generic connection pool with health checking |
| `lib/sshConnectionPool.js` | SSH-specific pool with shell session caching |
| `lib/telnetConnectionPool.js` | Telnet-specific pool with session state tracking |
| `lib/switchSSH.js` | SSH client with optional pooling |
| `lib/switchTelnet.js` | Telnet client with optional pooling |

## Configuration Options

### Pool Configuration

All pool configuration is passed via `poolConfig` object in the constructor:

```javascript
const config = {
  usePool: true,           // Enable pooling
  poolConfig: {
    maxConnections: 10,    // Maximum connections in pool
    idleTimeout: 300000,   // Idle timeout in ms (5 min default)
    healthCheckInterval: 60000,  // Health check interval (1 min default)
    healthCheckTimeout: 5000,    // Timeout for health checks (5s default)
    debug: false,          // Enable debug logging
    name: 'MyPool',        // Pool name for logging
    logger: null           // Custom logger function
  }
};
```

### Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxConnections` | number | 10 | Maximum number of connections to keep in pool |
| `idleTimeout` | number | 300000 | Time in ms before idle connections are evicted (5 min) |
| `healthCheckInterval` | number | 60000 | Interval for periodic health checks (1 min) |
| `healthCheckTimeout` | number | 5000 | Timeout for individual health check operations (5s) |
| `debug` | boolean | false | Enable debug logging for pool operations |
| `name` | string | varies | Pool name used in log messages |
| `logger` | function | null | Custom logger function `(level, message, data)` |

### Custom Logger Example

```javascript
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: {
    debug: true,
    logger: (level, message, data, meta) => {
      console.log(`[${meta.timestamp}] ${level.toUpperCase()}: ${message}`, data || '');
    }
  }
});
```

## API Reference

### SwitchSSH Pooled Methods

#### `executeCommandPooled(options)`

Execute a single command using a pooled connection.

```javascript
const output = await ssh.executeCommandPooled({
  host: '192.168.1.1',
  port: 22,              // optional, default: 22
  username: 'admin',
  password: 'password',
  command: 'display version',
  timeout: 30000,        // optional, default: shellTimeout
  disablePaging: true    // optional, default: true
});
```

#### `executeCommandsPooled(options)`

Execute multiple commands using a single pooled connection.

```javascript
const results = await ssh.executeCommandsPooled({
  host: '192.168.1.1',
  username: 'admin',
  password: 'password',
  commands: ['display version', 'display lldp neighbor'],
  disablePaging: true
});

// results = [
//   { command: 'display version', output: '...', success: true },
//   { command: 'display lldp neighbor', output: '...', success: true }
// ]
```

#### Pool Management Methods

```javascript
// Get pool statistics
const stats = ssh.getPoolStats();
// { hits: 10, misses: 2, hitRate: '83.33%', totalConnections: 3, ... }

// Get the pool instance for advanced usage
const pool = ssh.getPool();

// Release a specific connection back to pool
ssh.releasePooledConnection('192.168.1.1', 22, 'admin');

// Remove a connection from pool (force close)
ssh.removePooledConnection('192.168.1.1', 22, 'admin');

// Reset shell session (keep connection, recreate shell)
ssh.resetPooledShell('192.168.1.1', 22, 'admin');

// Check if a pooled shell is usable
const usable = ssh.isPooledShellUsable('192.168.1.1', 22, 'admin');

// Clear all pooled connections
ssh.clearPool();

// Shutdown pool completely
ssh.shutdownPool();
```

### SwitchTelnet Pooled Methods

Similar API to SwitchSSH:

```javascript
// Execute single command
const output = await telnet.executeCommandPooled({
  host: '192.168.1.1',
  port: 23,              // optional, default: 23
  username: 'admin',
  password: 'password',
  command: 'display version'
});

// Execute multiple commands
const results = await telnet.executeCommandsPooled({
  host: '192.168.1.1',
  username: 'admin',
  password: 'password',
  commands: ['display version', 'display lldp neighbor']
});

// Pool management
const stats = telnet.getPoolStats();
telnet.resetPooledSession('192.168.1.1', 23, 'admin');
const usable = telnet.isPooledSessionUsable('192.168.1.1', 23, 'admin');
telnet.clearPool();
telnet.shutdownPool();
```

### Pool Statistics

```javascript
const stats = ssh.getPoolStats();

// Base statistics
stats.hits              // Number of connection reuses
stats.misses            // Number of cache misses
stats.hitRate           // Hit rate percentage (e.g., "85.00%")
stats.errors            // Number of recorded errors
stats.evictions         // Number of evicted connections
stats.healthChecks      // Number of health checks performed
stats.healthCheckFailures  // Number of failed health checks
stats.totalConnections  // Current pool size
stats.activeConnections // Connections in use
stats.idleConnections   // Available connections

// SSH-specific (SSHConnectionPool)
stats.connectionsWithShell  // Connections with cached shell
stats.readyShells          // Shells ready for commands
stats.shellsWithErrors     // Shells with errors

// Telnet-specific (TelnetConnectionPool)
stats.authenticatedSessions  // Authenticated sessions
stats.readySessions         // Sessions ready for commands
stats.sessionsWithErrors    // Sessions with errors
```

## Migration Guide

### From Non-Pooled to Pooled Code

#### Before (Non-Pooled)

```javascript
import SwitchSSH from './lib/switchSSH.js';

const ssh = new SwitchSSH();

// Each call creates a new connection
for (const device of devices) {
  const output = await ssh.executeCommand({
    host: device.ip,
    username: 'admin',
    password: 'password',
    command: 'display lldp neighbor'
  });
}
```

#### After (Pooled)

```javascript
import SwitchSSH from './lib/switchSSH.js';

// Enable pooling in constructor
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: { maxConnections: 10 }
});

try {
  // Connections are reused automatically
  for (const device of devices) {
    const output = await ssh.executeCommandPooled({
      host: device.ip,
      username: 'admin',
      password: 'password',
      command: 'display lldp neighbor'
    });
  }
} finally {
  // Clean up when done
  ssh.clearPool();
}
```

### Backward Compatibility

**Original methods are unchanged.** You can continue using `executeCommand()` and `executeCommands()` without any changes:

```javascript
const ssh = new SwitchSSH({ usePool: true });

// These still work exactly as before (no pooling)
await ssh.executeCommand({ ... });
await ssh.executeCommands({ ... });

// Only these new methods use pooling
await ssh.executeCommandPooled({ ... });
await ssh.executeCommandsPooled({ ... });
```

### Mixed Usage

You can use both pooled and non-pooled methods on the same instance:

```javascript
const ssh = new SwitchSSH({ usePool: true });

// Non-pooled: creates new connection, closes after use
await ssh.executeCommand({ host: '192.168.1.1', ... });

// Pooled: reuses or creates connection, keeps in pool
await ssh.executeCommandPooled({ host: '192.168.1.1', ... });
```

## Best Practices

### 1. Enable Pooling for Batch Operations

```javascript
// Good: Enable pooling for discovery operations
const discovery = new LldpSshDiscovery(db, {
  usePool: true,
  poolConfig: { maxConnections: 20 }
});

await discovery.discoverZeroLinkDevices({ vendor: 'Huawei' });
```

### 2. Clean Up After Batch Operations

```javascript
try {
  for (const device of devices) {
    await ssh.executeCommandPooled({ ... });
  }
} finally {
  // Release resources after batch completes
  ssh.clearPool();
}
```

### 3. Shutdown on Application Exit

```javascript
// In server.js or main application
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  ssh.shutdownPool();
  telnet.shutdownPool();
  process.exit(0);
});
```

### 4. Configure Pool Size Based on Usage

```javascript
// For single-switch operations
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: { maxConnections: 5 }
});

// For multi-switch batch operations
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: { maxConnections: 20 }
});
```

### 5. Use Debug Mode for Troubleshooting

```javascript
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: {
    debug: true,
    name: 'SSH-Pool'
  }
});

// Output:
// [SSH-Pool] Pool initialized { maxConnections: 10, idleTimeout: 300000 }
// [SSH-Pool] Acquire miss: no connection for key "192.168.1.1:22:admin"
// [SSH-Pool] Added new connection for key "192.168.1.1:22:admin"
// [SSH-Pool] Acquire hit: reusing connection for key "192.168.1.1:22:admin"
```

## Troubleshooting

### Connection Not Being Reused

**Symptom**: Every command creates a new connection despite pooling enabled.

**Possible Causes**:
1. Using `executeCommand()` instead of `executeCommandPooled()`
2. Different credentials for same host (creates different pool key)
3. Connection removed due to errors

**Solution**:
```javascript
// Check pool stats
const stats = ssh.getPoolStats();
console.log('Hit rate:', stats.hitRate);
console.log('Errors:', stats.errors);

// Ensure using pooled methods
await ssh.executeCommandPooled({ ... });  // Correct
await ssh.executeCommand({ ... });        // Does not use pool
```

### Pool Running Out of Connections

**Symptom**: New connections fail with "Pool full" message.

**Solution**: Increase `maxConnections` or ensure connections are released:

```javascript
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: { maxConnections: 20 }  // Increase limit
});
```

### Stale Connections

**Symptom**: Commands fail on reused connections.

**Solution**: The pool automatically performs health checks, but you can:

```javascript
// Reduce idle timeout
const ssh = new SwitchSSH({
  usePool: true,
  poolConfig: {
    idleTimeout: 60000,        // 1 minute
    healthCheckInterval: 30000  // 30 seconds
  }
});

// Or manually reset connection
ssh.removePooledConnection('192.168.1.1', 22, 'admin');
```

### Shell State Issues (SSH)

**Symptom**: Commands return unexpected output or hang.

**Solution**: Reset the shell session:

```javascript
// Reset shell but keep connection
ssh.resetPooledShell('192.168.1.1', 22, 'admin');

// Or remove connection entirely
ssh.removePooledConnection('192.168.1.1', 22, 'admin');
```

## Server Integration

### Global Pool Instances

```javascript
// server.js
import SwitchSSH from './lib/switchSSH.js';
import SwitchTelnet from './lib/switchTelnet.js';

// Create global instances with pooling
const switchSsh = new SwitchSSH({
  usePool: true,
  poolConfig: {
    maxConnections: 20,
    idleTimeout: 300000,
    healthCheckInterval: 60000
  }
});

const switchTelnet = new SwitchTelnet({
  usePool: true,
  poolConfig: {
    maxConnections: 20,
    idleTimeout: 300000,
    healthCheckInterval: 60000
  }
});

// Use in request handlers
app.post('/api/switch/command', async (req, res) => {
  const output = await switchSsh.executeCommandPooled({
    host: req.body.host,
    username: req.body.username,
    password: req.body.password,
    command: req.body.command
  });
  res.json({ output });
});
```

### Debug Endpoint

```javascript
// Expose pool stats via API
app.get('/api/debug/pool-stats', (req, res) => {
  res.json({
    ssh: switchSsh.getPoolStats(),
    telnet: switchTelnet.getPoolStats()
  });
});
```

### Graceful Shutdown

```javascript
// Handle process termination
const shutdown = async () => {
  console.log('Shutting down pools...');

  // Log final stats
  console.log('SSH Pool stats:', switchSsh.getPoolStats());
  console.log('Telnet Pool stats:', switchTelnet.getPoolStats());

  // Shutdown pools
  switchSsh.shutdownPool();
  switchTelnet.shutdownPool();

  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## Testing

### Unit Tests

```bash
# Run ConnectionPool base class tests
node test/connectionPool.test.js

# Run SwitchSSH pooling tests
node test/switchSSH.pool.test.js
```

### Test Coverage

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| ConnectionPool | 155 | Constructor, acquire/release, health checks, statistics, concurrent access |
| SwitchSSH Pool | 119 | Constructor, backward compatibility, connection reuse, error recovery, shell management |

## Changelog

### 2024-12 - v1.0

- Initial implementation of connection pooling
- Created `ConnectionPool` base class with health checking
- Created `SSHConnectionPool` with shell session caching
- Created `TelnetConnectionPool` with session state tracking
- Updated `SwitchSSH` with `executeCommandPooled()` and `executeCommandsPooled()`
- Updated `SwitchTelnet` with `executeCommandPooled()` and `executeCommandsPooled()`
- Updated `LldpSshDiscovery` to use pooling by default
- Updated `server.js` with global pooled instances
- Added debug endpoint `/api/debug/pool-stats`
- Added graceful shutdown handlers
- Comprehensive test suites (274 tests total)

## References

- **SSH Client**: `lib/switchSSH.js`
- **Telnet Client**: `lib/switchTelnet.js`
- **LLDP Discovery**: `lib/lldpSshDiscovery.js`
- **Tests**: `test/connectionPool.test.js`, `test/switchSSH.pool.test.js`
