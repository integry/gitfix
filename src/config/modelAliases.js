const MODEL_ALIASES = {
    // Claude models (Anthropic)
    'opus': 'claude-opus-4-20250514',           // Claude Opus 4
    'opus4': 'claude-opus-4-20250514',          // Claude Opus 4
    'opus-4-0': 'claude-opus-4-20250514',       // Official alias
    'sonnet': 'claude-sonnet-4-20250514',       // Claude Sonnet 4 (default)
    'sonnet4': 'claude-sonnet-4-20250514',      // Claude Sonnet 4
    'sonnet-4-0': 'claude-sonnet-4-20250514',   // Official alias
    'sonnet37': 'claude-3-7-sonnet-20250219',   // Claude Sonnet 3.7
    'sonnet35': 'claude-3-5-sonnet-20241022',   // Claude Sonnet 3.5
    'haiku': 'claude-3-5-haiku-20241022',       // Claude Haiku 3.5
    'haiku35': 'claude-3-5-haiku-20241022',     // Claude Haiku 3.5
    'haiku3': 'claude-3-haiku-20240307',        // Claude Haiku 3
    
    // Official Claude aliases from documentation
    'claude-opus-4-0': 'claude-opus-4-20250514',
    'claude-sonnet-4-0': 'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
    
    // Legacy Claude aliases for backward compatibility
    'claude-3-opus': 'claude-3-opus-20240229',
    'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
    'claude-3-haiku': 'claude-3-haiku-20240307',
    'claude-3-sonnet': 'claude-3-sonnet-20240229',
    
    // OpenAI models
    'gpt4': 'gpt-4o',                           // GPT-4 Omni (latest)
    'gpt4o': 'gpt-4o',                          // GPT-4 Omni
    'gpt4o-mini': 'gpt-4o-mini',                // GPT-4 Omni Mini
    'gpt4-turbo': 'gpt-4-turbo',                // GPT-4 Turbo
    'gpt4-classic': 'gpt-4',                    // GPT-4 Classic
    'gpt35': 'gpt-3.5-turbo',                   // GPT-3.5 Turbo
    'gpt3.5': 'gpt-3.5-turbo',                  // GPT-3.5 Turbo
    'chatgpt': 'gpt-3.5-turbo',                 // Alias for ChatGPT
    
    // Google Gemini models
    'gemini': 'gemini-1.5-pro',                 // Gemini 1.5 Pro (default)
    'gemini-pro': 'gemini-1.5-pro',             // Gemini 1.5 Pro
    'gemini15': 'gemini-1.5-pro',               // Gemini 1.5 Pro
    'gemini-flash': 'gemini-1.5-flash',         // Gemini 1.5 Flash
    'gemini15-flash': 'gemini-1.5-flash',       // Gemini 1.5 Flash
    'gemini-legacy': 'gemini-1.0-pro',          // Gemini 1.0 Pro
    'gemini10': 'gemini-1.0-pro'                // Gemini 1.0 Pro
};

// Default model to use when none specified
const DEFAULT_MODEL_ALIAS = 'sonnet';

// Provider detection patterns
const PROVIDER_PATTERNS = {
    claude: /^claude-/,
    openai: /^gpt-/,
    gemini: /^gemini-/
};

function resolveModelAlias(modelNameOrAlias) {
    if (!modelNameOrAlias) {
        return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
    }
    
    // Check if it's an alias
    const lowerCaseModel = modelNameOrAlias.toLowerCase();
    if (MODEL_ALIASES[lowerCaseModel]) {
        return MODEL_ALIASES[lowerCaseModel];
    }
    
    // If it's not an alias, return as-is (might be a full model ID)
    return modelNameOrAlias;
}

function getDefaultModel() {
    return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
}

/**
 * Determines which AI provider should be used for a given model
 * @param {string} modelName - The model name (resolved or alias)
 * @returns {string} Provider name ('claude', 'openai', 'gemini')
 */
function getProviderForModel(modelName) {
    const resolvedModel = resolveModelAlias(modelName);
    
    // Check against provider patterns
    for (const [provider, pattern] of Object.entries(PROVIDER_PATTERNS)) {
        if (pattern.test(resolvedModel)) {
            return provider;
        }
    }
    
    // Default to claude for backward compatibility
    return 'claude';
}

/**
 * Gets all models supported by a specific provider
 * @param {string} providerName - Provider name ('claude', 'openai', 'gemini')
 * @returns {Array<string>} Array of model names for the provider
 */
function getModelsByProvider(providerName) {
    const pattern = PROVIDER_PATTERNS[providerName];
    if (!pattern) {
        return [];
    }
    
    const models = new Set();
    
    // Add models from aliases
    for (const [alias, modelName] of Object.entries(MODEL_ALIASES)) {
        if (pattern.test(modelName)) {
            models.add(modelName);
        }
    }
    
    return Array.from(models).sort();
}

/**
 * Gets all aliases for a specific model
 * @param {string} modelName - The full model name
 * @returns {Array<string>} Array of aliases for the model
 */
function getAliasesForModel(modelName) {
    const aliases = [];
    for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
        if (model === modelName) {
            aliases.push(alias);
        }
    }
    return aliases.sort();
}

/**
 * Checks if a model is supported by the system
 * @param {string} modelName - Model name to check
 * @returns {boolean} True if model is supported
 */
function isModelSupported(modelName) {
    const resolvedModel = resolveModelAlias(modelName);
    const provider = getProviderForModel(resolvedModel);
    
    // Check if we have a known provider for this model
    return Object.keys(PROVIDER_PATTERNS).includes(provider);
}

export {
    MODEL_ALIASES,
    DEFAULT_MODEL_ALIAS,
    PROVIDER_PATTERNS,
    resolveModelAlias,
    getDefaultModel,
    getProviderForModel,
    getModelsByProvider,
    getAliasesForModel,
    isModelSupported
};