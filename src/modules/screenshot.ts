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
  // The document that actually holds the rendered page.
  const doc = (node as any)?.ownerDocument as Document | undefined;
  if (!doc) {
    return null;
  }

  const pickLatest = (wrapper: Element | null): HTMLCanvasElement | null => {
    if (!wrapper) {
      return null;
    }
    const canvases = wrapper.querySelectorAll("canvas");
    // PDF.js keeps a previous canvas around for double buffering; the last one
    // is the page currently shown.
    return canvases.length
      ? (canvases[canvases.length - 1] as unknown as HTMLCanvasElement)
      : null;
  };

  // 1. The wrapper nearest the selection. Zotero's reader is a patched PDF.js,
  //    so building on its layer names here is a guess.
  try {
    let el: Element | null =
      (node as Element)?.nodeType === 1
        ? (node as Element)
        : ((node as Node).parentElement as Element | null);
    for (let hops = 0; hops < 20 && el; hops++) {
      const wrapper = el.closest?.(".canvasWrapper") || el.querySelector?.(".canvasWrapper");
      const found = pickLatest(wrapper ?? null);
      if (found) {
        return found;
      }
      el = el.parentElement;
    }
  } catch {
    /* fall through to the document-wide search */
  }

  // 2. Document-wide: independent of the DOM layout, so a reader that nests
  //    things differently still works. Requires the page to have a non-trivial
  //    canvas, which rules out the reader's UI canvases.
  try {
    const all = doc.querySelectorAll(".canvasWrapper canvas, canvas");
    const plausible: HTMLCanvasElement[] = [];
    for (let i = 0; i < all.length; i++) {
      const c = all[i] as HTMLCanvasElement;
      if (c.width >= 200 && c.height >= 200) {
        plausible.push(c);
      }
    }
    if (plausible.length) {
      // Prefer the largest: the rendered page dwarfs any icon canvas.
      return plausible.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    }
  } catch {
    /* nothing usable */
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
/* Deferred capture                                                    */
/* ------------------------------------------------------------------ */

/**
 * A capture reduced to plain data: a canvas plus a rectangle on it.
 *
 * The geometry is resolved while the selection is still alive — during
 * `renderTextSelectionPopup`, when the reader hands us its own iframe window —
 * and only the *rendering* happens later, when the button is pressed. Clicking
 * into the sidebar removes the PDF's selection, so resolving it late is exactly
 * what failed: the reader had a live selection at popup time and none after.
 */
export interface PendingCapture {
  canvas: HTMLCanvasElement;
  rect: Rect;
  /** Page-space size, for the diagnostic message. */
  detail: string;
  /** The selection text, for cross-checking against the crop. */
  text: string;
}

/**
 * Resolve the crop region for a selection, without rendering it.
 * Returns null when the page canvas or a usable rectangle cannot be found.
 */
export interface GeometryFailure {
  ok: false;
  step: "selection" | "textLayer" | "canvas" | "layerBox" | "rects" | "clamp";
  detail: string;
}
export type GeometryOutcome =
  | ({ ok: true } & PendingCapture)
  | GeometryFailure;

/**
 * Resolve the crop region for a selection, without rendering it.
 *
 * Reports which step failed rather than returning a bare null: this runs inside
 * the reader's popup handler where a failure is otherwise invisible, and
 * "capture did not work" says nothing about whether the text layer, the page
 * canvas or the selection rectangle was the problem.
 */
export function captureGeometry(
  selection: Selection | null,
  opts: { padding?: number } = {},
): GeometryOutcome {
  try {
    if (!selection || !selection.rangeCount) {
      return { ok: false, step: "selection", detail: "选区为空" };
    }
    const range = selection.getRangeAt(0);
    const startEl = range.startContainer;
    const textLayer = findTextLayer(startEl);
    const canvas = findPageCanvas(startEl);

    const doc = (startEl as any)?.ownerDocument;
    const docCanvases = (() => {
      try {
        return doc ? doc.querySelectorAll("canvas").length : -1;
      } catch {
        return -1;
      }
    })();

    if (!textLayer) {
      return {
        ok: false,
        step: "textLayer",
        detail: `找到画布=${canvas ? "是" : "否"} 文档内canvas数=${docCanvases} 起点=${(startEl as any)?.nodeName || "?"}`,
      };
    }
    if (!canvas) {
      return {
        ok: false,
        step: "canvas",
        detail: `有textLayer 文档内canvas数=${docCanvases}`,
      };
    }

    const layerBox = textLayer.getBoundingClientRect();
    if (layerBox.width <= 0 || layerBox.height <= 0) {
      return {
        ok: false,
        step: "layerBox",
        detail: `textLayer尺寸=${Math.round(layerBox.width)}x${Math.round(layerBox.height)}`,
      };
    }

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
      return {
        ok: false,
        step: "rects",
        detail: `getClientRects 共 ${count} 个，均过小`,
      };
    }

    const sx = canvas.width / layerBox.width;
    const sy = canvas.height / layerBox.height;
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
      parts.push(
        expandForFormula(inCanvas, lineHeight * sy, sx, opts.padding ?? 2),
      );
    }

    const union = unionRects(parts);
    const rect = union
      ? clampRect(union, canvas.width, canvas.height)
      : { left: 0, top: 0, width: 0, height: 0 };
    if (!isUsableRect(rect)) {
      return {
        ok: false,
        step: "clamp",
        detail: `裁剪矩形=${Math.round(rect.width)}x${Math.round(rect.height)} 画布=${canvas.width}x${canvas.height}`,
      };
    }

    return {
      ok: true,
      canvas,
      rect,
      detail: `canvas=${canvas.width}x${canvas.height} rect=${rect.left},${rect.top} ${rect.width}x${rect.height} scale=${sx.toFixed(2)}`,
      text: String(selection.toString() || ""),
    };
  } catch (e) {
    return {
      ok: false,
      step: "selection",
      detail: `异常: ${(e as Error)?.message || e}`,
    };
  }
}

/** Render a previously resolved capture. */
export function renderPendingCapture(
  pending: PendingCapture,
  scale = 2,
): CropResult | null {
  return cropCanvas(pending.canvas, pending.rect, scale);
}

/* ------------------------------------------------------------------ */
/* Finding the live selection                                          */
/* ------------------------------------------------------------------ */

/**
 * Find the non-empty selection in any open reader.
 *
 * The panel runs in the reader's outer window while the PDF lives in the
 * reader's own frame, so the selection has to be fetched from that frame. The
 * reliable way is through the reader instance — `Zotero.Reader._readers` holds
 * every open reader and each one references its frame directly. Walking
 * `window.frames` instead means guessing the nesting depth, which did not work.
 *
 * Readers are checked newest-first: the one the user is looking at is the most
 * likely to hold a live selection.
 */
export function findReaderSelection(): {
  selection: Selection | null;
  readerItemID?: number;
  source: string;
} {
  try {
    const readers: any[] =
      (Zotero as any).Reader?._readers || [];
    for (let i = readers.length - 1; i >= 0; i--) {
      const reader = readers[i];
      try {
        const win = reader?._iframeWindow;
        if (!win) {
          continue;
        }
        const sel = win.getSelection?.();
        if (sel && sel.rangeCount && String(sel.toString() || "").trim()) {
          return {
            selection: sel as Selection,
            readerItemID: reader.itemID,
            source: `reader#${i} itemID=${reader.itemID}`,
          };
        }
      } catch {
        /* a reader frame that is gone or not accessible */
      }
    }
    return { selection: null, source: `no reader selection (${readers.length} readers)` };
  } catch (e) {
    return { selection: null, source: `reader lookup failed: ${(e as Error)?.message || e}` };
  }
}

/**
 * Fallback: search child frames from a window.
 *
 * Kept for the case where the reader list is unavailable (an older Zotero, or a
 * host other than the reader). Secondary to `findReaderSelection`.
 */
export function findAnySelection(win: Window | null, depth = 0): Selection | null {
  if (!win || depth > 6) {
    return null;
  }
  try {
    const own = win.getSelection?.();
    if (own && own.rangeCount && String(own.toString() || "").trim()) {
      return own;
    }
  } catch {
    /* the window is not accessible */
  }

  try {
    const frames = win.frames;
    for (let i = 0; i < frames.length; i++) {
      let child: Window;
      try {
        child = frames[i] as Window;
        void child.document;
      } catch {
        continue;
      }
      const found = findAnySelection(child, depth + 1);
      if (found) {
        return found;
      }
    }
  } catch {
    /* frames unavailable */
  }
  return null;
}

/** Best available selection: reader first, frame walk second. */
export function locateSelection(win: Window | null): {
  selection: Selection | null;
  source: string;
} {
  const viaReader = findReaderSelection();
  if (viaReader.selection) {
    return { selection: viaReader.selection, source: viaReader.source };
  }
  const viaFrames = findAnySelection(win);
  return {
    selection: viaFrames,
    source: viaFrames ? "frame walk" : viaReader.source,
  };
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
export interface GeometryReport {
  ok: boolean;
  /** Which piece is missing, when not ok. */
  missing?: "selection" | "textLayer" | "canvas" | "rects";
  text: string;
}

/**
 * Describe the geometry without capturing.
 *
 * When a capture fails, "it did not work" is useless; what matters is *which*
 * lookup failed. The panel shows this directly, so a failure can be reported
 * without digging through the debug console.
 */
export function describeGeometry(selection: Selection | null): GeometryReport {
  try {
    if (!selection || !selection.rangeCount) {
      return { ok: false, missing: "selection", text: "没有选中内容" };
    }
    const range = selection.getRangeAt(0);
    const layer = findTextLayer(range.startContainer);
    const canvas = findPageCanvas(range.startContainer);
    const rects = range.getClientRects();
    const rectCount = rects ? rects.length : 0;

    const parts = [
      `textLayer=${layer ? "ok" : "缺失"}`,
      `canvas=${canvas ? `${canvas.width}x${canvas.height}` : "缺失"}`,
      layer
        ? `layerBox=${Math.round(layer.getBoundingClientRect().width)}x${Math.round(
            layer.getBoundingClientRect().height,
          )}`
        : "",
      `rects=${rectCount}`,
      layer && canvas
        ? `scale=${(canvas.width / Math.max(1, layer.getBoundingClientRect().width)).toFixed(2)}`
        : "",
    ].filter(Boolean);

    if (!layer) {
      return { ok: false, missing: "textLayer", text: parts.join(" ") };
    }
    if (!canvas) {
      return { ok: false, missing: "canvas", text: parts.join(" ") };
    }
    if (!rectCount) {
      return { ok: false, missing: "rects", text: parts.join(" ") };
    }
    return { ok: true, text: parts.join(" ") };
  } catch (e) {
    return { ok: false, text: `几何计算失败: ${(e as Error)?.message || e}` };
  }
}

/**
 * Approximate decoded size of a base64 PNG, in bytes./**
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

/* ------------------------------------------------------------------ */
/* Pending-capture stash                                               */
/* ------------------------------------------------------------------ */

/**
 * The most recent capture resolved while a selection was live.
 *
 * A single slot is enough: only one selection can be active at a time, and the
 * newest is always the relevant one. Keyed by item id so a change of paper
 * cannot reuse a stale region.
 */
let pendingCapture:
  | { itemID?: number; outcome: GeometryOutcome; at: number }
  | null = null;

export function stashPendingCapture(
  outcome: GeometryOutcome,
  itemID?: number,
): void {
  pendingCapture = { itemID, outcome, at: Date.now() };
  Zotero.debug(
    `[Highlight Ask] capture stashed: ${
      outcome.ok ? outcome.detail : `FAILED at ${outcome.step}: ${outcome.detail}`
    }`,
  );
}

/**
 * Retrieve the stashed outcome for this item.
 *
 * Returns the failure too, not just successes: the panel needs to say *why*
 * nothing was captured, and this is the only place that knows.
 */
export function takePendingOutcome(itemID?: number): GeometryOutcome | null {
  if (!pendingCapture) {
    return null;
  }
  if (
    itemID !== undefined &&
    pendingCapture.itemID !== undefined &&
    pendingCapture.itemID !== itemID
  ) {
    return null;
  }
  const { outcome } = pendingCapture;
  pendingCapture = null;
  return outcome;
}

/** Retrieve a stashed capture, or null if the stash holds a failure. */
export function takePendingCapture(itemID?: number): PendingCapture | null {
  const outcome = takePendingOutcome(itemID);
  return outcome && outcome.ok ? outcome : null;
}

export function hasPendingCapture(): boolean {
  return pendingCapture !== null;
}
