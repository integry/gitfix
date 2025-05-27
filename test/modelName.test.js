import { test } from 'node:test';
import assert from 'node:assert';

// Test the model name extraction logic
function extractModelDisplayName(modelId) {
    if (!modelId || typeof modelId !== 'string') {
        return 'Claude (Unknown Model)';
    }
    
    // Common model patterns and their display names
    const modelMappings = {
        'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
        'claude-3-sonnet': 'Claude 3 Sonnet',
        'claude-3-opus': 'Claude 3 Opus',
        'claude-3-haiku': 'Claude 3 Haiku',
        'claude-2.1': 'Claude 2.1',
        'claude-2.0': 'Claude 2.0',
        'claude-instant': 'Claude Instant'
    };
    
    // Try to match known patterns
    for (const [pattern, displayName] of Object.entries(modelMappings)) {
        if (modelId.toLowerCase().includes(pattern)) {
            return displayName;
        }
    }
    
    // Extract version and model type if available
    const claudeMatch = modelId.match(/claude-(\d+(?:\.\d+)?)-(\w+)/i);
    if (claudeMatch) {
        const version = claudeMatch[1];
        const type = claudeMatch[2].charAt(0).toUpperCase() + claudeMatch[2].slice(1);
        return `Claude ${version} ${type}`;
    }
    
    // Fallback: clean up the model ID for display
    const cleanedId = modelId
        .replace(/^claude-?/i, 'Claude ')
        .replace(/-(\d{8}|\d{4}-\d{2}-\d{2}).*$/, '') // Remove date stamps
        .replace(/-/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase()) // Title case
        .trim(); // Remove any trailing/leading whitespace
    
    return cleanedId || 'Claude (Unknown Model)';
}

test('Model name extraction for Claude 3.5 Sonnet variants', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-3-5-sonnet-20241022'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3-5-sonnet'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('CLAUDE-3-5-SONNET-LATEST'), 
        'Claude 3.5 Sonnet'
    );
});

test('Model name extraction for other Claude models', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-3-opus-20240229'), 
        'Claude 3 Opus'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3-haiku-20240307'), 
        'Claude 3 Haiku'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3-sonnet'), 
        'Claude 3 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-2.1'), 
        'Claude 2.1'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-instant'), 
        'Claude Instant'
    );
});

test('Model name extraction with pattern matching fallback', () => {
    // Test the regex fallback for new model patterns
    assert.strictEqual(
        extractModelDisplayName('claude-4-turbo'), 
        'Claude 4 Turbo'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3.5-nova'), 
        'Claude 3.5 Nova'
    );
});

test('Model name extraction for unknown or malformed inputs', () => {
    assert.strictEqual(
        extractModelDisplayName(''), 
        'Claude (Unknown Model)'
    );
    
    assert.strictEqual(
        extractModelDisplayName(null), 
        'Claude (Unknown Model)'
    );
    
    assert.strictEqual(
        extractModelDisplayName(undefined), 
        'Claude (Unknown Model)'
    );
    
    assert.strictEqual(
        extractModelDisplayName('some-other-model'), 
        'Some Other Model'
    );
});

test('Model name extraction removes timestamps', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-3-5-sonnet-20241022-v2'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-4-nova-2024-12-01'), 
        'Claude 4 Nova'
    );
});

test('Model name extraction handles edge cases', () => {
    // Test with different case variations
    assert.strictEqual(
        extractModelDisplayName('Claude-3-5-Sonnet'), 
        'Claude 3.5 Sonnet'
    );
    
    // Test with minimal Claude identifier
    assert.strictEqual(
        extractModelDisplayName('claude'), 
        'Claude'
    );
});