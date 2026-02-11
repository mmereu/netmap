# Extended Vendor Support - Design Document

**Data**: 2025-12-20
**Stato**: Approvato
**Autore**: Claude Code + Marco Mereu

---

## Sommario

Questo documento descrive l'architettura per estendere NetMap con supporto multi-vendor (Cisco IOS-XE, Arista EOS, Juniper Junos) mantenendo retrocompatibilità con il parser Huawei esistente.

## Contesto

### Stato Attuale

| Componente | Stato | Note |
|------------|-------|------|
| Vendor Detection | Esiste | `sysObjectIDMap.js` supporta 30+ vendor via SNMP |
| Parser Huawei | Completo | ~850 righe, formati detailed/compact |
| Parser altri vendor | Mancante | Solo Huawei implementato |
| Discovery SSH | Hardcoded | Comando e parser Huawei-only |

### Problemi Identificati

1. `lldpSshDiscovery.js:100` - Comando hardcoded `display lldp neighbor`
2. `lldpSshDiscovery.js:119` - Parser hardcoded `parseHuaweiLldpNeighbors()`
3. `_inferVendor()` esiste ma non usato per selezionare comando/parser

### Driver del Cambiamento

- Rete attuale: solo Huawei
- Obiettivo: preparare NetMap per essere vendor-agnostic nel futuro
- Approccio: architettura plugin con stub documentati

---

## Architettura

### Approccio Scelto: Plugin Architecture

```
lib/vendors/
  ├── index.js              # Registry e factory function
  ├── VendorParser.js       # Classe base astratta
  ├── HuaweiParser.js       # Refactoring parser esistente
  ├── CiscoParser.js        # Stub IOS-XE/IOS
  ├── AristaParser.js       # Stub EOS
  └── JuniperParser.js      # Stub Junos
```

### Vantaggi

- Architettura pulita, facile aggiungere vendor
- Parser Huawei esistente preservato e testato
- Stub pronti con documentazione comandi
- Vendor auto-detection già funzionante via sysObjectID

---

## Specifiche Tecniche

### 1. Classe Base VendorParser

```javascript
// lib/vendors/VendorParser.js

export default class VendorParser {
  // Identificazione - proprietà statiche
  static vendorId = 'unknown';        // 'huawei', 'cisco', etc.
  static vendorNames = [];            // ['Huawei'], ['Cisco'], etc.
  static enterpriseIds = [];          // ['2011'], ['9'], etc.
  static isImplemented = false;       // true se parser completo

  // Comandi SSH
  getLldpCommand() {
    throw new Error('getLldpCommand() must be implemented');
  }

  getCdpCommand() {
    return null;  // Solo Cisco supporta CDP
  }

  getDisablePagingCommand() {
    throw new Error('getDisablePagingCommand() must be implemented');
  }

  getPromptPattern() {
    throw new Error('getPromptPattern() must be implemented');
  }

  // Parsing
  parseLldpOutput(output) {
    throw new Error('parseLldpOutput() must be implemented');
  }

  parseCdpOutput(output) {
    throw new Error('parseCdpOutput() not supported for this vendor');
  }

  // Normalizzazione output comune
  normalizeNeighbor(raw) {
    throw new Error('normalizeNeighbor() must be implemented');
  }
}
```

### 2. Output Normalizzato (comune a tutti i vendor)

```javascript
{
  localPort: 'GigabitEthernet0/0/1',   // Porta locale normalizzata
  remoteDevice: 'switch-02',           // Nome device remoto
  remotePort: 'Ethernet1',             // Porta remota
  remotePortDescr: 'uplink',           // Descrizione porta (opzionale)
  chassisId: 'aa:bb:cc:dd:ee:ff',      // MAC chassis
  managementIp: '192.168.1.2',         // IP management (opzionale)
  systemDescr: 'Huawei S5720...',      // System description (opzionale)
  capabilities: ['bridge', 'router']   // Capabilities LLDP
}
```

### 3. Registry e Factory

```javascript
// lib/vendors/index.js

import HuaweiParser from './HuaweiParser.js';
import CiscoParser from './CiscoParser.js';
import AristaParser from './AristaParser.js';
import JuniperParser from './JuniperParser.js';

const PARSERS = [
  HuaweiParser,
  CiscoParser,
  AristaParser,
  JuniperParser
];

// Cache per lookup veloce
const parserByVendorId = new Map();
const parserByEnterprise = new Map();
const parserByVendorName = new Map();

// Popola cache all'import
for (const Parser of PARSERS) {
  parserByVendorId.set(Parser.vendorId, Parser);
  Parser.enterpriseIds.forEach(id => parserByEnterprise.set(id, Parser));
  Parser.vendorNames.forEach(name => parserByVendorName.set(name.toLowerCase(), Parser));
}

/**
 * Ottiene parser dal vendor name (es. 'Huawei', 'Cisco')
 */
export function getParserByVendor(vendorName) {
  if (!vendorName) return null;
  return parserByVendorName.get(vendorName.toLowerCase()) || null;
}

/**
 * Ottiene parser dall'Enterprise ID SNMP (es. '2011', '9')
 */
export function getParserByEnterpriseId(enterpriseId) {
  return parserByEnterprise.get(String(enterpriseId)) || null;
}

/**
 * Lista vendor supportati
 */
export function getSupportedVendors() {
  return PARSERS.map(P => ({
    id: P.vendorId,
    names: P.vendorNames,
    enterpriseIds: P.enterpriseIds,
    implemented: P.isImplemented ?? false
  }));
}
```

### 4. HuaweiParser (Refactoring)

Strategia: **wrap del parser esistente**, non riscrittura.

```javascript
// lib/vendors/HuaweiParser.js

import VendorParser from './VendorParser.js';
import {
  parseHuaweiLldpNeighbors,
  normalizeInterfaceName,
  convertToNeDiLinks
} from '../huaweiLldpParser.js';

export default class HuaweiParser extends VendorParser {
  static vendorId = 'huawei';
  static vendorNames = ['Huawei', 'H3C'];
  static enterpriseIds = ['2011', '25506'];
  static isImplemented = true;

  getLldpCommand() {
    return 'display lldp neighbor';
  }

  getLldpDetailCommand() {
    return 'display lldp neighbor brief';
  }

  getCdpCommand() {
    return null;
  }

  getDisablePagingCommand() {
    return 'screen-length 0 temporary';
  }

  getPromptPattern() {
    return /<[\w\-_]+>|\[[\w\-_]+\]/;
  }

  parseLldpOutput(output) {
    const raw = parseHuaweiLldpNeighbors(output);
    return raw.map(n => this.normalizeNeighbor(n));
  }

  normalizeNeighbor(raw) {
    return {
      localPort: normalizeInterfaceName(raw.localPort),
      remoteDevice: raw.remoteSysname || raw.chassisId,
      remotePort: raw.remotePort || raw.portId,
      remotePortDescr: raw.portDescr || null,
      chassisId: raw.chassisId,
      managementIp: raw.mgmtAddr || null,
      systemDescr: raw.sysDescr || null,
      capabilities: this._parseCapabilities(raw.sysDescr)
    };
  }

  convertToNeDiLinks(neighbors, localDevice) {
    return convertToNeDiLinks(neighbors, localDevice);
  }

  _parseCapabilities(sysDescr) {
    if (!sysDescr) return [];
    const caps = [];
    if (/switch|bridge/i.test(sysDescr)) caps.push('bridge');
    if (/router/i.test(sysDescr)) caps.push('router');
    return caps;
  }
}
```

### 5. Stub Vendor

#### CiscoParser

```javascript
// lib/vendors/CiscoParser.js

import VendorParser from './VendorParser.js';

export default class CiscoParser extends VendorParser {
  static vendorId = 'cisco';
  static vendorNames = ['Cisco'];
  static enterpriseIds = ['9'];
  static isImplemented = false;

  getLldpCommand() {
    return 'show lldp neighbors detail';
  }

  getCdpCommand() {
    return 'show cdp neighbors detail';
  }

  getDisablePagingCommand() {
    return 'terminal length 0';
  }

  getPromptPattern() {
    return /[\w\-]+[#>]/;
  }

  parseLldpOutput(output) {
    // Formato atteso:
    // Local Intf: Gi0/1
    // Chassis id: 0011.2233.4455
    // Port id: Gi0/2
    // System Name: neighbor-switch
    throw new Error(
      `CiscoParser.parseLldpOutput() non ancora implementato.`
    );
  }

  parseCdpOutput(output) {
    throw new Error(`CiscoParser.parseCdpOutput() non ancora implementato.`);
  }
}
```

#### AristaParser

```javascript
// lib/vendors/AristaParser.js

import VendorParser from './VendorParser.js';

export default class AristaParser extends VendorParser {
  static vendorId = 'arista';
  static vendorNames = ['Arista'];
  static enterpriseIds = ['30065'];
  static isImplemented = false;

  getLldpCommand() {
    return 'show lldp neighbors detail';
  }

  getCdpCommand() {
    return null;
  }

  getDisablePagingCommand() {
    return 'terminal length 0';
  }

  getPromptPattern() {
    return /[\w\-]+[#>]/;
  }

  parseLldpOutput(output) {
    // Formato atteso:
    // Interface Ethernet1 detected 1 LLDP neighbors:
    //   Neighbor 0011.2233.4455/"Ethernet2"
    //     - System Name: "spine-01"
    throw new Error(`AristaParser.parseLldpOutput() non ancora implementato.`);
  }
}
```

#### JuniperParser

```javascript
// lib/vendors/JuniperParser.js

import VendorParser from './VendorParser.js';

export default class JuniperParser extends VendorParser {
  static vendorId = 'juniper';
  static vendorNames = ['Juniper'];
  static enterpriseIds = ['2636'];
  static isImplemented = false;

  getLldpCommand() {
    return 'show lldp neighbors';
  }

  getLldpDetailCommand() {
    return 'show lldp neighbors detail';
  }

  getCdpCommand() {
    return null;
  }

  getDisablePagingCommand() {
    return 'set cli screen-length 0';
  }

  getPromptPattern() {
    return /[\w\-@]+[>#]/;
  }

  parseLldpOutput(output) {
    // Formato atteso:
    // Local Interface  Chassis Id        Port info
    // ge-0/0/1         00:11:22:33:44:55 ge-0/0/2
    throw new Error(`JuniperParser.parseLldpOutput() non ancora implementato.`);
  }
}
```

### 6. Modifiche a LldpSshDiscovery

```javascript
// lib/lldpSshDiscovery.js - Modifiche chiave

import { getParserByVendor, getParserByEnterpriseId } from './vendors/index.js';

class LldpSshDiscovery {

  async discoverDevice(deviceName) {
    const report = {
      success: false,
      device: deviceName,
      deviceIp: null,
      vendor: null,
      parserUsed: null,
      neighborsFound: 0,
      linksCreated: 0,
      virtualDevicesCreated: 0,
      errors: []
    };

    try {
      const device = this.db.getDevice(deviceName);
      if (!device) {
        report.errors.push(`Device '${deviceName}' non trovato`);
        return report;
      }
      report.deviceIp = device.ip;

      // Ottieni parser per vendor
      const parser = this._getParserForDevice(device);
      if (!parser) {
        report.errors.push(`Nessun parser per vendor '${device.vendor}'`);
        return report;
      }

      report.vendor = parser.constructor.vendorId;
      report.parserUsed = parser.constructor.name;

      if (!parser.constructor.isImplemented) {
        report.errors.push(`Parser ${report.parserUsed} non implementato (stub)`);
        return report;
      }

      // Esegui comando vendor-specific
      const lldpCommand = parser.getLldpCommand();
      const lldpOutput = await this._executeCommand(device, lldpCommand, parser);

      // Parsa con parser vendor-specific
      const neighbors = parser.parseLldpOutput(lldpOutput);
      report.neighborsFound = neighbors.length;

      for (const neighbor of neighbors) {
        await this._processNeighbor(device, neighbor, report);
      }

      report.success = report.errors.length === 0 || report.linksCreated > 0;
      return report;

    } catch (err) {
      report.errors.push(`Errore: ${err.message}`);
      return report;
    }
  }

  _getParserForDevice(device) {
    // Priorita 1: vendor dal DB
    if (device.vendor) {
      const Parser = getParserByVendor(device.vendor);
      if (Parser) return new Parser();
    }

    // Priorita 2: enterprise ID
    if (device.sysobjectid) {
      const enterpriseId = this._extractEnterpriseId(device.sysobjectid);
      const Parser = getParserByEnterpriseId(enterpriseId);
      if (Parser) return new Parser();
    }

    // Priorita 3: inferenza da sysname
    const inferredVendor = this._inferVendor(device.name);
    if (inferredVendor !== 'Unknown') {
      const Parser = getParserByVendor(inferredVendor);
      if (Parser) return new Parser();
    }

    return null;
  }

  _extractEnterpriseId(sysObjectId) {
    const match = sysObjectId?.match(/1\.3\.6\.1\.4\.1\.(\d+)/);
    return match ? match[1] : null;
  }

  async _executeCommand(device, command, parser) {
    const disablePaging = parser.getDisablePagingCommand();
    const commands = disablePaging ? [disablePaging, command] : [command];

    if (this.ssh.getPool()) {
      return await this.ssh.executeCommandsPooled({
        host: device.ip,
        port: this.defaultPort,
        username: this.credentials.username,
        password: this.credentials.password,
        commands: commands,
        timeout: this.timeout
      });
    } else {
      return await this.ssh.executeCommands({
        host: device.ip,
        port: this.defaultPort,
        username: this.credentials.username,
        password: this.credentials.password,
        commands: commands,
        timeout: this.timeout
      });
    }
  }
}
```

### 7. API Diagnostica

```javascript
// In server.js

import { getSupportedVendors, getParserByVendor } from './lib/vendors/index.js';

// GET /api/vendors - Lista vendor supportati
app.get('/api/vendors', (req, res) => {
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
});

// GET /api/vendors/:vendorId - Dettagli vendor
app.get('/api/vendors/:vendorId', (req, res) => {
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
        cdp: parser.getCdpCommand(),
        disablePaging: parser.getDisablePagingCommand()
      }
    }
  });
});
```

---

## Testing

### Script Test: `test-vendor-parsers.mjs`

```javascript
#!/usr/bin/env node

import { getSupportedVendors, getParserByVendor } from './lib/vendors/index.js';

async function testVendorRegistry() {
  console.log('=== Test Vendor Registry ===\n');

  const vendors = getSupportedVendors();
  console.log(`Vendor registrati: ${vendors.length}`);

  for (const v of vendors) {
    const status = v.implemented ? '✓' : '! stub';
    console.log(`  ${status} ${v.id} (${v.names.join(', ')})`);
  }
}

async function testParserLookup() {
  console.log('\n=== Test Parser Lookup ===\n');

  const testCases = [
    { input: 'Huawei', expected: 'huawei' },
    { input: 'huawei', expected: 'huawei' },
    { input: 'Cisco', expected: 'cisco' },
    { input: 'Unknown', expected: null }
  ];

  for (const tc of testCases) {
    const Parser = getParserByVendor(tc.input);
    const result = Parser?.vendorId || null;
    const pass = result === tc.expected;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} getParserByVendor('${tc.input}') = ${result}`);
  }
}

async function testHuaweiParser() {
  console.log('\n=== Test Huawei Parser ===\n');

  const HuaweiParser = getParserByVendor('Huawei');
  const parser = new HuaweiParser();

  const sampleOutput = `
GE0/0/1 has 1 neighbor(s):
Neighbor index : 1
Chassis type   : MAC address
Chassis ID     : 00e0-fc12-3456
Port ID type   : Interface name
Port ID        : GigabitEthernet0/0/2
System name    : switch-02
  `;

  try {
    const neighbors = parser.parseLldpOutput(sampleOutput);
    console.log(`  PASS Parsed ${neighbors.length} neighbor(s)`);
  } catch (err) {
    console.log(`  FAIL ${err.message}`);
  }
}

async function testStubBehavior() {
  console.log('\n=== Test Stub Behavior ===\n');

  const CiscoParser = getParserByVendor('Cisco');
  const parser = new CiscoParser();

  console.log(`  isImplemented: ${CiscoParser.isImplemented}`);
  console.log(`  lldpCommand: ${parser.getLldpCommand()}`);

  try {
    parser.parseLldpOutput('test');
    console.log('  FAIL Stub should throw error');
  } catch (err) {
    console.log(`  PASS Stub throws error correctly`);
  }
}

await testVendorRegistry();
await testParserLookup();
await testHuaweiParser();
await testStubBehavior();

console.log('\n=== Test completati ===');
```

---

## Piano di Implementazione

### Fase 1: Infrastruttura (priorità alta)

1. Creare directory `lib/vendors/`
2. Implementare `VendorParser.js` (classe base)
3. Implementare `index.js` (registry e factory)
4. Implementare `HuaweiParser.js` (wrap parser esistente)

### Fase 2: Stub Vendor (priorità media)

5. Implementare `CiscoParser.js` (stub)
6. Implementare `AristaParser.js` (stub)
7. Implementare `JuniperParser.js` (stub)

### Fase 3: Integrazione (priorità alta)

8. Modificare `LldpSshDiscovery.discoverDevice()`
9. Aggiungere metodi helper `_getParserForDevice()`, `_extractEnterpriseId()`

### Fase 4: API e Testing (priorità media)

10. Aggiungere endpoint `/api/vendors`
11. Creare `test-vendor-parsers.mjs`
12. Test non-regressione parser Huawei

---

## Retrocompatibilita

- `lib/huaweiLldpParser.js` rimane **invariato**
- Import diretto `parseHuaweiLldpNeighbors()` continua a funzionare
- Nessun breaking change per codice esistente

---

## Estensione Futura

Per aggiungere un nuovo vendor:

1. Creare `lib/vendors/NewVendorParser.js`
2. Estendere `VendorParser`
3. Implementare metodi richiesti
4. Aggiungere a `PARSERS` array in `index.js`
5. Testare con hardware reale

---

## Riferimenti

- Parser Huawei esistente: `lib/huaweiLldpParser.js`
- Vendor detection: `lib/sysObjectIDMap.js`
- Discovery SSH: `lib/lldpSshDiscovery.js`
- Documentazione: `docs/HUAWEI_LLDP_PARSER.md`
