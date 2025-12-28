import type { FlameState, TreeNode, FrameMetadata } from '../types/flame';
import { mockFlameState } from './mockData';
import { dataConfig } from '../config';

/**
 * Fetch Flame state from API or mock data
 */
export async function fetchFlameState(): Promise<FlameState> {
  if (dataConfig.useMock) {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 300));
    return mockFlameState;
  }

  const response = await fetch(dataConfig.apiEndpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch flame state: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Transform flat frames map into hierarchical tree structure for D3
 */
export function buildTreeHierarchy(
  state: FlameState
): TreeNode[] {
  const { frames, activeFrameID, rootFrameIDs } = state;

  function buildNode(frameId: string): TreeNode | null {
    const frame = frames[frameId];
    if (!frame) return null;

    // Find children: frames that have this frame as parent
    const childIds = Object.keys(frames).filter(
      (id) => frames[id].parentSessionID === frameId
    );

    const children = childIds
      .map((id) => buildNode(id))
      .filter((node): node is TreeNode => node !== null);

    return {
      id: frame.sessionID,
      goal: frame.goal,
      status: frame.status,
      isActive: frame.sessionID === activeFrameID,
      children: children.length > 0 ? children : undefined,
      // Additional metadata
      createdAt: frame.createdAt,
      updatedAt: frame.updatedAt,
      artifacts: frame.artifacts,
      decisions: frame.decisions,
      compactionSummary: frame.compactionSummary,
      parentSessionID: frame.parentSessionID,
    };
  }

  // Build tree for each root frame
  return rootFrameIDs
    .map((id) => buildNode(id))
    .filter((node): node is TreeNode => node !== null);
}

/**
 * Get status color for visualization
 */
export function getStatusColor(status: FrameMetadata['status']): string {
  const colors: Record<FrameMetadata['status'], string> = {
    planned: '#9ca3af',      // gray-400
    in_progress: '#3b82f6',  // blue-500
    completed: '#22c55e',    // green-500
    failed: '#ef4444',       // red-500
    blocked: '#f97316',      // orange-500
    invalidated: '#6b7280',  // gray-500
  };
  return colors[status];
}

/**
 * Get status label for display
 */
export function getStatusLabel(status: FrameMetadata['status']): string {
  const labels: Record<FrameMetadata['status'], string> = {
    planned: 'Planned',
    in_progress: 'In Progress',
    completed: 'Completed',
    failed: 'Failed',
    blocked: 'Blocked',
    invalidated: 'Invalidated',
  };
  return labels[status];
}
