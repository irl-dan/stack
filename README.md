# Call Stack Context Manager

**Hierarchical context management for AI coding agents.**

> **Note:** This is an experimental proof of concept exploring whether tree-structured context helps AI agents work more effectively. See [Status](#status) below.

This OpenCode plugin organizes AI agent work as a **call stack** rather than a linear chat history. Work is structured as a tree of frames, where each frame represents a discrete task with its own goal and results.

## The Problem

Current AI agents use linear conversation history. When working on Task B, the full 50-message debugging session from Task A is still in context - wasting tokens on irrelevant exploration and polluting the context window.

## The Solution

Organize work as a frame tree:

```
                [Root: "Build App"]
                       |
       +---------------+---------------+
       |                               |
 [Auth Frame]                    [API Frame]
  COMPLETED                       IN PROGRESS
  "JWT + refresh"                      |
                               +-------+-------+
                               |               |
                            [CRUD]        [Pagination]
                          IN PROGRESS       PLANNED
```

When working in the CRUD frame:

- **Included**: CRUD's history + API summary + Auth summary + Root goal
- **Excluded**: Auth's 50 debugging messages (only the summary matters)

Each frame has clear success criteria, and when completed, produces a summary that sibling frames can reference without inheriting the full exploration history.

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) installed ([installation guide](https://opencode.ai/docs))
- Node.js 18+ or Bun runtime

### Quick Start

1. **Copy the plugin to your project:**

   ```bash
   # Create the plugin directory
   mkdir -p /path/to/your/project/.opencode/plugin

   # Copy the plugin file
   cp .opencode/plugin/stack.ts /path/to/your/project/.opencode/plugin/
   ```

2. **Start OpenCode:**

   ```bash
   cd /path/to/your/project
   opencode
   ```

   The plugin loads automatically from the `.opencode/plugin/` directory.

## Usage

The plugin injects task management instructions that guide the agent to use stack tools automatically. For complex tasks, the agent will:

1. **Plan** - Break down work into frames with `stack_frame_plan`
2. **Activate** - Start each frame with `stack_frame_activate`
3. **Work** - Complete the task within the focused frame
4. **Complete** - Pop the frame with `stack_frame_pop` and results

### Key Tools

| Tool | Description |
|------|-------------|
| `stack_frame_plan` | Create a planned child frame |
| `stack_frame_plan_children` | Create multiple planned children at once |
| `stack_frame_activate` | Start work on a planned frame |
| `stack_frame_push` | Create a new child frame for immediate work |
| `stack_frame_pop` | Complete current frame with results |
| `stack_tree` | Visualize the frame hierarchy |
| `stack_status` | Show current frame status |

### Example Session

```
User: Build a user authentication system with login, logout, and password reset

Agent: [Uses stack_frame_plan to create:]
  - "Login Flow" - JWT auth, session management
  - "Logout Flow" - Token invalidation
  - "Password Reset" - Email verification, secure reset

Agent: [Uses stack_frame_activate on "Login Flow"]
Agent: [Works on login implementation...]
Agent: [Uses stack_frame_pop with results: "Implemented JWT auth with refresh tokens"]

Agent: [Uses stack_frame_activate on "Logout Flow"]
...
```

## File Storage

State is stored in your project:

```
.opencode/
  stack/
    state.json           # Frame tree state
    frames/
      <frameID>.json     # Individual frame files
```

## Configuration

Optional environment variables for token budgets:

```bash
STACK_TOKEN_BUDGET_TOTAL=4000      # Total context budget
STACK_TOKEN_BUDGET_ANCESTORS=1500  # Budget for ancestor frames
STACK_TOKEN_BUDGET_SIBLINGS=1500   # Budget for sibling frames
STACK_TOKEN_BUDGET_CURRENT=800     # Budget for current frame
```

## Reset State

To clear all frame state and start fresh:

```bash
rm -rf .opencode/stack/
```

## Documentation

| Document | Description |
|----------|-------------|
| [SPEC.md](./SPEC.md) | Theoretical framework and design rationale |
| [IMPLEMENTATION.md](./IMPLEMENTATION.md) | Technical implementation details |

## Status

**This is an experimental proof of concept, not production software.**

- Has known bugs and is unstable
- Will have breaking changes without notice
- No support is provided or implied
- Not intended for production systems

This project is shared as an open experiment for others interested in exploring tree-structured context management for AI agents. You are welcome to fork and experiment with it, but please do not build on it with the expectation of ongoing maintenance or support. It is provided as-is.

If you find value in the approach, consider it a starting point for your own implementation rather than a dependency.

## License

MIT
