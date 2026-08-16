// NASA/SDO attribution. Required by the SDO rules of the road, so it is always
// present — but it is not a headline, and having it as a fourth block of text
// over the opening frame made the landing read as busy. It lives here instead:
// a persistent, quiet footer credit that never competes with the pitch and
// never disappears from the page.
//
// It also carries the site's identity and policy links. The store has a full
// legal footer; the experience page had none, so a visitor who lands here first
// can find no company name, no policy, and no way to answer "who is this?".
// A skeptic reviewing the page went looking, found nothing, guessed
// Shopify-style URLs, hit a raw JSON 404 and stopped trusting the checkout —
// while /privacy, /terms, /refund and /accessibility all existed and worked the
// whole time, just one page over. These are the same paths the store footer
// uses; keep the two in sync.
export default function DataCredit() {
  return (
    <div className="data-credit">
      <p className="data-credit-line">
        Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams. Not affiliated; no
        endorsement implied.
      </p>
      <nav className="data-credit-legal" aria-label="Legal">
        <span className="data-credit-owner">© 2026 Chris Gilly</span>
        <span aria-hidden="true">·</span>
        <a href="/privacy">Privacy</a>
        <span aria-hidden="true">·</span>
        <a href="/terms">Terms</a>
        <span aria-hidden="true">·</span>
        <a href="/refund">Refunds</a>
        <span aria-hidden="true">·</span>
        <a href="/shipping">Shipping</a>
        <span aria-hidden="true">·</span>
        <a href="/accessibility">Accessibility</a>
      </nav>
    </div>
  );
}
