/**
 * GFZ Potsdam ap → Kp conversion. The Kp index is a quasi-logarithmic 0..9
 * scale in thirds (0, 0+, 1-, 1, ..., 9); ap is the corresponding linear
 * amplitude in 2 nT units. The canonical lookup is a 28-entry step table:
 * ap is the floor threshold, Kp is the step value (in one-third units as a
 * decimal for downstream normalisation).
 *
 * Reference: Bartels et al. (1939); GFZ Kp index documentation.
 *   https://kp.gfz-potsdam.de/en/data
 */

const TABLE = [
    [0,   0.00], [2,   0.33], [3,   0.67], [4,   1.00],
    [5,   1.33], [6,   1.67], [7,   2.00], [9,   2.33],
    [12,  2.67], [15,  3.00], [18,  3.33], [22,  3.67],
    [27,  4.00], [32,  4.33], [39,  4.67], [48,  5.00],
    [56,  5.33], [67,  5.67], [80,  6.00], [94,  6.33],
    [111, 6.67], [132, 7.00], [154, 7.33], [179, 7.67],
    [207, 8.00], [236, 8.33], [300, 8.67], [400, 9.00],
];

/** ap (linear amplitude) → Kp (0..9, in third-steps). Returns null on null input. */
export function apToKp(ap) {
    if (ap == null || !Number.isFinite(ap)) return null;
    let kp = TABLE[0][1];
    for (const [thresh, k] of TABLE) {
        if (ap >= thresh) kp = k;
        else break;
    }
    return kp;
}
