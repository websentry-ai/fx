import {
  createFxAgent as createWasmAgent,
  createFxTerminal as createWasmTerminal,
  encodeXtermKeyEvent,
  fxSdkApiVersion,
  listModels,
  supportsJspi,
  xtermAdapter,
} from "./fx-sdk.js";

export { encodeXtermKeyEvent, fxSdkApiVersion, listModels, supportsJspi, xtermAdapter };
export const libfxApiVersion = 2;

// Unbound fork: plain paths, not module-relative URLs. A host that bundles this
// file has the wasm on its own origin, and `new URL(..., import.meta.url)` makes
// the bundler resolve an artifact that does not sit beside the module. Every
// host here passes `wasm` anyway, so these are the last resort.
const defaultCoreWasm = "/fx-core.wasm";
const defaultTermWasm = "/fx-term.wasm";

export function createFxAgent(options = {}) {
  return createWasmAgent({ ...options, wasm: options.wasm ?? defaultCoreWasm });
}

export function createFxTerminal(options = {}) {
  return createWasmTerminal({ ...options, wasm: options.wasm ?? defaultTermWasm });
}
