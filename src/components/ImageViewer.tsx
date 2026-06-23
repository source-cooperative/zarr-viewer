import { Deck, OrthographicView } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useRef, useState } from "react";
import * as zarr from "zarrita";
import { formatNumber } from "./RangeSlider";
import { createLogger } from "../log";
import {
  type AutoStats,
  type BandStats,
  buildBandStats,
  percentileFromHistogram,
} from "../render/stats";
import { buildSelection, pickLevelForZoom } from "../zarr/profiles/image-orthographic/lod";
import type {
  ImageOrthographicContext,
  ImageOrthographicState,
} from "../zarr/profiles/image-orthographic/types";
import { loadColormapLut } from "./colormap-lut";
import { styleToRgba } from "./image-normalize";

const log = createLogger("image-viewer");

/** A decoded level slice: the raw samples (for restyling + hover) plus its
 * intensity stats. Styling is applied separately so colormap/rescale/gamma
 * tweaks never refetch. */
type RawTexture = {
  raw: ArrayLike<number>;
  width: number;
  height: number;
  downsample: number;
  level: number;
  stats: BandStats | null;
};

type HoverInfo = { x: number; y: number; col: number; row: number; value: number };

/** Resolve the display window: explicit rescale wins; else a 2–98% percentile
 * of the auto-stats; else the current slice's own min/max; else [0,1]. */
function resolveRescale(
  rmin: number | undefined,
  rmax: number | undefined,
  autoStats: AutoStats | null,
  current: RawTexture | null,
): [number, number] {
  if (rmin !== undefined && rmax !== undefined) return [rmin, rmax];
  if (autoStats?.global) {
    return [
      percentileFromHistogram(autoStats.global, 0.02),
      percentileFromHistogram(autoStats.global, 0.98),
    ];
  }
  if (current?.stats) return [current.stats.min, current.stats.max];
  return [0, 1];
}

/** Standalone deck.gl `OrthographicView` host for non-geographic OME-Zarr
 * images. Picks the pyramid level matching the current zoom (LOD), paints it
 * over a constant pixel-space extent, and applies colormap/rescale/gamma on the
 * CPU. Hover reads the raw intensity under the cursor. Loads each level whole
 * (fits microscopy wells; not gigapixel whole-slides). */
export function ImageViewer({
  ctx,
  state,
  opacity,
  autoStats,
}: {
  ctx: ImageOrthographicContext;
  state: ImageOrthographicState;
  opacity: number;
  autoStats: AutoStats | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deckRef = useRef<Deck<OrthographicView> | null>(null);
  const sampleRef = useRef<RawTexture | null>(null); // read by hover handler
  const cacheRef = useRef<Map<string, RawTexture>>(new Map());

  const [zoom, setZoom] = useState<number | null>(null);
  const [current, setCurrent] = useState<RawTexture | null>(null);
  const [lut, setLut] = useState<Uint8Array | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const { width, height } = ctx; // finest-level extent = world coords
  const downsamples = useMemo(() => ctx.levels.map((l) => l.downsample), [ctx.levels]);
  const indicesKey = JSON.stringify(state.indices);

  // Create the Deck instance once. View is uncontrolled (deck's controller owns
  // pan/zoom); we observe zoom for LOD and the cursor for hover.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || width === 0 || height === 0) return;
    const cw = wrap.clientWidth || 800;
    const ch = wrap.clientHeight || 600;
    const fitZoom = Math.log2(Math.min(cw / width, ch / height) * 0.92);
    setZoom(fitZoom);

    const deck = new Deck<OrthographicView>({
      canvas,
      views: new OrthographicView({ id: "ortho" }),
      controller: true,
      initialViewState: {
        target: [width / 2, height / 2, 0],
        zoom: fitZoom,
        minZoom: fitZoom - 1,
        maxZoom: 8,
      },
      layers: [],
      getCursor: ({ isDragging }) => (isDragging ? "grabbing" : "crosshair"),
      onViewStateChange: ({ viewState }) => {
        const z = (viewState as { zoom: number }).zoom;
        setZoom((prev) =>
          prev != null && Math.round(prev * 10) === Math.round(z * 10) ? prev : z,
        );
      },
      onHover: (info) => {
        const tex = sampleRef.current;
        const coord = info.coordinate;
        if (!tex || !coord) {
          setHover(null);
          return;
        }
        const col = Math.floor(coord[0]!);
        const row = Math.floor(coord[1]!);
        if (col < 0 || col >= width || row < 0 || row >= height) {
          setHover(null);
          return;
        }
        const lc = Math.min(tex.width - 1, Math.floor(col / tex.downsample));
        const lr = Math.min(tex.height - 1, Math.floor(row / tex.downsample));
        setHover({ x: info.x, y: info.y, col, row, value: Number(tex.raw[lr * tex.width + lc]) });
      },
    });
    deckRef.current = deck;
    log.info(`ortho host ${width}×${height}px, fitZoom=${fitZoom.toFixed(2)}`);
    return () => {
      deck.finalize();
      deckRef.current = null;
    };
  }, [width, height]);

  const targetLevel =
    zoom == null ? ctx.levels.length - 1 : pickLevelForZoom(zoom, downsamples);

  // Load the selected level + channel + z/t slice (raw + stats), and cache it.
  // The previous slice stays painted until the new one is ready.
  useEffect(() => {
    const level = ctx.levels[targetLevel];
    if (!level) return;
    const key = `${targetLevel}|${state.channel}|${indicesKey}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      sampleRef.current = cached;
      setCurrent(cached);
      setStatus("ready");
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        const sel = buildSelection(
          ctx.axes,
          ctx.channelAxisIndex,
          ctx.spatialAxes,
          state.channel,
          state.indices,
        );
        const chunk = await zarr.get(
          level.array as zarr.Array<zarr.NumberDataType, zarr.Readable>,
          sel,
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted) return;
        const raw = chunk.data as ArrayLike<number>;
        const tex: RawTexture = {
          raw,
          width: level.width,
          height: level.height,
          downsample: level.downsample,
          level: targetLevel,
          stats: buildBandStats(raw, null),
        };
        cacheRef.current.set(key, tex);
        sampleRef.current = tex;
        setCurrent(tex);
        setStatus("ready");
      } catch (err) {
        if (ctrl.signal.aborted) return;
        log.error("level load failed", err);
        setStatus("error");
      }
    })();
    return () => ctrl.abort();
    // state.indices read inside; its value is captured by indicesKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, targetLevel, state.channel, indicesKey]);

  // Drop the cache when the store changes.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      cache.clear();
      sampleRef.current = null;
    };
  }, [ctx]);

  // Load the colormap LUT (null = grayscale fallback / "gray" handled by LUT).
  useEffect(() => {
    let cancelled = false;
    loadColormapLut(state.colormap)
      .then((l) => {
        if (!cancelled) setLut(l);
      })
      .catch(() => {
        if (!cancelled) setLut(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.colormap]);

  // Build the styled ImageData from the raw slice — recomputed on styling
  // changes (no refetch). Primitive deps so it doesn't rerun every render.
  const rmin = state.rescale?.[0];
  const rmax = state.rescale?.[1];
  const image = useMemo(() => {
    if (!current) return null;
    const [mn, mx] = resolveRescale(rmin, rmax, autoStats, current);
    const rgba = styleToRgba(current.raw, current.width, current.height, mn, mx, state.gamma, lut);
    return new ImageData(rgba, current.width, current.height);
  }, [current, rmin, rmax, state.gamma, lut, autoStats]);

  // Push the styled texture to Deck as a single BitmapLayer over the constant
  // finest-pixel extent.
  useEffect(() => {
    if (!image || !current) return;
    deckRef.current?.setProps({
      layers: [
        new BitmapLayer({
          id: `ome-L${current.level}`,
          image,
          // bounds [left, bottom, right, top]; top=0 → row 0 at top under flipY.
          bounds: [0, height, width, 0],
          opacity,
        }),
      ],
    });
  }, [image, current, opacity, width, height]);

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, background: "#000" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />

      {status !== "ready" && (
        <div
          className="panel mono"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            padding: "6px 10px",
            fontSize: 12,
            color: status === "error" ? "var(--danger, #f66)" : undefined,
          }}
        >
          {status === "error" ? "Failed to load image" : "Loading image…"}
        </div>
      )}

      {hover && (
        <div
          style={{
            position: "absolute",
            left: hover.x + 14,
            top: hover.y + 14,
            zIndex: 16,
            pointerEvents: "none",
            maxWidth: 280,
          }}
        >
          <div
            className="panel mono"
            style={{ padding: "4px 8px", fontSize: 11, lineHeight: 1.4, whiteSpace: "nowrap" }}
          >
            <div>{ctx.channels[state.channel]?.label ?? `channel ${state.channel}`}</div>
            <div>{formatNumber(hover.value)}</div>
            <div style={{ color: "var(--text-muted)" }}>
              x {hover.col}, y {hover.row}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
