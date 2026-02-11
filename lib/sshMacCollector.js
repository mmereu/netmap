/**
 * SSH MAC Collector - Raccolta periodica MAC address via SSH
 *
 * Scansiona switch Huawei via SSH per raccogliere TUTTI i MAC address
 * e li inserisce direttamente nel database NeDi MySQL.
 *
 * Risolve il problema: NeDi SNMP perde ~70% dei MAC sugli Huawei.
 * SSH "display mac-address" li trova tutti.
 *
 * Usa wrapper OpenSSH (sshpass + ssh) per compatibilità con algoritmi
 * legacy degli switch Huawei (dh-group1-sha1, dh-group14-sha1).
 *
 * @module sshMacCollector
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseHuaweiMacTable } from './huaweiLldpParser.js';

const execAsync = promisify(exec);

/**
 * SSH MAC Collector
 *
 * Raccoglie MAC address da switch Huawei via SSH e li inserisce in NeDi.
 */
class SshMacCollector {
  /**
   * @param {Object} nediDb - Istanza NeDiDB per accesso MySQL
   * @param {Object} options - Opzioni di configurazione
   * @param {number} [options.intervalMs=900000] - Intervallo tra run (default 15 min)
   * @param {number} [options.concurrency=5] - Switch in parallelo
   * @param {Object} [options.credentials] - Credenziali SSH default
   * @param {Map} [options.credentialsByNetwork] - Map<network, {username, password}>
   * @param {boolean} [options.autoStart=false] - Avvia automaticamente
   */
  constructor(nediDb, options = {}) {
    this.nedi = nediDb;
    this.intervalMs = options.intervalMs || 15 * 60 * 1000; // 15 minuti
    this.concurrency = options.concurrency || 5;
    this.credentials = options.credentials || {
      username: process.env.SWITCH_SSH_USER || 'admin',
      password: process.env.SWITCH_SSH_PASS || ''
    };
    // Mappa credenziali per network (es. "10.5.4" -> {username, password})
    this.credentialsByNetwork = options.credentialsByNetwork || new Map();

    // Timeout SSH in secondi
    this.sshTimeout = options.sshTimeout || 30;

    // Statistiche
    this.stats = {
      lastRun: null,
      lastDuration: 0,
      switchesTotal: 0,
      switchesOk: 0,
      switchesFailed: 0,
      macsInserted: 0,
      macsUpdated: 0,
      macsTotal: 0,
      errors: []
    };

    // Timer per scheduling
    this._timer = null;
    this._running = false;

    // Auto-start se richiesto
    if (options.autoStart) {
      this.start();
    }
  }

  /**
   * Converte IP numerico NeDi in stringa dotted-decimal
   * NeDi salva IP come INT: 171705382 -> 192.168.5.38
   *
   * @param {number} ipNum - IP numerico
   * @returns {string} IP in formato stringa
   */
  numericIpToString(ipNum) {
    if (typeof ipNum === 'string') return ipNum; // Già stringa
    if (!ipNum || isNaN(ipNum)) return null;

    const num = parseInt(ipNum, 10);
    return [
      (num >>> 24) & 255,
      (num >>> 16) & 255,
      (num >>> 8) & 255,
      num & 255
    ].join('.');
  }

  /**
   * Ottiene le credenziali SSH per un IP specifico
   * Cerca nella mappa per network (es. "10.5.4" per 192.168.5.38)
   *
   * @param {string} ip - IP dello switch
   * @returns {Object} Credenziali {username, password}
   */
  getCredentialsForIp(ip) {
    if (!ip || typeof ip !== 'string') return this.credentials;

    // Estrai il network prefix (primi 3 ottetti)
    const parts = ip.split('.');
    if (parts.length !== 4) return this.credentials;

    const networkPrefix = parts.slice(0, 3).join('.');

    // Cerca nelle credenziali per network
    if (this.credentialsByNetwork.has(networkPrefix)) {
      const creds = this.credentialsByNetwork.get(networkPrefix);
      if (creds?.username && creds?.password) {
        return creds;
      }
    }

    // Fallback alle credenziali default
    return this.credentials;
  }

  /**
   * Esegue comando SSH via expect per sessione interattiva
   * Gli switch Huawei richiedono sessione interattiva (non comandi diretti)
   *
   * @param {string} host - IP dello switch
   * @param {string} username - Username SSH
   * @param {string} password - Password SSH
   * @param {string} command - Comando da eseguire
   * @returns {Promise<Object>} { success, output, error }
   */
  async executeViaOpenSSH(host, username, password, command) {
    // Genera nome file temporaneo unico
    const scriptPath = join(tmpdir(), `ssh_expect_${host.replace(/\./g, '_')}_${Date.now()}.exp`);

    // Escape password per TCL (backslash, dollaro, brackets, quotes)
    const escapedPassword = password
      .replace(/\\/g, '\\\\')
      .replace(/\$/g, '\\$')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/"/g, '\\"')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}');

    // Script expect per sessione SSH interattiva Huawei
    // NOTA: TCL richiede {pattern} per regex, non "pattern"
    // Disabilita paging con screen-length 0 temporary
    const expectScript = `#!/usr/bin/expect -f
set timeout ${this.sshTimeout}
log_user 0

spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=${this.sshTimeout} -o KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1,diffie-hellman-group-exchange-sha1 -o HostKeyAlgorithms=+ssh-rsa,ssh-dss ${username}@${host}

expect {
  "User Authentication" {
    # Banner Huawei - ignora e continua ad aspettare password
    exp_continue
  }
  "Are you sure you want to continue" {
    # SSH host key confirmation
    send "yes\\r"
    exp_continue
  }
  -nocase {password:} {
    send "${escapedPassword}\\r"
  }
  timeout {
    puts "EXPECT_ERROR: Connection timeout"
    exit 1
  }
  eof {
    puts "EXPECT_ERROR: Connection closed"
    exit 1
  }
}

# Attendi prompt Huawei <hostname> o [hostname]
expect {
  -re {<[^>]+>} {}
  -re {\\[[^\\]]+\\]} {}
  timeout {
    puts "EXPECT_ERROR: No prompt after login"
    exit 1
  }
}

# Disabilita paging per output completo
send "screen-length 0 temporary\\r"
expect {
  -re {<[^>]+>} {}
  -re {\\[[^\\]]+\\]} {}
  timeout {
    puts "EXPECT_ERROR: screen-length timeout"
    exit 1
  }
}

# Abilita output
log_user 1

# Esegui comando principale
send "${command}\\r"

# Attendi output completo e nuovo prompt
expect {
  -re {<[^>]+>} {
    send "quit\\r"
  }
  -re {\\[[^\\]]+\\]} {
    send "quit\\r"
  }
  timeout {
    puts "EXPECT_ERROR: Command timeout"
    exit 1
  }
}

expect eof
exit 0
`;

    try {
      // Scrivi script expect su file
      await writeFile(scriptPath, expectScript, { mode: 0o700 });

      // Esegui script
      const { stdout, stderr } = await execAsync(`expect ${scriptPath}`, {
        timeout: (this.sshTimeout + 15) * 1000,
        maxBuffer: 10 * 1024 * 1024
      });

      // Cleanup file temporaneo
      try { await unlink(scriptPath); } catch (_) {}

      // Verifica errori expect
      if (stdout.includes('EXPECT_ERROR:')) {
        const errorMatch = stdout.match(/EXPECT_ERROR: (.+)/);
        return {
          success: false,
          output: '',
          error: errorMatch ? errorMatch[1] : 'Expect error'
        };
      }

      return {
        success: true,
        output: stdout,
        stderr: stderr
      };
    } catch (err) {
      // Cleanup file temporaneo in caso di errore
      try { await unlink(scriptPath); } catch (_) {}

      let errorMsg = err.message;

      if (err.killed) {
        errorMsg = 'SSH timeout';
      } else if (err.stdout?.includes('EXPECT_ERROR:')) {
        const errorMatch = err.stdout.match(/EXPECT_ERROR: (.+)/);
        errorMsg = errorMatch ? errorMatch[1] : 'Expect error';
      } else if (err.stderr) {
        errorMsg = err.stderr.trim() || err.message;
      }

      return {
        success: false,
        output: '',
        error: errorMsg
      };
    }
  }

  /**
   * Esegue comando via TELNET per switch che non supportano SSH
   * Fallback per switch Huawei che richiedono STELNET o hanno SSH disabilitato
   *
   * @param {string} host - IP dello switch
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {string} command - Comando da eseguire
   * @returns {Promise<Object>} { success, output, error }
   */
  async executeViaTelnet(host, username, password, command) {
    const scriptPath = join(tmpdir(), `telnet_expect_${host.replace(/\./g, '_')}_${Date.now()}.exp`);

    // Escape password per TCL
    const escapedPassword = password
      .replace(/\\/g, '\\\\')
      .replace(/\$/g, '\\$')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/"/g, '\\"')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}');

    const escapedUsername = username
      .replace(/\\/g, '\\\\')
      .replace(/\$/g, '\\$')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/"/g, '\\"');

    // Script expect per sessione TELNET interattiva Huawei
    const expectScript = `#!/usr/bin/expect -f
set timeout ${this.sshTimeout}
log_user 0

spawn telnet ${host} 23

# Attendi banner e prompt login
expect {
  "Connection refused" {
    puts "EXPECT_ERROR: Telnet connection refused"
    exit 1
  }
  "Unable to connect" {
    puts "EXPECT_ERROR: Telnet unable to connect"
    exit 1
  }
  "Connection closed" {
    puts "EXPECT_ERROR: Telnet connection closed"
    exit 1
  }
  -nocase "username:" {
    send "${escapedUsername}\\r"
  }
  -nocase "login:" {
    send "${escapedUsername}\\r"
  }
  timeout {
    puts "EXPECT_ERROR: Telnet connection timeout"
    exit 1
  }
  eof {
    puts "EXPECT_ERROR: Telnet connection failed"
    exit 1
  }
}

# Attendi password prompt
expect {
  -nocase "password:" {
    send "${escapedPassword}\\r"
  }
  timeout {
    puts "EXPECT_ERROR: No password prompt"
    exit 1
  }
}

# Attendi prompt Huawei <hostname> o [hostname]
expect {
  "Authentication fail" {
    puts "EXPECT_ERROR: Authentication failed"
    exit 1
  }
  "Login incorrect" {
    puts "EXPECT_ERROR: Login incorrect"
    exit 1
  }
  -re {<[^>]+>} {}
  -re {\\[[^\\]]+\\]} {}
  timeout {
    puts "EXPECT_ERROR: No prompt after login"
    exit 1
  }
}

# Disabilita paging per output completo
send "screen-length 0 temporary\\r"
expect {
  -re {<[^>]+>} {}
  -re {\\[[^\\]]+\\]} {}
  timeout {
    puts "EXPECT_ERROR: screen-length timeout"
    exit 1
  }
}

# Abilita output
log_user 1

# Esegui comando principale
send "${command}\\r"

# Attendi output completo e nuovo prompt
expect {
  -re {<[^>]+>} {
    send "quit\\r"
  }
  -re {\\[[^\\]]+\\]} {
    send "quit\\r"
  }
  timeout {
    puts "EXPECT_ERROR: Command timeout"
    exit 1
  }
}

expect eof
exit 0
`;

    try {
      await writeFile(scriptPath, expectScript, { mode: 0o700 });

      const { stdout, stderr } = await execAsync(`expect ${scriptPath}`, {
        timeout: (this.sshTimeout + 15) * 1000,
        maxBuffer: 10 * 1024 * 1024
      });

      try { await unlink(scriptPath); } catch (_) {}

      if (stdout.includes('EXPECT_ERROR:')) {
        const errorMatch = stdout.match(/EXPECT_ERROR: (.+)/);
        return {
          success: false,
          output: '',
          error: errorMatch ? errorMatch[1] : 'Telnet expect error'
        };
      }

      return {
        success: true,
        output: stdout,
        stderr: stderr,
        protocol: 'telnet'
      };
    } catch (err) {
      try { await unlink(scriptPath); } catch (_) {}

      let errorMsg = err.message;

      if (err.killed) {
        errorMsg = 'Telnet timeout';
      } else if (err.stdout?.includes('EXPECT_ERROR:')) {
        const errorMatch = err.stdout.match(/EXPECT_ERROR: (.+)/);
        errorMsg = errorMatch ? errorMatch[1] : 'Telnet expect error';
      } else if (err.stderr) {
        errorMsg = err.stderr.trim() || err.message;
      }

      return {
        success: false,
        output: '',
        error: errorMsg
      };
    }
  }

  /**
   * Ottiene lista switch Huawei da NeDi
   * Filtra per sysObjectID Huawei: 1.3.6.1.4.1.2011.*
   *
   * @returns {Promise<Array>} Lista switch con device, devip (stringa)
   */
  async getHuaweiSwitches() {
    const sql = `
      SELECT device, devip
      FROM devices
      WHERE sysobjid LIKE '1.3.6.1.4.1.2011%'
        AND devip IS NOT NULL
        AND devip != 0
      ORDER BY device
    `;

    const [rows] = await this.nedi.pool.query(sql);

    // Converti IP numerici in stringhe
    return rows.map(row => ({
      device: row.device,
      devip: this.numericIpToString(row.devip)
    })).filter(row => row.devip); // Rimuovi quelli senza IP valido
  }

  /**
   * Raccoglie MAC da uno switch via SSH con retry automatico e fallback Telnet
   *
   * @param {string} ip - IP dello switch
   * @param {string} deviceName - Nome device per logging
   * @param {number} [maxRetries=3] - Numero massimo di tentativi SSH
   * @returns {Promise<Object>} Risultato con success, macs[], error, protocol
   */
  async collectFromSwitch(ip, deviceName, maxRetries = 3) {
    const startTime = Date.now();

    // Errori per cui fare retry SSH (switch sovraccarico, connessioni instabili)
    const retryableErrors = [
      'Connection closed',
      'Connection reset',
      'Connection refused',
      'SSH timeout',
      'No prompt after login'
    ];

    // Errori che indicano di provare telnet come fallback
    const telnetFallbackErrors = [
      'Connection closed',
      'No prompt after login',
      'SSH timeout',
      'Connection refused'
    ];

    let lastSshError = null;
    const creds = this.getCredentialsForIp(ip);

    // === FASE 1: Tentativi SSH ===
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeViaOpenSSH(
          ip,
          creds.username,
          creds.password,
          'display mac-address'
        );

        if (!result.success) {
          throw new Error(result.error || 'SSH command failed');
        }

        const macs = parseHuaweiMacTable(result.output, deviceName);
        const retryInfo = attempt > 1 ? ` (SSH retry ${attempt - 1})` : '';
        console.log(`[MAC-Collector] ${deviceName} (${ip}): ${macs.length} MAC via SSH in ${Date.now() - startTime}ms${retryInfo}`);

        return {
          success: true,
          macs: macs,
          duration: Date.now() - startTime,
          attempts: attempt,
          protocol: 'ssh'
        };

      } catch (err) {
        lastSshError = err.message;

        const isRetryable = retryableErrors.some(e => err.message.includes(e));

        if (isRetryable && attempt < maxRetries) {
          const backoffMs = 2000 * attempt;
          console.log(`[MAC-Collector] ${deviceName} (${ip}) SSH attempt ${attempt} failed: ${err.message}, retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        break;
      }
    }

    // === FASE 2: Fallback Telnet (se SSH fallisce con errori specifici) ===
    const shouldTryTelnet = telnetFallbackErrors.some(e => lastSshError?.includes(e));

    if (shouldTryTelnet) {
      console.log(`[MAC-Collector] ${deviceName} (${ip}) SSH failed, trying TELNET fallback...`);

      try {
        const telnetResult = await this.executeViaTelnet(
          ip,
          creds.username,
          creds.password,
          'display mac-address'
        );

        if (telnetResult.success) {
          const macs = parseHuaweiMacTable(telnetResult.output, deviceName);
          console.log(`[MAC-Collector] ${deviceName} (${ip}): ${macs.length} MAC via TELNET in ${Date.now() - startTime}ms`);

          return {
            success: true,
            macs: macs,
            duration: Date.now() - startTime,
            attempts: maxRetries + 1,
            protocol: 'telnet'
          };
        } else {
          console.log(`[MAC-Collector] ${deviceName} (${ip}) TELNET fallback failed: ${telnetResult.error}`);
        }
      } catch (telnetErr) {
        console.log(`[MAC-Collector] ${deviceName} (${ip}) TELNET fallback error: ${telnetErr.message}`);
      }
    }

    // Tutti i tentativi falliti (SSH + Telnet)
    const finalError = shouldTryTelnet ? `SSH: ${lastSshError}, Telnet fallback also failed` : lastSshError;
    console.error(`[MAC-Collector] ${deviceName} (${ip}) FAILED after ${maxRetries} SSH attempts${shouldTryTelnet ? ' + Telnet' : ''}: ${lastSshError}`);

    return {
      success: false,
      macs: [],
      error: finalError,
      duration: Date.now() - startTime,
      attempts: maxRetries + (shouldTryTelnet ? 1 : 0),
      protocol: 'none'
    };
  }

  /**
   * Inserisce/aggiorna MAC in NeDi MySQL
   * Usa INSERT ... ON DUPLICATE KEY UPDATE per atomicità
   *
   * @param {Array} macs - Array di MAC objects
   * @returns {Promise<Object>} Statistiche insert/update
   */
  async upsertMacs(macs) {
    if (!macs || macs.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    const sql = `
      INSERT INTO nodes (mac, device, ifname, vlanid, firstseen, lastseen)
      VALUES (?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        device = VALUES(device),
        ifname = VALUES(ifname),
        vlanid = VALUES(vlanid),
        lastseen = NOW()
    `;

    let inserted = 0;
    let updated = 0;

    // Batch insert
    for (const mac of macs) {
      try {
        const [result] = await this.nedi.pool.query(sql, [
          mac.mac,
          mac.device,
          mac.portNormalized || mac.port,
          mac.vlan
        ]);

        // affectedRows: 1 = insert, 2 = update
        if (result.affectedRows === 1) {
          inserted++;
        } else if (result.affectedRows === 2) {
          updated++;
        }
      } catch (err) {
        // Ignora errori singoli, logga solo se critici
        if (!err.message.includes('Duplicate')) {
          console.error(`[MAC-Collector] Upsert error for ${mac.mac}: ${err.message}`);
        }
      }
    }

    return { inserted, updated };
  }

  /**
   * Esegue un run completo del collector
   *
   * @returns {Promise<Object>} Statistiche del run
   */
  async run() {
    if (this._running) {
      console.log('[MAC-Collector] Already running, skipping');
      return this.stats;
    }

    this._running = true;
    const startTime = Date.now();

    console.log('[MAC-Collector] Starting collection run...');

    // Reset stats per questo run
    this.stats = {
      lastRun: new Date(),
      lastDuration: 0,
      switchesTotal: 0,
      switchesOk: 0,
      switchesFailed: 0,
      macsInserted: 0,
      macsUpdated: 0,
      macsTotal: 0,
      errors: []
    };

    try {
      // 1. Ottieni lista switch Huawei
      const switches = await this.getHuaweiSwitches();
      this.stats.switchesTotal = switches.length;

      console.log(`[MAC-Collector] Found ${switches.length} Huawei switches`);

      if (switches.length === 0) {
        console.log('[MAC-Collector] No Huawei switches found, exiting');
        this._running = false;
        return this.stats;
      }

      // 2. Process in batch paralleli
      const batchSize = this.concurrency;
      for (let i = 0; i < switches.length; i += batchSize) {
        const batch = switches.slice(i, i + batchSize);

        const results = await Promise.all(
          batch.map(sw => this.collectFromSwitch(sw.devip, sw.device))
        );

        // 3. Upsert MAC per ogni switch del batch
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const sw = batch[j];

          if (result.success) {
            this.stats.switchesOk++;

            if (result.macs.length > 0) {
              const upsertStats = await this.upsertMacs(result.macs);
              this.stats.macsInserted += upsertStats.inserted;
              this.stats.macsUpdated += upsertStats.updated;
              this.stats.macsTotal += result.macs.length;
            }
          } else {
            this.stats.switchesFailed++;
            this.stats.errors.push({
              device: sw.device,
              ip: sw.devip,
              error: result.error
            });
          }
        }

        // Progress log ogni batch
        console.log(`[MAC-Collector] Progress: ${Math.min(i + batchSize, switches.length)}/${switches.length} switches`);
      }

      this.stats.lastDuration = Date.now() - startTime;

      console.log(`[MAC-Collector] Run complete in ${this.stats.lastDuration}ms`);
      console.log(`[MAC-Collector] Switches: ${this.stats.switchesOk}/${this.stats.switchesTotal} OK`);
      console.log(`[MAC-Collector] MACs: ${this.stats.macsInserted} inserted, ${this.stats.macsUpdated} updated, ${this.stats.macsTotal} total`);

      if (this.stats.switchesFailed > 0) {
        console.log(`[MAC-Collector] Failed: ${this.stats.switchesFailed} switches`);
      }

    } catch (err) {
      console.error(`[MAC-Collector] Run failed: ${err.message}`);
      this.stats.errors.push({ error: err.message });
    }

    this._running = false;
    return this.stats;
  }

  /**
   * Avvia lo scheduling periodico
   *
   * @param {number} [delayMs=120000] - Delay prima del primo run (default 2 min)
   */
  start(delayMs = 120000) {
    if (this._timer) {
      console.log('[MAC-Collector] Already started');
      return;
    }

    console.log(`[MAC-Collector] Starting scheduler (interval: ${this.intervalMs / 1000}s, first run in ${delayMs / 1000}s)`);

    // Primo run dopo delay
    setTimeout(() => {
      this.run();
    }, delayMs);

    // Run periodici
    this._timer = setInterval(() => {
      this.run();
    }, this.intervalMs);

    // Non bloccare l'exit del processo
    if (this._timer.unref) {
      this._timer.unref();
    }
  }

  /**
   * Ferma lo scheduling
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      console.log('[MAC-Collector] Scheduler stopped');
    }
  }

  /**
   * Ritorna lo stato corrente
   *
   * @returns {Object} Stato e statistiche
   */
  getStatus() {
    return {
      running: this._running,
      scheduled: !!this._timer,
      intervalMs: this.intervalMs,
      nextRun: this.stats.lastRun
        ? new Date(this.stats.lastRun.getTime() + this.intervalMs)
        : null,
      stats: this.stats
    };
  }
}

export default SshMacCollector;
