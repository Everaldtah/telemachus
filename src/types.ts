export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  toolCalls?: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  model: string;
}

export interface Provider {
  readonly kind: "nvidia" | "openrouter";
  readonly model: string;
  generate(messages: Message[], options?: GenerateOptions): Promise<GenerateResult>;
  listModels(): Promise<string[]>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
