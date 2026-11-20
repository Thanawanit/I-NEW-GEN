/**
 * Smart Bio-Fert Drone — Focused Single-Stage Wizard Controller
 * - Strict SIM vs LIVE isolation across every stage, API request, and UI state.
 * - Progressive disclosure: only the active step's UI is shown.
 * - Follows modern-web-guidance patterns for <dialog>, <progress>, <select>, and compositor motion.
 */

const STAGE_TITLES = [
  "ขั้นที่ 1 จาก 7 • ตั้งชื่อแปลงที่ดิน",
  "ขั้นที่ 2 จาก 7 • วาดขอบเขตแปลงบนแผนที่ดาวเทียม",
  "ขั้นที่ 3 จาก 7 • เลือกชนิดพืชและชนิดดิน",
  "ขั้นที่ 4 จาก 7 • โดรนสำรวจความเขียวของแปลง",
  "ขั้นที่ 5 จาก 7 • ตรวจวัดธาตุอาหารในดิน",
  "ขั้นที่ 6 จาก 7 • คำนวณสูตรปุ๋ยและจ่ายผสม 1,000 ml",
  "ขั้นที่ 7 จาก 7 • เติมน้ำเข้าตลับโดรนและบินพ่น",
];

function createEmptyModeState() {
  return {
    stage: 0,
    maxStage: 0,
    plot: {
      id: null,
      name: "",
      polygonGeojson: null,
      latlngs: null,
      calculatedAreaM2: null,
      confirmedAreaM2: null,
      waypointsCm: [],
    },
    crop: {
      profileId: null,
      cropName: "",
      variety: "",
      growthStage: "",
      soilType: "",
    },
    survey: {
      origUrl: "",
      maskUrl: "",
      greenPct: null,
      done: false,
    },
    soil: {
      points: [],
      done: false,
    },
    mixer: {
      jobId: null,
      sysDeficit: null,
      rfDeficit: null,
      r2: null,
      mae: null,
      volumes: null,
      pumpSec: null,
      dispensedDone: false,
    },
    finalDrone: {
      done: false,
    },
  };
}

const appState = {
  activeMode: "sim", // 'sim' | 'live'
  crops: [],
  byMode: {
    sim: createEmptyModeState(),
    live: createEmptyModeState(),
  },
};

function currentState() {
  return appState.byMode[appState.activeMode];
}

function speakThai(text) {
  if (!("speechSynthesis" in window) || !text) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "th-TH";
    utter.rate = 1.02;
    window.speechSynthesis.speak(utter);
  } catch (_) {}
}

async function apiRequest(url, options = {}) {
  try {
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { __error: data.error || data.message || `HTTP ${resp.status}`, __status: resp.status, ...data };
    }
    return data;
  } catch (err) {
    return { __error: err.message || "Network error", __status: 0 };
  }
}

function formatNum(val, digits = 1) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(digits);
}

function areaM2ToThaiText(areaM2) {
  const m2 = Number(areaM2);
  if (!Number.isFinite(m2) || m2 <= 0) return "กรุณาวาดขอบเขตแปลงบนแผนที่ด้านบน";
  const rai = Math.floor(m2 / 1600);
  const remRai = m2 % 1600;
  const ngan = Math.floor(remRai / 400);
  const wah = (remRai % 400) / 4;
  return `เท่ากับ ${rai} ไร่ ${ngan} งาน ${wah.toFixed(1)} ตารางวา`;
}

/* ==================== STAGE NAVIGATION & MODE SWITCHER ==================== */

function goToStage(stageIndex) {
  const idx = Math.max(0, Math.min(6, Number(stageIndex)));
  const s = currentState();
  s.stage = idx;
  if (idx > s.maxStage) s.maxStage = idx;

  document.querySelectorAll("[data-stage]").forEach((el) => {
    const elStage = Number(el.dataset.stage);
    el.classList.toggle("hidden", elStage !== idx);
  });

  document.querySelectorAll("#step-dots .dot-btn").forEach((btn) => {
    const dStage = Number(btn.dataset.stage);
    btn.classList.toggle("is-active", dStage === idx);
    btn.classList.toggle("is-done", dStage < idx);
  });

  document.getElementById("stage-subtitle").textContent = STAGE_TITLES[idx] || "";

  if (idx === 1 && mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 60);
  }
}

function setOperationalMode(mode) {
  stopAutoSoilProbing(false);
  stopDispenseTimers();

  appState.activeMode = mode === "live" ? "live" : "sim";
  const isSim = appState.activeMode === "sim";

  const shell = document.getElementById("app-shell");
  shell.classList.toggle("is-mode-sim", isSim);
  shell.classList.toggle("is-mode-live", !isSim);

  document.getElementById("btn-mode-sim").classList.toggle("is-active", isSim);
  document.getElementById("btn-mode-live").classList.toggle("is-active", !isSim);

  const strip = document.getElementById("mode-strip");
  const badge = document.getElementById("mode-strip-badge");
  const text = document.getElementById("mode-strip-text");
  strip.classList.toggle("is-sim", isSim);
  strip.classList.toggle("is-live", !isSim);
  badge.className = `badge ${isSim ? "badge-simulated" : "badge-live"}`;
  badge.textContent = isSim ? "SIMULATED" : "LIVE HARDWARE";
  text.textContent = isSim
    ? "โหมดทดสอบจำลอง — ข้อมูลทั้งหมดแยกจากโหมดอุปกรณ์จริง 100%"
    : "โหมดอุปกรณ์จริง — เชื่อมต่อกล่องวัดดิน LoRa และเครื่องจ่ายปุ๋ย Raspberry Pi 5";

  restoreModeUI();
}

function restoreModeUI() {
  const s = currentState();
  document.getElementById("input-plot-name").value = s.plot.name || "";

  // Map polygon restore (strict SIM vs LIVE undo history isolation)
  undoStack = [];
  redoStack = [];
  if (drawnItems) {
    drawnItems.clearLayers();
    activePolygonLayer = null;
    if (s.plot.latlngs) {
      createEditablePolygonLayer(s.plot.latlngs, true);
    } else {
      updateUndoRedoButtons();
    }
  }
  updateAreaDisplay(s.plot.confirmedAreaM2);

  // Crop restore
  restoreCascadingCropUI();

  // Survey restore
  document.getElementById("survey-launch-wrap").classList.toggle("hidden", s.survey.done);
  document.getElementById("survey-status-wrap").classList.add("hidden");
  document.getElementById("survey-live-fallback").classList.add("hidden");
  document.getElementById("survey-result-wrap").classList.toggle("hidden", !s.survey.done);
  if (s.survey.done) {
    document.getElementById("img-before-exg").src = s.survey.origUrl;
    document.getElementById("img-after-exg").src = s.survey.maskUrl;
    document.getElementById("exg-pct-badge").textContent = `${formatNum(s.survey.greenPct, 1)} %`;
  }

  // Soil restore
  renderProbeCards(s.soil.points);

  // Mixer restore
  const hasCalc = Boolean(s.mixer.sysDeficit);
  document.getElementById("calc-launch-wrap").classList.toggle("hidden", hasCalc);
  document.getElementById("calc-status-wrap").classList.add("hidden");
  document.getElementById("calc-comparison-wrap").classList.toggle("hidden", !hasCalc);
  document.getElementById("dispense-live-section").classList.toggle("hidden", !s.mixer.dispensedDone);
  if (hasCalc) renderMixerComparison();

  goToStage(s.stage);
}

/* ==================== STAGE 0: PLOT NAME ==================== */

function bindStage0() {
  const input = document.getElementById("input-plot-name");
  const nextBtn = document.getElementById("btn-stage0-next");

  const proceed = () => {
    const name = input.value.trim() || "แปลงสาธิต";
    input.value = name;
    currentState().plot.name = name;
    goToStage(1);
  };

  nextBtn.addEventListener("click", proceed);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      proceed();
    }
  });
}

/* ==================== STAGE 1: SATELLITE MAP + POLYGON ONLY ==================== */

let mapInstance = null;
let drawnItems = null;
let polygonDrawer = null;
let undoStack = [];
let redoStack = [];
let activePolygonLayer = null;

function computeGeodesicAreaM2(latlngs) {
  if (!window.L || !L.GeometryUtil || !latlngs || latlngs.length < 3) return 0;
  return Math.abs(L.GeometryUtil.geodesicArea(latlngs));
}

function updateUndoRedoButtons() {
  document.getElementById("btn-map-undo").disabled = undoStack.length <= 1;
  document.getElementById("btn-map-redo").disabled = redoStack.length === 0;
}

function pushPolygonSnapshot(latlngs) {
  const clone = latlngs.map((pt) => [pt.lat, pt.lng]);
  undoStack.push(clone);
  redoStack = [];
  updateUndoRedoButtons();
}

function updateAreaDisplay(areaM2) {
  const input = document.getElementById("input-confirmed-area");
  const sub = document.getElementById("area-thai-sub");
  const btnConfirm = document.getElementById("btn-confirm-area");
  const val = Number(areaM2);
  if (Number.isFinite(val) && val > 0) {
    input.value = val.toFixed(1);
    sub.textContent = areaM2ToThaiText(val);
    btnConfirm.disabled = false;
  } else {
    input.value = "";
    sub.textContent = "กรุณาวาดขอบเขตแปลงบนแผนที่ด้านบน";
    btnConfirm.disabled = true;
  }
}

function syncPolygonToState(latlngs) {
  const s = currentState();
  if (!latlngs || latlngs.length < 3) {
    s.plot.latlngs = null;
    s.plot.polygonGeojson = null;
    s.plot.calculatedAreaM2 = null;
    s.plot.confirmedAreaM2 = null;
    updateAreaDisplay(null);
    return;
  }
  const latlngObjs = latlngs.map((p) => (Array.isArray(p) ? L.latLng(p[0], p[1]) : p));
  const area = computeGeodesicAreaM2(latlngObjs);
  const ring = latlngObjs.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);

  s.plot.latlngs = latlngObjs.map((p) => [p.lat, p.lng]);
  s.plot.polygonGeojson = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
  };
  s.plot.calculatedAreaM2 = area;
  s.plot.confirmedAreaM2 = area;
  updateAreaDisplay(area);
}

function enableWholePolygonDrag(layer) {
  let draggingShape = false;
  let lastLatLng = null;

  layer.on("mousedown touchstart", (e) => {
    if (!e.latlng) return;
    draggingShape = true;
    lastLatLng = e.latlng;
    mapInstance.dragging.disable();
  });

  mapInstance.on("mousemove touchmove", (e) => {
    if (!draggingShape || !lastLatLng || !e.latlng || activePolygonLayer !== layer) return;
    const dLat = e.latlng.lat - lastLatLng.lat;
    const dLng = e.latlng.lng - lastLatLng.lng;
    lastLatLng = e.latlng;

    const ring = layer.getLatLngs()[0].map((p) => L.latLng(p.lat + dLat, p.lng + dLng));
    layer.setLatLngs([ring]);
    if (layer.editing && layer.editing.enabled()) {
      layer.editing.updateMarkers();
    }
    syncPolygonToState(ring);
  });

  const endDrag = () => {
    if (!draggingShape) return;
    draggingShape = false;
    lastLatLng = null;
    mapInstance.dragging.enable();
    if (activePolygonLayer === layer) {
      pushPolygonSnapshot(layer.getLatLngs()[0]);
    }
  };
  mapInstance.on("mouseup touchend", endDrag);
}

function createEditablePolygonLayer(latlngs, recordSnapshot = true) {
  drawnItems.clearLayers();
  const poly = L.polygon(latlngs, {
    color: "#1e6b3a",
    fillColor: "#2f9e5b",
    fillOpacity: 0.28,
    weight: 2.5,
  });
  drawnItems.addLayer(poly);
  activePolygonLayer = poly;
  if (poly.editing) poly.editing.enable();

  poly.on("edit", () => {
    const pts = poly.getLatLngs()[0];
    syncPolygonToState(pts);
    pushPolygonSnapshot(pts);
  });

  enableWholePolygonDrag(poly);
  const pts = poly.getLatLngs()[0];
  syncPolygonToState(pts);
  if (recordSnapshot) {
    undoStack = [];
    redoStack = [];
    pushPolygonSnapshot(pts);
  }
}

function initStage1Map() {
  if (!window.L) return;
  // Satellite Imagery ONLY (Esri World Imagery) — no layer switcher
  mapInstance = L.map("map", {
    center: [18.8392, 97.9262],
    zoom: 17,
    zoomControl: true,
  });

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, attribution: "Esri World Imagery" }
  ).addTo(mapInstance);

  drawnItems = new L.FeatureGroup();
  mapInstance.addLayer(drawnItems);

  // Polygon only — rectangle intentionally excluded
  polygonDrawer = new L.Draw.Polygon(mapInstance, {
    allowIntersection: false,
    showArea: true,
    shapeOptions: { color: "#1e6b3a", fillOpacity: 0.28, weight: 2.5 },
  });

  mapInstance.on(L.Draw.Event.CREATED, (e) => {
    const pts = e.layer.getLatLngs()[0];
    createEditablePolygonLayer(pts, true);
    document.getElementById("map-tool-hint").textContent =
      "วาดสำเร็จ! ลากจุดขาวเพื่อปรับมุม หรือลากพื้นที่เพื่อย้ายตำแหน่งได้เลย";
  });

  document.getElementById("btn-map-draw").addEventListener("click", () => {
    polygonDrawer.enable();
    document.getElementById("map-tool-hint").textContent =
      "จิ้มจุดรอบแปลงบนแผนที่ แล้วกดจุดแรกอีกครั้งเพื่อปิดรูปแปลง";
  });

  document.getElementById("btn-map-undo").addEventListener("click", () => {
    if (undoStack.length <= 1) return;
    const current = undoStack.pop();
    redoStack.push(current);
    createEditablePolygonLayer(undoStack[undoStack.length - 1], false);
    updateUndoRedoButtons();
  });

  document.getElementById("btn-map-redo").addEventListener("click", () => {
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    undoStack.push(next);
    createEditablePolygonLayer(next, false);
    updateUndoRedoButtons();
  });

  document.getElementById("btn-map-reset").addEventListener("click", () => {
    if (polygonDrawer) polygonDrawer.disable();
    drawnItems.clearLayers();
    activePolygonLayer = null;
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    syncPolygonToState(null);
    document.getElementById("map-tool-hint").textContent =
      "กดปุ่มวาดแล้วจิ้มมุมแปลง หรือลากจุดเพื่อย้ายตำแหน่งได้เลย";
  });

  document.getElementById("btn-map-apply").addEventListener("click", () => {
    if (polygonDrawer) polygonDrawer.disable();
    if (activePolygonLayer) {
      if (activePolygonLayer.editing) activePolygonLayer.editing.disable();
      const pts = activePolygonLayer.getLatLngs()[0];
      syncPolygonToState(pts);
      setTimeout(() => activePolygonLayer && activePolygonLayer.editing && activePolygonLayer.editing.enable(), 40);
      document.getElementById("map-tool-hint").textContent = "บันทึกขอบเขตแปลงเรียบร้อยแล้ว";
    }
  });

  document.getElementById("input-confirmed-area").addEventListener("input", (e) => {
    const val = Number(e.target.value);
    currentState().plot.confirmedAreaM2 = Number.isFinite(val) && val > 0 ? val : null;
    document.getElementById("area-thai-sub").textContent = areaM2ToThaiText(val);
    document.getElementById("btn-confirm-area").disabled = !(Number.isFinite(val) && val > 0);
  });

  document.getElementById("btn-confirm-area").addEventListener("click", async () => {
    const s = currentState();
    const areaVal = Number(document.getElementById("input-confirmed-area").value);
    if (!Number.isFinite(areaVal) || areaVal <= 0) return;
    s.plot.confirmedAreaM2 = areaVal;

    const geojson = s.plot.polygonGeojson || {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[97.926, 18.839], [97.9265, 18.839], [97.9265, 18.8395], [97.926, 18.8395], [97.926, 18.839]]],
      },
    };
    const res = await apiRequest("/api/plots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plot_name: s.plot.name || "แปลงสาธิต",
        mode: appState.activeMode,
        polygon_geojson: geojson,
        calculated_area_m2: s.plot.calculatedAreaM2 || areaVal,
        confirmed_area_m2: areaVal,
        soil_type: s.crop.soilType || "loam",
        crop_profile_id: s.crop.profileId || 1,
      }),
    });
    if (res && res.plot_id) {
      s.plot.id = res.plot_id;
      s.plot.waypointsCm = res.waypoints_cm || [];
    }
    goToStage(2);
  });
}

/* ==================== STAGE 2: SEQUENTIAL CASCADING DROPDOWNS ==================== */

function restoreCascadingCropUI() {
  const s = currentState();
  const selCrop = document.getElementById("select-crop-name");
  const selVar = document.getElementById("select-variety");
  const selStage = document.getElementById("select-growth-stage");
  const selSoil = document.getElementById("select-soil-type");

  const cropNames = [...new Set(appState.crops.map((c) => c.crop_name))];
  selCrop.innerHTML = '<option value="" disabled selected>เลือกชนิดพืช...</option>';
  cropNames.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    selCrop.appendChild(opt);
  });

  if (s.crop.cropName) {
    selCrop.value = s.crop.cropName;
    populateVarieties(s.crop.cropName);
    document.getElementById("wrap-variety").classList.remove("hidden");
  } else {
    document.getElementById("wrap-variety").classList.add("hidden");
  }

  if (s.crop.variety) {
    selVar.value = s.crop.variety;
    populateStages(s.crop.cropName, s.crop.variety);
    document.getElementById("wrap-stage").classList.remove("hidden");
  } else {
    document.getElementById("wrap-stage").classList.add("hidden");
  }

  if (s.crop.growthStage) {
    selStage.value = s.crop.growthStage;
    document.getElementById("wrap-soil-type").classList.remove("hidden");
  } else {
    document.getElementById("wrap-soil-type").classList.add("hidden");
  }

  if (s.crop.soilType) {
    selSoil.value = s.crop.soilType;
    document.getElementById("wrap-stage2-submit").classList.remove("hidden");
  } else {
    selSoil.value = "";
    document.getElementById("wrap-stage2-submit").classList.add("hidden");
  }
}

function populateVarieties(cropName) {
  const selVar = document.getElementById("select-variety");
  const varieties = [...new Set(appState.crops.filter((c) => c.crop_name === cropName).map((c) => c.variety))];
  selVar.innerHTML = '<option value="" disabled selected>เลือกสายพันธุ์...</option>';
  varieties.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selVar.appendChild(opt);
  });
}

function populateStages(cropName, variety) {
  const selStage = document.getElementById("select-growth-stage");
  const stages = appState.crops.filter((c) => c.crop_name === cropName && c.variety === variety);
  selStage.innerHTML = '<option value="" disabled selected>เลือกระยะการเจริญเติบโต...</option>';
  stages.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.growth_stage;
    opt.textContent = p.growth_stage;
    selStage.appendChild(opt);
  });
}

function bindStage2() {
  const selCrop = document.getElementById("select-crop-name");
  const selVar = document.getElementById("select-variety");
  const selStage = document.getElementById("select-growth-stage");
  const selSoil = document.getElementById("select-soil-type");

  selCrop.addEventListener("change", (e) => {
    const s = currentState();
    s.crop.cropName = e.target.value;
    s.crop.variety = "";
    s.crop.growthStage = "";
    s.crop.profileId = null;
    populateVarieties(s.crop.cropName);
    document.getElementById("wrap-variety").classList.remove("hidden");
    document.getElementById("wrap-stage").classList.add("hidden");
    document.getElementById("wrap-soil-type").classList.add("hidden");
    document.getElementById("wrap-stage2-submit").classList.add("hidden");
  });

  selVar.addEventListener("change", (e) => {
    const s = currentState();
    s.crop.variety = e.target.value;
    s.crop.growthStage = "";
    s.crop.profileId = null;
    populateStages(s.crop.cropName, s.crop.variety);
    document.getElementById("wrap-stage").classList.remove("hidden");
    document.getElementById("wrap-soil-type").classList.add("hidden");
    document.getElementById("wrap-stage2-submit").classList.add("hidden");
  });

  selStage.addEventListener("change", (e) => {
    const s = currentState();
    s.crop.growthStage = e.target.value;
    const match = appState.crops.find(
      (c) => c.crop_name === s.crop.cropName && c.variety === s.crop.variety && c.growth_stage === s.crop.growthStage
    );
    s.crop.profileId = match ? match.id : null;
    document.getElementById("wrap-soil-type").classList.remove("hidden");
  });

  selSoil.addEventListener("change", (e) => {
    currentState().crop.soilType = e.target.value;
    document.getElementById("wrap-stage2-submit").classList.remove("hidden");
  });

  document.getElementById("form-crop-cascade").addEventListener("submit", (e) => {
    e.preventDefault();
    const s = currentState();
    if (!s.crop.profileId || !s.crop.soilType) return;
    goToStage(3);
  });
}

/* ==================== STAGE 3: DRONE SURVEY BEFORE / AFTER ==================== */

function showSurveyImages(origUrl, maskUrl, greenPct) {
  const s = currentState();
  s.survey = { origUrl, maskUrl, greenPct, done: true };
  document.getElementById("survey-status-wrap").classList.add("hidden");
  document.getElementById("survey-live-fallback").classList.add("hidden");
  document.getElementById("img-before-exg").src = origUrl;
  document.getElementById("img-after-exg").src = maskUrl;
  document.getElementById("exg-pct-badge").textContent = `${formatNum(greenPct, 1)} %`;
  document.getElementById("survey-result-wrap").classList.remove("hidden");
}

function bindStage3() {
  document.getElementById("btn-fly-survey").addEventListener("click", async () => {
    const s = currentState();
    const mode = appState.activeMode;
    document.getElementById("survey-launch-wrap").classList.add("hidden");
    const statusWrap = document.getElementById("survey-status-wrap");
    const statusText = document.getElementById("survey-status-text");
    statusWrap.classList.remove("hidden");

    statusText.textContent = "กำลังส่งคำสั่งให้โดรนขึ้นบิน...";
    const mission = await apiRequest("/api/drone/mission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plot_id: s.plot.id || 1,
        mode: "survey_photo",
        execution_mode: mode === "live" ? "LIVE" : "SIMULATED",
        waypoints_cm: s.plot.waypointsCm,
      }),
    });

    if (mode === "live" && mission.__status === 501) {
      // Live drone Wi-Fi SDK not wired yet -> switch smoothly to photo upload fallback
      statusWrap.classList.add("hidden");
      document.getElementById("survey-live-fallback").classList.remove("hidden");
      return;
    }

    statusText.textContent = "โดรนกำลังบินถ่ายภาพแปลงและวิเคราะห์ความเขียว (ExG)...";
    await new Promise((r) => setTimeout(r, 700));
    const sample = await apiRequest("/api/drone/analyze-sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plot_id: s.plot.id || 1, mode }),
    });
    if (sample && sample.ok) {
      showSurveyImages(sample.orig_image_url, sample.mask_image_url, sample.green_coverage_pct);
    }
  });

  document.getElementById("input-survey-image").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const s = currentState();
    document.getElementById("survey-live-fallback").classList.add("hidden");
    document.getElementById("survey-status-wrap").classList.remove("hidden");
    document.getElementById("survey-status-text").textContent = "กำลังวิเคราะห์พื้นที่สีเขียว (ExG) จากภาพถ่าย...";

    const origDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });

    const formData = new FormData();
    formData.append("image", file);
    formData.append("mode", appState.activeMode);
    formData.append("plot_id", String(s.plot.id || 1));

    const res = await apiRequest("/api/drone/analyze-image", { method: "POST", body: formData });
    if (res && typeof res.green_coverage_pct === "number") {
      showSurveyImages(origDataUrl, res.mask_image_url, res.green_coverage_pct);
    }
  });

  document.getElementById("btn-survey-accept").addEventListener("click", () => goToStage(4));
}

/* ==================== STAGE 4: AUTO 1-15 SOIL PROBING + 5-PRONG SENSOR CARDS ==================== */

let _probeTimer = null;
let _probeRunning = false;

function renderProbeCards(pointsList) {
  const validPts = (pointsList || []).filter((p) => p && p.n !== null);
  const grid = document.getElementById("probe-cards-grid");
  const progressWrap = document.getElementById("probe-progress-wrap");
  const bar = document.getElementById("probe-progress-bar");
  const countText = document.getElementById("probe-count-text");
  const confirmWrap = document.getElementById("probe-confirm-wrap");

  if (validPts.length > 0 || _probeRunning) {
    progressWrap.classList.remove("hidden");
  } else {
    progressWrap.classList.add("hidden");
  }

  bar.value = validPts.length;
  // Clean non-pressuring count (never display "x/15")
  countText.textContent = `ปักแล้ว ${validPts.length} ครั้ง`;
  confirmWrap.classList.toggle("hidden", validPts.length === 0 || _probeRunning);

  grid.innerHTML = "";
  validPts.forEach((pt) => {
    const card = document.createElement("div");
    card.className = "sensor-probe-card";
    card.innerHTML = `
      <div class="sensor-body">
        <div class="sensor-head-tag">
          <span>หัววัดดิน • จุดที่ ${pt.point_index}</span>
          <span>5-PIN</span>
        </div>
        <div class="sensor-metrics">
          <div class="sensor-metric"><span>N</span><strong class="tabular-num">${formatNum(pt.n, 0)}</strong></div>
          <div class="sensor-metric"><span>P</span><strong class="tabular-num">${formatNum(pt.p, 0)}</strong></div>
          <div class="sensor-metric"><span>K</span><strong class="tabular-num">${formatNum(pt.k, 0)}</strong></div>
          <div class="sensor-metric"><span>pH</span><strong class="tabular-num">${formatNum(pt.ph, 1)}</strong></div>
        </div>
      </div>
      <div class="sensor-prongs" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
    `;
    grid.appendChild(card);
  });
}

function stopAutoSoilProbing(announce = true) {
  _probeRunning = false;
  if (_probeTimer) {
    clearTimeout(_probeTimer);
    _probeTimer = null;
  }
  const startBtn = document.getElementById("btn-start-probe");
  const stopBtn = document.getElementById("btn-stop-probe");
  if (startBtn) startBtn.classList.remove("hidden");
  if (stopBtn) stopBtn.classList.add("hidden");

  const s = currentState();
  const count = (s.soil.points || []).filter((p) => p && p.n !== null).length;
  if (count > 0) s.soil.done = true;
  renderProbeCards(s.soil.points);

  if (announce) {
    document.getElementById("probe-voice-status").textContent = `หยุดตรวจวัดแล้ว (ได้ทั้งหมด ${count} จุด)`;
    speakThai("หยุดการตรวจวัดดินแล้ว");
  }
}

async function startAutoSoilProbing() {
  if (_probeRunning) return;
  _probeRunning = true;
  const s = currentState();
  const mode = appState.activeMode;

  document.getElementById("btn-start-probe").classList.add("hidden");
  document.getElementById("btn-stop-probe").classList.remove("hidden");
  document.getElementById("probe-progress-wrap").classList.remove("hidden");
  document.getElementById("probe-confirm-wrap").classList.add("hidden");

  // Clear previous points cleanly on fresh start
  await apiRequest("/api/soil/points", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plot_id: s.plot.id || 1, mode, action: "clear_all" }),
  });
  s.soil.points = [];
  renderProbeCards([]);

  let currentPoint = 1;
  document.getElementById("probe-voice-status").textContent = "เริ่มปักลงบนดินได้ จุดที่ 1";
  speakThai("เริ่มปักลงบนดินได้");

  const cfg = await apiRequest("/api/config");

  const tickProbe = async () => {
    if (!_probeRunning) return;
    let bodyPayload = {
      plot_id: s.plot.id || 1,
      mode,
      point_index: currentPoint,
      action: "record",
    };

    if (mode === "live") {
      if (cfg && cfg.pi5_base_url) {
        await apiRequest("/api/soil/sync-pi5", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plot_id: s.plot.id || 1 }),
        });
      }
    } else {
      // Realistic SIM soil variation per sample spot
      bodyPayload.n = Math.round(14 + Math.random() * 12);
      bodyPayload.p = Math.round(7 + Math.random() * 7);
      bodyPayload.k = Math.round(30 + Math.random() * 18);
      bodyPayload.ph = Number((5.8 + Math.random() * 0.8).toFixed(1));
    }

    const res = await apiRequest("/api/soil/points", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });

    if (!_probeRunning) return;
    if (res && !res.__error) {
      s.soil.points = res.points || [];
      renderProbeCards(s.soil.points);

      if (currentPoint >= 15) {
        document.getElementById("probe-voice-status").textContent = "ตรวจครบ 15 ครั้งเสร็จสิ้นแล้ว";
        speakThai("ตรวจครบ 15 ครั้งเสร็จสิ้น");
        stopAutoSoilProbing(false);
        return;
      }
      const doneIdx = currentPoint;
      currentPoint += 1;
      const msg = `ตรวจครั้งที่ ${doneIdx} เสร็จสิ้น เริ่มปักครั้งที่ ${currentPoint}`;
      document.getElementById("probe-voice-status").textContent = msg;
      speakThai(msg);
    }

    if (_probeRunning) {
      _probeTimer = setTimeout(tickProbe, 4000);
    }
  };

  _probeTimer = setTimeout(tickProbe, 3200);
}

function bindStage4() {
  document.getElementById("btn-start-probe").addEventListener("click", startAutoSoilProbing);
  document.getElementById("btn-stop-probe").addEventListener("click", () => stopAutoSoilProbing(true));
  document.getElementById("btn-soil-confirm").addEventListener("click", () => goToStage(5));
}

/* ==================== STAGE 5: DUAL COMPARISON + 10s VOICE + BOTTLE ANIMATION ==================== */

let _countdownTimer = null;
let _dispensePollTimer = null;

function stopDispenseTimers() {
  if (_countdownTimer) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
  if (_dispensePollTimer) {
    clearInterval(_dispensePollTimer);
    _dispensePollTimer = null;
  }
}

function updateBottleVisual(dispensedMl, totalMl = 1000) {
  const safeTotal = totalMl > 0 ? totalMl : 1000;
  const clamped = Math.max(0, Math.min(safeTotal, Number(dispensedMl || 0)));
  const frac = clamped / safeTotal;
  const pct = frac * 100;

  document.getElementById("bottle-water-fill").style.transform = `scaleY(${frac.toFixed(4)})`;
  document.getElementById("bottle-ml-text").textContent = `${clamped.toFixed(0)} / ${safeTotal.toFixed(0)} ml`;
  document.getElementById("bottle-pct-text").textContent = `${pct.toFixed(0)} / 100%`;
}

function renderMixerComparison() {
  const s = currentState();
  const sys = s.mixer.sysDeficit;
  const rf = s.mixer.rfDeficit;
  if (!sys || !rf) return;

  document.getElementById("sys-n-val").textContent = `${formatNum(sys.n, 1)} g`;
  document.getElementById("sys-p-val").textContent = `${formatNum(sys.p2o5, 1)} g`;
  document.getElementById("sys-k-val").textContent = `${formatNum(sys.k2o, 1)} g`;

  const rfDefs = rf.rf_deficits_g || rf;
  document.getElementById("rf-n-val").textContent = `${formatNum(rfDefs.n, 1)} g`;
  document.getElementById("rf-p-val").textContent = `${formatNum(rfDefs.p2o5, 1)} g`;
  document.getElementById("rf-k-val").textContent = `${formatNum(rfDefs.k2o, 1)} g`;

  const totalDeficit = Number(sys.n || 0) + Number(sys.p2o5 || 0) + Number(sys.k2o || 0);
  document.getElementById("conv-total-deficit").textContent = `${totalDeficit.toFixed(1)} g`;
  document.getElementById("conv-r2").textContent = `${(Number(s.mixer.r2 || 0) * 100).toFixed(1)} %`;
  document.getElementById("conv-mae").textContent = `${formatNum(s.mixer.mae, 2)} g/m²`;

  const vols = s.mixer.volumes || {};
  document.getElementById("ch-n-ml").textContent = `${formatNum(vols.n, 1)} ml`;
  document.getElementById("ch-p-ml").textContent = `${formatNum(vols.p, 1)} ml`;
  document.getElementById("ch-k-ml").textContent = `${formatNum(vols.k, 1)} ml`;
  document.getElementById("ch-w-ml").textContent = `${formatNum(vols.water, 1)} ml`;
}

function bindStage5() {
  document.getElementById("btn-calc-fertilizer").addEventListener("click", async () => {
    const s = currentState();
    const mode = appState.activeMode;

    document.getElementById("calc-launch-wrap").classList.add("hidden");
    const statusWrap = document.getElementById("calc-status-wrap");
    statusWrap.classList.remove("hidden");
    document.getElementById("calc-status-text").textContent =
      "กำลังคำนวณสมดุลมวลและเทียบผลโมเดล Random Forest (AI)...";

    const res = await apiRequest("/api/mixer/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plot_id: s.plot.id || 1,
        mode,
        crop_profile_id: s.crop.profileId || 1,
        confirmed_area_m2: s.plot.confirmedAreaM2 || 100,
        soil_type: s.crop.soilType || "loam",
        exg_green_pct: s.survey.greenPct,
      }),
    });

    statusWrap.classList.add("hidden");
    if (!res || res.__error) {
      document.getElementById("calc-launch-wrap").classList.remove("hidden");
      return;
    }

    s.mixer.jobId = res.job_id;
    s.mixer.sysDeficit = res.deficits_g;
    s.mixer.rfDeficit = res.rf_prediction;
    s.mixer.r2 = res.rf_prediction?.r2_score;
    s.mixer.mae = res.rf_prediction?.mae_g_m2;
    s.mixer.volumes = res.demo_volumes_ml;
    s.mixer.pumpSec = res.pump_seconds;

    renderMixerComparison();
    document.getElementById("calc-comparison-wrap").classList.remove("hidden");
  });

  document.getElementById("btn-start-dispense").addEventListener("click", () => {
    stopDispenseTimers();
    const s = currentState();
    const mode = appState.activeMode;
    const liveSection = document.getElementById("dispense-live-section");
    const countdownBox = document.getElementById("countdown-banner");
    const countdownNum = document.getElementById("countdown-num");
    const statusText = document.getElementById("dispense-status-text");
    const nextFinalBtn = document.getElementById("btn-goto-drone-final");

    liveSection.classList.remove("hidden");
    countdownBox.classList.remove("hidden");
    nextFinalBtn.classList.add("hidden");
    updateBottleVisual(0, 1000);
    liveSection.scrollIntoView({ behavior: "smooth", block: "start" });

    let secLeft = 10;
    countdownNum.textContent = String(secLeft);
    statusText.textContent = "รอผู้ใช้เตรียมกระบอกผสมใต้หัวจ่าย...";
    speakThai("ให้นำกระบอกมาใส่ใต้หัวจ่าย เริ่มใน 10 วินาที");

    _countdownTimer = setInterval(async () => {
      secLeft -= 1;
      if (secLeft > 0) {
        countdownNum.textContent = String(secLeft);
        speakThai(String(secLeft));
        return;
      }
      clearInterval(_countdownTimer);
      _countdownTimer = null;
      countdownBox.classList.add("hidden");
      speakThai("เริ่มจ่ายปุ๋ย");

      const totalBatch =
        Number(s.mixer.volumes?.n || 0) +
        Number(s.mixer.volumes?.p || 0) +
        Number(s.mixer.volumes?.k || 0) +
        Number(s.mixer.volumes?.water || 0) || 1000;

      if (mode === "live") {
        statusText.textContent = "กำลังสั่งเปิดปั๊มจ่ายปุ๋ยจริงทีละช่อง...";
        const dispRes = await apiRequest("/api/mixer/dispense-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (dispRes && dispRes.__error) {
          statusText.textContent = dispRes.__error;
          return;
        }
        _dispensePollTimer = setInterval(async () => {
          const hw = await apiRequest("/api/mixer/hw-status");
          if (!hw || hw.__error) return;
          statusText.textContent = hw.current_step || "กำลังจ่ายน้ำ...";
          updateBottleVisual(hw.dispensed_ml, hw.target_total_ml || totalBatch);
          if (!hw.is_running) {
            clearInterval(_dispensePollTimer);
            _dispensePollTimer = null;
            updateBottleVisual(hw.target_total_ml || totalBatch, hw.target_total_ml || totalBatch);
            s.mixer.dispensedDone = true;
            statusText.textContent = "จ่ายน้ำปุ๋ยครบ 1,000 ml เรียบร้อยแล้ว";
            nextFinalBtn.classList.remove("hidden");
          }
        }, 250);
      } else {
        // SIM mode realistic sequential N -> P -> K -> Water fill animation up to 1000 ml
        const vN = Number(s.mixer.volumes?.n || 0);
        const vP = Number(s.mixer.volumes?.p || 0);
        const vK = Number(s.mixer.volumes?.k || 0);
        const vW = Number(s.mixer.volumes?.water || totalBatch);
        let simMl = 0;
        const stepMl = totalBatch / 36; // ~9 seconds smooth demo

        _dispensePollTimer = setInterval(() => {
          simMl = Math.min(totalBatch, simMl + stepMl);
          if (simMl <= vN) statusText.textContent = "กำลังดูดจ่ายปุ๋ย N (ไนโตรเจน)...";
          else if (simMl <= vN + vP) statusText.textContent = "กำลังดูดจ่ายปุ๋ย P (ฟอสฟอรัส)...";
          else if (simMl <= vN + vP + vK) statusText.textContent = "กำลังดูดจ่ายปุ๋ย K (โพแทสเซียม)...";
          else statusText.textContent = "กำลังเติมน้ำเปล่าเจือจาง...";

          updateBottleVisual(simMl, totalBatch);
          if (simMl >= totalBatch) {
            clearInterval(_dispensePollTimer);
            _dispensePollTimer = null;
            s.mixer.dispensedDone = true;
            statusText.textContent = "ผสมปุ๋ยน้ำชีวภาพครบ 1,000 ml เสร็จสิ้นแล้ว";
            speakThai("จ่ายน้ำปุ๋ยครบ 1,000 มิลลิลิตรแล้วครับ");
            nextFinalBtn.classList.remove("hidden");
          }
        }, 250);
      }
    }, 1000);
  });

  document.getElementById("btn-stop-dispense").addEventListener("click", async () => {
    stopDispenseTimers();
    if (appState.activeMode === "live") {
      await apiRequest("/api/mixer/stop-live", { method: "POST" });
    }
    document.getElementById("dispense-status-text").textContent = "หยุดการจ่ายน้ำฉุกเฉินแล้ว";
  });

  document.getElementById("btn-goto-drone-final").addEventListener("click", () => goToStage(6));
}

/* ==================== STAGE 6: DRONE REFILL STATION & FINAL SPRAY ==================== */

function bindStage6() {
  const btn = document.getElementById("btn-final-drone-run");
  const statusEl = document.getElementById("final-drone-status");
  const streamEl = document.getElementById("svg-refill-stream");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const s = currentState();
    const isLive = appState.activeMode === "live";

    statusEl.textContent = "1. เปิดก๊อกสถานีเติมน้ำปุ๋ย 8–10 ml ลงตลับใต้โดรน...";
    if (streamEl) streamEl.setAttribute("opacity", "0.95");
    await new Promise((r) => setTimeout(r, 1200));

    statusEl.textContent = "2. ปิดวาล์วและล็อกตลับเรียบร้อย — เตรียมนำโดรนขึ้นบิน...";
    if (streamEl) streamEl.setAttribute("opacity", "0.15");
    await new Promise((r) => setTimeout(r, 900));

    statusEl.textContent = "3. โดรนกำลังบินพ่นปุ๋ยละอองฝอยเหนือแปลงเป้าหมาย...";
    await apiRequest("/api/drone/mission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plot_id: s.plot.id || 1,
        mode: "spray_fertilizer",
        execution_mode: isLive ? "LIVE" : "SIMULATED",
        waypoints_cm: s.plot.waypointsCm,
        job_id: s.mixer.jobId,
      }),
    });
    await new Promise((r) => setTimeout(r, 1400));

    s.finalDrone.done = true;
    statusEl.textContent = isLive
      ? "4. เสร็จสิ้นภารกิจ (หากใช้โดรนบังคับมือ ให้บินพ่นตามเส้นทางจริงได้เลย)"
      : "4. โดรนบินพ่นและลงจอดปลอดภัย — เสร็จสิ้นภารกิจครบทุกขั้นตอน!";
    speakThai("เสร็จสิ้นภารกิจพ่นปุ๋ยเรียบร้อยแล้วครับ");
    btn.disabled = false;
  });
}

/* ==================== NATIVE <dialog> INFO & SETTINGS + FALLBACKS ==================== */

function bindInfoSettingsDialog() {
  const dialog = document.getElementById("info-settings-dialog");
  const openBtn = document.getElementById("btn-open-info");
  const closeBtn = document.getElementById("btn-close-dialog");

  const loadSettingsValues = async () => {
    const cfg = await apiRequest("/api/config");
    if (!cfg || cfg.__error) return;
    document.getElementById("cfg-pi5-url").value = cfg.pi5_base_url || "";
    document.getElementById("cfg-q-n").value = cfg.q_pump_n ?? "";
    document.getElementById("cfg-q-p").value = cfg.q_pump_p ?? "";
    document.getElementById("cfg-q-k").value = cfg.q_pump_k ?? "";
    document.getElementById("cfg-q-w").value = cfg.q_pump_water ?? "";
    document.getElementById("cfg-table-w").value = cfg.table_width_cm ?? "";
    document.getElementById("cfg-table-h").value = cfg.table_height_cm ?? "";
  };

  openBtn.addEventListener("click", loadSettingsValues);

  // Progressive fallback for browsers without Invoker Commands (commandfor)
  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    openBtn.addEventListener("click", () => dialog.showModal());
    closeBtn.addEventListener("click", () => dialog.close());
  }

  // Light-dismiss fallback when <dialog closedby="any"> is unavailable
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    const isOutside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = isOutside(e);
    });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && isOutside(e)) dialog.close();
    });
  }

  // Mandatory reset of returnValue on close per modern-web-guidance dialog guide
  dialog.addEventListener("close", () => {
    dialog.returnValue = "";
  });

  document.getElementById("form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    await apiRequest("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pi5_base_url: document.getElementById("cfg-pi5-url").value.trim(),
        q_pump_n: Number(document.getElementById("cfg-q-n").value),
        q_pump_p: Number(document.getElementById("cfg-q-p").value),
        q_pump_k: Number(document.getElementById("cfg-q-k").value),
        q_pump_water: Number(document.getElementById("cfg-q-w").value),
        table_width_cm: Number(document.getElementById("cfg-table-w").value),
        table_height_cm: Number(document.getElementById("cfg-table-h").value),
      }),
    });
    dialog.close();
  });
}

/* ==================== BOOTSTRAP ==================== */

async function initApp() {
  const cropsRes = await apiRequest("/api/crops");
  appState.crops = cropsRes && cropsRes.crops ? cropsRes.crops : [];

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setOperationalMode(btn.dataset.mode));
  });

  document.querySelectorAll("#step-dots .dot-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.stage);
      if (target <= currentState().maxStage) {
        goToStage(target);
      }
    });
  });

  initStage1Map();
  bindStage0();
  bindStage2();
  bindStage3();
  bindStage4();
  bindStage5();
  bindStage6();
  bindInfoSettingsDialog();

  setOperationalMode("sim");
}

document.addEventListener("DOMContentLoaded", initApp);
