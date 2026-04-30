// Minimal Bevy WASM loader
let wasm;
let wasmMemory;

const imports = {
    wbg: {
        __wbindgen_throw: function(ptr, len) {
            throw new Error(getStringFromWasm(ptr, len));
        },
        __wbindgen_object_drop_ref: function() {},
        __wbindgen_cb_drop: function() { return 0; },
        __wbindgen_string_new: function(ptr, len) {
            return getStringFromWasm(ptr, len);
        },
        __wbindgen_is_undefined: function(idx) {
            return getObject(idx) === undefined;
        },
        __wbg_instanceof_Window_f401953a2cf86220: function() { return true; },
        __wbg_document_5aff8cd83ef968f5: function(arg0) {
            return addToExternrefTable0(document);
        },
        __wbg_createElement_5921e9eb06b9ec89: function(arg0, arg1, arg2) {
            try {
                const tag = getStringFromWasm(arg1, arg2);
                return addToExternrefTable0(document.createElement(tag));
            } catch(e) {
                console.error('createElement error:', e);
                return 0;
            }
        },
        __wbg_getElementById_c369ff43f0db99cf: function(arg0, arg1, arg2) {
            const id = getStringFromWasm(arg1, arg2);
            const el = document.getElementById(id);
            return el ? addToExternrefTable0(el) : 0;
        },
        __wbg_appendChild_580ccb11a660db68: function(arg0, arg1) {
            try {
                getObject(arg0).appendChild(getObject(arg1));
            } catch(e) {
                console.error('appendChild error:', e);
            }
        },
        __wbg_setAttribute_d5540a19be09f8dc: function(arg0, arg1, arg2, arg3, arg4) {
            try {
                const name = getStringFromWasm(arg1, arg2);
                const value = getStringFromWasm(arg3, arg4);
                getObject(arg0).setAttribute(name, value);
            } catch(e) {
                console.error('setAttribute error:', e);
            }
        },
        __wbg_setwidth_83d936c4b04dcbec: function(arg0, arg1) {
            getObject(arg0).width = arg1;
        },
        __wbg_setheight_6025ba0d58e6cc8c: function(arg0, arg1) {
            getObject(arg0).height = arg1;
        },
        __wbg_getContext_dfc91ab0837db1d1: function(arg0, arg1, arg2) {
            try {
                const type = getStringFromWasm(arg1, arg2);
                const ctx = getObject(arg0).getContext(type);
                return ctx ? addToExternrefTable0(ctx) : 0;
            } catch(e) {
                console.error('getContext error:', e);
                return 0;
            }
        },
        __wbg_instanceof_CanvasRenderingContext2d_a0c4f0da6392b8ca: function() { return true; },
        __wbg_body_be46234bb33edd63: function(arg0) {
            const body = document.body;
            return body ? addToExternrefTable0(body) : 0;
        },
        __wbg_createElement_8bae7856a4bb7411: function(arg0, arg1, arg2) {
            const tag = getStringFromWasm(arg1, arg2);
            return addToExternrefTable0(document.createElement(tag));
        },
        __wbg_newnoargs_c62ea9419c21fbac: function(arg0, arg1) {
            return addToExternrefTable0(new Function(getStringFromWasm(arg0, arg1)));
        },
        __wbg_call_90c26b09837aba1c: function(arg0, arg1) {
            try {
                return addToExternrefTable0(getObject(arg0).call(getObject(arg1)));
            } catch(e) {
                return 0;
            }
        },
        __wbg_new_9fb8d994e1c0aaac: function() {
            return addToExternrefTable0(new Object());
        },
        __wbg_self_f0e34d89f33b99fd: function() {
            return addToExternrefTable0(self);
        },
        __wbg_window_d3b084224f4774d7: function() {
            return addToExternrefTable0(window);
        },
        __wbg_globalThis_9caa27ff917c6860: function() {
            return addToExternrefTable0(globalThis);
        },
        __wbg_global_35dfdd59a4da3e74: function() {
            return addToExternrefTable0(global);
        },
        __wbindgen_debug_string: function() {},
        __wbindgen_object_clone_ref: function(arg0) {
            return addToExternrefTable0(getObject(arg0));
        },
        __wbindgen_is_object: function(arg0) {
            return typeof getObject(arg0) === 'object' && getObject(arg0) !== null;
        },
        __wbindgen_is_string: function(arg0) {
            return typeof getObject(arg0) === 'string';
        },
        __wbindgen_number_new: function(arg0) {
            return addToExternrefTable0(arg0);
        },
        __wbindgen_number_get: function(arg0, arg1) {
            const obj = getObject(arg1);
            return typeof obj === 'number' ? obj : undefined;
        },
        __wbindgen_boolean_get: function(arg0) {
            const v = getObject(arg0);
            return typeof v === 'boolean' ? (v ? 1 : 0) : 2;
        },
        __wbg_log_c9486ca5d8e2cbe8: function(arg0, arg1) {
            console.log(getStringFromWasm(arg0, arg1));
        },
        __wbg_mark_40e050a77cc39fea: function(arg0, arg1) {
            performance.mark(getStringFromWasm(arg0, arg1));
        },
        __wbg_measure_aa7a73f17813f708: function(arg0, arg1, arg2, arg3) {
            try {
                const name = getStringFromWasm(arg0, arg1);
                const start = getStringFromWasm(arg2, arg3);
                performance.measure(name, start);
            } catch(e) {}
        },
        __wbg_performance_a1b8bde2ee512264: function(arg0) {
            return addToExternrefTable0(performance);
        },
        __wbg_now_abd80e969af37148: function(arg0) {
            return performance.now();
        },
        __wbindgen_jsval_loose_eq: function(arg0, arg1) {
            return getObject(arg0) == getObject(arg1);
        },
        __wbg_String_88810dfeb4021902: function(arg0, arg1) {
            return addToExternrefTable0(String(getObject(arg1)));
        },
        __wbg_set_f975102236d3c502: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1] = getObject(arg2);
        },
        __wbg_randomFillSync_5c9c955aa56b6049: function() {},
        __wbg_getRandomValues_3aa56aa6edec874c: function() {},
        __wbg_crypto_566d7465cdbb6b7a: function(arg0) {
            return addToExternrefTable0(crypto);
        },
        __wbg_process_dc09a8c7d59982f6: function(arg0) {
            return addToExternrefTable0(process);
        },
        __wbg_versions_d98c6400c6ca2bd8: function(arg0) {
            return addToExternrefTable0(process.versions);
        },
        __wbg_node_caaf83d002149bd5: function(arg0) {
            return addToExternrefTable0(process.versions.node);
        },
        __wbg_msCrypto_0b84745e9245cdf6: function(arg0) {
            return addToExternrefTable0(crypto.msCrypto);
        },
        __wbg_require_94a9da52636aacbf: function() { return 0; },
        __wbg_getRandomValues_805f1c3d65988a5a: function(arg0, arg1) {
            crypto.getRandomValues(getArrayU8FromWasm(arg0, arg1));
        },
        __wbindgen_memory: function() {
            return addToExternrefTable0(wasm.memory);
        },
        __wbg_buffer_085ec1f694018c4f: function(arg0) {
            return addToExternrefTable0(getObject(arg0).buffer);
        },
        __wbg_newwithbyteoffsetandlength_6da8e527659b86aa: function(arg0, arg1, arg2) {
            return addToExternrefTable0(new Uint8Array(getObject(arg0), arg1, arg2));
        },
        __wbg_new_8125e318e6245eed: function(arg0) {
            return addToExternrefTable0(new Uint8Array(getObject(arg0)));
        },
        __wbg_set_5cf90238115182c3: function(arg0, arg1, arg2) {
            getObject(arg0).set(getObject(arg1), arg2);
        },
        __wbg_length_72e2208bbc0efc61: function(arg0) {
            return getObject(arg0).length;
        },
        __wbindgen_throw: function(arg0, arg1) {
            throw new Error(getStringFromWasm(arg0, arg1));
        }
    }
};

const externrefTable0 = [];
let externrefTableIdx0 = 0;

function addToExternrefTable0(obj) {
    if (externrefTableIdx0 === externrefTable0.length) {
        externrefTable0.push(obj);
    } else {
        externrefTable0[externrefTableIdx0] = obj;
    }
    return externrefTableIdx0++;
}

function getObject(idx) {
    return externrefTable0[idx];
}

const cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

function getStringFromWasm(ptr, len) {
    return cachedTextDecoder.decode(getUint8Memory().subarray(ptr, ptr + len));
}

function getArrayU8FromWasm(ptr, len) {
    return getUint8Memory().subarray(ptr, ptr + len);
}

let cachegetUint8Memory = null;
function getUint8Memory() {
    if (cachegetUint8Memory === null || cachegetUint8Memory.buffer !== wasm.memory.buffer) {
        cachegetUint8Memory = new Uint8Array(wasm.memory.buffer);
    }
    return cachegetUint8Memory;
}

async function init(input) {
    if (typeof input === 'undefined') {
        input = new URL('star_renderer_bg.wasm', import.meta.url);
    }

    const { instance, module } = await load(await input, imports);

    wasm = instance.exports;
    init.__wbindgen_wasm_module = module;

    return wasm;
}

async function load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                console.warn('instantiateStreaming failed:', e);
                const bytes = await module.arrayBuffer();
                return await WebAssembly.instantiate(bytes, imports);
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

export default init;
