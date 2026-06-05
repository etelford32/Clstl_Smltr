# Earth hi-res textures (zoom LOD)

Higher-resolution surface imagery, loaded lazily by earth.html when the
camera zooms close (see js/earth-skin.js `loadEarthHiRes` / EARTH_TEXTURES_HI).
Vendored locally — same-origin, no CDN dependency.

| File | Size | Channel |
|---|---|---|
| day-8k.jpg  | 8192x4096 | daytime albedo (Blue Marble) |
| topo-8k.jpg | 8192x4096 | elevation/bump (drives shader relief) |

Source: Solar System Scope texture set, via the franky-adl/threejs-earth
repository. Solar System Scope textures are licensed CC BY 4.0
(https://www.solarsystemscope.com/textures/). topo downsampled from
10800x5400 to 8192x4096 to fit GPU max-texture-size budgets.

Night lights remain at the 4K three-globe set (js/vendor/three-globe-2.31.0)
— night detail is diffuse and indistinguishable at 8K.
