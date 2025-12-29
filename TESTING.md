# Testing the Stack Plugin

This document describes how to test the Call Stack Context Management plugin.

## Prerequisites

- OpenCode CLI installed (`opencode` command available)
- Plugin located at `.opencode/plugin/stack.ts`

## Project Structure Guidelines

**Important**: When testing with OpenCode agents, encourage them to build new projects inside the `test-projects` directory. This keeps test projects organized and separate from the main codebase.

## Quick Start

```bash
# Navigate to the stack directory
cd /path/to/stack

# Clear any existing state for a fresh test
rm -rf .opencode/stack/frames .opencode/stack/state.json

# Run a test prompt
opencode run "Create a plan for building a REST API with three endpoints"
```

## CLI-Based Testing with `opencode run`

The OpenCode CLI supports non-interactive execution via `opencode run [message]`. This is the primary way to test the stack plugin from the command line.

### Basic Commands

```bash
# Single command execution
opencode run "Your test prompt here"

# JSON output for programmatic parsing
opencode run "Your test prompt" --format json

# With verbose logs
opencode run "Your test prompt" --print-logs 2>&1

# With specific model
opencode run "Your test prompt" --model anthropic/claude-sonnet-4-5-20250929
```

### Session Management

Resume existing sessions for multi-step workflows:

```bash
# Continue the last session
opencode run --continue "Continue working on this task"

# Resume a specific session by ID
opencode run --session ses_abc123xyz "Continue from where we left off"
```

### Plugin Auto-Loading

The stack plugin at `.opencode/plugin/stack.ts` loads automatically when OpenCode starts. You can verify this by:

1. Looking for initialization logs when using `--print-logs`
2. Testing that stack tools are available:
   ```bash
   opencode run "Use stack_tree to show me the current frame tree"
   ```

### JSON Output Mode

The `--format json` flag streams JSON events, useful for:

- Programmatic parsing of tool calls
- Verifying which tools the agent uses
- Debugging frame operations

```bash
opencode run "Create a simple task plan" --format json 2>&1 | head -100
```

### Configuring Permissions for Automation

By default, OpenCode prompts for approval on certain operations (`external_directory`, `doom_loop`). For automated testing, configure permissions to allow operations without prompts.

**Option 1: Environment variable (recommended for quick tests)**

```bash
export OPENCODE_PERMISSION='{"edit":"allow","bash":"allow","external_directory":"allow","doom_loop":"allow"}'
opencode run "Your test prompt"
```

**Option 2: Config file (`opencode.json` in project root)**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "external_directory": "allow",
    "doom_loop": "allow"
  }
}
```

**Option 3: Granular bash permissions**

```json
{
  "permission": {
    "bash": {
      "git push": "ask",
      "rm -rf *": "deny",
      "*": "allow"
    }
  }
}
```

Permission levels: `"allow"` (no prompt), `"ask"` (prompt), `"deny"` (disabled)

## Core Test Scenarios

### 1. Frame Planning

Test that the agent uses stack tools for task decomposition:

```bash
opencode run "Build a user authentication system with login, logout, and password reset. Break this into subtasks and work through each one."
```

**Expected behavior:**

- Agent uses `stack_frame_plan_children` to create subtasks
- Each subtask has a title and successCriteria
- Agent uses `stack_frame_activate` to start each subtask
- Agent uses `stack_frame_pop` with results when completing

### 2. Verify Frame State

Check the state file after running:

```bash
cat .opencode/stack/state.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
frames = d.get('frames', {})
print(f'Total frames: {len(frames)}')
for fid, f in frames.items():
    print(f'  [{f.get(\"status\")[:4]}] {f.get(\"title\", \"?\")[:40]}')
"
```

### 3. Frame Hierarchy (Nested Frames)

Test dynamic frame creation within frames:

```bash
opencode run "Build a complex feature that requires multiple sub-components. When you encounter complexity, create child frames. Target depth > 2."
```

**Expected behavior:**

- Agent creates frames within frames
- State shows `plannedChildren` relationships
- Max depth > 2 in frame tree

### 4. Context Injection

Verify context is being injected:

```bash
opencode run "Use stack_context_preview to show me what context is being injected" --print-logs 2>&1
```

Look for logs showing:

- `Context generated`
- `Frame context injected`

### 5. Frame Completion

Test the pop workflow:

```bash
# Get the active frame ID
FRAME_ID=$(cat .opencode/stack/state.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('activeFrameID', ''))")

# Pop with explicit frame ID
opencode run "Complete this frame with stack_frame_pop. Use status=completed and provide results summarizing what was done."
```

### 6. Tree Visualization

View the current stack tree:

```bash
opencode run "Use stack_tree to show the current frame hierarchy"
```

### 7. State Retrieval for UI

Get complete state as JSON:

```bash
opencode run "Use stack_get_state to return the complete stack state"
```

## Key Files to Inspect

| File                            | Purpose                    |
| ------------------------------- | -------------------------- |
| `.opencode/stack/state.json`    | Root state with frame tree |
| `.opencode/stack/frames/*.json` | Individual frame metadata  |

## State Structure

```json
{
  "version": 1,
  "frames": {
    "ses_xxx": {
      "sessionID": "ses_xxx",
      "parentSessionID": "ses_parent",
      "status": "in_progress",
      "title": "Frame name",
      "successCriteria": "What defines done",
      "successCriteriaCompacted": "Dense version",
      "results": "What was accomplished",
      "resultsCompacted": "Dense version",
      "artifacts": ["file1.ts"],
      "decisions": ["Decision text"],
      "plannedChildren": ["plan-xxx"]
    }
  },
  "activeFrameID": "ses_xxx",
  "rootFrameIDs": ["ses_root"]
}
```

## Available Tools

### Core Frame Management

| Tool                  | Description                            |
| --------------------- | -------------------------------------- |
| `stack_frame_push`    | Create child frame with title/criteria |
| `stack_frame_pop`     | Complete frame with status/results     |
| `stack_status`        | Show frame tree with status icons      |
| `stack_tree`          | ASCII visualization of frame tree      |
| `stack_frame_details` | View full frame metadata               |
| `stack_add_artifact`  | Add artifact to current frame          |
| `stack_add_decision`  | Add decision to current frame          |

### Planning

| Tool                        | Description                      |
| --------------------------- | -------------------------------- |
| `stack_frame_plan`          | Create a single planned frame    |
| `stack_frame_plan_children` | Create multiple planned children |
| `stack_frame_activate`      | Start work on planned frame      |
| `stack_frame_invalidate`    | Invalidate frame with cascade    |
| `stack_frame_summarize`     | Summarize frame content          |

### Context & Debug

| Tool                    | Description               |
| ----------------------- | ------------------------- |
| `stack_context_info`    | Show token usage metadata |
| `stack_context_preview` | Preview XML context       |
| `stack_cache_clear`     | Clear context cache       |
| `stack_get_state`       | Get complete state JSON   |
| `stack_compaction_info` | Show compaction status    |
| `stack_get_summary`     | Get summary for a frame   |
| `stack_stats`           | Show overall statistics   |
| `stack_config`          | View/update configuration |

### Subagent Integration

| Tool                      | Description               |
| ------------------------- | ------------------------- |
| `stack_subagent_complete` | Complete a subagent frame |
| `stack_subagent_list`     | List all subagent frames  |

### Autonomy

| Tool                   | Description                  |
| ---------------------- | ---------------------------- |
| `stack_autonomy`       | Configure autonomy settings  |
| `stack_should_push`    | Check if push is recommended |
| `stack_should_pop`     | Check if pop is recommended  |
| `stack_auto_suggest`   | Toggle auto-suggestions      |
| `stack_autonomy_stats` | View autonomy statistics     |

## Debugging Tips

1. **Check plugin initialization**: Look for `=== STACK PLUGIN INITIALIZED ===` in logs

2. **Verify hooks firing**: Look for:
   - `CHAT.MESSAGE` - Message hook
   - `Frame context injected` - Context injection working

3. **State not persisting**: Check file permissions on `.opencode/stack/`

4. **Reset for clean test**:

   ```bash
   rm -rf .opencode/stack/
   ```

5. **Observe tool usage in JSON mode**:
   ```bash
   opencode run "Create a plan with 3 steps" --format json 2>&1 | grep -i stack_
   ```

## Observing Plugin Behavior

### Watch State Changes in Real-Time

```bash
# In one terminal, watch the state file
watch -n 1 'cat .opencode/stack/state.json | python3 -m json.tool 2>/dev/null | head -50'

# In another terminal, run commands
opencode run "Plan out a simple feature"
```

### Inspect Frame Files

```bash
# List all frame files by modification time
ls -lt .opencode/stack/frames/

# View the most recent frame
cat .opencode/stack/frames/$(ls -t .opencode/stack/frames/ | head -1) | python3 -m json.tool
```

### Verify Tool Calls

Using JSON output mode, you can verify which tools the agent calls:

```bash
opencode run "Plan a simple task" --format json 2>&1 | \
  python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        event = json.loads(line)
        if 'tool' in str(event).lower() or 'stack_' in str(event):
            print(json.dumps(event, indent=2))
    except: pass
"
```

## E2E Test Results

The plugin has been validated with:

- **Simple tasks**: 5 frames, proper tool usage, no TodoWrite
- **Complex tasks**: 63 frames, depth 4, nested hierarchies
- **Real applications**: TypeScript projects with 17+ source files

Key validation:

- Agents use stack tools as PRIMARY task management (not TodoWrite)
- Dynamic frame creation when complexity discovered
- Proper completion with results summaries
- Session resumption with `--session` flag works correctly

## Environment Variables

```bash
# Token budgets
STACK_TOKEN_BUDGET_TOTAL=4000
STACK_TOKEN_BUDGET_ANCESTORS=1500
STACK_TOKEN_BUDGET_SIBLINGS=1500
STACK_TOKEN_BUDGET_CURRENT=800

# Autonomy
STACK_AUTONOMY_LEVEL=suggest  # manual, suggest, or auto
STACK_PUSH_THRESHOLD=70
STACK_POP_THRESHOLD=80
```
