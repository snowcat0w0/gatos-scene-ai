/**
 * Square-grid detection on a grayscale image (pure, no Foundry or DOM globals).
 *
 * A grid printed on a map is a set of thin lines that repeat with one period over the whole image. Vision models
 * are poor at measuring that period to a fraction of a pixel, signal processing is good at it:
 *
 *   1. Edge profiles: for every column (row) the summed horizontal (vertical) gradient. Each gradient is clipped,
 *      so a faint line running the whole height outweighs a short, strong edge such as a wall.
 *   2. Autocorrelation of the detrended profiles gives the period in whole pixels.
 *   3. A comb fit (mean of the profile at phase + k·period) refines period and phase to sub-pixel precision.
 *
 * All lengths are in pixels of the image passed in; the caller converts when it analysed a downscaled copy.
 */

/**
 * @typedef {{width: number, height: number, data: ArrayLike<number>}} GrayImage  row-major luma, 0..255
 */

/**
 * Column and row edge profiles.
 * @param {GrayImage} gray
 * @param {number} [cap]  per-pixel gradient clip
 * @returns {{px: Float64Array, py: Float64Array}}
 */
export function edgeProfiles({ width: w, height: h, data }, cap = 40) {
  const px = new Float64Array(w);
  const py = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const d = Math.abs(data[row + x + 1] - data[row + x - 1]);
      px[x] += d > cap ? cap : d;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x < w; x++) {
      const d = Math.abs(data[row + w + x] - data[row - w + x]);
      sum += d > cap ? cap : d;
    }
    py[y] = sum;
  }
  return { px, py };
}

/** Subtract a moving average (window 2·radius+1) and scale to unit variance. */
export function standardize(p, radius) {
  const n = p.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + p[i];
  const out = new Float64Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = p[i] - (prefix[b] - prefix[a]) / (b - a);
    sq += out[i] * out[i];
  }
  const sd = Math.sqrt(sq / Math.max(1, n));
  if (sd > 1e-9) for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** Normalised autocorrelation of a standardized profile for lags 0..maxLag. */
export function autocorrelation(p, maxLag) {
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

/** 3-tap box smoothing: merges the two gradient peaks at either side of one grid line. */
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

/**
 * Sub-pixel period and phase of one axis around an integer period estimate.
 * @param {Float64Array} profile  standardized profile
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
  return { ...best, teeth: Math.floor((q.length - best.phase) / best.period) };
}

/** Local maxima of acf within [from, to], strongest first. */
function peaks(acf, from, to) {
  const out = [];
  for (let lag = Math.max(1, from); lag <= to && lag < acf.length - 1; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) out.push({ lag, value: acf[lag] });
  }
  return out.sort((a, b) => b.value - a.value);
}

/**
 * @typedef GridDetection
 * @property {number} periodX   cell width in px
 * @property {number} periodY   cell height in px
 * @property {number} phaseX    x of the first vertical grid line, 0 <= phaseX < periodX
 * @property {number} phaseY    y of the first horizontal grid line
 * @property {number} strength  autocorrelation at the period, 0..1 (how periodic the image is)
 * @property {number} score     mean z-value of the edge profile on the fitted grid lines
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

  const { px, py } = edgeProfiles(gray);
  const sx = standardize(px, hi);
  const sy = standardize(py, hi);
  // Smoothed copies for the autocorrelation: a period of 70.4 px puts lines 70 and 71 px apart in turn, and
  // without some width neither integer lag lines them up.
  const ax = autocorrelation(smooth(sx), hi + 1);
  const ay = autocorrelation(smooth(sy), hi + 1);
  const combined = new Float64Array(hi + 2);
  for (let i = 0; i < combined.length; i++) combined[i] = (ax[i] + ay[i]) / 2;

  const found = peaks(combined, lo, hi);
  if (!found.length) return null;

  // The strongest peaks may sit on multiples of the period (2T, 7T correlate as well as T does). Fit a comb at
  // the strongest peaks and at the divisors of the top one, and compare the fits by significance: the comb score
  // is a mean of z-values over the teeth, so score·√teeth measures how far from chance a fit is. A multiple kT
  // hits grid lines only but with 1/k of the teeth (√k less significant); T/2 has twice the teeth but half of
  // them between lines (√2 less significant). The true period comes out on top.
  const lags = [];
  const addLag = (lag) => {
    if (lag >= lo && lag <= hi && !lags.some((l) => Math.abs(l - lag) <= Math.max(1, lag * 0.02))) lags.push(lag);
  };
  for (const p of found.slice(0, 8)) addLag(p.lag);
  for (let k = 2; k <= 8; k++) addLag(found[0].lag / k);
  const significance = (r) => r.score * Math.sqrt(Math.max(1, r.teeth));
  let fit = null;
  for (const lag of lags) {
    const rx = refineAxis(sx, lag);
    const ry = refineAxis(sy, lag);
    // Both axes must show the grid.
    const z = Math.min(significance(rx), significance(ry));
    if (!fit || z > fit.z) fit = { rx, ry, z };
  }
  const { rx, ry, z } = fit;
  const period = (rx.period + ry.period) / 2;
  const strength = Math.max(0, Math.min(1, combined[Math.min(combined.length - 1, Math.round(period))]));
  const score = Math.min(rx.score, ry.score);
  let confidence = "low";
  if (strength >= 0.2 && z >= 8) confidence = "high";
  else if (strength >= 0.1 && z >= 4.5) confidence = "medium";

  return {
    periodX: rx.period,
    periodY: ry.period,
    phaseX: rx.phase,
    phaseY: ry.phase,
    strength,
    score,
    confidence,
    candidates: found.slice(0, 5).map((p) => p.lag),
  };
}

/**
 * Re-fit the phase for a period given from outside (a model said "the real cell is twice as large").
 * @param {GrayImage} gray
 * @param {number} period
 * @returns {GridDetection|null}
 */
export function detectGridNear(gray, period) {
  return detectGrid(gray, { hint: period });
}
