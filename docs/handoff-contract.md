# Store link handoff contract

Links that send a person from the Sun pages, the wall or Heliogram to the My Heliogram store on the
image they are looking at. Producers: Heliogram (`Store.swift`), gilly.space (`assets/sun.js`
`SunData.storeLink`, SU-17). Consumer: `api/solar-archive.js`.

## Query parameters

| Parameter | Meaning |
|---|---|
| `utm_source` | Who sent the visitor: `heliogram`, `sun` (gilly.space/sun.html) or `wall`. Counts the funnel. |
| `d` | Date, `YYYY-MM-DD`, UTC (the imagery's own clock). |
| `t` | Time, `HH:mm`, UTC. Written with its colon. |
| `wl` | AIA wavelength id (`171`, `304`, ...). Only for numeric ids; rainbow, `composite_uv` and `dem` send the date alone. |

Rules: `wl` travels only beside a valid `d`; a link with no usable time is the plain store address plus
`utm_source`. The store reads `d`, `t` and `wl` in `_shareParams` (`solar-archive.js`) and treats
`d` plus `wl` together as a handoff from the film (it defers the cookie banner while the overlay opens).
Other parameters the store already reads (`p`, `vibe`, `cat`, `tune`) are not part of this contract.

## The data frontier

The store can only print dates up to its data frontier, `GET /api/data_frontier`. It measured about
5 to 6 days behind on 2026-08-09 and it drifts. A link built from a moment in the last 48 hours (the
Sun pages show exactly that window) is therefore usually past the frontier. This contract does not
clamp: the producer sends the moment it shows and the store decides what to offer. Whether the store's
reply to a date past the frontier is good enough for a buyer is UNCHECKED here.

## Example

```text
https://myheliograph.com/?utm_source=sun&d=2026-09-30&t=14:20&wl=171
```

The example shows the shape; it is not a record of a real order.
