/**
 * Image access: load a scene background, turn it into grayscale for grid detection, and render the pictures
 * sent to the model (whole-map overview, tiles with the numbered coordinate overlay, grid check crop).
 * Browser only (canvas 2D); no Foundry documents are touched here.
 */

const VIDEO_RE = /\.(webm|mp4|m4v|ogv)(\?.*)?$/i;

export class ImageError extends Error {
  /** @param {"load"|"tainted"} kind */
  constructor(kind, message) {
    super(message);
    this.name = "ImageError";
    this.kind = kind;
  }
}

/** Resolve a Foundry data path against the route prefix; absolute URLs pass through. */
function resolveUrl(src) {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  return globalThis.foundry?.utils?.getRoute ? foundry.utils.getRoute(src) : src;
}

/**
 * Load an image or the first frame of a video.
 * @param {string} src
 * @returns {Promise<{el: CanvasImageSource, width: number, height: number, src: string}>}
 */
export async function loadSource(src) {
  const url = resolveUrl(src);
  if (VIDEO_RE.test(src)) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    await new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener("error", () => reject(new ImageError("load", `cannot load ${src}`)), { once: true });
    });
    return { el: video, width: video.videoWidth, height: video.videoHeight, src };
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  // load/error events rather than img.decode(): decode() waits for the rendering pipeline and never settles while
  // the Foundry tab is in the background, which is exactly where a GM leaves it during a long analysis.
  await new Promise((resolve, reject) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", () => reject(new ImageError("load", `cannot load ${src}`)), { once: true });
    img.src = url;
  });
  if (!img.naturalWidth || !img.naturalHeight) throw new ImageError("load", `cannot load ${src}`);
  return { el: img, width: img.naturalWidth, height: img.naturalHeight, src };
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

/** JPEG as { mime, base64, width, height }. A cross-origin image without CORS headers taints the canvas. */
function encode(canvas, quality = 0.9) {
  let url;
  try {
    url = canvas.toDataURL("image/jpeg", quality);
  } catch {
    throw new ImageError("tainted", "the image is served from another site without CORS headers");
  }
  return { mime: "image/jpeg", base64: url.slice(url.indexOf(",") + 1), width: canvas.width, height: canvas.height };
}

/**
 * Grayscale copy for grid detection, at most `maxEdge` px on the long side.
 * @returns {{width, height, data: Float32Array, scaleX: number, scaleY: number}}  scale = gray px per image px
 */
export function toGray(source, maxEdge = 2048) {
  const f = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const { canvas, ctx } = makeCanvas(source.width * f, source.height * f);
  ctx.drawImage(source.el, 0, 0, canvas.width, canvas.height);
  let rgba;
  try {
    rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    throw new ImageError("tainted", "the image is served from another site without CORS headers");
  }
  const data = new Float32Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return {
    width: canvas.width,
    height: canvas.height,
    data,
    scaleX: canvas.width / source.width,
    scaleY: canvas.height / source.height,
  };
}

/** The whole map, scaled down, without overlay. */
export function renderOverview(source, maxEdge = 1024) {
  const f = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const { canvas, ctx } = makeCanvas(source.width * f, source.height * f);
  ctx.drawImage(source.el, 0, 0, canvas.width, canvas.height);
  return encode(canvas, 0.85);
}

const OVERLAY = "rgba(255, 0, 255, 0.6)";
const BAND = "#16161a";
const OUTSIDE = "#2a2a30";

/**
 * A section of the map with a cols × rows overlay grid.
 * @param {object} source                    from loadSource
 * @param {object} p
 * @param {{x, y, w, h}} p.rect              section in image pixels; may reach beyond the image (scene padding)
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.maxEdge                 longest edge of the result in px
 * @param {boolean} [p.labels=true]          numbered bands around the map
 * @param {number} [p.lineWidth=1]
 * @param {number[]} [p.dash]                 dash pattern; gaps let the map's own lines show through
 * @returns {{mime, base64, width, height}}
 */
export function renderTile(source, { rect, cols, rows, maxEdge, labels = true, lineWidth = 1, dash = null }) {
  // The label band scales with the cell size, so solve for the cell size that makes map + two bands fit.
  const bandFor = (ppc) => (labels ? Math.round(Math.max(18, Math.min(34, ppc * 0.4))) : 0);
  let ppc = Math.floor(maxEdge / Math.max(cols, rows));
  while (ppc > 16 && Math.max(cols, rows) * ppc + 2 * bandFor(ppc) > maxEdge) ppc--;
  const band = bandFor(ppc);
  const mapW = cols * ppc;
  const mapH = rows * ppc;
  const { canvas, ctx } = makeCanvas(mapW + 2 * band, mapH + 2 * band);

  ctx.fillStyle = BAND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(band, band, mapW, mapH);

  // Only the part of the section that lies on the image can be drawn.
  const sx0 = Math.max(0, rect.x);
  const sy0 = Math.max(0, rect.y);
  const sx1 = Math.min(source.width, rect.x + rect.w);
  const sy1 = Math.min(source.height, rect.y + rect.h);
  if (sx1 > sx0 && sy1 > sy0) {
    const kx = mapW / rect.w;
    const ky = mapH / rect.h;
    ctx.drawImage(
      source.el,
      sx0,
      sy0,
      sx1 - sx0,
      sy1 - sy0,
      band + (sx0 - rect.x) * kx,
      band + (sy0 - rect.y) * ky,
      (sx1 - sx0) * kx,
      (sy1 - sy0) * ky,
    );
  }

  ctx.strokeStyle = OVERLAY;
  ctx.lineWidth = lineWidth;
  if (dash) ctx.setLineDash(dash);
  const half = lineWidth % 2 ? 0.5 : 0;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = band + Math.min(mapW - 1, i * ppc) + half;
    ctx.moveTo(x, band);
    ctx.lineTo(x, band + mapH);
  }
  for (let j = 0; j <= rows; j++) {
    const y = band + Math.min(mapH - 1, j * ppc) + half;
    ctx.moveTo(band, y);
    ctx.lineTo(band + mapW, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  if (labels) {
    const size = Math.round(Math.max(11, Math.min(18, band * 0.62)));
    ctx.font = `bold ${size}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Skip labels that would overlap when cells are small.
    const every = Math.max(1, Math.ceil((size * 1.9) / ppc));
    for (let i = 0; i <= cols; i += every) {
      const x = band + i * ppc;
      ctx.fillText(String(i), x, band / 2);
      ctx.fillText(String(i), x, band + mapH + band / 2);
    }
    for (let j = 0; j <= rows; j += every) {
      const y = band + j * ppc;
      ctx.fillText(String(j), band / 2, y);
      ctx.fillText(String(j), band + mapW + band / 2, y);
    }
  }
  return encode(canvas, 0.9);
}

/**
 * Crop for the grid check: `cells` × `cells` detected cells with the detected grid drawn on top, taken from the
 * busiest of a few candidate spots (a blank border tells the model nothing).
 * @param {object} source
 * @param {{periodX, periodY, phaseX, phaseY}} det   in image pixels
 * @param {object} gray                              from toGray, used to pick the spot
 * @param {object} [p]
 * @returns {{mime, base64, width, height, cells: number}}
 */
export function renderGridCheck(source, det, gray, { cells = 8, maxEdge = 768 } = {}) {
  const across = Math.max(2, Math.min(cells, Math.floor(source.width / det.periodX) - 1));
  const down = Math.max(2, Math.min(cells, Math.floor(source.height / det.periodY) - 1));
  const kxMax = Math.max(0, Math.floor((source.width - det.phaseX) / det.periodX) - across);
  const kyMax = Math.max(0, Math.floor((source.height - det.phaseY) / det.periodY) - down);

  const variance = (kx, ky) => {
    const x0 = Math.floor((det.phaseX + kx * det.periodX) * gray.scaleX);
    const y0 = Math.floor((det.phaseY + ky * det.periodY) * gray.scaleY);
    const x1 = Math.min(gray.width, Math.ceil(x0 + across * det.periodX * gray.scaleX));
    const y1 = Math.min(gray.height, Math.ceil(y0 + down * det.periodY * gray.scaleY));
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const v = gray.data[y * gray.width + x];
        n++;
        sum += v;
        sq += v * v;
      }
    }
    return n ? sq / n - (sum / n) ** 2 : 0;
  };

  let best = { kx: Math.floor(kxMax / 2), ky: Math.floor(kyMax / 2), v: -1 };
  for (const fy of [0.5, 0.25, 0.75]) {
    for (const fx of [0.5, 0.25, 0.75]) {
      const kx = Math.round(kxMax * fx);
      const ky = Math.round(kyMax * fy);
      const v = variance(kx, ky);
      if (v > best.v) best = { kx, ky, v };
    }
  }

  const rect = {
    x: det.phaseX + best.kx * det.periodX,
    y: det.phaseY + best.ky * det.periodY,
    w: across * det.periodX,
    h: down * det.periodY,
  };
  // Dashed: a solid overlay that sits exactly on the map's grid lines would hide the very lines to compare with.
  const out = renderTile(source, { rect, cols: across, rows: down, maxEdge, labels: false, lineWidth: 2, dash: [7, 9] });
  return { ...out, cells: across };
}

/** A white picture with one red square, for the connection test. */
export function renderProbe() {
  const { canvas, ctx } = makeCanvas(96, 96);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = "#e01010";
  ctx.fillRect(24, 24, 48, 48);
  return encode(canvas, 0.92);
}
