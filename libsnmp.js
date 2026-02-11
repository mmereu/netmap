import snmp from 'net-snmp';

/**
 * Libreria SNMP estesa con supporto LLDP/CDP/FDP/EDP (stile NeDi)
 */
class NetMapSNMP {
  constructor(community = process.env.SNMP_COMMUNITY || 'public', options = {}) {
    this.community = community;
    this.defaultOptions = {
      timeout: options.timeout || 3000,
      retries: options.retries || 1,
      version: snmp.Version2c,
      ...options,
    };
  }

  /**
   * Crea una sessione SNMP
   */
  createSession(ip, customOptions = {}) {
    return snmp.createSession(ip, this.community, {
      ...this.defaultOptions,
      ...customOptions,
    });
  }

  /**
   * Decodifica valore SNMP
   */
  decodeValue(value) {
    if (Buffer.isBuffer(value)) {
      // MAC address (6 bytes)
      if (value.length === 6) {
        return Array.from(value)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(':');
      }
      // Prova ASCII
      const txt = value.toString('utf8');
      if (/^[\x20-\x7E]+$/.test(txt)) return txt;
      return value.toString('hex');
    }
    if (value === null || value === undefined) return '';
    return value.toString();
  }

  /**
   * Walk SNMP subtree con timeout
   */
  async walk(ip, oid, maxRepetitions = 20, timeout = 5000) {
    return new Promise((resolve) => {
      const session = this.createSession(ip);
      const rows = [];
      let completed = false;

      // Timeout globale
      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          session.close();
          resolve({ err: 'Timeout', rows: [] });
        }
      }, timeout);

      session.subtree(
        oid,
        maxRepetitions,
        (vb) => {
          if (completed) return;
          const list = Array.isArray(vb) ? vb : [vb];
          for (const v of list) {
            if (v?.oid) {
              rows.push({ oid: v.oid, type: v.type, value: v.value });
            }
          }
        },
        (err) => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          session.close();
          resolve({ err: err ? err.toString() : null, rows });
        }
      );
    });
  }

  /**
   * Get SNMP value
   */
  async get(ip, oids) {
    return new Promise((resolve) => {
      const session = this.createSession(ip);
      session.get(oids, (err, varbinds) => {
        session.close();
        if (err) {
          resolve({ err: err.toString(), values: null });
        } else {
          resolve({ err: null, values: varbinds });
        }
      });
    });
  }

  /**
   * Ottieni sysName
   */
  async getSysName(ip) {
    const result = await this.get(ip, ['1.3.6.1.2.1.1.5.0']);
    if (result.err || !result.values?.[0]?.value) return null;
    return this.decodeValue(result.values[0].value);
  }

  /**
   * Ottieni sysDescr
   */
  async getSysDescr(ip) {
    const result = await this.get(ip, ['1.3.6.1.2.1.1.1.0']);
    if (result.err || !result.values?.[0]?.value) return null;
    return this.decodeValue(result.values[0].value);
  }

  /**
   * Ottieni sysUpTime
   */
  async getSysUpTime(ip) {
    const result = await this.get(ip, ['1.3.6.1.2.1.1.3.0']);
    if (result.err || !result.values?.[0]?.value) return null;
    return result.values[0].value;
  }

  /**
   * Ottieni sysLocation
   */
  async getSysLocation(ip) {
    const result = await this.get(ip, ['1.3.6.1.2.1.1.6.0']);
    if (result.err || !result.values?.[0]?.value) return null;
    return this.decodeValue(result.values[0].value);
  }

  /**
   * Ottieni sysObjectID (per identificare vendor/OS)
   */
  async getSysObjectID(ip) {
    const result = await this.get(ip, ['1.3.6.1.2.1.1.2.0']);
    if (result.err || !result.values?.[0]?.value) return null;
    return result.values[0].value.toString();
  }

  /**
   * Parse LLDP RemTable (1.0.8802.1.1.2.1.4.1.1)
   * Gestisce sia il formato standard che il formato Huawei con timeMark
   */
  parseLLDPRemTable(vbs) {
    const entries = {};
    let debugCount = 0;
    const OID_BASE = '1.0.8802.1.1.2.1.4.1.1';
    const BASE_PARTS = OID_BASE.split('.').length; // 11

    for (const vb of vbs) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const len = parts.length;

      // L'OID deve essere almeno: base (11) + attr (1) + localPort (1) + remIndex (1) = 14
      if (len < BASE_PARTS + 3) {
        if (debugCount < 3) {
          console.log(`[LLDP-PARSE] OID troppo corto (${len}, attesi almeno ${BASE_PARTS + 3}): ${vb.oid}`);
          debugCount++;
        }
        continue;
      }

      // Verifica che l'OID inizi con la base
      const oidBase = parts.slice(0, BASE_PARTS).join('.');
      if (oidBase !== OID_BASE) {
        if (debugCount < 3) {
          console.log(`[LLDP-PARSE] OID base non corrisponde: ${oidBase} (atteso: ${OID_BASE})`);
          debugCount++;
        }
        continue;
      }

      // Formati OID supportati:
      // Standard (14 parti): 1.0.8802.1.1.2.1.4.1.1.ATTR.localPort.remIndex
      // Huawei (15 parti):   1.0.8802.1.1.2.1.4.1.1.ATTR.timeMark.localPort.remIndex
      const attr = parts[BASE_PARTS];
      let localPort, remIndex;

      // Huawei e alcuni vendor usano timeMark (valore numerico, non sempre 0)
      // Euristica migliorata: timeMark è tipicamente 0 o valore alto (>512)
      // localPort è tipicamente 1-512 (numero porte switch)
      if (len >= BASE_PARTS + 4) {
        // Formato con timeMark: ATTR.timeMark.localPort.remIndex
        const candidateTimeMark = parseInt(parts[BASE_PARTS + 1]);
        const candidateLocalPort = parseInt(parts[BASE_PARTS + 2]);

        // Se primo valore è 0 o > 512 → è timeMark (formato Huawei)
        // Se primo valore è 1-512 e secondo > 512 → formato ambiguo, usa standard
        if (candidateTimeMark === 0 || candidateTimeMark > 512) {
          // Formato Huawei con timeMark
          localPort = parts[BASE_PARTS + 2];
          remIndex = parts[BASE_PARTS + 3];
        } else if (candidateLocalPort > 512 || len === BASE_PARTS + 4) {
          // timeMark basso ma localPort alto → probabilmente timeMark=candidateTimeMark
          localPort = parts[BASE_PARTS + 2];
          remIndex = parts[BASE_PARTS + 3];
        } else {
          // Ambiguo: assume formato standard con dati extra
          localPort = parts[BASE_PARTS + 1];
          remIndex = parts[BASE_PARTS + 2];
        }
      } else if (len === BASE_PARTS + 3) {
        // Formato standard: ATTR.localPort.remIndex
        localPort = parts[BASE_PARTS + 1];
        remIndex = parts[BASE_PARTS + 2];
      } else {
        continue; // OID non valido
      }

      const key = `${localPort}-${remIndex}`;

      if (!entries[key]) {
        entries[key] = { localPort, remIndex };
      }

      const entry = entries[key];

      // Gestione corretta del TTL per evitare errori di buffer
      const processValue = (value) => {
        if (attr === '8' && typeof value === 'number') {
          // TTL è già un numero
          return value;
        } else if (attr === '8' && Buffer.isBuffer(value)) {
          // TTL come buffer - gestione sicura
          try {
            if (value.length >= 4) {
              return value.readUInt32BE(0);
            } else if (value.length >= 2) {
              return value.readUInt16BE(0);
            } else if (value.length >= 1) {
              return value[0];
            }
          } catch (e) {
            // In caso di errore, ritorna il valore decodificato
          }
        }
        return this.decodeValue(value);
      };

      switch (attr) {
        case '4': // chassisSubtype
          entry.chassisSubtype = this.decodeValue(vb.value);
          break;
        case '5': // chassisId
          entry.chassisId = this.decodeValue(vb.value);
          break;
        case '6': // portIdSubtype
          entry.portSubtype = this.decodeValue(vb.value);
          break;
        case '7': // portId
          entry.portId = this.decodeValue(vb.value);
          break;
        case '8': // portDesc (remote port description)
          entry.portDesc = this.decodeValue(vb.value);
          break;
        case '9': // sysName
          entry.sysName = this.decodeValue(vb.value);
          break;
        case '10': // sysDesc
          entry.sysDesc = this.decodeValue(vb.value);
          break;
        case '11': // sysCap
          entry.sysCap = this.decodeValue(vb.value);
          break;
        default:
          if (debugCount < 5) {
            console.log(`[LLDP-PARSE] Attributo sconosciuto: ${attr} (OID: ${vb.oid}, localPort=${localPort}, remIndex=${remIndex})`);
            debugCount++;
          }
          break;
      }
    }
    return Object.values(entries);
  }

  /**
   * Parse LLDP RemManAddrTable (1.0.8802.1.1.2.1.4.2.1) - IP dei neighbor (METODO NEDI)
   * Migliorato per Huawei: supporta sia formato standard che con timeMark
   */
  parseLLDPRemManAddrTable(vbs) {
    const ipMap = {}; // localPort-remIndex -> IP
    let debugCount = 0;
    const OID_BASE = '1.0.8802.1.1.2.1.4.2.1';
    const BASE_PARTS = OID_BASE.split('.').length; // 11
    const isByte = (val) => Number.isInteger(val) && val >= 0 && val <= 255;

    for (const vb of vbs) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const len = parts.length;

      // L'OID deve contenere almeno: base + attr + timeMark? + localPort + remIndex + addrSubtype + addrLen + addr
      if (len < BASE_PARTS + 6) {
        if (debugCount < 3) {
          console.log(`[LLDP-IP] OID troppo corto (${len}): ${vb.oid}`);
          debugCount++;
        }
        continue;
      }

      // Verifica che l'OID inizi con la base
      const oidBase = parts.slice(0, BASE_PARTS).join('.');
      if (oidBase !== OID_BASE) continue;

      const attr = parts[BASE_PARTS];

      // Pattern OID:
      // Standard (19 parti): ...4.2.1.ATTR.localPort.remIndex.addrSubtype.addrLen.addr1.addr2.addr3.addr4
      // Huawei (20 parti):   ...4.2.1.ATTR.timeMark.localPort.remIndex.addrSubtype.addrLen.addr1.addr2.addr3.addr4

      let localPort, remIndex, addrSubtype;
      // Huawei usa timeMark (può essere 0 o altro valore numerico come 8949)
      // Determina il formato in base alla lunghezza dell'OID
      const hasTimeMark = len >= BASE_PARTS + 9;

      if (hasTimeMark) {
        // Formato Huawei con timeMark
        localPort = parts[BASE_PARTS + 2];
        remIndex = parts[BASE_PARTS + 3];
        addrSubtype = parts[BASE_PARTS + 4];
      } else if (len >= BASE_PARTS + 8) {
        // Formato standard
        localPort = parts[BASE_PARTS + 1];
        remIndex = parts[BASE_PARTS + 2];
        addrSubtype = parts[BASE_PARTS + 3];
      } else {
        continue;
      }

      // attr=4: lldpRemManAddrIfId (IP address)
      // addrSubtype: 1=IPv4, 2=IPv6
      if (attr === '4' && addrSubtype === '1') {
        let ip = null;

        // METODO 1: usa il buffer dell'OCTET STRING (preferito)
        if (Buffer.isBuffer(vb.value) && vb.value.length >= 4) {
          const bytes = Array.from(vb.value.slice(-4)).map(b => b & 0xff);
          if (bytes.every(isByte)) {
            ip = bytes.join('.');
          }
        } else if (typeof vb.value === 'string') {
          // Alcuni vendor restituiscono stringhe "192.168.10.230" o "0A 0A 04 E6"
          const matches = vb.value.match(/\d+/g);
          if (matches && matches.length >= 4) {
            const nums = matches.slice(-4).map(n => Number(n));
            if (nums.every(isByte)) {
              ip = nums.join('.');
            }
          }
        }

        // METODO 2: IP nell'OID (fallback) -> prendi sempre gli ultimi 4 segmenti
        if (!ip) {
          const suffix = parts.slice(-4).map(n => Number(n));
          if (suffix.length === 4 && suffix.every(isByte)) {
            ip = suffix.join('.');
          } else if (len >= BASE_PARTS + 9) {
            const addrOffset = hasTimeMark ? BASE_PARTS + 6 : BASE_PARTS + 5;
            const addrParts = [];
            for (let i = 0; i < 4; i++) {
              const value = Number(parts[addrOffset + i]);
              if (!isByte(value)) {
                addrParts.length = 0;
                break;
              }
              addrParts.push(value);
            }
            if (addrParts.length === 4) {
              ip = addrParts.join('.');
            }
          }
        }

        if (ip) {
          const key = `${localPort}-${remIndex}`;
          ipMap[key] = ip;
          if (debugCount < 5) {
            console.log(`[LLDP-IP] Trovato IP ${ip} per localPort=${localPort}, remIndex=${remIndex} (timeMark=${hasTimeMark})`);
            debugCount++;
          }
        } else if (debugCount < 5) {
          console.log(`[LLDP-IP] Nessun IP valido per localPort=${localPort}, remIndex=${remIndex}, OID=${vb.oid}`);
          debugCount++;
        }
      }
    }
    return ipMap;
  }

  /**
   * Parse LLDP LocPortTable (1.0.8802.1.1.2.1.3.7.1)
   */
  parseLLDPLocPortTable(vbs) {
    const entries = {};
    for (const vb of vbs) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const len = parts.length;
      if (len < 2) continue;

      const portNum = parts[len - 1];
      const attr = parts[len - 2];

      if (!entries[portNum]) {
        entries[portNum] = { portNum };
      }

      const entry = entries[portNum];
      switch (attr) {
        case '3': // portId
          entry.portId = this.decodeValue(vb.value);
          break;
        case '4': // portDesc
          entry.portDesc = this.decodeValue(vb.value);
          break;
        default:
          break;
      }
    }
    return Object.values(entries);
  }

  /**
   * Parse CDP (Cisco Discovery Protocol)
   */
  parseCDP(vbs) {
    const entries = {};
    for (const vb of vbs) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      // CDP: 1.3.6.1.4.1.9.9.23.1.2.1.1.X.ifIndex
      const len = parts.length;
      if (len < 2) continue;

      const ifIndex = parts[len - 1];
      const attr = parts[len - 2];

      if (!entries[ifIndex]) {
        entries[ifIndex] = { ifIndex };
      }

      const entry = entries[ifIndex];
      switch (attr) {
        case '4': // cdpCacheDeviceId (sysName)
          entry.sysName = this.decodeValue(vb.value);
          break;
        case '5': // cdpCacheDevicePort (portId)
          entry.portId = this.decodeValue(vb.value);
          break;
        case '6': // cdpCachePlatform (sysDesc)
          entry.sysDesc = this.decodeValue(vb.value);
          break;
        case '7': // cdpCacheAddress (IP)
          if (Buffer.isBuffer(vb.value) && vb.value.length >= 4) {
            entry.ip = Array.from(vb.value.slice(0, 4)).join('.');
          }
          break;
        default:
          break;
      }
    }
    return Object.values(entries);
  }

  /**
   * Parse FDP (Foundry Discovery Protocol) - Foundry/Brocade
   * OID: 1.3.6.1.4.1.1991.1.1.1.1.1.1
   */
  parseFDP(vbs) {
    const entries = {};
    for (const vb of vbs) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const len = parts.length;
      if (len < 2) continue;

      const ifIndex = parts[len - 1];
      const attr = parts[len - 2];

      if (!entries[ifIndex]) {
        entries[ifIndex] = { ifIndex };
      }

      const entry = entries[ifIndex];
      // FDP ha struttura simile a CDP
      switch (attr) {
        case '2': // fdpRemChassisId
          entry.chassisId = this.decodeValue(vb.value);
          break;
        case '3': // fdpRemPortId
          entry.portId = this.decodeValue(vb.value);
          break;
        case '4': // fdpRemSysName
          entry.sysName = this.decodeValue(vb.value);
          break;
        default:
          break;
      }
    }
    return Object.values(entries);
  }

  /**
   * Parse EDP (Extreme Discovery Protocol) - Extreme Networks
   * OID: 1.3.6.1.4.1.1916.1.7.1.1.1
   */
  parseEDP(vbs) {
    const entries = {};
    for (const vb of vbs) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const len = parts.length;
      if (len < 2) continue;

      const ifIndex = parts[len - 1];
      const attr = parts[len - 2];

      if (!entries[ifIndex]) {
        entries[ifIndex] = { ifIndex };
      }

      const entry = entries[ifIndex];
      switch (attr) {
        case '2': // edpRemChassisId
          entry.chassisId = this.decodeValue(vb.value);
          break;
        case '3': // edpRemPortId
          entry.portId = this.decodeValue(vb.value);
          break;
        case '4': // edpRemSysName
          entry.sysName = this.decodeValue(vb.value);
          break;
        default:
          break;
      }
    }
    return Object.values(entries);
  }

  /**
   * Discovery completo protocolli (LLDP/CDP/FDP/EDP) con timeout per ogni operazione
   */
  async discoverProtocols(ip, timeout = 5000) {
    const result = {
      ip,
      sysName: null,
      sysDescr: null,
      sysUpTime: null,
      sysLocation: null,
      sysObjectID: null,
      lldp: [],
      cdp: [],
      fdp: [],
      edp: [],
      protocols: [],
    };

    try {
      // Informazioni base sistema (con timeout breve)
      const [sysName, sysDescr, sysUpTime, sysLocation, sysObjectID] = await Promise.allSettled([
        this.getSysName(ip),
        this.getSysDescr(ip),
        this.getSysUpTime(ip),
        this.getSysLocation(ip),
        this.getSysObjectID(ip),
      ]);

      result.sysName = sysName.status === 'fulfilled' ? sysName.value : null;
      result.sysDescr = sysDescr.status === 'fulfilled' ? sysDescr.value : null;
      result.sysUpTime = sysUpTime.status === 'fulfilled' ? sysUpTime.value : null;
      result.sysLocation = sysLocation.status === 'fulfilled' ? sysLocation.value : null;
      result.sysObjectID = sysObjectID.status === 'fulfilled' ? sysObjectID.value : null;

      // Inizializza array errori per tracciamento
      result.errors = [];

      // LLDP (timeout gestito internamente da walk())
      try {
        const lldpRem = await this.walk(ip, '1.0.8802.1.1.2.1.4.1.1', 20, timeout);
        if (!lldpRem.err && lldpRem.rows.length > 0) {
          result.lldp = this.parseLLDPRemTable(lldpRem.rows);
          result.protocols.push('LLDP');
        } else if (lldpRem.err) {
          result.errors.push({ operation: 'lldp_rem', error: lldpRem.err });
        }
      } catch (err) {
        result.errors.push({ operation: 'lldp_rem', error: err.message });
      }

      // LLDP LocPortTable (mapping porte) - opzionale
      try {
        const lldpLoc = await this.walk(ip, '1.0.8802.1.1.2.1.3.7.1', 20, timeout);
        if (!lldpLoc.err && lldpLoc.rows.length > 0) {
          result.lldpLoc = this.parseLLDPLocPortTable(lldpLoc.rows);
        }
      } catch (err) {
        // LocPortTable opzionale - non tracciare errore
      }

      // LLDP RemManAddrTable (1.0.8802.1.1.2.1.4.2.1) - IP dei neighbor (METODO NEDI)
      try {
        const lldpRemManAddr = await this.walk(ip, '1.0.8802.1.1.2.1.4.2.1', 20, timeout);
        if (!lldpRemManAddr.err && lldpRemManAddr.rows.length > 0) {
          const ipMap = this.parseLLDPRemManAddrTable(lldpRemManAddr.rows);
          console.log(`[LLDP-IP] ${ip}: Trovati ${Object.keys(ipMap).length} IP in RemManAddrTable`);
          let ipAssigned = 0;
          result.lldp.forEach(neighbor => {
            const key = `${neighbor.localPort}-${neighbor.remIndex}`;
            if (ipMap[key]) {
              neighbor.ip = ipMap[key];
              ipAssigned++;
            }
          });
          console.log(`[LLDP-IP] ${ip}: Assegnati ${ipAssigned} IP ai neighbor (su ${result.lldp.length} totali)`);
        } else {
          console.log(`[LLDP-IP] ${ip}: RemManAddrTable vuota o errore (rows=${lldpRemManAddr?.rows?.length || 0})`);
        }
      } catch (err) {
        console.log(`[LLDP-IP] ${ip}: Errore lettura RemManAddrTable: ${err.message}`);
        result.errors.push({ operation: 'lldp_rem_man_addr', error: err.message });
      }

      // CDP (Cisco)
      try {
        const cdp = await this.walk(ip, '1.3.6.1.4.1.9.9.23.1.2.1.1', 20, timeout);
        if (!cdp.err && cdp.rows.length > 0) {
          result.cdp = this.parseCDP(cdp.rows);
          result.protocols.push('CDP');
        }
      } catch (err) {
        // CDP opzionale - non tracciare errore
      }

      // FDP (Foundry/Brocade)
      try {
        const fdp = await this.walk(ip, '1.3.6.1.4.1.1991.1.1.1.1.1.1', 20, timeout);
        if (!fdp.err && fdp.rows.length > 0) {
          result.fdp = this.parseFDP(fdp.rows);
          result.protocols.push('FDP');
        }
      } catch (err) {
        // FDP opzionale - non tracciare errore
      }

      // EDP (Extreme)
      try {
        const edp = await this.walk(ip, '1.3.6.1.4.1.1916.1.7.1.1.1', 20, timeout);
        if (!edp.err && edp.rows.length > 0) {
          result.edp = this.parseEDP(edp.rows);
          result.protocols.push('EDP');
        }
      } catch (err) {
        // EDP opzionale - non tracciare errore
      }
    } catch (err) {
      result.errors = result.errors || [];
      result.errors.push({ operation: 'general', error: err.message });
    }

    return result;
  }

  /**
   * Ottieni ARP table
   */
  async getARPTable(ip) {
    const arp = await this.walk(ip, '1.3.6.1.2.1.4.22.1');
    if (arp.err || !arp.rows.length) return [];

    const entries = [];
    const arpMap = {};

    for (const vb of arp.rows) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      // ARP: 1.3.6.1.2.1.4.22.1.2.ifIndex.ip
      const len = parts.length;
      if (len < 3) continue;

      const ipAddr = parts.slice(-4).join('.');
      const ifIndex = parts[len - 5];
      const attr = parts[len - 6];

      const key = `${ifIndex}-${ipAddr}`;
      if (!arpMap[key]) {
        arpMap[key] = { ifIndex: parseInt(ifIndex), ip: ipAddr };
      }

      if (attr === '2') {
        // atPhysAddress
        arpMap[key].mac = this.decodeValue(vb.value);
      }
    }

    return Object.values(arpMap);
  }

  /**
   * Ottieni mappatura bridge port → ifIndex
   * Necessaria perché su switch stack (es. Huawei) bridge port ≠ ifIndex
   * OID: dot1dBasePortIfIndex (1.3.6.1.2.1.17.1.4.1.2)
   */
  async getBridgePortMapping(ip) {
    const mapping = {};
    const result = await this.walk(ip, '1.3.6.1.2.1.17.1.4.1.2');

    if (result.err || !result.rows.length) {
      return mapping; // Ritorna mapping vuoto, useremo bridge port direttamente come fallback
    }

    for (const vb of result.rows) {
      if (!vb?.oid) continue;
      // OID format: 1.3.6.1.2.1.17.1.4.1.2.<bridgePort> = <ifIndex>
      const parts = vb.oid.split('.');
      const bridgePort = parseInt(parts[parts.length - 1]);
      const ifIndex = parseInt(vb.value);
      mapping[bridgePort] = ifIndex;
    }

    return mapping;
  }

  /**
   * Ottieni FDB (Forwarding Database / MAC table)
   * NOTA: Usa getBridgePortMapping per convertire bridge port → ifIndex reale
   */
  async getFDBTable(ip) {
    // Prima ottieni la mappatura bridge port → ifIndex
    const bridgePortMap = await this.getBridgePortMapping(ip);
    const hasBridgeMapping = Object.keys(bridgePortMap).length > 0;

    // Bridge MIB: 1.3.6.1.2.1.17.4.3.1
    const fdb = await this.walk(ip, '1.3.6.1.2.1.17.4.3.1');
    if (fdb.err || !fdb.rows.length) return [];

    const fdbMap = {};

    for (const vb of fdb.rows) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      // FDB: 1.3.6.1.2.1.17.4.3.1.2.vlan.mac
      const len = parts.length;
      if (len < 8) continue;

      const mac = parts.slice(-6).map((p) => parseInt(p).toString(16).padStart(2, '0')).join(':');
      const vlan = parts[len - 7];
      const attr = parts[len - 8];

      const key = `${vlan}-${mac}`;
      if (!fdbMap[key]) {
        fdbMap[key] = { vlan: parseInt(vlan), mac };
      }

      if (attr === '2') {
        // dot1dTpFdbPort - questo è il BRIDGE PORT, non l'ifIndex!
        const bridgePort = parseInt(vb.value);
        // Converti bridge port → ifIndex usando la mappatura
        // Se la mappatura esiste, usala; altrimenti usa bridge port come fallback
        if (hasBridgeMapping && bridgePortMap[bridgePort]) {
          fdbMap[key].ifIndex = bridgePortMap[bridgePort];
          fdbMap[key].bridgePort = bridgePort; // Salva anche il bridge port originale per debug
        } else {
          fdbMap[key].ifIndex = bridgePort; // Fallback: usa bridge port come ifIndex
          fdbMap[key].bridgePort = bridgePort;
        }
      }
    }

    return Object.values(fdbMap);
  }

  /**
   * Ottieni interfaces (IF-MIB)
   */
  async getInterfaces(ip) {
    const ifTable = await this.walk(ip, '1.3.6.1.2.1.2.2.1');
    if (ifTable.err || !ifTable.rows.length) return [];

    const interfaces = {};
    for (const vb of ifTable.rows) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const ifIndex = parts[parts.length - 1];
      const attr = parts[parts.length - 2];

      if (!interfaces[ifIndex]) {
        interfaces[ifIndex] = { ifIndex: parseInt(ifIndex) };
      }

      const iface = interfaces[ifIndex];
      switch (attr) {
        case '2': // ifDescr
          iface.ifDescr = this.decodeValue(vb.value);
          break;
        case '3': // ifType
          iface.ifType = vb.value;
          break;
        case '5': // ifSpeed
          iface.ifSpeed = vb.value;
          break;
        case '7': // ifAdminStatus
          iface.ifAdminStatus = vb.value;
          break;
        case '8': // ifOperStatus
          iface.ifOperStatus = vb.value;
          break;
        case '6': // ifPhysAddress
          iface.ifPhysAddress = this.decodeValue(vb.value);
          break;
        default:
          break;
      }
    }

    return Object.values(interfaces);
  }

  /**
   * Ottieni interfaces estese (IF-MIB + ifXTable per ifName, ifAlias, ifHighSpeed)
   */
  async getInterfacesExtended(ip) {
    const interfaces = await this.getInterfaces(ip);
    const ifXTable = await this.walk(ip, '1.3.6.1.2.1.31.1.1.1');

    if (!ifXTable.err && ifXTable.rows.length) {
      const ifMap = {};
      interfaces.forEach(iface => { ifMap[iface.ifIndex] = iface; });

      for (const vb of ifXTable.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const ifIndex = parts[parts.length - 1];
        const attr = parts[parts.length - 2];

        if (!ifMap[ifIndex]) continue;
        const iface = ifMap[ifIndex];

        switch (attr) {
          case '1': // ifName
            iface.ifName = this.decodeValue(vb.value);
            break;
          case '15': // ifHighSpeed (Mbps)
            iface.ifHighSpeed = vb.value;
            break;
          case '18': // ifAlias
            iface.ifAlias = this.decodeValue(vb.value);
            break;
          default:
            break;
        }
      }
    }

    return interfaces;
  }

  /**
   * Ottieni VLAN (Q-BRIDGE-MIB)
   * OID: 1.3.6.1.2.1.17.7.1.4.3.1 (dot1qVlanStaticTable)
   */
  async getVLANs(ip) {
    const vlans = [];

    // dot1qVlanStaticName (1.3.6.1.2.1.17.7.1.4.3.1.1)
    const vlanNames = await this.walk(ip, '1.3.6.1.2.1.17.7.1.4.3.1.1');
    if (!vlanNames.err && vlanNames.rows.length) {
      for (const vb of vlanNames.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const vlanId = parseInt(parts[parts.length - 1]);
        vlans.push({
          vlanId,
          vlanName: this.decodeValue(vb.value),
          status: 'active',
        });
      }
    }

    // Fallback: vtpVlanTable per Cisco (1.3.6.1.4.1.9.9.46.1.3.1.1)
    if (vlans.length === 0) {
      const vtpVlans = await this.walk(ip, '1.3.6.1.4.1.9.9.46.1.3.1.1.4');
      if (!vtpVlans.err && vtpVlans.rows.length) {
        for (const vb of vtpVlans.rows) {
          if (!vb?.oid) continue;
          const parts = vb.oid.split('.');
          const vlanId = parseInt(parts[parts.length - 1]);
          vlans.push({
            vlanId,
            vlanName: this.decodeValue(vb.value),
            status: 'active',
          });
        }
      }
    }

    return vlans;
  }

  /**
   * Ottieni VLAN membership per porta (Q-BRIDGE-MIB)
   * OID: 1.3.6.1.2.1.17.7.1.4.5.1.1 (dot1qPvid - PVID per porta)
   */
  async getPortVLANs(ip) {
    const portVlans = [];

    // dot1qPvid (PVID - native VLAN)
    const pvid = await this.walk(ip, '1.3.6.1.2.1.17.7.1.4.5.1.1');
    if (!pvid.err && pvid.rows.length) {
      for (const vb of pvid.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const portIndex = parseInt(parts[parts.length - 1]);
        portVlans.push({
          portIndex,
          pvid: vb.value,
          tagged: [],
        });
      }
    }

    // dot1qVlanCurrentEgressPorts (porte tagged per VLAN)
    const egressPorts = await this.walk(ip, '1.3.6.1.2.1.17.7.1.4.2.1.4');
    if (!egressPorts.err && egressPorts.rows.length) {
      for (const vb of egressPorts.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const vlanId = parseInt(parts[parts.length - 1]);

        // Bitmap delle porte
        if (Buffer.isBuffer(vb.value)) {
          for (let i = 0; i < vb.value.length; i++) {
            const byte = vb.value[i];
            for (let bit = 0; bit < 8; bit++) {
              if (byte & (1 << (7 - bit))) {
                const portIndex = i * 8 + bit + 1;
                const port = portVlans.find(p => p.portIndex === portIndex);
                if (port && !port.tagged.includes(vlanId)) {
                  port.tagged.push(vlanId);
                }
              }
            }
          }
        }
      }
    }

    return portVlans;
  }

  /**
   * Ottieni STP info (BRIDGE-MIB)
   * OID: 1.3.6.1.2.1.17.2 (dot1dStp)
   */
  async getSTPInfo(ip) {
    const stp = {
      protocolSpecification: null, // 1=unknown, 2=decLb100, 3=ieee8021d
      priority: null,
      rootBridge: null,
      rootPort: null,
      rootCost: null,
      maxAge: null,
      helloTime: null,
      forwardDelay: null,
    };

    const stpScalars = [
      '1.3.6.1.2.1.17.2.1.0', // dot1dStpProtocolSpecification
      '1.3.6.1.2.1.17.2.2.0', // dot1dStpPriority
      '1.3.6.1.2.1.17.2.5.0', // dot1dStpDesignatedRoot
      '1.3.6.1.2.1.17.2.6.0', // dot1dStpRootCost
      '1.3.6.1.2.1.17.2.7.0', // dot1dStpRootPort
      '1.3.6.1.2.1.17.2.8.0', // dot1dStpMaxAge
      '1.3.6.1.2.1.17.2.9.0', // dot1dStpHelloTime
      '1.3.6.1.2.1.17.2.10.0', // dot1dStpForwardDelay
    ];

    const result = await this.get(ip, stpScalars);
    if (!result.err && result.values) {
      result.values.forEach((vb, idx) => {
        if (!vb?.value) return;
        switch (idx) {
          case 0: stp.protocolSpecification = vb.value; break;
          case 1: stp.priority = vb.value; break;
          case 2: stp.rootBridge = this.decodeValue(vb.value); break;
          case 3: stp.rootCost = vb.value; break;
          case 4: stp.rootPort = vb.value; break;
          case 5: stp.maxAge = vb.value / 100; break; // centiseconds
          case 6: stp.helloTime = vb.value / 100; break;
          case 7: stp.forwardDelay = vb.value / 100; break;
        }
      });
    }

    return stp;
  }

  /**
   * Ottieni STP port states (BRIDGE-MIB)
   * OID: 1.3.6.1.2.1.17.2.15.1 (dot1dStpPortTable)
   */
  async getSTPPorts(ip) {
    const stpPorts = [];

    const portTable = await this.walk(ip, '1.3.6.1.2.1.17.2.15.1');
    if (portTable.err || !portTable.rows.length) return stpPorts;

    const ports = {};
    for (const vb of portTable.rows) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      const portNum = parts[parts.length - 1];
      const attr = parts[parts.length - 2];

      if (!ports[portNum]) {
        ports[portNum] = { port: parseInt(portNum) };
      }

      const port = ports[portNum];
      switch (attr) {
        case '2': // dot1dStpPortPriority
          port.priority = vb.value;
          break;
        case '3': // dot1dStpPortState
          // 1=disabled, 2=blocking, 3=listening, 4=learning, 5=forwarding, 6=broken
          port.state = vb.value;
          port.stateText = ['', 'disabled', 'blocking', 'listening', 'learning', 'forwarding', 'broken'][vb.value] || 'unknown';
          break;
        case '5': // dot1dStpPortPathCost
          port.pathCost = vb.value;
          break;
        case '6': // dot1dStpPortDesignatedRoot
          port.designatedRoot = this.decodeValue(vb.value);
          break;
        case '8': // dot1dStpPortDesignatedBridge
          port.designatedBridge = this.decodeValue(vb.value);
          break;
        case '9': // dot1dStpPortDesignatedPort
          port.designatedPort = this.decodeValue(vb.value);
          break;
        default:
          break;
      }
    }

    return Object.values(ports);
  }

  /**
   * Ottieni LACP/LAG info (IEEE8023-LAG-MIB)
   * OID: 1.2.840.10006.300.43.1.1 (dot3adAgg)
   */
  async getLACPInfo(ip) {
    const aggregators = [];

    // dot3adAggPortListTable (1.2.840.10006.300.43.1.1.2.1)
    const aggPorts = await this.walk(ip, '1.2.840.10006.300.43.1.1.2.1.1');
    if (!aggPorts.err && aggPorts.rows.length) {
      for (const vb of aggPorts.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const aggIndex = parseInt(parts[parts.length - 1]);

        // Bitmap delle porte membro
        const memberPorts = [];
        if (Buffer.isBuffer(vb.value)) {
          for (let i = 0; i < vb.value.length; i++) {
            const byte = vb.value[i];
            for (let bit = 0; bit < 8; bit++) {
              if (byte & (1 << (7 - bit))) {
                memberPorts.push(i * 8 + bit + 1);
              }
            }
          }
        }

        aggregators.push({
          aggIndex,
          memberPorts,
          portCount: memberPorts.length,
        });
      }
    }

    return aggregators;
  }

  /**
   * Ottieni PoE info (POWER-ETHERNET-MIB)
   * OID: 1.3.6.1.2.1.105 (pethObjects)
   */
  async getPoEInfo(ip) {
    const poe = {
      totalPower: null,
      usedPower: null,
      ports: [],
    };

    // pethMainPseOperStatus (1.3.6.1.2.1.105.1.3.1.1.3)
    const poeStatus = await this.walk(ip, '1.3.6.1.2.1.105.1.3.1.1');
    if (!poeStatus.err && poeStatus.rows.length) {
      for (const vb of poeStatus.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const attr = parts[parts.length - 2];

        switch (attr) {
          case '2': // pethMainPseConsumptionPower (milliwatts)
            poe.usedPower = vb.value / 1000; // Convert to watts
            break;
          case '4': // pethMainPsePower (watts)
            poe.totalPower = vb.value;
            break;
        }
      }
    }

    // pethPsePortTable (1.3.6.1.2.1.105.1.1.1)
    const poePorts = await this.walk(ip, '1.3.6.1.2.1.105.1.1.1');
    if (!poePorts.err && poePorts.rows.length) {
      const ports = {};
      for (const vb of poePorts.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');
        const portIndex = parts[parts.length - 1];
        const groupIndex = parts[parts.length - 2];
        const attr = parts[parts.length - 3];
        const key = `${groupIndex}-${portIndex}`;

        if (!ports[key]) {
          ports[key] = { groupIndex: parseInt(groupIndex), portIndex: parseInt(portIndex) };
        }

        const port = ports[key];
        switch (attr) {
          case '2': // pethPsePortAdminEnable
            port.adminEnabled = vb.value === 1;
            break;
          case '4': // pethPsePortDetectionStatus
            // 1=disabled, 2=searching, 3=deliveringPower, 4=fault, 5=test, 6=otherFault
            port.detectionStatus = vb.value;
            port.delivering = vb.value === 3;
            break;
          case '5': // pethPsePortPowerPriority
            port.priority = ['', 'critical', 'high', 'low'][vb.value] || 'unknown';
            break;
          case '9': // pethPsePortPowerClassifications
            port.powerClass = vb.value;
            break;
          default:
            break;
        }
      }
      poe.ports = Object.values(ports);
    }

    return poe;
  }

  /**
   * Ottieni IP addresses (IP-MIB)
   * OID: 1.3.6.1.2.1.4.20.1 (ipAddrTable)
   */
  async getIPAddresses(ip) {
    const addresses = [];

    const ipAddrTable = await this.walk(ip, '1.3.6.1.2.1.4.20.1');
    if (ipAddrTable.err || !ipAddrTable.rows.length) return addresses;

    const addrMap = {};
    for (const vb of ipAddrTable.rows) {
      if (!vb?.oid) continue;
      const parts = vb.oid.split('.');
      // OID: 1.3.6.1.2.1.4.20.1.ATTR.IP1.IP2.IP3.IP4
      const len = parts.length;
      if (len < 5) continue;

      const ipAddr = parts.slice(-4).join('.');
      const attr = parts[len - 5];

      if (!addrMap[ipAddr]) {
        addrMap[ipAddr] = { ip: ipAddr };
      }

      const entry = addrMap[ipAddr];
      switch (attr) {
        case '2': // ipAdEntIfIndex
          entry.ifIndex = vb.value;
          break;
        case '3': // ipAdEntNetMask
          if (Buffer.isBuffer(vb.value) && vb.value.length === 4) {
            entry.netmask = Array.from(vb.value).join('.');
          } else {
            entry.netmask = this.decodeValue(vb.value);
          }
          break;
        default:
          break;
      }
    }

    return Object.values(addrMap);
  }

  /**
   * Ottieni IPv6 addresses (IP-MIB / IPV6-MIB)
   * OID: 1.3.6.1.2.1.55.1.8.1 (ipv6AddrTable) o 1.3.6.1.2.1.4.34.1 (ipAddressTable)
   */
  async getIPv6Addresses(ip) {
    const addresses = [];

    // ipAddressTable (supporta IPv4 e IPv6)
    const ipAddressTable = await this.walk(ip, '1.3.6.1.2.1.4.34.1');
    if (!ipAddressTable.err && ipAddressTable.rows.length) {
      for (const vb of ipAddressTable.rows) {
        if (!vb?.oid) continue;
        const parts = vb.oid.split('.');

        // Estrai tipo indirizzo (1=unknown, 2=ipv4, 3=ipv4z, 4=ipv6, 5=ipv6z)
        const addrType = parseInt(parts[10]);
        if (addrType === 4 || addrType === 5) { // IPv6
          // Estrai indirizzo IPv6 (16 bytes dopo addrType)
          const ipv6Parts = parts.slice(11, 27);
          if (ipv6Parts.length === 16) {
            const ipv6Addr = [];
            for (let i = 0; i < 16; i += 2) {
              const hex = (parseInt(ipv6Parts[i]) << 8 | parseInt(ipv6Parts[i + 1])).toString(16);
              ipv6Addr.push(hex);
            }
            addresses.push({
              ip: ipv6Addr.join(':'),
              type: 'ipv6',
            });
          }
        }
      }
    }

    return addresses;
  }

  /**
   * Discovery esteso con tutte le informazioni (VLAN, STP, LACP, PoE, IP)
   */
  async discoverExtended(ip, options = {}) {
    const result = await this.discoverProtocols(ip, options.timeout || 5000);

    // Aggiungi info estese se richieste
    if (options.includeVLANs) {
      result.vlans = await this.getVLANs(ip);
      result.portVlans = await this.getPortVLANs(ip);
    }

    if (options.includeSTP) {
      result.stp = await this.getSTPInfo(ip);
      result.stpPorts = await this.getSTPPorts(ip);
    }

    if (options.includeLACP) {
      result.lacp = await this.getLACPInfo(ip);
    }

    if (options.includePoE) {
      result.poe = await this.getPoEInfo(ip);
    }

    if (options.includeIPAddresses) {
      result.ipAddresses = await this.getIPAddresses(ip);
      result.ipv6Addresses = await this.getIPv6Addresses(ip);
    }

    if (options.includeInterfaces) {
      result.interfaces = await this.getInterfacesExtended(ip);
    }

    return result;
  }
}

export default NetMapSNMP;

