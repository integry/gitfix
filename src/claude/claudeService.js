import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';

// Configuration from environment variables
const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 minutes

/**
 * Generates a context-aware prompt for Claude Code to analyze and fix GitHub issues
 * @param {Object} issueRef - GitHub issue reference
 * @param {string} issueRef.number - Issue number
 * @param {string} issueRef.repoOwner - Repository owner
 * @param {string} issueRef.repoName - Repository name
 * @param {string} branchName - The specific branch name to use (optional)
 * @param {string} modelName - The AI model being used (optional)
 * @returns {string} Formatted prompt for Claude
 */
function generateClaudePrompt(issueRef, branchName = null, modelName = null) {
    const branchInfo = branchName ? `\n- **BRANCH**: You are working on branch \`${branchName}\`.` : '';
    const modelInfo = modelName ? `\n- **MODEL**: This task is being processed by the \`${modelName}\` model.` : '';
    
    return `Please analyze and implement a solution for GitHub issue #${issueRef.number}.

**REPOSITORY INFORMATION:**
- Repository Owner: ${issueRef.repoOwner}
- Repository Name: ${issueRef.repoName}
- Full Repository: ${issueRef.repoOwner}/${issueRef.repoName}${branchInfo}${modelInfo}

**YOUR FOCUS: IMPLEMENTATION ONLY**

The git workflow (branching, committing, pushing, PR creation) is handled automatically by the system. Your job is to focus solely on implementing the solution.

Follow these steps systematically:
1. Use \`gh issue view ${issueRef.number}\` to get the issue details
2. Use \`gh issue view ${issueRef.number} --comments\` to read all issue comments for additional context
3. Understand the complete problem described in the issue and comments
4. Search the codebase to understand the current implementation
5. Implement the necessary changes to solve the issue
6. Test your implementation (if applicable and possible)
7. Ensure code follows existing patterns and conventions

**IMPORTANT NOTES:**
- **DO NOT** worry about git operations (add, commit, push, PR creation)
- **DO NOT** use git commands or GitHub CLI for workflow operations
- **FOCUS ONLY** on implementing the solution to the problem
- You are working in a git worktree environment with the codebase ready
- Make your changes directly to the files that need modification
- The system will automatically handle committing, pushing, and creating a PR
- Include a brief summary of what you implemented when you're done

**SUCCESS CRITERIA:**
Your task is complete when you have implemented a working solution to the issue. The git workflow and PR creation will be handled automatically by the system after your implementation.`;
}

/**
 * Executes Claude Code CLI in a Docker container to analyze and fix a GitHub issue
 * @param {Object} options - Execution options
 * @param {string} options.worktreePath - Path to the Git worktree containing the repository
 * @param {Object} options.issueRef - GitHub issue reference
 * @param {string} options.githubToken - GitHub authentication token
 * @param {string} options.customPrompt - Custom prompt to use instead of default (optional)
 * @param {boolean} options.isRetry - Whether this is a retry attempt (optional)
 * @param {string} options.retryReason - Reason for retry (optional)
 * @param {string} options.branchName - The specific branch name to use (optional)
 * @param {string} options.modelName - The AI model being used (optional)
 * @returns {Promise<Object>} Claude execution result
 */
export async function executeClaudeCode({ worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName }) {
    const startTime = Date.now();
    
    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE,
        isRetry,
        retryReason
    }, isRetry ? 'Starting Claude Code execution (RETRY)...' : 'Starting Claude Code execution...');

    try {
        // Generate the prompt for Claude
        const prompt = customPrompt || generateClaudePrompt(issueRef, branchName, modelName);
        
        if (isRetry) {
            logger.info({
                issueNumber: issueRef.number,
                retryReason,
                promptLength: prompt.length
            }, 'Using enhanced prompt for retry execution');
        }
        
        // Construct Docker run command
        const dockerArgs = [
            'run',
            '--rm',
            '--security-opt', 'no-new-privileges',
            '--cap-drop', 'ALL',
            '--network', 'bridge', // Restrict network access
            
            // Mount the worktree as the workspace
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            
            // Mount the main git repository to fix worktree references
            '-v', `${path.dirname(path.dirname(worktreePath))}:/tmp/git-processor:rw`,
            
            // Mount Claude config directory and main config file
            '-v', `${CLAUDE_CONFIG_PATH}:/home/node/.claude:rw`,
            '-v', `${path.join(os.homedir(), '.claude.json')}:/home/node/.claude.json:rw`,
            
            // Pass GitHub token as environment variable
            '-e', `GH_TOKEN=${githubToken}`,
            
            // Set working directory
            '-w', '/home/node/workspace',
            
            // Use the Claude Code Docker image
            CLAUDE_DOCKER_IMAGE,
            
            // Execute Claude Code CLI with the generated prompt
            'claude',
            '-p', prompt,
            '--max-turns', CLAUDE_MAX_TURNS.toString(),
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions'
        ];
        
        // Add model specification if provided
        if (modelName) {
            dockerArgs.splice(-6, 0, '--model', modelName);
            logger.info({
                issueNumber: issueRef.number,
                requestedModel: modelName
            }, 'Using specific model for Claude Code execution');
        } else {
            logger.debug({
                issueNumber: issueRef.number
            }, 'No model specified, Claude Code will use default');
        }

        logger.debug({
            issueNumber: issueRef.number,
            dockerArgs: dockerArgs, // Show full command
            promptLength: prompt.length,
            fullPrompt: prompt
        }, 'Executing Docker command for Claude Code');

        // Execute Docker command
        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath
        });

        const executionTime = Date.now() - startTime;

        logger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            outputLength: result.stdout?.length || 0,
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            fullStdout: result.stdout,
            fullStderr: result.stderr
        }, 'Claude Code execution completed');

        // Parse Claude's stream-json output
        let claudeOutput = {
            success: result.exitCode === 0,
            rawOutput: result.stdout,
            error: result.stderr,
            conversationLog: [],
            sessionId: null,
            finalResult: null
        };
        
        // Parse stream-json output line by line
        if (result.stdout) {
            const lines = result.stdout.split('\n').filter(line => line.trim());
            for (const line of lines) {
                try {
                    const jsonLine = JSON.parse(line);
                    
                    // Collect conversation messages
                    if (jsonLine.type === 'user' || jsonLine.type === 'assistant') {
                        claudeOutput.conversationLog.push(jsonLine);
                        
                        // Extract model from assistant messages
                        if (jsonLine.type === 'assistant' && jsonLine.message?.model) {
                            claudeOutput.model = jsonLine.message.model;
                        }
                    }
                    
                    // Extract session ID
                    if (jsonLine.session_id) {
                        claudeOutput.sessionId = jsonLine.session_id;
                    }
                    
                    // Extract conversation ID if available
                    if (jsonLine.conversation_id) {
                        claudeOutput.conversationId = jsonLine.conversation_id;
                    }
                    
                    // Extract model information if available
                    if (jsonLine.model) {
                        claudeOutput.model = jsonLine.model;
                    }
                    
                    // Extract final result
                    if (jsonLine.type === 'result') {
                        claudeOutput.finalResult = jsonLine;
                        claudeOutput.success = !jsonLine.is_error;
                        
                        // Also check for model info in final result
                        if (jsonLine.model) {
                            claudeOutput.model = jsonLine.model;
                        }
                        if (jsonLine.conversation_id) {
                            claudeOutput.conversationId = jsonLine.conversation_id;
                        }
                    }
                } catch (parseError) {
                    // Skip non-JSON lines (like entrypoint output)
                    continue;
                }
            }
        }

        // Extract key information from Claude's response
        const response = {
            success: claudeOutput.success,
            executionTime,
            output: claudeOutput,
            logs: result.stderr || '',
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            
            // Extract conversation and session info
            conversationLog: claudeOutput.conversationLog || [],
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model: claudeOutput.model || process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022', // Default to current Sonnet
            finalResult: claudeOutput.finalResult,
            
            // Extract specific fields if available in Claude's structured output
            modifiedFiles: [], // Will be determined by file system inspection
            commitMessage: null, // Will be extracted from conversation if present
            summary: claudeOutput.finalResult?.result || null
        };

        if (!response.success) {
            logger.error({
                issueNumber: issueRef.number,
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout
            }, 'Claude Code execution failed');
        } else {
            logger.info({
                issueNumber: issueRef.number,
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout
            }, 'Claude Code execution succeeded - full output');
        }

        return response;

    } catch (error) {
        const executionTime = Date.now() - startTime;
        
        logger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            error: error.message,
            stack: error.stack
        }, 'Error during Claude Code execution');

        return {
            success: false,
            error: error.message,
            executionTime,
            output: null,
            logs: error.stderr || error.message
        };
    }
}

/**
 * Executes a Docker command and returns the result
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} Execution result
 */
function executeDockerCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd } = options;
        
        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        // Set up timeout
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            
            // Force kill if SIGTERM doesn't work
            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 5000);
        }, timeout);

        // Collect output
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (exitCode) => {
            clearTimeout(timeoutHandle);
            
            if (timedOut) {
                reject(new Error(`Command timed out after ${timeout}ms`));
                return;
            }

            resolve({
                exitCode,
                stdout,
                stderr
            });
        });

        child.on('error', (error) => {
            clearTimeout(timeoutHandle);
            reject(error);
        });
    });
}

/**
 * Builds the Claude Code Docker image if it doesn't exist
 * @returns {Promise<boolean>} True if build was successful
 */
export async function buildClaudeDockerImage() {
    logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Building Claude Code Docker image...');

    try {
        // Check if image already exists
        const checkResult = await executeDockerCommand('docker', [
            'images', '-q', CLAUDE_DOCKER_IMAGE
        ]);

        if (checkResult.stdout.trim()) {
            logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Docker image already exists');
            return true;
        }

        // Build the image
        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-f', 'Dockerfile.claude',
            '-t', CLAUDE_DOCKER_IMAGE,
            '.'
        ], {
            timeout: 600000 // 10 minutes for build
        });

        if (buildResult.exitCode === 0) {
            logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Docker image built successfully');
            return true;
        } else {
            logger.error({
                image: CLAUDE_DOCKER_IMAGE,
                exitCode: buildResult.exitCode,
                stderr: buildResult.stderr
            }, 'Failed to build Docker image');
            return false;
        }

    } catch (error) {
        handleError(error, 'Error building Claude Docker image');
        return false;
    }
}