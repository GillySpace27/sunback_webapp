// Helper: Get the API base URL, using current window location
function getApiBase() {
  const origin = window.location.origin;
  // Always use /api for both Render and local development, since FastAPI mounts routes under /api
  return `${origin}/api`;
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
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
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
  while (true) {
    const resp = await fetch(statusUrl);
    if (!resp.ok) throw new Error("Failed to poll status");
    const data = await resp.json();
    if (onUpdate) onUpdate(data);
    if (data.status === "complete" || data.status === "error") {
      return data;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Helper: Upload image to Printful via API
async function uploadToPrintful(imageUrl) {
  // This is a placeholder; you would need to implement Printful API integration
  setStatus("Uploading to Printful...", "blue");
  // Example: await postJSON(getApiBase() + "/printful_upload", {image_url: imageUrl});
  await new Promise(r => setTimeout(r, 1000));
  setStatus("Uploaded to Printful!", "green");
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

  // New: get the three new buttons
  const previewBtn = document.getElementById("previewBtn");
  const hqBtn = document.getElementById("hqBtn");
  const printfulBtn = document.getElementById("printfulBtn");

  // Helper to show preview image in #solar-image (not #preview-img)
  function showPreview(url) {
    const img = document.getElementById("solar-image");
    if (img) {
      img.src = url;
      img.style.display = "block";
    }
  }

  // Wire up Preview button
  if (previewBtn) {
    previewBtn.addEventListener("click", async () => {
      const date = document.getElementById("solar-date").value;
      const wavelength = document.getElementById("solar-wavelength").value;
      const apiBase = getApiBase();
      console.log("Using API base:", apiBase);
      try {
        const resp = await postJSON(`${apiBase}/generate`, {
          date, wavelength, preview: true
        });
        if (resp.status_url) {
          await pollStatus(resp.status_url, data => {
            if (data.status === "processing") setStatus("Processing preview...", "blue");
            if (data.status === "error") setStatus(`Error: ${data.error}`, "red");
            if (data.image_url) showPreview(data.image_url);
          });
        } else if (resp.asset_url) {
          showPreview(resp.asset_url);
        } else {
          alert("No preview returned!");
        }
      } catch (err) {
        console.error("Preview generation failed:", err);
      }
    });
  }

  // Wire up HQ Proof button
  if (hqBtn) {
    hqBtn.addEventListener("click", async () => {
      const date = document.getElementById("solar-date").value;
      const wavelength = document.getElementById("solar-wavelength").value;
      const apiBase = getApiBase();
      console.log("Using API base:", apiBase);
      try {
        const resp = await postJSON(`${apiBase}/generate`, {
          date, wavelength, preview: false, upload_to_printful: false
        });
        if (resp.status_url) {
          await pollStatus(resp.status_url, data => {
            if (data.status === "processing") setStatus("Processing HQ proof...", "blue");
            if (data.status === "error") setStatus(`Error: ${data.error}`, "red");
            if (data.image_url) showPreview(data.image_url);
          });
        } else {
          alert("HQ render request failed.");
        }
      } catch (err) {
        console.error("HQ render failed:", err);
      }
    });
  }

  // Wire up Printful Upload button
  if (printfulBtn) {
    printfulBtn.addEventListener("click", async () => {
      const date = document.getElementById("solar-date").value;
      const wavelength = document.getElementById("solar-wavelength").value;
      const apiBase = getApiBase();
      console.log("Using API base:", apiBase);
      try {
        const resp = await postJSON(`${apiBase}/generate`, {
          date, wavelength, preview: false, upload_to_printful: true
        });
        if (resp.status_url) {
          await pollStatus(resp.status_url, data => {
            if (data.status === "processing") setStatus("Uploading to Printful...", "blue");
            if (data.status === "error") setStatus(`Error: ${data.error}`, "red");
            if (data.image_url) showPreview(data.image_url);
          });
        } else {
          alert("Printful upload failed to start.");
        }
      } catch (err) {
        console.error("Printful upload failed:", err);
      }
    });
  }

  if (generateBtn && dateInput && wavelengthInput) {
    generateBtn.addEventListener("click", async () => {
      generateBtn.disabled = true;
      setStatus("Generating image...", "blue");
      try {
        const date = dateInput.value;
        const wavelength = wavelengthInput.value;
        const apiBase = getApiBase();
        console.log("Using API base:", apiBase);
        const resp = await postJSON(`${apiBase}/generate`, { date, wavelength, preview: true });
        console.log("Generate response:", resp);
        if (!resp.status_url) throw new Error("No status_url returned from generate");

        const statusData = await pollStatus(resp.status_url, data => {
          if (data.status === "processing") setStatus("Processing...", "blue");
          if (data.status === "error") setStatus(`Error: ${data.error}`, "red");
          if (data.image_url) showImage(data.image_url);
        });

        if (statusData.status === "error") throw new Error(statusData.error);
        if (!statusData.image_url) throw new Error("No image_url in status response");
        showImage(statusData.image_url);
        setStatus("Image ready!", "green");
      } catch (err) {
        console.error("Generate failed:", err);
        setStatus(`Failed: ${err.message}`, "red");
      } finally {
        generateBtn.disabled = false;
      }
    });
  }

  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", async () => {
      clearCacheBtn.disabled = true;
      setStatus("Clearing cache...", "blue");
      try {
        const apiBase = getApiBase();
        console.log("Using API base:", apiBase);
        await postJSON(`${apiBase}/clear_cache`, {});
        setStatus("Cache cleared!", "green");
      } catch (err) {
        setStatus(`Failed to clear cache: ${err.message}`, "red");
      } finally {
        clearCacheBtn.disabled = false;
      }
    });
  }
}

// Run on page load
window.addEventListener("DOMContentLoaded", initApp);