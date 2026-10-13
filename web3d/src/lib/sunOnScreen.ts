// Where the film's Sun is on screen, in CSS px, written every frame by
// three/Sun.tsx and read by ui/Prologue.tsx so the flight lands exactly on it.
// Its own module so the prologue can read it without pulling in three.js.
// r stays 0 until the 3D scene has drawn a frame.
export const sunOnScreen = { x: 0, y: 0, r: 0 };
