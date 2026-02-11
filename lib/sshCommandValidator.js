/**
 * SSH Command Validator for LLM Council
 *
 * Valida i comandi SSH prima dell'esecuzione usando un approccio ibrido:
 * 1. Pattern whitelist/blacklist per comandi noti
 * 2. LLM validation per comandi ambigui
 *
 * SICUREZZA: Solo comandi read-only sono permessi.
 *
 * @version 1.0.0
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Comandi SEMPRE permessi (read-only, diagnostici)
 */
const WHITELIST_PATTERNS = [
  // Display commands (Huawei)
  /^display\s+/i,
  /^dis\s+/i,

  // Show commands (Cisco-style, alcuni Huawei)
  /^show\s+/i,

  // Ping/traceroute
  /^ping\s+/i,
  /^tracert?\s+/i,

  // Specific safe commands
  /^quit$/i,
  /^exit$/i,
  /^return$/i,
  /^screen-length\s+\d+/i,

  // Common diagnostics
  /^dir\s*/i,
  /^pwd$/i,
  /^more\s+/i
];

/**
 * Comandi SEMPRE bloccati (configurazione, distruttivi)
 */
const BLACKLIST_PATTERNS = [
  // Configuration mode
  /^system-view$/i,
  /^sys$/i,
  /^configure\s*/i,
  /^conf\s*/i,

  // Destructive commands
  /^delete\s+/i,
  /^erase\s+/i,
  /^format\s+/i,
  /^reset\s+/i,
  /^reboot$/i,
  /^shutdown$/i,
  /^restart$/i,

  // Configuration changes
  /^interface\s+/i,
  /^int\s+/i,
  /^vlan\s+\d/i,
  /^ip\s+/i,
  /^undo\s+/i,
  /^set\s+/i,
  /^no\s+/i,

  // User management
  /^aaa$/i,
  /^local-user\s+/i,
  /^user-interface\s+/i,

  // File operations (write)
  /^copy\s+/i,
  /^save$/i,
  /^write\s+/i,

  // SNMP configuration
  /^snmp-agent\s+/i,

  // SSH/Telnet config
  /^stelnet\s+/i,
  /^ssh\s+/i,
  /^telnet\s+/i,

  // Debug (can impact performance)
  /^debugging\s+/i,
  /^debug\s+/i,

  // Shell escape
  /^!.*$/,
  /^\$.*$/,
  /^`.*`$/,
  /;\s*$/,  // Command chaining
  /\|.*\|/,  // Pipe injection
  /[&|;`$]/  // Shell metacharacters
];

/**
 * Comandi che richiedono validazione LLM (ambigui)
 */
const AMBIGUOUS_PATTERNS = [
  /^display\s+current-configuration/i,  // Potrebbe esporre password
  /^display\s+saved-configuration/i,
  /^display\s+startup/i,
  /^display\s+license/i,
  /^display\s+snmp/i,
  /^display\s+aaa/i,
  /^display\s+ssh/i,
  /^display\s+user/i
];

// =============================================================================
// VALIDATION RESULTS
// =============================================================================

export const ValidationResult = {
  ALLOWED: 'allowed',
  DENIED: 'denied',
  NEEDS_LLM_CHECK: 'needs_llm_check',
  SANITIZED: 'sanitized'
};

export const DenialReason = {
  BLACKLISTED: 'Command matches blacklist pattern',
  SHELL_INJECTION: 'Potential shell injection detected',
  CONFIGURATION_MODE: 'Configuration commands not allowed',
  DESTRUCTIVE: 'Destructive command not allowed',
  UNKNOWN: 'Command not recognized as safe'
};

// =============================================================================
// VALIDATION FUNCTIONS
// =============================================================================

/**
 * Validate a command using pattern matching
 *
 * @param {string} command - Command to validate
 * @returns {object} Validation result
 */
export function validateCommand(command) {
  // Normalize command
  const normalizedCmd = command.trim();

  if (!normalizedCmd) {
    return {
      status: ValidationResult.DENIED,
      reason: 'Empty command',
      command: normalizedCmd
    };
  }

  // Check blacklist first (security)
  for (const pattern of BLACKLIST_PATTERNS) {
    if (pattern.test(normalizedCmd)) {
      return {
        status: ValidationResult.DENIED,
        reason: DenialReason.BLACKLISTED,
        pattern: pattern.toString(),
        command: normalizedCmd
      };
    }
  }

  // Check for shell injection attempts
  if (hasShellInjection(normalizedCmd)) {
    return {
      status: ValidationResult.DENIED,
      reason: DenialReason.SHELL_INJECTION,
      command: normalizedCmd
    };
  }

  // Check whitelist
  for (const pattern of WHITELIST_PATTERNS) {
    if (pattern.test(normalizedCmd)) {
      // Check if it's also ambiguous
      for (const ambiguous of AMBIGUOUS_PATTERNS) {
        if (ambiguous.test(normalizedCmd)) {
          return {
            status: ValidationResult.NEEDS_LLM_CHECK,
            reason: 'Command may expose sensitive information',
            command: normalizedCmd
          };
        }
      }

      return {
        status: ValidationResult.ALLOWED,
        command: normalizedCmd
      };
    }
  }

  // Unknown command - needs LLM check or deny
  return {
    status: ValidationResult.NEEDS_LLM_CHECK,
    reason: 'Command not in whitelist, requires LLM validation',
    command: normalizedCmd
  };
}

/**
 * Check for shell injection patterns
 */
function hasShellInjection(command) {
  const injectionPatterns = [
    /[;&|`$]/,           // Shell metacharacters
    /\$\(/,              // Command substitution
    /`[^`]+`/,           // Backtick command substitution
    />\s*\//,            // Redirect to file
    /<\s*\//,            // Read from file
    /\|\s*\w+/,          // Pipe to another command (suspicious)
    /\n|\r/,             // Newline injection
    /\\x[0-9a-f]{2}/i,   // Hex escape
    /%[0-9a-f]{2}/i      // URL encoding
  ];

  return injectionPatterns.some(p => p.test(command));
}

/**
 * Sanitize a command (remove potentially dangerous parts)
 *
 * @param {string} command - Command to sanitize
 * @returns {object} Sanitization result
 */
export function sanitizeCommand(command) {
  let sanitized = command.trim();
  const changes = [];

  // Remove shell metacharacters
  const original = sanitized;
  sanitized = sanitized.replace(/[;&|`$]/g, '');
  if (sanitized !== original) {
    changes.push('Removed shell metacharacters');
  }

  // Remove redirects
  sanitized = sanitized.replace(/[<>]\s*\S+/g, '');
  if (sanitized !== original) {
    changes.push('Removed redirects');
  }

  // Remove newlines
  sanitized = sanitized.replace(/[\r\n]/g, ' ').trim();

  // Collapse multiple spaces
  sanitized = sanitized.replace(/\s+/g, ' ');

  return {
    original: command,
    sanitized: sanitized,
    changes: changes,
    wasModified: changes.length > 0
  };
}

/**
 * Validate a command with LLM assistance
 *
 * @param {string} command - Command to validate
 * @param {Function} llmQuery - Function to query LLM
 * @returns {Promise<object>} Validation result
 */
export async function validateWithLLM(command, llmQuery) {
  // First do pattern validation
  const patternResult = validateCommand(command);

  if (patternResult.status === ValidationResult.DENIED) {
    return patternResult;
  }

  if (patternResult.status === ValidationResult.ALLOWED) {
    return patternResult;
  }

  // Need LLM validation
  try {
    const prompt = `Sei un esperto di sicurezza di rete. Analizza questo comando CLI per switch Huawei:

COMANDO: ${command}

Rispondi SOLO con un JSON valido in questo formato:
{
  "safe": true/false,
  "reason": "breve spiegazione",
  "category": "diagnostic|informational|configuration|destructive|unknown"
}

REGOLE:
- "safe": true SOLO per comandi read-only che non modificano configurazione
- Comandi "display" sono generalmente safe
- Comandi che mostrano password/secrets NON sono safe
- Comandi di configurazione NON sono safe`;

    const response = await llmQuery(prompt);

    // Parse LLM response
    let llmResult;
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        llmResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('[Validator] LLM response parse error:', parseError);
      // Default to deny on parse error
      return {
        status: ValidationResult.DENIED,
        reason: 'Could not parse LLM validation response',
        llmResponse: response,
        command
      };
    }

    if (llmResult.safe === true && llmResult.category !== 'configuration' && llmResult.category !== 'destructive') {
      return {
        status: ValidationResult.ALLOWED,
        reason: llmResult.reason,
        category: llmResult.category,
        validatedBy: 'llm',
        command
      };
    } else {
      return {
        status: ValidationResult.DENIED,
        reason: llmResult.reason || 'LLM determined command is not safe',
        category: llmResult.category,
        validatedBy: 'llm',
        command
      };
    }

  } catch (error) {
    console.error('[Validator] LLM validation error:', error);
    // Default to deny on error
    return {
      status: ValidationResult.DENIED,
      reason: 'LLM validation failed: ' + error.message,
      command
    };
  }
}

// =============================================================================
// BATCH VALIDATION
// =============================================================================

/**
 * Validate multiple commands
 *
 * @param {string[]} commands - Commands to validate
 * @returns {object[]} Validation results
 */
export function validateCommands(commands) {
  return commands.map(cmd => validateCommand(cmd));
}

/**
 * Filter only allowed commands from a list
 *
 * @param {string[]} commands - Commands to filter
 * @returns {string[]} Only allowed commands
 */
export function filterAllowedCommands(commands) {
  return commands
    .map(cmd => validateCommand(cmd))
    .filter(result => result.status === ValidationResult.ALLOWED)
    .map(result => result.command);
}

// =============================================================================
// COMMAND SUGGESTIONS
// =============================================================================

/**
 * Suggest safe alternatives for a denied command
 *
 * @param {string} deniedCommand - Command that was denied
 * @returns {string[]} Safe alternatives
 */
export function suggestAlternatives(deniedCommand) {
  const lower = deniedCommand.toLowerCase();
  const suggestions = [];

  // Configuration view alternatives
  if (lower.includes('current-configuration')) {
    suggestions.push('display this');
    suggestions.push('display interface brief');
    suggestions.push('display vlan');
  }

  // User info alternatives
  if (lower.includes('user') || lower.includes('aaa')) {
    suggestions.push('display users');
    suggestions.push('display user-interface');
  }

  // Interface config alternatives
  if (lower.includes('interface') && !lower.startsWith('display')) {
    suggestions.push('display interface ' + lower.replace(/interface\s*/i, ''));
    suggestions.push('display interface brief');
  }

  // VLAN config alternatives
  if (/^vlan\s+\d/i.test(lower)) {
    suggestions.push('display vlan');
    suggestions.push('display vlan all');
  }

  return suggestions;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  validateCommand,
  validateCommands,
  validateWithLLM,
  sanitizeCommand,
  filterAllowedCommands,
  suggestAlternatives,
  ValidationResult,
  DenialReason,
  WHITELIST_PATTERNS,
  BLACKLIST_PATTERNS
};
