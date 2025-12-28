/**
 * Status of a frame in the Flame tree
 */
export type FrameStatus =
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'invalidated';

/**
 * Metadata for a single frame (work unit) in the Flame tree
 */
export interface FrameMetadata {
  sessionID: string;
  parentSessionID?: string;
  status: FrameStatus;
  goal: string;
  createdAt: number;
  updatedAt: number;
  artifacts: string[];
  decisions: string[];
  plannedChildren?: string[];
  compactionSummary?: string;
}

/**
 * The complete Flame state returned by flame_get_state
 */
export interface FlameState {
  version: number;
  frames: Record<string, FrameMetadata>;
  activeFrameID: string;
  rootFrameIDs: string[];
  updatedAt: number;
}

/**
 * D3 hierarchical node structure for tree visualization
 * Includes full frame metadata for detail display
 */
export interface TreeNode {
  id: string;
  goal: string;
  status: FrameStatus;
  isActive: boolean;
  children?: TreeNode[];

  // Additional metadata from FrameMetadata
  createdAt: number;
  updatedAt: number;
  artifacts: string[];
  decisions: string[];
  compactionSummary?: string;
  parentSessionID?: string;
}
