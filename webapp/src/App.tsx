import { useEffect, useState } from 'react';
import { FlameTree } from './components/FlameTree';
import { FrameDetail } from './components/FrameDetail';
import { DebugPanel } from './components/DebugPanel';
import { Legend } from './components/Legend';
import { fetchFlameState, buildTreeHierarchy } from './data/flameApi';
import type { FlameState, TreeNode } from './types/flame';
import './App.css';

function App() {
  const [flameState, setFlameState] = useState<FlameState | null>(null);
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadFlameState();
  }, []);

  async function loadFlameState() {
    try {
      setLoading(true);
      setError(null);
      const state = await fetchFlameState();
      setFlameState(state);
      const tree = buildTreeHierarchy(state);
      setTreeData(tree);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flame state');
    } finally {
      setLoading(false);
    }
  }

  function handleNodeClick(node: TreeNode) {
    setSelectedNode(node);
  }

  if (loading) {
    return (
      <div className="app loading">
        <div className="spinner" />
        <p>Loading Flame state...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app error">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={loadFlameState}>Retry</button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Flame Tree Visualizer</h1>
        <p className="subtitle">
          Hierarchical context management for AI agents
        </p>
        {flameState && (
          <span className="meta">
            {Object.keys(flameState.frames).length} frames |
            Last updated: {new Date(flameState.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </header>

      <div className="app-content">
        <aside className="sidebar">
          <Legend />
          <FrameDetail node={selectedNode} />
        </aside>

        <main className="main-content">
          <FlameTree
            data={treeData}
            width={900}
            height={600}
            onNodeClick={handleNodeClick}
          />
        </main>

        <aside className="debug-sidebar">
          <h3>Debug Info</h3>
          <DebugPanel node={selectedNode} />
        </aside>
      </div>

      <footer className="app-footer">
        <button className="refresh-btn" onClick={loadFlameState}>
          Refresh
        </button>
      </footer>
    </div>
  );
}

export default App;
