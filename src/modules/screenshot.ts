import { ensureDir, pluginRootDir } from "./storage";
/**
 * Formula screenshots.
 *
 * Why this exists: PDF text extraction mangles maths — fractions flatten,
 * sub/superscripts lose their position, symbols from private-use fonts vanish.
 * No amount of prompt engineering recovers information that was never in the
 * text layer. Cropping the pixels is the only approach that works for every
 * formula, including ones rendered as vector outlines with no text at all.
 *
 * The coordinate maths is isolated here because it is the part that silently
 * produces a screenshot of the wrong region, which looks like a model failure
 * rather than a bug.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Padding {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Map a rectangle from the text layer's coordinate space to canvas pixels.
 *
 * The reader draws a page into a canvas whose backing store is
 * `cssSize * outputScale` (see PDF.js's `OutputScale`), while the text layer and
 * the DOM selection are laid out in CSS pixels. Scaling by
 * `canvas.width / layerWidth` therefore handles both the device pixel ratio and
 * any zoom in one step.
 */
export function scaleRectToCanvas(
  rect: Rect,
  layer: Rect,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  if (layer.width <= 0 || layer.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const sx = canvasWidth / layer.width;
  const sy = canvasHeight / layer.height;
  return {
    left: (rect.left - layer.left) * sx,
    top: (rect.top - layer.top) * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

/**
 * Expand a selection rectangle to cover whole lines, then pad it.
 *
 * A text-layer selection is per-glyph and tight: for a formula it may cover only
 * part of the expression, and the surrounding tall glyphs (fractions, integrals)
 * stick out above and below. Growing vertically to the full line box keeps the
 * formula intact.
 */
export function expandForFormula(
  rect: Rect,
  lineHeight: number,
  scale: number,
  padding = 2,
): Rect {
  const growY = Math.max(0, (lineHeight - rect.height) / 2);
  const pad = padding * scale;
  return {
    left: rect.left - pad,
    top: rect.top - growY - pad,
    width: rect.width + pad * 2,
    height: rect.height + growY * 2 + pad * 2,
  };
}

/** Clamp a rectangle to the canvas and round it to whole pixels. */
export function clampRect(
  rect: Rect,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  const left = Math.max(0, Math.min(Math.floor(rect.left), canvasWidth));
  const top = Math.max(0, Math.min(Math.floor(rect.top), canvasHeight));
  const right = Math.max(left, Math.min(Math.ceil(rect.left + rect.width), canvasWidth));
  const bottom = Math.max(
    top,
    Math.min(Math.ceil(rect.top + rect.height), canvasHeight),
  );
  return { left, top, width: right - left, height: bottom - top };
}

/** Is there anything worth sending? */
export function isUsableRect(rect: Rect, minSide = 8): boolean {
  return rect.width >= minSide && rect.height >= minSide;
}

/** Bounding box that contains all the given rectangles. */
export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) {
    return null;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

/* ------------------------------------------------------------------ */
/* Page canvas discovery                                               */
/* ------------------------------------------------------------------ */

/**
 * The rendered page canvas that contains a text-layer node.
 *
 * Zotero's reader (PDF.js) lays each page out as
 * `pageView > canvasWrapper > canvas` plus a sibling text layer, and may keep a
 * previous canvas around for double buffering. Taking the *last* canvas inside
 * the wrapper picks the current one rather than the stale buffer.
 */
export function findPageCanvas(node: Node): HTMLCanvasElement | null {
  let el: Node | null = node;
  while (el && (el as HTMLElement).tagName !== "DIV") {
    el = el.parentNode;
  }
  let scope = el as HTMLElement | null;
  // Walk up looking for the page container that holds both layers.
  for (let i = 0; i < 6 && scope; i++) {
    const wrapper = scope.querySelector?.(".canvasWrapper");
    if (wrapper) {
      const canvases = wrapper.querySelectorAll("canvas");
      if (canvases.length) {
        return canvases[canvases.length - 1] as unknown as HTMLCanvasElement;
      }
    }
    // Zotero's type definitions widen `parentElement` to `Element`.
    scope = scope.parentElement as HTMLElement | null;
  }
  return null;
}

/** The element whose coordinate space the selection rectangle is in. */
export function findTextLayer(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    const candidate = el as HTMLElement;
    if (candidate.classList?.contains("textLayer")) {
      return candidate;
    }
    el = el.parentNode;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Cropping                                                            */
/* ------------------------------------------------------------------ */

export interface CropResult {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Crop a region out of a canvas and return a PNG data URL.
 *
 * The crop is drawn at `scale` times its size so small sub/superscripts survive
 * the vision model's downscaling. The provider resizes large images to roughly
 * 1300x1300 before inference, so a small, sharp crop is strictly better than a
 * large, soft one.
 */
export function cropCanvas(
  canvas: HTMLCanvasElement,
  rect: Rect,
  scale = 2,
): CropResult | null {
  try {
    // Zotero's type definitions override `ownerDocument` and `getContext` with
    // XPCOM types that do not match lib.dom. Narrow once, at this boundary,
    // rather than scattering casts through the geometry code above.
    const el = canvas as unknown as {
      ownerDocument: Document;
      width: number;
      height: number;
      toDataURL(type?: string): string;
    };
    const out = el.ownerDocument.createElement("canvas") as HTMLCanvasElement;
    out.width = Math.max(1, Math.round(rect.width * scale));
    out.height = Math.max(1, Math.round(rect.height * scale));
    const ctx = out.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) {
      return null;
    }
    // A white background: formulas are drawn in black on transparent, and a
    // transparent PNG can be rendered unreadably on a dark surface.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(
      el as unknown as CanvasImageSource,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      0,
      0,
      out.width,
      out.height,
    );
    return {
      dataUrl: out.toDataURL("image/png"),
      width: out.width,
      height: out.height,
    };
  } catch (e) {
    // A tainted canvas throws here; report rather than crash the ask flow.
    Zotero.debug(`[Highlight Ask] canvas crop failed: ${(e as Error)?.message || e}`);
    return null;
  }
}

/**
 * Capture the formula a DOM selection covers.
 *
 * Returns null whenever a screenshot is not possible, so the caller can fall
 * back to sending text — a screenshot is an improvement, never a requirement.
 */
export function captureSelection(
  selection: Selection | null,
  opts: { padding?: number; scale?: number } = {},
): CropResult | null {
  try {
    if (!selection || !selection.rangeCount) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const textLayer = findTextLayer(range.startContainer);
    const canvas = findPageCanvas(range.startContainer);
    if (!textLayer || !canvas) {
      return null;
    }

    // Union the per-line client rects: a wrapped formula spans several.
    const layerBox = textLayer.getBoundingClientRect();
    const lineRects: DOMRect[] = [];
    const clientRects = range.getClientRects();
    const count = clientRects ? clientRects.length : 0;
    for (let i = 0; i < count; i++) {
      const r = clientRects![i];
      if (r.width > 1 && r.height > 1) {
        lineRects.push(r);
      }
    }
    if (!lineRects.length) {
      return null;
    }

    const scale = opts.scale ?? 2;
    const lineHeight = lineRects[0].height || 0;

    const parts: Rect[] = [];
    for (const r of lineRects) {
      const inCanvas = scaleRectToCanvas(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        {
          left: layerBox.left,
          top: layerBox.top,
          width: layerBox.width,
          height: layerBox.height,
        },
        canvas.width,
        canvas.height,
      );
      const sx = canvas.width / Math.max(1, layerBox.width);
      parts.push(
        expandForFormula(
          inCanvas,
          lineHeight * (canvas.height / Math.max(1, layerBox.height)),
          sx,
          opts.padding ?? 2,
        ),
      );
    }

    const union = unionRects(parts);
    if (!union) {
      return null;
    }
    const clamped = clampRect(union, canvas.width, canvas.height);
    if (!isUsableRect(clamped)) {
      return null;
    }
    return cropCanvas(canvas, clamped, scale);
  } catch (e) {
    Zotero.debug(`[Highlight Ask] capture failed: ${(e as Error)?.message || e}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

export interface DebugCapture {
  /** File the PNG was written to, for the user to open. */
  path?: string;
  dataUrl: string;
  width: number;
  height: number;
  /** What the geometry worked out to, for eyeballing against the image. */
  detail: string;
}

/**
 * Capture and save a selection to disk so it can be inspected by eye.
 *
 * This exists because the failure mode of screenshot cropping is a picture of
 * the wrong region, and no amount of unit-testing the arithmetic proves that
 * the *selector* found the right elements in a real reader DOM. Looking at the
 * PNG answers it immediately.
 */
export async function captureSelectionToFile(
  selection: Selection | null,
  opts: { padding?: number; scale?: number } = {},
): Promise<DebugCapture | null> {
  const shot = captureSelection(selection, opts);
  if (!shot) {
    return null;
  }
  let path: string | undefined;
  try {
    const dir = `${pluginRootDir()}/debug`;
    await ensureDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${dir}/capture-${stamp}.png`;
    const base64 = shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    await IOUtils.write(file, bytes);
    path = file;
  } catch (e) {
    Zotero.debug(`[Highlight Ask] could not save capture: ${(e as Error)?.message || e}`);
  }
  return {
    path,
    dataUrl: shot.dataUrl,
    width: shot.width,
    height: shot.height,
    detail: `${shot.width}x${shot.height} px`,
  };
}

/**
 * Describe the geometry without capturing, for the debug log.
 *
 * When a capture comes out wrong, the numbers say whether the page canvas was
 * found, what the scale factor was, and which region was taken.
 */
export function describeGeometry(selection: Selection | null): string {
  try {
    if (!selection || !selection.rangeCount) {
      return "no selection";
    }
    const range = selection.getRangeAt(0);
    const layer = findTextLayer(range.startContainer);
    const canvas = findPageCanvas(range.startContainer);
    const rects = range.getClientRects();
    return [
      `textLayer=${layer ? "found" : "MISSING"}`,
      `canvas=${canvas ? `${canvas.width}x${canvas.height}` : "MISSING"}`,
      `layerBox=${layer ? Math.round(layer.getBoundingClientRect().width) + "x" + Math.round(layer.getBoundingClientRect().height) : "-"}`,
      `rects=${rects ? rects.length : 0}`,
      `scale=${layer && canvas ? (canvas.width / Math.max(1, layer.getBoundingClientRect().width)).toFixed(2) : "-"}`,
    ].join(" ");
  } catch (e) {
    return `geometry failed: ${(e as Error)?.message || e}`;
  }
}

/**
 * Approximate decoded size of a base64 PNG, in bytes.
 *
 * Used to stay under the provider's per-image limit before sending.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    return 0;
  }
  const b64 = dataUrl.length - comma - 1;
  return Math.floor((b64 * 3) / 4);
}
