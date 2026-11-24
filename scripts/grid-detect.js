/**
 * Square-grid detection on a grayscale image (pure, no Foundry or DOM globals).
 *
 * A grid printed on a map is a set of thin lines that repeat with one period. Vision models are poor at measuring
 * that period to a fraction of a pixel, signal processing is good at it:
 *
 *   1. Line profiles: every pixel gets a "thin line" response (darker or lighter than both neighbours a few
 *      pixels away), which a grid line produces and the step edge of a wall or a shadow does not. The responses
 *      are summed along columns and rows, separately for a dozen bands of the image.
 *   2. Autocorrelation of the band profiles gives candidate periods in whole pixels.
 *   3. For a candidate period the bands are weighted by how periodic they are at it, so the part of a map where
 *      the grid is visible (often only the floor) decides and parchment, rock hatching and lettering stay out.
 *   4. A comb fit (mean of the profile at phase + k·period) refines period and phase to sub-pixel precision.
 *
 * All lengths are in pixels of the image passed in; the caller converts when it analysed a downscaled copy.
 */

/**
 * @typedef {{width: number, height: number, data: ArrayLike<number>}} GrayImage  row-major luma, 0..255
 */

const BANDS = 12;
/** Neighbour distances of the line response: covers lines up to about five pixels wide. */
const REACH = 3;

/**
 * Thin-line profiles per band.
 * @param {GrayImage} gray
 * @param {number} [bands]
 * @param {number} [cap]   per-pixel response clip, so one harsh mark cannot outvote a long faint line
 * @returns {{x: Float64Array[], y: Float64Array[]}}  x[b][column]: vertical lines seen in horizontal band b of the
 *          image; y[b][row]: horizontal lines seen in vertical band b
 */
export function bandProfiles({ width: w, height: h, data }, bands = BANDS, cap = 40) {
  const x = Array.from({ length: bands }, () => new Float64Array(w));
  const y = Array.from({ length: bands }, () => new Float64Array(h));
  for (let row = REACH; row < h - REACH; row++) {
    const px = x[Math.min(bands - 1, Math.floor((row * bands) / h))];
    const base = row * w;
    for (let col = REACH; col < w - REACH; col++) {
      const i = base + col;
      const c = data[i];
      let rv = 0; // vertical line through this pixel
      let rh = 0; // horizontal line through this pixel
      for (let d = 1; d <= REACH; d++) {
        const l = data[i - d];
        const r = data[i + d];
        const v = l < r ? Math.max(l - c, c - r) : Math.max(r - c, c - l);
        if (v > rv) rv = v;
        const u = data[i - d * w];
        const o = data[i + d * w];
        const g = u < o ? Math.max(u - c, c - o) : Math.max(o - c, c - u);
        if (g > rh) rh = g;
      }
      px[col] += rv > cap ? cap : rv;
      y[Math.min(bands - 1, Math.floor((col * bands) / w))][row] += rh > cap ? cap : rh;
    }
  }
  return { x, y };
}

/** Subtract a moving average (window 2·radius+1). */
function detrend(p, radius) {
  const n = p.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + p[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = p[i] - (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

/** Scale to zero mean and unit variance. */
function unitVariance(p) {
  const n = p.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += p[i];
  mean /= Math.max(1, n);
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (p[i] - mean) ** 2;
  const sd = Math.sqrt(sq / Math.max(1, n));
  const out = new Float64Array(n);
  if (sd > 1e-12) for (let i = 0; i < n; i++) out[i] = (p[i] - mean) / sd;
  return out;
}

/** Mean lagged product for lags 0..maxLag. */
function autocorrelation(p, maxLag) {
  const n = p.length;
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    let sum = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) sum += p[i] * p[i + lag];
    acf[lag] = sum / m;
  }
  return acf;
}

/** 3-tap box smoothing: gives a line some width, so a fractional period still lines up at integer lags. */
function smooth(p) {
  const n = p.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = p[i > 0 ? i - 1 : i];
    const c = p[i < n - 1 ? i + 1 : i];
    out[i] = (a + p[i] + c) / 3;
  }
  return out;
}

/** Mean of q sampled (linearly interpolated) at phase + k·period. */
function combScore(q, period, phase) {
  const n = q.length;
  let sum = 0;
  let count = 0;
  for (let pos = phase; pos < n - 1; pos += period) {
    if (pos < 0) continue;
    const i = Math.floor(pos);
    const f = pos - i;
    sum += q[i] * (1 - f) + q[i + 1] * f;
    count++;
  }
  return count ? sum / count : -Infinity;
}

/** Best phase for a fixed period: coarse scan of [0, period), then a fine scan around the best. */
function bestPhase(q, period) {
  let best = { phase: 0, score: -Infinity };
  for (let ph = 0; ph < period; ph += 0.5) {
    const score = combScore(q, period, ph);
    if (score > best.score) best = { phase: ph, score };
  }
  const centre = best.phase;
  for (let ph = centre - 0.6; ph <= centre + 0.6; ph += 0.05) {
    const phase = ((ph % period) + period) % period;
    const score = combScore(q, period, phase);
    if (score > best.score) best = { phase, score };
  }
  return best;
}

const teethOf = (n, period, phase) => Math.max(1, Math.floor((n - phase) / period));
/** The comb score is a mean of z-values over the teeth, so score·√teeth says how far from chance a fit is. */
const significance = (r) => r.score * Math.sqrt(r.teeth);

/**
 * Sub-pixel period and phase of one axis around a period estimate.
 * @param {Float64Array} profile  zero-mean, unit-variance profile
 * @param {number} t0             period estimate
 * @returns {{period: number, phase: number, score: number, teeth: number}}  score = mean z-value on the comb
 */
export function refineAxis(profile, t0) {
  const q = smooth(profile);
  const span = Math.max(1.5, t0 * 0.03);
  let best = { period: t0, phase: 0, score: -Infinity };
  const search = (tFrom, tTo, tStep, phaseFrom, phaseTo, phaseStep) => {
    for (let t = tFrom; t <= tTo + 1e-9; t += tStep) {
      for (let ph = phaseFrom; ph < phaseTo; ph += phaseStep) {
        // Phases outside [0, t) wrap around; the comb is the same set of teeth.
        const phase = ((ph % t) + t) % t;
        const score = combScore(q, t, phase);
        if (score > best.score) best = { period: t, phase, score };
      }
    }
  };
  search(Math.max(2, t0 - span), t0 + span, 0.02, 0, t0 + span, 0.5);
  const coarse = best;
  search(coarse.period - 0.03, coarse.period + 0.03, 0.002, coarse.phase - 0.6, coarse.phase + 0.6, 0.05);
  return { ...best, teeth: teethOf(q.length, best.period, best.phase) };
}

/**
 * One period for both axes. Printed grids are square, and on a faint grid the two axes fitted alone drift apart
 * by a fraction of a percent — enough to slide the far side of the map off by a third of a cell.
 * @returns {{rx, ry}|null}  null when a common period fits clearly worse than the separate ones (a scan that
 *          really is stretched)
 */
function refineSquare(px, py, rx, ry) {
  const mean = (rx.period + ry.period) / 2;
  if (Math.abs(rx.period - ry.period) / mean > 0.015) return null;
  const qx = smooth(px);
  const qy = smooth(py);
  const from = Math.min(rx.period, ry.period) - 0.02;
  const to = Math.max(rx.period, ry.period) + 0.02;
  // A step that moves the last tooth by a twentieth of a pixel.
  const step = Math.max(0.0005, (0.05 * mean) / Math.max(qx.length, qy.length));
  let best = null;
  for (let t = from; t <= to + 1e-9; t += step) {
    const bx = bestPhase(qx, t);
    const by = bestPhase(qy, t);
    const x = { period: t, ...bx, teeth: teethOf(qx.length, t, bx.phase) };
    const y = { period: t, ...by, teeth: teethOf(qy.length, t, by.phase) };
    const total = significance(x) + significance(y);
    if (!best || total > best.total) best = { rx: x, ry: y, total };
  }
  if (!best || best.total < 0.9 * (significance(rx) + significance(ry))) return null;
  return { rx: best.rx, ry: best.ry };
}

/** Local maxima of acf within [from, to], strongest first. */
function peaks(acf, from, to) {
  const out = [];
  for (let lag = Math.max(1, from); lag <= to && lag < acf.length - 1; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) out.push({ lag, value: acf[lag] });
  }
  return out.sort((a, b) => b.value - a.value);
}

/** Detrended band profiles with their autocorrelations. */
function prepareAxis(bands, radius, maxLag) {
  return bands.map((band) => {
    const raw = detrend(band, radius);
    return { raw, acf: autocorrelation(smooth(raw), maxLag) };
  });
}

/**
 * The profile of one axis for a candidate period: bands weighted by how periodic they are at that period.
 * A band without the grid correlates near zero there and drops out.
 */
function weightedProfile(axis, lag) {
  const n = axis[0].raw.length;
  const energy = Math.max(...axis.map((b) => b.acf[0]));
  const lo = Math.floor(lag);
  const hi = Math.min(axis[0].acf.length - 1, Math.ceil(lag));
  const out = new Float64Array(n);
  let used = 0;
  for (const band of axis) {
    if (!(band.acf[0] > energy * 1e-6)) continue;
    const w = Math.max(0, band.acf[lo], band.acf[hi]) / band.acf[0];
    if (!(w > 0)) continue;
    used += w;
    for (let i = 0; i < n; i++) out[i] += w * band.raw[i];
  }
  if (!used) for (const band of axis) for (let i = 0; i < n; i++) out[i] += band.raw[i];
  return unitVariance(out);
}

/**
 * @typedef GridDetection
 * @property {number} periodX   cell width in px
 * @property {number} periodY   cell height in px
 * @property {number} phaseX    x of the first vertical grid line, 0 <= phaseX < periodX
 * @property {number} phaseY    y of the first horizontal grid line
 * @property {number} strength  autocorrelation at the period, 0..1 (how periodic the image is)
 * @property {number} score     mean z-value of the line profile on the fitted grid lines
 * @property {number} z         significance of the weaker axis (score·√lines)
 * @property {"high"|"medium"|"low"} confidence
 * @property {number[]} candidates  other plausible periods (px), strongest first
 */

/**
 * Detect a square grid.
 * @param {GrayImage} gray
 * @param {object} [options]
 * @param {number} [options.minPeriod=8]
 * @param {number} [options.maxPeriod]   default: a third of the shorter image edge
 * @param {number} [options.hint]        expected period; restricts the search to 0.8×–1.25× of it
 * @returns {GridDetection|null}  null when the image is too small to hold three cells
 */
export function detectGrid(gray, { minPeriod = 8, maxPeriod, hint } = {}) {
  const { width: w, height: h } = gray;
  let lo = minPeriod;
  let hi = Math.floor(Math.min(maxPeriod ?? Infinity, Math.min(w, h) / 3));
  if (hint) {
    lo = Math.max(2, Math.floor(hint * 0.8));
    hi = Math.min(Math.floor(Math.min(w, h) / 2), Math.ceil(hint * 1.25));
  }
  if (!(hi > lo)) return null;

  const profiles = bandProfiles(gray);
  const ax = prepareAxis(profiles.x, hi, hi + 1);
  const ay = prepareAxis(profiles.y, hi, hi + 1);

  // Energy-weighted mean of the bands' autocorrelations; a band that anti-correlates at a lag counts as zero.
  const combined = new Float64Array(hi + 2);
  let energy = 0;
  for (const band of [...ax, ...ay]) energy += band.acf[0];
  if (!(energy > 0)) return null;
  for (let lag = 0; lag < combined.length; lag++) {
    let sum = 0;
    for (const band of [...ax, ...ay]) sum += Math.max(0, band.acf[lag]);
    combined[lag] = sum / energy;
  }

  const found = peaks(combined, lo, hi);
  if (!found.length) return null;

  // The strongest peaks may sit on multiples of the period (2T, 7T correlate as well as T does). Fit a comb at
  // the strongest peaks and at the divisors of the top one, and compare the fits by significance. A multiple kT
  // hits grid lines only but with 1/k of the teeth (√k less significant); T/2 has twice the teeth but half of
  // them between lines (√2 less significant). The true period comes out on top.
  const lags = [];
  const addLag = (lag) => {
    if (lag >= lo && lag <= hi && !lags.some((l) => Math.abs(l - lag) <= Math.max(1, lag * 0.02))) lags.push(lag);
  };
  for (const p of found.slice(0, 8)) addLag(p.lag);
  for (let k = 2; k <= 8; k++) addLag(found[0].lag / k);
  let fit = null;
  for (const lag of lags) {
    const px = weightedProfile(ax, lag);
    const py = weightedProfile(ay, lag);
    const rx = refineAxis(px, lag);
    const ry = refineAxis(py, lag);
    // Both axes must show the grid.
    const z = Math.min(significance(rx), significance(ry));
    if (!fit || z > fit.z) fit = { px, py, rx, ry, z };
  }

  const square = refineSquare(fit.px, fit.py, fit.rx, fit.ry);
  const rx = square?.rx ?? fit.rx;
  const ry = square?.ry ?? fit.ry;
  const z = Math.min(significance(rx), significance(ry));
  const period = (rx.period + ry.period) / 2;
  const strength = Math.max(0, Math.min(1, combined[Math.min(combined.length - 1, Math.round(period))]));
  const score = Math.min(rx.score, ry.score);
  // Measured on real maps: gridded ones reach a strength of 0.25 and more, pictures without a grid stay near
  // 0.01 whatever their z (few teeth make z easy to inflate), so strength gates and z grades.
  let confidence = "low";
  if (strength >= 0.25 && z >= 8) confidence = "high";
  else if (strength >= 0.15 && z >= 3) confidence = "medium";

  return {
    periodX: rx.period,
    periodY: ry.period,
    phaseX: rx.phase,
    phaseY: ry.phase,
    strength,
    score,
    z,
    confidence,
    candidates: found.slice(0, 5).map((p) => p.lag),
  };
}
