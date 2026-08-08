import type { Screenshot } from "../types/index.js";

/**
 * Read width/height from a PNG buffer (IHDR), without decoding pixels.
 */
export function readPngDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  // PNG signature
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return null;
  }
  // IHDR type at offset 12 must be "IHDR"
  const type = buffer.toString("ascii", 12, 16);
  if (type !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function extractBase64Payload(image: string): string | null {
  if (image.startsWith("data:")) {
    const idx = image.indexOf(",");
    if (idx < 0) return null;
    return image.slice(idx + 1);
  }
  if (/^https?:\/\//i.test(image)) return null;
  return image;
}

export interface ScreenshotDimensionCheck {
  ok: boolean;
  /** Dimensions to use for planning (actual image when measurable). */
  width: number;
  height: number;
  metadataWidth: number;
  metadataHeight: number;
  corrected: boolean;
  /** True when we could measure the encoded image. */
  measured: boolean;
  warning?: string;
}

/**
 * Ensure screenshot metadata matches the encoded image bytes.
 * When PNG IHDR differs from declared width/height, prefer the actual image size.
 */
export function alignScreenshotDimensions(
  screenshot: Screenshot,
): ScreenshotDimensionCheck {
  const metadataWidth = screenshot.width;
  const metadataHeight = screenshot.height;

  const b64 = extractBase64Payload(screenshot.image);
  if (!b64) {
    return {
      ok: true,
      width: metadataWidth,
      height: metadataHeight,
      metadataWidth,
      metadataHeight,
      corrected: false,
      measured: false,
      warning: "Could not measure image bytes (remote URL or empty payload)",
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch {
    return {
      ok: false,
      width: metadataWidth,
      height: metadataHeight,
      metadataWidth,
      metadataHeight,
      corrected: false,
      measured: false,
      warning: "Invalid base64 image payload",
    };
  }

  const dims = readPngDimensions(buffer);
  if (!dims) {
    // JPEG/WebP — trust metadata; we cannot verify without a decoder.
    return {
      ok: true,
      width: metadataWidth,
      height: metadataHeight,
      metadataWidth,
      metadataHeight,
      corrected: false,
      measured: false,
    };
  }

  if (dims.width === metadataWidth && dims.height === metadataHeight) {
    return {
      ok: true,
      width: dims.width,
      height: dims.height,
      metadataWidth,
      metadataHeight,
      corrected: false,
      measured: true,
    };
  }

  // Tiny IHDR with large metadata usually means a test stub / corrupt decode —
  // never treat 1×1 as the planning coordinate space for a desktop screenshot.
  const MIN_PLAUSIBLE = 64;
  if (
    (dims.width < MIN_PLAUSIBLE || dims.height < MIN_PLAUSIBLE) &&
    metadataWidth >= MIN_PLAUSIBLE &&
    metadataHeight >= MIN_PLAUSIBLE
  ) {
    return {
      ok: true,
      width: metadataWidth,
      height: metadataHeight,
      metadataWidth,
      metadataHeight,
      corrected: false,
      measured: true,
      warning: `Image IHDR ${dims.width}x${dims.height} is implausibly small vs metadata ${metadataWidth}x${metadataHeight}; keeping metadata for coordinate bounds`,
    };
  }

  return {
    ok: true,
    width: dims.width,
    height: dims.height,
    metadataWidth,
    metadataHeight,
    corrected: true,
    measured: true,
    warning: `Screenshot metadata ${metadataWidth}x${metadataHeight} != image IHDR ${dims.width}x${dims.height}; using IHDR`,
  };
}

export function withAlignedDimensions(screenshot: Screenshot): {
  screenshot: Screenshot;
  check: ScreenshotDimensionCheck;
} {
  const check = alignScreenshotDimensions(screenshot);
  if (!check.corrected) {
    return { screenshot, check };
  }
  return {
    screenshot: {
      ...screenshot,
      width: check.width,
      height: check.height,
    },
    check,
  };
}
