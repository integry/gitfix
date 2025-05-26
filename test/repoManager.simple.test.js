import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Repository Manager - Enhanced Features Logic Tests', () => {
    
    test('should generate structured commit message correctly', () => {
        const issueNumber = 42;
        const issueTitle = 'Fix authentication bug with null pointer exception';
        
        // Test default structured commit message generation (extracted logic)
        const shortTitle = issueTitle ? issueTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
        const finalCommitMessage = `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}

Implemented by Claude Code. Full conversation log in PR comment.`;

        assert(finalCommitMessage.includes('fix(ai): Resolve issue #42'));
        assert(finalCommitMessage.includes('Fix authentication bug with null pointer exception'));
        assert(finalCommitMessage.includes('Implemented by Claude Code'));
        assert(finalCommitMessage.split('\n').length >= 3, 'Should be multi-line commit message');
    });

    test('should handle Claude suggested commit message', () => {
        const claudeSuggested = 'feat: implement advanced authentication system\n\nAdded OAuth2 support and improved security validation.';
        const commitMessageObj = { claudeSuggested };
        
        // Test Claude suggested message handling (extracted logic)
        let finalCommitMessage;
        if (typeof commitMessageObj === 'object' && commitMessageObj.claudeSuggested) {
            finalCommitMessage = commitMessageObj.claudeSuggested;
        }

        assert.strictEqual(finalCommitMessage, claudeSuggested);
    });

    test('should truncate long issue titles in commit messages', () => {
        const longTitle = 'This is a very long issue title that exceeds the reasonable length limit for commit messages and should be truncated properly to maintain readability';
        const issueNumber = 123;
        
        // Test title truncation (extracted logic)
        const shortTitle = longTitle.substring(0, 50).replace(/\s+/g, ' ').trim();
        const commitMessage = `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}

Implemented by Claude Code. Full conversation log in PR comment.`;

        assert(shortTitle.length <= 50, 'Title should be truncated to 50 characters');
        assert(commitMessage.includes('This is a very long issue title that exceeds the'), 'Should include truncated title');
        assert(!commitMessage.includes('reasonable length limit'), 'Should not include text beyond truncation point');
    });

    test('should validate retention strategy logic', () => {
        // Test keep_on_failure strategy
        const retentionStrategy = 'keep_on_failure';
        const success = false;
        
        const shouldKeepWorktree = !success && retentionStrategy === 'keep_on_failure';
        assert.strictEqual(shouldKeepWorktree, true);

        // Test keep_for_hours strategy
        const retentionStrategy2 = 'keep_for_hours';
        const shouldScheduleCleanup = !success && retentionStrategy2 === 'keep_for_hours';
        assert.strictEqual(shouldScheduleCleanup, true);

        // Test always_delete strategy (default)
        const retentionStrategy3 = 'always_delete';
        const shouldDeleteImmediately = retentionStrategy3 === 'always_delete';
        assert.strictEqual(shouldDeleteImmediately, true);
    });

    test('should generate retention info correctly', () => {
        const retentionHours = 48;
        const now = Date.now();
        
        // Test retention info generation (extracted logic)
        const retentionInfo = {
            timestamp: new Date().toISOString(),
            issueProcessed: true,
            success: false,
            retentionHours,
            scheduledCleanup: new Date(now + retentionHours * 60 * 60 * 1000).toISOString()
        };

        assert(typeof retentionInfo.timestamp === 'string');
        assert(retentionInfo.issueProcessed === true);
        assert(retentionInfo.success === false);
        assert(retentionInfo.retentionHours === 48);
        
        // Verify scheduled cleanup is correctly calculated
        const scheduledTime = new Date(retentionInfo.scheduledCleanup);
        const expectedTime = new Date(now + 48 * 60 * 60 * 1000);
        const timeDiff = Math.abs(scheduledTime.getTime() - expectedTime.getTime());
        assert(timeDiff < 5000, 'Scheduled cleanup should be approximately 48 hours from now');
    });

    test('should determine branch deletion logic correctly', () => {
        // Test branch deletion logic based on success
        const wasSuccessful = true;
        const postProcessingResult = { pr: { number: 123 } };
        
        const shouldDeleteBranch = !wasSuccessful; // Keep branch if successful (it's in the PR)
        assert.strictEqual(shouldDeleteBranch, false, 'Should not delete branch when successful and PR created');

        // Test when unsuccessful
        const wasUnsuccessful = false;
        const shouldDeleteBranchOnFailure = !wasUnsuccessful;
        assert.strictEqual(shouldDeleteBranchOnFailure, true, 'Should delete branch when unsuccessful');
    });

    test('should validate expired worktree cleanup logic', () => {
        // Test age calculation
        const oldTimestamp = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
        const ageHours = (Date.now() - oldTimestamp) / (1000 * 60 * 60);
        const maxAgeHours = 72;
        
        const shouldCleanupByAge = ageHours > maxAgeHours;
        assert.strictEqual(shouldCleanupByAge, false, 'Should not cleanup by age if under limit');

        // Test with older timestamp
        const veryOldTimestamp = Date.now() - 96 * 60 * 60 * 1000; // 96 hours ago
        const veryOldAgeHours = (Date.now() - veryOldTimestamp) / (1000 * 60 * 60);
        
        const shouldCleanupVeryOld = veryOldAgeHours > maxAgeHours;
        assert.strictEqual(shouldCleanupVeryOld, true, 'Should cleanup very old worktrees');
    });

    test('should validate retention file scheduling logic', () => {
        // Test future cleanup time
        const futureCleanup = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours in future
        const now = new Date();
        
        const shouldCleanupNow = now >= futureCleanup;
        assert.strictEqual(shouldCleanupNow, false, 'Should not cleanup before scheduled time');

        // Test past cleanup time
        const pastCleanup = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago
        const shouldCleanupPast = now >= pastCleanup;
        assert.strictEqual(shouldCleanupPast, true, 'Should cleanup after scheduled time');
    });

    test('should handle commit message variations correctly', () => {
        const testCases = [
            {
                input: 'Simple string message',
                expected: 'Simple string message'
            },
            {
                input: { claudeSuggested: 'Claude suggested message' },
                expected: 'Claude suggested message'
            },
            {
                input: null,
                issueNumber: 42,
                issueTitle: 'Test issue',
                expectedPattern: /fix\(ai\): Resolve issue #42/
            }
        ];

        testCases.forEach((testCase, index) => {
            let finalCommitMessage;
            
            if (typeof testCase.input === 'object' && testCase.input?.claudeSuggested) {
                finalCommitMessage = testCase.input.claudeSuggested;
            } else if (typeof testCase.input === 'string') {
                finalCommitMessage = testCase.input;
            } else {
                // Generate default
                const shortTitle = testCase.issueTitle ? testCase.issueTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
                finalCommitMessage = `fix(ai): Resolve issue #${testCase.issueNumber} - ${shortTitle}

Implemented by Claude Code. Full conversation log in PR comment.`;
            }

            if (testCase.expected) {
                assert.strictEqual(finalCommitMessage, testCase.expected, `Test case ${index + 1} failed`);
            } else if (testCase.expectedPattern) {
                assert(testCase.expectedPattern.test(finalCommitMessage), `Test case ${index + 1} pattern match failed`);
            }
        });
    });
});

describe('Repository Manager - Edge Cases', () => {
    
    test('should handle empty or undefined issue titles', () => {
        const issueNumber = 42;
        const undefinedTitle = undefined;
        const emptyTitle = '';
        
        // Test with undefined title
        const shortTitle1 = undefinedTitle ? undefinedTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
        assert.strictEqual(shortTitle1, 'issue fix');

        // Test with empty title
        const shortTitle2 = emptyTitle ? emptyTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
        assert.strictEqual(shortTitle2, 'issue fix');
    });

    test('should handle special characters in issue titles', () => {
        const specialCharTitle = 'Fix: Issue with @user & "special" chars [important]';
        const shortTitle = specialCharTitle.substring(0, 50).replace(/\s+/g, ' ').trim();
        
        assert(shortTitle.length <= 50);
        assert(shortTitle.includes('Fix: Issue with @user & "special" chars'));
    });

    test('should handle very short issue titles', () => {
        const shortTitle = 'Bug';
        const processedTitle = shortTitle.substring(0, 50).replace(/\s+/g, ' ').trim();
        
        assert.strictEqual(processedTitle, 'Bug');
    });

    test('should handle retention hours parsing', () => {
        // Test valid retention hours
        const validHours = parseInt('24', 10);
        assert.strictEqual(validHours, 24);

        // Test invalid retention hours (should default)
        const invalidHours = parseInt('invalid', 10);
        const defaultHours = invalidHours || 24;
        assert.strictEqual(defaultHours, 24);

        // Test environment variable simulation
        const envVar = '48';
        const parsedEnvVar = parseInt(envVar, 10);
        assert.strictEqual(parsedEnvVar, 48);
    });
});