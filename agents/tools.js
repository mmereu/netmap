/**
 * NetMap AI Agent Tools
 * Custom tools for network management operations
 */

import { tool } from '@openai/agents';
import { z } from 'zod';

// Lazy imports per evitare circular dependencies
let db = null;
let nedi = null;

async function getDb() {
  if (!db) {
    const libdb = await import('../libdb.js');
    db = new libdb.default(); // Crea istanza della classe NetMapDB
  }
  return db;
}

async function getNeDi() {
  if (!nedi) {
    try {
      const libnedi = await import('../libnedi.js');
      nedi = await libnedi.getNeDiDB();
    } catch (error) {
      console.warn('[NeDi] Connessione non disponibile:', error.message);
      return null;
    }
  }
  return nedi;
}

// ============================================
// MAC TRACKER TOOLS
// ============================================

export const searchMac = tool({
  name: 'search_mac',
  description: 'Cerca un MAC address nella rete usando ricerca ibrida (DB + SSH trace). Trova lo switch e la porta dove il MAC è connesso. Accetta MAC e opzionalmente una network CIDR.',
  parameters: z.object({
    mac: z.string().describe('MAC address da cercare (formato: aa:bb:cc:dd:ee:ff)'),
    network: z.string().optional().describe('Network CIDR per limitare la ricerca. NON USARE se non specificato esplicitamente dall\'utente.'),
  }),
  async execute({ mac, network }) {
    try {
      // Usa l'API hybrid che combina DB + SSH trace
      const apiUrl = 'http://localhost:4000/api/search/mac/hybrid';
      const body = { mac };
      if (network && network.trim()) body.network = network.trim();

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (result.error) {
        return `Errore nella ricerca: ${result.error}`;
      }

      if (!result.found) {
        return `MAC ${mac} non trovato nella rete${network ? ` ${network}` : ''}.`;
      }

      // Formatta risposta leggibile
      const endpoint = result.endpoint || {};
      const path = result.sshResult?.path || [];

      let output = `✅ MAC ${mac} TROVATO!\n\n`;
      output += `📍 POSIZIONE:\n`;
      output += `   Switch: ${endpoint.sysName || 'N/A'}\n`;
      output += `   IP: ${endpoint.ip || 'N/A'}\n`;
      output += `   Porta: ${endpoint.ifName || 'N/A'}\n`;
      output += `   VLAN: ${endpoint.vlan || 'N/A'}\n`;

      if (path.length > 0) {
        output += `\n🔗 PERCORSO (${path.length} hop):\n`;
        path.forEach((hop, i) => {
          output += `   ${i + 1}. ${hop.sysName} (${hop.ip}) → ${hop.ifName}\n`;
        });
      }

      output += `\n⏱️ Ricerca: ${result.elapsed || 'N/A'}`;
      output += `\n📊 Fonte: ${result.source || 'hybrid'}`;

      return output;
    } catch (error) {
      return `Errore nella ricerca MAC: ${error.message}`;
    }
  },
});

export const getMacHistory = tool({
  name: 'get_mac_history',
  description: 'Ottiene lo storico dei movimenti di un MAC address nella rete.',
  parameters: z.object({
    mac: z.string().describe('MAC address da cercare'),
  }),
  async execute({ mac }) {
    try {
      const nediDb = await getNeDi();
      const history = await nediDb.getMacAddresses(mac);

      if (!history || history.length === 0) {
        return `Nessuno storico trovato per MAC ${mac}.`;
      }

      return JSON.stringify(history, null, 2);
    } catch (error) {
      return `Errore nel recupero storico MAC: ${error.message}`;
    }
  },
});

// ============================================
// DEVICE INFO TOOLS
// ============================================

export const getDeviceInfo = tool({
  name: 'get_device_info',
  description: 'Ottiene informazioni dettagliate su un dispositivo di rete (switch, router, AP) dato il nome o IP.',
  parameters: z.object({
    device: z.string().describe('Nome o IP del dispositivo'),
  }),
  async execute({ device }) {
    try {
      const nediDb = await getNeDi();
      const info = await nediDb.getDevice(device);

      if (!info) {
        // Prova nel DB locale
        const localDb = await getDb();
        const localInfo = localDb.getDevice(device);
        if (localInfo) {
          return JSON.stringify(localInfo, null, 2);
        }
        return `Dispositivo ${device} non trovato.`;
      }

      return JSON.stringify(info, null, 2);
    } catch (error) {
      return `Errore nel recupero info dispositivo: ${error.message}`;
    }
  },
});

export const getDeviceFullStatus = tool({
  name: 'get_device_full_status',
  description: 'Ottiene lo stato completo di un dispositivo: CPU, memoria, temperatura, interfacce, eventi, connessioni LLDP.',
  parameters: z.object({
    device: z.string().describe('Nome o IP del dispositivo'),
  }),
  async execute({ device }) {
    try {
      const nediDb = await getNeDi();
      const status = await nediDb.getDeviceFullStatus(device);

      if (!status) {
        return `Dispositivo ${device} non trovato o status non disponibile.`;
      }

      return JSON.stringify(status, null, 2);
    } catch (error) {
      return `Errore nel recupero status dispositivo: ${error.message}`;
    }
  },
});

export const getDevicePorts = tool({
  name: 'get_device_ports',
  description: 'Elenca tutte le porte/interfacce di un dispositivo con stato, velocità e VLAN.',
  parameters: z.object({
    device: z.string().describe('Nome o IP del dispositivo'),
  }),
  async execute({ device }) {
    try {
      const nediDb = await getNeDi();
      const interfaces = await nediDb.getDeviceInterfaces(device);

      if (!interfaces || interfaces.length === 0) {
        return `Nessuna interfaccia trovata per ${device}.`;
      }

      // Formatta output compatto
      const summary = interfaces.map(iface => ({
        port: iface.ifname,
        status: iface.ifstat === 3 ? 'UP' : 'DOWN',
        speed: iface.speed ? `${iface.speed} Mbps` : 'N/A',
        vlan: iface.pvid || 'N/A',
        description: iface.ifdescr || ''
      }));

      return JSON.stringify(summary, null, 2);
    } catch (error) {
      return `Errore nel recupero porte: ${error.message}`;
    }
  },
});

export const getDeviceConnections = tool({
  name: 'get_device_connections',
  description: 'Mostra le connessioni LLDP/CDP di un dispositivo (a quali altri dispositivi è collegato).',
  parameters: z.object({
    device: z.string().describe('Nome o IP del dispositivo'),
  }),
  async execute({ device }) {
    try {
      const nediDb = await getNeDi();
      const connections = await nediDb.getDeviceConnections(device);

      if (!connections || connections.length === 0) {
        return `Nessuna connessione LLDP/CDP trovata per ${device}.`;
      }

      return JSON.stringify(connections, null, 2);
    } catch (error) {
      return `Errore nel recupero connessioni: ${error.message}`;
    }
  },
});

// ============================================
// NETWORK DISCOVERY TOOLS
// ============================================

export const listDevices = tool({
  name: 'list_devices',
  description: 'Elenca tutti i dispositivi nella rete, opzionalmente filtrati per tipo o sito.',
  parameters: z.object({
    type: z.enum(['switch', 'router', 'ap', 'all']).optional().describe('Tipo di dispositivo da filtrare'),
    site: z.string().optional().describe('Nome del sito da filtrare'),
    limit: z.number().optional().describe('Numero massimo di risultati (default: 50)'),
  }),
  async execute({ type = 'all', site, limit = 50 }) {
    try {
      const localDb = await getDb();
      let devices = localDb.getAllDevices();

      // Filtra per tipo
      if (type !== 'all') {
        devices = devices.filter(d => d.device_type === type);
      }

      // Filtra per sito
      if (site) {
        devices = devices.filter(d =>
          d.location?.toLowerCase().includes(site.toLowerCase()) ||
          d.name?.toLowerCase().includes(site.toLowerCase())
        );
      }

      // Limita risultati
      devices = devices.slice(0, limit);

      const summary = devices.map(d => ({
        name: d.name,
        ip: d.ip,
        type: d.device_type,
        vendor: d.vendor,
        location: d.location
      }));

      return JSON.stringify({
        total: summary.length,
        devices: summary
      }, null, 2);
    } catch (error) {
      return `Errore nel listing dispositivi: ${error.message}`;
    }
  },
});

export const getNetworkStats = tool({
  name: 'get_network_stats',
  description: 'Ottiene statistiche generali sulla rete: numero dispositivi, link, AP, ecc.',
  parameters: z.object({}),
  async execute() {
    try {
      // Prova NeDi prima
      const nediDb = await getNeDi();
      if (nediDb) {
        const stats = await nediDb.getStats();
        return JSON.stringify({ source: 'nedi', ...stats }, null, 2);
      }

      // Fallback a DB locale
      const localDb = await getDb();
      const devices = localDb.getAllDevices();
      const links = localDb.getAllLinks();

      const stats = {
        source: 'local',
        totalDevices: devices.length,
        switches: devices.filter(d => d.device_type === 'switch').length,
        routers: devices.filter(d => d.device_type === 'router').length,
        accessPoints: devices.filter(d => d.device_type === 'ap').length,
        totalLinks: links.length
      };

      return JSON.stringify(stats, null, 2);
    } catch (error) {
      return `Errore nel recupero statistiche: ${error.message}`;
    }
  },
});

export const getSites = tool({
  name: 'get_sites',
  description: 'Elenca tutti i siti/location della rete con il numero di dispositivi per sito.',
  parameters: z.object({}),
  async execute() {
    try {
      const nediDb = await getNeDi();
      const sites = await nediDb.getSites();

      if (!sites || sites.length === 0) {
        return 'Nessun sito configurato.';
      }

      return JSON.stringify(sites, null, 2);
    } catch (error) {
      return `Errore nel recupero siti: ${error.message}`;
    }
  },
});

// ============================================
// TROUBLESHOOTING TOOLS
// ============================================

export const getDeviceEvents = tool({
  name: 'get_device_events',
  description: 'Recupera gli ultimi eventi/allarmi di un dispositivo.',
  parameters: z.object({
    device: z.string().describe('Nome o IP del dispositivo'),
    limit: z.number().optional().describe('Numero di eventi da recuperare (default: 10)'),
  }),
  async execute({ device, limit = 10 }) {
    try {
      const nediDb = await getNeDi();
      const events = await nediDb.getDeviceEvents(device, limit);

      if (!events || events.length === 0) {
        return `Nessun evento recente per ${device}.`;
      }

      return JSON.stringify(events, null, 2);
    } catch (error) {
      return `Errore nel recupero eventi: ${error.message}`;
    }
  },
});

export const findDeviceByMac = tool({
  name: 'find_device_by_mac',
  description: 'Trova un dispositivo dato il suo MAC address.',
  parameters: z.object({
    mac: z.string().describe('MAC address del dispositivo'),
  }),
  async execute({ mac }) {
    try {
      const localDb = await getDb();
      const device = localDb.getDeviceByMAC(mac);

      if (!device) {
        return `Nessun dispositivo trovato con MAC ${mac}.`;
      }

      return JSON.stringify(device, null, 2);
    } catch (error) {
      return `Errore nella ricerca dispositivo: ${error.message}`;
    }
  },
});

export const getTopology = tool({
  name: 'get_topology',
  description: 'Ottiene la topologia della rete (dispositivi e link) per un sito specifico.',
  parameters: z.object({
    site: z.string().optional().describe('Nome del sito (opzionale, se vuoto restituisce tutto)'),
  }),
  async execute({ site }) {
    try {
      const nediDb = await getNeDi();
      const topology = await nediDb.getTopologyData();

      if (site) {
        // Filtra per sito
        const filtered = {
          devices: topology.devices?.filter(d =>
            d.location?.toLowerCase().includes(site.toLowerCase())
          ) || [],
          links: topology.links || []
        };
        return JSON.stringify({
          site,
          deviceCount: filtered.devices.length,
          devices: filtered.devices.slice(0, 20) // Limita per leggibilità
        }, null, 2);
      }

      return JSON.stringify({
        totalDevices: topology.devices?.length || 0,
        totalLinks: topology.links?.length || 0,
        summary: 'Usa il parametro site per filtrare per sito specifico'
      }, null, 2);
    } catch (error) {
      return `Errore nel recupero topologia: ${error.message}`;
    }
  },
});

// Export all tools grouped by category
export const macTrackerTools = [searchMac, getMacHistory];
export const deviceInfoTools = [getDeviceInfo, getDeviceFullStatus, getDevicePorts, getDeviceConnections];
export const discoveryTools = [listDevices, getNetworkStats, getSites];
export const troubleshootingTools = [getDeviceEvents, findDeviceByMac, getTopology];

// All tools combined
export const allTools = [
  ...macTrackerTools,
  ...deviceInfoTools,
  ...discoveryTools,
  ...troubleshootingTools
];
