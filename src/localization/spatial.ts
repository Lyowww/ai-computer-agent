/**
 * Spatial constraint extraction and coordinate sanity checks.
 * Catches obviously contradictory click coordinates vs natural-language regions.
 */

export type SpatialRegion =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Soft thresholds — catch gross errors, not borderline UI. */
const EDGE = 0.35;
const FAR = 0.65;

const COMPOUND: Array<{ re: RegExp; region: SpatialRegion }> = [
  {
    re: /\b(top[\s-]?left|left[\s-]?top|upper[\s-]?left|upper[\s-]?lefthand)\b/i,
    region: "top-left",
  },
  {
    re: /\b(top[\s-]?right|right[\s-]?top|upper[\s-]?right)\b/i,
    region: "top-right",
  },
  {
    re: /\b(bottom[\s-]?left|left[\s-]?bottom|lower[\s-]?left)\b/i,
    region: "bottom-left",
  },
  {
    re: /\b(bottom[\s-]?right|right[\s-]?bottom|lower[\s-]?right)\b/i,
    region: "bottom-right",
  },
];

/**
 * Parse spatial words from a user instruction into regions that a click must respect.
 * "left top sidebar" → top-left. Plain "click Devices" → no constraint.
 */
export function extractSpatialConstraints(instruction: string): SpatialRegion[] {
  const text = instruction.trim();
  if (!text) return [];

  const regions: SpatialRegion[] = [];
  const seen = new Set<SpatialRegion>();

  const add = (r: SpatialRegion) => {
    if (!seen.has(r)) {
      seen.add(r);
      regions.push(r);
    }
  };

  for (const { re, region } of COMPOUND) {
    if (re.test(text)) add(region);
  }

  // "left top sidebar" / "top left nav" without hyphen
  const hasLeft = /\bleft\b/i.test(text);
  const hasRight = /\bright\b/i.test(text);
  const hasTop = /\b(top|upper)\b/i.test(text);
  const hasBottom = /\b(bottom|lower)\b/i.test(text);

  if (hasLeft && hasTop) add("top-left");
  if (hasRight && hasTop) add("top-right");
  if (hasLeft && hasBottom) add("bottom-left");
  if (hasRight && hasBottom) add("bottom-right");

  // Axis-only when no compound already covers that axis
  const hasHorizontalCompound = regions.some(
    (r) => r.includes("left") || r.includes("right"),
  );
  const hasVerticalCompound = regions.some(
    (r) => r.includes("top") || r.includes("bottom"),
  );

  if (hasLeft && !hasHorizontalCompound) add("left");
  if (hasRight && !hasHorizontalCompound) add("right");
  if (hasTop && !hasVerticalCompound) add("top");
  if (hasBottom && !hasVerticalCompound) add("bottom");

  return regions;
}

export interface SpatialSanityResult {
  ok: boolean;
  reason?: string;
  normalizedX: number;
  normalizedY: number;
  regions: SpatialRegion[];
}

function violates(
  region: SpatialRegion,
  nx: number,
  ny: number,
): string | null {
  switch (region) {
    case "top":
      return ny >= EDGE
        ? `Instruction implies top (y < ${EDGE}) but click is at y=${ny.toFixed(2)}`
        : null;
    case "bottom":
      return ny <= FAR
        ? `Instruction implies bottom (y > ${FAR}) but click is at y=${ny.toFixed(2)}`
        : null;
    case "left":
      return nx >= EDGE
        ? `Instruction implies left (x < ${EDGE}) but click is at x=${nx.toFixed(2)}`
        : null;
    case "right":
      return nx <= FAR
        ? `Instruction implies right (x > ${FAR}) but click is at x=${nx.toFixed(2)}`
        : null;
    case "top-left":
      if (nx >= EDGE || ny >= EDGE) {
        return `Instruction implies top-left (x < ${EDGE}, y < ${EDGE}) but click is at (${nx.toFixed(2)}, ${ny.toFixed(2)})`;
      }
      return null;
    case "top-right":
      if (nx <= FAR || ny >= EDGE) {
        return `Instruction implies top-right (x > ${FAR}, y < ${EDGE}) but click is at (${nx.toFixed(2)}, ${ny.toFixed(2)})`;
      }
      return null;
    case "bottom-left":
      if (nx >= EDGE || ny <= FAR) {
        return `Instruction implies bottom-left (x < ${EDGE}, y > ${FAR}) but click is at (${nx.toFixed(2)}, ${ny.toFixed(2)})`;
      }
      return null;
    case "bottom-right":
      if (nx <= FAR || ny <= FAR) {
        return `Instruction implies bottom-right (x > ${FAR}, y > ${FAR}) but click is at (${nx.toFixed(2)}, ${ny.toFixed(2)})`;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Sanity-check that a click is roughly in the region described by the user.
 * Soft thresholds — only rejects obviously contradictory coordinates.
 */
export function checkSpatialSanity(
  x: number,
  y: number,
  width: number,
  height: number,
  instruction: string,
): SpatialSanityResult {
  const regions = extractSpatialConstraints(instruction);
  const normalizedX = width > 0 ? x / width : 0;
  const normalizedY = height > 0 ? y / height : 0;

  if (regions.length === 0) {
    return { ok: true, normalizedX, normalizedY, regions };
  }

  for (const region of regions) {
    const reason = violates(region, normalizedX, normalizedY);
    if (reason) {
      return { ok: false, reason, normalizedX, normalizedY, regions };
    }
  }

  return { ok: true, normalizedX, normalizedY, regions };
}

/**
 * Best-effort extraction of a visible UI label the user asked to click.
 * Used for logging / optional targetLabel cross-check — never as sole proof.
 */
export function extractLikelyTargetLabel(instruction: string): string | null {
  const text = instruction.trim();
  if (!text) return null;

  const quoted = /['"]([^'"]{1,64})['"]/.exec(text);
  if (quoted?.[1]) return quoted[1].trim();

  const skip =
    /^(left|right|top|bottom|upper|lower|the|a|an|on|sidebar|nav|navigation|please|click|tap)$/i;

  // "... Devices tab" / "... refresh button"
  const withRole =
    /\b([A-Za-z][\w.-]{0,40})\s+(tab|button|icon|link|item|menu)\b/gi;
  let m: RegExpExecArray | null;
  const roleHits: string[] = [];
  while ((m = withRole.exec(text)) !== null) {
    if (m[1] && !skip.test(m[1])) roleHits.push(m[1].trim());
  }
  if (roleHits.length > 0) return roleHits[roleHits.length - 1];

  const patterns = [
    /\b(?:click|tap|press|select|open)\s+(?:on\s+)?(?:the\s+)?(?:(?:left|right|top|bottom|upper|lower|sidebar|nav(?:igation)?)\s+)*(?:['"]?)([A-Za-z][\w.-]{0,40})(?:['"]?)\s*$/i,
  ];

  for (const re of patterns) {
    const hit = re.exec(text);
    if (hit?.[1] && !skip.test(hit[1])) return hit[1].trim();
  }

  return null;
}

export function formatCoordinateSystemPrompt(
  width: number,
  height: number,
): string {
  return [
    `The screenshot dimensions are ${width} x ${height} pixels.`,
    "",
    "All CLICK, DOUBLE_CLICK, and MOVE_MOUSE coordinates MUST refer directly to this screenshot coordinate system.",
    "",
    "Origin:",
    "(0, 0) = top-left corner.",
    "",
    "X increases → right.",
    "Y increases → down.",
    "",
    "Do not use native screen coordinates.",
    "Do not estimate coordinates from a different resolution.",
    "Do not scale coordinates yourself.",
    "Do not invent coordinates.",
    "Never reuse coordinates from previous screenshots or previous tasks.",
    "Always derive coordinates from the CURRENT screenshot image attached to this message.",
  ].join("\n");
}
