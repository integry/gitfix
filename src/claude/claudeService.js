import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getDefaultModel } from '../config/modelAliases.js';

// Configuration from environment variables
const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 minutes

/**
 * Custom error for Claude usage limits.
 * This allows the worker to catch this specific error and requeue the job.
 */
export class UsageLimitError extends Error {
  constructor(message, resetTimestamp) {
    super(message);
    this.name = 'UsageLimitError';
    this.resetTimestamp = resetTimestamp; // UNIX timestamp (seconds)
    this.retryable = true;
  }
}

/**
 * Generates a context-aware prompt for Claude Code to analyze and fix GitHub issues
 * @param {Object} issueRef - GitHub issue reference
 * @param {string} issueRef.number - Issue number
 * @param {string} issueRef.repoOwner - Repository owner
 * @param {string} issueRef.repoName - Repository name
 * @param {string} branchName - The specific branch name to use (optional)
 * @param {string} modelName - The AI model being used (optional)
 * @param {Object} issueDetails - Pre-fetched issue details (optional)
 * @returns {string} Formatted prompt for Claude
 */
function generateClaudePrompt(issueRef, branchName = null, modelName = null, issueDetails = null) {
    const branchInfo = branchName ? `\n- **BRANCH**: You are working on branch \`${branchName}\`.` : '';
    const modelInfo = modelName ? `\n- **MODEL**: This task is being processed by the \`${modelName}\` model.` : '';

    // Build issue details section if provided
    let issueDetailsSection = '';
    if (issueDetails) {
        issueDetailsSection = `

**ISSUE DETAILS (Pre-fetched for reliability):**

**Title:** ${issueDetails.title || 'N/A'}

**Description:**
${issueDetails.body || 'No description provided'}

**Labels:** ${issueDetails.labels?.map(l => l.name).join(', ') || 'None'}

**Created by:** @${issueDetails.user?.login || 'unknown'}
**Created at:** ${issueDetails.created_at || 'unknown'}`;

        // Add comments if available
        if (issueDetails.comments && issueDetails.comments.length > 0) {
            issueDetailsSection += `\n\n**Comments (${issueDetails.comments.length} total):**\n`;
            issueDetails.comments.forEach((comment, index) => {
                issueDetailsSection += `\n---\n**Comment ${index + 1}** by @${comment.user?.login || 'unknown'} (${comment.created_at || 'unknown'}):\n${comment.body || 'Empty comment'}\n`;
            });
        } else {
            issueDetailsSection += `\n\n**Comments:** No comments on this issue yet.`;
        }

        issueDetailsSection += `\n\n**Note:** The above issue details have been automatically injected. You can still use \`gh issue view ${issueRef.number}\` if you need to fetch any additional information or verify the details.`;
    }

    return `Please analyze and implement a solution for GitHub issue #${issueRef.number}.

**REPOSITORY INFORMATION:**
- Repository Owner: ${issueRef.repoOwner}
- Repository Name: ${issueRef.repoName}
- Full Repository: ${issueRef.repoOwner}/${issueRef.repoName}${branchInfo}${modelInfo}${issueDetailsSection}

**YOUR FOCUS: IMPLEMENTATION ONLY**

The git workflow (branching, committing, pushing, PR creation) is handled automatically by the system. Your job is to focus solely on implementing the solution.

Follow these steps systematically:
1. ${issueDetails ? 'Review the pre-fetched issue details above' : `Use \`gh issue view ${issueRef.number}\` to get the issue details`}
2. ${issueDetails ? '(Optional)' : ''} Use \`gh issue view ${issueRef.number} --comments\` to ${issueDetails ? 'fetch any additional comments or verify the information' : 'read all issue comments for additional context'}
3. **Pay attention to any images, screenshots, or attachments** in the issue description and comments - these often contain crucial visual information like UI mockups, error screenshots, or design specifications
4. Understand the complete problem described in the issue, comments, and any visual materials
5. Search the codebase to understand the current implementation
6. Implement the necessary changes to solve the issue
7. Test your implementation (if applicable and possible)
8. Ensure code follows existing patterns and conventions

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
 * Generates a prompt for Claude to analyze a task description and create GitHub issues
 * @param {string} taskDescription - The raw text blob describing the tasks
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} worktreePath - Path to the Git worktree containing the repository
 * @returns {string} Formatted prompt for Claude
 */
export function generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreePath) {
    return `You are an expert software analyst. Your task is to convert code change requests into detailed GitHub issue specifications for the **${repoOwner}/${repoName}** repo, so a junior developer can implement them. If the issue specification with comments is already defined, publish it directly to Github without modifications, otherwise carefully analyze the request first and then publish the issues.

You are working in a git worktree at '${worktreePath}' which contains the full source code for analysis and planning.

You MUST publish issues and their respective comments using gh commands:

1. **Create an Issue:** The issue body must contain:
   * A detailed task description and context.
   * Clear, step-by-step implementation instructions.
2. **Add a Comment:** After creating the issue and capturing its ID/number, add a separate comment to that issue containing the suggested implementation code (use diffs where possible).
3. **Multi-Issue Tasks:** If the work is significant, break it into multiple issues. When doing so, the issue description must reference the previous issue ID and describe the epic's overall goal and current stage. Prefer a single issue when possible.

**YOUR FOCUS: ANALYSIS AND 'gh' COMMANDS ONLY**
- You have read-only access to the codebase for planning.
- DO NOT implement any code changes.
- DO NOT use git commands (add, commit, push).
- Your *only* output should be the bash script using 'gh' commands to create the issues.

Here is the user's request:
---
${taskDescription}
---`;
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
 * @param {Object} options.issueDetails - Pre-fetched issue details (optional)
 * @returns {Promise<Object>} Claude execution result
 */
export async function executeClaudeCode({ worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, issueDetails }) {
    const startTime = Date.now();

    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE,
        isRetry,
        retryReason
    }, isRetry ? 'Starting Claude Code execution (RETRY)...' : 'Starting Claude Code execution...');

    let worktreeGitContent = null;
    let mainRepoPath = null;

    try {
        // Generate the prompt for Claude
        const basePrompt = customPrompt || generateClaudePrompt(issueRef, branchName, modelName, issueDetails);

        // Add critical safety instructions to prevent git repository corruption
        const prompt = `${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do not try destructive recovery methods
- NOTE: You may encounter permission errors when trying to commit - this is expected
- The system will automatically commit your changes after you complete the modifications`;

        logger.debug({
            issueNumber: issueRef.number,
            promptLength: prompt.length,
            hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'),
            isCustomPrompt: !!customPrompt
        }, 'Generated Claude prompt with safety rules');

        if (isRetry) {
            logger.info({
                issueNumber: issueRef.number,
                retryReason,
                promptLength: prompt.length
            }, 'Using enhanced prompt for retry execution');
        }

        // Ensure worktree files are owned by UID 1000 (node user in container)
        try {
            await executeDockerCommand('sudo', ['chown', '-R', '1000:1000', worktreePath], {
                timeout: 10000 // 10 seconds should be enough
            });
            logger.debug({
                issueNumber: issueRef.number,
                worktreePath
            }, 'Set worktree ownership to UID 1000 for container compatibility');
        } catch (chownError) {
            logger.warn({
                issueNumber: issueRef.number,
                worktreePath,
                error: chownError.message
            }, 'Failed to set worktree ownership - container may have permission issues');
        }

        // No longer need temporary Claude config directory as we mount directly
        // This entire block can be removed since we're using direct mount approach

            // Verify worktree .git file before Docker execution
            const worktreeGitPath = path.join(worktreePath, '.git');

            try {
                if (fs.existsSync(worktreeGitPath)) {
                    const stats = fs.statSync(worktreeGitPath);
                    if (stats.isFile()) {
                        worktreeGitContent = fs.readFileSync(worktreeGitPath, 'utf8').trim();
                        const gitdirMatch = worktreeGitContent.match(/gitdir:\s*(.+)/);
                        if (gitdirMatch) {
                            mainRepoPath = gitdirMatch[1].trim();
                        }
                        logger.debug({
                            issueNumber: issueRef.number,
                            worktreeGitPath,
                            worktreeGitContent,
                            mainRepoPath,
                            mainRepoExists: mainRepoPath ? fs.existsSync(mainRepoPath) : false
                        }, 'Verified worktree .git file structure');
                    } else {
                        logger.error({
                            issueNumber: issueRef.number,
                            worktreeGitPath,
                            isDirectory: stats.isDirectory()
                        }, 'CRITICAL: Worktree .git is a directory, not a file! This will cause git init disasters');
                    }
                } else {
                    logger.warn({
                        issueNumber: issueRef.number,
                        worktreeGitPath
                    }, 'Worktree .git file not found - this may cause issues');
                }
            } catch (verifyError) {
                logger.error({
                    issueNumber: issueRef.number,
                    error: verifyError.message
                }, 'Failed to verify worktree structure');
            }

        // Construct Docker run command
        const dockerArgs = [
            'run',
            '--rm',
            '--security-opt', 'no-new-privileges',
            // Remove cap-drop ALL to allow chown
            '--cap-add', 'CHOWN',
            '--network', 'bridge', // Restrict network access

            // Run as root initially to fix permissions, then drop to node user
            '--user', '0:0',

            // Mount the worktree as the workspace with proper ownership
            '-v', `${worktreePath}:/home/node/workspace:rw`,

            // Mount the git-processor base directory that contains both clones and worktrees
            // This ensures worktree .git files can reference the main repository
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',

            // Mount the claude-logs directory for log persistence across containers
            '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',

            // Mount the actual Claude config directory directly (read-write so Claude can create project dirs)
            '-v', `${CLAUDE_CONFIG_PATH}:/home/node/.claude:rw`,
            // Also mount .claude.json if it exists
            ...(fs.existsSync(path.join(os.homedir(), '.claude.json')) ?
                ['-v', `${path.join(os.homedir(), '.claude.json')}:/home/node/.claude.json:rw`] : []),

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

        // Log Docker mount details for debugging
        const mounts = [];
        for (let i = 0; i < dockerArgs.length; i++) {
            if (dockerArgs[i] === '-v' && i + 1 < dockerArgs.length) {
                const [source, dest] = dockerArgs[i + 1].split(':');
                mounts.push({
                    source,
                    destination: dest,
                    sourceExists: fs.existsSync(source),
                    sourceType: fs.existsSync(source) ? (fs.statSync(source).isDirectory() ? 'directory' : 'file') : 'missing'
                });
            }
        }

        logger.debug({
            issueNumber: issueRef.number,
            dockerArgs: dockerArgs, // Show full command
            mounts,
            workDir: '/home/node/workspace',
            modelName: modelName || 'default',
            promptLength: prompt.length,
            promptPreview: prompt.substring(0, 200) + '...'
        }, 'Executing Docker command for Claude Code with detailed mount info');

        // Execute Docker command
        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath
        });

        const executionTime = Date.now() - startTime;

        // No cleanup needed since we're using direct mount approach

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

                        // CRITICAL: Check for Usage Limit error provided in the result stream
                        if (jsonLine.result) {
                            const limitMatch = jsonLine.result.match(/Claude AI usage limit reached\|(\d+)/);
                            if (limitMatch && limitMatch[1]) {
                                const resetTimestamp = parseInt(limitMatch[1], 10);
                                logger.warn({ resetTimestamp }, 'Claude usage limit reached. Throwing specific error for requeue.');
                                throw new UsageLimitError(
                                    `Claude usage limit reached. Limit resets at timestamp ${resetTimestamp}.`,
                                    resetTimestamp
                                );
                            }
                        }
                        
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
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel(), // Default to current Sonnet
            finalResult: claudeOutput.finalResult,

            // Extract specific fields if available in Claude's structured output
            modifiedFiles: [], // Will be determined by file system inspection
            commitMessage: null, // Will be extracted from conversation if present
            summary: claudeOutput.finalResult?.result || null,
            
            // Include the prompt for debugging and display
            prompt: prompt
        };
        
        // Store the prompt in Redis with execution identifiers for later retrieval
        if (claudeOutput.sessionId || claudeOutput.conversationId) {
            try {
                const Redis = await import('ioredis');
                const redis = new Redis.default({
                    host: process.env.REDIS_HOST || 'redis',
                    port: process.env.REDIS_PORT || 6379
                });
                
                // Store prompt with multiple keys for flexible retrieval
                const promptData = {
                    prompt: prompt,
                    timestamp: new Date().toISOString(),
                    issueRef: issueRef,
                    sessionId: claudeOutput.sessionId,
                    conversationId: claudeOutput.conversationId,
                    model: response.model,
                    isRetry: isRetry,
                    retryReason: retryReason
                };
                
                const promptKeys = [];
                
                // Key by sessionId (most unique)
                if (claudeOutput.sessionId) {
                    const sessionKey = `execution:prompt:session:${claudeOutput.sessionId}`;
                    await redis.set(sessionKey, JSON.stringify(promptData), 'EX', 86400 * 30); // 30 days
                    promptKeys.push(sessionKey);
                }
                
                // Key by conversationId
                if (claudeOutput.conversationId) {
                    const conversationKey = `execution:prompt:conversation:${claudeOutput.conversationId}`;
                    await redis.set(conversationKey, JSON.stringify(promptData), 'EX', 86400 * 30);
                    promptKeys.push(conversationKey);
                }
                
                // Also store by issue/timestamp for listing all executions
                const timestamp = Date.now();
                const issueKey = `execution:prompt:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${timestamp}`;
                await redis.set(issueKey, JSON.stringify(promptData), 'EX', 86400 * 30);
                promptKeys.push(issueKey);
                
                logger.info({
                    issueNumber: issueRef.number,
                    sessionId: claudeOutput.sessionId,
                    conversationId: claudeOutput.conversationId,
                    promptKeys: promptKeys,
                    promptLength: prompt.length
                }, 'Stored execution prompt in Redis with unique identifiers');
                
                await redis.quit();
            } catch (redisError) {
                logger.warn({
                    issueNumber: issueRef.number,
                    error: redisError.message
                }, 'Failed to store execution prompt in Redis - continuing');
            }
        }

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
                stderrLength: result.stderr?.length || 0,
                stdoutLength: result.stdout?.length || 0,
                hasConversationLog: !!response.conversationLog?.length,
                conversationTurns: response.conversationLog?.length || 0,
                model: response.model,
                summary: response.summary?.substring(0, 200)
            }, 'Claude Code execution succeeded');

            // Verify worktree state after execution
            try {
                const postExecGitPath = path.join(worktreePath, '.git');
                if (fs.existsSync(postExecGitPath)) {
                    const postStats = fs.statSync(postExecGitPath);
                    const isNowDirectory = postStats.isDirectory();

                    if (isNowDirectory) {
                        logger.error({
                            issueNumber: issueRef.number,
                            worktreePath,
                            preExecType: worktreeGitContent ? 'file' : 'unknown',
                            postExecType: 'directory'
                        }, 'CRITICAL: Worktree .git was converted from file to directory! Claude may have run git init');

                        // Check for signs of git init
                        const gitConfigPath = path.join(postExecGitPath, 'config');
                        if (fs.existsSync(gitConfigPath)) {
                            const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
                            logger.error({
                                issueNumber: issueRef.number,
                                gitConfigPreview: gitConfig.substring(0, 200)
                            }, 'Found git config in new .git directory - git init was definitely run');
                        }
                    } else {
                        const postContent = fs.readFileSync(postExecGitPath, 'utf8').trim();
                        if (postContent !== worktreeGitContent) {
                            logger.warn({
                                issueNumber: issueRef.number,
                                preContent: worktreeGitContent,
                                postContent: postContent
                            }, 'Worktree .git file content changed during execution');
                        }
                    }
                }
            } catch (postVerifyError) {
                logger.error({
                    issueNumber: issueRef.number,
                    error: postVerifyError.message
                }, 'Failed to verify worktree state after execution');
            }
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
    } finally {
        // Cleanup moved to after Docker execution completes
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

/**
 * Generates a prompt for Claude to analyze task import requests and create GitHub issues
 * @param {string} taskDescription - The raw text description from the user
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} worktreePath - Path to the git worktree
 * @returns {string} Formatted prompt for Claude to create GitHub issues
 */
export function generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreePath) {
    return `You are an expert software analyst. Your task is to convert code change requests into detailed GitHub issue specifications for the **${repoOwner}/${repoName}** repo, so a junior developer can implement them. If the issue specification with comments is already defined, publish it directly to Github without modifications, otherwise carefully analyze the request first and then publish the issues.

You are working in a git worktree at '${worktreePath}' which contains the full source code for analysis and planning.

You MUST publish issues and their respective comments using gh commands:

1.  **Create an Issue:** The issue body must contain:
    * A detailed task description and context.
    * Clear, step-by-step implementation instructions.
2.  **Add a Comment:** After creating the issue and capturing its ID/number, add a separate comment to that issue containing the suggested implementation code (use diffs where possible).
3.  **Multi-Issue Tasks:** If the work is significant, break it into multiple issues. When doing so, the issue description must reference the previous issue ID and describe the epic's overall goal and current stage. Prefer a single issue when possible.

**YOUR FOCUS: ANALYSIS AND 'gh' COMMANDS ONLY**
-   You have read-only access to the codebase for planning.
-   DO NOT implement any code changes.
-   DO NOT use git commands (add, commit, push).
-   Your *only* output should be the bash script using 'gh' commands to create the issues.

Here is the user's request:
---
${taskDescription}
---`;
}