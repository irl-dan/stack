# Post-E2E Testing Action Items

Based on comprehensive E2E testing of the Flame Graph Context Management plugin, here are the findings and recommended improvements.

## Completed Fixes

The following issues have been addressed:

### ~~BUG-001: flame_invalidate Not Persisting Status Change~~ - FIXED

**Root Cause:** The `flame_plan` and `flame_plan_children` tools were displaying truncated frame IDs (12 characters), so when the LLM tried to use them with `flame_invalidate`, the lookup failed.

**Fix Applied:**
- Changed `flame_plan` to show full frame ID instead of truncated
- Changed `flame_plan_children` to show full frame IDs
- Added `flame_invalidate` usage hint in help text

---

### ~~BUG-002: flame_pop Difficult to Use in Non-Interactive Context~~ - FIXED

**Fix Applied:** Added optional `frameID` parameter to `flame_pop`:
- If `frameID` is provided, pops that specific frame
- If not provided, uses current session (backward compatible)
- Added warning when `generateSummary` is used with non-current frame

**Additionally Discovered:** OpenCode natively supports session resumption via `--session <id>` flag, which is the recommended approach for multi-step workflows.

---

### ~~USR-001: Session Isolation Makes Multi-Step Testing Difficult~~ - RESOLVED

**Resolution:** OpenCode already supports session resumption:
- `opencode run --session <id>` to resume a specific session
- `opencode run --continue` to resume the last session

This was always available but not documented in our testing process.

---

## Remaining Issues

### BUG-003: Default Goal is Session ID Truncated (LOW)

**Severity:** Low - Cosmetic issue

**Description:** When frames are auto-created, the default goal is set to "Session ses_49e9" (truncated session ID) which is not meaningful.

**Reproduction Steps:**
1. Run any `opencode run` command
2. Check state.json
3. Goal shows "Session ses_XXXX"

**Expected:** More meaningful default like "New frame" or prompt for goal

---

## Usability Issues

### USR-002: No Visual Feedback on Context Injection

When context is injected, there's no indication to the user. Only visible in `--print-logs`.

**Recommendations:**
- Add a summary comment in responses when significant context was injected
- Show token usage in `flame_tree` output

### USR-003: Frame Tree Truncates Long Goals

In `flame_tree` output, long goals are truncated with "..." but no way to see full goal.

**Recommendations:**
- Add `flame_frame_info <frameID>` tool for detailed frame view
- Or increase truncation threshold

### USR-004: Multiple Root Frames Accumulate

Every `opencode run` creates a new root frame. Over time, `rootFrameIDs` array grows with many disconnected frames.

**Recommendations:**
- Add `flame_cleanup` to remove stale/empty root frames
- Or auto-cleanup frames with no activity after N days

## Missing Features

### FEAT-001: No Way to Browse Frame Logs

The spec mentions "Full logs persist to disk" and "pointer to full log file" but:
- `logPath` field is never populated
- No tool to export/view frame history

**Recommendations:**
- Implement `flame_export_log <frameID>` to save frame history to markdown
- Populate `logPath` when exporting

### FEAT-002: No Compaction Summary Extraction

The `compactionSummary` field exists but is never populated during normal operation. The compaction hook fires but summary extraction appears incomplete.

**Recommendations:**
- Verify `experimental.session.compacting` hook is extracting summaries
- Test with longer sessions that trigger actual compaction

### FEAT-003: Sibling Context Not Visible

When completing a child frame, the summary should appear in sibling context. This wasn't observed during testing.

**Recommendations:**
- Test with completed siblings present
- Verify `getCompletedSiblings()` is called during context generation

### FEAT-004: No Frame Rollback

Frames can be invalidated but there's no way to rollback file changes made during a frame.

**Recommendations:**
- Consider integrating with git snapshot system
- Add `flame_rollback` to revert changes made during frame

## Architectural Questions

### ARCH-001: Frame ID vs Session ID Confusion

When `flame_activate` converts a planned frame to active:
- Sometimes the ID changes from `plan-*` to `ses_*`
- Sometimes it keeps the original ID

**Question:** What determines this behavior? Should planned frames always get new IDs when activated?

**Note:** Recent changes added `replaceFrameID()` method to properly handle ID changes during activation.

### ARCH-002: Multiple Plugin Instances

Plugin is loaded multiple times (project level, worktree level). Each instance logs independently.

**Question:** Is this intentional? Should state be shared or isolated?

### ARCH-003: Context Injection Timing

Context is injected via `experimental.chat.messages.transform` hook. This happens multiple times per LLM call.

**Question:** Is caching working correctly with multiple invocations?

## Performance Concerns

### PERF-001: State File Read/Write on Every Operation

Every tool call reads and writes the full `state.json` file.

**Impact:** With many frames, this could become slow

**Recommendations:**
- Consider lazy loading of frame details
- Use separate files per frame (already partially implemented)

### PERF-002: Context Generation for Every Message

Even with caching (30s TTL), context is regenerated frequently.

**Impact:** Token estimation and XML generation on hot path

**Recommendations:**
- Increase cache TTL when frame structure hasn't changed
- Cache at frame level, not just session level

## Recommended Improvements (Prioritized)

### ~~P0 - Critical (Fix First)~~ - COMPLETED

1. ~~**Fix flame_invalidate persistence bug**~~ - Fixed (full IDs now shown)
2. ~~**Add explicit frame completion tool**~~ - Fixed (`flame_pop` now accepts `frameID`)

### P1 - High Priority

3. **Implement log export** - Essential for "full logs persist" promise
4. **Fix compaction summary extraction** - Key feature not working

### P2 - Medium Priority

5. **Improve default goals** - Use session title or prompt user
6. **Add frame cleanup** - Remove stale root frames
7. **Add frame detail view** - `flame_frame <frameID>` for full info

### P3 - Nice to Have

8. **Visual context injection indicator** - Show when context was injected
9. **Git integration for rollback** - Connect to snapshot system
10. **Better tree visualization** - Include more metadata

## Testing Coverage Gaps

The following areas need more testing:

1. **Deeply nested frames** - 4+ levels deep
2. **Many siblings** - 10+ frames at same level
3. **Compaction under load** - Force compaction by filling context
4. **Concurrent sessions** - Multiple OpenCode instances
5. **Subagent integration** - TaskTool with child sessions
6. **Autonomy suggestions** - Push/pop heuristics
7. **Session resumption workflows** - Using `--session` flag with flame tools

## Summary

The Flame plugin demonstrates a solid foundation for hierarchical context management. Core features like frame creation, planning, and activation work correctly.

**Fixed in this round:**
1. `flame_invalidate` now works correctly (full IDs shown in output)
2. `flame_pop` accepts optional `frameID` for non-interactive use
3. Documented session resumption via `--session` flag

**Remaining work:**
1. Log export and compaction summary extraction
2. Default goal improvement
3. Frame cleanup utilities
4. Various UX improvements

With the P0 fixes complete, the plugin is now usable for real workflows. The tree structure, context injection, and token budgeting all work as expected.
