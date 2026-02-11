/**
 * Council Context Injection
 *
 * Gestisce l'iniezione di contesto NetMap nelle query del Council.
 * Include informazioni su dispositivi, topologia e stato rete.
 *
 * @version 1.0.0
 */

// =============================================================================
// CONTEXT TEMPLATES
// =============================================================================

/**
 * System prompt base per il Council
 */
export const BASE_SYSTEM_PROMPT = `Sei un assistente AI specializzato in reti enterprise, con particolare competenza su:
- Switch Huawei serie S5700/S5720/S5735
- Protocolli di rete (LLDP, STP, VLAN, LACP)
- Troubleshooting di rete
- Network monitoring con NeDi

Rispondi sempre in italiano in modo chiaro e conciso.
Quando fornisci comandi CLI, specifica sempre per quale dispositivo/vendor.
Se non sei sicuro di qualcosa, dillo chiaramente.`;

/**
 * Context templates per diversi tipi di query
 */
export const CONTEXT_TEMPLATES = {
  mac_search: `
CONTESTO RICERCA MAC:
L'utente sta cercando un MAC address nella rete aziendale.
- Rete: {{network}}
- MAC cercato: {{mac}}
- Risultato ricerca DB: {{db_result}}

Se il MAC è stato trovato, indica:
1. Switch e porta dove è collegato
2. VLAN di appartenenza
3. Se è un trunk o access port

Se non trovato, suggerisci:
1. Verificare il formato MAC
2. Controllare se il dispositivo è acceso
3. Possibili comandi SSH per diagnosi`,

  device_info: `
CONTESTO DISPOSITIVO:
Informazioni sul dispositivo di rete richiesto.
- Dispositivo: {{device}}
- Tipo: {{type}}
- IP: {{ip}}
- Modello: {{model}}
- Location: {{location}}
- Status: {{status}}
- Uptime: {{uptime}}

Informazioni aggiuntive:
- Interfacce totali: {{interface_count}}
- Interfacce UP: {{interfaces_up}}
- VLAN configurate: {{vlan_count}}`,

  topology: `
CONTESTO TOPOLOGIA:
Topologia di rete per il sito richiesto.
- Sito: {{site}}
- Dispositivi totali: {{device_count}}
- Link LLDP: {{link_count}}
- Access Points: {{ap_count}}

Struttura:
{{topology_tree}}`,

  troubleshooting: `
CONTESTO TROUBLESHOOTING:
L'utente sta cercando di risolvere un problema di rete.
- Problema descritto: {{problem}}
- Dispositivo coinvolto: {{device}}
- Ultimo status: {{last_status}}
- Eventi recenti: {{recent_events}}

Guida il troubleshooting passo-passo, partendo dalle verifiche più semplici.`,

  general: `
CONTESTO RETE NETMAP:
Informazioni generali sulla rete gestita.
- Dispositivi totali: {{total_devices}}
- Switch: {{switch_count}}
- Router: {{router_count}}
- Access Points: {{ap_count}}
- Siti: {{site_count}}

Database NeDi:
- MAC addresses noti: {{mac_count}}
- Link LLDP: {{link_count}}`
};

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

/**
 * Build context for a query
 *
 * @param {string} queryType - Type of query (mac_search, device_info, etc.)
 * @param {object} data - Data to inject into template
 * @returns {string} Formatted context
 */
export function buildContext(queryType, data = {}) {
  const template = CONTEXT_TEMPLATES[queryType] || CONTEXT_TEMPLATES.general;

  // Replace placeholders with data
  let context = template;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `{{${key}}}`;
    const displayValue = formatValue(value);
    context = context.replace(new RegExp(placeholder, 'g'), displayValue);
  }

  // Remove unfilled placeholders
  context = context.replace(/\{\{[^}]+\}\}/g, 'N/A');

  return context.trim();
}

/**
 * Format a value for display in context
 */
function formatValue(value) {
  if (value === null || value === undefined) {
    return 'N/A';
  }
  if (Array.isArray(value)) {
    return value.length > 5
      ? `${value.slice(0, 5).join(', ')} ... (${value.length} totali)`
      : value.join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Create full system prompt with context
 *
 * @param {string} queryType - Type of query
 * @param {object} contextData - Context data
 * @param {object} options - Options
 * @returns {string} Full system prompt
 */
export function createSystemPrompt(queryType, contextData = {}, options = {}) {
  const parts = [BASE_SYSTEM_PROMPT];

  // Add context if provided
  if (queryType && Object.keys(contextData).length > 0) {
    const context = buildContext(queryType, contextData);
    parts.push('\n---\n' + context);
  }

  // Add tool instructions if tools enabled
  if (options.toolsEnabled) {
    parts.push(`
---
ISTRUZIONI TOOLS:
Hai accesso a tools per interagire con la rete. Usali quando necessario per:
- Cercare MAC addresses
- Ottenere informazioni su dispositivi
- Verificare stato interfacce
- Eseguire comandi diagnostici (solo read-only)

Quando usi un tool, spiega sempre perché lo stai usando.`);
  }

  // Add SSH instructions if enabled
  if (options.sshEnabled) {
    parts.push(`
---
ISTRUZIONI SSH:
Puoi eseguire comandi diagnostici sugli switch Huawei via SSH.
REGOLE FONDAMENTALI:
1. SOLO comandi read-only (display, show)
2. MAI comandi di configurazione
3. Spiega sempre il motivo del comando
4. Interpreta l'output per l'utente`);
  }

  return parts.join('\n');
}

// =============================================================================
// CONTEXT EXTRACTORS
// =============================================================================

/**
 * Extract entities from user query
 *
 * @param {string} query - User query
 * @returns {object} Extracted entities
 */
export function extractEntities(query) {
  const entities = {
    macs: [],
    ips: [],
    devices: [],
    vlans: [],
    interfaces: [],
    commands: []
  };

  // MAC address patterns
  const macPatterns = [
    /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/g,  // xx:xx:xx:xx:xx:xx
    /([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}/g,     // xxxx.xxxx.xxxx
    /([0-9a-fA-F]{4}-){2}[0-9a-fA-F]{4}/g       // xxxx-xxxx-xxxx (Huawei)
  ];

  for (const pattern of macPatterns) {
    const matches = query.match(pattern);
    if (matches) {
      entities.macs.push(...matches);
    }
  }

  // IP address pattern
  const ipPattern = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  const ips = query.match(ipPattern);
  if (ips) {
    entities.ips.push(...ips);
  }

  // VLAN numbers
  const vlanPattern = /\bvlan\s*(\d+)\b/gi;
  let vlanMatch;
  while ((vlanMatch = vlanPattern.exec(query)) !== null) {
    entities.vlans.push(parseInt(vlanMatch[1]));
  }

  // Interface names (Huawei format)
  const ifacePattern = /\b(GE|10GE|XGE|Eth-Trunk|GigabitEthernet|XGigabitEthernet)\d+\/\d+\/\d+\b/gi;
  const ifaces = query.match(ifacePattern);
  if (ifaces) {
    entities.interfaces.push(...ifaces);
  }

  // Device names (pattern: XX_XX_Name_NN)
  const devicePattern = /\b\d{2}_[A-Z]\d_[A-Za-z_]+_\d+\b/g;
  const devices = query.match(devicePattern);
  if (devices) {
    entities.devices.push(...devices);
  }

  // CLI commands
  const cmdPattern = /\b(display|show)\s+[\w-]+/gi;
  const cmds = query.match(cmdPattern);
  if (cmds) {
    entities.commands.push(...cmds);
  }

  return entities;
}

/**
 * Detect query intent
 *
 * @param {string} query - User query
 * @returns {string} Query intent
 */
export function detectQueryIntent(query) {
  const lowerQuery = query.toLowerCase();

  // MAC search
  if (/mac|indirizzo|address|dove.*collegato|trova.*dispositivo/i.test(lowerQuery)) {
    return 'mac_search';
  }

  // Device info
  if (/info|dettagli|stato|status|switch|router/i.test(lowerQuery)) {
    return 'device_info';
  }

  // Topology
  if (/topologia|mappa|struttura|connessioni|collegamenti/i.test(lowerQuery)) {
    return 'topology';
  }

  // Troubleshooting
  if (/problema|errore|non funziona|down|aiuto|debug|diagnos/i.test(lowerQuery)) {
    return 'troubleshooting';
  }

  // VLAN
  if (/vlan|segmenta|network/i.test(lowerQuery)) {
    return 'vlan';
  }

  // Interface
  if (/porta|interface|interfaccia|port/i.test(lowerQuery)) {
    return 'interface';
  }

  return 'general';
}

// =============================================================================
// CONVERSATION CONTEXT
// =============================================================================

/**
 * Create a conversation context manager
 */
export function createConversationContext(options = {}) {
  const context = {
    sessionId: options.sessionId || Date.now().toString(),
    messages: [],
    entities: {
      macs: new Set(),
      ips: new Set(),
      devices: new Set()
    },
    lastIntent: null,
    toolCalls: [],
    sshCommands: []
  };

  return {
    /**
     * Add a message to context
     */
    addMessage(role, content) {
      context.messages.push({
        role,
        content,
        timestamp: Date.now()
      });

      // Extract entities from user messages
      if (role === 'user') {
        const extracted = extractEntities(content);
        extracted.macs.forEach(m => context.entities.macs.add(m));
        extracted.ips.forEach(ip => context.entities.ips.add(ip));
        extracted.devices.forEach(d => context.entities.devices.add(d));

        context.lastIntent = detectQueryIntent(content);
      }

      // Keep last 20 messages
      if (context.messages.length > 20) {
        context.messages = context.messages.slice(-20);
      }
    },

    /**
     * Record a tool call
     */
    addToolCall(tool, params, result) {
      context.toolCalls.push({
        tool,
        params,
        result: typeof result === 'string' ? result.substring(0, 500) : result,
        timestamp: Date.now()
      });
    },

    /**
     * Record an SSH command
     */
    addSshCommand(device, command, output) {
      context.sshCommands.push({
        device,
        command,
        output: output?.substring(0, 1000),
        timestamp: Date.now()
      });
    },

    /**
     * Get conversation summary for context injection
     */
    getSummary() {
      return {
        messageCount: context.messages.length,
        entities: {
          macs: [...context.entities.macs],
          ips: [...context.entities.ips],
          devices: [...context.entities.devices]
        },
        lastIntent: context.lastIntent,
        recentToolCalls: context.toolCalls.slice(-5),
        recentSshCommands: context.sshCommands.slice(-3)
      };
    },

    /**
     * Get messages for API call
     */
    getMessages() {
      return context.messages.map(m => ({
        role: m.role,
        content: m.content
      }));
    },

    /**
     * Clear context
     */
    clear() {
      context.messages = [];
      context.entities = { macs: new Set(), ips: new Set(), devices: new Set() };
      context.lastIntent = null;
      context.toolCalls = [];
      context.sshCommands = [];
    }
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  BASE_SYSTEM_PROMPT,
  CONTEXT_TEMPLATES,
  buildContext,
  createSystemPrompt,
  extractEntities,
  detectQueryIntent,
  createConversationContext
};
