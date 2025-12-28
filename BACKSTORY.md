# Backstory: How We Got Here

This document captures the exploration and decision-making process that led to the Call Stack Context Manager implementation.

## The Problem Statement

The project originated from a Twitter thread discussing a fundamental architectural problem with current AI coding agents (including Claude Code):

> "Context window won't be 'solved' as long as attention is quadratic... but this is downstream of an architectural problem with standard agent implementations that use a linear 'chat-like' history."

The insight: Engineers naturally think of work as a **call stack** (push subtask, complete it, pop back), not as a linear transcript. When an agent's context is organized as a linear chat log:

1. **Context window pressure** - Full linear history fills the window, requiring lossy compaction
2. **Irrelevant context pollution** - When working on Task B, the full exploration/debugging history of sibling Task A is unnecessarily prefixed
3. **No structural memory** - Task relationships (parent/child/sibling) are implicit rather than explicit

## The Solution Vision

Organize agent context as a **tree of frames** (like a call stack) rather than a linear chat log:

```
                [Root Frame: "Build App"]
                       |
       +---------------+---------------+
       |                               |
 [Frame A: Auth]                [Frame B: API Routes]
  (completed)                      (in progress)
       |                               |
  +----+----+                    +-----+-----+
  |         |                    |           |
[A1]      [A2]                 [B1]        [B2]
(done)    (done)            (in progress) (planned)
```

Key mechanics:

- **Frame Push/Pop** - Create child frames for subtasks, pop when complete
- **Full Logs to Disk** - Nothing truly lost
- **Compaction on Pop** - Summary injected into parent context
- **Active Context** - Current frame + ancestor compactions + sibling compactions (NOT full linear history)

## Exploration Process

We systematically evaluated six implementation approaches across two platforms (Claude Code and OpenCode):

### Claude Code Approaches

| Proposal | Approach                                                       | Verdict                                                       |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| 01       | Inside Claude Code (plugins, hooks, skills)                    | SUBSTANTIALLY FEASIBLE - but limited to depth-1 via subagents |
| 02       | Composing Claude Codes (meta-agent orchestrating CLI sessions) | FEASIBLE WITH CAVEATS - achieves isolation but complex        |
| 03       | Claude Agents SDK                                              | FULLY FEASIBLE - full control but ground-up build             |

**Key Finding for Claude Code:** Subagents provide context isolation, but "subagents cannot spawn other subagents" - limiting native support to depth-1 frame trees.

### OpenCode Approaches

| Proposal | Approach                             | Verdict                                    |
| -------- | ------------------------------------ | ------------------------------------------ |
| 04       | OpenCode Native (plugins, SDK)       | HIGHLY FEASIBLE - native session isolation |
| 05       | OpenCode SDK (external orchestrator) | FEASIBLE WITH LIMITATIONS                  |
| 06       | OpenCode Fork/PR                     | PR-ABLE - backwards compatible             |

**Key Finding for OpenCode:** Sessions have TRUE context isolation. Each session's `prompt.ts` loop fetches only its own messages - `parentID` is purely navigational metadata. This means a plugin creating child sessions for "frames" achieves true LLM-level context isolation.

## Critical Discovery: Plugin Capabilities

Deep source code analysis revealed:

**Context Isolation: PLUGIN CAN ACHIEVE**

```typescript
// From prompt.ts - each session fetches ONLY its own messages
let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID));
```

**UI Visualization: PLUGIN CANNOT ACHIEVE**

- Desktop app has no plugin extension points for UI
- No hooks for injecting components or panels
- Requires fork or external UI

## Decision Criteria

Through clarifying questions, we established:

1. **Distribution Goal**: Plugin first, upstream contribution if people like it
2. **Core Requirement**: Must actually improve context management (not just UX)
3. **Maintenance Preference**: Prefer upstream acceptance, avoid long-term fork
4. **Timeline**: Production-grade in 1-2 weeks with coding agent assistance

## Selected Path

Given these criteria, we chose:

**Phase 1: OpenCode Plugin** (Week 1)

- Achieves true context isolation via session-per-frame
- Validates the core architectural improvement
- No fork required

**Phase 2: External Web UI** (Week 2)

- Visualization via separate web app using OpenCode SDK
- Avoids fork while providing visualization
- Can be integrated upstream later

**Phase 3: Upstream Contribution** (After validation)

- Propose frame system to OpenCode team
- Include UI extension points proposal
- Full community benefit

## Files Generated During Exploration

All exploratory documents have been archived in `archive/`:

- `initial-interview.md` - Q&A clarifying the frame concept
- `proposals/01-inside-claude-code.md` - Claude Code plugin analysis
- `proposals/02-composing-claude-codes.md` - CLI composition analysis
- `proposals/03-agents-sdk.md` - Claude Agents SDK analysis
- `proposals/04-opencode-native.md` - OpenCode plugin analysis (PRIMARY)
- `proposals/05-opencode-sdk.md` - OpenCode SDK analysis
- `proposals/06-opencode-fork.md` - OpenCode fork analysis

## Key Takeaways

1. **OpenCode > Claude Code for this use case** - Native session isolation eliminates the need for workarounds
2. **Plugin path validates architecture** - No fork needed to prove the concept works
3. **UI is separate concern** - Can be addressed via external tool or later upstream contribution
4. **Phased approach de-risks** - Start with plugin, graduate to contribution if validated
