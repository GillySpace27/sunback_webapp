// Solar rotation, shared by the loader (which decides when to re-anchor) and
// the Sun shader (which does the re-projection).
//
// 27.2753 days is the SYNODIC Carrington period: the Sun's rotation as seen
// from a moving Earth. That is the one an observer measures, and therefore the
// one that matches what consecutive AIA frames actually show. The sidereal
// period (25.38 d) would be the right number for a frame fixed to the stars
// and the wrong one here.
export const SYNODIC_DAYS = 27.2753;

/** Rotation phase for a date, in radians. Only differences are meaningful. */
export function spinPhase(dateStr: string): number {
  const ms = new Date(`${dateStr || "2015-01-01"}T12:00:00Z`).getTime();
  return Number.isNaN(ms) ? 0 : (ms / 86400000 / SYNODIC_DAYS) * Math.PI * 2;
}

/** Which date a bound texture is a photograph OF, read off its own request URL.
 *
 * Deliberately derived rather than tracked in the store: the URL is generated
 * from the identity (see thumbUrl), so it cannot drift out of sync with the
 * pixels the way a parallel piece of state can. */
export function textureDate(t: unknown): string | null {
  const src = (t as { image?: { src?: string } } | null)?.image?.src ?? "";
  return src.match(/date=(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

/** How far the Sun has turned between a photograph and the date on screen. */
export function relativeSpin(tex: unknown, date: string): number {
  const shot = textureDate(tex);
  return shot ? spinPhase(date) - spinPhase(shot) : 0;
}
