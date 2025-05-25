#!/bin/bash
# Entrypoint script for Claude Code execution container
# Handles initialization and executes Claude Code CLI with proper security

set -e

# Initialize firewall if running as root or with sudo capabilities
if [ "$EUID" -eq 0 ] || sudo -n true 2>/dev/null; then
    echo "Initializing container firewall..."
    sudo /usr/local/bin/init-firewall.sh
else
    echo "Warning: Cannot initialize firewall - no sudo privileges"
    echo "Consider running container with --privileged or proper sudo setup"
fi

# Ensure GitHub token is available
if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set"
    echo "GitHub operations may fail"
else
    echo "GitHub token detected, configuring gh CLI..."
    echo "$GH_TOKEN" | gh auth login --with-token
fi

# Ensure Claude config is mounted and accessible
if [ ! -f "/home/node/.config/claude-code/auth.json" ]; then
    echo "Warning: Claude auth.json not found"
    echo "Ensure Claude config directory is properly mounted"
    echo "Expected path: /home/node/.config/claude-code/auth.json"
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