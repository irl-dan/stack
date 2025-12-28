import type { FrameStatus } from '../types/flame';
import { getStatusColor, getStatusLabel } from '../data/flameApi';

const statuses: FrameStatus[] = [
  'planned',
  'in_progress',
  'completed',
  'failed',
  'blocked',
  'invalidated',
];

export function Legend() {
  return (
    <div className="legend">
      <h4>Status Legend</h4>
      <div className="legend-items">
        {statuses.map((status) => (
          <div key={status} className="legend-item">
            <span
              className="legend-dot"
              style={{ backgroundColor: getStatusColor(status) }}
            />
            <span className="legend-label">{getStatusLabel(status)}</span>
          </div>
        ))}
        <div className="legend-item">
          <span className="legend-dot active-dot" />
          <span className="legend-label">Active Frame</span>
        </div>
      </div>
    </div>
  );
}
