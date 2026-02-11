#!/usr/bin/env node
/**
 * Import links da NeDi MySQL database via SSH
 * Aggiorna local_ifname e remote interface dai dati NeDi
 */

import Database from 'better-sqlite3';
import { Client } from 'ssh2';

// Database locale SQLite
const localDb = new Database('./netmap.db');

// Converti IP numerico in dotted notation
function longToIp(long) {
  return [
    (long >>> 24) & 255,
    (long >>> 16) & 255,
    (long >>> 8) & 255,
    long & 255,
  ].join('.');
}

function execSshCommand(config, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', () => {
          conn.end();
          resolve({ stdout, stderr });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect(config);
  });
}

async function importViaSsh() {
  const sshConfig = {
    host: process.env.NEDI_SSH_HOST || 'localhost',
    port: 22,
    username: process.env.NEDI_SSH_USER || 'root',
    password: process.env.NEDI_SSH_PASS || '',
  };

  try {
    console.log('[NeDi Import] Connessione SSH a NeDi...');

    // Query MySQL via SSH - filtro per negozio 10 (device inizia con "10_")
    // IP range in formato numerico (adjust per il vostro range di rete)
    // Range: 168430592 (192.168.10.0) - 168430847 (192.168.10.255)
    const mysqlCmd = `mysql -u nedi -p$NEDI_MYSQL_PASS nedi -N -e "
      SELECT
        d.devip,
        d.device,
        l.ifname,
        l.neighbor,
        l.nbrifname
      FROM links l
      JOIN devices d ON l.device = d.device
      WHERE d.device LIKE '10\\_%'
        AND l.neighbor IS NOT NULL
        AND l.neighbor != ''
        AND l.ifname IS NOT NULL
    "`;

    const result = await execSshCommand(sshConfig, mysqlCmd);

    if (result.stderr && !result.stderr.includes('Warning')) {
      console.error('[NeDi Import] MySQL warning:', result.stderr);
    }

    const lines = result.stdout.trim().split('\n').filter(l => l);
    console.log(`[NeDi Import] Trovati ${lines.length} link per negozio 10 in NeDi`);

    if (lines.length === 0) {
      console.log('[NeDi Import] Nessun link trovato per negozio 10');
      return;
    }

    // Mostra alcuni esempi con IP convertito
    console.log('[NeDi Import] Esempi (IP convertito):');
    lines.slice(0, 5).forEach(l => {
      const parts = l.split('\t');
      const ip = longToIp(parseInt(parts[0]));
      console.log(`   ${ip}\t${parts[1]}\t${parts[2]}\t${parts[3]}\t${parts[4]}`);
    });

    // Prepara update statements - MATCHA PER NEIGHBOR per evitare update errati
    // Il match deve essere fatto sia per device (IP) che per neighbor (remote_sysname)
    const updateLocalStmt = localDb.prepare(`
      UPDATE links
      SET local_ifname = ?
      WHERE device_id IN (SELECT id FROM devices WHERE ip = ?)
        AND (remote_sysname = ? OR remote_sysname LIKE ?)
        AND (local_ifname IS NULL OR local_ifname = '')
    `);

    const updateRemoteStmt = localDb.prepare(`
      UPDATE links
      SET remote_portdesc = ?
      WHERE device_id IN (SELECT id FROM devices WHERE ip = ?)
        AND (remote_sysname = ? OR remote_sysname LIKE ?)
        AND (remote_portdesc IS NULL OR remote_portdesc = '')
    `);

    let updatedLocal = 0;
    let updatedRemote = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 5) continue;

      const [ipLong, localSysname, localIf, remoteSysname, remoteIf] = parts;
      const localIp = longToIp(parseInt(ipLong));

      // Skip se neighbor è un MAC address (non possiamo matchare)
      if (!remoteSysname || /^[0-9a-f]{12}$/i.test(remoteSysname)) continue;

      // Update local interface - matcha per IP device E neighbor
      if (localIf && localIp && remoteSysname) {
        const neighborPattern = `%${remoteSysname}%`;
        const r1 = updateLocalStmt.run(localIf, localIp, remoteSysname, neighborPattern);
        if (r1.changes > 0) updatedLocal += r1.changes;
      }

      // Update remote interface - stessa logica
      if (remoteIf && remoteIf !== '-' && localIp && remoteSysname) {
        const neighborPattern = `%${remoteSysname}%`;
        const r2 = updateRemoteStmt.run(remoteIf, localIp, remoteSysname, neighborPattern);
        if (r2.changes > 0) updatedRemote += r2.changes;
      }
    }

    console.log(`[NeDi Import] Aggiornati: ${updatedLocal} local_ifname, ${updatedRemote} remote_portdesc`);

    // Statistiche finali
    const stats = localDb.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN local_ifname IS NOT NULL AND local_ifname != '' THEN 1 ELSE 0 END) as with_local_if,
        SUM(CASE WHEN remote_portdesc IS NOT NULL AND remote_portdesc != '' THEN 1 ELSE 0 END) as with_remote_if
      FROM links
    `).get();

    console.log('[NeDi Import] Statistiche finali:', stats);

  } catch (err) {
    console.error('[NeDi Import] Errore:', err.message);
  }
}

importViaSsh();
