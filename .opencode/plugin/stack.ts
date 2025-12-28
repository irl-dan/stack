/**
 * Call Stack Context Manager Plugin - Phase 1.7
 *
 * Tree-structured context management for AI agents.
 *
 * Core Features:
 * - Frame State Manager with file-based persistence
 * - /push and /pop commands for frame lifecycle
 * - Session event tracking and context injection
 *
 * Phase 1.2 Additions:
 * - Token Budget Manager with configurable limits
 * - Intelligent Ancestor Selection
 * - Sibling Relevance Filtering
 * - Context Caching with TTL
 *
 * Phase 1.3 Additions:
 * - Custom compaction prompts for frame completion vs overflow
 * - Better summary extraction from compaction events
 * - Automatic summary storage in frame metadata
 * - stack_frame_summarize tool for manual summary generation
 *
 * Phase 1.4: Skipped (OpenCode handles logging natively)
 *
 * Phase 1.5 Additions:
 * - TaskTool/subagent session detection
 * - Heuristic-based frame creation (duration, message count)
 * - Automatic frame completion on subagent idle
 * - stack_config, stack_stats tools
 * - Configurable subagent detection patterns
 * - Cross-frame context sharing between parent and subagent
 *
 * Phase 1.6 Additions:
 * - Planned frame support (stack_frame_plan, stack_frame_plan_children, stack_frame_activate)
 * - Invalidation cascade (stack_frame_invalidate)
 * - Frame tree visualization (stack_tree)
 * - Track invalidation reason and timestamp in frame metadata
 *
 * Phase 1.7 Additions (Agent Autonomy):
 * - Autonomy configuration (manual/suggest/auto modes)
 * - Push heuristics for failure boundary and context switch detection
 * - Pop heuristics for goal completion and stagnation detection
 * - Auto-suggestion system for context injection
 * - stack_autonomy, stack_should_push, stack_should_pop, stack_auto_suggest tools
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"

// ============================================================================
// Type Definitions
// ============================================================================

/** Frame status per SPEC.md */
type FrameStatus = "planned" | "in_progress" | "completed" | "failed" | "blocked" | "invalidated"

// ============================================================================
// Phase 1.2: Token Budget Types
// ============================================================================

/** Token budget configuration */
interface TokenBudget {
  /** Total tokens available for frame context */
  total: number
  /** Budget for ancestor contexts */
  ancestors: number
  /** Budget for sibling contexts */
  siblings: number
  /** Budget for current frame */
  current: number
  /** Reserved tokens for XML structure overhead */
  overhead: number
}

/** Default token budgets (conservative estimates) */
const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  total: 4000,      // ~16KB of context
  ancestors: 1500,  // ~6KB for ancestor chain
  siblings: 1500,   // ~6KB for sibling contexts
  current: 800,     // ~3KB for current frame
  overhead: 200,    // ~800 bytes for XML tags
}

/** Context cache entry */
interface CacheEntry {
  /** Cached XML context string */
  context: string
  /** When the cache entry was created */
  createdAt: number
  /** Session ID this cache is for */
  sessionID: string
  /** Hash of frame state used for invalidation */
  stateHash: string
  /** Token count estimate */
  tokenCount: number
}

/** Context generation metadata */
interface ContextMetadata {
  /** Total tokens used */
  totalTokens: number
  /** Tokens used by ancestors */
  ancestorTokens: number
  /** Tokens used by siblings */
  siblingTokens: number
  /** Tokens used by current frame */
  currentTokens: number
  /** Number of ancestors included */
  ancestorCount: number
  /** Number of ancestors truncated */
  ancestorsTruncated: number
  /** Number of siblings included */
  siblingCount: number
  /** Number of siblings filtered */
  siblingsFiltered: number
  /** Whether content was truncated */
  wasTruncated: boolean
  /** Cache hit or miss */
  cacheHit: boolean
}

// ============================================================================
// Phase 1.3: Compaction Integration Types
// ============================================================================

/** Compaction type - distinguishes frame completion from overflow compaction */
type CompactionType = "overflow" | "frame_completion" | "manual_summary"

/** State for pending frame completion */
interface PendingFrameCompletion {
  /** Session ID of the frame being completed */
  sessionID: string
  /** Target status for the frame */
  targetStatus: FrameStatus
  /** User-provided summary (optional) */
  userSummary?: string
  /** When the completion was requested */
  requestedAt: number
  /** Whether we're waiting for compaction summary */
  awaitingCompaction: boolean
}

/** Compaction event tracking for summary extraction */
interface CompactionTracking {
  /** Session IDs with pending compaction */
  pendingCompactions: Set<string>
  /** Map of sessionID to expected compaction type */
  compactionTypes: Map<string, CompactionType>
  /** Pending frame completions awaiting summary */
  pendingCompletions: Map<string, PendingFrameCompletion>
}

// ============================================================================
// Phase 1.5: Subagent Integration Types
// ============================================================================

/** Configuration for subagent detection and frame creation heuristics */
interface SubagentConfig {
  /** Whether subagent integration is enabled */
  enabled: boolean
  /** Minimum duration (ms) for a subagent session to be considered meaningful */
  minDuration: number
  /** Minimum message count for a subagent session to be considered meaningful */
  minMessageCount: number
  /** Title patterns that indicate a subagent session (regex strings) */
  subagentPatterns: string[]
  /** Whether to auto-complete frames when subagent sessions go idle */
  autoCompleteOnIdle: boolean
  /** Delay (ms) after idle before auto-completing (allows for follow-up) */
  idleCompletionDelay: number
  /** Whether to inject parent context into subagent frames */
  injectParentContext: boolean
  /** Whether to propagate subagent summaries to parent context */
  propagateSummaries: boolean
}

/** Default subagent configuration */
const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  enabled: true,
  minDuration: 60000,         // 1 minute minimum
  minMessageCount: 3,         // At least 3 messages exchanged
  subagentPatterns: [
    "@.*subagent",            // OpenCode TaskTool pattern: (@agent subagent)
    "subagent",               // Generic subagent mention
    "\\[Task\\]",             // Task marker pattern
  ],
  autoCompleteOnIdle: true,
  idleCompletionDelay: 5000,  // 5 seconds
  injectParentContext: true,
  propagateSummaries: true,
}

/** Tracked subagent session information */
interface SubagentSession {
  /** Session ID of the subagent */
  sessionID: string
  /** Parent session ID */
  parentSessionID: string
  /** Session title */
  title: string
  /** When the session was created */
  createdAt: number
  /** When the session last had activity */
  lastActivityAt: number
  /** Whether this has been identified as a subagent session */
  isSubagent: boolean
  /** Whether a frame has been created for this session */
  hasFrame: boolean
  /** Message count for this session */
  messageCount: number
  /** Scheduled idle completion timer ID (for cleanup) */
  idleTimerID?: ReturnType<typeof setTimeout>
  /** Whether the session is currently idle */
  isIdle: boolean
  /** Whether the session has been completed */
  isCompleted: boolean
}

/** Subagent tracking state */
interface SubagentTracking {
  /** Configuration for subagent detection */
  config: SubagentConfig
  /** Map of sessionID -> SubagentSession for tracked subagent sessions */
  sessions: Map<string, SubagentSession>
  /** Statistics about subagent sessions */
  stats: SubagentStats
}

/** Statistics about subagent sessions */
interface SubagentStats {
  /** Total subagent sessions detected */
  totalDetected: number
  /** Sessions that became frames */
  framesCreated: number
  /** Sessions skipped due to heuristics (too short, etc.) */
  skippedByHeuristics: number
  /** Sessions auto-completed */
  autoCompleted: number
  /** Sessions manually completed */
  manuallyCompleted: number
  /** Last reset timestamp */
  lastReset: number
}

// ============================================================================
// Phase 1.7: Agent Autonomy Types
// ============================================================================

/** Autonomy level per SPEC.md Control Authority section */
type AutonomyLevel = "manual" | "suggest" | "auto"

/** Configuration for agent autonomy behavior */
interface AutonomyConfig {
  /** Current autonomy level */
  level: AutonomyLevel
  /** Confidence threshold for auto-push (0-100) */
  pushThreshold: number
  /** Confidence threshold for auto-pop (0-100) */
  popThreshold: number
  /** Include suggestions in LLM context when level is 'suggest' or 'auto' */
  suggestInContext: boolean
  /** Which heuristics are enabled */
  enabledHeuristics: string[]
}

/** Default autonomy configuration */
const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  level: "suggest",
  pushThreshold: 70,
  popThreshold: 80,
  suggestInContext: true,
  enabledHeuristics: [
    "failure_boundary",
    "context_switch",
    "complexity",
    "duration",
    "goal_completion",
    "stagnation",
    "context_overflow",
  ],
}

/** Result of push heuristic evaluation */
interface PushHeuristicResult {
  /** Whether a push is recommended */
  shouldPush: boolean
  /** Confidence score (0-100) */
  confidence: number
  /** Suggested goal for the new frame */
  suggestedGoal?: string
  /** Primary reason for the recommendation */
  primaryReason: string
  /** All heuristic scores */
  heuristicScores: Record<string, number>
  /** Human-readable explanation */
  explanation: string
}

/** Result of pop heuristic evaluation */
interface PopHeuristicResult {
  /** Whether a pop is recommended */
  shouldPop: boolean
  /** Confidence score (0-100) */
  confidence: number
  /** Suggested status for the frame */
  suggestedStatus: FrameStatus
  /** Primary reason for the recommendation */
  primaryReason: string
  /** All heuristic scores */
  heuristicScores: Record<string, number>
  /** Human-readable explanation */
  explanation: string
}

/** Suggestion generated by autonomy system */
interface AutonomySuggestion {
  /** Type of suggestion */
  type: "push" | "pop"
  /** When the suggestion was generated */
  timestamp: number
  /** Confidence score */
  confidence: number
  /** Suggested goal or status */
  suggestion: string
  /** Reason for the suggestion */
  reason: string
  /** Whether this suggestion was acted upon */
  actedUpon: boolean
}

/** Autonomy tracking state */
interface AutonomyTracking {
  /** Current configuration */
  config: AutonomyConfig
  /** Pending suggestions to inject into context */
  pendingSuggestions: AutonomySuggestion[]
  /** History of suggestions (for stats) */
  suggestionHistory: AutonomySuggestion[]
  /** Last evaluation timestamps per session */
  lastEvaluation: Map<string, number>
  /** Statistics */
  stats: AutonomyStats
}

/** Statistics about autonomy suggestions */
interface AutonomyStats {
  /** Total suggestions made */
  totalSuggestions: number
  /** Push suggestions */
  pushSuggestions: number
  /** Pop suggestions */
  popSuggestions: number
  /** Suggestions acted upon */
  actedUpon: number
  /** Suggestions ignored/expired */
  ignored: number
  /** Auto-triggered pushes (when level is 'auto') */
  autoPushes: number
  /** Auto-triggered pops (when level is 'auto') */
  autoPops: number
  /** Last reset timestamp */
  lastReset: number
}

/** Frame metadata stored for each session acting as a frame */
interface FrameMetadata {
  /** The session ID this frame corresponds to */
  sessionID: string
  /** Parent frame's session ID (undefined for root) */
  parentSessionID?: string
  /** Current status of the frame */
  status: FrameStatus

  // Identity & Success Criteria (set at creation, immutable)
  /** Short name for the frame (e.g., "User Authentication") */
  title: string
  /** Full success criteria - what defines "done" */
  successCriteria: string
  /** Dense compacted version of success criteria for tree/context display */
  successCriteriaCompacted: string

  // Results (set at completion)
  /** Full results - detailed summary of what was accomplished */
  results?: string
  /** Dense compacted version of results for tree/context display */
  resultsCompacted?: string

  /** When the frame was created */
  createdAt: number
  /** When the frame was last updated */
  updatedAt: number
  /** Artifacts produced by this frame (file paths, etc) */
  artifacts: string[]
  /** Key decisions made in this frame */
  decisions: string[]
  /** Path to full log file (when exported) */
  logPath?: string

  // Phase 1.6: Planning and Invalidation fields
  /** Reason for invalidation (if status is 'invalidated') */
  invalidationReason?: string
  /** When the frame was invalidated */
  invalidatedAt?: number
  /** IDs of planned child frames (for planning ahead) */
  plannedChildren?: string[]
}

/** Root frame tree state */
interface StackState {
  /** Version for future migrations */
  version: number
  /** Map of sessionID -> FrameMetadata */
  frames: Record<string, FrameMetadata>
  /** Currently active frame (session ID) */
  activeFrameID?: string
  /** Root frame IDs (frames with no parent) */
  rootFrameIDs: string[]
  /** Last update timestamp */
  updatedAt: number
}

/** Plugin runtime state (not persisted) */
interface RuntimeState {
  /** Currently tracked session ID from chat.message hook */
  currentSessionID: string | null
  /** Processed message IDs for deduplication */
  processedMessageIDs: Set<string>
  /** Hook invocation count for debugging */
  hookInvocationCount: number
  /** Directory for stack data */
  stackDir: string
  /** Plugin initialization time */
  initTime: number
  /** Phase 1.2: Context cache */
  contextCache: Map<string, CacheEntry>
  /** Phase 1.2: Token budget configuration */
  tokenBudget: TokenBudget
  /** Phase 1.2: Cache TTL in milliseconds (default 30 seconds) */
  cacheTTL: number
  /** Phase 1.2: Last context generation metadata */
  lastContextMetadata: ContextMetadata | null
  /** Phase 1.3: Compaction tracking for summary extraction */
  compactionTracking: CompactionTracking
  /** Phase 1.5: Subagent session tracking */
  subagentTracking: SubagentTracking
  /** Phase 1.7: Autonomy tracking for push/pop suggestions */
  autonomyTracking: AutonomyTracking
}

// ============================================================================
// State Management
// ============================================================================

const runtime: RuntimeState = {
  currentSessionID: null,
  processedMessageIDs: new Set(),
  hookInvocationCount: 0,
  stackDir: "",
  initTime: 0,
  // Phase 1.2 additions
  contextCache: new Map(),
  tokenBudget: { ...DEFAULT_TOKEN_BUDGET },
  cacheTTL: 30000, // 30 seconds
  lastContextMetadata: null,
  // Phase 1.3 additions
  compactionTracking: {
    pendingCompactions: new Set(),
    compactionTypes: new Map(),
    pendingCompletions: new Map(),
  },
  // Phase 1.5 additions
  subagentTracking: {
    config: { ...DEFAULT_SUBAGENT_CONFIG },
    sessions: new Map(),
    stats: {
      totalDetected: 0,
      framesCreated: 0,
      skippedByHeuristics: 0,
      autoCompleted: 0,
      manuallyCompleted: 0,
      lastReset: Date.now(),
    },
  },
  // Phase 1.7 additions
  autonomyTracking: {
    config: { ...DEFAULT_AUTONOMY_CONFIG },
    pendingSuggestions: [],
    suggestionHistory: [],
    lastEvaluation: new Map(),
    stats: {
      totalSuggestions: 0,
      pushSuggestions: 0,
      popSuggestions: 0,
      actedUpon: 0,
      ignored: 0,
      autoPushes: 0,
      autoPops: 0,
      lastReset: Date.now(),
    },
  },
}

function getDefaultState(): StackState {
  return {
    version: 1,
    frames: {},
    activeFrameID: undefined,
    rootFrameIDs: [],
    updatedAt: Date.now(),
  }
}

// ============================================================================
// Logging
// ============================================================================

function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString()
  const entry = `[${timestamp}] [stack] ${message}`
  console.log(entry, data !== undefined ? JSON.stringify(data, null, 2) : "")
}

// ============================================================================
// File Storage
// ============================================================================

function getStackDir(projectDir: string): string {
  return path.join(projectDir, ".opencode", "stack")
}

function getFramesDir(projectDir: string): string {
  return path.join(getStackDir(projectDir), "frames")
}

function getStateFilePath(projectDir: string): string {
  return path.join(getStackDir(projectDir), "state.json")
}

function getFrameFilePath(projectDir: string, sessionID: string): string {
  // Sanitize session ID for filename
  const safeID = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
  return path.join(getFramesDir(projectDir), `${safeID}.json`)
}

async function ensureDirectories(projectDir: string): Promise<void> {
  const framesDir = getFramesDir(projectDir)
  await fs.promises.mkdir(framesDir, { recursive: true })
}

async function loadState(projectDir: string): Promise<StackState> {
  const statePath = getStateFilePath(projectDir)
  try {
    const content = await fs.promises.readFile(statePath, "utf-8")
    const state = JSON.parse(content) as StackState
    return state
  } catch (error) {
    // File doesn't exist or is invalid, return default state
    return getDefaultState()
  }
}

async function saveState(projectDir: string, state: StackState): Promise<void> {
  await ensureDirectories(projectDir)
  state.updatedAt = Date.now()
  const statePath = getStateFilePath(projectDir)
  await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2))
}

async function saveFrame(projectDir: string, frame: FrameMetadata): Promise<void> {
  await ensureDirectories(projectDir)
  frame.updatedAt = Date.now()
  const framePath = getFrameFilePath(projectDir, frame.sessionID)
  await fs.promises.writeFile(framePath, JSON.stringify(frame, null, 2))
}

async function loadFrame(projectDir: string, sessionID: string): Promise<FrameMetadata | null> {
  const framePath = getFrameFilePath(projectDir, sessionID)
  try {
    const content = await fs.promises.readFile(framePath, "utf-8")
    return JSON.parse(content) as FrameMetadata
  } catch {
    return null
  }
}

// ============================================================================
// Phase 1.2: Token Budget Manager
// ============================================================================

/**
 * Estimate token count for a string using ~4 chars per token approximation.
 * This is a rough estimate that works reasonably well for English text.
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  // Average of ~4 characters per token for English text
  // This is conservative to avoid context overflow
  return Math.ceil(text.length / 4)
}

/**
 * Truncate text to fit within a token budget, adding indicator if truncated.
 */
function truncateToTokenBudget(text: string, maxTokens: number, indicator: string = "..."): { text: string; wasTruncated: boolean } {
  if (!text) return { text: "", wasTruncated: false }

  const currentTokens = estimateTokens(text)
  if (currentTokens <= maxTokens) {
    return { text, wasTruncated: false }
  }

  // Estimate char limit, accounting for indicator
  const indicatorLength = indicator.length
  const maxChars = (maxTokens * 4) - indicatorLength

  if (maxChars <= 0) {
    return { text: indicator, wasTruncated: true }
  }

  // Truncate to nearest word boundary if possible
  let truncated = text.substring(0, maxChars)
  const lastSpace = truncated.lastIndexOf(" ")
  if (lastSpace > maxChars * 0.8) {
    truncated = truncated.substring(0, lastSpace)
  }

  return { text: truncated + indicator, wasTruncated: true }
}

/**
 * Configure token budget from environment or defaults
 */
function getTokenBudget(): TokenBudget {
  // Allow override via environment variables
  const envTotal = process.env.STACK_TOKEN_BUDGET_TOTAL
  const envAncestors = process.env.STACK_TOKEN_BUDGET_ANCESTORS
  const envSiblings = process.env.STACK_TOKEN_BUDGET_SIBLINGS
  const envCurrent = process.env.STACK_TOKEN_BUDGET_CURRENT

  return {
    total: envTotal ? parseInt(envTotal, 10) : DEFAULT_TOKEN_BUDGET.total,
    ancestors: envAncestors ? parseInt(envAncestors, 10) : DEFAULT_TOKEN_BUDGET.ancestors,
    siblings: envSiblings ? parseInt(envSiblings, 10) : DEFAULT_TOKEN_BUDGET.siblings,
    current: envCurrent ? parseInt(envCurrent, 10) : DEFAULT_TOKEN_BUDGET.current,
    overhead: DEFAULT_TOKEN_BUDGET.overhead,
  }
}

// ============================================================================
// Phase 1.2: Context Caching
// ============================================================================

/**
 * Generate a hash of frame state for cache invalidation.
 * Changes to frame status, summaries, or structure invalidate the cache.
 */
function generateStateHash(
  frame: FrameMetadata | null,
  ancestors: FrameMetadata[],
  siblings: FrameMetadata[],
  plannedChildren: FrameMetadata[] = []
): string {
  const parts = [
    frame?.sessionID || "none",
    frame?.status || "none",
    frame?.updatedAt?.toString() || "0",
    frame?.resultsCompacted?.length?.toString() || "0",
    ancestors.length.toString(),
    ancestors.map(a => `${a.sessionID}:${a.status}:${a.updatedAt}`).join(","),
    siblings.length.toString(),
    siblings.map(s => `${s.sessionID}:${s.status}:${s.updatedAt}`).join(","),
    plannedChildren.length.toString(),
    plannedChildren.map(c => `${c.sessionID}:${c.title}`).join(","),
  ]
  return parts.join("|")
}

/**
 * Check if cache entry is valid (not expired and state matches).
 */
function isCacheValid(entry: CacheEntry | undefined, stateHash: string): boolean {
  if (!entry) return false

  // Check TTL
  const age = Date.now() - entry.createdAt
  if (age > runtime.cacheTTL) {
    return false
  }

  // Check state hash
  if (entry.stateHash !== stateHash) {
    return false
  }

  return true
}

/**
 * Store context in cache.
 */
function cacheContext(sessionID: string, context: string, stateHash: string, tokenCount: number): void {
  const entry: CacheEntry = {
    context,
    createdAt: Date.now(),
    sessionID,
    stateHash,
    tokenCount,
  }
  runtime.contextCache.set(sessionID, entry)

  // Cleanup old cache entries (keep max 50)
  if (runtime.contextCache.size > 50) {
    const entries = Array.from(runtime.contextCache.entries())
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt)
    const toDelete = entries.slice(0, entries.length - 25)
    toDelete.forEach(([key]) => runtime.contextCache.delete(key))
  }
}

/**
 * Invalidate cache for a session (called on state changes).
 */
function invalidateCache(sessionID: string): void {
  runtime.contextCache.delete(sessionID)
  log("Cache invalidated", { sessionID })
}

/**
 * Invalidate all cache entries (for major state changes).
 */
function invalidateAllCache(): void {
  runtime.contextCache.clear()
  log("All cache invalidated")
}

// ============================================================================
// Phase 1.3: Compaction Prompt Generation
// ============================================================================

/**
 * Generate a frame-aware compaction prompt based on frame state and compaction type.
 * Different prompts for overflow compaction vs frame completion.
 */
function generateFrameCompactionPrompt(
  frame: FrameMetadata,
  compactionType: CompactionType,
  ancestors: FrameMetadata[] = [],
  siblings: FrameMetadata[] = []
): string {
  const timestamp = new Date().toISOString()

  // Base context about the frame hierarchy
  let prompt = `## Stack Frame Compaction\n\n`
  prompt += `**Compaction Type:** ${compactionType}\n`
  prompt += `**Timestamp:** ${timestamp}\n\n`

  // Frame identity and success criteria
  prompt += `### Current Frame\n`
  prompt += `- **Frame ID:** ${frame.sessionID.substring(0, 8)}\n`
  prompt += `- **Title:** ${frame.title}\n`
  prompt += `- **Success Criteria:** ${frame.successCriteria}\n`
  prompt += `- **Status:** ${frame.status}\n`
  prompt += `- **Created:** ${new Date(frame.createdAt).toISOString()}\n\n`

  // Include parent frame context if available
  if (ancestors.length > 0) {
    const parent = ancestors[0] // Immediate parent
    prompt += `### Parent Frame Context\n`
    prompt += `- **Parent Title:** ${parent.title}\n`
    prompt += `- **Parent Criteria:** ${parent.successCriteriaCompacted}\n`
    prompt += `- **Parent Status:** ${parent.status}\n`
    if (parent.resultsCompacted) {
      prompt += `- **Parent Results:** ${parent.resultsCompacted.substring(0, 500)}${parent.resultsCompacted.length > 500 ? '...' : ''}\n`
    }
    prompt += `\n`
  }

  // Include artifacts and decisions
  if (frame.artifacts.length > 0) {
    prompt += `### Artifacts Produced\n`
    frame.artifacts.forEach(artifact => {
      prompt += `- ${artifact}\n`
    })
    prompt += `\n`
  }

  if (frame.decisions.length > 0) {
    prompt += `### Key Decisions Made\n`
    frame.decisions.forEach(decision => {
      prompt += `- ${decision}\n`
    })
    prompt += `\n`
  }

  // Include sibling context for awareness
  const completedSiblings = siblings.filter(s => s.status === 'completed' && s.resultsCompacted)
  if (completedSiblings.length > 0) {
    prompt += `### Related Completed Work (Siblings)\n`
    completedSiblings.slice(0, 3).forEach(sibling => {
      prompt += `- **${sibling.title}:** ${sibling.resultsCompacted?.substring(0, 200) || 'No results'}${(sibling.resultsCompacted?.length || 0) > 200 ? '...' : ''}\n`
    })
    prompt += `\n`
  }

  // Type-specific instructions
  if (compactionType === 'frame_completion') {
    prompt += `### Compaction Instructions (Frame Completion)\n\n`
    prompt += `This frame is being completed. Generate a comprehensive summary that:\n\n`
    prompt += `1. **Summarizes progress** toward the success criteria: "${frame.successCriteria}"\n`
    prompt += `2. **Lists key outcomes** - what was accomplished, built, or fixed\n`
    prompt += `3. **Documents decisions** - important choices made and their rationale\n`
    prompt += `4. **Notes dependencies** - any requirements for or from sibling/child frames\n`
    prompt += `5. **Records blockers** - if status is blocked/failed, explain why\n\n`
    prompt += `The summary should be self-contained and useful for the parent frame to understand what was done without needing the full conversation history.\n\n`
    prompt += `**Format:** Write 2-4 paragraphs covering outcomes, decisions, and any remaining concerns.\n`
  } else if (compactionType === 'manual_summary') {
    prompt += `### Compaction Instructions (Manual Summary)\n\n`
    prompt += `Generate a checkpoint summary of work in progress for: "${frame.title}"\n\n`
    prompt += `1. **Current state** - what has been done so far\n`
    prompt += `2. **In-flight work** - what is currently being worked on\n`
    prompt += `3. **Next steps** - immediate next actions planned\n`
    prompt += `4. **Open questions** - any unresolved issues or decisions pending\n\n`
    prompt += `This summary should allow resumption of work after context is compacted.\n`
  } else {
    // Overflow compaction - continuation context
    prompt += `### Compaction Instructions (Overflow - Continuation)\n\n`
    prompt += `Context window overflow detected. Generate a continuation summary that preserves:\n\n`
    prompt += `1. **Frame context** - remind that we're working toward: "${frame.title}" (${frame.successCriteriaCompacted})\n`
    prompt += `2. **Recent progress** - what was accomplished in the compacted portion\n`
    prompt += `3. **Current state** - where things stand now\n`
    prompt += `4. **Active threads** - any in-progress tasks or discussions\n`
    prompt += `5. **Important context** - key facts needed to continue effectively\n\n`
    prompt += `The summary should enable seamless continuation of work without losing critical context.\n`
  }

  return prompt
}

/**
 * Register a pending frame completion that will be finalized when compaction completes.
 */
function registerPendingCompletion(
  sessionID: string,
  targetStatus: FrameStatus,
  userSummary?: string
): void {
  runtime.compactionTracking.pendingCompletions.set(sessionID, {
    sessionID,
    targetStatus,
    userSummary,
    requestedAt: Date.now(),
    awaitingCompaction: true,
  })
  runtime.compactionTracking.compactionTypes.set(sessionID, 'frame_completion')
  log('Registered pending frame completion', { sessionID, targetStatus })
}

/**
 * Mark a session as having a pending compaction of a specific type.
 */
function markPendingCompaction(sessionID: string, type: CompactionType): void {
  runtime.compactionTracking.pendingCompactions.add(sessionID)
  runtime.compactionTracking.compactionTypes.set(sessionID, type)
  log('Marked pending compaction', { sessionID, type })
}

/**
 * Get the compaction type for a session, defaulting to overflow.
 */
function getCompactionType(sessionID: string): CompactionType {
  return runtime.compactionTracking.compactionTypes.get(sessionID) || 'overflow'
}

/**
 * Clear compaction tracking for a session.
 */
function clearCompactionTracking(sessionID: string): void {
  runtime.compactionTracking.pendingCompactions.delete(sessionID)
  runtime.compactionTracking.compactionTypes.delete(sessionID)
  runtime.compactionTracking.pendingCompletions.delete(sessionID)
}

/**
 * Extract summary text from a compaction message.
 * Handles various message formats from OpenCode.
 */
function extractSummaryText(message: { parts?: Array<{ type: string; text?: string }> }): string | null {
  if (!message.parts) return null

  const textPart = message.parts.find(p => p.type === 'text') as { type: string; text?: string } | undefined
  if (!textPart?.text) return null

  // Return the text, optionally cleaning it up
  const text = textPart.text.trim()
  return text.length > 0 ? text : null
}

// ============================================================================
// Phase 1.5: Subagent Integration Functions
// ============================================================================

/**
 * Load subagent configuration from environment variables.
 */
function loadSubagentConfigFromEnv(): Partial<SubagentConfig> {
  const config: Partial<SubagentConfig> = {}

  if (process.env.STACK_SUBAGENT_ENABLED !== undefined) {
    config.enabled = process.env.STACK_SUBAGENT_ENABLED === 'true'
  }
  if (process.env.STACK_SUBAGENT_MIN_DURATION) {
    config.minDuration = parseInt(process.env.STACK_SUBAGENT_MIN_DURATION, 10)
  }
  if (process.env.STACK_SUBAGENT_MIN_MESSAGES) {
    config.minMessageCount = parseInt(process.env.STACK_SUBAGENT_MIN_MESSAGES, 10)
  }
  if (process.env.STACK_SUBAGENT_AUTO_COMPLETE !== undefined) {
    config.autoCompleteOnIdle = process.env.STACK_SUBAGENT_AUTO_COMPLETE === 'true'
  }
  if (process.env.STACK_SUBAGENT_IDLE_DELAY) {
    config.idleCompletionDelay = parseInt(process.env.STACK_SUBAGENT_IDLE_DELAY, 10)
  }
  if (process.env.STACK_SUBAGENT_PATTERNS) {
    config.subagentPatterns = process.env.STACK_SUBAGENT_PATTERNS.split(',').map(s => s.trim())
  }

  return config
}

/**
 * Check if a session title matches subagent patterns.
 */
function isSubagentTitle(title: string): boolean {
  const patterns = runtime.subagentTracking.config.subagentPatterns

  for (const patternStr of patterns) {
    try {
      const pattern = new RegExp(patternStr, 'i')
      if (pattern.test(title)) {
        return true
      }
    } catch (e) {
      // Invalid regex pattern, skip it
      log('Invalid subagent pattern', { pattern: patternStr, error: e })
    }
  }

  return false
}

/**
 * Register a new subagent session for tracking.
 */
function registerSubagentSession(
  sessionID: string,
  parentSessionID: string,
  title: string
): SubagentSession {
  const session: SubagentSession = {
    sessionID,
    parentSessionID,
    title,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    isSubagent: isSubagentTitle(title),
    hasFrame: false,
    messageCount: 0,
    isIdle: false,
    isCompleted: false,
  }

  runtime.subagentTracking.sessions.set(sessionID, session)
  runtime.subagentTracking.stats.totalDetected++

  log('Subagent session registered', {
    sessionID,
    parentSessionID,
    title,
    isSubagent: session.isSubagent,
  })

  return session
}

/**
 * Update activity for a subagent session (called on message events).
 */
function updateSubagentActivity(sessionID: string): void {
  const session = runtime.subagentTracking.sessions.get(sessionID)
  if (!session) return

  session.lastActivityAt = Date.now()
  session.messageCount++
  session.isIdle = false

  // Clear any pending idle timer
  if (session.idleTimerID) {
    clearTimeout(session.idleTimerID)
    session.idleTimerID = undefined
  }

  log('Subagent activity updated', {
    sessionID,
    messageCount: session.messageCount,
  })
}

/**
 * Check if a subagent session meets the heuristics for frame creation.
 */
function meetsFrameHeuristics(session: SubagentSession): boolean {
  const config = runtime.subagentTracking.config

  // Check duration
  const duration = Date.now() - session.createdAt
  if (duration < config.minDuration) {
    log('Subagent session below min duration', {
      sessionID: session.sessionID,
      duration,
      minDuration: config.minDuration,
    })
    return false
  }

  // Check message count
  if (session.messageCount < config.minMessageCount) {
    log('Subagent session below min message count', {
      sessionID: session.sessionID,
      messageCount: session.messageCount,
      minMessageCount: config.minMessageCount,
    })
    return false
  }

  return true
}

/**
 * Create a frame for a subagent session if it meets heuristics.
 * Returns true if frame was created.
 */
async function maybeCreateSubagentFrame(
  sessionID: string,
  manager: FrameStateManager
): Promise<boolean> {
  const session = runtime.subagentTracking.sessions.get(sessionID)
  if (!session || session.hasFrame) {
    return false
  }

  if (!meetsFrameHeuristics(session)) {
    runtime.subagentTracking.stats.skippedByHeuristics++
    return false
  }

  // Create the frame
  try {
    await manager.createFrame(
      session.sessionID,
      session.title || `Subagent task`,
      session.parentSessionID
    )

    session.hasFrame = true
    runtime.subagentTracking.stats.framesCreated++

    // Invalidate parent cache (new child affects context)
    invalidateCache(session.parentSessionID)

    log('Subagent frame created', {
      sessionID: session.sessionID,
      parentSessionID: session.parentSessionID,
      title: session.title,
    })

    return true
  } catch (error) {
    log('Failed to create subagent frame', {
      sessionID,
      error: error instanceof Error ? error.message : error,
    })
    return false
  }
}

/**
 * Handle subagent session going idle.
 * May schedule auto-completion if configured.
 */
function handleSubagentIdle(
  sessionID: string,
  manager: FrameStateManager
): void {
  const session = runtime.subagentTracking.sessions.get(sessionID)
  if (!session || session.isCompleted) return

  const config = runtime.subagentTracking.config

  session.isIdle = true

  log('Subagent session idle', {
    sessionID,
    hasFrame: session.hasFrame,
    autoCompleteOnIdle: config.autoCompleteOnIdle,
  })

  // If auto-completion is enabled and this session has a frame
  if (config.autoCompleteOnIdle && session.hasFrame) {
    // Clear any existing timer
    if (session.idleTimerID) {
      clearTimeout(session.idleTimerID)
    }

    // Schedule auto-completion after delay
    session.idleTimerID = setTimeout(async () => {
      // Verify session is still idle
      const currentSession = runtime.subagentTracking.sessions.get(sessionID)
      if (!currentSession || !currentSession.isIdle || currentSession.isCompleted) {
        return
      }

      log('Auto-completing subagent session', { sessionID })

      try {
        // Complete the frame
        await manager.completeFrame(
          sessionID,
          'completed',
          `(Auto-completed after idle timeout)`
        )

        currentSession.isCompleted = true
        runtime.subagentTracking.stats.autoCompleted++

        // Invalidate caches
        invalidateCache(sessionID)
        invalidateCache(currentSession.parentSessionID)

        log('Subagent session auto-completed', { sessionID })
      } catch (error) {
        log('Failed to auto-complete subagent session', {
          sessionID,
          error: error instanceof Error ? error.message : error,
        })
      }
    }, config.idleCompletionDelay)
  }
}

/**
 * Complete a subagent session manually (e.g., from tool call).
 */
async function completeSubagentSession(
  sessionID: string,
  status: FrameStatus,
  summary: string | undefined,
  manager: FrameStateManager
): Promise<boolean> {
  const session = runtime.subagentTracking.sessions.get(sessionID)
  if (!session) {
    return false
  }

  // Clear any pending idle timer
  if (session.idleTimerID) {
    clearTimeout(session.idleTimerID)
    session.idleTimerID = undefined
  }

  // Create frame first if it doesn't exist but should
  if (!session.hasFrame) {
    await maybeCreateSubagentFrame(sessionID, manager)
  }

  // Complete the frame if it exists
  if (session.hasFrame) {
    try {
      await manager.completeFrame(sessionID, status, summary)
      session.isCompleted = true
      runtime.subagentTracking.stats.manuallyCompleted++

      // Invalidate caches
      invalidateCache(sessionID)
      invalidateCache(session.parentSessionID)

      log('Subagent session manually completed', { sessionID, status })
      return true
    } catch (error) {
      log('Failed to manually complete subagent session', {
        sessionID,
        error: error instanceof Error ? error.message : error,
      })
    }
  }

  return false
}

/**
 * Get subagent tracking stats.
 */
function getSubagentStats(): SubagentStats & { activeSessions: number } {
  return {
    ...runtime.subagentTracking.stats,
    activeSessions: Array.from(runtime.subagentTracking.sessions.values())
      .filter(s => !s.isCompleted).length,
  }
}

/**
 * Reset subagent statistics.
 */
function resetSubagentStats(): void {
  runtime.subagentTracking.stats = {
    totalDetected: 0,
    framesCreated: 0,
    skippedByHeuristics: 0,
    autoCompleted: 0,
    manuallyCompleted: 0,
    lastReset: Date.now(),
  }
}

/**
 * Clean up old subagent sessions (completed sessions older than 1 hour).
 */
function cleanupOldSubagentSessions(): void {
  const maxAge = 60 * 60 * 1000 // 1 hour
  const now = Date.now()
  let cleaned = 0

  for (const [sessionID, session] of runtime.subagentTracking.sessions) {
    if (session.isCompleted && (now - session.lastActivityAt) > maxAge) {
      // Clear any timer
      if (session.idleTimerID) {
        clearTimeout(session.idleTimerID)
      }
      runtime.subagentTracking.sessions.delete(sessionID)
      cleaned++
    }
  }

  if (cleaned > 0) {
    log('Cleaned up old subagent sessions', { count: cleaned })
  }
}

// ============================================================================
// Phase 1.7: Agent Autonomy Functions
// ============================================================================

/**
 * Load autonomy configuration from environment variables.
 */
function loadAutonomyConfigFromEnv(): Partial<AutonomyConfig> {
  const config: Partial<AutonomyConfig> = {}

  if (process.env.STACK_AUTONOMY_LEVEL) {
    const level = process.env.STACK_AUTONOMY_LEVEL.toLowerCase()
    if (level === 'manual' || level === 'suggest' || level === 'auto') {
      config.level = level
    }
  }
  if (process.env.STACK_PUSH_THRESHOLD) {
    config.pushThreshold = Math.min(100, Math.max(0, parseInt(process.env.STACK_PUSH_THRESHOLD, 10)))
  }
  if (process.env.STACK_POP_THRESHOLD) {
    config.popThreshold = Math.min(100, Math.max(0, parseInt(process.env.STACK_POP_THRESHOLD, 10)))
  }
  if (process.env.STACK_SUGGEST_IN_CONTEXT !== undefined) {
    config.suggestInContext = process.env.STACK_SUGGEST_IN_CONTEXT === 'true'
  }
  if (process.env.STACK_ENABLED_HEURISTICS) {
    config.enabledHeuristics = process.env.STACK_ENABLED_HEURISTICS.split(',').map(s => s.trim())
  }

  return config
}

/**
 * Evaluate push heuristics to determine if a new frame should be created.
 *
 * Heuristics per SPEC.md:
 * - Failure Boundary: Is this a discrete unit that could be retried?
 * - Context Switch: Are we switching to different files/concepts?
 * - Complexity: Is the task complex enough to warrant isolation?
 * - Duration: Has significant time/tokens been spent on a subtask?
 */
async function evaluatePushHeuristics(
  manager: FrameStateManager,
  sessionID: string,
  context: {
    recentMessages?: number
    recentFileChanges?: string[]
    currentGoal?: string
    potentialNewGoal?: string
    errorCount?: number
    tokenCount?: number
  }
): Promise<PushHeuristicResult> {
  const config = runtime.autonomyTracking.config
  const frame = await manager.getFrame(sessionID)
  const heuristicScores: Record<string, number> = {}

  // Default context values
  const recentMessages = context.recentMessages || 0
  const recentFileChanges = context.recentFileChanges || []
  const currentGoal = context.currentGoal || frame?.title || ''
  const potentialNewGoal = context.potentialNewGoal || ''
  const errorCount = context.errorCount || 0
  const tokenCount = context.tokenCount || 0

  // ================================
  // Heuristic 1: Failure Boundary
  // ================================
  // High score if there are errors or potential for discrete failure unit
  if (config.enabledHeuristics.includes('failure_boundary')) {
    let failureScore = 0
    if (errorCount > 0) {
      failureScore += Math.min(50, errorCount * 15) // Up to 50 for errors
    }
    // If there's a distinct new goal, it could be a retry boundary
    if (potentialNewGoal && potentialNewGoal !== currentGoal) {
      failureScore += 30
    }
    heuristicScores['failure_boundary'] = failureScore
  }

  // ================================
  // Heuristic 2: Context Switch
  // ================================
  // High score if we're switching files/concepts
  if (config.enabledHeuristics.includes('context_switch')) {
    let contextSwitchScore = 0

    // Check if potential new goal differs significantly from current
    if (potentialNewGoal && currentGoal) {
      const currentKeywords = extractKeywords(currentGoal)
      const newKeywords = extractKeywords(potentialNewGoal)
      let overlap = 0
      for (const word of newKeywords) {
        if (currentKeywords.has(word)) overlap++
      }
      const overlapRatio = currentKeywords.size > 0
        ? overlap / currentKeywords.size
        : 0
      // Low overlap = high context switch score
      contextSwitchScore = Math.round((1 - overlapRatio) * 60)
    }

    // File changes indicate context switch
    if (recentFileChanges.length > 3) {
      contextSwitchScore += 20
    } else if (recentFileChanges.length > 1) {
      contextSwitchScore += 10
    }

    heuristicScores['context_switch'] = contextSwitchScore
  }

  // ================================
  // Heuristic 3: Complexity
  // ================================
  // High score if the task seems complex
  if (config.enabledHeuristics.includes('complexity')) {
    let complexityScore = 0

    // Many messages suggest complex discussion
    if (recentMessages > 20) {
      complexityScore += 40
    } else if (recentMessages > 10) {
      complexityScore += 25
    } else if (recentMessages > 5) {
      complexityScore += 10
    }

    // Multiple file changes suggest complexity
    if (recentFileChanges.length > 5) {
      complexityScore += 30
    } else if (recentFileChanges.length > 2) {
      complexityScore += 15
    }

    heuristicScores['complexity'] = complexityScore
  }

  // ================================
  // Heuristic 4: Duration
  // ================================
  // High score if significant time has been spent
  if (config.enabledHeuristics.includes('duration')) {
    let durationScore = 0

    // Token count as proxy for duration/complexity
    if (tokenCount > 50000) {
      durationScore = 70
    } else if (tokenCount > 30000) {
      durationScore = 50
    } else if (tokenCount > 15000) {
      durationScore = 30
    } else if (tokenCount > 5000) {
      durationScore = 15
    }

    heuristicScores['duration'] = durationScore
  }

  // ================================
  // Calculate overall score
  // ================================
  const scores = Object.values(heuristicScores)
  const confidence = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0

  const shouldPush = confidence >= config.pushThreshold

  // Determine primary reason
  let primaryReason = 'No strong signals'
  let maxScore = 0
  for (const [heuristic, score] of Object.entries(heuristicScores)) {
    if (score > maxScore) {
      maxScore = score
      primaryReason = heuristic.replace('_', ' ')
    }
  }

  // Build explanation
  let explanation = `Push evaluation for session ${sessionID.substring(0, 8)}:\n`
  explanation += `- Confidence: ${confidence}% (threshold: ${config.pushThreshold}%)\n`
  explanation += `- Recommendation: ${shouldPush ? 'PUSH' : 'NO PUSH'}\n`
  explanation += `- Primary reason: ${primaryReason}\n`
  explanation += `- Heuristic scores:\n`
  for (const [h, s] of Object.entries(heuristicScores)) {
    explanation += `  - ${h}: ${s}\n`
  }

  return {
    shouldPush,
    confidence,
    suggestedGoal: potentialNewGoal || undefined,
    primaryReason,
    heuristicScores,
    explanation,
  }
}

/**
 * Evaluate pop heuristics to determine if current frame should be completed.
 *
 * Heuristics:
 * - Goal Completion: Has the goal been achieved?
 * - Stagnation: No progress, repeated failures?
 * - Context Overflow: Approaching context limit?
 */
async function evaluatePopHeuristics(
  manager: FrameStateManager,
  sessionID: string,
  context: {
    goalKeywords?: string[]
    recentArtifacts?: string[]
    successSignals?: string[]
    failureSignals?: string[]
    noProgressTurns?: number
    tokenCount?: number
    contextLimit?: number
  }
): Promise<PopHeuristicResult> {
  const config = runtime.autonomyTracking.config
  const frame = await manager.getFrame(sessionID)
  const heuristicScores: Record<string, number> = {}

  // Default context values
  const goalKeywords = context.goalKeywords || (frame ? Array.from(extractKeywords(`${frame.title} ${frame.successCriteria}`)) : [])
  const recentArtifacts = context.recentArtifacts || frame?.artifacts || []
  const successSignals = context.successSignals || []
  const failureSignals = context.failureSignals || []
  const noProgressTurns = context.noProgressTurns || 0
  const tokenCount = context.tokenCount || 0
  const contextLimit = context.contextLimit || 100000

  let suggestedStatus: FrameStatus = 'completed'

  // ================================
  // Heuristic 1: Goal Completion
  // ================================
  if (config.enabledHeuristics.includes('goal_completion')) {
    let completionScore = 0

    // Success signals increase completion confidence
    if (successSignals.length > 0) {
      completionScore += Math.min(60, successSignals.length * 20)
    }

    // Artifacts produced indicate progress
    if (recentArtifacts.length > 0) {
      completionScore += Math.min(30, recentArtifacts.length * 10)
    }

    // Check keyword coverage in artifacts/signals
    const allText = [...recentArtifacts, ...successSignals].join(' ').toLowerCase()
    let keywordHits = 0
    for (const keyword of goalKeywords) {
      if (allText.includes(keyword)) keywordHits++
    }
    if (goalKeywords.length > 0) {
      completionScore += Math.round((keywordHits / goalKeywords.length) * 30)
    }

    heuristicScores['goal_completion'] = completionScore
  }

  // ================================
  // Heuristic 2: Stagnation
  // ================================
  if (config.enabledHeuristics.includes('stagnation')) {
    let stagnationScore = 0

    // No progress turns
    if (noProgressTurns > 5) {
      stagnationScore = 70
      suggestedStatus = 'blocked'
    } else if (noProgressTurns > 3) {
      stagnationScore = 40
    } else if (noProgressTurns > 1) {
      stagnationScore = 20
    }

    // Failure signals suggest blocking or failure
    if (failureSignals.length > 3) {
      stagnationScore += 40
      suggestedStatus = 'failed'
    } else if (failureSignals.length > 1) {
      stagnationScore += 20
    }

    heuristicScores['stagnation'] = stagnationScore
  }

  // ================================
  // Heuristic 3: Context Overflow
  // ================================
  if (config.enabledHeuristics.includes('context_overflow')) {
    let overflowScore = 0

    const usageRatio = tokenCount / contextLimit
    if (usageRatio > 0.9) {
      overflowScore = 90
    } else if (usageRatio > 0.8) {
      overflowScore = 70
    } else if (usageRatio > 0.7) {
      overflowScore = 50
    } else if (usageRatio > 0.5) {
      overflowScore = 20
    }

    heuristicScores['context_overflow'] = overflowScore
  }

  // ================================
  // Calculate overall score
  // ================================
  const scores = Object.values(heuristicScores)
  const confidence = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0

  const shouldPop = confidence >= config.popThreshold

  // Determine primary reason
  let primaryReason = 'No strong signals'
  let maxScore = 0
  for (const [heuristic, score] of Object.entries(heuristicScores)) {
    if (score > maxScore) {
      maxScore = score
      primaryReason = heuristic.replace('_', ' ')
    }
  }

  // Determine status based on highest scoring heuristic
  if (heuristicScores['stagnation'] > 60) {
    suggestedStatus = failureSignals.length > successSignals.length ? 'failed' : 'blocked'
  } else if (heuristicScores['goal_completion'] > 60) {
    suggestedStatus = 'completed'
  }

  // Build explanation
  let explanation = `Pop evaluation for session ${sessionID.substring(0, 8)}:\n`
  explanation += `- Confidence: ${confidence}% (threshold: ${config.popThreshold}%)\n`
  explanation += `- Recommendation: ${shouldPop ? 'POP' : 'NO POP'}\n`
  explanation += `- Suggested status: ${suggestedStatus}\n`
  explanation += `- Primary reason: ${primaryReason}\n`
  explanation += `- Heuristic scores:\n`
  for (const [h, s] of Object.entries(heuristicScores)) {
    explanation += `  - ${h}: ${s}\n`
  }

  return {
    shouldPop,
    confidence,
    suggestedStatus,
    primaryReason,
    heuristicScores,
    explanation,
  }
}

/**
 * Create a suggestion for push/pop based on heuristic evaluation.
 */
function createSuggestion(
  type: "push" | "pop",
  confidence: number,
  suggestion: string,
  reason: string
): AutonomySuggestion {
  return {
    type,
    timestamp: Date.now(),
    confidence,
    suggestion,
    reason,
    actedUpon: false,
  }
}

/**
 * Add a suggestion to the pending queue and history.
 */
function addSuggestion(suggestion: AutonomySuggestion): void {
  runtime.autonomyTracking.pendingSuggestions.push(suggestion)
  runtime.autonomyTracking.suggestionHistory.push(suggestion)
  runtime.autonomyTracking.stats.totalSuggestions++

  if (suggestion.type === 'push') {
    runtime.autonomyTracking.stats.pushSuggestions++
  } else {
    runtime.autonomyTracking.stats.popSuggestions++
  }

  log('Suggestion added', {
    type: suggestion.type,
    confidence: suggestion.confidence,
    suggestion: suggestion.suggestion,
  })

  // Keep history manageable (last 100 suggestions)
  if (runtime.autonomyTracking.suggestionHistory.length > 100) {
    runtime.autonomyTracking.suggestionHistory =
      runtime.autonomyTracking.suggestionHistory.slice(-50)
  }
}

/**
 * Get pending suggestions for context injection.
 */
function getPendingSuggestions(): AutonomySuggestion[] {
  // Clean up old suggestions (older than 5 minutes)
  const maxAge = 5 * 60 * 1000
  const now = Date.now()

  runtime.autonomyTracking.pendingSuggestions =
    runtime.autonomyTracking.pendingSuggestions.filter(s => {
      if (now - s.timestamp > maxAge) {
        if (!s.actedUpon) {
          runtime.autonomyTracking.stats.ignored++
        }
        return false
      }
      return true
    })

  return runtime.autonomyTracking.pendingSuggestions
}

/**
 * Mark a suggestion as acted upon.
 */
function markSuggestionActedUpon(type: "push" | "pop"): void {
  const pending = runtime.autonomyTracking.pendingSuggestions.find(
    s => s.type === type && !s.actedUpon
  )
  if (pending) {
    pending.actedUpon = true
    runtime.autonomyTracking.stats.actedUpon++

    // Remove from pending
    runtime.autonomyTracking.pendingSuggestions =
      runtime.autonomyTracking.pendingSuggestions.filter(s => s !== pending)
  }
}

/**
 * Format suggestions for context injection.
 * Format: [STACK SUGGESTION: Consider pushing a new frame for "X" - Reason: Y]
 */
function formatSuggestionsForContext(): string {
  const config = runtime.autonomyTracking.config
  if (!config.suggestInContext) return ''
  if (config.level === 'manual') return ''

  const suggestions = getPendingSuggestions()
  if (suggestions.length === 0) return ''

  let output = '\n\n<!-- Stack Autonomy Suggestions -->\n'

  for (const suggestion of suggestions) {
    if (suggestion.type === 'push') {
      output += `[STACK SUGGESTION: Consider pushing a new frame for "${suggestion.suggestion}" - Reason: ${suggestion.reason} (${suggestion.confidence}% confidence)]\n`
    } else {
      output += `[STACK SUGGESTION: Consider popping current frame with status "${suggestion.suggestion}" - Reason: ${suggestion.reason} (${suggestion.confidence}% confidence)]\n`
    }
  }

  return output
}

/**
 * Reset autonomy statistics.
 */
function resetAutonomyStats(): void {
  runtime.autonomyTracking.stats = {
    totalSuggestions: 0,
    pushSuggestions: 0,
    popSuggestions: 0,
    actedUpon: 0,
    ignored: 0,
    autoPushes: 0,
    autoPops: 0,
    lastReset: Date.now(),
  }
  runtime.autonomyTracking.pendingSuggestions = []
  runtime.autonomyTracking.suggestionHistory = []
}

// ============================================================================
// Phase 1.2: Intelligent Ancestor Selection
// ============================================================================

/**
 * Score an ancestor based on relevance and recency.
 * Higher scores = more relevant, should be included first.
 */
function scoreAncestor(ancestor: FrameMetadata, depth: number, currentFrame: FrameMetadata | null): number {
  let score = 0

  // Immediate parent gets highest priority
  if (depth === 0) {
    score += 1000
  } else if (depth === 1) {
    // Grandparent gets high priority
    score += 500
  } else {
    // Deeper ancestors get decreasing priority
    score += Math.max(0, 100 - (depth * 20))
  }

  // Recency bonus (more recent = higher score)
  const ageHours = (Date.now() - ancestor.updatedAt) / (1000 * 60 * 60)
  score += Math.max(0, 50 - ageHours)

  // Status bonus
  if (ancestor.status === "in_progress") {
    score += 30 // Active work is more relevant
  } else if (ancestor.status === "completed") {
    score += 10 // Completed with summary is valuable
  }

  // Has results bonus (more context available)
  if (ancestor.resultsCompacted) {
    score += 20
  }

  // Has artifacts bonus
  if (ancestor.artifacts.length > 0) {
    score += 10
  }

  return score
}

/**
 * Select ancestors within token budget, prioritizing by relevance.
 * Always includes immediate parent if it exists.
 */
function selectAncestors(
  ancestors: FrameMetadata[],
  budget: number,
  currentFrame: FrameMetadata | null
): { selected: FrameMetadata[]; truncatedCount: number; tokensUsed: number } {
  if (ancestors.length === 0) {
    return { selected: [], truncatedCount: 0, tokensUsed: 0 }
  }

  // Score each ancestor
  const scored = ancestors.map((ancestor, depth) => ({
    ancestor,
    depth,
    score: scoreAncestor(ancestor, depth, currentFrame),
    estimatedTokens: estimateTokens(formatAncestorForContext(ancestor)),
  }))

  // Sort by score (highest first), but keep parent at top
  scored.sort((a, b) => {
    // Parent always first
    if (a.depth === 0) return -1
    if (b.depth === 0) return 1
    return b.score - a.score
  })

  // Select within budget
  const selected: FrameMetadata[] = []
  let tokensUsed = 0
  let truncatedCount = 0

  for (const item of scored) {
    if (tokensUsed + item.estimatedTokens <= budget) {
      selected.push(item.ancestor)
      tokensUsed += item.estimatedTokens
    } else {
      truncatedCount++
    }
  }

  // Restore original order (root to parent) for context generation
  selected.sort((a, b) => {
    const depthA = ancestors.indexOf(a)
    const depthB = ancestors.indexOf(b)
    return depthB - depthA // Reverse because ancestors is parent-first
  })

  return { selected, truncatedCount, tokensUsed }
}

/**
 * Format an ancestor for token estimation.
 */
function formatAncestorForContext(ancestor: FrameMetadata): string {
  let content = `${ancestor.title}: ${ancestor.successCriteriaCompacted}`
  if (ancestor.resultsCompacted) {
    content += " " + ancestor.resultsCompacted
  }
  if (ancestor.artifacts.length > 0) {
    content += " " + ancestor.artifacts.join(", ")
  }
  return content
}

// ============================================================================
// Phase 1.2: Sibling Relevance Filtering
// ============================================================================

/**
 * Calculate relevance score for a sibling relative to current frame's goal.
 * Uses keyword overlap and recency.
 */
function scoreSibling(sibling: FrameMetadata, currentCriteria: string): number {
  let score = 0

  // Recency bonus (completed within last hour gets max bonus)
  const ageHours = (Date.now() - sibling.updatedAt) / (1000 * 60 * 60)
  score += Math.max(0, 100 - (ageHours * 10))

  // Keyword overlap with current criteria
  const currentWords = extractKeywords(currentCriteria)
  const siblingWords = extractKeywords(`${sibling.title} ${sibling.successCriteriaCompacted}`)
  const resultsWords = sibling.resultsCompacted ? extractKeywords(sibling.resultsCompacted) : new Set<string>()

  // Check criteria overlap
  for (const word of currentWords) {
    if (siblingWords.has(word)) {
      score += 20 // Strong relevance signal
    }
    if (resultsWords.has(word)) {
      score += 10 // Moderate relevance signal
    }
  }

  // Has results bonus (more useful context)
  if (sibling.resultsCompacted) {
    score += 30
  }

  // Has artifacts bonus (may indicate shared files)
  if (sibling.artifacts.length > 0) {
    score += 15

    // Check for artifact overlap with current frame goal
    const artifactText = sibling.artifacts.join(" ").toLowerCase()
    for (const word of currentWords) {
      if (artifactText.includes(word)) {
        score += 25 // Strong signal - working on related files
      }
    }
  }

  // Status bonus
  if (sibling.status === "completed") {
    score += 20 // Completed work is most valuable
  } else if (sibling.status === "failed") {
    score += 15 // Failed attempts may have lessons
  }

  return score
}

/**
 * Extract significant keywords from text for relevance matching.
 */
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
    "be", "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "this", "that",
    "these", "those", "it", "its", "i", "you", "he", "she", "we", "they",
  ])

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))

  return new Set(words)
}

/**
 * Filter and select siblings within token budget, prioritizing by relevance.
 */
function selectSiblings(
  siblings: FrameMetadata[],
  budget: number,
  currentGoal: string,
  minRelevanceScore: number = 30
): { selected: FrameMetadata[]; filteredCount: number; tokensUsed: number } {
  if (siblings.length === 0) {
    return { selected: [], filteredCount: 0, tokensUsed: 0 }
  }

  // Score each sibling
  const scored = siblings.map(sibling => ({
    sibling,
    score: scoreSibling(sibling, currentGoal),
    estimatedTokens: estimateTokens(formatSiblingForContext(sibling)),
  }))

  // Filter by minimum relevance score
  const relevant = scored.filter(item => item.score >= minRelevanceScore)
  const filteredByScore = scored.length - relevant.length

  // Sort by score (highest first)
  relevant.sort((a, b) => b.score - a.score)

  // Select within budget
  const selected: FrameMetadata[] = []
  let tokensUsed = 0
  let filteredByBudget = 0

  for (const item of relevant) {
    if (tokensUsed + item.estimatedTokens <= budget) {
      selected.push(item.sibling)
      tokensUsed += item.estimatedTokens
    } else {
      filteredByBudget++
    }
  }

  // Sort selected by recency (most recent first)
  selected.sort((a, b) => b.updatedAt - a.updatedAt)

  return {
    selected,
    filteredCount: filteredByScore + filteredByBudget,
    tokensUsed,
  }
}

/**
 * Format a sibling for token estimation.
 */
function formatSiblingForContext(sibling: FrameMetadata): string {
  let content = `${sibling.title}: ${sibling.successCriteriaCompacted}`
  if (sibling.resultsCompacted) {
    content += " " + sibling.resultsCompacted
  }
  if (sibling.artifacts.length > 0) {
    content += " " + sibling.artifacts.join(", ")
  }
  return content
}

// ============================================================================
// Frame State Manager
// ============================================================================

class FrameStateManager {
  constructor(private projectDir: string) {}

  /**
   * Create a new frame (child of the current active frame)
   */
  async createFrame(
    sessionID: string,
    title: string,
    successCriteria: string,
    successCriteriaCompacted: string,
    parentSessionID?: string
  ): Promise<FrameMetadata> {
    const state = await loadState(this.projectDir)

    const frame: FrameMetadata = {
      sessionID,
      parentSessionID,
      status: "in_progress",
      title,
      successCriteria,
      successCriteriaCompacted,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      artifacts: [],
      decisions: [],
    }

    // Add to state
    state.frames[sessionID] = frame
    state.activeFrameID = sessionID

    // Track as root if no parent
    if (!parentSessionID) {
      state.rootFrameIDs.push(sessionID)
    }

    // Persist
    await saveFrame(this.projectDir, frame)
    await saveState(this.projectDir, state)

    log("Frame created", { sessionID, title, parentSessionID })
    return frame
  }

  /**
   * Update frame status
   */
  async updateFrameStatus(
    sessionID: string,
    status: FrameStatus,
    results?: string,
    resultsCompacted?: string
  ): Promise<FrameMetadata | null> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[sessionID]

    if (!frame) {
      log("Frame not found for status update", { sessionID })
      return null
    }

    frame.status = status
    if (results) {
      frame.results = results
    }
    if (resultsCompacted) {
      frame.resultsCompacted = resultsCompacted
    }
    frame.updatedAt = Date.now()

    // Persist
    state.frames[sessionID] = frame
    await saveFrame(this.projectDir, frame)
    await saveState(this.projectDir, state)

    log("Frame status updated", { sessionID, status })
    return frame
  }

  /**
   * Complete the current frame and return parent frame ID
   */
  async completeFrame(
    sessionID: string,
    status: FrameStatus,
    results: string,
    resultsCompacted: string
  ): Promise<string | undefined> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[sessionID]

    if (!frame) {
      log("Frame not found for completion", { sessionID })
      return undefined
    }

    frame.status = status
    frame.results = results
    frame.resultsCompacted = resultsCompacted
    frame.updatedAt = Date.now()

    // Update active frame to parent
    const parentID = frame.parentSessionID
    state.activeFrameID = parentID

    // Persist
    state.frames[sessionID] = frame
    await saveFrame(this.projectDir, frame)
    await saveState(this.projectDir, state)

    log("Frame completed", { sessionID, status, parentID })
    return parentID
  }

  /**
   * Get frame by session ID
   */
  async getFrame(sessionID: string): Promise<FrameMetadata | null> {
    const state = await loadState(this.projectDir)
    return state.frames[sessionID] || null
  }

  /**
   * Get active frame
   */
  async getActiveFrame(): Promise<FrameMetadata | null> {
    const state = await loadState(this.projectDir)
    if (!state.activeFrameID) return null
    return state.frames[state.activeFrameID] || null
  }

  /**
   * Get children of a frame
   */
  async getChildren(sessionID: string): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    return Object.values(state.frames).filter((f) => f.parentSessionID === sessionID)
  }

  /**
   * Get ancestors of a frame (from immediate parent to root)
   */
  async getAncestors(sessionID: string): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    const ancestors: FrameMetadata[] = []

    let current = state.frames[sessionID]
    while (current?.parentSessionID) {
      const parent = state.frames[current.parentSessionID]
      if (parent) {
        ancestors.push(parent)
        current = parent
      } else {
        break
      }
    }

    return ancestors
  }

  /**
   * Get completed siblings of a frame
   */
  async getCompletedSiblings(sessionID: string): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[sessionID]
    if (!frame) return []

    const siblings = Object.values(state.frames).filter(
      (f) =>
        f.parentSessionID === frame.parentSessionID &&
        f.sessionID !== sessionID &&
        f.status === "completed"
    )

    return siblings
  }

  /**
   * Get all frames
   */
  async getAllFrames(): Promise<StackState> {
    return await loadState(this.projectDir)
  }

  /**
   * Load state (Phase 2.1: Alias for getAllFrames for UI consistency)
   */
  async loadState(): Promise<StackState> {
    return await loadState(this.projectDir)
  }

  /**
   * Set active frame
   */
  async setActiveFrame(sessionID: string): Promise<void> {
    const state = await loadState(this.projectDir)
    state.activeFrameID = sessionID
    await saveState(this.projectDir, state)
  }

  /**
   * Initialize or get frame for a session (auto-creates root frames)
   */
  async ensureFrame(sessionID: string, sessionTitle?: string): Promise<FrameMetadata> {
    const existing = await this.getFrame(sessionID)
    if (existing) return existing

    // Create a new root frame for this session with default values
    const title = sessionTitle || `Session ${sessionID.substring(0, 8)}`
    const defaultCriteria = "(Auto-created root frame - set criteria with a planning tool)"
    return await this.createFrame(sessionID, title, defaultCriteria, defaultCriteria)
  }

  // ================================================================
  // Phase 1.6: Planning and Invalidation Methods
  // ================================================================

  /**
   * Create a planned frame (not yet started)
   * Phase 1.6: Planned frames exist in 'planned' status before activation
   */
  async createPlannedFrame(
    sessionID: string,
    title: string,
    successCriteria: string,
    successCriteriaCompacted: string,
    parentSessionID?: string
  ): Promise<FrameMetadata> {
    const state = await loadState(this.projectDir)

    const frame: FrameMetadata = {
      sessionID,
      parentSessionID,
      status: "planned",
      title,
      successCriteria,
      successCriteriaCompacted,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      artifacts: [],
      decisions: [],
      plannedChildren: [],
    }

    // Add to state (but don't make it active)
    state.frames[sessionID] = frame

    // Track as root if no parent
    if (!parentSessionID) {
      state.rootFrameIDs.push(sessionID)
    } else {
      // Add to parent's plannedChildren list
      const parent = state.frames[parentSessionID]
      if (parent) {
        if (!parent.plannedChildren) {
          parent.plannedChildren = []
        }
        parent.plannedChildren.push(sessionID)
        await saveFrame(this.projectDir, parent)
      }
    }

    // Persist
    await saveFrame(this.projectDir, frame)
    await saveState(this.projectDir, state)

    log("Planned frame created", { sessionID, title, parentSessionID })
    return frame
  }

  /**
   * Create multiple planned children for a frame at once
   * Phase 1.6: Allows sketching out B→B1,B2,B3 before starting B
   */
  async createPlannedChildren(
    parentSessionID: string,
    children: Array<{
      sessionID: string
      title: string
      successCriteria: string
      successCriteriaCompacted: string
    }>
  ): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    const parent = state.frames[parentSessionID]

    if (!parent) {
      throw new Error(`Parent frame not found: ${parentSessionID}`)
    }

    const createdFrames: FrameMetadata[] = []

    for (const child of children) {
      const frame: FrameMetadata = {
        sessionID: child.sessionID,
        parentSessionID,
        status: "planned",
        title: child.title,
        successCriteria: child.successCriteria,
        successCriteriaCompacted: child.successCriteriaCompacted,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        artifacts: [],
        decisions: [],
        plannedChildren: [],
      }

      state.frames[child.sessionID] = frame
      await saveFrame(this.projectDir, frame)
      createdFrames.push(frame)

      // Add to parent's plannedChildren list
      if (!parent.plannedChildren) {
        parent.plannedChildren = []
      }
      parent.plannedChildren.push(child.sessionID)
    }

    // Update parent
    await saveFrame(this.projectDir, parent)
    await saveState(this.projectDir, state)

    log("Planned children created", {
      parentSessionID,
      count: children.length,
      childIDs: children.map(c => c.sessionID),
    })

    return createdFrames
  }

  /**
   * Activate a planned frame (change status from 'planned' to 'in_progress')
   * Phase 1.6: Starts work on a previously planned frame
   */
  async activateFrame(sessionID: string): Promise<FrameMetadata | null> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[sessionID]

    if (!frame) {
      log("Frame not found for activation", { sessionID })
      return null
    }

    if (frame.status !== "planned") {
      log("Frame is not in planned status", { sessionID, status: frame.status })
      return null
    }

    frame.status = "in_progress"
    frame.updatedAt = Date.now()

    // Make it the active frame
    state.activeFrameID = sessionID
    state.frames[sessionID] = frame

    await saveFrame(this.projectDir, frame)
    await saveState(this.projectDir, state)

    log("Frame activated", { sessionID, title: frame.title })
    return frame
  }

  /**
   * Replace a frame ID (e.g., when converting plan-* to ses-*)
   * Updates all references: children's parentSessionID, parent's plannedChildren, rootFrameIDs, activeFrameID
   */
  async replaceFrameID(oldID: string, newID: string): Promise<void> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[oldID]

    if (!frame) {
      log("Frame not found for ID replacement", { oldID })
      return
    }

    // Update frame's own ID
    frame.sessionID = newID
    frame.updatedAt = Date.now()

    // Move in frames map
    delete state.frames[oldID]
    state.frames[newID] = frame

    // Update children's parentSessionID
    for (const f of Object.values(state.frames)) {
      if (f.parentSessionID === oldID) {
        f.parentSessionID = newID
        await saveFrame(this.projectDir, f)
      }
    }

    // Update parent's plannedChildren array
    if (frame.parentSessionID) {
      const parent = state.frames[frame.parentSessionID]
      if (parent?.plannedChildren) {
        const idx = parent.plannedChildren.indexOf(oldID)
        if (idx >= 0) {
          parent.plannedChildren[idx] = newID
          await saveFrame(this.projectDir, parent)
        }
      }
    }

    // Update rootFrameIDs
    const rootIdx = state.rootFrameIDs.indexOf(oldID)
    if (rootIdx >= 0) {
      state.rootFrameIDs[rootIdx] = newID
    }

    // Update activeFrameID
    if (state.activeFrameID === oldID) {
      state.activeFrameID = newID
    }

    // Save updated state and frame
    await saveFrame(this.projectDir, frame)
    await saveState(this.projectDir, state)

    // Try to rename the frame file (best effort)
    const oldPath = getFrameFilePath(this.projectDir, oldID)
    const newPath = getFrameFilePath(this.projectDir, newID)
    try {
      await fs.promises.rename(oldPath, newPath)
    } catch {
      // File might not exist or rename might fail, that's okay
      // The frame data is saved with the new ID
    }

    log("Frame ID replaced", { oldID, newID })
  }

  /**
   * Invalidate a frame and cascade to planned children
   * Phase 1.6: When a frame is invalidated:
   *   - All 'planned' children are auto-invalidated
   *   - 'in_progress' children are flagged but not auto-invalidated
   *   - 'completed' children remain completed
   */
  async invalidateFrame(
    sessionID: string,
    reason: string
  ): Promise<{
    invalidated: FrameMetadata
    cascadedPlanned: FrameMetadata[]
    warningInProgress: FrameMetadata[]
  } | null> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[sessionID]

    if (!frame) {
      log("Frame not found for invalidation", { sessionID })
      return null
    }

    // Invalidate the main frame
    frame.status = "invalidated"
    frame.invalidationReason = reason
    frame.invalidatedAt = Date.now()
    frame.updatedAt = Date.now()

    state.frames[sessionID] = frame
    await saveFrame(this.projectDir, frame)

    // Track cascaded and warned frames
    const cascadedPlanned: FrameMetadata[] = []
    const warningInProgress: FrameMetadata[] = []

    // Get all children (direct and nested)
    const getAllDescendants = (parentID: string): FrameMetadata[] => {
      const children = Object.values(state.frames).filter(
        f => f.parentSessionID === parentID
      )
      const descendants: FrameMetadata[] = [...children]
      for (const child of children) {
        descendants.push(...getAllDescendants(child.sessionID))
      }
      return descendants
    }

    const descendants = getAllDescendants(sessionID)

    for (const descendant of descendants) {
      if (descendant.status === "planned") {
        // Auto-invalidate planned children
        descendant.status = "invalidated"
        descendant.invalidationReason = `Parent frame invalidated: ${reason}`
        descendant.invalidatedAt = Date.now()
        descendant.updatedAt = Date.now()
        state.frames[descendant.sessionID] = descendant
        await saveFrame(this.projectDir, descendant)
        cascadedPlanned.push(descendant)
      } else if (descendant.status === "in_progress") {
        // Warn but don't auto-invalidate in-progress children
        warningInProgress.push(descendant)
      }
      // Completed children remain as-is
    }

    // Update active frame if needed
    if (state.activeFrameID === sessionID) {
      state.activeFrameID = frame.parentSessionID
    }

    await saveState(this.projectDir, state)

    log("Frame invalidated with cascade", {
      sessionID,
      reason,
      cascadedPlannedCount: cascadedPlanned.length,
      warningInProgressCount: warningInProgress.length,
    })

    return { invalidated: frame, cascadedPlanned, warningInProgress }
  }

  /**
   * Get all siblings (not just completed) of a frame
   * Phase 1.6: Used for tree visualization
   */
  async getAllSiblings(sessionID: string): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    const frame = state.frames[sessionID]
    if (!frame) return []

    return Object.values(state.frames).filter(
      f => f.parentSessionID === frame.parentSessionID && f.sessionID !== sessionID
    )
  }

  /**
   * Get all children of a frame (any status)
   * Phase 1.6: Enhanced to include all statuses for tree visualization
   */
  async getAllChildren(sessionID: string): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    return Object.values(state.frames).filter(
      f => f.parentSessionID === sessionID
    )
  }

  /**
   * Get frames by status
   * Phase 1.6: Useful for finding all planned frames, etc.
   */
  async getFramesByStatus(status: FrameStatus): Promise<FrameMetadata[]> {
    const state = await loadState(this.projectDir)
    return Object.values(state.frames).filter(f => f.status === status)
  }
}

// ============================================================================
// Context Generation (Phase 1.2 Enhanced)
// ============================================================================

/**
 * Result of context generation including metadata
 */
interface ContextGenerationResult {
  context: string
  metadata: ContextMetadata
  cacheHit: boolean
}

/**
 * Sibling ordering information for stack discipline guidance
 */
interface SiblingOrderInfo {
  /** Current frame's position among siblings (1-indexed) */
  position: number
  /** Total number of siblings including current frame */
  total: number
  /** Number of completed siblings */
  completedCount: number
  /** Number of in-progress siblings (should be 0 for proper stack discipline) */
  inProgressCount: number
  /** Number of planned/pending siblings */
  pendingCount: number
  /** The next pending sibling (if any) - for "next up" guidance */
  nextPending: FrameMetadata | null
  /** Whether there are other in-progress siblings (indicates stack discipline violation) */
  hasOtherInProgress: boolean
}

/**
 * Calculate sibling ordering info for stack discipline guidance.
 * Siblings are ordered by createdAt timestamp.
 */
function calculateSiblingOrder(currentFrame: FrameMetadata, allSiblings: FrameMetadata[]): SiblingOrderInfo {
  // Include current frame in the list for ordering
  const allWithCurrent = [...allSiblings, currentFrame]

  // Sort by createdAt to establish order
  allWithCurrent.sort((a, b) => a.createdAt - b.createdAt)

  // Find current frame's position (1-indexed)
  const position = allWithCurrent.findIndex(f => f.sessionID === currentFrame.sessionID) + 1
  const total = allWithCurrent.length

  // Count by status
  let completedCount = 0
  let inProgressCount = 0
  let pendingCount = 0
  let nextPending: FrameMetadata | null = null
  let hasOtherInProgress = false

  for (const sibling of allWithCurrent) {
    if (sibling.sessionID === currentFrame.sessionID) continue // Skip self

    if (sibling.status === "completed") {
      completedCount++
    } else if (sibling.status === "in_progress") {
      inProgressCount++
      hasOtherInProgress = true
    } else if (sibling.status === "planned") {
      pendingCount++
      // Track the first pending sibling after current frame's position
      if (!nextPending) {
        const siblingPos = allWithCurrent.findIndex(f => f.sessionID === sibling.sessionID) + 1
        if (siblingPos > position) {
          nextPending = sibling
        }
      }
    }
  }

  // If no pending after current, check for any pending before (wrap around)
  if (!nextPending) {
    for (const sibling of allWithCurrent) {
      if (sibling.status === "planned" && sibling.sessionID !== currentFrame.sessionID) {
        nextPending = sibling
        break
      }
    }
  }

  return {
    position,
    total,
    completedCount,
    inProgressCount,
    pendingCount,
    nextPending,
    hasOtherInProgress,
  }
}

/**
 * Generate XML context for injection into LLM calls.
 * Phase 1.2: Includes token budget management, intelligent selection, and caching.
 */
async function generateFrameContext(manager: FrameStateManager, sessionID: string): Promise<string> {
  const result = await generateFrameContextWithMetadata(manager, sessionID)
  return result.context
}

/**
 * Generate XML context with full metadata for debugging and monitoring.
 */
async function generateFrameContextWithMetadata(
  manager: FrameStateManager,
  sessionID: string
): Promise<ContextGenerationResult> {
  const frame = await manager.getFrame(sessionID)
  if (!frame) {
    return {
      context: "",
      metadata: createEmptyMetadata(),
      cacheHit: false,
    }
  }

  // Get all ancestors and siblings first
  const allAncestors = await manager.getAncestors(sessionID)
  const completedSiblings = await manager.getCompletedSiblings(sessionID)
  const allSiblings = await manager.getAllSiblings(sessionID)

  // Calculate sibling ordering info for stack discipline guidance
  const siblingOrderInfo = calculateSiblingOrder(frame, allSiblings)

  // Get planned children for the current frame
  const plannedChildren: FrameMetadata[] = []
  if (frame.plannedChildren && frame.plannedChildren.length > 0) {
    for (const childID of frame.plannedChildren) {
      const child = await manager.getFrame(childID)
      if (child && child.status === "planned") {
        plannedChildren.push(child)
      }
    }
  }

  // Generate state hash for cache lookup (include planned children)
  const stateHash = generateStateHash(frame, allAncestors, allSiblings, plannedChildren)

  // Check cache
  const cachedEntry = runtime.contextCache.get(sessionID)
  if (isCacheValid(cachedEntry, stateHash)) {
    log("Cache hit for context generation", { sessionID })
    return {
      context: cachedEntry!.context,
      metadata: {
        ...createEmptyMetadata(),
        totalTokens: cachedEntry!.tokenCount,
        cacheHit: true,
      },
      cacheHit: true,
    }
  }

  // Get token budget
  const budget = getTokenBudget()

  // Phase 1.2: Intelligent ancestor selection with budget
  const ancestorSelection = selectAncestors(allAncestors, budget.ancestors, frame)

  // Phase 1.2: Sibling relevance filtering with budget (use completed siblings for context)
  const siblingSelection = selectSiblings(completedSiblings, budget.siblings, `${frame.title} ${frame.successCriteria}`)

  // Build context XML with selected frames and ordering guidance
  const { xml, currentTokens, wasTruncated } = buildContextXml(
    sessionID,
    frame,
    ancestorSelection.selected,
    siblingSelection.selected,
    ancestorSelection.truncatedCount,
    siblingSelection.filteredCount,
    budget,
    plannedChildren,
    siblingOrderInfo
  )

  // Calculate total tokens
  const totalTokens = ancestorSelection.tokensUsed + siblingSelection.tokensUsed + currentTokens + budget.overhead

  // Build metadata
  const metadata: ContextMetadata = {
    totalTokens,
    ancestorTokens: ancestorSelection.tokensUsed,
    siblingTokens: siblingSelection.tokensUsed,
    currentTokens,
    ancestorCount: ancestorSelection.selected.length,
    ancestorsTruncated: ancestorSelection.truncatedCount,
    siblingCount: siblingSelection.selected.length,
    siblingsFiltered: siblingSelection.filteredCount,
    wasTruncated,
    cacheHit: false,
  }

  // Cache the result
  cacheContext(sessionID, xml, stateHash, totalTokens)

  // Store metadata for debugging
  runtime.lastContextMetadata = metadata

  log("Context generated", {
    sessionID,
    totalTokens,
    ancestorCount: ancestorSelection.selected.length,
    ancestorsTruncated: ancestorSelection.truncatedCount,
    siblingCount: siblingSelection.selected.length,
    siblingsFiltered: siblingSelection.filteredCount,
    wasTruncated,
    cacheHit: false,
  })

  return { context: xml, metadata, cacheHit: false }
}

/**
 * Build workflow guidance section with stack discipline instructions.
 * This appears at the TOP of the context for maximum visibility.
 */
function buildWorkflowGuidance(
  frame: FrameMetadata,
  plannedChildren: FrameMetadata[],
  siblingOrderInfo?: SiblingOrderInfo
): string {
  let xml = ``

  // Detect if this is a root frame with no planning done yet
  const isRootFrame = !frame.parentSessionID
  const isUnplannedRoot = isRootFrame && plannedChildren.length === 0
  const isAutoCreatedFrame = frame.successCriteria.includes("Auto-created")

  // =========================================================================
  // CORE PHILOSOPHY - This is the PRIMARY instruction for task management
  // =========================================================================
  xml += `  <stack-task-management>\n`
  xml += `    <philosophy>\n`
  xml += `      STACK TOOLS ARE YOUR PRIMARY TASK MANAGEMENT SYSTEM.\n`
  xml += `      Do NOT use TodoWrite. Use stack_frame_push/stack_frame_pop/stack_frame_plan instead.\n`
  xml += `      Every significant unit of work should be a frame with clear success criteria.\n`
  xml += `    </philosophy>\n\n`

  // =========================================================================
  // INITIAL PLANNING GUIDANCE - Critical for new/root sessions
  // =========================================================================
  if (isUnplannedRoot || isAutoCreatedFrame) {
    xml += `    <initial-planning priority="HIGH">\n`
    xml += `      THIS IS A NEW SESSION. Before writing any code:\n`
    xml += `      1. Analyze the task complexity\n`
    xml += `      2. If the task has multiple components/features, use stack_frame_plan to break it down\n`
    xml += `      3. Each child frame should have specific, verifiable success criteria\n`
    xml += `      4. Then use stack_frame_activate to start the first child task\n`
    xml += `      \n`
    xml += `      Example for a complex task:\n`
    xml += `        stack_frame_plan with children: [\n`
    xml += `          { title: "Feature A", successCriteria: "...", successCriteriaCompacted: "..." },\n`
    xml += `          { title: "Feature B", successCriteria: "...", successCriteriaCompacted: "..." }\n`
    xml += `        ]\n`
    xml += `    </initial-planning>\n\n`
  }

  // =========================================================================
  // WHEN TO CREATE CHILD FRAMES - Dynamic decomposition guidance
  // =========================================================================
  xml += `    <when-to-create-child-frames>\n`
  xml += `      CREATE a new child frame (stack_frame_push) when you encounter:\n`
  xml += `      - A subtask that has its own distinct success criteria\n`
  xml += `      - Work that could be done independently or in parallel\n`
  xml += `      - Multiple approaches to try (each approach = separate frame)\n`
  xml += `      - Separable concerns (e.g., implement feature vs write tests)\n`
  xml += `      - Context switches (different files, different subsystems)\n`
  xml += `      - Complexity that exceeds what fits in current frame's scope\n`
  xml += `      - Any task that would benefit from its own summary when complete\n`
  xml += `      \n`
  xml += `      DO NOT cram everything into one frame. Decompose aggressively.\n`
  xml += `      Frames are cheap. Context loss from poor organization is expensive.\n`
  xml += `    </when-to-create-child-frames>\n\n`

  // =========================================================================
  // CURRENT FRAME STATUS
  // =========================================================================
  xml += `    <current-frame>\n`
  xml += `      <title>${escapeXml(frame.title)}</title>\n`
  xml += `      <success-criteria>${escapeXml(frame.successCriteria)}</success-criteria>\n`
  xml += `      <status>${frame.status}</status>\n`
  xml += `    </current-frame>\n\n`

  // =========================================================================
  // POSITION AND SIBLING STATUS
  // =========================================================================
  if (siblingOrderInfo && siblingOrderInfo.total > 1) {
    xml += `    <position>Task ${siblingOrderInfo.position} of ${siblingOrderInfo.total}</position>\n`
    xml += `    <sibling-status completed="${siblingOrderInfo.completedCount}" in-progress="${siblingOrderInfo.inProgressCount + 1}" pending="${siblingOrderInfo.pendingCount}" />\n`

    // Warn about stack discipline violation
    if (siblingOrderInfo.hasOtherInProgress) {
      xml += `    <warning>STACK DISCIPLINE VIOLATION: ${siblingOrderInfo.inProgressCount} other sibling(s) are in_progress. Complete or pop them before starting new work.</warning>\n`
    }
  }

  // =========================================================================
  // NEXT ACTIONS
  // =========================================================================
  if (plannedChildren.length > 0) {
    // Has children to work on
    xml += `    <next-action>Complete current task, then activate first planned child</next-action>\n`
    xml += `    <first-child title="${escapeXml(plannedChildren[0].title)}" id="${plannedChildren[0].sessionID.substring(0, 12)}" />\n`
  } else if (siblingOrderInfo?.nextPending) {
    // No children, but has pending siblings
    xml += `    <next-action>Complete current task with stack_frame_pop, then activate next sibling</next-action>\n`
    xml += `    <next-sibling title="${escapeXml(siblingOrderInfo.nextPending.title)}" id="${siblingOrderInfo.nextPending.sessionID.substring(0, 12)}" />\n`
  } else if (isRootFrame) {
    // Root frame - encourage planning or completion
    xml += `    <next-action>Either: (1) Plan subtasks with stack_frame_plan, OR (2) Complete this task with stack_frame_pop</next-action>\n`
  } else {
    // Leaf node with no pending siblings
    xml += `    <next-action>Complete current task with stack_frame_pop to return to parent</next-action>\n`
  }

  // =========================================================================
  // CORE RULES
  // =========================================================================
  xml += `    <rules>\n`
  xml += `      <rule>COMPLETE your current frame's success criteria before starting siblings</rule>\n`
  xml += `      <rule>Call stack_frame_pop with results/resultsCompacted when done</rule>\n`
  xml += `      <rule>Work DEPTH-FIRST: finish children before moving to siblings</rule>\n`
  xml += `      <rule>CREATE child frames for any significant sub-work (don't cram)</rule>\n`
  xml += `      <rule>NEVER use TodoWrite - stack tools replace it entirely</rule>\n`
  xml += `    </rules>\n`

  xml += `  </stack-task-management>\n`
  return xml
}

/**
 * Build the XML context string with metadata, truncation indicators, and workflow guidance.
 */
function buildContextXml(
  sessionID: string,
  frame: FrameMetadata,
  ancestors: FrameMetadata[],
  siblings: FrameMetadata[],
  ancestorsTruncated: number,
  siblingsFiltered: number,
  budget: TokenBudget,
  plannedChildren: FrameMetadata[] = [],
  siblingOrderInfo?: SiblingOrderInfo
): { xml: string; currentTokens: number; wasTruncated: boolean } {
  let wasTruncated = false
  let xml = `<stack-context session="${sessionID}">\n`

  // Add workflow guidance section FIRST for visibility
  xml += buildWorkflowGuidance(frame, plannedChildren, siblingOrderInfo)

  // Add metadata header for debugging
  xml += `  <metadata>\n`
  xml += `    <budget total="${budget.total}" ancestors="${budget.ancestors}" siblings="${budget.siblings}" current="${budget.current}" />\n`
  if (ancestorsTruncated > 0 || siblingsFiltered > 0) {
    xml += `    <truncation ancestors-omitted="${ancestorsTruncated}" siblings-filtered="${siblingsFiltered}" />\n`
    wasTruncated = true
  }
  xml += `  </metadata>\n`

  // Add ancestor chain (from root to immediate parent)
  if (ancestors.length > 0) {
    xml += `  <ancestors count="${ancestors.length}"${ancestorsTruncated > 0 ? ` omitted="${ancestorsTruncated}"` : ""}>\n`
    for (const ancestor of ancestors) {
      xml += formatFrameXml(ancestor, "    ", budget.ancestors / Math.max(ancestors.length, 1))
    }
    xml += `  </ancestors>\n`
  }

  // Add completed siblings
  if (siblings.length > 0) {
    xml += `  <completed-siblings count="${siblings.length}"${siblingsFiltered > 0 ? ` filtered="${siblingsFiltered}"` : ""}>\n`
    for (const sibling of siblings) {
      xml += formatFrameXml(sibling, "    ", budget.siblings / Math.max(siblings.length, 1))
    }
    xml += `  </completed-siblings>\n`
  }

  // Add current frame with planned children
  const currentFrameXml = formatCurrentFrameXml(frame, "  ", budget.current, plannedChildren)
  xml += currentFrameXml.xml
  if (currentFrameXml.wasTruncated) {
    wasTruncated = true
  }

  xml += `</stack-context>`

  return {
    xml,
    currentTokens: estimateTokens(currentFrameXml.xml),
    wasTruncated,
  }
}

/**
 * Format a single frame (ancestor or sibling) as XML.
 * Uses compacted versions for space efficiency.
 */
function formatFrameXml(frame: FrameMetadata, indent: string, tokenBudgetPerFrame: number): string {
  let xml = `${indent}<frame id="${frame.sessionID.substring(0, 8)}" status="${frame.status}">\n`
  xml += `${indent}  <title>${escapeXml(frame.title)}</title>\n`
  xml += `${indent}  <criteria>${escapeXml(frame.successCriteriaCompacted)}</criteria>\n`

  if (frame.resultsCompacted) {
    // Truncate results if needed
    const resultsBudget = Math.floor(tokenBudgetPerFrame * 0.7) // 70% for results
    const { text: truncatedResults, wasTruncated } = truncateToTokenBudget(
      frame.resultsCompacted,
      resultsBudget,
      " [truncated]"
    )
    xml += `${indent}  <results${wasTruncated ? ' truncated="true"' : ""}>${escapeXml(truncatedResults)}</results>\n`
  }

  if (frame.artifacts.length > 0) {
    xml += `${indent}  <artifacts>${escapeXml(frame.artifacts.join(", "))}</artifacts>\n`
  }

  if (frame.logPath) {
    xml += `${indent}  <log>${escapeXml(frame.logPath)}</log>\n`
  }

  xml += `${indent}</frame>\n`
  return xml
}

/**
 * Format the current frame as XML with full details.
 * Phase 2: Includes planned children to show what work is planned next.
 */
function formatCurrentFrameXml(
  frame: FrameMetadata,
  indent: string,
  tokenBudget: number,
  plannedChildren: FrameMetadata[] = []
): { xml: string; wasTruncated: boolean } {
  let wasTruncated = false
  let xml = `${indent}<current-frame id="${frame.sessionID.substring(0, 8)}" status="${frame.status}">\n`
  xml += `${indent}  <title>${escapeXml(frame.title)}</title>\n`
  xml += `${indent}  <success-criteria>${escapeXml(frame.successCriteria)}</success-criteria>\n`

  if (frame.artifacts.length > 0) {
    xml += `${indent}  <artifacts>${escapeXml(frame.artifacts.join(", "))}</artifacts>\n`
  }

  if (frame.decisions.length > 0) {
    // Truncate decisions if they exceed budget
    const decisionsText = frame.decisions.join("; ")
    const decisionsBudget = Math.floor(tokenBudget * 0.5)
    const { text: truncatedDecisions, wasTruncated: decisionsTruncated } = truncateToTokenBudget(
      decisionsText,
      decisionsBudget,
      " [more decisions omitted]"
    )
    if (decisionsTruncated) {
      wasTruncated = true
    }
    xml += `${indent}  <decisions${decisionsTruncated ? ' truncated="true"' : ""}>${escapeXml(truncatedDecisions)}</decisions>\n`
  }

  // Phase 2: Add planned children section
  if (plannedChildren.length > 0) {
    xml += `${indent}  <planned-children count="${plannedChildren.length}">\n`
    for (const child of plannedChildren) {
      xml += `${indent}    <planned-task id="${child.sessionID.substring(0, 8)}">\n`
      xml += `${indent}      <title>${escapeXml(child.title)}</title>\n`
      xml += `${indent}      <criteria>${escapeXml(child.successCriteriaCompacted)}</criteria>\n`
      xml += `${indent}    </planned-task>\n`
    }
    xml += `${indent}  </planned-children>\n`
  }

  xml += `${indent}</current-frame>\n`
  return { xml, wasTruncated }
}

/**
 * Create empty metadata for cases where no context is generated.
 */
function createEmptyMetadata(): ContextMetadata {
  return {
    totalTokens: 0,
    ancestorTokens: 0,
    siblingTokens: 0,
    currentTokens: 0,
    ancestorCount: 0,
    ancestorsTruncated: 0,
    siblingCount: 0,
    siblingsFiltered: 0,
    wasTruncated: false,
    cacheHit: false,
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

// ============================================================================
// Plugin Export
// ============================================================================

export const StackPlugin: Plugin = async (ctx) => {
  const { project, client, directory } = ctx

  runtime.stackDir = getStackDir(directory)
  runtime.initTime = Date.now()
  // Phase 1.2: Initialize token budget from environment
  runtime.tokenBudget = getTokenBudget()
  // Phase 1.5: Initialize subagent config from environment
  const envSubagentConfig = loadSubagentConfigFromEnv()
  runtime.subagentTracking.config = { ...DEFAULT_SUBAGENT_CONFIG, ...envSubagentConfig }
  // Phase 1.7: Initialize autonomy config from environment
  const envAutonomyConfig = loadAutonomyConfigFromEnv()
  runtime.autonomyTracking.config = { ...DEFAULT_AUTONOMY_CONFIG, ...envAutonomyConfig }

  log("=== STACK PLUGIN INITIALIZED (Phase 1.7) ===")
  log("Plugin context", {
    projectId: project.id,
    directory,
    stackDir: runtime.stackDir,
    initTime: new Date(runtime.initTime).toISOString(),
    tokenBudget: runtime.tokenBudget,
    cacheTTL: runtime.cacheTTL,
    subagentConfig: runtime.subagentTracking.config,
    autonomyConfig: runtime.autonomyTracking.config,
  })

  // Ensure directories exist
  await ensureDirectories(directory)

  // Create frame state manager
  const manager = new FrameStateManager(directory)

  return {
    /**
     * Event hook - track session lifecycle
     */
    event: async ({ event }) => {
      // Track session creation for frame initialization
      if (event.type === "session.created" && "info" in event.properties) {
        const info = event.properties.info as {
          id: string
          parentID?: string
          title?: string
        }

        log("SESSION CREATED", {
          sessionID: info.id,
          parentID: info.parentID,
          title: info.title,
        })

        // Update runtime tracking
        runtime.currentSessionID = info.id

        // Phase 1.5: Enhanced subagent detection and tracking
        if (info.parentID) {
          const parentFrame = await manager.getFrame(info.parentID)

          if (parentFrame && runtime.subagentTracking.config.enabled) {
            // Register this as a potential subagent session
            const subagentSession = registerSubagentSession(
              info.id,
              info.parentID,
              info.title || 'Subagent task'
            )

            // If it matches subagent patterns and parent context injection is enabled,
            // check if we should create a frame immediately or wait for heuristics
            if (subagentSession.isSubagent) {
              log('Subagent session detected', {
                sessionID: info.id,
                parentID: info.parentID,
                title: info.title,
              })

              // For obvious subagent sessions (pattern match), create frame immediately
              // to ensure context injection works from the start
              const goal = info.title || `Subagent task`
              await manager.createFrame(info.id, goal, info.parentID)
              subagentSession.hasFrame = true
              runtime.subagentTracking.stats.framesCreated++

              // Invalidate cache for parent (new child affects context)
              invalidateCache(info.parentID)
            }
            // For non-pattern-matched sessions, we'll create frames based on heuristics
            // when the session goes idle or accumulates enough activity
          } else if (parentFrame) {
            // Subagent integration disabled, but still create frames for child sessions
            // (backwards compatibility with Phase 1.3 behavior)
            const goal = info.title || `Subagent task`
            await manager.createFrame(info.id, goal, info.parentID)
            invalidateCache(info.parentID)
          }
        }
      }

      // Track session becoming active
      if (event.type === "session.updated" && "info" in event.properties) {
        const info = event.properties.info as { id: string }
        runtime.currentSessionID = info.id

        // Ensure frame exists and is active
        const frame = await manager.getFrame(info.id)
        if (frame) {
          await manager.setActiveFrame(info.id)
        }
      }

      // Track session idle for potential frame completion
      if (event.type === "session.idle" && "sessionID" in event.properties) {
        const sessionID = event.properties.sessionID as string
        log("SESSION IDLE", { sessionID })

        // Phase 1.5: Handle subagent session idle
        if (runtime.subagentTracking.config.enabled) {
          const subagentSession = runtime.subagentTracking.sessions.get(sessionID)

          if (subagentSession && !subagentSession.isCompleted) {
            // Try to create frame if it doesn't exist (for non-pattern sessions that now meet heuristics)
            if (!subagentSession.hasFrame) {
              await maybeCreateSubagentFrame(sessionID, manager)
            }

            // Handle idle (may trigger auto-completion)
            handleSubagentIdle(sessionID, manager)
          }
        }

        // Periodic cleanup of old subagent sessions
        cleanupOldSubagentSessions()
      }

      // Track compaction events (Phase 1.3 Enhanced)
      if (event.type === "session.compacted" && "sessionID" in event.properties) {
        const sessionID = event.properties.sessionID as string
        const compactionType = getCompactionType(sessionID)
        const pendingCompletion = runtime.compactionTracking.pendingCompletions.get(sessionID)

        log("SESSION COMPACTED (Phase 1.3)", {
          sessionID,
          compactionType,
          hasPendingCompletion: !!pendingCompletion,
        })

        // Try to fetch the summary message for this frame
        try {
          const messages = await client.session.messages({
            path: { id: sessionID },
          })

          // Look for the most recent summary message (has summary: true flag)
          const summaryMessage = messages.data
            ?.filter((m: { info: { summary?: boolean } }) => m.info.summary === true)
            .pop()

          if (summaryMessage) {
            const summaryText = extractSummaryText(summaryMessage)

            if (summaryText) {
              const frame = await manager.getFrame(sessionID)

              if (pendingCompletion) {
                // This was a frame completion compaction - finalize the completion
                const finalSummary = pendingCompletion.userSummary
                  ? `${pendingCompletion.userSummary}\n\n---\n\n${summaryText}`
                  : summaryText

                // Complete the frame with the summary
                await manager.completeFrame(
                  sessionID,
                  pendingCompletion.targetStatus,
                  finalSummary
                )

                log("Frame completion finalized with compaction summary", {
                  sessionID,
                  targetStatus: pendingCompletion.targetStatus,
                  summaryLength: finalSummary.length,
                  hadUserSummary: !!pendingCompletion.userSummary,
                })

                // Clear the pending completion tracking
                clearCompactionTracking(sessionID)
              } else {
                // This was an overflow or manual compaction - just update the summary
                await manager.updateFrameStatus(
                  sessionID,
                  frame?.status || "in_progress",
                  summaryText
                )

                log("Frame updated with compaction summary", {
                  sessionID,
                  compactionType,
                  summaryLength: summaryText.length,
                })

                // Clear compaction type tracking (but not pending completion)
                runtime.compactionTracking.pendingCompactions.delete(sessionID)
                runtime.compactionTracking.compactionTypes.delete(sessionID)
              }

              // Invalidate cache for this session and parent
              invalidateCache(sessionID)
              if (frame?.parentSessionID) {
                invalidateCache(frame.parentSessionID)
              }
            }
          } else {
            log("No summary message found after compaction", { sessionID })

            // If this was a pending completion but no summary was generated,
            // complete the frame anyway with just the user summary
            if (pendingCompletion && pendingCompletion.userSummary) {
              await manager.completeFrame(
                sessionID,
                pendingCompletion.targetStatus,
                pendingCompletion.userSummary
              )
              clearCompactionTracking(sessionID)
              log("Frame completion finalized with user summary only", {
                sessionID,
                targetStatus: pendingCompletion.targetStatus,
              })
            }
          }
        } catch (error) {
          log("Failed to fetch compaction summary", {
            error: error instanceof Error ? error.message : error,
            sessionID,
            compactionType,
          })

          // If this was a pending completion, complete anyway
          if (pendingCompletion) {
            try {
              await manager.completeFrame(
                sessionID,
                pendingCompletion.targetStatus,
                pendingCompletion.userSummary || "(Summary extraction failed)"
              )
              clearCompactionTracking(sessionID)
              log("Frame completion finalized despite summary extraction failure", {
                sessionID,
              })
            } catch (completionError) {
              log("Failed to finalize frame completion", {
                error: completionError instanceof Error ? completionError.message : completionError,
              })
            }
          }
        }
      }
    },

    /**
     * chat.message hook - track current session ID
     * This fires BEFORE transform hooks and provides sessionID
     */
    "chat.message": async (input, output) => {
      runtime.currentSessionID = input.sessionID
      runtime.hookInvocationCount++

      log("CHAT.MESSAGE", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        invocation: runtime.hookInvocationCount,
      })

      // Ensure frame exists for this session
      await manager.ensureFrame(input.sessionID)

      // Phase 1.5: Track subagent activity
      if (runtime.subagentTracking.config.enabled) {
        updateSubagentActivity(input.sessionID)
      }
    },

    /**
     * experimental.chat.system.transform - inject frame context into system prompt
     * This is the recommended approach for adding context that should guide agent behavior.
     */
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = runtime.currentSessionID
      if (!sessionID) {
        log("No session ID available for context injection")
        return
      }

      // Generate frame context
      let frameContext = await generateFrameContext(manager, sessionID)

      // Phase 1.7: Append autonomy suggestions to context if enabled
      const autonomySuggestions = formatSuggestionsForContext()
      if (autonomySuggestions) {
        frameContext = frameContext + autonomySuggestions
      }

      if (frameContext) {
        // Append to system prompt array
        output.system.push(frameContext)

        log("Frame context injected into system prompt", {
          sessionID,
          contextLength: frameContext.length,
          systemPartsCount: output.system.length,
          hasSuggestions: !!autonomySuggestions,
        })
      }
    },

    /**
     * experimental.session.compacting - customize compaction prompt for frames (Phase 1.3 Enhanced)
     *
     * Provides different compaction prompts based on:
     * - Frame completion (via stack_frame_pop)
     * - Manual summary (via stack_frame_summarize)
     * - Overflow compaction (automatic)
     */
    "experimental.session.compacting": async (input, output) => {
      const frame = await manager.getFrame(input.sessionID)

      if (frame) {
        // Determine compaction type
        const compactionType = getCompactionType(input.sessionID)

        // Get ancestors and siblings for context
        const ancestors = await manager.getAncestors(input.sessionID)
        const siblings = await manager.getCompletedSiblings(input.sessionID)

        // Generate the appropriate compaction prompt
        const compactionPrompt = generateFrameCompactionPrompt(
          frame,
          compactionType,
          ancestors,
          siblings
        )

        // Add frame context to compaction
        output.context.push(compactionPrompt)

        // If this is a frame completion, we can override the prompt
        // to ensure the summary focuses on completion
        if (compactionType === 'frame_completion' || compactionType === 'manual_summary') {
          // The prompt field takes precedence when set
          // We build a complete prompt that includes our instructions
          output.prompt = compactionPrompt
        }

        log("Compaction context added for frame (Phase 1.3)", {
          sessionID: input.sessionID,
          title: frame.title,
          compactionType,
          ancestorCount: ancestors.length,
          siblingCount: siblings.length,
        })
      }
    },

    /**
     * Tool execution hook - auto-track artifacts from file operations
     * Phase 2: Automatically adds modified files to the current frame's artifacts
     */
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: any }
    ) => {
      // Only track file operations (write, edit)
      const fileTools = ["write", "edit"]
      if (!fileTools.includes(input.tool)) {
        return
      }

      // Get the file path from metadata
      const filepath = output.metadata?.filepath || output.metadata?.filePath
      if (!filepath) {
        return
      }

      // Get the current session's frame
      const frame = await manager.getFrame(input.sessionID)
      if (!frame) {
        return
      }

      // Only add if not already in artifacts
      if (frame.artifacts.includes(filepath)) {
        return
      }

      // Add the artifact
      await manager.addArtifact(input.sessionID, filepath)
      invalidateCache(input.sessionID)

      log("AUTO-ARTIFACT: File operation tracked", {
        tool: input.tool,
        sessionID: input.sessionID,
        filepath,
      })
    },

    /**
     * Custom tools for frame control
     */
    tool: {
      /**
       * /push - Create a new child frame
       */
      stack_frame_push: tool({
        description:
          `Create a new child frame for a subtask. Use when starting a distinct unit of work that could be retried or rolled back independently.

SUCCESS CRITERIA FORMAT:
- Define what "done" looks like in concrete, verifiable terms
- Include specific deliverables (files, endpoints, tests, etc.)
- Make it clear when this frame can be marked complete

COMPACTED VERSION:
- Dense, information-rich summary (not a vague generalization)
- Preserve key specifics: names, decisions, constraints
- Can be a few sentences, but should maximize information density`,
        args: {
          title: tool.schema.string().describe("Short name for the frame (e.g., 'User Authentication', 'API Endpoints')"),
          successCriteria: tool.schema.string().describe("Full success criteria - what defines 'done' for this frame. Be specific about deliverables."),
          successCriteriaCompacted: tool.schema.string().describe("Dense compacted version for tree display. Preserve specifics, don't generalize."),
        },
        async execute(args, toolCtx) {
          const parentSessionID = runtime.currentSessionID

          if (!parentSessionID) {
            return "Error: No active session to create child frame from"
          }

          try {
            // Create a new session as child
            const newSession = await client.session.create({
              body: {
                parentID: parentSessionID,
                title: args.title,
              },
            })

            if (!newSession.data) {
              return "Error: Failed to create child session"
            }

            const childSessionID = newSession.data.id

            // Initialize frame for the new session
            await manager.createFrame(
              childSessionID,
              args.title,
              args.successCriteria,
              args.successCriteriaCompacted,
              parentSessionID
            )

            // Invalidate parent cache (new child affects sibling context)
            invalidateCache(parentSessionID)

            log("PUSH: Created child frame", {
              parentSessionID,
              childSessionID,
              title: args.title,
            })

            return `# Frame Created

**Title:** ${args.title}
**Frame ID:** ${childSessionID.substring(0, 8)}
**Parent:** ${parentSessionID.substring(0, 8)}

## Success Criteria
${args.successCriteria}

---
Work on this subtask, then use stack_frame_pop to complete it and return to the parent frame.`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log("PUSH: Failed", { error: message })
            return `Error creating frame: ${message}`
          }
        },
      }),

      /**
       * /pop - Complete current frame and return to parent
       *
       * Requires detailed results and a compacted version for tree display.
       */
      stack_frame_pop: tool({
        description:
          `Complete a frame and return to its parent. Requires both full results and a compacted version.

RESULTS FORMAT:
- Be SPECIFIC, not generic. Include concrete details that enable resumption.
- WHAT was done: specific files, functions, endpoints, components created/modified
- KEY DECISIONS: technical choices made and why (e.g., "Used Redis for caching because X")
- CURRENT STATE: what works now, what's tested, what's deployed
- BLOCKERS/NEXT: any issues hit, dependencies needed, or immediate next steps

COMPACTED VERSION:
- NOT a vague summary - preserve key specifics in condensed form
- Think "compression" not "generalization"
- Can be a few sentences or short paragraph - maximize information density
- This appears in the frame tree and sibling context

AVOID: Vague text like "Made progress on the feature" or "Updated the code"

GOOD EXAMPLE (compacted): "Auth endpoints complete: POST /register, /login, /logout in src/auth/. JWT w/ 24h expiry, bcrypt passwords. Tests passing. Blocked: SMTP config needed for password reset."`,
        args: {
          frameID: tool.schema
            .string()
            .optional()
            .describe("Specific frame ID to complete. If not provided, uses current session."),
          status: tool.schema
            .enum(["completed", "failed", "blocked"])
            .describe("The completion status of this frame"),
          results: tool.schema
            .string()
            .describe("Full detailed results: what was accomplished, decisions made, current state, blockers."),
          resultsCompacted: tool.schema
            .string()
            .describe("Dense compacted version for tree display. Preserve specifics, don't generalize. This appears in sibling/parent context."),
        },
        async execute(args, toolCtx) {
          // Use provided frameID or fall back to current session
          const targetFrameID = args.frameID || runtime.currentSessionID

          if (!targetFrameID) {
            return "Error: No frame ID provided and no active session"
          }

          // Both results fields are required
          if (!args.results || args.results.trim().length === 0) {
            return `Error: results is required. Provide detailed results of what was accomplished.`
          }
          if (!args.resultsCompacted || args.resultsCompacted.trim().length === 0) {
            return `Error: resultsCompacted is required. Provide a dense, information-rich compacted version.`
          }

          const frame = await manager.getFrame(targetFrameID)
          if (!frame) {
            return `Error: Frame not found: ${targetFrameID}`
          }

          if (!frame.parentSessionID) {
            return "Error: Cannot pop from root frame. This is the top-level frame."
          }

          // Prevent re-popping completed frames
          if (frame.status === "completed" || frame.status === "failed" || frame.status === "invalidated") {
            return `Error: Frame already has terminal status: ${frame.status}. Cannot pop again.`
          }

          const parentID = frame.parentSessionID

          // Complete the frame with results
          await manager.completeFrame(
            targetFrameID,
            args.status as FrameStatus,
            args.results,
            args.resultsCompacted
          )

          // Invalidate caches (completed frame affects parent's sibling context)
          invalidateCache(targetFrameID)
          invalidateCache(parentID)

          log("POP: Completed frame", {
            sessionID: targetFrameID,
            status: args.status,
            parentID,
            resultsLength: args.results.length,
          })

          return `# Frame Completed

**Status:** ${args.status}
**Frame:** ${targetFrameID.substring(0, 8)}
**Title:** ${frame.title}
**Parent:** ${parentID.substring(0, 8)}

## Results
${args.results}

## Compacted (for tree)
${args.resultsCompacted}

---
This is now available as context for sibling frames and the parent.`
        },
      }),

      /**
       * /stack-status - Show current frame tree
       */
      stack_status: tool({
        description: "Show the current frame tree and status",
        args: {},
        async execute(args, toolCtx) {
          const state = await manager.getAllFrames()
          const currentID = runtime.currentSessionID

          if (Object.keys(state.frames).length === 0) {
            return "No frames exist yet. Use stack_frame_push to create the first frame."
          }

          let output = "# Stack Frame Tree\n\n"
          output += `Active Frame: ${state.activeFrameID?.substring(0, 8) || "none"}\n\n`

          // Build tree visualization
          function formatFrame(frame: FrameMetadata, indent: number = 0): string {
            const prefix = "  ".repeat(indent)
            const marker = frame.sessionID === currentID ? ">>> " : "    "
            const statusIcon = {
              planned: "[P]",
              in_progress: "[*]",
              completed: "[+]",
              failed: "[X]",
              blocked: "[!]",
              invalidated: "[-]",
            }[frame.status]

            const titleDisplay = `${frame.title}: ${frame.successCriteriaCompacted}`
            let line = `${prefix}${marker}${statusIcon} ${titleDisplay.substring(0, 60)}${titleDisplay.length > 60 ? '...' : ''} (${frame.sessionID.substring(0, 8)})\n`

            // Add results if completed
            if (frame.resultsCompacted && indent < 2) {
              const resultsPreview = frame.resultsCompacted.substring(0, 100)
              line += `${prefix}        Results: ${resultsPreview}${frame.resultsCompacted.length > 100 ? '...' : ''}\n`
            }

            return line
          }

          function printTree(frameID: string, indent: number = 0): string {
            const frame = state.frames[frameID]
            if (!frame) return ""

            let result = formatFrame(frame, indent)

            // Find and print children
            const children = Object.values(state.frames).filter(
              (f) => f.parentSessionID === frameID
            )
            for (const child of children) {
              result += printTree(child.sessionID, indent + 1)
            }

            return result
          }

          // Print from root frames
          for (const rootID of state.rootFrameIDs) {
            output += printTree(rootID)
          }

          // Also print any orphaned frames (frames without parents that aren't in rootFrameIDs)
          const orphans = Object.values(state.frames).filter(
            (f) => !f.parentSessionID && !state.rootFrameIDs.includes(f.sessionID)
          )
          if (orphans.length > 0) {
            output += "\n(Orphaned frames):\n"
            for (const orphan of orphans) {
              output += formatFrame(orphan, 0)
            }
          }

          return output
        },
      }),

      /**
       * stack_frame_details - Show full details for a specific frame
       */
      stack_frame_details: tool({
        description:
          "Show complete details for a specific frame including full success criteria and results. Use this to see the uncompacted versions.",
        args: {
          frameID: tool.schema.string().describe("The frame ID to show details for"),
        },
        async execute(args, toolCtx) {
          if (!args.frameID) {
            return "Error: Frame ID is required"
          }

          const frame = await manager.getFrame(args.frameID)
          if (!frame) {
            return `Error: Frame not found: ${args.frameID}`
          }

          let output = `# Frame Details: ${frame.title}\n\n`
          output += `**Frame ID:** ${frame.sessionID}\n`
          output += `**Status:** ${frame.status}\n`
          output += `**Parent:** ${frame.parentSessionID || "root"}\n`
          output += `**Created:** ${new Date(frame.createdAt).toISOString()}\n`
          output += `**Updated:** ${new Date(frame.updatedAt).toISOString()}\n\n`

          output += `## Success Criteria\n\n`
          output += `${frame.successCriteria}\n\n`
          output += `**Compacted:** ${frame.successCriteriaCompacted}\n\n`

          if (frame.results) {
            output += `## Results\n\n`
            output += `${frame.results}\n\n`
            output += `**Compacted:** ${frame.resultsCompacted}\n\n`
          }

          if (frame.artifacts.length > 0) {
            output += `## Artifacts\n\n`
            frame.artifacts.forEach((a) => (output += `- ${a}\n`))
            output += `\n`
          }

          if (frame.decisions.length > 0) {
            output += `## Decisions\n\n`
            frame.decisions.forEach((d) => (output += `- ${d}\n`))
            output += `\n`
          }

          if (frame.plannedChildren && frame.plannedChildren.length > 0) {
            output += `## Planned Children\n\n`
            frame.plannedChildren.forEach((c) => (output += `- ${c}\n`))
            output += `\n`
          }

          if (frame.invalidationReason) {
            output += `## Invalidation\n\n`
            output += `**Reason:** ${frame.invalidationReason}\n`
            output += `**At:** ${new Date(frame.invalidatedAt!).toISOString()}\n`
          }

          return output
        },
      }),

      /**
       * /stack-add-artifact - Record an artifact produced by this frame
       */
      stack_add_artifact: tool({
        description: "Record an artifact (file, resource, etc) produced by this frame",
        args: {
          artifact: tool.schema.string().describe("The artifact path or description"),
        },
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          const state = await loadState(directory)
          const frame = state.frames[sessionID]
          if (!frame) {
            return "Error: Current session is not a tracked frame"
          }

          frame.artifacts.push(args.artifact)
          frame.updatedAt = Date.now()
          state.frames[sessionID] = frame

          await saveFrame(directory, frame)
          await saveState(directory, state)

          // Phase 1.2: Invalidate cache (artifacts affect sibling relevance scoring)
          invalidateCache(sessionID)

          return `Artifact recorded: "${args.artifact}"`
        },
      }),

      /**
       * /stack-add-decision - Record a key decision made in this frame
       */
      stack_add_decision: tool({
        description: "Record a key decision made in this frame",
        args: {
          decision: tool.schema.string().describe("The decision and its rationale"),
        },
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          const state = await loadState(directory)
          const frame = state.frames[sessionID]
          if (!frame) {
            return "Error: Current session is not a tracked frame"
          }

          frame.decisions.push(args.decision)
          frame.updatedAt = Date.now()
          state.frames[sessionID] = frame

          await saveFrame(directory, frame)
          await saveState(directory, state)

          // Phase 1.2: Invalidate cache (decisions affect context content)
          invalidateCache(sessionID)

          return `Decision recorded: "${args.decision}"`
        },
      }),

      // ================================================================
      // Phase 1.2: Context Assembly Tools
      // ================================================================

      /**
       * /stack-context-info - Show context generation metadata (Phase 1.2)
       */
      stack_context_info: tool({
        description: "Show context generation metadata including token usage, caching info, and what was included/filtered",
        args: {},
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          // Generate fresh context with metadata
          const result = await generateFrameContextWithMetadata(manager, sessionID)

          let output = "# Stack Context Assembly Info (Phase 1.2)\n\n"

          output += "## Token Budget\n"
          output += `- Total budget: ${runtime.tokenBudget.total} tokens\n`
          output += `- Ancestors budget: ${runtime.tokenBudget.ancestors} tokens\n`
          output += `- Siblings budget: ${runtime.tokenBudget.siblings} tokens\n`
          output += `- Current frame budget: ${runtime.tokenBudget.current} tokens\n`
          output += `- Overhead reserved: ${runtime.tokenBudget.overhead} tokens\n\n`

          output += "## Last Context Generation\n"
          output += `- Total tokens used: ${result.metadata.totalTokens}\n`
          output += `- Ancestor tokens: ${result.metadata.ancestorTokens}\n`
          output += `- Sibling tokens: ${result.metadata.siblingTokens}\n`
          output += `- Current frame tokens: ${result.metadata.currentTokens}\n\n`

          output += "## Selection Results\n"
          output += `- Ancestors included: ${result.metadata.ancestorCount}\n`
          output += `- Ancestors truncated: ${result.metadata.ancestorsTruncated}\n`
          output += `- Siblings included: ${result.metadata.siblingCount}\n`
          output += `- Siblings filtered: ${result.metadata.siblingsFiltered}\n`
          output += `- Content truncated: ${result.metadata.wasTruncated ? "yes" : "no"}\n\n`

          output += "## Caching\n"
          output += `- Cache hit: ${result.cacheHit ? "yes" : "no"}\n`
          output += `- Cache TTL: ${runtime.cacheTTL / 1000} seconds\n`
          output += `- Cache entries: ${runtime.contextCache.size}\n\n`

          output += "## Environment Overrides\n"
          output += `- STACK_TOKEN_BUDGET_TOTAL: ${process.env.STACK_TOKEN_BUDGET_TOTAL || "(not set)"}\n`
          output += `- STACK_TOKEN_BUDGET_ANCESTORS: ${process.env.STACK_TOKEN_BUDGET_ANCESTORS || "(not set)"}\n`
          output += `- STACK_TOKEN_BUDGET_SIBLINGS: ${process.env.STACK_TOKEN_BUDGET_SIBLINGS || "(not set)"}\n`
          output += `- STACK_TOKEN_BUDGET_CURRENT: ${process.env.STACK_TOKEN_BUDGET_CURRENT || "(not set)"}\n`

          return output
        },
      }),

      /**
       * /stack-context-preview - Preview the actual XML context that would be injected (Phase 1.2)
       */
      stack_context_preview: tool({
        description: "Preview the actual XML context that would be injected into LLM calls",
        args: {
          maxLength: tool.schema
            .number()
            .optional()
            .describe("Maximum characters to show (default 2000)"),
        },
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          const context = await generateFrameContext(manager, sessionID)
          const maxLength = args.maxLength || 2000

          if (!context) {
            return "No context available for current session"
          }

          let output = "# Stack Context Preview\n\n"
          output += `Session: ${sessionID.substring(0, 8)}\n`
          output += `Context length: ${context.length} characters (~${estimateTokens(context)} tokens)\n\n`
          output += "```xml\n"

          if (context.length > maxLength) {
            output += context.substring(0, maxLength)
            output += `\n... [truncated, ${context.length - maxLength} more characters]\n`
          } else {
            output += context
          }

          output += "\n```"

          return output
        },
      }),

      /**
       * /stack-cache-clear - Clear the context cache (Phase 1.2)
       */
      stack_cache_clear: tool({
        description: "Clear the context cache for all sessions or a specific session",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Optional session ID to clear cache for (clears all if not provided)"),
        },
        async execute(args, toolCtx) {
          if (args.sessionID) {
            invalidateCache(args.sessionID)
            return `Cache cleared for session: ${args.sessionID.substring(0, 8)}`
          } else {
            invalidateAllCache()
            return `All cache cleared (${runtime.contextCache.size} entries removed)`
          }
        },
      }),

      // ================================================================
      // Phase 1.3: Compaction Integration Tools
      // ================================================================

      /**
       * /stack-summarize - Manually trigger summary generation for current frame
       *
       * This tool captures the current state of work in progress without
       * completing the frame. Useful for checkpointing before a long operation
       * or when context is getting full.
       */
      stack_frame_summarize: tool({
        description:
          "Manually trigger summary generation for the current frame. Captures current state without completing the frame. Useful before long operations or when context is filling up.",
        args: {
          note: tool.schema
            .string()
            .optional()
            .describe("Optional note to include in the summary prompt (e.g., 'checkpoint before refactoring')"),
        },
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          const frame = await manager.getFrame(sessionID)
          if (!frame) {
            return "Error: Current session is not a tracked frame"
          }

          // Mark this session for manual summary compaction
          markPendingCompaction(sessionID, 'manual_summary')

          // Generate the compaction prompt context
          const ancestors = await manager.getAncestors(sessionID)
          const siblings = await manager.getCompletedSiblings(sessionID)

          let output = `# Manual Summary Request\n\n`
          output += `**Frame:** ${frame.sessionID.substring(0, 8)}\n`
          output += `**Title:** ${frame.title}\n`
          output += `**Success Criteria:** ${frame.successCriteria}\n`
          output += `**Status:** ${frame.status}\n\n`

          if (args.note) {
            output += `**Note:** ${args.note}\n\n`
          }

          output += `The next compaction event for this session will use the manual summary prompt.\n\n`
          output += `**Instructions:** To generate the summary now, you can:\n`
          output += `1. Continue working until automatic compaction triggers, OR\n`
          output += `2. Ask me to generate a summary of the current work\n\n`

          output += `**Current frame context:**\n`
          output += `- Artifacts: ${frame.artifacts.length > 0 ? frame.artifacts.join(', ') : 'none'}\n`
          output += `- Decisions: ${frame.decisions.length > 0 ? frame.decisions.length + ' recorded' : 'none'}\n`
          output += `- Ancestors: ${ancestors.length}\n`
          output += `- Completed siblings: ${siblings.length}\n`

          log("Manual summary requested", {
            sessionID,
            title: frame.title,
            note: args.note,
          })

          return output
        },
      }),

      /**
       * /stack-compaction-info - Show compaction tracking state (Phase 1.3)
       */
      stack_compaction_info: tool({
        description: "Show current compaction tracking state including pending completions and compaction types",
        args: {},
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID

          let output = "# Stack Compaction Tracking Info (Phase 1.3)\n\n"

          output += "## Current Session\n"
          output += `- Session ID: ${sessionID?.substring(0, 8) || 'none'}\n`

          if (sessionID) {
            const compactionType = getCompactionType(sessionID)
            const pendingCompletion = runtime.compactionTracking.pendingCompletions.get(sessionID)
            const isPending = runtime.compactionTracking.pendingCompactions.has(sessionID)

            output += `- Has pending compaction: ${isPending ? 'yes' : 'no'}\n`
            output += `- Compaction type: ${compactionType}\n`
            output += `- Has pending completion: ${pendingCompletion ? 'yes' : 'no'}\n`

            if (pendingCompletion) {
              output += `\n### Pending Completion\n`
              output += `- Target status: ${pendingCompletion.targetStatus}\n`
              output += `- Has user summary: ${pendingCompletion.userSummary ? 'yes' : 'no'}\n`
              output += `- Requested at: ${new Date(pendingCompletion.requestedAt).toISOString()}\n`
              output += `- Awaiting compaction: ${pendingCompletion.awaitingCompaction}\n`
            }
          }

          output += `\n## Global Tracking State\n`
          output += `- Pending compactions: ${runtime.compactionTracking.pendingCompactions.size}\n`
          output += `- Compaction types tracked: ${runtime.compactionTracking.compactionTypes.size}\n`
          output += `- Pending completions: ${runtime.compactionTracking.pendingCompletions.size}\n`

          if (runtime.compactionTracking.pendingCompactions.size > 0) {
            output += `\n### Pending Sessions\n`
            runtime.compactionTracking.pendingCompactions.forEach(sid => {
              const type = runtime.compactionTracking.compactionTypes.get(sid) || 'unknown'
              output += `- ${sid.substring(0, 8)}: ${type}\n`
            })
          }

          return output
        },
      }),

      /**
       * /stack-get-summary - Retrieve the current compaction summary for a frame
       */
      stack_get_summary: tool({
        description: "Get the compaction summary for the current frame or a specific frame",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Optional session ID (uses current frame if not provided)"),
        },
        async execute(args, toolCtx) {
          const sessionID = args.sessionID || runtime.currentSessionID
          if (!sessionID) {
            return "Error: No session ID provided and no active session"
          }

          const frame = await manager.getFrame(sessionID)
          if (!frame) {
            return `Error: No frame found for session ${sessionID.substring(0, 8)}`
          }

          let output = `# Frame Summary\n\n`
          output += `**Frame ID:** ${frame.sessionID.substring(0, 8)}\n`
          output += `**Title:** ${frame.title}\n`
          output += `**Success Criteria:** ${frame.successCriteria}\n`
          output += `**Status:** ${frame.status}\n`
          output += `**Created:** ${new Date(frame.createdAt).toISOString()}\n`
          output += `**Updated:** ${new Date(frame.updatedAt).toISOString()}\n\n`

          if (frame.resultsCompacted) {
            output += `## Results\n\n${frame.results || frame.resultsCompacted}\n`
          } else {
            output += `*No results available yet.*\n`
          }

          if (frame.artifacts.length > 0) {
            output += `\n## Artifacts\n`
            frame.artifacts.forEach(a => {
              output += `- ${a}\n`
            })
          }

          if (frame.decisions.length > 0) {
            output += `\n## Decisions\n`
            frame.decisions.forEach(d => {
              output += `- ${d}\n`
            })
          }

          return output
        },
      }),

      // ================================================================
      // Phase 1.5: Subagent Integration Tools
      // ================================================================

      /**
       * /stack-config - View and modify subagent integration settings
       */
      stack_config: tool({
        description: "View or modify subagent integration settings. Shows current configuration and allows changing settings.",
        args: {
          enabled: tool.schema
            .boolean()
            .optional()
            .describe("Enable or disable subagent integration"),
          minDuration: tool.schema
            .number()
            .optional()
            .describe("Minimum duration (ms) for a subagent session to be considered meaningful"),
          minMessageCount: tool.schema
            .number()
            .optional()
            .describe("Minimum message count for a subagent session to be considered meaningful"),
          autoCompleteOnIdle: tool.schema
            .boolean()
            .optional()
            .describe("Whether to auto-complete frames when subagent sessions go idle"),
          idleCompletionDelay: tool.schema
            .number()
            .optional()
            .describe("Delay (ms) after idle before auto-completing"),
          addPattern: tool.schema
            .string()
            .optional()
            .describe("Add a new subagent detection pattern (regex)"),
          removePattern: tool.schema
            .string()
            .optional()
            .describe("Remove a subagent detection pattern"),
          injectParentContext: tool.schema
            .boolean()
            .optional()
            .describe("Whether to inject parent context into subagent frames"),
          propagateSummaries: tool.schema
            .boolean()
            .optional()
            .describe("Whether to propagate subagent summaries to parent context"),
        },
        async execute(args, toolCtx) {
          const config = runtime.subagentTracking.config
          let modified = false

          // Apply modifications
          if (args.enabled !== undefined) {
            config.enabled = args.enabled
            modified = true
          }
          if (args.minDuration !== undefined) {
            config.minDuration = args.minDuration
            modified = true
          }
          if (args.minMessageCount !== undefined) {
            config.minMessageCount = args.minMessageCount
            modified = true
          }
          if (args.autoCompleteOnIdle !== undefined) {
            config.autoCompleteOnIdle = args.autoCompleteOnIdle
            modified = true
          }
          if (args.idleCompletionDelay !== undefined) {
            config.idleCompletionDelay = args.idleCompletionDelay
            modified = true
          }
          if (args.injectParentContext !== undefined) {
            config.injectParentContext = args.injectParentContext
            modified = true
          }
          if (args.propagateSummaries !== undefined) {
            config.propagateSummaries = args.propagateSummaries
            modified = true
          }
          if (args.addPattern) {
            // Validate pattern
            try {
              new RegExp(args.addPattern)
              if (!config.subagentPatterns.includes(args.addPattern)) {
                config.subagentPatterns.push(args.addPattern)
                modified = true
              }
            } catch (e) {
              return `Error: Invalid regex pattern: ${args.addPattern}`
            }
          }
          if (args.removePattern) {
            const index = config.subagentPatterns.indexOf(args.removePattern)
            if (index > -1) {
              config.subagentPatterns.splice(index, 1)
              modified = true
            }
          }

          // Build output
          let output = `# Subagent Integration Configuration (Phase 1.5)\n\n`

          if (modified) {
            output += `**Configuration updated!**\n\n`
          }

          output += `## Core Settings\n`
          output += `- **Enabled:** ${config.enabled}\n`
          output += `- **Min Duration:** ${config.minDuration}ms (${(config.minDuration / 1000).toFixed(1)}s)\n`
          output += `- **Min Message Count:** ${config.minMessageCount}\n\n`

          output += `## Auto-Completion\n`
          output += `- **Auto-complete on Idle:** ${config.autoCompleteOnIdle}\n`
          output += `- **Idle Completion Delay:** ${config.idleCompletionDelay}ms (${(config.idleCompletionDelay / 1000).toFixed(1)}s)\n\n`

          output += `## Context Sharing\n`
          output += `- **Inject Parent Context:** ${config.injectParentContext}\n`
          output += `- **Propagate Summaries:** ${config.propagateSummaries}\n\n`

          output += `## Detection Patterns\n`
          if (config.subagentPatterns.length === 0) {
            output += `*No patterns configured*\n`
          } else {
            config.subagentPatterns.forEach((pattern, i) => {
              output += `${i + 1}. \`${pattern}\`\n`
            })
          }

          output += `\n## Environment Variables\n`
          output += `These environment variables can be set to override defaults at startup:\n`
          output += `- \`STACK_SUBAGENT_ENABLED\`: ${process.env.STACK_SUBAGENT_ENABLED || '(not set)'}\n`
          output += `- \`STACK_SUBAGENT_MIN_DURATION\`: ${process.env.STACK_SUBAGENT_MIN_DURATION || '(not set)'}\n`
          output += `- \`STACK_SUBAGENT_MIN_MESSAGES\`: ${process.env.STACK_SUBAGENT_MIN_MESSAGES || '(not set)'}\n`
          output += `- \`STACK_SUBAGENT_AUTO_COMPLETE\`: ${process.env.STACK_SUBAGENT_AUTO_COMPLETE || '(not set)'}\n`
          output += `- \`STACK_SUBAGENT_IDLE_DELAY\`: ${process.env.STACK_SUBAGENT_IDLE_DELAY || '(not set)'}\n`
          output += `- \`STACK_SUBAGENT_PATTERNS\`: ${process.env.STACK_SUBAGENT_PATTERNS || '(not set)'}\n`

          return output
        },
      }),

      /**
       * /stack-stats - Show statistics about detected subagent sessions
       */
      stack_stats: tool({
        description: "Show statistics about detected subagent sessions, including counts, completion rates, and active sessions.",
        args: {
          reset: tool.schema
            .boolean()
            .optional()
            .describe("Reset all statistics"),
          showActive: tool.schema
            .boolean()
            .optional()
            .describe("Show details of all active (non-completed) sessions (default: true)"),
        },
        async execute(args, toolCtx) {
          if (args.reset) {
            resetSubagentStats()
            return "Subagent statistics have been reset."
          }

          const stats = getSubagentStats()
          const showActive = args.showActive !== false

          let output = `# Subagent Integration Statistics (Phase 1.5)\n\n`

          output += `## Summary\n`
          output += `- **Total Sessions Detected:** ${stats.totalDetected}\n`
          output += `- **Frames Created:** ${stats.framesCreated}\n`
          output += `- **Skipped (heuristics):** ${stats.skippedByHeuristics}\n`
          output += `- **Auto-completed:** ${stats.autoCompleted}\n`
          output += `- **Manually Completed:** ${stats.manuallyCompleted}\n`
          output += `- **Currently Active:** ${stats.activeSessions}\n\n`

          // Calculate percentages
          if (stats.totalDetected > 0) {
            const frameRate = (stats.framesCreated / stats.totalDetected * 100).toFixed(1)
            const skipRate = (stats.skippedByHeuristics / stats.totalDetected * 100).toFixed(1)
            const autoCompleteRate = stats.framesCreated > 0
              ? (stats.autoCompleted / stats.framesCreated * 100).toFixed(1)
              : '0.0'

            output += `## Rates\n`
            output += `- **Frame Creation Rate:** ${frameRate}%\n`
            output += `- **Heuristic Skip Rate:** ${skipRate}%\n`
            output += `- **Auto-completion Rate:** ${autoCompleteRate}% of frames\n\n`
          }

          output += `## Tracking Info\n`
          output += `- **Last Reset:** ${new Date(stats.lastReset).toISOString()}\n`
          output += `- **Sessions in Memory:** ${runtime.subagentTracking.sessions.size}\n`
          output += `- **Integration Enabled:** ${runtime.subagentTracking.config.enabled}\n\n`

          // Show active sessions if requested
          if (showActive && stats.activeSessions > 0) {
            output += `## Active Sessions\n`
            const activeSessions = Array.from(runtime.subagentTracking.sessions.values())
              .filter(s => !s.isCompleted)
              .sort((a, b) => b.lastActivityAt - a.lastActivityAt)

            activeSessions.forEach(session => {
              const age = Date.now() - session.createdAt
              const idleTime = Date.now() - session.lastActivityAt
              const ageStr = formatDuration(age)
              const idleStr = formatDuration(idleTime)

              output += `\n### ${session.sessionID.substring(0, 8)}\n`
              output += `- **Title:** ${session.title}\n`
              output += `- **Parent:** ${session.parentSessionID.substring(0, 8)}\n`
              output += `- **Is Subagent:** ${session.isSubagent}\n`
              output += `- **Has Frame:** ${session.hasFrame}\n`
              output += `- **Message Count:** ${session.messageCount}\n`
              output += `- **Age:** ${ageStr}\n`
              output += `- **Idle Time:** ${idleStr}\n`
              output += `- **Is Idle:** ${session.isIdle}\n`
            })
          }

          return output
        },
      }),

      /**
       * /stack-subagent-complete - Manually complete a subagent session
       */
      stack_subagent_complete: tool({
        description: "Manually complete a subagent session. Can be used to complete sessions that haven't auto-completed.",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Session ID to complete (uses current session if not provided)"),
          status: tool.schema
            .enum(["completed", "failed", "blocked"])
            .optional()
            .describe("Completion status (default: completed)"),
          summary: tool.schema
            .string()
            .optional()
            .describe("Optional summary of the subagent's work"),
        },
        async execute(args, toolCtx) {
          const sessionID = args.sessionID || runtime.currentSessionID
          if (!sessionID) {
            return "Error: No session ID provided and no active session"
          }

          const status = (args.status || 'completed') as FrameStatus

          // Check if this is a tracked subagent session
          const subagentSession = runtime.subagentTracking.sessions.get(sessionID)
          if (!subagentSession) {
            return `Error: Session ${sessionID.substring(0, 8)} is not a tracked subagent session`
          }

          if (subagentSession.isCompleted) {
            return `Session ${sessionID.substring(0, 8)} has already been completed`
          }

          const success = await completeSubagentSession(sessionID, status, args.summary, manager)

          if (success) {
            return `Successfully completed subagent session ${sessionID.substring(0, 8)} with status: ${status}

${args.summary ? `Summary: ${args.summary}` : '(no summary provided)'}

The parent frame (${subagentSession.parentSessionID.substring(0, 8)}) will now include this session's context in its sibling summaries.`
          } else {
            return `Failed to complete subagent session ${sessionID.substring(0, 8)}. Check the logs for details.`
          }
        },
      }),

      /**
       * /stack-subagent-list - List all tracked subagent sessions
       */
      stack_subagent_list: tool({
        description: "List all tracked subagent sessions with their current status and metadata.",
        args: {
          filter: tool.schema
            .enum(["all", "active", "completed", "with-frame", "without-frame"])
            .optional()
            .describe("Filter sessions (default: all)"),
        },
        async execute(args, toolCtx) {
          const filter = args.filter || 'all'

          let sessions = Array.from(runtime.subagentTracking.sessions.values())

          // Apply filter
          switch (filter) {
            case 'active':
              sessions = sessions.filter(s => !s.isCompleted)
              break
            case 'completed':
              sessions = sessions.filter(s => s.isCompleted)
              break
            case 'with-frame':
              sessions = sessions.filter(s => s.hasFrame)
              break
            case 'without-frame':
              sessions = sessions.filter(s => !s.hasFrame)
              break
          }

          // Sort by last activity (most recent first)
          sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)

          let output = `# Stack Subagent Sessions (Phase 1.5)\n\n`
          output += `**Filter:** ${filter}\n`
          output += `**Count:** ${sessions.length}\n\n`

          if (sessions.length === 0) {
            output += `*No sessions match the filter.*\n`
            return output
          }

          output += `| Session | Parent | Title | Frame | Messages | Status | Age |\n`
          output += `|---------|--------|-------|-------|----------|--------|-----|\n`

          sessions.forEach(session => {
            const age = formatDuration(Date.now() - session.createdAt)
            const status = session.isCompleted ? 'Done' : session.isIdle ? 'Idle' : 'Active'
            const title = session.title.length > 30
              ? session.title.substring(0, 27) + '...'
              : session.title

            output += `| ${session.sessionID.substring(0, 8)} | ${session.parentSessionID.substring(0, 8)} | ${title} | ${session.hasFrame ? 'Yes' : 'No'} | ${session.messageCount} | ${status} | ${age} |\n`
          })

          return output
        },
      }),

      // ================================================================
      // Phase 1.6: Planning and Invalidation Tools
      // ================================================================

      /**
       * stack_frame_plan - Create a planned frame (not started yet)
       * Phase 1.6: Frames can exist in 'planned' state before execution
       */
      stack_frame_plan: tool({
        description: `Create a planned frame for future work. Planned frames appear in the frame tree but are not started yet. Use stack_frame_activate to start working on a planned frame.

SUCCESS CRITERIA FORMAT:
- Define what "done" looks like in concrete, verifiable terms
- Include specific deliverables (files, endpoints, tests, etc.)
- Be precise about scope boundaries

COMPACTED VERSION:
- Dense, information-rich summary (not a vague generalization)
- Preserve key specifics: names, decisions, constraints
- Think "compression" not "summarization"`,
        args: {
          title: tool.schema.string().describe("Short name for the frame (2-5 words)"),
          successCriteria: tool.schema
            .string()
            .describe("Full success criteria - what defines 'done' for this frame"),
          successCriteriaCompacted: tool.schema
            .string()
            .describe("Dense compacted version of success criteria for tree display"),
          parentSessionID: tool.schema
            .string()
            .optional()
            .describe("Parent frame session ID (uses current frame if not provided)"),
        },
        async execute(args, toolCtx) {
          const parentID = args.parentSessionID || runtime.currentSessionID

          if (!parentID) {
            return "Error: No parent session ID provided and no active session"
          }

          // Check if parent exists
          const parentFrame = await manager.getFrame(parentID)
          if (!parentFrame) {
            return `Error: Parent frame not found: ${parentID.substring(0, 8)}`
          }

          try {
            // Generate a unique ID for the planned frame
            const plannedID = `plan-${Date.now()}-${Math.random().toString(36).substring(7)}`

            const frame = await manager.createPlannedFrame(
              plannedID,
              args.title,
              args.successCriteria,
              args.successCriteriaCompacted,
              parentID
            )

            // Invalidate parent cache
            invalidateCache(parentID)

            log("PLAN: Created planned frame", {
              plannedID,
              parentID,
              title: args.title,
            })

            return `# Planned Frame Created

**Frame ID:** ${frame.sessionID}
**Parent:** ${parentID.substring(0, 8)}
**Title:** ${args.title}
**Success Criteria:** ${args.successCriteria}
**Status:** planned

The planned frame has been added to the frame tree. To start working on it:
- Use \`stack_frame_activate\` with the frame ID to begin work
- Use \`stack_frame_invalidate\` with the frame ID to invalidate it
- Or plan more children with \`stack_frame_plan\`

Planned frames will be automatically invalidated if their parent is invalidated.`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log("PLAN: Failed", { error: message })
            return `Error creating planned frame: ${message}`
          }
        },
      }),

      /**
       * stack_frame_plan_children - Create multiple planned children at once
       * Phase 1.6: Allows sketching out B->B1,B2,B3 before starting B
       */
      stack_frame_plan_children: tool({
        description: `Create multiple planned child frames at once. Use to sketch out the structure of subtasks before starting work on them.

Each child needs:
- title: Short name (2-5 words)
- successCriteria: Full success criteria - what defines 'done'
- successCriteriaCompacted: Dense version for tree display

COMPACTED VERSION:
- Dense, information-rich summary (not a vague generalization)
- Preserve key specifics: names, decisions, constraints
- Think "compression" not "summarization"`,
        args: {
          parentSessionID: tool.schema
            .string()
            .optional()
            .describe("Parent frame session ID (uses current frame if not provided)"),
          children: tool.schema
            .array(
              tool.schema.object({
                title: tool.schema.string().describe("Short name (2-5 words)"),
                successCriteria: tool.schema.string().describe("Full success criteria"),
                successCriteriaCompacted: tool.schema
                  .string()
                  .describe("Dense compacted version"),
              })
            )
            .describe("Array of child frame definitions"),
        },
        async execute(args, toolCtx) {
          const parentID = args.parentSessionID || runtime.currentSessionID

          if (!parentID) {
            return "Error: No parent session ID provided and no active session"
          }

          if (!args.children || args.children.length === 0) {
            return "Error: No children provided. Each child needs: title, successCriteria, successCriteriaCompacted"
          }

          try {
            // Generate unique IDs for each planned frame
            const childrenWithIDs = args.children.map((child, index) => ({
              sessionID: `plan-${Date.now()}-${index}-${Math.random().toString(36).substring(7)}`,
              title: child.title,
              successCriteria: child.successCriteria,
              successCriteriaCompacted: child.successCriteriaCompacted,
            }))

            const frames = await manager.createPlannedChildren(parentID, childrenWithIDs)

            // Invalidate parent cache
            invalidateCache(parentID)

            log("PLAN_CHILDREN: Created planned children", {
              parentID,
              count: frames.length,
            })

            let output = `# Planned Children Created\n\n`
            output += `**Parent:** ${parentID.substring(0, 8)}\n`
            output += `**Count:** ${frames.length}\n\n`
            output += `## Planned Frames\n\n`

            frames.forEach((frame, index) => {
              output += `${index + 1}. **${frame.title}**\n`
              output += `   - ID: ${frame.sessionID}\n`
              output += `   - Criteria: ${frame.successCriteriaCompacted}\n`
              output += `   - Status: planned\n\n`
            })

            output += `Use \`stack_frame_activate\` with a frame ID to start working on a planned frame.\n`
            output += `Use \`stack_frame_invalidate\` with a frame ID to invalidate a planned frame.\n`
            output += `Use \`stack_tree\` to see the full frame structure.`

            return output
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log("PLAN_CHILDREN: Failed", { error: message })
            return `Error creating planned children: ${message}`
          }
        },
      }),

      /**
       * stack_frame_activate - Start working on a planned frame
       * Phase 1.6: Changes status from 'planned' to 'in_progress'
       * Phase 2: Creates a real OpenCode session and replaces the plan-* ID
       */
      stack_frame_activate: tool({
        description:
          "Start working on a planned frame. Creates a real OpenCode session, changes the frame's status from 'planned' to 'in_progress', and makes it the active frame.",
        args: {
          sessionID: tool.schema
            .string()
            .describe("The session ID of the planned frame to activate"),
        },
        async execute(args, toolCtx) {
          if (!args.sessionID) {
            return "Error: Session ID is required"
          }

          // First, check if frame exists and is planned
          const existingFrame = await manager.getFrame(args.sessionID)
          if (!existingFrame) {
            return `Error: Frame not found: ${args.sessionID.substring(0, 8)}`
          }
          if (existingFrame.status !== "planned") {
            return `Error: Frame ${args.sessionID.substring(0, 8)} is not in 'planned' status (current status: ${existingFrame.status})`
          }

          try {
            // Determine the parent session ID for the new session
            // If the parent is also a plan-* ID, we can't use it as a parent
            // Only use real ses_* IDs as parents
            let parentID: string | undefined
            if (existingFrame.parentSessionID?.startsWith("ses_")) {
              parentID = existingFrame.parentSessionID
            }

            // Create a real OpenCode session
            const newSession = await client.session.create({
              body: {
                parentID,
                title: existingFrame.title,
              },
            })

            if (!newSession.data) {
              return "Error: Failed to create OpenCode session"
            }

            const newSessionID = newSession.data.id

            // Replace the plan-* ID with the real ses_* ID
            await manager.replaceFrameID(args.sessionID, newSessionID)

            // Now activate the frame (which updates status to in_progress)
            const frame = await manager.activateFrame(newSessionID)

            if (!frame) {
              // This shouldn't happen since we just created it
              log("ACTIVATE: Failed to activate after ID replacement", {
                oldID: args.sessionID,
                newID: newSessionID,
              })
              return `Error: Failed to activate frame after session creation`
            }

            // Invalidate caches
            invalidateCache(newSessionID)
            if (frame.parentSessionID) {
              invalidateCache(frame.parentSessionID)
            }

            log("ACTIVATE: Frame activated with real session", {
              oldID: args.sessionID,
              newSessionID,
              title: frame.title,
            })

            // Generate call-stack context for the new session
            // This provides the session with orientation about what has been done before
            const callStackContext = await generateFrameContext(manager, newSessionID)
            log("ACTIVATE: Generated call-stack context", {
              newSessionID,
              contextLength: callStackContext.length,
            })

            // Send initial prompt to kick off work in the new session
            // Rules and workflow guidance are now in the system prompt via <workflow-guidance>
            const initialPrompt = `# ${frame.title}

**Success Criteria:** ${frame.successCriteria}

Begin working on your task now.`

            // Fire-and-forget: Send initial prompt without awaiting
            // This avoids potential response parsing issues with promptAsync
            client.session.promptAsync({
              path: { id: newSessionID },
              body: {
                // Include the call-stack context as the system prompt
                system: callStackContext,
                parts: [{ type: "text", text: initialPrompt }],
              },
            }).then(() => {
              log("ACTIVATE: Initial prompt sent to session with call-stack context", { newSessionID })
            }).catch((promptError) => {
              // Log but don't fail - the session was created successfully
              const promptMessage =
                promptError instanceof Error
                  ? promptError.message
                  : String(promptError)
              log("ACTIVATE: Failed to send initial prompt (non-fatal)", {
                error: promptMessage,
              })
            })

            return `# Frame Activated

**Frame ID:** ${frame.sessionID.substring(0, 8)}
**Title:** ${frame.title}
**Success Criteria:** ${frame.successCriteria}
**Status:** in_progress (was: planned)
**Parent:** ${frame.parentSessionID?.substring(0, 8) || "root"}

A new OpenCode session has been created. Workflow guidance is provided in the system prompt.`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log("ACTIVATE: Failed to create session", { error: message })
            return `Error creating session: ${message}`
          }
        },
      }),

      /**
       * stack_frame_invalidate - Invalidate a frame with cascade to planned children
       * Phase 1.6: When a frame is invalidated:
       *   - All 'planned' children are auto-invalidated
       *   - 'in_progress' children are warned but not auto-invalidated
       *   - 'completed' children remain completed
       */
      stack_frame_invalidate: tool({
        description:
          "Invalidate a frame and cascade to its planned children. Use when a frame's work is no longer needed or has become obsolete. In-progress children will be warned but not auto-invalidated.",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("The session ID of the frame to invalidate (uses current frame if not provided)"),
          reason: tool.schema
            .string()
            .describe("The reason for invalidation (will be stored in frame metadata)"),
        },
        async execute(args, toolCtx) {
          const sessionID = args.sessionID || runtime.currentSessionID

          if (!sessionID) {
            return "Error: No session ID provided and no active session"
          }

          if (!args.reason) {
            return "Error: Reason is required for invalidation"
          }

          const result = await manager.invalidateFrame(sessionID, args.reason)

          if (!result) {
            return `Error: Frame not found: ${sessionID.substring(0, 8)}`
          }

          // Invalidate caches
          invalidateCache(sessionID)
          if (result.invalidated.parentSessionID) {
            invalidateCache(result.invalidated.parentSessionID)
          }
          result.cascadedPlanned.forEach(f => invalidateCache(f.sessionID))

          log("INVALIDATE: Frame invalidated", {
            sessionID,
            reason: args.reason,
            cascadedCount: result.cascadedPlanned.length,
            warningCount: result.warningInProgress.length,
          })

          let output = `# Frame Invalidated\n\n`
          output += `**Frame ID:** ${result.invalidated.sessionID.substring(0, 8)}\n`
          output += `**Title:** ${result.invalidated.title}\n`
          output += `**Reason:** ${args.reason}\n`
          output += `**Status:** invalidated\n\n`

          if (result.cascadedPlanned.length > 0) {
            output += `## Cascaded Invalidations\n\n`
            output += `The following planned children were automatically invalidated:\n\n`
            result.cascadedPlanned.forEach(frame => {
              output += `- **${frame.title}** (${frame.sessionID.substring(0, 8)})\n`
            })
            output += `\n`
          }

          if (result.warningInProgress.length > 0) {
            output += `## Warning: In-Progress Children\n\n`
            output += `The following frames are still in progress and were NOT auto-invalidated:\n\n`
            result.warningInProgress.forEach(frame => {
              output += `- **${frame.title}** (${frame.sessionID.substring(0, 8)}) - status: ${frame.status}\n`
            })
            output += `\nConsider reviewing these frames and manually invalidating or completing them.\n\n`
          }

          output += `Use \`stack_tree\` to see the updated frame structure.`

          return output
        },
      }),

      /**
       * stack_tree - Visual ASCII tree of all frames
       * Phase 1.6: Shows parent-child relationships with status indicators
       */
      stack_tree: tool({
        description:
          "Show a visual ASCII tree of all frames with status indicators. Includes completed, in-progress, planned, invalidated, blocked, and failed frames.",
        args: {
          showFull: tool.schema
            .boolean()
            .optional()
            .describe("Show full tree including all branches (default: true)"),
          rootID: tool.schema
            .string()
            .optional()
            .describe("Optional root frame ID to start from (shows subtree only)"),
          showDetails: tool.schema
            .boolean()
            .optional()
            .describe("Show additional details like timestamps and summaries (default: false)"),
        },
        async execute(args, toolCtx) {
          const state = await manager.getAllFrames()
          const currentID = runtime.currentSessionID
          const showFull = args.showFull !== false
          const showDetails = args.showDetails === true

          if (Object.keys(state.frames).length === 0) {
            return "No frames exist yet. Use stack_frame_push or stack_frame_plan to create frames."
          }

          // Status icons per SPEC
          const statusIcon: Record<FrameStatus, string> = {
            completed: "✓",
            in_progress: "→",
            planned: "○",
            invalidated: "✗",
            blocked: "!",
            failed: "⚠",
          }

          // Build tree output
          let output = `# Stack Frame Tree\n\n`
          output += `**Legend:** completed, -> in_progress, o planned, x invalidated, ! blocked, warning failed\n`
          output += `**Active Frame:** ${state.activeFrameID?.substring(0, 8) || "none"}\n\n`
          output += "```\n"

          // Recursive tree builder
          function buildTree(
            frameID: string,
            prefix: string = "",
            isLast: boolean = true
          ): string {
            const frame = state.frames[frameID]
            if (!frame) return ""

            // Determine marker
            const marker = frameID === currentID ? ">>>" : "   "
            const connector = isLast ? "└──" : "├──"
            const icon = statusIcon[frame.status] || "?"

            // Build the line - show title and compacted criteria
            const titleDisplay = `${frame.title}: ${frame.successCriteriaCompacted}`
            let line = `${prefix}${connector} ${icon} ${titleDisplay.substring(0, 60)}${titleDisplay.length > 60 ? '...' : ''}`
            line += ` (${frame.sessionID.substring(0, 8)})`
            if (frameID === currentID) {
              line += " <<<ACTIVE"
            }
            line += "\n"

            // Add details if requested
            if (showDetails) {
              const detailPrefix = prefix + (isLast ? "    " : "│   ")
              if (frame.invalidationReason) {
                line += `${detailPrefix}    Reason: ${frame.invalidationReason.substring(0, 60)}${frame.invalidationReason.length > 60 ? '...' : ''}\n`
              }
              if (frame.resultsCompacted) {
                const resultsPreview = frame.resultsCompacted.substring(0, 80).replace(/\n/g, ' ')
                line += `${detailPrefix}    Results: ${resultsPreview}${frame.resultsCompacted.length > 80 ? '...' : ''}\n`
              }
              if (frame.artifacts.length > 0) {
                line += `${detailPrefix}    Artifacts: ${frame.artifacts.slice(0, 3).join(', ')}${frame.artifacts.length > 3 ? '...' : ''}\n`
              }
            }

            // Get children
            const children = Object.values(state.frames)
              .filter(f => f.parentSessionID === frameID)
              .sort((a, b) => {
                // Sort: in_progress first, then planned, then completed, then failed/blocked/invalidated
                const statusOrder: Record<FrameStatus, number> = {
                  in_progress: 0,
                  planned: 1,
                  completed: 2,
                  blocked: 3,
                  failed: 4,
                  invalidated: 5,
                }
                return (statusOrder[a.status] || 6) - (statusOrder[b.status] || 6)
              })

            // Build children
            const childPrefix = prefix + (isLast ? "    " : "│   ")
            children.forEach((child, index) => {
              const childIsLast = index === children.length - 1
              line += buildTree(child.sessionID, childPrefix, childIsLast)
            })

            return line
          }

          // If specific root is requested, only show that subtree
          if (args.rootID) {
            const rootFrame = state.frames[args.rootID]
            if (!rootFrame) {
              return `Error: Frame not found: ${args.rootID.substring(0, 8)}`
            }
            output += buildTree(args.rootID, "", true)
          } else {
            // Show from all root frames
            const rootFrames = state.rootFrameIDs
              .map(id => state.frames[id])
              .filter(f => f !== undefined)
              .sort((a, b) => b.createdAt - a.createdAt)

            rootFrames.forEach((rootFrame, index) => {
              const isLast = index === rootFrames.length - 1
              // For root frames, use a different format
              const icon = statusIcon[rootFrame.status] || "?"
              const marker = rootFrame.sessionID === currentID ? ">>>" : "   "
              const titleDisplay = `${rootFrame.title}: ${rootFrame.successCriteriaCompacted}`
              output += `${marker} ${icon} ${titleDisplay.substring(0, 60)}${titleDisplay.length > 60 ? '...' : ''}`
              output += ` (${rootFrame.sessionID.substring(0, 8)})`
              if (rootFrame.sessionID === currentID) {
                output += " <<<ACTIVE"
              }
              output += "\n"

              // Get children
              const children = Object.values(state.frames)
                .filter(f => f.parentSessionID === rootFrame.sessionID)
                .sort((a, b) => {
                  const statusOrder: Record<FrameStatus, number> = {
                    in_progress: 0,
                    planned: 1,
                    completed: 2,
                    blocked: 3,
                    failed: 4,
                    invalidated: 5,
                  }
                  return (statusOrder[a.status] || 6) - (statusOrder[b.status] || 6)
                })

              children.forEach((child, childIndex) => {
                const childIsLast = childIndex === children.length - 1
                output += buildTree(child.sessionID, "    ", childIsLast)
              })

              if (!isLast) {
                output += "\n"
              }
            })

            // Check for orphaned frames (frames without parents that aren't in rootFrameIDs)
            const orphans = Object.values(state.frames).filter(
              f => !f.parentSessionID && !state.rootFrameIDs.includes(f.sessionID)
            )

            if (orphans.length > 0 && showFull) {
              output += "\n--- Orphaned Frames ---\n"
              orphans.forEach((orphan, index) => {
                const isLast = index === orphans.length - 1
                output += buildTree(orphan.sessionID, "", isLast)
              })
            }
          }

          output += "```\n"

          // Add summary stats
          const stats = {
            total: Object.keys(state.frames).length,
            completed: Object.values(state.frames).filter(f => f.status === "completed").length,
            in_progress: Object.values(state.frames).filter(f => f.status === "in_progress").length,
            planned: Object.values(state.frames).filter(f => f.status === "planned").length,
            invalidated: Object.values(state.frames).filter(f => f.status === "invalidated").length,
            blocked: Object.values(state.frames).filter(f => f.status === "blocked").length,
            failed: Object.values(state.frames).filter(f => f.status === "failed").length,
          }

          output += `\n**Stats:** ${stats.total} total | ${stats.completed} ✓ | ${stats.in_progress} → | ${stats.planned} ○ | ${stats.invalidated} ✗ | ${stats.blocked} ! | ${stats.failed} ⚠\n`

          return output
        },
      }),

      // ================================================================
      // Phase 1.7: Agent Autonomy Tools
      // ================================================================

      /**
       * stack_autonomy - View and modify autonomy settings
       * Phase 1.7: Controls how autonomous the agent is in managing frames
       */
      stack_autonomy: tool({
        description:
          "View or modify agent autonomy settings. Controls whether the agent automatically suggests or performs push/pop operations based on heuristics.",
        args: {
          level: tool.schema
            .enum(["manual", "suggest", "auto"])
            .optional()
            .describe("Autonomy level: manual (never auto), suggest (suggest but wait), auto (act automatically)"),
          pushThreshold: tool.schema
            .number()
            .optional()
            .describe("Confidence threshold (0-100) for auto-push recommendations"),
          popThreshold: tool.schema
            .number()
            .optional()
            .describe("Confidence threshold (0-100) for auto-pop recommendations"),
          suggestInContext: tool.schema
            .boolean()
            .optional()
            .describe("Include suggestions in LLM context"),
          enableHeuristic: tool.schema
            .string()
            .optional()
            .describe("Enable a specific heuristic (e.g., 'failure_boundary', 'context_switch')"),
          disableHeuristic: tool.schema
            .string()
            .optional()
            .describe("Disable a specific heuristic"),
          reset: tool.schema
            .boolean()
            .optional()
            .describe("Reset to default configuration"),
        },
        async execute(args, toolCtx) {
          const config = runtime.autonomyTracking.config

          // Handle reset
          if (args.reset) {
            runtime.autonomyTracking.config = { ...DEFAULT_AUTONOMY_CONFIG }
            resetAutonomyStats()
            return `Autonomy configuration reset to defaults.

**Level:** ${DEFAULT_AUTONOMY_CONFIG.level}
**Push Threshold:** ${DEFAULT_AUTONOMY_CONFIG.pushThreshold}%
**Pop Threshold:** ${DEFAULT_AUTONOMY_CONFIG.popThreshold}%
**Suggest in Context:** ${DEFAULT_AUTONOMY_CONFIG.suggestInContext}
**Enabled Heuristics:** ${DEFAULT_AUTONOMY_CONFIG.enabledHeuristics.join(', ')}`
          }

          let modified = false

          // Apply modifications
          if (args.level !== undefined) {
            config.level = args.level
            modified = true
          }
          if (args.pushThreshold !== undefined) {
            config.pushThreshold = Math.min(100, Math.max(0, args.pushThreshold))
            modified = true
          }
          if (args.popThreshold !== undefined) {
            config.popThreshold = Math.min(100, Math.max(0, args.popThreshold))
            modified = true
          }
          if (args.suggestInContext !== undefined) {
            config.suggestInContext = args.suggestInContext
            modified = true
          }
          if (args.enableHeuristic) {
            if (!config.enabledHeuristics.includes(args.enableHeuristic)) {
              config.enabledHeuristics.push(args.enableHeuristic)
              modified = true
            }
          }
          if (args.disableHeuristic) {
            const index = config.enabledHeuristics.indexOf(args.disableHeuristic)
            if (index > -1) {
              config.enabledHeuristics.splice(index, 1)
              modified = true
            }
          }

          // Build output
          let output = `# Agent Autonomy Configuration (Phase 1.7)\n\n`

          if (modified) {
            output += `**Configuration updated!**\n\n`
          }

          output += `## Current Settings\n`
          output += `- **Autonomy Level:** ${config.level}\n`
          output += `  - manual: Agent never auto-pushes, only suggests when asked\n`
          output += `  - suggest: Agent suggests push/pop but waits for confirmation\n`
          output += `  - auto: Agent can autonomously push/pop based on heuristics\n\n`

          output += `- **Push Threshold:** ${config.pushThreshold}%\n`
          output += `- **Pop Threshold:** ${config.popThreshold}%\n`
          output += `- **Suggest in Context:** ${config.suggestInContext}\n\n`

          output += `## Enabled Heuristics\n`
          const allHeuristics = [
            'failure_boundary',
            'context_switch',
            'complexity',
            'duration',
            'goal_completion',
            'stagnation',
            'context_overflow',
          ]
          for (const h of allHeuristics) {
            const enabled = config.enabledHeuristics.includes(h)
            output += `- ${enabled ? '✓' : '✗'} ${h}\n`
          }

          output += `\n## Statistics\n`
          const stats = runtime.autonomyTracking.stats
          output += `- Total suggestions: ${stats.totalSuggestions}\n`
          output += `- Push suggestions: ${stats.pushSuggestions}\n`
          output += `- Pop suggestions: ${stats.popSuggestions}\n`
          output += `- Acted upon: ${stats.actedUpon}\n`
          output += `- Ignored/expired: ${stats.ignored}\n`
          output += `- Auto pushes: ${stats.autoPushes}\n`
          output += `- Auto pops: ${stats.autoPops}\n`

          output += `\n## Environment Variables\n`
          output += `- \`STACK_AUTONOMY_LEVEL\`: ${process.env.STACK_AUTONOMY_LEVEL || '(not set)'}\n`
          output += `- \`STACK_PUSH_THRESHOLD\`: ${process.env.STACK_PUSH_THRESHOLD || '(not set)'}\n`
          output += `- \`STACK_POP_THRESHOLD\`: ${process.env.STACK_POP_THRESHOLD || '(not set)'}\n`
          output += `- \`STACK_SUGGEST_IN_CONTEXT\`: ${process.env.STACK_SUGGEST_IN_CONTEXT || '(not set)'}\n`
          output += `- \`STACK_ENABLED_HEURISTICS\`: ${process.env.STACK_ENABLED_HEURISTICS || '(not set)'}\n`

          return output
        },
      }),

      /**
       * stack_should_push - Evaluate push heuristics
       * Phase 1.7: Determines if current context warrants creating a new frame
       */
      stack_should_push: tool({
        description:
          "Evaluate heuristics to determine if a new child frame should be pushed. Returns a recommendation with confidence score based on failure boundary, context switch, complexity, and duration factors.",
        args: {
          potentialGoal: tool.schema
            .string()
            .optional()
            .describe("Potential goal for the new frame (used for context switch detection)"),
          recentMessages: tool.schema
            .number()
            .optional()
            .describe("Number of recent messages in current context"),
          recentFileChanges: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("List of recently changed files"),
          errorCount: tool.schema
            .number()
            .optional()
            .describe("Number of errors encountered recently"),
          tokenCount: tool.schema
            .number()
            .optional()
            .describe("Approximate token count of current context"),
        },
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          const result = await evaluatePushHeuristics(manager, sessionID, {
            recentMessages: args.recentMessages,
            recentFileChanges: args.recentFileChanges,
            potentialNewGoal: args.potentialGoal,
            errorCount: args.errorCount,
            tokenCount: args.tokenCount,
          })

          const config = runtime.autonomyTracking.config

          let output = `# Push Heuristic Evaluation\n\n`
          output += `**Session:** ${sessionID.substring(0, 8)}\n`
          output += `**Autonomy Level:** ${config.level}\n\n`

          output += `## Recommendation\n`
          output += `- **Should Push:** ${result.shouldPush ? 'YES' : 'NO'}\n`
          output += `- **Confidence:** ${result.confidence}% (threshold: ${config.pushThreshold}%)\n`
          output += `- **Primary Reason:** ${result.primaryReason}\n`
          if (result.suggestedGoal) {
            output += `- **Suggested Goal:** "${result.suggestedGoal}"\n`
          }
          output += `\n`

          output += `## Heuristic Scores\n`
          for (const [heuristic, score] of Object.entries(result.heuristicScores)) {
            const enabled = config.enabledHeuristics.includes(heuristic)
            output += `- ${heuristic}: ${score}${enabled ? '' : ' (disabled)'}\n`
          }
          output += `\n`

          output += `## Explanation\n`
          output += result.explanation

          // If suggest or auto mode and should push, create a suggestion
          if (config.level !== 'manual' && result.shouldPush) {
            const suggestion = createSuggestion(
              'push',
              result.confidence,
              result.suggestedGoal || 'New subtask',
              result.primaryReason
            )
            addSuggestion(suggestion)

            output += `\n## Suggestion Created\n`
            output += `A push suggestion has been added to the context queue.`

            // If auto mode, we could trigger the push automatically
            if (config.level === 'auto' && result.confidence >= config.pushThreshold) {
              output += `\n\n**Auto Mode:** Consider using stack_frame_push with goal "${result.suggestedGoal || 'New subtask'}"`
              runtime.autonomyTracking.stats.autoPushes++
            }
          }

          return output
        },
      }),

      /**
       * stack_should_pop - Evaluate pop heuristics
       * Phase 1.7: Determines if current frame should be completed
       */
      stack_should_pop: tool({
        description:
          "Evaluate heuristics to determine if the current frame should be popped (completed). Returns a recommendation with suggested status based on goal completion, stagnation, and context overflow factors.",
        args: {
          successSignals: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("List of success indicators (e.g., 'tests passing', 'build succeeded')"),
          failureSignals: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("List of failure indicators (e.g., 'tests failing', 'error occurred')"),
          noProgressTurns: tool.schema
            .number()
            .optional()
            .describe("Number of conversation turns with no meaningful progress"),
          tokenCount: tool.schema
            .number()
            .optional()
            .describe("Current token count"),
          contextLimit: tool.schema
            .number()
            .optional()
            .describe("Context limit for the model"),
        },
        async execute(args, toolCtx) {
          const sessionID = runtime.currentSessionID
          if (!sessionID) {
            return "Error: No active session"
          }

          const frame = await manager.getFrame(sessionID)
          if (!frame) {
            return "Error: No frame found for current session"
          }

          const result = await evaluatePopHeuristics(manager, sessionID, {
            successSignals: args.successSignals,
            failureSignals: args.failureSignals,
            noProgressTurns: args.noProgressTurns,
            tokenCount: args.tokenCount,
            contextLimit: args.contextLimit,
          })

          const config = runtime.autonomyTracking.config

          let output = `# Pop Heuristic Evaluation\n\n`
          output += `**Session:** ${sessionID.substring(0, 8)}\n`
          output += `**Current Task:** ${frame.title}\n`
          output += `**Autonomy Level:** ${config.level}\n\n`

          output += `## Recommendation\n`
          output += `- **Should Pop:** ${result.shouldPop ? 'YES' : 'NO'}\n`
          output += `- **Confidence:** ${result.confidence}% (threshold: ${config.popThreshold}%)\n`
          output += `- **Suggested Status:** ${result.suggestedStatus}\n`
          output += `- **Primary Reason:** ${result.primaryReason}\n\n`

          output += `## Heuristic Scores\n`
          for (const [heuristic, score] of Object.entries(result.heuristicScores)) {
            const enabled = config.enabledHeuristics.includes(heuristic)
            output += `- ${heuristic}: ${score}${enabled ? '' : ' (disabled)'}\n`
          }
          output += `\n`

          output += `## Explanation\n`
          output += result.explanation

          // Check if this is a root frame
          if (!frame.parentSessionID) {
            output += `\n\n**Note:** This is a root frame and cannot be popped.`
          }

          // If suggest or auto mode and should pop, create a suggestion
          if (config.level !== 'manual' && result.shouldPop && frame.parentSessionID) {
            const suggestion = createSuggestion(
              'pop',
              result.confidence,
              result.suggestedStatus,
              result.primaryReason
            )
            addSuggestion(suggestion)

            output += `\n## Suggestion Created\n`
            output += `A pop suggestion has been added to the context queue.`

            // If auto mode
            if (config.level === 'auto' && result.confidence >= config.popThreshold) {
              output += `\n\n**Auto Mode:** Consider using stack_frame_pop with status "${result.suggestedStatus}"`
              runtime.autonomyTracking.stats.autoPops++
            }
          }

          return output
        },
      }),

      /**
       * stack_auto_suggest - Toggle and manage auto-suggestions
       * Phase 1.7: Controls whether suggestions are injected into context
       */
      stack_auto_suggest: tool({
        description:
          "Toggle auto-suggestions on/off and view pending suggestions. When enabled, suggestions are injected into the LLM context.",
        args: {
          enable: tool.schema
            .boolean()
            .optional()
            .describe("Enable or disable auto-suggestions in context"),
          clearPending: tool.schema
            .boolean()
            .optional()
            .describe("Clear all pending suggestions"),
          showHistory: tool.schema
            .boolean()
            .optional()
            .describe("Show suggestion history"),
        },
        async execute(args, toolCtx) {
          const config = runtime.autonomyTracking.config

          // Handle enable/disable
          if (args.enable !== undefined) {
            config.suggestInContext = args.enable
            log('Auto-suggest toggled', { enabled: args.enable })
          }

          // Handle clear pending
          if (args.clearPending) {
            const count = runtime.autonomyTracking.pendingSuggestions.length
            runtime.autonomyTracking.pendingSuggestions = []
            log('Pending suggestions cleared', { count })
          }

          let output = `# Auto-Suggestion System (Phase 1.7)\n\n`
          output += `**Enabled:** ${config.suggestInContext}\n`
          output += `**Autonomy Level:** ${config.level}\n\n`

          // Show pending suggestions
          const pending = getPendingSuggestions()
          output += `## Pending Suggestions (${pending.length})\n`
          if (pending.length === 0) {
            output += `*No pending suggestions*\n`
          } else {
            for (const suggestion of pending) {
              const age = formatDuration(Date.now() - suggestion.timestamp)
              output += `\n### ${suggestion.type.toUpperCase()} Suggestion\n`
              output += `- **Confidence:** ${suggestion.confidence}%\n`
              output += `- **Suggestion:** ${suggestion.suggestion}\n`
              output += `- **Reason:** ${suggestion.reason}\n`
              output += `- **Age:** ${age}\n`
              output += `- **Acted Upon:** ${suggestion.actedUpon}\n`
            }
          }

          // Show history if requested
          if (args.showHistory) {
            output += `\n## Suggestion History (last 20)\n`
            const history = runtime.autonomyTracking.suggestionHistory.slice(-20)
            if (history.length === 0) {
              output += `*No suggestion history*\n`
            } else {
              output += `| Type | Confidence | Suggestion | Acted Upon |\n`
              output += `|------|------------|------------|------------|\n`
              for (const s of history.reverse()) {
                const truncSuggestion = s.suggestion.length > 30
                  ? s.suggestion.substring(0, 27) + '...'
                  : s.suggestion
                output += `| ${s.type} | ${s.confidence}% | ${truncSuggestion} | ${s.actedUpon ? 'Yes' : 'No'} |\n`
              }
            }
          }

          // Show what would be injected
          output += `\n## Context Injection Preview\n`
          if (!config.suggestInContext || config.level === 'manual') {
            output += `*Context injection is disabled (suggestInContext: ${config.suggestInContext}, level: ${config.level})*\n`
          } else {
            const injection = formatSuggestionsForContext()
            if (injection) {
              output += "```\n" + injection + "\n```"
            } else {
              output += `*No suggestions to inject*\n`
            }
          }

          return output
        },
      }),

      /**
       * stack_get_state - Get complete stack state for UI rendering
       * Phase 2.1: Used by the Stack UI to fetch the complete state tree
       */
      stack_get_state: tool({
        description:
          "Get complete stack state for UI rendering. Returns the full frame tree including all frames, active frame ID, and root frame IDs as JSON.",
        args: {},
        async execute(args, toolCtx) {
          const state = await manager.loadState()
          return JSON.stringify({
            version: state.version,
            frames: state.frames,
            activeFrameID: state.activeFrameID,
            rootFrameIDs: state.rootFrameIDs,
            updatedAt: state.updatedAt,
          }, null, 2)
        },
      }),

      /**
       * stack_autonomy_stats - View detailed autonomy statistics
       * Phase 1.7: Shows statistics about autonomy system usage
       */
      stack_autonomy_stats: tool({
        description:
          "View detailed statistics about the autonomy system including suggestions made, acted upon, and effectiveness.",
        args: {
          reset: tool.schema
            .boolean()
            .optional()
            .describe("Reset all statistics"),
        },
        async execute(args, toolCtx) {
          if (args.reset) {
            resetAutonomyStats()
            return "Autonomy statistics have been reset."
          }

          const stats = runtime.autonomyTracking.stats
          const config = runtime.autonomyTracking.config

          let output = `# Autonomy Statistics (Phase 1.7)\n\n`

          output += `## Configuration\n`
          output += `- **Autonomy Level:** ${config.level}\n`
          output += `- **Push Threshold:** ${config.pushThreshold}%\n`
          output += `- **Pop Threshold:** ${config.popThreshold}%\n`
          output += `- **Suggest in Context:** ${config.suggestInContext}\n\n`

          output += `## Suggestion Counts\n`
          output += `- **Total Suggestions:** ${stats.totalSuggestions}\n`
          output += `- **Push Suggestions:** ${stats.pushSuggestions}\n`
          output += `- **Pop Suggestions:** ${stats.popSuggestions}\n\n`

          output += `## Outcomes\n`
          output += `- **Acted Upon:** ${stats.actedUpon}\n`
          output += `- **Ignored/Expired:** ${stats.ignored}\n`
          if (stats.totalSuggestions > 0) {
            const actionRate = (stats.actedUpon / stats.totalSuggestions * 100).toFixed(1)
            output += `- **Action Rate:** ${actionRate}%\n`
          }
          output += `\n`

          output += `## Auto Actions (auto mode only)\n`
          output += `- **Auto Pushes:** ${stats.autoPushes}\n`
          output += `- **Auto Pops:** ${stats.autoPops}\n\n`

          output += `## Tracking Info\n`
          output += `- **Last Reset:** ${new Date(stats.lastReset).toISOString()}\n`
          output += `- **Pending Suggestions:** ${runtime.autonomyTracking.pendingSuggestions.length}\n`
          output += `- **History Size:** ${runtime.autonomyTracking.suggestionHistory.length}\n`

          return output
        },
      }),
    },
  }
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`
  return `${(ms / 3600000).toFixed(1)}h`
}

export default StackPlugin
