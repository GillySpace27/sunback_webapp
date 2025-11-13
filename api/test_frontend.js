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
  picker.innerHTML = "";
  try {
    const templates = await P.listLiveTemplates();
    templates.forEach(t => {
      const card = document.createElement("div");
      card.style.cssText = `
        width:200px; padding:1em; border-radius:12px;
        box-shadow:0 2px 8px rgba(0,0,0,0.1);
        background:#fff; cursor:pointer; text-align:center;
        transition:transform 0.2s ease; margin:0.5em;
      `;
      card.onmouseenter = ()=> card.style.transform = "scale(1.03)";
      card.onmouseleave = ()=> card.style.transform = "scale(1)";
      const thumb = t.thumbnail ? `<img src="${t.thumbnail}" style="width:100%; border-radius:8px; margin-bottom:0.5em;">` : "";
      const variantsHtml = t.variants.map(v => `<div style="font-size:0.8em; color:#555;">${v.name}</div>`).join("");
      card.innerHTML = `
        ${thumb}
        <div style="font-weight:700; margin-bottom:0.25em;">${t.name}</div>
        <div>${variantsHtml}</div>
      `;
      card.addEventListener("click", ()=>{
        const img = document.getElementById("solar-image")?.src;
        if (!img){ alert("No image yet — generate HQ first."); return; }
        const first = t.variants[0];
        if (!first){ alert("No variants available for this template."); return; }
        P.handleUploadAndMockupToTemplate(img, {
          product_id: t.product_id,
          variant_id: first.variant_id
        }).catch(err=>alert(err.message));
      });
      picker.appendChild(card);
    });
  } catch (e) {
    picker.innerHTML = `<div style="color:red;">Failed to load: ${e.message}</div>`;
  }
}

// Initialization: wire up UI
function initApp() {
  let globalProgress = 0;
  function bumpProgress(delta = 2) {
    globalProgress = Math.min(100, globalProgress + delta);
    const bar = document.getElementById("progress-bar");
    if (bar) bar.style.width = globalProgress + "%";
  }
  function setProgress(pct) {
    globalProgress = pct;
    const bar = document.getElementById("progress-bar");
    bar.style.width = pct + "%";
  }

  let progressTimer = null;

  function startProgressTimer() {
    if (progressTimer) return;
    progressTimer = setInterval(() => {
      // Slowly bump while waiting, but never reach 100
      if (globalProgress < 95) {
        bumpProgress(1);
      }
    }, 1500); // bump every 1.5 seconds
  }

  function stopProgressTimer() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }
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

  const hqBtn = document.getElementById("hq-btn");
  const uploadBtn = document.getElementById("uploadPrintfulBtn");
  if (uploadBtn) {
    uploadBtn.disabled = true;
  }

  if (generateBtn && dateInput && wavelengthInput) {
    generateBtn.addEventListener("click", async () => {
      // Cancel any ongoing fetches before starting new work
      if (currentAbortController) currentAbortController.abort();
      currentAbortController = null;
      generateBtn.disabled = true;
      // Disable HQ and clear cache during preview generation
      // const hqBtn = document.getElementById("hq-btn");
      if (hqBtn) {
        hqBtn.disabled = false;   // disable HQ during preview generation (removed per instructions)
      }
      if (clearCacheBtn) clearCacheBtn.disabled = true;
      setProgress(0);
      startProgressTimer();
      setStatus("Generating preview...", "blue");
      setProgress(10); // request sent
      try {
        const date = dateInput.value;
        const wavelength = wavelengthInput.value;
        const apiBase = getApiBase();
        const res = await postJSON(`${apiBase}/generate_preview`, { date, wavelength, mission: "SDO" });
        setProgress(50); // backend responded with preview metadata
        const previewUrl = res.preview_url || res.png_url;
        if (!previewUrl) throw new Error("No preview URL from backend");
        const imgEl = document.getElementById("solar-image");
        const fullUrl = normalizeUrl(previewUrl);
        imgEl.src = fullUrl;
        imgEl.style.display = "block";
        imgEl.onload = null;
        imgEl.onerror = () => setStatus("❌ Failed to load preview image.", "red");
        setProgress(80); // image assigned to DOM, loading underway
        setStatus("Preview loaded! Click the button to generate the HQ image next!", "green");
        setProgress(100);
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "red");
      } finally {
        stopProgressTimer();
        generateBtn.disabled = false;
        if (clearCacheBtn) clearCacheBtn.disabled = false;
        if (hqBtn) {
          // hqBtn.disabled = false;   // HQ becomes available only after preview success (removed per instructions)
        }
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
      if (generateBtn) generateBtn.disabled = true;
      if (hqBtn) hqBtn.disabled = true;
      setProgress(0);
      stopProgressTimer();
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
        setProgress(0);
      } catch (err) {
        setStatus(`Failed to clear cache: ${err.message}`, "red");
      } finally {
        clearCacheBtn.disabled = false;
        if (generateBtn) generateBtn.disabled = false;
        if (hqBtn) hqBtn.disabled = true;   // HQ must stay disabled until a new preview exists
      }
    });
  }

  if (hqBtn && dateInput && wavelengthInput) {
    // hqBtn.disabled = true;   // HQ starts disabled (removed per instructions, so HQ enabled at init)

    // Add global flag uploadAllowed here
    let uploadInProgress = false;
    let uploadAllowed = false;

    hqBtn.addEventListener("click", async () => {
      if (generateBtn) generateBtn.disabled = true;
      if (clearCacheBtn) clearCacheBtn.disabled = true;
      if (currentAbortController) currentAbortController.abort();
      currentAbortController = null;
      hqBtn.disabled = true;
      if (uploadBtn) uploadBtn.disabled = true;
      setProgress(0);
      startProgressTimer();
      setStatus("Generating HQ image...", "blue");
      setProgress(10); // HQ request sent
      try {
        const date = dateInput.value;
        const wavelength = wavelengthInput.value;
        const apiBase = getApiBase();
        const hqRes = await postJSON(`${apiBase}/generate`, { date, wavelength, mission: "SDO", detector: "AIA" });
        setProgress(60); // HQ backend responded
        if (hqRes.png_url) {
          const resolved = normalizeUrl(hqRes.png_url);
          const imgEl = document.getElementById("solar-image");
          imgEl.src = resolved;
          imgEl.style.display = "block";
          setProgress(90); // image assigned
          setStatus("HQ image loaded!", "green");
          setProgress(100);
          if (uploadBtn) {
            uploadBtn.disabled = false;
            uploadAllowed = true; // allow exactly one upload per HQ generation
          }
        } else {
          setStatus("HQ generation returned no PNG.", "orange");
        }
      } catch (e) {
        setStatus("HQ generation failed: " + e.message, "red");
      } finally {
        stopProgressTimer();
        hqBtn.disabled = false;
        if (generateBtn) generateBtn.disabled = false;
        if (clearCacheBtn) clearCacheBtn.disabled = false;
      }
    });

    if (uploadBtn) {
      uploadBtn.addEventListener("click", async () => {
        // Replace old guard with new logic
        if (uploadBtn.disabled) return;
        if (!uploadAllowed) return;

        uploadBtn.disabled = true;   // HARD LOCK: cannot be clicked again
        uploadInProgress = true;
        uploadBtn.innerText = "Uploading…";
        const imgEl = document.getElementById("solar-image");
        const latest = imgEl?.src;
        if (!latest) {
          alert("No HQ image available. Generate the HQ proof first.");
          uploadInProgress = false;
          uploadBtn.disabled = false;
          uploadBtn.innerText = "Upload to Printful";
          return;
        }
        setStatus("Uploading image to Printful...", "blue");
        try {
          const file_id = await P.uploadImageToPrintfulFromUrl(latest);  // correct upload function
          setStatus("Upload complete! File ID: " + file_id, "green");
        } catch (err) {
          setStatus("Upload failed: " + err.message, "red");
        } finally {
          uploadInProgress = false;
          uploadAllowed = false;
          uploadBtn.disabled = true;
          uploadBtn.innerText = "Upload to Printful";
        }
      });
    }
  }

  const dashBtn = document.getElementById("openPrintfulDashboardBtn");
  if (dashBtn) {
    dashBtn.addEventListener("click", () => {
      // Opens Printful File Library where the user can select any product
      window.open("https://www.printful.com/dashboard/library/index", "_blank");
      setStatus("Opened Printful dashboard in a new tab.", "green");
    });
  }
}

// Run on page load
window.addEventListener("DOMContentLoaded", initApp);
const originalLog = console.log;
console.log = function(...args) {
  originalLog.apply(console, args);
  try {
    // bump progress for any backend console-write reflected here
    const bar = document.getElementById("progress-bar");
    if (bar) {
      const evt = args.join(" ");
      bumpProgress(evt.includes("[fetch]") || evt.includes("[rhef]") ? 4 : 1);
    }
  } catch(e){}
};
  // Bind order form submit
  const orderForm = document.getElementById("orderForm");
  if (orderForm){
    orderForm.addEventListener("submit", P.handleOrderSubmit);
  }
  // Load products on DOM ready
  loadProductPicker();