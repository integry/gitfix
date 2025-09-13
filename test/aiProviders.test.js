import { test } from 'node:test';
import assert from 'node:assert';
import { 
    resolveModelAlias, 
    getProviderForModel, 
    getModelsByProvider,
    getAliasesForModel,
    isModelSupported,
    MODEL_ALIASES 
} from '../src/config/modelAliases.js';
import { AIProviderFactory } from '../src/ai/aiProviderFactory.js';

test('Model Aliases and Provider Detection', async (t) => {
    await t.test('resolveModelAlias - should resolve Claude aliases correctly', () => {
        assert.strictEqual(resolveModelAlias('opus'), 'claude-opus-4-20250514');
        assert.strictEqual(resolveModelAlias('sonnet'), 'claude-sonnet-4-20250514');
        assert.strictEqual(resolveModelAlias('haiku'), 'claude-3-5-haiku-20241022');
    });

    await t.test('resolveModelAlias - should resolve OpenAI aliases correctly', () => {
        assert.strictEqual(resolveModelAlias('gpt4'), 'gpt-4o');
        assert.strictEqual(resolveModelAlias('gpt4o-mini'), 'gpt-4o-mini');
        assert.strictEqual(resolveModelAlias('gpt35'), 'gpt-3.5-turbo');
        assert.strictEqual(resolveModelAlias('chatgpt'), 'gpt-3.5-turbo');
    });

    await t.test('resolveModelAlias - should resolve Gemini aliases correctly', () => {
        assert.strictEqual(resolveModelAlias('gemini'), 'gemini-1.5-pro');
        assert.strictEqual(resolveModelAlias('gemini-flash'), 'gemini-1.5-flash');
        assert.strictEqual(resolveModelAlias('gemini10'), 'gemini-1.0-pro');
    });

    await t.test('resolveModelAlias - should return original name for unknown aliases', () => {
        assert.strictEqual(resolveModelAlias('unknown-model'), 'unknown-model');
        assert.strictEqual(resolveModelAlias('gpt-5'), 'gpt-5');
    });

    await t.test('resolveModelAlias - should return default model when no input provided', () => {
        assert.strictEqual(resolveModelAlias(''), 'claude-sonnet-4-20250514');
        assert.strictEqual(resolveModelAlias(null), 'claude-sonnet-4-20250514');
        assert.strictEqual(resolveModelAlias(undefined), 'claude-sonnet-4-20250514');
    });

    await t.test('getProviderForModel - should detect Claude provider for Claude models', () => {
        assert.strictEqual(getProviderForModel('claude-opus-4-20250514'), 'claude');
        assert.strictEqual(getProviderForModel('claude-sonnet-4-20250514'), 'claude');
        assert.strictEqual(getProviderForModel('opus'), 'claude'); // Should resolve alias first
    });

    await t.test('getProviderForModel - should detect OpenAI provider for GPT models', () => {
        assert.strictEqual(getProviderForModel('gpt-4o'), 'openai');
        assert.strictEqual(getProviderForModel('gpt-3.5-turbo'), 'openai');
        assert.strictEqual(getProviderForModel('gpt4'), 'openai'); // Should resolve alias first
    });

    await t.test('getProviderForModel - should detect Gemini provider for Gemini models', () => {
        assert.strictEqual(getProviderForModel('gemini-1.5-pro'), 'gemini');
        assert.strictEqual(getProviderForModel('gemini-1.5-flash'), 'gemini');
        assert.strictEqual(getProviderForModel('gemini'), 'gemini'); // Should resolve alias first
    });

    await t.test('getProviderForModel - should default to claude for unknown models', () => {
        assert.strictEqual(getProviderForModel('unknown-model'), 'claude');
        assert.strictEqual(getProviderForModel('llama-2'), 'claude');
    });

    await t.test('getModelsByProvider - should return Claude models', () => {
        const claudeModels = getModelsByProvider('claude');
        assert.ok(claudeModels.includes('claude-opus-4-20250514'));
        assert.ok(claudeModels.includes('claude-sonnet-4-20250514'));
        assert.ok(claudeModels.includes('claude-3-5-haiku-20241022'));
        assert.ok(claudeModels.every(model => model.startsWith('claude-')));
    });

    await t.test('getModelsByProvider - should return OpenAI models', () => {
        const openaiModels = getModelsByProvider('openai');
        assert.ok(openaiModels.includes('gpt-4o'));
        assert.ok(openaiModels.includes('gpt-3.5-turbo'));
        assert.ok(openaiModels.every(model => model.startsWith('gpt-')));
    });

    await t.test('getModelsByProvider - should return Gemini models', () => {
        const geminiModels = getModelsByProvider('gemini');
        assert.ok(geminiModels.includes('gemini-1.5-pro'));
        assert.ok(geminiModels.includes('gemini-1.5-flash'));
        assert.ok(geminiModels.every(model => model.startsWith('gemini-')));
    });

    await t.test('getModelsByProvider - should return empty array for unknown provider', () => {
        assert.deepStrictEqual(getModelsByProvider('unknown'), []);
    });

    await t.test('getAliasesForModel - should return aliases for Claude models', () => {
        const opusAliases = getAliasesForModel('claude-opus-4-20250514');
        assert.ok(opusAliases.includes('opus'));
        assert.ok(opusAliases.includes('opus4'));
        assert.ok(opusAliases.includes('opus-4-0'));
    });

    await t.test('getAliasesForModel - should return aliases for OpenAI models', () => {
        const gpt4Aliases = getAliasesForModel('gpt-4o');
        assert.ok(gpt4Aliases.includes('gpt4'));
        assert.ok(gpt4Aliases.includes('gpt4o'));
    });

    await t.test('getAliasesForModel - should return aliases for Gemini models', () => {
        const geminiAliases = getAliasesForModel('gemini-1.5-pro');
        assert.ok(geminiAliases.includes('gemini'));
        assert.ok(geminiAliases.includes('gemini-pro'));
        assert.ok(geminiAliases.includes('gemini15'));
    });

    await t.test('getAliasesForModel - should return empty array for models without aliases', () => {
        assert.deepStrictEqual(getAliasesForModel('unknown-model'), []);
    });

    await t.test('isModelSupported - should return true for supported models', () => {
        assert.strictEqual(isModelSupported('opus'), true);
        assert.strictEqual(isModelSupported('gpt4'), true);
        assert.strictEqual(isModelSupported('gemini'), true);
        assert.strictEqual(isModelSupported('claude-sonnet-4-20250514'), true);
        assert.strictEqual(isModelSupported('gpt-4o'), true);
        assert.strictEqual(isModelSupported('gemini-1.5-pro'), true);
    });

    await t.test('isModelSupported - should return true for unknown models (defaults to claude)', () => {
        // Unknown models default to claude provider, which is supported
        assert.strictEqual(isModelSupported('unknown-model'), true);
        assert.strictEqual(isModelSupported('llama-2'), true);
    });
});

test('AI Provider Factory', async (t) => {
    let factory;

    // Set up test environment variables
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.GOOGLE_AI_API_KEY = 'test-gemini-key';

    await t.test('should initialize all providers', () => {
        factory = new AIProviderFactory();
        const availableProviders = factory.getAvailableProviders();
        assert.ok(availableProviders.includes('claude'));
        assert.ok(availableProviders.includes('openai'));
        assert.ok(availableProviders.includes('gemini'));
    });

    await t.test('should return correct provider for models', () => {
        factory = new AIProviderFactory();
        const claudeProvider = factory.getProviderForModel('opus');
        assert.strictEqual(claudeProvider.getProviderName(), 'claude');

        const openaiProvider = factory.getProviderForModel('gpt4');
        assert.strictEqual(openaiProvider.providerName, 'openai');

        const geminiProvider = factory.getProviderForModel('gemini');
        assert.strictEqual(geminiProvider.providerName, 'gemini');
    });

    await t.test('should return specific provider by name', () => {
        factory = new AIProviderFactory();
        const claudeProvider = factory.getProvider('claude');
        assert.ok(claudeProvider);
        assert.strictEqual(claudeProvider.getProviderName(), 'claude');

        const openaiProvider = factory.getProvider('openai');
        assert.ok(openaiProvider);
        assert.strictEqual(openaiProvider.providerName, 'openai');

        const geminiProvider = factory.getProvider('gemini');
        assert.ok(geminiProvider);
        assert.strictEqual(geminiProvider.providerName, 'gemini');
    });

    await t.test('should return null for unknown provider', () => {
        factory = new AIProviderFactory();
        assert.strictEqual(factory.getProvider('unknown'), null);
    });

    await t.test('should fallback to default provider for unknown models', () => {
        factory = new AIProviderFactory();
        const provider = factory.getProviderForModel('unknown-model');
        assert.strictEqual(provider.getProviderName(), 'claude'); // Default provider
    });

    await t.test('should have claude as default provider', () => {
        factory = new AIProviderFactory();
        assert.strictEqual(factory.getDefaultProvider(), 'claude');
    });

    await t.test('should allow changing default provider', () => {
        factory = new AIProviderFactory();
        factory.setDefaultProvider('openai');
        assert.strictEqual(factory.getDefaultProvider(), 'openai');
    });

    await t.test('should throw error when setting invalid default provider', () => {
        factory = new AIProviderFactory();
        assert.throws(() => {
            factory.setDefaultProvider('unknown');
        }, {
            message: "Provider 'unknown' not available"
        });
    });

    // Clean up environment variables
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
});