"""
Gated MLP + LSTM residual predictor for the thermosphere surrogate.

This subpackage trains a two-tier residual-correction model on the CSVs
produced by `dsmc.pipeline.jacchia_residuals` and `dsmc.pipeline.jacchia_timeseries`.

The architecture follows the cross-event analysis (see
`data/jacchia_residuals/cross_event_summary.md`):

  * MLP head      → feed-forward, sees only instantaneous features.
                    Handles quiet/unsettled regime (Ap < 80) which is
                    ~95% of the operational duty cycle.

  * LSTM head     → 1-layer recurrent net over a 24 h Ap/F10.7 history.
                    Captures the nonlinear temporal coupling that emerges
                    on extreme storms (Gannon, Halloween) where the
                    interaction-term ΔR² beats linear-lag ΔR² by 3×.

  * GatedPredictor → hard threshold on Ap_t. Inference cost in the
                    quiet regime stays at a small MLP forward pass;
                    LSTM only runs when the storm gate fires.

The skill metric is RMSE of `log10(ρ_jacchia / ρ_msis) − f(features)`.
The trivial baseline (corrector ≡ 0, i.e. surrogate alone) sets the
ceiling we have to beat; the cross-event analysis sets the floor any
useful model has to clear.
"""
