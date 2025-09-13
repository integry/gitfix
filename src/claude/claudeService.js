import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getDefaultModel } from '../config/modelAliases.js';
import Redis from 'ioredis';

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
 * @param {string} options.taskId - Task ID for tracking and live streaming (optional)
 * @returns {Promise<Object>} Claude execution result
 */
export async function executeClaudeCode({ worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, taskId }) {
    const startTime = Date.now();
    
    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE,
        isRetry,
        retryReason
    }, isRetry ? 'Starting Claude Code execution (RETRY)...' : 'Starting Claude Code execution...');

    let tempClaudeConfigDir = null;
    let worktreeGitContent = null;
    let mainRepoPath = null;
    
    try {
        // Generate the prompt for Claude
        const basePrompt = customPrompt || generateClaudePrompt(issueRef, branchName, modelName);
        
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
        
        // Create temporary directory for Claude config with proper permissions
        tempClaudeConfigDir = path.join('/tmp', `claude-config-${issueRef.number}-${Date.now()}`);
        try {
            // Create temp directory
            await executeDockerCommand('mkdir', ['-p', tempClaudeConfigDir], { timeout: 5000 });
            
            // Copy Claude config files
            await executeDockerCommand('cp', ['-r', `${CLAUDE_CONFIG_PATH}/.`, tempClaudeConfigDir], { timeout: 5000 });
            
            // Copy .claude.json if it exists
            const claudeJsonPath = path.join(os.homedir(), '.claude.json');
            if (fs.existsSync(claudeJsonPath)) {
                await executeDockerCommand('cp', [claudeJsonPath, path.join(tempClaudeConfigDir, '.claude.json')], { timeout: 5000 });
            }
            
            // Set proper ownership for container user (UID 1000)
            await executeDockerCommand('sudo', ['chown', '-R', '1000:1000', tempClaudeConfigDir], { timeout: 5000 });
            
            // Ensure credentials file is readable by container user
            const tempCredentialsPath = path.join(tempClaudeConfigDir, '.credentials.json');
            if (fs.existsSync(tempCredentialsPath)) {
                await executeDockerCommand('sudo', ['chmod', '644', tempCredentialsPath], { timeout: 5000 });
            }
            
            logger.debug({
                issueNumber: issueRef.number,
                tempClaudeConfigDir
            }, 'Created temporary Claude config directory with proper permissions');
            
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
        } catch (configError) {
            logger.error({
                issueNumber: issueRef.number,
                error: configError.message
            }, 'Failed to prepare Claude config for container');
            throw new Error(`Failed to prepare Claude configuration: ${configError.message}`);
        }
        
        // Construct Docker run command
        const dockerArgs = [
            'run',
            '--rm',
            '--security-opt', 'no-new-privileges',
            '--cap-drop', 'ALL',
            '--network', 'bridge', // Restrict network access
            
            // Ensure container runs as node user (UID 1000)
            '--user', '1000:1000',
            
            // Mount the worktree as the workspace with proper ownership
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            
            // Mount the git-processor base directory that contains both clones and worktrees
            // This ensures worktree .git files can reference the main repository
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',
            
            // Mount temporary Claude config directory with proper permissions
            '-v', `${tempClaudeConfigDir}:/home/node/.claude:rw`,
            // Mount .claude.json if it exists in temp directory
            ...(fs.existsSync(path.join(tempClaudeConfigDir, '.claude.json')) ? 
                ['-v', `${path.join(tempClaudeConfigDir, '.claude.json')}:/home/node/.claude.json:rw`] : []),
            
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

        // Execute Docker command with live streaming
        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath,
            taskId,
            issueRef
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
        
        // Save logs and final diff to Redis for completed tasks
        if (taskId) {
            const redisClient = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379
            });
            
            try {
                // Save the complete logs
                await redisClient.setex(`task:${taskId}:logs`, 7 * 24 * 60 * 60, result.stdout || '');
                
                // Get and save the final git diff
                const { execSync } = require('child_process');
                try {
                    const finalDiff = execSync('git diff', { cwd: worktreePath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
                    await redisClient.setex(`task:${taskId}:finalDiff`, 7 * 24 * 60 * 60, finalDiff || '');
                } catch (diffError) {
                    logger.error({ taskId, error: diffError.message }, 'Failed to get final git diff');
                }
                
                logger.info({ taskId }, 'Saved task logs and final diff to Redis');
            } catch (saveError) {
                logger.error({ taskId, error: saveError.message }, 'Failed to save task data to Redis');
            } finally {
                await redisClient.disconnect();
            }
        }

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
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel(), // Default to current Sonnet
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
        // Clean up temporary Claude config directory
        if (tempClaudeConfigDir) {
            try {
                await executeDockerCommand('rm', ['-rf', tempClaudeConfigDir], { timeout: 5000 });
                logger.debug({
                    issueNumber: issueRef.number,
                    tempClaudeConfigDir
                }, 'Cleaned up temporary Claude config directory');
            } catch (cleanupError) {
                logger.warn({
                    issueNumber: issueRef.number,
                    tempClaudeConfigDir,
                    error: cleanupError.message
                }, 'Failed to clean up temporary Claude config directory');
            }
        }
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
        const { timeout = 300000, cwd, taskId, issueRef } = options;
        
        let redisPublisher;
        
        // Set up Redis publisher for live streaming if taskId is provided
        if (taskId) {
            redisPublisher = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379
            });
        }
        
        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let diffInterval;

        // Set up periodic git diff publishing if we have taskId and cwd
        if (taskId && cwd && redisPublisher) {
            diffInterval = setInterval(async () => {
                try {
                    const { exec } = require('child_process');
                    exec('git diff', { cwd }, (error, stdout, stderr) => {
                        if (!error && stdout) {
                            redisPublisher.publish(`task-diff:${taskId}`, stdout).catch(err => {
                                logger.error({ taskId, error: err.message }, 'Failed to publish git diff to Redis');
                            });
                        }
                    });
                } catch (err) {
                    logger.error({ taskId, error: err.message }, 'Failed to run git diff');
                }
            }, 5000); // Run every 5 seconds
        }

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

        // Collect output and stream to Redis if taskId is provided
        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            
            // Publish to Redis for live streaming
            if (redisPublisher && taskId) {
                redisPublisher.publish(`task-log:${taskId}`, chunk).catch(err => {
                    logger.error({ taskId, error: err.message }, 'Failed to publish log chunk to Redis');
                });
            }
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            
            // Also publish stderr to Redis
            if (redisPublisher && taskId) {
                redisPublisher.publish(`task-log:${taskId}`, `[STDERR] ${chunk}`).catch(err => {
                    logger.error({ taskId, error: err.message }, 'Failed to publish stderr chunk to Redis');
                });
            }
        });

        child.on('close', (exitCode) => {
            clearTimeout(timeoutHandle);
            
            // Clear diff interval
            if (diffInterval) {
                clearInterval(diffInterval);
            }
            
            // Clean up Redis connection
            if (redisPublisher) {
                redisPublisher.disconnect();
            }
            
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
            
            // Clear diff interval
            if (diffInterval) {
                clearInterval(diffInterval);
            }
            
            // Clean up Redis connection on error
            if (redisPublisher) {
                redisPublisher.disconnect();
            }
            
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