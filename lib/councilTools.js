/**
 * Council Tools - Function Calling Infrastructure
 *
 * Definisce i tools disponibili per l'LLM Council e la loro
 * struttura per function calling.
 *
 * @version 1.0.0
 */

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

/**
 * Network-related tools per NetMap
 */
export const NETWORK_TOOLS = {
  search_mac: {
    name: 'search_mac',
    description: 'Cerca un MAC address nella rete per trovare lo switch e la porta dove è collegato il dispositivo',
    parameters: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address da cercare (formato: xx:xx:xx:xx:xx:xx o xxxx.xxxx.xxxx)'
        },
        network: {
          type: 'string',
          description: 'Network/sito specifico dove cercare (opzionale)'
        }
      },
      required: ['mac']
    }
  },

  get_device_info: {
    name: 'get_device_info',
    description: 'Ottiene informazioni dettagliate su uno switch o dispositivo di rete',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP del dispositivo'
        }
      },
      required: ['device']
    }
  },

  get_device_ports: {
    name: 'get_device_ports',
    description: 'Ottiene lo stato delle porte di uno switch',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP dello switch'
        },
        port: {
          type: 'string',
          description: 'Porta specifica (opzionale, es: GE0/0/1)'
        }
      },
      required: ['device']
    }
  },

  get_topology: {
    name: 'get_topology',
    description: 'Ottiene la topologia di rete per un sito o area',
    parameters: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          description: 'ID o nome del sito'
        },
        depth: {
          type: 'number',
          description: 'Profondità della topologia da recuperare (default: 2)'
        }
      },
      required: []
    }
  },

  search_devices: {
    name: 'search_devices',
    description: 'Cerca dispositivi per nome, IP, modello o location',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Termine di ricerca'
        },
        type: {
          type: 'string',
          enum: ['switch', 'router', 'ap', 'all'],
          description: 'Tipo di dispositivo da cercare'
        },
        site: {
          type: 'string',
          description: 'Sito specifico (opzionale)'
        }
      },
      required: ['query']
    }
  }
};

/**
 * SSH diagnostic tools per switch Huawei
 */
export const SSH_TOOLS = {
  ssh_execute_diagnostic: {
    name: 'ssh_execute_diagnostic',
    description: 'Esegue un comando diagnostico read-only su uno switch Huawei via SSH',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP dello switch'
        },
        command: {
          type: 'string',
          description: 'Comando diagnostico da eseguire (es: display mac-address, display interface)'
        },
        reason: {
          type: 'string',
          description: 'Motivo per cui è necessario questo comando'
        }
      },
      required: ['device', 'command', 'reason']
    }
  },

  ssh_get_mac_table: {
    name: 'ssh_get_mac_table',
    description: 'Recupera la tabella MAC di uno switch Huawei',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP dello switch'
        },
        vlan: {
          type: 'number',
          description: 'VLAN specifica (opzionale)'
        },
        interface: {
          type: 'string',
          description: 'Interfaccia specifica (opzionale)'
        }
      },
      required: ['device']
    }
  },

  ssh_get_interface_status: {
    name: 'ssh_get_interface_status',
    description: 'Recupera lo stato delle interfacce di uno switch',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP dello switch'
        },
        interface: {
          type: 'string',
          description: 'Interfaccia specifica (opzionale)'
        }
      },
      required: ['device']
    }
  },

  ssh_get_arp_table: {
    name: 'ssh_get_arp_table',
    description: 'Recupera la tabella ARP di uno switch/router',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP del dispositivo'
        },
        ip: {
          type: 'string',
          description: 'IP specifico da cercare (opzionale)'
        }
      },
      required: ['device']
    }
  },

  ssh_get_lldp_neighbors: {
    name: 'ssh_get_lldp_neighbors',
    description: 'Recupera i neighbor LLDP di uno switch',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Nome o IP dello switch'
        },
        interface: {
          type: 'string',
          description: 'Interfaccia specifica (opzionale)'
        }
      },
      required: ['device']
    }
  },

  ssh_trace_mac_path: {
    name: 'ssh_trace_mac_path',
    description: 'Traccia il percorso di un MAC address attraverso la rete',
    parameters: {
      type: 'object',
      properties: {
        mac: {
          type: 'string',
          description: 'MAC address da tracciare'
        },
        start_device: {
          type: 'string',
          description: 'Switch di partenza (opzionale)'
        }
      },
      required: ['mac']
    }
  }
};

/**
 * Database/Query tools
 */
export const DATABASE_TOOLS = {
  query_nedi: {
    name: 'query_nedi',
    description: 'Esegue una query sul database NeDi per informazioni di rete',
    parameters: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: ['devices', 'interfaces', 'vlans', 'links', 'nodes', 'events'],
          description: 'Tipo di query'
        },
        filters: {
          type: 'object',
          description: 'Filtri per la query'
        },
        limit: {
          type: 'number',
          description: 'Limite risultati (default: 100)'
        }
      },
      required: ['query_type']
    }
  }
};

// =============================================================================
// TOOL REGISTRY
// =============================================================================

/**
 * All available tools
 */
export const ALL_TOOLS = {
  ...NETWORK_TOOLS,
  ...SSH_TOOLS,
  ...DATABASE_TOOLS
};

/**
 * Get tools by category
 */
export function getToolsByCategory(category) {
  switch (category) {
    case 'network':
      return NETWORK_TOOLS;
    case 'ssh':
      return SSH_TOOLS;
    case 'database':
      return DATABASE_TOOLS;
    default:
      return ALL_TOOLS;
  }
}

/**
 * Get tool definitions for OpenAI/Anthropic function calling format
 */
export function getToolDefinitions(toolNames = null) {
  const tools = toolNames
    ? toolNames.map(name => ALL_TOOLS[name]).filter(Boolean)
    : Object.values(ALL_TOOLS);

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * Get tool by name
 */
export function getTool(name) {
  return ALL_TOOLS[name] || null;
}

/**
 * Validate tool call parameters
 */
export function validateToolCall(toolName, params) {
  const tool = ALL_TOOLS[toolName];
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolName}` };
  }

  const required = tool.parameters.required || [];
  const missing = required.filter(param => !(param in params));

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required parameters: ${missing.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Format tools for Claude messages API
 */
export function getClaudeToolFormat(toolNames = null) {
  const tools = toolNames
    ? toolNames.map(name => ALL_TOOLS[name]).filter(Boolean)
    : Object.values(ALL_TOOLS);

  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}

/**
 * Format tools for Gemini
 */
export function getGeminiToolFormat(toolNames = null) {
  const tools = toolNames
    ? toolNames.map(name => ALL_TOOLS[name]).filter(Boolean)
    : Object.values(ALL_TOOLS);

  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }];
}

// =============================================================================
// TOOL EXECUTION CONTEXT
// =============================================================================

/**
 * Create a tool execution context
 */
export function createToolContext(options = {}) {
  return {
    sessionId: options.sessionId || Date.now().toString(),
    userId: options.userId || 'anonymous',
    permissions: options.permissions || ['network', 'database'],
    sshEnabled: options.sshEnabled || false,
    maxExecutions: options.maxExecutions || 10,
    executionCount: 0,
    history: []
  };
}

/**
 * Check if tool is allowed in context
 */
export function isToolAllowed(toolName, context) {
  const tool = ALL_TOOLS[toolName];
  if (!tool) return false;

  // SSH tools require explicit permission
  if (toolName.startsWith('ssh_') && !context.sshEnabled) {
    return false;
  }

  // Check execution limit
  if (context.executionCount >= context.maxExecutions) {
    return false;
  }

  return true;
}

/**
 * Record tool execution
 */
export function recordToolExecution(toolName, params, result, context) {
  context.executionCount++;
  context.history.push({
    tool: toolName,
    params,
    result: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : result,
    timestamp: Date.now()
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  NETWORK_TOOLS,
  SSH_TOOLS,
  DATABASE_TOOLS,
  ALL_TOOLS,
  getToolsByCategory,
  getToolDefinitions,
  getTool,
  validateToolCall,
  getClaudeToolFormat,
  getGeminiToolFormat,
  createToolContext,
  isToolAllowed,
  recordToolExecution
};
