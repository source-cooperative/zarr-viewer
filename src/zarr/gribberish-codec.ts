/**
 * A zarrita `array_to_bytes` codec that decodes GRIB2 message bytes into a
 * typed array, backed by the `@mattnucc/gribberish` bindings (native in Node,
 * WASM in the browser).
 *
 * This mirrors gribberish's own Python numcodecs `GribberishCodec`
 * (python/gribberish/zarr/codec.py): each stored chunk is one GRIB2 message;
 * data variables decode via `dataAdjusted(adjust_longitude_range, north_up)`,
 * and the synthetic `latitude`/`longitude` variables come from `latlngAdjusted`.
 *
 * dynamical.org's virtual GRIB stores (e.g. NOAA HRRR) declare this codec as
 * the array_to_bytes step, typically preceded by a `scale_offset` array_to_array
 * codec (e.g. Kelvin -> degrees Celsius), which zarrita applies after us.
 *
 * Registering the codec in `zarr.registry` is sufficient for both rendering
 * (the tile loaders read chunks through `zarr.get` -> the codec pipeline) and
 * the `assertCodecsSupported` gate (it checks `zarr.registry.has`).
 *
 * This module statically imports the gribberish binding (and, in the browser,
 * its WASM), so it is loaded lazily via dynamic import from
 * {@link installGribberishCodec} — non-GRIB stores never pull it in.
 */
import { GribMessage } from "@mattnucc/gribberish";

// Minimal dtype -> TypedArray constructor map. GRIB decodes to float; dynamical
// stores use float64/float32 (the coordinate helper path may hit either). We
// avoid importing zarrita's internal `getCtr`/`getStrides` helpers.
const CTORS: Partial<Record<string, new (length: number) => ArrayBufferView>> = {
  float64: Float64Array,
  float32: Float32Array,
  int64: BigInt64Array,
  int32: Int32Array,
  int16: Int16Array,
  int8: Int8Array,
  uint64: BigUint64Array,
  uint32: Uint32Array,
  uint16: Uint16Array,
  uint8: Uint8Array,
};

// C-order (row-major) strides for a chunk shape.
function cStrides(shape: readonly number[]): number[] {
  const stride = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    stride[i] = acc;
    acc *= shape[i]!;
  }
  return stride;
}

type GribberishConfig = {
  var?: string | null;
  adjust_longitude_range?: boolean;
  north_up?: boolean;
};

type ChunkMeta = { dataType: string; shape: number[] };

export class GribberishCodec {
  kind = "array_to_bytes" as const;

  #var: string | null;
  #adjustLon: boolean;
  #northUp: boolean;
  #ctor: new (length: number) => ArrayBufferView;
  #shape: number[];
  #stride: number[];

  constructor(config: GribberishConfig, meta: ChunkMeta) {
    this.#var = config?.var ?? null;
    this.#adjustLon = Boolean(config?.adjust_longitude_range);
    this.#northUp = Boolean(config?.north_up);
    const ctor = CTORS[meta.dataType];
    if (!ctor) {
      throw new Error(`gribberish codec: unsupported data type ${meta.dataType}`);
    }
    this.#ctor = ctor;
    this.#shape = meta.shape;
    this.#stride = cStrides(meta.shape);
  }

  static fromConfig(config: GribberishConfig, meta: ChunkMeta): GribberishCodec {
    return new GribberishCodec(config, meta);
  }

  encode(): never {
    throw new Error("gribberish codec is read-only (decode only)");
  }

  decode(bytes: Uint8Array): {
    data: ArrayBufferView;
    shape: number[];
    stride: number[];
  } {
    let values: ArrayLike<number>;
    if (this.#var === "latitude" || this.#var === "longitude") {
      const msg = GribMessage.parseFromBuffer(bytes, 0);
      const latlng = msg.latlngAdjusted(this.#adjustLon, this.#northUp);
      values = this.#var === "latitude" ? latlng.latitude : latlng.longitude;
    } else {
      const msg = GribMessage.parseFromBuffer(bytes, 0);
      values = msg.dataAdjusted(this.#adjustLon, this.#northUp);
    }
    // Copy into the array's native dtype. gribberish returns JS numbers, so
    // integer dtypes go through the BigInt/Number constructors as needed.
    const out = new this.#ctor(values.length) as ArrayBufferView & {
      [i: number]: number | bigint;
    };
    const isBig = out instanceof BigInt64Array || out instanceof BigUint64Array;
    for (let i = 0; i < values.length; i++) {
      out[i] = isBig ? BigInt(Math.trunc(values[i]!)) : values[i]!;
    }
    return { data: out, shape: this.#shape, stride: this.#stride };
  }
}
