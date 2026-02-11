/**
 * Test suite for lib/connection module
 */
import {
  DEFAULT_CONFIG,
  SSH_ALGORITHMS,
  HUAWEI_PATTERNS,
  CLIENT_TYPES,
  cleanOutput,
  createClient,
  getClientImportPath
} from './lib/connection/index.js';

let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('\n=== Connection Module Test Suite ===\n');

// DEFAULT_CONFIG tests
console.log('DEFAULT_CONFIG:');
test('has port', DEFAULT_CONFIG.port === 22);
test('has readyTimeout', DEFAULT_CONFIG.readyTimeout === 20000);
test('has keepaliveInterval', DEFAULT_CONFIG.keepaliveInterval === 10000);
test('has commandTimeout', DEFAULT_CONFIG.commandTimeout === 30000);

// SSH_ALGORITHMS tests
console.log('\nSSH_ALGORITHMS:');
test('has kex algorithms', SSH_ALGORITHMS.kex.length > 5);
test('has cipher algorithms', SSH_ALGORITHMS.cipher.length > 5);
test('has serverHostKey', SSH_ALGORITHMS.serverHostKey.length > 5);
test('has hmac algorithms', SSH_ALGORITHMS.hmac.length >= 3);
test('includes legacy diffie-hellman-group1-sha1', SSH_ALGORITHMS.kex.includes('diffie-hellman-group1-sha1'));

// HUAWEI_PATTERNS tests
console.log('\nHUAWEI_PATTERNS:');
test('has prompt patterns', HUAWEI_PATTERNS.prompt.length === 4);
test('has pagination pattern', HUAWEI_PATTERNS.pagination instanceof RegExp);
test('has confirm patterns', HUAWEI_PATTERNS.confirm.length === 3);
test('prompt pattern matches <hostname>', HUAWEI_PATTERNS.prompt[0].test('<SW-CORE-01>'));
test('prompt pattern matches [hostname]', HUAWEI_PATTERNS.prompt[1].test('[SW-CORE-01]'));
test('pagination matches More', HUAWEI_PATTERNS.pagination.test('---- More ----'));

// CLIENT_TYPES tests
console.log('\nCLIENT_TYPES:');
test('has SSH_EXEC', CLIENT_TYPES.SSH_EXEC === 'ssh-exec');
test('has SSH_SHELL', CLIENT_TYPES.SSH_SHELL === 'ssh-shell');
test('has TELNET', CLIENT_TYPES.TELNET === 'telnet');

// cleanOutput tests
console.log('\ncleanOutput:');
test('removes More markers', !cleanOutput('output---- More ----more').includes('More'));
test('removes ANSI codes', !cleanOutput('test\x1b[32mcolor\x1b[0m').includes('\x1b'));
test('removes null bytes', !cleanOutput('test\x00null').includes('\x00'));
test('trims whitespace', cleanOutput('  test  ') === 'test');
test('handles empty string', cleanOutput('') === '');
test('handles null', cleanOutput(null) === '');

// createClient tests
console.log('\ncreateClient:');
const huaweiClient = createClient({ vendor: 'Huawei' });
test('Huawei uses ssh-shell', huaweiClient.type === 'ssh-shell');
test('Huawei module is switchSSH', huaweiClient.module === 'switchSSH');

const linuxClient = createClient({ vendor: 'Linux' });
test('Linux uses ssh-exec', linuxClient.type === 'ssh-exec');
test('Linux module is sshAgent', linuxClient.module === 'sshAgent');

const telnetClient = createClient({ protocol: 'telnet' });
test('Telnet protocol uses telnet', telnetClient.type === 'telnet');
test('Telnet module is switchTelnet', telnetClient.module === 'switchTelnet');

const h3cClient = createClient({ vendor: 'H3C' });
test('H3C uses ssh-shell', h3cClient.type === 'ssh-shell');

const unknownClient = createClient({ vendor: 'Unknown' });
test('Unknown defaults to ssh-shell', unknownClient.type === 'ssh-shell');

const interactiveClient = createClient({ vendor: 'Cisco', interactive: true });
test('Force interactive uses ssh-shell', interactiveClient.type === 'ssh-shell');

// getClientImportPath tests
console.log('\ngetClientImportPath:');
test('ssh-exec path', getClientImportPath('ssh-exec') === '../sshAgent.js');
test('ssh-shell path', getClientImportPath('ssh-shell') === './switchSSH.js');
test('telnet path', getClientImportPath('telnet') === './switchTelnet.js');
test('unknown defaults to ssh-shell', getClientImportPath('unknown') === './switchSSH.js');

// Summary
console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
