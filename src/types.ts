export type JsonObject = Record<string, unknown>;

export interface KeyMapping {
  nvidia_keys: string[];
  created_at: string;
  note?: string;
  request_count?: number;
  expires_at?: number;      // Unix timestamp (ms) - expiration time for time-based cards
  max_requests?: number;    // Maximum request count limit for quota-based cards
}

export interface ModelConfig {
  identity: string;
  fallback_chain: string[];
}

export interface ChatRequest extends JsonObject {
  model: string;
  messages: JsonObject[];
  stream: boolean;
}

export interface ChatMessage extends JsonObject {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
}

export interface ChatChoice extends JsonObject {
  index: number;
  message: ChatMessage;
  finish_reason: unknown;
}

export interface ChatCompletion extends JsonObject {
  model: string;
  choices: ChatChoice[];
}

export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
    param: string | null;
  };
}
