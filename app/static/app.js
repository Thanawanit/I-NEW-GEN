/**
 * Smart Bio-Fert Workspace — Frontend Controller
 * Enforces 100% separation between DEMO SIMULATOR ('sim') and LIVE HARDWARE ('live')
 * state, requests, and UI controls, with clean 3-zone rendering.
 */

function createInitialModeState() {
  return {
    plot: {
      id: null,
      name: "แปลงสาธิต อ.ขุนยวม",
      geojson: null,
      calculatedAreaM2: null,
      confirmedAreaM2: null,
      areaProvenance: "NO DATA",
      waypointsCm: [],
    },
    crop: {
      profileId: null,
      cropName: null,
      variety: null,
      growthStage: null,
      soilType: "loam",
      profile: null,
      provenance: "NO DATA",
    },
    survey: {
      greenPct: null,
      origImageUrl: null,
      maskImageUrl: null,
      status: "NO DATA",
      provenance: "NO DATA",
      noticeText: "",
      noticeType: "",
    },
    soil: {
      moisturePct: null,
      ecUsCm: null,
      nLevel: null,
      pLevel: null,
      kLevel: null,
      ph: null,
      recordedAt: null,
      provenance: "NO DATA",
      manualProvenance: "NO DATA",
    },
    fermenter: {
      tempN: null,
      tempP: null,
      tempK: null,
      mixerTds: null,
      provenance: "NO DATA",
    },
    mixer: {
      jobId: null,
      deficits: null,
      volumes: null,
      pumpSec: null,
      phWarning: null,
      rfPrediction: null,
      ecNotice: "",
      ecNoticeType: "",
      provenance: "NO DATA",
    },
    spray: {
      status: "NO DATA",
      provenance: "NO DATA",
      noticeText: "",
      noticeType: "",
    },
  };
}

const appState = {
  activeMode: "sim", // 'sim' | 'live'
  currentStep: 1,
  backendConnected: false,
  crops: [],
  byMode: {
    sim: createInitialModeState(),
    live: createInitialModeState(),
  },
};

function currentModeState() {
  return appState.byMode[appState.activeMode];
}

/* ==================== PROVENANCE BADGE HELPERS ==================== */

const BADGE_CLASS_MAP = {
  LIVE: "badge-live",
  SIMULATED: "badge-simulated",
  MANUAL: "badge-manual",
  CALCULATED: "badge-calculated",
  STALE: "badge-stale",
  "NO DATA": "badge-nodata",
};

function setBadge(el, statusText) {
  if (!el) return;
  const normalized = BADGE_CLASS_MAP[statusText] ? statusText : "NO DATA";
  el.className = `badge ${BADGE_CLASS_MAP[normalized]}`;
  el.textContent = normalized;
}

function formatNum(val, digits = 2) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(digits);
}

/* ==================== API HELPER ==================== */

async function apiRequest(url, options = {}) {
  try {
    const res = await fetch(url, options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || payload.message || `HTTP ${res.status}`);
    }
    appState.backendConnected = true;
    updateBackendStatusUI();
    return payload;
  } catch (err) {
    if (String(err.message).startsWith("Failed to fetch") || String(err.message).includes("NetworkError")) {
      appState.backendConnected = false;
      updateBackendStatusUI(err.message);
    } else {
      // Server responded with validation/501 error -> server IS alive
      appState.backendConnected = true;
      updateBackendStatusUI();
      return { __error: err.message };
    }
    return null;
  }
}

function updateBackendStatusUI(errMessage = "") {
  const badge = document.getElementById("backend-status-badge");
  const banner = document.getElementById("backend-banner");
  const bannerText = document.getElementById("backend-banner-text");

  if (appState.backendConnected) {
    setBadge(badge, "LIVE");
    banner.classList.add("hidden");
  } else {
    setBadge(badge, "NO DATA");
    banner.classList.remove("hidden");
    if (errMessage) {
      bannerText.textContent = `ยังไม่พบการเชื่อมต่อกับ Flask Backend API (${errMessage}) — ระบบจะแสดง NO DATA จนกว่าเซิร์ฟเวอร์จะพร้อม`;
    }
  }
}

/* ==================== MODE SWITCHER (100% SEPARATION) ==================== */

function setOperationalMode(newMode) {
  appState.activeMode = newMode === "live" ? "live" : "sim";
  const isSim = appState.activeMode === "sim";

  const shell = document.getElementById("app-shell");
  shell.classList.toggle("is-mode-sim", isSim);
  shell.classList.toggle("is-mode-live", !isSim);

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.mode === appState.activeMode);
  });

  const banner = document.getElementById("mode-banner");
  const bannerBadge = document.getElementById("mode-banner-badge");
  const bannerText = document.getElementById("mode-banner-text");
  const sidebarNote = document.getElementById("sidebar-mode-note");
  const ctxBadge = document.getElementById("ctx-active-mode-badge");

  if (isSim) {
    banner.className = "mode-banner is-sim";
    setBadge(bannerBadge, "SIMULATED");
    bannerBadge.textContent = "DEMO SIMULATOR";
    bannerText.textContent =
      "กำลังทำงานในโหมดทดสอบจำลอง — ข้อมูลทั้งหมดในโหมดนี้แยกออกจากข้อมูลอุปกรณ์จริง 100% (ปุ่มสั่งอุปกรณ์จริงถูกซ่อนไว้)";
    sidebarNote.innerHTML =
      "<strong>โหมดทดสอบจำลอง:</strong> ใช้สำหรับทดสอบระบบซอฟต์แวร์และอัลกอริทึม ข้อมูลจะไม่ปนกับฐานข้อมูลอุปกรณ์จริง";
    setBadge(ctxBadge, "SIMULATED");
    ctxBadge.textContent = "DEMO SIMULATOR";
  } else {
    banner.className = "mode-banner is-live";
    setBadge(bannerBadge, "LIVE");
    bannerBadge.textContent = "LIVE HARDWARE";
    bannerText.textContent =
      "กำลังทำงานในโหมดอุปกรณ์จริง — แสดงและบันทึกเฉพาะข้อมูลจาก ESP32, โดรนจริง และชุดตรวจดินจริง (ปุ่มจำลองถูกซ่อนไว้ 100%)";
    sidebarNote.innerHTML =
      "<strong>โหมดอุปกรณ์จริง:</strong> รับส่งข้อมูลกับ ESP32 #1, #2 และโดรนจริงเท่านั้น หากยังไม่ได้ต่ออุปกรณ์จะแสดง NO DATA";
    setBadge(ctxBadge, "LIVE");
    ctxBadge.textContent = "LIVE HARDWARE";
  }

  renderCurrentModeUI();
  refreshBackendForActiveMode();
}

async function refreshBackendForActiveMode() {
  const s = currentModeState();
  const mode = appState.activeMode;

  const soilRes = await apiRequest(`/api/soil/latest/${s.plot.id || 1}?mode=${mode}`);
  if (soilRes && soilRes.reading) {
    const r = soilRes.reading;
    const prov = r.source === "manual_testkit" ? "MANUAL" : mode === "sim" ? "SIMULATED" : "LIVE";
    s.soil.moisturePct = r.moisture_pct;
    s.soil.ecUsCm = r.ec_us_cm;
    s.soil.ph = r.ph_value;
    if (r.nitrogen_mg_kg !== null && r.nitrogen_mg_kg !== undefined && !s.soil.nLevel) {
      s.soil.nLevel = `${formatNum(r.nitrogen_mg_kg, 0)}`;
      s.soil.pLevel = `${formatNum(r.phosphorus_mg_kg, 0)}`;
      s.soil.kLevel = `${formatNum(r.potassium_mg_kg, 0)}`;
    }
    s.soil.recordedAt = r.recorded_at;
    s.soil.provenance = prov;
  }

  const fermRes = await apiRequest(`/api/fermenter/latest?mode=${mode}`);
  if (fermRes && fermRes.telemetry) {
    const t = fermRes.telemetry;
    s.fermenter.tempN = t.temp_n;
    s.fermenter.tempP = t.temp_p;
    s.fermenter.tempK = t.temp_k;
    s.fermenter.mixerTds = t.mixer_tds_ppm;
    s.fermenter.provenance = mode === "sim" ? "SIMULATED" : "LIVE";
  }

  renderCurrentModeUI();
}

function renderCurrentModeUI() {
  const s = currentModeState();

  // Workspace 1: Plot
  document.getElementById("input-plot-name").value = s.plot.name || "";
  document.getElementById("val-calc-area").textContent = formatNum(s.plot.calculatedAreaM2, 2);
  document.getElementById("input-confirmed-area").value = s.plot.confirmedAreaM2 ?? "";
  document.getElementById("val-conf-area-display").textContent = formatNum(s.plot.confirmedAreaM2, 2);
  setBadge(document.getElementById("badge-calc-area"), s.plot.calculatedAreaM2 ? "CALCULATED" : "NO DATA");
  setBadge(document.getElementById("badge-conf-area"), s.plot.areaProvenance);
  document.getElementById("map-empty-hint").classList.toggle("hidden", Boolean(s.plot.geojson));
  renderMapPolygonForMode(s.plot.geojson);
  renderWaypointPreview(s.plot.waypointsCm);

  // Workspace 2: Crop
  syncCropDropdownsToState();

  // Workspace 3: Imagery & Soil
  const origBox = document.getElementById("original-image-box");
  const maskBox = document.getElementById("mask-image-box");
  origBox.innerHTML = s.survey.origImageUrl
    ? `<img src="${s.survey.origImageUrl}" alt="ภาพถ่ายแปลงต้นฉบับ" />`
    : "<span>NO DATA — ยังไม่มีภาพถ่ายแปลง</span>";
  maskBox.innerHTML = s.survey.maskImageUrl
    ? `<img src="${s.survey.maskImageUrl}" alt="ผลคัดแยกพื้นที่สีเขียว ExG" />`
    : "<span>NO DATA — รอผลวิเคราะห์จาก OpenCV</span>";
  document.getElementById("val-green-pct").textContent =
    s.survey.greenPct !== null ? `${formatNum(s.survey.greenPct, 1)} %` : "— %";
  document.getElementById("val-survey-status").textContent = s.survey.status;
  setBadge(document.getElementById("badge-exg"), s.survey.provenance);
  renderNotice("drone-survey-notice", s.survey.noticeText, s.survey.noticeType);

  document.getElementById("soil-moisture-val").textContent =
    s.soil.moisturePct !== null ? `${formatNum(s.soil.moisturePct, 1)} %` : "— %";
  document.getElementById("soil-ec-val").textContent =
    s.soil.ecUsCm !== null ? `${formatNum(s.soil.ecUsCm, 0)} µS/cm` : "— µS/cm";
  document.getElementById("soil-recorded-at").textContent = s.soil.recordedAt || "—";
  document.getElementById("soil-npk-val").textContent = s.soil.nLevel
    ? `${s.soil.nLevel} / ${s.soil.pLevel} / ${s.soil.kLevel}`
    : "—";
  document.getElementById("soil-ph-val").textContent = s.soil.ph !== null ? formatNum(s.soil.ph, 1) : "—";

  setBadge(document.getElementById("badge-soil-data"), s.soil.provenance);
  setBadge(document.getElementById("soil-moisture-badge"), s.soil.provenance);
  setBadge(document.getElementById("soil-ec-badge"), s.soil.provenance);
  setBadge(document.getElementById("soil-npk-badge"), s.soil.manualProvenance);
  setBadge(document.getElementById("soil-ph-badge"), s.soil.manualProvenance);

  // Workspace 4: Fermenter & Mixer
  document.getElementById("temp-n-val").textContent =
    s.fermenter.tempN !== null ? `${formatNum(s.fermenter.tempN, 1)} °C` : "— °C";
  document.getElementById("temp-p-val").textContent =
    s.fermenter.tempP !== null ? `${formatNum(s.fermenter.tempP, 1)} °C` : "— °C";
  document.getElementById("temp-k-val").textContent =
    s.fermenter.tempK !== null ? `${formatNum(s.fermenter.tempK, 1)} °C` : "— °C";
  document.getElementById("mixer-tds-val").textContent =
    s.fermenter.mixerTds !== null ? `${formatNum(s.fermenter.mixerTds, 0)} ppm` : "— ppm";

  ["badge-fermenter", "temp-n-badge", "temp-p-badge", "temp-k-badge", "mixer-tds-badge"].forEach((id) =>
    setBadge(document.getElementById(id), s.fermenter.provenance)
  );

  setBadge(document.getElementById("badge-recipe"), s.mixer.provenance);
  document.getElementById("def-n-val").textContent = s.mixer.deficits ? `${formatNum(s.mixer.deficits.n, 1)} g` : "— g";
  document.getElementById("def-p-val").textContent = s.mixer.deficits ? `${formatNum(s.mixer.deficits.p2o5, 1)} g` : "— g";
  document.getElementById("def-k-val").textContent = s.mixer.deficits ? `${formatNum(s.mixer.deficits.k2o, 1)} g` : "— g";

  document.getElementById("vol-n-val").textContent = s.mixer.volumes ? `${formatNum(s.mixer.volumes.n, 1)} ml` : "— ml";
  document.getElementById("vol-p-val").textContent = s.mixer.volumes ? `${formatNum(s.mixer.volumes.p, 1)} ml` : "— ml";
  document.getElementById("vol-k-val").textContent = s.mixer.volumes ? `${formatNum(s.mixer.volumes.k, 1)} ml` : "— ml";
  document.getElementById("vol-w-val").textContent = s.mixer.volumes ? `${formatNum(s.mixer.volumes.water, 1)} ml` : "— ml";

  document.getElementById("sec-n-val").textContent = s.mixer.pumpSec ? `${formatNum(s.mixer.pumpSec.n, 1)} s` : "— s";
  document.getElementById("sec-p-val").textContent = s.mixer.pumpSec ? `${formatNum(s.mixer.pumpSec.p, 1)} s` : "— s";
  document.getElementById("sec-k-val").textContent = s.mixer.pumpSec ? `${formatNum(s.mixer.pumpSec.k, 1)} s` : "— s";
  document.getElementById("sec-w-val").textContent = s.mixer.pumpSec ? `${formatNum(s.mixer.pumpSec.water, 1)} s` : "— s";

  const rf = s.mixer.rfPrediction;
  document.getElementById("rf-metrics-val").textContent = rf
    ? `R² = ${formatNum(rf.r2_score, 4)} | MAE = ${formatNum(rf.mae_g_m2, 3)} g/m² (${rf.n_estimators} trees)`
    : "—";
  document.getElementById("rf-deficits-val").textContent =
    rf && rf.rf_deficits_g
      ? `${formatNum(rf.rf_deficits_g.n, 1)} / ${formatNum(rf.rf_deficits_g.p2o5, 1)} / ${formatNum(rf.rf_deficits_g.k2o, 1)} g`
      : "— g";
  if (rf && rf.feature_importances_pct) {
    const top3 = Object.entries(rf.feature_importances_pct)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} (${formatNum(v, 1)}%)`)
      .join(", ");
    document.getElementById("rf-top-features-val").textContent = top3;
  } else {
    document.getElementById("rf-top-features-val").textContent = "—";
  }

  renderNotice("ph-warning-box", s.mixer.phWarning || "", s.mixer.phWarning ? "warn" : "");
  renderNotice("ec-check-box", s.mixer.ecNotice, s.mixer.ecNoticeType);

  // Workspace 5: Spray & Audit
  renderNotice("drone-spray-notice", s.spray.noticeText, s.spray.noticeType);
  renderReviewTable();
  updateProgressAndSummary();
}

function renderNotice(elementId, text, type) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.classList.remove("hidden", "is-ok", "is-danger");
  if (!text) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  if (type === "ok") el.classList.add("is-ok");
  if (type === "danger") el.classList.add("is-danger");
  el.textContent = text;
}

/* ==================== NAVIGATION & PROGRESS ==================== */

function goToStep(stepNumber) {
  appState.currentStep = stepNumber;

  document.querySelectorAll(".step-item").forEach((btn) => {
    btn.classList.toggle("is-active", Number(btn.dataset.step) === stepNumber);
  });

  document.querySelectorAll(".workspace-panel").forEach((panel) => {
    panel.classList.toggle("is-active", Number(panel.dataset.panel) === stepNumber);
  });

  document.getElementById("btn-prev-step").disabled = stepNumber === 1;
  document.getElementById("btn-next-step").disabled = stepNumber === 5;

  if (stepNumber === 1 && mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 60);
  }
  if (stepNumber === 5) {
    renderReviewTable();
  }
}

function updateProgressAndSummary() {
  const s = currentModeState();
  const stepBadges = [
    s.plot.confirmedAreaM2 ? s.plot.areaProvenance : "NO DATA",
    s.crop.profileId ? s.crop.provenance : "NO DATA",
    s.soil.provenance !== "NO DATA" ? s.soil.provenance : s.survey.provenance,
    s.mixer.pumpSec ? s.mixer.provenance : s.fermenter.provenance,
    s.spray.provenance,
  ];

  let completed = 0;
  stepBadges.forEach((status, idx) => {
    setBadge(document.getElementById(`nav-badge-${idx + 1}`), status);
    if (status !== "NO DATA") completed += 1;
  });

  document.getElementById("progress-counter").textContent = `${completed} / 5`;
  document.getElementById("progress-fill").style.width = `${Math.max(20, (completed / 5) * 100)}%`;

  document.getElementById("sum-plot").textContent = s.plot.name || "ยังไม่ได้กำหนด";
  document.getElementById("sum-area").textContent = s.plot.confirmedAreaM2
    ? `${formatNum(s.plot.confirmedAreaM2, 1)} ตร.ม. (${s.plot.areaProvenance})`
    : "NO DATA";
  document.getElementById("sum-crop").textContent = s.crop.cropName
    ? `${s.crop.cropName} (${s.crop.growthStage || "—"})`
    : "NO DATA";
  document.getElementById("sum-exg").textContent =
    s.survey.greenPct !== null ? `${formatNum(s.survey.greenPct, 1)}% (${s.survey.provenance})` : "NO DATA";
  document.getElementById("sum-soil").textContent =
    s.soil.moisturePct !== null || s.soil.ph !== null
      ? `ชื้น ${formatNum(s.soil.moisturePct, 1)}% • pH ${formatNum(s.soil.ph, 1)}`
      : "NO DATA";
  document.getElementById("sum-soil-npk").textContent = s.soil.nLevel
    ? `${s.soil.nLevel} / ${s.soil.pLevel} / ${s.soil.kLevel}`
    : "NO DATA";
  document.getElementById("sum-ferm-temps").textContent =
    s.fermenter.tempN !== null
      ? `${formatNum(s.fermenter.tempN, 1)} / ${formatNum(s.fermenter.tempP, 1)} / ${formatNum(s.fermenter.tempK, 1)} °C`
      : "NO DATA";
  document.getElementById("sum-ferm-tds").textContent =
    s.fermenter.mixerTds !== null ? `${formatNum(s.fermenter.mixerTds, 0)} ppm` : "NO DATA";
  document.getElementById("sum-mixer").textContent = s.mixer.pumpSec
    ? `คำนวณแล้ว (${s.mixer.provenance})`
    : "NO DATA";
}

/* ==================== WORKSPACE 1: LEAFLET MAP ==================== */

let mapInstance = null;
let drawnItems = null;
let activeEditHandler = null;
let isEditingPolygon = false;
let currentMapMode = "sat";

function applyThaiDrawLocal() {
  if (!L.drawLocal) return;
  L.drawLocal.draw.handlers.polygon.tooltip = {
    start: "คลิกบนแผนที่เพื่อเริ่มวางมุมแรกของแปลง",
    cont: "คลิกวางมุมถัดไปเรื่อยๆ ตามขอบเขตแปลง",
    end: "คลิกที่จุดแรกอีกครั้ง (หรือดับเบิลคลิก) เพื่อปิดรูปแปลง",
  };
  L.drawLocal.draw.handlers.rectangle.tooltip = {
    start: "คลิกค้างแล้วลากบนแผนที่เพื่อวาดแปลงสี่เหลี่ยม",
  };
  L.drawLocal.draw.handlers.simpleshape.tooltip = {
    end: "ปล่อยเมาส์เพื่อสร้างแปลงสี่เหลี่ยม",
  };
  L.drawLocal.edit.handlers.edit.tooltip = {
    text: "ลากจุดสีขาวเพื่อขยับมุมแปลง เสร็จแล้วกดปุ่ม 'บันทึกจุดมุมที่แก้'",
    subtext: "",
  };
}

function initMap() {
  const khunYuamCoords = [18.8396, 97.9268];
  if (typeof L === "undefined") {
    document.getElementById("map-empty-hint").textContent =
      "ไม่สามารถโหลดแผนที่ Leaflet ได้ (โปรดตรวจสอบการเชื่อมต่ออินเทอร์เน็ต)";
    return;
  }

  applyThaiDrawLocal();

  mapInstance = L.map("field-map", { zoomControl: false }).setView(khunYuamCoords, 15);
  const esriSatLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics",
      maxNativeZoom: 17,
      maxZoom: 20,
    }
  ).addTo(mapInstance);

  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxNativeZoom: 19,
    maxZoom: 20,
  });

  drawnItems = new L.FeatureGroup();
  mapInstance.addLayer(drawnItems);

  const polygonDrawer = new L.Draw.Polygon(mapInstance, {
    allowIntersection: false,
    showArea: true,
    shapeOptions: { color: "#15803d", weight: 3 },
  });
  const rectDrawer = new L.Draw.Rectangle(mapInstance, {
    showArea: true,
    shapeOptions: { color: "#15803d", weight: 3 },
  });

  mapInstance.on(L.Draw.Event.CREATED, (event) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(event.layer);
    handlePolygonChange(event.layer);
  });

  mapInstance.on(L.Draw.Event.EDITED, () => {
    const layers = drawnItems.getLayers();
    if (layers.length > 0) handlePolygonChange(layers[0]);
  });

  document.getElementById("btn-focus-khunyuam").addEventListener("click", () => {
    mapInstance.setView(khunYuamCoords, 16);
  });

  document.getElementById("btn-map-zoom-in").addEventListener("click", () => {
    mapInstance.zoomIn();
  });

  document.getElementById("btn-map-zoom-out").addEventListener("click", () => {
    mapInstance.zoomOut();
  });

  document.getElementById("btn-toggle-map-layer").addEventListener("click", (e) => {
    if (currentMapMode === "sat") {
      mapInstance.removeLayer(esriSatLayer);
      osmLayer.addTo(mapInstance);
      currentMapMode = "osm";
      e.currentTarget.textContent = "สลับแผนที่: แผนที่ถนน";
    } else {
      mapInstance.removeLayer(osmLayer);
      esriSatLayer.addTo(mapInstance);
      currentMapMode = "sat";
      e.currentTarget.textContent = "สลับแผนที่: ภาพดาวเทียม";
    }
  });

  document.getElementById("btn-draw-rect").addEventListener("click", () => {
    if (isEditingPolygon && activeEditHandler) {
      activeEditHandler.disable();
      isEditingPolygon = false;
      document.getElementById("btn-edit-polygon").textContent = "แก้ไขมุมแปลง";
    }
    polygonDrawer.disable();
    rectDrawer.enable();
  });

  document.getElementById("btn-draw-polygon").addEventListener("click", () => {
    if (isEditingPolygon && activeEditHandler) {
      activeEditHandler.disable();
      isEditingPolygon = false;
      document.getElementById("btn-edit-polygon").textContent = "แก้ไขมุมแปลง";
    }
    rectDrawer.disable();
    polygonDrawer.enable();
  });

  document.getElementById("btn-edit-polygon").addEventListener("click", (e) => {
    if (drawnItems.getLayers().length === 0) return;
    if (!isEditingPolygon) {
      rectDrawer.disable();
      polygonDrawer.disable();
      activeEditHandler = new L.EditToolbar.Edit(mapInstance, { featureGroup: drawnItems });
      activeEditHandler.enable();
      isEditingPolygon = true;
      e.currentTarget.textContent = "บันทึกจุดมุมที่แก้";
    } else if (activeEditHandler) {
      activeEditHandler.save();
      activeEditHandler.disable();
      isEditingPolygon = false;
      e.currentTarget.textContent = "แก้ไขมุมแปลง";
    }
  });

  document.getElementById("btn-clear-polygon").addEventListener("click", () => {
    if (isEditingPolygon && activeEditHandler) {
      activeEditHandler.disable();
      isEditingPolygon = false;
      document.getElementById("btn-edit-polygon").textContent = "แก้ไขมุมแปลง";
    }
    const s = currentModeState();
    s.plot.geojson = null;
    s.plot.calculatedAreaM2 = null;
    s.plot.confirmedAreaM2 = null;
    s.plot.areaProvenance = "NO DATA";
    s.plot.waypointsCm = [];
    renderCurrentModeUI();
  });
}

function renderMapPolygonForMode(geojson) {
  if (!drawnItems) return;
  drawnItems.clearLayers();
  if (geojson) {
    const geoLayer = L.geoJSON(geojson);
    geoLayer.eachLayer((l) => drawnItems.addLayer(l));
  }
}

function handlePolygonChange(layer) {
  const s = currentModeState();
  const latlngs = layer.getLatLngs()[0] || [];
  let areaM2 = 0;
  if (L.GeometryUtil && typeof L.GeometryUtil.geodesicArea === "function") {
    areaM2 = L.GeometryUtil.geodesicArea(latlngs);
  }
  s.plot.geojson = layer.toGeoJSON();
  s.plot.calculatedAreaM2 = Number(areaM2.toFixed(2));
  s.plot.confirmedAreaM2 = s.plot.calculatedAreaM2;
  s.plot.areaProvenance = "CALCULATED";
  renderCurrentModeUI();
}

function renderWaypointPreview(waypoints) {
  const tbody = document.getElementById("waypoint-table-body");
  const canvas = document.getElementById("waypoint-canvas");
  const ctx = canvas.getContext("2d");
  const badge = document.getElementById("badge-waypoints");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#faf9f6";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pad = 20;
  ctx.strokeStyle = "#cbc8be";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2);

  if (!waypoints || waypoints.length === 0) {
    setBadge(badge, "NO DATA");
    tbody.innerHTML =
      '<tr><td colspan="5" class="empty-cell">NO DATA — กดบันทึกแปลงเพื่อรับเส้นทางบินจาก Backend</td></tr>';
    return;
  }

  setBadge(badge, "CALCULATED");
  tbody.innerHTML = waypoints
    .map(
      (wp, i) => `
      <tr>
        <td class="tabular-num">${i + 1}</td>
        <td class="tabular-num">${formatNum(wp.dx, 1)}</td>
        <td class="tabular-num">${formatNum(wp.dy, 1)}</td>
        <td class="tabular-num">${formatNum(wp.distance_cm, 1)}</td>
        <td class="tabular-num">${formatNum(wp.angle_deg, 1)}°</td>
      </tr>`
    )
    .join("");

  const scaleX = (canvas.width - pad * 2) / 100;
  const scaleY = (canvas.height - pad * 2) / 80;
  let curX = pad + 20;
  let curY = canvas.height - pad - 20;

  ctx.beginPath();
  ctx.moveTo(curX, curY);
  ctx.strokeStyle = "#1f5e3b";
  ctx.lineWidth = 2;

  waypoints.forEach((wp) => {
    curX += (wp.dx || 0) * scaleX;
    curY -= (wp.dy || 0) * scaleY;
    ctx.lineTo(curX, curY);
  });
  ctx.stroke();
}

/* ==================== WORKSPACE 2: CROP PROFILE ==================== */

async function loadCrops() {
  const data = await apiRequest("/api/crops");
  const cropSel = document.getElementById("select-crop");
  const warn = document.getElementById("crop-backend-warning");

  if (!data || data.__error || !Array.isArray(data.crops)) {
    warn.classList.remove("hidden");
    cropSel.disabled = true;
    return;
  }

  warn.classList.add("hidden");
  appState.crops = data.crops;
  const uniqueCrops = [...new Set(appState.crops.map((c) => c.crop_name))];

  cropSel.innerHTML = '<option value="">-- เลือกชนิดพืช --</option>';
  uniqueCrops.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    cropSel.appendChild(opt);
  });
  cropSel.disabled = false;
  syncCropDropdownsToState();
}

function syncCropDropdownsToState() {
  const s = currentModeState();
  const cropSel = document.getElementById("select-crop");
  const varSel = document.getElementById("select-variety");
  const stageSel = document.getElementById("select-stage");

  document.getElementById("select-soil-type").value = s.crop.soilType || "loam";

  if (!s.crop.cropName) {
    cropSel.value = "";
    varSel.innerHTML = '<option value="">เลือกชนิดพืชก่อน</option>';
    varSel.disabled = true;
    stageSel.innerHTML = '<option value="">เลือกระยะการเจริญเติบโต</option>';
    stageSel.disabled = true;
  } else {
    cropSel.value = s.crop.cropName;
    populateVarieties(s.crop.cropName);
    varSel.value = s.crop.variety || "";
    if (s.crop.variety) {
      populateStages(s.crop.cropName, s.crop.variety);
      stageSel.value = s.crop.profileId ? String(s.crop.profileId) : "";
    }
  }

  const prof = s.crop.profile;
  document.getElementById("crop-root-depth").textContent = prof ? formatNum(prof.root_depth_m, 2) : "—";
  document.getElementById("crop-npk-target").textContent = prof
    ? `${formatNum(prof.target_n_g_m2, 2)} – ${formatNum(prof.target_p2o5_g_m2, 2)} – ${formatNum(prof.target_k2o_g_m2, 2)}`
    : "—";
  document.getElementById("crop-ph-range").textContent = prof
    ? `${formatNum(prof.ph_min, 1)} – ${formatNum(prof.ph_max, 1)}`
    : "—";
  document.getElementById("crop-ec-limit").textContent = prof ? `≤ ${formatNum(prof.safe_ec_max_ppm, 0)}` : "—";
  setBadge(document.getElementById("badge-crop-profile"), s.crop.provenance);
}

function populateVarieties(cropName) {
  const varSel = document.getElementById("select-variety");
  const varieties = [...new Set(appState.crops.filter((c) => c.crop_name === cropName).map((c) => c.variety))];
  varSel.innerHTML = '<option value="">-- เลือกสายพันธุ์ --</option>';
  varieties.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    varSel.appendChild(opt);
  });
  varSel.disabled = varieties.length === 0;
}

function populateStages(cropName, variety) {
  const stageSel = document.getElementById("select-stage");
  const stages = appState.crops.filter((c) => c.crop_name === cropName && c.variety === variety);
  stageSel.innerHTML = '<option value="">-- เลือกระยะการเจริญเติบโต --</option>';
  stages.forEach((st) => {
    const opt = document.createElement("option");
    opt.value = st.id;
    opt.textContent = st.growth_stage;
    stageSel.appendChild(opt);
  });
  stageSel.disabled = stages.length === 0;
}

function bindCropSelectors() {
  const cropSel = document.getElementById("select-crop");
  const varSel = document.getElementById("select-variety");
  const stageSel = document.getElementById("select-stage");

  cropSel.addEventListener("change", () => {
    const s = currentModeState();
    s.crop.cropName = cropSel.value || null;
    s.crop.variety = null;
    s.crop.profileId = null;
    s.crop.growthStage = null;
    s.crop.profile = null;
    s.crop.provenance = "NO DATA";
    renderCurrentModeUI();
  });

  varSel.addEventListener("change", () => {
    const s = currentModeState();
    s.crop.variety = varSel.value || null;
    s.crop.profileId = null;
    s.crop.growthStage = null;
    s.crop.profile = null;
    s.crop.provenance = "NO DATA";
    renderCurrentModeUI();
  });

  stageSel.addEventListener("change", () => {
    const s = currentModeState();
    const profile = appState.crops.find((c) => String(c.id) === String(stageSel.value));
    if (!profile) {
      s.crop.profileId = null;
      s.crop.profile = null;
      s.crop.provenance = "NO DATA";
    } else {
      s.crop.profileId = profile.id;
      s.crop.growthStage = profile.growth_stage;
      s.crop.profile = profile;
      s.crop.provenance = "MANUAL";
    }
    renderCurrentModeUI();
  });

  document.getElementById("select-soil-type").addEventListener("change", (e) => {
    currentModeState().crop.soilType = e.target.value;
  });
}

/* ==================== WORKSPACE 3: ASSESSMENT & SOIL ==================== */

function bindWorkspace3() {
  document.getElementById("btn-drone-survey-live").addEventListener("click", () =>
    triggerDroneMission("survey_photo", "LIVE")
  );
  document.getElementById("btn-drone-survey-sim").addEventListener("click", () =>
    triggerDroneMission("survey_photo", "SIMULATED")
  );

  document.getElementById("input-survey-image").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const s = currentModeState();

    const reader = new FileReader();
    reader.onload = () => {
      s.survey.origImageUrl = reader.result;
      renderCurrentModeUI();
    };
    reader.readAsDataURL(file);

    const formData = new FormData();
    formData.append("image", file);
    formData.append("mode", appState.activeMode);
    if (s.plot.id) formData.append("plot_id", s.plot.id);

    const res = await apiRequest("/api/drone/analyze-image", { method: "POST", body: formData });
    if (res && typeof res.green_coverage_pct === "number") {
      s.survey.greenPct = res.green_coverage_pct;
      s.survey.maskImageUrl = res.mask_image_url;
      s.survey.provenance = "CALCULATED";
      renderCurrentModeUI();
    }
  });

  document.getElementById("btn-refresh-soil").addEventListener("click", refreshBackendForActiveMode);

  document.getElementById("btn-sim-soil").addEventListener("click", async () => {
    const s = currentModeState();
    const payload = {
      plot_id: s.plot.id || 1,
      mode: "sim",
      simulated: true,
      moisture_pct: 42.5,
      ec_us_cm: 310,
    };
    const res = await apiRequest("/api/soil/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res && !res.__error) {
      s.soil.moisturePct = payload.moisture_pct;
      s.soil.ecUsCm = payload.ec_us_cm;
      s.soil.recordedAt = new Date().toLocaleTimeString("th-TH");
      s.soil.provenance = "SIMULATED";
      renderCurrentModeUI();
    }
  });

  document.getElementById("form-manual-soil").addEventListener("submit", async (e) => {
    e.preventDefault();
    const s = currentModeState();
    const payload = {
      plot_id: s.plot.id || 1,
      mode: appState.activeMode,
      n_level: document.getElementById("manual-n").value,
      p_level: document.getElementById("manual-p").value,
      k_level: document.getElementById("manual-k").value,
      ph_value: Number(document.getElementById("manual-ph").value),
    };
    const res = await apiRequest("/api/soil/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res && !res.__error) {
      s.soil.nLevel = payload.n_level;
      s.soil.pLevel = payload.p_level;
      s.soil.kLevel = payload.k_level;
      s.soil.ph = payload.ph_value;
      s.soil.manualProvenance = "MANUAL";
      if (s.soil.provenance === "NO DATA") {
        s.soil.provenance = "MANUAL";
      }
      renderCurrentModeUI();
    }
  });
}

async function triggerDroneMission(mode, executionMode) {
  const s = currentModeState();
  const isSurvey = mode === "survey_photo";

  const res = await apiRequest("/api/drone/mission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plot_id: s.plot.id || 1,
      mode,
      execution_mode: executionMode,
      waypoints_cm: s.plot.waypointsCm,
    }),
  });

  const target = isSurvey ? s.survey : s.spray;
  if (!res) {
    target.noticeType = "danger";
    target.noticeText = "ไม่สามารถเชื่อมต่อ Backend API ได้";
  } else if (res.__error) {
    target.noticeType = "danger";
    target.noticeText = res.__error;
  } else if (executionMode === "SIMULATED") {
    target.noticeType = "sim";
    target.noticeText = `โหมดจำลอง (SIMULATED): ${res.message} — ไม่ใช่การบินจริงของตัวโดรน`;
    target.status = res.status || "completed";
    target.provenance = "SIMULATED";
  } else {
    target.noticeType = "ok";
    target.noticeText = `สั่งการโดรนจริงสำเร็จ (LIVE): ${res.message}`;
    target.status = res.status || "completed";
    target.provenance = "LIVE";
  }
  renderCurrentModeUI();
}

/* ==================== WORKSPACE 4: FERMENTER & MIXER ==================== */

function bindWorkspace4() {
  document.getElementById("btn-refresh-fermenter").addEventListener("click", refreshBackendForActiveMode);

  document.getElementById("btn-sim-fermenter").addEventListener("click", async () => {
    const s = currentModeState();
    const payload = {
      mode: "sim",
      simulated: true,
      temp_n: 31.2,
      temp_p: 30.8,
      temp_k: 31.5,
      mixer_tds_ppm: 740,
    };
    const res = await apiRequest("/api/fermenter/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res && !res.__error) {
      s.fermenter.tempN = payload.temp_n;
      s.fermenter.tempP = payload.temp_p;
      s.fermenter.tempK = payload.temp_k;
      s.fermenter.mixerTds = payload.mixer_tds_ppm;
      s.fermenter.provenance = "SIMULATED";
      renderCurrentModeUI();
    }
  });

  document.getElementById("btn-calc-recipe").addEventListener("click", async () => {
    const s = currentModeState();
    const res = await apiRequest("/api/mixer/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plot_id: s.plot.id || 1,
        mode: appState.activeMode,
        crop_profile_id: s.crop.profileId,
        confirmed_area_m2: s.plot.confirmedAreaM2,
        soil_type: s.crop.soilType,
        exg_green_pct: s.survey.greenPct,
      }),
    });
    if (!res) return;
    if (res.__error) {
      s.mixer.ecNotice = res.__error;
      s.mixer.ecNoticeType = "danger";
      renderCurrentModeUI();
      return;
    }

    s.mixer.jobId = res.job_id || null;
    s.mixer.deficits = res.deficits_g;
    s.mixer.volumes = res.demo_volumes_ml;
    s.mixer.pumpSec = res.pump_seconds;
    s.mixer.phWarning = res.ph_warning || null;
    s.mixer.rfPrediction = res.rf_prediction || null;
    s.mixer.provenance = "CALCULATED";
    s.mixer.ecNotice = "";
    renderCurrentModeUI();
  });

  document.getElementById("btn-send-mixer-live").addEventListener("click", async () => {
    const s = currentModeState();
    const res = await apiRequest("/api/mixer/dispense-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res || res.__error || !res.ok) {
      s.mixer.ecNotice = (res && (res.__error || res.error)) || "ยังไม่มีคำสั่งผสมปุ๋ยที่รอจ่ายในโหมด LIVE (กรุณากดคำนวณสูตรก่อน)";
      s.mixer.ecNoticeType = "danger";
    } else {
      const d = res.durations_sec || {};
      s.mixer.ecNotice = `สั่งปั๊ม Raspberry Pi GPIO (17, 27, 22, 23) ทำงานแล้ว (Job #${res.job_id}: N ${formatNum(d.n, 1)}s, P ${formatNum(d.p, 1)}s, K ${formatNum(d.k, 1)}s, น้ำ ${formatNum(d.water, 1)}s)`;
      s.mixer.ecNoticeType = "ok";
    }
    renderCurrentModeUI();
  });

  document.getElementById("btn-stop-mixer-live").addEventListener("click", async () => {
    const s = currentModeState();
    await apiRequest("/api/mixer/stop-live", { method: "POST" });
    s.mixer.ecNotice = "สั่งหยุดปั๊มทั้ง 4 ตัวทันทีแล้ว (Emergency Stop)";
    s.mixer.ecNoticeType = "danger";
    renderCurrentModeUI();
  });

  document.getElementById("btn-check-ec-live").addEventListener("click", () => runEcCheck(false));
  document.getElementById("btn-sim-ec-check").addEventListener("click", () => runEcCheck(true));
}

async function runEcCheck(isSim) {
  const s = currentModeState();
  const res = await apiRequest("/api/mixer/check-ec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: s.mixer.jobId || 1,
      mode: isSim ? "sim" : "live",
      simulated: isSim,
    }),
  });
  if (!res) return;
  if (res.__error) {
    s.mixer.ecNotice = res.__error;
    s.mixer.ecNoticeType = "danger";
  } else {
    const prefix = isSim ? "SIMULATED EC Guard" : "LIVE EC Guard";
    s.mixer.ecNotice = `${prefix}: วัดได้ ${formatNum(res.measured_tds_ppm, 0)} ppm — ${res.message}`;
    s.mixer.ecNoticeType = res.needs_dilution ? "danger" : "ok";
  }
  renderCurrentModeUI();
}

/* ==================== WORKSPACE 5: REVIEW & CHECKLIST ==================== */

function bindWorkspace5() {
  const checks = document.querySelectorAll(".safety-check");
  const btnLive = document.getElementById("btn-drone-spray-live");
  const btnSim = document.getElementById("btn-drone-spray-sim");

  checks.forEach((chk) => {
    chk.addEventListener("change", () => {
      const allChecked = Array.from(checks).every((c) => c.checked);
      btnLive.disabled = !allChecked;
      btnSim.disabled = !allChecked;
    });
  });

  btnLive.addEventListener("click", () => triggerDroneMission("spray_fertilizer", "LIVE"));
  btnSim.addEventListener("click", () => triggerDroneMission("spray_fertilizer", "SIMULATED"));
}

function renderReviewTable() {
  const s = currentModeState();
  document.getElementById("rev-area").textContent = s.plot.confirmedAreaM2
    ? `${s.plot.name} (${formatNum(s.plot.confirmedAreaM2, 1)} ตร.ม.)`
    : "—";
  setBadge(document.getElementById("rev-area-badge"), s.plot.confirmedAreaM2 ? s.plot.areaProvenance : "NO DATA");

  document.getElementById("rev-crop").textContent = s.crop.cropName
    ? `${s.crop.cropName} / ${s.crop.variety || "—"} / ${s.crop.growthStage || "—"}`
    : "—";
  setBadge(document.getElementById("rev-crop-badge"), s.crop.provenance);

  document.getElementById("rev-exg").textContent =
    s.survey.greenPct !== null ? `${formatNum(s.survey.greenPct, 1)}% Green Coverage` : "—";
  setBadge(document.getElementById("rev-exg-badge"), s.survey.provenance);

  document.getElementById("rev-soil").textContent =
    s.soil.moisturePct !== null || s.soil.ph !== null
      ? `ความชื้น ${formatNum(s.soil.moisturePct, 1)}% • pH ${formatNum(s.soil.ph, 1)}`
      : "—";
  setBadge(document.getElementById("rev-soil-badge"), s.soil.provenance);

  document.getElementById("rev-mixer").textContent = s.mixer.pumpSec
    ? `N ${formatNum(s.mixer.pumpSec.n, 1)}s / P ${formatNum(s.mixer.pumpSec.p, 1)}s / K ${formatNum(s.mixer.pumpSec.k, 1)}s`
    : "—";
  setBadge(document.getElementById("rev-mixer-badge"), s.mixer.provenance);
}

/* ==================== SETTINGS MODAL ==================== */

function bindSettingsModal() {
  const modal = document.getElementById("settings-modal");
  const openBtn = document.getElementById("btn-open-settings");
  const closeBtns = [document.getElementById("btn-close-settings"), document.getElementById("btn-cancel-settings")];

  openBtn.addEventListener("click", async () => {
    modal.classList.remove("hidden");
    const cfg = await apiRequest("/api/config");
    const note = document.getElementById("settings-backend-note");
    if (!cfg || cfg.__error) {
      note.classList.remove("hidden");
      return;
    }
    note.classList.add("hidden");
    document.getElementById("cfg-q-n").value = cfg.q_pump_n ?? "";
    document.getElementById("cfg-q-p").value = cfg.q_pump_p ?? "";
    document.getElementById("cfg-q-k").value = cfg.q_pump_k ?? "";
    document.getElementById("cfg-q-w").value = cfg.q_pump_water ?? "";
    document.getElementById("cfg-table-w").value = cfg.table_width_cm ?? "";
    document.getElementById("cfg-table-h").value = cfg.table_height_cm ?? "";
  });

  closeBtns.forEach((b) => b.addEventListener("click", () => modal.classList.add("hidden")));

  document.getElementById("form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    await apiRequest("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q_pump_n: Number(document.getElementById("cfg-q-n").value),
        q_pump_p: Number(document.getElementById("cfg-q-p").value),
        q_pump_k: Number(document.getElementById("cfg-q-k").value),
        q_pump_water: Number(document.getElementById("cfg-q-w").value),
        table_width_cm: Number(document.getElementById("cfg-table-w").value),
        table_height_cm: Number(document.getElementById("cfg-table-h").value),
      }),
    });
    modal.classList.add("hidden");
  });
}

/* ==================== BOTTOM BAR & INIT ==================== */

function bindNavigationAndSave() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setOperationalMode(btn.dataset.mode));
  });

  document.querySelectorAll(".step-item").forEach((btn) => {
    btn.addEventListener("click", () => goToStep(Number(btn.dataset.step)));
  });

  document.getElementById("btn-prev-step").addEventListener("click", () => {
    if (appState.currentStep > 1) goToStep(appState.currentStep - 1);
  });

  document.getElementById("btn-next-step").addEventListener("click", () => {
    if (appState.currentStep < 5) goToStep(appState.currentStep + 1);
  });

  document.getElementById("input-plot-name").addEventListener("input", (e) => {
    currentModeState().plot.name = e.target.value;
    updateProgressAndSummary();
  });

  document.getElementById("input-confirmed-area").addEventListener("input", (e) => {
    const s = currentModeState();
    const val = Number(e.target.value);
    if (val > 0) {
      s.plot.confirmedAreaM2 = val;
      s.plot.areaProvenance =
        s.plot.calculatedAreaM2 && Math.abs(val - s.plot.calculatedAreaM2) < 0.01 ? "CALCULATED" : "MANUAL";
    } else {
      s.plot.confirmedAreaM2 = null;
      s.plot.areaProvenance = "NO DATA";
    }
    document.getElementById("val-conf-area-display").textContent = formatNum(s.plot.confirmedAreaM2, 2);
    setBadge(document.getElementById("badge-conf-area"), s.plot.areaProvenance);
    updateProgressAndSummary();
  });

  document.getElementById("btn-save-step").addEventListener("click", async () => {
    const s = currentModeState();
    if (appState.currentStep === 1 && s.plot.geojson) {
      const res = await apiRequest("/api/plots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: appState.activeMode,
          plot_name: s.plot.name,
          polygon_geojson: s.plot.geojson,
          calculated_area_m2: s.plot.calculatedAreaM2,
          confirmed_area_m2: s.plot.confirmedAreaM2,
          soil_type: s.crop.soilType,
          crop_profile_id: s.crop.profileId || 1,
        }),
      });
      if (res && !res.__error) {
        s.plot.id = res.plot_id;
        s.plot.waypointsCm = res.waypoints_cm || [];
        renderWaypointPreview(s.plot.waypointsCm);
      }
    }
    updateProgressAndSummary();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindCropSelectors();
  bindWorkspace3();
  bindWorkspace4();
  bindWorkspace5();
  bindSettingsModal();
  bindNavigationAndSave();
  setOperationalMode("sim");
  loadCrops();
});
