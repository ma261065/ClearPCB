// Type declarations for the subset of the vendored fflate build that ClearPCB uses.
// TypeScript reads these instead of type-checking the vendored implementation.

export interface DeflateOptions { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; mem?: number; }
export interface InflateOptions { out?: Uint8Array; }
export interface ZipOptions extends DeflateOptions { mtime?: Date | string | number; }
export type Zippable = Record<string, Uint8Array | [Uint8Array, ZipOptions] | Zippable>;
export type Unzipped = Record<string, Uint8Array<ArrayBuffer>>;
export type FlateCallback = (err: Error | null, data: Uint8Array<ArrayBuffer>) => void;
export type UnzipCallback = (err: Error | null, data: Unzipped) => void;
export interface AsyncTerminable { (): void; }

export function deflateSync(data: Uint8Array, opts?: DeflateOptions): Uint8Array<ArrayBuffer>;
export function inflateSync(data: Uint8Array, opts?: InflateOptions): Uint8Array<ArrayBuffer>;
export function zipSync(data: Zippable, opts?: ZipOptions): Uint8Array<ArrayBuffer>;
export function unzipSync(data: Uint8Array): Unzipped;
export function zip(data: Zippable, opts: ZipOptions, cb: FlateCallback): AsyncTerminable;
export function zip(data: Zippable, cb: FlateCallback): AsyncTerminable;
export function unzip(data: Uint8Array, cb: UnzipCallback): AsyncTerminable;
export function strToU8(str: string, latin1?: boolean): Uint8Array<ArrayBuffer>;
export function strFromU8(dat: Uint8Array, latin1?: boolean): string;
