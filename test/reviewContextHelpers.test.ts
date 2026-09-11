import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';

const hardLimits = new Map<string | undefined, number>([
    [undefined, 196000],
    ['large-reviewer', 980000],
    ['small-reviewer', 196000],
]);
const getModelHardLimit = (model: string | undefined) => hardLimits.get(model) ?? hardLimits.get(undefined)!;

await mock.module('@propr/core', {
    namedExports: {
        calculateCostWithCachePricing: mock.fn(),
        getAuthenticatedOctokit: mock.fn(),
        getDetailedUsageStats: mock.fn(),
        getModelHardLimit,
        getModelPricing: mock.fn(),
        getOpenRouterId: mock.fn(),
    },
});
await mock.module('../src/jobs/prCommentJobHelpers.js', {
    namedExports: {
        buildCommentHistory: mock.fn(() => ''),
        fetchLinkedIssueContext: mock.fn(async () => ({})),
    },
});
await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        fetchAllComments: mock.fn(async () => []),
        fetchPRFileContents: mock.fn(async () => new Map()),
        fetchPRFiles: mock.fn(async () => [{ filename: 'src/config.ts' }]),
        formatFileContents: mock.fn(() => ''),
        formatPRDiffWithMetadata: mock.fn(() => ({ diff: '+safe change', omittedFiles: [] })),
    },
});

const {
    fetchReviewContext,
    REVIEW_CONTEXT_TOKEN_RESERVE,
    resolveReviewContextTokenBudget,
} = await import('../src/jobs/reviewContextHelpers.js');

describe('review context token budget', () => {
    test('keeps reserved output and runtime capacity inside the smallest reviewer window', () => {
        const models = ['large-reviewer', 'small-reviewer'];
        const smallestReviewerWindow = Math.min(...models.map(model => getModelHardLimit(model)));
        const automaticBudget = resolveReviewContextTokenBudget(models);

        assert.equal(automaticBudget + REVIEW_CONTEXT_TOKEN_RESERVE, smallestReviewerWindow);
        assert.equal(
            resolveReviewContextTokenBudget(models, smallestReviewerWindow),
            automaticBudget,
            'an explicit limit must not bypass the safe input ceiling',
        );
        assert.equal(resolveReviewContextTokenBudget(models, 120000), 120000);
    });
});

test('review context pins file content to the reviewed SHA and rejects head movement', async () => {
    const { fetchPRFileContents } = await import('../src/jobs/prCommentJobUtils.js');
    let head = 'a'.repeat(40);
    const octokit = { paginate: async () => [], request: async () => ({ data: { head: { sha: head } } }) };
    const data = { data: { head: { ref: 'feature', sha: head }, body: '', labels: [], user: { login: 'fixture' }, title: 'Fixture' } };
    const params = { repoOwner: 'acme', repoName: 'repo', pullRequestNumber: 42, models: [], correlationId: 'fixture', correlatedLogger: { info() {}, warn() {} } };
    await fetchReviewContext(octokit as never, data, params as never);
    const calls = (fetchPRFileContents as unknown as { mock: { calls: Array<{ arguments: Array<{ prHeadRef: string }> }> } }).mock.calls;
    assert.equal(calls.at(-1)!.arguments[0].prHeadRef, head);
    head = 'b'.repeat(40);
    await assert.rejects(fetchReviewContext(octokit as never, data, params as never), /head changed/);
});
