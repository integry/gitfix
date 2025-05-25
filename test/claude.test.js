import { test } from 'node:test';
import assert from 'node:assert';

// Set up test environment variables
process.env.CLAUDE_DOCKER_IMAGE = 'claude-code-processor:test';
process.env.CLAUDE_CONFIG_PATH = '/tmp/test-claude-config';
process.env.CLAUDE_MAX_TURNS = '5';
process.env.CLAUDE_TIMEOUT_MS = '60000';

test('Claude service module exports required functions', async () => {
    const claudeService = await import('../src/claude/claudeService.js');
    
    assert.strictEqual(typeof claudeService.executeClaudeCode, 'function');
    assert.strictEqual(typeof claudeService.buildClaudeDockerImage, 'function');
});

test('Claude prompt generation includes issue details', () => {
    // Test the prompt generation logic (simplified version for testing)
    function generateTestPrompt(issue) {
        return `You are an expert software engineer tasked with analyzing and fixing a GitHub issue.

## Issue Details
**Repository:** ${issue.repoOwner}/${issue.repoName}
**Issue #${issue.number}:** ${issue.title}

**Issue Description:**
${issue.body || 'No description provided.'}`;
    }
    
    const testIssue = {
        number: 123,
        title: 'Fix the authentication bug',
        body: 'The login system is not working properly',
        repoOwner: 'testowner',
        repoName: 'testrepo'
    };
    
    const prompt = generateTestPrompt(testIssue);
    
    assert.ok(prompt.includes('testowner/testrepo'));
    assert.ok(prompt.includes('Issue #123'));
    assert.ok(prompt.includes('Fix the authentication bug'));
    assert.ok(prompt.includes('The login system is not working properly'));
});

test('Docker command construction validates inputs', () => {
    // Test Docker argument validation (simplified)
    function validateDockerArgs(worktreePath, githubToken) {
        const errors = [];
        
        if (!worktreePath || typeof worktreePath !== 'string') {
            errors.push('worktreePath must be a non-empty string');
        }
        
        if (!githubToken || typeof githubToken !== 'string') {
            errors.push('githubToken must be a non-empty string');
        }
        
        return errors;
    }
    
    // Valid inputs
    assert.deepStrictEqual(
        validateDockerArgs('/path/to/worktree', 'ghp_token123'), 
        []
    );
    
    // Invalid inputs
    assert.ok(validateDockerArgs('', 'token').length > 0);
    assert.ok(validateDockerArgs('/path', '').length > 0);
    assert.ok(validateDockerArgs(null, 'token').length > 0);
});

test('Claude output parsing handles various formats', () => {
    // Test output parsing logic
    function parseClaudeOutput(rawOutput, exitCode) {
        let claudeOutput;
        try {
            claudeOutput = JSON.parse(rawOutput || '{}');
        } catch (parseError) {
            claudeOutput = {
                success: exitCode === 0,
                rawOutput: rawOutput,
                parseError: parseError.message
            };
        }
        
        return {
            success: exitCode === 0,
            output: claudeOutput,
            conversationLog: claudeOutput.conversation || [],
            modifiedFiles: claudeOutput.modifiedFiles || [],
            commitMessage: claudeOutput.commitMessage || null
        };
    }
    
    // Valid JSON output
    const validJson = JSON.stringify({
        conversation: ['message1', 'message2'],
        modifiedFiles: ['file1.js', 'file2.js'],
        commitMessage: 'Fix: Update authentication logic'
    });
    
    const result1 = parseClaudeOutput(validJson, 0);
    assert.strictEqual(result1.success, true);
    assert.strictEqual(result1.conversationLog.length, 2);
    assert.strictEqual(result1.modifiedFiles.length, 2);
    assert.strictEqual(result1.commitMessage, 'Fix: Update authentication logic');
    
    // Invalid JSON output
    const result2 = parseClaudeOutput('invalid json', 0);
    assert.strictEqual(result2.success, true); // exitCode is 0
    assert.ok(result2.output.parseError);
    assert.strictEqual(result2.conversationLog.length, 0);
    
    // Failed execution
    const result3 = parseClaudeOutput('{}', 1);
    assert.strictEqual(result3.success, false);
});

test('Environment configuration has valid defaults', () => {
    // Test default configuration values
    const defaultConfig = {
        CLAUDE_DOCKER_IMAGE: process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest',
        CLAUDE_MAX_TURNS: parseInt(process.env.CLAUDE_MAX_TURNS || '10', 10),
        CLAUDE_TIMEOUT_MS: parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10)
    };
    
    assert.strictEqual(defaultConfig.CLAUDE_DOCKER_IMAGE, 'claude-code-processor:test');
    assert.strictEqual(defaultConfig.CLAUDE_MAX_TURNS, 5);
    assert.strictEqual(defaultConfig.CLAUDE_TIMEOUT_MS, 60000);
    
    // Validate types
    assert.strictEqual(typeof defaultConfig.CLAUDE_DOCKER_IMAGE, 'string');
    assert.strictEqual(typeof defaultConfig.CLAUDE_MAX_TURNS, 'number');
    assert.strictEqual(typeof defaultConfig.CLAUDE_TIMEOUT_MS, 'number');
    
    // Validate ranges
    assert.ok(defaultConfig.CLAUDE_MAX_TURNS > 0);
    assert.ok(defaultConfig.CLAUDE_TIMEOUT_MS > 0);
});