/**
 * solar-lstm.js — Lightweight LSTM neural network for solar weather forecasting.
 *
 * Pure ES module JavaScript — no TensorFlow / ONNX dependency.
 * Runs entirely in the browser with online learning from streaming data.
 *
 * Architecture:
 *   Input (5):  [speed_norm, density_norm, bz_norm, bt_norm, kp_norm]
 *   LSTM (32 hidden units, single layer)
 *   Dense (5):  [speed_norm, density_norm, bz_norm, bt_norm, kp_norm] predicted
 *
 * Training:
 *   - Sliding window of 24 hourly observations
 *   - Online SGD with Adam optimiser
 *   - Trained continuously from swpc-update events
 *   - Multi-step prediction via autoregressive rollout (1h → 24h)
 *
 * Validation:
 *   - Each prediction is logged with timestamp
 *   - When actual observation arrives, error is computed
 *   - Exponential moving average tracks accuracy trend
 *   - Learning rate adapts based on error momentum
 */

// ── Feature definitions ─────────────────────────────────────────────────────

export const FEATURES = ['speed_norm', 'density_norm', 'bz_norm', 'bt_norm', 'kp_norm'];
export const N_FEAT = FEATURES.length;

/**
 * Normalise raw solar wind values to [0, 1] for LSTM input.
 * Must match the shader uniform normalisation in sun.html.
 */
export function normalise(raw) {
    return new Float64Array([
        Math.max(0, Math.min(1, ((raw.speed ?? 400) - 250) / 650)),
        Math.max(0, Math.min(1, (raw.density ?? 5) / 25)),
        Math.max(0, Math.min(1, -(raw.bz ?? 0) / 30)),   // southward = positive
        Math.max(0, Math.min(1, (raw.bt ?? 5) / 30)),
        Math.max(0, Math.min(1, (raw.kp ?? 2) / 9)),
    ]);
}

/**
 * Denormalise LSTM output back to physical values.
 */
export function denormalise(norm) {
    return {
        speed:   norm[0] * 650 + 250,
        density: norm[1] * 25,
        bz:      -norm[2] * 30,
        bt:      norm[3] * 30,
        kp:      norm[4] * 9,
    };
}

// ── Math helpers ────────────────────────────────────────────────────────────

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, x)))); }
function dtanh(y)   { return 1 - y * y; }
function dsigmoid(y){ return y * (1 - y); }

/** Xavier/Glorot initialisation scaled by fan_in + fan_out */
function xavierInit(rows, cols) {
    const scale = Math.sqrt(2 / (rows + cols));
    const W = new Float64Array(rows * cols);
    for (let i = 0; i < W.length; i++) {
        // Box-Muller for normal distribution
        const u1 = Math.random() || 1e-10;
        const u2 = Math.random();
        W[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
    }
    return W;
}

/** Matrix-vector multiply: y = W·x + b  (W is rows×cols, x is cols, b is rows) */
function mvmul(W, x, b, rows, cols) {
    const y = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
        let s = b[r];
        const off = r * cols;
        for (let c = 0; c < cols; c++) s += W[off + c] * x[c];
        y[r] = s;
    }
    return y;
}

// ── LSTM Cell ───────────────────────────────────────────────────────────────

class LSTMCell {
    /**
     * @param {number} inputSize  - dimension of input vector
     * @param {number} hiddenSize - dimension of hidden/cell state
     */
    constructor(inputSize, hiddenSize) {
        this.inputSize  = inputSize;
        this.hiddenSize = hiddenSize;
        const concatSize = inputSize + hiddenSize;

        // Gate weights: [forget, input, cell_candidate, output]
        // Each gate: W is hiddenSize × concatSize, b is hiddenSize
        this.Wf = xavierInit(hiddenSize, concatSize);
        this.Wi = xavierInit(hiddenSize, concatSize);
        this.Wc = xavierInit(hiddenSize, concatSize);
        this.Wo = xavierInit(hiddenSize, concatSize);

        // Biases — forget gate starts at +1 to encourage remembering
        this.bf = new Float64Array(hiddenSize).fill(1.0);
        this.bi = new Float64Array(hiddenSize);
        this.bc = new Float64Array(hiddenSize);
        this.bo = new Float64Array(hiddenSize);
    }

    /**
     * Forward pass: returns {h, c, cache} for one time step.
     * @param {Float64Array} x  - input vector [inputSize]
     * @param {Float64Array} h_prev - previous hidden state [hiddenSize]
     * @param {Float64Array} c_prev - previous cell state [hiddenSize]
     */
    forward(x, h_prev, c_prev) {
        const { hiddenSize, inputSize } = this;
        const concatSize = inputSize + hiddenSize;

        // Concatenate [x, h_prev]
        const xh = new Float64Array(concatSize);
        xh.set(x);
        xh.set(h_prev, inputSize);

        // Gate activations
        const f_gate = mvmul(this.Wf, xh, this.bf, hiddenSize, concatSize).map(sigmoid);
        const i_gate = mvmul(this.Wi, xh, this.bi, hiddenSize, concatSize).map(sigmoid);
        const c_cand = mvmul(this.Wc, xh, this.bc, hiddenSize, concatSize).map(Math.tanh);
        const o_gate = mvmul(this.Wo, xh, this.bo, hiddenSize, concatSize).map(sigmoid);

        // New cell state and hidden state
        const c = new Float64Array(hiddenSize);
        const h = new Float64Array(hiddenSize);
        for (let i = 0; i < hiddenSize; i++) {
            c[i] = f_gate[i] * c_prev[i] + i_gate[i] * c_cand[i];
            h[i] = o_gate[i] * Math.tanh(c[i]);
        }

        return {
            h, c,
            cache: { xh, f_gate, i_gate, c_cand, o_gate, c_prev, h_prev, c_new: c },
        };
    }

    /**
     * Backward pass for one time step.
     * @param {object}       cache  - from forward()
     * @param {Float64Array}  dh    - gradient of loss w.r.t. hidden [hiddenSize]
     * @param {Float64Array}  dc    - gradient of loss w.r.t. cell [hiddenSize]
     * @returns {{ dx, dh_prev, dc_prev, grads }}
     */
    backward(cache, dh, dc) {
        const { hiddenSize, inputSize } = this;
        const concatSize = inputSize + hiddenSize;
        const { xh, f_gate, i_gate, c_cand, o_gate, c_prev, c_new } = cache;

        // Backprop through h = o * tanh(c)
        const tanh_c = c_new.map(Math.tanh);
        const do_ = new Float64Array(hiddenSize);
        const dc_total = new Float64Array(hiddenSize);
        for (let i = 0; i < hiddenSize; i++) {
            do_[i] = dh[i] * tanh_c[i];
            dc_total[i] = dc[i] + dh[i] * o_gate[i] * dtanh(tanh_c[i]);
        }

        // Backprop through gates
        const df = new Float64Array(hiddenSize);
        const di = new Float64Array(hiddenSize);
        const dcc = new Float64Array(hiddenSize);
        const dc_prev_out = new Float64Array(hiddenSize);

        for (let j = 0; j < hiddenSize; j++) {
            df[j]  = dc_total[j] * c_prev[j] * dsigmoid(f_gate[j]);
            di[j]  = dc_total[j] * c_cand[j] * dsigmoid(i_gate[j]);
            dcc[j] = dc_total[j] * i_gate[j] * dtanh(c_cand[j]);
            dc_prev_out[j] = dc_total[j] * f_gate[j];
        }

        const do_raw = do_.map((v, j) => v * dsigmoid(o_gate[j]));

        // Weight gradients: dW = d_gate · xh^T, db = d_gate
        const grads = {
            dWf: this._outerProduct(df, xh, hiddenSize, concatSize),
            dWi: this._outerProduct(di, xh, hiddenSize, concatSize),
            dWc: this._outerProduct(dcc, xh, hiddenSize, concatSize),
            dWo: this._outerProduct(do_raw, xh, hiddenSize, concatSize),
            dbf: df, dbi: di, dbc: dcc, dbo: do_raw,
        };

        // Input gradient: dxh = Wf^T·df + Wi^T·di + Wc^T·dcc + Wo^T·do_raw
        const dxh = new Float64Array(concatSize);
        this._addMTv(dxh, this.Wf, df, hiddenSize, concatSize);
        this._addMTv(dxh, this.Wi, di, hiddenSize, concatSize);
        this._addMTv(dxh, this.Wc, dcc, hiddenSize, concatSize);
        this._addMTv(dxh, this.Wo, do_raw, hiddenSize, concatSize);

        const dx = dxh.slice(0, inputSize);
        const dh_prev = dxh.slice(inputSize);

        return { dx, dh_prev, dc_prev: dc_prev_out, grads };
    }

    /** Outer product: M[r][c] = a[r] * b[c] */
    _outerProduct(a, b, rows, cols) {
        const M = new Float64Array(rows * cols);
        for (let r = 0; r < rows; r++) {
            const off = r * cols;
            for (let c = 0; c < cols; c++) M[off + c] = a[r] * b[c];
        }
        return M;
    }

    /** Accumulate transpose-multiply: v += M^T · a */
    _addMTv(v, M, a, rows, cols) {
        for (let r = 0; r < rows; r++) {
            const off = r * cols;
            for (let c = 0; c < cols; c++) v[c] += M[off + c] * a[r];
        }
    }
}

// ── Dense output layer ──────────────────────────────────────────────────────

class DenseLayer {
    constructor(inputSize, outputSize) {
        this.inputSize  = inputSize;
        this.outputSize = outputSize;
        this.W = xavierInit(outputSize, inputSize);
        this.b = new Float64Array(outputSize);
    }

    forward(x) {
        const y = mvmul(this.W, x, this.b, this.outputSize, this.inputSize);
        // Sigmoid output — predictions are normalised [0, 1]
        return y.map(sigmoid);
    }

    backward(x, y, dy) {
        // dy is the gradient from loss, y is sigmoid output
        const dz = new Float64Array(this.outputSize);
        for (let i = 0; i < this.outputSize; i++) {
            dz[i] = dy[i] * dsigmoid(y[i]);
        }
        const dW = new Float64Array(this.outputSize * this.inputSize);
        for (let r = 0; r < this.outputSize; r++) {
            const off = r * this.inputSize;
            for (let c = 0; c < this.inputSize; c++) {
                dW[off + c] = dz[r] * x[c];
            }
        }
        const dx = new Float64Array(this.inputSize);
        for (let r = 0; r < this.outputSize; r++) {
            const off = r * this.inputSize;
            for (let c = 0; c < this.inputSize; c++) {
                dx[c] += this.W[off + c] * dz[r];
            }
        }
        return { dx, dW, db: dz };
    }
}

// ── Adam optimiser ──────────────────────────────────────────────────────────

class AdamOptimiser {
    constructor(lr = 0.001, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
        this.lr    = lr;
        this.beta1 = beta1;
        this.beta2 = beta2;
        this.eps   = eps;
        this.t     = 0;
        this._m    = new Map();  // first moment
        this._v    = new Map();  // second moment
    }

    /** Update parameter array in-place. key must be unique per parameter. */
    step(key, param, grad) {
        if (!this._m.has(key)) {
            this._m.set(key, new Float64Array(param.length));
            this._v.set(key, new Float64Array(param.length));
        }
        this.t++;
        const m = this._m.get(key);
        const v = this._v.get(key);
        const { beta1, beta2, eps, lr, t } = this;
        const bc1 = 1 - Math.pow(beta1, t);
        const bc2 = 1 - Math.pow(beta2, t);

        for (let i = 0; i < param.length; i++) {
            m[i] = beta1 * m[i] + (1 - beta1) * grad[i];
            v[i] = beta2 * v[i] + (1 - beta2) * grad[i] * grad[i];
            const mHat = m[i] / bc1;
            const vHat = v[i] / bc2;
            param[i] -= lr * mHat / (Math.sqrt(vHat) + eps);
        }
    }
}

// ── Solar LSTM Model ────────────────────────────────────────────────────────

export class SolarLSTM {
    /**
     * @param {object} opts
     * @param {number} opts.hiddenSize   - LSTM hidden units (default 32)
     * @param {number} opts.seqLen       - training sequence length (default 24)
     * @param {number} opts.lr           - learning rate (default 0.001)
     */
    constructor(opts = {}) {
        this.hiddenSize = opts.hiddenSize ?? 32;
        this.seqLen     = opts.seqLen     ?? 24;

        this.lstm  = new LSTMCell(N_FEAT, this.hiddenSize);
        this.dense = new DenseLayer(this.hiddenSize, N_FEAT);
        this.optim = new AdamOptimiser(opts.lr ?? 0.001);

        // Training buffer: ring of normalised feature vectors (hourly)
        this._buffer = [];
        this._maxBuf = 720;  // 30 days of hourly data

        // Validation tracking
        this._pendingPredictions = [];  // {t_ms, horizon_h, predicted: Float64Array}
        this._errorEMA = 0.5;          // exponential moving average of MSE
        this._errorAlpha = 0.05;        // EMA smoothing factor
        this._nTrained = 0;
        this._nValidated = 0;

        // Confidence metric: starts low, improves with training
        this._confidence = 0;
    }

    /** Number of training steps completed */
    get trainedSteps() { return this._nTrained; }

    /** Number of validated predictions */
    get validatedSteps() { return this._nValidated; }

    /** Current error EMA (lower = better, 0-1 scale) */
    get errorEMA() { return this._errorEMA; }

    /** Model confidence [0-1] based on training volume and error trend */
    get confidence() { return this._confidence; }

    /**
     * Ingest a new hourly observation. Triggers training if buffer is large enough.
     * @param {object} raw - { speed, density, bz, bt, kp }
     * @param {number} t_ms - timestamp (ms)
     */
    ingest(raw, t_ms = Date.now()) {
        const norm = normalise(raw);
        this._buffer.push({ t_ms, features: norm });
        if (this._buffer.length > this._maxBuf) this._buffer.shift();

        // Validate any pending predictions that have matured
        this._validatePending(raw, t_ms);

        // Train if we have enough data
        if (this._buffer.length >= this.seqLen + 1) {
            this._trainStep();
        }
    }

    /**
     * Seed the model with historical data (array of {t_ms, speed, density, bz, bt, kp}).
     * Runs multiple training epochs over the data.
     * @param {Array} history - oldest-first array of raw observations
     * @param {number} epochs - number of training passes (default 3)
     */
    seed(history, epochs = 3) {
        // Add to buffer
        for (const rec of history) {
            const norm = normalise(rec);
            this._buffer.push({ t_ms: rec.t_ms ?? rec.t ?? Date.now(), features: norm });
        }
        if (this._buffer.length > this._maxBuf) {
            this._buffer = this._buffer.slice(-this._maxBuf);
        }

        // Train multiple epochs
        const nWindows = Math.max(0, this._buffer.length - this.seqLen - 1);
        if (nWindows < 1) return;

        for (let epoch = 0; epoch < epochs; epoch++) {
            // Shuffle window start indices
            const indices = Array.from({ length: nWindows }, (_, i) => i);
            for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            for (const startIdx of indices) {
                this._trainOnWindow(startIdx);
            }
        }
        console.info(`[SolarLSTM] Seeded with ${history.length} records, ${epochs} epochs, ${this._nTrained} steps`);
    }

    /**
     * Generate multi-step forecast from the most recent observations.
     * @param {number} horizon_h - hours to forecast (default 24)
     * @returns {Array<{ t_ms, features: Float64Array, raw: object }>}
     */
    forecast(horizon_h = 24) {
        if (this._buffer.length < this.seqLen) {
            return [];  // not enough data
        }

        // Run the LSTM over the last seqLen observations to prime the hidden state
        const { hiddenSize } = this;
        let h = new Float64Array(hiddenSize);
        let c = new Float64Array(hiddenSize);

        const start = this._buffer.length - this.seqLen;
        for (let t = 0; t < this.seqLen; t++) {
            const result = this.lstm.forward(this._buffer[start + t].features, h, c);
            h = result.h;
            c = result.c;
        }

        // Autoregressive rollout: feed predictions back as input
        const forecasts = [];
        const lastT = this._buffer[this._buffer.length - 1].t_ms;
        let currentInput = this._buffer[this._buffer.length - 1].features;

        for (let step = 1; step <= horizon_h; step++) {
            const result = this.lstm.forward(currentInput, h, c);
            h = result.h;
            c = result.c;
            const pred = this.dense.forward(result.h);

            // Clamp predictions to valid range
            for (let i = 0; i < N_FEAT; i++) {
                pred[i] = Math.max(0, Math.min(1, pred[i]));
            }

            const t_ms = lastT + step * 3_600_000;
            forecasts.push({
                t_ms,
                features: pred,
                raw: denormalise(pred),
            });

            // Store prediction for validation
            this._pendingPredictions.push({
                t_ms,
                horizon_h: step,
                predicted: new Float64Array(pred),
                created_at: Date.now(),
            });

            currentInput = pred;  // autoregressive: feed prediction as next input
        }

        // Prune old pending predictions (>48h old)
        const cutoff = Date.now() - 48 * 3_600_000;
        this._pendingPredictions = this._pendingPredictions.filter(p => p.created_at > cutoff);

        return forecasts;
    }

    // ── Training ────────────────────────────────────────────────────────────

    /** Train on the most recent window */
    _trainStep() {
        const startIdx = Math.max(0, this._buffer.length - this.seqLen - 1);
        this._trainOnWindow(startIdx);
    }

    /** Train on a specific window starting at buffer index `startIdx` */
    _trainOnWindow(startIdx) {
        const { seqLen, hiddenSize } = this;
        const endIdx = startIdx + seqLen;
        if (endIdx >= this._buffer.length) return;

        // ── Forward pass through sequence ──
        let h = new Float64Array(hiddenSize);
        let c = new Float64Array(hiddenSize);
        const caches  = [];
        const hiddens = [];
        const outputs = [];

        for (let t = 0; t < seqLen; t++) {
            const x = this._buffer[startIdx + t].features;
            const result = this.lstm.forward(x, h, c);
            caches.push(result.cache);
            hiddens.push(result.h);
            h = result.h;
            c = result.c;

            // Predict next step from hidden state
            const pred = this.dense.forward(result.h);
            outputs.push(pred);
        }

        // ── Compute loss: MSE over sequence ──
        let totalLoss = 0;
        const denseGrads = [];

        for (let t = 0; t < seqLen; t++) {
            const target = this._buffer[startIdx + t + 1].features;
            const pred   = outputs[t];
            const dy = new Float64Array(N_FEAT);
            for (let i = 0; i < N_FEAT; i++) {
                const err = pred[i] - target[i];
                dy[i] = 2 * err / (seqLen * N_FEAT);  // MSE gradient
                totalLoss += err * err;
            }
            denseGrads.push(this.dense.backward(hiddens[t], pred, dy));
        }
        totalLoss /= seqLen * N_FEAT;

        // ── Backward pass through time (BPTT) ──
        let dh_next = new Float64Array(hiddenSize);
        let dc_next = new Float64Array(hiddenSize);

        // Accumulated LSTM weight gradients
        const { lstm } = this;
        const concatSize = lstm.inputSize + hiddenSize;
        const accGrads = {
            dWf: new Float64Array(hiddenSize * concatSize),
            dWi: new Float64Array(hiddenSize * concatSize),
            dWc: new Float64Array(hiddenSize * concatSize),
            dWo: new Float64Array(hiddenSize * concatSize),
            dbf: new Float64Array(hiddenSize),
            dbi: new Float64Array(hiddenSize),
            dbc: new Float64Array(hiddenSize),
            dbo: new Float64Array(hiddenSize),
        };

        // Accumulated dense weight gradients
        const accDW = new Float64Array(this.dense.outputSize * this.dense.inputSize);
        const accDb = new Float64Array(this.dense.outputSize);

        for (let t = seqLen - 1; t >= 0; t--) {
            // Dense gradient flows into hidden
            const dg = denseGrads[t];
            for (let i = 0; i < accDW.length; i++) accDW[i] += dg.dW[i];
            for (let i = 0; i < accDb.length; i++) accDb[i] += dg.db[i];

            // Combine dense→hidden gradient with recurrent gradient
            const dh = new Float64Array(hiddenSize);
            for (let i = 0; i < hiddenSize; i++) dh[i] = dg.dx[i] + dh_next[i];

            const bk = lstm.backward(caches[t], dh, dc_next);
            dh_next = bk.dh_prev;
            dc_next = bk.dc_prev;

            // Accumulate LSTM gradients
            const g = bk.grads;
            for (let i = 0; i < accGrads.dWf.length; i++) {
                accGrads.dWf[i] += g.dWf[i];
                accGrads.dWi[i] += g.dWi[i];
                accGrads.dWc[i] += g.dWc[i];
                accGrads.dWo[i] += g.dWo[i];
            }
            for (let i = 0; i < hiddenSize; i++) {
                accGrads.dbf[i] += g.dbf[i];
                accGrads.dbi[i] += g.dbi[i];
                accGrads.dbc[i] += g.dbc[i];
                accGrads.dbo[i] += g.dbo[i];
            }
        }

        // ── Gradient clipping (max norm = 5.0) ──
        const allGrads = [accGrads.dWf, accGrads.dWi, accGrads.dWc, accGrads.dWo,
                          accGrads.dbf, accGrads.dbi, accGrads.dbc, accGrads.dbo,
                          accDW, accDb];
        let globalNorm = 0;
        for (const g of allGrads) for (let i = 0; i < g.length; i++) globalNorm += g[i] * g[i];
        globalNorm = Math.sqrt(globalNorm);
        if (globalNorm > 5.0) {
            const scale = 5.0 / globalNorm;
            for (const g of allGrads) for (let i = 0; i < g.length; i++) g[i] *= scale;
        }

        // ── Adam update ──
        this.optim.step('Wf', lstm.Wf, accGrads.dWf);
        this.optim.step('Wi', lstm.Wi, accGrads.dWi);
        this.optim.step('Wc', lstm.Wc, accGrads.dWc);
        this.optim.step('Wo', lstm.Wo, accGrads.dWo);
        this.optim.step('bf', lstm.bf, accGrads.dbf);
        this.optim.step('bi', lstm.bi, accGrads.dbi);
        this.optim.step('bc', lstm.bc, accGrads.dbc);
        this.optim.step('bo', lstm.bo, accGrads.dbo);
        this.optim.step('dW', this.dense.W, accDW);
        this.optim.step('db', this.dense.b, accDb);

        // Track error
        this._errorEMA = this._errorEMA * (1 - this._errorAlpha) + totalLoss * this._errorAlpha;
        this._nTrained++;

        // Update confidence: sigmoid of (trained_steps / 100) * (1 - error)
        const trainFactor = 1 - Math.exp(-this._nTrained / 200);
        const errorFactor = Math.max(0, 1 - this._errorEMA * 4);
        this._confidence = trainFactor * errorFactor;
    }

    // ── Validation ──────────────────────────────────────────────────────────

    /** Validate pending predictions against an actual observation */
    _validatePending(raw, t_ms) {
        const actual = normalise(raw);
        const matched = [];

        this._pendingPredictions = this._pendingPredictions.filter(pred => {
            // Match if the observation timestamp is within ±30 min of predicted time
            if (Math.abs(t_ms - pred.t_ms) < 30 * 60_000) {
                let mse = 0;
                for (let i = 0; i < N_FEAT; i++) {
                    const err = pred.predicted[i] - actual[i];
                    mse += err * err;
                }
                mse /= N_FEAT;
                matched.push({ horizon_h: pred.horizon_h, mse });
                this._nValidated++;
                return false;  // remove from pending
            }
            return true;  // keep waiting
        });

        // Adaptive learning rate based on validation error
        if (matched.length > 0) {
            const avgMSE = matched.reduce((s, m) => s + m.mse, 0) / matched.length;
            // If error is rising, increase learning rate; if falling, decrease
            if (avgMSE > this._errorEMA * 1.5) {
                this.optim.lr = Math.min(0.01, this.optim.lr * 1.1);
            } else if (avgMSE < this._errorEMA * 0.5) {
                this.optim.lr = Math.max(0.0001, this.optim.lr * 0.95);
            }
        }
    }

    // ── Serialisation ───────────────────────────────────────────────────────

    /** Export model weights for persistence (e.g., localStorage) */
    exportWeights() {
        const { lstm, dense } = this;
        return {
            version: 1,
            hiddenSize: this.hiddenSize,
            seqLen: this.seqLen,
            nTrained: this._nTrained,
            nValidated: this._nValidated,
            errorEMA: this._errorEMA,
            confidence: this._confidence,
            lr: this.optim.lr,
            lstm: {
                Wf: Array.from(lstm.Wf), Wi: Array.from(lstm.Wi),
                Wc: Array.from(lstm.Wc), Wo: Array.from(lstm.Wo),
                bf: Array.from(lstm.bf), bi: Array.from(lstm.bi),
                bc: Array.from(lstm.bc), bo: Array.from(lstm.bo),
            },
            dense: { W: Array.from(dense.W), b: Array.from(dense.b) },
        };
    }

    /** Import previously exported weights */
    importWeights(data) {
        if (!data || data.version !== 1) return false;
        const { lstm, dense } = this;
        try {
            lstm.Wf = new Float64Array(data.lstm.Wf);
            lstm.Wi = new Float64Array(data.lstm.Wi);
            lstm.Wc = new Float64Array(data.lstm.Wc);
            lstm.Wo = new Float64Array(data.lstm.Wo);
            lstm.bf = new Float64Array(data.lstm.bf);
            lstm.bi = new Float64Array(data.lstm.bi);
            lstm.bc = new Float64Array(data.lstm.bc);
            lstm.bo = new Float64Array(data.lstm.bo);
            dense.W = new Float64Array(data.dense.W);
            dense.b = new Float64Array(data.dense.b);
            this._nTrained   = data.nTrained   ?? 0;
            this._nValidated = data.nValidated  ?? 0;
            this._errorEMA   = data.errorEMA    ?? 0.5;
            this._confidence = data.confidence   ?? 0;
            this.optim.lr    = data.lr           ?? 0.001;
            return true;
        } catch {
            return false;
        }
    }

    /** Try to load weights from localStorage */
    loadFromStorage() {
        try {
            const json = localStorage.getItem('solar_lstm_weights');
            if (json) {
                const ok = this.importWeights(JSON.parse(json));
                if (ok) console.info(`[SolarLSTM] Loaded weights from storage (${this._nTrained} steps, confidence ${(this._confidence * 100).toFixed(0)}%)`);
                return ok;
            }
        } catch { /* ignore */ }
        return false;
    }

    /** Save weights to localStorage */
    saveToStorage() {
        try {
            localStorage.setItem('solar_lstm_weights', JSON.stringify(this.exportWeights()));
        } catch { /* quota errors silently ignored */ }
    }

    /** Get a human-readable status summary */
    status() {
        return {
            trained:    this._nTrained,
            validated:  this._nValidated,
            errorEMA:   +this._errorEMA.toFixed(4),
            confidence: +this._confidence.toFixed(3),
            lr:         +this.optim.lr.toFixed(6),
            bufferSize: this._buffer.length,
        };
    }
}
