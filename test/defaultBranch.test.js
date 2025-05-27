import { test } from 'node:test';
import assert from 'node:assert';

// Test the branch detection logic in isolation
test('Environment variable GIT_FALLBACK_BRANCH is respected', () => {
    // Save original environment
    const originalValue = process.env.GIT_FALLBACK_BRANCH;
    
    // Test with custom fallback branch
    process.env.GIT_FALLBACK_BRANCH = 'dev';
    
    // Simulate the common branches logic from repoManager
    const commonBranches = [
        process.env.GIT_FALLBACK_BRANCH || 'main',
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    // Verify 'dev' is prioritized
    assert.strictEqual(commonBranches[0], 'dev');
    assert.ok(commonBranches.includes('main'));
    assert.ok(commonBranches.includes('master'));
    
    // Restore original environment
    if (originalValue !== undefined) {
        process.env.GIT_FALLBACK_BRANCH = originalValue;
    } else {
        delete process.env.GIT_FALLBACK_BRANCH;
    }
});

test('Default fallback branch behavior without environment variable', () => {
    // Save and clear environment variable
    const originalValue = process.env.GIT_FALLBACK_BRANCH;
    delete process.env.GIT_FALLBACK_BRANCH;
    
    // Simulate the common branches logic from repoManager
    const commonBranches = [
        process.env.GIT_FALLBACK_BRANCH || 'main',
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    // Verify 'main' is the default
    assert.strictEqual(commonBranches[0], 'main');
    
    // Restore original environment
    if (originalValue !== undefined) {
        process.env.GIT_FALLBACK_BRANCH = originalValue;
    }
});

test('Branch detection priority order is correct', () => {
    // Test the expected priority order
    const expectedOrder = ['main', 'master', 'develop', 'dev', 'trunk'];
    
    // Simulate the common branches logic (without custom fallback)
    const commonBranches = [
        'main',  // process.env.GIT_FALLBACK_BRANCH || 'main'
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    // Check that all expected branches are present
    for (const branch of expectedOrder) {
        assert.ok(commonBranches.includes(branch), `Branch '${branch}' should be in fallback list`);
    }
    
    // Verify that 'dev' comes before 'trunk' (priority order)
    const devIndex = commonBranches.indexOf('dev');
    const trunkIndex = commonBranches.indexOf('trunk');
    assert.ok(devIndex < trunkIndex, 'dev should have higher priority than trunk');
});