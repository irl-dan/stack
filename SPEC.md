# Call Stack Context Manager - Specification

## The Problem

Current AI agent implementations organize conversation history as a **linear sequence** of messages. This creates several fundamental issues:

### Context Window Pressure

Full linear history fills the context window, requiring lossy compaction. Every debugging tangent, exploration, and dead-end remains in context even after the relevant work is complete.

### Misaligned Mental Model

Engineers think of work as a call stack - push a subtask, complete it, pop back to the parent. Linear transcripts do not reflect this natural structure of problem-solving.

### Irrelevant Context Pollution

When working on Task B, the full history of sibling Task A is unnecessarily included. A 50-message debugging session from Task A wastes tokens when you have moved on to Task B.

### No Structural Memory

Task relationships (parent/child/sibling) are implicit rather than explicit. There is no way to reference "what we decided in the auth subtask" without it being somewhere in the linear history.

---

## The Solution: Tree-Structured Context (Call Stack)

Organize agent context as a **tree of frames** rather than a linear chat log:

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

Each frame represents a discrete unit of work with its own goal, success criteria, and results. The full conversation history of each frame is preserved, but only relevant summaries cross-pollinate between frames.

---

## Core Mechanics

### 1. Frame Push/Pop Semantics

- **Push**: Create a new child frame when starting a distinct subtask
- **Pop**: Return to parent frame when subtask completes (or fails/blocks)

Heuristics for when to push:
- **Failure Boundary**: Work that could be retried as a unit if it fails
- **Context Switch**: Different files, concepts, or subsystems
- **Complexity Threshold**: Work that benefits from its own summary

### 2. Full Logs Persist to Disk

Every frame's complete history is saved to a log file. Nothing is truly lost - agents can browse previous frame logs if needed. This means compaction is additive context, not a replacement for lost information.

### 3. Frame Identity (Immutable)

Each frame has immutable identity set at creation:

| Field | Description |
|-------|-------------|
| `title` | Short name (2-5 words) - e.g., "User Authentication" |
| `successCriteria` | What defines "done" in concrete, verifiable terms |
| `successCriteriaCompacted` | Dense version for tree/context display |

The success criteria provide clear exit conditions and enable verification of completion.

### 4. Frame Results (Set on Completion)

When a frame completes, results are recorded:

| Field | Description |
|-------|-------------|
| `results` | Detailed summary of what was accomplished |
| `resultsCompacted` | Dense version for context injection |
| `artifacts` | Files/resources produced |
| `decisions` | Key decisions made |

These results become the "handoff" to sibling and parent frames.

### 5. Active Context Construction

When working in Frame B1, the active context includes:

- **B1's own working history** (full conversation)
- **Compaction of parent B** (its successCriteria and any partial results)
- **Compaction of grandparent Root** (the overall goal)
- **Compaction of completed sibling A** (its results) - this is the cross-talk
- **NOT included**: The full linear history of A1, A2, or any deep exploration

This selective inclusion means the context window contains only what is relevant to the current work.

### 6. Structure as XML, Content as Prose

Context is structured as XML for parsing but contains prose for readability:

```xml
<stack-context id="root" status="in_progress">
  <title>Build the application</title>
  <success-criteria>Complete working app with auth and API</success-criteria>
  <child id="A" status="completed">
    <title>User Authentication</title>
    <results>Implemented JWT-based auth with refresh tokens.
    Created User model, auth middleware, login/logout routes.</results>
    <artifacts>src/auth/*, src/models/User.ts</artifacts>
  </child>
  <child id="B" status="in_progress">
    <title>API Routes</title>
    <success-criteria>RESTful CRUD endpoints with pagination</success-criteria>
    <child id="B1" status="in_progress">
      <title>CRUD Endpoints</title>
      <success-criteria>GET/POST/PUT/DELETE for resources</success-criteria>
      <!-- Current working context -->
    </child>
    <child id="B2" status="planned">
      <title>Pagination</title>
      <success-criteria>Cursor-based pagination with limits</success-criteria>
    </child>
  </child>
</stack-context>
```

### 7. Planned Frames (Non-Linear Planning)

Frames can exist in `planned` state before execution begins:

- Planned frames can have planned children (sketch B -> B1, B2, B3 before starting B)
- Plans are mutable - discoveries during execution can add/remove/modify planned frames
- When a frame is invalidated, all planned children cascade to invalidated
- This enables upfront planning without commitment

### 8. Frame Status Lifecycle

Frames move through a defined lifecycle:

| Status | Description |
|--------|-------------|
| `planned` | Defined but not yet started |
| `in_progress` | Currently being worked on |
| `completed` | Successfully finished with results |
| `failed` | Attempted but did not succeed |
| `blocked` | Cannot proceed without external input |
| `invalidated` | No longer relevant (cascades to children) |

### 9. Control Authority

Both humans and agents can manage the frame tree:

- **Human**: Explicit commands (push, pop, plan, status)
- **Agent**: Autonomous decisions based on heuristics and context
- The system can suggest frame operations when patterns are detected

---

## Why This Helps

The crucial insight is **structural separation of concerns**:

| Linear History | Call Stack |
|----------------|------------|
| Task A exploration -> Task A solution -> Task B exploration -> Task B solution | Task A's full history in Frame A, Task B's full history in Frame B, only compactions cross-pollinate |
| Context grows monotonically | Active context = current frame + ancestor compactions + sibling compactions |
| Compaction loses detail | Full logs persist, compaction is additive context not replacement |
| No retry boundary | Frame = natural retry/rollback unit |
| Implicit task relationships | Explicit parent/child/sibling structure |

---

## Components Required for Implementation

An implementation of this specification requires:

1. **Frame State Manager**: Track tree of frames, their status, and relationships
2. **Log Persistence Layer**: Write full frame logs to disk for each frame
3. **Results Generator**: Produce summaries when frames complete
4. **Context Assembler**: Build active context from current frame + relevant ancestors and siblings
5. **Frame Controller**: Handle push/pop/plan commands (human or agent-initiated)
6. **Plan Manager**: Handle planned frames, activation, and cascade invalidation
7. **Token Budget Manager**: Allocate context window space across ancestors, siblings, and current frame
