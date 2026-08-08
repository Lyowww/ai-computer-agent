/**
 * Optional development helpers for inspecting AI click coordinates.
 * Never send debug overlays to the vision model in production.
 */

export interface CoordinateLogContext {
  taskId: string;
  requestId?: string;
  x: number;
  y: number;
  imageWidth: number;
  imageHeight: number;
  targetLabel?: string;
  nativeX?: number;
  nativeY?: number;
}

export function formatAiCoordinateLog(ctx: CoordinateLogContext): string {
  const prefix = ctx.requestId
    ? `[task=${ctx.taskId} req=${ctx.requestId}]`
    : `[task=${ctx.taskId}]`;
  const lines = [
    `${prefix} AI coordinate: x=${ctx.x} y=${ctx.y}`,
    `${prefix} AI image: ${ctx.imageWidth}x${ctx.imageHeight}`,
  ];
  if (ctx.targetLabel) {
    lines.push(`${prefix} targetLabel: ${ctx.targetLabel}`);
  }
  if (
    typeof ctx.nativeX === "number" &&
    typeof ctx.nativeY === "number"
  ) {
    lines.push(
      `${prefix} native mapped coordinate: x=${ctx.nativeX} y=${ctx.nativeY}`,
    );
  }
  return lines.join("\n");
}

/**
 * Whether debug coordinate overlays may be generated (desktop agent).
 * AI service never draws overlays onto images sent to the model.
 */
export function isCoordinateDebugOverlayEnabled(): boolean {
  const v = process.env.DEBUG_COORDINATE_OVERLAY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
