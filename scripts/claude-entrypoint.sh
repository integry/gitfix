#!/bin/bash
# Entrypoint script for Claude Code execution container
# Handles initialization and executes Claude Code CLI with proper security

set -e

# Skip firewall initialization for now (requires privileged container)
echo "Skipping firewall setup (would require --privileged Docker flag)"

# Ensure GitHub token is available
if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set"
    echo "GitHub operations may fail"
else
    echo "GitHub token detected, configuring gh CLI..."
    echo "$GH_TOKEN" | gh auth login --with-token
fi

# Ensure Claude config is mounted and accessible
if [ ! -f "/home/node/.claude/.credentials.json" ]; then
    echo "Warning: Claude credentials not found"
    echo "Ensure Claude config directory is properly mounted"
    echo "Expected path: /home/node/.claude/.credentials.json"
else
    echo "Claude authentication configuration found"
fi

# Set proper permissions for workspace
if [ -d "/home/node/workspace" ]; then
    # Ensure the user owns the workspace
    sudo chown -R node:node /home/node/workspace
    echo "Workspace permissions set"
fi

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@"
    exec "$@"
else
    echo "No command provided, starting interactive shell"
    exec /bin/bash
fi