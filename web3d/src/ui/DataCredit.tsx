// NASA/SDO attribution. Required by the SDO rules of the road, so it is always
// present — but it is not a headline, and having it as a fourth block of text
// over the opening frame made the landing read as busy. It lives here instead:
// a persistent, quiet footer credit that never competes with the pitch and
// never disappears from the page.
export default function DataCredit() {
  return (
    <p className="data-credit">
      Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams. Not affiliated; no
      endorsement implied.
    </p>
  );
}
