# Dotprompt Architecture - Configuration Guide

This guide explains how to configure the new dotprompt-based Copilot architecture.

## Overview

The dotprompt architecture separates concerns:

- **Prompt content** lives in `.prompt` files (version-controlled)
- **Model selection** lives in `config.json` (environment-specific)
- **Premium model locking** is enforced via subscription checks

## Configuration Format

### Enhanced Scenario Configuration

```json
{
  "copilot": {
    "scenarios": {
      "override_enabled": true,
      "scenarios": {
        "chat": {
          "model": "openai/gpt-4o",
          "optionalModels": ["openai/gpt-4o", "openai/gpt-4o-mini", "litellm/llama-3", "anthropic/claude-sonnet-4"],
          "proModels": ["anthropic/claude-sonnet-4"],
          "config": {
            "temperature": 0.7
          }
        },
        "coding": {
          "model": "anthropic/claude-sonnet-4-5",
          "config": {
            "temperature": 0.2
          }
        },
        "summary": {
          "model": "openai/gpt-4.1-2025-04-14"
        },
        "embedding": {
          "model": "openai/text-embedding-3-small"
        }
      }
    }
  }
}
```

**Note:** Only `chat` has `optionalModels` because it's the only scenario with a UI model selector. Other scenarios are action-based and use the configured model directly.

### Legacy Configuration (Still Supported)

```json
{
  "copilot": {
    "scenarios": {
      "override_enabled": true,
      "scenarios": {
        "chat": "gpt-4o",
        "coding": "claude-sonnet-4-5",
        "summary": "gpt-4.1-2025-04-14"
      }
    }
  }
}
```

**Note:** Legacy format will be automatically converted to enhanced format internally, but models without provider prefixes will fall back to legacy provider resolution.

## Model ID Format

All models **must** use the `provider/model-id` format:

### Supported Providers

- `openai/` - OpenAI models (e.g., `openai/gpt-4o`)
- `litellm/` - LiteLLM proxy models (e.g., `litellm/llama-3`)
- `gemini/` - Google Gemini models (e.g., `gemini/gemini-2.5-flash`)
- `anthropic/` - Anthropic Claude models (e.g., `anthropic/claude-sonnet-4`)
- `fal/` - FAL AI models (e.g., `fal/flux-pro`)

### Examples

✅ **Correct:**

```json
{
  "model": "openai/gpt-4o"
}
```

❌ **Incorrect:**

```json
{
  "model": "gpt-4o" // Missing provider prefix
}
```

## Scenario Configuration Fields

### Required Fields

- **`model`** (string): The default model to use for this scenario
  - Format: `provider/model-id`
  - Example: `"openai/gpt-4o"`

### Optional Fields

- **`optionalModels`** (string[]): Models available in the UI dropdown
  - Only use for scenarios with user choice (e.g., chat)
  - Format: Array of `provider/model-id` strings
  - Example: `["openai/gpt-4o", "openai/gpt-4o-mini"]`

- **`proModels`** (string[]): Premium models requiring subscription
  - Format: Array of `provider/model-id` strings
  - These models will be blocked for non-subscribers
  - Example: `["anthropic/claude-sonnet-4"]`

- **`config`** (object): Model parameter overrides
  - Overrides defaults from dotprompt files
  - Example: `{ "temperature": 0.7, "maxTokens": 4096 }`

## Scenarios

### When to Use `optionalModels`

✅ **Use for:** Scenarios where users actively select models via UI

- **chat** - Users choose from dropdown in chat interface

❌ **Don't use for:** Action-based scenarios

- **summary** - Triggered by button, no user choice
- **translate** - Triggered by button, no user choice
- **coding** - Triggered by button, no user choice
- **embedding** - Technical operation, no user choice

### When to Use `proModels`

`proModels` can be used in **any scenario** to enforce subscription requirements:

✅ **Use when:**

- The model requires a premium subscription
- You want to lock certain models behind a paywall
- Works with both UI-based (chat) and action-based scenarios

**Example:**

```json
{
  "chat": {
    "model": "openai/gpt-4o",
    "optionalModels": ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
    "proModels": ["anthropic/claude-sonnet-4"] // Requires subscription
  },
  "coding": {
    "model": "anthropic/claude-sonnet-4-5"
    // No optionalModels (action-based), but could have proModels if needed
  }
}
```

### Available Scenarios

- `audio_transcribing` - Audio transcription
- `chat` - General chat (has UI model selector)
- `embedding` - Text embeddings
- `image` - Image generation/manipulation
- `rerank` - Result reranking
- `coding` - Code generation/editing
- `complex_text_generation` - Complex text tasks (presentations, mind maps)
- `quick_decision_making` - Quick decisions (headings, captions)
- `quick_text_generation` - Quick text generation
- `polish_and_summarize` - Text polishing and summarization

## Dotprompt Files

### File Location

Place `.prompt` files in:

```
packages/backend/server/src/plugins/copilot/prompts/
```

### File Format

```yaml
---
scenario: chat
tools:
  - docRead
  - webSearch
config:
  temperature: 0.7
  maxTokens: 4096
---
You are AFFiNE AI, a helpful assistant...
```

### Frontmatter Fields

- **`scenario`** (string): Scenario identifier (optional, can be inferred)
- **`tools`** (string[]): Available tools for this prompt
- **`config`** (object): Default model parameters
- **`input`** (object): Input schema for validation (future use)

**Important:** Do NOT specify `model`, `optionalModels`, or `proModels` in dotprompt files. These belong in `config.json`.

## Priority and Merging

### Loading Priority

1. **Dotprompt file** (if exists)
2. **Database** (fallback for legacy prompts)

### Config Merging

When using dotprompt files, configuration is merged as follows:

```
Final Config = Dotprompt Config < Scenario Config
```

- Scenario config from `config.json` takes precedence
- Dotprompt config provides defaults
- Tools from dotprompt are preserved
- ProModels from scenario config are added

## Migration Guide

### From Database to Dotprompt

1. **Create `.prompt` file** for your prompt
2. **Add scenario config** to `config.json` with provider prefix
3. **Test** that the prompt loads correctly
4. **Database entry** becomes fallback (can be kept for safety)

### Example Migration

**Before (Database only):**

```typescript
// In prompts.ts
{
  name: 'Chat With AFFiNE AI',
  model: 'gpt-4o',
  messages: [...]
}
```

**After (Dotprompt + Config):**

`prompts/chat.prompt`:

```yaml
---
scenario: chat
tools:
  - docRead
  - webSearch
---
You are AFFiNE AI...
```

`config.json`:

```json
{
  "copilot": {
    "scenarios": {
      "override_enabled": true,
      "scenarios": {
        "chat": {
          "model": "openai/gpt-4o",
          "optionalModels": ["openai/gpt-4o", "openai/gpt-4o-mini"]
        }
      }
    }
  }
}
```

## Benefits

1. **Version Control**: Prompts are in files, easy to track changes
2. **Environment Flexibility**: Different models per environment via config
3. **Fork-Friendly**: Self-hosters can customize prompts without DB migrations
4. **Clear Separation**: Prompt content vs. model selection
5. **Provider Routing**: Explicit provider selection via prefix
6. **Backward Compatible**: Existing database prompts still work

## Troubleshooting

### Error: "Model must include provider prefix"

**Cause:** Model ID in config.json doesn't have provider prefix

**Fix:** Change `"model": "gpt-4o"` to `"model": "openai/gpt-4o"`

### Error: "Unknown provider"

**Cause:** Invalid provider prefix

**Fix:** Use one of: `openai`, `litellm`, `gemini`, `anthropic`, `fal`

### Error: "Provider is not configured"

**Cause:** Provider exists but not configured in config.json

**Fix:** Add provider configuration:

```json
{
  "copilot": {
    "providers": {
      "openai": {
        "apiKey": "sk-...",
        "baseURL": "https://api.openai.com/v1"
      }
    }
  }
}
```

### Error: "No scenario config found"

**Cause:** Scenario not configured in config.json

**Fix:** Add scenario configuration:

```json
{
  "copilot": {
    "scenarios": {
      "override_enabled": true,
      "scenarios": {
        "your_scenario": {
          "model": "openai/gpt-4o"
        }
      }
    }
  }
}
```
