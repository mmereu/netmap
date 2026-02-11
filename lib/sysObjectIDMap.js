/**
 * Mapping sysObjectID -> Vendor/Model/OS (stile NeDi)
 * Basato su enterprise OID e pattern comuni
 */

// Enterprise OID prefixes
const ENTERPRISE_PREFIX = '1.3.6.1.4.1';

// Vendor mapping basato su enterprise number
const VENDOR_MAP = {
  // Cisco
  '9': { vendor: 'Cisco', os: 'IOS' },
  // Huawei
  '2011': { vendor: 'Huawei', os: 'VRP' },
  // HP/Aruba
  '11': { vendor: 'HP', os: 'ProCurve' },
  '25506': { vendor: 'H3C', os: 'Comware' },
  '47196': { vendor: 'Aruba', os: 'ArubaOS' },
  // Juniper
  '2636': { vendor: 'Juniper', os: 'Junos' },
  // Extreme
  '1916': { vendor: 'Extreme', os: 'ExtremeXOS' },
  // Brocade/Foundry
  '1991': { vendor: 'Brocade', os: 'FabricOS' },
  // Dell
  '674': { vendor: 'Dell', os: 'FTOS' },
  '6027': { vendor: 'Dell Force10', os: 'FTOS' },
  // Arista
  '30065': { vendor: 'Arista', os: 'EOS' },
  // Mikrotik
  '14988': { vendor: 'Mikrotik', os: 'RouterOS' },
  // Ubiquiti
  '41112': { vendor: 'Ubiquiti', os: 'EdgeOS' },
  // Fortinet
  '12356': { vendor: 'Fortinet', os: 'FortiOS' },
  // Palo Alto
  '25461': { vendor: 'Palo Alto', os: 'PAN-OS' },
  // Check Point
  '2620': { vendor: 'Check Point', os: 'Gaia' },
  // F5
  '3375': { vendor: 'F5', os: 'TMOS' },
  // Netgear
  '4526': { vendor: 'Netgear', os: 'NetgearOS' },
  // D-Link
  '171': { vendor: 'D-Link', os: 'D-LinkOS' },
  // TP-Link
  '11863': { vendor: 'TP-Link', os: 'TP-LinkOS' },
  // Zyxel
  '890': { vendor: 'Zyxel', os: 'ZyNOS' },
  // Allied Telesis
  '207': { vendor: 'Allied Telesis', os: 'AlliedWare' },
  // Alcatel-Lucent
  '6486': { vendor: 'Alcatel-Lucent', os: 'AOS' },
  // Nortel/Avaya
  '2272': { vendor: 'Nortel', os: 'NTOS' },
  '562': { vendor: 'Nortel', os: 'NTOS' },
  // Enterasys
  '5624': { vendor: 'Enterasys', os: 'EnterasysOS' },
  // 3Com
  '43': { vendor: '3Com', os: '3ComOS' },
  // Linux
  '8072': { vendor: 'Net-SNMP', os: 'Linux' },
  // VMware
  '6876': { vendor: 'VMware', os: 'ESXi' },
  // Microsoft
  '311': { vendor: 'Microsoft', os: 'Windows' },
};

// Model mapping dettagliato per vendor (pattern sysObjectID completo)
const MODEL_PATTERNS = {
  // Huawei S-series switches
  '1.3.6.1.4.1.2011.2.23.': { vendor: 'Huawei', model: 'S-Series Switch', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.69': { vendor: 'Huawei', model: 'S5720', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.95': { vendor: 'Huawei', model: 'S5735', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.96': { vendor: 'Huawei', model: 'S5731', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.97': { vendor: 'Huawei', model: 'S6730', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.107': { vendor: 'Huawei', model: 'S5736', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.190': { vendor: 'Huawei', model: 'S5735S', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.215': { vendor: 'Huawei', model: 'S5735-L', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.276': { vendor: 'Huawei', model: 'S5735-L-V2', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.277': { vendor: 'Huawei', model: 'S5736-S', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.278': { vendor: 'Huawei', model: 'S5735S-L-M', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.288': { vendor: 'Huawei', model: 'S5735-L-V2-I', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.23.314': { vendor: 'Huawei', model: 'S5735-S-V2', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.170': { vendor: 'Huawei', model: 'NE Series Router', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.224': { vendor: 'Huawei', model: 'CE Series Switch', os: 'VRP' },
  '1.3.6.1.4.1.2011.2.239': { vendor: 'Huawei', model: 'CloudEngine', os: 'VRP' },
  
  // Cisco Catalyst
  '1.3.6.1.4.1.9.1.': { vendor: 'Cisco', model: 'Catalyst', os: 'IOS' },
  '1.3.6.1.4.1.9.1.516': { vendor: 'Cisco', model: 'Catalyst 2960', os: 'IOS' },
  '1.3.6.1.4.1.9.1.696': { vendor: 'Cisco', model: 'Catalyst 2960S', os: 'IOS' },
  '1.3.6.1.4.1.9.1.1208': { vendor: 'Cisco', model: 'Catalyst 2960X', os: 'IOS' },
  '1.3.6.1.4.1.9.1.1745': { vendor: 'Cisco', model: 'Catalyst 9300', os: 'IOS-XE' },
  '1.3.6.1.4.1.9.1.2066': { vendor: 'Cisco', model: 'Catalyst 9200', os: 'IOS-XE' },
  '1.3.6.1.4.1.9.1.282': { vendor: 'Cisco', model: 'Catalyst 3750', os: 'IOS' },
  '1.3.6.1.4.1.9.1.428': { vendor: 'Cisco', model: 'Catalyst 3560', os: 'IOS' },
  '1.3.6.1.4.1.9.1.614': { vendor: 'Cisco', model: 'Catalyst 3750X', os: 'IOS' },
  
  // HP ProCurve
  '1.3.6.1.4.1.11.2.3.7.11.': { vendor: 'HP', model: 'ProCurve', os: 'ProCurve' },
  '1.3.6.1.4.1.11.2.3.7.11.33': { vendor: 'HP', model: 'ProCurve 2920', os: 'ProCurve' },
  '1.3.6.1.4.1.11.2.3.7.11.72': { vendor: 'HP', model: 'ProCurve 2530', os: 'ProCurve' },
  
  // Aruba
  '1.3.6.1.4.1.47196.4.1.1.1.': { vendor: 'Aruba', model: 'Aruba Switch', os: 'ArubaOS-CX' },
  
  // Juniper
  '1.3.6.1.4.1.2636.1.1.1.2.': { vendor: 'Juniper', model: 'EX Series', os: 'Junos' },
  '1.3.6.1.4.1.2636.1.1.1.2.30': { vendor: 'Juniper', model: 'EX2200', os: 'Junos' },
  '1.3.6.1.4.1.2636.1.1.1.2.31': { vendor: 'Juniper', model: 'EX4200', os: 'Junos' },
  
  // Extreme
  '1.3.6.1.4.1.1916.2.': { vendor: 'Extreme', model: 'Summit', os: 'ExtremeXOS' },
  
  // Brocade/Foundry
  '1.3.6.1.4.1.1991.1.3.': { vendor: 'Brocade', model: 'ICX', os: 'FastIron' },
  
  // Dell
  '1.3.6.1.4.1.674.10895.': { vendor: 'Dell', model: 'PowerConnect', os: 'DNOS' },
  '1.3.6.1.4.1.6027.1.': { vendor: 'Dell Force10', model: 'S-Series', os: 'FTOS' },
  
  // Arista
  '1.3.6.1.4.1.30065.1.': { vendor: 'Arista', model: '7000 Series', os: 'EOS' },
  
  // Mikrotik
  '1.3.6.1.4.1.14988.1': { vendor: 'Mikrotik', model: 'RouterBoard', os: 'RouterOS' },
};

// Pattern per estrarre modello da sysDescr
const SYSDESCR_PATTERNS = [
  // Huawei
  { regex: /Huawei.*?(S\d{4}[A-Z0-9-]*)/i, vendor: 'Huawei', modelGroup: 1 },
  { regex: /Huawei.*?(CE\d{4}[A-Z0-9-]*)/i, vendor: 'Huawei', modelGroup: 1 },
  { regex: /Huawei.*?(NE\d{2,4}[A-Z0-9-]*)/i, vendor: 'Huawei', modelGroup: 1 },
  { regex: /VRP.*?Version\s+(\d+\.\d+)/i, osGroup: 1, osPrefix: 'VRP ' },
  
  // Cisco
  { regex: /Cisco.*?(Catalyst\s*\d{4}[A-Z0-9-]*)/i, vendor: 'Cisco', modelGroup: 1 },
  { regex: /Cisco.*?(WS-C\d{4}[A-Z0-9-]*)/i, vendor: 'Cisco', modelGroup: 1 },
  { regex: /Cisco.*?(C\d{4}[A-Z0-9-]*)/i, vendor: 'Cisco', modelGroup: 1 },
  { regex: /Cisco IOS.*?Version\s+([\d.()A-Z]+)/i, osGroup: 1, osPrefix: 'IOS ' },
  
  // HP
  { regex: /HP.*?(ProCurve\s*\d{4}[A-Z0-9-]*)/i, vendor: 'HP', modelGroup: 1 },
  { regex: /HP.*?(J\d{4}[A-Z])/i, vendor: 'HP', modelGroup: 1 },
  
  // Juniper
  { regex: /Juniper.*?(EX\d{4}[A-Z0-9-]*)/i, vendor: 'Juniper', modelGroup: 1 },
  { regex: /Juniper.*?(QFX\d{4}[A-Z0-9-]*)/i, vendor: 'Juniper', modelGroup: 1 },
  { regex: /JUNOS\s+([\d.R-]+)/i, osGroup: 1, osPrefix: 'Junos ' },
  
  // Extreme
  { regex: /Extreme.*?(Summit\s*[A-Z0-9-]+)/i, vendor: 'Extreme', modelGroup: 1 },
  { regex: /ExtremeXOS.*?version\s+([\d.]+)/i, osGroup: 1, osPrefix: 'ExtremeXOS ' },
  
  // Arista
  { regex: /Arista.*?(DCS-\d{4}[A-Z0-9-]*)/i, vendor: 'Arista', modelGroup: 1 },
  
  // Generic
  { regex: /Linux\s+(\S+)/i, osGroup: 1, osPrefix: 'Linux ' },
  { regex: /Windows.*?(\d+)/i, osGroup: 1, osPrefix: 'Windows ' },
];

/**
 * Estrae vendor/model/os da sysObjectID e sysDescr
 * @param {string} sysObjectID - OID completo (es. "1.3.6.1.4.1.2011.2.23.215")
 * @param {string} sysDescr - Descrizione sistema
 * @returns {Object} { vendor, model, os, serial }
 */
function extractDeviceFacts(sysObjectID, sysDescr = '') {
  const result = {
    vendor: null,
    model: null,
    os: null,
    serial: null,
  };
  
  if (!sysObjectID) return result;
  
  // 1. Cerca match esatto nel MODEL_PATTERNS
  for (const [pattern, info] of Object.entries(MODEL_PATTERNS)) {
    if (sysObjectID.startsWith(pattern)) {
      result.vendor = info.vendor;
      result.model = info.model;
      result.os = info.os;
      break;
    }
  }
  
  // 2. Se non trovato, estrai vendor da enterprise number
  if (!result.vendor && sysObjectID.startsWith(ENTERPRISE_PREFIX)) {
    const parts = sysObjectID.split('.');
    if (parts.length >= 7) {
      const enterpriseNum = parts[6];
      const vendorInfo = VENDOR_MAP[enterpriseNum];
      if (vendorInfo) {
        result.vendor = vendorInfo.vendor;
        result.os = vendorInfo.os;
      }
    }
  }
  
  // 3. Arricchisci con info da sysDescr
  if (sysDescr) {
    for (const pattern of SYSDESCR_PATTERNS) {
      const match = sysDescr.match(pattern.regex);
      if (match) {
        if (pattern.vendor && !result.vendor) {
          result.vendor = pattern.vendor;
        }
        if (pattern.modelGroup && match[pattern.modelGroup]) {
          result.model = match[pattern.modelGroup].trim();
        }
        if (pattern.osGroup && match[pattern.osGroup]) {
          result.os = (pattern.osPrefix || '') + match[pattern.osGroup].trim();
        }
      }
    }
    
    // Cerca serial number in sysDescr (pattern comuni)
    const serialPatterns = [
      /serial[:\s#]*([A-Z0-9]{8,})/i,
      /S\/N[:\s]*([A-Z0-9]{8,})/i,
      /SN[:\s]*([A-Z0-9]{8,})/i,
    ];
    for (const regex of serialPatterns) {
      const match = sysDescr.match(regex);
      if (match) {
        result.serial = match[1];
        break;
      }
    }
  }
  
  // 4. Fallback: usa sysObjectID come model se non trovato
  if (!result.model && sysObjectID) {
    // Estrai ultime 2-3 parti dell'OID come identificatore
    const parts = sysObjectID.split('.');
    if (parts.length > 3) {
      result.model = `OID-${parts.slice(-3).join('.')}`;
    }
  }
  
  return result;
}

/**
 * Determina il tipo di dispositivo (switch L2, switch L3, router, firewall, ecc.)
 * @param {Object} facts - { vendor, model, os, sysDescr }
 * @returns {string} Tipo dispositivo
 */
function getDeviceType(facts) {
  const { vendor, model, os, sysDescr = '' } = facts;
  const descLower = (sysDescr || '').toLowerCase();
  const modelLower = (model || '').toLowerCase();
  
  // Router
  if (descLower.includes('router') || modelLower.includes('router') ||
      modelLower.includes('ne40') || modelLower.includes('ne80') ||
      modelLower.includes('asr') || modelLower.includes('isr')) {
    return 'router';
  }
  
  // Firewall
  if (descLower.includes('firewall') || descLower.includes('fortigate') ||
      descLower.includes('palo alto') || descLower.includes('checkpoint') ||
      vendor === 'Fortinet' || vendor === 'Palo Alto' || vendor === 'Check Point') {
    return 'firewall';
  }
  
  // Switch L3 (core)
  if (modelLower.includes('s6730') || modelLower.includes('s7700') ||
      modelLower.includes('s9300') || modelLower.includes('ce12800') ||
      modelLower.includes('catalyst 6') || modelLower.includes('catalyst 9') ||
      modelLower.includes('nexus') || modelLower.includes('ex4') ||
      descLower.includes('core') || descLower.includes('layer 3')) {
    return 'switch-l3';
  }
  
  // Switch L2 (access/distribution)
  if (modelLower.includes('s5735') || modelLower.includes('s5720') ||
      modelLower.includes('s2700') || modelLower.includes('s3700') ||
      modelLower.includes('catalyst 2') || modelLower.includes('catalyst 3') ||
      modelLower.includes('procurve') || modelLower.includes('ex2') ||
      descLower.includes('switch') || descLower.includes('layer 2')) {
    return 'switch-l2';
  }
  
  // Access Point
  if (descLower.includes('access point') || descLower.includes('wireless') ||
      modelLower.includes('ap') || modelLower.includes('wap')) {
    return 'access-point';
  }
  
  // Server
  if (descLower.includes('server') || descLower.includes('linux') ||
      descLower.includes('windows server') || vendor === 'VMware') {
    return 'server';
  }
  
  // Default
  return 'switch';
}

/**
 * Ottiene l'icona appropriata per il tipo di dispositivo (stile NeDi)
 * @param {string} deviceType - Tipo dispositivo
 * @param {string} status - Stato (active, down, warning)
 * @returns {string} Path icona
 */
function getDeviceIcon(deviceType, status = 'active') {
  const statusSuffix = status === 'down' ? 'r' : (status === 'warning' ? 'o' : 'g');
  
  const iconMap = {
    'router': `dev/w2g${statusSuffix}`,
    'switch-l3': `dev/skm${statusSuffix}`,
    'switch-l2': `dev/s2l${statusSuffix}`,
    'switch': `dev/w2g${statusSuffix}`,
    'firewall': `dev/fwl${statusSuffix}`,
    'access-point': `dev/wap${statusSuffix}`,
    'server': `dev/srv${statusSuffix}`,
    'default': `dev/w2gd`,
  };
  
  return iconMap[deviceType] || iconMap['default'];
}

export {
  extractDeviceFacts,
  getDeviceType,
  getDeviceIcon,
  VENDOR_MAP,
  MODEL_PATTERNS,
};

export default {
  extractDeviceFacts,
  getDeviceType,
  getDeviceIcon,
};



