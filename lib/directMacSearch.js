/**
 * Ricerca MAC diretta - bypassa AI per query semplici
 * v3: Endpoint detection migliorato con macCount e LLDP matching
 */
import mysql from 'mysql2/promise';

// Pool connessione MySQL
let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.NEDI_MYSQL_HOST || 'localhost',
      port: parseInt(process.env.NEDI_MYSQL_PORT || '3306', 10),
      user: process.env.NEDI_MYSQL_USER || 'nedi',
      password: process.env.NEDI_MYSQL_PASS || '',
      database: process.env.NEDI_MYSQL_DB || 'nedi',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 5000,
      acquireTimeout: 5000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });
  }
  return pool;
}

// Converte IP numerico in stringa
function longToIp(long) {
  if (!long) return null;
  return [
    (long >>> 24) & 255,
    (long >>> 16) & 255,
    (long >>> 8) & 255,
    long & 255
  ].join('.');
}

/**
 * Ottiene lo storico dei movimenti tra AP per un MAC
 */
async function getMovementHistory(db, cleanMac, hours = 24) {
  const cutoffTime = Math.floor(Date.now() / 1000) - (hours * 3600);

  const [siteRows] = await db.query(
    'SELECT DISTINCT SUBSTRING(device, 1, 2) as site_prefix FROM nodes WHERE mac = ? LIMIT 1',
    [cleanMac]
  );

  const sitePrefix = siteRows.length > 0 ? siteRows[0].site_prefix : null;
  if (!sitePrefix) return [];

  const apPattern = 'PDV' + sitePrefix.padStart(3, '0') + '%';

  const [rows] = await db.query(`
    SELECT
      n.lastseen,
      n.device,
      GROUP_CONCAT(DISTINCT ap.neighbor ORDER BY ap.neighbor SEPARATOR ',') as access_points
    FROM nodes n
    INNER JOIN (
      SELECT DISTINCT device, neighbor
      FROM links
      WHERE neighbor LIKE ?
    ) ap ON n.device = ap.device
    WHERE n.mac = ?
      AND n.lastseen >= ?
    GROUP BY n.lastseen, n.device
    ORDER BY n.lastseen DESC
    LIMIT 50
  `, [apPattern, cleanMac, cutoffTime]);

  const movements = [];
  let lastSwitch = null;

  for (const row of rows) {
    if (row.device !== lastSwitch) {
      const zoneMatch = row.device.match(/_([A-Za-z]+)_?\d*$/);
      const zone = zoneMatch ? zoneMatch[1] : '';

      movements.push({
        time: new Date(parseInt(row.lastseen) * 1000).toLocaleTimeString('it-IT', {hour: '2-digit', minute: '2-digit'}),
        zone: zone,
        switchName: row.device,
        aps: row.access_points ? row.access_points.split(',').slice(0, 3).map(ap => ap.replace(/^PDV\d+-[A-Z]+-/, '')).join(', ') : ''
      });
      lastSwitch = row.device;
    }
  }

  return movements.slice(0, 10);
}

/**
 * Trova l'endpoint reale per un MAC - la porta fisica dove è connesso
 * v5: Riconosce quando il MAC cercato E' un AP (non un client)
 */
async function findEndpoint(db, cleanMac) {
  // Step 0: Controlla se questo MAC ha ARP entry e corrisponde a un AP
  const [arpCheck] = await db.query(`
    SELECT nodip FROM nodarp WHERE mac = ? LIMIT 1
  `, [cleanMac]);

  if (arpCheck.length > 0) {
    const apIp = longToIp(arpCheck[0].nodip);
    // Cerca se questo IP e' un AP in links (linkdesc contiene l'IP)
    const [apLink] = await db.query(`
      SELECT device, ifname, neighbor, linkdesc FROM links
      WHERE neighbor LIKE 'PDV%' AND linkdesc LIKE ?
      LIMIT 1
    `, ['%' + apIp + '%']);

    if (apLink.length > 0) {
      // Il MAC cercato E' un AP! Ritorna direttamente
      const [devInfo] = await db.query(`SELECT devip FROM devices WHERE device = ? LIMIT 1`, [apLink[0].device]);
      return {
        device: apLink[0].device,
        ifname: apLink[0].ifname,
        vlanid: null,
        devip: devInfo.length > 0 ? devInfo[0].devip : null,
        macCount: 1,
        lldpNeighbor: apLink[0].neighbor,
        endpointType: 'access-point-self',
        isEndpoint: true,
        apIp: apIp
      };
    }
  }

  // Query standard: trova tutte le posizioni ordinate per macCount (access port first)
  // Escludi interfacce aggregate e porte con troppi MAC
  const [positions] = await db.query(`
    SELECT
      n.device, n.ifname, n.vlanid, n.lastseen,
      d.devip,
      (SELECT COUNT(DISTINCT mac) FROM nodes n2 WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount
    FROM nodes n
    LEFT JOIN devices d ON n.device = d.device
    WHERE n.mac = ?
      AND n.ifname NOT LIKE 'Eth-Trunk%'
      AND n.ifname NOT LIKE 'Port-channel%'
      AND n.ifname NOT LIKE 'Trunk%'
    GROUP BY n.device, n.ifname
    ORDER BY macCount ASC, n.lastseen DESC
    LIMIT 20
  `, [cleanMac]);

  if (positions.length === 0) return null;

  // Prima posizione = minimo macCount = endpoint piu probabile
  const endpoint = positions[0];

  // NUOVO: Se macCount > 100, e' una trunk - NON cercare LLDP su questa porta
  const apVendorOUIs = ['00e60e', 'e60e65', '00a67c', '001018', '000b86', '74acb9', 'f09fc2', '788a20'];
  const macOUI = cleanMac.substring(0, 6);
  const isAPVendorMac = apVendorOUIs.includes(macOUI);

  if (endpoint.macCount > 100) {
    const [switchAPs] = await db.query(`
      SELECT neighbor, ifname, linkdesc FROM links
      WHERE device = ? AND neighbor LIKE 'PDV%'
      ORDER BY neighbor
    `, [endpoint.device]);

    if (switchAPs.length > 0) {
      endpoint.nearbyAPs = switchAPs.map(a => a.neighbor);
      if (isAPVendorMac) {
        endpoint.endpointType = 'wifi-client';
        endpoint.lldpNote = 'MAC di client WiFi (vendor AP). Switch ha ' + switchAPs.length + ' AP collegati.';
      } else {
        endpoint.endpointType = 'trunk-with-aps';
        endpoint.lldpNote = 'MAC su porta trunk. Switch ha ' + switchAPs.length + ' AP collegati.';
      }
      endpoint.isEndpoint = true;
      return endpoint;
    }
  }

  // Step 1: Cerca LLDP neighbor su questa porta esatta
  const ifnameBase = endpoint.ifname.replace(/^(Eth|Et|Gi|GE|XGE|10GE)/, '');
  const [lldpRows] = await db.query(`
    SELECT neighbor FROM links
    WHERE device = ?
      AND (ifname = ? OR ifname LIKE ?)
    LIMIT 1
  `, [endpoint.device, endpoint.ifname, '%' + ifnameBase]);

  if (lldpRows.length > 0 && lldpRows[0].neighbor) {
    endpoint.lldpNeighbor = lldpRows[0].neighbor;
    endpoint.endpointType = /^PDV/i.test(lldpRows[0].neighbor) ? 'access-point' : 'lldp-device';
  } else {
    // Step 2: NeDi ha bug ifIndex mapping - cerca TUTTI gli AP PDV su questo switch
    // Se c'e' solo 1 AP PDV e la porta ha pochi MAC, probabilmente e' quello
    const [switchAPs] = await db.query(`
      SELECT neighbor, ifname FROM links
      WHERE device = ? AND neighbor LIKE 'PDV%'
      ORDER BY neighbor
    `, [endpoint.device]);

    // OUI di vendor AP noti (primi 3 byte del MAC)
    const apVendorOUIs = ['00e60e', 'e60e65', '00a67c', '001018', '000b86']; // Extreme, TP-Link, Ubiquiti, Aruba
    const macOUI = cleanMac.substring(0, 6);
    const isAPVendor = apVendorOUIs.includes(macOUI);

    if (switchAPs.length === 1 && endpoint.macCount <= 10) {
      // Solo 1 AP sullo switch e pochi MAC sulla porta = quasi sicuro e' questo AP
      endpoint.lldpNeighbor = switchAPs[0].neighbor;
      endpoint.endpointType = 'access-point';
      endpoint.lldpNote = 'AP unico su switch';
    } else if (switchAPs.length > 0 && endpoint.macCount <= 5 && isAPVendor) {
      // Pochissimi MAC, vendor AP noto, e ci sono AP sullo switch = probabilmente E' un AP
      endpoint.nearbyAPs = switchAPs.map(a => a.neighbor);
      endpoint.endpointType = 'access-point-likely';
      endpoint.lldpNote = 'MAC vendor AP (Extreme/Ubiquiti/Aruba)';
    } else if (switchAPs.length > 0) {
      // Piu' AP sullo switch - mostra come "AP nelle vicinanze"
      endpoint.nearbyAPs = switchAPs.map(a => a.neighbor);
      endpoint.endpointType = 'access-port';
    } else {
      endpoint.endpointType = 'access-port';
    }
  }

  endpoint.isEndpoint = true;
  return endpoint;
}

/**
 * Ricerca MAC diretta nel database NeDi - trova l'ENDPOINT reale
 */
export async function searchMacDirect(mac, options = {}) {
  const { showMovements = false } = options;
  const t0 = Date.now();

  const cleanMac = mac.replace(/[:\-.\s]/g, '').toLowerCase();
  if (cleanMac.length < 6 || !/^[0-9a-f]+$/.test(cleanMac)) {
    return { found: false, response: `MAC "${mac}" non valido`, elapsed: Date.now() - t0 };
  }

  try {
    const db = await getPool();

    const endpoint = await findEndpoint(db, cleanMac);
    const elapsed = Date.now() - t0;

    if (!endpoint) {
      return {
        found: false,
        response: `MAC ${mac} NON TROVATO nel database NeDi.`,
        elapsed
      };
    }

    const switchIp = endpoint.devip ? longToIp(endpoint.devip) : 'N/A';

    let response = `MAC ${mac} TROVATO!`;

    // Mostra LLDP neighbor se presente (PDV = Access Point)
    if (endpoint.lldpNeighbor) {
      if (/^PDV/i.test(endpoint.lldpNeighbor)) {
        response += `\nAccess Point: ${endpoint.lldpNeighbor}`;
      } else {
        response += `\nDispositivo LLDP: ${endpoint.lldpNeighbor}`;
      }
    }

    response += `
Switch: ${endpoint.device}
IP Switch: ${switchIp}
Porta: ${endpoint.ifname}
VLAN: ${endpoint.vlanid || 'N/A'}
MAC su porta: ${endpoint.macCount || '?'}`;

    // Tipo endpoint e note
    if (endpoint.endpointType === 'access-point-self') {
      response += `\nTipo: QUESTO E' L'ACCESS POINT`;
      if (endpoint.apIp) {
        response += `\nIP AP: ${endpoint.apIp}`;
      }
    } else if (endpoint.endpointType === 'access-point-likely') {
      response += `\nTipo: PROBABILE ACCESS POINT`;
      if (endpoint.lldpNote) {
        response += ` (${endpoint.lldpNote})`;
      }
    } else if (endpoint.endpointType === 'wifi-client') {
      response += '\n\n📶 CLIENT WIFI';
      response += '\n' + (endpoint.lldpNote || '');
    } else if (endpoint.endpointType === 'trunk-with-aps') {
      response += '\nTipo: MAC su trunk (potrebbe essere WiFi)';
    } else if (endpoint.endpointType === 'access-point') {
      response += `\nTipo: Connesso via Access Point`;
      if (endpoint.lldpNote) {
        response += ` (${endpoint.lldpNote})`;
      }
    } else if (endpoint.endpointType === 'lldp-device') {
      response += `\nTipo: Dispositivo LLDP`;
    } else {
      response += `\nTipo: Porta access`;
    }

    // Mostra AP nelle vicinanze (quando LLDP non matcha porta esatta)
    if (endpoint.nearbyAPs && endpoint.nearbyAPs.length > 0) {
      response += `\nAP su switch: ${endpoint.nearbyAPs.slice(0, 5).join(', ')}`;
      if (endpoint.nearbyAPs.length > 5) {
        response += ` (+${endpoint.nearbyAPs.length - 5} altri)`;
      }
    }

    response += `
Fonte: nedi-db
Tempo: ${elapsed}ms`;

    // Storico movimenti (solo se richiesto)
    if (showMovements) {
      try {
        const movements = await getMovementHistory(db, cleanMac, 24);
        if (movements.length > 1) {
          response += '\n\nStorico movimenti (ultime 24h):';
          movements.forEach((m) => {
            const location = m.zone || m.switchName.split('_').slice(-2).join('_');
            response += `\n  ${m.time} - ${location} (${m.aps})`;
          });
        }
      } catch (movErr) {
        console.error('[FAST-MAC] Movement history error:', movErr.message);
      }
    }

    return { found: true, response, elapsed };

  } catch (err) {
    console.error('[FAST-MAC] ERROR:', err.message);
    return {
      found: false,
      response: `Errore database: ${err.message}`,
      elapsed: Date.now() - t0
    };
  }
}

/**
 * Rileva se il messaggio e una ricerca MAC semplice
 */
export function detectMacSearch(message) {
  const msg = message.toLowerCase().trim();

  let match = msg.match(/(?:cerca|trova|where|dov[e']?\s*[èe]?|search|locate|find)\s*(?:il\s*)?mac\s*[:\s]?\s*([0-9a-f][0-9a-f:\-.\s]{5,})/i);
  if (match && match[1]) {
    const cleanMac = match[1].trim().replace(/[:\-.\s]/g, '');
    if (cleanMac.length >= 12 && /^[0-9a-f]+$/i.test(cleanMac)) {
      return { isMacSearch: true, mac: match[1].trim() };
    }
  }

  match = msg.match(/\bmac\s*[:\s]?\s*([0-9a-f][0-9a-f:\-.\s]{5,})/i);
  if (match && match[1]) {
    const cleanMac = match[1].trim().replace(/[:\-.\s]/g, '');
    if (cleanMac.length >= 12 && /^[0-9a-f]+$/i.test(cleanMac)) {
      return { isMacSearch: true, mac: match[1].trim() };
    }
  }

  match = msg.match(/^[0-9a-f]{2}[:\-.]?[0-9a-f]{2}[:\-.]?[0-9a-f]{2}[:\-.]?[0-9a-f]{2}[:\-.]?[0-9a-f]{2}[:\-.]?[0-9a-f]{2}$/i);
  if (match) {
    const cleanMac = match[0].replace(/[:\-.\s]/g, '');
    if (cleanMac.length >= 12 && /^[0-9a-f]+$/i.test(cleanMac)) {
      return { isMacSearch: true, mac: match[0] };
    }
  }

  return { isMacSearch: false, mac: null };
}
