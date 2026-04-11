// Solar prediction model.
//
// Submodules:
//   solar_wind      — live NOAA wind speed pipeline → simulation bridge
//   feature_extract — live NASA/NOAA data → ML input features
//   flare_ml        — neural network flare prediction + CME probability

pub mod feature_extract;
pub mod flare_ml;
pub mod solar_wind;
