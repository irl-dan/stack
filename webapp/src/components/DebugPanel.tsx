import { useState, useEffect } from 'react';
import type { TreeNode } from '../types/flame';
import {
  fetchSessionMessages,
  fetchSessionDiff,
  fetchSessionTodos,
  fetchSystemPrompt,
  type MessageWithParts,
  type FileDiff,
  type Todo,
} from '../data/opencodeApi';

interface DebugPanelProps {
  node: TreeNode | null;
}

type TabType = 'messages' | 'diff' | 'todos' | 'system';

export function DebugPanel({ node }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('messages');
  const [messages, setMessages] = useState<MessageWithParts[]>([]);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only fetch for real sessions (ses_*), not planned frames
  const isRealSession = node?.id.startsWith('ses_');

  useEffect(() => {
    if (!node || !isRealSession) {
      setMessages([]);
      setDiffs([]);
      setTodos([]);
      setSystemPrompt(null);
      return;
    }

    loadData(node.id, activeTab);
  }, [node?.id, activeTab, isRealSession]);

  async function loadData(sessionId: string, tab: TabType) {
    setLoading(true);
    setError(null);

    try {
      switch (tab) {
        case 'messages':
          const msgs = await fetchSessionMessages(sessionId);
          setMessages(msgs);
          break;
        case 'diff':
          const diffData = await fetchSessionDiff(sessionId);
          setDiffs(diffData);
          break;
        case 'todos':
          const todoData = await fetchSessionTodos(sessionId);
          setTodos(todoData);
          break;
        case 'system':
          const prompt = await fetchSystemPrompt(sessionId);
          setSystemPrompt(prompt);
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  if (!node) {
    return (
      <div className="debug-panel empty">
        <p>Select a node to view debug info</p>
      </div>
    );
  }

  if (!isRealSession) {
    return (
      <div className="debug-panel empty">
        <p>Debug info only available for real sessions (not planned frames)</p>
        <p className="hint">Use <code>flame_activate</code> to start this planned frame</p>
      </div>
    );
  }

  return (
    <div className="debug-panel">
      <div className="debug-tabs">
        <button
          className={`tab ${activeTab === 'messages' ? 'active' : ''}`}
          onClick={() => setActiveTab('messages')}
        >
          Messages ({messages.length})
        </button>
        <button
          className={`tab ${activeTab === 'diff' ? 'active' : ''}`}
          onClick={() => setActiveTab('diff')}
        >
          Diff ({diffs.length})
        </button>
        <button
          className={`tab ${activeTab === 'todos' ? 'active' : ''}`}
          onClick={() => setActiveTab('todos')}
        >
          Todos ({todos.length})
        </button>
        <button
          className={`tab ${activeTab === 'system' ? 'active' : ''}`}
          onClick={() => setActiveTab('system')}
        >
          System
        </button>
      </div>

      <div className="debug-content">
        {loading && <div className="loading">Loading...</div>}
        {error && <div className="error">{error}</div>}

        {!loading && !error && activeTab === 'messages' && (
          <MessagesView messages={messages} />
        )}
        {!loading && !error && activeTab === 'diff' && (
          <DiffView diffs={diffs} />
        )}
        {!loading && !error && activeTab === 'todos' && (
          <TodosView todos={todos} />
        )}
        {!loading && !error && activeTab === 'system' && (
          <SystemPromptView systemPrompt={systemPrompt} />
        )}
      </div>
    </div>
  );
}

function MessagesView({ messages }: { messages: MessageWithParts[] }) {
  if (messages.length === 0) {
    return <div className="empty-state">No messages yet</div>;
  }

  return (
    <div className="messages-list">
      {messages.map((msg, i) => (
        <div key={msg.info.id || i} className={`message ${msg.info.role}`}>
          <div className="message-header">
            <span className="role">{msg.info.role}</span>
            <span className="time">
              {new Date(msg.info.time.created).toLocaleTimeString()}
            </span>
            {msg.info.model && (
              <span className="model">{msg.info.model.modelID}</span>
            )}
          </div>
          <div className="message-parts">
            {msg.parts.map((part, j) => (
              <div key={j} className={`part ${part.type}`}>
                {part.type === 'text' && (
                  <pre className="text-content">{part.text}</pre>
                )}
                {part.type === 'tool-invocation' && (
                  <div className="tool-call">
                    <span className="tool-name">{part.tool?.name}</span>
                    <details>
                      <summary>Input</summary>
                      <pre>{JSON.stringify(part.tool?.input, null, 2)}</pre>
                    </details>
                  </div>
                )}
                {part.type === 'tool-result' && (
                  <div className="tool-result">
                    <details>
                      <summary>Result</summary>
                      <pre>{part.result}</pre>
                    </details>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffView({ diffs }: { diffs: FileDiff[] }) {
  if (diffs.length === 0) {
    return <div className="empty-state">No file changes</div>;
  }

  return (
    <div className="diff-list">
      {diffs.map((diff, i) => (
        <div key={i} className={`diff-item ${diff.status}`}>
          <div className="diff-header">
            <span className={`status-badge ${diff.status}`}>{diff.status}</span>
            <code className="path">{diff.path}</code>
          </div>
          {diff.diff && (
            <pre className="diff-content">{diff.diff}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function TodosView({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) {
    return <div className="empty-state">No todos</div>;
  }

  return (
    <div className="todos-list">
      {todos.map((todo) => (
        <div key={todo.id} className={`todo-item ${todo.status}`}>
          <span className={`status-icon ${todo.status}`}>
            {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '→' : '○'}
          </span>
          <span className="content">{todo.content}</span>
        </div>
      ))}
    </div>
  );
}

function SystemPromptView({ systemPrompt }: { systemPrompt: string | null }) {
  if (!systemPrompt) {
    return <div className="empty-state">No system prompt found</div>;
  }

  return (
    <div className="system-prompt-view">
      <pre className="system-prompt-content">{systemPrompt}</pre>
    </div>
  );
}
