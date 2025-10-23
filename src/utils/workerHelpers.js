import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import Redis from 'ioredis';
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
            issueNumber,
            status: error.status 
        }, `Failed to remove label '${labelName}' from issue #${issueNumber}`);
        return false;
    }
}

/**
 * Validates that the current working directory is a git repository
 * If not, it initializes a new git repository
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} - True if git repo is valid
 */
export async function ensureGitRepository(logger) {
    try {
        const git = simpleGit();
        
        // Check if current directory is a git repository
        const isRepo = await git.checkIsRepo();
        
        if (!isRepo) {
            logger.warn('Current directory is not a git repository. Initializing...');
            await git.init();
            logger.info('Git repository initialized successfully');
        } else {
            logger.debug('Current directory is a valid git repository');
        }
        
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to ensure git repository');
        throw error;
    }
}

/**
 * Safely adds a label to an issue, ignoring errors if label already exists
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {string} labelName - Label to add
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} - True if added or already exists, false if other error
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
        if (error.status === 422 && error.message?.includes('already exists')) {
            logger.debug(`Label '${labelName}' already exists on issue #${issueNumber}`);
            return true; // Label already exists, which is fine
        }
        logger.warn({ 
            error: error.message, 
            labelName, 
            issueNumber,
            status: error.status 
        }, `Failed to add label '${labelName}' to issue #${issueNumber}`);
        return false;
    }
}

/**
 * Safely updates issue labels with robust error handling
 * @param {Object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} issueNumber - Issue number
 * @param {Array<string>} labelsToRemove - Labels to remove
 * @param {Array<string>} labelsToAdd - Labels to add
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} - Result with success status and any errors
 */
export async function safeUpdateLabels(octokit, owner, repo, issueNumber, labelsToRemove = [], labelsToAdd = [], logger = logger) {
    const results = {
        success: true,
        removed: [],
        added: [],
        errors: []
    };

    // Remove labels
    for (const labelName of labelsToRemove) {
        const removed = await safeRemoveLabel(octokit, owner, repo, issueNumber, labelName, logger);
        if (removed) {
            results.removed.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to remove '${labelName}'`);
        }
    }

    // Add labels
    for (const labelName of labelsToAdd) {
        const added = await safeAddLabel(octokit, owner, repo, issueNumber, labelName, logger);
        if (added) {
            results.added.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to add '${labelName}'`);
        }
    }

    logger.info({
        issueNumber,
        removed: results.removed,
        added: results.added,
        errors: results.errors.length > 0 ? results.errors : undefined
    }, 'Label update completed');

    return results;
}

/**
 * Generate a completion comment for Claude execution results
 * @param {Object} claudeResult - Result from Claude execution
 * @param {Object} issueRef - Issue reference object
 * @returns {Promise<string>} Comment body
 */
export async function generateCompletionComment(claudeResult, issueRef) {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);
    
    let comment = `🤖 **AI Processing ${isSuccess ? 'Completed' : 'Failed'}**\n\n`;
    
    if (!isSuccess) {
        comment += `❌ The Claude Code execution encountered an error:\n\`\`\`\n${claudeResult.error || 'Unknown error'}\n\`\`\`\n\n`;
    } else if (!claudeResult.hasChanges) {
        comment += `ℹ️ **No changes were necessary**\n\n`;
        comment += `After analyzing the issue, Claude determined that no code changes were required.\n\n`;
    }
    
    if (claudeResult.summary) {
        comment += `## Summary\n\n${claudeResult.summary}\n\n`;
    }
    
    comment += `---\n`;
    comment += `📊 **Execution Details:**\n`;
    comment += `- Model: ${claudeResult.model || 'Unknown'}\n`;
    comment += `- Execution Time: ${executionTime}s\n`;
    
    if (claudeResult.finalResult?.num_turns) {
        comment += `- Conversation Turns: ${claudeResult.finalResult.num_turns}\n`;
    }
    
    const cost = claudeResult.finalResult?.cost_usd || claudeResult.finalResult?.total_cost_usd;
    if (cost != null) {
        comment += `- Cost: $${cost.toFixed(2)}\n`;
    }
    
    comment += `- Timestamp: ${timestamp}\n`;
    comment += `- Issue: #${issueRef.number}\n`;
    
    return comment;
}

/**
 * Creates log files from Claude execution result and stores them in Redis for retrieval
 * @param {Object} claudeResult - The result from Claude execution
 * @param {Object} issueRef - The issue reference object
 * @returns {Promise<Object>} Object containing file paths
 */
export async function createLogFiles(claudeResult, issueRef) {
    const logDir = path.join(os.tmpdir(), 'claude-logs');
    
    // Ensure log directory exists
    await fs.ensureDir(logDir);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePrefix = `issue-${issueRef.number}-${timestamp}`;
    
    const files = {};
    
    try {
        // Save raw output if available
        if (claudeResult.output) {
            const outputPath = path.join(logDir, `${filePrefix}-output.txt`);
            await fs.writeFile(outputPath, 
                typeof claudeResult.output === 'string' 
                    ? claudeResult.output 
                    : JSON.stringify(claudeResult.output, null, 2)
            );
            files.output = outputPath;
        }
        
        // Save conversation log if available
        if (claudeResult.conversationLog) {
            const conversationPath = path.join(logDir, `${filePrefix}-conversation.json`);
            await fs.writeFile(conversationPath, JSON.stringify(claudeResult.conversationLog, null, 2));
            files.conversation = conversationPath;
        }
        
        // Save error details if failed
        if (!claudeResult.success && claudeResult.error) {
            const errorPath = path.join(logDir, `${filePrefix}-error.txt`);
            await fs.writeFile(errorPath, claudeResult.error);
            files.error = errorPath;
        }
        
        // Save final result if available
        if (claudeResult.finalResult) {
            const resultPath = path.join(logDir, `${filePrefix}-result.json`);
            await fs.writeFile(resultPath, JSON.stringify(claudeResult.finalResult, null, 2));
            files.result = resultPath;
        }
        
        // Store in Redis for retrieval by API
        if (Object.keys(files).length > 0) {
            const redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379
            });
            
            const logData = {
                files,
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                timestamp,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId
            };
            
            // Store by issue number
            const issueKey = `execution:logs:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}`;
            await redis.set(issueKey, JSON.stringify(logData), 'EX', 86400 * 30); // 30 days expiry
            
            // Also store by sessionId if available
            if (claudeResult.sessionId) {
                const sessionKey = `execution:logs:session:${claudeResult.sessionId}`;
                await redis.set(sessionKey, JSON.stringify(logData), 'EX', 86400 * 30);
            }
            
            // Store by conversationId if available
            if (claudeResult.conversationId) {
                const conversationKey = `execution:logs:conversation:${claudeResult.conversationId}`;
                await redis.set(conversationKey, JSON.stringify(logData), 'EX', 86400 * 30);
            }
            
            await redis.quit();
        }
        
        logger.info({
            issueNumber: issueRef.number,
            filesCreated: Object.keys(files)
        }, 'Created log files for Claude execution');
        
        return files;
    } catch (error) {
        logger.error({
            error: error.message,
            issueNumber: issueRef.number
        }, 'Failed to create log files');
        return {};
    }
}