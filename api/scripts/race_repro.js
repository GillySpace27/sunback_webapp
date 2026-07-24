/* Stale-render race repro. Paste into the DevTools console on a running
   Solar Archive page (./run_server → http://127.0.0.1:8000), then read the
   result after ~20 s.

   Emulates Conner's flaky-wifi report: 131 Å's preview lands 7 s late, 304 Å
   lands fast, and the user switches 131 → 304 in between.

   PASS: alt text says 304 and mean RGB ≈ [96,16,2]  (red 304 image)
   FAIL: alt text says 131 / mean RGB ≈ [118,77,36]  (teal 131 image painted
         over the user's current selection — the original bug)               */
(function () {
  var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    set: function (v) {
      var self = this, ms = 0;
      if (/size=512/.test(String(v))) ms = /wavelength=131/.test(String(v)) ? 7000 : 400;
      if (ms) setTimeout(function () { d.set.call(self, v); }, ms); else d.set.call(self, v);
    },
    get: function () { return d.get.call(this); }
  });
  var dt = document.getElementById("solarDate");
  dt.value = "2023-10-02";
  dt.dispatchEvent(new Event("change", { bubbles: true }));
  setTimeout(function () { document.querySelector('.wl-card[data-wl="131"]').click(); }, 400);
  setTimeout(function () { document.querySelector('.wl-card[data-wl="304"]').click(); }, 1200);
  setTimeout(function () {
    var c = document.getElementById("solarCanvas");
    var px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < px.length; i += 4 * 97) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    var alt = c.getAttribute("aria-label");
    console.log(alt.indexOf("304") !== -1 ? "PASS" : "FAIL", alt,
                [r / n | 0, g / n | 0, b / n | 0]);
  }, 20000);
})();
