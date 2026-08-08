# AI Computer Agent — AI Brain / Orchestrator

Production-ready TypeScript/Node.js service that turns a **user instruction + screenshot** into **validated structured computer actions**.

This project does **not**:

- render a chat UI
- run a WebSocket/backend server
- move the mouse or type on a real machine

It only **plans** the next safe action(s). A separate desktop agent executes them and returns a new screenshot for the next iteration.

## Flow

```
User instruction
  → analyze current screenshot
  → produce structured action(s)
  → desktop agent executes
  → receive updated screenshot
  → analyze result
  → produce next action
  → repeat until DONE / ASK_USER / FAILED
```

Example: `"Open Chrome and go to youtube.com"`

1. Decide if Chrome is already visible  
2. `OPEN_APP` if needed  
3. Wait for a fresh screenshot  
4. Find the address bar → `CLICK`  
5. `TYPE_TEXT` (`youtube.com`)  
6. `HOTKEY` / `KEY_PRESS` (Enter)  
7. Verify from screenshot → `DONE`

## Stack

- Node.js 20+
- TypeScript (ESM)
- OpenAI-compatible provider abstraction
- OpenRouter + Google Gemini implementations
- Zod validation
- dotenv configuration
- Vitest tests

## Project layout

```
src/
  ai/providers/     OpenRouter + Gemini + factory
  prompts/          System / user prompt builders
  vision/           Screenshot → structured plan
  orchestrator/     Iterative planner + loop protection
  actions/          Action helpers / fingerprints
  schemas/          Zod schemas
  safety/           Action safety layer
  memory/           Task state + history
  types/            Shared TypeScript types
  utils/            Config, JSON extraction, coordinates
  index.ts          Public API
tests/
```

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
AI_PROVIDER=openrouter                 # or gemini
AI_MODEL=google/gemini-2.5-flash       # provider-specific model id
OPENROUTER_API_KEY=...                 # required for openrouter
OPENROUTER_HTTP_REFERER=               # optional
OPENROUTER_APP_NAME=PetAI Computer Agent
GEMINI_API_KEY=...                     # required for gemini
MAX_AGENT_ITERATIONS=30
MAX_SAME_ACTION_RETRIES=3
AI_TIMEOUT_MS=60000
```

```bash
npm run build
npm test
```

## Public API

### `planNextAction(input, options?)`

```ts
import { planNextAction } from "@petai/ai-computer-agent";

const { taskState, response } = await planNextAction({
  userInstruction: "Open Chrome and go to youtube.com",
  screenshot: {
    width: 1920,
    height: 1080,
    image: "data:image/png;base64,...", // or raw base64
  },
});

console.log(response.status);
console.log(response.actions);
// Hand `response.actions` to the desktop agent, then call again with
// the new screenshot + previous `taskState` (and action results).
```

### Continue a task

```ts
import { planNextAction, recordActionResults } from "@petai/ai-computer-agent";

let { taskState, response } = await planNextAction({
  userInstruction: "Open Chrome and go to youtube.com",
  screenshot: shot1,
});

// Desktop agent executes response.actions …
taskState = recordActionResults(taskState, [
  {
    action: response.actions[0],
    success: true,
    executedAt: new Date().toISOString(),
  },
]);

({ taskState, response } = await planNextAction({
  userInstruction: taskState.userInstruction,
  screenshot: shot2,
  taskState,
}));
```

### Inject a provider (tests / custom backends)

```ts
import { Orchestrator, type AiProvider } from "@petai/ai-computer-agent";

const provider: AiProvider = {
  name: "openrouter",
  async complete(req) {
    // custom implementation
    return { content: "...", model: req.model };
  },
};

const orchestrator = new Orchestrator({ provider, config: { model: "mock" } });
await orchestrator.planNextAction({ userInstruction: "...", screenshot });
```

## Response schema

Every plan validates as:

```json
{
  "status": "ACTION_REQUIRED | COMPLETED | NEEDS_USER_INPUT | FAILED",
  "reasoning_summary": "short operational explanation",
  "actions": [],
  "message": "human-readable response"
}
```

`reasoning_summary` is short and operational — not chain-of-thought.

## Supported actions

| Type | Params |
|------|--------|
| `CLICK` | `{ x, y, button? }` |
| `DOUBLE_CLICK` | `{ x, y, button? }` |
| `MOVE_MOUSE` | `{ x, y }` |
| `TYPE_TEXT` | `{ text }` |
| `KEY_PRESS` | `{ key }` |
| `HOTKEY` | `{ keys: string[] }` |
| `OPEN_APP` | `{ app }` |
| `WAIT` | `{ ms }` |
| `SCREENSHOT` | `{ reason? }` |
| `DONE` | `{ summary? }` |
| `ASK_USER` | `{ question, reason? }` |

Coordinates must satisfy `0 <= x < width` and `0 <= y < height`.

The model **cannot** return arbitrary code, shell commands, or executable payloads.

## Safety layer

Before actions leave the orchestrator they are checked for:

- out-of-bounds coordinates
- shell / script-like `TYPE_TEXT` content
- blocked apps (e.g. Terminal)
- dangerous hotkeys
- forbidden params (`command`, `script`, `eval`, …)
- consequential user instructions (delete, purchase, password change, shutdown, …) → `ASK_USER`

## Loop protection

- Default max iterations: `MAX_AGENT_ITERATIONS` (30)
- Repeated unsuccessful identical actions → `NEEDS_USER_INPUT` / `FAILED`
- Empty or invalid model output → `FAILED`

## Switching providers

Set `AI_PROVIDER` + `AI_MODEL` (and the matching API key). The orchestrator depends only on the `AiProvider` interface, so OpenRouter and Gemini are interchangeable without code changes.

| Provider | Env key | Example model |
|----------|---------|---------------|
| `openrouter` | `OPENROUTER_API_KEY` | `google/gemini-2.5-flash`, `openai/gpt-4o` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.0-flash`, `gemini-1.5-pro` |

## Connecting to a backend later

Typical integration:

1. Backend receives chat message + latest screenshot from the desktop agent  
2. Backend calls `planNextAction(...)`  
3. Backend forwards `response.actions` to the desktop agent  
4. Desktop agent executes, captures a new screenshot, reports `ActionResult`s  
5. Backend calls `planNextAction` again with updated `taskState` until `COMPLETED` / `FAILED` / `NEEDS_USER_INPUT`

## License

MIT
