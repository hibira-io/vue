export type AgentRunStatus = 'streaming' | 'awaiting_approval' | 'done' | 'error';

export interface AgentToolCall {
  /** The provider's tool call id. */
  id: string;
  name: string | null;
  arguments: any;
  status: 'running' | 'done' | 'failed' | 'denied';
  /** undefined until the tool_result event. */
  result: any;
  error: string | null;
}

export type AgentPart =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'tool'; toolId: string };

/** One agent invocation (one broadcastOnQueue() call), put back together. */
export interface AgentRun {
  /** The invocation id, or "run-N" for broadcasts outside the queue. */
  id: string;
  status: AgentRunStatus;
  done: boolean;
  /** Text so far; steps are joined with a blank line, like TextDelta::combine(). */
  text: string;
  reasoning: string;
  /** Text, reasoning and tool calls in the order they started. */
  parts: AgentPart[];
  toolCalls: AgentToolCall[];
  /** The pending approvals of a tool_approval_request (status "awaiting_approval"). */
  approvals: any[];
  citations: Array<{ title?: string; url?: string }>;
  provider: string | null;
  model: string | null;
  usage: any;
  /** stream_end's finish reason. */
  reason: string | null;
  error: string | null;
  /** stream_start events seen. */
  steps: number;
  startedAt: number;
  endedAt?: number;
}

export interface AgentStore {
  apply(payload: any, event: string): void;
  readonly runs: Record<string, AgentRun>;
  reset(): void;
}

export const CHUNK_EVENT: 'hibira:chunk';
export const AGENT_EVENTS: string[];

export function createAgentStore(
  onChange: (runs: Record<string, AgentRun>, changed: AgentRun | null) => void,
  options?: { maxRuns?: number; now?: () => number },
): AgentStore;

export function latestRun(runs: Record<string, AgentRun>): AgentRun | null;
