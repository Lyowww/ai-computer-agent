/**
 * Core domain types for the AI computer-control orchestrator.
 * The AI never executes actions — it only produces validated action objects.
 */

export type MouseButton = "LEFT" | "RIGHT" | "MIDDLE";

export type AgentStatus =
  | "ACTION_REQUIRED"
  | "COMPLETED"
  | "NEEDS_USER_INPUT"
  | "FAILED";

/**
 * In-memory task status used by the AI orchestrator.
 * Wire / backend lifecycle uses TaskLifecycleStatus (PENDING, RUNNING, …).
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "needs_user_input"
  | "failed"
  | "cancelled";

/**
 * How the backend should treat planning after actions execute.
 * - single_action: plan once → execute → END (default for normal requests)
 * - multi_step: allow screenshot/plan loops until COMPLETED
 */
export type ExecutionMode = "single_action" | "multi_step";

export type ActionType =
  | "CLICK"
  | "DOUBLE_CLICK"
  | "MOVE_MOUSE"
  | "TYPE_TEXT"
  | "KEY_PRESS"
  | "HOTKEY"
  | "OPEN_APP"
  | "WAIT"
  | "SCREENSHOT"
  | "DONE"
  | "ASK_USER";

export interface Screenshot {
  /** Pixel width of the screenshot image. */
  width: number;
  /** Pixel height of the screenshot image. */
  height: number;
  /**
   * Image payload.
   * Accepts a data URL (`data:image/png;base64,...`), raw base64, or an HTTPS URL.
   */
  image: string;
  /** Optional MIME type when `image` is raw base64. Defaults to image/png. */
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
}

export interface ClickParams {
  x: number;
  y: number;
  button?: MouseButton;
  /** Debug/validation only — not proof the coordinate is correct. */
  targetLabel?: string;
}

export interface DoubleClickParams {
  x: number;
  y: number;
  button?: MouseButton;
  targetLabel?: string;
}

export interface MoveMouseParams {
  x: number;
  y: number;
  targetLabel?: string;
}

export interface TypeTextParams {
  text: string;
}

export interface KeyPressParams {
  key: string;
}

export interface HotkeyParams {
  keys: string[];
}

export interface OpenAppParams {
  app: string;
}

export interface WaitParams {
  /** Duration in milliseconds. */
  ms: number;
}

export interface ScreenshotParams {
  /** Optional reason for requesting a fresh screenshot. */
  reason?: string;
}

export interface DoneParams {
  summary?: string;
}

export interface AskUserParams {
  question: string;
  /** Why user confirmation is required. */
  reason?: string;
}

export type ActionParams =
  | ClickParams
  | DoubleClickParams
  | MoveMouseParams
  | TypeTextParams
  | KeyPressParams
  | HotkeyParams
  | OpenAppParams
  | WaitParams
  | ScreenshotParams
  | DoneParams
  | AskUserParams;

export type ComputerAction =
  | { type: "CLICK"; params: ClickParams }
  | { type: "DOUBLE_CLICK"; params: DoubleClickParams }
  | { type: "MOVE_MOUSE"; params: MoveMouseParams }
  | { type: "TYPE_TEXT"; params: TypeTextParams }
  | { type: "KEY_PRESS"; params: KeyPressParams }
  | { type: "HOTKEY"; params: HotkeyParams }
  | { type: "OPEN_APP"; params: OpenAppParams }
  | { type: "WAIT"; params: WaitParams }
  | { type: "SCREENSHOT"; params: ScreenshotParams }
  | { type: "DONE"; params: DoneParams }
  | { type: "ASK_USER"; params: AskUserParams };

export interface AiPlanResponse {
  status: AgentStatus;
  /** Short operational explanation — never chain-of-thought. */
  reasoning_summary: string;
  actions: ComputerAction[];
  /** Human-readable message for the user / backend. */
  message: string;
}

export interface ActionResult {
  action: ComputerAction;
  success: boolean;
  error?: string;
  /** Optional note from the desktop agent after execution. */
  notes?: string;
  executedAt: string;
}

export interface TaskState {
  taskId: string;
  userInstruction: string;
  currentScreenshot: Screenshot | null;
  previousActions: ComputerAction[];
  actionResults: ActionResult[];
  iteration: number;
  status: TaskStatus;
  executionMode: ExecutionMode;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Optional free-form notes accumulated across iterations. */
  notes?: string[];
}

export interface PlanNextActionInput {
  taskId?: string;
  userInstruction: string;
  screenshot: Screenshot;
  /** Prior actions already taken for this task (optional — orchestrator can track them). */
  previousActions?: ComputerAction[];
  actionResults?: ActionResult[];
  iteration?: number;
  /** Optional override; otherwise inferred from the instruction. */
  executionMode?: ExecutionMode;
  /** Optional user reply when the previous status was NEEDS_USER_INPUT. */
  userReply?: string;
  /** Existing task state to continue; if omitted a new task is created. */
  taskState?: TaskState;
}

export interface PlanNextActionResult {
  taskState: TaskState;
  response: AiPlanResponse;
  executionMode: ExecutionMode;
}

export type AiProviderName = "openrouter" | "gemini";

export interface AiMessageContentText {
  type: "text";
  text: string;
}

export interface AiMessageContentImage {
  type: "image";
  /** data URL or HTTPS URL */
  url: string;
}

export type AiMessageContent = AiMessageContentText | AiMessageContentImage;

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string | AiMessageContent[];
}

export interface AiCompletionRequest {
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Request JSON object response when the provider supports it. */
  responseFormat?: "json_object" | "text";
}

export interface AiCompletionResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
}

export interface AiProvider {
  /** Provider identifier — built-ins use AiProviderName; mocks may use any string. */
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;
}

export interface OrchestratorConfig {
  provider: AiProviderName;
  model: string;
  maxIterations: number;
  maxSameActionRetries: number;
  /** Provider HTTP timeout in milliseconds. */
  timeoutMs: number;
  openRouterApiKey?: string;
  geminiApiKey?: string;
  openRouterBaseUrl?: string;
  geminiBaseUrl?: string;
  /** Optional OpenRouter HTTP-Referer header. */
  openRouterHttpReferer?: string;
  /** Optional OpenRouter X-Title header. */
  openRouterAppName?: string;
}
