/**
 * Huawei Command Library
 *
 * Libreria di comandi Huawei pre-validati per diagnostica switch.
 * Include parser per output e generatori di comandi.
 *
 * @version 1.0.0
 */

// =============================================================================
// COMMAND DEFINITIONS
// =============================================================================

/**
 * Comandi diagnostici categorizzati per uso
 */
export const COMMANDS = {
  // ===== MAC Address =====
  mac: {
    all: 'display mac-address',
    byVlan: (vlan) => `display mac-address vlan ${vlan}`,
    byInterface: (iface) => `display mac-address ${iface}`,
    byMac: (mac) => `display mac-address ${mac}`,
    dynamic: 'display mac-address dynamic',
    static: 'display mac-address static',
    count: 'display mac-address summary'
  },

  // ===== Interface =====
  interface: {
    brief: 'display interface brief',
    status: 'display interface',
    single: (iface) => `display interface ${iface}`,
    description: 'display interface description',
    errors: (iface) => `display interface ${iface} | include error|CRC|collision`,
    transceiver: (iface) => `display transceiver interface ${iface}`,
    transceiverAll: 'display transceiver'
  },

  // ===== VLAN =====
  vlan: {
    all: 'display vlan',
    single: (vlan) => `display vlan ${vlan}`,
    brief: 'display vlan brief',
    summary: 'display vlan summary',
    portVlan: (iface) => `display port vlan ${iface}`
  },

  // ===== ARP =====
  arp: {
    all: 'display arp all',
    byIp: (ip) => `display arp ${ip}`,
    byInterface: (iface) => `display arp interface ${iface}`,
    byVlan: (vlan) => `display arp vlan ${vlan}`,
    count: 'display arp statistics'
  },

  // ===== LLDP =====
  lldp: {
    neighbors: 'display lldp neighbor',
    neighborBrief: 'display lldp neighbor brief',
    neighborDetail: (iface) => `display lldp neighbor interface ${iface}`,
    status: 'display lldp status',
    local: 'display lldp local'
  },

  // ===== STP =====
  stp: {
    brief: 'display stp brief',
    status: 'display stp',
    interface: (iface) => `display stp interface ${iface}`,
    root: 'display stp root',
    topology: 'display stp topology-change'
  },

  // ===== Device Info =====
  device: {
    version: 'display version',
    inventory: 'display device',
    cpu: 'display cpu-usage',
    memory: 'display memory-usage',
    temperature: 'display temperature all',
    power: 'display power',
    fan: 'display fan',
    elabel: 'display elabel',
    esn: 'display esn'
  },

  // ===== Routing =====
  routing: {
    table: 'display ip routing-table',
    toIp: (ip) => `display ip routing-table ${ip}`,
    summary: 'display ip routing-table statistics',
    static: 'display ip routing-table protocol static'
  },

  // ===== Port Channel / Eth-Trunk =====
  trunk: {
    all: 'display eth-trunk',
    single: (id) => `display eth-trunk ${id}`,
    summary: 'display trunkmembership eth-trunk'
  },

  // ===== Logs/Events =====
  logs: {
    recent: 'display logbuffer',
    alarm: 'display alarm active',
    traplog: 'display trapbuffer'
  },

  // ===== Diagnostics =====
  diag: {
    ping: (ip) => `ping ${ip}`,
    pingCount: (ip, count) => `ping -c ${count} ${ip}`,
    tracert: (ip) => `tracert ${ip}`,
    ntp: 'display ntp-service status',
    clock: 'display clock',
    uptime: 'display version | include uptime'
  },

  // ===== Stack =====
  stack: {
    status: 'display stack',
    configuration: 'display stack configuration',
    peers: 'display stack peer'
  },

  // ===== PoE =====
  poe: {
    interface: (iface) => `display poe interface ${iface}`,
    power: 'display poe power',
    device: 'display poe-device'
  }
};

// =============================================================================
// OUTPUT PARSERS
// =============================================================================

/**
 * Parse MAC address table output
 */
export function parseMacTable(output) {
  const macs = [];
  const lines = output.split('\n');

  // Pattern per riga MAC Huawei
  // MAC Address    VLAN/VSI/BD   Learned-From        Type
  // 0000-0000-0001 10            GE0/0/1             dynamic
  const macPattern = /([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\s+(\d+)\s+(\S+)\s+(\w+)/gi;

  for (const line of lines) {
    const match = macPattern.exec(line);
    if (match) {
      macs.push({
        mac: match[1],
        vlan: parseInt(match[2]),
        interface: match[3],
        type: match[4].toLowerCase()
      });
    }
    macPattern.lastIndex = 0;  // Reset regex
  }

  return macs;
}

/**
 * Parse interface brief output
 */
export function parseInterfaceBrief(output) {
  const interfaces = [];
  const lines = output.split('\n');

  // Pattern: Interface  PHY  Protocol InUti OutUti   inBand   outBand
  const ifacePattern = /^(\S+)\s+(up|down|\*down)\s+(up|down|\*down)/i;

  for (const line of lines) {
    const match = line.match(ifacePattern);
    if (match) {
      interfaces.push({
        name: match[1],
        physical: match[2].replace('*', ''),
        protocol: match[3].replace('*', ''),
        adminDown: match[2].includes('*') || match[3].includes('*')
      });
    }
  }

  return interfaces;
}

/**
 * Parse ARP table output
 */
export function parseArpTable(output) {
  const entries = [];
  const lines = output.split('\n');

  // Pattern: IP Address      MAC Address     VLAN Interface   Aging Type
  const arpPattern = /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\s+(\d+)\s+(\S+)/gi;

  for (const line of lines) {
    const match = arpPattern.exec(line);
    if (match) {
      entries.push({
        ip: match[1],
        mac: match[2],
        vlan: parseInt(match[3]),
        interface: match[4]
      });
    }
    arpPattern.lastIndex = 0;
  }

  return entries;
}

/**
 * Parse LLDP neighbor output
 */
export function parseLldpNeighbors(output) {
  const neighbors = [];
  const blocks = output.split(/Local Interface:/i).slice(1);

  for (const block of blocks) {
    const neighbor = {};

    // Local interface
    const localMatch = block.match(/^\s*(\S+)/);
    if (localMatch) neighbor.localInterface = localMatch[1];

    // Neighbor device
    const chassisMatch = block.match(/Chassis ID\s*:\s*(.+)/i);
    if (chassisMatch) neighbor.chassisId = chassisMatch[1].trim();

    // Port ID
    const portMatch = block.match(/Port ID\s*:\s*(.+)/i);
    if (portMatch) neighbor.remotePort = portMatch[1].trim();

    // System name
    const sysMatch = block.match(/System Name\s*:\s*(.+)/i);
    if (sysMatch) neighbor.systemName = sysMatch[1].trim();

    // System description
    const descMatch = block.match(/System Description\s*:\s*(.+)/i);
    if (descMatch) neighbor.systemDescription = descMatch[1].trim();

    // Management address
    const mgmtMatch = block.match(/Management Address\s*:\s*(\d+\.\d+\.\d+\.\d+)/i);
    if (mgmtMatch) neighbor.managementIp = mgmtMatch[1];

    if (neighbor.localInterface) {
      neighbors.push(neighbor);
    }
  }

  return neighbors;
}

/**
 * Parse device version output
 */
export function parseVersion(output) {
  const info = {};

  // Software version
  const versionMatch = output.match(/VRP.*Version\s+(\S+)/i);
  if (versionMatch) info.version = versionMatch[1];

  // Model
  const modelMatch = output.match(/(?:Huawei|HUAWEI)\s+(S\d+\S*)/i);
  if (modelMatch) info.model = modelMatch[1];

  // Uptime
  const uptimeMatch = output.match(/uptime is\s+(.+)/i);
  if (uptimeMatch) info.uptime = uptimeMatch[1].trim();

  // Memory
  const memMatch = output.match(/(\d+)\s+bytes\s+memory/i);
  if (memMatch) info.memory = parseInt(memMatch[1]);

  // Serial number
  const snMatch = output.match(/ESN\s*[:\s]+(\S+)/i);
  if (snMatch) info.serialNumber = snMatch[1];

  return info;
}

/**
 * Parse CPU usage output
 */
export function parseCpuUsage(output) {
  const cpuMatch = output.match(/CPU\s*Usage\s*:\s*(\d+)%/i);
  return cpuMatch ? parseInt(cpuMatch[1]) : null;
}

/**
 * Parse memory usage output
 */
export function parseMemoryUsage(output) {
  const memMatch = output.match(/Memory\s*Using\s*Percentage\s*:\s*(\d+)%/i);
  return memMatch ? parseInt(memMatch[1]) : null;
}

// =============================================================================
// COMMAND GENERATORS
// =============================================================================

/**
 * Generate diagnostic command sequence for a MAC search
 */
export function generateMacSearchSequence(mac, vlan = null) {
  const commands = [];

  // Search MAC in table
  commands.push({
    command: COMMANDS.mac.byMac(mac),
    purpose: 'Find MAC in forwarding table',
    parser: parseMacTable
  });

  // If VLAN known, also search in that VLAN
  if (vlan) {
    commands.push({
      command: COMMANDS.mac.byVlan(vlan),
      purpose: `List all MACs in VLAN ${vlan}`,
      parser: parseMacTable
    });
  }

  // Check ARP for IP
  commands.push({
    command: COMMANDS.arp.all,
    purpose: 'Find IP address from ARP',
    parser: parseArpTable
  });

  return commands;
}

/**
 * Generate diagnostic command sequence for interface troubleshooting
 */
export function generateInterfaceDiagSequence(interfaceName) {
  return [
    {
      command: COMMANDS.interface.single(interfaceName),
      purpose: 'Get detailed interface status',
      parser: null
    },
    {
      command: COMMANDS.interface.errors(interfaceName),
      purpose: 'Check for interface errors',
      parser: null
    },
    {
      command: COMMANDS.lldp.neighborDetail(interfaceName),
      purpose: 'Check LLDP neighbor on interface',
      parser: parseLldpNeighbors
    },
    {
      command: COMMANDS.stp.interface(interfaceName),
      purpose: 'Check STP status on interface',
      parser: null
    },
    {
      command: COMMANDS.mac.byInterface(interfaceName),
      purpose: 'List MACs learned on interface',
      parser: parseMacTable
    }
  ];
}

/**
 * Generate device health check sequence
 */
export function generateHealthCheckSequence() {
  return [
    {
      command: COMMANDS.device.version,
      purpose: 'Get device version and uptime',
      parser: parseVersion
    },
    {
      command: COMMANDS.device.cpu,
      purpose: 'Check CPU usage',
      parser: parseCpuUsage
    },
    {
      command: COMMANDS.device.memory,
      purpose: 'Check memory usage',
      parser: parseMemoryUsage
    },
    {
      command: COMMANDS.device.temperature,
      purpose: 'Check temperature',
      parser: null
    },
    {
      command: COMMANDS.logs.alarm,
      purpose: 'Check active alarms',
      parser: null
    }
  ];
}

// =============================================================================
// COMMAND TEMPLATES
// =============================================================================

/**
 * Common diagnostic scenarios with pre-built command sets
 */
export const DIAGNOSTIC_SCENARIOS = {
  // Port down troubleshooting
  portDown: {
    name: 'Port Down Troubleshooting',
    description: 'Diagnose why a port is down',
    requiredParams: ['interface'],
    commands: (params) => [
      `display interface ${params.interface}`,
      `display transceiver interface ${params.interface}`,
      `display lldp neighbor interface ${params.interface}`,
      `display stp interface ${params.interface}`
    ]
  },

  // Device not reachable
  deviceUnreachable: {
    name: 'Device Unreachable',
    description: 'Diagnose connectivity to a device',
    requiredParams: ['ip'],
    commands: (params) => [
      `ping ${params.ip}`,
      `display arp ${params.ip}`,
      `display ip routing-table ${params.ip}`
    ]
  },

  // MAC flapping
  macFlapping: {
    name: 'MAC Flapping Detection',
    description: 'Detect and diagnose MAC flapping',
    requiredParams: ['mac'],
    commands: (params) => [
      `display mac-address ${params.mac}`,
      `display logbuffer | include ${params.mac}`,
      `display stp brief`
    ]
  },

  // VLAN issues
  vlanTroubleshooting: {
    name: 'VLAN Troubleshooting',
    description: 'Diagnose VLAN configuration issues',
    requiredParams: ['vlan'],
    commands: (params) => [
      `display vlan ${params.vlan}`,
      `display mac-address vlan ${params.vlan}`,
      `display arp vlan ${params.vlan}`
    ]
  },

  // Performance check
  performanceCheck: {
    name: 'Performance Check',
    description: 'Check overall device performance',
    requiredParams: [],
    commands: () => [
      'display cpu-usage',
      'display memory-usage',
      'display interface brief | include up'
    ]
  }
};

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  COMMANDS,
  DIAGNOSTIC_SCENARIOS,
  parseMacTable,
  parseInterfaceBrief,
  parseArpTable,
  parseLldpNeighbors,
  parseVersion,
  parseCpuUsage,
  parseMemoryUsage,
  generateMacSearchSequence,
  generateInterfaceDiagSequence,
  generateHealthCheckSequence
};
