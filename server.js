import express from 'express';
import bodyParser from 'body-parser';
import Cidr from 'ip-cidr';
// SNMP RIMOSSO - Stub per compatibilità (le API SNMP restituiranno errore)
const snmp = {
  Version2c: 1,
  createSession: () => ({
    get: (oids, cb) => cb(new Error('SNMP disabilitato - usa SSH')),
    subtree: (oid, maxRep, cb, doneCb) => doneCb(new Error('SNMP disabilitato - usa SSH')),
    walk: () => Promise.reject(new Error('SNMP disabilitato - usa SSH')),
    close: () => {}
  }),
  walk: () => Promise.reject(new Error('SNMP disabilitato - usa SSH')),
  get: () => Promise.reject(new Error('SNMP disabilitato - usa SSH'))
};
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import crypto from 'crypto';
import SSHAgent from './sshAgent.js';
import { getAllServers } from './sshConfig.js';
import NetMapDB from './libdb.js';
import NeDiDB, { getNeDiDB } from './libnedi.js';
// SNMP RIMOSSO - Classe stub per compatibilità
class NetMapSNMP {
  constructor() {
    this.community = process.env.SNMP_COMMUNITY || 'public';
  }
  async getSysName() { throw new Error('SNMP disabilitato - usa SSH'); }
  async getARPTable() { throw new Error('SNMP disabilitato - usa SSH'); }
  async getFDBTable() { throw new Error('SNMP disabilitato - usa SSH'); }
  async getInterfacesExtended() { throw new Error('SNMP disabilitato - usa SSH'); }
  async discoverProtocols() { return { protocols: [], vendor: null }; }
  async walk() { throw new Error('SNMP disabilitato - usa SSH'); }
  async get() { throw new Error('SNMP disabilitato - usa SSH'); }
  decodeValue(v) { return v?.toString() || ''; }
}
import NetMapMap from './libmap.js';
import NetMapPing from './libping.js';
import { extractDeviceFacts, getDeviceType, getDeviceIcon } from './lib/sysObjectIDMap.js';
import LldpSshDiscovery from './lib/lldpSshDiscovery.js';
import { lookupOui } from './lib/ouiDatabase.js';
import SwitchSSH from './lib/switchSSH.js';
import SwitchTelnet from './lib/switchTelnet.js';
import { parseHuaweiLldpNeighbors } from './lib/huaweiLldpParser.js';
import { getSupportedVendors, getParserByVendor } from './lib/vendors/index.js';
import { searchMacIpFabric } from './lib/ipfabric-client.js';
import { MacCache } from './lib/MacCache.js';
import { NeDiSyncJob } from './lib/NeDiSyncJob.js';
import SshMacCollector from './lib/sshMacCollector.js';
import agentRoutes from './routes/agentRoutes.js';
import agentStreamRoutes from './routes/agentStreamRoutes.js';

// SSH MAC Collector instance (inizializzato in app.listen)
let macCollector = null;

const app = express();
const PORT = process.env.PORT || 4000;
const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const MAP_TIMEOUT = Number(process.env.MAP_TIMEOUT || 3000);
const MAP_RETRIES = Number(process.env.MAP_RETRIES || 1);
const DEFAULT_HOST_LIMIT = Number(process.env.CIDR_LIMIT) || 1024;
const HARD_HOST_LIMIT = Number(process.env.CIDR_MAX_LIMIT) || 32768;

// Inizializza SSH Agent
const sshAgent = new SSHAgent();
const switchSsh = new SwitchSSH();
const switchTelnet = new SwitchTelnet();

// Inizializza Database
const db = new NetMapDB(process.env.DB_PATH || './netmap.db');

// ========== MAC-TRACKER V3: CACHE IN-MEMORY ==========
const macCacheV3 = new MacCache();
let macSyncJob = null;  // Inizializzato in startMacSyncJob()

/**
 * Avvia il background sync job per MAC Cache V3
 * Chiamato dopo che NeDi è disponibile
 */
async function startMacSyncJob() {
  if (macSyncJob) {
    console.log('[MAC-V3] Sync job già attivo');
    return;
  }

  try {
    const nedi = new NeDiDB();
    await nedi.init(); // Assicuriamoci che sia inizializzato se necessario
    if (!nedi) {
      console.warn('[MAC-V3] NeDi non disponibile, sync job non avviato');
      return;
    }

    macSyncJob = new NeDiSyncJob(nedi, macCacheV3, {
      interval: 15 * 60 * 1000,  // 15 minuti
      retryDelayBase: 60 * 1000,  // 1 minuto
      maxConsecutiveFailures: 3,
      onSync: (result) => {
        console.log(`[MAC-V3] Sync completato: ${result.entries} MAC in ${result.duration}ms`);
      },
      onError: (err) => {
        console.error(`[MAC-V3] ERRORE SYNC: ${err.message} (${err.consecutiveFailures}x)`);
      }
    });

    // Avvia con sync immediato
    await macSyncJob.start(true);
    console.log(`[MAC-V3] Background sync avviato (interval: 15min)`);

  } catch (err) {
    console.error('[MAC-V3] Errore avvio sync job:', err.message);
  }
}

// ========== CACHE IN-MEMORY PER PERFORMANCE ==========
class MapCache {
  constructor(ttlMs = 30000) { // 30 secondi default
    this.cache = new Map();
    this.ttl = ttlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  clear() {
    this.cache.clear();
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  getStats() {
    return {
      size: this.cache.size,
      ttlMs: this.ttl
    };
  }
}

const mapCache = new MapCache(60000); // Cache 60 secondi per mappa
const deviceCache = new MapCache(60000); // Cache 60 secondi per device data

// Invalida cache quando cambia il DB
const originalUpsertDevice = db.upsertDevice.bind(db);
const originalUpsertLink = db.upsertLink.bind(db);

db.upsertDevice = function(...args) {
  const result = originalUpsertDevice(...args);
  mapCache.clear();
  deviceCache.clear();
  return result;
};

db.upsertLink = function(...args) {
  const result = originalUpsertLink(...args);
  mapCache.clear();
  deviceCache.clear();
  return result;
};

// Inizializza SNMP esteso
const snmpAgent = new NetMapSNMP(COMMUNITY, {
  timeout: MAP_TIMEOUT,
  retries: MAP_RETRIES,
});

// Inizializza Map generator
const mapGenerator = new NetMapMap();

// Inizializza Ping (stile NeDi)
const pingAgent = new NetMapPing();

// Tracking scansioni attive
const activeScans = new Map();

app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Debug: lista routes registrate
app.get("/api/debug/routes", (req, res) => {
  // Protetto: solo localhost o header X-Debug-Token
  const isLocal = req.ip === "127.0.0.1" || req.ip === "::1" || req.hostname === "localhost";
  const hasDebugToken = req.headers["x-debug-token"] === "netmap-debug-2024";
  if (!isLocal && !hasDebugToken) {
    return res.status(403).json({ error: "Access denied" });
  }
  try {
    const routes = [];
    const stack = app._router && app._router.stack ? app._router.stack : [];
    stack.forEach(layer => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
        routes.push({ path: layer.route.path, methods });
      }
    });
    res.json({ count: routes.length, routes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Chat routes
app.get('/ai', (req, res) => res.redirect('/ai/chat.html'));
app.get('/ai/chat', (req, res) => res.redirect('/ai/chat.html'));

app.get('/', (req, res) => {
  res.redirect('/discovery.html');
});

// Helper per espandere un CIDR in IP list (limitato per evitare scansioni enormi)
// Esclude indirizzo di rete e broadcast (stile NeDi)
function expandCidr(cidrStr, requestedLimit) {
  if (!Cidr.isValidCIDR(cidrStr)) {
    throw new Error('CIDR non valido');
  }
  const cidr = new Cidr(cidrStr);
  const hostCount = Number(cidr.size);
  const maxHosts = Math.min(requestedLimit || DEFAULT_HOST_LIMIT, HARD_HOST_LIMIT);
  if (hostCount > maxHosts) {
    throw new Error(`CIDR troppo grande. Limite ${maxHosts} host per run.`);
  }

  // Ottieni tutti gli IP del range
  const allIPs = cidr.toArray({ limit: Math.min(hostCount, maxHosts) });

  // Filtra: escludi indirizzo di rete (primo) e broadcast (ultimo)
  // Per /32 o /31, non escludere nulla
  const prefixLength = cidrStr.split('/')[1];
  if (prefixLength && (parseInt(prefixLength) >= 31)) {
    return allIPs; // /31 e /32 non hanno network/broadcast separati
  }

  // Per altri CIDR, escludi primo (network) e ultimo (broadcast)
  if (allIPs.length > 2) {
    return allIPs.slice(1, -1); // Rimuovi primo e ultimo
  }

  return allIPs;
}

// Lettura SNMP LLDP/CDP stile NeDi per un host (raw)
async function scanHost(ip) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, COMMUNITY, { timeout: 3000, retries: 1, version: snmp.Version2c });
    const result = { ip, sysName: null, lldpLoc: [], lldpRem: [], neighbors: [], ok: false, error: null };

    // sysName
    session.get(['1.3.6.1.2.1.1.5.0'], (err, varbinds) => {
      if (!err && varbinds?.[0]?.value) {
        result.sysName = varbinds[0].value.toString();
      }
    });

    const lldpRemOid = '1.0.8802.1.1.2.1.4.1.1'; // lldpRemTable
    const lldpLocOid = '1.0.8802.1.1.2.1.3.7.1'; // lldpLocPortTable
    const lldpMedInvOid = '1.0.8802.1.1.2.1.5.4795.1.3.3.1'; // lldpXMedRemInventory
    const lldpRemIpOid = '1.0.8802.1.1.2.1.4.2.1.3'; // lldpRemManAddrTable
    const cdpOid = '1.3.6.1.4.1.9.9.23.1.2.1.1'; // CDP fallback

    let doneCount = 0;
    const finalize = () => {
      doneCount += 1;
      if (doneCount === 4) {
        session.close();
        result.ok = true;
        resolve(result);
      }
    };

    const collect = (arr) => (vb) => { if (vb?.oid) arr.push({ oid: vb.oid, value: vb.value }); };

    session.subtree(lldpLocOid, 20, collect(result.lldpLoc), () => finalize());
    session.subtree(lldpRemOid, 20, collect(result.lldpRem), () => finalize());
    session.subtree(lldpMedInvOid, 20, collect(result.lldpRem), () => finalize());
    // CDP (molti device non rispondono, non blocchiamo)
    session.subtree(cdpOid, 20, collect(result.lldpRem), () => finalize());
  });
}

// Discovery API
app.post('/api/discover', async (req, res) => {
  const { cidr, limit } = req.body || {};
  if (!cidr) {
    return res.status(400).json({ error: 'CIDR richiesto (es. 192.168.1.0/24)' });
  }

  let hosts;
  try {
    hosts = expandCidr(cidr, limit ? Number(limit) : DEFAULT_HOST_LIMIT);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Parallel limited
  const concurrency = 6;
  const queue = [...hosts];
  const results = [];

  const workers = new Array(concurrency).fill(null).map(async () => {
    while (queue.length) {
      const ip = queue.shift();
      try {
        const r = await scanHost(ip);
        results.push(r);
      } catch (err) {
        results.push({ ip, ok: false, error: err.message });
      }
    }
  });

  await Promise.all(workers);

  return res.json({
    cidr,
    community: COMMUNITY,
    count: results.length,
    timestamp: new Date().toISOString(),
    results,
  });
});

// Helpers per mappa LLDP
function decodeBuffer(val) {
  if (Buffer.isBuffer(val)) {
    // Se è MAC (6 byte) formatta con :
    if (val.length === 6) {
      return Array.from(val).map((b) => b.toString(16).padStart(2, '0')).join(':');
    }
    // prova ASCII sicuro
    const txt = val.toString('utf8');
    if (/^[\x20-\x7E]+$/.test(txt)) return txt;
    return val.toString('hex');
  }
  if (val === null || val === undefined) return '';
  return val.toString();
}

function parseLldpVarbinds(vbs) {
  const entries = {};
  for (const vb of vbs) {
    if (!vb?.oid) continue;
    const parts = vb.oid.split('.');
    // LLDP OID format: 1.0.8802.1.1.2.1.4.1.1.ATTR.TIMEMARK.LOCALPORT.REMINDEX
    // Base: 1.0.8802.1.1.2.1.4.1.1 (10 parts) -> ATTR is at index 10
    const len = parts.length;
    const localPort = parts[len - 2];
    const remIndex = parts[len - 1];
    // Attr is at position len-4 (after timeMark which is at len-3)
    const attr = parts[len - 4]; // 4=ChassisSubType,5=ChassisId,6=PortIdSubType,7=PortId,9=SysName,10=SysDesc,11=SysCap
    const key = `${localPort}-${remIndex}`;
    if (!entries[key]) entries[key] = { localPort, remIndex };
    const entry = entries[key];
    switch (attr) {
      case '5': // chassisId
        entry.chassisId = decodeBuffer(vb.value);
        break;
      case '6': // portIdSubType
        entry.portSubType = decodeBuffer(vb.value);
        break;
      case '7': // portId
        entry.portId = decodeBuffer(vb.value);
        break;
      case '8': // portDesc (lldpRemPortDesc)
        entry.portDesc = decodeBuffer(vb.value);
        break;
      case '9': // sysName
        entry.sysName = decodeBuffer(vb.value);
        break;
      case '10': // sysDesc
        entry.sysDesc = decodeBuffer(vb.value);
        break;
      case '11': // sysCap
        entry.sysCap = decodeBuffer(vb.value);
        break;
      default:
        break;
    }
  }
  return Object.values(entries);
}

async function scanHostMap(ip) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, COMMUNITY, { timeout: MAP_TIMEOUT, retries: MAP_RETRIES, version: snmp.Version2c });
    const result = { ip, sysName: null, lldp: [] };
    session.get(['1.3.6.1.2.1.1.5.0'], (err, vbs) => {
      if (!err && vbs?.[0]?.value) result.sysName = decodeBuffer(vbs[0].value);
    });
    const rows = [];
    session.subtree('1.0.8802.1.1.2.1.4.1.1', 20,
      (vb) => {
        if (Array.isArray(vb)) rows.push(...vb);
        else if (vb) rows.push(vb);
      },
      (error) => {
        if (!error && rows.length) {
          result.lldp = parseLldpVarbinds(rows);
        }
        session.close();
        resolve(result);
      }
    );
  });
}

// Endpoint mappa LLDP -> JSON nodi/link
app.get('/api/map', async (req, res) => {
  try {
    const cidr = req.query.cidr || '192.168.10.0/24';
    const limit = Number(req.query.limit) || DEFAULT_HOST_LIMIT;
    let hosts;
    try {
      hosts = expandCidr(cidr, limit);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const queue = [...hosts];
    const results = [];
    const nodesMap = new Map();
    const links = [];
    const concurrency = Number(req.query.concurrency || 5);

    const workers = Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const ip = queue.shift();
        // Salta network e broadcast addresses
        const ipParts = ip.split('.');
        const lastOctet = parseInt(ipParts[3]);
        if (lastOctet === 0 || lastOctet === 255) {
          continue;
        }
        try {
          const r = await scanHostMap(ip);
          results.push(r);
        } catch (e) {
          results.push({ ip, error: e.message });
        }
      }
    });
    await Promise.all(workers);

    // Build nodes - SOLO device con sysName o neighbors (filtra IP senza risposta SNMP)
    for (const r of results) {
      // Salta se non ha sysName e non ha neighbors (non è un device valido)
      if (!r.sysName && (!r.lldp || r.lldp.length === 0)) {
        continue;
      }

      nodesMap.set(r.ip, { id: r.ip, label: r.sysName ? `${r.sysName}\n${r.ip}` : r.ip, type: 'device' });
      for (const n of r.lldp || []) {
        const remoteId = n.sysName || n.chassisId || `${r.ip}-lldp-${n.remIndex}`;
        if (!nodesMap.has(remoteId)) {
          nodesMap.set(remoteId, { id: remoteId, label: n.sysName || n.chassisId || remoteId, type: 'neighbor' });
        }
        links.push({
          from: r.ip,
          to: remoteId,
          localIf: n.localPort,
          remoteIf: n.portId,
          chassisId: n.chassisId,
        });
      }
    }

    res.json({
      cidr,
      nodes: Array.from(nodesMap.values()),
      links,
      raw: results, // opzionale: dati grezzi per debug
    });
  } catch (err) {
    console.error('Errore in /api/map', err);
    res.status(500).json({ error: 'Errore interno nella scansione LLDP' });
  }
});

// SSH Agent API

// Test connessione SSH
app.post('/api/ssh/test', async (req, res) => {
  try {
    const { host, port, username, password, privateKey, passphrase } = req.body;

    if (!host || !username) {
      return res.status(400).json({ error: 'host e username richiesti' });
    }

    if (!password && !privateKey) {
      return res.status(400).json({ error: 'password o privateKey richiesti' });
    }

    const connectionOptions = {
      host,
      port: port || 22,
      username,
      ...(password && { password }),
      ...(privateKey && { privateKey }),
      ...(passphrase && { passphrase }),
    };

    const connected = await sshAgent.testConnection(connectionOptions);
    res.json({
      host,
      connected,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Esegui comando SSH
app.post('/api/ssh/execute', async (req, res) => {
  try {
    const { host, port, username, password, privateKey, passphrase, command, timeout } = req.body;

    if (!host || !username || !command) {
      return res.status(400).json({ error: 'host, username e command richiesti' });
    }

    if (!password && !privateKey) {
      return res.status(400).json({ error: 'password o privateKey richiesti' });
    }

    const connectionOptions = {
      host,
      port: port || 22,
      username,
      ...(password && { password }),
      ...(privateKey && { privateKey }),
      ...(passphrase && { passphrase }),
    };

    const result = await sshAgent.executeCommand(connectionOptions, command, {
      timeout: timeout || 30000,
    });

    res.json({
      host,
      command,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Esegui più comandi SSH
app.post('/api/ssh/execute-batch', async (req, res) => {
  try {
    const { host, port, username, password, privateKey, passphrase, commands, timeout, stopOnError } = req.body;

    if (!host || !username || !Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'host, username e commands (array) richiesti' });
    }

    if (!password && !privateKey) {
      return res.status(400).json({ error: 'password o privateKey richiesti' });
    }

    const connectionOptions = {
      host,
      port: port || 22,
      username,
      ...(password && { password }),
      ...(privateKey && { privateKey }),
      ...(passphrase && { passphrase }),
    };

    const results = await sshAgent.executeCommands(connectionOptions, commands, {
      timeout: timeout || 30000,
      stopOnError: stopOnError || false,
    });

    res.json({
      host,
      commands,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ottieni informazioni sistema remoto
app.post('/api/ssh/system-info', async (req, res) => {
  try {
    const { host, port, username, password, privateKey, passphrase } = req.body;

    if (!host || !username) {
      return res.status(400).json({ error: 'host e username richiesti' });
    }

    if (!password && !privateKey) {
      return res.status(400).json({ error: 'password o privateKey richiesti' });
    }

    const connectionOptions = {
      host,
      port: port || 22,
      username,
      ...(password && { password }),
      ...(privateKey && { privateKey }),
      ...(passphrase && { passphrase }),
    };

    const systemInfo = await sshAgent.getSystemInfo(connectionOptions);

    res.json({
      host,
      ...systemInfo,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API per server predefiniti (twiky e ndei)

// Lista server configurati
app.get('/api/ssh/servers', (req, res) => {
  const servers = getAllServers();
  // Rimuovi le password dalla risposta per sicurezza
  const safeServers = Object.entries(servers).reduce((acc, [key, value]) => {
    acc[key] = {
      name: value.name,
      host: value.host,
      port: value.port,
      username: value.username,
      // password non inclusa per sicurezza
    };
    return acc;
  }, {});
  res.json({ servers: safeServers });
});

// Test connessione a server predefinito
app.post('/api/ssh/server/:serverName/test', async (req, res) => {
  try {
    const { serverName } = req.params;
    const connected = await sshAgent.testServerConnection(serverName);
    res.json({
      server: serverName,
      connected,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Esegui comando su server predefinito
app.post('/api/ssh/server/:serverName/execute', async (req, res) => {
  try {
    const { serverName } = req.params;
    const { command, timeout } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'command richiesto' });
    }

    const result = await sshAgent.executeOnServer(serverName, command, {
      timeout: timeout || 30000,
    });

    res.json({
      server: serverName,
      command,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Esegui più comandi su server predefinito
app.post('/api/ssh/server/:serverName/execute-batch', async (req, res) => {
  try {
    const { serverName } = req.params;
    const { commands, timeout, stopOnError } = req.body;

    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'commands (array) richiesto' });
    }

    const results = await sshAgent.executeCommandsOnServer(serverName, commands, {
      timeout: timeout || 30000,
      stopOnError: stopOnError || false,
    });

    res.json({
      server: serverName,
      commands,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ottieni informazioni sistema da server predefinito
app.get('/api/ssh/server/:serverName/system-info', async (req, res) => {
  try {
    const { serverName } = req.params;
    const systemInfo = await sshAgent.getServerSystemInfo(serverName);
    res.json({
      server: serverName,
      ...systemInfo,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== DATABASE & DISCOVERY ESTESO ==========

// Discovery completo con persistenza database (stile NeDi: ping prima, poi SNMP)
app.post('/api/discover-full', async (req, res) => {
  const scanId = `scan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const scanInfo = {
    id: scanId,
    cidr: req.body?.cidr,
    status: 'starting',
    startTime: Date.now(),
    scanned: 0,
    found: 0,
    total: 0,
  };
  activeScans.set(scanId, scanInfo);

  try {
    const { cidr, limit, includeARP, includeFDB, skipPing } = req.body || {};
    if (!cidr) {
      activeScans.delete(scanId);
      return res.status(400).json({ error: 'CIDR richiesto' });
    }

    scanInfo.status = 'ping';
    scanInfo.cidr = cidr;

    let hosts;

    // METODO NEDI: Prima ping per trovare host attivi, poi SNMP solo su quelli
    if (!skipPing) {
      try {
        // Ping CIDR per trovare solo host attivi (stile fping -g)
        console.log(`Eseguendo ping su ${cidr} per trovare host attivi...`);
        hosts = await pingAgent.pingCIDR(cidr, 1000, 20);
        console.log(`Ping completato: ${hosts.length} host attivi trovati`);
      } catch (err) {
        return res.status(400).json({ error: `Errore ping: ${err.message}` });
      }

      // Limita il numero di host se necessario
      if (limit && hosts.length > limit) {
        hosts = hosts.slice(0, limit);
        console.log(`Limitato a ${limit} host`);
      }
    } else {
      // Metodo vecchio: espandi CIDR senza ping (non raccomandato)
      try {
        hosts = expandCidr(cidr, limit ? Number(limit) : DEFAULT_HOST_LIMIT);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    console.log(`\n[SNMP] Inizio scansione SNMP su ${hosts.length} host...`);
    console.log(`[SNMP] Community: ${COMMUNITY}, Concurrency: 6, Timeout: 3s per host\n`);

    scanInfo.status = 'scanning';
    scanInfo.total = hosts.length;

    const concurrency = 6;
    const queue = [...hosts];
    const results = [];
    const devicesProcessed = [];
    let scanned = 0;
    let found = 0;
    const startTime = Date.now();

    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const ip = queue.shift();
        scanned++;
        const progress = ((scanned / hosts.length) * 100).toFixed(1);

        // Aggiorna stato scansione
        scanInfo.scanned = scanned;
        scanInfo.found = found;
        scanInfo.progress = progress;

        try {
          // Verifica che l'IP non sia network o broadcast
          const ipParts = ip.split('.');
          const lastOctet = parseInt(ipParts[3]);
          if (lastOctet === 0 || lastOctet === 255) {
            // Salta network e broadcast addresses
            process.stdout.write(`[${progress}%] ${ip}: SKIP (network/broadcast)\r`);
            continue;
          }

          // Discovery completo protocolli con timeout breve (3 secondi per IP)
          let discovery;
          try {
            discovery = await Promise.race([
              snmpAgent.discoverProtocols(ip, 3000),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout discovery')), 3000)),
            ]);
          } catch (err) {
            // Se timeout o errore, salta questo IP
            process.stdout.write(`[${progress}%] ${ip}: NO SNMP\r`);
            continue;
          }

          // Filtra: salva SOLO se ha sysName O ha neighbors (è un device reale)
          // Se non ha né sysName né neighbors, non è un device SNMP valido
          if (!discovery.sysName &&
            discovery.lldp.length === 0 &&
            discovery.cdp.length === 0 &&
            discovery.fdp.length === 0 &&
            discovery.edp.length === 0) {
            // Non è un device SNMP valido, salta
            process.stdout.write(`[${progress}%] ${ip}: NO DEVICE\r`);
            continue;
          }

          // Device trovato!
          found++;
          const protocols = discovery.protocols.join(',') || 'SNMP';
          const neighbors = discovery.lldp.length + discovery.cdp.length + discovery.fdp.length + discovery.edp.length;
          console.log(`[${progress}%] ✓ ${ip}: ${discovery.sysName || 'Unknown'} (${protocols}, ${neighbors} neighbors)`);

          if (discovery.sysName || discovery.lldp.length || discovery.cdp.length || discovery.fdp.length || discovery.edp.length) {
            // Salva device
            const deviceResult = db.upsertDevice({
              ip,
              sysname: discovery.sysName,
              sysdesc: discovery.sysDescr,
              sysuptime: discovery.sysUpTime,
              syslocation: discovery.sysLocation,
              snmp_version: '2c',
              community: COMMUNITY,
              status: 'active',
            });

            const deviceId = deviceResult.lastInsertRowid || db.getDevice(ip)?.id;
            if (!deviceId) {
              console.error(`ERRORE: deviceId non valido per ${ip}`);
              continue;
            }
            devicesProcessed.push({ ip, deviceId });

            // Log progresso link
            const linkCount = discovery.lldp.length + discovery.cdp.length + discovery.fdp.length + discovery.edp.length;
            if (linkCount > 0) {
              process.stdout.write(`      → Salvati ${linkCount} link\r`);
              // DEBUG: Log dettagliato neighbor trovati
              if (discovery.lldp.length > 0) {
                console.log(`\n[DEBUG] ${ip}: Trovati ${discovery.lldp.length} neighbor LLDP`);
                discovery.lldp.slice(0, 3).forEach((n, idx) => {
                  console.log(`  [${idx}] sysName='${n.sysName || 'N/A'}', chassisId='${n.chassisId || 'N/A'}', portId='${n.portId || 'N/A'}', ip='${n.ip || 'N/A'}'`);
                  console.log(`       localPort='${n.localPort || 'N/A'}', remIndex='${n.remIndex || 'N/A'}'`);
                });
              } else {
                console.log(`\n[DEBUG] ${ip}: discovery.lldp è vuoto (length=${discovery.lldp?.length || 0})`);
              }
            }

            // Salva links LLDP (METODO NEDI: crea device per neighbor se non esiste)
            for (const neighbor of discovery.lldp) {
              try {
                // DEBUG: Log ogni neighbor
                console.log(`[LLDP] ${ip}: neighbor sysName='${neighbor.sysName || 'N/A'}', chassisId='${neighbor.chassisId || 'N/A'}', portId='${neighbor.portId || 'N/A'}', ip='${neighbor.ip || 'N/A'}'`);

                let remoteDeviceId = null;
                let remoteIp = neighbor.ip || null; // IP da LLDP RemManAddr se disponibile

                // METODO NEDI: Determina nome neighbor (na) come fa NeDi
                // 1. Se esiste sysName, lo usa
                // 2. Se chassisId è IP (tipo 5), usa IP come nome
                // 3. Se chassisId è MAC (tipo 4), usa MAC come nome
                // 4. Altrimenti usa chassisId come nome
                let neighborName = null;
                if (neighbor.sysName) {
                  neighborName = neighbor.sysName;
                } else if (neighbor.chassisId) {
                  // Se chassisId è un IP (contiene solo numeri e punti)
                  if (/^\d+\.\d+\.\d+\.\d+$/.test(neighbor.chassisId)) {
                    neighborName = neighbor.chassisId;
                    remoteIp = neighbor.chassisId; // Usa chassisId come IP
                  } else if (/^[0-9a-fA-F:]{17}$/.test(neighbor.chassisId)) {
                    // Se è un MAC address
                    neighborName = neighbor.chassisId.replace(/:/g, '');
                  } else {
                    // Altrimenti usa chassisId come nome
                    neighborName = neighbor.chassisId.substring(0, 64); // Limita a 64 caratteri come NeDi
                  }
                }

                // Se non abbiamo un nome, salta questo neighbor
                if (!neighborName) {
                  console.log(`[LLDP] ${ip}: SKIP neighbor senza nome (sysName='${neighbor.sysName || 'N/A'}', chassisId='${neighbor.chassisId || 'N/A'}')`);
                  continue;
                }

                console.log(`[LLDP] ${ip}: neighborName='${neighborName}', remoteIp='${remoteIp || 'N/A'}'`);

                // METODO NEDI: Crea device per neighbor se ha sysName O chassisId
                // NeDi crea device anche solo con chassisId se non ha sysName
                if (neighborName) {
                  // Cerca device esistente per sysname
                  const allDevices = db.getAllDevices();
                  let remoteDevice = allDevices.find(d => d.sysname === neighborName);

                  if (remoteDevice) {
                    console.log(`[NEIGHBOR] ${ip}: Device esistente trovato per sysname='${neighborName}' (ID: ${remoteDevice.id})`);
                  }

                  // Se non trovato per sysname, cerca per IP
                  if (!remoteDevice && remoteIp && remoteIp !== 'N/A' && remoteIp !== '0.0.0.0') {
                    remoteDevice = allDevices.find(d => d.ip === remoteIp);
                    if (remoteDevice) {
                      console.log(`[NEIGHBOR] ${ip}: Device esistente trovato per IP='${remoteIp}' (ID: ${remoteDevice.id})`);
                    }
                  }

                  if (remoteDevice) {
                    // Device esiste già
                    remoteDeviceId = remoteDevice.id;
                    remoteIp = remoteDevice.ip || remoteIp;
                    console.log(`[NEIGHBOR] ${ip}: Usa device esistente: ${neighborName} (ID: ${remoteDeviceId})`);
                  } else {
                    // METODO NEDI: Crea device per neighbor anche se non ancora scansionato
                    // NeDi usa '0.0.0.0' come IP placeholder se non disponibile
                    const neighborDevice = {
                      sysname: neighborName,
                      sysdesc: neighbor.sysDesc || null,
                      syslocation: null,
                      snmp_version: null, // Non ancora scansionato
                      community: null,
                      status: 'neighbor', // Stato speciale: neighbor non ancora scansionato
                      ip: remoteIp || (neighbor.chassisId && /^\d+\.\d+\.\d+\.\d+$/.test(neighbor.chassisId) ? neighbor.chassisId : '0.0.0.0'), // Usa placeholder se non disponibile
                    };

                    try {
                      console.log(`[NEIGHBOR] Creazione device: sysname='${neighborDevice.sysname}', ip='${neighborDevice.ip || 'N/A'}'`);
                      const neighborResult = db.upsertDevice(neighborDevice);
                      // getDevice cerca per IP o sysname
                      const lookupKey = neighborDevice.ip || neighborDevice.sysname;
                      if (lookupKey) {
                        remoteDeviceId = neighborResult.lastInsertRowid || db.getDevice(lookupKey)?.id;
                        if (remoteDeviceId) {
                          const createdDevice = db.getDevice(lookupKey);
                          if (createdDevice) {
                            remoteIp = createdDevice.ip || remoteIp;
                            console.log(`[NEIGHBOR] ✅ Creato device: ${neighborName} (ID: ${remoteDeviceId}, IP: ${remoteIp || 'N/A'})`);
                          } else {
                            console.log(`[NEIGHBOR] ⚠️ Device creato ma non trovato con getDevice('${lookupKey}')`);
                          }
                        } else {
                          console.log(`[NEIGHBOR] ⚠️ remoteDeviceId non valido dopo upsertDevice`);
                        }
                      } else {
                        console.log(`[NEIGHBOR] ⚠️ lookupKey vuoto (ip='${neighborDevice.ip || 'N/A'}', sysname='${neighborDevice.sysname || 'N/A'}')`);
                      }
                    } catch (err) {
                      console.error(`[NEIGHBOR] ERRORE creazione device: ${err.message}`);
                      console.error(`[NEIGHBOR] Stack: ${err.stack}`);
                    }
                  }
                }

                // DEBUG: Log prima di salvare link
                if (!remoteDeviceId) {
                  console.log(`[LINK] ${ip}: WARNING - remoteDeviceId è null per neighbor ${neighborName} (localPort=${neighbor.localPort})`);
                }

                db.upsertLink({
                  device_id: deviceId,
                  local_ifindex: parseInt(neighbor.localPort) || null,
                  remote_device_id: remoteDeviceId || null,
                  remote_ip: remoteIp || null,
                  remote_sysname: neighbor.sysName || null,
                  remote_chassisid: neighbor.chassisId || null,
                  remote_portid: neighbor.portId || null,
                  remote_portdesc: neighbor.portDesc || null, // Fixed: use portDesc instead of sysDesc
                  protocol: 'LLDP',
                });
              } catch (err) {
                console.error(`ERRORE link LLDP per ${ip}: ${err.message}`);
              }
            }

            // Salva links CDP (METODO NEDI: crea device per neighbor se non esiste)
            for (const neighbor of discovery.cdp) {
              try {
                let remoteDeviceId = null;
                let remoteIp = neighbor.ip || null;

                // METODO NEDI: CDP ha sempre IP, crea device se non esiste
                if (neighbor.ip) {
                  let remoteDevice = db.getDevice(neighbor.ip);
                  if (remoteDevice) {
                    remoteDeviceId = remoteDevice.id;
                  } else {
                    // METODO NEDI: Crea device per neighbor anche se non ancora scansionato
                    const neighborDevice = {
                      ip: neighbor.ip,
                      sysname: neighbor.sysName || null,
                      sysdesc: neighbor.sysDesc || null,
                      syslocation: null,
                      snmp_version: null, // Non ancora scansionato
                      community: null,
                      status: 'neighbor', // Stato speciale: neighbor non ancora scansionato
                    };

                    const neighborResult = db.upsertDevice(neighborDevice);
                    remoteDeviceId = neighborResult.lastInsertRowid || db.getDevice(neighbor.ip)?.id;
                  }
                } else if (neighbor.sysName) {
                  // Se non ha IP ma ha sysName, cerca per sysName
                  const allDevices = db.getAllDevices();
                  const found = allDevices.find(d => d.sysname === neighbor.sysName);
                  if (found) {
                    remoteDeviceId = found.id;
                    remoteIp = found.ip;
                  } else {
                    // METODO NEDI: Crea device con solo sysName
                    const neighborDevice = {
                      sysname: neighbor.sysName,
                      sysdesc: neighbor.sysDesc || null,
                      syslocation: null,
                      snmp_version: null,
                      community: null,
                      status: 'neighbor',
                    };

                    const neighborResult = db.upsertDevice(neighborDevice);
                    remoteDeviceId = neighborResult.lastInsertRowid || db.getDevice(neighbor.sysName)?.id;
                  }
                }

                db.upsertLink({
                  device_id: deviceId,
                  local_ifindex: neighbor.ifIndex || null,
                  remote_device_id: remoteDeviceId || null,
                  remote_sysname: neighbor.sysName || null,
                  remote_portid: neighbor.portId || null,
                  remote_portdesc: neighbor.portDesc || null, // Fixed: use portDesc
                  remote_ip: remoteIp || null,
                  protocol: 'CDP',
                });
              } catch (err) {
                console.error(`ERRORE link CDP per ${ip}: ${err.message}`);
              }
            }

            // Salva links FDP (METODO NEDI: crea device per neighbor se non esiste)
            for (const neighbor of discovery.fdp) {
              try {
                let remoteDeviceId = null;
                let remoteIp = neighbor.ip || null;

                if (neighbor.sysName) {
                  const allDevices = db.getAllDevices();
                  let found = allDevices.find(d => d.sysname === neighbor.sysName);

                  if (found) {
                    remoteDeviceId = found.id;
                    remoteIp = found.ip || remoteIp;
                  } else {
                    // METODO NEDI: Crea device per neighbor
                    const neighborDevice = {
                      sysname: neighbor.sysName,
                      sysdesc: neighbor.sysDesc || null,
                      syslocation: null,
                      snmp_version: null,
                      community: null,
                      status: 'neighbor',
                    };

                    if (remoteIp) {
                      neighborDevice.ip = remoteIp;
                    }

                    const neighborResult = db.upsertDevice(neighborDevice);
                    remoteDeviceId = neighborResult.lastInsertRowid || db.getDevice(neighbor.sysName)?.id;
                    if (remoteDeviceId) {
                      const createdDevice = db.getDevice(neighbor.sysName);
                      if (createdDevice) remoteIp = createdDevice.ip || remoteIp;
                    }
                  }
                }

                db.upsertLink({
                  device_id: deviceId,
                  local_ifindex: neighbor.ifIndex || null,
                  remote_device_id: remoteDeviceId || null,
                  remote_ip: remoteIp || null,
                  remote_sysname: neighbor.sysName || null,
                  remote_chassisid: neighbor.chassisId || null,
                  remote_portid: neighbor.portId || null,
                  protocol: 'FDP',
                });
              } catch (err) {
                console.error(`ERRORE link FDP per ${ip}: ${err.message}`);
              }
            }

            // Salva links EDP (METODO NEDI: crea device per neighbor se non esiste)
            for (const neighbor of discovery.edp) {
              try {
                let remoteDeviceId = null;
                let remoteIp = neighbor.ip || null;

                if (neighbor.sysName) {
                  const allDevices = db.getAllDevices();
                  let found = allDevices.find(d => d.sysname === neighbor.sysName);

                  if (found) {
                    remoteDeviceId = found.id;
                    remoteIp = found.ip || remoteIp;
                  } else {
                    // METODO NEDI: Crea device per neighbor
                    const neighborDevice = {
                      sysname: neighbor.sysName,
                      sysdesc: neighbor.sysDesc || null,
                      syslocation: null,
                      snmp_version: null,
                      community: null,
                      status: 'neighbor',
                    };

                    if (remoteIp) {
                      neighborDevice.ip = remoteIp;
                    }

                    const neighborResult = db.upsertDevice(neighborDevice);
                    remoteDeviceId = neighborResult.lastInsertRowid || db.getDevice(neighbor.sysName)?.id;
                    if (remoteDeviceId) {
                      const createdDevice = db.getDevice(neighbor.sysName);
                      if (createdDevice) remoteIp = createdDevice.ip || remoteIp;
                    }
                  }
                }

                db.upsertLink({
                  device_id: deviceId,
                  local_ifindex: neighbor.ifIndex || null,
                  remote_device_id: remoteDeviceId || null,
                  remote_ip: remoteIp || null,
                  remote_sysname: neighbor.sysName || null,
                  remote_chassisid: neighbor.chassisId || null,
                  remote_portid: neighbor.portId || null,
                  protocol: 'EDP',
                });
              } catch (err) {
                console.error(`ERRORE link EDP per ${ip}: ${err.message}`);
              }
            }

            // ARP table (opzionale)
            if (includeARP) {
              const arpTable = await snmpAgent.getARPTable(ip);
              for (const arp of arpTable) {
                db.upsertARP({
                  device_id: deviceId,
                  interface_id: null, // TODO: mappare ifIndex
                  ip: arp.ip,
                  mac: arp.mac,
                });
              }
            }

            // FDB table (opzionale)
            if (includeFDB) {
              const fdbTable = await snmpAgent.getFDBTable(ip);
              for (const fdb of fdbTable) {
                db.upsertFDB({
                  device_id: deviceId,
                  interface_id: fdb.ifIndex || null,
                  mac: fdb.mac,
                  vlan: fdb.vlan,
                });
              }
            }

            // Evento discovery
            db.addEvent({
              device_id: deviceId,
              type: 'discovery',
              severity: 'info',
              message: `Discovered via ${discovery.protocols.join(', ') || 'SNMP'}`,
            });

            results.push(discovery);
          }
        } catch (err) {
          results.push({ ip, error: err.message });
        }
      }
    });

    await Promise.all(workers);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[COMPLETATO] Scansione terminata in ${totalTime}s`);
    console.log(`[RISULTATI] Host scansionati: ${scanned}, Device trovati: ${found}, Device processati: ${devicesProcessed.length}`);
    console.log(`[RISULTATI] Device salvati nel database: ${devicesProcessed.length}\n`);

    scanInfo.status = 'completed';
    scanInfo.duration = `${totalTime}s`;
    scanInfo.endTime = Date.now();

    // Rimuovi dopo 5 minuti
    setTimeout(() => activeScans.delete(scanId), 5 * 60 * 1000);

    return res.json({
      cidr,
      count: results.length,
      devicesProcessed: devicesProcessed.length,
      scanned: scanned,
      found: found,
      timestamp: new Date().toISOString(),
      duration: `${totalTime}s`,
      scanId,
      results,
    });
  } catch (err) {
    console.error('Errore in /api/discover-full', err);
    scanInfo.status = 'error';
    scanInfo.error = err.message;
    setTimeout(() => activeScans.delete(scanId), 5 * 60 * 1000);
    res.status(500).json({ error: err.message });
  }
});

// Discovery ricorsivo: parte da un device seed e scopre tutti i neighbor ricorsivamente
app.post('/api/discover-recursive', async (req, res) => {
  const scanId = `recursive-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const scanInfo = {
    id: scanId,
    seed: req.body?.seed || req.body?.device,
    status: 'starting',
    startTime: Date.now(),
    scanned: 0,
    found: 0,
    levels: 0,
    discoveredDevices: [],
  };
  activeScans.set(scanId, scanInfo);

  try {
    const { seed, device, maxLevels = 10, community = COMMUNITY } = req.body || {};
    const seedDevice = seed || device;
    if (!seedDevice) {
      activeScans.delete(scanId);
      return res.status(400).json({ error: 'seed o device richiesto (IP o sysname)' });
    }

    // Trova device seed
    let seedIp = seedDevice;
    const allDevices = db.getAllDevices();
    let seedDeviceObj = allDevices.find(d => d.ip === seedDevice || d.sysname === seedDevice);

    if (!seedDeviceObj) {
      // Se non esiste, prova a fare discovery del seed
      console.log(`[RECURSIVE] Device seed ${seedDevice} non trovato, faccio discovery...`);
      try {
        const discovery = await snmpAgent.discoverProtocols(seedDevice, 5000);
        if (discovery.sysName || discovery.lldp.length > 0 || discovery.cdp.length > 0) {
          const deviceResult = db.upsertDevice({
            ip: seedDevice,
            sysname: discovery.sysName,
            sysdesc: discovery.sysDescr,
            sysuptime: discovery.sysUpTime,
            syslocation: discovery.sysLocation,
            snmp_version: '2c',
            community: community,
            status: 'active',
          });
          seedDeviceObj = db.getDevice(seedDevice);
          seedIp = seedDevice;
        } else {
          return res.status(404).json({ error: `Device ${seedDevice} non trovato e non scopribile via SNMP` });
        }
      } catch (err) {
        return res.status(404).json({ error: `Device ${seedDevice} non trovato: ${err.message}` });
      }
    } else {
      seedIp = seedDeviceObj.ip;
    }

    console.log(`\n[RECURSIVE] Inizio discovery ricorsivo da ${seedIp} (${seedDeviceObj?.sysname || seedIp})`);
    console.log(`[RECURSIVE] Max livelli: ${maxLevels}\n`);

    const discoveredIps = new Set([seedIp]); // IP già scoperti
    const todoQueue = [{ ip: seedIp, level: 0 }]; // Coda BFS: { ip, level }
    const discoveredDevices = []; // Device scoperti in questa sessione
    let scanned = 0;
    let found = 0;
    const startTime = Date.now();

    scanInfo.status = 'scanning';

    // BFS: scopri device livello per livello
    while (todoQueue.length > 0) {
      const { ip, level } = todoQueue.shift();

      if (level >= maxLevels) {
        console.log(`[RECURSIVE] Livello ${level} raggiunto (max ${maxLevels}), salto ${ip}`);
        continue;
      }

      scanned++;
      scanInfo.scanned = scanned;
      scanInfo.found = found;
      scanInfo.levels = level;

      console.log(`[RECURSIVE] [L${level}] Scansione ${ip}...`);

      try {
        // Discovery del device
        let discovery;
        try {
          discovery = await Promise.race([
            snmpAgent.discoverProtocols(ip, 3000),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
          ]);
        } catch (err) {
          console.log(`[RECURSIVE] [L${level}] ${ip}: NO SNMP (${err.message})`);
          continue;
        }

        // Salva device se ha sysName o neighbors
        if (discovery.sysName || discovery.lldp.length > 0 || discovery.cdp.length > 0 ||
          discovery.fdp.length > 0 || discovery.edp.length > 0) {
          found++;
          const deviceResult = db.upsertDevice({
            ip,
            sysname: discovery.sysName,
            sysdesc: discovery.sysDescr,
            sysuptime: discovery.sysUpTime,
            syslocation: discovery.sysLocation,
            snmp_version: '2c',
            community: community,
            status: 'active',
            level: level, // NeDi-style hierarchical level
          });

          // IMPORTANTE: lastInsertRowid funziona solo per INSERT, non per UPDATE
          // Dopo upsertDevice, recupera sempre il device per ottenere l'ID corretto
          let deviceId = deviceResult.lastInsertRowid;
          if (!deviceId) {
            // Se lastInsertRowid è null/undefined (UPDATE invece di INSERT), recupera dal database
            const deviceFromDb = db.getDevice(ip);
            if (deviceFromDb) {
              deviceId = deviceFromDb.id;
            } else {
              // Prova anche per sysname se IP non funziona
              if (discovery.sysName) {
                const allDevices = db.getAllDevices();
                const deviceByName = allDevices.find(d => d.sysname === discovery.sysName);
                if (deviceByName) {
                  deviceId = deviceByName.id;
                }
              }
            }
          }

          if (!deviceId) {
            console.error(`[RECURSIVE] [L${level}] ${ip}: ERRORE - deviceId non valido!`);
            console.error(`[RECURSIVE] [L${level}] ${ip}: deviceResult.lastInsertRowid=${deviceResult.lastInsertRowid}, db.getDevice(ip)?.id=${db.getDevice(ip)?.id}`);
            continue;
          }
          console.log(`[RECURSIVE] [L${level}] ${ip}: deviceId=${deviceId} (lastInsertRowid=${deviceResult.lastInsertRowid})`);

          discoveredDevices.push({ ip, sysname: discovery.sysName, level });
          const neighbors = discovery.lldp.length + discovery.cdp.length + discovery.fdp.length + discovery.edp.length;
          console.log(`[RECURSIVE] [L${level}] ✓ ${ip}: ${discovery.sysName || 'Unknown'} (deviceId=${deviceId}, ${neighbors} neighbors)`);
          console.log(`[RECURSIVE] [L${level}] ${ip}: LLDP=${discovery.lldp.length}, CDP=${discovery.cdp.length}, FDP=${discovery.fdp.length}, EDP=${discovery.edp.length}`);

          // DEBUG: Mostra primi neighbor LLDP
          if (discovery.lldp.length > 0) {
            console.log(`[RECURSIVE] [L${level}] ${ip}: Primi 3 neighbor LLDP:`);
            discovery.lldp.slice(0, 3).forEach((n, idx) => {
              console.log(`  [${idx}] sysName='${n.sysName || 'N/A'}', ip='${n.ip || 'N/A'}', chassisId='${n.chassisId || 'N/A'}'`);
            });
          }

          // Salva link e trova neighbor per discovery ricorsivo
          const neighborIps = new Set();
          let linksSaved = 0;

          // Processa LLDP neighbors
          for (const neighbor of discovery.lldp) {
            try {
              let neighborName = neighbor.sysName;
              let neighborIp = neighbor.ip;

              // Se non abbiamo IP da RemManAddrTable, prova a trovarlo dal database o dal sysName
              if (!neighborIp && neighborName) {
                // Cerca device esistente nel database per sysName
                const existingDevice = db.getDevice(neighborName);
                if (existingDevice && existingDevice.ip) {
                  neighborIp = existingDevice.ip;
                  console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor ${neighborName} ha IP ${neighborIp} dal database`);
                } else {
                  // Se sysName contiene pattern IP (es. XX_L2_RackA_Y -> IP da naming convention)
                  // Pattern: siteId_L2_RackX_lastOctet -> uses site-specific IP scheme
                  const ipMatch = neighborName.match(/(\d+)_L2_Rack[A-Za-z_]+?(\d+)$/);
                  if (ipMatch) {
                    const siteId = parseInt(ipMatch[1]);
                    const lastOctet = ipMatch[2];
                    neighborIp = `192.168.${siteId}.${lastOctet}`;
                    console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor ${neighborName} IP dedotto: ${neighborIp}`);
                  }
                }
              }

              if (!neighborName && neighbor.chassisId) {
                if (/^\d+\.\d+\.\d+\.\d+$/.test(neighbor.chassisId)) {
                  neighborName = neighbor.chassisId;
                  neighborIp = neighbor.chassisId;
                } else if (/^[0-9a-fA-F:]{17}$/.test(neighbor.chassisId)) {
                  neighborName = neighbor.chassisId.replace(/:/g, '');
                } else {
                  neighborName = neighbor.chassisId.substring(0, 64);
                }
              }

              // IMPORTANTE: Salva link anche se non abbiamo neighborName, usando chassisId o portId
              if (!neighborName && !neighbor.chassisId && !neighbor.portId) {
                console.log(`[RECURSIVE] [L${level}] ${ip}: SKIP neighbor senza nome/chassisId/portId`);
                continue;
              }

              // Se non abbiamo neighborName, usiamo chassisId o portId come fallback
              if (!neighborName) {
                if (neighbor.chassisId) {
                  neighborName = `chassis-${neighbor.chassisId.substring(0, 16)}`;
                } else if (neighbor.portId) {
                  neighborName = `port-${neighbor.portId}`;
                }
              }

              // Crea/aggiorna device neighbor
              let remoteDevice = null;
              if (neighborName) {
                remoteDevice = db.getDevice(neighborName);
              }
              if (!remoteDevice && neighborIp) {
                remoteDevice = db.getDevice(neighborIp);
              }

              if (!remoteDevice && neighborName) {
                const neighborDevice = {
                  sysname: neighborName,
                  sysdesc: neighbor.sysDesc || null,
                  syslocation: null,
                  snmp_version: null,
                  community: null,
                  status: 'neighbor',
                  // NeDi-style LLDP level: neighbor è sempre 1 hop dopo il device corrente
                  // (equivalente a ReadDevs(..., $lv+1) in libmap.php)
                  level: level + 1,
                };
                if (neighborIp) {
                  neighborDevice.ip = neighborIp;
                }
                db.upsertDevice(neighborDevice);
                remoteDevice = db.getDevice(neighborName) || (neighborIp ? db.getDevice(neighborIp) : null);
              }

              // Salva link SEMPRE, anche se remoteDevice non esiste
              try {
                db.upsertLink({
                  device_id: deviceId,
                  local_ifindex: parseInt(neighbor.localPort) || null,
                  remote_device_id: remoteDevice ? remoteDevice.id : null,
                  remote_ip: remoteDevice ? (remoteDevice.ip || neighborIp) : neighborIp,
                  remote_sysname: neighbor.sysName || neighborName || null,
                  remote_chassisid: neighbor.chassisId || null,
                  remote_portid: neighbor.portId || null,
                  remote_portdesc: neighbor.portDesc || null, // Fixed: use portDesc
                  protocol: 'LLDP',
                });
                linksSaved++;
                if (linksSaved <= 3 || linksSaved % 10 === 0) {
                  console.log(`[RECURSIVE] [L${level}] ${ip}: Link salvato ${linksSaved}/${discovery.lldp.length} per ${neighborName || neighbor.chassisId || 'unknown'}`);
                }
              } catch (err) {
                console.error(`[RECURSIVE] [L${level}] ${ip}: Errore salvataggio link per ${neighborName || 'unknown'}: ${err.message}`);
              }

              // Se ha IP valido e remoteDevice, aggiungi alla coda per discovery ricorsivo
              if (remoteDevice) {
                const ipToAdd = remoteDevice.ip || neighborIp;
                if (ipToAdd && /^\d+\.\d+\.\d+\.\d+$/.test(ipToAdd) &&
                  !discoveredIps.has(ipToAdd)) {
                  // Verifica che non sia network/broadcast
                  const ipParts = ipToAdd.split('.');
                  const lastOctet = parseInt(ipParts[3]);
                  if (lastOctet !== 0 && lastOctet !== 255) {
                    neighborIps.add(ipToAdd);
                    console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor ${neighborName} ha IP ${ipToAdd} - aggiunto alla coda`);
                  }
                } else {
                  if (ipToAdd) {
                    console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor ${neighborName} IP ${ipToAdd} già scoperto o invalido`);
                  } else {
                    console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor ${neighborName} senza IP valido`);
                  }
                }
              }
            } catch (err) {
              console.error(`[RECURSIVE] Errore link LLDP: ${err.message}`);
            }
          }

          // Processa CDP neighbors (stessa logica)
          for (const neighbor of discovery.cdp) {
            try {
              if (neighbor.sysName) {
                let remoteDevice = db.getDevice(neighbor.sysName);
                if (!remoteDevice && neighbor.ip) {
                  remoteDevice = db.getDevice(neighbor.ip);
                }

                if (!remoteDevice) {
                  const neighborDevice = {
                    sysname: neighbor.sysName,
                    sysdesc: neighbor.sysDesc || null,
                    syslocation: null,
                    snmp_version: null,
                    community: null,
                    status: 'neighbor',
                    level: level + 1, // Neighbor è 1 livello dopo il device corrente
                  };
                  if (neighbor.ip) {
                    neighborDevice.ip = neighbor.ip;
                  }
                  db.upsertDevice(neighborDevice);
                  remoteDevice = db.getDevice(neighbor.sysName) || db.getDevice(neighbor.ip);
                }

                if (remoteDevice) {
                  db.upsertLink({
                    device_id: deviceId,
                    local_ifindex: parseInt(neighbor.localPort) || null,
                    remote_device_id: remoteDevice.id,
                    remote_ip: remoteDevice.ip || neighbor.ip,
                    remote_sysname: neighbor.sysName,
                    remote_chassisid: neighbor.chassisId || null,
                    remote_portid: neighbor.portId || null,
                    remote_portdesc: neighbor.portDesc || null, // Fixed: use portDesc
                    protocol: 'CDP',
                  });

                  const ipToAdd = remoteDevice.ip || neighbor.ip;
                  if (ipToAdd && /^\d+\.\d+\.\d+\.\d+$/.test(ipToAdd) &&
                    !discoveredIps.has(ipToAdd)) {
                    // Verifica che non sia network/broadcast
                    const ipParts = ipToAdd.split('.');
                    const lastOctet = parseInt(ipParts[3]);
                    if (lastOctet !== 0 && lastOctet !== 255) {
                      neighborIps.add(ipToAdd);
                      console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor CDP ${neighbor.sysName} ha IP ${ipToAdd} - aggiunto alla coda`);
                    }
                  } else {
                    if (ipToAdd) {
                      console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor CDP ${neighbor.sysName} IP ${ipToAdd} già scoperto o invalido`);
                    } else {
                      console.log(`[RECURSIVE] [L${level}] ${ip}: Neighbor CDP ${neighbor.sysName} senza IP valido`);
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`[RECURSIVE] Errore link CDP: ${err.message}`);
            }
          }

          // Aggiungi neighbor alla coda per discovery ricorsivo
          console.log(`[RECURSIVE] [L${level}] ${ip}: Link LLDP salvati: ${linksSaved}/${discovery.lldp.length}`);
          console.log(`[RECURSIVE] [L${level}] ${ip}: Trovati ${neighborIps.size} neighbor IP da scoprire`);
          for (const neighborIp of neighborIps) {
            if (!discoveredIps.has(neighborIp)) {
              discoveredIps.add(neighborIp);
              todoQueue.push({ ip: neighborIp, level: level + 1 });
              console.log(`[RECURSIVE] [L${level}] → Aggiunto ${neighborIp} alla coda (livello ${level + 1})`);
            } else {
              console.log(`[RECURSIVE] [L${level}] → ${neighborIp} già scoperto, salto`);
            }
          }
          console.log(`[RECURSIVE] [L${level}] ${ip}: Coda ora contiene ${todoQueue.length} device`);
        }
      } catch (err) {
        console.error(`[RECURSIVE] [L${level}] Errore su ${ip}: ${err.message}`);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    scanInfo.status = 'completed';
    scanInfo.discoveredDevices = discoveredDevices;

    console.log(`\n[RECURSIVE] Discovery ricorsivo completato in ${totalTime}s`);
    console.log(`[RECURSIVE] Device scansionati: ${scanned}, trovati: ${found}`);
    console.log(`[RECURSIVE] Livelli esplorati: ${scanInfo.levels}`);

    setTimeout(() => activeScans.delete(scanId), 5 * 60 * 1000);

    return res.json({
      seed: seedDevice,
      seedIp,
      scanned,
      found,
      levels: scanInfo.levels,
      discoveredDevices: discoveredDevices.length,
      devices: discoveredDevices,
      duration: `${totalTime}s`,
      scanId,
    });
  } catch (err) {
    console.error('Errore in /api/discover-recursive', err);
    scanInfo.status = 'error';
    scanInfo.error = err.message;
    setTimeout(() => activeScans.delete(scanId), 5 * 60 * 1000);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint per LLDP SNMP discovery con import automatico Access Point
app.post('/api/discovery/lldp-snmp', async (req, res) => {
  const scanId = `lldp-snmp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const scanInfo = {
    id: scanId,
    network: req.body?.network,
    status: 'starting',
    startTime: Date.now(),
    scanned: 0,
    responsive: 0,
    lldpEnabled: 0,
    apImported: 0,
    devices: [],
  };
  activeScans.set(scanId, scanInfo);

  try {
    const { network } = req.body || {};
    if (!network) {
      activeScans.delete(scanId);
      return res.status(400).json({ error: 'network richiesto (formato CIDR, es. 192.168.21.0/24)' });
    }

    // Espandi CIDR
    let hosts;
    try {
      hosts = expandCidr(network, 1024);
    } catch (err) {
      activeScans.delete(scanId);
      return res.status(400).json({ error: err.message });
    }

    console.log(`\n[LLDP-SNMP] Inizio discovery per ${network} (${hosts.length} host)`);
    console.log(`[LLDP-SNMP] Community: ${COMMUNITY}\n`);

    scanInfo.status = 'scanning';
    const results = [];
    const apPattern = /ap|pdv|wifi|wireless|wlan/i;

    // Test SNMP parallelo (concurrency 10)
    const concurrency = 10;
    const queue = [...hosts];
    let scanned = 0;
    let responsive = 0;
    let lldpEnabled = 0;
    let apImported = 0;

    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const ip = queue.shift();
        scanned++;
        scanInfo.scanned = scanned;

        try {
          // 1. Test connettività SNMP (sysName)
          const sysNameResult = await snmpAgent.getSysName(ip);
          if (!sysNameResult) {
            results.push({
              ip,
              sysname: null,
              lldp: false,
              neighbors: 0,
              aps: 0,
              status: 'no-snmp',
            });
            continue;
          }

          responsive++;
          scanInfo.responsive = responsive;
          console.log(`[LLDP-SNMP] ${ip}: SNMP OK (sysName: ${sysNameResult})`);

          // 2. Test accesso MIB LLDP (1.0.8802.1.1.2.1.1.1.0)
          const lldpTest = await snmpAgent.get(ip, ['1.0.8802.1.1.2.1.1.1.0']);
          if (lldpTest.err || !lldpTest.values?.[0]?.value) {
            console.log(`[LLDP-SNMP] ${ip}: LLDP MIB non accessibile`);
            results.push({
              ip,
              sysname: sysNameResult,
              lldp: false,
              neighbors: 0,
              aps: 0,
              status: 'no-lldp',
            });
            continue;
          }

          lldpEnabled++;
          scanInfo.lldpEnabled = lldpEnabled;
          console.log(`[LLDP-SNMP] ${ip}: LLDP MIB accessibile`);

          // 3. Conta neighbors LLDP (walk lldpRemSysName)
          const lldpWalk = await snmpAgent.walk(ip, '1.0.8802.1.1.2.1.4.1.1.9', 50, 5000);
          const neighbors = lldpWalk.rows || [];
          console.log(`[LLDP-SNMP] ${ip}: ${neighbors.length} neighbors LLDP trovati`);

          // 4. Filtra solo Access Point
          let apCount = 0;
          const apList = [];
          for (const vb of neighbors) {
            if (!vb?.value) continue;
            const sysName = snmpAgent.decodeValue(vb.value);
            if (apPattern.test(sysName)) {
              apCount++;
              apList.push(sysName);
            }
          }

          console.log(`[LLDP-SNMP] ${ip}: ${apCount} Access Point trovati`);

          // 5. Import AP nel database (solo se ci sono AP)
          if (apCount > 0) {
            // Trova device nel database
            let device = db.getDevice(ip);
            if (!device) {
              // Crea device se non esiste
              const deviceResult = db.upsertDevice({
                ip,
                sysname: sysNameResult,
                snmp_version: '2c',
                community: COMMUNITY,
                status: 'active',
              });
              device = db.getDevice(ip);
            }

            if (device) {
              // Importa link LLDP per ogni AP
              const discovery = await snmpAgent.discoverProtocols(ip, 10000);
              const apNeighbors = discovery.lldp.filter(n => {
                const name = (n.sysName || n.portDescr || '').toLowerCase();
                return apPattern.test(name);
              });

              console.log(`[LLDP-SNMP] ${ip}: Import ${apNeighbors.length} AP nel database...`);
              const now = Math.floor(Date.now() / 1000);

              for (const n of apNeighbors) {
                const neighborName = n.sysName || n.chassisId || n.portId;
                if (!neighborName) continue;

                // Crea/aggiorna device neighbor AP
                let remoteDevice = db.getDevice(neighborName);
                if (!remoteDevice && n.ip) {
                  remoteDevice = db.getDevice(n.ip);
                }

                if (!remoteDevice && neighborName) {
                  const neighborDevice = {
                    sysname: neighborName,
                    sysdesc: n.sysDesc || null,
                    snmp_version: null,
                    community: null,
                    status: 'neighbor',
                  };
                  if (n.ip) {
                    neighborDevice.ip = n.ip;
                  }
                  db.upsertDevice(neighborDevice);
                  remoteDevice = db.getDevice(neighborName) || (n.ip ? db.getDevice(n.ip) : null);
                }

                // Salva link
                db.upsertLink({
                  device_id: device.id,
                  local_ifindex: parseInt(n.localPort) || null,
                  remote_device_id: remoteDevice ? remoteDevice.id : null,
                  remote_ip: remoteDevice ? (remoteDevice.ip || n.ip) : n.ip,
                  remote_sysname: n.sysName || neighborName || null,
                  remote_chassisid: n.chassisId || null,
                  remote_portid: n.portId || null,
                  remote_portdesc: n.portDesc || null,
                  protocol: 'LLDP',
                });

                apImported++;
                scanInfo.apImported = apImported;
              }
              console.log(`[LLDP-SNMP] ${ip}: ✓ Importati ${apNeighbors.length} AP`);
            }
          }

          results.push({
            ip,
            sysname: sysNameResult,
            lldp: true,
            neighbors: neighbors.length,
            aps: apCount,
            apList: apList.slice(0, 10), // Max 10 per response size
            status: 'ok',
          });
        } catch (err) {
          console.error(`[LLDP-SNMP] ${ip}: Errore - ${err.message}`);
          results.push({
            ip,
            sysname: null,
            lldp: false,
            neighbors: 0,
            aps: 0,
            status: 'error',
            error: err.message,
          });
        }
      }
    });

    await Promise.all(workers);

    const totalTime = ((Date.now() - scanInfo.startTime) / 1000).toFixed(1);
    scanInfo.status = 'completed';
    scanInfo.devices = results;

    console.log(`\n[LLDP-SNMP] Discovery completato in ${totalTime}s`);
    console.log(`[LLDP-SNMP] Scansionati: ${scanned}, Responsive: ${responsive}, LLDP: ${lldpEnabled}, AP importati: ${apImported}`);

    setTimeout(() => activeScans.delete(scanId), 5 * 60 * 1000);

    return res.json({
      success: true,
      network,
      scanned,
      responsive,
      lldpEnabled,
      apImported,
      devices: results,
      duration: `${totalTime}s`,
      scanId,
    });
  } catch (err) {
    console.error('[LLDP-SNMP] Errore:', err);
    scanInfo.status = 'error';
    scanInfo.error = err.message;
    setTimeout(() => activeScans.delete(scanId), 5 * 60 * 1000);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint per verificare scansioni attive
app.get('/api/scans/status', (req, res) => {
  const scans = Array.from(activeScans.values()).map(scan => ({
    id: scan.id,
    cidr: scan.cidr,
    status: scan.status,
    progress: scan.progress || '0',
    scanned: scan.scanned || 0,
    found: scan.found || 0,
    total: scan.total || 0,
    elapsed: scan.startTime ? `${((Date.now() - scan.startTime) / 1000).toFixed(1)}s` : '0s',
  }));
  res.json({ active: scans.length, scans });
});

// Query devices dal database
app.get('/api/devices', (req, res) => {
  try {
    // Parametri filtro
    const siteId = req.query.site_id ? parseInt(req.query.site_id, 10) : null;

    // Cache key basata sui parametri query
    const cacheKey = `devices:${JSON.stringify(req.query)}`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log('[CACHE HIT] Returning cached devices list');
      return res.json(cached);
    }

    console.log('[CACHE MISS] Fetching devices from database');

    // Filtra per sito se specificato
    let devices;
    if (siteId) {
      devices = db.getDevicesBySite(siteId);
    } else if (req.query.unassigned === 'true') {
      devices = db.getUnassignedDevices();
    } else {
      devices = db.getAllDevices();
    }

    // Aggiungi informazioni sito ai devices
    const sites = db.getAllSites();
    const siteMap = new Map(sites.map(s => [s.id, s]));

    const devicesWithSite = devices.map(d => ({
      ...d,
      site: d.site_id ? siteMap.get(d.site_id) : null
    }));

    const result = {
      count: devicesWithSite.length,
      site_filter: siteId ? siteMap.get(siteId)?.name : null,
      devices: devicesWithSite
    };

    // Salva in cache
    deviceCache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query device specifico
app.get('/api/devices/:ip', (req, res) => {
  try {
    const { ip } = req.params;

    // Cache key basata su IP del device
    const cacheKey = `device:${ip}`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log(`[CACHE HIT] Returning cached device details for ${ip}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] Fetching device details for ${ip} from database`);

    const device = db.getDevice(ip);
    if (!device) {
      // 404 responses are NOT cached
      return res.status(404).json({ error: 'Device non trovato' });
    }

    const interfaces = db.getDeviceInterfaces(device.id);
    const links = db.getDeviceLinks(device.id);

    const result = {
      device,
      interfaces,
      links,
    };

    // Salva in cache
    deviceCache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query port statistics per device (con VLAN, MAC count, STP, PoE)
app.get('/api/devices/:ip/port-stats', (req, res) => {
  try {
    const { ip } = req.params;

    // Cache key basata su IP del device
    const cacheKey = `device:${ip}:port-stats`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log(`[CACHE HIT] Returning cached port stats for ${ip}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] Fetching port stats for ${ip} from database`);

    const device = db.getDevice(ip);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    const ports = db.getPortStatistics(device.id);

    // Aggiungi STP e PoE se disponibili
    const stpPorts = db.getDeviceSTPPorts(device.id);
    const stpMap = new Map(stpPorts.map(p => [p.port_num, p]));

    const poePorts = db.getDevicePoEPorts(device.id);
    const poeMap = new Map(poePorts.map(p => [p.interface_id, p]));

    ports.forEach(port => {
      const stp = stpMap.get(port.ifindex);
      if (stp) {
        port.stpState = stp.state;
        port.stpPriority = stp.priority;
        port.stpPathCost = stp.path_cost;
      }

      const poe = poeMap.get(port.id);
      if (poe) {
        port.poe = {
          adminEnabled: poe.admin_enabled,
          detection_status: poe.detection_status,
          delivering: poe.detection_status === 3,
          priority: poe.priority,
          power_class: poe.power_class,
          power_used: poe.power_used,
        };
      }
    });

    const result = {
      device: ip,
      count: ports.length,
      ports,
    };

    // Cache the result
    deviceCache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint per summary device (per tooltip)
app.get('/api/devices/:ip/summary', (req, res) => {
  try {
    const { ip } = req.params;

    // Cache key basata su IP del device
    const cacheKey = `device:${ip}:summary`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log(`[CACHE HIT] Returning cached device summary for ${ip}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] Fetching device summary for ${ip} from database`);

    const device = db.getDevice(ip);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    // Ottieni statistiche porte
    const portStats = db.getPortStatistics(device.id);

    // Estrai vendor e model da sysdesc se disponibile
    let vendor = device.vendor || null;
    let model = device.model || null;

    if (!vendor && device.sysdesc) {
      // Parsing basilare vendor da sysdesc
      const desc = device.sysdesc.toLowerCase();
      if (desc.includes('cisco')) vendor = 'Cisco';
      else if (desc.includes('huawei')) vendor = 'Huawei';
      else if (desc.includes('hp')) vendor = 'HP';
      else if (desc.includes('aruba')) vendor = 'Aruba';
      else if (desc.includes('juniper')) vendor = 'Juniper';
      else if (desc.includes('mikrotik')) vendor = 'Mikrotik';
    }

    // Calcola uptime in secondi (se sysuptime e in centesimi di secondo)
    let uptime = device.sysuptime;
    if (uptime && uptime > 100) {
      uptime = Math.floor(uptime / 100); // Converti centesimi in secondi
    }

    const result = {
      device: {
        ip: device.ip,
        sysname: device.sysname,
        sysdesc: device.sysdesc,
        sysuptime: device.sysuptime,
        status: device.status,
      },
      vendor,
      model,
      uptime,
      portStats: portStats.map(p => ({
        ifindex: p.ifindex,
        ifname: p.ifname,
        ifoperstatus: p.ifoperstatus,
        ifadminstatus: p.ifadminstatus,
        ifspeed: p.ifspeed,
      })),
    };

    // Salva in cache
    deviceCache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query IP addresses per device
app.get('/api/devices/:ip/addresses', (req, res) => {
  try {
    const { ip } = req.params;

    // Cache key basata su IP del device
    const cacheKey = `device:${ip}:addresses`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log(`[CACHE HIT] Returning cached addresses for ${ip}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] Fetching addresses for ${ip} from database`);

    const device = db.getDevice(ip);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    const addresses = db.getDeviceIPAddresses(device.id);
    const response = {
      device: ip,
      count: addresses.length,
      addresses,
    };

    // Cache the response
    deviceCache.set(cacheKey, response);

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query VLANs per device
app.get('/api/devices/:ip/vlans', (req, res) => {
  try {
    const { ip } = req.params;

    // Cache key basata su IP del device
    const cacheKey = `device:${ip}:vlans`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log(`[CACHE HIT] Returning cached VLANs for ${ip}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] Fetching VLANs for ${ip} from database`);

    const device = db.getDevice(ip);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    const vlans = db.db.prepare('SELECT * FROM vlans WHERE device_id = ? ORDER BY vlan_id').all(device.id);
    const response = {
      device: ip,
      count: vlans.length,
      vlans,
    };

    // Cache the response
    deviceCache.set(cacheKey, response);

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query LAG/LACP per device
app.get('/api/devices/:ip/lags', (req, res) => {
  try {
    const { ip } = req.params;

    // Cache key basata su IP del device
    const cacheKey = `device:${ip}:lags`;
    const cached = deviceCache.get(cacheKey);

    if (cached) {
      console.log(`[CACHE HIT] Returning cached LAGs for ${ip}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] Fetching LAGs for ${ip} from database`);

    const device = db.getDevice(ip);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    const lags = db.getDeviceLAGs(device.id);
    const response = {
      device: ip,
      count: lags.length,
      lags,
    };

    // Cache the response
    deviceCache.set(cacheKey, response);

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query links
app.get('/api/links', (req, res) => {
  try {
    const links = db.getAllLinks();
    res.json({ count: links.length, links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query events
app.get('/api/events', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const events = db.getEvents(limit);
    res.json({ count: events.length, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monitoring: check device status
app.post('/api/monitoring/check', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'IP richiesto' });
    }

    const device = db.getDevice(ip);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    const startTime = Date.now();
    const sysName = await snmpAgent.getSysName(ip);
    const latency = Date.now() - startTime;

    const status = sysName ? 'up' : 'down';

    db.upsertMonitoring({
      device_id: device.id,
      status,
      latency: sysName ? latency : null,
    });

    res.json({
      device: ip,
      status,
      latency: sysName ? latency : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monitoring: check tutti i dispositivi
app.post('/api/monitoring/check-all', async (req, res) => {
  try {
    const devices = db.getAllDevices();
    const results = [];

    const concurrency = 10;
    const queue = [...devices];
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const device = queue.shift();
        try {
          const startTime = Date.now();
          const sysName = await snmpAgent.getSysName(device.ip);
          const latency = Date.now() - startTime;
          const status = sysName ? 'up' : 'down';

          db.upsertMonitoring({
            device_id: device.id,
            status,
            latency: sysName ? latency : null,
          });

          results.push({ ip: device.ip, status, latency: sysName ? latency : null });
        } catch (err) {
          results.push({ ip: device.ip, status: 'down', error: err.message });
        }
      }
    });

    await Promise.all(workers);

    res.json({
      count: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mappa completa dal database
app.get('/api/map-db', (req, res) => {
  try {
    // Parametri filtro sito
    const siteId = req.query.site_id ? parseInt(req.query.site_id, 10) : null;
    const siteIds = req.query.site_ids ? req.query.site_ids.split(',').map(id => parseInt(id, 10)) : null;

    // Cache key basata sui parametri query
    const cacheKey = `map-db:${JSON.stringify(req.query)}`;
    const cached = mapCache.get(cacheKey);

    if (cached) {
      console.log('[CACHE HIT] Returning cached map data');
      return res.json(cached);
    }

    console.log('[CACHE MISS] Fetching from database');

    // Usa query ottimizzate con filtro sito opzionale
    let devices;
    if (siteId) {
      devices = db.getDevicesBySite(siteId);
    } else if (siteIds && siteIds.length > 0) {
      devices = db.getDevicesBySites(siteIds);
    } else {
      devices = db.getAllDevices();
    }
    const links = db.getDeduplicatedLinks(); // Query ottimizzata + deduplicata
    const fmt = req.query.fmt || 'json'; // json, svg, png

    // Parametri stile NeDi
    const lev = Number(req.query.lev) || 1; // Level: 1-4+ (4 = mostra tutto)
    const mde = req.query.mde || 'b'; // Mode: 'b'=basic, 'f'=flat, 'l'=location, 'r'=ring
    const pwt = Number(req.query.pwt) || 10; // Power/Weight per layout
    const len = Number(req.query.len) || 120; // Lunghezza base layout
    const lal = Number(req.query.lal) || 50; // Label
    const lsf = Number(req.query.lsf) || 5; // Link scale factor
    const dim = req.query.dim || '1280x800'; // Dimensioni
    const [width, height] = dim.split('x').map(Number);

    // Modalità flat richiede lev >= 4
    const isFlatMode = (mde === 'f' || mde === 'l') && lev >= 4;

    // Crea mappa device_id -> ip per lookup veloce
    const deviceIdToIp = new Map();
    const ipToDevice = new Map();
    for (const device of devices) {
      deviceIdToIp.set(device.id, device.ip);
      ipToDevice.set(device.ip, device);
    }

    const nodesMap = new Map();
    const linksList = [];

    // Helper per verificare se un campo è valido (non null, non undefined, non stringa vuota)
    const isValid = (val) => val !== null && val !== undefined && val !== '';

    // Helper per determinare l'icona del device (stile NeDi)
    const getIcon = (device) => {
      const sysname = (device.sysname || '').toLowerCase();
      const sysdescr = (device.sysdescr || '').toLowerCase();
      const type = (device.type || '').toLowerCase();

      // Core/L3 switches
      if (sysname.includes('l3') || sysname.includes('core') || sysname.includes('s67') || sysname.includes('s77')) {
        return 'nedi/glob.png'; // Globe icon per core
      }
      // Router
      if (sysname.includes('router') || sysname.includes('rt') || sysdescr.includes('router')) {
        return 'nedi/rout.png';
      }
      // Firewall
      if (sysname.includes('fw') || sysname.includes('firewall') || sysdescr.includes('firewall')) {
        return 'nedi/nfw.png';
      }
      // Access Point
      if (sysname.includes('ap') || sysname.includes('wap') || sysdescr.includes('access point')) {
        return 'nedi/wlan.png';
      }
      // L2 Switch
      if (sysname.includes('l2') || sysname.includes('rack') || sysname.includes('s57') || sysname.includes('s27')) {
        return 'nedi/swit.png';
      }
      // Generic switch
      if (sysdescr.includes('switch') || type === 'l2') {
        return 'nedi/swit.png';
      }
      // Default
      return 'nedi/dev.png';
    };

    // Build nodes da devices
    for (const device of devices) {
      nodesMap.set(device.ip, {
        id: device.ip,
        label: device.sysname ? `${device.sysname}\n${device.ip}` : device.ip,
        sysname: device.sysname,
        type: 'device',
        status: device.status || 'active',
        icon: getIcon(device),
        w: 32, // Width icona
        h: 32, // Height icona
        level: device.level || 0, // NeDi-style hierarchical level
      });
    }

    // Build links - correggiamo il mapping
    let linksProcessed = 0;
    let linksSkipped = 0;
    let linksSkippedFromIp = 0;
    let linksSkippedToId = 0;

    for (const link of links) {
      // Ottieni IP locale dal device_id (usa isValid per evitare stringhe vuote)
      let fromIp = isValid(link.local_ip) ? link.local_ip : null;
      if (!fromIp && link.device_id) {
        fromIp = deviceIdToIp.get(link.device_id);
      }
      if (!isValid(fromIp)) {
        linksSkippedFromIp++;
        if (linksSkippedFromIp <= 3) {
          console.warn(`[MAP-DB] Link ${link.id}: device_id=${link.device_id}, local_ip='${link.local_ip}', fromIp=${fromIp}`);
        }
        linksSkipped++;
        continue;
      }

      // Determina IP/ID del dispositivo remoto
      let toId = null;
      let toLabel = null;
      let toType = 'neighbor';

      // PRIORITÀ 1: Se abbiamo remote_device_id, usa quello (device già matchato)
      if (isValid(link.remote_device_id)) {
        const remoteDevice = devices.find(d => d.id === link.remote_device_id);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname ? `${remoteDevice.sysname}\n${remoteDevice.ip}` : remoteDevice.ip;
          toType = 'device';
        }
      }

      // PRIORITÀ 2: Se non trovato, cerca per remote_ip (dal campo originale, non dal JOIN)
      if (!toId && isValid(link.remote_ip)) {
        const remoteDevice = ipToDevice.get(link.remote_ip);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname ? `${remoteDevice.sysname}\n${remoteDevice.ip}` : remoteDevice.ip;
          toType = 'device';
        } else if (isFlatMode || lev >= 3) {
          // Modalità flat o lev >= 3: mostra neighbor anche se non è device
          toId = link.remote_ip;
          toLabel = (isValid(link.remote_sysname) ? link.remote_sysname : link.remote_ip);
          toType = 'neighbor';
        }
      }

      // PRIORITÀ 3: Cerca per remote_sysname (anche se non abbiamo IP)
      if (!toId && isValid(link.remote_sysname)) {
        const remoteDevice = devices.find(d => d.sysname === link.remote_sysname);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = `${remoteDevice.sysname}\n${remoteDevice.ip}`;
          toType = 'device';
        } else if (isFlatMode || lev >= 3) {
          // Mostra neighbor per sysname anche in basic mode se lev >= 3
          toId = link.remote_sysname;
          toLabel = link.remote_sysname;
          toType = 'neighbor';
        }
      }

      // PRIORITÀ 4: Usa chassisId come fallback - cerca anche nei link per matchare device
      if (!toId && isValid(link.remote_chassisid)) {
        // Cerca se qualche device ha questo chassisId (confronto parziale)
        const matchingDevice = devices.find(d => {
          // Confronta chassisId con sysname o altri campi
          return d.sysname && (
            d.sysname.toLowerCase().includes(link.remote_chassisid.toLowerCase().substring(0, 8)) ||
            link.remote_chassisid.toLowerCase().includes(d.sysname.toLowerCase().substring(0, 8))
          );
        });

        if (matchingDevice) {
          toId = matchingDevice.ip;
          toLabel = matchingDevice.sysname ? `${matchingDevice.sysname}\n${matchingDevice.ip}` : matchingDevice.ip;
          toType = 'device';
        } else if (isFlatMode || lev >= 3) {
          // Se non trovato, usa chassisId come neighbor
          toId = `chassis-${link.remote_chassisid.substring(0, 12)}`;
          toLabel = (isValid(link.remote_sysname) ? link.remote_sysname : link.remote_chassisid.substring(0, 16));
          toType = 'neighbor';
        }
      }

      // PRIORITÀ 5: Usa remote_portid come ultimo fallback
      if (!toId && isValid(link.remote_portid)) {
        // Crea un ID univoco usando fromIp + portId
        toId = `${fromIp}-port-${link.remote_portid}`;
        toLabel = isValid(link.remote_sysname) ? link.remote_sysname : `Port ${link.remote_portid}`;
        toType = 'neighbor';
      }

      // PRIORITÀ 6: Se non abbiamo nessun identificatore remoto, crea comunque un link "sconosciuto"
      // (solo se abbiamo almeno local_ifindex per identificare l'interfaccia)
      if (!toId && isValid(link.local_ifindex)) {
        if (isFlatMode || lev >= 4) {
          toId = `${fromIp}-if${link.local_ifindex}-unknown`;
          toLabel = `Unknown (if ${link.local_ifindex})`;
          toType = 'neighbor';
        }
      }

      // Assicurati che fromIp e toId siano sempre definiti e validi PRIMA di continuare
      if (!isValid(fromIp)) {
        linksSkippedFromIp++;
        linksSkipped++;
        continue;
      }
      if (!isValid(toId)) {
        linksSkippedToId++;
        if (linksSkippedToId <= 3) {
          console.warn(`[MAP-DB] Link ${link.id}: toId non valido! remote_ip='${link.remote_ip}', remote_sysname='${link.remote_sysname}', remote_chassisid='${link.remote_chassisid}', remote_portid='${link.remote_portid}'`);
        }
        linksSkipped++;
        continue;
      }

      linksProcessed++;

      // Crea nodo neighbor se non esiste
      if (!nodesMap.has(toId)) {
        nodesMap.set(toId, {
          id: toId,
          label: toLabel || toId,
          type: toType,
          status: 'active',
        });
      }

      // Crea link con informazioni aggiuntive per level 4
      // Assicurati che from/to siano sempre presenti (non solo source/target)
      // di e ni vengono dalla query come alias (local_ifname as di, remote_portdesc as ni)
      const deviceIf = link.di || link.local_ifname || null;
      const neighborIf = link.ni || link.remote_portdesc || link.remote_portid || null;

      const linkData = {
        from: fromIp,  // PRIMARIO per frontend
        to: toId,      // PRIMARIO per frontend
        source: fromIp, // Per compatibilità D3.js/vis.js
        target: toId,   // Per compatibilità D3.js/vis.js
        di: deviceIf, // Device Interface (NeDi format)
        ni: neighborIf, // Neighbor Interface (NeDi format)
        protocol: link.protocol || 'LLDP',
        chassisId: link.remote_chassisid || null,
        label: deviceIf ? `if ${deviceIf}` : (link.protocol || 'LLDP'),
      };

      // Level 4: aggiungi informazioni dettagliate se disponibili
      if (lev >= 4) {
        if (deviceIf) {
          linkData.label = `if ${deviceIf} (${link.protocol || 'LLDP'})`;
        }
        if (neighborIf) {
          linkData.remoteIfDesc = neighborIf;
        }
      }

      linksList.push(linkData);
    }

    console.log(`[MAP-DB] Link processati: ${linksProcessed}, saltati: ${linksSkipped} (fromIp: ${linksSkippedFromIp}, toId: ${linksSkippedToId}), totali nel DB: ${links.length}`);

    // DEDUPLICAZIONE: rimuovi link duplicati e con dati corrotti
    const seenLinks = new Set();
    const deduplicatedLinks = [];
    let duplicatesRemoved = 0;
    let corruptedRemoved = 0;

    for (const link of linksList) {
      // Filtra link con dati HEX corrotti (> 30 caratteri, tipicamente system description)
      if (link.ni && link.ni.length > 50 && /^[0-9a-fA-F]+$/.test(link.ni)) {
        corruptedRemoved++;
        continue;
      }

      // Crea chiave univoca per deduplicazione (ordina from/to per catturare bidirezionali)
      const sortedPair = [link.from, link.to].sort().join('|');
      const portPair = [link.di || '', link.ni || ''].sort().join('|');
      const linkKey = `${sortedPair}:${portPair}`;

      if (!seenLinks.has(linkKey)) {
        seenLinks.add(linkKey);
        deduplicatedLinks.push(link);
      } else {
        duplicatesRemoved++;
      }
    }

    console.log(`[MAP-DB] Deduplicazione: rimossi ${duplicatesRemoved} duplicati, ${corruptedRemoved} corrotti. Link finali: ${deduplicatedLinks.length}`);

    const nodes = Array.from(nodesMap.values());

    // Applica layout gerarchico stile NeDi con parametri personalizzati
    const layoutWidth = width || 1200;
    const layoutHeight = height || 800;
    const baseLength = len || Math.min(layoutWidth, layoutHeight) / 4;

    if (fmt === 'svg') {
      mapGenerator.forceDirectedLayout(nodes, deduplicatedLinks, 30, layoutWidth, layoutHeight);
    } else {
      // Per JSON, usa layout gerarchico con parametri NeDi
      mapGenerator.hierarchicalLayout(nodes, deduplicatedLinks, layoutWidth, layoutHeight, {
        pwt, // Power/Weight
        len: baseLength, // Lunghezza base
        lsf, // Link scale factor
      });
    }

    if (fmt === 'svg') {
      const svg = mapGenerator.generateSVG(nodes, deduplicatedLinks, {
        width: layoutWidth,
        height: layoutHeight,
        title: req.query.tit || req.query.title || 'Network Map',
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }

    const mapData = mapGenerator.generateJSON(nodes, deduplicatedLinks, {
      metadata: {
        nodeCount: nodes.length,
        linkCount: deduplicatedLinks.length,
        level: lev,
        mode: mde,
        title: req.query.tit || req.query.title || 'Network Map',
      },
    });

    // Salva in cache
    mapCache.set(cacheKey, mapData);

    res.json(mapData);
  } catch (err) {
    console.error('Errore in /api/map-db', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint mappa formato NeDi (D3.js v3)
app.get('/api/map-nedi', (req, res) => {
  try {
    // Parametri filtro (stile NeDi)
    const filterDevice = req.query['st[]'] || req.query.device; // Device specifico
    const filterRange = Number(req.query.range) || 0; // Livelli di neighbor (0 = tutti)
    const dim = req.query.dim || '1280x800';
    const lev = Number(req.query.lev) || 4;
    const mde = req.query.mde || 'f';
    const pwt = Number(req.query.pwt) || 5;
    const len = Number(req.query.len) || 120;
    const [width, height] = dim.split('x').map(Number);

    const isFlatMode = (mde === 'f' || mde === 'l') && lev >= 4;

    // Filtra device se specificato
    let devices = db.getAllDevices();
    if (filterDevice) {
      devices = devices.filter(d =>
        d.sysname === filterDevice ||
        d.ip === filterDevice ||
        d.sysname?.includes(filterDevice)
      );
    }

    // Se range > 0, trova neighbor ricorsivamente
    const selectedDevices = new Set(devices.map(d => d.ip));
    const neighborDevices = new Set();

    if (filterRange > 0) {
      // BFS per trovare neighbor fino a 'range' livelli
      let currentLevel = new Set(selectedDevices);
      for (let level = 0; level < filterRange; level++) {
        const nextLevel = new Set();
        const allLinks = db.getAllLinks();

        for (const link of allLinks) {
          const fromIp = link.local_ip || devices.find(d => d.id === link.device_id)?.ip;
          if (!fromIp) continue;

          // Se il device locale è nel livello corrente, aggiungi il neighbor
          if (currentLevel.has(fromIp)) {
            let toIp = null;
            if (link.remote_device_id) {
              const remoteDevice = devices.find(d => d.id === link.remote_device_id);
              if (remoteDevice) toIp = remoteDevice.ip;
            } else if (link.remote_ip) {
              const remoteDevice = devices.find(d => d.ip === link.remote_ip);
              if (remoteDevice) toIp = remoteDevice.ip;
            } else if (link.remote_sysname) {
              const remoteDevice = devices.find(d => d.sysname === link.remote_sysname);
              if (remoteDevice) toIp = remoteDevice.ip;
            }

            if (toIp && !selectedDevices.has(toIp) && !neighborDevices.has(toIp)) {
              nextLevel.add(toIp);
              neighborDevices.add(toIp);
            }
          }
        }

        currentLevel = nextLevel;
        if (nextLevel.size === 0) break; // Nessun neighbor trovato
      }

      // Aggiungi neighbor devices trovati
      const allDevices = db.getAllDevices();
      for (const neighborIp of neighborDevices) {
        const neighborDevice = allDevices.find(d => d.ip === neighborIp);
        if (neighborDevice && !devices.find(d => d.ip === neighborIp)) {
          devices.push(neighborDevice);
        }
      }
    }

    // Helper per validazione
    const isValid = (val) => val !== null && val !== undefined && val !== '';

    // Filtra link solo per device selezionati
    let links = db.getAllLinks();
    if (filterDevice || filterRange > 0) {
      const selectedIps = new Set(devices.map(d => d.ip));
      links = links.filter(link => {
        const fromIp = link.local_ip || devices.find(d => d.id === link.device_id)?.ip;
        return fromIp && selectedIps.has(fromIp);
      });
    }

    // Filtra link vuoti (senza dati remoti) e deduplica per local_ifindex (mantieni quello con più dati)
    // NON filtrare i link senza dati remoti - devono essere visualizzati come "Unknown"
    // IMPORTANTE: Mantieni TUTTI i link, anche quelli senza dati remoti
    // Ogni link è unico per ID, quindi non serve deduplica
    // links rimane invariato - contiene tutti i 374 link

    // Crea mappa device_id -> ip
    const deviceIdToIp = new Map();
    const ipToDevice = new Map();
    for (const device of devices) {
      deviceIdToIp.set(device.id, device.ip);
      ipToDevice.set(device.ip, device);
    }

    // Crea array nodi (formato NeDi)
    const nodes = [];
    const nodeIndexMap = new Map(); // IP/ID -> indice nell'array
    const deviceMap = new Map(); // IP -> device object

    // Aggiungi device
    for (const device of devices) {
      const nodeIndex = nodes.length;
      nodeIndexMap.set(device.ip, nodeIndex);
      deviceMap.set(device.ip, device);

      // Determina icona: NeDi usa "dev/*.png" per device reali
      // CORREZIONE: switch core (215) -> skm, switch L2 -> s2l
      let iconPath = 'dev/w2gd'; // Default switch (come NeDi)
      if (device.sysname) {
        const sysname = device.sysname.toLowerCase();
        const sysdesc = (device.sysdesc || '').toLowerCase();

        // Switch Core (con 215, core, o S6730/S7700 che sono switch core)
        if (sysname.includes('215') || sysname.includes('core') ||
          sysname.includes('s6730') || sysname.includes('s7700') ||
          sysdesc.includes('215') || sysdesc.includes('core') ||
          sysdesc.includes('s6730') || sysdesc.includes('s7700')) {
          iconPath = 'dev/skmg'; // Switch core icon (come NeDi)
        }
        // Router L3 (S77xx sono router, S67xx sono switch core)
        else if (sysname.includes('l3') || sysname.includes('s77') ||
          sysdesc.includes('router') || sysdesc.includes('s77')) {
          iconPath = 'dev/w2gn'; // Router icon
        }
        // Switch L2 (tutti gli switch che contengono L2, Rack, o sono switch generici)
        else if (sysname.includes('l2') || sysname.includes('rack') || sysname.includes('s57') || sysname.includes('s27') ||
          sysdesc.includes('switch') || sysdesc.includes('s57') || sysdesc.includes('s27') ||
          sysdesc.includes('s5700') || sysdesc.includes('s2700')) {
          iconPath = 'dev/s2lg'; // Switch L2 icon (come NeDi)
        }
        // Altro
        else {
          iconPath = 'dev/w2gd'; // Default
        }
      }

      nodes.push({
        it: 'i', // tipo: icona
        h: 14,
        w: 14,
        is: iconPath, // path icona (senza "img/" - viene aggiunto nel frontend)
        na: device.sysname || device.ip, // nome
        ip: device.ip,
        ty: (() => {
          // Decodifica sysdesc se è in formato hex (problema di encoding)
          let desc = device.sysdesc || device.sysname || 'Device';
          // Se sembra essere hex (solo caratteri 0-9a-fA-F), prova a decodificare
          if (desc && /^[0-9a-fA-F]+$/.test(desc) && desc.length > 10) {
            try {
              // Prova a decodificare come hex
              const bytes = Buffer.from(desc, 'hex');
              desc = bytes.toString('utf8').replace(/\0/g, '').trim();
              if (!desc || desc.length < 3) desc = device.sysname || 'Device';
            } catch (e) {
              desc = device.sysname || 'Device';
            }
          }
          return desc.substring(0, 50);
        })(),
        lo: '', // location
        co: '', // contact
        mo: '' // mode
      });
    }

    // Aggiungi neighbor referenziati dai link
    const neighborMap = new Map();
    for (const link of links) {
      const fromIp = link.local_ip || deviceIdToIp.get(link.device_id);
      if (!isValid(fromIp)) continue;

      // Determina ID remoto (PRIORITÀ: remote_device_id > remote_ip > remote_sysname > remote_chassisid > remote_portid)
      let toId = null;
      let toLabel = null;

      if (isValid(link.remote_device_id)) {
        const remoteDevice = devices.find(d => d.id === link.remote_device_id);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname || remoteDevice.ip;
        }
      }

      if (!toId && isValid(link.remote_ip)) {
        const remoteDevice = ipToDevice.get(link.remote_ip);
        if (remoteDevice) {
          toId = link.remote_ip;
          toLabel = remoteDevice.sysname || link.remote_ip;
        } else {
          // Device non nella lista, ma abbiamo IP - crea neighbor
          toId = link.remote_ip;
          toLabel = link.remote_sysname || link.remote_ip;
        }
      }

      if (!toId && isValid(link.remote_sysname)) {
        const remoteDevice = devices.find(d => d.sysname === link.remote_sysname);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname;
        } else {
          // Device non nella lista, ma abbiamo sysname - crea neighbor
          toId = link.remote_sysname;
          toLabel = link.remote_sysname;
        }
      }

      if (!toId && isValid(link.remote_chassisid)) {
        toId = link.remote_chassisid;
        toLabel = link.remote_sysname || link.remote_chassisid.substring(0, 16);
      }

      if (!toId && isValid(link.remote_portid)) {
        toId = `${fromIp}-port-${link.remote_portid}`;
        toLabel = link.remote_sysname || link.remote_portid;
      }

      if (!toId) continue;

      // Aggiungi neighbor se non esiste (sempre, anche se non è nella lista devices)
      if (!nodeIndexMap.has(toId) && !neighborMap.has(toId)) {
        // Verifica se esiste come device nel database
        let neighborDevice = null;
        if (toId.includes('.')) {
          // È un IP, cerca device per IP
          neighborDevice = db.getDevice(toId);
        } else if (toLabel) {
          // È un sysname, cerca device per sysname
          const allDevices = db.getAllDevices();
          neighborDevice = allDevices.find(d => d.sysname === toLabel);
        }

        if (neighborDevice) {
          // È un device completo - usa le sue informazioni (inclusa icona)
          const nodeIndex = nodes.length;
          nodeIndexMap.set(neighborDevice.ip, nodeIndex);
          deviceMap.set(neighborDevice.ip, neighborDevice);

          // Determina icona per questo device
          let iconPath = 'dev/w2gd';
          if (neighborDevice.sysname) {
            const sysname = neighborDevice.sysname.toLowerCase();
            const sysdesc = (neighborDevice.sysdesc || '').toLowerCase();

            if (sysname.includes('l3') || sysname.includes('s67') || sysname.includes('s77') ||
              sysdesc.includes('router') || sysdesc.includes('s67') || sysdesc.includes('s77')) {
              iconPath = 'dev/w2gn';
            } else if (sysname.includes('215') || sysname.includes('core') ||
              sysdesc.includes('215') || sysdesc.includes('core')) {
              iconPath = 'dev/skmg';
            } else if (sysname.includes('l2') || sysname.includes('rack') || sysname.includes('s57') || sysname.includes('s27') ||
              sysdesc.includes('switch') || sysdesc.includes('s57') || sysdesc.includes('s27') ||
              sysdesc.includes('s5700') || sysdesc.includes('s2700')) {
              iconPath = 'dev/s2lg';
            }
          }

          nodes.push({
            it: 'i', // tipo: icona (non cerchio!)
            h: 14,
            w: 14,
            is: iconPath,
            na: neighborDevice.sysname || neighborDevice.ip,
            ip: neighborDevice.ip,
            ty: neighborDevice.sysdesc || neighborDevice.sysname || 'Device',
            lo: '',
            co: '',
            mo: ''
          });
        } else {
          // Non è un device completo - crea come cerchio
          neighborMap.set(toId, {
            id: toId,
            label: toLabel || toId,
            type: 'neighbor'
          });
        }
      }
    }

    // Aggiungi neighbor rimanenti (solo quelli che non sono device completi) all'array nodi
    for (const [neighborId, neighbor] of neighborMap) {
      if (nodeIndexMap.has(neighborId)) continue; // Già aggiunto come device

      const nodeIndex = nodes.length;
      nodeIndexMap.set(neighborId, nodeIndex);

      nodes.push({
        it: 'c', // tipo: circle (solo per neighbor senza device completo)
        h: 10,
        w: 10,
        is: '#1f6f3f', // colore neighbor
        na: neighbor.label,
        ip: neighborId.includes('.') ? neighborId : '',
        ty: 'Neighbor',
        lo: '',
        co: '',
        mo: ''
      });
    }

    // FASE 1: Crea TUTTI i nodi neighbor PRIMA di processare i link
    // Questo assicura che tutti i nodi siano disponibili quando processiamo i link
    let nodesCreatedPhase1 = 0;
    for (const link of links) {
      const fromIp = link.local_ip || deviceIdToIp.get(link.device_id);
      if (!isValid(fromIp)) {
        // DEBUG: Log per link senza fromIp
        if (nodesCreatedPhase1 < 5) {
          console.warn(`[MAP-NEDI FASE1] Link ${link.id} senza fromIp: device_id=${link.device_id}, local_ip=${link.local_ip}`);
        }
        continue;
      }

      let toId = null;
      let toLabel = null;

      // Determina toId usando la stessa logica di matching
      if (isValid(link.remote_device_id)) {
        const remoteDevice = devices.find(d => d.id === link.remote_device_id);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname || remoteDevice.ip;
        }
      }
      if (!toId && isValid(link.remote_ip)) {
        const remoteDevice = ipToDevice.get(link.remote_ip);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname || remoteDevice.ip;
        } else {
          // Device non nella lista, ma abbiamo IP - crea neighbor
          toId = link.remote_ip;
          toLabel = link.remote_sysname || link.remote_ip;
        }
      }
      if (!toId && isValid(link.remote_sysname)) {
        const remoteDevice = devices.find(d => d.sysname === link.remote_sysname);
        if (remoteDevice) {
          toId = remoteDevice.ip;
          toLabel = remoteDevice.sysname;
        } else {
          // Device non nella lista, ma abbiamo sysname - crea neighbor
          toId = link.remote_sysname;
          toLabel = link.remote_sysname;
        }
      }
      if (!toId && isValid(link.remote_chassisid)) {
        toId = `chassis-${link.remote_chassisid.substring(0, 16)}`;
        toLabel = link.remote_sysname || link.remote_chassisid.substring(0, 16);
      }
      if (!toId && isValid(link.remote_portid)) {
        toId = `${fromIp}-port-${link.remote_portid}`;
        toLabel = link.remote_sysname || `Port ${link.remote_portid}`;
      }
      // PRIORITÀ MASSIMA: Se non abbiamo toId, usa SEMPRE local_ifindex per creare un nodo "Unknown"
      // Questo è FONDAMENTALE per mostrare TUTTI i link, anche quelli senza dati remoti
      if (!toId) {
        if (isValid(link.local_ifindex)) {
          // Usa device_id + local_ifindex per creare un ID unico
          toId = `device-${link.device_id}-if${link.local_ifindex}-unknown`;
          toLabel = `Unknown (if ${link.local_ifindex})`;
        } else if (isValid(link.id)) {
          // Se non c'è nemmeno local_ifindex, usa l'ID del link stesso
          toId = `link-${link.id}-unknown`;
          toLabel = `Unknown (link ${link.id})`;
        }
      }

      // Crea nodo neighbor se non esiste già (SEMPRE, anche se toId è "Unknown")
      if (toId && !nodeIndexMap.has(toId) && !neighborMap.has(toId)) {
        nodesCreatedPhase1++;
        neighborMap.set(toId, {
          id: toId,
          label: toLabel || toId,
          type: 'neighbor'
        });
        const nodeIndex = nodes.length;
        nodeIndexMap.set(toId, nodeIndex);

        // Verifica se è un device esistente per determinare tipo e icona
        let neighborDevice = null;
        if (toId.includes('.')) {
          neighborDevice = db.getDevice(toId);
        } else if (toLabel) {
          const allDevices = db.getAllDevices();
          neighborDevice = allDevices.find(d => d.sysname === toLabel);
        }

        if (neighborDevice) {
          // È un device completo - determina icona manualmente
          let iconPath = 'dev/w2gd';
          if (neighborDevice.sysname) {
            const sysname = neighborDevice.sysname.toLowerCase();
            const sysdesc = (neighborDevice.sysdesc || '').toLowerCase();
            if (sysname.includes('l3') || sysname.includes('s67') || sysname.includes('s77') ||
              sysdesc.includes('router') || sysdesc.includes('s67') || sysdesc.includes('s77')) {
              iconPath = 'dev/w2gn';
            } else if (sysname.includes('215') || sysname.includes('core') ||
              sysdesc.includes('215') || sysdesc.includes('core')) {
              iconPath = 'dev/skmg';
            } else if (sysname.includes('l2') || sysname.includes('rack') || sysname.includes('s57') || sysname.includes('s27') ||
              sysdesc.includes('switch') || sysdesc.includes('s57') || sysdesc.includes('s27')) {
              iconPath = 'dev/s2lg';
            }
          }
          nodes.push({
            it: 'i',
            h: 14,
            w: 14,
            is: iconPath,
            na: neighborDevice.sysname || neighborDevice.ip,
            ip: neighborDevice.ip || '',
            ty: neighborDevice.sysdesc?.substring(0, 20) || 'Device',
            lo: neighborDevice.syslocation || '',
            co: neighborDevice.sysdesc?.substring(0, 30) || '',
            mo: neighborDevice.model || ''
          });
        } else {
          // È un neighbor parziale
          nodes.push({
            it: 'c',
            h: 6,
            w: 6,
            is: '#1f6f3f',
            na: toLabel || toId,
            ip: toId.includes('.') ? toId : '',
            ty: 'Neighbor',
            lo: '',
            co: '',
            mo: ''
          });
        }
      }
    }

    console.log(`[MAP-NEDI FASE1] Nodi neighbor creati: ${nodesCreatedPhase1}, nodi totali ora: ${nodes.length}`);

    // FASE 2: Crea link (formato NeDi)
    const linkMap = new Map(); // "sourceIndex-targetIndex" -> link
    let linksProcessed = 0;
    let linksSkipped = 0;

    for (const link of links) {
      const fromIp = link.local_ip || deviceIdToIp.get(link.device_id);
      if (!isValid(fromIp)) {
        linksSkipped++;
        continue;
      }

      const sourceIndex = nodeIndexMap.get(fromIp);
      if (sourceIndex === undefined) {
        linksSkipped++;
        continue;
      }

      let toId = null;
      // Stessa logica di matching (PRIORITÀ: remote_device_id > remote_ip > remote_sysname > remote_chassisid > remote_portid)
      if (isValid(link.remote_device_id)) {
        const remoteDevice = devices.find(d => d.id === link.remote_device_id);
        if (remoteDevice) toId = remoteDevice.ip;
      }
      if (!toId && isValid(link.remote_ip)) {
        const remoteDevice = ipToDevice.get(link.remote_ip);
        if (remoteDevice) {
          toId = remoteDevice.ip;
        } else {
          // Device non nella lista, ma abbiamo IP - usa IP come toId
          toId = link.remote_ip;
        }
      }
      if (!toId && isValid(link.remote_sysname)) {
        const remoteDevice = devices.find(d => d.sysname === link.remote_sysname);
        if (remoteDevice) {
          toId = remoteDevice.ip;
        } else {
          // Device non nella lista, ma abbiamo sysname - usa sysname come toId
          toId = link.remote_sysname;
        }
      }
      if (!toId && isValid(link.remote_chassisid)) {
        toId = `chassis-${link.remote_chassisid.substring(0, 16)}`;
      }
      if (!toId && isValid(link.remote_portid)) {
        toId = `${fromIp}-port-${link.remote_portid}`;
      }

      // PRIORITÀ MASSIMA: Se non abbiamo toId, usa SEMPRE local_ifindex o link.id
      // IMPORTANTE: Usa ESATTAMENTE lo stesso ID della FASE 1
      if (!toId) {
        if (isValid(link.local_ifindex)) {
          toId = `device-${link.device_id}-if${link.local_ifindex}-unknown`;
        } else if (isValid(link.id)) {
          toId = `link-${link.id}-unknown`;
        }
      }

      // DEBUG: Log per link senza toId (non dovrebbe più succedere)
      if (!toId) {
        console.warn(`[MAP-NEDI FASE2] Link ${link.id} ANCORA senza toId! device_id=${link.device_id}, local_ifindex=${link.local_ifindex}, link.id=${link.id}`);
        linksSkipped++;
        continue;
      }

      let targetIndex = nodeIndexMap.get(toId);
      if (targetIndex === undefined) {
        // Se il nodo non esiste, crealo ora (non dovrebbe succedere dopo FASE 1, ma per sicurezza)
        if (!neighborMap.has(toId)) {
          neighborMap.set(toId, {
            id: toId,
            label: toId.includes('Unknown') ? `Unknown (if ${link.local_ifindex})` : toId,
            type: 'neighbor'
          });
          const nodeIndex = nodes.length;
          nodeIndexMap.set(toId, nodeIndex);
          nodes.push({
            it: 'c',
            h: 6,
            w: 6,
            is: '#1f6f3f',
            na: toId.includes('Unknown') ? `Unknown (if ${link.local_ifindex})` : toId,
            ip: toId.includes('.') ? toId : '',
            ty: 'Neighbor',
            lo: '',
            co: '',
            mo: ''
          });
          targetIndex = nodeIndex; // Usa il nuovo indice
        } else {
          // Se esiste in neighborMap ma non in nodeIndexMap, cerca di recuperarlo
          targetIndex = nodeIndexMap.get(toId);
        }

        // Se ancora undefined, salta questo link
        if (targetIndex === undefined) {
          console.warn(`[MAP-NEDI FASE2] Link ${link.id} saltato: targetIndex undefined per toId=${toId}`);
          linksSkipped++;
          continue;
        }
      }

      linksProcessed++;

      // IMPORTANTE: Crea un link per ogni interfaccia, anche se vanno allo stesso nodo
      // Usa local_ifindex come parte della chiave per distinguere link multipli
      // AGGIUNGI ANCHE link.id per garantire unicità assoluta
      const linkKey = `${sourceIndex}-${targetIndex}-${link.local_ifindex || 0}-${link.id}`;
      if (linkMap.has(linkKey)) {
        // Link già esistente (non dovrebbe succedere con questa chiave, ma per sicurezza)
        const existingLink = linkMap.get(linkKey);
        existingLink.n = (existingLink.n || 1) + 1;
      } else {
        linkMap.set(linkKey, {
          source: sourceIndex,
          target: targetIndex,
          di: link.local_ifname || (link.local_ifindex ? `if${link.local_ifindex}` : '-'), // device interface
          ni: link.remote_portid || '-', // neighbor interface
          bw: 0, // bandwidth (non disponibile)
          w: 0.5, // width
          c: 'gray', // color
          n: 1 // numero link
        });
      }
    }

    const linksArray = Array.from(linkMap.values());

    // NeDi NON calcola coordinate iniziali nel JSON - D3.js le calcola da zero
    // Quindi NON aggiungiamo x,y ai nodi - lasciamo fare tutto a D3.js force layout

    console.log(`[MAP-NEDI] Nodi: ${nodes.length}, Link: ${linksArray.length} (processati: ${linksProcessed}, saltati: ${linksSkipped})`);

    res.json({
      nodes,
      links: linksArray
    });
  } catch (err) {
    console.error('Errore in /api/map-nedi', err);
    res.status(500).json({ error: err.message });
  }
});

// Export mappa come file
app.get('/api/map-export', async (req, res) => {
  try {
    const { fmt, filename } = req.query;
    if (!fmt || !['json', 'svg'].includes(fmt)) {
      return res.status(400).json({ error: 'fmt deve essere json o svg' });
    }

    const devices = db.getAllDevices();
    const links = db.getAllLinks();

    const nodesMap = new Map();
    const linksList = [];

    for (const device of devices) {
      nodesMap.set(device.ip, {
        id: device.ip,
        label: device.sysname ? `${device.sysname}\n${device.ip}` : device.ip,
        type: 'device',
        status: device.status,
      });
    }

    for (const link of links) {
      const fromIp = link.local_ip || link.device_id;
      const toId = link.remote_ip || link.remote_sysname || link.remote_chassisid || `unknown-${link.id}`;

      if (!nodesMap.has(toId)) {
        nodesMap.set(toId, {
          id: toId,
          label: link.remote_sysname || toId,
          type: 'neighbor',
        });
      }

      linksList.push({
        from: fromIp,
        to: toId,
        localIf: link.local_ifname || null, // NON usare ifindex se manca il nome
        remoteIf: link.remote_portid,
        protocol: link.protocol,
        label: link.local_ifname ? `if ${link.local_ifname}` : link.protocol,
      });
    }

    const nodes = Array.from(nodesMap.values());
    const exportDir = './exports';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(exportDir, filename || `map-${timestamp}.${fmt}`);

    if (fmt === 'json') {
      const mapData = mapGenerator.generateJSON(nodes, linksList);
      mapGenerator.saveJSON(mapData, filePath);
    } else if (fmt === 'svg') {
      mapGenerator.forceDirectedLayout(nodes, linksList, 50);
      const svg = mapGenerator.generateSVG(nodes, linksList);
      mapGenerator.saveSVG(svg, filePath);
    }

    res.json({
      success: true,
      file: filePath,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Errore in /api/map-export', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== AUTHENTICATION ==========

// Helper per hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Helper per generare token sessione
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware autenticazione (opzionale - per endpoint protetti)
function authMiddleware(requiredRole = null) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

    if (!token) {
      return res.status(401).json({ error: 'Token mancante' });
    }

    const session = db.getSessionByToken(token);
    if (!session) {
      return res.status(401).json({ error: 'Token non valido o scaduto' });
    }

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
    };

    // Verifica ruolo se richiesto
    const roleHierarchy = { viewer: 1, operator: 2, admin: 3 };
    if (requiredRole && roleHierarchy[session.role] < roleHierarchy[requiredRole]) {
      return res.status(403).json({ error: 'Permessi insufficienti' });
    }

    next();
  };
}

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username e password richiesti' });
    }

    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const passwordHash = hashPassword(password);
    if (user.password_hash !== passwordHash) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    // Crea sessione
    const token = generateToken();
    db.createSession(user.id, token, 86400); // 24 ore
    db.updateUserLastLogin(user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    if (token) {
      db.deleteSession(token);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verifica sessione
app.get('/api/auth/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) {
      return res.status(401).json({ valid: false });
    }

    const session = db.getSessionByToken(token);
    if (!session) {
      return res.status(401).json({ valid: false });
    }

    res.json({
      valid: true,
      user: {
        id: session.user_id,
        username: session.username,
        role: session.role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gestione utenti (solo admin)
app.get('/api/users', authMiddleware('admin'), (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authMiddleware('admin'), (req, res) => {
  try {
    const { username, password, role, email } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username e password richiesti' });
    }

    const passwordHash = hashPassword(password);
    const result = db.createUser({ username, password_hash: passwordHash, role, email });

    res.json({
      success: true,
      userId: result.lastInsertRowid,
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'Username già esistente' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', authMiddleware('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { role, email, password, active } = req.body;

    const updateData = { role, email, active };
    if (password) {
      updateData.password_hash = hashPassword(password);
    }

    db.updateUser(parseInt(id), updateData);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== RESCAN LINKS ==========

// Ri-scansiona link LLDP/CDP su tutti i device esistenti
app.post('/api/rescan-links', async (req, res) => {
  try {
    const devices = db.getAllDevices().filter(d => d.status === 'active');
    console.log(`[RESCAN] Ri-scansione link su ${devices.length} device...`);

    let totalLinks = 0;
    let devicesScanned = 0;
    let devicesWithLinks = 0;
    const errors = [];

    const concurrency = 5;
    const queue = [...devices];

    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const device = queue.shift();
        devicesScanned++;

        try {
          // Discovery LLDP/CDP
          const discovery = await snmpAgent.discoverProtocols(device.ip, 5000);
          const neighbors = [
            ...discovery.lldp.map(n => ({ ...n, protocol: 'LLDP' })),
            ...discovery.cdp.map(n => ({ ...n, protocol: 'CDP' })),
          ];

          if (neighbors.length === 0) {
            continue;
          }

          devicesWithLinks++;
          let deviceLinks = 0;

          for (const neighbor of neighbors) {
            // Trova remote device
            let remoteDevice = null;
            let remoteIp = neighbor.ip || null;
            let neighborName = neighbor.sysName || null;

            // Prova a trovare device per sysName o IP
            if (neighborName) {
              remoteDevice = db.getDevice(neighborName);
            }
            if (!remoteDevice && remoteIp) {
              remoteDevice = db.getDevice(remoteIp);
            }

            // Cross-reference con MAC se disponibile
            if (!remoteDevice && neighbor.chassisId && /^[0-9a-fA-F:.-]{12,17}$/.test(neighbor.chassisId)) {
              remoteDevice = db.getDeviceByMAC(neighbor.chassisId);
            }

            // Salva link
            db.upsertLink({
              device_id: device.id,
              local_ifindex: parseInt(neighbor.localPort) || neighbor.ifIndex || null,
              remote_device_id: remoteDevice?.id || null,
              remote_ip: remoteDevice?.ip || remoteIp || null,
              remote_sysname: neighborName || null,
              remote_chassisid: neighbor.chassisId || null,
              remote_portid: neighbor.portId || null,
              remote_portdesc: neighbor.portDesc || null, // Fixed: use portDesc
              protocol: neighbor.protocol,
            });

            deviceLinks++;
            totalLinks++;
          }

          console.log(`[RESCAN] ${device.ip} (${device.sysname}): ${deviceLinks} link salvati`);

        } catch (err) {
          errors.push({ ip: device.ip, error: err.message });
        }
      }
    });

    await Promise.all(workers);

    // Risolvi neighbor dopo il rescan
    const resolveResult = db.resolveUnknownNeighbors();

    console.log(`[RESCAN] Completato: ${totalLinks} link da ${devicesWithLinks}/${devicesScanned} device`);

    res.json({
      success: true,
      devicesScanned,
      devicesWithLinks,
      totalLinks,
      resolved: resolveResult,
      errors: errors.slice(0, 10),
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[RESCAN] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== NEIGHBOR RESOLUTION ==========

// Risolvi neighbor Unknown (metodo NeDi)
app.post('/api/resolve-neighbors', async (req, res) => {
  try {
    console.log('[RESOLVE] Inizio risoluzione neighbor Unknown...');
    const result = db.resolveUnknownNeighbors();
    console.log(`[RESOLVE] Completato: ${result.resolved}/${result.checked} risolti`);

    res.json({
      success: true,
      checked: result.checked,
      resolved: result.resolved,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raccolta dati estesa per risolvere neighbor (ARP, FDB, ifPhysAddress)
app.post('/api/collect-resolution-data', async (req, res) => {
  try {
    const { cidr } = req.body;
    const devices = cidr ? [] : db.getAllDevices();

    // Se specificato CIDR, usa solo quei device
    if (cidr) {
      const allDevices = db.getAllDevices();
      const hosts = expandCidr(cidr, 1024);
      allDevices.forEach(d => {
        if (hosts.includes(d.ip)) devices.push(d);
      });
    }

    console.log(`[COLLECT] Raccolta dati ARP/FDB/ifPhysAddress da ${devices.length} device...`);

    let arpCount = 0;
    let fdbCount = 0;
    let ifaceCount = 0;

    const concurrency = 5;
    const queue = [...devices];

    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const device = queue.shift();
        try {
          // Raccogli interfaces con ifPhysAddress
          const interfaces = await snmpAgent.getInterfacesExtended(device.ip);
          for (const iface of interfaces) {
            if (iface.ifPhysAddress) {
              db.upsertInterface({
                device_id: device.id,
                ifindex: iface.ifIndex,
                ifname: iface.ifName,
                ifdescr: iface.ifDescr,
                iftype: iface.ifType,
                ifspeed: iface.ifSpeed,
                ifadminstatus: iface.ifAdminStatus,
                ifoperstatus: iface.ifOperStatus,
                ifphysaddress: iface.ifPhysAddress,
                ifalias: iface.ifAlias,
              });
              ifaceCount++;
            }
          }

          // Raccogli ARP
          const arpTable = await snmpAgent.getARPTable(device.ip);
          for (const arp of arpTable) {
            db.upsertARP({
              device_id: device.id,
              ip: arp.ip,
              mac: arp.mac,
            });
            arpCount++;
          }

          // Raccogli FDB
          const fdbTable = await snmpAgent.getFDBTable(device.ip);
          for (const fdb of fdbTable) {
            db.upsertFDB({
              device_id: device.id,
              mac: fdb.mac,
              vlan: fdb.vlan,
            });
            fdbCount++;
          }

          console.log(`[COLLECT] ${device.ip}: ${interfaces.length} iface, ${arpTable.length} ARP, ${fdbTable.length} FDB`);
        } catch (err) {
          console.log(`[COLLECT] ${device.ip}: errore - ${err.message}`);
        }
      }
    });

    await Promise.all(workers);

    // Ora risolvi i neighbor
    const resolveResult = db.resolveUnknownNeighbors();

    res.json({
      success: true,
      collected: {
        interfaces: ifaceCount,
        arp: arpCount,
        fdb: fdbCount,
      },
      resolved: resolveResult,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== LINK DEDUPLICATI ==========

// Links dedeuplicati per mappa
app.get('/api/links-deduplicated', (req, res) => {
  try {
    const links = db.getDeduplicatedLinks();
    res.json({ count: links.length, links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Esegui deduplicazione nel DB (rimuove link duplicati permanentemente)
app.post('/api/admin/dedup-links', (req, res) => {
  try {
    const result = db.deduplicateLinks();
    console.log(`[ADMIN] Deduplicazione DB: ${result.duplicates} duplicati rimossi su ${result.checked} link`);
    res.json({
      message: 'Deduplicazione completata',
      checked: result.checked,
      removed: result.duplicates
    });
  } catch (err) {
    console.error('[ADMIN] Errore deduplicazione:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== NEDI SYNC (DB PRINCIPALE) ==========

// Stato sync NeDi
let nediSyncInterval = null;
let nediDB = null;
let lastNediSync = null;

// Funzione core di sync da NeDi
async function syncFromNeDi(options = {}) {
  const { prefix = '', fullSync = false } = options;
  const startTime = Date.now();

  console.log(`[NEDI-SYNC] Avvio sincronizzazione (prefix: ${prefix || 'tutti'}, fullSync: ${fullSync})...`);

  // Inizializza connessione NeDi se necessario
  if (!nediDB) {
    nediDB = await getNeDiDB();
  }

  const stats = {
    devices: { inserted: 0, updated: 0, total: 0 },
    links: { inserted: 0, skipped: 0, deleted: 0, fixed: 0, total: 0 },
    neighbors: { inserted: 0, skipped: 0, total: 0 },
    duration: 0
  };

  try {
    // 1. Sync devices da NeDi
    const nediDevices = await nediDB.getAllDevices();
    const filteredDevices = prefix
      ? nediDevices.filter(d => d.sysname && d.sysname.startsWith(prefix))
      : nediDevices;

    stats.devices.total = filteredDevices.length;

    for (const dev of filteredDevices) {
      if (!dev.sysname || !dev.ip) continue;

      try {
        // Cerca per sysname o per IP
        const existingBySysname = db.getDevice(dev.sysname);
        const existingByIp = db.db.prepare('SELECT * FROM devices WHERE ip = ?').get(dev.ip);

        if (existingBySysname) {
          // Update per sysname
          db.db.prepare(`
            UPDATE devices SET
              ip = COALESCE(?, ip),
              model = COALESCE(?, model),
              sysdesc = COALESCE(?, sysdesc),
              syslocation = COALESCE(?, syslocation),
              vendor = COALESCE(?, vendor),
              lastseen = strftime('%s', 'now')
            WHERE sysname = ?
          `).run(dev.ip, dev.model, dev.sysdesc, dev.syslocation, dev.vendor, dev.sysname);
          stats.devices.updated++;
        } else if (existingByIp) {
          // Update per IP (stesso IP, sysname diverso - aggiorna sysname)
          db.db.prepare(`
            UPDATE devices SET
              sysname = ?,
              model = COALESCE(?, model),
              sysdesc = COALESCE(?, sysdesc),
              syslocation = COALESCE(?, syslocation),
              vendor = COALESCE(?, vendor),
              lastseen = strftime('%s', 'now')
            WHERE ip = ?
          `).run(dev.sysname, dev.model, dev.sysdesc, dev.syslocation, dev.vendor, dev.ip);
          stats.devices.updated++;
        } else {
          // Insert nuovo device
          db.db.prepare(`
            INSERT INTO devices (sysname, ip, model, sysdesc, syslocation, vendor, status, lastseen, firstseen)
            VALUES (?, ?, ?, ?, ?, ?, 'active', strftime('%s', 'now'), strftime('%s', 'now'))
          `).run(dev.sysname, dev.ip, dev.model, dev.sysdesc, dev.syslocation, dev.vendor);
          stats.devices.inserted++;
        }
      } catch (err) {
        console.warn(`[NEDI-SYNC] Skip device ${dev.sysname}: ${err.message}`);
      }
    }

    // 2. Sync links da NeDi
    const nediLinks = await nediDB.getAllLinks();
    const filteredLinks = prefix
      ? nediLinks.filter(l =>
          (l.local_sysname && l.local_sysname.startsWith(prefix)) ||
          (l.remote_sysname && l.remote_sysname.startsWith(prefix))
        )
      : nediLinks;

    stats.links.total = filteredLinks.length;

    // Se fullSync, elimina link esistenti prima
    if (fullSync && prefix) {
      const deleteResult = db.db.prepare(`
        DELETE FROM links WHERE device_id IN (SELECT id FROM devices WHERE sysname LIKE ?)
      `).run(prefix + '%');
      stats.links.deleted = deleteResult.changes;
    }

    const seenPairs = new Set();

    for (const link of filteredLinks) {
      if (!link.local_sysname || !link.remote_sysname) {
        stats.links.skipped++;
        continue;
      }

      const sourceDevice = db.getDevice(link.local_sysname);
      const targetDevice = db.getDevice(link.remote_sysname);

      if (!sourceDevice) {
        stats.links.skipped++;
        continue;
      }

      // Deduplica A-B / B-A (se target esiste)
      if (targetDevice) {
        const pairKey = [sourceDevice.id, targetDevice.id].sort().join('-');
        if (seenPairs.has(pairKey)) {
          stats.links.skipped++;
          continue;
        }
        seenPairs.add(pairKey);
      }

      // Upsert link
      const existingLink = db.db.prepare(`
        SELECT id FROM links
        WHERE device_id = ? AND (remote_device_id = ? OR remote_sysname = ?)
      `).get(sourceDevice.id, targetDevice?.id || null, link.remote_sysname);

      if (existingLink) {
        db.db.prepare(`
          UPDATE links SET
            local_ifname = COALESCE(?, local_ifname),
            remote_device_id = COALESCE(?, remote_device_id),
            remote_sysname = COALESCE(?, remote_sysname),
            remote_portdesc = COALESCE(?, remote_portdesc),
            protocol = COALESCE(?, protocol),
            lastseen = strftime('%s', 'now')
          WHERE id = ?
        `).run(link.local_ifname, targetDevice?.id, link.remote_sysname, link.remote_portdesc, link.protocol, existingLink.id);
      } else {
        db.db.prepare(`
          INSERT INTO links (device_id, local_ifname, remote_device_id, remote_sysname, remote_portdesc, protocol, lastseen)
          VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
        `).run(sourceDevice.id, link.local_ifname, targetDevice?.id || null, link.remote_sysname, link.remote_portdesc, link.protocol || 'LLDP');
        stats.links.inserted++;
      }
    }

    // ========== FASE 3: Sync neighbors LLDP come devices ==========
    console.log('[NEDI-SYNC] Fase 3: Importazione neighbors LLDP...');

    const neighborDevices = await nediDB.getNeighborDevices();
    stats.neighbors.total = neighborDevices.length;

    // Calcola il prossimo IP fittizio disponibile (evita duplicati)
    const existingFakeCount = db.db.prepare("SELECT COUNT(*) as cnt FROM devices WHERE ip LIKE '192.168.25%'").get();
    let fakeIpCounter = existingFakeCount?.cnt || 0;
    console.log(`[NEDI-SYNC] IP fittizi esistenti: ${fakeIpCounter}, partendo da 192.168.${250 + Math.floor(fakeIpCounter / 255)}.${fakeIpCounter % 255}`);
    for (const neighbor of neighborDevices) {
      try {
        // Salta se già esiste
        const existing = db.db.prepare('SELECT id FROM devices WHERE sysname = ?').get(neighbor.sysname);
        if (existing) {
          stats.neighbors.skipped++;
          continue;
        }

        // Genera IP fittizio univoco per neighbor senza IP
        // Usa range 192.168.250-254.0-254 per supportare fino a 1275 devices (5 subnet * 255)
        let fakeIp = neighbor.ip;
        if (!fakeIp) {
          const subnet = 250 + Math.floor(fakeIpCounter / 255);
          const host = fakeIpCounter % 255;
          fakeIp = `192.168.${subnet}.${host}`;
          fakeIpCounter++;
        }

        // Inserisci come device virtuale
        db.db.prepare(`
          INSERT OR IGNORE INTO devices (sysname, ip, vendor, status, level, lastseen, firstseen)
          VALUES (?, ?, 'LLDP Neighbor', 'discovered', 1, strftime('%s','now'), strftime('%s','now'))
        `).run(neighbor.sysname, fakeIp);

        stats.neighbors.inserted++;
      } catch (err) {
        stats.neighbors.skipped++;
      }
    }

    console.log(`[NEDI-SYNC] Neighbors: ${stats.neighbors.inserted} inseriti, ${stats.neighbors.skipped} skippati`);

    // ========== FASE 4: Risoluzione link orfani ==========
    console.log('[NEDI-SYNC] Fase 4: Risoluzione link orfani...');

    // Trova tutti i link con remote_device_id NULL ma con remote_sysname presente
    const orphanLinks = db.db.prepare(`
      SELECT id, device_id, local_ifname, remote_sysname, remote_portdesc, protocol
      FROM links
      WHERE remote_device_id IS NULL
        AND remote_sysname IS NOT NULL
        AND remote_sysname != ''
    `).all();

    console.log(`[NEDI-SYNC] Trovati ${orphanLinks.length} link orfani da risolvere`);

    for (const link of orphanLinks) {
      try {
        // Cerca device esistente con questo sysname
        let remoteDevice = db.db.prepare('SELECT id FROM devices WHERE sysname = ?').get(link.remote_sysname);

        // Se non esiste, crealo come device virtuale
        if (!remoteDevice) {
          const subnet = 250 + Math.floor(fakeIpCounter / 255);
          const host = fakeIpCounter % 255;
          const fakeIp = `192.168.${subnet}.${host}`;
          fakeIpCounter++;

          db.db.prepare(`
            INSERT OR IGNORE INTO devices (sysname, ip, vendor, status, level, lastseen, firstseen)
            VALUES (?, ?, 'LLDP Neighbor', 'discovered', 1, strftime('%s','now'), strftime('%s','now'))
          `).run(link.remote_sysname, fakeIp);

          remoteDevice = db.db.prepare('SELECT id FROM devices WHERE sysname = ?').get(link.remote_sysname);
          stats.neighbors.inserted++;
        }

        // Aggiorna il link con il remote_device_id corretto
        if (remoteDevice) {
          db.db.prepare(`
            UPDATE links
            SET remote_device_id = ?,
                lastseen = strftime('%s', 'now')
            WHERE id = ?
          `).run(remoteDevice.id, link.id);
          stats.links.fixed++;
        }
      } catch (err) {
        console.warn(`[NEDI-SYNC] Errore risoluzione link orfano ${link.id}: ${err.message}`);
      }
    }

    console.log(`[NEDI-SYNC] Link orfani risolti: ${stats.links.fixed}`);

    // =====================================================
    // FASE 5: Fallback LLDP SNMP per switch con pochi link
    // =====================================================
    console.log('[NEDI-SYNC] FASE 5: Fallback LLDP SNMP...');
    stats.snmpFallback = { checked: 0, neighbors: 0, links: 0 };

    // Trova device con pochi link (< 3 link NeDi)
    const devicesWithFewLinks = db.db.prepare(`
      SELECT d.id, d.sysname, d.ip, COUNT(l.id) as link_count
      FROM devices d
      LEFT JOIN links l ON d.id = l.device_id
      WHERE d.ip IS NOT NULL
        AND d.ip != ''
        AND d.ip NOT LIKE 'SNMP%'
        AND d.ip NOT LIKE '192.168.%'
        AND d.sysname NOT LIKE 'PDV%'
        AND d.sysname NOT LIKE '%AP%'
      GROUP BY d.id
      HAVING link_count < 3
      ORDER BY link_count ASC
      LIMIT 50
    `).all();

    console.log(`[NEDI-SYNC] Device con pochi link da controllare: ${devicesWithFewLinks.length}`);

    // Query SNMP LLDP per ogni device
    for (const dev of devicesWithFewLinks) {
      try {
        stats.snmpFallback.checked++;
        const protocols = await snmpAgent.discoverProtocols(dev.ip, 8000);

        if (protocols.lldp && protocols.lldp.length > 0) {
          console.log(`[NEDI-SYNC] LLDP trovato per ${dev.sysname} (${dev.ip}): ${protocols.lldp.length} neighbor`);

          for (const neighbor of protocols.lldp) {
            if (!neighbor.sysName && !neighbor.ip) continue;

            const remoteName = neighbor.sysName || neighbor.ip || 'Unknown';
            stats.snmpFallback.neighbors++;

            // Verifica se il link esiste già
            const existingLink = db.db.prepare(`
              SELECT id FROM links
              WHERE device_id = ? AND remote_sysname = ?
            `).get(dev.id, remoteName);

            if (!existingLink) {
              // Trova porta locale (ifname) dal numero di porta LLDP
              const localIfname = `Port${neighbor.localPort}`;

              // Inserisci nuovo link
              db.db.prepare(`
                INSERT INTO links (device_id, local_ifname, remote_sysname, lastseen, protocol)
                VALUES (?, ?, ?, strftime('%s','now'), 'SNMP-LLDP')
              `).run(dev.id, localIfname, remoteName);

              stats.snmpFallback.links++;
              console.log(`[NEDI-SYNC] Nuovo link SNMP: ${dev.sysname} [${localIfname}] -> ${remoteName}`);
            }
          }
        }
      } catch (err) {
        // SNMP timeout o errore - ignora e continua
      }
    }

    console.log(`[NEDI-SYNC] FASE 5 completata: ${stats.snmpFallback.checked} device controllati, ${stats.snmpFallback.links} nuovi link SNMP`);

    // =====================================================
    // FASE 6: Sync MAC addresses da NeDi nodes
    // =====================================================
    console.log('[NEDI-SYNC] FASE 6: Sync MAC addresses...');
    stats.macs = { inserted: 0, updated: 0, skipped: 0, total: 0 };

    try {
      const nediMacs = await nediDB.getMacAddresses(50000);
      stats.macs.total = nediMacs.length;
      console.log(`[NEDI-SYNC] Trovati ${nediMacs.length} MAC in NeDi`);

      // Prepara statements per performance
      const findMac = db.db.prepare('SELECT id FROM nodes WHERE mac = ?');
      const insertMac = db.db.prepare(`
        INSERT INTO nodes (mac, device_id, interface_id, ifname, vlan, source, lastseen)
        VALUES (?, ?, ?, ?, ?, 'NEDI', strftime('%s', 'now'))
      `);
      const updateMac = db.db.prepare(`
        UPDATE nodes SET device_id = ?, interface_id = ?, ifname = COALESCE(?, ifname), vlan = ?, lastseen = strftime('%s', 'now')
        WHERE id = ?
      `);

      // Cache device_id e interface_id
      const deviceCache = new Map();
      const ifCache = new Map();

      for (const m of nediMacs) {
        try {
          // Normalizza MAC (rimuovi separatori)
          const cleanMac = (m.mac || '').replace(/[:\-.]/g, '').toLowerCase();
          if (cleanMac.length !== 12) {
            stats.macs.skipped++;
            continue;
          }

          // Formatta MAC con :
          const formattedMac = cleanMac.match(/.{2}/g).join(':');

          // Trova device_id (con cache)
          let deviceId = deviceCache.get(m.device);
          if (deviceId === undefined) {
            const dev = db.db.prepare('SELECT id FROM devices WHERE sysname = ?').get(m.device);
            deviceId = dev?.id || null;
            deviceCache.set(m.device, deviceId);
          }

          // Trova interface_id (con cache)
          let ifId = null;
          if (deviceId && m.ifname) {
            const cacheKey = `${deviceId}:${m.ifname}`;
            ifId = ifCache.get(cacheKey);
            if (ifId === undefined) {
              const iface = db.db.prepare('SELECT id FROM interfaces WHERE device_id = ? AND ifname = ?').get(deviceId, m.ifname);
              ifId = iface?.id || null;
              ifCache.set(cacheKey, ifId);
            }
          }

          // Upsert
          const existing = findMac.get(formattedMac);
          if (existing) {
            updateMac.run(deviceId, ifId, m.ifname || null, m.vlan || null, existing.id);
            stats.macs.updated++;
          } else {
            insertMac.run(formattedMac, deviceId, ifId, m.ifname || null, m.vlan || null);
            stats.macs.inserted++;
          }
        } catch (macErr) {
          stats.macs.skipped++;
        }
      }

      console.log(`[NEDI-SYNC] FASE 6 completata: ${stats.macs.inserted} MAC inseriti, ${stats.macs.updated} aggiornati, ${stats.macs.skipped} skippati`);
    } catch (macSyncErr) {
      console.error(`[NEDI-SYNC] Errore FASE 6:`, macSyncErr.message);
    }

    stats.duration = Date.now() - startTime;
    lastNediSync = new Date().toISOString();

    console.log(`[NEDI-SYNC] Completato in ${stats.duration}ms: ${stats.devices.inserted} dev inseriti, ${stats.devices.updated} aggiornati, ${stats.links.inserted} link inseriti, ${stats.links.fixed} link risolti, ${stats.neighbors.inserted} neighbors, ${stats.macs?.inserted || 0} MAC importati`);

    return { success: true, stats, lastSync: lastNediSync };

  } catch (err) {
    console.error('[NEDI-SYNC] Errore:', err);
    return { success: false, error: err.message, stats };
  }
}

// Avvia sync automatico
function startNeDiAutoSync(intervalMinutes = 5) {
  if (nediSyncInterval) {
    clearInterval(nediSyncInterval);
  }

  console.log(`[NEDI-SYNC] Auto-sync attivato ogni ${intervalMinutes} minuti`);

  // Sync immediato
  syncFromNeDi().catch(err => console.error('[NEDI-SYNC] Errore sync iniziale:', err));

  // Scheduler
  nediSyncInterval = setInterval(() => {
    syncFromNeDi().catch(err => console.error('[NEDI-SYNC] Errore sync schedulato:', err));
  }, intervalMinutes * 60 * 1000);

  return { active: true, intervalMinutes };
}

// Ferma sync automatico
function stopNeDiAutoSync() {
  if (nediSyncInterval) {
    clearInterval(nediSyncInterval);
    nediSyncInterval = null;
    console.log('[NEDI-SYNC] Auto-sync disattivato');
    return { active: false };
  }
  return { active: false, message: 'Non era attivo' };
}

// Endpoint: Sync manuale da NeDi
app.post('/api/admin/sync-nedi', async (req, res) => {
  const { prefix = '', fullSync = false } = req.body || {};

  try {
    const result = await syncFromNeDi({ prefix, fullSync });

    if (result.success) {
      res.json({
        message: 'Sincronizzazione NeDi completata',
        ...result
      });
    } else {
      res.status(500).json({ error: result.error, stats: result.stats });
    }
  } catch (err) {
    console.error('[NEDI-SYNC] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Attiva/disattiva auto-sync
app.post('/api/admin/nedi-autosync', (req, res) => {
  const { enabled = true, intervalMinutes = 5 } = req.body || {};

  if (enabled) {
    const result = startNeDiAutoSync(intervalMinutes);
    res.json({ message: 'Auto-sync NeDi attivato', ...result });
  } else {
    const result = stopNeDiAutoSync();
    res.json({ message: 'Auto-sync NeDi disattivato', ...result });
  }
});

// Endpoint: Stato sync NeDi
app.get('/api/admin/nedi-status', async (req, res) => {
  try {
    // Usa getNedi() per verificare connessione (stesso singleton di /api/nedi/*)
    let nediStats = null;
    let isConnected = false;

    try {
      const nedi = await getNedi();
      if (nedi) {
        nediStats = await nedi.getStats();
        isConnected = true;
      }
    } catch (connErr) {
      console.error('[NeDi Status] Errore connessione:', connErr.message);
    }

    res.json({
      connected: isConnected,
      autoSyncActive: !!nediSyncInterval,
      lastSync: lastNediSync,
      nediStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/sync-mac-nedi
 * Sincronizza MAC addresses da NeDi MySQL alla tabella fdb locale
 * Body: { limit?: number, daysBack?: number }
 */
app.post('/api/admin/sync-mac-nedi', async (req, res) => {
  const { limit = 1000, daysBack = 7 } = req.body || {};

  try {
    console.log(`[MAC-SYNC] Inizio sincronizzazione MAC da NeDi (limit=${limit}, daysBack=${daysBack})`);

    const nedi = await getNedi();
    if (!nedi) {
      return res.status(503).json({ error: 'NeDi non disponibile' });
    }

    // Recupera MAC addresses da NeDi
    const macList = await nedi.getMacAddresses(limit, daysBack);
    console.log(`[MAC-SYNC] Recuperati ${macList.length} MAC da NeDi`);

    const stats = {
      total: macList.length,
      inserted: 0,
      skipped: 0,
      errors: 0,
      errorDetails: []
    };

    // Helper per normalizzare MAC address
    function normalizeMac(mac) {
      if (!mac) return null;
      const clean = mac.replace(/[:.|-]/g, '').toLowerCase();
      if (clean.length !== 12) return null;
      return clean.match(/.{2}/g).join(':');
    }

    // Processa ogni MAC
    for (const macEntry of macList) {
      try {
        // Normalizza MAC address
        const normalizedMac = normalizeMac(macEntry.mac);
        if (!normalizedMac) {
          stats.skipped++;
          continue;
        }

        // Trova device_id dal nome device
        const device = db.getDevice(macEntry.device);
        if (!device) {
          stats.skipped++;
          continue;
        }

        // Trova interface_id dal device_id + ifname
        const interfaces = db.getDeviceInterfaces(device.id);
        const iface = interfaces.find(i => i.ifname === macEntry.ifname);

        // Upsert nella tabella fdb
        db.upsertFDB({
          device_id: device.id,
          interface_id: iface ? iface.id : null,
          mac: normalizedMac,
          vlan: macEntry.vlan || 0
        });

        stats.inserted++;
      } catch (err) {
        stats.errors++;
        stats.errorDetails.push({
          mac: macEntry.mac,
          device: macEntry.device,
          error: err.message
        });
      }
    }

    console.log(`[MAC-SYNC] Completato: ${stats.inserted} inseriti, ${stats.skipped} saltati, ${stats.errors} errori`);

    res.json({
      message: 'Sincronizzazione MAC completata',
      stats,
      // Limita errorDetails se troppi
      errorDetails: stats.errorDetails.slice(0, 10)
    });
  } catch (err) {
    console.error('[MAC-SYNC] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== LLDP SSH DISCOVERY ==========

// Credenziali SSH di default (possono essere sovrascritte via environment)
const defaultSshCredentials = {
  username: process.env.SWITCH_SSH_USER || 'admin',
  password: process.env.SWITCH_SSH_PASS || ''
};

// Endpoint: Discovery LLDP via SSH su device specifico o batch
app.post('/api/admin/discover-lldp-ssh', async (req, res) => {
  const { deviceName, batchMode = false, vendor = 'Huawei', limit = 10, credentials } = req.body || {};

  try {
    // Inizializza discovery con credenziali (da body o default)
    const discovery = new LldpSshDiscovery(db, {
      credentials: credentials || defaultSshCredentials
    });

    if (batchMode) {
      // Modalità batch: discovery su N device senza link
      console.log(`[LLDP-SSH] Batch discovery: vendor=${vendor}, limit=${limit}`);

      const zeroLinkDevices = db.getDevicesWithoutLinks({ vendor, limit });

      if (zeroLinkDevices.length === 0) {
        return res.json({
          message: 'Nessun device senza link trovato',
          batchMode: true,
          vendor,
          devicesProcessed: 0,
          results: []
        });
      }

      console.log(`[LLDP-SSH] Trovati ${zeroLinkDevices.length} device senza link`);

      const results = [];
      for (const device of zeroLinkDevices) {
        console.log(`[LLDP-SSH] Processing ${device.sysname} (${device.ip})...`);
        const result = await discovery.discoverDevice(device.sysname);
        results.push(result);
      }

      // Statistiche aggregate
      const stats = {
        batchMode: true,
        vendor,
        devicesProcessed: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        totalNeighbors: results.reduce((sum, r) => sum + r.neighborsFound, 0),
        totalLinks: results.reduce((sum, r) => sum + r.linksCreated, 0),
        totalVirtualDevices: results.reduce((sum, r) => sum + r.virtualDevicesCreated, 0)
      };

      res.json({
        message: 'Batch discovery completato',
        ...stats,
        results
      });

    } else {
      // Modalità singolo device
      if (!deviceName) {
        return res.status(400).json({ error: 'deviceName richiesto per discovery singolo' });
      }

      console.log(`[LLDP-SSH] Discovery singolo su device: ${deviceName}`);
      const result = await discovery.discoverDevice(deviceName);

      if (result.success) {
        res.json({
          message: 'Discovery completato',
          ...result
        });
      } else {
        res.status(500).json({
          message: 'Discovery fallito',
          ...result
        });
      }
    }

  } catch (err) {
    console.error('[LLDP-SSH] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== SITES & MULTI-TENANT API ==========

// GET /api/admin/sites - Lista tutti i siti con statistiche
app.get('/api/admin/sites', (req, res) => {
  try {
    const sites = db.getAllSitesWithStats();
    res.json(sites);
  } catch (err) {
    console.error('[SITES] Errore lista siti:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sites - Crea nuovo sito
app.post('/api/admin/sites', (req, res) => {
  try {
    const { name, description, rules } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome sito obbligatorio' });
    }

    // Verifica nome unico
    const existing = db.getSiteByName(name);
    if (existing) {
      return res.status(409).json({ error: `Sito '${name}' esiste già` });
    }

    const result = db.createSite({ name, description });
    const siteId = result.lastInsertRowid;

    // Crea rules se fornite
    if (rules && Array.isArray(rules)) {
      for (const rule of rules) {
        if (rule.type && rule.value) {
          db.createSiteRule(siteId, {
            rule_type: rule.type,
            rule_value: rule.value,
            priority: rule.priority || 0
          });
        }
      }
    }

    const site = db.getSiteById(siteId);
    res.status(201).json(site);
  } catch (err) {
    console.error('[SITES] Errore creazione sito:', err);
    res.status(500).json({ error: err.message });
  }
});

// NOTA: Routes statiche DEVONO essere prima di quelle con :id

// GET /api/admin/sites/preview - Preview assegnazioni device-site
app.get('/api/admin/sites/preview', (req, res) => {
  try {
    const preview = db.previewSiteAssignments();

    // Statistiche
    const stats = {
      total: preview.length,
      assigned: preview.filter(p => p.matched_site_id !== null).length,
      unassigned: preview.filter(p => p.matched_site_id === null).length,
      changed: preview.filter(p => p.current_site_id !== p.matched_site_id).length
    };

    res.json({ stats, preview });
  } catch (err) {
    console.error('[SITES] Errore preview assegnazioni:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sites/reassign - Ricalcola tutte le assegnazioni device-site
app.post('/api/admin/sites/reassign', (req, res) => {
  try {
    const stats = db.reassignAllDevices();

    // Aggiungi nomi siti alle statistiche
    const sites = db.getAllSites();
    const siteMap = new Map(sites.map(s => [s.id, s.name]));
    const bysiteName = {};
    for (const [siteId, count] of Object.entries(stats.bysite)) {
      const name = siteMap.get(parseInt(siteId, 10)) || `Site ${siteId}`;
      bysiteName[name] = count;
    }

    res.json({
      success: true,
      stats: {
        ...stats,
        bysite_names: bysiteName
      }
    });
  } catch (err) {
    console.error('[SITES] Errore reassign devices:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sites/unassigned - Lista device non assegnati
app.get('/api/admin/sites/unassigned', (req, res) => {
  try {
    const devices = db.getUnassignedDevices();
    res.json({
      count: devices.length,
      devices
    });
  } catch (err) {
    console.error('[SITES] Errore lista unassigned:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/test-devices - Add test devices for development/testing
app.post('/api/admin/test-devices', (req, res) => {
  try {
    const testDevices = [
      { ip: '192.168.21.1', sysname: 'SW-SITE-A-01', vendor: 'Huawei', syslocation: 'Site-A', status: 'up' },
      { ip: '192.168.21.2', sysname: 'SW-SITE-A-02', vendor: 'Huawei', syslocation: 'Site-A', status: 'up' },
      { ip: '192.168.21.3', sysname: 'SW-SITE-A-03', vendor: 'Huawei', syslocation: 'Site-A', status: 'down' },
      { ip: '10.22.5.1', sysname: 'SW-SITE-B-01', vendor: 'Huawei', syslocation: 'Site-B', status: 'up' },
      { ip: '10.22.5.2', sysname: 'SW-SITE-B-02', vendor: 'Cisco', syslocation: 'Site-B', status: 'up' },
      { ip: '10.22.5.3', sysname: 'SW-SITE-B-03', vendor: 'Huawei', syslocation: 'Site-B', status: 'down' },
      { ip: '10.23.6.1', sysname: 'SW-SITE-C-01', vendor: 'Huawei', syslocation: 'Site-C', status: 'up' },
      { ip: '10.23.6.2', sysname: 'SW-SITE-C-02', vendor: 'Aruba', syslocation: 'Site-C', status: 'up' },
    ];

    const results = [];
    for (const device of testDevices) {
      const result = db.upsertDevice(device);
      results.push({ ip: device.ip, sysname: device.sysname, id: result.lastInsertRowid || result.id });
    }

    res.json({
      message: 'Test devices created',
      count: results.length,
      devices: results
    });
  } catch (err) {
    console.error('[TEST] Error creating test devices:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sites/:id - Dettaglio sito
app.get('/api/admin/sites/:id', (req, res) => {
  try {
    const site = db.getSiteById(parseInt(req.params.id, 10));
    if (!site) {
      return res.status(404).json({ error: 'Sito non trovato' });
    }

    // Aggiungi regole e statistiche
    site.rules = db.getSiteRules(site.id);
    site.users = db.getSiteUsers(site.id);
    site.device_count = db.getDevicesBySite(site.id).length;

    res.json(site);
  } catch (err) {
    console.error('[SITES] Errore dettaglio sito:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sites/:id - Modifica sito
app.put('/api/admin/sites/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, rules } = req.body;

    const site = db.getSiteById(id);
    if (!site) {
      return res.status(404).json({ error: 'Sito non trovato' });
    }

    // Se cambia nome, verifica unicità
    if (name && name !== site.name) {
      const existing = db.getSiteByName(name);
      if (existing) {
        return res.status(409).json({ error: `Sito '${name}' esiste già` });
      }
    }

    db.updateSite(id, { name, description });
    res.json(db.getSiteById(id));
  } catch (err) {
    console.error('[SITES] Errore modifica sito:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/sites/:id - Elimina sito
app.delete('/api/admin/sites/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const site = db.getSiteById(id);
    if (!site) {
      return res.status(404).json({ error: 'Sito non trovato' });
    }

    db.deleteSite(id);
    res.json({ success: true, message: `Sito '${site.name}' eliminato` });
  } catch (err) {
    console.error('[SITES] Errore eliminazione sito:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sites/:id/rules - Lista regole di un sito
app.get('/api/admin/sites/:id/rules', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const site = db.getSiteById(id);
    if (!site) {
      return res.status(404).json({ error: 'Sito non trovato' });
    }

    const rules = db.getSiteRules(id);
    res.json(rules);
  } catch (err) {
    console.error('[SITES] Errore lista regole:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sites/:id/rules - Aggiungi regola a un sito
app.post('/api/admin/sites/:id/rules', (req, res) => {
  try {
    const siteId = parseInt(req.params.id, 10);
    const { rule_type, rule_value, priority } = req.body;

    const site = db.getSiteById(siteId);
    if (!site) {
      return res.status(404).json({ error: 'Sito non trovato' });
    }

    // Validazione rule_type
    const validTypes = ['cidr', 'ip_range', 'pattern', 'sysname_pattern'];
    if (!validTypes.includes(rule_type)) {
      return res.status(400).json({
        error: `Tipo regola non valido. Valori ammessi: ${validTypes.join(', ')}`
      });
    }

    if (!rule_value) {
      return res.status(400).json({ error: 'Valore regola obbligatorio' });
    }

    const result = db.createSiteRule(siteId, { rule_type, rule_value, priority: priority || 0 });
    res.status(201).json({
      id: result.lastInsertRowid,
      site_id: siteId,
      rule_type,
      rule_value,
      priority: priority || 0
    });
  } catch (err) {
    console.error('[SITES] Errore creazione regola:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/sites/rules/:id - Elimina regola
app.delete('/api/admin/sites/rules/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = db.deleteSiteRule(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Regola non trovata' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[SITES] Errore eliminazione regola:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id/sites - Assegna siti a un utente
app.put('/api/admin/users/:id/sites', (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { site_ids } = req.body;

    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    // Valida che i siti esistano
    if (site_ids && site_ids.length > 0) {
      for (const siteId of site_ids) {
        if (!db.getSiteById(siteId)) {
          return res.status(400).json({ error: `Sito ${siteId} non trovato` });
        }
      }
    }

    db.setUserSites(userId, site_ids || []);
    const userSites = db.getUserSites(userId);

    res.json({
      user_id: userId,
      sites: userSites
    });
  } catch (err) {
    console.error('[SITES] Errore assegnazione siti utente:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:id/sites - Lista siti assegnati a un utente
app.get('/api/admin/users/:id/sites', (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);

    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    const sites = db.getUserSites(userId);
    res.json(sites);
  } catch (err) {
    console.error('[SITES] Errore lista siti utente:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== END SITES API ==========

// Endpoint: Lista device senza link (candidati per discovery)
app.get('/api/admin/zero-link-devices', (req, res) => {
  try {
    const { vendor = 'Huawei', limit = 50 } = req.query;

    const devices = db.getDevicesWithoutLinks({
      vendor,
      limit: parseInt(limit, 10)
    });

    res.json({
      count: devices.length,
      vendor,
      limit: parseInt(limit, 10),
      devices
    });

  } catch (err) {
    console.error('[ZERO-LINK] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Test connessione SSH a uno switch
app.post('/api/admin/test-switch-ssh', async (req, res) => {
  const { deviceName, ip, username, password } = req.body;

  try {
    const credentials = {
      username: username || defaultSshCredentials.username,
      password: password || defaultSshCredentials.password
    };

    const discovery = new LldpSshDiscovery(db, { credentials });

    let targetIp = ip;
    let targetName = deviceName;

    // Se fornito deviceName, cerca IP nel DB
    if (deviceName && !ip) {
      const device = db.getDevice(deviceName);
      if (!device) {
        return res.status(404).json({ error: `Device '${deviceName}' non trovato` });
      }
      if (!device.ip) {
        return res.status(400).json({ error: `Device '${deviceName}' non ha IP configurato` });
      }
      targetIp = device.ip;
      targetName = device.sysname;
    }

    if (!targetIp) {
      return res.status(400).json({ error: 'IP o deviceName richiesto' });
    }

    console.log(`[SSH-TEST] Test connessione a ${targetName || targetIp} (${targetIp})`);

    // Test connessione SSH e ottieni info switch
    const switchInfo = await discovery.ssh.getSwitchInfo({
      host: targetIp,
      ...credentials
    });

    if (switchInfo.success) {
      // Estrai hostname dal sysname output
      const sysnameMatch = switchInfo.sysname?.match(/sysname\s+(\S+)/);
      const hostname = sysnameMatch ? sysnameMatch[1] : null;

      res.json({
        success: true,
        message: 'Connessione SSH riuscita',
        device: targetName,
        ip: targetIp,
        hostname: hostname,
        version: switchInfo.version?.split('\n')[0] || null,
        deviceInfo: switchInfo.device?.split('\n')[0] || null
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Connessione SSH fallita',
        device: targetName,
        ip: targetIp,
        error: 'Impossibile ottenere informazioni dallo switch'
      });
    }

  } catch (err) {
    console.error('[SSH-TEST] Errore:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ========== VENDOR PARSERS API ==========

/**
 * GET /api/vendors
 * Lista tutti i vendor supportati per LLDP discovery
 */
app.get('/api/vendors', (req, res) => {
  try {
    const vendors = getSupportedVendors();
    res.json({
      success: true,
      vendors: vendors,
      summary: {
        total: vendors.length,
        implemented: vendors.filter(v => v.implemented).length,
        stub: vendors.filter(v => !v.implemented).length
      }
    });
  } catch (err) {
    console.error('[VENDORS] Errore:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/vendors/:vendorId
 * Dettagli singolo vendor (comandi SSH, capabilities)
 */
app.get('/api/vendors/:vendorId', (req, res) => {
  try {
    const Parser = getParserByVendor(req.params.vendorId);
    if (!Parser) {
      return res.status(404).json({
        success: false,
        error: `Vendor '${req.params.vendorId}' non trovato`
      });
    }

    const parser = new Parser();
    res.json({
      success: true,
      vendor: {
        id: Parser.vendorId,
        names: Parser.vendorNames,
        enterpriseIds: Parser.enterpriseIds,
        implemented: Parser.isImplemented,
        commands: {
          lldp: parser.getLldpCommand(),
          lldpDetail: parser.getLldpDetailCommand ? parser.getLldpDetailCommand() : null,
          cdp: parser.getCdpCommand(),
          disablePaging: parser.getDisablePagingCommand()
        }
      }
    });
  } catch (err) {
    console.error('[VENDORS] Errore:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== OUI VENDOR LOOKUP ==========

app.get("/api/oui/:oui", async (req, res) => {
  try {
    const result = await lookupOui(req.params.oui);
    res.json(result);
  } catch (err) {
    console.error("[OUI-LOOKUP] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========== MAC ADDRESS SEARCH REAL-TIME (SNMP) ==========

/**
 * Ricerca MAC address in tempo reale via SNMP
 * Scansiona FDB/Q-Bridge degli switch per trovare su quale porta è il MAC
 */
app.get('/api/search/mac/realtime/:mac', async (req, res) => {
  const startTime = Date.now();
  const { mac } = req.params;
  const { site, cidr, limit = 50 } = req.query;

  // Normalizza MAC per confronto
  const cleanMAC = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (cleanMAC.length < 6) {
    return res.status(400).json({ error: 'MAC address deve avere almeno 6 caratteri hex' });
  }

  // Estrai prefisso IP da CIDR (es. 192.168.1.0/24 -> 192.168.1.)
  let ipPrefix = null;
  if (cidr) {
    const cidrMatch = cidr.match(/^(\d+\.\d+\.\d+)\.\d+\/\d+$/);
    if (cidrMatch) {
      ipPrefix = cidrMatch[1] + '.';
    }
  }

  console.log(`[MAC-REALTIME] Ricerca SNMP real-time per MAC: ${mac} (normalized: ${cleanMAC})${cidr ? ` su ${cidr}` : ''}`);

  try {
    // Prendi lista switch da scansionare
    let deviceQuery = `
      SELECT DISTINCT d.ip, d.sysname, d.syslocation, d.vendor
      FROM devices d
      WHERE d.ip IS NOT NULL
        AND d.ip != ''
        AND (d.sysdesc LIKE '%switch%' OR d.sysdesc LIKE '%S5700%' OR d.sysdesc LIKE '%S5720%' OR d.sysdesc LIKE '%S6720%' OR d.sysdesc LIKE '%Huawei%')
    `;

    const params = [];

    if (ipPrefix) {
      deviceQuery += ` AND d.ip LIKE ?`;
      params.push(ipPrefix + '%');
    }

    if (site) {
      deviceQuery += ` AND d.syslocation LIKE ?`;
      params.push(`%${site}%`);
    }

    deviceQuery += ` LIMIT ?`;
    params.push(parseInt(limit));
    const devices = db.db.prepare(deviceQuery).all(...params);

    console.log(`[MAC-REALTIME] Scansione ${devices.length} switch...`);

    const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public', { timeout: 5000, retries: 1 });
    const results = [];
    const errors = [];

    // OID per MAC tables (Huawei priority)
    const HW_L2MAC_PORT_OID = '1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4'; // Huawei hwL2MacPort (BEST)
    const QBRIDGE_OID = '1.3.6.1.2.1.17.7.1.2.2.1'; // Q-Bridge fallback

    // MAC in formato decimale per ricerca in OID Huawei
    const macDecimal = cleanMAC.match(/.{2}/g)?.map(h => parseInt(h, 16)).join('.') || '';

    console.log(`[MAC-REALTIME] MAC decimale per OID search: ${macDecimal}`);

    // Scansiona in parallelo (batch di 10)
    const batchSize = 10;
    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize);

      const batchPromises = batch.map(async (device) => {
        try {
          // === METODO 1: Huawei hwL2MacPort (più affidabile per Huawei) ===
          // Formato OID: base.MAC[6].VLAN.macType.48 -> valore = bridgePort
          let hwWalkResult = await snmp.walk(device.ip, HW_L2MAC_PORT_OID, 30, 8000);

          if (!hwWalkResult.err && hwWalkResult.rows?.length > 0) {
            const uniquePorts = new Map(); // Deduplica per porta

            for (const row of hwWalkResult.rows) {
              const parts = row.oid.split('.');
              const baseLen = HW_L2MAC_PORT_OID.split('.').length;

              // Estrai MAC (6 ottetti dopo base) ed effettua match esatto
              const macParts = parts.slice(baseLen, baseLen + 6);
              const macFromOid = macParts.map(p => parseInt(p).toString(16).padStart(2, '0')).join('');
              if (macFromOid !== cleanMAC) continue;

              const formattedMAC = macParts.map(p => parseInt(p).toString(16).padStart(2, '0')).join(':');

              // Estrai VLAN (posizione baseLen + 6)
              const vlan = parseInt(parts[baseLen + 6]) || null;

              // Bridge port è il valore
              const bridgePort = row.value;

              // Deduplica: un MAC può apparire su più VLAN, teniamo quella > 1
              const key = `${device.ip}-${bridgePort}`;
              if (!uniquePorts.has(key) || (vlan && vlan > 1)) {
                uniquePorts.set(key, {
                  mac: formattedMAC,
                  device: device.sysname,
                  deviceIp: device.ip,
                  location: device.syslocation,
                  vendor: device.vendor,
                  port: bridgePort,
                  vlan: vlan,
                  source: 'hwL2MacPort',
                  timestamp: new Date().toISOString()
                });
              }
            }

            uniquePorts.forEach(v => results.push(v));

            if (uniquePorts.size > 0) {
              console.log(`[MAC-REALTIME]   ${device.sysname}: MAC trovato via hwL2MacPort (${uniquePorts.size} locations)`);
              return; // Trovato con Huawei, no fallback
            }
          }

          // === METODO 2: Q-Bridge fallback ===
          let walkResult = await snmp.walk(device.ip, QBRIDGE_OID, 20, 5000);

          if (walkResult.err) {
            errors.push({ device: device.sysname, ip: device.ip, error: walkResult.err });
            return;
          }

          for (const vb of walkResult.rows) {
            if (!vb?.oid) continue;
            const parts = vb.oid.split('.');
            const len = parts.length;

            if (len >= 8) {
              const qBridgeBaseLen = QBRIDGE_OID.split(".").length;
              const macBytes = parts.slice(qBridgeBaseLen, qBridgeBaseLen + 6).map(p => parseInt(p).toString(16).padStart(2, '0'));
              const foundMAC = macBytes.join('');

              if (foundMAC === cleanMAC || foundMAC.includes(cleanMAC)) {
                results.push({
                  mac: macBytes.join(':'),
                  device: device.sysname,
                  deviceIp: device.ip,
                  location: device.syslocation,
                  vendor: device.vendor,
                  port: vb.value,
                  vlan: parts[len - 7] || null,
                  source: 'Q-Bridge',
                  timestamp: new Date().toISOString()
                });
              }
            }
          }
        } catch (err) {
          errors.push({ device: device.sysname, ip: device.ip, error: err.message });
        }
      });

      await Promise.all(batchPromises);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[MAC-REALTIME] Completato in ${elapsed}ms - Trovati: ${results.length}, Errori: ${errors.length}`);

    // === IP FABRIC-STYLE ENDPOINT DETECTION ===
    // Logica: porta con MENO MAC = endpoint reale (non uplink)
    // Gli uplink hanno centinaia di MAC perché aggregano traffico da molti dispositivi
    let endpoint = null;
    const processedResults = [];
    const hwL2MacPortOid = '1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4';
    const LLDP_REM_SYS_NAME = '1.0.8802.1.1.2.1.4.1.1.9';

    console.log(`[MAC-REALTIME] IP Fabric: analisi ${results.length} switch per MAC count per porta...`);

    // Per ogni switch dove appare il MAC, conta i MAC sulla stessa porta
    const macCountPromises = results.map(async (r) => {
      try {
        const bridgePort = r.port;
        let macCount = 0;
        let lldpNeighbor = null;

        // 1. Conta TUTTI i MAC sulla stessa porta via Huawei hwL2MacPort
        const hwWalkResult = await snmp.walk(r.deviceIp, hwL2MacPortOid, 50, 8000);
        if (!hwWalkResult.err && hwWalkResult.rows?.length > 0) {
          for (const row of hwWalkResult.rows) {
            if (row.value === bridgePort) {
              macCount++;
            }
          }
        }

        // 2. Traduce port -> ifIndex -> ifName
        // IMPORTANTE: hwL2MacPort restituisce ifIndex DIRETTAMENTE, non bridge port!
        // Q-Bridge restituisce bridge port che va tradotto via dot1dBasePortIfIndex
        let ifIndex = null;
        let ifName = null;
        try {
          if (r.source === 'hwL2MacPort') {
            // hwL2MacPort: il valore È già l'ifIndex!
            ifIndex = bridgePort;
          } else {
            // Q-Bridge: traduce bridge port -> ifIndex
            const dot1dOid = `1.3.6.1.2.1.17.1.4.1.2.${bridgePort}`;
            const ifIndexResult = await snmp.get(r.deviceIp, [dot1dOid]);
            if (!ifIndexResult.err && ifIndexResult.values?.[0]?.value) {
              ifIndex = ifIndexResult.values[0].value;
            }
          }

          // Ottieni ifName da ifIndex
          if (ifIndex) {
            const ifNameOid = `1.3.6.1.2.1.31.1.1.1.1.${ifIndex}`;
            const ifNameResult = await snmp.get(r.deviceIp, [ifNameOid]);
            if (!ifNameResult.err && ifNameResult.values?.[0]?.value) {
              const val = ifNameResult.values[0].value;
              ifName = Buffer.isBuffer(val) ? val.toString() : String(val);
            }
          }
        } catch (e) { console.warn('[MAC-REALTIME] Port translation warning:', e.message); }

        // 3. Verifica LLDP neighbor REAL-TIME sulla porta (non da DB)
        try {
          const lldpWalkResult = await snmp.walk(r.deviceIp, LLDP_REM_SYS_NAME, 10, 5000);
          if (!lldpWalkResult.err && lldpWalkResult.rows?.length > 0) {
            for (const row of lldpWalkResult.rows) {
              const parts = row.oid.split('.');
              const localPort = parseInt(parts[parts.length - 2]);
              // LLDP usa ifIndex o numero porta
              if (localPort === ifIndex || localPort === bridgePort) {
                const val = row.value;
                lldpNeighbor = Buffer.isBuffer(val) ? val.toString() : String(val);
                break;
              }
            }
          }
        } catch (e) { console.warn('[MAC-REALTIME] LLDP neighbor check warning:', e.message); }

        // Determina se è uplink basato su LLDP neighbor (switch = L2_/L3_ nel nome)
        const isUplink = lldpNeighbor && (
          lldpNeighbor.includes('L2_') || lldpNeighbor.includes('L3_') ||
          lldpNeighbor.includes('_L2') || lldpNeighbor.includes('_L3')
        );

        r.macCount = macCount;
        r.ifIndex = ifIndex;
        r.ifName = ifName || `bridgePort${bridgePort}`;
        r.lldpNeighbor = lldpNeighbor;
        r.hasLldpNeighbor = !!lldpNeighbor;
        r.isUplink = isUplink;
        r.portType = isUplink ? 'uplink' : (lldpNeighbor ? 'access-with-lldp' : 'access');
        r.isLikelyEndpoint = macCount <= 10 && !isUplink;

        processedResults.push(r);

        console.log(`[MAC-REALTIME]   ${r.device} (${r.deviceIp}) porta ${r.ifName}: ${macCount} MAC, LLDP: ${lldpNeighbor || '-'}`);

      } catch (err) {
        r.macCount = 9999;
        r.error = err.message;
        processedResults.push(r);
      }
    });

    await Promise.all(macCountPromises);

    // === SELEZIONE ENDPOINT: PORTA CON MENO MAC ===
    // IP Fabric logic: ordina per MAC count (ascendente), endpoint = prima porta
    // FIX: macCount <= 0 indica errore SNMP, va messo IN FONDO non in cima!
    processedResults.sort((a, b) => {
      // Prima i risultati validi (macCount > 0), poi quelli con errore
      if (a.macCount > 0 && b.macCount <= 0) return -1;
      if (a.macCount <= 0 && b.macCount > 0) return 1;
      // Se entrambi validi o entrambi error, ordina per macCount ascendente
      return a.macCount - b.macCount;
    });

    // Helper per escludere L3/Core switch (definito prima per tutti i filtri)
    const isL3Switch = (device) => device.includes('L3_') || device.includes('_L3_') ||
                                    device.includes('Core') || device.includes('6730');

    // === PRIORITÀ 0: IP Fabric Logic - Pochissimi MAC = endpoint ===
    // Se una porta ha 1-5 MAC, è quasi certamente l'endpoint
    // IGNORA isUplink perché potrebbe essere collegato a switch L2 ma comunque endpoint
    const veryFewMacs = processedResults.filter(r =>
      r.macCount > 0 && r.macCount <= 5 && !isL3Switch(r.device)
    );
    if (veryFewMacs.length > 0) {
      endpoint = veryFewMacs[0];
      console.log(`[MAC-REALTIME] Endpoint (IP Fabric: ${endpoint.macCount} MAC): ${endpoint.device} ${endpoint.ifName}`);
    }
    // Priorità 1: Porta con meno MAC e NO LLDP neighbor (endpoint certo)
    // IMPORTANTE:
    // - macCount > 0 per escludere errori SNMP dove il conteggio fallisce
    // - Esclude switch L3/Core (aggregazione) che hanno pochi MAC ma non sono endpoint
    else if (!endpoint) {
      const noLldpPorts = processedResults.filter(r =>
        !r.hasLldpNeighbor &&
        r.macCount > 0 &&
        r.macCount < 50 &&
        !isL3Switch(r.device)
      );
      if (noLldpPorts.length > 0) {
        endpoint = noLldpPorts[0];
        console.log(`[MAC-REALTIME] Endpoint (no LLDP, ${endpoint.macCount} MAC): ${endpoint.device} ${endpoint.ifName}`);
      }
    }
    // Priorità 2: Porta con meno MAC e LLDP non-switch (AP, telefono)
    // IMPORTANTE: esclude macCount <= 0 E switch L3/Core
    if (!endpoint && processedResults.length > 0) {

      // Filtra: macCount > 0, non-uplink, non-L3
      const validResults = processedResults.filter(r =>
        r.macCount > 0 && !r.isUplink && !isL3Switch(r.device)
      );

      if (validResults.length > 0) {
        endpoint = validResults[0];
      } else {
        // Fallback: almeno macCount > 0 e non-L3
        const fallback = processedResults.filter(r => r.macCount > 0 && !isL3Switch(r.device));
        if (fallback.length > 0) {
          endpoint = fallback[0];
        } else {
          // Ultimo fallback: qualsiasi non-L3 con macCount > 0 (no error)
          const anyNonL3Valid = processedResults.filter(r => r.macCount > 0 && !isL3Switch(r.device));
          if (anyNonL3Valid.length > 0) {
            endpoint = anyNonL3Valid[0];
          } else {
            // Estremo fallback: qualsiasi non-L3 (anche con errore)
            const anyNonL3 = processedResults.filter(r => !isL3Switch(r.device));
            endpoint = anyNonL3.length > 0 ? anyNonL3[0] : processedResults[0];
          }
        }
      }
      console.log(`[MAC-REALTIME] Endpoint (min MAC ${endpoint.macCount}): ${endpoint.device} ${endpoint.ifName} -> ${endpoint.lldpNeighbor || '-'}`);
    }

    console.log(`[MAC-REALTIME] IP Fabric endpoint: ${endpoint?.device} ${endpoint?.ifName} (${endpoint?.macCount} MAC, ${endpoint?.portType})`);

    // === TRADUZIONE PORT → IFNAME ===
    // IMPORTANTE: hwL2MacPort restituisce ifIndex DIRETTAMENTE!
    // Q-Bridge restituisce bridge port che va tradotto via dot1dBasePortIfIndex
    if (endpoint && endpoint.port) {
      try {
        const portValue = endpoint.port;
        endpoint.bridgePort = portValue; // Salva originale per debug

        let ifIndex;
        if (endpoint.source === 'hwL2MacPort') {
          // hwL2MacPort: il valore È già l'ifIndex!
          ifIndex = portValue;
          console.log(`[MAC-REALTIME] hwL2MacPort: port ${portValue} = ifIndex diretto`);
        } else {
          // Q-Bridge: traduce bridge port → ifIndex
          const dot1dBasePortIfIndexOid = `1.3.6.1.2.1.17.1.4.1.2.${portValue}`;
          const ifIndexResult = await snmp.get(endpoint.deviceIp, [dot1dBasePortIfIndexOid]);
          if (!ifIndexResult.err && ifIndexResult.values?.[0]?.value) {
            ifIndex = ifIndexResult.values[0].value;
          }
        }

        if (ifIndex) {
          endpoint.ifIndex = ifIndex;

          // OID ifName.{ifIndex} → nome porta
          const ifNameOid = `1.3.6.1.2.1.31.1.1.1.1.${ifIndex}`;
          const ifNameResult = await snmp.get(endpoint.deviceIp, [ifNameOid]);

          if (!ifNameResult.err && ifNameResult.values?.[0]?.value) {
            const ifNameVal = ifNameResult.values[0].value;
            const ifName = Buffer.isBuffer(ifNameVal) ? ifNameVal.toString() : String(ifNameVal);
            endpoint.ifName = ifName;
            console.log(`[MAC-REALTIME] Traduzione: port ${portValue} → ifIndex ${ifIndex} → ${ifName}`);
          }
        }
      } catch (translateErr) {
        console.log(`[MAC-REALTIME] Errore traduzione port: ${translateErr.message}`);
      }

      // === QUERY LLDP NEIGHBOR CON IFNAME ===
      // Ora che abbiamo l'ifName corretto, cerchiamo il neighbor LLDP nel DB
      if (endpoint.ifName) {
        try {
          // Estrai numero porta dall'ifName (es. GigabitEthernet0/0/11 -> 11)
          const portMatch = endpoint.ifName.match(/(\d+)$/);
          if (portMatch) {
            const portNum = portMatch[1];
            const lldpNeighbor = db.db.prepare(`
              SELECT l.remote_sysname FROM links l
              JOIN devices d ON l.device_id = d.id
              WHERE d.sysname = ?
                AND (l.local_ifname LIKE ? OR l.local_ifname LIKE ? OR l.local_ifname LIKE ?)
              LIMIT 1
            `).get(endpoint.device, `%/${portNum}`, `Gi0/0/${portNum}`, `GigabitEthernet0/0/${portNum}`);

            if (lldpNeighbor?.remote_sysname) {
              endpoint.lldpNeighbor = lldpNeighbor.remote_sysname;
              endpoint.hasLldpNeighbor = true;
              console.log(`[MAC-REALTIME] LLDP Neighbor: ${endpoint.lldpNeighbor}`);
            }
          }
        } catch (lldpErr) {
          console.log(`[MAC-REALTIME] Errore query LLDP: ${lldpErr.message}`);
        }
      }

      // === QUERY UPLINK SWITCH ===
      // Trova l'uplink dello switch (porta verso L3/Core)
      try {
        const uplinkQuery = db.db.prepare(`
          SELECT l.local_ifname, l.remote_sysname
          FROM links l
          JOIN devices d ON l.device_id = d.id
          WHERE d.sysname = ?
            AND (l.remote_sysname LIKE '%L3%' OR l.remote_sysname LIKE '%Core%' OR l.remote_sysname LIKE '%6730%' OR l.remote_sysname LIKE '%6720%')
          LIMIT 1
        `).get(endpoint.device);

        if (uplinkQuery?.remote_sysname) {
          endpoint.uplinkSwitch = uplinkQuery.remote_sysname;
          endpoint.uplinkPort = uplinkQuery.local_ifname;
          console.log(`[MAC-REALTIME] Uplink: ${endpoint.uplinkPort} -> ${endpoint.uplinkSwitch}`);
        }
      } catch (uplinkErr) {
        console.log(`[MAC-REALTIME] Errore query uplink: ${uplinkErr.message}`);
      }
    }

    // === QUERY VLAN PER ENDPOINT (Huawei hwL2MacPort) ===
    // La VLAN corretta è nell'OID hwL2MacPort, NON nel PVID della porta!
    // Formato OID: 1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4.MAC[6].VLAN.macType.48
    // NOTA: Un MAC può apparire su più VLAN (es. VLAN 1 management + VLAN 1001 dati)
    if (endpoint && !endpoint.vlan && endpoint.mac) {
      try {
        // Converti MAC in formato decimale per ricerca nell'OID
        const macDecimal = endpoint.mac.split(':').map(h => parseInt(h, 16)).join('.');

        // Huawei hwL2MacPort OID
        const hwL2MacPortOid = '1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4';
        const hwWalkResult = await snmp.walk(endpoint.deviceIp, hwL2MacPortOid, 20, 8000);

        if (!hwWalkResult.err && hwWalkResult.rows?.length > 0) {
          // Raccogli TUTTE le VLAN dove appare questo MAC
          const vlansFound = [];
          for (const row of hwWalkResult.rows) {
            // Formato: base.MAC[6].VLAN.macType.48
            const parts = row.oid.split('.');
            const baseLen = hwL2MacPortOid.split('.').length;

            // Estrai MAC (6 ottetti dopo base) ed effettua match esatto
            const macParts = parts.slice(baseLen, baseLen + 6);
            const macFromOid = macParts.map(p => parseInt(p).toString(16).padStart(2, '0')).join('');
            if (macFromOid !== endpoint.mac.replace(/:/g, '').toLowerCase()) continue;

            const vlanIdx = baseLen + 6;
            const vlanVal = parseInt(parts[vlanIdx]);
            if (!isNaN(vlanVal) && vlanVal > 0 && vlanVal < 4095) {
              vlansFound.push(vlanVal);
            }
          }

          if (vlansFound.length > 0) {
            // Salva tutte le VLAN trovate
            endpoint.vlans = vlansFound.sort((a, b) => a - b);

            // Preferisci VLAN > 1 (VLAN 1 è spesso default/management)
            const dataVlans = vlansFound.filter(v => v > 1);
            endpoint.vlan = dataVlans.length > 0 ? Math.max(...dataVlans) : vlansFound[0];

            console.log(`[MAC-REALTIME] VLAN da hwL2MacPort: ${endpoint.vlan} (tutte: ${vlansFound.join(', ')})`);
          }
        }

        // Fallback: dot1qPvid (PVID porta) - meno accurato ma sempre disponibile
        if (!endpoint.vlan) {
          const pvidOid = `1.3.6.1.2.1.17.7.1.4.5.1.1.${endpoint.port}`;
          const pvidResult = await snmp.get(endpoint.deviceIp, [pvidOid]);
          if (!pvidResult.err && pvidResult.values?.[0]?.value) {
            const vlanVal = pvidResult.values[0].value;
            endpoint.vlan = typeof vlanVal === 'number' ? vlanVal : parseInt(vlanVal);
            console.log(`[MAC-REALTIME] VLAN da PVID (fallback): ${endpoint.vlan}`);
          }
        }
      } catch (vlanErr) {
        console.log(`[MAC-REALTIME] Impossibile ottenere VLAN: ${vlanErr.message}`);
      }
    }

    res.json({
      query: mac,
      normalized: cleanMAC.match(/.{2}/g)?.join(':') || cleanMAC,
      scannedDevices: devices.length,
      elapsed: `${elapsed}ms`,
      endpoint: endpoint, // <-- ENDPOINT REALE
      results: processedResults,
      errors: errors.slice(0, 10),
      found: results.length > 0
    });

  } catch (err) {
    console.error('[MAC-REALTIME] Errore:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== MAC ADDRESS SEARCH (DATABASE) ==========

// Endpoint: Cerca MAC address in FDB, ARP e interfaces
app.get('/api/search/mac/:mac', async (req, res) => {
  try {
    const { mac } = req.params;
    const { site, vlan } = req.query;

    // Pulisce e valida input MAC (supporta ricerca parziale, minimo 4 caratteri hex)
    const clean = mac.replace(/[:.|\-]/g, '').toLowerCase();
    if (clean.length < 4 || !/^[0-9a-f]+$/.test(clean)) {
      return res.status(400).json({ error: 'Inserire almeno 4 caratteri esadecimali validi' });
    }

    // Normalizza: se completo (12 char) formatta come xx:xx:xx:xx:xx:xx, altrimenti usa parziale
    const normalizedMac = clean.length === 12
      ? clean.match(/.{2}/g).join(':')
      : clean;

    console.log(`[MAC-SEARCH] Ricerca MAC: ${mac} → normalizzato: ${normalizedMac}`);

    // Pattern per LIKE SQL (cerca MAC pulito senza separatori)
    const searchPattern = `%${normalizedMac.replace(/:/g, '')}%`;

    // Cerca in FDB (Forwarding Database) con filtri opzionali
    let fdbQuery = `
      SELECT f.mac, f.vlan, f.lastseen, f.firstseen,
             d.sysname as device, d.ip as device_ip,
             i.ifname as interface
      FROM fdb f
      JOIN devices d ON f.device_id = d.id
      LEFT JOIN interfaces i ON f.interface_id = i.id
      WHERE REPLACE(REPLACE(f.mac, ':', ''), '-', '') LIKE ?
    `;
    const fdbParams = [searchPattern];
    if (site && /^\d{1,3}$/.test(site)) {
      fdbQuery += ` AND d.sysname LIKE ?`;
      fdbParams.push(`${site}_%`);
    }
    const vlanNum = vlan !== undefined ? parseInt(vlan) : null;
    if (vlanNum !== null && !Number.isNaN(vlanNum)) {
      fdbQuery += ` AND f.vlan = ?`;
      fdbParams.push(vlanNum);
    }
    fdbQuery += ` ORDER BY f.lastseen DESC LIMIT 100`;
    const fdbResults = db.db.prepare(fdbQuery).all(...fdbParams);

    // Cerca in ARP table con filtro sito opzionale
    let arpQuery = `
      SELECT a.ip, a.mac, a.lastseen,
             d.sysname as device, d.ip as device_ip
      FROM arp a
      JOIN devices d ON a.device_id = d.id
      WHERE REPLACE(REPLACE(a.mac, ':', ''), '-', '') LIKE ?
    `;
    const arpParams = [searchPattern];
    if (site && /^\d{1,3}$/.test(site)) {
      arpQuery += ` AND d.sysname LIKE ?`;
      arpParams.push(`${site}_%`);
    }
    arpQuery += ` ORDER BY a.lastseen DESC LIMIT 100`;
    const arpResults = db.db.prepare(arpQuery).all(...arpParams);

    // Cerca in interfaces (MAC fisico delle porte) con filtro sito opzionale
    let ifQuery = `
      SELECT i.ifphysaddress as mac, i.ifname, i.ifdescr,
             d.sysname as device, d.ip as device_ip
      FROM interfaces i
      JOIN devices d ON i.device_id = d.id
      WHERE REPLACE(REPLACE(i.ifphysaddress, ':', ''), '-', '') LIKE ?
    `;
    const ifParams = [searchPattern];
    if (site && /^\d{1,3}$/.test(site)) {
      ifQuery += ` AND d.sysname LIKE ?`;
      ifParams.push(`${site}_%`);
    }
    ifQuery += ` LIMIT 100`;
    const ifResults = db.db.prepare(ifQuery).all(...ifParams);

    const localCount = fdbResults.length + arpResults.length + ifResults.length;

    console.log(`[MAC-SEARCH] Risultati locali: FDB=${fdbResults.length}, ARP=${arpResults.length}, IF=${ifResults.length}`);

    // Cerca anche su NeDi se disponibile
    let nediResults = null;
    try {
      const nedi = await getNedi();
      if (nedi) {
        console.log(`[MAC-SEARCH] Ricerca su NeDi...`);
        nediResults = await nedi.searchMac(clean, 100, { site: site, vlan: vlanNum });
        console.log(`[MAC-SEARCH] Risultati NeDi: nodes=${nediResults.nodes.count}, arp=${nediResults.arp.count}`);
      } else {
        nediResults = { nodes: { count: 0, data: [] }, arp: { count: 0, data: [] }, totalCount: 0, error: 'NeDi non disponibile' };
      }
    } catch (nediErr) {
      console.warn(`[MAC-SEARCH] NeDi non disponibile:`, nediErr.message);
      nediResults = { nodes: { count: 0, data: [] }, arp: { count: 0, data: [] }, totalCount: 0, error: nediErr.message };
    }

    const totalCount = localCount + (nediResults ? nediResults.totalCount : 0);

    res.json({
      query: mac,
      normalized: normalizedMac,
      results: {
        fdb: { count: fdbResults.length, data: fdbResults },
        arp: { count: arpResults.length, data: arpResults },
        interfaces: { count: ifResults.length, data: ifResults }
      },
      nedi: nediResults,
      totalCount
    });
  } catch (error) {
    console.error('[MAC-SEARCH] Errore:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// MAC FINDER - Metodo FUNZIONANTE con logica IP Fabric
// Usa dot1dTpFdbPort (standard IEEE) che funziona su Huawei
// ============================================================
app.post('/api/search/mac/find', async (req, res) => {
  const startTime = Date.now();
  try {
    const { mac, network } = req.body || {};
    if (!mac) return res.status(400).json({ error: 'MAC richiesto' });
    if (!network) return res.status(400).json({ error: 'Network CIDR richiesto (es: 192.168.12.0/24)' });

    const cleanMac = mac.replace(/[:\-\.]/g, '').toLowerCase();
    if (cleanMac.length !== 12 || !/^[0-9a-f]{12}$/.test(cleanMac)) {
      return res.status(400).json({ error: 'MAC non valido' });
    }

    // Parse CIDR
    const [baseIp, bits] = network.split('/');
    const mask = parseInt(bits) || 24;
    const baseParts = baseIp.split('.').map(Number);
    const numHosts = Math.pow(2, 32 - mask) - 2;

    // Generate IPs
    const ips = [];
    for (let i = 1; i <= numHosts; i++) {
      const ip = [
        baseParts[0],
        baseParts[1],
        baseParts[2],
        (baseParts[3] & (256 - Math.pow(2, 32 - mask))) + i
      ].join('.');
      ips.push(ip);
    }

    console.log(`[MAC-FIND] Searching ${mac} on ${network} (${ips.length} hosts)`);

    const OID = {
      sysName: '1.3.6.1.2.1.1.5.0',
      dot1dTpFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
      dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
      ifName: '1.3.6.1.2.1.31.1.1.1.1',
    };

    const results = [];
    const BATCH_SIZE = 20;
    const TIMEOUT = 10000;

    // Helper: create SNMP session
    const createSession = (ip) => snmp.createSession(ip, COMMUNITY, {
      timeout: TIMEOUT, retries: 1, version: snmp.Version2c
    });

    // Helper: get sysName
    const getSysName = (ip) => new Promise((resolve) => {
      const session = createSession(ip);
      session.get([OID.sysName], (err, varbinds) => {
        try { session.close(); } catch(e) {}
        resolve(err || !varbinds?.[0] ? null : varbinds[0].value?.toString());
      });
    });

    // Helper: search MAC on switch FDB
    const searchMac = (ip) => new Promise((resolve) => {
      const session = createSession(ip);
      let found = null;
      const baseLen = OID.dot1dTpFdbPort.split('.').length; // 10 per dot1dTpFdbPort
      const timeoutId = setTimeout(() => {
        try { session.close(); } catch(e) {}
        resolve(null);
      }, TIMEOUT + 2000);

      session.subtree(OID.dot1dTpFdbPort, (varbinds) => {
        for (const vb of varbinds) {
          const parts = vb.oid.split('.');
          const macHex = parts.slice(baseLen, baseLen + 6).map(p => parseInt(p).toString(16).padStart(2, '0')).join('');
          if (macHex === cleanMac) {
            found = { bridgePort: vb.value };
            break;
          }
        }
      }, () => {
        clearTimeout(timeoutId);
        try { session.close(); } catch(e) {}
        resolve(found);
      });
    });

    // Helper: count MACs on port (for IP Fabric logic)
    const countMacsOnPort = (ip, bridgePort) => new Promise((resolve) => {
      const session = createSession(ip);
      let count = 0;
      const timeoutId = setTimeout(() => {
        try { session.close(); } catch(e) {}
        resolve(count);
      }, TIMEOUT + 2000);

      session.subtree(OID.dot1dTpFdbPort, (varbinds) => {
        for (const vb of varbinds) {
          if (vb.value === bridgePort) count++;
        }
      }, () => {
        clearTimeout(timeoutId);
        try { session.close(); } catch(e) {}
        resolve(count);
      });
    });

    // Helper: translate bridge port to ifName
    const translatePort = (ip, bridgePort) => new Promise((resolve) => {
      const session = createSession(ip);
      session.get([OID.dot1dBasePortIfIndex + '.' + bridgePort], (err, varbinds) => {
        if (err || !varbinds?.[0]?.value) {
          try { session.close(); } catch(e) {}
          return resolve({ bridgePort, ifIndex: null, ifName: null });
        }
        const ifIndex = varbinds[0].value;
        session.get([OID.ifName + '.' + ifIndex], (err2, vb2) => {
          try { session.close(); } catch(e) {}
          resolve({
            bridgePort,
            ifIndex,
            ifName: err2 || !vb2?.[0]?.value ? null : vb2[0].value.toString()
          });
        });
      });
    });

    // Scan in batches
    for (let i = 0; i < ips.length; i += BATCH_SIZE) {
      const batch = ips.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (ip) => {
        try {
          const found = await searchMac(ip);
          if (found) {
            const [sysName, portInfo, macCount] = await Promise.all([
              getSysName(ip),
              translatePort(ip, found.bridgePort),
              countMacsOnPort(ip, found.bridgePort)
            ]);
            results.push({ ip, sysName, ...found, ...portInfo, macCount });
            console.log(`[MAC-FIND] Found on ${sysName} (${ip}) ${portInfo.ifName} - ${macCount} MAC`);
          }
        } catch (e) { console.warn('[MAC-FIND] Device scan error:', e.message); }
      }));
    }

    // IP Fabric logic:
    // 1. Escludere Eth-Trunk (sono sempre uplink)
    // 2. Tra le porte rimanenti, ordinare per MAC count (meno = endpoint)
    const accessPorts = results.filter(r => !r.ifName?.toLowerCase().includes('eth-trunk'));
    const trunkPorts = results.filter(r => r.ifName?.toLowerCase().includes('eth-trunk'));

    // Ordina access ports per MAC count
    accessPorts.sort((a, b) => a.macCount - b.macCount);

    // Endpoint = prima porta access (meno MAC), fallback a trunk se non ci sono access
    const endpoint = accessPorts.length > 0 ? accessPorts[0] : (trunkPorts.length > 0 ? trunkPorts[0] : null);

    console.log(`[MAC-FIND] Access ports: ${accessPorts.length}, Trunk ports: ${trunkPorts.length}`);
    const elapsed = Date.now() - startTime;

    console.log(`[MAC-FIND] Done in ${elapsed}ms - Found on ${results.length} switches, endpoint: ${endpoint?.sysName || 'none'}`);

    res.json({
      query: mac,
      normalized: cleanMac,
      network,
      scanned: ips.length,
      elapsed: elapsed + 'ms',
      found: results.length > 0,
      endpoint,
      results
    });

  } catch (error) {
    console.error('[MAC-FIND] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// MAC TRACE - Logica IP Fabric CORRETTA
// Segue il percorso: CORE → TRUNK → neighbor → repeat → ACCESS
// NON scansiona 254 device, segue solo il path reale
// ============================================================
app.post('/api/search/mac/trace', async (req, res) => {
  const startTime = Date.now();
  try {
    const { mac, network, fastCoreOnly = false } = req.body || {};
    if (!mac) return res.status(400).json({ error: 'MAC richiesto' });
    if (!network) return res.status(400).json({ error: 'Network CIDR richiesto (es: 192.168.21.0/24)' });

    const cleanMac = mac.replace(/[:\-\.]/g, '').toLowerCase();
    if (cleanMac.length !== 12 || !/^[0-9a-f]{12}$/.test(cleanMac)) {
      return res.status(400).json({ error: 'MAC non valido' });
    }

    // Calcola IP del CORE (sempre .251)
    const baseParts = network.split('/')[0].split('.').map(Number);
    // Se manca il terzo ottetto, usa 4 come default (es. 10.x -> 10.x.4.251)
    const thirdOctet = baseParts[2] !== undefined ? baseParts[2] : 4;
    const coreIp = `${baseParts[0]}.${baseParts[1]}.${thirdOctet}.251`;

    console.log(`[MAC-TRACE] Tracing ${mac} starting from CORE ${coreIp}`);

    const OID = {
      sysName: '1.3.6.1.2.1.1.5.0',
      dot1dTpFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
      hwL2MacPort: '1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4',
      dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
      ifName: '1.3.6.1.2.1.31.1.1.1.1',
      lldpRemSysName: '1.0.8802.1.1.2.1.4.1.1.9',
      lldpRemManAddr: '1.0.8802.1.1.2.1.4.2.1.4',
    };
    const TIMEOUT = fastCoreOnly ? 8000 : 15000;

    // Helper: create SNMP session
    const createSession = (ip) => snmp.createSession(ip, COMMUNITY, {
      timeout: TIMEOUT, retries: 2, version: snmp.Version2c
    });

    // Helper: find IP of device by sysName (from netmap.db)
    const findDeviceIp = (sysName) => {
      if (!sysName) return null;
      try {
        const row = db.db.prepare('SELECT ip FROM devices WHERE sysname LIKE ? OR sysname = ?').get(`%${sysName}%`, sysName);
        return row?.ip || null;
      } catch (e) {
        return null;
      }
    };

    // Helper: get sysName
    const getSysName = (ip) => new Promise((resolve) => {
      const session = createSession(ip);
      session.get([OID.sysName], (err, varbinds) => {
        try { session.close(); } catch(e) {}
        resolve(err || !varbinds?.[0] ? null : varbinds[0].value?.toString());
      });
    });

    const findMacInFdb = (ip, timeoutOverride = null) => new Promise((resolve) => {
      let resolved = false;
      const macDec = cleanMac.match(/.{2}/g).map(h => parseInt(h, 16)).join('.');
      try {
        const sessionHw = snmp.createSession(ip, COMMUNITY, { timeout: timeoutOverride || TIMEOUT, retries: 1, version: snmp.Version2c });
        const baseLen = OID.hwL2MacPort.split('.').length;
        sessionHw.subtree(OID.hwL2MacPort, (varbinds) => {
          for (const vb of varbinds) {
            // Extract last 6 octets from OID as MAC
            const parts = (vb.oid || '').split('.');
            const macFromOid = parts.slice(baseLen, baseLen + 6).map(p => parseInt(p).toString(16).padStart(2, '0')).join('');
            if (macFromOid === cleanMac) {
              resolved = true;
              try { sessionHw.close(); } catch(e) {}
              resolve({ source: 'huawei', ifIndex: vb.value });
              return;
            }
          }
        }, () => {
          try { sessionHw.close(); } catch(e) {}
          if (resolved) return;
          const sessionStd = snmp.createSession(ip, COMMUNITY, { timeout: timeoutOverride || TIMEOUT, retries: 1, version: snmp.Version2c });
          let found = null;
          const timeoutId = setTimeout(() => {
            try { sessionStd.close(); } catch(e) {}
            resolve(found);
          }, TIMEOUT + 2000);
          const stdBaseLen = OID.dot1dTpFdbPort.split('.').length;
          sessionStd.subtree(OID.dot1dTpFdbPort, (varbinds2) => {
            for (const vb2 of varbinds2) {
              const parts = vb2.oid.split('.');
              const macHex = parts.slice(stdBaseLen, stdBaseLen + 6).map(p => parseInt(p).toString(16).padStart(2, '0')).join('');
              if (macHex === cleanMac) { found = { source: 'bridge', bridgePort: vb2.value }; break; }
            }
          }, () => {
            clearTimeout(timeoutId);
            try { sessionStd.close(); } catch(e) {}
            resolve(found);
          });
        });
      } catch (e) {
        try {
          const sessionStd = snmp.createSession(ip, COMMUNITY, { timeout: timeoutOverride || TIMEOUT, retries: 1, version: snmp.Version2c });
          let found = null;
          const stdBaseLen = OID.dot1dTpFdbPort.split('.').length;
          const timeoutId = setTimeout(() => {
            try { sessionStd.close(); } catch(e) {}
            resolve(found);
          }, TIMEOUT + 2000);
          sessionStd.subtree(OID.dot1dTpFdbPort, (varbinds2) => {
            for (const vb2 of varbinds2) {
              const parts = vb2.oid.split('.');
              const macHex = parts.slice(stdBaseLen, stdBaseLen + 6).map(p => parseInt(p).toString(16).padStart(2, '0')).join('');
              if (macHex === cleanMac) { found = { source: 'bridge', bridgePort: vb2.value }; break; }
            }
          }, () => {
            clearTimeout(timeoutId);
            try { sessionStd.close(); } catch(e) {}
            resolve(found);
          });
        } catch (_) { resolve(null); }
      }
    });

    const countMacsOnBridgePort = (ip, bridgePort) => new Promise((resolve) => {
      const session = createSession(ip);
      let count = 0;
      session.subtree(OID.dot1dTpFdbPort, (varbinds) => {
        for (const vb of varbinds) { if (vb.value === bridgePort) count++; }
      }, () => { try { session.close(); } catch(e) {} ; resolve(count); });
    });

    const countMacsOnIfIndex = (ip, ifIndex) => new Promise((resolve) => {
      let count = 0;
      const targetIfIndex = Number(ifIndex);
      try {
        const session = createSession(ip);
        session.subtree(OID.hwL2MacPort, (varbinds) => {
          for (const vb of varbinds) {
            if (Number(vb.value) === targetIfIndex) count++;
          }
        }, (err) => {
          try { session.close(); } catch(e) {}
          resolve(err ? null : count);
        });
      } catch { resolve(null); }
    });

    // Helper: get ifIndex from bridgePort
    const getIfIndex = (ip, bridgePort) => new Promise((resolve) => {
      const session = createSession(ip);
      const oid = `${OID.dot1dBasePortIfIndex}.${bridgePort}`;
      session.get([oid], (err, varbinds) => {
        try { session.close(); } catch(e) {}
        resolve(err || !varbinds?.[0] ? null : varbinds[0].value);
      });
    });

    const getBridgePortFromIfIndex = (ip, ifIndex) => new Promise((resolve) => {
      const session = createSession(ip);
      let port = null;
      session.subtree(OID.dot1dBasePortIfIndex, (varbinds) => {
        for (const vb of varbinds) {
          if (vb.value === ifIndex) {
            const parts = vb.oid.split('.');
            port = parseInt(parts[parts.length - 1], 10);
            break;
          }
        }
      }, () => { try { session.close(); } catch(e) {} ; resolve(port); });
    });

    // Helper: get ifName from ifIndex
    const getIfName = (ip, ifIndex) => new Promise((resolve) => {
      const session = createSession(ip);
      const oid = `${OID.ifName}.${ifIndex}`;
      session.get([oid], (err, varbinds) => {
        try { session.close(); } catch(e) {}
        resolve(err || !varbinds?.[0] ? null : varbinds[0].value?.toString());
      });
    });

    const getLagMembers = (ip, aggIfIndex, ifName) => new Promise((resolve) => {
      const session = createSession(ip);
      const members = new Set();

      // PRIORITÀ 1: IEEE 802.3ad (più affidabile - usa ifIndex del LAG)
      session.subtree('1.2.840.10006.300.43.1.2.1.1.13', (varbinds) => {
        for (const vb of varbinds) {
          const parts = (vb.oid || '').split('.');
          const portIfIndex = Number(parts[parts.length - 1]);
          const lagIfIndex = vb.value;
          if (lagIfIndex === Number(aggIfIndex) && portIfIndex) {
            members.add(portIfIndex);
          }
        }
      }, () => {
        if (members.size > 0) {
          try { session.close(); } catch(e) {}
          resolve(Array.from(members));
          return;
        }

        // PRIORITÀ 2: Huawei proprietary OID (fallback per switch che non supportano IEEE)
        const trunkNum = ifName ? parseInt((ifName.match(/eth-trunk(\d+)/i) || [])[1]) : null;

        session.subtree('1.3.6.1.4.1.2011.5.25.41.1.4.1.1.2', (varbinds2) => {
          const allTrunks = new Map();
          for (const vb of varbinds2) {
            const parts = (vb.oid || '').split('.');
            const trunkId = parts[parts.length - 2];
            const memberIfIndex = Number(parts[parts.length - 1]);
            if (!allTrunks.has(trunkId)) allTrunks.set(trunkId, []);
            allTrunks.get(trunkId).push(memberIfIndex);
          }

          let targetTrunkId = null;
          const sortedTrunkIds = Array.from(allTrunks.keys()).sort((a, b) => Number(a) - Number(b));

          if (trunkNum !== null && sortedTrunkIds.length > 0) {
            if (sortedTrunkIds.length === 1) {
              targetTrunkId = sortedTrunkIds[0];
            } else if (allTrunks.has(String(trunkNum))) {
              targetTrunkId = String(trunkNum);
            } else {
              for (const [idx, tid] of sortedTrunkIds.entries()) {
                if (idx === trunkNum - 4) {
                  targetTrunkId = tid;
                  break;
                }
              }
            }
          }

          if (targetTrunkId && allTrunks.has(targetTrunkId)) {
            allTrunks.get(targetTrunkId).forEach(m => members.add(m));
          }
        }, () => {
          if (members.size === 0) {
            // PRIORITÀ 3: ifStackTable
            session.subtree('1.3.6.1.2.1.31.1.2.1.2', (varbinds3) => {
              for (const vb of varbinds3) {
                const parts = (vb.oid || '').split('.');
                const higher = Number(parts[parts.length - 2]);
                const lower = Number(parts[parts.length - 1]);
                if (higher === Number(aggIfIndex) && lower) members.add(lower);
              }
            }, () => {
              try { session.close(); } catch(e) {}
              resolve(Array.from(members));
            });
          } else {
            try { session.close(); } catch(e) {}
            resolve(Array.from(members));
          }
        });
      });
    });

    // Helper: get LLDP neighbor on port (robusto: porta → neighbor name + mgmt IP)
    const getLldpNeighbor = (ip, ifIndex, ifName) => new Promise((resolve) => {
      const remRows = [];
      const manRows = [];
      const locMap = new Map();

      // Calcola LLDP LocalPort da ifName
      // Su Huawei CORE: GigabitEthernet1/0/13 -> LLDP LocalPort = slot*100 + port = 113
      // Su switch L2: GigabitEthernet0/0/13 -> LLDP LocalPort = 13
      let lldpLocalPort = null;
      const slotPortMatch = (ifName || '').match(/(\d+)\/\d+\/(\d+)/);
      if (slotPortMatch) {
        const slot = parseInt(slotPortMatch[1]);
        const port = parseInt(slotPortMatch[2]);
        lldpLocalPort = slot === 0 ? port : slot * 100 + port;
      }
      const portNumMatch = (ifName || '').match(/(\d+)$/);
      const portNum = portNumMatch ? Number(portNumMatch[1]) : null;

      const parseRemMan = (vbs) => {
        const ipMap = {};
        const OID_BASE = '1.0.8802.1.1.2.1.4.2.1';
        const baseLen = OID_BASE.split('.').length;
        const isByte = (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 255;
        for (const vb of vbs) {
          const oid = (vb.oid || '').split('.');
          if (oid.slice(0, baseLen).join('.') !== OID_BASE) continue;
          const attr = oid[baseLen];
          const len = oid.length;
          const hasTimeMark = len >= baseLen + 9;
          let localPort, remIndex, addrSubtype;
          if (hasTimeMark) {
            localPort = oid[baseLen + 2];
            remIndex = oid[baseLen + 3];
            addrSubtype = oid[baseLen + 4];
          } else if (len >= baseLen + 8) {
            localPort = oid[baseLen + 1];
            remIndex = oid[baseLen + 2];
            addrSubtype = oid[baseLen + 3];
          } else {
            continue;
          }
          if (attr === '4' && addrSubtype === '1') {
            let ipStr = null;
            if (Buffer.isBuffer(vb.value) && vb.value.length >= 4) {
              const bytes = Array.from(vb.value.slice(-4)).map(b => b & 0xff);
              if (bytes.every(isByte)) ipStr = bytes.join('.');
            } else if (typeof vb.value === 'string') {
              const m = vb.value.match(/\d+/g);
              if (m && m.length >= 4) {
                const nums = m.slice(-4).map(Number);
                if (nums.every(isByte)) ipStr = nums.join('.');
              }
            }
            if (!ipStr) {
              const suffix = oid.slice(-4).map(Number);
              if (suffix.length === 4 && suffix.every(isByte)) {
                ipStr = suffix.join('.');
              } else {
                const offset = hasTimeMark ? baseLen + 6 : baseLen + 5;
                const addr = [0,1,2,3].map(i => Number(oid[offset + i]));
                if (addr.every(isByte)) ipStr = addr.join('.');
              }
            }
            if (ipStr) ipMap[`${localPort}-${remIndex}`] = ipStr;
          }
        }
        return ipMap;
      };

      const finalize = () => {
        let neighborName = null;
        let neighborIp = null;
        try {
          const entries = parseLldpVarbinds(remRows) || [];
          let best = null;
          let bestScore = -Infinity;
          for (const e of entries) {
            const lp = parseInt(e.localPort, 10);
            const pid = (e.portId || '').trim();
            const pdesc = (e.portDesc || '').trim();
            const loc = locMap.get(String(lp)) || {};
            let score = 0;
            // Priorità 1: lldpLocalPort calcolato da ifName (es. GE1/0/13 -> 113)
            // Score DOMINANTE (+50) per garantire che il match esatto vinca sempre
            if (lldpLocalPort && !isNaN(lp) && lp === lldpLocalPort) score += 50;
            // Priorità 2: match esatto con ifIndex (per device dove LLDP LocalPort = ifIndex)
            else if (!isNaN(lp) && lp === Number(ifIndex)) score += 10;
            // Priorità 3: prossimità a ifIndex
            else if (!isNaN(lp)) score += Math.max(0, 6 - Math.abs(lp - Number(ifIndex)));
            // Priorità 4: match con ultimo numero della porta
            if (portNum && !isNaN(lp) && lp === portNum) score += 9;
            if (ifName && pid && pid === ifName) score += 8;
            if (ifName && pdesc && (pdesc === ifName || pdesc.includes(ifName))) score += 4;
            if (ifName && loc.id && loc.id === ifName) score += 12;
            if (ifName && loc.desc && (loc.desc === ifName || loc.desc.includes(ifName))) score += 6;
            if ((e.sysName || '').includes('_L2_')) score += 2;
            if (score > bestScore) { bestScore = score; best = e; }
          }
          neighborName = best?.sysName || null;
          const ipMap = parseRemMan(manRows);
          if (best) {
            const key = `${best.localPort}-${best.remIndex}`;
            neighborIp = ipMap[key] || null;
          }
        } catch {}
        // Prefer management IP inside requested network (same /24 of core)
        try {
          const prefix = `${baseParts[0]}.${baseParts[1]}.${baseParts[2]}.`;
          if (!neighborIp || (typeof neighborIp === 'string' && !neighborIp.startsWith(prefix))) {
            // IP LLDP fuori rete - cerca nel database
            if (neighborName) {
              const candidate = findDeviceIp(neighborName);
              if (candidate && candidate.startsWith(prefix)) {
                neighborIp = candidate;
              }
            }
          }
        } catch {}
        resolve({ name: neighborName, ip: neighborIp });
      };

      try {
        const sessionLoc = createSession(ip);
        const locRows = [];
        sessionLoc.subtree('1.0.8802.1.1.2.1.3.7.1', 20, (vb) => {
          if (Array.isArray(vb)) locRows.push(...vb); else if (vb) locRows.push(vb);
        }, () => {
          try { sessionLoc.close(); } catch(e) {}
          for (const vb of locRows) {
            const parts = (vb.oid || '').split('.');
            const attr = parts[parts.length - 2];
            const lp = parts[parts.length - 1];
            const entry = locMap.get(lp) || {};
            if (attr === '3') entry.id = (vb.value || '').toString();
            else if (attr === '4') entry.desc = (vb.value || '').toString();
            locMap.set(lp, entry);
          }
          const sessionRem = createSession(ip);
          sessionRem.subtree('1.0.8802.1.1.2.1.4.1.1', 20, (vb) => {
            if (Array.isArray(vb)) remRows.push(...vb); else if (vb) remRows.push(vb);
          }, () => {
            try { sessionRem.close(); } catch(e) {}
            const sessionMan = createSession(ip);
            const timeoutId = setTimeout(() => { try { sessionMan.close(); } catch(e) {} ; finalize(); }, TIMEOUT + 2000);
            sessionMan.subtree('1.0.8802.1.1.2.1.4.2.1', 20, (vb) => {
              if (Array.isArray(vb)) manRows.push(...vb); else if (vb) manRows.push(vb);
            }, () => {
              clearTimeout(timeoutId);
              try { sessionMan.close(); } catch(e) {}
              finalize();
            });
          });
        });
      } catch {
        try {
          const sessionRem = createSession(ip);
          sessionRem.subtree('1.0.8802.1.1.2.1.4.1.1', 20, (vb) => {
            if (Array.isArray(vb)) remRows.push(...vb); else if (vb) remRows.push(vb);
          }, () => {
            try { sessionRem.close(); } catch(e) {}
            const sessionMan = createSession(ip);
            const timeoutId = setTimeout(() => { try { sessionMan.close(); } catch(e) {} ; finalize(); }, TIMEOUT + 2000);
            sessionMan.subtree('1.0.8802.1.1.2.1.4.2.1', 20, (vb) => {
              if (Array.isArray(vb)) manRows.push(...vb); else if (vb) manRows.push(vb);
            }, () => {
              clearTimeout(timeoutId);
              try { sessionMan.close(); } catch(e) {}
              finalize();
            });
          });
        } catch { finalize(); }
      }
    });

    // Helper: rileva TRUNK nel contesto TRACE (solo live heuristics)
    const traceIsTrunk = (sysName, ifName, ifIndex) => {
      try {
        const nameLower = (ifName || '').toLowerCase();
        const isL3 = (sysName || '').includes('_L3_');
        // Solo eth-trunk/port-channel/10GE sono trunk per nome
        const byName = /(eth-trunk|port-channel|10ge|xgigabitethernet|tenge|xge)/.test(nameLower);
        // Uplink hint: solo porte >= 49 (tipicamente SFP uplink su switch 48 porte)
        const uplinkNumberHint = /(?:gigabitethernet|xgigabitethernet|tenge|xge)\d+\/\d+\/(49|5[0-9])/i.test(ifName || '');
        return byName || (isL3 && uplinkNumberHint);
      } catch { return false; }
    };

    // === MAIN TRACE LOGIC ===
    const path = [];
    let currentIp = coreIp;
    let maxHops = 10;
    let endpoint = null;

    while (maxHops-- > 0) {
      console.log(`[MAC-TRACE] Hop: ${currentIp}`);

      // 1. Get sysName
      const sysName = await getSysName(currentIp);
      if (!sysName) {
        path.push({ ip: currentIp, error: 'SNMP timeout' });
        break;
      }

      // 2. Find MAC in FDB
      const found = await findMacInFdb(currentIp);
      if (!found) {
        path.push({ ip: currentIp, sysName, error: 'MAC not in FDB' });
        break;
      }

      let bridgePort = found.bridgePort || null;
      let ifIndex = found.ifIndex || null;
      if (!ifIndex && bridgePort) ifIndex = await getIfIndex(currentIp, bridgePort);
      if (!bridgePort && ifIndex) bridgePort = await getBridgePortFromIfIndex(currentIp, ifIndex);
      const ifName = ifIndex ? await getIfName(currentIp, ifIndex) : null;
      let macCount = null;
      try {
        const macCountPromise = ifIndex
          ? countMacsOnIfIndex(currentIp, ifIndex)
          : (bridgePort ? countMacsOnBridgePort(currentIp, bridgePort) : Promise.resolve(null));
        macCount = await Promise.race([
          macCountPromise,
          new Promise(r => setTimeout(() => r(null), TIMEOUT + 5000))
        ]);
      } catch {}

      const hop = {
        ip: currentIp,
        sysName,
        bridgePort,
        ifIndex,
        ifName: ifName || `Port-${bridgePort}`,
        macCount  // aggiungo per debug
      };
      path.push(hop);

      // 4. Check TRUNK vs ACCESS con logica TRACE + macCount
      // BUGFIX: Nome della porta è fonte primaria di verità (99% affidabile)
      // MacCount è usato SOLO come fallback per device legacy senza nomi chiari
      console.log(`[MAC-TRACE] ${sysName} ${ifName} macCount=${macCount}, isTrunkByName=${traceIsTrunk(sysName, ifName, ifIndex)}`);
      const isTrunkByName = traceIsTrunk(sysName, ifName, ifIndex);

      // Se il nome lo dice chiaramente, fidiamoci del nome (non importa macCount)
      let isTrunk = isTrunkByName;

      // Se il nome NON è chiaro, usa macCount come fallback
      // (device legacy senza Eth-Trunk nel nome)
      if (!isTrunkByName) {
        const isAccessByName = (ifName || '').toLowerCase().match(/^gigabit|^ethernet0|^gi|^eth0/i);
        if (!isAccessByName) {
          // Nome è ambiguo (non Eth-Trunk E non chiaramente access)
          // Usa macCount come discriminatore
          const isTrunkByMacCount = macCount !== null && macCount >= 30;
          const isAccessByMacCount = macCount !== null && macCount <= 10;
          isTrunk = isTrunkByMacCount && !isAccessByMacCount;
        }
      }

      console.log(`[MAC-TRACE] isTrunk=${isTrunk}, isTrunkByName=${isTrunkByName}, isTrunkByMacCount=${macCount !== null && macCount >= 30}`);
      if (!isTrunk) {
        // Porta non-trunk: potrebbe essere ACCESS (endpoint) o collegata a switch L2
        hop.macCount = macCount;

        // Query LLDP per vedere cosa c'è collegato
        let accessNeighbor = null;
        try {
          console.log(`[MAC-TRACE] Querying LLDP for port: ip=${currentIp}, ifIndex=${ifIndex}, ifName=${ifName}`);
          accessNeighbor = await getLldpNeighbor(currentIp, ifIndex, ifName);
          console.log(`[MAC-TRACE] LLDP result: ${JSON.stringify(accessNeighbor)}`);
        } catch (lldpErr) {
          console.log(`[MAC-TRACE] LLDP query failed: ${lldpErr.message}`);
        }

        // Se LLDP neighbor è uno SWITCH (contiene _L2_ o _L3_) con IP → CONTINUA il trace
        const neighborIsSwitch = accessNeighbor?.name &&
          (accessNeighbor.name.includes('_L2_') || accessNeighbor.name.includes('_L3_'));

        if (neighborIsSwitch && accessNeighbor?.ip) {
          console.log(`[MAC-TRACE] Port has SWITCH neighbor: ${accessNeighbor.name} (${accessNeighbor.ip}), continuing trace...`);
          hop.lldpNeighbor = accessNeighbor.name;
          hop.nextHop = accessNeighbor.ip;
          // hop già aggiunto a path alla linea 5498, non serve push qui
          currentIp = accessNeighbor.ip;
          continue; // Continua il trace verso lo switch collegato
        }

        // Altrimenti è un ENDPOINT (device finale o nessun LLDP)
        if (accessNeighbor?.name) {
          hop.lldpNeighbor = accessNeighbor.name;
          hop.endpointDevice = accessNeighbor.name;
          console.log(`[MAC-TRACE] ACCESS port has endpoint device: ${accessNeighbor.name}`);
        }

        endpoint = hop;
        console.log(`[MAC-TRACE] ENDPOINT FOUND: ${sysName} ${ifName} (${macCount} MAC)`);
        break;
      }

      // 5. It's a TRUNK - resolve neighbor (DB links first, then LLDP)
      console.log(`[MAC-TRACE] TRUNK detected: ${ifName}, looking for neighbor...`);
      let neighbor = null;
      if ((ifName || '').toLowerCase().includes('eth-trunk') || (ifName || '').toLowerCase().includes('port-channel')) {
        try {
          const members = await getLagMembers(currentIp, ifIndex, ifName);
          for (const m of members) {
            const mName = await getIfName(currentIp, m);
            const n = await getLldpNeighbor(currentIp, m, mName);
            if (n?.ip) { neighbor = n; break; }
          }
        } catch {}
      }
      if (!neighbor) {
        neighbor = await getLldpNeighbor(currentIp, ifIndex, ifName);
      }
      if (!neighbor?.name && !neighbor?.ip) {
        endpoint = hop;
        console.log(`[MAC-TRACE] No LLDP neighbor on ${sysName} ${ifName}, stopping here`);
        break;
      }
      const neighborIp = neighbor?.ip;
      if (!neighborIp) {
        // LLDP neighbor esiste ma senza IP management = endpoint device (telefono, AP, etc)
        hop.lldpNeighbor = neighbor?.name || null;
        hop.endpointDevice = neighbor?.name || null;
        endpoint = hop;
        console.log(`[MAC-TRACE] LLDP neighbor ${neighbor?.name || 'unknown'} has no mgmt IP, stopping here`);
        break;
      }

      hop.lldpNeighbor = neighbor?.name || null;
      hop.nextHop = neighborIp;

      // 6.5 Anti-loop check: se il neighbor è già nel path, siamo sulla porta uplink
      const alreadyVisited = path.some(p => p.ip === neighborIp);
      if (alreadyVisited) {
        console.log(`[MAC-TRACE] LOOP DETECTED: ${neighborIp} already in path, MAC is on uplink port`);
        hop.error = 'MAC on uplink port (loop detected)';
        hop.nextHop = null;
        endpoint = hop;
        break;
      }

      // 7. Continue to next switch
      if (fastCoreOnly) {
        endpoint = hop; // ritorna solo lo step del CORE
        break;
      }
      currentIp = neighborIp;
    }

    const elapsed = `${Date.now() - startTime}ms`;
    console.log(`[MAC-TRACE] Complete in ${elapsed}, ${path.length} hops`);

    res.json({
      query: mac,
      normalized: cleanMac,
      network,
      coreSwitch: coreIp,
      elapsed,
      hops: path.length,
      found: !!endpoint,
      endpoint,
      path
    });

  } catch (error) {
    console.error('[MAC-TRACE] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

function loadCsvCredentials() {
  try {
    const csvPath = path.resolve(process.cwd(), 'Pdv.CSV');
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.trim().split(/\r?\n/);
    if (lines.length < 2) return { bySite: new Map(), byNetwork: new Map(), coreFallback: null };
    const header = lines[0].split(';').map(h => h.trim().toLowerCase());
    const idxSite = header.findIndex(h => h === 'sito' || h === 'site');
    const idxNetwork = header.findIndex(h => h === 'network' || h === 'cidr' || h === 'subnet');
    const idxUser = header.findIndex(h => h === 'utente' || h === 'username' || h === 'user');
    const idxPass = header.findIndex(h => h === 'password' || h === 'pass' || h === 'pwd');
    // Nuove colonne per credenziali switch CORE del sito
    const idxCoreIp = header.findIndex(h => h === 'switch core' || h === 'coreip' || h === 'core_ip');
    const idxCoreUser = header.findIndex(h => h === 'utente core' || h === 'core_user' || h === 'coreuser');
    const idxCorePass = header.findIndex(h => h === 'password core' || h === 'core_pass' || h === 'corepass');
    const bySite = new Map();      // Map<siteKey, Array<creds>>
    const byNetwork = new Map();   // Map<network, Array<creds>>
    let coreFallback = null;
    const unq = (s) => {
      let x = String(s || '').trim();
      if (x.startsWith('"') && x.endsWith('"')) x = x.slice(1, -1);
      x = x.replace(/""/g, '"');
      return x;
    };
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(';');
      const site = idxSite >= 0 ? String(parts[idxSite] || '').trim() : '';
      const network = idxNetwork >= 0 ? String(parts[idxNetwork] || '').trim() : '';
      const user = idxUser >= 0 ? unq(parts[idxUser]) : '';
      const pass = idxPass >= 0 ? unq(parts[idxPass]) : '';
      // Credenziali CORE specifiche per questo sito
      const coreIp = idxCoreIp >= 0 ? String(parts[idxCoreIp] || '').trim() : '';
      const coreUser = idxCoreUser >= 0 ? unq(parts[idxCoreUser]) : '';
      const corePass = idxCorePass >= 0 ? unq(parts[idxCorePass]) : '';
      const creds = {
        username: user,
        password: pass,
        coreIp: coreIp || null,
        coreUsername: coreUser || null,
        corePassword: corePass || null
      };
      if (site.toUpperCase() === 'CORE') {
        coreFallback = { username: user, password: pass };
      } else {
        // Accumula tutte le credenziali per ogni sito (supporta righe multiple)
        if (site) {
          if (!bySite.has(site)) bySite.set(site, []);
          bySite.get(site).push(creds);
        }
      }
      // Accumula tutte le credenziali per ogni network
      if (network) {
        if (!byNetwork.has(network)) byNetwork.set(network, []);
        byNetwork.get(network).push(creds);
      }
    }
    return { bySite, byNetwork, coreFallback };
  } catch {
    return { bySite: new Map(), byNetwork: new Map(), coreFallback: null };
  }
}

function formatMacHyphen(mac) {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 12);
  if (hex.length !== 12) return null;
  return `${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}`;
}

function compactPath(nodes) {
  const out = [];
  let prevKey = null;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const key = `${n?.sysName || ''}|${n?.ip || ''}|${n?.ifName || ''}|${n?.bridgePort || ''}`;
    if (key !== prevKey) {
      out.push(n);
      prevKey = key;
    }
  }
  return out;
}

function parseInterfaceFromMacOutput(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/((?:[A-Za-z]+[A-Za-z]*)?(?:Eth|GE|Gigabit|XGigabit|Ethernet)[^\s]*\d+\/\d+\/\d+|Eth-?Trunk\d+)/i);
    if (m) return m[1];
  }
  return null;
}

function parseVlanFromMacOutput(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    // Pattern per formati Huawei comuni:
    // 1. "VLAN ID: 123" o "VLAN ID/VSI Index: 123"
    // 2. "VLAN: 123" o "VlanId: 123"
    // 3. Tabellare Huawei: "aaaa-bbbb-cccc 1001/-/-" o "aaaa-bbbb-cccc 1001/- "
    const m =
      line.match(/VLAN\s*ID(?:\/VSI\s*Index)?\s*:?\s*(\d+)/i) ||
      line.match(/VLAN\s*:?\s*(\d+)/i) ||
      line.match(/VlanId\s*:?\s*(\d+)/i) ||
      // Formato tabellare Huawei: MAC + spazi + VLAN/... (es: "00e6-0e5b-e740 1001/-/-")
      line.match(/[\da-f]{4}-[\da-f]{4}-[\da-f]{4}\s+(\d+)[\/\-]/i) ||
      // Formato tabellare generico: MAC + spazi + VLAN numerico solo
      line.match(/[\da-f]{4}-[\da-f]{4}-[\da-f]{4}\s+(\d+)\s+/i) ||
      line.match(/[\da-f:.\-]{12,17}\s+(\d+)\s+/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseTrunkMembers(text) {
  const lines = String(text || '').split(/\r?\n/);
  const members = [];
  for (const line of lines) {
    const m = line.match(/((?:Gigabit|XGigabit|GE|Ethernet)[A-Za-z]*\d+\/\d+\/\d+)/i);
    if (m) members.push(m[1]);
  }
  return Array.from(new Set(members));
}

function normalizeInterfaceName(name) {
  const n = String(name || '').trim();
  const m = n.match(/^(GE|GigabitEthernet)\s*?(\d+)\/(\d+)\/(\d+)$/i) || n.match(/^(GE|GigabitEthernet)(\d+)\/(\d+)\/(\d+)$/i);
  if (m) return `GigabitEthernet ${m[2]}/${m[3]}/${m[4]}`;
  const mx = n.match(/^(XGE|XGigabitEthernet)\s*?(\d+)\/(\d+)\/(\d+)$/i) || n.match(/^(XGE|XGigabitEthernet)(\d+)\/(\d+)\/(\d+)$/i);
  if (mx) return `XGigabitEthernet ${mx[2]}/${mx[3]}/${mx[4]}`;
  return n;
}

function interfaceCommandVariants(name) {
  const variants = [];
  const base = String(name || '').trim();
  variants.push(base);
  const norm = normalizeInterfaceName(base);
  if (norm && norm !== base) variants.push(norm);
  const nospace = norm.replace(/\s+/g, '');
  if (nospace && nospace !== norm) variants.push(nospace);
  return Array.from(new Set(variants));
}

function parseLldpNeighborName(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/(System\s+name|Neighbor\s+device\s+name)\s*:\s*(\S+)/i);
    if (m) return m[2];
  }
  return null;
}

function parseLldpNeighborIp(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m =
      line.match(/Management\s+address(?:\s+value)?\s*:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i) ||
      line.match(/IP\s+address\s*:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i) ||
      line.match(/Mgmt\s+IP\s*:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Estrae informazioni complete da output LLDP neighbor
 * Include: nome, IP, capabilities, chassis ID, tipo dispositivo
 */
function parseLldpFullInfo(text) {
  const lines = String(text || '').split(/\r?\n/);
  const info = {
    name: null,
    ip: null,
    chassisId: null,
    portId: null,
    capabilities: [],
    isEndpoint: false,
    deviceType: null
  };

  for (const line of lines) {
    // System name
    const nameMatch = line.match(/(System\s+name|Neighbor\s+device\s+name)\s*:\s*(\S+)/i);
    if (nameMatch) info.name = nameMatch[2];

    // Management IP
    const ipMatch = line.match(/Management\s+address\s+value\s*:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i);
    if (ipMatch) info.ip = ipMatch[1];

    // Chassis ID (spesso è il MAC)
    const chassisMatch = line.match(/Chassis\s+ID\s*:\s*([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})/i);
    if (chassisMatch) info.chassisId = chassisMatch[1];

    // Port ID
    const portMatch = line.match(/Port\s+ID\s*:\s*(\S+)/i);
    if (portMatch && !line.includes('Port ID type')) info.portId = portMatch[1];

    // Capabilities enabled
    const capMatch = line.match(/System\s+capabilities\s+enabled\s*:\s*(.+)/i);
    if (capMatch) {
      info.capabilities = capMatch[1].toLowerCase().split(/\s+/).filter(c => c.length > 0);
    }
  }

  // Determina tipo dispositivo e se è endpoint
  if (info.capabilities.includes('wlanaccesspoint') || info.capabilities.includes('wlan-access-point')) {
    info.deviceType = 'accessPoint';
    info.isEndpoint = true;
  } else if (info.capabilities.includes('telephone')) {
    info.deviceType = 'telephone';
    info.isEndpoint = true;
  } else if (info.capabilities.includes('router') && !info.capabilities.includes('bridge')) {
    info.deviceType = 'router';
    info.isEndpoint = true;
  } else if (info.capabilities.includes('bridge') && info.capabilities.length === 1) {
    info.deviceType = 'switch';
    info.isEndpoint = false;
  } else if (info.capabilities.includes('bridge')) {
    // Bridge con altre capabilities - probabilmente switch
    info.deviceType = 'switch';
    info.isEndpoint = false;
  } else if (info.name && /_L2_|_L3_/.test(info.name)) {
    info.deviceType = 'switch';
    info.isEndpoint = false;
  } else if (!info.name && !info.ip) {
    // Nessuna info - potrebbe essere endpoint senza LLDP
    info.isEndpoint = true;
    info.deviceType = 'unknown';
  }

  return info;
}

/**
 * Verifica se LLDP neighbor è uno switch gestito con IP raggiungibile
 * IMPORTANTE: L2/L3 switch potrebbero non avere IP management nel LLDP
 * ma il naming convention (_L2_, _L3_) è una prova forte che è un switch
 */
function isLldpManagedSwitch(lldpInfo) {
  if (!lldpInfo) return false;
  // Ha IP management e non è un endpoint
  if (lldpInfo.ip && !lldpInfo.isEndpoint) return true;
  // È uno switch L2/L3 per naming convention - continua il trace
  // anche se non ha IP management nel LLDP (verrà trovato via DB)
  if (lldpInfo.name && /_L2_|_L3_/.test(lldpInfo.name)) return true;
  return false;
}

/**
 * Deriva l'IP di uno switch dal suo sysname usando la naming convention:
 * - Pattern: {siteId}_L2_{nome}_{lastOctet} o {siteId}_L3_{nome}_{lastOctet}
 * - Esempio: 03_L2_RackWIFI_30 → 192.168.3.30
 * - Esempio: 10_L2_Rack_CassaCentrale_4 → 192.168.10.4
 * @param {string} sysname - Nome del dispositivo (es. "03_L2_RackWIFI_30")
 * @returns {string|null} IP derivato o null se non riconosciuto
 */
function deriveIpFromSysname(sysname) {
  if (!sysname) return null;
  // Pattern: {siteId}_L2_..._N o {siteId}_L3_..._N dove N è l'ultimo ottetto
  const match = sysname.match(/^(\d+)_L[23]_.*?_(\d+)$/);
  if (!match) return null;
  const siteId = parseInt(match[1], 10);
  const lastOctet = parseInt(match[2], 10);
  if (isNaN(siteId) || isNaN(lastOctet) || lastOctet < 1 || lastOctet > 254) return null;
  // Costruisce l'IP: 10.{siteId}.4.{lastOctet}
  return `10.${siteId}.4.${lastOctet}`;
}

function parseNeighborFromInterfaceDesc(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m =
      line.match(/Description\s*:\s*(\S+)/i) ||
      line.match(/desc\s*[:=]\s*(\S+)/i) ||
      line.match(/Port\s+name\s*:\s*(\S+)/i);
    const val = m ? m[1] : null;
    if (val && /_L2_|_L3_/.test(val)) return val;
  }
  return null;
}

function parseLldpBriefNames(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = new Set();
  for (const line of lines) {
    const m1 = line.match(/has\s+\d+\s+neighbor\(s\):\s*(\S+)/i);
    if (m1 && m1[1]) out.add(m1[1]);
    const m2 = line.match(/Neighbor\s+device\s+name\s*:\s*(\S+)/i);
    if (m2 && m2[1]) out.add(m2[1]);
    const m3 = line.match(/System\s+name\s*:\s*(\S+)/i);
    if (m3 && m3[1]) out.add(m3[1]);
  }
  return Array.from(out);
}

function findInterfaceBriefLine(text, variants) {
  const lines = String(text || '').split(/\r?\n/);
  for (const v of Array.isArray(variants) ? variants : []) {
    for (const line of lines) {
      if (line.includes(v)) return line.trim();
    }
  }
  return null;
}

function vlanIncludesAnyInterface(text, variants) {
  const t = String(text || '');
  for (const v of Array.isArray(variants) ? variants : []) {
    if (v && t.includes(v)) return true;
  }
  return false;
}

function shortenOutput(s, n = 300) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n) + '...';
}

async function runSwitchCommand(host, siteCreds, coreFallback, command, altCredsArray = [], timeoutMs = 30000) {
  let lastError = null;
  console.log('[runSwitchCommand] START host:', host, 'command:', command?.slice(0, 50), 'timeout:', timeoutMs);

  // Determina se questo è lo switch CORE del sito (usa credenziali CORE specifiche)
  const isCoreSwitch = siteCreds?.coreIp && host === siteCreds.coreIp;
  const effectiveUser = isCoreSwitch && siteCreds?.coreUsername ? siteCreds.coreUsername : siteCreds?.username;
  const effectivePass = isCoreSwitch && siteCreds?.corePassword ? siteCreds.corePassword : siteCreds?.password;
  console.log('[runSwitchCommand] isCoreSwitch:', isCoreSwitch, 'effectiveUser:', effectiveUser, 'hasPass:', !!effectivePass, 'altCreds:', altCredsArray?.length || 0);

  // 1. Prova SSH con credenziali appropriate (CORE o sito)
  try {
    if (effectiveUser && effectivePass) {
      console.log('[runSwitchCommand] Trying SSH with effectiveUser:', effectiveUser);
      const out = await switchSsh.executeCommand({ host, username: effectiveUser, password: effectivePass, command, timeout: timeoutMs });
      console.log('[runSwitchCommand] SSH result length:', String(out || '').length);
      if (String(out || '').trim().length > 0) return out;
    }
  } catch (e) { console.log('[runSwitchCommand] SSH error:', e.message); lastError = e; }

  // 1b. Se CORE fallisce, prova con credenziali normali del sito
  try {
    if (isCoreSwitch && siteCreds?.username && siteCreds?.password && siteCreds.username !== effectiveUser) {
      console.log('[runSwitchCommand] CORE failed, trying site creds:', siteCreds.username);
      const out = await switchSsh.executeCommand({ host, username: siteCreds.username, password: siteCreds.password, command, timeout: timeoutMs });
      console.log('[runSwitchCommand] SSH site creds result length:', String(out || '').length);
      if (String(out || '').trim().length > 0) return out;
    }
  } catch (e1b) { console.log('[runSwitchCommand] SSH site creds error:', e1b.message); lastError = e1b; }

  // 1c. Prova credenziali alternative (righe multiple nel CSV)
  const triedUsers = new Set([effectiveUser, siteCreds?.username].filter(Boolean));
  for (const alt of (altCredsArray || [])) {
    if (!alt?.username || !alt?.password) continue;
    if (triedUsers.has(alt.username)) continue;  // Già provato
    triedUsers.add(alt.username);
    try {
      console.log('[runSwitchCommand] Trying alt creds:', alt.username);
      const out = await switchSsh.executeCommand({ host, username: alt.username, password: alt.password, command, timeout: timeoutMs });
      console.log('[runSwitchCommand] SSH alt creds result length:', String(out || '').length);
      if (String(out || '').trim().length > 0) return out;
    } catch (eAlt) { console.log('[runSwitchCommand] SSH alt creds error:', eAlt.message); lastError = eAlt; }
  }

  // 2. Prova SSH con credenziali CORE globali (fallback per .251)
  try {
    if (/\.251$/.test(host) && coreFallback?.username && coreFallback?.password && coreFallback.username !== effectiveUser) {
      console.log('[runSwitchCommand] Trying SSH CORE fallback with:', coreFallback.username);
      const out = await switchSsh.executeCommand({ host, username: coreFallback.username, password: coreFallback.password, command, timeout: timeoutMs });
      console.log('[runSwitchCommand] SSH CORE result length:', String(out || '').length);
      if (String(out || '').trim().length > 0) return out;
    }
  } catch (e2) { console.log('[runSwitchCommand] SSH CORE error:', e2.message); lastError = e2; }

  // 3. Fallback Telnet - prova con credenziali appropriate
  try {
    if (effectiveUser && effectivePass) {
      console.log('[runSwitchCommand] Trying Telnet with effectiveUser:', effectiveUser);
      const out = await switchTelnet.executeCommand({ host, username: effectiveUser, password: effectivePass, command, timeout: timeoutMs });
      console.log('[runSwitchCommand] Telnet result length:', String(out || '').length);
      if (String(out || '').trim().length > 0) return out;
    }
  } catch (e3) { console.log('[runSwitchCommand] Telnet error:', e3.message); lastError = e3; }

  // 4. Fallback Telnet - prova con credenziali CORE globali
  try {
    if (/\.251$/.test(host) && coreFallback?.username && coreFallback?.password) {
      console.log('[runSwitchCommand] Trying Telnet CORE fallback');
      const out = await switchTelnet.executeCommand({ host, username: coreFallback.username, password: coreFallback.password, command, timeout: timeoutMs });
      console.log('[runSwitchCommand] Telnet CORE result length:', String(out || '').length);
      if (String(out || '').trim().length > 0) return out;
    }
  } catch (e4) { console.log('[runSwitchCommand] Telnet CORE error:', e4.message); lastError = e4; }

  console.log('[runSwitchCommand] All attempts failed for host:', host);
  if (lastError) throw lastError;
  return '';
}

async function tryMacCli(host, sshCreds, coreFallback, hyphenMac, altCredsArray = [], timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const cmds = [
    `display mac-address ${hyphenMac}`,
    `display mac-address | include ${hyphenMac}`,
    `display mac-address | include ${String(hyphenMac || '').toUpperCase()}`,
    `display mac-address mac ${hyphenMac}`,
    `display mac-address dynamic | include ${hyphenMac}`,
    `display mac-address verbose | include ${hyphenMac}`,
    `display mac-address dynamic | include ${String(hyphenMac || '').toUpperCase()}`,
    `display mac-address verbose | include ${String(hyphenMac || '').toUpperCase()}`,
  ];
  for (const c of cmds) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log('[tryMacCli] Timeout exceeded for host:', host);
      break;
    }
    try {
      // Use remaining time for the command, but ensure at least 5s for a chance
      const cmdTimeout = Math.max(5000, remaining);
      const out = await runSwitchCommand(host, sshCreds, coreFallback, c, altCredsArray, cmdTimeout);
      if (String(out || '').trim().length > 0) return out;
    } catch {}
  }
  return '';
}

// ========== FUNZIONI SSH PER SOSTITUIRE SNMP ==========

/**
 * Ottiene tutti i neighbor LLDP via SSH
 * @param {string} host - IP dello switch
 * @param {Object} siteCreds - Credenziali del sito
 * @param {Object} coreFallback - Credenziali CORE fallback
 * @returns {Promise<Array>} Array di neighbor con name, ip, localPort, etc
 */
async function getLldpNeighborsSSH(host, siteCreds, coreFallback, altCredsArray = [], timeoutMs = 30000) {
  try {
    const out = await runSwitchCommand(host, siteCreds, coreFallback, 'display lldp neighbor', altCredsArray, timeoutMs);
    if (!out) return [];
    return parseHuaweiLldpNeighbors(out);
  } catch {
    return [];
  }
}

/**
 * Trova l'IP di management di un neighbor LLDP per nome via SSH
 * Sostituisce getNeighborMgmtIpByName SNMP
 */
async function getNeighborMgmtIpByNameSSH(host, neighborName, siteCreds, coreFallback, altCredsArray = [], timeoutMs = 30000) {
  try {
    const neighbors = await getLldpNeighborsSSH(host, siteCreds, coreFallback, altCredsArray, timeoutMs);
    for (const n of neighbors) {
      if (n.sysName && n.sysName.trim() === neighborName) {
        return n.mgmtAddr || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Trova qualsiasi IP di management LLDP che inizia con un prefix via SSH
 * Sostituisce getAnyLldpMgmtIpWithinPrefix SNMP
 */
async function getAnyLldpMgmtIpWithinPrefixSSH(host, prefix, siteCreds, coreFallback, altCredsArray = [], timeoutMs = 30000) {
  try {
    const neighbors = await getLldpNeighborsSSH(host, siteCreds, coreFallback, altCredsArray, timeoutMs);
    console.log(`[getAnyLldpMgmtIpWithinPrefixSSH] host=${host} prefix=${prefix} neighbors=${neighbors?.length || 0}`);
    for (const n of neighbors) {
      console.log(`[getAnyLldpMgmtIpWithinPrefixSSH] checking: name=${n.name} mgmtAddr=${n.mgmtAddr}`);
      if (n.mgmtAddr && n.mgmtAddr.startsWith(prefix)) {
        console.log(`[getAnyLldpMgmtIpWithinPrefixSSH] MATCH: ${n.mgmtAddr}`);
        return n.mgmtAddr;
      }
    }
    console.log(`[getAnyLldpMgmtIpWithinPrefixSSH] no match found`);
    return null;
  } catch (err) {
    console.log(`[getAnyLldpMgmtIpWithinPrefixSSH] error: ${err.message}`);
    return null;
  }
}

/**
 * Trova il miglior neighbor L2 nel sito via SSH
 * Sostituisce getBestL2NeighborInSite SNMP
 */
async function getBestL2NeighborInSiteSSH(host, siteCreds, coreFallback, findDeviceIp, altCredsArray = [], timeoutMs = 30000) {
  try {
    const neighbors = await getLldpNeighborsSSH(host, siteCreds, coreFallback, altCredsArray, timeoutMs);
    for (const n of neighbors) {
      if (n.sysName && /_L2_/.test(n.sysName)) {
        const ip = n.mgmtAddr || (findDeviceIp ? findDeviceIp(n.sysName) : null);
        if (ip) return { name: n.sysName, ip };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ottiene il sysname via SSH
 * Sostituisce getSysName SNMP
 */
async function getSysNameSSH(host, siteCreds, coreFallback, altCredsArray = [], timeoutMs = 30000) {
  try {
    const out = await runSwitchCommand(host, siteCreds, coreFallback, 'display current-configuration | include sysname', altCredsArray, timeoutMs);
    if (!out) return null;
    const match = out.match(/sysname\s+(\S+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * IP FABRIC STYLE: Recursive LLDP Trace
 * Segue il path LLDP dal core switch fino all'endpoint (porta senza LLDP neighbor)
 *
 * @param {string} startDevice - Nome device di partenza (es. 09_L3_S6730_251)
 * @param {string} startPort - Porta di partenza (es. XGi1/0/34)
 * @param {string} hyphenMac - MAC in formato Huawei (xxxx-xxxx-xxxx)
 * @param {object} siteCreds - Credenziali sito
 * @param {object} coreFallback - Credenziali fallback
 * @param {array} altCredsArray - Credenziali alternative
 * @param {number} maxHops - Massimo numero di hop (default 5)
 * @returns {object} - { endpoint: {device, port, vlan}, path: [...], found: boolean }
 */
async function recursiveLldpTrace(startDevice, startPort, hyphenMac, siteCreds, coreFallback, altCredsArray = [], maxHops = 5) {
  const path = [];
  let currentDevice = startDevice;
  let currentPort = startPort;
  let hops = 0;

  console.log(`[LLDP-TRACE] Starting recursive trace from ${startDevice}:${startPort} for MAC ${hyphenMac}`);

  try {
    const nedi = await getNedi();
    if (!nedi) {
      console.log(`[LLDP-TRACE] NeDi not available`);
      return { endpoint: null, path, found: false, error: 'NeDi not available' };
    }

    while (hops < maxHops) {
      hops++;
      console.log(`[LLDP-TRACE] Hop ${hops}: ${currentDevice}:${currentPort}`);

      // Normalizza il nome porta per la query LLDP (rimuovi prefisso GE/XGE/Gi/XGi)
      const portSuffix = currentPort.replace(/^(Gi|XGi|GE|XGE|GigabitEthernet|XGigabitEthernet)/i, '');

      // Trova LLDP neighbor sulla porta corrente
      const lldpQuery = await nedi.execQuery(`
        SELECT neighbor, ifname FROM links
        WHERE device = ? AND (ifname LIKE ? OR ifname LIKE ? OR ifname LIKE ? OR ifname LIKE ?)
        LIMIT 1
      `, [currentDevice, `%${portSuffix}`, `Gi${portSuffix}`, `GE${portSuffix}`, `XGi${portSuffix}`]);

      if (!lldpQuery || lldpQuery.length === 0) {
        // Nessun LLDP neighbor = ENDPOINT TROVATO (access port)
        console.log(`[LLDP-TRACE] No LLDP neighbor on ${currentDevice}:${currentPort} → ENDPOINT`);
        path.push({ device: currentDevice, port: currentPort, type: 'endpoint', hop: hops });
        return {
          endpoint: { device: currentDevice, port: currentPort },
          path,
          found: true,
          reason: 'no-lldp-neighbor'
        };
      }

      const neighbor = lldpQuery[0].neighbor;
      console.log(`[LLDP-TRACE] LLDP neighbor: ${neighbor}`);

      // Se neighbor non è uno switch L2/L3, è un endpoint (es. AP, telefono, server)
      if (!/_L2_|_L3_|_SA_L2_/i.test(neighbor)) {
        console.log(`[LLDP-TRACE] Neighbor ${neighbor} is not a switch → ENDPOINT DEVICE`);
        path.push({ device: currentDevice, port: currentPort, neighbor, type: 'endpoint-device', hop: hops });
        return {
          endpoint: { device: currentDevice, port: currentPort, connectedDevice: neighbor },
          path,
          found: true,
          reason: 'non-switch-neighbor'
        };
      }

      // Neighbor è uno switch, aggiungi al path e continua
      path.push({ device: currentDevice, port: currentPort, neighbor, type: 'transit', hop: hops });

      // Cerca l'IP dello switch neighbor nel DB locale
      const neighborInfo = db.db.prepare(`
        SELECT ip, sysname FROM devices WHERE sysname = ? OR sysname LIKE ?
      `).get(neighbor, `%${neighbor}%`);

      if (!neighborInfo?.ip) {
        console.log(`[LLDP-TRACE] Cannot find IP for neighbor ${neighbor}`);
        return {
          endpoint: { device: neighbor, port: null, note: 'IP not found in local DB' },
          path,
          found: false,
          reason: 'neighbor-ip-not-found'
        };
      }

      // Cerca il MAC sulla FDB dello switch neighbor via SSH
      console.log(`[LLDP-TRACE] Searching MAC on ${neighbor} (${neighborInfo.ip})...`);
      const fdbResult = await findMacInFdbSSH(neighborInfo.ip, hyphenMac, siteCreds, coreFallback, altCredsArray, 25000);

      if (!fdbResult?.ifName) {
        console.log(`[LLDP-TRACE] MAC not found in FDB of ${neighbor} - may be inactive`);
        return {
          endpoint: { device: neighbor, port: null, note: 'MAC not in FDB - possibly inactive' },
          path,
          found: false,
          reason: 'mac-not-in-fdb'
        };
      }

      console.log(`[LLDP-TRACE] MAC found on ${neighbor}:${fdbResult.ifName}`);

      // Aggiorna per il prossimo hop
      currentDevice = neighbor;
      currentPort = fdbResult.ifName;
    }

    console.log(`[LLDP-TRACE] Max hops (${maxHops}) reached`);
    return {
      endpoint: { device: currentDevice, port: currentPort },
      path,
      found: false,
      reason: 'max-hops-reached'
    };

  } catch (err) {
    console.log(`[LLDP-TRACE] Error: ${err.message}`);
    return { endpoint: null, path, found: false, error: err.message };
  }
}

/**
 * Trova MAC nella FDB via SSH
 * Sostituisce findMacInFdb SNMP - ritorna direttamente ifName e vlan
 */
async function findMacInFdbSSH(host, hyphenMac, siteCreds, coreFallback, altCredsArray = [], timeoutMs = 30000) {
  try {
    const out = await tryMacCli(host, siteCreds, coreFallback, hyphenMac, altCredsArray, timeoutMs);
    if (!out) return null;
    const ifName = parseInterfaceFromMacOutput(out);
    const vlan = parseVlanFromMacOutput(out);
    console.log(`[MAC-FDB-SSH] ${host} MAC=${hyphenMac} → ifName=${ifName} vlan=${vlan}`);
    console.log(`[MAC-FDB-SSH] Raw output:`, String(out).replace(/\r?\n/g, ' | ').substring(0, 500));
    if (!ifName) return null;
    return { ifName, vlan, source: 'ssh' };
  } catch {
    return null;
  }
}

// ========== FINE FUNZIONI SSH ==========

/**
 * Esegue il trace SSH completo per un MAC
 */
async function runSshTrace(mac, network, startIp, timeoutMs = 45000) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  console.log('[SSH-TRACE-LIB] Starting trace for', mac, 'in', network, 'timeout:', timeoutMs);
  
  const cleanMac = mac.replace(/[:\-.]/g, '').toLowerCase();
  const hyphenMac = formatMacHyphen(mac);
  const parts = network.split('/')[0].split('.');
  const coreIp = `${parts[0]}.${parts[1]}.${parts[2]}.251`;
  const siteKey = String(parts[1]);
  
  const credsMap = loadCsvCredentials();
  const siteCredsArray = credsMap.byNetwork.get(network) || credsMap.bySite.get(siteKey) || [];
  const siteCreds = siteCredsArray[0] || null;
  const coreFallback = credsMap.coreFallback || null;
  
  const path = [];
  let currentIp = startIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(startIp) ? startIp : coreIp;
  let hops = 0;
  let endpoint = null;

  const findDeviceIp = (sysName) => {
    try {
      if (!sysName) return null;
      const row = db.db.prepare('SELECT ip FROM devices WHERE sysname = ? OR sysname LIKE ?').get(sysName, `%${sysName}%`);
      return row?.ip || null;
    } catch (_) { return null; }
  };

  while (hops < 10) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.log('[SSH-TRACE-LIB] Timeout exceeded after', hops, 'hops');
      endpoint = {
        ...path[path.length - 1],
        warning: 'Timeout trace: risultato parziale'
      };
      break;
    }

    console.log('[SSH-TRACE-LIB] Hop', hops, 'currentIp:', currentIp);
    let sshCreds = siteCreds;
    if (!sshCreds && /\.251$/.test(currentIp)) sshCreds = coreFallback || null;
    const sshCredsAlt = siteCredsArray.slice(1);

    const sysName = await getSysNameSSH(currentIp, sshCreds, coreFallback, sshCredsAlt, remaining);
    const fdb = await findMacInFdbSSH(currentIp, hyphenMac, sshCreds, coreFallback, sshCredsAlt, remaining);
    const ifName = fdb?.ifName || null;
    const vlan = fdb?.vlan || null;

    const hop = { ip: currentIp, sysName, ifName, vlan };
    path.push(hop);
    hops++;

    if (!ifName && !sysName) {
      hop.connectionFailed = true;
      try {
        const dev = db.db.prepare('SELECT id, sysname FROM devices WHERE ip = ?').get(currentIp);
        if (dev) {
          hop.sysName = dev.sysname;
          const links = db.db.prepare('SELECT local_ifname, remote_sysname FROM links WHERE device_id = ?').all(dev.id);
          for (const link of links) {
            if (!/_L2_|_L3_/.test(link.remote_sysname)) continue;
            const neighborDev = db.db.prepare('SELECT ip FROM devices WHERE sysname = ?').get(link.remote_sysname);
            if (!neighborDev?.ip) continue;
            const neighborFdb = await findMacInFdbSSH(neighborDev.ip, hyphenMac, sshCreds, coreFallback, sshCredsAlt, remaining);
            if (neighborFdb?.ifName) {
              hop.ifName = link.local_ifname;
              hop.lldpNeighbor = link.remote_sysname;
              hop.nextHop = neighborDev.ip;
              currentIp = neighborDev.ip;
              break;
            }
          }
          if (hop.nextHop) continue;
        }
      } catch (_) {}
    }

    let nextHop = null;
    if (sshCreds && hyphenMac) {
      try {
        const cliIf = ifName;
        const cliVlan = vlan;
        if (cliVlan && hop && !hop.vlan) hop.vlan = cliVlan;
        
        if (cliIf && /eth-?trunk/i.test(cliIf)) {
          const trunkNum = (cliIf.match(/eth-?trunk\s*(\d+)/i) || cliIf.match(/Eth-?Trunk(\d+)/i))?.[1];
          if (trunkNum) {
            const trunkOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display eth-trunk ${trunkNum}`, sshCredsAlt, remaining);
            const members = parseTrunkMembers(trunkOut);
            const sitePrefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
            for (const m of members) {
              const nOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor interface ${m}`, sshCredsAlt, remaining);
              const nName = parseLldpNeighborName(nOut);
              const nIp = parseLldpNeighborIp(nOut);
              if (nIp && nIp.startsWith(sitePrefix)) { nextHop = nIp; break; }
              if (nName && !nextHop) {
                const mgmtIp = await getNeighborMgmtIpByNameSSH(currentIp, nName, sshCreds, coreFallback, sshCredsAlt, remaining);
                if (mgmtIp) { nextHop = mgmtIp; break; }
                if (!nextHop) {
                  const dbIp = findDeviceIp(nName);
                  if (dbIp) { nextHop = dbIp; break; }
                }
              }
              if (!nextHop) {
                const iOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display interface ${m}`, sshCredsAlt, remaining);
                const iName = parseNeighborFromInterfaceDesc(iOut);
                if (iName) {
                  const dbIp2 = findDeviceIp(iName);
                  if (dbIp2) { nextHop = dbIp2; break; }
                }
              }
            }
            if (!nextHop) {
              const best = await getBestL2NeighborInSiteSSH(currentIp, sshCreds, coreFallback, findDeviceIp, sshCredsAlt, remaining);
              if (best?.ip) nextHop = best.ip;
              if (best?.name) hop.lldpNeighbor = best.name;
            }
          }
        } else if (cliIf && !/eth-?trunk/i.test(cliIf)) {
          let lOut = '';
          let lldpInfo = null;
          try {
            const variants = interfaceCommandVariants(cliIf);
            for (const v of variants) {
              lOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor interface ${v}`, sshCredsAlt, remaining);
              if (lOut && lOut.includes('neighbor')) {
                lldpInfo = parseLldpFullInfo(lOut);
                if (lldpInfo.name || lldpInfo.ip) break;
              }
            }
          } catch (_) {}

          if (lldpInfo && isLldpManagedSwitch(lldpInfo)) {
            let nh = lldpInfo.ip;
            if (!nh && lldpInfo.name) {
              nh = await getNeighborMgmtIpByNameSSH(currentIp, lldpInfo.name, sshCreds, coreFallback, sshCredsAlt, remaining);
              if (!nh) nh = findDeviceIp(lldpInfo.name);
              if (!nh) nh = deriveIpFromSysname(lldpInfo.name);
            }
            if (nh) {
              hop.ifName = cliIf;
              hop.lldpNeighbor = lldpInfo.name;
              hop.nextHop = nh;
              currentIp = nh;
              continue;
            }
          }

          if (lldpInfo && lldpInfo.isEndpoint) {
            endpoint = {
              ...hop,
              ifName: cliIf,
              lldpNeighbor: lldpInfo.name || undefined,
              endpointDevice: lldpInfo.name || undefined,
              endpointIp: lldpInfo.ip || undefined,
              endpointMac: lldpInfo.chassisId || undefined,
              endpointType: lldpInfo.deviceType || undefined,
              capabilities: lldpInfo.capabilities || []
            };
            break;
          }

          if (!lldpInfo || (!lldpInfo.name && !lldpInfo.ip)) {
            try {
              const briefOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor brief`, sshCredsAlt, remaining);
              const names = parseLldpBriefNames(briefOut);
              const siteId2 = String(parts[1]).padStart(2, '0');
              const sitePrefix = `${siteId2}_L2_`;
              for (const nm of names) {
                if (!/_L2_|_L3_/.test(nm)) continue;
                if (!nm.startsWith(sitePrefix) && !nm.includes(sitePrefix)) continue;
                let ipCand = await getNeighborMgmtIpByNameSSH(currentIp, nm, sshCreds, coreFallback, sshCredsAlt, remaining);
                if (!ipCand) ipCand = findDeviceIp(nm);
                if (ipCand) {
                  hop.ifName = cliIf;
                  hop.lldpNeighbor = nm;
                  hop.nextHop = ipCand;
                  currentIp = ipCand;
                  break;
                }
              }
              if (hop.nextHop) continue;
            } catch (_) {}

            let dName = null;
            const variants = interfaceCommandVariants(cliIf);
            for (const v of variants) {
              try {
                const dOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display interface ${v}`, sshCredsAlt, remaining);
                dName = parseNeighborFromInterfaceDesc(dOut);
                if (dName) break;
              } catch (_) {}
            }
            const dIp = dName ? findDeviceIp(dName) : null;
            if (dIp) {
              hop.ifName = cliIf;
              hop.lldpNeighbor = dName;
              hop.nextHop = dIp;
              currentIp = dIp;
              continue;
            }
          }

          if (!hop.nextHop) {
            endpoint = {
              ...hop,
              ifName: cliIf,
              lldpNeighbor: lldpInfo?.name || undefined,
              endpointDevice: lldpInfo?.name || undefined,
              endpointType: 'unknown'
            };
            break;
          }
        }
      } catch (_) {}
    }
    
    if (!nextHop && ifName && /eth-?trunk/i.test(ifName)) {
      try {
        const siteId2 = String(parts[1]).padStart(2, '0');
        const sitePrefix = `${siteId2}_L2_`;
        const candidates = db.db.prepare('SELECT ip, sysname FROM devices WHERE sysname LIKE ?').all(`${sitePrefix}%`) || [];
        for (const cand of candidates) {
          if (!cand?.ip) continue;
          const fdbResult = await findMacInFdbSSH(cand.ip, hyphenMac, siteCreds, coreFallback, sshCredsAlt, remaining);
          if (fdbResult?.ifName) {
            nextHop = cand.ip;
            hop.lldpNeighbor = cand.sysname;
            break;
          }
        }
      } catch (_) {}
    }
    
    if (!nextHop) {
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      const mgmt = await getAnyLldpMgmtIpWithinPrefixSSH(currentIp, prefix, sshCreds, coreFallback, sshCredsAlt, remaining);
      if (mgmt) {
        hop.nextHop = mgmt;
        currentIp = mgmt;
        continue;
      }
      
      try {
        const siteId2 = String(parts[1]).padStart(2, '0');
        const forced = db.db.prepare('SELECT ip, sysname FROM devices WHERE sysname = ?').get(`${siteId2}_L2_Rack0_8`);
        if (forced?.ip) {
          hop.lldpNeighbor = forced.sysname;
          hop.nextHop = forced.ip;
          currentIp = forced.ip;
          continue;
        }
      } catch (_) {}
      
      endpoint = hop;
      break;
    }
    
    if (nextHop) {
      hop.nextHop = nextHop;
      if (nextHop !== currentIp) currentIp = nextHop;
    }
  }

  return {
    query: mac,
    normalized: cleanMac,
    network,
    coreSwitch: coreIp,
    elapsed: `${Date.now() - t0}ms`,
    hops: path.length,
    found: !!endpoint,
    endpoint,
    path
  };
}

app.post('/api/search/mac/trace-ssh', async (req, res) => {
  const t0 = Date.now();
  console.log('[TRACE-SSH] Request received:', JSON.stringify(req.body || {}));
  try {
    const { mac, network, startIp } = req.body || {};
    if (!mac) return res.status(400).json({ error: 'MAC richiesto' });
    if (!network) return res.status(400).json({ error: 'Network CIDR richiesto' });

    const result = await runSshTrace(mac, network, startIp);
    
    // Compattazione path per output pulito
    const pathCompact = compactPath(result.path);
    result.path = pathCompact;
    result.hops = pathCompact.length;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// MAC TRACKER V2 - RICERCA ISTANTANEA + REFRESH PROGRESSIVO
// Fase 1: Query parallele DB (0-500ms) → risultato immediato
// Fase 2: SSH trace in background → update live
// =============================================================================
app.post('/api/search/mac/instant', async (req, res) => {
  const t0 = Date.now();
  console.log('[MAC-INSTANT] Request received:', JSON.stringify(req.body || {}));

  try {
    const { mac, network, liveRefresh = false } = req.body || {};

    if (!mac) return res.status(400).json({ error: 'MAC richiesto' });

    const cleanMac = mac.replace(/[:\-.]/g, '').toLowerCase();
    if (cleanMac.length < 6) {
      return res.status(400).json({ error: 'MAC troppo corto (min 6 caratteri)' });
    }

    const normalizedMac = cleanMac.length === 12
      ? cleanMac.match(/.{2}/g).join(':')
      : cleanMac;

    // =========================================================================
    // FASE 1: Query IP Fabric DB (fonte primaria, ~10-50ms)
    // =========================================================================
    console.log('[MAC-INSTANT] Trying IP Fabric DB first...');
    const ipfResult = await searchMacIpFabric(mac);

    if (ipfResult && ipfResult.found) {
      // Aggiungi vendor info se mancante
      if (!ipfResult.vendor?.name || ipfResult.vendor?.name === null) {
        try {
          const ouiResult = await lookupOui(cleanMac);
          if (ouiResult.found) {
            ipfResult.vendor = { name: ouiResult.vendor, oui: ouiResult.oui };
          }
        } catch (e) { /* ignore */ }
      }
      ipfResult.elapsed = `${Date.now() - t0}ms`;
      console.log(`[MAC-INSTANT] Found in IP Fabric DB in ${ipfResult.elapsed}`);
      return res.json(ipfResult);
    }

    // =========================================================================
    // FASE 2 (FALLBACK): Query NeDi (se non trovato in IP Fabric)
    // =========================================================================
    console.log('[MAC-INSTANT] Not in IP Fabric, falling back to NeDi...');
    const nedi = await getNedi();
    if (!nedi) {
      return res.status(404).json({
        found: false,
        query: mac,
        normalized: normalizedMac,
        source: 'ip-fabric-db',
        message: 'MAC non trovato',
        elapsed: `${Date.now() - t0}ms`
      });
    }

    // Usa il metodo aggregato searchMacInstant
    const nediResult = await nedi.searchMacInstant(mac);

    // Aggiungi vendor info usando lookupOui (lazy-loaded)
    let vendorInfo = { name: 'Unknown', oui: cleanMac.substring(0, 6).toUpperCase() };
    try {
      const ouiResult = await lookupOui(cleanMac);
      if (ouiResult.found) {
        vendorInfo = { name: ouiResult.vendor, oui: ouiResult.oui };
      }
    } catch (e) { /* ignore */ }

    // Costruisci path dalla lista switch
    const path = (nediResult.allSwitches || []).map((sw, idx) => ({
      hop: idx + 1,
      switch: sw.switch,
      ip: sw.ip,
      port: sw.port,
      vlan: sw.vlan,
      macCount: sw.macCount,
      isEndpoint: sw.isEndpoint
    }));

    const elapsed = `${Date.now() - t0}ms`;

    const result = {
      query: mac,
      normalized: normalizedMac,
      network: network || null,
      phase: 'db',
      elapsed,
      timestamp: Date.now(),
      found: nediResult.found,
      source: 'nedi',

      // Posizione attuale
      endpoint: nediResult.endpoint ? {
        switch: nediResult.endpoint.switch,
        switchIp: nediResult.endpoint.switchIp,
        port: nediResult.endpoint.port,
        vlan: nediResult.endpoint.vlan,
        macCount: nediResult.endpoint.macCount,
        portType: nediResult.endpoint.portType,
        source: 'nedi'
      } : null,

      // ARP/IP info
      arpInfo: nediResult.arpInfo,

      // Vendor
      vendor: vendorInfo,

      // LLDP details
      lldpInfo: nediResult.endpoint?.lldpInfo || null,

      // Tutti gli switch
      allSwitches: nediResult.allSwitches || [],

      // Storico
      history: nediResult.history || [],

      // VLAN history
      vlanHistory: nediResult.vlanHistory || [],

      // Path
      path
    };

    // =========================================================================
    // FASE 2: SSH lookup se:
    // - Trovato solo su interfacce virtuali, OPPURE
    // - liveRefresh richiesto per aggiornare dati dal DB
    // =========================================================================
    const hasOnlyVirtualInterfaces = result.found &&
      result.allSwitches.length > 0 &&
      result.allSwitches.every(sw => sw.isVirtual === true);

    // SSH lookup OPZIONALE - solo se liveRefresh=true
    // Default: restituisce dati NeDi istantaneamente (~50ms)
    // Con liveRefresh=true: verifica porta via SSH (~20-30s)
    const shouldDoSshLookup = liveRefresh && result.found && result.endpoint?.switchIp;

    if (shouldDoSshLookup) {
      console.log(`[MAC-INSTANT] SSH lookup su ${result.endpoint.switchIp} (virtual=${hasOnlyVirtualInterfaces}, verifyPort=true)`);

      try {
        // Converti MAC in formato Huawei (xxxx-xxxx-xxxx)
        const hyphenMac = cleanMac.match(/.{4}/g)?.join('-') || cleanMac;

        // Ottieni credenziali SSH dal CSV
        const switchIp = result.endpoint.switchIp;
        const ipParts = switchIp.split('.');
        const siteKey = ipParts[1] || '';
        const networkPrefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/24`;

        const credsMap = loadCsvCredentials();
        const siteCredsArray = credsMap.byNetwork.get(networkPrefix) || credsMap.bySite.get(siteKey) || [];
        const sshCreds = siteCredsArray[0] || null;
        const sshCredsAlt = siteCredsArray.slice(1);
        const coreFallback = credsMap.coreFallback || null;

        // Esegui comando MAC address
        const macOut = await tryMacCli(result.endpoint.switchIp, sshCreds, coreFallback, hyphenMac, sshCredsAlt, 25000);

        if (macOut) {
          const physicalPort = parseInterfaceFromMacOutput(macOut);
          const vlan = parseVlanFromMacOutput(macOut);

          console.log(`[MAC-INSTANT] SSH result: port=${physicalPort}, vlan=${vlan}`);

          if (physicalPort) {
            // Aggiorna endpoint con porta fisica
            result.endpoint.port = physicalPort;
            result.endpoint.source = 'ssh';
            result.sshLookup = true;

            // Aggiorna anche allSwitches
            if (result.allSwitches[0]) {
              result.allSwitches[0].port = physicalPort;
              result.allSwitches[0].isVirtual = false;
            }

            // Aggiorna path
            if (result.path[0]) {
              result.path[0].port = physicalPort;
            }
          }

          if (vlan) {
            result.endpoint.vlan = vlan;
            if (result.allSwitches[0]) result.allSwitches[0].vlan = vlan;
            if (result.path[0]) result.path[0].vlan = vlan;
          }

          // Se VLAN non trovata, prova comando specifico sulla porta
          if (!vlan && physicalPort) {
            try {
              // Normalizza nome porta per comando Huawei
              const portName = normalizeInterfaceName(physicalPort);
              const portVlanCmd = `display port vlan ${portName}`;
              console.log(`[MAC-INSTANT] Cercando VLAN con: ${portVlanCmd}`);

              const portVlanOut = await runSwitchCommand(switchIp, sshCreds, coreFallback, portVlanCmd, sshCredsAlt);

              // Parse PVID dalla risposta (cerca "PVID: X" o prima riga con numero dopo la porta)
              const pvidMatch = String(portVlanOut || '').match(/PVID\s*:?\s*(\d+)/i) ||
                               String(portVlanOut || '').match(/default\s+vlan\s*:?\s*(\d+)/i) ||
                               String(portVlanOut || '').match(/^\s*\d+\s+(\d+)/m);

              if (pvidMatch) {
                const portVlan = parseInt(pvidMatch[1]);
                console.log(`[MAC-INSTANT] VLAN trovata da port vlan: ${portVlan}`);
                result.endpoint.vlan = portVlan;
                if (result.allSwitches[0]) result.allSwitches[0].vlan = portVlan;
                if (result.path[0]) result.path[0].vlan = portVlan;
              } else {
                // Fallback: prova display interface per PVID
                const ifCmd = `display interface ${portName} | include PVID`;
                const ifOut = await runSwitchCommand(switchIp, sshCreds, coreFallback, ifCmd, sshCredsAlt);
                const ifPvidMatch = String(ifOut || '').match(/PVID\s*:?\s*(\d+)/i);
                if (ifPvidMatch) {
                  const ifVlan = parseInt(ifPvidMatch[1]);
                  console.log(`[MAC-INSTANT] VLAN trovata da interface: ${ifVlan}`);
                  result.endpoint.vlan = ifVlan;
                  if (result.allSwitches[0]) result.allSwitches[0].vlan = ifVlan;
                  if (result.path[0]) result.path[0].vlan = ifVlan;
                }
              }
            } catch (vlanErr) {
              console.log(`[MAC-INSTANT] VLAN lookup failed: ${vlanErr.message}`);
            }
          }
        }
      } catch (sshErr) {
        console.log(`[MAC-INSTANT] SSH lookup failed: ${sshErr.message}`);
        result.sshLookupError = sshErr.message;
      }
    }

    // Se liveRefresh richiesto e non trovato in DB, avvia SSH trace
    if (liveRefresh && !result.found && network) {
      result.liveRefreshPending = true;
      result.message = 'Live refresh disponibile via /api/search/mac/hybrid';
    }

    result.elapsed = `${Date.now() - t0}ms`;
    console.log(`[MAC-INSTANT] Completed in ${result.elapsed} - found=${result.found} sshLookup=${result.sshLookup || false}`);
    res.json(result);

  } catch (err) {
    console.error('[MAC-INSTANT] Error:', err);
    res.status(500).json({ error: err.message, elapsed: `${Date.now() - t0}ms` });
  }
});

// =============================================================================
// RICERCA MAC IBRIDA: DB locale (~1ms) → NeDi remoto (~50ms) → SSH (~30-60s)
// Priorità: velocità massima con fallback progressivi
// =============================================================================
app.post('/api/search/mac/hybrid', async (req, res) => {
  const t0 = Date.now();
  console.log('[MAC-HYBRID] Request received:', JSON.stringify(req.body || {}));

  try {
    const { mac, network, site, skipDb = false, skipSsh = false, vlan } = req.body || {};

    if (!mac) return res.status(400).json({ error: 'MAC richiesto' });

    const cleanMac = mac.replace(/[:\-.]/g, '').toLowerCase();
    if (cleanMac.length !== 12 || !/^[0-9a-f]{12}$/.test(cleanMac)) {
      return res.status(400).json({ error: 'MAC non valido (12 caratteri esadecimali)' });
    }

    // Normalizza MAC per output
    const normalizedMac = cleanMac.match(/.{2}/g).join(':');
    let result = {
      query: mac,
      normalized: normalizedMac,
      network: network || null,
      source: null,
      dbResult: null,
      sshResult: null,
      found: false,
      elapsed: null
    };

    // =========================================================================
    // FASE 0: Query IP Fabric DB (fonte primaria PostgreSQL)
    // =========================================================================
    if (!skipDb) {
      console.log('[MAC-HYBRID] Trying IP Fabric DB first...');
      const ipfResult = await searchMacIpFabric(normalizedMac);
      
      if (ipfResult && ipfResult.found) {
        console.log('[MAC-HYBRID] Found in IP Fabric DB');
        // Map to hybrid response format
        result.found = true;
        result.source = 'ip-fabric-db';
        result.endpoint = ipfResult.endpoint;
        result.vendor = ipfResult.vendor;
        result.ip = ipfResult.ip;
        result.ipAddresses = ipfResult.ipAddresses;
        result.lldpInfo = ipfResult.lldpInfo;
        result.wifiAccessPoint = ipfResult.wifiAccessPoint;
        result.isEdgePort = ipfResult.isEdgePort;
        result.lastSeen = ipfResult.lastSeen;
        result.elapsed = Date.now() - t0 + 'ms';
        return res.json(result);
      }
      console.log('[MAC-HYBRID] Not in IP Fabric, falling back to NeDi...');
    }

    // =========================================================================
    // FASE 1: Ricerca NeDi DB remoto (FALLBACK)
    // =========================================================================
    if (!skipDb) {
      const t1 = Date.now();
      try {
        const nedi = await getNedi();
        if (nedi) {
          const filters = {};
          if (site) filters.site = site;
          if (vlan) filters.vlan = vlan;

          const nediResult = await nedi.searchMac(mac, 50, filters);
          console.log(`[MAC-HYBRID] NeDi remote: ${nediResult.totalCount} results in ${Date.now() - t1}ms`);

          if (nediResult.totalCount > 0) {
            result.dbResult = nediResult;
            result.source = 'nedi-db';
            result.found = true;

            // Estrai l'endpoint più probabile - ESCLUDI uplink (Eth-Trunk, molti MAC) e ordina per macCount
            if (nediResult.nodes?.data?.length > 0) {
              // Filtra uplink e ordina per macCount ASC (meno MAC = access port = endpoint reale)
              const candidates = nediResult.nodes.data
                .filter(n => !/eth-?trunk/i.test(n.interface))  // escludi Eth-Trunk
                .sort((a, b) => (a.macCount || 999) - (b.macCount || 999));  // ordina per meno MAC first

              const best = candidates[0] || nediResult.nodes.data[0];  // fallback al primo se tutti filtrati
              console.log(`[MAC-HYBRID] Endpoint selection: ${nediResult.nodes.data.length} candidati, best=${best.device}:${best.interface} (macCount=${best.macCount})`);
              result.endpoint = {
                device: best.device,
                deviceIp: best.device_ip,
                ifName: best.interface,
                vlan: best.vlan,
                vendor: best.vendor,
                source: 'nedi-nodes'
              };

              // ENDPOINT TRACING: Cerca su switch L2 se:
              // 1. macCount è alto (>50) = probabilmente uplink
              // 2. Device è un L3/Core switch = SEMPRE cerca su L2 downstream
              const MAC_COUNT_UPLINK_THRESHOLD = 50;
              const isL3CoreSwitch = (deviceName) => {
                const name = (deviceName || '').toLowerCase();
                return name.includes('_l3_') || name.includes('l3_') ||
                       name.includes('core') || name.includes('s67') || name.includes('s77');
              };
              const shouldSearchL2 = (best.macCount > MAC_COUNT_UPLINK_THRESHOLD) || isL3CoreSwitch(best.device);

              if (shouldSearchL2 && best.device_ip) {
                const reason = isL3CoreSwitch(best.device) ? `L3/Core switch (${best.device})` : `macCount=${best.macCount} > ${MAC_COUNT_UPLINK_THRESHOLD}`;
                console.log(`[MAC-HYBRID] ${reason}, searching L2 switches in parallel...`);
                try {
                  const hyphenMac = formatMacHyphen(mac);
                  const credsMap = loadCsvCredentials();
                  const ipParts = best.device_ip.split('.');
                  const siteKey = ipParts.length >= 2 ? String(ipParts[1]) : null;
                  const siteId2 = String(siteKey).padStart(2, '0');

                  // Ottieni credenziali sito
                  const siteCredsArray = siteKey ? (credsMap.bySite.get(siteKey) || []) : [];
                  const siteCreds = siteCredsArray[0] || null;
                  const sshCredsAlt = siteCredsArray.slice(1);
                  const coreFallback = credsMap.coreFallback || null;

                  // Ottieni tutti gli switch L2 del sito dal DB locale
                  // Pattern multipli: XX_L2_*, XX_SA_L2_*, XX_L2%, etc.
                  const l2Switches = db.db.prepare(`
                    SELECT ip, sysname FROM devices
                    WHERE (sysname LIKE ? OR sysname LIKE ? OR sysname LIKE ?)
                      AND sysname NOT LIKE '%L3%'
                      AND ip IS NOT NULL
                  `).all(`${siteId2}_L2_%`, `${siteId2}_SA_L2_%`, `${siteId2}_%_L2_%`) || [];

                  console.log(`[MAC-HYBRID] Found ${l2Switches.length} L2 switches for site ${siteId2}`);

                  if (l2Switches.length > 0) {
                    // Cerca il MAC in batch paralleli di 5 switch (evita saturazione SSH)
                    const BATCH_SIZE = 5;
                    const allResults = [];

                    for (let i = 0; i < l2Switches.length; i += BATCH_SIZE) {
                      const batch = l2Switches.slice(i, i + BATCH_SIZE);
                      console.log(`[MAC-HYBRID] Searching batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(l2Switches.length/BATCH_SIZE)}: ${batch.map(s => s.ip).join(', ')}`);

                      const batchPromises = batch.map(async (sw) => {
                        try {
                          const fdbResult = await findMacInFdbSSH(sw.ip, hyphenMac, siteCreds, coreFallback, sshCredsAlt, 25000);
                          if (fdbResult?.ifName) {
                            // IP FABRIC QUICK WIN #1: Check LLDP neighbor (uplink detection)
                            // Se la porta ha un neighbor LLDP, è sicuramente un uplink
                            let hasLldpNeighbor = false;
                            try {
                              const nedi = await getNedi();
                              if (nedi) {
                                const neighbors = await nedi.execQuery(`
                                  SELECT neighbor FROM links
                                  WHERE device = ? AND ifname = ? AND neighbor IS NOT NULL
                                  LIMIT 1
                                `, [sw.sysname, fdbResult.ifName]);
                                hasLldpNeighbor = neighbors && neighbors.length > 0;
                                if (hasLldpNeighbor) {
                                  console.log(`[MAC-HYBRID] ${sw.sysname}:${fdbResult.ifName} has LLDP neighbor → UPLINK`);
                                }
                              }
                            } catch (e) {
                              console.log(`[MAC-HYBRID] LLDP check failed for ${sw.sysname}: ${e.message}`);
                            }

                            // Conta quanti MAC ci sono su questa porta usando display mac-address dynamic
                            // (Huawei non supporta | count)
                            let portMacCount = 999;
                            try {
                              const macListResult = await runSwitchCommand(sw.ip, siteCreds, coreFallback,
                                `display mac-address dynamic`, sshCredsAlt, 15000);
                              if (macListResult) {
                                // Conta le righe che contengono la porta e un MAC valido
                                const portPattern = new RegExp(fdbResult.ifName.replace(/\//g, '\\/'), 'i');
                                const macLines = macListResult.split('\n').filter(l =>
                                  portPattern.test(l) && /[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(l)
                                );
                                portMacCount = macLines.length || 999;
                              }
                            } catch (e) {
                              console.log(`[MAC-HYBRID] Failed to count MACs on ${sw.ip}:${fdbResult.ifName}: ${e.message}`);
                            }

                            // IP FABRIC: Calcola confidence score
                            // - No LLDP neighbor + low MAC count = high confidence endpoint
                            // - LLDP neighbor = definitely uplink (low confidence as endpoint)
                            let confidence = 0.5;
                            if (!hasLldpNeighbor && portMacCount <= 5) confidence = 0.95;
                            else if (!hasLldpNeighbor && portMacCount <= 20) confidence = 0.80;
                            else if (!hasLldpNeighbor) confidence = 0.60;
                            else if (hasLldpNeighbor) confidence = 0.10; // Uplink, very unlikely endpoint

                            return {
                              ip: sw.ip,
                              sysName: sw.sysname,
                              ifName: fdbResult.ifName,
                              vlan: fdbResult.vlan,
                              macCount: portMacCount,
                              hasLldpNeighbor,
                              confidence
                            };
                          }
                        } catch (_) {}
                        return null;
                      });

                      const batchResults = await Promise.all(batchPromises);
                      allResults.push(...batchResults.filter(r => r !== null));

                      // Se abbiamo già trovato un endpoint con macCount basso, possiamo fermarci
                      const lowMacCount = allResults.find(r => r.macCount < 10);
                      if (lowMacCount) {
                        console.log(`[MAC-HYBRID] Found endpoint early: ${lowMacCount.sysName}:${lowMacCount.ifName} (macCount=${lowMacCount.macCount})`);
                        break;
                      }
                    }

                    const searchResults = allResults;
                    console.log(`[MAC-HYBRID] Parallel search found ${searchResults.length} switches with MAC`);

                    if (searchResults.length > 0) {
                      // IP FABRIC: Sort by confidence (primary) then by macCount (secondary)
                      // Higher confidence = more likely to be endpoint
                      searchResults.sort((a, b) => {
                        if (b.confidence !== a.confidence) {
                          return b.confidence - a.confidence; // Higher confidence first
                        }
                        return a.macCount - b.macCount; // Lower MAC count as tiebreaker
                      });
                      const endpoint = searchResults[0];
                      console.log(`[MAC-HYBRID] Best endpoint: ${endpoint.sysName}:${endpoint.ifName} (confidence=${endpoint.confidence}, macCount=${endpoint.macCount}, lldp=${endpoint.hasLldpNeighbor})`);

                      result.endpoint = {
                        device: endpoint.sysName,
                        deviceIp: endpoint.ip,
                        ifName: endpoint.ifName,
                        vlan: endpoint.vlan,
                        vendor: null,
                        source: 'ssh-parallel-search',
                        confidence: endpoint.confidence,
                        hasLldpNeighbor: endpoint.hasLldpNeighbor,
                        macCount: endpoint.macCount
                      };
                      result.sshResult = {
                        switchesSearched: l2Switches.length,
                        switchesWithMac: searchResults.length,
                        allMatches: searchResults.map(r => ({
                          device: r.sysName,
                          port: r.ifName,
                          macCount: r.macCount,
                          confidence: r.confidence,
                          hasLldpNeighbor: r.hasLldpNeighbor
                        }))
                      };
                      result.source = 'nedi-db+ssh-parallel';
                    } else {
                      // IP FABRIC STYLE: Recursive LLDP Trace
                      // Segue il path dal core switch fino all'endpoint
                      console.log(`[MAC-HYBRID] SSH parallel search found nothing, starting recursive LLDP trace from ${best.device}:${best.interface}...`);
                      try {
                        const traceResult = await recursiveLldpTrace(
                          best.device,
                          best.interface,
                          hyphenMac,
                          siteCreds,
                          coreFallback,
                          sshCredsAlt,
                          5 // max 5 hops
                        );

                        console.log(`[MAC-HYBRID] LLDP trace result:`, JSON.stringify(traceResult));

                        if (traceResult.found && traceResult.endpoint) {
                          // Aggiorna endpoint con il risultato del trace
                          result.endpoint = {
                            device: traceResult.endpoint.device,
                            deviceIp: null, // TODO: lookup IP
                            ifName: traceResult.endpoint.port,
                            vlan: best.vlan,
                            vendor: null,
                            source: 'lldp-recursive-trace',
                            connectedDevice: traceResult.endpoint.connectedDevice || null
                          };
                          // Lookup IP del device trovato
                          const endpointDevice = db.db.prepare(`SELECT ip FROM devices WHERE sysname = ?`).get(traceResult.endpoint.device);
                          if (endpointDevice?.ip) {
                            result.endpoint.deviceIp = endpointDevice.ip;
                          }
                          result.source = 'nedi-db+lldp-trace';
                        } else {
                          // Trace non ha trovato endpoint, ma aggiungi path info
                          result.endpoint.note = `MAC possibly inactive - LLDP trace: ${traceResult.reason}`;
                          result.endpoint.lldpTracePath = traceResult.path;
                        }

                        result.sshResult = {
                          switchesSearched: l2Switches.length,
                          switchesWithMac: 0,
                          lldpTrace: {
                            found: traceResult.found,
                            reason: traceResult.reason,
                            path: traceResult.path,
                            endpoint: traceResult.endpoint
                          }
                        };
                      } catch (lldpErr) {
                        console.log(`[MAC-HYBRID] LLDP recursive trace failed: ${lldpErr.message}`);
                      }
                    }
                  }
                } catch (sshErr) {
                  console.log(`[MAC-HYBRID] Parallel search failed: ${sshErr.message}, using NeDi result`);
                }
              }
              // Se VLAN è null, prova SSH lookup sullo switch
              else if (best.vlan == null && best.device_ip) {
                console.log(`[MAC-HYBRID] VLAN null from NeDi, trying SSH lookup on ${best.device_ip}...`);
                try {
                  const hyphenMac = formatMacHyphen(mac);
                  const credsMap = loadCsvCredentials();
                  // Determina sito dalla device_ip
                  const ipParts = best.device_ip.split('.');
                  const siteKey = ipParts.length >= 2 ? String(ipParts[1]) : null;
                  const siteCredsArray = siteKey ? (credsMap.bySite.get(siteKey) || []) : [];
                  const siteCreds = siteCredsArray[0] || null;
                  const sshCredsAlt = siteCredsArray.slice(1);
                  const coreFallback = credsMap.coreFallback || null;

                  if (siteCreds || coreFallback) {
                    const sshResult = await findMacInFdbSSH(best.device_ip, hyphenMac, siteCreds, coreFallback, sshCredsAlt);
                    if (sshResult?.vlan) {
                      result.endpoint.vlan = sshResult.vlan;
                      result.endpoint.vlanSource = 'ssh-lookup';
                      console.log(`[MAC-HYBRID] VLAN from SSH: ${sshResult.vlan}`);
                    }
                  }
                } catch (sshErr) {
                  console.log(`[MAC-HYBRID] SSH VLAN lookup failed: ${sshErr.message}`);
                }
              }
            } else if (nediResult.arp?.data?.length > 0) {
              const best = nediResult.arp.data[0];
              result.endpoint = {
                device: best.device,
                deviceIp: best.device_ip,
                ifName: best.interface,
                ip: best.ip,
                hostname: best.hostname,
                source: 'nedi-arp'
              };
            }

            result.elapsed = `${Date.now() - t0}ms`;
            console.log(`[MAC-HYBRID] Found in NeDi DB: ${result.endpoint?.device} ${result.endpoint?.ifName} VLAN=${result.endpoint?.vlan}`);
            return res.json(result);
          }
        }
      } catch (dbErr) {
        console.error(`[MAC-HYBRID] NeDi error:`, dbErr.message);
        // Continua con SSH fallback
      }
    }

    // =========================================================================
    // FASE 2: Fallback SSH trace (lenta, ~30-60s)
    // =========================================================================
    if (!skipSsh && network) {
      console.log(`[MAC-HYBRID] MAC not found in DB, trying SSH trace on ${network}...`);
      try {
        const sshResult = await runSshTrace(mac, network, null, 45000);
        
        result.sshResult = {
          path: sshResult.path,
          hops: sshResult.hops,
          elapsed: sshResult.elapsed
        };
        result.source = 'ssh-trace';
        result.found = sshResult.found;
        result.endpoint = sshResult.endpoint;
        
      } catch (sshErr) {
        console.error(`[MAC-HYBRID] SSH trace error:`, sshErr.message);
        result.error = sshErr.message;
      }
    } else if (!network) {
      if (!skipSsh) {
        result.error = 'Network CIDR required for SSH fallback';
      }
    }

    result.elapsed = `${Date.now() - t0}ms`;
    res.json(result);

  } catch (err) {
    console.error(`[MAC-HYBRID] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/search/mac/snmp', async (req, res) => {
  try {
    const { mac, network, site, vlan: vlanFilter, earlyExit = true, skipLocalDb = false } = req.body || {};
    if (!mac) return res.status(400).json({ error: 'MAC richiesto' });
    const cleanMac = mac.replace(/[:.|\-]/g, '').toLowerCase();
    if (cleanMac.length !== 12 || !/^[0-9a-f]{12}$/.test(cleanMac)) return res.status(400).json({ error: 'MAC non valido (12 caratteri esadecimali)' });

    // FASE 1: Ricerca database locale (veloce, < 50ms)
    let localResults = [];
    if (!skipLocalDb) {
      try {
        const searchPattern = `%${cleanMac.match(/.{2}/g).join(':')}%`;
        const fdbLocal = db.db.prepare(`
          SELECT d.ip, d.sysname, i.ifname, i.ifdescr, f.vlan, 'FDB-LOCAL' as source
          FROM fdb f
          JOIN devices d ON f.device_id = d.id
          LEFT JOIN interfaces i ON f.interface_id = i.id
          WHERE LOWER(REPLACE(f.mac, ':', '')) LIKE ?
          ORDER BY f.lastseen DESC LIMIT 10
        `).all(`%${cleanMac}%`);

        for (const row of fdbLocal) {
          localResults.push({
            ip: row.ip,
            sysName: row.sysname,
            source: 'FDB-LOCAL',
            ifName: row.ifname,
            ifDescr: row.ifdescr,
            vlan: row.vlan,
            fromCache: true
          });
        }
      } catch (_) { /* DB locale non disponibile, continua con SNMP */ }
    }

    let targets = [];
    if (network) {
      let ips;
      try {
        ips = expandCidr(network, 256);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const maxHosts = Math.min(ips.length, 256);
      targets = ips.slice(0, maxHosts);
    }

    // Filtro opzionale per sito: limita la scansione agli IP dei device del sito
    if (site && /^\d{1,3}$/.test(site)) {
      try {
        const siteDevices = db.db.prepare('SELECT ip, sysname FROM devices WHERE sysname LIKE ?').all(`${site}_%`);
        const siteIps = siteDevices.map(d => d.ip).filter(Boolean);
        if (targets.length === 0) {
          targets = siteIps;
        } else {
          const siteSet = new Set(siteIps);
          const filtered = targets.filter(ip => siteSet.has(ip));
          if (filtered.length > 0) {
            targets = filtered;
          }
        }
      } catch (_) {
        // Se il filtro sito fallisce, continua con targets originali
      }
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: 'Nessun target: specifica network CIDR o un sito con devices' });
    }

    const results = [];

    const hexMatchesMac = (value) => {
      if (Buffer.isBuffer(value)) {
        const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
        return hex === cleanMac;
      }
      if (typeof value === 'string') {
        const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
        return hex === cleanMac;
      }
      return false;
    };

    const agent = snmpAgent;
    const WALK_TIMEOUT = 5000;  // Increased from 2000ms to 5000ms for FDB/Q-Bridge walks
    const MAX_REPETITIONS = 50; // Increased from 20 for faster GETBULK on large FDB tables
    const BATCH_SIZE = 20;
    let foundMac = false; // Flag per early exit
    async function mapPort(ip, dot1dPort) {
      let ifIndex = null;
      let ifName = null;
      let ifDescr = null;
      let ifAlias = null;
      const m1 = await agent.get(ip, [`1.3.6.1.2.1.17.1.4.1.2.${dot1dPort}`]);
      if (!m1.err && m1.values?.[0]?.value !== undefined) {
        ifIndex = Number(m1.values[0].value);
        // Optimize: fetch ifName, ifDescr, ifAlias in parallel instead of sequential
        const [m2, m4] = await Promise.all([
          agent.get(ip, [`1.3.6.1.2.1.31.1.1.1.1.${ifIndex}`]),
          agent.get(ip, [`1.3.6.1.2.1.31.1.1.1.18.${ifIndex}`]),
        ]);
        if (!m2.err && m2.values?.[0]?.value) {
          ifName = agent.decodeValue(m2.values[0].value);
        } else {
          const m3 = await agent.get(ip, [`1.3.6.1.2.1.2.2.1.2.${ifIndex}`]);
          if (!m3.err && m3.values?.[0]?.value) {
            ifDescr = agent.decodeValue(m3.values[0].value);
          }
        }
        if (!m4.err && m4.values?.[0]?.value) {
          ifAlias = agent.decodeValue(m4.values[0].value);
        }
      }
      return { ifIndex, ifName, ifDescr, ifAlias };
    }
    for (let i = 0; i < targets.length && !(earlyExit && foundMac); i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (ip) => {
        if (earlyExit && foundMac) return; // Early exit se già trovato
        try {
          const sysName = await agent.getSysName(ip);
          const portMappingCache = new Map(); // Cache port mapping for this device

          const arpWalk = await agent.walk(ip, '1.3.6.1.2.1.4.22.1.2', MAX_REPETITIONS, WALK_TIMEOUT);
          if (!arpWalk.err && Array.isArray(arpWalk.rows)) {
            for (const row of arpWalk.rows) {
              if (hexMatchesMac(row.value)) {
                results.push({ ip, sysName, source: 'ARP', port: null, vlan: null });
                foundMac = true;
              }
            }
          }

          const fdbWalk = await agent.walk(ip, '1.3.6.1.2.1.17.4.3.1', MAX_REPETITIONS, WALK_TIMEOUT);
          if (!fdbWalk.err && Array.isArray(fdbWalk.rows)) {
            for (const row of fdbWalk.rows) {
              if (!row?.oid) continue;
              const parts = row.oid.split('.');
              const len = parts.length;

              // FDB: 1.3.6.1.2.1.17.4.3.1.ATTR.MAC1.MAC2.MAC3.MAC4.MAC5.MAC6
              if (len >= 8) {
                const attr = parts[len - 7];

                // Only process address entries (attr=1)
                if (attr === '1') {
                  const macBytes = parts.slice(baseLen, baseLen + 6).map(p => parseInt(p).toString(16).padStart(2, '0'));
                  const macHex = macBytes.join('').toLowerCase();

                  if (macHex === cleanMac) {
                    // Extract MAC from OID parts (last 6 octets)
                    const idx = parts.slice(baseLen, baseLen + 6).join('.');
                    let port = null;
                    const portRes = await agent.get(ip, [`1.3.6.1.2.1.17.4.3.1.2.${idx}`]);
                    if (!portRes.err && portRes.values?.[0]?.value !== undefined) {
                      port = portRes.values[0].value.toString();
                    }
                    let ifName = null;
                    let ifDescr = null;
                    let ifIndex = null;
                    if (port) {
                      // Check cache first before calling mapPort
                      let mapped = portMappingCache.get(port);
                      if (!mapped) {
                        mapped = await mapPort(ip, port);
                        portMappingCache.set(port, mapped);
                      }
                      ifName = mapped.ifName || null;
                      ifDescr = mapped.ifDescr || null;
                      const ifAlias = mapped.ifAlias || null;
                      ifIndex = mapped.ifIndex || null;
                      results.push({ ip, sysName, source: 'FDB', port, ifIndex, ifName, ifDescr, ifAlias, vlan: null });
                      foundMac = true;
                    } else {
                      results.push({ ip, sysName, source: 'FDB', port, ifName, ifDescr, vlan: null });
                      foundMac = true;
                    }
                  }
                }
              }
            }
          }

          if (earlyExit && foundMac) return; // Skip Q-BRIDGE se già trovato in FDB

          const qAddrBase = '1.3.6.1.2.1.17.7.1.2.2.1.1';
          const qPortBase = '1.3.6.1.2.1.17.7.1.2.2.1.2';
          const qWalk = await agent.walk(ip, qAddrBase, MAX_REPETITIONS, WALK_TIMEOUT);
          if (!qWalk.err && Array.isArray(qWalk.rows)) {
            for (const row of qWalk.rows) {
              const idx = row.oid.startsWith(qAddrBase + '.') ? row.oid.slice(qAddrBase.length + 1) : null;
              if (!idx) continue;
              const parts = idx.split('.').map(x => parseInt(x, 10));
              if (parts.length < 7) continue;
              const vlan = parts[0];
              const macHex = parts.slice(1, 7).map(b => b.toString(16).padStart(2, '0')).join('');
              if (macHex.toLowerCase() !== cleanMac) continue;
              const portRes = await agent.get(ip, [`${qPortBase}.${vlan}.${parts.slice(1,7).join('.')}`]);
              let port = null;
              if (!portRes.err && portRes.values?.[0]?.value !== undefined) {
                port = portRes.values[0].value.toString();
              }
              let ifName = null;
              let ifDescr = null;
              let ifIndex = null;
              if (port) {
                // Check cache first before calling mapPort
                let mapped = portMappingCache.get(port);
                if (!mapped) {
                  mapped = await mapPort(ip, port);
                  portMappingCache.set(port, mapped);
                }
                ifName = mapped.ifName || null;
                ifDescr = mapped.ifDescr || null;
                const ifAlias = mapped.ifAlias || null;
                ifIndex = mapped.ifIndex || null;
                results.push({ ip, sysName, source: 'FDB', port, ifIndex, ifName, ifDescr, ifAlias, vlan });
                foundMac = true;
              } else {
                results.push({ ip, sysName, source: 'FDB', port, ifName, ifDescr, vlan });
                foundMac = true;
              }
            }
          }
        } catch (e) { console.warn('[MAC-TRACE] Q-Bridge walk error:', e.message); }
      }));
    }

    let filtered = results;
    if (vlanFilter !== undefined && vlanFilter !== null && vlanFilter !== '') {
      const vn = Number(vlanFilter);
      if (!Number.isNaN(vn)) {
        filtered = filtered.filter(r => r.vlan === vn);
      }
    }
    const unique = [];
    const keySet = new Set();
    for (const r of filtered) {
      const k = `${r.ip}|${r.source}|${r.port || ''}|${r.vlan || ''}`;
      if (!keySet.has(k)) { keySet.add(k); unique.push(r); }
    }

    async function resolveFinalPosition(entries) {
      const evaluated = [];
      for (const r of entries) {
        let dev = null;
        try {
          dev = db.getDevice(r.sysName || r.ip);
        } catch {}
        let isTrunk = false;
        let ifIndex = r.ifIndex || null;
        let iface = null;
        let ifaceId = null;
        let vlanMembership = { tagged: 0, untagged: 0 };
        if (dev && !ifIndex && (r.ifName || r.ifDescr)) {
          try {
            const ifs = db.getDeviceInterfaces(dev.id) || [];
            const found = ifs.find(i => i.ifname === r.ifName || i.ifdescr === r.ifDescr);
            ifIndex = found?.ifindex || ifIndex;
            iface = found || null;
            ifaceId = found?.id || null;
          } catch {}
        }
        if (dev && ifIndex && !iface) {
          try {
            const ifs = db.getDeviceInterfaces(dev.id) || [];
            const found = ifs.find(i => Number(i.ifindex) === Number(ifIndex));
            iface = found || null;
            ifaceId = found?.id || null;
          } catch {}
        }
        if (ifaceId) {
          try {
            const ivlans = db.getInterfaceVLANs(ifaceId) || [];
            vlanMembership = {
              tagged: ivlans.filter(v => v.tagged === 1).length,
              untagged: ivlans.filter(v => v.tagged === 0).length,
            };
          } catch {}
        }
        if (dev && ifIndex) {
          try {
            const links = db.getDeviceLinks(dev.id) || [];
            isTrunk = links.some(l => Number(l.local_ifindex) === Number(ifIndex));
          } catch {}
        }
        const isL2 = (r.sysName || '').includes('_L2_');
        const isL3 = (r.sysName || '').includes('_L3_');
        const descr = (iface?.ifdescr || r.ifDescr || '').toLowerCase();
        const nameLower = (r.ifName || '').toLowerCase();
        const trunkHintDescr = /trunk|uplink|stack|agg|lag|eth-trunk|tenge|xge|core/.test(descr);
        const trunkHintName = /trunk|eth-trunk|port-channel|bundle|agg|lag|lagg|lacp|po\d+|channel/.test(nameLower);
        const aliasLower = (iface?.ifalias || r.ifAlias || '').toLowerCase();
        const trunkHintAlias = /link|uplink|agg|lag|trunk|stack|core|\b\d+\.\d+\.\d+\.\d+\b/.test(aliasLower) || /\b\d{1,3}_l2_/.test(aliasLower);
        const uplinkNumberHint = /(?:gigabitethernet|xgigabitethernet|tenge|xge)\d+\/\d+\/(2[5-9]|[3-9]\d)/i.test(r.ifName || '');
        const likelyAccess = vlanMembership.tagged === 0 && vlanMembership.untagged === 1;
        const hasVlan = r.vlan != null;
        let macCount = null;
        try {
          if (r.port && /^\d+$/.test(r.port)) {
            macCount = await countMacsOnBridgePort(r.ip, Number(r.port));
          }
        } catch {}
        let hasLldp = false;
        try {
          const discL = await agent.discoverProtocols(r.ip, 3000);
          const lldpList = discL.lldp || [];
          const idx = Number(ifIndex);
          const nm = (r.ifName || '').trim();
          const ds = (r.ifDescr || '').trim();
          if (idx) hasLldp = lldpList.some(n => Number(n.localPort) === idx);
          if (!hasLldp && nm) hasLldp = lldpList.some(n => (n.portId && String(n.portId).trim() === nm) || (n.portDesc && String(n.portDesc).trim() === nm));
          if (!hasLldp && ds) hasLldp = lldpList.some(n => (n.portDesc && String(n.portDesc).trim() === ds));
        } catch {}
        // Scoring più robusto
        let score = 0;
        score += isL2 ? 4 : 0;
        score += hasVlan ? 3 : 0;
        score += r.ifAlias ? 2 : 0;
        score += likelyAccess ? 3 : 0;
        if (macCount !== null) {
          if (macCount <= 10) score += 5;
          else if (macCount >= 100) score -= 8;
          else if (macCount >= 30) score -= 4;
        }
        score += (!hasLldp) ? 2 : -5;
        const trunkDetected = isTrunk || trunkHintDescr || trunkHintName || trunkHintAlias || uplinkNumberHint || /^eth-trunk\d+$/i.test(r.ifName || '') || /^port-channel\d+$/i.test(r.ifName || '') || (isL3 && /(xgigabitethernet|tenge|xge|port-channel|eth-trunk)/.test(nameLower));
        score -= trunkDetected ? 10 : 0;
        // Penalizza anche hint di trunk nei nomi/descrizioni
        score -= (trunkHintDescr || trunkHintName) ? 5 : 0;
        // Penalizza porte 1-2 (spesso uplink sugli access) se non likelyAccess
        if (!likelyAccess && r.port && /^\d+$/.test(r.port) && Number(r.port) <= 2) score -= 2;
        const pnumMatch2 = (r.ifName || '').match(/\/(\d+)$/);
        const pnum2 = pnumMatch2 ? Number(pnumMatch2[1]) : null;
        if (!likelyAccess && pnum2 && pnum2 <= 2) score -= 4;
        if (pnum2 && pnum2 >= 3 && pnum2 <= 24) score += 1;
        // Penalizza porte alte tipiche uplink (25+ su 24p, 47+ su 48p)
        const pnumMatch = (r.ifName || '').match(/\/(\d+)$/);
        const pnum = pnumMatch ? Number(pnumMatch[1]) : null;
        if (pnum && (pnum >= 25 || pnum >= 47)) score -= 6;
        evaluated.push({ ...r, ifIndex, isTrunk: trunkDetected, score, vlanMembership });
      }
      const nonTrunk = evaluated.filter(e => !e.isTrunk);
      const sorted = (nonTrunk.length ? nonTrunk : evaluated).sort((a, b) => b.score - a.score);
      const final = sorted[0] || null;
      return { final, candidates: evaluated };
    }

    const resolution = await resolveFinalPosition(unique);

    async function buildCoreIpFromNetwork(n) {
      try {
        const base = n.split('/')[0];
        const parts = base.split('.');
        if (parts.length !== 4) return null;
        return `${parts[0]}.${parts[1]}.${parts[2]}.251`;
      } catch (_) { return null; }
    }

    async function findSiteCoreIp(s) {
      try {
        const rows = db.db.prepare('SELECT ip FROM devices WHERE sysname LIKE ?').all(`${s}_%`);
        const ips = rows.map(r => r.ip).filter(Boolean);
        const core = ips.find(ip => ip && ip.split('.').length === 4 && ip.split('.')[3] === '251');
        return core || null;
      } catch (_) { return null; }
    }

    async function findPortOnDevice(ipAddr) {
      const sysName = await agent.getSysName(ipAddr);
      let found = null;
      const qAddrBase = '1.3.6.1.2.1.17.7.1.2.2.1.1';
      const qPortBase = '1.3.6.1.2.1.17.7.1.2.2.1.2';
      const qWalk = await agent.walk(ipAddr, qAddrBase, 20, WALK_TIMEOUT);
      if (!qWalk.err && Array.isArray(qWalk.rows)) {
        for (const row of qWalk.rows) {
          const idx = row.oid.startsWith(qAddrBase + '.') ? row.oid.slice(qAddrBase.length + 1) : null;
          if (!idx) continue;
          const parts = idx.split('.').map(x => parseInt(x, 10));
          if (parts.length < 7) continue;
          const vlan = parts[0];
          const macHex = parts.slice(1, 7).map(b => b.toString(16).padStart(2, '0')).join('');
          if (macHex.toLowerCase() !== cleanMac) continue;
          const portRes = await agent.get(ipAddr, [`${qPortBase}.${vlan}.${parts.slice(1,7).join('.')}`]);
          let port = null;
          if (!portRes.err && portRes.values?.[0]?.value !== undefined) {
            port = portRes.values[0].value.toString();
          }
          let ifIndex = null;
          let ifName = null;
          let ifDescr = null;
          let ifAlias = null;
          if (port) {
            const mapped = await mapPort(ipAddr, port);
            ifIndex = mapped.ifIndex || null;
            ifName = mapped.ifName || null;
            ifDescr = mapped.ifDescr || null;
            ifAlias = mapped.ifAlias || null;
          }
          found = { ip: ipAddr, sysName, source: 'FDB', port, ifIndex, ifName, ifDescr, ifAlias, vlan };
          break;
        }
      }
      if (!found) {
        const fdbWalk = await agent.walk(ipAddr, '1.3.6.1.2.1.17.4.3.1.1', 20, WALK_TIMEOUT);
        if (!fdbWalk.err && Array.isArray(fdbWalk.rows)) {
          for (const row of fdbWalk.rows) {
            if (hexMatchesMac(row.value)) {
              const idx = row.oid.replace('1.3.6.1.2.1.17.4.3.1.1.', '');
              let port = null;
              const portRes = await agent.get(ipAddr, [`1.3.6.1.2.1.17.4.3.1.2.${idx}`]);
              if (!portRes.err && portRes.values?.[0]?.value !== undefined) {
                port = portRes.values[0].value.toString();
              }
              let ifIndex = null;
              let ifName = null;
              let ifDescr = null;
              let ifAlias = null;
              if (port) {
                const mapped = await mapPort(ipAddr, port);
                ifIndex = mapped.ifIndex || null;
                ifName = mapped.ifName || null;
                ifDescr = mapped.ifDescr || null;
                ifAlias = mapped.ifAlias || null;
              }
              found = { ip: ipAddr, sysName, source: 'FDB', port, ifIndex, ifName, ifDescr, ifAlias, vlan: null };
              break;
            }
          }
        }
      }
      return found;
    }

    async function findNeighbor(ipAddr, portInfo) {
      const disc = await agent.discoverProtocols(ipAddr, 8000);
      const list = disc.lldp || [];
      const ifIndex = Number(portInfo?.ifIndex);
      const ifName = (portInfo?.ifName || '').trim();
      const ifDescr = (portInfo?.ifDescr || '').trim();
      let m = list.find(n => Number(n.localPort) === ifIndex);
      if (!m && ifName) {
        m = list.find(n => (n.portId && String(n.portId).trim() === ifName) || (n.portDesc && String(n.portDesc).trim() === ifName));
      }
      if (!m && ifDescr) {
        m = list.find(n => (n.portDesc && String(n.portDesc).trim() === ifDescr));
      }
      let neighborIp = null;
      let neighborName = null;
      if (m) {
        neighborIp = m.ip || null;
        neighborName = m.sysName || null;
        if (!neighborIp && m.chassisId) {
          try {
            const key = String(m.chassisId).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
            if (key && key.length >= 12) {
              const devByMac = db.getDeviceByMAC(key);
              if (devByMac && devByMac.ip) {
                neighborIp = devByMac.ip;
                neighborName = devByMac.sysname || neighborName;
              }
            }
          } catch (e) { console.warn('[MAC-TRACE] SNMP walk error:', e.message); }
        }
      }

      if (!neighborIp) {
        try {
          const dev = db.getDevice(ipAddr);
          if (dev) {
            const links = db.getDeviceLinks(dev.id) || [];
            let link = links.find(l => (l.local_ifindex != null && Number(l.local_ifindex) === Number(ifIndex)) || (l.local_ifname && ifName && String(l.local_ifname).trim() === ifName) || (l.local_portdesc && ifDescr && String(l.local_portdesc).trim() === ifDescr));
            if (!link) {
              const allLinks = db.getAllLinks() || [];
              link = allLinks.find(l => (l.local_ip === ipAddr) && ((l.local_ifindex != null && Number(l.local_ifindex) === Number(ifIndex)) || (l.local_ifname && ifName && String(l.local_ifname).trim() === ifName) || (l.local_portdesc && ifDescr && String(l.local_portdesc).trim() === ifDescr)));
            }
            if (link) {
              neighborIp = link.remote_ip || null;
              neighborName = link.remote_sysname || neighborName;
              if (!neighborIp && neighborName) {
                const rdev = db.getDevice(neighborName);
                neighborIp = rdev ? rdev.ip : null;
              }
            }
          }
        } catch (e) { console.warn('[MAC-TRACE] Port resolution error:', e.message); }
      }

      if (!neighborIp && portInfo?.ifAlias) {
        try {
          let aliasKey = String(portInfo.ifAlias).trim();
          const ipMatch = aliasKey.match(/\b\d+\.\d+\.\d+\.\d+\b/);
          if (ipMatch) aliasKey = ipMatch[0];
          const rdev = db.getDevice(aliasKey);
          if (rdev && rdev.ip) {
            neighborIp = rdev.ip;
            neighborName = rdev.sysname || neighborName;
          }
        } catch (_) {}
      }

      if (!neighborIp && neighborName) {
        try {
          const rdev = db.getDevice(neighborName);
          neighborIp = rdev ? rdev.ip : null;
        } catch (_) {}
      }

      return neighborIp ? { ip: neighborIp, sysName: neighborName || null } : null;
    }

    async function countMacsOnBridgePort(ipAddr, dot1dPort) {
      let count = 0;
      try {
        const qAddrBase = '1.3.6.1.2.1.17.7.1.2.2.1.1';
        const qPortBase = '1.3.6.1.2.1.17.7.1.2.2.1.2';
        const qWalk = await agent.walk(ipAddr, qAddrBase, 200, WALK_TIMEOUT);
        if (!qWalk.err && Array.isArray(qWalk.rows)) {
          for (const row of qWalk.rows) {
            const idx = row.oid.startsWith(qAddrBase + '.') ? row.oid.slice(qAddrBase.length + 1) : null;
            if (!idx) continue;
            const parts = idx.split('.').map(x => parseInt(x, 10));
            if (parts.length < 7) continue;
            const vlan = parts[0];
            const portRes = await agent.get(ipAddr, [`${qPortBase}.${vlan}.${parts.slice(1,7).join('.')}`]);
            if (!portRes.err && portRes.values?.[0]?.value !== undefined) {
              const p = Number(portRes.values[0].value);
              if (p === Number(dot1dPort)) count++;
            }
          }
        }
      } catch {}
      try {
        const fWalk = await agent.walk(ipAddr, '1.3.6.1.2.1.17.4.3.1.1', 200, WALK_TIMEOUT);
        if (!fWalk.err && Array.isArray(fWalk.rows)) {
          for (const row of fWalk.rows) {
            const idx = row.oid.replace('1.3.6.1.2.1.17.4.3.1.1.', '');
            const portRes = await agent.get(ipAddr, [`1.3.6.1.2.1.17.4.3.1.2.${idx}`]);
            if (!portRes.err && portRes.values?.[0]?.value !== undefined) {
              const p = Number(portRes.values[0].value);
              if (p === Number(dot1dPort)) count++;
            }
          }
        }
      } catch {}
      return count;
    }

    async function traceFromCore(startIp) {
      const path = [];
      const visited = new Set();
      let currentIp = startIp;
      let last = null;
      async function localIfaceFromNeighbor(deviceIp, neighbor) {
        try {
          const dev = db.getDevice(deviceIp);
          const ifs = dev ? (db.getDeviceInterfaces(dev.id) || []) : [];
          let ifIndex = null, ifName = null, ifDescr = null, ifAlias = null;
          if (neighbor && neighbor.localPort != null) {
            const cand = ifs.find(i => Number(i.ifindex) === Number(neighbor.localPort));
            if (cand) {
              ifIndex = Number(cand.ifindex);
              ifName = cand.ifname || null;
              ifDescr = cand.ifdescr || null;
              ifAlias = cand.ifalias || null;
            }
          }
          if (!ifIndex) {
            const byName = ifs.find(i => i.ifname === neighbor.portId || i.ifdescr === neighbor.portDesc);
            if (byName) {
              ifIndex = Number(byName.ifindex);
              ifName = byName.ifname || null;
              ifDescr = byName.ifdescr || null;
              ifAlias = byName.ifalias || null;
            }
          }
          return { ifIndex, ifName, ifDescr, ifAlias };
        } catch (_) {
          return { ifIndex: null, ifName: null, ifDescr: null, ifAlias: null };
        }
      }
      for (let hop = 0; hop < 12; hop++) {
        if (!currentIp || visited.has(currentIp)) break;
        visited.add(currentIp);
        let p = await findPortOnDevice(currentIp);
        if (!p) {
          // Se il Core non vede il MAC, prova i neighbors del Core per trovare chi lo impara
          try {
            const disc = await agent.discoverProtocols(currentIp, 8000);
            const neighbors = (disc.lldp || []).slice(0, 24);
            let next = null;
            const scored = [];
            for (const n of neighbors) {
              const nIp = n.ip || (n.sysName ? (db.getDevice(n.sysName)?.ip || null) : null);
              if (!nIp) continue;
              const np = await findPortOnDevice(nIp);
              if (np) {
                const nameLower = (np.ifName || '').toLowerCase();
                const descrLower = (np.ifDescr || '').toLowerCase();
                const trunkHint = /trunk|eth-trunk|port-channel|agg|lag|lacp|po\d+|channel/.test(nameLower) || /trunk|uplink|stack|agg|lag|eth-trunk|core/.test(descrLower);
                let score = 0;
                score += np.vlan != null ? 3 : 0;
                score += np.ifAlias ? 2 : 0;
                score -= trunkHint ? 8 : 0;
                scored.push({ n, np, nIp, score });
              } else {
                const nameDev = (n.sysName || '').toLowerCase();
                let score = 0;
                score += nameDev.includes('_l2_') ? 2 : 0;
                scored.push({ n, np: null, nIp, score });
              }
            }
            scored.sort((a,b) => b.score - a.score);
            const best = scored[0] || null;
            if (best) {
              next = { ip: best.nIp, sysName: best.n.sysName || null };
              const li = await localIfaceFromNeighbor(currentIp, best.n);
              path.push({ ip: currentIp, sysName: disc.sysName || currentIp, source: 'LLDP', port: null, ifIndex: li.ifIndex, ifName: li.ifName, ifDescr: li.ifDescr, ifAlias: li.ifAlias, vlan: null });
            }
            if (!next) break;
            currentIp = next.ip;
            continue;
          } catch (_) {
            break;
          }
        }
        path.push(p);
        let status = null;
        try { status = isTrunkCandidate(p); } catch (_) { status = null; }
        if (!status || !status.trunkDetected) {
          last = p;
          break;
        }
        let nei = null;
        // Preferisci LLDP/DB per neighbor
        nei = await findNeighbor(currentIp, p);
        // Fallback: prova alias porta (alcuni core hanno alias con sysname o IP)
        if (!nei && p.ifAlias) {
          try {
            const alias = String(p.ifAlias).trim();
            let dev = db.getDevice(alias);
            if (!dev && /^\d{1,3}_/.test(alias)) {
              dev = db.getDevice(alias);
            }
            if (!dev) {
              const ipMatch = alias.match(/\b\d+\.\d+\.\d+\.\d+\b/);
              if (ipMatch) dev = db.getDevice(ipMatch[0]);
            }
            if (dev && dev.ip && !visited.has(dev.ip)) {
              nei = { ip: dev.ip, sysName: dev.sysname || null };
            }
          } catch (_) {}
        }
        if (nei && nei.ip && !visited.has(nei.ip)) {
          try {
            const np = await findPortOnDevice(nei.ip);
            let st = null;
            try { st = isTrunkCandidate(np || {}); } catch (_) { st = null; }
            if (!np || (st && st.trunkDetected && !st.likelyAccess)) {
              // Prova fallback via DB links del device corrente per superare trunk aggregati
              try {
                const currDev = db.getDevice(currentIp);
                const links = currDev ? (db.getDeviceLinks(currDev.id) || []) : [];
                const trunkLinks = links.filter(l =>
                  (p.ifIndex != null && Number(l.local_ifindex) === Number(p.ifIndex)) ||
                  (p.ifName && l.local_ifname && String(l.local_ifname).trim() === String(p.ifName).trim()) ||
                  (p.ifDescr && l.local_portdesc && String(l.local_portdesc).trim() === String(p.ifDescr).trim())
                );
                const candidates = [];
                for (const tl of trunkLinks) {
                  const rip = tl.remote_ip || (tl.remote_sysname ? (db.getDevice(tl.remote_sysname)?.ip || null) : null);
                  if (!rip || visited.has(rip)) continue;
                  const rport = await findPortOnDevice(rip);
                  if (rport) {
                    const s = isTrunkCandidate(rport);
                    let score = 0;
                    score += rport.vlan != null ? 3 : 0;
                    score += rport.ifAlias ? 2 : 0;
                    score += (!s.trunkDetected && s.likelyAccess) ? 6 : 0;
                    score -= s.trunkDetected ? 8 : 0;
                    // Bonus per device L2
                    const isL2 = (rport.sysName || '').includes('_L2_');
                    score += isL2 ? 3 : 0;
                    candidates.push({ nIp: rip, np: rport, score, n: { sysName: tl.remote_sysname || null, portId: tl.remote_portid || null, portDesc: tl.remote_portdesc || null } });
                  }
                }
                candidates.sort((a,b) => b.score - a.score);
                const bestDb = candidates[0] || null;
                if (bestDb) {
                  const disc2 = await agent.discoverProtocols(currentIp, 8000);
                  path.push({ ip: currentIp, sysName: disc2.sysName || currentIp, source: 'LLDP/DB', port: null, ifIndex: null, ifName: String(bestDb.n.portId || ''), ifDescr: String(bestDb.n.portDesc || ''), ifAlias: null, vlan: null });
                  nei = { ip: bestDb.nIp, sysName: bestDb.n.sysName || null };
                }
              } catch (_) {}

              const disc = await agent.discoverProtocols(currentIp, 8000);
              const neighbors = (disc.lldp || []).slice(0, 24);
              const scored = [];
              for (const n of neighbors) {
                const nIp = n.ip || (n.sysName ? (db.getDevice(n.sysName)?.ip || null) : null);
                if (!nIp || visited.has(nIp)) continue;
                const nPort = await findPortOnDevice(nIp);
                if (nPort) {
                  const s = isTrunkCandidate(nPort);
                  let score = 0;
                  score += nPort.vlan != null ? 3 : 0;
                  score += nPort.ifAlias ? 2 : 0;
                  score += (!s.trunkDetected && s.likelyAccess) ? 5 : 0;
                  score -= s.trunkDetected ? 8 : 0;
                  scored.push({ n, np: nPort, nIp, score });
                }
              }
              scored.sort((a,b) => b.score - a.score);
              const best = scored[0] || null;
              if (best) {
                const disc2 = await agent.discoverProtocols(currentIp, 8000);
                const li = await localIfaceFromNeighbor(currentIp, best.n);
                path.push({ ip: currentIp, sysName: disc2.sysName || currentIp, source: 'LLDP', port: null, ifIndex: li.ifIndex, ifName: li.ifName, ifDescr: li.ifDescr, ifAlias: li.ifAlias, vlan: null });
                nei = { ip: best.nIp, sysName: best.n.sysName || null };
              }
            }
          } catch (_) {}
        }
        if (!nei || (nei.ip && visited.has(nei.ip))) {
          // Fallback: prova tutti i neighbors del device corrente e scegli quello che impara il MAC meglio
          try {
            const disc = await agent.discoverProtocols(currentIp, 8000);
            const neighbors = (disc.lldp || []).slice(0, 24);
            const scored = [];
            for (const n of neighbors) {
              const nIp = n.ip || (n.sysName ? (db.getDevice(n.sysName)?.ip || null) : null);
              if (!nIp || visited.has(nIp)) continue;
              const np = await findPortOnDevice(nIp);
              if (np) {
                const nameLower = (np.ifName || '').toLowerCase();
                const descrLower = (np.ifDescr || '').toLowerCase();
                const trunkHint = /trunk|eth-trunk|port-channel|agg|lag|lacp|po\d+|channel/.test(nameLower) || /trunk|uplink|stack|agg|lag|eth-trunk|core/.test(descrLower);
                let score = 0;
                score += np.vlan != null ? 3 : 0;
                score += np.ifAlias ? 2 : 0;
                score -= trunkHint ? 8 : 0;
                scored.push({ n, np, nIp, score });
              } else {
                const nameDev = (n.sysName || '').toLowerCase();
                let score = 0;
                score += nameDev.includes('_l2_') ? 2 : 0;
                scored.push({ n, np: null, nIp, score });
              }
            }
            scored.sort((a,b) => b.score - a.score);
            const best = scored[0] || null;
            if (!best) break;
            const li = await localIfaceFromNeighbor(currentIp, best.n);
            path.push({ ip: currentIp, sysName: disc.sysName || currentIp, source: 'LLDP', port: null, ifIndex: li.ifIndex, ifName: li.ifName, ifDescr: li.ifDescr, ifAlias: li.ifAlias, vlan: null });
            currentIp = best.nIp;
            continue;
          } catch (_) {
            break;
          }
        }
        currentIp = nei.ip;
      }
      let final = last;
      if (path.length > 0) {
        for (let i = path.length - 1; i >= 0; i--) {
          const st = isTrunkCandidate(path[i]);
          if (!st.trunkDetected && (st.likelyAccess || path[i].vlan != null)) { final = path[i]; break; }
        }
      }
      return { path, final };
    }

    let coreIp = null;
    if (network) coreIp = await buildCoreIpFromNetwork(network);
    if (!coreIp && site) coreIp = await findSiteCoreIp(site);
    let traced = null;
    if (coreIp) {
      try {
        traced = await traceFromCore(coreIp);
      } catch (e) { console.warn('[MAC-TRACE] Device scan error:', e.message); }
    }

    function isTrunkCandidate(r) {
      try {
        let dev = null;
        try { dev = db.getDevice(r.sysName || r.ip); } catch {}
        let ifIndex = r.ifIndex || null;
        let iface = null;
        let ifaceId = null;
        if (dev && !ifIndex && (r.ifName || r.ifDescr)) {
          try {
            const ifs = db.getDeviceInterfaces(dev.id) || [];
            const found = ifs.find(i => i.ifname === r.ifName || i.ifdescr === r.ifDescr);
            ifIndex = found?.ifindex || ifIndex;
            iface = found || null;
            ifaceId = found?.id || null;
          } catch {}
        }
        if (dev && ifIndex && !iface) {
          try {
            const ifs = db.getDeviceInterfaces(dev.id) || [];
            const found = ifs.find(i => Number(i.ifindex) === Number(ifIndex));
            iface = found || null;
            ifaceId = found?.id || null;
          } catch {}
        }
        let vlanMembership = { tagged: 0, untagged: 0 };
        if (ifaceId) {
          try {
            const ivlans = db.getInterfaceVLANs(ifaceId) || [];
            vlanMembership = {
              tagged: ivlans.filter(v => v.tagged === 1).length,
              untagged: ivlans.filter(v => v.tagged === 0).length,
            };
          } catch {}
        }
        let isTrunk = false;
        if (dev && ifIndex) {
          try {
            const links = db.getDeviceLinks(dev.id) || [];
            isTrunk = links.some(l => Number(l.local_ifindex) === Number(ifIndex));
          } catch {}
        }
        const descr = (iface?.ifdescr || r.ifDescr || '').toLowerCase();
        const nameLower = (r.ifName || '').toLowerCase();
        const aliasLower = (iface?.ifalias || r.ifAlias || '').toLowerCase();
        const trunkHintDescr = /trunk|uplink|stack|agg|lag|eth-trunk|tenge|xge|core/.test(descr);
        const trunkHintName = /trunk|eth-trunk|port-channel|bundle|agg|lag|lagg|lacp|po\d+|channel/.test(nameLower);
        const trunkHintAlias = /link|uplink|agg|lag|trunk|stack|core|\b\d+\.\d+\.\d+\.\d+\b/.test(aliasLower) || /\b\d{1,3}_l2_/.test(aliasLower);
        const uplinkNumberHint = /(?:gigabitethernet|xgigabitethernet|tenge|xge)\d+\/\d+\/(2[5-9]|[3-9]\d)/i.test(r.ifName || '');
        const trunkDetected = isTrunk || trunkHintDescr || trunkHintName || trunkHintAlias || uplinkNumberHint || /^eth-trunk\d+$/i.test(r.ifName || '') || /^port-channel\d+$/i.test(r.ifName || '');
        let likelyAccess = vlanMembership.tagged === 0 && vlanMembership.untagged === 1;
        const pm = (r.ifName || '').match(/\/(\d+)$/);
        const pn = pm ? Number(pm[1]) : null;
        if (!likelyAccess && !trunkDetected && pn && pn >= 3 && pn <= 24) likelyAccess = true;
        if (!likelyAccess && !trunkDetected && r.vlan != null) likelyAccess = true;
        return { trunkDetected, likelyAccess };
      } catch (_) {
        return { trunkDetected: false, likelyAccess: false };
      }
    }

    // PRIORITÀ: Parti dal Core e usa il trace per trovare l'access
    let finalBest = null;

    if (traced && traced.final) {
      finalBest = traced.final;
    }

    // Se il trace non dà un access, prova tra i risultati SNMP i candidati L2 non-trunk
    if (!finalBest) {
      const l2Candidates = unique.filter(r => (r.sysName || '').includes('_L2_'));
      for (const c of l2Candidates) {
        const st = isTrunkCandidate(c);
        if (!st.trunkDetected) {
          finalBest = c;
          break;
        }
      }
    }

    // Fallback: usa resolution.final
    if (!finalBest) {
      finalBest = resolution.final;
    }

    // Se finalBest è ancora un L3, prova a trovare un L2 dal trace path
    if (finalBest && (finalBest.sysName || '').includes('_L3_')) {
      const l2InPath = (traced?.path || []).find(p => (p.sysName || '').includes('_L2_'));
      if (l2InPath) {
        const st = isTrunkCandidate(l2InPath);
        if (!st.trunkDetected) {
          finalBest = l2InPath;
        }
      }
    }

    if (finalBest) {
      const st = isTrunkCandidate(finalBest);
      if (st.trunkDetected) {
        try {
          const nonTrunkCandidates = (resolution.candidates || []).filter(c => {
            const cs = isTrunkCandidate(c);
            return !cs.trunkDetected;
          });
          if (nonTrunkCandidates.length > 0) {
            // Ordina per score decrescente, scegli il migliore non-trunk
            nonTrunkCandidates.sort((a,b) => (b.score || 0) - (a.score || 0));
            finalBest = nonTrunkCandidates[0];
          }
        } catch (_) {}
      }
    }
    if (!finalBest) {
      try {
        const pathNames = new Set((traced?.path || []).map(p => p.sysName).filter(Boolean));
        const nonTrunkCandidates = (resolution.candidates || []).filter(c => {
          const cs = isTrunkCandidate(c);
          return !cs.trunkDetected;
        });
        if (nonTrunkCandidates.length > 0) {
          const ranked = nonTrunkCandidates.map(c => {
            let rscore = c.score || 0;
            if (pathNames.size > 0 && pathNames.has(c.sysName || c.ip)) rscore += 4;
            const pm = (c.ifName || '').match(/\/(\d+)$/);
            const pn = pm ? Number(pm[1]) : null;
            if (pn && pn <= 2) rscore -= 4;
            if (pn && pn >= 3 && pn <= 24) rscore += 1;
            if (pn && pn >= 25) rscore -= 6;
            return { c, rscore };
          });
          ranked.sort((a,b) => b.rscore - a.rscore);
          finalBest = ranked[0]?.c || null;
        }
      } catch (_) {}
    }

    res.json({
      query: mac,
      normalized: cleanMac.match(/.{2}/g).join(':'),
      network,
      scanned: targets.length,
      localCache: { count: localResults.length, data: localResults },
      snmp: { count: unique.length, data: unique, final: finalBest, trace: traced }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== DEVICE DETAIL ==========

// Endpoint: Ottieni dettagli completi di un device
app.get('/api/devices/:deviceName/detail', async (req, res) => {
  const { deviceName } = req.params;

  try {
    console.log(`[DEVICE-DETAIL] Richiesta dettagli per device: ${deviceName}`);

    // Tentativo 1: Usa NeDi se disponibile
    if (nediDB) {
      try {
        console.log(`[DEVICE-DETAIL] Provo a recuperare da NeDi...`);
        const nediData = await nediDB.getDeviceFullStatus(deviceName);
        console.log(`[DEVICE-DETAIL] Dati recuperati da NeDi con successo`);
        return res.json({
          source: 'nedi',
          ...nediData
        });
      } catch (nediErr) {
        console.warn(`[DEVICE-DETAIL] NeDi fallito, provo database locale:`, nediErr.message);
        // Continua con fallback locale
      }
    }

    // Fallback: Database locale SQLite
    console.log(`[DEVICE-DETAIL] Recupero da database locale...`);
    const device = db.getDevice(deviceName);

    if (!device) {
      return res.status(404).json({ 
        error: 'Device non trovato',
        deviceName,
        message: `Nessun device trovato con nome o IP: ${deviceName}`
      });
    }

    // Recupera dati correlati in parallelo
    const [interfaces, vlans, links, events, monitoring] = await Promise.all([
      Promise.resolve(db.getDeviceInterfaces(device.id) || []),
      Promise.resolve(
        db.db.prepare('SELECT * FROM vlans WHERE device_id = ?').all(device.id) || []
      ),
      Promise.resolve(db.getDeviceLinks(device.id) || []),
      Promise.resolve(
        db.db.prepare(`
          SELECT * FROM events 
          WHERE device_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 10
        `).all(device.id) || []
      ),
      Promise.resolve(
        db.db.prepare('SELECT * FROM monitoring WHERE device_id = ?').get(device.id)
      )
    ]);

    // Formatta risposta compatibile con NeDi
    const response = {
      source: 'local',
      device: {
        sysname: device.sysname,
        ip: device.ip,
        model: device.model,
        vendor: device.vendor,
        os: device.os,
        location: device.location,
        serial: device.serial,
        status: device.status,
        uptime: device.uptime,
        lastseen: device.lastseen,
        firstseen: device.firstseen
      },
      interfaces: {
        count: interfaces.length,
        list: interfaces.map(iface => ({
          ifindex: iface.ifindex,
          ifname: iface.ifname,
          ifdescr: iface.ifdescr,
          ifalias: iface.ifalias,
          iftype: iface.iftype,
          ifmtu: iface.ifmtu,
          ifspeed: iface.ifspeed,
          ifphysaddress: iface.ifphysaddress,
          ifadminstatus: iface.ifadminstatus,
          ifoperstatus: iface.ifoperstatus,
          iflastchange: iface.iflastchange
        }))
      },
      vlans: {
        count: vlans.length,
        list: vlans.map(vlan => ({
          vlan_id: vlan.vlan_id,
          vlan_name: vlan.vlan_name,
          vlan_status: vlan.vlan_status
        }))
      },
      connections: {
        count: links.length,
        list: links.map(link => ({
          local_interface: link.local_ifindex,
          remote_device: link.remote_sysname,
          remote_interface: link.remote_portid,
          remote_ip: link.remote_ip,
          protocol: link.discovery_protocol
        }))
      },
      events: {
        count: events.length,
        list: events.map(event => ({
          timestamp: event.timestamp,
          type: event.type,
          severity: event.severity,
          message: event.message,
          details: event.details
        }))
      },
      status: monitoring ? {
        cpu_usage: monitoring.cpu_usage,
        memory_usage: monitoring.memory_usage,
        temperature: monitoring.temperature,
        uptime_seconds: device.uptime,
        status: monitoring.status,
        latency: monitoring.latency,
        last_check: monitoring.last_check,
        alerts: monitoring.status === 'down' ? ['Device non raggiungibile'] : []
      } : {
        cpu_usage: null,
        memory_usage: null,
        temperature: null,
        uptime_seconds: device.uptime,
        status: 'unknown',
        alerts: ['Dati monitoring non disponibili']
      },
      timestamp: Date.now()
    };

    console.log(`[DEVICE-DETAIL] Dati recuperati da database locale con successo`);
    res.json(response);

  } catch (err) {
    console.error('[DEVICE-DETAIL] Errore:', err);
    res.status(500).json({ 
      error: 'Errore interno del server',
      message: err.message,
      deviceName
    });
  }
});

// ========== REPORTING ==========

// Report utilizzo porte
app.get('/api/reports/port-usage', (req, res) => {
  try {
    const devices = db.getAllDevices();
    const report = {
      generated: new Date().toISOString(),
      summary: {
        totalDevices: devices.length,
        totalPorts: 0,
        portsUp: 0,
        portsDown: 0,
        portsAdminDown: 0,
        utilizationPercent: 0,
      },
      byDevice: [],
    };

    for (const device of devices) {
      const ports = db.getPortStatistics(device.id);
      const up = ports.filter(p => p.ifoperstatus === 1).length;
      const down = ports.filter(p => p.ifoperstatus !== 1 && p.ifadminstatus !== 2).length;
      const adminDown = ports.filter(p => p.ifadminstatus === 2).length;
      const totalMAC = ports.reduce((sum, p) => sum + (p.macCount || 0), 0);

      report.summary.totalPorts += ports.length;
      report.summary.portsUp += up;
      report.summary.portsDown += down;
      report.summary.portsAdminDown += adminDown;

      report.byDevice.push({
        ip: device.ip,
        sysname: device.sysname,
        vendor: device.vendor,
        model: device.model,
        totalPorts: ports.length,
        portsUp: up,
        portsDown: down,
        portsAdminDown: adminDown,
        macCount: totalMAC,
        utilizationPercent: ports.length > 0 ? Math.round((up / (ports.length - adminDown)) * 100) : 0,
      });
    }

    // Calcola utilizzo globale
    const activePorts = report.summary.totalPorts - report.summary.portsAdminDown;
    report.summary.utilizationPercent = activePorts > 0
      ? Math.round((report.summary.portsUp / activePorts) * 100)
      : 0;

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========= NEW: Robust SSH Trace Endpoint (v2) =========
// Metodo: POST
// Path: /api/trace/ssh/v2
// Scopo: Traccia percorso MAC via SSH-first con fallback LLDP (interface + brief), SNMP e DB
// Autenticazione: opzionale (richiesta se env API_KEY è definita). Header: Authorization: Bearer <API_KEY>
// Input (JSON):
//   - mac: string (formati accettati: AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff, aabbccddeeff)
//   - network: string CIDR (es. 192.168.3.0/24)
//   - startIp: string IPv4 opzionale (override del CORE)
//   - fastCoreOnly: boolean opzionale (true: restituisce solo hop CORE)
// Output (JSON):
//   - query, normalized, network, coreSwitch, elapsed, hops, found, endpoint, path[]
// Status:
//   - 200: successo
//   - 400: input non valido
//   - 401: non autorizzato (se API_KEY impostata)
//   - 429: rate limit
//   - 500: errore interno
// Limitazioni:
//   - Dipende da connettività SSH/SNMP ai device
//   - LLDP può non fornire Management IP per alcuni neighbor
//   - Rate limit semplice in memoria
function isValidMac(s) {
  const hex = String(s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex);
}
function normalizeMac(s) {
  return String(s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}
function isValidIPv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''));
}
function isValidCIDR(cidr) {
  const m = String(cidr || '').match(/^(\d{1,3}(\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/);
  return !!m;
}
const API_KEY = process.env.API_KEY || '';
function requireAuth(req, res, next) {
  if (!API_KEY) return next();
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token && token === API_KEY) return next();
  return res.status(401).json({ error: 'Non autorizzato' });
}
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || req.headers['x-forwarded-for'] || 'local';
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { ts: now, count: 0 };
  if (now - bucket.ts > 10000) { bucket.ts = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > 20) return res.status(429).json({ error: 'Troppi richieste, riprova più tardi' });
  next();
}
app.post('/api/trace/ssh/v2', requireAuth, rateLimit, async (req, res) => {
  const t0 = Date.now();
  try {
    const { mac, network, startIp, fastCoreOnly = false } = req.body || {};
    if (!mac || !network) return res.status(400).json({ error: 'Parametri richiesti: mac, network' });
    if (!isValidMac(mac)) return res.status(400).json({ error: 'MAC non valido (12 hex)' });
    if (!isValidCIDR(network)) return res.status(400).json({ error: 'Network CIDR non valido' });
    if (startIp && !isValidIPv4(startIp)) return res.status(400).json({ error: 'startIp non valido' });
    const cleanMac = normalizeMac(mac);
    const hyphenMac = `${cleanMac.slice(0,4)}-${cleanMac.slice(4,8)}-${cleanMac.slice(8,12)}`;
    const parts = network.split('/')[0].split('.');
    const coreIp = `${parts[0]}.${parts[1]}.${parts[2]}.251`;
    const credsMap = loadCsvCredentials();
    const siteCredsArray = credsMap.byNetwork.get(network) || credsMap.bySite.get(String(parts[1])) || [];
    const siteCreds = siteCredsArray[0] || null;
    const sshCredsAlt = siteCredsArray.slice(1);  // Credenziali alternative
    const coreFallback = credsMap.coreFallback || null;
    const path = [];
    let currentIp = startIp && isValidIPv4(startIp) ? startIp : coreIp;
    let endpoint = null;
    let hops = 0;
    const logs = [];
    const TIMEOUT = 15000;
    const createSession = (ip) => snmp.createSession(ip, COMMUNITY, { timeout: TIMEOUT, retries: 2, version: snmp.Version2c });
    const getSysName = (ip) => new Promise((resolve) => {
      const s = createSession(ip);
      s.get(['1.3.6.1.2.1.1.5.0'], (err, vb) => { try { s.close(); } catch(_) {} ; resolve(err ? null : vb?.[0]?.value?.toString() || null); });
    });
    while (hops < 10) {
      const sysName = await getSysName(currentIp);
      logs.push({ ip: currentIp, cmd: 'SNMP sysName', out: shortenOutput(sysName || '') });
      let sshCreds = siteCreds;
      if (!sshCreds && /\.251$/.test(currentIp)) sshCreds = coreFallback || null;
      const hop = { ip: currentIp, sysName };
      path.push(hop);
      hops++;
      if (!sshCreds) {
        endpoint = hop;
        break;
      }
      const macOut = await tryMacCli(currentIp, sshCreds, coreFallback, hyphenMac, sshCredsAlt);
      logs.push({ ip: currentIp, cmd: `display mac-address ${hyphenMac}`, out: shortenOutput(macOut) });
      const cliIf = parseInterfaceFromMacOutput(macOut);
      const cliVlan = parseVlanFromMacOutput(macOut);
      if (cliVlan && hop && !hop.vlan) hop.vlan = cliVlan;
      try {
        const variants = interfaceCommandVariants(cliIf || '');
        const briefAll = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display interface brief`, sshCredsAlt);
        logs.push({ ip: currentIp, cmd: `display interface brief`, out: shortenOutput(briefAll) });
        const briefLine = findInterfaceBriefLine(briefAll, variants);
        if (briefLine) hop.interfaceBrief = briefLine;
      } catch (_) {}
      if (cliVlan) {
        try {
          const vlanOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display vlan ${cliVlan}`, sshCredsAlt);
          logs.push({ ip: currentIp, cmd: `display vlan ${cliVlan}`, out: shortenOutput(vlanOut) });
          const variants = interfaceCommandVariants(cliIf || '');
          hop.vlanHasPort = vlanIncludesAnyInterface(vlanOut, variants);
        } catch (_) {}
      }
      if (!cliIf) {
        endpoint = hop;
        break;
      }
      if (/eth-?trunk/i.test(cliIf)) {
        let nextHop = null;
        const trunkNum = (cliIf.match(/eth-?trunk\s*(\d+)/i) || cliIf.match(/Eth-?Trunk(\d+)/i))?.[1];
        if (trunkNum) {
          const trunkOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display eth-trunk ${trunkNum}`, sshCredsAlt);
          logs.push({ ip: currentIp, cmd: `display eth-trunk ${trunkNum}`, out: shortenOutput(trunkOut) });
          const members = parseTrunkMembers(trunkOut);
          if (members?.length) hop.trunkMembers = members;
          if (cliVlan) {
            try {
              const vlanOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display vlan ${cliVlan}`, sshCredsAlt);
              logs.push({ ip: currentIp, cmd: `display vlan ${cliVlan}`, out: shortenOutput(vlanOut) });
              const variants = interfaceCommandVariants(cliIf || '');
              hop.vlanHasPort = vlanIncludesAnyInterface(vlanOut, variants);
            } catch (_) {}
          }
          for (const m of members) {
            const nOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor interface ${m}`, sshCredsAlt);
            logs.push({ ip: currentIp, cmd: `display lldp neighbor interface ${m}`, out: shortenOutput(nOut) });
            const nIp = parseLldpNeighborIp(nOut);
            const nName = parseLldpNeighborName(nOut);
            if (nIp) { nextHop = nIp; break; }
            if (!nIp && nName) {
              let ipCand = await getNeighborMgmtIpByName(currentIp, nName, createSession);
              if (!ipCand) ipCand = findDeviceIp(nName);
              if (ipCand) { nextHop = ipCand; break; }
            }
          }
          if (!nextHop) {
            const brief = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor brief`, sshCredsAlt);
            logs.push({ ip: currentIp, cmd: `display lldp neighbor brief`, out: shortenOutput(brief) });
            const names = parseLldpBriefNames(brief);
            const siteId2 = String(parts[1]).padStart(2, '0');
            const sitePrefix = `${siteId2}_L2_`;
            for (const nm of names) {
              if (!/_L2_|_L3_/.test(nm)) continue;
              if (!nm.startsWith(sitePrefix) && !nm.includes(sitePrefix)) continue;
              let ipCand = await getNeighborMgmtIpByName(currentIp, nm, createSession).catch(() => null);
              if (!ipCand) ipCand = findDeviceIp(nm);
              if (ipCand) { nextHop = ipCand; hop.lldpNeighbor = nm; break; }
            }
          }
        }
        if (!nextHop) {
          endpoint = hop;
          break;
        }
        hop.ifName = cliIf;
        hop.nextHop = nextHop;
        try {
          const arpOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display arp | include ${hyphenMac}`, sshCredsAlt);
          logs.push({ ip: currentIp, cmd: `display arp | include ${hyphenMac}`, out: shortenOutput(arpOut) });
          if (String(arpOut || '').trim().length > 0) hop.arpHit = true;
        } catch (_) {}
        try {
          const macvOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display mac-vlan | include ${hyphenMac}`, sshCredsAlt);
          logs.push({ ip: currentIp, cmd: `display mac-vlan | include ${hyphenMac}`, out: shortenOutput(macvOut) });
          if (String(macvOut || '').trim().length > 0) hop.macVlanHit = true;
        } catch (_) {}
        if (fastCoreOnly) { endpoint = hop; break; }
        currentIp = nextHop;
        continue;
      } else {
        hop.ifName = cliIf;
        let lOut = '';
        let lName = null;
        let lIp = null;
        try {
          const variants = interfaceCommandVariants(cliIf);
          for (const v of variants) {
            lOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor interface ${v}`, sshCredsAlt);
            logs.push({ ip: currentIp, cmd: `display lldp neighbor interface ${v}`, out: shortenOutput(lOut) });
            lName = parseLldpNeighborName(lOut);
            lIp = parseLldpNeighborIp(lOut);
            if (lName || lIp) break;
          }
        } catch (_) {}
        if (cliVlan) {
          try {
            const vlanOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display vlan ${cliVlan}`, sshCredsAlt);
            logs.push({ ip: currentIp, cmd: `display vlan ${cliVlan}`, out: shortenOutput(vlanOut) });
            const variants = interfaceCommandVariants(cliIf || '');
            hop.vlanHasPort = vlanIncludesAnyInterface(vlanOut, variants);
          } catch (_) {}
        }
        if (!lName && !lIp) {
          const brief = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display lldp neighbor brief`, sshCredsAlt);
          logs.push({ ip: currentIp, cmd: `display lldp neighbor brief`, out: shortenOutput(brief) });
          const names = parseLldpBriefNames(brief);
          const siteId2 = String(parts[1]).padStart(2, '0');
          const sitePrefix = `${siteId2}_L2_`;
          for (const nm of names) {
            if (!/_L2_|_L3_/.test(nm)) continue;
            if (!nm.startsWith(sitePrefix) && !nm.includes(sitePrefix)) continue;
            let ipCand = await getNeighborMgmtIpByName(currentIp, nm, createSession).catch(() => null);
            if (!ipCand) ipCand = findDeviceIp(nm);
            if (ipCand) { lName = nm; lIp = ipCand; break; }
          }
        }
        if (lName && /(_L2_|_L3_)/.test(lName)) {
          const nextHop = lIp || await getNeighborMgmtIpByName(currentIp, lName, createSession).catch(() => null) || findDeviceIp(lName);
          if (nextHop) {
            hop.lldpNeighbor = lName;
            hop.nextHop = nextHop;
            try {
              const arpOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display arp | include ${hyphenMac}`, sshCredsAlt);
              logs.push({ ip: currentIp, cmd: `display arp | include ${hyphenMac}`, out: shortenOutput(arpOut) });
              if (String(arpOut || '').trim().length > 0) hop.arpHit = true;
            } catch (_) {}
            try {
              const macvOut = await runSwitchCommand(currentIp, sshCreds, coreFallback, `display mac-vlan | include ${hyphenMac}`, sshCredsAlt);
              logs.push({ ip: currentIp, cmd: `display mac-vlan | include ${hyphenMac}`, out: shortenOutput(macvOut) });
              if (String(macvOut || '').trim().length > 0) hop.macVlanHit = true;
            } catch (_) {}
            currentIp = nextHop;
            continue;
          }
        }
        endpoint = { ...hop, lldpNeighbor: lName || undefined, endpointDevice: lName || undefined };
        break;
      }
    }
    const elapsed = `${Date.now() - t0}ms`;
    res.status(200).json({
      query: mac,
      normalized: cleanMac,
      network,
      coreSwitch: coreIp,
      elapsed,
      hops: path.length,
      found: !!endpoint,
      endpoint,
      path,
      logs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Report VLAN
app.get('/api/reports/vlans', (req, res) => {
  try {
    const vlans = db.db.prepare(`
      SELECT v.vlan_id, v.vlan_name, d.ip, d.sysname,
        (SELECT COUNT(*) FROM interface_vlans iv 
         JOIN interfaces i ON iv.interface_id = i.id 
         WHERE i.device_id = v.device_id AND iv.vlan_id = v.vlan_id) as port_count
      FROM vlans v
      JOIN devices d ON v.device_id = d.id
      ORDER BY v.vlan_id, d.sysname
    `).all();

    // Raggruppa per VLAN
    const vlanMap = new Map();
    vlans.forEach(v => {
      if (!vlanMap.has(v.vlan_id)) {
        vlanMap.set(v.vlan_id, {
          vlan_id: v.vlan_id,
          vlan_name: v.vlan_name,
          devices: [],
          totalPorts: 0,
        });
      }
      const entry = vlanMap.get(v.vlan_id);
      entry.devices.push({ ip: v.ip, sysname: v.sysname, port_count: v.port_count });
      entry.totalPorts += v.port_count || 0;
    });

    res.json({
      generated: new Date().toISOString(),
      count: vlanMap.size,
      vlans: Array.from(vlanMap.values()).sort((a, b) => a.vlan_id - b.vlan_id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', host: os.hostname() });
});

// Cache statistics endpoint for monitoring
app.get('/api/cache/stats', (req, res) => {
  res.json({
    mapCache: mapCache.getStats(),
    deviceCache: deviceCache.getStats(),
    timestamp: Date.now()
  });
});

// Test endpoint per verificare discovery LLDP
app.get('/api/test-discovery/:ip', async (req, res) => {
  const { ip } = req.params;
  const community = req.query.community || process.env.SNMP_COMMUNITY || 'public';

  try {
    console.log(`[TEST] Discovery LLDP per ${ip} con community ${community}`);
    snmpAgent.community = community;
    const discovery = await snmpAgent.discoverProtocols(ip, 10000);

    // Log dettagliato per debug
    if (discovery.lldp && discovery.lldp.length > 0) {
      console.log(`[TEST] Trovati ${discovery.lldp.length} neighbor LLDP`);
      discovery.lldp.slice(0, 3).forEach((n, idx) => {
        console.log(`[TEST] Neighbor ${idx}:`, JSON.stringify(n, null, 2));
      });
    }

    res.json({
      ip,
      community,
      lldp: discovery.lldp || [],
      cdp: discovery.cdp || [],
      fdp: discovery.fdp || [],
      edp: discovery.edp || [],
      sysName: discovery.sysName || null,
      sysDescr: discovery.sysDescr || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint per link asimmetrici (forward_status != reverse_status)
app.get('/api/test/asymmetric-links', (req, res) => {
  try {
    const devices = db.getAllDevices();
    const links = db.getAllLinks();

    // Stati possibili per test
    const statuses = ['up', 'down', 'degraded', 'unknown'];

    // Mappa device_id -> ip
    const deviceIdToIp = new Map();
    const ipToDevice = new Map();
    devices.forEach(device => {
      deviceIdToIp.set(device.id, device.ip);
      ipToDevice.set(device.ip, device);
    });

    // Genera dati test con stati asimmetrici
    const testLinks = links
      .filter(link => link.remote_device_id) // Solo link completi
      .slice(0, 20) // Limita a 20 link per test
      .map((link, index) => {
        // Assegna stati diversi in modo deterministico
        const forwardStatus = statuses[index % statuses.length];
        const reverseStatus = statuses[(index + 1) % statuses.length];

        const fromIp = link.local_ip || deviceIdToIp.get(link.device_id);
        const toIp = link.remote_device_ip || deviceIdToIp.get(link.remote_device_id);

        return {
          source: fromIp,
          target: toIp,
          di: link.local_ifname || '',
          ni: link.remote_portdesc || link.remote_portid || '',
          protocol: link.protocol || 'LLDP',
          speed: 1000, // Default 1G per test
          forward_status: forwardStatus,
          reverse_status: reverseStatus,
          // Tag per identificare i link test
          isTestData: true
        };
      });

    // Prepara nodi (devices) per il frontend
    const nodes = devices.map(device => ({
      id: device.ip,
      label: device.sysname || device.ip,
      sysname: device.sysname,
      ip: device.ip,
      type: device.status === 'neighbor' ? 'neighbor' : 'device',
      status: device.status || 'active',
      level: device.level || 0
    }));

    res.json({
      nodes,
      links: testLinks,
      meta: {
        totalDevices: devices.length,
        totalLinks: links.length,
        testLinksGenerated: testLinks.length,
        statusTypes: statuses,
        message: 'Dati test con stati asimmetrici (forward_status != reverse_status)',
        usage: 'Usa questi dati per testare i gradients bidirezionali nella mappa'
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== NEDI DATABASE ENDPOINTS ==========
// Endpoint per usare NeDi come database principale

let nediDb = null;

async function getNedi() {
  if (!nediDb) {
    nediDb = await getNeDiDB();
  }
  return nediDb;
}

// Stats NeDi
app.get('/api/nedi/stats', async (req, res) => {
  try {
    const nedi = await getNedi();
    const { site } = req.query;

    if (site) {
      // Stats filtrate per sito
      const stats = await nedi.getStatsBySite(site);
      res.json(stats);
    } else {
      const stats = await nedi.getStats();
      res.json(stats);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista siti NeDi (estratti dal prefisso nome device)
app.get('/api/nedi/sites', async (req, res) => {
  try {
    const nedi = await getNedi();
    const sites = await nedi.getSites();
    res.json({ sites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Devices NeDi
app.get('/api/nedi/devices', async (req, res) => {
  try {
    const nedi = await getNedi();
    const { limit = 100, offset = 0, status, site } = req.query;
    const devices = await nedi.getDevicesPaginated({
      limit: parseInt(limit),
      offset: parseInt(offset),
      status,
      site
    });
    const count = await nedi.getDevicesCount({ status, site });
    res.json({ devices, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Device singolo NeDi
app.get('/api/nedi/devices/:identifier', async (req, res) => {
  try {
    const nedi = await getNedi();
    const device = await nedi.getDevice(req.params.identifier);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Interfacce device NeDi
app.get('/api/nedi/devices/:identifier/interfaces', async (req, res) => {
  try {
    const nedi = await getNedi();
    const interfaces = await nedi.getDeviceInterfaces(req.params.identifier);
    res.json(interfaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Links device NeDi
app.get('/api/nedi/devices/:identifier/links', async (req, res) => {
  try {
    const nedi = await getNedi();
    const links = await nedi.getDeviceLinks(req.params.identifier);
    res.json(links);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tutti i links NeDi
app.get('/api/nedi/links', async (req, res) => {
  try {
    const nedi = await getNedi();
    const links = await nedi.getAllLinks();
    res.json(links);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/nedi/search/mac/:mac', async (req, res) => {
  try {
    const nedi = await getNedi();
    const macInput = (req.params.mac || '').toLowerCase();
    const clean = macInput.replace(/[:.|-]/g, '');
    const { site, vlan } = req.query;
    const siteFilter = site && /^\d{1,3}$/.test(site) ? site : null;
    const vlanNum = vlan !== undefined ? parseInt(vlan) : null;
    if (!clean || clean.length !== 12 || !/^[0-9a-f]{12}$/.test(clean)) {
      return res.status(400).json({ error: 'MAC non valido (12 caratteri esadecimali)' });
    }

    let nodesSql = `SELECT mac, device, ifname, vlanid FROM nodes WHERE mac = '${clean}'`;
    if (siteFilter) nodesSql += ` AND device LIKE '${siteFilter}_%'`;
    if (vlanNum !== null && !Number.isNaN(vlanNum)) nodesSql += ` AND vlanid = ${vlanNum}`;
    nodesSql += ` LIMIT 100`;

    let nodarpSql = `SELECT mac, INET_NTOA(nodip) AS ip, arpdevice, arpifname FROM nodarp WHERE mac = '${clean}'`;
    if (siteFilter) nodarpSql += ` AND arpdevice LIKE '${siteFilter}_%'`;
    nodarpSql += ` LIMIT 100`;

    const nodesOut = await nedi.execQuery(nodesSql);
    const nodarpOut = await nedi.execQuery(nodarpSql);

    const nodesCols = ['mac', 'device', 'ifname', 'vlanid'];
    const arpCols = ['mac', 'ip', 'arpdevice', 'arpifname'];

    const nodes = nedi.parseRows(nodesOut, nodesCols);
    const arp = nedi.parseRows(nodarpOut, arpCols);

    res.json({
      query: req.params.mac,
      normalized: clean.match(/.{2}/g).join(':'),
      results: {
        nodes: { count: nodes.length, data: nodes },
        arp: { count: arp.length, data: arp }
      },
      totalCount: nodes.length + arp.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mappa topologica NeDi (formato compatibile con frontend)
app.get('/api/nedi/map', async (req, res) => {
  try {
    const nedi = await getNedi();
    const { filter, level = 1 } = req.query;

    const topo = await nedi.getTopologyData({
      deviceFilter: filter,
      level: parseInt(level)
    });

    // Converti in formato frontend
    const nodes = topo.nodes.map(n => ({
      id: n.id,
      label: n.label,
      ip: n.ip,
      type: 'device',
      vendor: n.vendor,
      model: n.type,
      location: n.location,
      status: 'active'
    }));

    const links = topo.edges.map((e, i) => ({
      id: `link-${i}`,
      source: e.source,
      target: e.target,
      source_port: e.sourcePort,
      target_port: e.targetPort,
      protocol: e.protocol,
      status: 'up'
    }));

    res.json({
      nodes,
      links,
      meta: {
        source: 'nedi',
        totalDevices: nodes.length,
        totalLinks: links.length,
        filter: filter || 'all'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mappa per negozio specifico (es. /api/nedi/map/10 per negozio 10)
app.get('/api/nedi/map/:store', async (req, res) => {
  try {
    const nedi = await getNedi();
    const storeFilter = `${req.params.store}_`;

    const topo = await nedi.getTopologyData({ deviceFilter: storeFilter });

    const nodes = topo.nodes.map(n => ({
      id: n.id,
      label: n.label,
      ip: n.ip,
      type: 'device',
      vendor: n.vendor,
      model: n.type,
      location: n.location,
      status: 'active'
    }));

    const links = topo.edges.map((e, i) => ({
      id: `link-${i}`,
      source: e.source,
      target: e.target,
      source_port: e.sourcePort,
      target_port: e.targetPort,
      protocol: e.protocol,
      status: 'up'
    }));

    res.json({
      nodes,
      links,
      meta: {
        source: 'nedi',
        store: req.params.store,
        totalDevices: nodes.length,
        totalLinks: links.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// MAC-TRACKER V3 API ENDPOINTS
// Cache-first con refresh on-demand
// IMPORTANTE: Route specifiche PRIMA di quelle con parametri!
// =============================================================================

/**
 * GET /api/v3/mac/status
 * Stato cache e sync job
 */
app.get('/api/v3/mac/status', (req, res) => {
  try {
    const cacheStats = macCacheV3.getStats();
    const syncStatus = macSyncJob ? macSyncJob.getStatus() : { isRunning: false, message: 'Sync job non inizializzato' };

    res.json({
      cache: cacheStats,
      sync: syncStatus,
      version: 'v3'
    });

  } catch (err) {
    console.error('[MAC-V3] Errore status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v3/mac/search
 * Ricerca con filtri multipli
 * Query: mac, ip, vlan, switch, limit
 */
app.get('/api/v3/mac/search', (req, res) => {
  const { mac, ip, vlan, switch: sw, limit = 50 } = req.query;
  const t0 = Date.now();

  try {
    const results = macCacheV3.search(
      { mac, ip, vlan: vlan ? parseInt(vlan) : undefined, switch: sw },
      parseInt(limit)
    );

    res.set('X-Cache-Age', macCacheV3.getAgeSeconds());

    res.json({
      totalCount: results.length,
      results: results,
      filters: { mac, ip, vlan, switch: sw },
      cacheAge: macCacheV3.getAge(),
      searchTime: Date.now() - t0
    });

  } catch (err) {
    console.error('[MAC-V3] Errore search:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v3/mac/sync
 * Forza sync immediato da NeDi
 */
app.post('/api/v3/mac/sync', async (req, res) => {
  console.log('[MAC-V3] Sync forzato richiesto');

  try {
    if (!macSyncJob) {
      // Prova ad avviare il sync job
      await startMacSyncJob();
      if (!macSyncJob) {
        return res.status(503).json({
          success: false,
          error: 'NeDi non disponibile per sync'
        });
      }
    }

    const result = await macSyncJob.forceSync();

    res.json({
      success: result.success,
      entries: result.entries,
      duration: result.duration,
      nodes: result.nodes,
      arp: result.arp,
      devices: result.devices,
      error: result.error
    });

  } catch (err) {
    console.error('[MAC-V3] Errore sync forzato:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/v3/mac/:mac/refresh
 * Trigger refresh SSH live per MAC specifico
 */
app.post('/api/v3/mac/:mac/refresh', async (req, res) => {
  const { mac } = req.params;
  const t0 = Date.now();

  console.log(`[MAC-V3] Refresh richiesto per: ${mac}`);

  try {
    // Prima cerca in cache per info switch
    const cached = macCacheV3.get(mac);

    if (!cached || !cached.endpoint?.switchIp) {
      return res.status(404).json({
        success: false,
        error: 'MAC non in cache o switch IP non disponibile',
        hint: 'Attendere sync NeDi o cercare manualmente'
      });
    }

    // Esegui SSH lookup
    const switchIp = cached.endpoint.switchIp;
    // Converte MAC in formato Huawei: xxxx-xxxx-xxxx
    const cleanMac = mac.replace(/[:\-\.]/g, '').toLowerCase();
    const huaweiMac = cleanMac.replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');

    console.log(`[MAC-V3] SSH refresh su ${switchIp} per MAC ${huaweiMac}`);

    // Carica credenziali dal CSV
    const credsMap = loadCsvCredentials();
    const coreFallback = credsMap.coreFallback || { username: 'admin', password: '' };

    // Cerca credenziali per questo IP nel CSV (byNetwork)
    let siteCreds = null;
    for (const [network, credsArray] of credsMap.byNetwork) {
      // Semplice check se l'IP inizia con il prefisso di rete
      const networkPrefix = network.split('/')[0].split('.').slice(0, 3).join('.');
      if (switchIp.startsWith(networkPrefix)) {
        siteCreds = credsArray[0];
        break;
      }
    }

    // Fallback a credenziali CORE se non trovate
    if (!siteCreds) {
      siteCreds = coreFallback;
    }

    // Esegui comando SSH con runSwitchCommand (gestisce fallback)
    const command = `display mac-address ${huaweiMac}`;
    const output = await runSwitchCommand(switchIp, siteCreds, coreFallback, command);

    // Parse output Huawei: "MAC address  VLAN  Learned-From  Type"
    // Esempio: "142e-5e8e-8fbe   1   GE0/0/47   dynamic"
    let parsedPort = null;
    let parsedVlan = null;

    if (output) {
      const lines = output.split('\n');
      for (const line of lines) {
        // Cerca linea con MAC (formato Huawei: xxxx-xxxx-xxxx)
        const match = line.match(/([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\s+(\d+)\s+(\S+)/i);
        if (match) {
          parsedVlan = parseInt(match[2]);
          parsedPort = match[3];
          break;
        }
      }
    }

    console.log(`[MAC-V3] Parsed output: port=${parsedPort}, vlan=${parsedVlan}`);

    if (parsedPort) {
      // Aggiorna cache con dati live
      macCacheV3.update(mac, {
        endpoint: {
          ...cached.endpoint,
          port: parsedPort,
          vlan: parsedVlan || cached.endpoint.vlan,
          source: 'ssh'
        },
        liveVerified: Date.now()
      });

      console.log(`[MAC-V3] Refresh completato: ${mac} -> ${parsedPort}`);

      res.json({
        success: true,
        mac: mac,
        endpoint: {
          switch: cached.endpoint.switch,
          switchIp: switchIp,
          port: parsedPort,
          vlan: parsedVlan || cached.endpoint.vlan,
          source: 'ssh'
        },
        liveVerified: new Date().toISOString(),
        refreshTime: Date.now() - t0
      });

    } else {
      res.json({
        success: false,
        mac: mac,
        message: 'MAC non trovato su switch (potrebbe essere offline)',
        rawOutput: output?.substring(0, 200),
        cached: cached.endpoint,
        refreshTime: Date.now() - t0
      });
    }

  } catch (err) {
    console.error('[MAC-V3] Errore refresh:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      refreshTime: Date.now() - t0
    });
  }
});

/**
 * GET /api/v3/mac/:mac
 * Ricerca MAC in cache (O(1))
 * Header X-Cache-Age indica età cache
 * NOTA: Questa route DEVE essere l'ultima perché cattura tutto!
 */
app.get('/api/v3/mac/:mac', (req, res) => {
  const { mac } = req.params;
  const t0 = Date.now();

  try {
    const result = macCacheV3.get(mac);
    const cacheAge = macCacheV3.getAgeSeconds();

    // Headers cache info
    res.set('X-Cache-Age', cacheAge);
    res.set('X-Cache-Stale', macCacheV3.isStale());

    if (!result) {
      return res.status(404).json({
        found: false,
        mac: mac,
        message: 'MAC non trovato in cache',
        cacheAge: macCacheV3.getAge(),
        searchTime: Date.now() - t0
      });
    }

    res.json({
      found: true,
      mac: result.mac,
      endpoint: result.endpoint,
      ip: result.ip,
      hostname: result.hostname,
      vendor: result.vendor,
      lastSeen: result.lastSeen,
      liveVerified: result.liveVerified,
      cacheAge: macCacheV3.getAge(),
      searchTime: Date.now() - t0
    });

  } catch (err) {
    console.error('[MAC-V3] Errore lookup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// SSH MAC Collector API
// =============================================================================

/**
 * GET /api/admin/mac-collector/status
 * Ritorna stato e statistiche del collector
 */
app.get('/api/admin/mac-collector/status', (req, res) => {
  if (!macCollector) {
    return res.json({
      running: false,
      scheduled: false,
      message: 'Collector not initialized yet (starts 3 min after server boot)'
    });
  }
  res.json(macCollector.getStatus());
});

/**
 * POST /api/admin/mac-collector/run
 * Trigger manuale di un run
 */
app.post('/api/admin/mac-collector/run', async (req, res) => {
  if (!macCollector) {
    return res.status(503).json({
      error: 'Collector not initialized yet'
    });
  }

  // Esegui in background
  macCollector.run().catch(err => {
    console.error('[MAC-Collector] Manual run failed:', err.message);
  });

  res.json({
    started: true,
    message: 'Collection run started in background'
  });
});

/**
 * GET /api/admin/mac-collector/logs
 * Ritorna ultimi errori
 */
app.get('/api/admin/mac-collector/logs', (req, res) => {
  if (!macCollector) {
    return res.json({ errors: [] });
  }

  const status = macCollector.getStatus();
  res.json({
    lastRun: status.stats.lastRun,
    errors: status.stats.errors.slice(-100)  // Ultimi 100
  });
});

// =============================================================================
// AI Agent Routes
// =============================================================================
app.use('/api/agent', agentRoutes);
app.use('/api/agent', agentStreamRoutes);

const server = app.listen(PORT, async () => {
  console.log(`Netmap server in ascolto su http://localhost:${PORT}`);
});

// ============ PROTEZIONE ISTANZE DUPLICATE ============
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ ERRORE: Porta ${PORT} già in uso!`);
    console.error(`   Un'altra istanza di NetMap è già in esecuzione.`);
    console.error(`\n   Per gestire il servizio usa SOLO:`);
    console.error(`   → sudo systemctl restart netmap`);
    console.error(`   → sudo systemctl status netmap`);
    console.error(`\n   NON lanciare mai 'node server.js' manualmente!\n`);
    process.exit(1);
  } else {
    console.error('Errore server:', err);
    process.exit(1);
  }
});
// ======================================================

server.once('listening', () => {
  console.log(`  - API locale: /api/*`);
  console.log(`  - API NeDi:   /api/nedi/*`);
  console.log(`  - MAC-V3:     /api/v3/mac/*`);
  console.log(`  - AI Agents:  /api/agent/*`);
  console.log(`  - MAC Collector: /api/admin/mac-collector/*`);

  // Avvia MAC-V3 sync job in background
  setTimeout(() => {
    startMacSyncJob().catch(err => {
      console.error('[MAC-V3] Errore inizializzazione sync:', err.message);
    });
  }, 2000);  // Delay per permettere NeDi di inizializzare

  // Avvia SSH MAC Collector dopo 10 secondi
  setTimeout(async () => {
    try {
      const nedi = await getNedi();

      // Carica credenziali da CSV e costruisci mappa per network
      const credsMap = loadCsvCredentials();
      const credentialsByNetwork = new Map();

      // Popola mappa: network prefix -> credenziali
      for (const [network, credsArray] of credsMap.byNetwork) {
        if (credsArray.length > 0 && credsArray[0]?.username && credsArray[0]?.password) {
          // Estrai prefisso di rete dai primi 3 ottetti del CIDR (es. "192.168.5.0/24" -> "10.5.4")
          const prefix = network.split('/')[0].split('.').slice(0, 3).join('.');
          credentialsByNetwork.set(prefix, {
            username: credsArray[0].username,
            password: credsArray[0].password
          });
        }
      }

      console.log(`[MAC-Collector] Caricate ${credentialsByNetwork.size} credenziali per network`);

      macCollector = new SshMacCollector(nedi, {
        intervalMs: 15 * 60 * 1000,  // 15 minuti
        concurrency: 5,
        credentialsByNetwork: credentialsByNetwork,
        credentials: {
          username: process.env.SWITCH_SSH_USER || 'admin',
          password: process.env.SWITCH_SSH_PASS || ''
        }
      });
      macCollector.start(5000);  // Primo run dopo 5 secondi
      console.log('[MAC-Collector] Inizializzato e avviato');
    } catch (err) {
      console.error('[MAC-Collector] Errore inizializzazione:', err.message);
    }
  }, 10000);  // 10 secondi delay
});
