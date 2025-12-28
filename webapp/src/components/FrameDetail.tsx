import type { TreeNode } from '../types/flame';
import { getStatusColor, getStatusLabel } from '../data/flameApi';
import { getOpenCodeSessionUrl } from '../config';

interface FrameDetailProps {
  node: TreeNode | null;
}

/**
 * Format a timestamp to relative time (e.g., "5 minutes ago")
 */
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

/**
 * Format session ID for display (truncated)
 */
function formatSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`;
}

export function FrameDetail({ node }: FrameDetailProps) {
  if (!node) {
    return (
      <div className="frame-detail empty">
        <p>Click on a node to see details</p>
      </div>
    );
  }

  const sessionUrl = getOpenCodeSessionUrl(node.id);

  return (
    <div className="frame-detail">
      <h3>{node.goal}</h3>

      <div className="detail-row">
        <span className="label">ID:</span>
        <code className="value" title={node.id}>{formatSessionId(node.id)}</code>
      </div>

      <div className="detail-row">
        <span className="label">Status:</span>
        <span
          className="status-badge"
          style={{ backgroundColor: getStatusColor(node.status) }}
        >
          {getStatusLabel(node.status)}
        </span>
      </div>

      {node.isActive && (
        <div className="active-indicator">
          Active Frame
        </div>
      )}

      {/* OpenCode Session Link - only for actual sessions (not planned frames) */}
      {node.id.startsWith('ses_') && (
        <div className="detail-row">
          <span className="label">Session:</span>
          <a
            href={sessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="session-link"
          >
            Open in OpenCode
          </a>
        </div>
      )}

      {/* Timestamps */}
      <div className="detail-section">
        <div className="detail-row">
          <span className="label">Created:</span>
          <span className="value">{formatRelativeTime(node.createdAt)}</span>
        </div>
        <div className="detail-row">
          <span className="label">Updated:</span>
          <span className="value">{formatRelativeTime(node.updatedAt)}</span>
        </div>
      </div>

      {/* Artifacts */}
      {node.artifacts.length > 0 && (
        <div className="detail-section">
          <span className="label">Artifacts:</span>
          <ul className="artifact-list">
            {node.artifacts.map((artifact, i) => (
              <li key={i}><code>{artifact}</code></li>
            ))}
          </ul>
        </div>
      )}

      {/* Decisions */}
      {node.decisions.length > 0 && (
        <div className="detail-section">
          <span className="label">Decisions:</span>
          <ul className="decision-list">
            {node.decisions.map((decision, i) => (
              <li key={i}>{decision}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Compaction Summary */}
      {node.compactionSummary && (
        <div className="detail-section">
          <span className="label">Summary:</span>
          <p className="summary-text">{node.compactionSummary}</p>
        </div>
      )}

      {/* Children count */}
      {node.children && node.children.length > 0 && (
        <div className="detail-row">
          <span className="label">Children:</span>
          <span className="value">{node.children.length} subtasks</span>
        </div>
      )}
    </div>
  );
}
