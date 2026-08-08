/**
 * Thin HTTP adapter so computer-agent-backend can call:
 *   POST {AI_SERVICE_URL}/v1/plan
 *
 * This is NOT a rebuild of the AI planner — it only wraps planNextAction().
 * OpenRouter / Gemini credentials stay in this process, never on the desktop agent.
 */

import http from "node:http";
import { planNextAction } from "../orchestrator/index.js";
import type { ComputerAction } from "../types/index.js";

const PORT = Number(process.env.AI_HTTP_PORT ?? process.env.PORT ?? 4000);
const API_KEY = process.env.AI_SERVICE_API_KEY?.trim() ?? "";

const AGENT_TO_WIRE: Record<string, string> = {
  ACTION_REQUIRED: "continue",
  COMPLETED: "completed",
  NEEDS_USER_INPUT: "need_user",
  FAILED: "failed",
};

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res: http.ServerResponse): void {
  send(res, 401, { error: "Unauthorized" });
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!API_KEY) return true;
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${API_KEY}`) return true;
  const alt = req.headers["x-api-key"];
  return typeof alt === "string" && alt === API_KEY;
}

function toWireActions(actions: ComputerAction[]): Array<{
  type: string;
  params: Record<string, unknown>;
}> {
  return actions.map((action) => ({
    type: action.type,
    params: { ...(action.params as Record<string, unknown>) },
  }));
}

export function createPlanServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      send(res, 200, { ok: true, service: "ai-computer-agent" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/plan") {
      if (!checkAuth(req)) {
        unauthorized(res);
        return;
      }

      try {
        const body = (await readJson(req)) as {
          taskId?: string;
          userInstruction?: string;
          screenshot?: {
            width: number;
            height: number;
            image: string;
            mimeType?: string;
          };
          previousActions?: ComputerAction[];
          userReply?: string;
        };

        if (!body.userInstruction || !body.screenshot) {
          send(res, 400, {
            error: "userInstruction and screenshot are required",
          });
          return;
        }

        const { response } = await planNextAction({
          taskId: body.taskId,
          userInstruction: body.userInstruction,
          screenshot: {
            width: body.screenshot.width,
            height: body.screenshot.height,
            image: body.screenshot.image,
            mimeType:
              body.screenshot.mimeType === "image/jpeg" ||
              body.screenshot.mimeType === "image/webp" ||
              body.screenshot.mimeType === "image/png"
                ? body.screenshot.mimeType
                : undefined,
          },
          previousActions: body.previousActions,
          userReply: body.userReply,
        });

        send(res, 200, {
          taskId: body.taskId ?? "unknown",
          status: AGENT_TO_WIRE[response.status] ?? "continue",
          message: response.message,
          actions: toWireActions(response.actions),
          reasoning_summary: response.reasoning_summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ level: "ERROR", message }));
        send(res, 503, { error: "AI planning failed", message });
      }
      return;
    }

    send(res, 404, { error: "Not found" });
  });
}

export function startPlanServer(port = PORT): http.Server {
  const server = createPlanServer();
  // Bind all interfaces so Render / containers can reach the service.
  server.listen(port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        level: "INFO",
        message: `AI computer agent listening on 0.0.0.0:${port}`,
        endpoints: ["/v1/plan", "/health"],
      })
    );
  });
  return server;
}
