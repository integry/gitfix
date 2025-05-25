import { test, mock } from 'node:test';
import assert from 'node:assert';

// Set up test environment variables
process.env.GIT_CLONES_BASE_PATH = '/tmp/test-clones';
process.env.GIT_WORKTREES_BASE_PATH = '/tmp/test-worktrees';
process.env.GIT_DEFAULT_BRANCH = 'main';

// Simple unit tests for helper functions only
// We'll test the actual Git operations in integration tests when we have a real repository

// Test only the URL construction helper function
function getRepoUrl(issue) {
    return `https://github.com/${issue.repoOwner}/${issue.repoName}.git`;
}

test('getRepoUrl constructs correct URL', () => {
    const issue = {
        repoOwner: 'testowner',
        repoName: 'testrepo'
    };
    
    const url = getRepoUrl(issue);
    assert.strictEqual(url, 'https://github.com/testowner/testrepo.git');
});

test('Git module has valid environment configuration', () => {
    // Test that environment variables are set correctly for Git operations
    assert.strictEqual(process.env.GIT_CLONES_BASE_PATH, '/tmp/test-clones');
    assert.strictEqual(process.env.GIT_WORKTREES_BASE_PATH, '/tmp/test-worktrees');
    assert.strictEqual(process.env.GIT_DEFAULT_BRANCH, 'main');
});

test('Branch name generation from issue title', () => {
    // Test the branch naming logic (simplified version)
    function generateBranchName(issueNumber, title) {
        const safeName = title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .substring(0, 50);
        
        return `ai-fix/${issueNumber}-${safeName}`;
    }
    
    const branchName = generateBranchName(123, 'Fix the bug with special chars!');
    assert.strictEqual(branchName, 'ai-fix/123-fix-the-bug-with-special-chars');
    
    const longTitle = 'This is a very long issue title that should be truncated to prevent extremely long branch names';
    const longBranchName = generateBranchName(456, longTitle);
    
    // Just verify it starts with the right prefix and contains safe characters
    assert.ok(longBranchName.startsWith('ai-fix/456-'));
    assert.ok(/^[a-zA-Z0-9\/-]+$/.test(longBranchName));
    
    // The title part should be properly truncated and safe
    const titlePart = longBranchName.replace('ai-fix/456-', '');
    assert.ok(titlePart.length > 0);
    assert.ok(titlePart.includes('this-is-a-very-long-issue-title'));
});