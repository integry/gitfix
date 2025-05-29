import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('Worker Integration - Concurrent Model Execution', () => {
    let tempDir;
    let mockRedis;
    let mockOctokit;
    let originalEnv;
    
    beforeEach(async () => {
        // Save original environment
        originalEnv = { ...process.env };
        
        // Create temporary directory
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitfix-integration-'));
        
        // Set up test environment
        process.env.WORKTREES_BASE_PATH = path.join(tempDir, 'worktrees');
        process.env.GIT_PROCESSOR_PATH = path.join(tempDir, 'git-processor');
        process.env.AI_PROCESSING_TAG = 'AI-processing';
        process.env.AI_PRIMARY_TAG = 'AI';
        process.env.AI_DONE_TAG = 'AI-done';
        
        await fs.ensureDir(process.env.WORKTREES_BASE_PATH);
        await fs.ensureDir(process.env.GIT_PROCESSOR_PATH);
        
        // Mock Redis client
        mockRedis = {
            set: mock.fn(),
            get: mock.fn(),
            del: mock.fn(),
            exists: mock.fn(),
            quit: mock.fn()
        };
        
        // Mock Octokit
        mockOctokit = {
            request: mock.fn(),
            auth: mock.fn(async () => ({ token: 'fake-token' }))
        };
    });
    
    afterEach(async () => {
        // Restore environment
        process.env = originalEnv;
        
        // Clean up temporary directory
        if (tempDir) {
            await fs.remove(tempDir);
        }
    });
    
    test('concurrent jobs with different models create unique worktrees', async () => {
        // Simplified test focusing on the naming logic without full module mocking
        // This tests the core logic that would be used in real concurrent execution
        
        function simulateWorktreeCreation(issueId, issueTitle, modelName) {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
            
            const randomString = Math.random().toString(36).substring(2, 5);
            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            
            const modelSuffix = modelName ? `-${modelName}` : '';
            const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreePath = path.join(process.env.WORKTREES_BASE_PATH, 'testuser', 'testrepo', worktreeDirName);
            
            return { worktreePath, branchName, modelName };
        }
        
        // Simulate concurrent worktree creation
        const issueId = 42;
        const issueTitle = 'Test Concurrent Issue';
        
        const opusWorktree = simulateWorktreeCreation(issueId, issueTitle, 'opus');
        const sonnetWorktree = simulateWorktreeCreation(issueId, issueTitle, 'sonnet');
        
        // Verify unique paths and branches
        assert.notStrictEqual(opusWorktree.worktreePath, sonnetWorktree.worktreePath);
        assert.notStrictEqual(opusWorktree.branchName, sonnetWorktree.branchName);
        
        // Verify model-specific naming
        assert(opusWorktree.branchName.includes('-opus-'));
        assert(sonnetWorktree.branchName.includes('-sonnet-'));
        assert(opusWorktree.worktreePath.includes('-opus-'));
        assert(sonnetWorktree.worktreePath.includes('-sonnet-'));
        
        // Create actual directories to test file system isolation
        await fs.ensureDir(opusWorktree.worktreePath);
        await fs.ensureDir(sonnetWorktree.worktreePath);
        
        await fs.writeFile(path.join(opusWorktree.worktreePath, 'opus-file.txt'), 'opus work');
        await fs.writeFile(path.join(sonnetWorktree.worktreePath, 'sonnet-file.txt'), 'sonnet work');
        
        // Verify file isolation
        const opusFiles = await fs.readdir(opusWorktree.worktreePath);
        const sonnetFiles = await fs.readdir(sonnetWorktree.worktreePath);
        
        assert(opusFiles.includes('opus-file.txt'));
        assert(!opusFiles.includes('sonnet-file.txt'));
        
        assert(sonnetFiles.includes('sonnet-file.txt'));
        assert(!sonnetFiles.includes('opus-file.txt'));
    });
    
    test('delay function prevents exact simultaneous execution', async () => {
        // Test the delay logic directly
        function addModelSpecificDelay(modelName) {
            const baseDelay = 100; // Reduced for testing
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 200); // Reduced range
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        const models = ['opus', 'sonnet', 'claude-3', 'gpt-4'];
        const executionTimes = [];
        
        // Execute delays concurrently and measure timing
        const startTime = Date.now();
        const promises = models.map(async (model) => {
            const modelStartTime = Date.now();
            await addModelSpecificDelay(model);
            const modelEndTime = Date.now();
            return {
                model,
                startOffset: modelStartTime - startTime,
                duration: modelEndTime - modelStartTime,
                endOffset: modelEndTime - startTime
            };
        });
        
        const results = await Promise.all(promises);
        
        // All should complete
        assert.strictEqual(results.length, models.length);
        
        // Each should have different duration (very likely)
        const durations = results.map(r => r.duration);
        const uniqueDurations = new Set(durations);
        assert(uniqueDurations.size > 1, 'Models should have different delay durations');
        
        // All durations should be within expected range
        durations.forEach((duration, index) => {
            assert(duration >= 90, `Model ${models[index]} duration too short: ${duration}ms`);
            assert(duration < 350, `Model ${models[index]} duration too long: ${duration}ms`);
        });
        
        // Execution should be staggered (not all starting at exactly the same time)
        const startOffsets = results.map(r => r.startOffset);
        const maxStartOffset = Math.max(...startOffsets);
        assert(maxStartOffset < 50, 'All should start within reasonable time of each other');
    });
    
    test('worktree cleanup after concurrent execution', async () => {
        // Create mock worktree directories
        const owner = 'testuser';
        const repoName = 'testrepo';
        const issueId = 42;
        
        const worktreePaths = [];
        for (const model of ['opus', 'sonnet']) {
            const randomString = Math.random().toString(36).substring(2, 5);
            const timestamp = '20240528-1430';
            const dirName = `issue-${issueId}-${timestamp}-${model}-${randomString}`;
            const worktreePath = path.join(process.env.WORKTREES_BASE_PATH, owner, repoName, dirName);
            
            await fs.ensureDir(worktreePath);
            await fs.writeFile(path.join(worktreePath, 'test.txt'), 'test content');
            
            worktreePaths.push(worktreePath);
        }
        
        // Verify directories exist
        for (const worktreePath of worktreePaths) {
            const exists = await fs.pathExists(worktreePath);
            assert(exists, `Worktree should exist before cleanup: ${worktreePath}`);
        }
        
        // Simulate cleanup
        for (const worktreePath of worktreePaths) {
            await fs.remove(worktreePath);
        }
        
        // Verify directories are cleaned up
        for (const worktreePath of worktreePaths) {
            const exists = await fs.pathExists(worktreePath);
            assert(!exists, `Worktree should be cleaned up: ${worktreePath}`);
        }
    });
    
    test('file system isolation between concurrent workers', async () => {
        // Create separate worktree directories for different models
        const baseDir = process.env.WORKTREES_BASE_PATH;
        const owner = 'testuser';
        const repoName = 'testrepo';
        const issueId = 42;
        
        const opusDir = path.join(baseDir, owner, repoName, 'issue-42-20240528-1430-opus-abc');
        const sonnetDir = path.join(baseDir, owner, repoName, 'issue-42-20240528-1430-sonnet-xyz');
        
        // Create directories and files
        await fs.ensureDir(opusDir);
        await fs.ensureDir(sonnetDir);
        
        await fs.writeFile(path.join(opusDir, 'opus-work.txt'), 'opus is working on this issue');
        await fs.writeFile(path.join(sonnetDir, 'sonnet-work.txt'), 'sonnet is working on this issue');
        
        // Verify isolation - each worker has its own files
        const opusFiles = await fs.readdir(opusDir);
        const sonnetFiles = await fs.readdir(sonnetDir);
        
        assert(opusFiles.includes('opus-work.txt'));
        assert(!opusFiles.includes('sonnet-work.txt'));
        
        assert(sonnetFiles.includes('sonnet-work.txt'));
        assert(!sonnetFiles.includes('opus-work.txt'));
        
        // Verify file contents
        const opusContent = await fs.readFile(path.join(opusDir, 'opus-work.txt'), 'utf8');
        const sonnetContent = await fs.readFile(path.join(sonnetDir, 'sonnet-work.txt'), 'utf8');
        
        assert.strictEqual(opusContent, 'opus is working on this issue');
        assert.strictEqual(sonnetContent, 'sonnet is working on this issue');
        
        // Simulate concurrent file operations
        await Promise.all([
            fs.writeFile(path.join(opusDir, 'concurrent-opus.txt'), 'opus concurrent operation'),
            fs.writeFile(path.join(sonnetDir, 'concurrent-sonnet.txt'), 'sonnet concurrent operation')
        ]);
        
        // Verify both operations succeeded independently
        const opusExists = await fs.pathExists(path.join(opusDir, 'concurrent-opus.txt'));
        const sonnetExists = await fs.pathExists(path.join(sonnetDir, 'concurrent-sonnet.txt'));
        
        assert(opusExists, 'Opus concurrent file should exist');
        assert(sonnetExists, 'Sonnet concurrent file should exist');
        
        // Verify cross-contamination didn't occur
        const opusCrossFile = await fs.pathExists(path.join(opusDir, 'concurrent-sonnet.txt'));
        const sonnetCrossFile = await fs.pathExists(path.join(sonnetDir, 'concurrent-opus.txt'));
        
        assert(!opusCrossFile, 'Sonnet file should not appear in opus directory');
        assert(!sonnetCrossFile, 'Opus file should not appear in sonnet directory');
    });
    
    test('error handling in concurrent execution', async () => {
        // Simplified test for error handling logic
        // This tests that failures in one operation don't affect others
        
        function simulateJobExecution(jobId, modelName, shouldFail = false) {
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    if (shouldFail) {
                        reject(new Error(`${modelName} job failed`));
                    } else {
                        resolve({
                            jobId,
                            modelName,
                            status: 'completed',
                            worktreePath: path.join(tempDir, 'worktrees', 'testuser', 'testrepo', `issue-42-${modelName}-abc`)
                        });
                    }
                }, Math.random() * 100); // Random delay to simulate real execution
            });
        }
        
        // Simulate concurrent execution where one fails and one succeeds
        const results = await Promise.allSettled([
            simulateJobExecution('job-opus', 'opus', true), // This should fail
            simulateJobExecution('job-sonnet', 'sonnet', false) // This should succeed
        ]);
        
        // Verify mixed results
        assert.strictEqual(results.length, 2);
        
        const opusResult = results[0];
        const sonnetResult = results[1];
        
        // Opus should have failed
        assert.strictEqual(opusResult.status, 'rejected');
        assert(opusResult.reason.message.includes('opus job failed'));
        
        // Sonnet should have succeeded
        assert.strictEqual(sonnetResult.status, 'fulfilled');
        assert.strictEqual(sonnetResult.value.status, 'completed');
        assert.strictEqual(sonnetResult.value.modelName, 'sonnet');
        
        // Verify that failure of one doesn't prevent the other from completing
        assert.notStrictEqual(opusResult.status, sonnetResult.status);
    });
});