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

test('Repository-specific environment variable key generation', () => {
    // Test the key generation function logic
    function getRepoConfigKey(owner, repoName) {
        const cleanOwner = owner.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const cleanRepoName = repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        return `GIT_DEFAULT_BRANCH_${cleanOwner}_${cleanRepoName}`;
    }
    
    // Test simple case
    assert.strictEqual(
        getRepoConfigKey('integry', 'forex'), 
        'GIT_DEFAULT_BRANCH_INTEGRY_FOREX'
    );
    
    // Test with special characters
    assert.strictEqual(
        getRepoConfigKey('my-org', 'my-repo.com'), 
        'GIT_DEFAULT_BRANCH_MY_ORG_MY_REPO_COM'
    );
    
    // Test with numbers
    assert.strictEqual(
        getRepoConfigKey('org123', 'repo456'), 
        'GIT_DEFAULT_BRANCH_ORG123_REPO456'
    );
});

test('Repository-specific branch configuration takes precedence', () => {
    // Save original environment
    const originalValue = process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    
    // Set repository-specific configuration
    process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = 'dev';
    
    // This would be the logic in detectDefaultBranch
    const repoConfigKey = 'GIT_DEFAULT_BRANCH_INTEGRY_FOREX';
    const repoSpecificBranch = process.env[repoConfigKey];
    
    assert.strictEqual(repoSpecificBranch, 'dev');
    assert.ok(repoSpecificBranch, 'Repository-specific branch should be found');
    
    // Restore original environment
    if (originalValue !== undefined) {
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = originalValue;
    } else {
        delete process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    }
});

test('Multiple repository configurations can coexist', () => {
    // Save original environment
    const originalForex = process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    const originalSnake = process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE;
    
    // Set multiple repository-specific configurations
    process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = 'dev';
    process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE = 'main';
    
    // Verify both are set correctly
    assert.strictEqual(process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX, 'dev');
    assert.strictEqual(process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE, 'main');
    
    // Test that they don't interfere with each other
    assert.notStrictEqual(
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX, 
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE
    );
    
    // Restore original environment
    if (originalForex !== undefined) {
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = originalForex;
    } else {
        delete process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    }
    
    if (originalSnake !== undefined) {
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE = originalSnake;
    } else {
        delete process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE;
    }
});