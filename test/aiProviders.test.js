import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { 
    resolveModelAlias, 
    getProviderForModel, 
    getModelsByProvider,
    getAliasesForModel,
    isModelSupported,
    MODEL_ALIASES 
} from '../src/config/modelAliases.js';
import { AIProviderFactory } from '../src/ai/aiProviderFactory.js';

describe('Model Aliases and Provider Detection', () => {
    describe('resolveModelAlias', () => {
        test('should resolve Claude aliases correctly', () => {
            expect(resolveModelAlias('opus')).toBe('claude-opus-4-20250514');
            expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-4-20250514');
            expect(resolveModelAlias('haiku')).toBe('claude-3-5-haiku-20241022');
        });

        test('should resolve OpenAI aliases correctly', () => {
            expect(resolveModelAlias('gpt4')).toBe('gpt-4o');
            expect(resolveModelAlias('gpt4o-mini')).toBe('gpt-4o-mini');
            expect(resolveModelAlias('gpt35')).toBe('gpt-3.5-turbo');
            expect(resolveModelAlias('chatgpt')).toBe('gpt-3.5-turbo');
        });

        test('should resolve Gemini aliases correctly', () => {
            expect(resolveModelAlias('gemini')).toBe('gemini-1.5-pro');
            expect(resolveModelAlias('gemini-flash')).toBe('gemini-1.5-flash');
            expect(resolveModelAlias('gemini10')).toBe('gemini-1.0-pro');
        });

        test('should return original name for unknown aliases', () => {
            expect(resolveModelAlias('unknown-model')).toBe('unknown-model');
            expect(resolveModelAlias('gpt-5')).toBe('gpt-5');
        });

        test('should return default model when no input provided', () => {
            expect(resolveModelAlias('')).toBe('claude-sonnet-4-20250514');
            expect(resolveModelAlias(null)).toBe('claude-sonnet-4-20250514');
            expect(resolveModelAlias(undefined)).toBe('claude-sonnet-4-20250514');
        });
    });

    describe('getProviderForModel', () => {
        test('should detect Claude provider for Claude models', () => {
            expect(getProviderForModel('claude-opus-4-20250514')).toBe('claude');
            expect(getProviderForModel('claude-sonnet-4-20250514')).toBe('claude');
            expect(getProviderForModel('opus')).toBe('claude'); // Should resolve alias first
        });

        test('should detect OpenAI provider for GPT models', () => {
            expect(getProviderForModel('gpt-4o')).toBe('openai');
            expect(getProviderForModel('gpt-3.5-turbo')).toBe('openai');
            expect(getProviderForModel('gpt4')).toBe('openai'); // Should resolve alias first
        });

        test('should detect Gemini provider for Gemini models', () => {
            expect(getProviderForModel('gemini-1.5-pro')).toBe('gemini');
            expect(getProviderForModel('gemini-1.5-flash')).toBe('gemini');
            expect(getProviderForModel('gemini')).toBe('gemini'); // Should resolve alias first
        });

        test('should default to claude for unknown models', () => {
            expect(getProviderForModel('unknown-model')).toBe('claude');
            expect(getProviderForModel('llama-2')).toBe('claude');
        });
    });

    describe('getModelsByProvider', () => {
        test('should return Claude models', () => {
            const claudeModels = getModelsByProvider('claude');
            expect(claudeModels).toContain('claude-opus-4-20250514');
            expect(claudeModels).toContain('claude-sonnet-4-20250514');
            expect(claudeModels).toContain('claude-3-5-haiku-20241022');
            expect(claudeModels.every(model => model.startsWith('claude-'))).toBe(true);
        });

        test('should return OpenAI models', () => {
            const openaiModels = getModelsByProvider('openai');
            expect(openaiModels).toContain('gpt-4o');
            expect(openaiModels).toContain('gpt-3.5-turbo');
            expect(openaiModels.every(model => model.startsWith('gpt-'))).toBe(true);
        });

        test('should return Gemini models', () => {
            const geminiModels = getModelsByProvider('gemini');
            expect(geminiModels).toContain('gemini-1.5-pro');
            expect(geminiModels).toContain('gemini-1.5-flash');
            expect(geminiModels.every(model => model.startsWith('gemini-'))).toBe(true);
        });

        test('should return empty array for unknown provider', () => {
            expect(getModelsByProvider('unknown')).toEqual([]);
        });
    });

    describe('getAliasesForModel', () => {
        test('should return aliases for Claude models', () => {
            const opusAliases = getAliasesForModel('claude-opus-4-20250514');
            expect(opusAliases).toContain('opus');
            expect(opusAliases).toContain('opus4');
            expect(opusAliases).toContain('opus-4-0');
        });

        test('should return aliases for OpenAI models', () => {
            const gpt4Aliases = getAliasesForModel('gpt-4o');
            expect(gpt4Aliases).toContain('gpt4');
            expect(gpt4Aliases).toContain('gpt4o');
        });

        test('should return aliases for Gemini models', () => {
            const geminiAliases = getAliasesForModel('gemini-1.5-pro');
            expect(geminiAliases).toContain('gemini');
            expect(geminiAliases).toContain('gemini-pro');
            expect(geminiAliases).toContain('gemini15');
        });

        test('should return empty array for models without aliases', () => {
            expect(getAliasesForModel('unknown-model')).toEqual([]);
        });
    });

    describe('isModelSupported', () => {
        test('should return true for supported models', () => {
            expect(isModelSupported('opus')).toBe(true);
            expect(isModelSupported('gpt4')).toBe(true);
            expect(isModelSupported('gemini')).toBe(true);
            expect(isModelSupported('claude-sonnet-4-20250514')).toBe(true);
            expect(isModelSupported('gpt-4o')).toBe(true);
            expect(isModelSupported('gemini-1.5-pro')).toBe(true);
        });

        test('should return true for unknown models (defaults to claude)', () => {
            // Unknown models default to claude provider, which is supported
            expect(isModelSupported('unknown-model')).toBe(true);
            expect(isModelSupported('llama-2')).toBe(true);
        });
    });
});

describe('AI Provider Factory', () => {
    let factory;

    beforeEach(() => {
        // Mock environment variables
        process.env.OPENAI_API_KEY = 'test-openai-key';
        process.env.GOOGLE_AI_API_KEY = 'test-gemini-key';
        
        factory = new AIProviderFactory();
    });

    afterEach(() => {
        // Clean up environment variables
        delete process.env.OPENAI_API_KEY;
        delete process.env.GOOGLE_AI_API_KEY;
    });

    describe('Provider Management', () => {
        test('should initialize all providers', () => {
            const availableProviders = factory.getAvailableProviders();
            expect(availableProviders).toContain('claude');
            expect(availableProviders).toContain('openai');
            expect(availableProviders).toContain('gemini');
        });

        test('should return correct provider for models', () => {
            const claudeProvider = factory.getProviderForModel('opus');
            expect(claudeProvider.getProviderName()).toBe('claude');

            const openaiProvider = factory.getProviderForModel('gpt4');
            expect(openaiProvider.providerName).toBe('openai');

            const geminiProvider = factory.getProviderForModel('gemini');
            expect(geminiProvider.providerName).toBe('gemini');
        });

        test('should return specific provider by name', () => {
            const claudeProvider = factory.getProvider('claude');
            expect(claudeProvider).toBeTruthy();
            expect(claudeProvider.getProviderName()).toBe('claude');

            const openaiProvider = factory.getProvider('openai');
            expect(openaiProvider).toBeTruthy();
            expect(openaiProvider.providerName).toBe('openai');

            const geminiProvider = factory.getProvider('gemini');
            expect(geminiProvider).toBeTruthy();
            expect(geminiProvider.providerName).toBe('gemini');
        });

        test('should return null for unknown provider', () => {
            expect(factory.getProvider('unknown')).toBeNull();
        });

        test('should fallback to default provider for unknown models', () => {
            const provider = factory.getProviderForModel('unknown-model');
            expect(provider.getProviderName()).toBe('claude'); // Default provider
        });
    });

    describe('Default Provider Management', () => {
        test('should have claude as default provider', () => {
            expect(factory.getDefaultProvider()).toBe('claude');
        });

        test('should allow changing default provider', () => {
            factory.setDefaultProvider('openai');
            expect(factory.getDefaultProvider()).toBe('openai');
        });

        test('should throw error when setting invalid default provider', () => {
            expect(() => {
                factory.setDefaultProvider('unknown');
            }).toThrow("Provider 'unknown' not available");
        });
    });

    describe('Provider Validation', () => {
        test('should validate provider configurations', async () => {
            // Mock the validation methods
            const claudeProvider = factory.getProvider('claude');
            const openaiProvider = factory.getProvider('openai');
            const geminiProvider = factory.getProvider('gemini');

            claudeProvider.validateConfiguration = jest.fn().mockResolvedValue(true);
            openaiProvider.validateConfiguration = jest.fn().mockResolvedValue(false);
            geminiProvider.validateConfiguration = jest.fn().mockResolvedValue(true);

            const results = await factory.validateAllProviders();

            expect(results.claude.isValid).toBe(true);
            expect(results.openai.isValid).toBe(false);
            expect(results.gemini.isValid).toBe(true);
        });

        test('should handle validation errors', async () => {
            const claudeProvider = factory.getProvider('claude');
            claudeProvider.validateConfiguration = jest.fn().mockRejectedValue(new Error('Validation failed'));

            const results = await factory.validateAllProviders();

            expect(results.claude.isValid).toBe(false);
            expect(results.claude.error).toBe('Validation failed');
        });
    });
});