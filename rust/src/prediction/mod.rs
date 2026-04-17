// Solar prediction model.
//
// Submodules:
//   solar_wind      — live NOAA wind speed pipeline → simulation bridge
//   feature_extract — live NASA/NOAA data → ML input features
//   flare_ml        — neural network flare prediction + CME probability

// The prediction pipeline is scaffolded ahead of the live NOAA/NASA
// integrations — some items (API polling constants, weight-loading methods,
// intermediate raw-feature structs) are plumbed in but not yet wired from
// callers. #[allow(dead_code)] keeps compile output clean until the native
// integration is finished. Remove once everything is exercised.
#[allow(dead_code)]
pub mod feature_extract;
#[allow(dead_code)]
pub mod flare_ml;
#[allow(dead_code)]
pub mod solar_wind;
