/**
 * Minimal streaming CSV reader for heliochronicles data files.
 *
 * Upstream CSVs are machine-written (data/heliochronicles/scripts/lib/csv.mjs):
 * unquoted ASCII fields, comma-separated, one header line, LF terminated,
 * empty strings for nulls. Quoting is only used for cells containing
 * commas/quotes/newlines — the upstream schemas never emit those in practice,
 * but we handle RFC-4180 quoting defensively.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Async generator yielding one row object per data line. */
export async function* streamCsv(filePath) {
    const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    let header = null;
    for await (const rawLine of rl) {
        if (rawLine === '') continue;
        const fields = splitCsvLine(rawLine);
        if (!header) { header = fields; continue; }
        const row = {};
        for (let i = 0; i < header.length; i++) row[header[i]] = fields[i] ?? '';
        yield row;
    }
}

function splitCsvLine(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === '"') {
            let v = '';
            i++;
            while (i < line.length) {
                if (line[i] === '"' && line[i + 1] === '"') { v += '"'; i += 2; }
                else if (line[i] === '"') { i++; break; }
                else { v += line[i++]; }
            }
            out.push(v);
            if (line[i] === ',') i++;
        } else {
            const end = line.indexOf(',', i);
            if (end === -1) { out.push(line.slice(i)); break; }
            out.push(line.slice(i, end));
            i = end + 1;
        }
    }
    return out;
}

/** Parse a CSV cell as a finite number, or null for empty / non-numeric. */
export function numOrNull(s) {
    if (s == null || s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}
