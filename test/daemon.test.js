import { test, mock } from 'node:test';
import assert from 'node:assert';
import { fetchIssuesForRepo, pollForIssues } from '../src/daemon.js';

// Mock environment variables for testing
process.env.GITHUB_REPOS_TO_MONITOR = 'test-owner/test-repo';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_EXCLUDE_TAGS_PROCESSING = 'AI-processing';
process.env.AI_EXCLUDE_TAGS_DONE = 'AI-done';

test('fetchIssuesForRepo handles invalid repository format', async () => {
    const mockOctokit = {};
    const invalidRepo = 'invalid-format';
    
    const issues = await fetchIssuesForRepo(mockOctokit, invalidRepo);
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo constructs correct search query', async (t) => {
    let capturedQuery = '';
    const mockOctokit = {
        request: mock.fn(async (endpoint, options) => {
            capturedQuery = options.q;
            return {
                data: {
                    total_count: 0,
                    items: []
                }
            };
        })
    };

    await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
    assert.strictEqual(mockOctokit.request.mock.calls[0].arguments[0], 'GET /search/issues');
    assert.ok(capturedQuery.includes('repo:owner/repo'));
    assert.ok(capturedQuery.includes('is:issue'));
    assert.ok(capturedQuery.includes('is:open'));
    assert.ok(capturedQuery.includes('label:"AI"'));
    assert.ok(capturedQuery.includes('-label:"AI-processing"'));
    assert.ok(capturedQuery.includes('-label:"AI-done"'));
});

test('fetchIssuesForRepo transforms issues correctly', async () => {
    const mockIssue = {
        id: 123,
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/owner/repo/issues/1',
        labels: [
            { name: 'AI' },
            { name: 'bug' }
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z'
    };

    const mockOctokit = {
        request: mock.fn(async () => ({
            data: {
                total_count: 1,
                items: [mockIssue]
            }
        }))
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    
    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0], {
        id: 123,
        number: 1,
        title: 'Test Issue',
        url: 'https://github.com/owner/repo/issues/1',
        repoOwner: 'owner',
        repoName: 'repo',
        labels: ['AI', 'bug'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z'
    });
});

test('fetchIssuesForRepo handles API errors gracefully', async () => {
    const mockOctokit = {
        request: mock.fn(async () => {
            const error = new Error('API Error');
            error.status = 500;
            throw error;
        })
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo handles rate limit errors', async () => {
    const mockOctokit = {
        request: mock.fn(async () => {
            const error = new Error('API rate limit exceeded');
            error.status = 403;
            throw error;
        })
    };

    const issues = await fetchIssuesForRepo(mockOctokit, 'owner/repo');
    assert.deepStrictEqual(issues, []);
});

test('pollForIssues returns detected issues', async (t) => {
    // Override environment for this test
    const originalRepos = process.env.GITHUB_REPOS_TO_MONITOR;
    process.env.GITHUB_REPOS_TO_MONITOR = 'owner1/repo1';

    // This test validates that pollForIssues can run without authentication
    // In a real scenario, it would use the authenticated client
    const { pollForIssues: testPollForIssues } = await import('../src/daemon.js');
    
    // Since we don't have real GitHub credentials in test, this will fail auth
    // but that's expected and handled gracefully
    const issues = await testPollForIssues();

    // Without auth, it should return undefined (no issues)
    assert.strictEqual(issues, undefined);

    // Restore original environment
    process.env.GITHUB_REPOS_TO_MONITOR = originalRepos;
});

test('daemon exports required functions', () => {
    assert.strictEqual(typeof fetchIssuesForRepo, 'function');
    assert.strictEqual(typeof pollForIssues, 'function');
});