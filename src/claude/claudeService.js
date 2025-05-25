import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';

// Configuration from environment variables
const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '10', 10);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 minutes

/**
 * Generates a context-aware prompt for Claude Code to analyze and fix GitHub issues
 * @param {Object} issue - GitHub issue details
 * @param {string} issue.number - Issue number
 * @param {string} issue.title - Issue title
 * @param {string} issue.body - Issue description
 * @param {string} issue.repoOwner - Repository owner
 * @param {string} issue.repoName - Repository name
 * @returns {string} Formatted prompt for Claude
 */
function generateClaudePrompt(issue) {
    return `You are an expert software engineer tasked with analyzing and fixing a GitHub issue.

## Issue Details
**Repository:** ${issue.repoOwner}/${issue.repoName}
**Issue #${issue.number}:** ${issue.title}

**Issue Description:**
${issue.body || 'No description provided.'}

## Your Task
1. **Analyze the codebase** in the current workspace directory to understand the project structure and identify relevant files
2. **Understand the issue** described above and determine what needs to be implemented or fixed
3. **Implement the necessary changes** to address the issue requirements
4. **Ensure code quality** by following existing patterns and best practices in the codebase
5. **Test your changes** if possible (write tests or verify existing tests still pass)

## Guidelines
- Focus on implementing the specific requirements mentioned in the issue
- Follow the existing code style and patterns in the project
- Make minimal, targeted changes that address the issue without breaking existing functionality
- If the issue is unclear, make reasonable assumptions and document them in your implementation
- Prioritize clean, maintainable code over complex solutions

## Workspace
The repository has been checked out to the current working directory. You have full access to read, analyze, and modify files as needed.

Please proceed with analyzing the codebase and implementing the solution for this issue.`;
}

/**
 * Executes Claude Code CLI in a Docker container to analyze and fix a GitHub issue
 * @param {Object} options - Execution options
 * @param {string} options.worktreePath - Path to the Git worktree containing the repository
 * @param {Object} options.issue - GitHub issue details
 * @param {string} options.githubToken - GitHub authentication token
 * @returns {Promise<Object>} Claude execution result
 */
export async function executeClaudeCode({ worktreePath, issue, githubToken }) {
    const startTime = Date.now();
    
    logger.info({
        issueNumber: issue.number,
        repository: `${issue.repoOwner}/${issue.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE
    }, 'Starting Claude Code execution...');

    try {
        // Generate the prompt for Claude
        const prompt = generateClaudePrompt(issue);
        
        // Construct Docker run command
        const dockerArgs = [
            'run',
            '--rm',
            '--security-opt', 'no-new-privileges',
            '--cap-drop', 'ALL',
            '--network', 'bridge', // Restrict network access
            
            // Mount the worktree as the workspace
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            
            // Mount Claude config directory (read-only for security)
            '-v', `${CLAUDE_CONFIG_PATH}:/home/node/.claude:ro`,
            
            // Pass GitHub token as environment variable
            '-e', `GH_TOKEN=${githubToken}`,
            
            // Set working directory
            '-w', '/home/node/workspace',
            
            // Use the Claude Code Docker image
            CLAUDE_DOCKER_IMAGE,
            
            // Execute Claude Code CLI with the generated prompt
            'claude',
            '-p', prompt,
            '--output-format', 'json',
            '--dangerously-skip-permissions',
            '--max-turns', CLAUDE_MAX_TURNS.toString()
        ];

        logger.debug({
            issueNumber: issue.number,
            dockerArgs: dockerArgs.slice(0, -3), // Hide the prompt for brevity
            promptLength: prompt.length
        }, 'Executing Docker command for Claude Code');

        // Execute Docker command
        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath
        });

        const executionTime = Date.now() - startTime;

        logger.info({
            issueNumber: issue.number,
            repository: `${issue.repoOwner}/${issue.repoName}`,
            executionTime,
            outputLength: result.stdout?.length || 0,
            success: result.exitCode === 0
        }, 'Claude Code execution completed');

        // Parse Claude's JSON output
        let claudeOutput;
        try {
            claudeOutput = JSON.parse(result.stdout || '{}');
        } catch (parseError) {
            logger.warn({
                issueNumber: issue.number,
                parseError: parseError.message,
                rawOutput: result.stdout?.substring(0, 500)
            }, 'Failed to parse Claude output as JSON, using raw output');
            
            claudeOutput = {
                success: result.exitCode === 0,
                rawOutput: result.stdout,
                error: result.stderr
            };
        }

        // Extract key information from Claude's response
        const response = {
            success: result.exitCode === 0,
            executionTime,
            output: claudeOutput,
            logs: result.stderr || '',
            exitCode: result.exitCode,
            
            // Extract specific fields if available in Claude's structured output
            conversationLog: claudeOutput.conversation || [],
            modifiedFiles: claudeOutput.modifiedFiles || [],
            commitMessage: claudeOutput.commitMessage || null,
            summary: claudeOutput.summary || null
        };

        if (!response.success) {
            logger.error({
                issueNumber: issue.number,
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout?.substring(0, 1000)
            }, 'Claude Code execution failed');
        }

        return response;

    } catch (error) {
        const executionTime = Date.now() - startTime;
        
        logger.error({
            issueNumber: issue.number,
            repository: `${issue.repoOwner}/${issue.repoName}`,
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