// api/printful.js — Frontend helpers for Printful + API base

(function () {
  const API_BASE = `${window.location.origin}/api`;

  async function jsonFetch(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
    }
    // Try JSON, otherwise return text
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return res.text();
  }

  // --- Public API used by test_frontend.js ---
  const P = {
    getApiBase() {
      return API_BASE;
    },

    async listProducts() {
      // Returns array of {id, name, thumbnail, type}
      return await jsonFetch(`${API_BASE}/printful/products`);
    },

    async uploadImageToPrintfulFromUrl(imageUrl) {
      // Fetch the image and re-upload to /api/printful/upload
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
      const blob = await resp.blob();
      const file = new File([blob], imageUrl.split("/").pop() || "image.png", { type: blob.type || "image/png" });
      const form = new FormData();
      form.append("file", file);
      const up = await fetch(`${API_BASE}/printful/upload`, { method: "POST", body: form });
      if (!up.ok) {
        const txt = await up.text();
        throw new Error(`Upload failed: ${txt}`);
      }
      const data = await up.json();
      if (!data.file_id) throw new Error("No file_id returned from upload");
      return data.file_id;
    },

    async handleUploadAndMockup(imageUrl, productId, variantId) {
      // 1) Upload image to Printful library via backend
      const file_id = await P.uploadImageToPrintfulFromUrl(imageUrl);

      // 2) Request a mockup for product/variant
      const form = new FormData();
      form.append("product_id", String(productId));
      form.append("variant_id", String(variantId));
      form.append("file_id", String(file_id));

      const res = await fetch(`${API_BASE}/printful/mockup`, { method: "POST", body: form });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Mockup request failed: ${txt}`);
      }
      const data = await res.json();
      if (!data.mockup_url) throw new Error("No mockup URL returned");
      // Show mockup in a new tab
      window.open(data.mockup_url, "_blank");
      return data.mockup_url;
    },

    async handleOrderSubmit(ev) {
      ev.preventDefault();
      const formEl = ev.currentTarget;
      const api = API_BASE;

      const variant_id = Number(formEl.variant_id.value);
      const fileUrl = document.getElementById("solar-image")?.src;
      if (!fileUrl) {
        alert("Generate a preview first so we can upload that image.");
        return;
      }
      // Ensure file is in Printful library
      const file_id = await P.uploadImageToPrintfulFromUrl(fileUrl);

      const fd = new FormData(formEl);
      fd.set("variant_id", String(variant_id));
      fd.set("file_id", String(file_id));

      const res = await fetch(`${api}/printful/order`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Order failed: ${data.error || data.detail || res.statusText}`);
        return;
      }
      alert(`Order created! ID: ${data.order_id}`);
    }
  };

  window.SolarArchivePrintful = P;
})();