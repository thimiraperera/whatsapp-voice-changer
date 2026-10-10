/*
 * DSP core: pitch and formant shifting, robot and whisper textures, noise gate and crushers.
 *
 * Self-contained and stringifiable: everything lives inside wvcDefineDSP(scope), which references
 * nothing outside itself. voice-engine.js builds an AudioWorklet module from
 * '(' + wvcDefineDSP.toString() + ')(globalThis);', so no helper may live outside the function.
 *
 * Installs scope.WVCDSP = { VoiceCore, FFT, SpectralShifter, GranularShifter, PROCESSOR_NAME } and,
 * inside an AudioWorkletGlobalScope, registers the 'wvc-voice-core' processor.
 */
function wvcDefineDSP(scope) {
  'use strict';

  const PROCESSOR_NAME = 'wvc-voice-core';
  const TWO_PI = Math.PI * 2;

  const DEFAULTS = Object.freeze({
    pitch: 0,
    formant: 0,
    algorithm: 'spectral',
    texture: 'normal',
    robotPitch: 110,
    gate: -90,
    bitDepth: 16,
    downsample: 1,
  });
  const LIMITS = Object.freeze({
    pitch: [-24, 24],
    formant: [-12, 12],
    robotPitch: [40, 400],
    gate: [-90, -20],
    bitDepth: [2, 16],
    downsample: [1, 32],
  });
  const ALGORITHMS = ['spectral', 'granular'];
  const TEXTURES = ['normal', 'robot', 'whisper'];

  const PATH_NONE = -1;
  const PATH_BYPASS = 0;
  const PATH_SPECTRAL = 1;
  const PATH_GRANULAR = 2;

  const TEX_NORMAL = 0;
  const TEX_ROBOT = 1;
  const TEX_WHISPER = 2;

  const CHUNK = 1024;

  function sanitizeRate(sr) {
    const n = Number(sr);
    return Number.isFinite(n) && n >= 3000 && n <= 768000 ? n : 48000;
  }

  function clampNum(v, lo, hi, fallback) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function wrapPhase(p) {
    // Principal argument in (-pi, pi].
    return p - TWO_PI * Math.round(p / TWO_PI);
  }

  /* ------------------------------------------------------------------ *
   * FFT: real-signal transforms of size n via one complex FFT of size n/2.
   * realForward: n real samples -> n/2+1 complex bins (unnormalised DFT).
   * realInverse: n/2+1 bins (Hermitian spectrum) -> n real samples (exact inverse of realForward).
   * ------------------------------------------------------------------ */
  class FFT {
    constructor(size) {
      const n = Math.floor(Number(size));
      if (!(n >= 4) || (n & (n - 1)) !== 0) throw new RangeError('FFT size must be a power of two >= 4');
      this.size = n;
      const m = n >> 1;
      this._m = m;
      this._rev = new Uint32Array(m);
      let bits = 0;
      while (1 << bits < m) bits++;
      for (let i = 0; i < m; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        this._rev[i] = r;
      }
      const tw = Math.max(1, m >> 1);
      this._cos = new Float64Array(tw);
      this._sin = new Float64Array(tw);
      for (let k = 0; k < tw; k++) {
        this._cos[k] = Math.cos((TWO_PI * k) / m);
        this._sin[k] = Math.sin((TWO_PI * k) / m);
      }
      this._pc = new Float64Array(m + 1);
      this._ps = new Float64Array(m + 1);
      for (let k = 0; k <= m; k++) {
        this._pc[k] = Math.cos((TWO_PI * k) / n);
        this._ps[k] = Math.sin((TWO_PI * k) / n);
      }
      this._zr = new Float64Array(m);
      this._zi = new Float64Array(m);
    }

    /** In-place complex FFT of length n/2 (internal). inverse => conjugate twiddles, no scaling. */
    _complex(re, im, inverse) {
      const m = this._m;
      const rev = this._rev;
      for (let i = 0; i < m; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      const cs = this._cos;
      const sn = this._sin;
      const sgn = inverse ? 1 : -1;
      for (let len = 2; len <= m; len <<= 1) {
        const half = len >> 1;
        const step = (m / len) | 0;
        for (let i = 0; i < m; i += len) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const wr = cs[k];
            const wi = sgn * sn[k];
            const a = i + j;
            const b = a + half;
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr;
            im[b] = im[a] - xi;
            re[a] += xr;
            im[a] += xi;
          }
        }
      }
    }

    realForward(input, outRe, outIm) {
      const m = this._m;
      const zr = this._zr;
      const zi = this._zi;
      for (let j = 0; j < m; j++) {
        zr[j] = input[2 * j];
        zi[j] = input[2 * j + 1];
      }
      this._complex(zr, zi, false);
      const pc = this._pc;
      const ps = this._ps;
      for (let k = 0; k <= m; k++) {
        const k1 = k === m ? 0 : k;
        const k2 = k === 0 ? 0 : m - k;
        const Zr = zr[k1];
        const Zi = zi[k1];
        const Cr = zr[k2];
        const Ci = -zi[k2];
        const Er = 0.5 * (Zr + Cr);
        const Ei = 0.5 * (Zi + Ci);
        const Or = 0.5 * (Zi - Ci);
        const Oi = -0.5 * (Zr - Cr);
        const wr = pc[k];
        const wi = -ps[k];
        outRe[k] = Er + wr * Or - wi * Oi;
        outIm[k] = Ei + wr * Oi + wi * Or;
      }
    }

    realInverse(inRe, inIm, output) {
      const m = this._m;
      const zr = this._zr;
      const zi = this._zi;
      const pc = this._pc;
      const ps = this._ps;
      for (let k = 0; k < m; k++) {
        const Xr = inRe[k];
        const Xi = k === 0 ? 0 : inIm[k];
        const Cr = inRe[m - k];
        const Ci = m - k === m ? 0 : -inIm[m - k];
        const Er = 0.5 * (Xr + Cr);
        const Ei = 0.5 * (Xi + Ci);
        const Dr = 0.5 * (Xr - Cr);
        const Di = 0.5 * (Xi - Ci);
        const wr = pc[k];
        const wi = ps[k];
        const Or = Dr * wr - Di * wi;
        const Oi = Dr * wi + Di * wr;
        zr[k] = Er - Oi;
        zi[k] = Ei + Or;
      }
      this._complex(zr, zi, true);
      const s = 1 / m;
      for (let j = 0; j < m; j++) {
        output[2 * j] = zr[j] * s;
        output[2 * j + 1] = zi[j] * s;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * SpectralShifter: STFT phase vocoder with cepstral envelope.
   * Constant latency = fftSize - 1 samples.
   * ------------------------------------------------------------------ */
  class SpectralShifter {
    constructor(sampleRate) {
      const sr = sanitizeRate(sampleRate);
      this.sampleRate = sr;
      const N = sr <= 50000 ? 1024 : 2048;
      const H = N >> 2;
      const K = (N >> 1) + 1;
      this.fftSize = N;
      this.hopSize = H;
      this.latencySamples = N - 1;
      this._N = N;
      this._H = H;
      this._K = K;
      this._fft = new FFT(N);

      this._wa = new Float64Array(N);
      this._ws = new Float64Array(N);
      for (let n = 0; n < N; n++) {
        const w = 0.5 - 0.5 * Math.cos((TWO_PI * n) / N);
        this._wa[n] = w;
        this._ws[n] = w;
      }
      // Overlap-add normalisation, computed numerically.
      let olaSum = 0;
      for (let n = 0; n < H; n++) {
        let s = 0;
        for (let k = n; k < N; k += H) s += this._wa[k] * this._ws[k];
        olaSum += s;
      }
      const ola = olaSum / H;
      this._olaScale = 1 / ola;
      let sumWa2 = 0;
      let sumWs2 = 0;
      for (let n = 0; n < N; n++) {
        sumWa2 += this._wa[n] * this._wa[n];
        sumWs2 += this._ws[n] * this._ws[n];
      }
      this._sumWa2 = sumWa2;
      // Random-phase frames add incoherently: this gain restores input power after OLA.
      this._whisperGain = ola / Math.sqrt((sumWa2 / N) * (sumWs2 / H));

      // Cepstral lifter: pass quefrencies < 1.5 ms, raised-cosine taper up to 2.5 ms.
      const Q = Math.max(4, Math.round(sr * 0.0015));
      const Q2 = Math.min(N >> 1, Math.max(Q + 2, Math.round(sr * 0.0025)));
      this._lifter = new Float64Array(N);
      for (let n = 0; n < N; n++) {
        const q = n <= N >> 1 ? n : N - n;
        let l;
        if (q < Q) l = 1;
        else if (q >= Q2) l = 0;
        else l = 0.5 + 0.5 * Math.cos((Math.PI * (q - Q)) / (Q2 - Q));
        this._lifter[n] = l;
      }

      this._inFifo = new Float64Array(N);
      this._outAcc = new Float64Array(N);
      this._outFifo = new Float64Array(H);
      this._frame = new Float64Array(N);
      this._re = new Float64Array(K);
      this._im = new Float64Array(K);
      this._re2 = new Float64Array(K);
      this._im2 = new Float64Array(K);
      this._mag = new Float64Array(K);
      this._anaRe = new Float64Array(K);
      this._anaIm = new Float64Array(K);
      this._prevRe = new Float64Array(K);
      this._prevIm = new Float64Array(K);
      this._env = new Float64Array(K);
      this._exc = new Float64Array(K);
      this._envShift = new Float64Array(K);
      this._mOut = new Float64Array(K);
      this._src = new Int32Array(K);
      this._phiOut = new Float64Array(K);
      this._peaks = new Int32Array(K);
      this._grain = new Float64Array(N);
      this._robotRing = new Float64Array(N);

      this._pitchRatio = 1;
      this._formantRatio = 1;
      this._texture = TEX_NORMAL;
      this._robotPeriod = sr / DEFAULTS.robotPitch;
      this._rng = 0x9e3779b9;
      this.reset();
    }

    reset() {
      this._inFifo.fill(0);
      this._outAcc.fill(0);
      this._outFifo.fill(0);
      this._prevRe.fill(0);
      this._prevIm.fill(0);
      this._phiOut.fill(0);
      this._grain.fill(0);
      this._robotRing.fill(0);
      this._pos = this._N - this._H;
      this._outRead = 1;
      this._robotRead = 0;
      this._robotCounter = 0;
      this._grainReady = false;
      this._rng = 0x9e3779b9;
    }

    setPitch(semitones) {
      const st = clampNum(semitones, -24, 24, 0);
      this._pitchRatio = Math.pow(2, st / 12);
    }

    setFormant(semitones) {
      const st = clampNum(semitones, -24, 24, 0);
      this._formantRatio = Math.pow(2, st / 12);
    }

    setTexture(texture) {
      this._texture = texture === 'robot' || texture === TEX_ROBOT ? TEX_ROBOT
        : texture === 'whisper' || texture === TEX_WHISPER ? TEX_WHISPER : TEX_NORMAL;
    }

    setRobotPitch(hz) {
      this._robotPeriod = this.sampleRate / clampNum(hz, 20, 2000, DEFAULTS.robotPitch);
    }

    process(input, output, offset, length) {
      const off = offset | 0;
      const end = off + (length === undefined ? input.length - off : length | 0);
      const N = this._N;
      const H = this._H;
      const inFifo = this._inFifo;
      const outFifo = this._outFifo;
      const ring = this._robotRing;
      const mask = N - 1;
      const robot = this._texture === TEX_ROBOT;
      for (let i = off; i < end; i++) {
        inFifo[this._pos++] = input[i];
        if (this._pos >= N) {
          this._processFrame();
          this._pos = N - H;
          this._outRead = 0;
        }
        let y;
        if (robot) {
          const r = this._robotRead;
          y = ring[r];
          ring[r] = 0;
          this._robotRead = (r + 1) & mask;
          this._robotCounter += 1;
          if (this._robotCounter >= this._robotPeriod) {
            this._robotCounter -= this._robotPeriod;
            if (this._grainReady) this._addGrain(this._robotRead);
          }
        } else {
          y = outFifo[this._outRead];
        }
        if (this._outRead < H - 1) this._outRead++;
        output[i] = y;
      }
    }

    _addGrain(start) {
      const N = this._N;
      const mask = N - 1;
      const ring = this._robotRing;
      const g = this._grain;
      for (let n = 0; n < N; n++) ring[(start + n) & mask] += g[n];
    }

    _rand() {
      // xorshift32 -> [0, 1)
      let x = this._rng | 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this._rng = x;
      return (x >>> 0) / 4294967296;
    }

    _processFrame() {
      const N = this._N;
      const H = this._H;
      const K = this._K;
      const fft = this._fft;
      const wa = this._wa;
      const frame = this._frame;
      const inFifo = this._inFifo;
      const re = this._re;
      const im = this._im;
      const mag = this._mag;
      const anaRe = this._anaRe;
      const anaIm = this._anaIm;
      const env = this._env;
      const envShift = this._envShift;
      const tex = this._texture;

      let inEnergy = 0;
      for (let n = 0; n < N; n++) {
        const v = inFifo[n] * wa[n];
        frame[n] = v;
        inEnergy += v * v;
      }
      fft.realForward(frame, re, im);

      // Phases are derived lazily (only around peaks) from the current and previous complex spectra.
      let magEnergy = 0;
      for (let k = 0; k < K; k++) {
        const a = re[k];
        const b = im[k];
        anaRe[k] = a;
        anaIm[k] = b;
        const p = a * a + b * b;
        mag[k] = Math.sqrt(p);
        magEnergy += p;
      }

      // Spectral envelope by cepstral liftering of the log magnitude.
      const re2 = this._re2;
      const im2 = this._im2;
      // A +/-1 bin max filter first fills the valleys between (barely resolved) harmonics, so the
      // envelope follows the harmonic peaks instead of their log-mean (approximate true envelope).
      // Below the first significant peak (~f0) the envelope is held flat at that peak's level, so
      // the empty region under f0 does not drag the envelope (and inflate the excitation) there.
      let magMax = 0;
      for (let k = 0; k < K; k++) if (mag[k] > magMax) magMax = mag[k];
      let lowFill = 0;
      const kLimit = K >> 3;
      for (let k = 1; k < kLimit; k++) {
        const m = mag[k];
        if (m > magMax * 0.01 && m >= mag[k - 1] && m >= mag[k + 1]) {
          for (let j = 0; j < k; j++) re2[j] = m;
          lowFill = k;
          break;
        }
      }
      for (let k = 0; k < K; k++) {
        let m = mag[k];
        if (k > 0 && mag[k - 1] > m) m = mag[k - 1];
        if (k < K - 1 && mag[k + 1] > m) m = mag[k + 1];
        if (k < lowFill && re2[k] > m) m = re2[k];
        re2[k] = Math.log(m + 1e-9);
        im2[k] = 0;
      }
      fft.realInverse(re2, im2, frame);
      const lifter = this._lifter;
      for (let n = 0; n < N; n++) frame[n] *= lifter[n];
      fft.realForward(frame, re2, im2);
      let envMax = 0;
      for (let k = 0; k < K; k++) {
        const e = Math.exp(re2[k]);
        env[k] = e;
        if (e > envMax) envMax = e;
      }
      const envFloor = envMax * 1e-3 + 1e-12;

      // Envelope sampled at j / formantRatio.
      const invF = 1 / this._formantRatio;
      let envShiftEnergy = 0;
      for (let j = 0; j < K; j++) {
        const s = j * invF;
        let e = 0;
        if (s < K - 1) {
          const k0 = s | 0;
          const f = s - k0;
          e = env[k0] + f * (env[k0 + 1] - env[k0]);
        } else if (s === K - 1) {
          e = env[K - 1];
        }
        envShift[j] = e;
        envShiftEnergy += e * e;
      }

      if (tex === TEX_ROBOT) {
        this._makeGrain(inEnergy);
      } else {
        if (tex === TEX_WHISPER) this._whisperSpectrum(magEnergy, envShiftEnergy);
        else this._shiftSpectrum(envFloor);
        fft.realInverse(re, im, frame);
        const ws = this._ws;
        const acc = this._outAcc;
        const sc = this._olaScale;
        for (let n = 0; n < N; n++) acc[n] += frame[n] * ws[n] * sc;
      }

      this._prevRe.set(anaRe);
      this._prevIm.set(anaIm);
      const acc = this._outAcc;
      const outFifo = this._outFifo;
      for (let n = 0; n < H; n++) outFifo[n] = acc[n];
      acc.copyWithin(0, H);
      acc.fill(0, N - H);
      inFifo.copyWithin(0, H);
    }

    _shiftSpectrum(envFloor) {
      const K = this._K;
      const mag = this._mag;
      const env = this._env;
      const exc = this._exc;
      const envShift = this._envShift;
      const mOut = this._mOut;
      const srcPeaks = this._src;
      const aRe = this._anaRe;
      const aIm = this._anaIm;
      const pRe = this._prevRe;
      const pIm = this._prevIm;
      const expectStep = (TWO_PI * this._H) / this._N;
      const phiOut = this._phiOut;
      const peaks = this._peaks;
      const re = this._re;
      const im = this._im;
      const r = this._pitchRatio;
      const invR = 1 / r;

      let magMax = 0;
      for (let k = 0; k < K; k++) {
        const e = env[k];
        const m = mag[k];
        exc[k] = m / (e > envFloor ? e : envFloor);
        if (m > magMax) magMax = m;
      }
      // Inverse mapping: output bin j reads the excitation at j / r (no gaps on up-shifts).
      for (let j = 0; j < K; j++) {
        const s = j * invR;
        let e = 0;
        if (s < K - 1) {
          const k0 = s | 0;
          e = exc[k0] + (s - k0) * (exc[k0 + 1] - exc[k0]);
        } else if (s === K - 1) {
          e = exc[K - 1];
        }
        mOut[j] = e * envShift[j];
      }

      // Peaks are picked on the analysis spectrum and mapped to output bins, so valleys between
      // (barely resolved) harmonics never become peaks with a blended frequency.
      let np = 0;
      const thr = magMax * 1e-6;
      let lastOut = -1;
      for (let k = 1; k < K - 1; k++) {
        const m = mag[k];
        if (m <= thr || m <= mag[k - 1] || m < mag[k + 1]) continue;
        const j = Math.round(k * r);
        if (j >= K) break;
        if (j === lastOut) {
          // Two analysis peaks collapsed onto one output bin (down-shift): keep the stronger.
          if (m > mag[srcPeaks[np - 1]]) srcPeaks[np - 1] = k;
          continue;
        }
        peaks[np] = j;
        srcPeaks[np] = k;
        np++;
        lastOut = j;
      }
      if (np === 0) {
        for (let j = 0; j < K; j++) {
          re[j] = 0;
          im[j] = 0;
          phiOut[j] = 0;
        }
        return;
      }

      // Identity phase locking (Laroche-Dolson): each peak advances by its scaled instantaneous
      // frequency; the bins of its region keep the analysis phase pattern at the same bin offset
      // from the peak (the +/-pi alternation across a lobe encodes the frame's time centre).
      let regionStart = 0;
      for (let p = 0; p < np; p++) {
        const pk = peaks[p];
        const sp = srcPeaks[p];
        const regionEnd = p + 1 < np ? (pk + peaks[p + 1] + 1) >> 1 : K;
        const xr = aRe[sp];
        const xi = aIm[sp];
        // True instantaneous frequency (rad/hop) from the phase advance since the previous frame.
        const expected = sp * expectStep;
        const dPhi = Math.atan2(xi * pRe[sp] - xr * pIm[sp], xr * pRe[sp] + xi * pIm[sp]);
        const omega = expected + wrapPhase(dPhi - expected);
        const phiP = wrapPhase(phiOut[pk] + r * omega);
        const cP = Math.cos(phiP);
        const sP = Math.sin(phiP);
        const shift = sp - pk;
        for (let j = regionStart; j < regionEnd; j++) {
          const d = j - pk;
          const m = mOut[j];
          if (d === 0) {
            phiOut[j] = phiP;
            re[j] = m * cP;
            im[j] = m * sP;
          } else if (d === 1 || d === -1) {
            let sk = j + shift;
            if (sk < 0) sk = 0;
            else if (sk > K - 1) sk = K - 1;
            // Rotate by the analysis phase of bin sk relative to the source peak: arg(X[sk] * conj(X[sp])).
            const ur = aRe[sk] * xr + aIm[sk] * xi;
            const ui = aIm[sk] * xr - aRe[sk] * xi;
            const ul = Math.sqrt(ur * ur + ui * ui);
            if (ul > 0) {
              const cr = ur / ul;
              const ci = ui / ul;
              phiOut[j] = wrapPhase(phiP + Math.atan2(ci, cr));
              re[j] = m * (cP * cr - sP * ci);
              im[j] = m * (sP * cr + cP * ci);
            } else {
              phiOut[j] = wrapPhase(phiP + Math.PI);
              re[j] = -m * cP;
              im[j] = -m * sP;
            }
          } else if (d & 1) {
            // Further out the analysis bin may belong to a neighbouring harmonic; use the ideal
            // pattern of a stationary sinusoid in a centred window (alternating by pi).
            phiOut[j] = wrapPhase(phiP + Math.PI);
            re[j] = -m * cP;
            im[j] = -m * sP;
          } else {
            phiOut[j] = phiP;
            re[j] = m * cP;
            im[j] = m * sP;
          }
        }
        regionStart = regionEnd;
      }
      im[0] = 0;
      im[K - 1] = 0;
    }

    _whisperSpectrum(magEnergy, envShiftEnergy) {
      const K = this._K;
      const envShift = this._envShift;
      const re = this._re;
      const im = this._im;
      const scale = envShiftEnergy > 1e-30 ? Math.sqrt(magEnergy / envShiftEnergy) * this._whisperGain : 0;
      for (let j = 0; j < K; j++) {
        const m = envShift[j] * scale;
        const ph = this._rand() * TWO_PI;
        re[j] = m * Math.cos(ph);
        im[j] = m * Math.sin(ph);
      }
      im[0] = 0;
      im[K - 1] = 0;
    }

    _makeGrain(inEnergy) {
      const N = this._N;
      const K = this._K;
      const half = N >> 1;
      const envShift = this._envShift;
      const re = this._re;
      const im = this._im;
      const frame = this._frame;
      const grain = this._grain;
      const wa = this._wa;
      for (let j = 0; j < K; j++) {
        re[j] = envShift[j];
        im[j] = 0;
      }
      this._fft.realInverse(re, im, frame);
      let e = 0;
      for (let n = 0; n < N; n++) {
        const v = frame[(n + half) & (N - 1)] * wa[n];
        grain[n] = v;
        e += v * v;
      }
      const inRms = Math.sqrt(inEnergy / this._sumWa2);
      const gain = e > 1e-30 && inRms > 1e-9 ? inRms * Math.sqrt(this._robotPeriod / e) : 0;
      for (let n = 0; n < N; n++) grain[n] *= gain;
      this._grainReady = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * GranularShifter: two taps on a delay line, sawtooth delay modulation,
   * sin^2 crossfade (gains sum to 1). Nominal latency = grain / 2.
   * ------------------------------------------------------------------ */
  class GranularShifter {
    constructor(sampleRate) {
      const sr = sanitizeRate(sampleRate);
      this.sampleRate = sr;
      const G = 2 * Math.round(sr * 0.025);
      this.grainSize = G;
      this.latencySamples = G >> 1;
      this._G = G;
      const size = nextPow2(G + 8);
      this._buf = new Float32Array(size);
      this._mask = size - 1;
      this._ratio = 1;
      this.reset();
    }

    reset() {
      this._buf.fill(0);
      this._w = 0;
      this._phase = 0;
    }

    setPitch(semitones) {
      this._ratio = Math.pow(2, clampNum(semitones, -24, 24, 0) / 12);
    }

    process(input, output, offset, length) {
      const off = offset | 0;
      const end = off + (length === undefined ? input.length - off : length | 0);
      const buf = this._buf;
      const mask = this._mask;
      const size = mask + 1;
      const G = this._G;
      const inc = (1 - this._ratio) / G;
      let w = this._w;
      let ph = this._phase;
      for (let i = off; i < end; i++) {
        buf[w] = input[i];
        let ph2 = ph + 0.5;
        if (ph2 >= 1) ph2 -= 1;
        const p1 = w + size - ph * G;
        const i1 = Math.floor(p1);
        const f1 = p1 - i1;
        const a1 = buf[i1 & mask];
        const y1 = a1 + f1 * (buf[(i1 + 1) & mask] - a1);
        const p2 = w + size - ph2 * G;
        const i2 = Math.floor(p2);
        const f2 = p2 - i2;
        const a2 = buf[i2 & mask];
        const y2 = a2 + f2 * (buf[(i2 + 1) & mask] - a2);
        const s = Math.sin(Math.PI * ph);
        const g1 = s * s;
        output[i] = g1 * y1 + (1 - g1) * y2;
        ph += inc;
        if (ph >= 1) ph -= 1;
        else if (ph < 0) ph += 1;
        w = (w + 1) & mask;
      }
      this._w = w;
      this._phase = ph;
    }
  }

  /* ------------------------------------------------------------------ *
   * VoiceCore: gate -> shifter (or delayed passthrough) -> bit crusher -> sample-and-hold.
   * Path switches crossfade over ~20 ms with both paths running.
   * ------------------------------------------------------------------ */
  class VoiceCore {
    constructor(sampleRate, params) {
      const sr = sanitizeRate(sampleRate);
      this.sampleRate = sr;
      this._spec = [new SpectralShifter(sr), new SpectralShifter(sr)];
      this._gran = new GranularShifter(sr);
      this._specLatency = this._spec[0].latencySamples;
      this._granLatency = this._gran.latencySamples;

      const histSize = nextPow2(Math.max(8192, 4 * this._spec[0].fftSize, 2 * this._gran.grainSize + 16));
      this._hist = new Float32Array(histSize);
      this._histMask = histSize - 1;
      this._histW = 0;

      this._gated = new Float32Array(CHUNK);
      this._bufA = new Float32Array(CHUNK);
      this._bufB = new Float32Array(CHUNK);
      this._primeOut = new Float32Array(CHUNK);

      this._fadeLen = Math.max(16, Math.round(sr * 0.02));
      this._fadeIn = new Float32Array(this._fadeLen + 1);
      for (let k = 0; k <= this._fadeLen; k++) {
        const s = Math.sin((Math.PI / 2) * (k / this._fadeLen));
        this._fadeIn[k] = s * s;
      }

      // Gate: fast peak follower drives a held open/closed target; the gain glides toward it.
      this._envAtk = Math.exp(-1 / (0.001 * sr));
      this._envRel = Math.exp(-1 / (0.03 * sr));
      this._gainAtk = Math.exp(-1 / ((0.005 * sr) / 4.6));
      this._gainRel = Math.exp(-1 / ((0.12 * sr) / 4.6));
      this._holdSamples = Math.round(0.15 * sr);

      this._p = Object.assign({}, DEFAULTS);
      this._applyParamValues(params);
      this._computeDesired();
      this.reset();
    }

    get latencySamples() {
      return this._latency;
    }

    reset() {
      this._hist.fill(0);
      this._histW = 0;
      this._spec[0].reset();
      this._spec[1].reset();
      this._gran.reset();
      this._gateEnv = 0;
      this._gateGain = 1;
      this._gateHold = 0;
      this._dsCount = 0;
      this._dsHeld = 0;
      this._fading = false;
      this._fadePos = 0;
      this._oKind = PATH_NONE;
      this._oDelay = 0;
      this._oSpec = 0;
      this._oTex = TEX_NORMAL;
      this._aKind = this._dKind;
      this._aDelay = this._dDelay;
      this._aTex = this._dTex;
      this._aSpec = 0;
      this._configurePath(this._aKind, this._aSpec, this._aTex);
    }

    setParams(params) {
      if (!params || typeof params !== 'object') return;
      this._applyParamValues(params);
      this._computeDesired();
      if (this._isActiveDesired()) this._configurePath(this._aKind, this._aSpec, this._aTex);
    }

    _applyParamValues(params) {
      const p = this._p;
      if (params && typeof params === 'object') {
        const keys = ['pitch', 'formant', 'robotPitch', 'gate', 'bitDepth', 'downsample'];
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key in params) {
            const lim = LIMITS[key];
            p[key] = clampNum(params[key], lim[0], lim[1], p[key]);
          }
        }
        if ('algorithm' in params && ALGORITHMS.indexOf(params.algorithm) >= 0) p.algorithm = params.algorithm;
        if ('texture' in params && TEXTURES.indexOf(params.texture) >= 0) p.texture = params.texture;
      }
      p.bitDepth = Math.round(p.bitDepth);
      p.downsample = Math.round(p.downsample);
      this._gateOn = p.gate > LIMITS.gate[0];
      this._gateThr = Math.pow(10, p.gate / 20);
      this._crushQ = p.bitDepth < 16 ? Math.pow(2, p.bitDepth - 1) : 0;
      this._dsFactor = p.downsample > 1 ? p.downsample : 1;
    }

    _computeDesired() {
      const p = this._p;
      const tex = p.texture === 'robot' ? TEX_ROBOT : p.texture === 'whisper' ? TEX_WHISPER : TEX_NORMAL;
      const spectral = tex !== TEX_NORMAL || p.algorithm !== 'granular';
      this._latency = spectral ? this._specLatency : this._granLatency;
      this._dTex = tex;
      if (tex !== TEX_NORMAL) {
        this._dKind = PATH_SPECTRAL;
      } else if (!spectral) {
        // Granular ignores formant, so pitch 0 is neutral there.
        this._dKind = p.pitch === 0 ? PATH_BYPASS : PATH_GRANULAR;
      } else {
        this._dKind = p.pitch === 0 && p.formant === 0 ? PATH_BYPASS : PATH_SPECTRAL;
      }
      this._dDelay = this._dKind === PATH_BYPASS ? this._latency : 0;
    }

    _isActiveDesired() {
      if (this._aKind !== this._dKind) return false;
      if (this._aKind === PATH_BYPASS) return this._aDelay === this._dDelay;
      if (this._aKind === PATH_SPECTRAL) return this._aTex === this._dTex;
      return true;
    }

    _configurePath(kind, specIdx, tex) {
      const p = this._p;
      if (kind === PATH_SPECTRAL) {
        const s = this._spec[specIdx];
        s.setPitch(p.pitch);
        s.setFormant(p.formant);
        s.setTexture(tex);
        s.setRobotPitch(p.robotPitch);
      } else if (kind === PATH_GRANULAR) {
        this._gran.setPitch(p.pitch);
      }
    }

    _prime(shifter, count) {
      // Run recent history through a freshly reset shifter so it enters the crossfade in steady state.
      const hist = this._hist;
      const mask = this._histMask;
      const buf = this._bufB;
      const out = this._primeOut;
      let pos = (this._histW - count) & mask;
      let left = count;
      while (left > 0) {
        const n = left < CHUNK ? left : CHUNK;
        for (let i = 0; i < n; i++) buf[i] = hist[(pos + i) & mask];
        shifter.process(buf, out, 0, n);
        pos = (pos + n) & mask;
        left -= n;
      }
    }

    _maybeSwitch() {
      if (this._fading || this._isActiveDesired()) return;
      this._oKind = this._aKind;
      this._oDelay = this._aDelay;
      this._oSpec = this._aSpec;
      this._oTex = this._aTex;
      const kind = this._dKind;
      let specIdx = this._aSpec;
      if (kind === PATH_SPECTRAL && this._oKind === PATH_SPECTRAL) specIdx = 1 - this._oSpec;
      if (kind === PATH_SPECTRAL) {
        const s = this._spec[specIdx];
        s.reset();
        this._configurePath(kind, specIdx, this._dTex);
        this._prime(s, 2 * s.fftSize);
      } else if (kind === PATH_GRANULAR) {
        this._gran.reset();
        this._configurePath(kind, specIdx, this._dTex);
        this._prime(this._gran, 2 * this._gran.grainSize);
      }
      this._aKind = kind;
      this._aDelay = this._dDelay;
      this._aTex = this._dTex;
      this._aSpec = specIdx;
      this._fading = true;
      this._fadePos = 0;
    }

    _render(kind, delay, specIdx, len, histStart, out) {
      if (kind === PATH_SPECTRAL) {
        this._spec[specIdx].process(this._gated, out, 0, len);
      } else if (kind === PATH_GRANULAR) {
        this._gran.process(this._gated, out, 0, len);
      } else {
        const hist = this._hist;
        const mask = this._histMask;
        const start = histStart - delay;
        for (let i = 0; i < len; i++) out[i] = hist[(start + i) & mask];
      }
    }

    _gate(input, off, len) {
      const g = this._gated;
      if (!this._gateOn && this._gateGain === 1) {
        for (let i = 0; i < len; i++) {
          const x = input[off + i];
          g[i] = x - x === 0 ? x : 0;
        }
        return;
      }
      const on = this._gateOn;
      const thrOpen = this._gateThr;
      const thrHold = thrOpen * 0.5;
      const envAtk = this._envAtk;
      const envRel = this._envRel;
      const gainAtk = this._gainAtk;
      const gainRel = this._gainRel;
      const holdSamples = this._holdSamples;
      let env = this._gateEnv;
      let gain = this._gateGain;
      let hold = this._gateHold;
      for (let i = 0; i < len; i++) {
        let x = input[off + i];
        if (x - x !== 0) x = 0;
        const a = x < 0 ? -x : x;
        env = a > env ? a + (env - a) * envAtk : a + (env - a) * envRel;
        let open = true;
        if (on) {
          if (env > thrOpen || (hold > 0 && env > thrHold)) hold = holdSamples;
          else if (hold > 0) hold--;
          else open = false;
        }
        if (open) {
          gain = 1 + (gain - 1) * gainAtk;
          if (gain > 0.99999) gain = 1;
        } else {
          gain *= gainRel;
          if (gain < 1e-6) gain = 0;
        }
        g[i] = x * gain;
      }
      if (env < 1e-12) env = 0;
      this._gateEnv = env;
      this._gateGain = gain;
      this._gateHold = hold;
    }

    _segment(input, output, off, len) {
      this._gate(input, off, len);
      const g = this._gated;
      const hist = this._hist;
      const mask = this._histMask;
      const histStart = this._histW;
      for (let i = 0; i < len; i++) hist[(histStart + i) & mask] = g[i];
      this._histW = (histStart + len) & mask;

      const a = this._bufA;
      this._render(this._aKind, this._aDelay, this._aSpec, len, histStart, a);
      if (this._fading) {
        const b = this._bufB;
        this._render(this._oKind, this._oDelay, this._oSpec, len, histStart, b);
        const fin = this._fadeIn;
        const fp = this._fadePos;
        for (let i = 0; i < len; i++) {
          const w = fin[fp + i];
          a[i] = a[i] * w + b[i] * (1 - w);
        }
        this._fadePos = fp + len;
        if (this._fadePos >= this._fadeLen) {
          this._fading = false;
          this._oKind = PATH_NONE;
        }
      }

      const q = this._crushQ;
      const ds = this._dsFactor;
      let dsCount = this._dsCount;
      let held = this._dsHeld;
      let bad = false;
      for (let i = 0; i < len; i++) {
        let y = a[i];
        if (q > 0) y = Math.round(y * q) / q;
        if (ds > 1) {
          if (dsCount === 0) held = y;
          y = held;
          dsCount++;
          if (dsCount >= ds) dsCount = 0;
        }
        if (y - y !== 0) {
          y = 0;
          bad = true;
        }
        output[off + i] = y;
      }
      if (ds <= 1) dsCount = 0;
      if (held - held !== 0) held = 0;
      this._dsCount = dsCount;
      this._dsHeld = held;
      if (bad) this._recover();
    }

    _recover() {
      // A shifter produced a non-finite value: restart the processing paths from a clean state.
      this._spec[0].reset();
      this._spec[1].reset();
      this._gran.reset();
      this._configurePath(this._aKind, this._aSpec, this._aTex);
      if (this._fading) this._configurePath(this._oKind, this._oSpec, this._oTex);
      if (!(this._gateGain >= 0 && this._gateGain <= 1)) this._gateGain = 1;
      if (!(this._gateEnv >= 0 && this._gateEnv < Infinity)) this._gateEnv = 0;
    }

    process(input, output) {
      if (!input || !output) return;
      const n = Math.min(input.length, output.length);
      let off = 0;
      this._maybeSwitch();
      while (off < n) {
        let len = n - off;
        if (len > CHUNK) len = CHUNK;
        if (this._fading) {
          const rem = this._fadeLen - this._fadePos;
          if (len > rem) len = rem;
        }
        this._segment(input, output, off, len);
        off += len;
        this._maybeSwitch();
      }
    }
  }

  const WVCDSP = {
    VoiceCore,
    FFT,
    SpectralShifter,
    GranularShifter,
    PROCESSOR_NAME,
  };
  scope.WVCDSP = WVCDSP;

  /* ------------------------------------------------------------------ *
   * AudioWorklet processor (only inside an AudioWorkletGlobalScope).
   * ------------------------------------------------------------------ */
  if (typeof scope.registerProcessor === 'function' && typeof scope.AudioWorkletProcessor === 'function') {
    class WvcVoiceCoreProcessor extends scope.AudioWorkletProcessor {
      constructor(options) {
        super(options);
        const po = (options && options.processorOptions) || {};
        const sr = typeof scope.sampleRate === 'number' ? scope.sampleRate : 48000;
        this._disposed = false;
        this._failed = false;
        this._core = null;
        this._latency = 0;
        let initError = null;
        try {
          this._core = new VoiceCore(sr, po.params && typeof po.params === 'object' ? po.params : {});
          this._latency = this._core.latencySamples;
        } catch (err) {
          // Fail open: without a core the processor passes audio through untouched.
          this._failed = true;
          initError = err;
        }
        this.port.onmessage = (event) => this._onMessage(event && event.data);
        this._post({ type: 'ready', latencySamples: this._latency });
        if (initError) this._post({ type: 'error', message: String((initError && initError.message) || initError) });
      }

      _post(msg) {
        try {
          this.port.postMessage(msg);
        } catch (_) {
          // Port already closed; nothing left to notify.
        }
      }

      _onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        try {
          if (msg.type === 'dispose') {
            this._disposed = true;
            this._core = null;
            this.port.onmessage = null;
            return;
          }
          if (!this._core) return;
          if (msg.type === 'params') {
            this._core.setParams(msg.params);
            const lat = this._core.latencySamples;
            if (lat !== this._latency) {
              this._latency = lat;
              this._post({ type: 'latency', latencySamples: lat });
            }
          } else if (msg.type === 'reset') {
            this._core.reset();
            this._failed = false;
          }
        } catch (err) {
          this._post({ type: 'error', message: String((err && err.message) || err) });
        }
      }

      process(inputs, outputs) {
        if (this._disposed) return false;
        const outs = outputs && outputs[0];
        const out = outs && outs[0];
        if (!out) return true;
        const inp = inputs && inputs[0];
        const ch = inp && inp[0];
        if (!ch || ch.length === 0) {
          out.fill(0);
        } else if (this._failed) {
          this._passthrough(ch, out);
        } else {
          try {
            this._core.process(ch, out);
          } catch (err) {
            this._failed = true;
            this._post({ type: 'error', message: String((err && err.message) || err) });
            this._passthrough(ch, out);
          }
        }
        for (let c = 1; c < outs.length; c++) outs[c].set(out);
        return true;
      }

      _passthrough(ch, out) {
        const n = Math.min(ch.length, out.length);
        for (let i = 0; i < n; i++) out[i] = ch[i];
        for (let i = n; i < out.length; i++) out[i] = 0;
      }
    }
    try {
      scope.registerProcessor(PROCESSOR_NAME, WvcVoiceCoreProcessor);
    } catch (_) {
      // Already registered in this scope (module evaluated twice).
    }
  }

  return WVCDSP;
}

wvcDefineDSP(typeof globalThis !== 'undefined' ? globalThis : this);
if (typeof globalThis !== 'undefined') globalThis.wvcDefineDSP = wvcDefineDSP;
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.WVCDSP;
