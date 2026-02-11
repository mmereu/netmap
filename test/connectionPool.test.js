#!/usr/bin/env node
/**
 * Unit tests for ConnectionPool base class
 *
 * Tests cover:
 * - acquire/release cycle
 * - max connections limit
 * - idle timeout eviction
 * - health check removing dead connections
 * - concurrent access patterns
 * - statistics tracking
 */

import ConnectionPool from '../lib/connectionPool.js';

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${message}`);
    testsFailed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  ✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${message} (expected: ${expected}, got: ${actual})`);
    testsFailed++;
  }
}

function assertDeepEqual(actual, expected, message) {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  if (isEqual) {
    console.log(`  ✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${message}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Got: ${JSON.stringify(actual)}`);
    testsFailed++;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock connection factory
function createMockConnection(id) {
  return {
    id,
    destroyed: false,
    writable: true,
    end: function() {
      this.destroyed = true;
      this.writable = false;
    }
  };
}

// Custom ConnectionPool for testing
class TestConnectionPool extends ConnectionPool {
  constructor(options = {}) {
    super(options);
    this._aliveConnections = new Set();
  }

  setConnectionAlive(connection, alive) {
    if (alive) {
      this._aliveConnections.add(connection);
    } else {
      this._aliveConnections.delete(connection);
    }
  }

  isConnectionAlive(connection) {
    return this._aliveConnections.has(connection) || (connection && !connection.destroyed);
  }

  closeConnection(connection) {
    if (connection && typeof connection.end === 'function') {
      connection.end();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('  ConnectionPool Unit Tests');
console.log('═══════════════════════════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────────
// Test Suite 1: Constructor and Configuration
// ─────────────────────────────────────────────────────────────────────
console.log('📋 Test Suite 1: Constructor and Configuration\n');

async function testConstructorDefaults() {
  console.log('Test 1.1: Default options');
  const pool = new TestConnectionPool();

  assertEqual(pool.options.maxConnections, 10, 'Default maxConnections is 10');
  assertEqual(pool.options.idleTimeout, 300000, 'Default idleTimeout is 5 minutes');
  assertEqual(pool.options.healthCheckInterval, 60000, 'Default healthCheckInterval is 1 minute');
  assertEqual(pool.options.healthCheckTimeout, 5000, 'Default healthCheckTimeout is 5 seconds');
  assertEqual(pool.options.debug, false, 'Default debug is false');
  assertEqual(pool.options.name, 'ConnectionPool', 'Default name is ConnectionPool');
  assertEqual(pool.size(), 0, 'Pool starts empty');

  pool.shutdown();
}

async function testConstructorCustomOptions() {
  console.log('\nTest 1.2: Custom options');
  const customLogger = () => {};
  const pool = new TestConnectionPool({
    maxConnections: 5,
    idleTimeout: 60000,
    healthCheckInterval: 30000,
    healthCheckTimeout: 3000,
    debug: true,
    name: 'TestPool',
    logger: customLogger
  });

  assertEqual(pool.options.maxConnections, 5, 'Custom maxConnections is 5');
  assertEqual(pool.options.idleTimeout, 60000, 'Custom idleTimeout is 1 minute');
  assertEqual(pool.options.healthCheckInterval, 30000, 'Custom healthCheckInterval is 30 seconds');
  assertEqual(pool.options.healthCheckTimeout, 3000, 'Custom healthCheckTimeout is 3 seconds');
  assertEqual(pool.options.debug, true, 'Custom debug is true');
  assertEqual(pool.options.name, 'TestPool', 'Custom name is TestPool');
  assertEqual(typeof pool.options.logger, 'function', 'Custom logger is set');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 2: Key Generation
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 2: Key Generation\n');

async function testKeyGeneration() {
  console.log('Test 2.1: generateKey method');
  const pool = new TestConnectionPool();

  assertEqual(pool.generateKey('192.168.1.1', 22, 'admin'), '192.168.1.1:22:admin', 'Key format is host:port:username');
  assertEqual(pool.generateKey('switch.local', 23, 'root'), 'switch.local:23:root', 'Key with hostname');
  assertEqual(pool.generateKey('10.0.0.1', 2222, 'test-user'), '10.0.0.1:2222:test-user', 'Key with different port');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 3: Add and Remove Connections
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 3: Add and Remove Connections\n');

async function testAddConnection() {
  console.log('Test 3.1: Adding connections');
  const pool = new TestConnectionPool({ maxConnections: 3 });

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  const conn3 = createMockConnection(3);

  assert(pool.add('key1', conn1), 'First connection added successfully');
  assertEqual(pool.size(), 1, 'Pool size is 1');
  assert(pool.has('key1'), 'Pool has key1');

  assert(pool.add('key2', conn2), 'Second connection added successfully');
  assertEqual(pool.size(), 2, 'Pool size is 2');

  assert(pool.add('key3', conn3), 'Third connection added successfully');
  assertEqual(pool.size(), 3, 'Pool size is 3 (at max)');

  pool.shutdown();
}

async function testAddConnectionAtCapacity() {
  console.log('\nTest 3.2: Adding connection when pool is at capacity (with all connections in use)');
  const pool = new TestConnectionPool({ maxConnections: 2 });

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  const conn3 = createMockConnection(3);

  pool.add('key1', conn1);
  pool.add('key2', conn2);

  // Mark both as in use so they can't be evicted
  await pool.acquire('key1', { skipHealthCheck: true });
  await pool.acquire('key2', { skipHealthCheck: true });

  // Try to add a third connection - should fail since all are in use
  assert(!pool.add('key3', conn3), 'Cannot add when pool full and all in use');
  assertEqual(pool.size(), 2, 'Pool size remains 2');
  assert(!pool.has('key3'), 'key3 not in pool');

  pool.shutdown();
}

async function testAddConnectionEvictsIdle() {
  console.log('\nTest 3.3: Adding connection evicts idle connections when at capacity');
  const pool = new TestConnectionPool({ maxConnections: 2 });

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  const conn3 = createMockConnection(3);

  pool.add('key1', conn1);
  await sleep(10); // Small delay to ensure different timestamps
  pool.add('key2', conn2);

  // Both are idle, so oldest should be evicted
  assert(pool.add('key3', conn3), 'Third connection added (evicting oldest)');
  assertEqual(pool.size(), 2, 'Pool size remains 2');
  assert(!pool.has('key1'), 'Oldest connection (key1) was evicted');
  assert(pool.has('key2'), 'key2 still in pool');
  assert(pool.has('key3'), 'key3 added to pool');

  pool.shutdown();
}

async function testRemoveConnection() {
  console.log('\nTest 3.4: Removing connections');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  assert(pool.remove('key1'), 'Connection removed successfully');
  assertEqual(pool.size(), 0, 'Pool is empty');
  assert(!pool.has('key1'), 'key1 no longer in pool');
  assert(conn1.destroyed, 'Connection was closed');

  assert(!pool.remove('key1'), 'Remove returns false for non-existent key');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 4: Acquire and Release Cycle
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 4: Acquire and Release Cycle\n');

async function testAcquireExistingConnection() {
  console.log('Test 4.1: Acquire existing connection');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  const acquired = await pool.acquire('key1', { skipHealthCheck: true });
  assertEqual(acquired, conn1, 'Acquired the correct connection');

  const stats = pool.getStats();
  assertEqual(stats.hits, 1, 'Stats show 1 hit');
  assertEqual(stats.misses, 0, 'Stats show 0 misses');
  assertEqual(stats.activeConnections, 1, 'Stats show 1 active connection');

  pool.shutdown();
}

async function testAcquireNonExistentConnection() {
  console.log('\nTest 4.2: Acquire non-existent connection');
  const pool = new TestConnectionPool();

  const acquired = await pool.acquire('non-existent');
  assertEqual(acquired, null, 'Returns null for non-existent key');

  const stats = pool.getStats();
  assertEqual(stats.hits, 0, 'Stats show 0 hits');
  assertEqual(stats.misses, 1, 'Stats show 1 miss');

  pool.shutdown();
}

async function testAcquireInUseConnection() {
  console.log('\nTest 4.3: Acquire in-use connection');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // First acquire succeeds
  const acquired1 = await pool.acquire('key1', { skipHealthCheck: true });
  assertEqual(acquired1, conn1, 'First acquire succeeds');

  // Second acquire fails (connection in use)
  const acquired2 = await pool.acquire('key1', { skipHealthCheck: true });
  assertEqual(acquired2, null, 'Second acquire returns null (in use)');

  const stats = pool.getStats();
  assertEqual(stats.hits, 1, 'Stats show 1 hit (first acquire)');
  assertEqual(stats.misses, 1, 'Stats show 1 miss (second acquire)');

  pool.shutdown();
}

async function testReleaseConnection() {
  console.log('\nTest 4.4: Release connection');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Acquire
  await pool.acquire('key1', { skipHealthCheck: true });

  // Release
  assert(pool.release('key1'), 'Release returns true');

  const stats = pool.getStats();
  assertEqual(stats.activeConnections, 0, 'No active connections after release');
  assertEqual(stats.idleConnections, 1, 'One idle connection after release');

  // Can acquire again
  const acquired2 = await pool.acquire('key1', { skipHealthCheck: true });
  assertEqual(acquired2, conn1, 'Can acquire after release');

  pool.shutdown();
}

async function testReleaseNonExistentConnection() {
  console.log('\nTest 4.5: Release non-existent connection');
  const pool = new TestConnectionPool();

  assert(!pool.release('non-existent'), 'Release returns false for non-existent key');

  pool.shutdown();
}

async function testAcquireReleaseCycle() {
  console.log('\nTest 4.6: Full acquire/release cycle');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Multiple acquire/release cycles
  for (let i = 0; i < 5; i++) {
    const acquired = await pool.acquire('key1', { skipHealthCheck: true });
    assertEqual(acquired, conn1, `Acquire cycle ${i + 1} successful`);
    pool.release('key1');
  }

  const stats = pool.getStats();
  assertEqual(stats.hits, 5, 'Stats show 5 hits');
  assertEqual(pool.size(), 1, 'Pool still has 1 connection');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 5: Health Check
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 5: Health Check\n');

async function testAcquireWithHealthCheck() {
  console.log('Test 5.1: Acquire with health check (alive connection)');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Connection is alive (not destroyed)
  const acquired = await pool.acquire('key1');
  assertEqual(acquired, conn1, 'Acquired alive connection');

  pool.shutdown();
}

async function testAcquireDeadConnection() {
  console.log('\nTest 5.2: Acquire removes dead connection');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Mark connection as dead
  conn1.destroyed = true;

  const acquired = await pool.acquire('key1');
  assertEqual(acquired, null, 'Returns null for dead connection');
  assertEqual(pool.size(), 0, 'Dead connection removed from pool');

  const stats = pool.getStats();
  assertEqual(stats.healthCheckFailures, 1, 'Stats show 1 health check failure');

  pool.shutdown();
}

async function testManualHealthCheck() {
  console.log('\nTest 5.3: Manual health check via runHealthCheck()');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  pool.add('key1', conn1);
  pool.add('key2', conn2);

  // Mark one connection as dead
  conn1.destroyed = true;

  // Run health check
  await pool.runHealthCheck();

  assertEqual(pool.size(), 1, 'Pool has 1 connection after health check');
  assert(!pool.has('key1'), 'Dead connection removed');
  assert(pool.has('key2'), 'Alive connection remains');

  pool.shutdown();
}

async function testHealthCheckOnlyChecksIdleConnections() {
  console.log('\nTest 5.4: Health check only checks idle connections');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  pool.add('key1', conn1);
  pool.add('key2', conn2);

  // Acquire conn1 (mark as in use)
  await pool.acquire('key1', { skipHealthCheck: true });

  // Mark both as dead
  conn1.destroyed = true;
  conn2.destroyed = true;

  // Run health check - should only remove conn2 (idle)
  await pool.runHealthCheck();

  assertEqual(pool.size(), 1, 'Pool has 1 connection (in-use one preserved)');
  assert(pool.has('key1'), 'In-use connection preserved');
  assert(!pool.has('key2'), 'Idle dead connection removed');

  pool.shutdown();
}

async function testHealthCheckRunningState() {
  console.log('\nTest 5.5: Health check running state');
  const pool = new TestConnectionPool();

  assertEqual(pool.isHealthCheckRunning(), false, 'Health check not running initially');

  const healthCheckPromise = pool.runHealthCheck();
  // Note: This may be flaky depending on timing, but tests the API
  await healthCheckPromise;

  assertEqual(pool.isHealthCheckRunning(), false, 'Health check not running after completion');

  pool.shutdown();
}

async function testHealthCheckWithAsyncAliveCheck() {
  console.log('\nTest 5.6: Health check with async isConnectionAlive');

  class AsyncTestPool extends ConnectionPool {
    async isConnectionAlive(connection) {
      await sleep(10);
      return connection && !connection.destroyed;
    }
  }

  const pool = new AsyncTestPool({ healthCheckInterval: 60000 });

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  pool.add('key1', conn1);
  pool.add('key2', conn2);

  conn1.destroyed = true;

  await pool.runHealthCheck();

  assertEqual(pool.size(), 1, 'Pool has 1 connection after async health check');
  assert(!pool.has('key1'), 'Dead connection removed');
  assert(pool.has('key2'), 'Alive connection remains');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 6: Idle Timeout and Cleanup
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 6: Idle Timeout and Cleanup\n');

async function testIdleTimeoutEviction() {
  console.log('Test 6.1: Idle timeout eviction');
  const pool = new TestConnectionPool({
    idleTimeout: 50, // 50ms for testing
    healthCheckInterval: 60000 // Disable periodic health check
  });

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  assertEqual(pool.size(), 1, 'Pool has 1 connection');

  // Wait for idle timeout
  await sleep(100);

  // Run cleanup
  const evicted = pool.cleanup();
  assertEqual(evicted, 1, 'One connection evicted');
  assertEqual(pool.size(), 0, 'Pool is empty after cleanup');

  const stats = pool.getStats();
  assertEqual(stats.evictions, 1, 'Stats show 1 eviction');

  pool.shutdown();
}

async function testCleanupPreservesInUseConnections() {
  console.log('\nTest 6.2: Cleanup preserves in-use connections');
  const pool = new TestConnectionPool({
    idleTimeout: 50,
    healthCheckInterval: 60000
  });

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Acquire connection (mark as in use)
  await pool.acquire('key1', { skipHealthCheck: true });

  // Wait for what would be idle timeout
  await sleep(100);

  // Run cleanup
  const evicted = pool.cleanup();
  assertEqual(evicted, 0, 'No connections evicted (in use)');
  assertEqual(pool.size(), 1, 'Connection preserved');

  pool.shutdown();
}

async function testCleanupPreservesRecentlyActiveConnections() {
  console.log('\nTest 6.3: Cleanup preserves recently active connections');
  const pool = new TestConnectionPool({
    idleTimeout: 100,
    healthCheckInterval: 60000
  });

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Wait partial time
  await sleep(30);

  // Touch the connection by acquiring and releasing
  await pool.acquire('key1', { skipHealthCheck: true });
  pool.release('key1');

  // Wait more (but less than idle timeout from last activity)
  await sleep(30);

  // Run cleanup - connection should still be active
  const evicted = pool.cleanup();
  assertEqual(evicted, 0, 'No connections evicted (recently active)');
  assertEqual(pool.size(), 1, 'Connection preserved');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 7: Statistics Tracking
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 7: Statistics Tracking\n');

async function testInitialStats() {
  console.log('Test 7.1: Initial statistics');
  const pool = new TestConnectionPool();

  const stats = pool.getStats();
  assertEqual(stats.hits, 0, 'Initial hits is 0');
  assertEqual(stats.misses, 0, 'Initial misses is 0');
  assertEqual(stats.errors, 0, 'Initial errors is 0');
  assertEqual(stats.evictions, 0, 'Initial evictions is 0');
  assertEqual(stats.healthChecks, 0, 'Initial healthChecks is 0');
  assertEqual(stats.healthCheckFailures, 0, 'Initial healthCheckFailures is 0');
  assertEqual(stats.totalConnections, 0, 'Initial totalConnections is 0');
  assertEqual(stats.activeConnections, 0, 'Initial activeConnections is 0');
  assertEqual(stats.idleConnections, 0, 'Initial idleConnections is 0');
  assertEqual(stats.hitRate, '0%', 'Initial hitRate is 0%');

  pool.shutdown();
}

async function testStatsAfterOperations() {
  console.log('\nTest 7.2: Statistics after operations');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  // Some hits
  for (let i = 0; i < 8; i++) {
    await pool.acquire('key1', { skipHealthCheck: true });
    pool.release('key1');
  }

  // Some misses
  for (let i = 0; i < 2; i++) {
    await pool.acquire('non-existent');
  }

  const stats = pool.getStats();
  assertEqual(stats.hits, 8, 'Stats show 8 hits');
  assertEqual(stats.misses, 2, 'Stats show 2 misses');
  assertEqual(stats.hitRate, '80.00%', 'Hit rate is 80%');

  pool.shutdown();
}

async function testRecordError() {
  console.log('\nTest 7.3: Record error');
  const pool = new TestConnectionPool();

  pool.recordError();
  pool.recordError('Connection timeout');
  pool.recordError('Authentication failed');

  const stats = pool.getStats();
  assertEqual(stats.errors, 3, 'Stats show 3 errors');

  pool.shutdown();
}

async function testResetStats() {
  console.log('\nTest 7.4: Reset statistics');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  await pool.acquire('key1', { skipHealthCheck: true });
  pool.release('key1');
  pool.recordError();

  // Reset stats
  pool.resetStats();

  const stats = pool.getStats();
  assertEqual(stats.hits, 0, 'Hits reset to 0');
  assertEqual(stats.misses, 0, 'Misses reset to 0');
  assertEqual(stats.errors, 0, 'Errors reset to 0');
  // Note: connections still exist, just stats are reset
  assertEqual(stats.totalConnections, 1, 'Connections still present');

  pool.shutdown();
}

async function testHealthCheckStats() {
  console.log('\nTest 7.5: Health check statistics');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  pool.add('key1', conn1);
  pool.add('key2', conn2);

  // Mark one as dead
  conn1.destroyed = true;

  // Run health check
  await pool.runHealthCheck();

  const stats = pool.getStats();
  assertEqual(stats.healthChecks, 2, 'Stats show 2 health checks');
  assertEqual(stats.healthCheckFailures, 1, 'Stats show 1 health check failure');
  assertEqual(stats.healthCheckSuccessRate, '50.00%', 'Health check success rate is 50%');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 8: Connection Metadata
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 8: Connection Metadata\n');

async function testGetConnectionMeta() {
  console.log('Test 8.1: Get connection metadata');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  const meta = pool.getConnectionMeta('key1');

  assertEqual(meta.key, 'key1', 'Meta has correct key');
  assertEqual(meta.inUse, false, 'Meta shows not in use');
  assert(meta.lastActivity > 0, 'Meta has lastActivity timestamp');
  assert(meta.createdAt > 0, 'Meta has createdAt timestamp');
  assert(meta.idleTime >= 0, 'Meta has idleTime');
  assert(meta.age >= 0, 'Meta has age');
  assertEqual(meta.healthCheckPassed, true, 'Meta shows health check passed');

  pool.shutdown();
}

async function testGetConnectionMetaNonExistent() {
  console.log('\nTest 8.2: Get connection metadata for non-existent key');
  const pool = new TestConnectionPool();

  const meta = pool.getConnectionMeta('non-existent');
  assertEqual(meta, null, 'Returns null for non-existent key');

  pool.shutdown();
}

async function testMetadataUpdatesAfterAcquire() {
  console.log('\nTest 8.3: Metadata updates after acquire');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  const metaBefore = pool.getConnectionMeta('key1');
  await sleep(10);
  await pool.acquire('key1', { skipHealthCheck: true });
  const metaAfter = pool.getConnectionMeta('key1');

  assertEqual(metaAfter.inUse, true, 'Meta shows in use after acquire');
  assert(metaAfter.lastActivity > metaBefore.lastActivity, 'lastActivity updated');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 9: Pool Utility Methods
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 9: Pool Utility Methods\n');

async function testPoolSize() {
  console.log('Test 9.1: Pool size method');
  const pool = new TestConnectionPool();

  assertEqual(pool.size(), 0, 'Empty pool has size 0');

  pool.add('key1', createMockConnection(1));
  assertEqual(pool.size(), 1, 'Pool has size 1 after add');

  pool.add('key2', createMockConnection(2));
  assertEqual(pool.size(), 2, 'Pool has size 2 after second add');

  pool.remove('key1');
  assertEqual(pool.size(), 1, 'Pool has size 1 after remove');

  pool.shutdown();
}

async function testPoolHas() {
  console.log('\nTest 9.2: Pool has method');
  const pool = new TestConnectionPool();

  assert(!pool.has('key1'), 'Empty pool does not have key1');

  pool.add('key1', createMockConnection(1));
  assert(pool.has('key1'), 'Pool has key1 after add');

  pool.remove('key1');
  assert(!pool.has('key1'), 'Pool does not have key1 after remove');

  pool.shutdown();
}

async function testPoolKeys() {
  console.log('\nTest 9.3: Pool keys method');
  const pool = new TestConnectionPool();

  assertDeepEqual(pool.keys(), [], 'Empty pool has no keys');

  pool.add('key1', createMockConnection(1));
  pool.add('key2', createMockConnection(2));
  pool.add('key3', createMockConnection(3));

  const keys = pool.keys().sort();
  assertDeepEqual(keys, ['key1', 'key2', 'key3'], 'Pool returns all keys');

  pool.shutdown();
}

async function testPoolClear() {
  console.log('\nTest 9.4: Pool clear method');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  const conn2 = createMockConnection(2);
  pool.add('key1', conn1);
  pool.add('key2', conn2);

  pool.clear();

  assertEqual(pool.size(), 0, 'Pool is empty after clear');
  assert(conn1.destroyed, 'Connection 1 was closed');
  assert(conn2.destroyed, 'Connection 2 was closed');

  pool.shutdown();
}

async function testPoolShutdown() {
  console.log('\nTest 9.5: Pool shutdown method');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  pool.add('key1', conn1);

  pool.shutdown();

  assertEqual(pool.size(), 0, 'Pool is empty after shutdown');
  assert(conn1.destroyed, 'Connection was closed');
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 10: Debug Logging
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 10: Debug Logging\n');

async function testDebugLogging() {
  console.log('Test 10.1: Debug logging with custom logger');
  const logs = [];
  const customLogger = (level, message, data, meta) => {
    logs.push({ level, message, data, meta });
  };

  const pool = new TestConnectionPool({
    debug: true,
    name: 'DebugTestPool',
    logger: customLogger
  });

  pool.add('key1', createMockConnection(1));
  await pool.acquire('key1', { skipHealthCheck: true });
  pool.release('key1');

  assert(logs.length > 0, 'Logs were captured');
  assert(logs.some(l => l.message.includes('Added')), 'Add operation was logged');
  assert(logs.some(l => l.message.includes('Acquire')), 'Acquire operation was logged');
  assert(logs.some(l => l.message.includes('Released')), 'Release operation was logged');
  assert(logs.every(l => l.meta.prefix === '[DebugTestPool]'), 'All logs have correct prefix');

  pool.shutdown();
}

async function testSetDebug() {
  console.log('\nTest 10.2: Set debug at runtime');
  const logs = [];
  const customLogger = (level, message, data, meta) => {
    logs.push({ level, message });
  };

  const pool = new TestConnectionPool({
    debug: false,
    logger: customLogger
  });

  pool.add('key1', createMockConnection(1));
  const logsBeforeEnable = logs.length;

  pool.setDebug(true);
  pool.add('key2', createMockConnection(2));

  assert(logs.length > logsBeforeEnable, 'Logs captured after enabling debug');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 11: Concurrent Access Patterns
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 11: Concurrent Access Patterns\n');

async function testConcurrentAcquireRelease() {
  console.log('Test 11.1: Concurrent acquire/release on different keys');
  const pool = new TestConnectionPool();

  // Add multiple connections
  for (let i = 0; i < 5; i++) {
    pool.add(`key${i}`, createMockConnection(i));
  }

  // Concurrently acquire all connections
  const acquirePromises = [];
  for (let i = 0; i < 5; i++) {
    acquirePromises.push(pool.acquire(`key${i}`, { skipHealthCheck: true }));
  }
  const acquired = await Promise.all(acquirePromises);

  assert(acquired.every(c => c !== null), 'All connections acquired');

  const stats = pool.getStats();
  assertEqual(stats.activeConnections, 5, 'All 5 connections are active');

  // Release all
  for (let i = 0; i < 5; i++) {
    pool.release(`key${i}`);
  }

  const statsAfterRelease = pool.getStats();
  assertEqual(statsAfterRelease.activeConnections, 0, 'No active connections after release');
  assertEqual(statsAfterRelease.idleConnections, 5, 'All 5 connections are idle');

  pool.shutdown();
}

async function testConcurrentAcquireSameKey() {
  console.log('\nTest 11.2: Concurrent acquire attempts on same key');
  const pool = new TestConnectionPool();

  pool.add('key1', createMockConnection(1));

  // Try to acquire the same key 10 times concurrently
  const acquirePromises = [];
  for (let i = 0; i < 10; i++) {
    acquirePromises.push(pool.acquire('key1', { skipHealthCheck: true }));
  }
  const results = await Promise.all(acquirePromises);

  // Only one should succeed
  const successes = results.filter(r => r !== null);
  assertEqual(successes.length, 1, 'Only one acquire succeeded');

  const stats = pool.getStats();
  assertEqual(stats.hits, 1, 'Stats show 1 hit');
  assertEqual(stats.misses, 9, 'Stats show 9 misses');

  pool.shutdown();
}

async function testRapidAcquireReleaseRace() {
  console.log('\nTest 11.3: Rapid acquire/release race conditions');
  const pool = new TestConnectionPool();

  pool.add('key1', createMockConnection(1));

  // Simulate rapid acquire/release cycles in parallel
  const operations = [];
  for (let i = 0; i < 100; i++) {
    operations.push((async () => {
      const conn = await pool.acquire('key1', { skipHealthCheck: true });
      if (conn) {
        await sleep(Math.random() * 5);
        pool.release('key1');
        return true;
      }
      return false;
    })());
  }

  const results = await Promise.all(operations);
  const successCount = results.filter(r => r).length;

  assert(successCount >= 1, `At least 1 operation succeeded (got ${successCount})`);
  assertEqual(pool.size(), 1, 'Pool still has 1 connection');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite 12: Edge Cases
// ─────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(65) + '\n');
console.log('📋 Test Suite 12: Edge Cases\n');

async function testNullConnection() {
  console.log('Test 12.1: Handling null connection');
  const pool = new TestConnectionPool();

  // Default isConnectionAlive returns true for non-null
  // but our override should handle null gracefully
  pool.add('key1', null);
  const acquired = await pool.acquire('key1');

  // Behavior depends on isConnectionAlive implementation
  // Our TestConnectionPool treats null as alive if not destroyed
  assertEqual(acquired, null, 'Null connection handled');

  pool.shutdown();
}

async function testEmptyKey() {
  console.log('\nTest 12.2: Empty key handling');
  const pool = new TestConnectionPool();

  const conn1 = createMockConnection(1);
  assert(pool.add('', conn1), 'Can add with empty key');
  assert(pool.has(''), 'Pool has empty key');

  const acquired = await pool.acquire('', { skipHealthCheck: true });
  assertEqual(acquired, conn1, 'Can acquire with empty key');

  pool.shutdown();
}

async function testSpecialCharactersInKey() {
  console.log('\nTest 12.3: Special characters in key');
  const pool = new TestConnectionPool();

  const specialKey = '192.168.1.1:22:admin@domain.com';
  const conn1 = createMockConnection(1);

  assert(pool.add(specialKey, conn1), 'Can add with special characters');
  assert(pool.has(specialKey), 'Pool has special key');

  const acquired = await pool.acquire(specialKey, { skipHealthCheck: true });
  assertEqual(acquired, conn1, 'Can acquire with special key');

  pool.shutdown();
}

async function testMultiplePoolInstances() {
  console.log('\nTest 12.4: Multiple pool instances are independent');
  const pool1 = new TestConnectionPool({ name: 'Pool1' });
  const pool2 = new TestConnectionPool({ name: 'Pool2' });

  pool1.add('key1', createMockConnection(1));
  pool2.add('key1', createMockConnection(2));

  assertEqual(pool1.size(), 1, 'Pool1 has 1 connection');
  assertEqual(pool2.size(), 1, 'Pool2 has 1 connection');

  pool1.clear();
  assertEqual(pool1.size(), 0, 'Pool1 is empty');
  assertEqual(pool2.size(), 1, 'Pool2 still has 1 connection');

  pool1.shutdown();
  pool2.shutdown();
}

async function testCloseConnectionCalledOnRemove() {
  console.log('\nTest 12.5: closeConnection called on remove');
  let closeCalled = false;

  class TrackingPool extends ConnectionPool {
    closeConnection(connection) {
      closeCalled = true;
      super.closeConnection(connection);
    }
  }

  const pool = new TrackingPool();
  pool.add('key1', createMockConnection(1));
  pool.remove('key1');

  assert(closeCalled, 'closeConnection was called');

  pool.shutdown();
}

// ─────────────────────────────────────────────────────────────────────
// Run All Tests
// ─────────────────────────────────────────────────────────────────────

async function runAllTests() {
  try {
    // Suite 1: Constructor and Configuration
    await testConstructorDefaults();
    await testConstructorCustomOptions();

    // Suite 2: Key Generation
    await testKeyGeneration();

    // Suite 3: Add and Remove Connections
    await testAddConnection();
    await testAddConnectionAtCapacity();
    await testAddConnectionEvictsIdle();
    await testRemoveConnection();

    // Suite 4: Acquire and Release Cycle
    await testAcquireExistingConnection();
    await testAcquireNonExistentConnection();
    await testAcquireInUseConnection();
    await testReleaseConnection();
    await testReleaseNonExistentConnection();
    await testAcquireReleaseCycle();

    // Suite 5: Health Check
    await testAcquireWithHealthCheck();
    await testAcquireDeadConnection();
    await testManualHealthCheck();
    await testHealthCheckOnlyChecksIdleConnections();
    await testHealthCheckRunningState();
    await testHealthCheckWithAsyncAliveCheck();

    // Suite 6: Idle Timeout and Cleanup
    await testIdleTimeoutEviction();
    await testCleanupPreservesInUseConnections();
    await testCleanupPreservesRecentlyActiveConnections();

    // Suite 7: Statistics Tracking
    await testInitialStats();
    await testStatsAfterOperations();
    await testRecordError();
    await testResetStats();
    await testHealthCheckStats();

    // Suite 8: Connection Metadata
    await testGetConnectionMeta();
    await testGetConnectionMetaNonExistent();
    await testMetadataUpdatesAfterAcquire();

    // Suite 9: Pool Utility Methods
    await testPoolSize();
    await testPoolHas();
    await testPoolKeys();
    await testPoolClear();
    await testPoolShutdown();

    // Suite 10: Debug Logging
    await testDebugLogging();
    await testSetDebug();

    // Suite 11: Concurrent Access Patterns
    await testConcurrentAcquireRelease();
    await testConcurrentAcquireSameKey();
    await testRapidAcquireReleaseRace();

    // Suite 12: Edge Cases
    await testNullConnection();
    await testEmptyKey();
    await testSpecialCharactersInKey();
    await testMultiplePoolInstances();
    await testCloseConnectionCalledOnRemove();

  } catch (error) {
    console.error('\n❌ Test execution error:', error);
    testsFailed++;
  }

  // Print summary
  console.log('\n' + '═'.repeat(65) + '\n');
  console.log('📊 Test Summary\n');
  console.log(`  ✅ Passed: ${testsPassed}`);
  console.log(`  ❌ Failed: ${testsFailed}`);
  console.log(`  📝 Total:  ${testsPassed + testsFailed}`);
  console.log('\n' + '═'.repeat(65) + '\n');

  // Exit with appropriate code
  if (testsFailed > 0) {
    console.log('❌ Some tests failed\n');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!\n');
    process.exit(0);
  }
}

// Run tests
runAllTests();
