/**
 * Tool Executor for LLM Council
 *
 * Esegue i tools chiamati dal Council e restituisce i risultati.
 * Integra con NetMap API, NeDi database e SSH executor.
 *
 * @version 1.0.0
 */

import { ALL_TOOLS, validateToolCall, isToolAllowed, recordToolExecution } from './councilTools.js';

// =============================================================================
// TOOL HANDLERS
// =============================================================================

/**
 * Tool handler registry
 * Each handler receives (params, context) and returns result
 */
const toolHandlers = new Map();

/**
 * Register a tool handler
 *
 * @param {string} toolName - Name of the tool
 * @param {Function} handler - Handler function (params, context) => Promise<result>
 */
export function registerToolHandler(toolName, handler) {
  if (!ALL_TOOLS[toolName]) {
    console.warn(`[ToolExecutor] Registering handler for unknown tool: ${toolName}`);
  }
  toolHandlers.set(toolName, handler);
  console.log(`[ToolExecutor] Registered handler for: ${toolName}`);
}

/**
 * Check if a tool has a registered handler
 */
export function hasHandler(toolName) {
  return toolHandlers.has(toolName);
}

// =============================================================================
// EXECUTION
// =============================================================================

/**
 * Execute a tool call
 *
 * @param {string} toolName - Name of the tool
 * @param {object} params - Tool parameters
 * @param {object} context - Execution context
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
export async function executeTool(toolName, params, context = {}) {
  const startTime = Date.now();

  try {
    // Validate tool exists
    if (!ALL_TOOLS[toolName]) {
      return {
        success: false,
        error: `Tool sconosciuto: ${toolName}`,
        duration: Date.now() - startTime
      };
    }

    // Validate parameters
    const validation = validateToolCall(toolName, params);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        duration: Date.now() - startTime
      };
    }

    // Check permissions
    if (context && !isToolAllowed(toolName, context)) {
      return {
        success: false,
        error: `Tool non permesso nel contesto corrente: ${toolName}`,
        duration: Date.now() - startTime
      };
    }

    // Get handler
    const handler = toolHandlers.get(toolName);
    if (!handler) {
      return {
        success: false,
        error: `Nessun handler registrato per: ${toolName}`,
        duration: Date.now() - startTime
      };
    }

    // Execute handler
    console.log(`[ToolExecutor] Executing ${toolName} with params:`, params);
    const result = await handler(params, context);

    // Record execution
    if (context) {
      recordToolExecution(toolName, params, result, context);
    }

    const duration = Date.now() - startTime;
    console.log(`[ToolExecutor] ${toolName} completed in ${duration}ms`);

    return {
      success: true,
      result,
      duration
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ToolExecutor] ${toolName} failed:`, error);

    return {
      success: false,
      error: error.message,
      duration
    };
  }
}

/**
 * Execute multiple tool calls in sequence
 *
 * @param {Array<{name: string, params: object}>} toolCalls - Array of tool calls
 * @param {object} context - Execution context
 * @returns {Promise<Array<{name: string, success: boolean, result?: any, error?: string}>>}
 */
export async function executeToolSequence(toolCalls, context = {}) {
  const results = [];

  for (const call of toolCalls) {
    const result = await executeTool(call.name, call.params, context);
    results.push({
      name: call.name,
      ...result
    });

    // Stop on critical error if configured
    if (!result.success && context.stopOnError) {
      console.log(`[ToolExecutor] Stopping sequence due to error in ${call.name}`);
      break;
    }
  }

  return results;
}

/**
 * Execute multiple tool calls in parallel
 *
 * @param {Array<{name: string, params: object}>} toolCalls - Array of tool calls
 * @param {object} context - Execution context
 * @returns {Promise<Array<{name: string, success: boolean, result?: any, error?: string}>>}
 */
export async function executeToolsParallel(toolCalls, context = {}) {
  const promises = toolCalls.map(call =>
    executeTool(call.name, call.params, context).then(result => ({
      name: call.name,
      ...result
    }))
  );

  return Promise.all(promises);
}

// =============================================================================
// RESULT FORMATTING
// =============================================================================

/**
 * Format tool result for inclusion in LLM context
 *
 * @param {string} toolName - Name of the tool
 * @param {object} result - Execution result
 * @returns {string} Formatted result
 */
export function formatToolResult(toolName, result) {
  if (!result.success) {
    return `[ERRORE ${toolName}]: ${result.error}`;
  }

  const data = result.result;

  // Format based on result type
  if (typeof data === 'string') {
    return `[${toolName}]: ${data}`;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return `[${toolName}]: Nessun risultato trovato`;
    }
    return `[${toolName}]: ${data.length} risultati\n${formatArray(data)}`;
  }

  if (typeof data === 'object') {
    return `[${toolName}]:\n${formatObject(data)}`;
  }

  return `[${toolName}]: ${String(data)}`;
}

/**
 * Format array for display
 */
function formatArray(arr, maxItems = 10) {
  const items = arr.slice(0, maxItems);
  const formatted = items.map((item, i) => {
    if (typeof item === 'object') {
      return `  ${i + 1}. ${JSON.stringify(item)}`;
    }
    return `  ${i + 1}. ${item}`;
  });

  if (arr.length > maxItems) {
    formatted.push(`  ... e altri ${arr.length - maxItems}`);
  }

  return formatted.join('\n');
}

/**
 * Format object for display
 */
function formatObject(obj, indent = '  ') {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`);
      lines.push(formatObject(value, indent + '  '));
    } else if (Array.isArray(value)) {
      lines.push(`${indent}${key}: [${value.length} items]`);
    } else {
      lines.push(`${indent}${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

// =============================================================================
// BUILT-IN HANDLERS (Stubs - to be connected to actual implementations)
// =============================================================================

/**
 * Initialize built-in tool handlers
 * These are stubs that should be connected to actual NetMap implementations
 */
export function initializeBuiltInHandlers(dependencies = {}) {
  const { nediDb, libdb, sshExecutor } = dependencies;

  // search_mac handler
  registerToolHandler('search_mac', async (params, context) => {
    if (!nediDb) {
      throw new Error('NeDi database not configured');
    }

    const { mac, network } = params;
    // This should call the actual MAC search implementation
    // For now, return a stub response
    return {
      found: false,
      mac: mac,
      message: 'MAC search handler not fully implemented'
    };
  });

  // get_device_info handler
  registerToolHandler('get_device_info', async (params, context) => {
    if (!nediDb) {
      throw new Error('NeDi database not configured');
    }

    const { device } = params;
    return {
      device: device,
      message: 'Device info handler not fully implemented'
    };
  });

  // get_device_ports handler
  registerToolHandler('get_device_ports', async (params, context) => {
    const { device, port } = params;
    return {
      device: device,
      port: port,
      message: 'Device ports handler not fully implemented'
    };
  });

  // SSH handlers (require SSH executor)
  if (sshExecutor) {
    registerToolHandler('ssh_execute_diagnostic', async (params, context) => {
      const { device, command, reason } = params;
      // This should validate and execute via sshExecutor
      return {
        device,
        command,
        reason,
        message: 'SSH diagnostic handler not fully implemented'
      };
    });

    registerToolHandler('ssh_get_mac_table', async (params, context) => {
      const { device, vlan, interface: iface } = params;
      return {
        device,
        vlan,
        interface: iface,
        message: 'SSH MAC table handler not fully implemented'
      };
    });
  }

  console.log('[ToolExecutor] Built-in handlers initialized');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  registerToolHandler,
  hasHandler,
  executeTool,
  executeToolSequence,
  executeToolsParallel,
  formatToolResult,
  initializeBuiltInHandlers
};
