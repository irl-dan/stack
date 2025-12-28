# Flame Graph Context Management Plugin - Implementation Documentation

## Overview

Flame is a tree-structured context management plugin for OpenCode AI agents. It organizes AI agent work into a hierarchical frame structure where each frame represents a discrete unit of work with its own goal, artifacts, decisions, and lifecycle.

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

### File Structure

```
.opencode/flame/
├── state.json           # Root FlameState with frame index and active frame
└── frames/
    ├── {sessionID}.json # Individual frame metadata files
    └── plan-*.json      # Planned frame files
```

## Data Structures

### FlameState

Root state persisted to `state.json`:

```typescript
interface FlameState {
  version: number              // Schema version for migrations
  frames: Record<string, FrameMetadata>  // sessionID -> frame
  activeFrameID?: string       // Currently active frame
  rootFrameIDs: string[]       // Frames with no parent
  updatedAt: number            // Last modification timestamp
}
```

### FrameMetadata

Individual frame data:

```typescript
interface FrameMetadata {
  sessionID: string            // OpenCode session ID
  parentSessionID?: string     // Parent frame (undefined for root)
  status: FrameStatus          // Current lifecycle status
  goal: string                 // Frame purpose/objective
  createdAt: number
  updatedAt: number
  artifacts: string[]          // Files/resources produced
  decisions: string[]          // Key decisions recorded
  compactionSummary?: string   // Summary from compaction
  logPath?: string             // Path to exported log

  // Phase 1.6: Planning fields
  invalidationReason?: string
  invalidatedAt?: number
  plannedChildren?: string[]
}
```

### Runtime State

Non-persisted state for session tracking:

```typescript
interface RuntimeState {
  currentSessionID: string | null
  processedMessageIDs: Set<string>    // Deduplication
  hookInvocationCount: number
  flameDir: string
  initTime: number

  // Phase 1.2: Caching
  contextCache: Map<string, CacheEntry>
  tokenBudget: TokenBudget
  cacheTTL: number                    // Default: 30000ms
  lastContextMetadata: ContextMetadata | null

  // Phase 1.3: Compaction tracking
  compactionTracking: CompactionTracking

  // Phase 1.5: Subagent tracking
  subagentTracking: SubagentTracking

  // Phase 1.7: Autonomy tracking
  autonomyTracking: AutonomyTracking
}
```

## Phase Breakdown

### Phase 1.0-1.1: Core Frame Management

**FrameStateManager** class provides:
- `createFrame(sessionID, goal, parentSessionID?)` - Create new frame
- `updateFrameStatus(sessionID, status, summary?)` - Update status
- `completeFrame(sessionID, status, summary?)` - Complete and return parent
- `getFrame(sessionID)` - Retrieve frame by ID
- `getActiveFrame()` - Get currently active frame
- `getAncestors(sessionID)` - Get parent chain to root
- `getCompletedSiblings(sessionID)` - Get finished sibling frames
- `getAllFrames()` - Get full state
- `ensureFrame(sessionID, title?)` - Create if not exists

**File Storage**:
- `loadState(projectDir)` / `saveState(projectDir, state)` - Root state I/O
- `loadFrame(projectDir, sessionID)` / `saveFrame(projectDir, frame)` - Frame I/O
- Session IDs are sanitized for filenames (non-alphanumeric → `_`)

### Phase 1.2: Token Budget & Context Assembly

**Token Budget Management**:
- Configurable budgets via environment variables
- Default: 4000 total (1500 ancestors, 1500 siblings, 800 current, 200 overhead)
- Token estimation: ~4 characters per token

```typescript
const DEFAULT_TOKEN_BUDGET = {
  total: 4000,
  ancestors: 1500,
  siblings: 1500,
  current: 800,
  overhead: 200,
}
```

**Intelligent Ancestor Selection**:
- Scores ancestors by depth, recency, status, summary presence
- Immediate parent always included first
- Selects within budget, prioritizing by relevance score

**Sibling Relevance Filtering**:
- Scores siblings by keyword overlap with current goal
- Filters by minimum relevance threshold (default: 30)
- Includes artifact text in relevance matching

**Context Caching**:
- 30-second TTL cache keyed by session ID
- State hash invalidation (frame status/content changes)
- Max 50 cache entries with LRU cleanup

**Environment Variables**:
- `FLAME_TOKEN_BUDGET_TOTAL`
- `FLAME_TOKEN_BUDGET_ANCESTORS`
- `FLAME_TOKEN_BUDGET_SIBLINGS`
- `FLAME_TOKEN_BUDGET_CURRENT`

### Phase 1.3: Compaction Integration

**Compaction Types**:
- `overflow` - Automatic when context exceeds limits
- `frame_completion` - When completing a frame via `flame_pop`
- `manual_summary` - Triggered by `flame_summarize`

**Custom Compaction Prompts**:
- `generateFrameCompactionPrompt()` produces prompts tailored to compaction type
- Frame completion focuses on goal progress, outcomes, decisions, blockers
- Overflow compaction preserves continuation context
- Manual summary captures checkpoint state

**Pending Completion Flow**:
1. `flame_pop` with `generateSummary: true` registers pending completion
2. Next compaction event uses frame_completion prompt
3. Summary extracted from compaction message
4. Frame finalized with combined user + generated summary

**Summary Extraction**:
- Looks for messages with `info.summary === true`
- Extracts text parts from message
- Stores in frame's `compactionSummary` field

### Phase 1.5: Subagent Integration

**Detection Heuristics**:
- Pattern matching on session titles (configurable regex patterns)
- Duration threshold (default: 60 seconds)
- Message count threshold (default: 3 messages)

**Default Patterns**:
```typescript
["@.*subagent", "subagent", "\\[Task\\]"]
```

**Subagent Session Tracking**:
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

**Auto-Completion**:
- When subagent goes idle, schedules auto-completion after delay (default: 5s)
- Clears timer on new activity
- Records `autoCompleted` vs `manuallyCompleted` stats

**Environment Variables**:
- `FLAME_SUBAGENT_ENABLED`
- `FLAME_SUBAGENT_MIN_DURATION`
- `FLAME_SUBAGENT_MIN_MESSAGES`
- `FLAME_SUBAGENT_AUTO_COMPLETE`
- `FLAME_SUBAGENT_IDLE_DELAY`
- `FLAME_SUBAGENT_PATTERNS` (comma-separated)

### Phase 1.6: Planning & Invalidation

**Planned Frames**:
- `flame_plan` creates frame with status `planned`
- `flame_plan_children` creates multiple planned children at once
- `flame_activate` changes status from `planned` to `in_progress`
- Planned frames appear in tree but don't become active

**Invalidation Cascade**:
- `flame_invalidate` sets status to `invalidated` with reason
- All `planned` descendants auto-invalidated
- `in_progress` descendants warned but not auto-invalidated
- `completed` descendants remain unchanged

**FrameStateManager Additions**:
- `createPlannedFrame(sessionID, goal, parentSessionID?)`
- `createPlannedChildren(parentSessionID, children[])`
- `activateFrame(sessionID)` - planned → in_progress
- `invalidateFrame(sessionID, reason)` - with cascade
- `getFramesByStatus(status)`
- `getAllChildren(sessionID)` - any status
- `getAllSiblings(sessionID)` - any status

### Phase 1.7: Agent Autonomy

**Autonomy Levels**:
- `manual` - Never auto-suggests, only responds to explicit tool calls
- `suggest` - Evaluates heuristics and injects suggestions into context
- `auto` - Can autonomously trigger push/pop (not fully implemented)

**Push Heuristics** (when to create child frame):
- `failure_boundary` - Error count, potential retry boundary
- `context_switch` - Goal keyword divergence, file changes
- `complexity` - Message count, file change count
- `duration` - Token count as proxy

**Pop Heuristics** (when to complete current frame):
- `goal_completion` - Success signals, artifacts, keyword coverage
- `stagnation` - No-progress turns, failure signals
- `context_overflow` - Token usage ratio

**Suggestion System**:
- Suggestions added to `pendingSuggestions` queue
- Expired after 5 minutes if not acted upon
- Injected into context as `[FLAME SUGGESTION: ...]` comments
- History tracked for stats

**Environment Variables**:
- `FLAME_AUTONOMY_LEVEL`
- `FLAME_PUSH_THRESHOLD`
- `FLAME_POP_THRESHOLD`
- `FLAME_SUGGEST_IN_CONTEXT`
- `FLAME_ENABLED_HEURISTICS` (comma-separated)

## Hook Integration

### event

Handles OpenCode session lifecycle events:
- `session.created` - Registers session, detects subagents, creates frames
- `session.updated` - Updates current session tracking
- `session.idle` - Triggers subagent idle handling
- `session.compacted` - Extracts summaries, finalizes pending completions

### chat.message

Fires before `transform` hooks:
- Updates `runtime.currentSessionID`
- Ensures frame exists for session via `manager.ensureFrame()`
- Updates subagent activity tracking

### experimental.chat.messages.transform

Injects frame context into LLM calls:
- Generates context XML via `generateFrameContext()`
- Appends autonomy suggestions if enabled
- Prepends synthetic message to `output.messages`

### experimental.session.compacting

Customizes compaction prompts:
- Determines compaction type from tracking state
- Generates frame-aware prompt via `generateFrameCompactionPrompt()`
- Adds to `output.context` or overrides `output.prompt`

## Tools Reference

### Core Frame Management

| Tool | Description |
|------|-------------|
| `flame_push` | Create child frame for subtask |
| `flame_pop` | Complete frame and return to parent |
| `flame_status` | Show frame tree with status |
| `flame_set_goal` | Update current frame's goal |
| `flame_add_artifact` | Record produced artifact |
| `flame_add_decision` | Record key decision |

### Context Assembly (Phase 1.2)

| Tool | Description |
|------|-------------|
| `flame_context_info` | Show token usage and selection metadata |
| `flame_context_preview` | Preview XML context for injection |
| `flame_cache_clear` | Clear context cache |

### Compaction (Phase 1.3)

| Tool | Description |
|------|-------------|
| `flame_summarize` | Trigger manual summary generation |
| `flame_compaction_info` | Show compaction tracking state |
| `flame_get_summary` | Retrieve frame's compaction summary |

### Subagent Integration (Phase 1.5)

| Tool | Description |
|------|-------------|
| `flame_subagent_config` | View/modify subagent settings |
| `flame_subagent_stats` | Show subagent detection statistics |
| `flame_subagent_complete` | Manually complete subagent session |
| `flame_subagent_list` | List tracked subagent sessions |

### Planning & Invalidation (Phase 1.6)

| Tool | Description |
|------|-------------|
| `flame_plan` | Create planned frame |
| `flame_plan_children` | Create multiple planned children |
| `flame_activate` | Start work on planned frame |
| `flame_invalidate` | Invalidate frame with cascade |
| `flame_tree` | ASCII visualization of frame tree |

### Agent Autonomy (Phase 1.7)

| Tool | Description |
|------|-------------|
| `flame_autonomy_config` | View/modify autonomy settings |
| `flame_should_push` | Evaluate push heuristics |
| `flame_should_pop` | Evaluate pop heuristics |
| `flame_auto_suggest` | Manage auto-suggestions |
| `flame_autonomy_stats` | View autonomy statistics |

### UI Support

| Tool | Description |
|------|-------------|
| `flame_get_state` | Get complete state for UI rendering |

## Context XML Format

```xml
<flame-context session="abc12345">
  <metadata>
    <budget total="4000" ancestors="1500" siblings="1500" current="800" />
    <truncation ancestors-omitted="2" siblings-filtered="3" />
  </metadata>

  <ancestors count="2" omitted="1">
    <frame id="root1234" status="in_progress">
      <goal>Main project task</goal>
      <summary>Working on feature X...</summary>
      <artifacts>src/foo.ts, src/bar.ts</artifacts>
    </frame>
    <frame id="parent12" status="completed">
      <goal>Implement sub-feature</goal>
      <summary truncated="true">Completed implementation of...</summary>
    </frame>
  </ancestors>

  <completed-siblings count="1" filtered="2">
    <frame id="sibling1" status="completed">
      <goal>Related task</goal>
      <summary>Finished related work...</summary>
    </frame>
  </completed-siblings>

  <current-frame id="abc12345" status="in_progress">
    <goal>Current subtask</goal>
    <artifacts>src/current.ts</artifacts>
    <decisions>Using approach A because...</decisions>
  </current-frame>
</flame-context>

<!-- Flame Autonomy Suggestions -->
[FLAME SUGGESTION: Consider pushing a new frame for "refactor auth" - Reason: context switch (75% confidence)]
```

## Helper Functions

| Function | Purpose |
|----------|---------|
| `estimateTokens(text)` | Estimate tokens (~4 chars/token) |
| `truncateToTokenBudget(text, max, indicator)` | Truncate with word boundary respect |
| `extractKeywords(text)` | Extract significant words for relevance |
| `generateStateHash(frame, ancestors, siblings)` | Cache invalidation hash |
| `escapeXml(text)` | XML entity escaping |
| `formatDuration(ms)` | Human-readable duration |
| `log(message, data?)` | Timestamped console logging |

## Logging

All significant operations logged with `[flame]` prefix:
```
[2024-01-15T10:30:00.000Z] [flame] Frame created { sessionID: "...", goal: "..." }
```

Log events include:
- Frame lifecycle (created, completed, invalidated)
- Context generation (cache hits, token usage)
- Subagent detection and completion
- Compaction events
- Autonomy suggestions

## Cache Invalidation

Context cache is invalidated on:
- Frame status change
- Frame goal update
- Artifact/decision addition
- Child frame creation (affects parent's sibling context)
- Frame completion
- Frame invalidation

Global cache clear on major state changes via `invalidateAllCache()`.

## Error Handling

- File I/O errors return default/empty state
- Invalid regex patterns in subagent config logged and skipped
- Missing frames return null/undefined with logged warnings
- Tool errors return descriptive error strings
