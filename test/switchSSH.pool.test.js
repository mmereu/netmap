#!/usr/bin/env node
/**
 * Integration tests for SwitchSSH connection pooling
 *
 * Tests cover:
 * - Multiple commands reuse same connection
 * - Pool recovery from connection errors
 * - Backward compatibility (non-pooled still works)
 * - Performance improvement metrics
 * - Shell session caching and reuse
 * - Pool lifecycle management
 */

import SwitchSSH from '../lib/switchSSH.js';
import SSHConnectionPool from '../lib/sshConnectionPool.js';
import { EventEmitter } from 'events';

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \u2705 ${message}`);
    testsPassed++;
  } else {
    console.log(`  \u274c ${message}`);
    testsFailed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  \u2705 ${message}`);
    testsPassed++;
  } else {
    console.log(`  \u274c ${message} (expected: ${expected}, got: ${actual})`);
    testsFailed++;
  }
}

function assertDeepEqual(actual, expected, message) {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  if (isEqual) {
    console.log(`  \u2705 ${message}`);
    testsPassed++;
  } else {
    console.log(`  \u274c ${message}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Got: ${JSON.stringify(actual)}`);
    testsFailed++;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
// MOCK SSH CLIENT AND STREAM
// ═══════════════════════════════════════════════════════════════════

/**
 * Mock SSH stream (shell) that simulates Huawei switch behavior
 */
class MockShellStream extends EventEmitter {
  constructor(options = {}) {
    super();
    this.destroyed = false;
    this.writable = true;
    this._promptDelay = options.promptDelay || 10;
    this._commandDelay = options.commandDelay || 20;
    this._hostname = options.hostname || 'Switch';
    this._shouldError = options.shouldError || false;
    this._errorOnCommand = options.errorOnCommand || null;
    this._commandCount = 0;
    this._errorTriggered = false;
  }

  write(data) {
    if (this.destroyed || !this.writable) {
      return false;
    }

    const command = data.toString().trim();
    this._commandCount++;

    // Check if we should error on this command
    if (this._errorOnCommand && command.includes(this._errorOnCommand) && !this._errorTriggered) {
      this._errorTriggered = true;
      // Mark the stream as broken
      this.writable = false;
      this.destroyed = true;
      setTimeout(() => {
        this.emit('error', new Error('Command execution failed'));
        this.emit('close');
      }, this._commandDelay);
      return true;
    }

    // Simulate command echo and response
    setTimeout(() => {
      if (this.destroyed) return;

      // Echo the command
      this.emit('data', Buffer.from(command + '\n'));

      // Simulate command output
      let output = '';
      if (command === 'screen-length 0 temporary') {
        output = 'Info: The configuration takes effect on the current user terminal interface only.\n';
      } else if (command.startsWith('display')) {
        output = `Output for: ${command}\nLine 1\nLine 2\n`;
      } else if (command === 'quit') {
        output = '';
      } else {
        output = `Executed: ${command}\n`;
      }

      this.emit('data', Buffer.from(output));

      // Send prompt
      setTimeout(() => {
        if (this.destroyed) return;
        this.emit('data', Buffer.from(`<${this._hostname}>`));
      }, 5);
    }, this._commandDelay);

    return true;
  }

  end() {
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }

  sendInitialPrompt() {
    setTimeout(() => {
      if (!this.destroyed) {
        this.emit('data', Buffer.from(`\n<${this._hostname}>`));
      }
    }, this._promptDelay);
  }
}

/**
 * Mock SSH Client that simulates ssh2 Client
 */
class MockSSHClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this._sock = {
      destroyed: false,
      writable: true,
    };
    this._shellOptions = options.shellOptions || {};
    this._shouldFailConnect = options.shouldFailConnect || false;
    this._shouldFailShell = options.shouldFailShell || false;
    this._connectDelay = options.connectDelay || 10;
    this._connectionId = MockSSHClient._nextId++;
  }

  static _nextId = 1;

  connect() {
    setTimeout(() => {
      if (this._shouldFailConnect) {
        this.emit('error', new Error('Connection refused'));
      } else {
        this.emit('ready');
      }
    }, this._connectDelay);
  }

  shell(options, callback) {
    if (this._shouldFailShell) {
      callback(new Error('Failed to open shell'));
      return;
    }

    const stream = new MockShellStream(this._shellOptions);
    callback(null, stream);

    // Send initial prompt after shell opens
    stream.sendInitialPrompt();
  }

  end() {
    this._sock.destroyed = true;
    this._sock.writable = false;
    this.emit('end');
    this.emit('close');
  }

  destroy() {
    this._sock.destroyed = true;
    this._sock.writable = false;
  }
}

/**
 * Create a SwitchSSH instance that uses mocked connections
 */
class MockedSwitchSSH extends SwitchSSH {
  constructor(config = {}) {
    super(config);
    this._mockClientOptions = config.mockClientOptions || {};
    this._connectCount = 0;
    this._mockClients = [];
  }

  async connect(options) {
    this._connectCount++;
    const client = new MockSSHClient(this._mockClientOptions);
    this._mockClients.push(client);

    return new Promise((resolve, reject) => {
      client.on('ready', () => resolve(client));
      client.on('error', reject);
      client.connect();
    });
  }

  getConnectCount() {
    return this._connectCount;
  }

  resetConnectCount() {
    this._connectCount = 0;
  }

  getMockClients() {
    return this._mockClients;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════

console.log('\u2550'.repeat(65));
console.log('  SwitchSSH Connection Pool Integration Tests');
console.log('\u2550'.repeat(65) + '\n');

// ─────────────────────────────────────────────────────────────────────
// Test Suite 1: Constructor and Configuration
// ─────────────────────────────────────────────────────────────────────
console.log('\ud83d\udccb Test Suite 1: Constructor and Configuration\n');

async function testConstructorWithoutPool() {
  console.log('Test 1.1: Constructor without pooling (default)');
  const ssh = new SwitchSSH();

  assertEqual(ssh.usePool, false, 'Pooling is disabled by default');
  assertEqual(ssh._pool, null, 'Pool instance is null');
  assertEqual(ssh.getPool(), null, 'getPool() returns null');
  assertEqual(ssh.getPoolStats(), null, 'getPoolStats() returns null');
}

async function testConstructorWithPool() {
  console.log('\nTest 1.2: Constructor with pooling enabled');
  const ssh = new SwitchSSH({
    usePool: true,
    poolConfig: {
      maxConnections: 5,
      idleTimeout: 60000,
      debug: false,
    },
  });

  assertEqual(ssh.usePool, true, 'Pooling is enabled');
  assert(ssh._pool instanceof SSHConnectionPool, 'Pool instance created');
  assert(ssh.getPool() !== null, 'getPool() returns pool');
  assert(ssh.getPoolStats() !== null, 'getPoolStats() returns stats');

  const stats = ssh.getPoolStats();
  assertEqual(stats.totalConnections, 0, 'Initial pool is empty');
  assertEqual(stats.hits, 0, 'Initial hits is 0');
  assertEqual(stats.misses, 0, 'Initial misses is 0');

  ssh.shutdownPool();
}

async function testPoolConfigDefaults() {
  console.log('\nTest 1.3: Pool configuration defaults');
  const ssh = new SwitchSSH({ usePool: true });

  assertEqual(ssh.poolConfig.maxConnections, 10, 'Default maxConnections is 10');
  assertEqual(ssh.poolConfig.idleTimeout, 300000, 'Default idleTimeout is 5 minutes');
  assertEqual(ssh.poolConfig.healthCheckInterval, 60000, 'Default healthCheckInterval is 1 minute');
  assertEqual(ssh.poolConfig.debug, false, 'Default debug is false');

  ssh.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 2: Backward Compatibility
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 2: Backward Compatibility\n');

async function testNonPooledExecuteCommand() {
  console.log('Test 2.1: Non-pooled executeCommand still works');
  const ssh = new MockedSwitchSSH({ usePool: false });

  const result = await ssh.executeCommand({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assert(result.includes('display version'), 'Command output received');
  assertEqual(ssh.getConnectCount(), 1, 'One connection created');
  assertEqual(ssh.getPool(), null, 'No pool used');
}

async function testNonPooledExecuteCommands() {
  console.log('\nTest 2.2: Non-pooled executeCommands still works');
  const ssh = new MockedSwitchSSH({ usePool: false });

  const results = await ssh.executeCommands({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    commands: ['display version', 'display device'],
  });

  assertEqual(results.length, 2, 'Two results returned');
  assert(results[0].success, 'First command succeeded');
  assert(results[1].success, 'Second command succeeded');
  assertEqual(ssh.getConnectCount(), 1, 'Only one connection for multiple commands');
}

async function testPooledMethodsRequirePool() {
  console.log('\nTest 2.3: Pooled methods throw when pool disabled');
  const ssh = new MockedSwitchSSH({ usePool: false });

  let threw = false;
  try {
    await ssh.executeCommandPooled({
      host: '192.168.1.1',
      username: 'admin',
      password: 'password',
      command: 'display version',
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('not enabled'), 'Error message mentions pooling not enabled');
  }
  assert(threw, 'executeCommandPooled throws when pool disabled');

  threw = false;
  try {
    await ssh.executeCommandsPooled({
      host: '192.168.1.1',
      username: 'admin',
      password: 'password',
      commands: ['display version'],
    });
  } catch (err) {
    threw = true;
  }
  assert(threw, 'executeCommandsPooled throws when pool disabled');
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 3: Connection Reuse (Multiple Commands Same Connection)
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 3: Connection Reuse\n');

async function testMultipleCommandsReuseSameConnection() {
  console.log('Test 3.1: Multiple pooled commands reuse same connection');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Execute first command
  const result1 = await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  const statsAfter1 = ssh.getPoolStats();
  assertEqual(ssh.getConnectCount(), 1, 'First command creates one connection');
  assertEqual(statsAfter1.totalConnections, 1, 'Pool has 1 connection');
  assertEqual(statsAfter1.misses, 1, 'First command is a miss');

  // Execute second command - should reuse connection
  const result2 = await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display device',
  });

  const statsAfter2 = ssh.getPoolStats();
  assertEqual(ssh.getConnectCount(), 1, 'Second command reuses connection');
  assertEqual(statsAfter2.totalConnections, 1, 'Pool still has 1 connection');
  assertEqual(statsAfter2.hits, 1, 'Second command is a hit');

  // Execute third command
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display current-configuration',
  });

  const statsAfter3 = ssh.getPoolStats();
  assertEqual(ssh.getConnectCount(), 1, 'Third command reuses connection');
  assertEqual(statsAfter3.hits, 2, 'Third command is another hit');

  ssh.shutdownPool();
}

async function testDifferentHostsUseDifferentConnections() {
  console.log('\nTest 3.2: Different hosts use different connections');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Command to host 1
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  // Command to host 2
  await ssh.executeCommandPooled({
    host: '192.168.1.2',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getConnectCount(), 2, 'Two connections for different hosts');
  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool has 2 connections');

  ssh.shutdownPool();
}

async function testDifferentUsersUseDifferentConnections() {
  console.log('\nTest 3.3: Different usernames use different connections');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Command with user 1
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password1',
    command: 'display version',
  });

  // Command with user 2
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'operator',
    password: 'password2',
    command: 'display version',
  });

  assertEqual(ssh.getConnectCount(), 2, 'Two connections for different users');
  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool has 2 connections');

  ssh.shutdownPool();
}

async function testPooledExecuteCommandsReusesConnection() {
  console.log('\nTest 3.4: executeCommandsPooled reuses connection for batch');
  const ssh = new MockedSwitchSSH({ usePool: true });

  const results = await ssh.executeCommandsPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    commands: ['display version', 'display device', 'display interface'],
  });

  assertEqual(results.length, 3, 'Three results returned');
  assert(results.every(r => r.success), 'All commands succeeded');
  assertEqual(ssh.getConnectCount(), 1, 'Only one connection for batch');

  // Second batch should reuse same connection
  await ssh.executeCommandsPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    commands: ['display clock', 'display users'],
  });

  assertEqual(ssh.getConnectCount(), 1, 'Second batch reuses connection');
  assertEqual(ssh.getPoolStats().hits, 1, 'Second batch is a hit');

  ssh.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 4: Pool Recovery from Connection Errors
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 4: Pool Recovery from Errors\n');

async function testPoolRemovesBrokenConnectionOnError() {
  console.log('Test 4.1: Pool removes connection when manually marked as broken');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Create a connection
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  const pool = ssh.getPool();
  const key = pool.generateKey('192.168.1.1', 22, 'admin');

  assertEqual(pool.size(), 1, 'Pool has 1 connection');

  // Simulate a connection error by removing it manually (as the pool does on errors)
  pool.recordError('Simulated connection error');
  pool.remove(key);

  assertEqual(pool.size(), 0, 'Connection removed from pool');
  assert(pool.getStats().errors > 0, 'Error was recorded in stats');

  ssh.shutdownPool();
}

async function testPoolRecreatesConnectionAfterRemoval() {
  console.log('\nTest 4.2: Pool creates new connection after previous was removed');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // First command succeeds
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });
  assertEqual(ssh.getConnectCount(), 1, 'First connection created');

  // Manually remove the connection (simulating error cleanup)
  const pool = ssh.getPool();
  const key = pool.generateKey('192.168.1.1', 22, 'admin');
  pool.remove(key);

  assertEqual(pool.size(), 0, 'Connection was removed');

  // Third command should create new connection
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display device',
  });

  assertEqual(ssh.getConnectCount(), 2, 'New connection created after removal');
  assertEqual(ssh.getPoolStats().totalConnections, 1, 'Pool has 1 active connection');

  ssh.shutdownPool();
}

async function testConnectionFailureRecovery() {
  console.log('\nTest 4.3: Recovery from connection failure');

  // Create SSH with failing connection
  let failConnect = true;
  const ssh = new MockedSwitchSSH({
    usePool: true,
    mockClientOptions: {
      shouldFailConnect: true,
    },
  });

  // Override connect to control failure
  let attempts = 0;
  ssh.connect = async function(options) {
    attempts++;
    if (failConnect) {
      throw new Error('Connection refused');
    }
    const client = new MockSSHClient({});
    this._mockClients.push(client);
    return new Promise((resolve, reject) => {
      client.on('ready', () => resolve(client));
      client.on('error', reject);
      client.connect();
    });
  };

  // First attempt fails
  let threw = false;
  try {
    await ssh.executeCommandPooled({
      host: '192.168.1.1',
      username: 'admin',
      password: 'password',
      command: 'display version',
    });
  } catch (err) {
    threw = true;
  }
  assert(threw, 'First connection attempt failed');
  assertEqual(ssh.getPoolStats().totalConnections, 0, 'No connections in pool after failure');

  // Fix the connection issue
  failConnect = false;

  // Second attempt succeeds
  const result = await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assert(result.includes('display version'), 'Command succeeded after recovery');
  assertEqual(ssh.getPoolStats().totalConnections, 1, 'Connection in pool after recovery');

  ssh.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 5: Shell Session Management
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 5: Shell Session Management\n');

async function testShellSessionCaching() {
  console.log('Test 5.1: Shell sessions are cached and reused');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // First command creates connection and shell
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  const pool = ssh.getPool();
  const key = pool.generateKey('192.168.1.1', 22, 'admin');

  assert(pool.isShellReady(key), 'Shell is marked as ready');
  assert(pool.isShellUsable(key), 'Shell is usable');
  assert(pool.getShell(key) !== null, 'Shell is cached');

  // Second command reuses shell
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display device',
  });

  // Shell should still be the same
  assert(pool.isShellUsable(key), 'Shell still usable after second command');
  assertEqual(ssh.getPoolStats().connectionsWithShell, 1, 'One connection with shell');
  assertEqual(ssh.getPoolStats().readyShells, 1, 'One ready shell');

  ssh.shutdownPool();
}

async function testResetPooledShell() {
  console.log('\nTest 5.2: resetPooledShell clears shell but keeps connection');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Create connection with shell
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().connectionsWithShell, 1, 'Connection has shell');

  // Reset shell
  const reset = ssh.resetPooledShell('192.168.1.1', 22, 'admin');
  assert(reset, 'resetPooledShell returned true');

  const pool = ssh.getPool();
  const key = pool.generateKey('192.168.1.1', 22, 'admin');
  assertEqual(pool.getShell(key), null, 'Shell is cleared');
  assertEqual(ssh.getPoolStats().totalConnections, 1, 'Connection still in pool');

  // Next command should work and create new shell
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display device',
  });

  assertEqual(ssh.getConnectCount(), 1, 'Same connection reused');
  assert(pool.isShellUsable(key), 'New shell created and usable');

  ssh.shutdownPool();
}

async function testIsPooledShellUsable() {
  console.log('\nTest 5.3: isPooledShellUsable returns correct state');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // No connection yet
  assertEqual(ssh.isPooledShellUsable('192.168.1.1', 22, 'admin'), false, 'No shell before connection');

  // Create connection
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.isPooledShellUsable('192.168.1.1', 22, 'admin'), true, 'Shell usable after command');

  // Reset shell
  ssh.resetPooledShell('192.168.1.1', 22, 'admin');
  assertEqual(ssh.isPooledShellUsable('192.168.1.1', 22, 'admin'), false, 'Shell not usable after reset');

  ssh.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 6: Pool Lifecycle Management
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 6: Pool Lifecycle Management\n');

async function testClearPool() {
  console.log('Test 6.1: clearPool removes all connections');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Create multiple connections
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  await ssh.executeCommandPooled({
    host: '192.168.1.2',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool has 2 connections');

  ssh.clearPool();

  assertEqual(ssh.getPoolStats().totalConnections, 0, 'Pool is empty after clear');
  assertEqual(ssh.getPoolStats().hits, 0, 'Stats reset');

  // Can still use after clear
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().totalConnections, 1, 'Can add connections after clear');

  ssh.shutdownPool();
}

async function testShutdownPool() {
  console.log('\nTest 6.2: shutdownPool cleans up properly');
  const ssh = new MockedSwitchSSH({ usePool: true });

  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().totalConnections, 1, 'Pool has connection');

  ssh.shutdownPool();

  assertEqual(ssh.getPoolStats().totalConnections, 0, 'Pool empty after shutdown');
}

async function testRemovePooledConnection() {
  console.log('\nTest 6.3: removePooledConnection removes specific connection');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Create two connections
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  await ssh.executeCommandPooled({
    host: '192.168.1.2',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool has 2 connections');

  // Remove one
  const removed = ssh.removePooledConnection('192.168.1.1', 22, 'admin');
  assert(removed, 'Connection was removed');
  assertEqual(ssh.getPoolStats().totalConnections, 1, 'Pool has 1 connection');

  // Try to remove non-existent
  const notRemoved = ssh.removePooledConnection('192.168.1.99', 22, 'admin');
  assert(!notRemoved, 'Non-existent connection returns false');

  ssh.shutdownPool();
}

async function testReleasePooledConnection() {
  console.log('\nTest 6.4: releasePooledConnection releases connection back to pool');
  const ssh = new MockedSwitchSSH({ usePool: true });

  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  // Connection should already be released after command completes
  const stats = ssh.getPoolStats();
  assertEqual(stats.idleConnections, 1, 'Connection is idle after command');
  assertEqual(stats.activeConnections, 0, 'No active connections');

  // Explicit release on already-released should still work (idempotent)
  const released = ssh.releasePooledConnection('192.168.1.1', 22, 'admin');
  // May return false since it's already released, but shouldn't error
  assert(typeof released === 'boolean', 'releasePooledConnection returns boolean');

  ssh.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 7: Performance Improvement Metrics
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 7: Performance Metrics\n');

async function testPoolHitRateCalculation() {
  console.log('Test 7.1: Pool hit rate is calculated correctly');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // 1 miss (first connection)
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  // 4 hits (reusing connection)
  for (let i = 0; i < 4; i++) {
    await ssh.executeCommandPooled({
      host: '192.168.1.1',
      username: 'admin',
      password: 'password',
      command: `display command-${i}`,
    });
  }

  const stats = ssh.getPoolStats();
  assertEqual(stats.hits, 4, 'Stats show 4 hits');
  assertEqual(stats.misses, 1, 'Stats show 1 miss');
  assertEqual(stats.hitRate, '80.00%', 'Hit rate is 80%');

  ssh.shutdownPool();
}

async function testConnectionReuseSavesTime() {
  console.log('\nTest 7.2: Connection reuse is tracked correctly');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Execute 10 commands to same host
  for (let i = 0; i < 10; i++) {
    await ssh.executeCommandPooled({
      host: '192.168.1.1',
      username: 'admin',
      password: 'password',
      command: `display cmd-${i}`,
    });
  }

  assertEqual(ssh.getConnectCount(), 1, 'Only 1 connection created for 10 commands');

  const stats = ssh.getPoolStats();
  assertEqual(stats.hits, 9, '9 cache hits');
  assertEqual(stats.misses, 1, '1 cache miss');

  // Compare with non-pooled which would need 10 connections
  const sshNonPooled = new MockedSwitchSSH({ usePool: false });
  for (let i = 0; i < 10; i++) {
    await sshNonPooled.executeCommand({
      host: '192.168.1.1',
      username: 'admin',
      password: 'password',
      command: `display cmd-${i}`,
    });
  }

  assertEqual(sshNonPooled.getConnectCount(), 10, 'Non-pooled needs 10 connections');
  assert(ssh.getConnectCount() < sshNonPooled.getConnectCount(), 'Pooled uses fewer connections');

  ssh.shutdownPool();
}

async function testPoolStatsComprehensive() {
  console.log('\nTest 7.3: Pool stats are comprehensive');
  const ssh = new MockedSwitchSSH({ usePool: true });

  // Create connections
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  await ssh.executeCommandPooled({
    host: '192.168.1.2',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  // Reuse one
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display device',
  });

  const stats = ssh.getPoolStats();

  // Check all expected fields
  assert('hits' in stats, 'Stats has hits');
  assert('misses' in stats, 'Stats has misses');
  assert('hitRate' in stats, 'Stats has hitRate');
  assert('totalConnections' in stats, 'Stats has totalConnections');
  assert('activeConnections' in stats, 'Stats has activeConnections');
  assert('idleConnections' in stats, 'Stats has idleConnections');
  assert('errors' in stats, 'Stats has errors');
  assert('evictions' in stats, 'Stats has evictions');
  assert('connectionsWithShell' in stats, 'Stats has connectionsWithShell');
  assert('readyShells' in stats, 'Stats has readyShells');

  assertEqual(stats.totalConnections, 2, 'Two total connections');
  assertEqual(stats.hits, 1, 'One hit');
  assertEqual(stats.misses, 2, 'Two misses');

  ssh.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 8: Edge Cases
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(65) + '\n');
console.log('\ud83d\udccb Test Suite 8: Edge Cases\n');

async function testPoolWithNonDefaultPort() {
  console.log('Test 8.1: Pool works with non-default SSH port');
  const ssh = new MockedSwitchSSH({ usePool: true });

  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 2222,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  // Different ports should be different connections
  assertEqual(ssh.getConnectCount(), 2, 'Different ports create different connections');
  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool has 2 connections');

  ssh.shutdownPool();
}

async function testPoolMaxConnectionsLimit() {
  console.log('\nTest 8.2: Pool respects maxConnections limit');
  const ssh = new MockedSwitchSSH({
    usePool: true,
    poolConfig: {
      maxConnections: 2,
    },
  });

  // Create 3 connections (should evict oldest when at max)
  await ssh.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  await ssh.executeCommandPooled({
    host: '192.168.1.2',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool at max capacity');

  // Add third - should evict oldest
  await ssh.executeCommandPooled({
    host: '192.168.1.3',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh.getPoolStats().totalConnections, 2, 'Pool still at max capacity');

  ssh.shutdownPool();
}

async function testPoolMethodsWithDisabledPool() {
  console.log('\nTest 8.3: Pool helper methods work when pool disabled');
  const ssh = new MockedSwitchSSH({ usePool: false });

  assertEqual(ssh.getPool(), null, 'getPool returns null');
  assertEqual(ssh.getPoolStats(), null, 'getPoolStats returns null');
  assertEqual(ssh.releasePooledConnection('1.1.1.1', 22, 'admin'), false, 'release returns false');
  assertEqual(ssh.removePooledConnection('1.1.1.1', 22, 'admin'), false, 'remove returns false');
  assertEqual(ssh.resetPooledShell('1.1.1.1', 22, 'admin'), false, 'resetShell returns false');
  assertEqual(ssh.isPooledShellUsable('1.1.1.1', 22, 'admin'), false, 'isShellUsable returns false');

  // These should not throw
  ssh.clearPool();
  ssh.shutdownPool();

  assert(true, 'No errors thrown when pool disabled');
}

async function testMultipleSwitchSSHInstancesWithPools() {
  console.log('\nTest 8.4: Multiple SwitchSSH instances have independent pools');
  const ssh1 = new MockedSwitchSSH({ usePool: true });
  const ssh2 = new MockedSwitchSSH({ usePool: true });

  await ssh1.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  await ssh2.executeCommandPooled({
    host: '192.168.1.1',
    username: 'admin',
    password: 'password',
    command: 'display version',
  });

  assertEqual(ssh1.getPoolStats().totalConnections, 1, 'SSH1 pool has 1 connection');
  assertEqual(ssh2.getPoolStats().totalConnections, 1, 'SSH2 pool has 1 connection');
  assertEqual(ssh1.getConnectCount(), 1, 'SSH1 made 1 connection');
  assertEqual(ssh2.getConnectCount(), 1, 'SSH2 made 1 connection');

  ssh1.clearPool();
  assertEqual(ssh1.getPoolStats().totalConnections, 0, 'SSH1 pool cleared');
  assertEqual(ssh2.getPoolStats().totalConnections, 1, 'SSH2 pool unaffected');

  ssh1.shutdownPool();
  ssh2.shutdownPool();
}

// ─────────────────────────────────────────────────────────────────────
// Run All Tests
// ─────────────────────────────────────────────────────────────────────

async function runAllTests() {
  try {
    // Suite 1: Constructor and Configuration
    await testConstructorWithoutPool();
    await testConstructorWithPool();
    await testPoolConfigDefaults();

    // Suite 2: Backward Compatibility
    await testNonPooledExecuteCommand();
    await testNonPooledExecuteCommands();
    await testPooledMethodsRequirePool();

    // Suite 3: Connection Reuse
    await testMultipleCommandsReuseSameConnection();
    await testDifferentHostsUseDifferentConnections();
    await testDifferentUsersUseDifferentConnections();
    await testPooledExecuteCommandsReusesConnection();

    // Suite 4: Pool Recovery from Errors
    await testPoolRemovesBrokenConnectionOnError();
    await testPoolRecreatesConnectionAfterRemoval();
    await testConnectionFailureRecovery();

    // Suite 5: Shell Session Management
    await testShellSessionCaching();
    await testResetPooledShell();
    await testIsPooledShellUsable();

    // Suite 6: Pool Lifecycle Management
    await testClearPool();
    await testShutdownPool();
    await testRemovePooledConnection();
    await testReleasePooledConnection();

    // Suite 7: Performance Metrics
    await testPoolHitRateCalculation();
    await testConnectionReuseSavesTime();
    await testPoolStatsComprehensive();

    // Suite 8: Edge Cases
    await testPoolWithNonDefaultPort();
    await testPoolMaxConnectionsLimit();
    await testPoolMethodsWithDisabledPool();
    await testMultipleSwitchSSHInstancesWithPools();

  } catch (error) {
    console.error('\n\u274c Test execution error:', error);
    testsFailed++;
  }

  // Print summary
  console.log('\n' + '\u2550'.repeat(65) + '\n');
  console.log('\ud83d\udcca Test Summary\n');
  console.log(`  \u2705 Passed: ${testsPassed}`);
  console.log(`  \u274c Failed: ${testsFailed}`);
  console.log(`  \ud83d\udcdd Total:  ${testsPassed + testsFailed}`);
  console.log('\n' + '\u2550'.repeat(65) + '\n');

  // Exit with appropriate code
  if (testsFailed > 0) {
    console.log('\u274c Some tests failed\n');
    process.exit(1);
  } else {
    console.log('\u2705 All tests passed!\n');
    process.exit(0);
  }
}

// Run tests
runAllTests();
