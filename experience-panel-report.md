# Experience-side panel report

Five personas ran against `myheliograph.com/experience/`: impatient, screen-reader,
low-vision-phone, gift-novice, skeptic. Every claim below is marked by how it was
established, because a large fraction of the panel's loudest failures turned out to be
artifacts of the test harness rather than defects in the site.

## Read this first: the harness lied to three personas

The MCP browser pane reports `document.visibilityState === "hidden"`. In a hidden
document the browser suspends `requestAnimationFrame`. The experience page is a
scroll-driven WebGL scene whose every visual update runs inside rAF.

So in that harness the page renders once and then stops moving, while still being
fully alive to the DOM. That single fact manufactures three separate "catastrophic"
findings:

- "The Sun never rendered, just black" (skeptic, and my own first screenshot)
- "MAKE ONE / See the Sun do nothing" (gift-novice, skeptic, low-vision)
- "The page froze completely" (gift-novice)

I hit the same wall: a click on the picker toggle timed out after 30s. But the click
had in fact succeeded. Immediately afterward the DOM read
`aria-expanded="true"` with the label flipped to `Hide options`. Nothing was frozen.

**Consequence: no motion, interaction, or 3D-behaviour finding from this panel is
trustworthy.** Those need a real device. What survives is layout, copy, markup, and
network behaviour, which the harness reports accurately.

---

## Verified defects, worst first

### 1. The wordmark is unreadable on a 375px phone  [screenshot-verified]
The "SKIP TO THE STORE" pill is drawn directly on top of the `My Heliograph`
masthead. It reads "My Heli▓▓▓▓▓▓". The brand name is destroyed at the single most
common phone width, in the first viewport, above everything else.

This is the same class of bug as the master-toggle overlap fixed on 2026-08-13, in a
different component.

### 2. The Sun is badly framed on mobile  [screenshot-verified]
At 375x812 the sphere is chopped off by the left viewport edge and its lower limb
collides with the `PICK YOUR DATE` row. Roughly a third of the Sun is off-screen. The
hero composition that works on desktop does not survive a narrow aspect ratio.

### 3. Long black first paint on mobile, with no placeholder  [screenshot-verified]
The middle of the viewport is pure black for a substantial window before the Sun
appears: no spinner, no gradient, no poster frame. Floating text over a void reads as
a broken page. Whatever the true duration on a real phone, there is currently nothing
occupying that gap.

### 4. The experience page has no identity and no policy links  [source-verified]
`/privacy`, `/terms`, `/refund` and `/accessibility` all exist and return 200 on the
store. The experience page links to **none** of them, and carries no company name,
contact, or footer of any kind.

The skeptic went looking for "who is behind this", found nothing, guessed
Shopify-style URLs, and hit raw JSON. Their conclusion was that they could not trust
the checkout enough to continue. The pages that would have answered them already
exist; they are simply unreachable from where the visitor is standing.

### 5. Every 404 returns unstyled JSON  [curl-verified, 4/4 paths]
```
/pages/contact           404  {"detail":"Not Found"}
/policies/refund-policy  404  {"detail":"Not Found"}
/policies/privacy-policy 404  {"detail":"Not Found"}
/experience/nonexistent  404  {"detail":"Not Found"}
```
Any mistyped or stale URL drops the visitor onto a raw API error. For a first-time
buyer weighing whether this is a real business, that is the worst possible artifact to
surface.

### 6. No price in the first viewport  [DOM-verified]
`$9.99` does exist in the page text, but only after the picker is opened. A visitor
who reads the hero and leaves never sees a price. The impatient persona's verdict was
blunt: *"Right now I'm buying on vibes alone."*

Related and unfixed: there is no image of a finished product anywhere on the
experience page. Nobody sees what they are actually buying before the store.

### 7. Wavelength choice is unglossed jargon  [DOM-verified]
All six of `corona`, `chromosphere`, `photosphere`, `prominence`,
`transition region`, `Å` appear in the picker copy. Nine coloured circles, every
label in domain vocabulary.

The gift-novice had no basis whatsoever for choosing and said so: the only words they
could act on were `Original: as the telescope saw it` versus
`Enhanced: reveals the faint outer corona`, and they picked one purely because it
contained the word "telescope". That pair is the one piece of plain English in the
whole selection flow, and it works. Nothing else does.

### 8. `BuyLink` can latch permanently dead  [code-verified, latent]
`web3d/src/ui/BuyLink.tsx:30-40`: the click handler calls `preventDefault()`, sets
`preparing = true`, and navigates on a 700ms timer. `preparing` is never reset, and
subsequent clicks return early.

If that navigation is slow or fails, the purchase link is permanently inert for the
rest of the session, with no visible feedback beyond `aria-busy`. This is not what the
personas hit, but it is a genuine latent failure on the revenue path, and it would
present exactly as "the buy button does nothing".

### 9. The picker toggle has no explicit accessible name  [DOM-verified]
`read_page` listed it as `button [ref_5] type="button"` with no name. Its name derives
solely from incidental child text that changes between `Make yours` and
`Hide options`. An explicit `aria-label` would fix it.

---

## Claims that did not survive verification

Do not spend time on these.

| Claim | Status |
|---|---|
| "No link or button responds to Enter/Space anywhere" | **Unsupported.** No global keydown handler exists in `web3d/src`; Lenis does not bind keydown at all. |
| "Buttons do nothing / page frozen" | **False.** The click worked; `aria-expanded` flipped. Harness rAF suspension. |
| "`aria-expanded` is missing from the toggle" | **False.** Present and correct in `WavelengthPicker.tsx:34`. |
| "The Previous arrow is absent from the accessibility tree" | **False.** Present as `button "Previous"`. |
| "Typed date silently changed to an unrelated date" | **Unconfirmed.** Two personas, no reproduction. Worth one manual check on a real phone. |

---

## Suggested order

Cheap, high-value, and independent of the harness problem:

1. Masthead collision at ≤375px (#1)
2. Mobile Sun framing (#2)
3. A minimal footer on the experience page linking privacy / terms / refund /
   accessibility, plus a business name (#4)
4. A styled 404 (#5)
5. Plain-English glosses on the wavelength swatches, extending the
   Original/Enhanced pattern that already works (#7)
6. Reset `preparing` on failure in `BuyLink` (#8)

Then re-run the phone checks on real hardware, because this panel could not see
anything that moves.
