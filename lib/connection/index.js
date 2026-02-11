/**
 * Unified Connection Module
 *
 * Provides a unified interface for SSH and Telnet connections.
 * Consolidates functionality from sshAgent.js, switchSSH.js, and switchTelnet.js.
 *
 * Usage:
 *   import { createClient, SSHExecClient, SSHShellClient } from './lib/connection/index.js';
 *
 *   // Auto-detect client based on device type
 *   const client = createClient({ host: '10.0.0.1', vendor: 'Huawei' });
 *   const output = await client.execute('display version');
 *
 *   // Or use specific client
 *   const sshClient = new SSHExecClient();
 *   const result = await sshClient.executeCommand({ host, username, password }, 'uname -a');
 */

// Re-export types and utilities
export {
  DEFAULT_CONFIG,
  SSH_ALGORITHMS,
  HUAWEI_PATTERNS,
  CLIENT_TYPES,
  cleanOutput,
  withTimeout
} from './types.js';

// Re-export original clients for backward compatibility
// These are the existing implementations - this module doesn't replace them yet,
// just provides a unified entry point and shared utilities.

/**
 * Create a connection client based on device characteristics.
 *
 * @param {Object} options - Connection options
 * @param {string} options.host - Device IP/hostname
 * @param {string} options.vendor - Device vendor (e.g., 'Huawei', 'Cisco', 'Linux')
 * @param {string} options.protocol - Force protocol ('ssh' or 'telnet')
 * @param {boolean} options.interactive - Force interactive shell mode
 * @returns {Object} - Client configuration recommendation
 *
 * @example
 * const clientInfo = createClient({ host: '10.0.0.1', vendor: 'Huawei' });
 * // Returns: { type: 'ssh-shell', module: 'switchSSH', reason: 'Huawei requires interactive shell' }
 */
export function createClient(options = {}) {
  const { vendor = '', protocol, interactive } = options;

  const vendorLower = vendor.toLowerCase();

  // Determine best client based on vendor
  if (protocol === 'telnet') {
    return {
      type: 'telnet',
      module: 'switchTelnet',
      reason: 'Telnet protocol requested'
    };
  }

  // Huawei and similar vendors need interactive shell
  const interactiveVendors = ['huawei', 'h3c', 'hp', 'aruba', 'comware'];
  if (interactive || interactiveVendors.some(v => vendorLower.includes(v))) {
    return {
      type: 'ssh-shell',
      module: 'switchSSH',
      reason: `${vendor || 'Device'} requires interactive shell for prompt handling`
    };
  }

  // Linux servers and standard devices use exec
  const execVendors = ['linux', 'ubuntu', 'debian', 'centos', 'rhel', 'unix'];
  if (execVendors.some(v => vendorLower.includes(v))) {
    return {
      type: 'ssh-exec',
      module: 'sshAgent',
      reason: 'Linux/Unix server uses standard SSH exec'
    };
  }

  // Default to interactive shell for network devices
  return {
    type: 'ssh-shell',
    module: 'switchSSH',
    reason: 'Default to interactive shell for network devices'
  };
}

/**
 * Get recommended import path for a client type
 * @param {string} type - Client type from createClient
 * @returns {string} - Import path
 */
export function getClientImportPath(type) {
  const paths = {
    'ssh-exec': '../sshAgent.js',
    'ssh-shell': './switchSSH.js',
    'telnet': './switchTelnet.js'
  };
  return paths[type] || paths['ssh-shell'];
}

/**
 * Quick connection test
 * @param {Object} options - Connection options
 * @returns {Promise<Object>} - Test result with success, latency, error
 */
export async function testConnection(options) {
  const { host, port = 22, timeout = 5000 } = options;

  const start = Date.now();
  const net = await import('net');

  return new Promise((resolve) => {
    const socket = new net.default.Socket();

    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        success: false,
        host,
        port,
        latency: Date.now() - start,
        error: 'Connection timeout'
      });
    }, timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        success: true,
        host,
        port,
        latency: Date.now() - start
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        success: false,
        host,
        port,
        latency: Date.now() - start,
        error: err.message
      });
    });
  });
}

export default {
  createClient,
  getClientImportPath,
  testConnection
};
