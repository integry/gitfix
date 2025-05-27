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
 * @returns {string} Formatted prompt for Claude
 */
function generateClaudePrompt(issueRef) {
    return `Please analyze and fix the GitHub issue: #${issueRef.number}.

Follow these steps systematically:
1. Use \`gh issue view ${issueRef.number}\` to get the issue details
2. Understand the problem described in the issue
3. Search the codebase for relevant files
4. Implement the necessary changes to fix the issue
5. Write and run tests to verify the fix (if applicable)
6. Ensure code passes linting and type checking (if applicable)
7. Create a descriptive commit message and commit your changes
8. Push your branch to the remote repository
9. Create a pull request using \`gh pr create\`

Important notes:
- You are working in a git worktree environment
- Use the GitHub CLI (\`gh\`) for all GitHub-related tasks
- Always commit and push your changes before creating the PR
- For push operations, you may need to set up the remote URL with authentication
- If \`git push\` fails, try: \`git push --set-upstream origin <branch-name>\`
- For PR creation, use: \`gh pr create --title "Title" --body "Description"\`
- If authentication fails, try: \`gh auth status\` to verify setup
- Focus on completing the core functionality first, then handle git operations
- Make sure to create a meaningful branch name and PR description

CRITICAL: The main goal is to create a working pull request. If git operations fail, try alternative approaches and document the exact error messages.`;
}

/**
 * Executes Claude Code CLI in a Docker container to analyze and fix a GitHub issue
 * @param {Object} options - Execution options
 * @param {string} options.worktreePath - Path to the Git worktree containing the repository
 * @param {Object} options.issueRef - GitHub issue reference
 * @param {string} options.githubToken - GitHub authentication token
 * @returns {Promise<Object>} Claude execution result
 */
export async function executeClaudeCode({ worktreePath, issueRef, githubToken }) {
    const startTime = Date.now();
    
    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE
    }, 'Starting Claude Code execution...');

    try {
        // Generate the prompt for Claude
        const prompt = generateClaudePrompt(issueRef);
        
        // Construct Docker run command
        const dockerArgs = [
            'run',
            '--rm',
            '--security-opt', 'no-new-privileges',
            '--cap-drop', 'ALL',
            '--network', 'bridge', // Restrict network access
            
            // Mount the worktree as the workspace
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            
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