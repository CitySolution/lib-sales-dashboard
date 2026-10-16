// SheetJS in Node: the same vendored copy the page loads as a plain script.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = { Uint8Array, ArrayBuffer, DataView, Buffer, TextDecoder, TextEncoder, console, Date, Math };
vm.runInNewContext(readFileSync(new URL('../site/vendor/xlsx.full.min.js', import.meta.url), 'utf8'), ctx);
export const XLSX = ctx.XLSX;
