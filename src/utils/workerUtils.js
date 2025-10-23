import fs from 'fs-extra';
import path from 'path';
import logger from './logger.js';

/**
 * Formats a UNIX timestamp (seconds) into a readable string for GitHub comments
 * @param {number} resetTimestamp - UNIX timestamp in seconds
 * @returns {string} Formatted date/time string
 */
export function formatResetTime(resetTimestamp) {
    if (!resetTimestamp || typeof resetTimestamp !== 'number') {
        return 'at a later time';
    }
    const resetDate = new Date(resetTimestamp * 1000);
    return `${resetDate.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })} on ${resetDate.toLocaleDateString()}`;
}

/**
 * Adds a small random delay to prevent concurrent execution conflicts
 * @param {string} modelName - Model name to create consistent but different delays
 * @returns {Promise<void>}
 */
export function addModelSpecificDelay(modelName) {
    // Create a consistent but different delay for each model (500-2000ms)
    const baseDelay = 500;
    const modelHash = modelName.split('').reduce((hash, char) => {
        return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
    }, 0);
    const modelDelay = Math.abs(modelHash % 1500); // 0-1499ms additional delay
    const totalDelay = baseDelay + modelDelay;
    
    return new Promise(resolve => setTimeout(resolve, totalDelay));
}

/**
 * Safely removes a label from an issue, ignoring errors if label doesn't exist
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {string} labelName - Label to remove
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} - True if removed or didn't exist, false if other error
 */
export async function safeRemoveLabel(octokit, owner, repo, issueNumber, labelName, logger) {
    try {
        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
            owner,
            repo,
            issue_number: issueNumber,
            name: labelName
        });
        logger.debug(`Successfully removed label '${labelName}' from issue #${issueNumber}`);
        return true;
    } catch (error) {
        if (error.status === 404) {
            logger.debug(`Label '${labelName}' not found on issue #${issueNumber}, skipping removal`);
            return true; // Label doesn't exist, which is fine
        }
        logger.warn({ 
            error: error.message, 
            labelName, 
            issueNumber 
        }, `Failed to remove label '${labelName}' from issue #${issueNumber}`);
        return false;
    }
}

/**
 * Ensures the current directory is a git repository
 * @param {Object} logger - Logger instance
 * @returns {Promise<void>}
 */
export async function ensureGitRepository(logger) {
    try {
        const gitDir = await fs.pathExists('.git');
        if (!gitDir) {
            logger.error('Not in a git repository. Worker must run from a git repository directory.');
            throw new Error('Worker must be run from within a git repository');
        }
        
        // Also verify it's a valid git directory
        const { execSync } = await import('child_process');
        try {
            execSync('git rev-parse --git-dir', { stdio: 'ignore' });
        } catch (error) {
            logger.error('Invalid git repository detected');
            throw new Error('Current directory is not a valid git repository');
        }
    } catch (error) {
        logger.error({ error: error.message }, 'Git repository validation failed');
        throw error;
    }
}

/**
 * Safely adds a label to an issue, handling various error cases
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {string} labelName - Label to add
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} - True if added or already exists, false if error
 */
export async function safeAddLabel(octokit, owner, repo, issueNumber, labelName, logger) {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issueNumber,
            labels: [labelName]
        });
        logger.debug(`Successfully added label '${labelName}' to issue #${issueNumber}`);
        return true;
    } catch (error) {
        // Handle various GitHub API error responses
        if (error.status === 422 && error.message?.includes('already_exists')) {
            logger.debug(`Label '${labelName}' already exists on issue #${issueNumber}`);
            return true; // Label already exists, which is fine
        }
        
        if (error.status === 410) {
            logger.warn(`Issue #${issueNumber} is no longer available (deleted or locked)`);
            return false;
        }
        
        logger.error({ 
            error: error.message, 
            status: error.status,
            labelName, 
            issueNumber 
        }, `Failed to add label '${labelName}' to issue #${issueNumber}`);
        return false;
    }
}

/**
 * Updates labels on an issue - removes specified labels and adds new ones
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {string[]} labelsToRemove - Labels to remove
 * @param {string[]} labelsToAdd - Labels to add
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} - Result object with success status and details
 */
export async function safeUpdateLabels(octokit, owner, repo, issueNumber, labelsToRemove = [], labelsToAdd = [], logger) {
    const results = {
        removed: [],
        added: [],
        errors: []
    };
    
    // Remove labels first
    for (const label of labelsToRemove) {
        try {
            const removed = await safeRemoveLabel(octokit, owner, repo, issueNumber, label, logger);
            if (removed) {
                results.removed.push(label);
            } else {
                results.errors.push({ label, action: 'remove', reason: 'Failed to remove' });
            }
        } catch (error) {
            results.errors.push({ label, action: 'remove', error: error.message });
        }
    }
    
    // Then add new labels
    for (const label of labelsToAdd) {
        try {
            const added = await safeAddLabel(octokit, owner, repo, issueNumber, label, logger);
            if (added) {
                results.added.push(label);
            } else {
                results.errors.push({ label, action: 'add', reason: 'Failed to add' });
            }
        } catch (error) {
            results.errors.push({ label, action: 'add', error: error.message });
        }
    }
    
    const success = results.errors.length === 0;
    
    logger.info({
        issueNumber,
        removed: results.removed,
        added: results.added,
        errors: results.errors,
        success
    }, 'Label update completed');
    
    return {
        success,
        ...results
    };
}

/**
 * Creates log files for detailed Claude execution data
 * @param {Object} claudeResult - Result from Claude Code execution
 * @param {Object} issueRef - Issue reference
 * @returns {Promise<Object>} File paths and metadata
 */
export async function createLogFiles(claudeResult, issueRef) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = '/tmp/claude-logs';
    
    // Ensure log directory exists
    await fs.ensureDir(logDir);
    
    const filePrefix = `issue-${issueRef.number}-${timestamp}`;
    
    // Write full output log
    const fullLogPath = path.join(logDir, `${filePrefix}-full.log`);
    await fs.writeFile(fullLogPath, claudeResult.output?.rawOutput || 'No output captured');
    
    // Write conversation log if available
    let conversationPath = null;
    if (claudeResult.conversationLog && claudeResult.conversationLog.length > 0) {
        conversationPath = path.join(logDir, `${filePrefix}-conversation.json`);
        await fs.writeFile(conversationPath, JSON.stringify({
            sessionId: claudeResult.sessionId,
            conversationId: claudeResult.conversationId,
            timestamp: new Date().toISOString(),
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            messages: claudeResult.conversationLog
        }, null, 2));
    }
    
    // Write metadata
    const metadataPath = path.join(logDir, `${filePrefix}-metadata.json`);
    await fs.writeFile(metadataPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        model: claudeResult.model,
        executionTime: claudeResult.executionTime,
        success: claudeResult.success,
        modifiedFiles: claudeResult.modifiedFiles,
        sessionId: claudeResult.sessionId,
        conversationId: claudeResult.conversationId
    }, null, 2));
    
    // Write modified files list
    let modifiedFilesPath = null;
    if (claudeResult.modifiedFiles && claudeResult.modifiedFiles.length > 0) {
        modifiedFilesPath = path.join(logDir, `${filePrefix}-modified-files.txt`);
        await fs.writeFile(modifiedFilesPath, claudeResult.modifiedFiles.join('\n'));
    }
    
    logger.info({
        issueNumber: issueRef.number,
        logFiles: {
            fullLog: fullLogPath,
            conversation: conversationPath,
            metadata: metadataPath,
            modifiedFiles: modifiedFilesPath
        }
    }, 'Claude execution logs created');
    
    return {
        files: {
            full: fullLogPath,
            conversation: conversationPath,
            metadata: metadataPath,
            modifiedFiles: modifiedFilesPath
        },
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        timestamp
    };
}

/**
 * Generates a completion comment for GitHub based on Claude's results
 * @param {Object} claudeResult - Result from Claude Code execution
 * @param {Object} issueRef - Issue reference
 * @returns {Promise<string>} Formatted comment text
 */
export async function generateCompletionComment(claudeResult, issueRef) {
    let comment = '';
    
    if (claudeResult?.success) {
        comment += `✅ **AI Processing Complete**\n\n`;
        comment += `I've successfully analyzed and implemented a solution for this issue.\n\n`;
        
        if (claudeResult.modifiedFiles && claudeResult.modifiedFiles.length > 0) {
            comment += `**Files Modified:**\n`;
            claudeResult.modifiedFiles.forEach(file => {
                comment += `- \`${file}\`\n`;
            });
            comment += `\n`;
        }
        
        if (claudeResult.summary) {
            comment += `**Summary:**\n${claudeResult.summary}\n\n`;
        }
        
        comment += `**Model:** ${claudeResult.model || 'Unknown'}\n`;
        comment += `**Execution Time:** ${Math.round((claudeResult.executionTime || 0) / 1000)}s\n`;
        
        if (claudeResult.conversationId || claudeResult.sessionId) {
            comment += `\n**Session Details:**\n`;
            if (claudeResult.sessionId) {
                comment += `- Session ID: \`${claudeResult.sessionId}\`\n`;
            }
            if (claudeResult.conversationId) {
                comment += `- Conversation ID: \`${claudeResult.conversationId}\`\n`;
            }
        }
    } else {
        comment += `⚠️ **AI Processing Completed with Issues**\n\n`;
        comment += `The AI analysis was completed but encountered some challenges.\n\n`;
        
        if (claudeResult?.error) {
            comment += `**Error Details:**\n\`\`\`\n${claudeResult.error}\n\`\`\`\n\n`;
        }
        
        comment += `Please review the logs and consider manual intervention if needed.\n`;
    }
    
    return comment;
}