"""Sanity checks for the proportional-markup price ladder (money path).

Run: python3 api/scripts/test_ladder.py

Guards the invariants _compute_variant_prices relies on:
  - price >= cost for every tier (never sell below cost)
  - cheapest tier lands exactly on the advertised anchor
  - distinct cost tiers step >= $1.00
  - every price ends in .99
  - tampered (low/zero) anchor floors at ceil99(cost), never below cost

The JS twin (_ladderFor in solar-archive.js) must produce identical
numbers; if you change one, change both and re-run the parity script
from the 2026-08-08 repricing session (or spot-check by hand).
"""
import re
import sys
from pathlib import Path

# Pull the two pure functions out of printify_routes without importing
# fastapi and friends.
src = (Path(__file__).resolve().parents[1] / "printify_routes.py").read_text()
ns: dict = {}
start = src.index("def _ceil99")
end = src.index('@router.get("/blueprints/cheapest_costs")')
exec(src[start:end], ns)  # noqa: S102 - our own source
_ladder_prices = ns["_ladder_prices"]

# Real sticker data from the 2026-08-08 snapshot.
bucket = {i: {"cost": c} for i, c in enumerate([142, 158, 200, 232])}
ladder = _ladder_prices(bucket, 299)
assert ladder == {142: 299, 158: 399, 200: 499, 232: 599}, ladder

# Dense costs (the poster's 1-cent tiers) still step >= $1.
dense = {i: {"cost": c} for i, c in enumerate([496, 803, 805, 806])}
lad = _ladder_prices(dense, 999)
prices = [lad[c] for c in sorted(lad)]
assert all(b - a >= 100 for a, b in zip(prices, prices[1:])), prices
assert all(p % 100 == 99 for p in prices), prices
assert all(lad[c] >= c for c in lad)
assert prices[0] == 999  # cheapest pins to the anchor

# Tampered anchor: floors at ceil99(cost), never below cost.
lad0 = _ladder_prices(bucket, 0)
assert all(lad0[c] >= c for c in lad0), lad0
assert lad0[142] == 199, lad0

print("ladder self-check OK")
