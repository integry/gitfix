# AI Provider Configuration

GitFix now supports multiple AI providers beyond Claude, including OpenAI (GPT models) and Google Gemini. This document explains how to configure and use different AI providers.

## Supported Providers

### 1. Claude (Anthropic) - Default
- **Models**: Opus 4, Sonnet 4, Sonnet 3.7, Sonnet 3.5, Haiku 3.5, Haiku 3
- **Integration**: Native Claude Code CLI
- **Status**: Default provider, fully supported

### 2. OpenAI
- **Models**: GPT-4o, GPT-4o Mini, GPT-4 Turbo, GPT-4, GPT-3.5 Turbo
- **Integration**: Direct API calls
- **Status**: Full support

### 3. Google Gemini
- **Models**: Gemini 1.5 Pro, Gemini 1.5 Flash, Gemini 1.0 Pro
- **Integration**: Google AI API
- **Status**: Full support

## Environment Variables

### OpenAI Configuration
```bash
# Required: OpenAI API key
OPENAI_API_KEY=sk-your-api-key-here

# Optional: Custom API base URL (for Azure OpenAI, etc.)
OPENAI_BASE_URL=https://api.openai.com/v1

# Optional: Request timeout (default: 300000ms = 5 minutes)
OPENAI_TIMEOUT_MS=300000
```

### Google Gemini Configuration
```bash
# Required: Google AI API key
GOOGLE_AI_API_KEY=your-google-ai-api-key

# Optional: Custom API base URL
GOOGLE_AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta

# Optional: Request timeout (default: 300000ms = 5 minutes)
GEMINI_TIMEOUT_MS=300000
```

### Label Pattern Configuration
```bash
# Claude labels (default: ^llm-claude-(.+)$)
CLAUDE_LABEL_PATTERN=^llm-claude-(.+)$

# OpenAI labels (default: ^llm-openai-(.+)$)
OPENAI_LABEL_PATTERN=^llm-openai-(.+)$

# Gemini labels (default: ^llm-gemini-(.+)$)
GEMINI_LABEL_PATTERN=^llm-gemini-(.+)$

# Legacy pattern for backward compatibility
MODEL_LABEL_PATTERN=^llm-claude-(.+)$
```

## Model Aliases

The system includes convenient aliases for all supported models:

### Claude Models
- `opus`, `opus4`, `opus-4-0` → `claude-opus-4-20250514`
- `sonnet`, `sonnet4`, `sonnet-4-0` → `claude-sonnet-4-20250514` (default)
- `sonnet37` → `claude-3-7-sonnet-20250219`
- `sonnet35` → `claude-3-5-sonnet-20241022`
- `haiku`, `haiku35` → `claude-3-5-haiku-20241022`
- `haiku3` → `claude-3-haiku-20240307`

### OpenAI Models
- `gpt4`, `gpt4o` → `gpt-4o`
- `gpt4o-mini` → `gpt-4o-mini`
- `gpt4-turbo` → `gpt-4-turbo`
- `gpt4-classic` → `gpt-4`
- `gpt35`, `gpt3.5`, `chatgpt` → `gpt-3.5-turbo`

### Gemini Models
- `gemini`, `gemini-pro`, `gemini15` → `gemini-1.5-pro`
- `gemini-flash`, `gemini15-flash` → `gemini-1.5-flash`
- `gemini-legacy`, `gemini10` → `gemini-1.0-pro`

## Using Different Providers

### GitHub Issue Labels

Add labels to your GitHub issues to specify which AI provider and model to use:

#### Claude (existing behavior)
```
llm-claude-sonnet      # Uses Claude Sonnet 4
llm-claude-opus        # Uses Claude Opus 4
llm-claude-haiku       # Uses Claude Haiku 3.5
```

#### OpenAI
```
llm-openai-gpt4        # Uses GPT-4o
llm-openai-gpt4o-mini  # Uses GPT-4o Mini
llm-openai-gpt35       # Uses GPT-3.5 Turbo
```

#### Gemini
```
llm-gemini-pro         # Uses Gemini 1.5 Pro
llm-gemini-flash       # Uses Gemini 1.5 Flash
llm-gemini-legacy      # Uses Gemini 1.0 Pro
```

### Default Behavior

If no model-specific label is found, the system uses the default model (Claude Sonnet 4).

## Provider-Specific Features

### Claude
- **Docker Integration**: Uses Claude Code CLI in a secure container
- **Native Git Operations**: Full git worktree support
- **Streaming Output**: Real-time progress updates
- **Safety Features**: Built-in git safety rules

### OpenAI
- **Direct API**: Uses OpenAI's chat completions API
- **Command Execution**: Interactive shell command execution
- **Conversation Logging**: Full conversation history
- **Model Flexibility**: Supports all GPT models

### Gemini
- **Google AI API**: Uses Google's generative AI API
- **Multi-turn Conversations**: Supports complex interactions
- **Cost Efficient**: Competitive pricing
- **Fast Response**: Quick model responses

## Monitoring and Logging

All providers generate comprehensive logs including:
- Execution time
- Model used
- Conversation turns
- Success/failure status
- Cost information (where available)

Logs are stored in `/tmp/claude-logs/` (for compatibility, all providers use this directory).

## Troubleshooting

### Common Issues

1. **API Key Not Set**
   ```
   Error: OpenAI API key not provided
   Error: Google AI API key not provided
   ```
   **Solution**: Set the appropriate environment variable

2. **Invalid Model Name**
   ```
   Warning: Requested provider not available, falling back to default
   ```
   **Solution**: Check model aliases and ensure the label format is correct

3. **Infrastructure Build Failed**
   ```
   Warning: Some AI providers failed to build infrastructure
   ```
   **Solution**: Check API keys and network connectivity

### Debug Information

Enable debug logging to see provider selection:
```bash
LOG_LEVEL=debug
```

This will show:
- Which provider is selected for each model
- Model resolution from aliases
- Provider configuration validation
- Infrastructure build results

## Migration from Claude-Only Setup

Existing setups will continue to work without changes. To add new providers:

1. Add API keys for desired providers
2. Start using new label patterns on issues
3. Optionally update `DEFAULT_CLAUDE_MODEL` to use aliases from other providers

The system maintains full backward compatibility with existing `llm-claude-*` labels.

## Cost Considerations

- **Claude**: Managed through Anthropic billing
- **OpenAI**: Direct API charges apply
- **Gemini**: Google AI pricing applies

Monitor usage through provider dashboards and GitFix logs to track costs across different models.