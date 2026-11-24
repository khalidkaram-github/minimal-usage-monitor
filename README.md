# Usage Monitor (`minimal-usage-monitor`)

Minimal monochrome usage monitor plugin for Google Antigravity.

## Features
- **Live Context Meter**: Shows current conversation context usage (`%`, tokens used / max) with a configurable `/compact` alert threshold and one-click `/compact` copy button.
- **5h & 7d Rolling Windows**: Tracks local token usage, turns, and chats across the last 5 hours and 7 days, with optional custom limits.
- **Session Details**: Expandable breakdown for Input, Cache read, Output, Current turn, Models, Subagents, and 5h vs 7d matrix.
- **Native Light & Dark Theme**: Automatically adapts to Antigravity's host theme tokens (`--background`, `--foreground`, `--card`, `--border`, etc.).
- **SessionStart Quick Pill**: Injects a zero-token `[Usage Monitor]` link at the start of every new conversation for one-click opening.

## Installation

### Option 1: Antigravity CLI
```bash
agy plugin install https://github.com/khalidkaram-github/minimal-usage-monitor
```

### Option 2: Manual
Clone this repository into your Antigravity plugins folder:

- **Windows**: `%USERPROFILE%\.gemini\config\plugins\minimal-usage-monitor`
- **macOS / Linux**: `~/.gemini/config/plugins/minimal-usage-monitor`

Then enable **Usage Monitor** under **Customizations → Plugins**.
