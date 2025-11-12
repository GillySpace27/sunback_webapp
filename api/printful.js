(function(){
  function getApiBase(){
    const origin = window.location.origin;
    return `${origin}/api`;
  }
  async function uploadToPrintful(fileBlob, filename="sun.png"){
    const formData = new FormData();
    formData.append("file", fileBlob, filename);
    const resp = await fetch(`${getApiBase()}/printful/upload`, { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || "Upload failed");
    return data.file_id;
  }
  async function createMockup(productId, variantId, fileId){
    const formData = new FormData();
    formData.append("product_id", productId);
    formData.append("variant_id", variantId);
    formData.append("file_id", fileId);
    const resp = await fetch(`${getApiBase()}/printful/mockup`, { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || "Mockup failed");
    return data.mockup_url;
  }
  async function createOrder(orderInfo){
    const fd = new FormData();
    for (const [k,v] of Object.entries(orderInfo||{})) fd.append(k, v);
    const resp = await fetch(`${getApiBase()}/printful/order`, { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || data.detail || "Order failed");
    return data.order_id;
  }
  async function handleUploadAndMockup(previewUrl, productId, variantId){
    const blob = await fetch(previewUrl, {cache:"no-cache"}).then(r=>r.blob());
    const fileId = await uploadToPrintful(blob);
    const mockupUrl = await createMockup(productId, variantId, fileId);
    const imgEl = document.getElementById("mockupImage");
    const container = document.getElementById("mockupContainer");
    if (imgEl) imgEl.src = mockupUrl;
    if (container) container.style.display = "block";
    const form = document.getElementById("orderForm");
    if (form){
      form.dataset.fileId = fileId;
      form.dataset.variantId = variantId;
    }
    return { fileId, mockupUrl };
  }
  async function handleOrderSubmit(e){
    e.preventDefault();
    const form = e.target;
    const info = Object.fromEntries(new FormData(form));
    info.file_id = form.dataset.fileId;
    info.variant_id = form.dataset.variantId;
    const orderId = await createOrder(info);
    alert("Order placed! Printful ID: " + orderId);
  }

  // Product list proxy
  async function listProducts(){
    const resp = await fetch(`${getApiBase()}/printful/products`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to load products");
    return data;
  }

  // expose globals for test_frontend.js
  window.SolarArchivePrintful = {
    getApiBase, uploadToPrintful, createMockup, createOrder,
    handleUploadAndMockup, handleOrderSubmit, listProducts
  };
})();