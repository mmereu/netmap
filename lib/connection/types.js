/**
 * Shared types and constants for connection clients
 */

/**
 * Default configuration shared across all clients
 */
export const DEFAULT_CONFIG = {
  port: 22,
  readyTimeout: 20000,
  keepaliveInterval: 10000,
  keepaliveCountMax: 3,
  commandTimeout: 30000
};

/**
 * SSH algorithms for legacy device compatibility (Huawei, etc.)
 */
export const SSH_ALGORITHMS = {
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
    'hmac-sha1'
  ]
};

/**
 * Huawei-specific prompt patterns
 */
export const HUAWEI_PATTERNS = {
  prompt: [
    /<[^>]+>/,           // <hostname>
    /\[[^\]]+\]/,        // [hostname]
    /<[^>]+-[^>]+>/,     // <hostname-interface>
    /\[[^\]]+-[^\]]+\]/  // [hostname-interface]
  ],
  pagination: /----\s*More\s*----/gi,
  confirm: [
    /Press ENTER to continue/i,
    /Press any key to continue/i,
    /\(Y\/N\)/i
  ]
};

/**
 * Connection client types
 */
export const CLIENT_TYPES = {
  SSH_EXEC: 'ssh-exec',     // Standard SSH exec (Linux servers)
  SSH_SHELL: 'ssh-shell',   // Interactive SSH shell (Huawei switches)
  TELNET: 'telnet'          // Telnet (legacy devices)
};

/**
 * Clean ANSI escape codes and control characters from output
 * @param {string} output - Raw output
 * @returns {string} - Cleaned output
 */
export function cleanOutput(output) {
  if (!output) return '';

  let cleaned = output;

  // Remove "---- More ----" pagination markers
  cleaned = cleaned.replace(/----\s*More\s*----/gi, '');

  // Remove ANSI escape codes
  cleaned = cleaned.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Remove backspace sequences
  cleaned = cleaned.replace(/.\x08/g, '');

  // Remove Telnet IAC negotiation bytes
  cleaned = cleaned.replace(/[\xff][\xfb\xfc\xfd\xfe]./g, '');

  // Remove null bytes
  cleaned = cleaned.replace(/\x00/g, '');

  // Normalize line endings
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return cleaned.trim();
}

/**
 * Create a timeout promise
 * @param {number} ms - Timeout in milliseconds
 * @param {string} message - Error message on timeout
 * @returns {Promise} - Rejects after timeout
 */
export function createTimeout(ms, message = 'Operation timed out') {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Race a promise against a timeout
 * @param {Promise} promise - Promise to race
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} timeoutMessage - Error message on timeout
 * @returns {Promise} - Result of promise or timeout error
 */
export async function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    createTimeout(timeoutMs, timeoutMessage)
  ]);
}

export default {
  DEFAULT_CONFIG,
  SSH_ALGORITHMS,
  HUAWEI_PATTERNS,
  CLIENT_TYPES,
  cleanOutput,
  createTimeout,
  withTimeout
};
