# Call Stack Context Manager Plugin - Implementation Documentation

## Overview

The Call Stack Context Manager is a tree-structured context management plugin for OpenCode AI agents. It organizes AI agent work into a hierarchical frame structure where each frame represents a discrete unit of work with its own goal, artifacts, decisions, and lifecycle.

The plugin operates by:
1. Tracking session lifecycles and mapping them to frames
2. Injecting hierarchical context (ancestors + siblings) into LLM calls
3. Managing frame completion with compaction-based summaries
4. Providing tools for manual and automatic frame management

## Architecture

### Core Concepts

**Frame**: A discrete unit of work corresponding to an OpenCode session. Frames form a tree structure with parent-child relationships.

**Frame Status**: One of `planned`, `in_progress`, `completed`, `failed`, `blocked`, or `invalidated`.

**Context Injection**: Before each LLM call, the plugin injects XML context containing:
- Ancestor chain (parent frames up to root)
- Completed sibling frames (for cross-task awareness)
- Current frame metadata
- Workflow guidance and task management rules

### File Structure

```
.opencode/stack/
├── state.json           # Root StackState with frame index and active frame
└── frames/
    ├── {sessionID}.json # Individual frame metadata files
    └── plan-*.json      # Planned frame files
```

## Data Structures

### StackState

Root state persisted to `state.json`:

```typescript
interface StackState {
  version: number                         // Schema version for migrations
  frames: Record<string, FrameMetadata>   // sessionID -> frame
  activeFrameID?: string                  // Currently active frame
  rootFrameIDs: string[]                  // Frames with no parent
  updatedAt: number                       // Last modification timestamp
}
```

### FrameMetadata

Individual frame data:

```typescript
interface FrameMetadata {
  sessionID: string            // OpenCode session ID
  parentSessionID?: string     // Parent frame (undefined for root)
  status: FrameStatus          // Current lifecycle status

  // Identity (set at creation, immutable)
  title: string                // Short name (2-5 words)
  successCriteria: string      // What defines "done"
  successCriteriaCompacted: string  // Dense version for display

  // Results (set on completion)
  results?: string             // What was accomplished
  resultsCompacted?: string    // Dense version for context

  createdAt: number
  updatedAt: number
  artifacts: string[]          // Files/resources produced
  decisions: string[]          // Key decisions recorded
  logPath?: string             // Path to exported log

  // Planning and invalidation
  invalidationReason?: string  // Reason for invalidation
  invalidatedAt?: number       // When invalidated
  plannedChildren?: string[]   // IDs of planned child frames
}
```

### RuntimeState

Non-persisted state for session tracking:

```typescript
interface RuntimeState {
  currentSessionID: string | null
  processedMessageIDs: Set<string>    // Deduplication
  hookInvocationCount: number
  stackDir: string
  initTime: number

  // Context caching
  contextCache: Map<string, CacheEntry>
  tokenBudget: TokenBudget
  cacheTTL: number                    // Default: 30000ms
  lastContextMetadata: ContextMetadata | null

  // Compaction tracking
  compactionTracking: CompactionTracking

  // Subagent tracking
  subagentTracking: SubagentTracking

  // Autonomy tracking
  autonomyTracking: AutonomyTracking
}
```

## FrameStateManager

The `FrameStateManager` class provides all frame lifecycle operations:

### Core Methods

| Method | Description |
|--------|-------------|
| `createFrame(sessionID, title, successCriteria, successCriteriaCompacted, parentSessionID?)` | Create a new in_progress frame |
| `updateFrameStatus(sessionID, status, results?, resultsCompacted?)` | Update frame status with optional results |
| `completeFrame(sessionID, status, results, resultsCompacted)` | Complete frame and return parent ID |
| `getFrame(sessionID)` | Retrieve frame by ID |
| `getActiveFrame()` | Get currently active frame |
| `setActiveFrame(sessionID)` | Set the active frame |
| `getAncestors(sessionID)` | Get parent chain to root |
| `getCompletedSiblings(sessionID)` | Get completed sibling frames |
| `getAllSiblings(sessionID)` | Get all sibling frames (any status) |
| `getChildren(sessionID)` | Get child frames |
| `getAllChildren(sessionID)` | Get all child frames (any status) |
| `getAllFrames()` | Get full state |
| `loadState()` | Alias for getAllFrames |
| `ensureFrame(sessionID, title?)` | Create frame if not exists |

### Planning Methods

| Method | Description |
|--------|-------------|
| `createPlannedFrame(sessionID, title, successCriteria, successCriteriaCompacted, parentSessionID?)` | Create a planned frame |
| `createPlannedChildren(parentSessionID, children[])` | Create multiple planned children at once |
| `activateFrame(sessionID)` | Change status from planned to in_progress |
| `replaceFrameID(oldID, newID)` | Replace frame ID (e.g., plan-* to ses-*) |
| `invalidateFrame(sessionID, reason)` | Invalidate frame with cascade |
| `getFramesByStatus(status)` | Get all frames with given status |

**Parent Resolution:** When `stack_frame_plan` or `stack_frame_plan_children` is called without an explicit `parentSessionID`, the parent is resolved in this order:
1. Explicit `parentSessionID` argument (if provided)
2. `state.activeFrameID` (the currently active frame in plugin state)
3. `runtime.currentSessionID` (the OpenCode session receiving messages)

This ensures nested frames are created correctly when planning from within an activated child frame.

### File Storage Functions

| Function | Description |
|----------|-------------|
| `loadState(projectDir)` | Load root state from state.json |
| `saveState(projectDir, state)` | Save root state |
| `loadFrame(projectDir, sessionID)` | Load individual frame |
| `saveFrame(projectDir, frame)` | Save individual frame |

Session IDs are sanitized for filenames (non-alphanumeric characters replaced with `_`).

## Token Budget & Context Assembly

### Token Budget Configuration

Configurable budgets via environment variables with defaults:

```typescript
const DEFAULT_TOKEN_BUDGET = {
  total: 4000,      // ~16KB of context
  ancestors: 1500,  // ~6KB for ancestor chain
  siblings: 1500,   // ~6KB for sibling contexts
  current: 800,     // ~3KB for current frame
  overhead: 200,    // ~800 bytes for XML tags
}
```

Token estimation uses ~4 characters per token approximation.

### Intelligent Ancestor Selection

- Scores ancestors by depth, recency, status, and summary presence
- Immediate parent always included first
- Grandparent gets high priority
- Deeper ancestors get decreasing priority
- Recency bonus (more recent = higher score)
- Status bonus (in_progress > completed)
- Results/artifacts bonus

### Sibling Relevance Filtering

- Scores siblings by keyword overlap with current frame's goal
- Filters by minimum relevance threshold (default: 30)
- Includes artifact text in relevance matching
- Recency bonus for recently completed work
- Status bonus (completed work most valuable, failed work has lessons)

### Context Caching

- 30-second TTL cache keyed by session ID
- State hash invalidation when frame status/content changes
- Max 50 cache entries with LRU cleanup
- Cache invalidated on frame operations

### Environment Variables

| Variable | Description |
|----------|-------------|
| `STACK_TOKEN_BUDGET_TOTAL` | Total token budget |
| `STACK_TOKEN_BUDGET_ANCESTORS` | Ancestor context budget |
| `STACK_TOKEN_BUDGET_SIBLINGS` | Sibling context budget |
| `STACK_TOKEN_BUDGET_CURRENT` | Current frame budget |

## Compaction Integration

### Compaction Types

| Type | Trigger |
|------|---------|
| `overflow` | Automatic when context exceeds limits |
| `frame_completion` | When completing a frame via `stack_frame_pop` |
| `manual_summary` | Triggered by `stack_frame_summarize` |

### Custom Compaction Prompts

`generateFrameCompactionPrompt()` produces prompts tailored to compaction type:

- **Frame completion**: Focuses on goal progress, outcomes, decisions, blockers
- **Overflow compaction**: Preserves continuation context
- **Manual summary**: Captures checkpoint state for resumption

### Summary Extraction

- Looks for messages with `info.summary === true`
- Extracts text parts from compaction message
- Stores results in frame's `results` and `resultsCompacted` fields

## Subagent Integration

### Detection Heuristics

Subagent sessions are detected via:
- Pattern matching on session titles (configurable regex patterns)
- Duration threshold (default: 60 seconds)
- Message count threshold (default: 3 messages)

### Default Patterns

```typescript
["@.*subagent", "subagent", "\\[Task\\]"]
```

### SubagentSession Tracking

```typescript
interface SubagentSession {
  sessionID: string
  parentSessionID: string
  title: string
  createdAt: number
  lastActivityAt: number
  isSubagent: boolean       // Matches pattern
  hasFrame: boolean         // Frame created
  messageCount: number
  idleTimerID?: Timer
  isIdle: boolean
  isCompleted: boolean
}
```

### Auto-Completion

- When subagent goes idle, schedules auto-completion after delay (default: 5s)
- Clears timer on new activity
- Records `autoCompleted` vs `manuallyCompleted` stats
- Cleanup of old sessions after 1 hour

### Environment Variables

| Variable | Description |
|----------|-------------|
| `STACK_SUBAGENT_ENABLED` | Enable/disable subagent integration |
| `STACK_SUBAGENT_MIN_DURATION` | Minimum duration (ms) for meaningful session |
| `STACK_SUBAGENT_MIN_MESSAGES` | Minimum message count for meaningful session |
| `STACK_SUBAGENT_AUTO_COMPLETE` | Auto-complete on idle |
| `STACK_SUBAGENT_IDLE_DELAY` | Delay (ms) before auto-completing |
| `STACK_SUBAGENT_PATTERNS` | Comma-separated regex patterns |

## Planning & Invalidation

### Planned Frames

- `stack_frame_plan` creates frames with status `planned`
- `stack_frame_plan_children` creates multiple planned children at once
- `stack_frame_activate` creates a real OpenCode session, replaces plan-* ID with ses-* ID, changes status to `in_progress`
- Planned frames appear in tree but don't become active until activated

### Invalidation Cascade

When `stack_frame_invalidate` is called:
- Target frame status set to `invalidated` with reason and timestamp
- All `planned` descendants auto-invalidated with cascade reason
- `in_progress` descendants warned but NOT auto-invalidated
- `completed` descendants remain unchanged

## Agent Autonomy

### Autonomy Levels

| Level | Behavior |
|-------|----------|
| `manual` | Never auto-suggests, only responds to explicit tool calls |
| `suggest` | Evaluates heuristics and injects suggestions into context |
| `auto` | Can autonomously trigger push/pop (suggestions with higher confidence) |

### Push Heuristics (when to create child frame)

| Heuristic | Signals |
|-----------|---------|
| `failure_boundary` | Error count, potential retry boundary, distinct new goal |
| `context_switch` | Goal keyword divergence, multiple file changes |
| `complexity` | High message count, multiple file changes |
| `duration` | Token count as proxy for time spent |

### Pop Heuristics (when to complete current frame)

| Heuristic | Signals |
|-----------|---------|
| `goal_completion` | Success signals, artifacts produced, keyword coverage |
| `stagnation` | No-progress turns, failure signals |
| `context_overflow` | Token usage ratio near limit |

### Suggestion System

- Suggestions added to `pendingSuggestions` queue
- Expired after 5 minutes if not acted upon
- Injected into context as `[STACK SUGGESTION: ...]` comments when enabled
- History tracked for statistics

### Environment Variables

| Variable | Description |
|----------|-------------|
| `STACK_AUTONOMY_LEVEL` | manual, suggest, or auto |
| `STACK_PUSH_THRESHOLD` | Confidence threshold (0-100) for push |
| `STACK_POP_THRESHOLD` | Confidence threshold (0-100) for pop |
| `STACK_SUGGEST_IN_CONTEXT` | Include suggestions in LLM context |
| `STACK_ENABLED_HEURISTICS` | Comma-separated list of enabled heuristics |

## Hook Integration

### event

Handles OpenCode session lifecycle events:

| Event | Handler |
|-------|---------|
| `session.created` | Registers session, detects subagents, creates frames for child sessions |
| `session.updated` | Updates current session tracking, sets active frame |
| `session.idle` | Triggers subagent idle handling, may create frames, schedules auto-completion |
| `session.compacted` | Extracts summaries from compaction messages, finalizes pending completions |

### chat.message

Fires before transform hooks:
- Updates `runtime.currentSessionID`
- Ensures frame exists for session via `manager.ensureFrame()`
- Updates subagent activity tracking

### experimental.chat.system.transform

Injects frame context into system prompt:
- Generates context XML via `generateFrameContext()`
- Appends autonomy suggestions if enabled
- Adds to `output.system` array

### experimental.session.compacting

Customizes compaction prompts:
- Determines compaction type from tracking state
- Generates frame-aware prompt via `generateFrameCompactionPrompt()`
- Adds to `output.context` or overrides `output.prompt`

### tool.execute.after

Auto-tracks artifacts from file operations:
- Monitors `write` and `edit` tool executions
- Extracts file path from metadata
- Adds to current frame's artifacts if not already present
- Invalidates cache for affected session

## Tools Reference

### Core Frame Management

| Tool | Description |
|------|-------------|
| `stack_frame_push` | Create child frame with title, successCriteria, successCriteriaCompacted |
| `stack_frame_pop` | Complete frame with status (completed/failed/blocked), results, resultsCompacted. Root frames complete gracefully, marking the entire work tree as done. |
| `stack_status` | Show frame tree with status icons and hierarchy |
| `stack_tree` | ASCII visualization of frame tree with legend and statistics |
| `stack_frame_details` | View full frame metadata including timestamps, artifacts, decisions |
| `stack_add_artifact` | Record an artifact (file, resource) produced by current frame |
| `stack_add_decision` | Record a key decision made in current frame |

### Context Assembly

| Tool | Description |
|------|-------------|
| `stack_context_info` | Show token usage, budget configuration, caching info |
| `stack_context_preview` | Preview the actual XML context that would be injected |
| `stack_cache_clear` | Clear context cache for specific session or all sessions |

### Compaction

| Tool | Description |
|------|-------------|
| `stack_frame_summarize` | Trigger manual summary generation for checkpoint |
| `stack_compaction_info` | Show compaction tracking state and pending completions |
| `stack_get_summary` | Retrieve frame's current summary and metadata |

### Subagent Integration

| Tool | Description |
|------|-------------|
| `stack_config` | View/modify subagent configuration settings |
| `stack_stats` | Show subagent detection statistics and rates |
| `stack_subagent_complete` | Manually complete a subagent session |
| `stack_subagent_list` | List tracked subagent sessions with filters |

### Planning & Invalidation

| Tool | Description |
|------|-------------|
| `stack_frame_plan` | Create a planned frame for future work |
| `stack_frame_plan_children` | Create multiple planned children at once |
| `stack_frame_activate` | Start work on a planned frame (creates real session) |
| `stack_frame_invalidate` | Invalidate frame with reason and cascade to planned children |

### Agent Autonomy

| Tool | Description |
|------|-------------|
| `stack_autonomy` | View/modify autonomy level, thresholds, enabled heuristics |
| `stack_should_push` | Evaluate push heuristics with optional context signals |
| `stack_should_pop` | Evaluate pop heuristics with optional signals |
| `stack_auto_suggest` | Toggle auto-suggestions, view/clear pending suggestions |
| `stack_autonomy_stats` | View detailed autonomy statistics |

### UI Support

| Tool | Description |
|------|-------------|
| `stack_get_state` | Get complete state as JSON for UI rendering |

## Context XML Format

The context injected into the system prompt has this structure:

```xml
<stack-context session="abc12345">
  <stack-task-management>
    <philosophy>
      STACK TOOLS ARE YOUR PRIMARY TASK MANAGEMENT SYSTEM.
      Do NOT use TodoWrite. Use stack_frame_push/stack_frame_pop/stack_frame_plan instead.
      Every significant unit of work should be a frame with clear success criteria.
    </philosophy>

    <initial-planning priority="HIGH">
      THIS IS A NEW SESSION. Before writing any code:
      1. Analyze the task complexity
      2. If the task has multiple components/features, use stack_frame_plan to break it down
      3. Each child frame should have specific, verifiable success criteria
      4. Then use stack_frame_activate to start the first child task
    </initial-planning>

    <when-to-create-child-frames>
      CREATE a new child frame (stack_frame_push) when you encounter:
      - A subtask that has its own distinct success criteria
      - Work that could be done independently or in parallel
      - Multiple approaches to try (each approach = separate frame)
      - Separable concerns (e.g., implement feature vs write tests)
      - Context switches (different files, different subsystems)
      - Complexity that exceeds what fits in current frame's scope
      - Any task that would benefit from its own summary when complete
    </when-to-create-child-frames>

    <current-frame>
      <title>Current subtask</title>
      <success-criteria>Complete the implementation of X</success-criteria>
      <status>in_progress</status>
    </current-frame>

    <position>Task 2 of 3</position>
    <sibling-status completed="1" in-progress="1" pending="1" />

    <next-action>Complete current task with stack_frame_pop, then activate next sibling</next-action>
    <next-sibling title="Next Task" id="plan-123abc" />

    <rules>
      <rule>COMPLETE your current frame's success criteria before starting siblings</rule>
      <rule>Call stack_frame_pop with results/resultsCompacted when done</rule>
      <rule>Work DEPTH-FIRST: finish children before moving to siblings</rule>
      <rule>CREATE child frames for any significant sub-work (don't cram)</rule>
      <rule>NEVER use TodoWrite - stack tools replace it entirely</rule>
    </rules>
  </stack-task-management>

  <metadata>
    <budget total="4000" ancestors="1500" siblings="1500" current="800" />
  </metadata>

  <ancestors count="2">
    <frame id="root1234" status="in_progress">
      <title>Main project task</title>
      <success-criteria>Build complete application</success-criteria>
      <artifacts>src/foo.ts, src/bar.ts</artifacts>
    </frame>
  </ancestors>

  <completed-siblings count="1">
    <frame id="sibling1" status="completed">
      <title>Related task</title>
      <results>Finished related work...</results>
    </frame>
  </completed-siblings>

  <planned-children count="2">
    <frame id="plan-abc" title="Next feature" />
    <frame id="plan-def" title="Testing" />
  </planned-children>

  <current-frame id="abc12345" status="in_progress">
    <title>Current subtask</title>
    <success-criteria>Implementation requirements</success-criteria>
    <artifacts>src/current.ts</artifacts>
  </current-frame>
</stack-context>
```

## Helper Functions

| Function | Purpose |
|----------|---------|
| `estimateTokens(text)` | Estimate tokens (~4 chars/token) |
| `truncateToTokenBudget(text, max, indicator)` | Truncate with word boundary respect |
| `extractKeywords(text)` | Extract significant words for relevance matching |
| `generateStateHash(frame, ancestors, siblings, plannedChildren)` | Cache invalidation hash |
| `escapeXml(text)` | XML entity escaping |
| `formatDuration(ms)` | Human-readable duration (ms, s, m, h) |
| `log(message, data?)` | Timestamped console logging with [stack] prefix |
| `scoreAncestor(ancestor, depth, currentFrame)` | Calculate ancestor relevance score |
| `scoreSibling(sibling, currentCriteria)` | Calculate sibling relevance score |
| `selectAncestors(ancestors, budget, currentFrame)` | Select ancestors within budget |
| `selectSiblings(siblings, budget, currentGoal, minRelevance)` | Select siblings within budget |
| `calculateSiblingOrder(currentFrame, allSiblings)` | Calculate sibling position for workflow guidance |

## Logging

All significant operations logged with `[stack]` prefix:
```
[2024-01-15T10:30:00.000Z] [stack] Frame created { sessionID: "...", title: "..." }
```

Log events include:
- Frame lifecycle (created, completed, invalidated, activated)
- Context generation (cache hits/misses, token usage)
- Subagent detection and completion
- Compaction events and summary extraction
- Autonomy suggestions

## Cache Invalidation

Context cache is invalidated on:
- Frame status change
- Frame results update
- Artifact/decision addition
- Child frame creation (affects parent's sibling context)
- Frame completion
- Frame invalidation
- Frame ID replacement

Global cache clear via `invalidateAllCache()` on major state changes.

## Error Handling

- File I/O errors return default/empty state
- Invalid regex patterns in subagent config logged and skipped
- Missing frames return null/undefined with logged warnings
- Tool errors return descriptive error strings
- Compaction summary extraction failures handled gracefully with fallbacks
