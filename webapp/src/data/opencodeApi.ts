/**
 * OpenCode Server API Client
 * Used to fetch debugging information for sessions
 */

import { openCodeConfig } from '../config';

// Types based on OpenCode server responses
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
  model?: {
    providerID: string;
    modelID: string;
  };
  system?: string;
  agent?: string;
}

export interface MessagePart {
  type: 'text' | 'tool-invocation' | 'tool-result' | 'file';
  text?: string;
  tool?: {
    name: string;
    input: Record<string, unknown>;
  };
  result?: string;
  filePath?: string;
}

export interface MessageWithParts {
  info: Message;
  parts: MessagePart[];
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff?: string;
}

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface Session {
  id: string;
  title?: string;
  parentID?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Get the base URL for OpenCode API
 */
function getApiBaseUrl(): string {
  return openCodeConfig.baseUrl;
}

/**
 * Fetch messages for a session
 */
export async function fetchSessionMessages(sessionId: string): Promise<MessageWithParts[]> {
  const response = await fetch(`${getApiBaseUrl()}/session/${sessionId}/message`);
  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch file diffs for a session
 */
export async function fetchSessionDiff(sessionId: string): Promise<FileDiff[]> {
  const response = await fetch(`${getApiBaseUrl()}/session/${sessionId}/diff`);
  if (!response.ok) {
    throw new Error(`Failed to fetch diff: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch todo list for a session
 */
export async function fetchSessionTodos(sessionId: string): Promise<Todo[]> {
  const response = await fetch(`${getApiBaseUrl()}/session/${sessionId}/todo`);
  if (!response.ok) {
    throw new Error(`Failed to fetch todos: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch session details
 */
export async function fetchSession(sessionId: string): Promise<Session> {
  const response = await fetch(`${getApiBaseUrl()}/session/${sessionId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch session: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch child sessions
 */
export async function fetchChildSessions(sessionId: string): Promise<Session[]> {
  const response = await fetch(`${getApiBaseUrl()}/session/${sessionId}/children`);
  if (!response.ok) {
    throw new Error(`Failed to fetch children: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Subscribe to server-sent events for real-time updates
 */
export function subscribeToEvents(
  onEvent: (event: { type: string; properties: Record<string, unknown> }) => void,
  onError?: (error: Error) => void
): () => void {
  const eventSource = new EventSource(`${getApiBaseUrl()}/event`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onEvent(data);
    } catch (e) {
      console.error('Failed to parse event:', e);
    }
  };

  eventSource.onerror = () => {
    onError?.(new Error('EventSource connection failed'));
  };

  // Return cleanup function
  return () => eventSource.close();
}

/**
 * Format a message part for display
 */
export function formatMessagePart(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text || '';
    case 'tool-invocation':
      return `[Tool: ${part.tool?.name}]`;
    case 'tool-result':
      return `[Result: ${part.result?.substring(0, 100)}...]`;
    case 'file':
      return `[File: ${part.filePath}]`;
    default:
      return '[Unknown]';
  }
}

/**
 * Get a summary of messages (first user message + tool count)
 */
export function getMessagesSummary(messages: MessageWithParts[]): string {
  const userMessages = messages.filter(m => m.info.role === 'user');
  const toolCalls = messages.flatMap(m => m.parts.filter(p => p.type === 'tool-invocation'));

  const firstUserText = userMessages[0]?.parts.find(p => p.type === 'text')?.text || 'No prompt';
  const truncatedPrompt = firstUserText.length > 100
    ? firstUserText.substring(0, 100) + '...'
    : firstUserText;

  return `"${truncatedPrompt}" (${toolCalls.length} tool calls)`;
}

/**
 * Extract the system prompt from messages
 * The system prompt is stored on the first user message's `system` field
 */
export function extractSystemPrompt(messages: MessageWithParts[]): string | null {
  const firstUserMessage = messages.find(m => m.info.role === 'user');
  return firstUserMessage?.info.system || null;
}

/**
 * Fetch system prompt for a session
 * Fetches messages and extracts the system prompt from the first user message
 */
export async function fetchSystemPrompt(sessionId: string): Promise<string | null> {
  const messages = await fetchSessionMessages(sessionId);
  return extractSystemPrompt(messages);
}
