// The load state is Act One: a dark frame with a single igniting point.
// Shown while the heavy 3D chunk streams in.
// The film's very first frame.
//
// The 3D bundle is code-split, so for the first seconds of a cold landing
// there is no WebGL canvas at ALL — and the loader that stood in for it was a
// spark on black, which meant the page opened on an empty void under a
// headline promising a Sun (audit in Chrome, 2026-08-26). Nothing the texture
// loaders do can fix that: they live inside the chunk that has not arrived.
//
// So the poster is plain DOM. It is the same 24 KB baked 171 A disk the scene
// itself opens on (see useSunTextureLoader's OPENING_SUN), preloaded at parse
// time from index.html, so it paints about as early as the browser can paint
// anything — and the canvas then dissolves in over the identical image, which
// is why the handoff is invisible rather than a swap.
export default function Loader() {
  return (
    <div className="loader" role="status" aria-live="polite">
      <img
        className="loader-poster"
        src={`${import.meta.env.BASE_URL}sun_171.webp`}
        alt=""
        aria-hidden="true"
        decoding="async"
        /* eslint-disable-next-line react/no-unknown-property */
        fetchPriority="high"
      />
      <span className="loader-spark" aria-hidden="true" />
      <span className="visually-hidden">Loading My Heliograph</span>
    </div>
  );
}
