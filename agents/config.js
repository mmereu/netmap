/**
 * AI Agent Configuration
 * Configurazione provider e modelli per evitare dipendenze circolari
 */

// Provider configuration
export const PROVIDERS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini'
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile'
  }
};

// Legge il provider dalla variabile d'ambiente (default: groq)
let currentProvider = process.env.AI_PROVIDER || 'groq';

/**
 * Get current provider name
 */
export function getCurrentProvider() {
  return currentProvider;
}

/**
 * Set current provider (chiamato da initAgents)
 */
export function setCurrentProvider(provider) {
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider: ${provider}. Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  currentProvider = provider;
}

/**
 * Get current provider's default model
 * Questa funzione è usata da tutti gli agenti per ottenere il modello corretto
 */
export function getDefaultModel() {
  return PROVIDERS[currentProvider]?.defaultModel || 'llama-3.3-70b-versatile';
}
