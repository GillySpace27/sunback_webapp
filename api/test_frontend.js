const P = window.SolarArchivePrintful;

// Global AbortController for fetch cancellation
let currentAbortController = null;

function getApiBase(){ return P.getApiBase(); }

// Helper: Normalize preview and asset URLs for frontend use
function normalizeUrl(url) {
  if (!url) return url;
  // Absolute asset paths should not be prefixed by /api
  if (url.startsWith("/asset/")) {
    return `${window.location.origin}${url}`;
  }
  // Other API endpoints still use /api
  if (url.startsWith("/api/")) {
    return `${window.location.origin}${url}`;
  }
  // Fallback for relative paths
  return `${window.location.origin}/api/${url.replace(/^\/+/, "")}`;
}

// Helper: Set status message to user
function setStatus(msg, color = "black") {
  const statusEl = document.getElementById("solar-status");
  if (statusEl) {
    statusEl.innerText = msg;
    statusEl.style.color = color;
  }
}

// Helper: POST JSON to an endpoint, returns parsed response
async function postJSON(url, data) {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  return await resp.json();
}

// Helper: Show image in the preview area
function showImage(imgUrl) {
  const imgEl = document.getElementById("solar-image");
  if (imgEl) {
    imgEl.src = imgUrl;
    imgEl.style.display = "block";
  }
}

// Helper: Poll status endpoint until ready or error
async function pollStatus(statusUrl, onUpdate) {
  // Use currentAbortController if exists, else create one
  if (!currentAbortController) currentAbortController = new AbortController();
  const { signal } = currentAbortController;
  while (true) {
    const resp = await fetch(statusUrl, { signal });
    if (!resp.ok) throw new Error("Failed to poll status");
    const data = await resp.json();
    if (onUpdate) onUpdate(data);
    if (data.status === "complete" || data.status === "error") {
      return data;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}


// Main orchestration: Generate preview image
async function generatePreview(prompt) {
  try {
    setStatus("Requesting preview...", "blue");
    // Start the preview generation
    const apiBase = getApiBase();
    console.log("Using API base:", apiBase);
    const resp = await postJSON(`${apiBase}/generate`, { prompt });
    if (!resp.status_url) throw new Error("No status_url in response");

    setStatus("Waiting for image...", "blue");
    // Poll for completion
    const statusData = await pollStatus(resp.status_url, data => {
      if (data.status === "processing") setStatus("Processing preview...", "blue");
      if (data.status === "error") setStatus(`Error: ${data.error}`, "red");
    });

    if (statusData.status === "error") throw new Error(statusData.error);
    if (!statusData.image_url) throw new Error("No image_url in status response");
    setStatus("Preview ready!", "green");
    showImage(statusData.image_url);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, "red");
  }
}

// Additional: product picker helpers and order form bind
async function loadProductPicker(){
  const picker = document.getElementById("productPicker");
  if (!picker) return;
  picker.innerHTML = "";
  try{
    const products = await P.listProducts();
    products.slice(0, 12).forEach(p=>{
      const card = document.createElement("div");
      card.style.cssText = `
        width:180px; padding:1em; border-radius:12px;
        box-shadow:0 2px 8px rgba(0,0,0,0.1);
        background:#fff; cursor:pointer; text-align:center;
        transition:transform 0.2s ease;
      `;
      card.onmouseenter = ()=> card.style.transform = "scale(1.03)";
      card.onmouseleave = ()=> card.style.transform = "scale(1)";
      card.innerHTML = `
        <img src="${p.thumbnail}" style="width:100%; border-radius:8px; margin-bottom:0.5em;">
        <div style="font-weight:600;">${p.name}</div>
        <div style="font-size:0.85em; color:#666;">${p.type||''}</div>
      `;
      card.addEventListener("click", ()=>{
        const latest = document.getElementById("solar-image")?.src;
        if (!latest){ alert("No preview image yet — generate one first."); return; }
        // Temporary: use product id for both product and variant until variant UI is added
        P.handleUploadAndMockup(latest, p.id, p.id).catch(err=>alert(err.message));
      });
      picker.appendChild(card);
    });
  }catch(e){
    const p = document.createElement("p");
    p.style.color = "#b00";
    p.textContent = "Failed to load products: " + e.message;
    picker.appendChild(p);
  }
}

// Initialization: wire up UI
function initApp() {
  const generateBtn = document.getElementById("generate-btn");
  const clearCacheBtn = document.getElementById("clearCacheBtn");
  const dateInput = document.getElementById("solar-date");
  if (dateInput) {
    const today = new Date();
    today.setDate(today.getDate() - 4);
    dateInput.value = today.toISOString().split("T")[0];
  }
  const wavelengthInput = document.getElementById("solar-wavelength");
  if (wavelengthInput) {
    wavelengthInput.value = 171;
  }


  if (generateBtn && dateInput && wavelengthInput) {
    generateBtn.addEventListener("click", async () => {
      // Cancel any ongoing fetches before starting new work
      if (currentAbortController) currentAbortController.abort();
      currentAbortController = null;
      generateBtn.disabled = true;
      // Disable HQ and clear cache during preview generation
      const hqBtn = document.getElementById("hq-btn");
      const clearCacheBtn = document.getElementById("clearCacheBtn");
      if (hqBtn) hqBtn.disabled = true;   // disable HQ during preview generation
      if (clearCacheBtn) clearCacheBtn.disabled = true;
      setStatus("Generating preview...", "blue");
      try {
        const date = dateInput.value;
        const wavelength = wavelengthInput.value;
        const apiBase = getApiBase();
        const res = await postJSON(`${apiBase}/generate_preview`, { date, wavelength, mission: "SDO" });
        const previewUrl = res.preview_url || res.png_url;
        if (!previewUrl) throw new Error("No preview URL from backend");
        const imgEl = document.getElementById("solar-image");
        const fullUrl = normalizeUrl(previewUrl);
        imgEl.src = fullUrl;
        imgEl.style.display = "block";
        imgEl.onload = null;
        imgEl.onerror = () => setStatus("❌ Failed to load preview image.", "red");
        setStatus("Preview loaded! Click the button to generate the HQ image next!", "green");
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "red");
      } finally {
        generateBtn.disabled = false;
        const clearCacheBtn = document.getElementById("clearCacheBtn");
        const hqBtn = document.getElementById("hq-btn");
        if (clearCacheBtn) clearCacheBtn.disabled = false;
        if (hqBtn) hqBtn.disabled = false;   // HQ becomes available only after preview success
      }
    });
  }

  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", async () => {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      clearCacheBtn.disabled = true;
      // Also disable preview and HQ buttons
      const generateBtn = document.getElementById("generate-btn");
      const hqBtn = document.getElementById("hq-btn");
      if (generateBtn) generateBtn.disabled = true;
      if (hqBtn) hqBtn.disabled = true;
      setStatus("Clearing cache...", "blue");
      try {
        const apiBase = getApiBase();
        console.log("Using API base:", apiBase);
        await postJSON(`${apiBase}/clear_cache`, {});
        // Hide current preview image
        const imgEl = document.getElementById("solar-image");
        if (imgEl) {
          imgEl.src = "";
          imgEl.style.display = "none";
        }
        setStatus("Cache cleared!", "green");
      } catch (err) {
        setStatus(`Failed to clear cache: ${err.message}`, "red");
      } finally {
        clearCacheBtn.disabled = false;
        const generateBtn = document.getElementById("generate-btn");
        const hqBtn = document.getElementById("hq-btn");
        if (generateBtn) generateBtn.disabled = false;
        if (hqBtn) hqBtn.disabled = true;   // HQ must stay disabled until a new preview exists
      }
    });
  }

  // HQ Button logic
  const hqBtn = document.getElementById("hq-btn");
  if (hqBtn && dateInput && wavelengthInput) {
    hqBtn.disabled = true;   // HQ starts disabled
    hqBtn.addEventListener("click", async () => {
      const generateBtn = document.getElementById("generate-btn");
      const clearCacheBtn = document.getElementById("clearCacheBtn");
      if (generateBtn) generateBtn.disabled = true;
      if (clearCacheBtn) clearCacheBtn.disabled = true;
      if (currentAbortController) currentAbortController.abort();
      currentAbortController = null;
      hqBtn.disabled = true;
      setStatus("Generating HQ image...", "blue");
      try {
        const date = dateInput.value;
        const wavelength = wavelengthInput.value;
        const apiBase = getApiBase();
        const hqRes = await postJSON(`${apiBase}/generate`, { date, wavelength, mission: "SDO", detector: "AIA" });
        if (hqRes.png_url) {
          const resolved = normalizeUrl(hqRes.png_url);
          const imgEl = document.getElementById("solar-image");
          imgEl.src = resolved;
          imgEl.style.display = "block";
          setStatus("HQ image loaded!", "green");
        } else {
          setStatus("HQ generation returned no PNG.", "orange");
        }
      } catch (e) {
        setStatus("HQ generation failed: " + e.message, "red");
      } finally {
        hqBtn.disabled = false;
        const generateBtn = document.getElementById("generate-btn");
        const clearCacheBtn = document.getElementById("clearCacheBtn");
        if (generateBtn) generateBtn.disabled = false;
        if (clearCacheBtn) clearCacheBtn.disabled = false;
      }
    });
  }
}

// Run on page load
window.addEventListener("DOMContentLoaded", initApp);
  // Bind order form submit
  const orderForm = document.getElementById("orderForm");
  if (orderForm){
    orderForm.addEventListener("submit", P.handleOrderSubmit);
  }
  // Load products on DOM ready
  loadProductPicker();