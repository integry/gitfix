import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from '../../utils/logger.js';

// Configuration from environment variables
const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';

/**
 * Executes a Docker command and returns structured output
 * @param {string} command - The Docker command to execute
 * @param {string[]} args - Command arguments
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} Execution result with stdout, stderr, and exit code
 */
export function executeDockerCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const fullCommand = [command, ...args];
        logger.debug({ command: fullCommand.join(' '), options }, 'Executing Docker command');

        const dockerProcess = spawn('docker', args, {
            ...options,
            stdio: options.stdio || 'pipe'
        });

        let stdout = '';
        let stderr = '';

        if (dockerProcess.stdout) {
            dockerProcess.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                if (options.onStdout) {
                    options.onStdout(chunk);
                }
            });
        }

        if (dockerProcess.stderr) {
            dockerProcess.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;
                if (options.onStderr) {
                    options.onStderr(chunk);
                }
            });
        }

        dockerProcess.on('error', (error) => {
            logger.error({ error: error.message, command: fullCommand }, 'Docker process error');
            reject(error);
        });

        dockerProcess.on('close', (code) => {
            const result = {
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code,
                success: code === 0
            };

            if (code === 0) {
                resolve(result);
            } else {
                const error = new Error(`Docker command failed with exit code ${code}`);
                error.result = result;
                reject(error);
            }
        });
    });
}

/**
 * Builds the Claude Code Docker image if it doesn't exist
 * @returns {Promise<boolean>} True if image is ready, false otherwise
 */
export async function buildClaudeDockerImage() {
    try {
        // Check if the image already exists
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', CLAUDE_DOCKER_IMAGE]);
            if (result.stdout && result.stdout.trim()) {
                logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Docker image already exists');
                return true;
            }
        } catch (checkError) {
            logger.debug({ error: checkError.message }, 'Error checking for existing image, will attempt to build');
        }

        logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Building Claude Code Docker image...');

        // Get the directory of this module
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const dockerfilePath = path.resolve(__dirname, '../../../docker/claude-code');

        // Check if Dockerfile exists
        if (!fs.existsSync(path.join(dockerfilePath, 'Dockerfile'))) {
            logger.error({ path: dockerfilePath }, 'Dockerfile not found');
            return false;
        }

        // Build the image
        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-t', CLAUDE_DOCKER_IMAGE,
            '--platform', 'linux/amd64',
            dockerfilePath
        ], {
            onStdout: (data) => logger.debug({ output: data }, 'Docker build output'),
            onStderr: (data) => logger.debug({ output: data }, 'Docker build stderr')
        });

        if (buildResult.success) {
            logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Successfully built Claude Code Docker image');
            return true;
        } else {
            logger.error({ 
                exitCode: buildResult.exitCode,
                stderr: buildResult.stderr 
            }, 'Failed to build Claude Code Docker image');
            return false;
        }

    } catch (error) {
        logger.error({ error: error.message }, 'Error building Claude Code Docker image');
        return false;
    }
}

/**
 * Checks if Docker is available and running
 * @returns {Promise<boolean>} True if Docker is available
 */
export async function isDockerAvailable() {
    try {
        const result = await executeDockerCommand('docker', ['version', '--format', '{{.Server.Version}}']);
        logger.debug({ version: result.stdout }, 'Docker is available');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, 'Docker is not available');
        return false;
    }
}

/**
 * Gets container logs
 * @param {string} containerId - Container ID
 * @param {Object} options - Options for log retrieval
 * @returns {Promise<string>} Container logs
 */
export async function getContainerLogs(containerId, options = {}) {
    try {
        const args = ['logs'];
        
        if (options.tail) {
            args.push('--tail', options.tail.toString());
        }
        
        if (options.timestamps) {
            args.push('--timestamps');
        }
        
        args.push(containerId);
        
        const result = await executeDockerCommand('docker', args);
        return result.stdout + (result.stderr ? '\n' + result.stderr : '');
    } catch (error) {
        logger.error({ error: error.message, containerId }, 'Failed to get container logs');
        throw error;
    }
}

/**
 * Removes a Docker container
 * @param {string} containerId - Container ID to remove
 * @returns {Promise<boolean>} True if removed successfully
 */
export async function removeContainer(containerId) {
    try {
        await executeDockerCommand('docker', ['rm', '-f', containerId]);
        logger.debug({ containerId }, 'Container removed successfully');
        return true;
    } catch (error) {
        logger.warn({ error: error.message, containerId }, 'Failed to remove container');
        return false;
    }
}