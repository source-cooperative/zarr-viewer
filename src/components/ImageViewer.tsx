import { Deck, OrthographicView } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useRef, useState } from "react";
import * as zarr from "zarrita";
import { createLogger } from "../log";
import type {
  ImageOrthographicContext,
  ImageOrthographicState,
} from "../zarr/profiles/image-orthographic/types";
import { toGrayscaleRgba } from "./image-normalize";

const log = createLogger("image-viewer");

/** Standalone deck.gl `OrthographicView` host for non-geographic OME-Zarr
 * images. Loads the profile's coarse pyramid level for the selected channel,
 * normalizes it to a grayscale RGBA image, and paints it with a single
 * `BitmapLayer` in pixel-space coordinates. No basemap, no reprojection.
 *
 * MVP: one channel, whole coarse level, no tiling/hover. */
export function ImageViewer({
  ctx,
  state,
  opacity,
}: {
  ctx: ImageOrthographicContext;
  state: ImageOrthographicState;
  opacity: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deckRef = useRef<Deck<OrthographicView> | null>(null);
  const [image, setImage] = useState<ImageData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const { width, height } = ctx;

  // Create the Deck instance once, fit the image to the container. The image
  // spans world coords x:[0,width], y:[0,height]; with flipY (default) the
  // origin is top-left so row 0 paints at the top.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || width === 0 || height === 0) return;
    const cw = wrap.clientWidth || 800;
    const ch = wrap.clientHeight || 600;
    // OrthographicView: screen px = world units · 2^zoom. Fit both axes with a
    // little padding.
    const fitZoom = Math.log2(Math.min(cw / width, ch / height) * 0.92);

    const deck = new Deck<OrthographicView>({
      canvas,
      views: new OrthographicView({ id: "ortho" }),
      controller: true,
      initialViewState: {
        target: [width / 2, height / 2, 0],
        zoom: fitZoom,
        minZoom: fitZoom - 2,
        maxZoom: 8,
      },
      layers: [],
    });
    deckRef.current = deck;
    log.info(`ortho host ${width}×${height}px, fitZoom=${fitZoom.toFixed(2)}`);
    return () => {
      deck.finalize();
      deckRef.current = null;
    };
  }, [width, height]);

  // Load the selected channel's pixels from the coarse level and normalize to
  // a grayscale RGBA image using the omero display window (falls back to the
  // data min/max when no window is given).
  useEffect(() => {
    const ctrl = new AbortController();
    setStatus("loading");
    (async () => {
      try {
        // Pin channel + any leading (z/t) axes; take the full spatial pair.
        const sel: (number | null)[] = ctx.axes.map((_, i) => {
          if (i === ctx.spatialAxes.yIndex || i === ctx.spatialAxes.xIndex) {
            return null;
          }
          if (i === ctx.channelAxisIndex) return state.channel;
          return 0; // MVP pins z/t to index 0
        });
        const chunk = await zarr.get(
          ctx.coarseArray as zarr.Array<zarr.NumberDataType, zarr.Readable>,
          sel,
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted) return;
        const data = chunk.data as ArrayLike<number>;
        const win = ctx.channels[state.channel];
        const rgba = toGrayscaleRgba(data, width, height, win?.start, win?.end);
        setImage(new ImageData(rgba, width, height));
        setStatus("ready");
      } catch (err) {
        if (ctrl.signal.aborted) return;
        log.error("channel load failed", err);
        setStatus("error");
      }
    })();
    return () => ctrl.abort();
  }, [ctx, state.channel, width, height]);

  const layers = useMemo(() => {
    if (!image) return [];
    return [
      new BitmapLayer({
        id: "ome-image",
        image,
        // bounds [left, bottom, right, top]; top=0 puts image row 0 at the
        // top under flipY. (If it renders upside down on first view, swap the
        // 2nd/4th values.)
        bounds: [0, height, width, 0],
        opacity,
      }),
    ];
  }, [image, width, height, opacity]);

  // Push layer updates to the imperative Deck instance.
  useEffect(() => {
    deckRef.current?.setProps({ layers });
  }, [layers]);

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
    </div>
  );
}
