# model-router

Automatically routes each task to the cheapest Claude model that can handle it, to save tokens.

- **simple** (lookups, explanations, renames, short questions) -> Haiku
- **moderate** (ordinary coding work) -> Sonnet
- **complex** (architecture, hard debugging, large builds) -> your session model

Prompts are scored by fast keyword heuristics first; only unclear prompts go to a tiny Haiku classifier call. Subagents spawned without an explicit model are routed the same way. It never routes up to a pricier model, escalates back to the full model if a "cheap" turn runs past 20 steps, and avoids switching on long conversations where losing the prompt cache would cost more than it saves.

Commands: `/route status|on|off|haiku|sonnet|classifier on|off|stats|reset`.
Per-prompt overrides: start a prompt with `!!` for the full model, or `!cheap` for Haiku.

## Install

In Claude Code:

```
/plugin install model-router --marketplace michaelvallejo4040-hub/model-router
```

For Claude Code cloud sessions, add this to the environment's setup script so every new session has it:

```bash
mkdir -p ~/.claude && cat > ~/.claude/settings.json <<'JSON'
{
  "extraKnownMarketplaces": {
    "model-router": { "source": { "source": "github", "repo": "michaelvallejo4040-hub/model-router" } }
  },
  "enabledPlugins": { "model-router@model-router": true }
}
JSON
```
