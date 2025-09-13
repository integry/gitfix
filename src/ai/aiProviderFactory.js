import { OpenAIProvider } from './providers/openaiProvider.js';
import { GeminiProvider } from './providers/geminiProvider.js';
import { executeClaudeCode } from '../claude/claudeService.js';
import { getProviderForModel, resolveModelAlias } from '../config/modelAliases.js';
import logger from '../utils/logger.js';

/**
 * Claude provider wrapper to maintain compatibility with existing code
 */
class ClaudeProviderWrapper {
    constructor() {
        this.providerName = 'claude';
    }

    async executeCode(options) {
        return executeClaudeCode(options);
    }

    async validateConfiguration() {
        // Claude provider validation is handled in claudeService.js
        return true;
    }

    getProviderName() {
        return this.providerName;
    }

    async buildInfrastructure() {
        // Claude infrastructure building is handled in claudeService.js
        const { buildClaudeDockerImage } = await import('../claude/claudeService.js');
        return buildClaudeDockerImage();
    }
}

/**
 * Factory class for creating and managing AI providers
 */
export class AIProviderFactory {
    constructor() {
        this.providers = new Map();
        this.defaultProvider = 'claude';
        
        // Initialize providers
        this.initializeProviders();
    }

    /**
     * Initialize all available AI providers
     */
    initializeProviders() {
        // Claude provider (wrapper for existing service)
        this.providers.set('claude', new ClaudeProviderWrapper());

        // OpenAI provider
        const openaiConfig = {
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL,
            timeout: parseInt(process.env.OPENAI_TIMEOUT_MS || '300000', 10)
        };
        this.providers.set('openai', new OpenAIProvider(openaiConfig));

        // Gemini provider
        const geminiConfig = {
            apiKey: process.env.GOOGLE_AI_API_KEY,
            baseUrl: process.env.GOOGLE_AI_BASE_URL,
            timeout: parseInt(process.env.GEMINI_TIMEOUT_MS || '300000', 10)
        };
        this.providers.set('gemini', new GeminiProvider(geminiConfig));

        logger.info({
            providersInitialized: Array.from(this.providers.keys()),
            defaultProvider: this.defaultProvider
        }, 'AI providers initialized');
    }

    /**
     * Get the appropriate provider for a given model
     * @param {string} modelName - Model name or alias
     * @returns {Object} AI provider instance
     */
    getProviderForModel(modelName) {
        const resolvedModel = resolveModelAlias(modelName);
        const providerName = getProviderForModel(resolvedModel);
        
        const provider = this.providers.get(providerName);
        if (!provider) {
            logger.warn({
                modelName,
                resolvedModel,
                requestedProvider: providerName,
                availableProviders: Array.from(this.providers.keys())
            }, 'Requested provider not available, falling back to default');
            
            return this.providers.get(this.defaultProvider);
        }

        return provider;
    }

    /**
     * Get a specific provider by name
     * @param {string} providerName - Provider name ('claude', 'openai', 'gemini')
     * @returns {Object|null} AI provider instance or null if not found
     */
    getProvider(providerName) {
        return this.providers.get(providerName) || null;
    }

    /**
     * Get all available providers
     * @returns {Array<string>} Array of provider names
     */
    getAvailableProviders() {
        return Array.from(this.providers.keys());
    }

    /**
     * Validate all provider configurations
     * @returns {Promise<Object>} Validation results for each provider
     */
    async validateAllProviders() {
        const results = {};
        
        for (const [name, provider] of this.providers.entries()) {
            try {
                results[name] = {
                    isValid: await provider.validateConfiguration(),
                    error: null
                };
            } catch (error) {
                results[name] = {
                    isValid: false,
                    error: error.message
                };
            }
        }

        logger.info({ validationResults: results }, 'Provider validation completed');
        return results;
    }

    /**
     * Execute AI code analysis for a given model
     * @param {string} modelName - Model name or alias
     * @param {Object} options - Execution options
     * @returns {Promise<Object>} Execution result
     */
    async executeWithModel(modelName, options) {
        const provider = this.getProviderForModel(modelName);
        const resolvedModel = resolveModelAlias(modelName);
        
        logger.info({
            requestedModel: modelName,
            resolvedModel,
            provider: provider.getProviderName(),
            issueNumber: options.issueRef?.number
        }, 'Executing AI code analysis');

        // Add resolved model to options
        const executionOptions = {
            ...options,
            modelName: resolvedModel
        };

        return provider.executeCode(executionOptions);
    }

    /**
     * Build infrastructure for all providers
     * @returns {Promise<Object>} Build results for each provider
     */
    async buildAllInfrastructure() {
        const results = {};
        
        for (const [name, provider] of this.providers.entries()) {
            try {
                logger.info({ provider: name }, 'Building infrastructure for provider');
                results[name] = {
                    success: await provider.buildInfrastructure(),
                    error: null
                };
                
                if (results[name].success) {
                    logger.info({ provider: name }, 'Infrastructure built successfully');
                } else {
                    logger.warn({ provider: name }, 'Infrastructure build failed');
                }
            } catch (error) {
                logger.error({
                    provider: name,
                    error: error.message
                }, 'Infrastructure build error');
                
                results[name] = {
                    success: false,
                    error: error.message
                };
            }
        }

        return results;
    }

    /**
     * Set the default provider
     * @param {string} providerName - Provider name
     */
    setDefaultProvider(providerName) {
        if (this.providers.has(providerName)) {
            this.defaultProvider = providerName;
            logger.info({ defaultProvider: providerName }, 'Default provider updated');
        } else {
            throw new Error(`Provider '${providerName}' not available`);
        }
    }

    /**
     * Get the current default provider
     * @returns {string} Default provider name
     */
    getDefaultProvider() {
        return this.defaultProvider;
    }
}

// Create and export a singleton instance
export const aiProviderFactory = new AIProviderFactory();