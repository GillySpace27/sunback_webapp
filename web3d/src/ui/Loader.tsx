// The load state is Act One: a dark frame with a single igniting point.
// Shown while the heavy 3D chunk streams in.
export default function Loader() {
  return (
    <div className="loader" role="status" aria-live="polite">
      <span className="loader-spark" aria-hidden="true" />
      <span className="visually-hidden">Loading My Heliograph</span>
    </div>
  );
}
