import { test } from 'node:test';
import assert from 'node:assert';

// Test comment generation with enhanced execution details
function generateMockCompletionComment(claudeResult, issueRef) {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);
    
    function extractModelDisplayName(modelId) {
        if (!modelId || typeof modelId !== 'string') {
            return 'Claude (Unknown Model)';
        }
        
        const modelMappings = {
            'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
            'claude-3-opus': 'Claude 3 Opus',
            'claude-3-haiku': 'Claude 3 Haiku'
        };
        
        for (const [pattern, displayName] of Object.entries(modelMappings)) {
            if (modelId.toLowerCase().includes(pattern)) {
                return displayName;
            }
        }
        
        return 'Claude (Unknown Model)';
    }
    
    let comment = `🤖 **AI Processing ${isSuccess ? 'Completed' : 'Failed'}**\n\n`;
    comment += `**Execution Details:**\n`;
    comment += `- Issue: #${issueRef.number}\n`;
    comment += `- Repository: ${issueRef.repoOwner}/${issueRef.repoName}\n`;
    comment += `- Status: ${isSuccess ? '✅ Success' : '❌ Failed'}\n`;
    comment += `- Execution Time: ${executionTime}s\n`;
    comment += `- Timestamp: ${timestamp}\n`;
    
    // Add conversation ID if available
    if (claudeResult?.conversationId) {
        comment += `- Conversation ID: \`${claudeResult.conversationId}\`\n`;
    }
    
    // Add model information if available
    if (claudeResult?.model) {
        const modelName = extractModelDisplayName(claudeResult.model);
        comment += `- LLM Model: ${modelName}\n`;
    }
    
    comment += `\n`;
    
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        comment += `**Claude Code Results:**\n`;
        comment += `- Turns Used: ${result.num_turns || 'unknown'}\n`;
        comment += `- Cost: $${result.cost_usd || 'unknown'}\n`;
        comment += `- Session ID: \`${claudeResult.sessionId || 'unknown'}\`\n\n`;
    }
    
    return comment;
}

test('Enhanced GitHub comment includes conversation ID and model', () => {
    const mockClaudeResult = {
        success: true,
        executionTime: 127000, // 127 seconds in milliseconds
        conversationId: 'conv_abc123xyz789',
        sessionId: 'session_def456',
        model: 'claude-3-5-sonnet-20241022',
        finalResult: {
            num_turns: 15,
            cost_usd: 0.42
        }
    };
    
    const mockIssueRef = {
        number: 344,
        repoOwner: 'integry',
        repoName: 'forex'
    };
    
    const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
    
    // Verify key components are present
    assert.ok(comment.includes('🤖 **AI Processing Completed**'));
    assert.ok(comment.includes('- Issue: #344'));
    assert.ok(comment.includes('- Repository: integry/forex'));
    assert.ok(comment.includes('- Status: ✅ Success'));
    assert.ok(comment.includes('- Execution Time: 127s'));
    assert.ok(comment.includes('- Conversation ID: `conv_abc123xyz789`'));
    assert.ok(comment.includes('- LLM Model: Claude 3.5 Sonnet'));
    assert.ok(comment.includes('- Turns Used: 15'));
    assert.ok(comment.includes('- Cost: $0.42'));
    assert.ok(comment.includes('- Session ID: `session_def456`'));
});

test('GitHub comment gracefully handles missing optional fields', () => {
    const mockClaudeResult = {
        success: false,
        executionTime: 5000, // 5 seconds
        // No conversationId, model, or finalResult
    };
    
    const mockIssueRef = {
        number: 123,
        repoOwner: 'testorg',
        repoName: 'testrepo'
    };
    
    const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
    
    // Verify it handles missing fields gracefully
    assert.ok(comment.includes('🤖 **AI Processing Failed**'));
    assert.ok(comment.includes('- Status: ❌ Failed'));
    assert.ok(comment.includes('- Execution Time: 5s'));
    
    // Should not include conversation ID or model if not available
    assert.ok(!comment.includes('Conversation ID:'));
    assert.ok(!comment.includes('LLM Model:'));
    assert.ok(!comment.includes('Claude Code Results:'));
});

test('GitHub comment handles different model types correctly', () => {
    const testCases = [
        {
            model: 'claude-3-opus-20240229',
            expected: 'Claude 3 Opus'
        },
        {
            model: 'claude-3-haiku-20240307',
            expected: 'Claude 3 Haiku'
        },
        {
            model: 'claude-3-5-sonnet',
            expected: 'Claude 3.5 Sonnet'
        },
        {
            model: 'unknown-model',
            expected: 'Claude (Unknown Model)'
        }
    ];
    
    testCases.forEach(({ model, expected }) => {
        const mockClaudeResult = {
            success: true,
            executionTime: 1000,
            model
        };
        
        const mockIssueRef = {
            number: 1,
            repoOwner: 'test',
            repoName: 'test'
        };
        
        const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
        assert.ok(comment.includes(`- LLM Model: ${expected}`), 
                   `Expected to find "${expected}" for model "${model}"`);
    });
});