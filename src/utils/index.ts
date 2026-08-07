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

export function clampCoordinate(
  value: number,
  maxExclusive: number,
): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value >= maxExclusive) return Math.max(0, maxExclusive - 1);
  return Math.round(value);
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
 * or surrounding prose.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  // Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // Fenced code block
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim());
  }

  // First {...} object
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("Unable to extract JSON object from model response");
}
