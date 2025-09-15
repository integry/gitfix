import { AIProviderInterface } from '../aiProviderInterface.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../../utils/logger.js';

/**
 * OpenAI provider implementation using direct API calls
 */
export class OpenAIProvider extends AIProviderInterface {
    constructor(config = {}) {
        super(config);
        this.providerName = 'openai';
        this.supportedModels = [
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-4',
            'gpt-3.5-turbo'
        ];
        this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
        this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
        this.timeout = config.timeout || 300000; // 5 minutes
    }

    async validateConfiguration() {
        if (!this.apiKey) {
            logger.error('OpenAI API key not provided');
            return false;
        }

        try {
            // Test API connection with a simple request
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                logger.error({ status: response.status }, 'OpenAI API validation failed');
                return false;
            }

            logger.info('OpenAI provider configuration validated successfully');
            return true;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to validate OpenAI configuration');
            return false;
        }
    }

    async executeCode({ worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName }) {
        const startTime = Date.now();
        const model = modelName || this.getDefaultModel();

        logger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            worktreePath,
            model,
            provider: this.providerName,
            isRetry,
            retryReason
        }, isRetry ? 'Starting OpenAI execution (RETRY)...' : 'Starting OpenAI execution...');

        try {
            // Generate the prompt
            const basePrompt = customPrompt || this.generatePrompt(issueRef, branchName, model);
            
            // Add safety instructions
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
                model,
                isCustomPrompt: !!customPrompt
            }, 'Generated OpenAI prompt with safety rules');

            // Create a temporary script to execute the OpenAI interaction
            const tempScriptPath = await this.createExecutionScript({
                worktreePath,
                prompt,
                model,
                githubToken,
                issueRef
            });

            // Execute the script
            const result = await this.executeScript(tempScriptPath, {
                timeout: this.timeout,
                cwd: worktreePath
            });

            const executionTime = Date.now() - startTime;

            logger.info({
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                executionTime,
                success: result.exitCode === 0,
                exitCode: result.exitCode,
                model
            }, 'OpenAI execution completed');

            // Parse the result
            const response = this.parseExecutionResult(result, model, executionTime);

            // Clean up temporary script
            try {
                fs.unlinkSync(tempScriptPath);
            } catch (cleanupError) {
                logger.warn({ error: cleanupError.message }, 'Failed to cleanup temporary script');
            }

            return response;

        } catch (error) {
            const executionTime = Date.now() - startTime;
            
            logger.error({
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                executionTime,
                error: error.message,
                stack: error.stack,
                provider: this.providerName
            }, 'Error during OpenAI execution');

            return {
                success: false,
                error: error.message,
                executionTime,
                output: null,
                logs: error.message,
                exitCode: 1,
                rawOutput: '',
                conversationLog: [],
                sessionId: null,
                conversationId: null,
                model: model,
                finalResult: null,
                modifiedFiles: [],
                commitMessage: null,
                summary: null
            };
        }
    }

    async createExecutionScript({ worktreePath, prompt, model, githubToken, issueRef }) {
        const scriptTemplate = `#!/bin/bash
set -e

# Set environment variables
export GH_TOKEN="${githubToken}"
export OPENAI_API_KEY="${this.apiKey}"
export PYTHONPATH="/usr/local/lib/python3.11/site-packages"

# Change to worktree directory
cd "${worktreePath}"

# Create Python script for OpenAI interaction
cat > /tmp/openai_executor.py << 'EOF'
import os
import json
import subprocess
import sys
import time
from openai import OpenAI

def execute_command(command, cwd=None):
    """Execute a shell command and return the result"""
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "stdout": "",
            "stderr": "Command timed out",
            "returncode": 124
        }
    except Exception as e:
        return {
            "success": False,
            "stdout": "",
            "stderr": str(e),
            "returncode": 1
        }

def main():
    client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY'))
    
    # Initial system message with instructions
    system_message = """You are an AI coding assistant that helps fix GitHub issues. You have access to a shell environment where you can:
1. Use 'gh' commands to interact with GitHub (already authenticated)
2. Use standard shell commands to navigate and modify files
3. Use git commands for version control (but DO NOT run git init or delete .git)

Your task is to analyze the GitHub issue and implement the necessary changes. When you need to run a command, use the format:
EXECUTE: command_here

I will run the command and provide you with the output. Continue this process until the issue is resolved.

IMPORTANT SAFETY RULES:
- NEVER run 'rm .git' or 'git init'
- Be careful with destructive operations
- Focus only on implementing the solution to the issue
"""

    messages = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": """${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"""}
    ]
    
    conversation_log = []
    max_turns = 20
    turn = 0
    
    print(f"Starting OpenAI execution with model ${model}")
    print(f"Working directory: ${worktreePath}")
    print("=" * 50)
    
    while turn < max_turns:
        turn += 1
        print(f"\\nTurn {turn}/{max_turns}")
        
        try:
            # Get response from OpenAI
            response = client.chat.completions.create(
                model="${model}",
                messages=messages,
                max_tokens=4000,
                temperature=0.1
            )
            
            assistant_message = response.choices[0].message.content
            messages.append({"role": "assistant", "content": assistant_message})
            conversation_log.append({
                "turn": turn,
                "role": "assistant",
                "content": assistant_message,
                "model": "${model}"
            })
            
            print(f"Assistant: {assistant_message[:200]}...")
            
            # Check if the assistant wants to execute a command
            if "EXECUTE:" in assistant_message:
                # Extract commands to execute
                lines = assistant_message.split('\\n')
                commands_executed = []
                
                for line in lines:
                    if line.strip().startswith("EXECUTE:"):
                        command = line.replace("EXECUTE:", "").strip()
                        print(f"Executing: {command}")
                        
                        result = execute_command(command, "${worktreePath}")
                        commands_executed.append({
                            "command": command,
                            "result": result
                        })
                        
                        # Prepare output for the assistant
                        if result["success"]:
                            output = f"Command succeeded:\\n{result['stdout']}"
                            if result["stderr"]:
                                output += f"\\nStderr: {result['stderr']}"
                        else:
                            output = f"Command failed (exit code {result['returncode']}):\\n{result['stderr']}"
                            if result["stdout"]:
                                output += f"\\nStdout: {result['stdout']}"
                        
                        print(f"Result: {output[:200]}...")
                        
                        # Add the command result to the conversation
                        user_message = f"Command output for '{command}':\\n{output}"
                        messages.append({"role": "user", "content": user_message})
                        conversation_log.append({
                            "turn": turn,
                            "role": "user", 
                            "content": user_message,
                            "command": command,
                            "command_result": result
                        })
            else:
                # No more commands to execute, assistant is done
                print("\\nAssistant completed the task.")
                break
                
        except Exception as e:
            print(f"Error in turn {turn}: {str(e)}")
            error_message = f"An error occurred: {str(e)}"
            messages.append({"role": "user", "content": error_message})
            conversation_log.append({
                "turn": turn,
                "role": "error",
                "content": error_message
            })
            continue
    
    # Save conversation log
    log_data = {
        "model": "${model}",
        "total_turns": turn,
        "max_turns_reached": turn >= max_turns,
        "conversation": conversation_log,
        "final_message": messages[-1]["content"] if messages else None
    }
    
    with open("/tmp/openai_execution_log.json", "w") as f:
        json.dump(log_data, f, indent=2)
    
    print("\\n" + "=" * 50)
    print(f"Execution completed. Total turns: {turn}")
    print("Conversation log saved to /tmp/openai_execution_log.json")
    
    # Return success if we completed without hitting max turns
    sys.exit(0 if turn < max_turns else 1)

if __name__ == "__main__":
    main()
EOF

# Install OpenAI Python package if not already installed
python3 -c "import openai" 2>/dev/null || pip3 install openai

# Execute the Python script
python3 /tmp/openai_executor.py

# Clean up
rm -f /tmp/openai_executor.py
`;

        const tempScriptPath = path.join(os.tmpdir(), `openai-script-${issueRef.number}-${Date.now()}.sh`);
        fs.writeFileSync(tempScriptPath, scriptTemplate, { mode: 0o755 });
        
        return tempScriptPath;
    }

    async executeScript(scriptPath, options = {}) {
        return new Promise((resolve, reject) => {
            const { timeout = 300000, cwd } = options;
            
            const child = spawn('bash', [scriptPath], {
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
                    reject(new Error(`Script execution timed out after ${timeout}ms`));
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

    parseExecutionResult(result, model, executionTime) {
        let conversationLog = [];
        let sessionId = null;
        let finalResult = null;

        // Try to parse conversation log if it exists
        try {
            const logPath = '/tmp/openai_execution_log.json';
            if (fs.existsSync(logPath)) {
                const logData = JSON.parse(fs.readFileSync(logPath, 'utf8'));
                conversationLog = logData.conversation || [];
                sessionId = `openai-${Date.now()}`;
                finalResult = {
                    num_turns: logData.total_turns,
                    max_turns_reached: logData.max_turns_reached,
                    result: logData.final_message
                };
                
                // Clean up log file
                fs.unlinkSync(logPath);
            }
        } catch (parseError) {
            logger.warn({ error: parseError.message }, 'Failed to parse OpenAI execution log');
        }

        const success = result.exitCode === 0;
        let summary = null;

        // Extract summary from the last assistant message
        if (conversationLog.length > 0) {
            const lastAssistantMessage = conversationLog
                .filter(msg => msg.role === 'assistant')
                .pop();
            
            if (lastAssistantMessage) {
                summary = lastAssistantMessage.content;
            }
        }

        return {
            success,
            executionTime,
            output: {
                success,
                rawOutput: result.stdout,
                error: result.stderr,
                conversationLog,
                sessionId,
                finalResult,
                model
            },
            logs: result.stderr || '',
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            conversationLog,
            sessionId,
            conversationId: sessionId,
            model,
            finalResult,
            modifiedFiles: [], // Will be determined by file system inspection
            commitMessage: null, // Will be extracted from conversation if present
            summary
        };
    }

    getDefaultModel() {
        return 'gpt-4o';
    }
}