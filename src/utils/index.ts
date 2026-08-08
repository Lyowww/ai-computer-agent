import type { Screenshot } from "../types/index.js";

/**
 * Normalize screenshot image into a data URL suitable for vision APIs.
 */
export function toImageDataUrl(screenshot: Screenshot): string {
  const { image, mimeType = "image/png" } = screenshot;

  if (image.startsWith("data:")) {
    return image;
  }

  if (/^https?:\/\//i.test(image)) {
    return image;
  }

  // Assume raw base64
  return `data:${mimeType};base64,${image}`;
}

/**
 * Extract base64 payload and mime type from a screenshot for Gemini-style APIs.
 */
export function toInlineImageParts(screenshot: Screenshot): {
  mimeType: string;
  data: string;
} {
  const dataUrl = toImageDataUrl(screenshot);

  if (dataUrl.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
      throw new Error("Invalid image data URL format");
    }
    return { mimeType: match[1], data: match[2] };
  }

  // HTTPS URLs are not inlined — callers must use URL form where supported.
  throw new Error(
    "Gemini provider requires base64 or data-URL screenshots (not remote HTTPS URLs)",
  );
}

export function isCoordinateInBounds(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height
  );
}

export function createId(prefix = "task"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Extract a JSON object from model output that may include markdown fences
 * or surrounding prose. Never executes content — parse only.
 */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Unable to extract JSON object from empty model response");
  }

  const trimmed = text.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // 2. Fenced code block (```json ... ``` or ``` ... ```)
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // continue
    }
  }

  // 3. First balanced {...} object (handles trailing prose)
  const extracted = extractBalancedObject(trimmed);
  if (extracted !== null) {
    try {
      return JSON.parse(extracted);
    } catch {
      // continue
    }
  }

  throw new Error("Unable to extract JSON object from model response");
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
