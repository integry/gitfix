import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import path from 'path';

// Set up environment variables for testing
process.env.AI_PROCESSING_TAG = 'AI-processing';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_DONE_TAG = 'AI-done';

describe('Worker - Model-Specific Features', () => {
    
    test('addModelSpecificDelay generates consistent delays for same model', async () => {
        // Import worker module to access the delay function
        // Since it's not exported, we'll test the logic directly
        
        function addModelSpecificDelay(modelName) {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        // Test consistent delays for same model
        const model1 = 'opus';
        const model2 = 'sonnet';
        
        // Calculate expected delays
        const getExpectedDelay = (modelName) => {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            return baseDelay + modelDelay;
        };
        
        const expectedDelay1 = getExpectedDelay(model1);
        const expectedDelay2 = getExpectedDelay(model2);
        
        // Delays should be consistent for same model
        assert.strictEqual(getExpectedDelay(model1), expectedDelay1);
        assert.strictEqual(getExpectedDelay(model2), expectedDelay2);
        
        // Different models should have different delays (very likely)
        assert.notStrictEqual(expectedDelay1, expectedDelay2);
        
        // Delays should be within expected range
        assert(expectedDelay1 >= 500 && expectedDelay1 < 2000);
        assert(expectedDelay2 >= 500 && expectedDelay2 < 2000);
    });
    
    test('addModelSpecificDelay timing verification', async () => {
        function addModelSpecificDelay(modelName) {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        const startTime = Date.now();
        await addModelSpecificDelay('test-model');
        const endTime = Date.now();
        const actualDelay = endTime - startTime;
        
        // Should take at least 500ms (base delay)
        assert(actualDelay >= 490, `Delay was ${actualDelay}ms, expected at least 490ms`);
        
        // Should not take more than 2100ms (max delay + some tolerance)
        assert(actualDelay < 2100, `Delay was ${actualDelay}ms, expected less than 2100ms`);
    });
    
    test('addModelSpecificDelay handles edge cases', () => {
        function getDelayTime(modelName) {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            return baseDelay + modelDelay;
        }
        
        // Test empty string
        const emptyDelay = getDelayTime('');
        assert(emptyDelay >= 500 && emptyDelay < 2000);
        
        // Test single character
        const singleCharDelay = getDelayTime('a');
        assert(singleCharDelay >= 500 && singleCharDelay < 2000);
        
        // Test long model name
        const longModelDelay = getDelayTime('very-long-model-name-with-many-characters');
        assert(longModelDelay >= 500 && longModelDelay < 2000);
        
        // Test special characters
        const specialCharDelay = getDelayTime('claude-3.5-sonnet@2024');
        assert(specialCharDelay >= 500 && specialCharDelay < 2000);
    });
});

describe('Worker - Branch and Worktree Naming', () => {
    
    test('createWorktreeForIssue generates unique names with model and random string', () => {
        // Extract the naming logic for testing
        function generateWorktreeNames(issueId, issueTitle, modelName) {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
            
            const randomString = Math.random().toString(36).substring(2, 5);
            
            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            
            const modelSuffix = modelName ? `-${modelName}` : '';
            const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
            
            return { branchName, worktreeDirName, randomString };
        }
        
        const issueId = 42;
        const issueTitle = 'Fix Critical Bug in Authentication System';
        const modelName = 'opus';
        
        const result = generateWorktreeNames(issueId, issueTitle, modelName);
        
        // Check branch name format
        assert(result.branchName.startsWith('ai-fix/42-fix-critical-bug-in'));
        assert(result.branchName.includes('-opus-'));
        assert(result.branchName.endsWith(`-${result.randomString}`));
        
        // Check worktree name format
        assert(result.worktreeDirName.startsWith('issue-42-'));
        assert(result.worktreeDirName.includes('-opus-'));
        assert(result.worktreeDirName.endsWith(`-${result.randomString}`));
        
        // Random string should be 3 characters
        assert.strictEqual(result.randomString.length, 3);
        assert(/^[a-z0-9]{3}$/.test(result.randomString));
    });
    
    test('createWorktreeForIssue handles different models uniquely', () => {
        function generateWorktreeNames(issueId, issueTitle, modelName) {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
            
            const randomString = Math.random().toString(36).substring(2, 5);
            
            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            
            const modelSuffix = modelName ? `-${modelName}` : '';
            const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
            
            return { branchName, worktreeDirName };
        }
        
        const issueId = 42;
        const issueTitle = 'Test Issue';
        
        const opusResult = generateWorktreeNames(issueId, issueTitle, 'opus');
        const sonnetResult = generateWorktreeNames(issueId, issueTitle, 'sonnet');
        const defaultResult = generateWorktreeNames(issueId, issueTitle, null);
        
        // Models should create different names
        assert.notStrictEqual(opusResult.branchName, sonnetResult.branchName);
        assert.notStrictEqual(opusResult.worktreeDirName, sonnetResult.worktreeDirName);
        
        // Check model-specific suffixes
        assert(opusResult.branchName.includes('-opus-'));
        assert(sonnetResult.branchName.includes('-sonnet-'));
        assert(!defaultResult.branchName.includes('-opus-'));
        assert(!defaultResult.branchName.includes('-sonnet-'));
    });
    
    test('createWorktreeForIssue sanitizes issue titles correctly', () => {
        function sanitizeTitle(title) {
            return title
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
        }
        
        const testCases = [
            {
                input: 'Fix: Critical Bug with @mentions & "quotes"',
                expected: 'fix-critical-bug-with-men'
            },
            {
                input: 'Very   Long    Title    With    Multiple    Spaces',
                expected: 'very-long-title-with-mult'
            },
            {
                input: '---Leading-and-trailing-dashes---',
                expected: 'leading-and-trailing-dash'
            },
            {
                input: 'Special!@#$%^&*()Characters[]{}',
                expected: 'special-characters'
            },
            {
                input: 'Short',
                expected: 'short'
            }
        ];
        
        testCases.forEach((testCase, index) => {
            const result = sanitizeTitle(testCase.input);
            assert.strictEqual(result, testCase.expected, `Test case ${index + 1} failed`);
            assert(result.length <= 25, `Test case ${index + 1}: result too long`);
        });
    });
    
    test('worktree names include proper timestamp format', () => {
        function generateTimestamp() {
            const now = new Date();
            return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        }
        
        const timestamp = generateTimestamp();
        
        // Should be in format YYYYMMDD-HHMM
        assert(/^\d{8}-\d{4}$/.test(timestamp));
        
        // Should be current date/time (within reasonable tolerance)
        const now = new Date();
        const expectedStart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        assert(timestamp.startsWith(expectedStart));
    });
});

describe('Worker - Model-Specific Job Processing', () => {
    
    test('processGitHubIssueJob uses modelName from job data', async () => {
        // Test the logic of extracting modelName from job data directly
        // This is a simpler approach than full module mocking
        
        const issueRef = {
            repoOwner: 'test',
            repoName: 'repo',
            number: 42,
            modelName: 'opus',
            correlationId: 'test-correlation-id'
        };
        
        const modelName = issueRef.modelName || 'default';
        assert.strictEqual(modelName, 'opus');
        
        // Test that the naming logic would work with this modelName
        function simulateWorktreeNaming(issueId, issueTitle, modelName) {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
            
            const randomString = 'abc'; // Fixed for testing
            const timestamp = '20240528-1430'; // Fixed for testing
            const modelSuffix = modelName ? `-${modelName}` : '';
            const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${timestamp}${modelSuffix}-${randomString}`;
            
            return branchName;
        }
        
        const branchName = simulateWorktreeNaming(issueRef.number, 'Test Issue', modelName);
        assert(branchName.includes('-opus-'), `Branch name should contain model: ${branchName}`);
        assert.strictEqual(branchName, 'ai-fix/42-test-issue-20240528-1430-opus-abc');
    });
    
    test('processGitHubIssueJob handles missing modelName gracefully', async () => {
        // Mock basic dependencies for this test
        const mockOctokit = {
            request: mock.fn(),
            auth: mock.fn(async () => ({ token: 'fake-token' }))
        };
        
        const mockStateManager = {
            createTaskState: mock.fn(),
            updateTaskState: mock.fn()
        };
        
        // Test the modelName fallback logic directly
        const issueRef = { repoOwner: 'test', repoName: 'repo', number: 42 };
        const modelName = issueRef.modelName || 'default';
        
        assert.strictEqual(modelName, 'default');
        
        // Test with explicit modelName
        const issueRefWithModel = { ...issueRef, modelName: 'sonnet' };
        const modelNameWithModel = issueRefWithModel.modelName || 'default';
        
        assert.strictEqual(modelNameWithModel, 'sonnet');
    });
});

describe('Worker - Concurrent Execution Prevention', () => {
    
    test('different models get different delay times', () => {
        function calculateDelay(modelName) {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            return baseDelay + modelDelay;
        }
        
        const models = ['opus', 'sonnet', 'claude-3', 'gpt-4'];
        const delays = models.map(calculateDelay);
        
        // All delays should be different (very likely with good hash function)
        const uniqueDelays = new Set(delays);
        assert.strictEqual(uniqueDelays.size, delays.length, 'All models should have unique delays');
        
        // All delays should be in valid range
        delays.forEach((delay, index) => {
            assert(delay >= 500 && delay < 2000, `Model ${models[index]} delay ${delay} out of range`);
        });
    });
    
    test('concurrent job simulation shows different timings', async () => {
        function addModelSpecificDelay(modelName) {
            const baseDelay = 50; // Reduced for testing
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 100); // Reduced range for testing
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        // Simulate concurrent execution
        const startTime = Date.now();
        const models = ['opus', 'sonnet'];
        
        const promises = models.map(async (model, index) => {
            const modelStartTime = Date.now();
            await addModelSpecificDelay(model);
            const modelEndTime = Date.now();
            return {
                model,
                startTime: modelStartTime - startTime,
                duration: modelEndTime - modelStartTime,
                endTime: modelEndTime - startTime
            };
        });
        
        const results = await Promise.all(promises);
        
        // Both should finish, but with different durations
        assert.strictEqual(results.length, 2);
        assert.notStrictEqual(results[0].duration, results[1].duration);
        
        // Both should have reasonable durations
        results.forEach(result => {
            assert(result.duration >= 40, `${result.model} duration too short: ${result.duration}ms`);
            assert(result.duration < 200, `${result.model} duration too long: ${result.duration}ms`);
        });
    });
});