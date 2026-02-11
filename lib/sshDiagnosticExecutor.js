/**
 * SSH Diagnostic Executor
 *
 * Esegue comandi diagnostici su switch Huawei via SSH.
 * Include validazione, logging e parsing output.
 *
 * SICUREZZA: Usa sshCommandValidator per ogni comando.
 *
 * @version 1.0.0
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { validateCommand, validateWithLLM, ValidationResult } from './sshCommandValidator.js';
import { COMMANDS, parseMacTable, parseArpTable, parseLldpNeighbors } from './huaweiCommands.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const SSH_CONFIG = {
  defaultTimeout: 30000,       // 30s timeout
  maxOutputSize: 1024 * 1024,  // 1MB max output
  connectTimeout: 10000,       // 10s connect timeout
  maxConcurrent: 5,            // Max concurrent SSH sessions
  retryAttempts: 2,            // Retry on failure
  retryDelay: 2000             // 2s between retries
};

// Default credentials (should be overridden per-device)
const DEFAULT_CREDENTIALS = {
  username: 'admin',
  password: 'admin'
};

// Track active sessions
const activeSessions = new Set();

// Execution history for audit
const executionHistory = [];
const MAX_HISTORY = 1000;

// =============================================================================
// SSH EXECUTION
// =============================================================================

/**
 * Execute a single SSH command on a device
 *
 * @param {string} device - Device IP or hostname
 * @param {string} command - Command to execute
 * @param {object} options - Execution options
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export async function executeCommand(device, command, options = {}) {
  const startTime = Date.now();
  const sessionId = `${device}-${Date.now()}`;

  // Check concurrent session limit
  if (activeSessions.size >= SSH_CONFIG.maxConcurrent) {
    return {
      success: false,
      error: 'Too many concurrent SSH sessions',
      device,
      command
    };
  }

  // Validate command first
  const validation = validateCommand(command);

  if (validation.status === ValidationResult.DENIED) {
    logExecution(device, command, false, validation.reason, 0);
    return {
      success: false,
      error: `Command denied: ${validation.reason}`,
      validation,
      device,
      command
    };
  }

  if (validation.status === ValidationResult.NEEDS_LLM_CHECK && options.llmValidator) {
    const llmValidation = await validateWithLLM(command, options.llmValidator);
    if (llmValidation.status !== ValidationResult.ALLOWED) {
      logExecution(device, command, false, llmValidation.reason, 0);
      return {
        success: false,
        error: `Command denied by LLM: ${llmValidation.reason}`,
        validation: llmValidation,
        device,
        command
      };
    }
  }

  // Get credentials
  const credentials = options.credentials || getCredentialsForDevice(device);

  activeSessions.add(sessionId);

  try {
    const result = await executeWithExpect(device, command, credentials, options);
    const duration = Date.now() - startTime;

    logExecution(device, command, result.success, result.error, duration);

    return {
      ...result,
      device,
      command,
      duration
    };

  } finally {
    activeSessions.delete(sessionId);
  }
}

/**
 * Execute SSH command using expect script
 */
async function executeWithExpect(device, command, credentials, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || SSH_CONFIG.defaultTimeout;

    // Build expect script
    const expectScript = buildExpectScript(device, command, credentials, timeout);

    // Spawn expect process
    const proc = spawn('expect', ['-c', expectScript], {
      timeout: timeout + 5000,
      maxBuffer: SSH_CONFIG.maxOutputSize
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      // Limit output size
      if (stdout.length > SSH_CONFIG.maxOutputSize) {
        stdout = stdout.substring(0, SSH_CONFIG.maxOutputSize);
        proc.kill('SIGTERM');
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (timedOut) {
        resolve({
          success: false,
          error: 'SSH command timed out',
          output: stdout
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          error: stderr || `SSH exited with code ${code}`,
          output: stdout
        });
        return;
      }

      // Clean output (remove expect artifacts)
      const cleanOutput = cleanSshOutput(stdout, command);

      resolve({
        success: true,
        output: cleanOutput,
        rawOutput: stdout
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        success: false,
        error: `SSH process error: ${err.message}`
      });
    });
  });
}

/**
 * Build expect script for SSH execution
 * Uses sequential expect pattern (more reliable than exp_continue)
 */
function buildExpectScript(device, command, credentials, timeout) {
  const timeoutSec = Math.ceil(timeout / 1000);
  // Escape special characters in password for Tcl
  const escapedPassword = credentials.password
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  return `
log_user 1
set timeout ${timeoutSec}

spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=${Math.ceil(SSH_CONFIG.connectTimeout / 1000)} ${credentials.username}@${device}

# Wait for password prompt
expect {
  timeout {
    puts "TIMEOUT: Connection timed out waiting for password"
    exit 1
  }
  "Connection refused" {
    puts "ERROR: Connection refused"
    exit 1
  }
  "No route to host" {
    puts "ERROR: No route to host"
    exit 1
  }
  "assword:" {
    send "${escapedPassword}\\r"
  }
}

# Wait for shell prompt
expect {
  timeout {
    puts "TIMEOUT: Login failed or prompt not found"
    exit 1
  }
  ">" {}
  "#" {}
}

# Disable paging
send "screen-length 0 temporary\\r"
expect {
  timeout {
    puts "TIMEOUT: screen-length command failed"
    exit 1
  }
  ">" {}
  "#" {}
}

# Execute the command
send "${command.replace(/"/g, '\\"')}\\r"
expect {
  timeout {
    puts "TIMEOUT: Command timed out"
    exit 1
  }
  ">" {}
  "#" {}
}

# Exit cleanly
send "quit\\r"
expect eof
exit 0
  `.trim();
}

/**
 * Clean SSH output from expect artifacts
 */
function cleanSshOutput(output, command) {
  let clean = output;

  // Remove ANSI escape codes
  clean = clean.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');

  // Remove the command echo
  const cmdEscaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  clean = clean.replace(new RegExp(cmdEscaped + '\\r?\\n?', 'g'), '');

  // Remove expect artifacts
  clean = clean.replace(/spawn ssh.*\r?\n/g, '');
  clean = clean.replace(/\[Pp\]assword:.*\r?\n/g, '');
  clean = clean.replace(/screen-length.*\r?\n/g, '');
  clean = clean.replace(/quit\r?\n/g, '');
  clean = clean.replace(/Connection to.*closed.*\r?\n/g, '');

  // Remove leading/trailing whitespace
  clean = clean.trim();

  return clean;
}

/**
 * Get credentials for a device
 */
function getCredentialsForDevice(device) {
  // Load credentials from Pdv.CSV based on network prefix
  try {
    const csvPath = '/var/netmap/Pdv.CSV';
    const csvContent = readFileSync(csvPath, 'utf8');
    const lines = csvContent.trim().split(/\r?\n/);

    // Extract network prefix from device IP (first 3 octets)
    const devicePrefix = device.split('.').slice(0, 3).join('.');

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(';');
      if (parts.length >= 5) {
        const network = parts[2] || '';
        const networkPrefix = network.split('/')[0].split('.').slice(0, 3).join('.');

        if (networkPrefix === devicePrefix) {
          const username = parts[3]?.trim() || 'admin';
          const password = parts[4]?.trim() || '';
          console.log(`[SSH] Using creds for ${networkPrefix}: ${username}`);
          return { username, password };
        }
      }
    }
  } catch (err) {
    console.error('[SSH] Error loading creds:', err.message);
  }

  console.log('[SSH] Using default credentials');
  return DEFAULT_CREDENTIALS;
}

// =============================================================================
// BATCH EXECUTION
// =============================================================================

/**
 * Execute multiple commands on a device in sequence
 *
 * @param {string} device - Device IP or hostname
 * @param {string[]} commands - Commands to execute
 * @param {object} options - Execution options
 * @returns {Promise<object[]>} Results for each command
 */
export async function executeSequence(device, commands, options = {}) {
  const results = [];

  for (const command of commands) {
    const result = await executeCommand(device, command, options);
    results.push(result);

    // Stop on error if configured
    if (!result.success && options.stopOnError) {
      break;
    }

    // Small delay between commands
    if (options.delayBetween) {
      await new Promise(resolve => setTimeout(resolve, options.delayBetween));
    }
  }

  return results;
}

/**
 * Execute a command on multiple devices in parallel
 *
 * @param {string[]} devices - Device IPs or hostnames
 * @param {string} command - Command to execute
 * @param {object} options - Execution options
 * @returns {Promise<Map<string, object>>} Results per device
 */
export async function executeOnMultipleDevices(devices, command, options = {}) {
  const maxParallel = options.maxParallel || SSH_CONFIG.maxConcurrent;
  const results = new Map();
  const queue = [...devices];

  const executeOne = async () => {
    while (queue.length > 0) {
      const device = queue.shift();
      const result = await executeCommand(device, command, options);
      results.set(device, result);
    }
  };

  // Create parallel workers
  const workers = [];
  for (let i = 0; i < Math.min(maxParallel, devices.length); i++) {
    workers.push(executeOne());
  }

  await Promise.all(workers);
  return results;
}

// =============================================================================
// DIAGNOSTIC WORKFLOWS
// =============================================================================

/**
 * Run a MAC search diagnostic workflow
 *
 * @param {string} device - Switch IP
 * @param {string} mac - MAC address to search
 * @param {object} options - Options
 * @returns {Promise<object>} Diagnostic result
 */
export async function runMacSearchDiagnostic(device, mac, options = {}) {
  const results = {
    device,
    mac,
    found: false,
    interface: null,
    vlan: null,
    ip: null,
    details: {}
  };

  // Step 1: Search MAC table
  const macResult = await executeCommand(device, COMMANDS.mac.byMac(mac), options);
  if (macResult.success) {
    const parsed = parseMacTable(macResult.output);
    if (parsed.length > 0) {
      results.found = true;
      results.interface = parsed[0].interface;
      results.vlan = parsed[0].vlan;
      results.details.macTable = parsed;
    }
  }

  // Step 2: Check ARP for IP
  const arpResult = await executeCommand(device, COMMANDS.arp.all, options);
  if (arpResult.success) {
    const parsed = parseArpTable(arpResult.output);
    const arpEntry = parsed.find(e => e.mac.toLowerCase() === mac.toLowerCase().replace(/:/g, '-'));
    if (arpEntry) {
      results.ip = arpEntry.ip;
      results.details.arp = arpEntry;
    }
  }

  // Step 3: If found on a trunk, check LLDP
  if (results.interface && results.interface.toLowerCase().includes('trunk')) {
    const lldpResult = await executeCommand(device, COMMANDS.lldp.neighborDetail(results.interface), options);
    if (lldpResult.success) {
      const parsed = parseLldpNeighbors(lldpResult.output);
      results.details.lldp = parsed;
    }
  }

  return results;
}

/**
 * Run interface diagnostic workflow
 *
 * @param {string} device - Switch IP
 * @param {string} iface - Interface name
 * @param {object} options - Options
 * @returns {Promise<object>} Diagnostic result
 */
export async function runInterfaceDiagnostic(device, iface, options = {}) {
  const commands = [
    { name: 'status', cmd: COMMANDS.interface.single(iface) },
    { name: 'errors', cmd: COMMANDS.interface.errors(iface) },
    { name: 'lldp', cmd: COMMANDS.lldp.neighborDetail(iface) },
    { name: 'macs', cmd: COMMANDS.mac.byInterface(iface) }
  ];

  const results = {
    device,
    interface: iface,
    status: null,
    errors: false,
    neighbor: null,
    macCount: 0,
    details: {}
  };

  for (const { name, cmd } of commands) {
    const result = await executeCommand(device, cmd, options);
    results.details[name] = result;

    if (name === 'macs' && result.success) {
      const parsed = parseMacTable(result.output);
      results.macCount = parsed.length;
    }

    if (name === 'errors' && result.success) {
      results.errors = /error|crc|collision/i.test(result.output);
    }

    if (name === 'lldp' && result.success) {
      const parsed = parseLldpNeighbors(result.output);
      if (parsed.length > 0) {
        results.neighbor = parsed[0].systemName || parsed[0].chassisId;
      }
    }
  }

  return results;
}

// =============================================================================
// LOGGING & AUDIT
// =============================================================================

/**
 * Log command execution for audit
 */
function logExecution(device, command, success, error, duration) {
  const entry = {
    timestamp: new Date().toISOString(),
    device,
    command,
    success,
    error,
    duration
  };

  executionHistory.unshift(entry);

  // Keep history bounded
  while (executionHistory.length > MAX_HISTORY) {
    executionHistory.pop();
  }

  // Console log
  const status = success ? '✓' : '✗';
  console.log(`[SSH] ${status} ${device}: ${command} (${duration}ms)`);
}

/**
 * Get execution history
 */
export function getExecutionHistory(limit = 100) {
  return executionHistory.slice(0, limit);
}

/**
 * Get execution stats
 */
export function getExecutionStats() {
  const total = executionHistory.length;
  const successful = executionHistory.filter(e => e.success).length;
  const failed = total - successful;
  const avgDuration = total > 0
    ? executionHistory.reduce((sum, e) => sum + e.duration, 0) / total
    : 0;

  return {
    total,
    successful,
    failed,
    successRate: total > 0 ? ((successful / total) * 100).toFixed(1) + '%' : 'N/A',
    avgDuration: Math.round(avgDuration),
    activeSessions: activeSessions.size,
    maxConcurrent: SSH_CONFIG.maxConcurrent
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  executeCommand,
  executeSequence,
  executeOnMultipleDevices,
  runMacSearchDiagnostic,
  runInterfaceDiagnostic,
  getExecutionHistory,
  getExecutionStats,
  SSH_CONFIG
};
