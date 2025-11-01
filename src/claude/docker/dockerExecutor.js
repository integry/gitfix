import { spawn } from 'child_process';
import logger from '../../utils/logger.js';

const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';

export function executeDockerCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { timeout = 300000, cwd, onSessionId, onContainerId, worktreePath } = options;

        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let sessionIdDetected = false;
        let containerIdDetected = false;
        const messageTimestamps = new Map(); // Track timestamps for conversation messages

        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');

            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 5000);
        }, timeout);

        if (command === 'docker' && args[0] === 'run' && onContainerId && worktreePath) {
            setTimeout(async () => {
                if (!containerIdDetected) {
                    try {
                        const { execSync } = await import('child_process');
                        const containersOutput = execSync(
                            `docker ps --filter "volume=${worktreePath}" --format "{{.ID}}:{{.Names}}" --latest`,
                            { encoding: 'utf8', timeout: 5000 }
                        ).trim();
                        
                        if (containersOutput) {
                            const [containerId, containerName] = containersOutput.split(':');
                            containerIdDetected = true;
                            onContainerId(containerId, containerName);
                            logger.debug({
                                containerId,
                                containerName,
                                worktreePath
                            }, 'Detected Docker container ID for Claude execution');
                        }
                    } catch (err) {
                        logger.debug({ error: err.message }, 'Failed to detect container ID');
                    }
                }
            }, 2000);
        }

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            const receiveTimestamp = new Date().toISOString();
            stdout += chunk;

            // Parse lines and capture timestamps
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const jsonLine = JSON.parse(line);

                        // Capture timestamp for conversation messages
                        if (jsonLine.type === 'assistant' || jsonLine.type === 'user') {
                            // Use message ID as key if available, otherwise use a combination of type and content hash
                            const messageKey = jsonLine.message?.id ||
                                `${jsonLine.type}-${JSON.stringify(jsonLine).substring(0, 100)}`;
                            messageTimestamps.set(messageKey, receiveTimestamp);
                        }

                        if (!sessionIdDetected && onSessionId && jsonLine.session_id) {
                            sessionIdDetected = true;
                            onSessionId(jsonLine.session_id, jsonLine.conversation_id);
                        }
                    } catch (e) {
                        // Not JSON, skip
                    }
                }
            }
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
                stderr,
                messageTimestamps // Include captured timestamps
            });
        });

        child.on('error', (error) => {
            clearTimeout(timeoutHandle);
            reject(error);
        });
    });
}

export async function buildClaudeDockerImage() {
    logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Building Claude Code Docker image...');

    try {
        const checkResult = await executeDockerCommand('docker', [
            'images', '-q', CLAUDE_DOCKER_IMAGE
        ]);

        if (checkResult.stdout.trim()) {
            logger.info({ image: CLAUDE_DOCKER_IMAGE }, 'Docker image already exists');
            return true;
        }

        const buildResult = await executeDockerCommand('docker', [
            'build',
            '-f', 'Dockerfile.claude',
            '-t', CLAUDE_DOCKER_IMAGE,
            '.'
        ], {
            timeout: 600000
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
        logger.error({
            image: CLAUDE_DOCKER_IMAGE,
            error: error.message
        }, 'Error building Docker image');
        return false;
    }
}
