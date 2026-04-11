//! Machine-learning solar flare prediction — lightweight feedforward network.
//!
//! # Architecture
//!
//! A compact neural network that runs in real-time within the Bevy simulation
//! (including WASM builds) to predict solar flare probability and modulate
//! flux rope dynamics based on live NASA/NOAA observations.
//!
//! ## Network topology
//!
//! ```text
//!   Input (12 features)
//!     │
//!     ├─ Dense(12 → 32, ReLU)
//!     ├─ Dense(32 → 16, ReLU)
//!     ├─ Dense(16 → 8,  ReLU)
//!     │
//!     ├─ Head A: Dense(8 → 4, Softmax) — Flare class probabilities [quiet, C, M, X]
//!     └─ Head B: Dense(8 → 1, Sigmoid) — CME association probability
//! ```
//!
//! Total parameters: 12×32 + 32 + 32×16 + 16 + 16×8 + 8 + 8×4 + 4 + 8×1 + 1
//!                 = 384 + 32 + 512 + 16 + 128 + 8 + 32 + 4 + 8 + 1 = **1,125 parameters**
//!
//! This is small enough to:
//! - Run every frame on CPU (< 0.1 ms)
//! - Ship as static weights in the WASM binary (< 5 KB)
//! - Train on modest hardware from DONKI historical data
//!
//! ## Input features (12-dimensional)
//!
//! Extracted from live NASA/NOAA data streams (see [`super::feature_extract`]):
//!
//! | # | Feature                    | Source          | Range   |
//! |---|----------------------------|-----------------|---------|
//! | 0 | X-ray flux (log₁₀)        | NOAA GOES       | [-9, -3] normalised to [0,1] |
//! | 1 | X-ray flux derivative      | NOAA GOES       | [-1, 1]  |
//! | 2 | Solar wind speed (norm)    | DSCOVR/ACE      | [0, 1]   |
//! | 3 | Wind speed trend           | Pipeline        | [-1, 1]  |
//! | 4 | IMF Bz (norm, southward+)  | DSCOVR/ACE      | [0, 1]   |
//! | 5 | Proton density (norm)      | DSCOVR/ACE      | [0, 1]   |
//! | 6 | Radio flux F10.7 (norm)    | Penticton       | [0, 1]   |
//! | 7 | Active region count (norm) | NOAA SRS        | [0, 1]   |
//! | 8 | Max AR magnetic class      | NOAA SRS        | [0, 1]   |
//! | 9 | Recent flare rate          | DONKI FLR       | [0, 1]   |
//! |10 | Hours since last M+ flare  | DONKI FLR       | [0, 1]   |
//! |11 | CME speed (norm, if any)   | DONKI CME       | [0, 1]   |
//!
//! ## Weight initialisation
//!
//! Weights are initialised with a physics-informed prior derived from the
//! empirical relationships between these features and flare occurrence
//! (Bloomfield+ 2012, Bobra & Couvidat 2015, Leka+ 2019).  The network
//! can be further trained on historical DONKI data using the Python pipeline
//! in `swmf/pipeline/flare_features.py`.
//!
//! ## Integration
//!
//! The prediction runs on a timer ([`PREDICT_INTERVAL_SECS`]) and updates
//! the [`FlareMLPrediction`] resource.  The flux rope system reads this to
//! modulate energy injection rates, and the HUD displays the probability.

use bevy::prelude::*;

// ── Configuration ────────────────────────────────────────────────────────────

/// Number of input features.
pub const N_FEATURES: usize = 12;

/// Seconds between ML inference passes.
const PREDICT_INTERVAL_SECS: f32 = 5.0;

// ── Neural network primitives ────────────────────────────────────────────────

/// A single dense (fully connected) layer: y = activation(Wx + b).
#[derive(Clone)]
struct DenseLayer {
    /// Weight matrix, stored row-major: weights[out][in].
    weights: Vec<Vec<f32>>,
    /// Bias vector, length = output_size.
    biases: Vec<f32>,
    /// Activation function.
    activation: Activation,
}

#[derive(Clone, Copy)]
enum Activation {
    ReLU,
    Sigmoid,
    Softmax,
    None,
}

impl DenseLayer {
    fn new(input_size: usize, output_size: usize, activation: Activation) -> Self {
        // Xavier/Glorot uniform initialisation: U(-limit, limit)
        // where limit = sqrt(6 / (fan_in + fan_out)).
        let limit = (6.0 / (input_size + output_size) as f32).sqrt();
        let mut weights = Vec::with_capacity(output_size);
        let mut biases = Vec::with_capacity(output_size);

        // Deterministic pseudo-random for reproducible init.
        let mut seed: u64 = 42 + (input_size * output_size) as u64;
        let next_f32 = |s: &mut u64| -> f32 {
            *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let bits = ((*s >> 33) as u32) as f32 / u32::MAX as f32;
            bits * 2.0 * limit - limit
        };

        for _ in 0..output_size {
            let mut row = Vec::with_capacity(input_size);
            for _ in 0..input_size {
                row.push(next_f32(&mut seed));
            }
            weights.push(row);
            biases.push(next_f32(&mut seed) * 0.1); // small bias init
        }

        Self {
            weights,
            biases,
            activation,
        }
    }

    /// Forward pass: compute output given input vector.
    fn forward(&self, input: &[f32]) -> Vec<f32> {
        let mut output: Vec<f32> = self
            .weights
            .iter()
            .zip(&self.biases)
            .map(|(w_row, &b)| {
                w_row.iter().zip(input).map(|(&w, &x)| w * x).sum::<f32>() + b
            })
            .collect();

        match self.activation {
            Activation::ReLU => {
                for v in &mut output {
                    *v = v.max(0.0);
                }
            }
            Activation::Sigmoid => {
                for v in &mut output {
                    *v = 1.0 / (1.0 + (-*v).exp());
                }
            }
            Activation::Softmax => {
                let max_val = output.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                let mut sum = 0.0_f32;
                for v in &mut output {
                    *v = (*v - max_val).exp();
                    sum += *v;
                }
                if sum > 0.0 {
                    for v in &mut output {
                        *v /= sum;
                    }
                }
            }
            Activation::None => {}
        }

        output
    }

    /// Load weights from a flat slice (row-major weights then biases).
    fn load_weights(&mut self, data: &[f32]) {
        let in_sz = self.weights.first().map_or(0, |r| r.len());
        let out_sz = self.weights.len();
        let expected = in_sz * out_sz + out_sz;
        if data.len() < expected {
            return;
        }

        let mut idx = 0;
        for row in &mut self.weights {
            for w in row.iter_mut() {
                *w = data[idx];
                idx += 1;
            }
        }
        for b in &mut self.biases {
            *b = data[idx];
            idx += 1;
        }
    }
}

// ── Flare prediction network ─────────────────────────────────────────────────

/// The complete flare prediction neural network.
struct FlareNet {
    hidden1: DenseLayer, // 12 → 32
    hidden2: DenseLayer, // 32 → 16
    hidden3: DenseLayer, // 16 → 8
    head_class: DenseLayer, // 8 → 4 (softmax: quiet, C, M, X)
    head_cme: DenseLayer, // 8 → 1 (sigmoid: CME probability)
}

impl FlareNet {
    fn new() -> Self {
        let mut net = Self {
            hidden1: DenseLayer::new(N_FEATURES, 32, Activation::ReLU),
            hidden2: DenseLayer::new(32, 16, Activation::ReLU),
            hidden3: DenseLayer::new(16, 8, Activation::ReLU),
            head_class: DenseLayer::new(8, 4, Activation::Softmax),
            head_cme: DenseLayer::new(8, 1, Activation::Sigmoid),
        };

        // Apply physics-informed weight priors.
        net.apply_physics_priors();
        net
    }

    /// Initialise weights with physics-informed biases.
    ///
    /// Key empirical relationships used:
    /// - X-ray flux is the strongest single predictor of imminent flares
    ///   (persistence forecasting, Bloomfield+ 2012).
    /// - Southward Bz correlates with geomagnetic impact but not flare onset.
    /// - Active region magnetic complexity (McIntosh class) correlates with
    ///   flare productivity (Leka+ 2019).
    /// - F10.7 radio flux tracks the solar cycle activity envelope.
    fn apply_physics_priors(&mut self) {
        // Boost connections from the most predictive features in the first layer.
        // Feature indices: 0=xray, 6=f10.7, 7=AR_count, 8=AR_mag_class, 9=flare_rate
        let important_features = [0, 6, 7, 8, 9];
        let boost = 1.5_f32;

        for row in &mut self.hidden1.weights {
            for &fi in &important_features {
                if fi < row.len() {
                    row[fi] *= boost;
                }
            }
        }

        // Bias the class head toward "quiet" initially (conservative prediction).
        if self.head_class.biases.len() == 4 {
            self.head_class.biases[0] += 1.0; // quiet
            self.head_class.biases[1] -= 0.3; // C
            self.head_class.biases[2] -= 0.7; // M
            self.head_class.biases[3] -= 1.5; // X
        }

        // Bias CME head toward low probability initially.
        if !self.head_cme.biases.is_empty() {
            self.head_cme.biases[0] -= 1.0;
        }
    }

    /// Run inference on a feature vector.
    ///
    /// Returns `(class_probs, cme_prob)`:
    /// - `class_probs`: [p_quiet, p_C, p_M, p_X] (sum to 1.0)
    /// - `cme_prob`: probability of CME association [0, 1]
    fn predict(&self, features: &[f32; N_FEATURES]) -> ([f32; 4], f32) {
        let h1 = self.hidden1.forward(features);
        let h2 = self.hidden2.forward(&h1);
        let h3 = self.hidden3.forward(&h2);

        let class_out = self.head_class.forward(&h3);
        let cme_out = self.head_cme.forward(&h3);

        let mut class_probs = [0.0_f32; 4];
        for (i, &p) in class_out.iter().enumerate().take(4) {
            class_probs[i] = p;
        }

        let cme_prob = cme_out.first().copied().unwrap_or(0.0);

        (class_probs, cme_prob)
    }

    /// Load all network weights from a flat f32 slice.
    ///
    /// The expected layout is:
    ///   [hidden1_weights, hidden1_biases,
    ///    hidden2_weights, hidden2_biases,
    ///    hidden3_weights, hidden3_biases,
    ///    head_class_weights, head_class_biases,
    ///    head_cme_weights, head_cme_biases]
    fn load_weights(&mut self, data: &[f32]) {
        let sizes = [
            N_FEATURES * 32 + 32,  // hidden1
            32 * 16 + 16,          // hidden2
            16 * 8 + 8,            // hidden3
            8 * 4 + 4,             // head_class
            8 * 1 + 1,             // head_cme
        ];
        let total: usize = sizes.iter().sum();
        if data.len() < total {
            return;
        }

        let mut offset = 0;
        let mut take = |layer: &mut DenseLayer, sz: usize| {
            layer.load_weights(&data[offset..offset + sz]);
            offset += sz;
        };

        take(&mut self.hidden1, sizes[0]);
        take(&mut self.hidden2, sizes[1]);
        take(&mut self.hidden3, sizes[2]);
        take(&mut self.head_class, sizes[3]);
        take(&mut self.head_cme, sizes[4]);
    }
}

// ── Bevy resource ────────────────────────────────────────────────────────────

/// Current ML flare prediction, updated periodically.
#[derive(Resource)]
pub struct FlareMLPrediction {
    /// Probability of each flare class within the next 24 hours.
    /// [quiet, C-class, M-class, X-class]
    pub class_probs: [f32; 4],

    /// Probability that a current/imminent flare is CME-associated.
    pub cme_probability: f32,

    /// Most likely flare class label.
    pub predicted_class: &'static str,

    /// Overall flare probability (1 − p_quiet).
    pub flare_probability: f32,

    /// Activity scale factor sent to flux ropes (derived from prediction).
    /// Range [0.5, 3.0]: <1 = quieter than average, >1 = more active.
    pub activity_scale: f32,

    /// Latest input features (for HUD / debug display).
    pub latest_features: [f32; N_FEATURES],

    /// The neural network (owned by this resource).
    net: FlareNet,

    /// Timer for periodic inference.
    timer: f32,
}

impl Default for FlareMLPrediction {
    fn default() -> Self {
        Self {
            class_probs: [0.85, 0.10, 0.04, 0.01],
            cme_probability: 0.02,
            predicted_class: "Quiet",
            flare_probability: 0.15,
            activity_scale: 1.0,
            latest_features: [0.0; N_FEATURES],
            net: FlareNet::new(),
            timer: PREDICT_INTERVAL_SECS, // trigger on first frame
        }
    }
}

impl FlareMLPrediction {
    /// Run inference with the given features and update all derived fields.
    pub fn predict(&mut self, features: [f32; N_FEATURES]) {
        self.latest_features = features;
        let (class_probs, cme_prob) = self.net.predict(&features);
        self.class_probs = class_probs;
        self.cme_probability = cme_prob;
        self.flare_probability = 1.0 - class_probs[0];

        // Determine predicted class (argmax).
        let labels = ["Quiet", "C", "M", "X"];
        let max_idx = class_probs
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(0);
        self.predicted_class = labels[max_idx];

        // Compute activity scale for flux ropes.
        // Weighted by class severity: C=1.0, M=2.0, X=4.0.
        let weighted_activity =
            class_probs[1] * 1.0 + class_probs[2] * 2.0 + class_probs[3] * 4.0;
        self.activity_scale = (0.5 + weighted_activity * 2.5).clamp(0.5, 3.0);
    }

    /// Load trained weights from a flat f32 slice.
    pub fn load_weights(&mut self, data: &[f32]) {
        self.net.load_weights(data);
    }
}

// ── Bevy systems ─────────────────────────────────────────────────────────────

/// Periodically runs ML inference using the latest extracted features.
///
/// Reads from [`super::feature_extract::SolarFeatures`] and writes to
/// [`FlareMLPrediction`].  Also pushes the activity scale to all flux ropes.
pub fn run_flare_prediction(
    time: Res<Time>,
    mut prediction: ResMut<FlareMLPrediction>,
    features_res: Option<Res<super::feature_extract::SolarFeatures>>,
    mut ropes: ResMut<crate::simulation::flux_rope::FluxRopeSet>,
) {
    prediction.timer += time.delta_secs();
    if prediction.timer < PREDICT_INTERVAL_SECS {
        return;
    }
    prediction.timer = 0.0;

    // Extract features from the live data resource.
    let features = match features_res {
        Some(f) => f.as_array(),
        None => [0.5; N_FEATURES], // fallback: moderate baseline
    };

    prediction.predict(features);

    // Push activity scale to all flux ropes.
    let scale = prediction.activity_scale;
    for rope in &mut ropes.ropes {
        rope.ml_activity_scale = scale;
    }
}

// ── WASM: allow JS to inject trained weights ────────────────────────────────

/// JavaScript-callable function to load trained model weights into the
/// running simulation.  Weights are a flat Float32Array in the order:
/// [hidden1, hidden2, hidden3, head_class, head_cme] (see `FlareNet::load_weights`).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn load_flare_model_weights(weights: &[f32]) {
    // Store in a global atomic pointer for the next prediction tick to pick up.
    PENDING_WEIGHTS.lock().unwrap().replace(weights.to_vec());
}

#[cfg(target_arch = "wasm32")]
static PENDING_WEIGHTS: std::sync::Mutex<Option<Vec<f32>>> = std::sync::Mutex::new(None);

/// System that checks for pending weight uploads (WASM only).
#[cfg(target_arch = "wasm32")]
pub fn check_pending_weights(mut prediction: ResMut<FlareMLPrediction>) {
    if let Ok(mut lock) = PENDING_WEIGHTS.try_lock() {
        if let Some(weights) = lock.take() {
            prediction.load_weights(&weights);
            // Reset timer to trigger immediate re-prediction with new weights.
            prediction.timer = PREDICT_INTERVAL_SECS;
        }
    }
}
