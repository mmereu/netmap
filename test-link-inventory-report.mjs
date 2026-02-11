#!/usr/bin/env node

/**
 * Test endpoint GET /api/reports/links
 *
 * Uso:
 *   node test-link-inventory-report.mjs
 *   node test-link-inventory-report.mjs --full
 */

import http from 'http';

const PORT = 3000;
const HOST = 'localhost';

const options = {
  hostname: HOST,
  port: PORT,
  path: '/api/reports/links',
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    process.stdout.write(`\nStatus: ${res.statusCode} ${res.statusMessage}\n`);

    try {
      const json = JSON.parse(data);

      // Validate response structure
      const validationErrors = [];

      if (!json.generated) {
        validationErrors.push('Missing "generated" field');
      }
      if (!json.summary) {
        validationErrors.push('Missing "summary" field');
      } else {
        if (typeof json.summary.totalLinks !== 'number') {
          validationErrors.push('Missing or invalid "summary.totalLinks"');
        }
        if (!json.summary.linksByProtocol || typeof json.summary.linksByProtocol !== 'object') {
          validationErrors.push('Missing or invalid "summary.linksByProtocol"');
        }
        if (!json.summary.linksBySpeed || typeof json.summary.linksBySpeed !== 'object') {
          validationErrors.push('Missing or invalid "summary.linksBySpeed"');
        }
        if (typeof json.summary.resolvedLinks !== 'number') {
          validationErrors.push('Missing or invalid "summary.resolvedLinks"');
        }
        if (typeof json.summary.unresolvedLinks !== 'number') {
          validationErrors.push('Missing or invalid "summary.unresolvedLinks"');
        }
      }
      if (!Array.isArray(json.byDevice)) {
        validationErrors.push('Missing or invalid "byDevice" array');
      }

      if (validationErrors.length > 0) {
        process.stdout.write('\nValidation FAILED:\n');
        validationErrors.forEach(err => process.stdout.write(`  - ${err}\n`));
        process.exit(1);
      }

      // Print summary
      process.stdout.write('\n--- LINK INVENTORY REPORT ---\n');
      process.stdout.write(`Generated: ${json.generated}\n\n`);

      process.stdout.write('SUMMARY:\n');
      process.stdout.write(`  Total Links:      ${json.summary.totalLinks}\n`);
      process.stdout.write(`  Resolved Links:   ${json.summary.resolvedLinks}\n`);
      process.stdout.write(`  Unresolved Links: ${json.summary.unresolvedLinks}\n`);

      process.stdout.write('\nLINKS BY PROTOCOL:\n');
      const protocols = Object.entries(json.summary.linksByProtocol);
      if (protocols.length === 0) {
        process.stdout.write('  (none)\n');
      } else {
        protocols.forEach(([protocol, count]) => {
          process.stdout.write(`  ${protocol}: ${count}\n`);
        });
      }

      process.stdout.write('\nLINKS BY SPEED:\n');
      const speeds = Object.entries(json.summary.linksBySpeed);
      if (speeds.length === 0) {
        process.stdout.write('  (none)\n');
      } else {
        speeds.forEach(([speed, count]) => {
          process.stdout.write(`  ${speed}: ${count}\n`);
        });
      }

      process.stdout.write('\nDEVICES:\n');
      process.stdout.write(`  Total devices with links: ${json.byDevice.length}\n`);

      if (json.byDevice.length > 0 && process.argv.includes('--full')) {
        process.stdout.write('\nPER-DEVICE BREAKDOWN:\n');
        json.byDevice.forEach(device => {
          process.stdout.write(`\n  ${device.sysname || device.ip || 'Unknown'} (${device.ip || 'N/A'}):\n`);
          process.stdout.write(`    Total: ${device.totalLinks}, Resolved: ${device.resolvedLinks}, Unresolved: ${device.unresolvedLinks}\n`);
        });
      }

      process.stdout.write('\n-----------------------------\n');
      process.stdout.write('\nValidation PASSED\n\n');

      if (process.argv.includes('--json')) {
        process.stdout.write('\nFULL JSON:\n');
        process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      } else if (!process.argv.includes('--full')) {
        process.stdout.write('Use --full for per-device breakdown, --json for full JSON output\n');
      }

    } catch (err) {
      process.stderr.write(`\nError parsing JSON: ${err.message}\n`);
      process.stderr.write(`Raw response: ${data}\n`);
      process.exit(1);
    }
  });
});

req.on('error', (error) => {
  process.stderr.write(`\nHTTP request error: ${error.message}\n`);
  process.stderr.write('\nMake sure the server is running on http://localhost:3000\n');
  process.exit(1);
});

req.end();
