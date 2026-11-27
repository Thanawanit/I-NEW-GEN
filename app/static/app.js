/**
 * Smart Bio-Fert Drone — Focused Single-Stage Wizard Controller
 * - Strict SIM vs LIVE isolation across every stage, API request, and UI state.
 * - Stage header pill, vertical left map dock with point-level Undo, 5 Mae Hong Son soils,
 *   Before/After image upload in both modes, graduated beaker SVG + 2-step emergency stop,
 *   animated Stage 6 drone refill/spray reveal, and final complete summary card.
 */

const STAGE_TITLES = [
  "ขั้นที่ 1 (ตั้งชื่อแปลงที่ดิน)",
  "ขั้นที่ 2 (กำหนดแผนที่ และขนาด)",
  "ขั้นที่ 3 (เลือกชนิดพืช พันธุ์ และชนิดดิน)",
  "ขั้นที่ 4 (โดรนสำรวจความเขียวของแปลง)",
  "ขั้นที่ 5 (ตรวจวัดธาตุอาหารในดิน)",
  "ขั้นที่ 6 (คำนวณสูตร และผสมปุ๋ย)",
  "ขั้นที่ 7 (โดรนเติมปุ๋ย และบินพ่น)",
];

const SOIL_LABELS = {
  sandy_loam: "ดินร่วนปนทราย (1.55 g/cm³)",
  loam: "ดินร่วน (1.35 g/cm³)",
  clay_loam: "ดินร่วนเหนียว (1.40 g/cm³)",
  sandy_clay_loam: "ดินร่วนเหนียวปนทราย (1.45 g/cm³)",
  clay: "ดินเหนียว (1.25 g/cm³)",
};

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
      avgSummary: null,
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
  activeMode: "sim",
  crops: [],
  byMode: {
    sim: createEmptyModeState(),
    live: createEmptyModeState(),
  },
};

function currentState() {
  return appState.byMode[appState.activeMode];
}

let _speechResolve = null;
let _preferredThaiVoice = null;
let _ttsAudio = null;

function resolvePreferredThaiVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return _preferredThaiVoice;

  const niwat = voices.find(
    (v) =>
      /niwat/i.test(v.name || "") ||
      /niwat/i.test(v.voiceURI || "") ||
      /th-th-niwatneural/i.test(v.name || "")
  );
  if (niwat) {
    _preferredThaiVoice = niwat;
    return niwat;
  }

  const anyThai = voices.find((v) => (v.lang || "").toLowerCase().startsWith("th"));
  _preferredThaiVoice = anyThai || null;
  return _preferredThaiVoice;
}

if ("speechSynthesis" in window) {
  resolvePreferredThaiVoice();
  if ("onvoiceschanged" in window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = resolvePreferredThaiVoice;
  }
}

function stopSpeech() {
  if (_speechResolve) {
    const fn = _speechResolve;
    _speechResolve = null;
    fn();
  }
  if (_ttsAudio) {
    try {
      _ttsAudio.pause();
      _ttsAudio.src = "";
    } catch (_) {}
    _ttsAudio = null;
  }
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }
}

function _fallbackSpeechSynthesis(text, onDone) {
  if (!("speechSynthesis" in window) || !text) {
    if (onDone) onDone();
    return;
  }
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "th-TH";
    const voice = resolvePreferredThaiVoice();
    if (voice) utter.voice = voice;
    utter.rate = 1.0;
    if (onDone) {
      utter.onend = onDone;
      utter.onerror = onDone;
    }
    window.speechSynthesis.speak(utter);
  } catch (_) {
    if (onDone) onDone();
  }
}

const STATIC_AUDIO_CLIPS = {
  "เริ่มปักลงบนดินได้": "/static/audio/start_probe.wav",
  "ตรวจครบ 15 ครั้งเสร็จสิ้น": "/static/audio/measure_complete.wav",
  "หยุดการตรวจวัดดินแล้ว": "/static/audio/measure_stopped.wav",
  "กรุณานำกระบอกผสมมาวางใต้หัวจ่าย": "/static/audio/place_cup.wav",
  "ระบบกำลังจะปล่อยน้ำปุ๋ยผสมลงกระบอกในอีก": "/static/audio/dispense_preparing.wav",
  "เริ่มจ่ายน้ำปุ๋ยครับ": "/static/audio/dispense_start.wav",
  "จ่ายน้ำปุ๋ยครบ 1,000 มิลลิลิตรแล้วครับ": "/static/audio/dispense_done.wav",
  "เสร็จสิ้นระบบทั้งหมดเรียบร้อยแล้วครับ": "/static/audio/all_finished.wav",
};

function resolveAudioUrl(text) {
  const clean = String(text || "").trim();
  if (STATIC_AUDIO_CLIPS[clean]) return STATIC_AUDIO_CLIPS[clean];

  const roundMatch = clean.match(/^ตรวจครั้งที่\s*(\d+)\s*เสร็จสิ้น/);
  if (roundMatch) {
    const roundNum = Number(roundMatch[1]);
    if (roundNum >= 1 && roundNum <= 14) {
      return `/static/audio/round_${roundNum}.wav`;
    }
  }

  if (/^(10|[1-9])$/.test(clean)) {
    return `/static/audio/count_${clean}.wav`;
  }

  return `/api/tts?text=${encodeURIComponent(clean)}`;
}

function speakThai(text) {
  if (!text) return;
  stopSpeech();
  try {
    const audio = new Audio(resolveAudioUrl(text));
    _ttsAudio = audio;
    audio.onerror = () => {
      if (_ttsAudio === audio) _fallbackSpeechSynthesis(text);
    };
    audio.play().catch(() => {
      if (_ttsAudio === audio) _fallbackSpeechSynthesis(text);
    });
  } catch (_) {
    _fallbackSpeechSynthesis(text);
  }
}

function speakThaiAndWait(text, maxWaitMs = 7000) {
  return new Promise((resolve) => {
    if (!text) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (_speechResolve === finish) _speechResolve = null;
      clearTimeout(timerId);
      resolve();
    };
    const timerId = setTimeout(finish, maxWaitMs);
    stopSpeech();
    _speechResolve = finish;

    try {
      const audio = new Audio(resolveAudioUrl(text));
      _ttsAudio = audio;
      audio.onended = finish;
      audio.onerror = () => {
        if (_ttsAudio === audio) _fallbackSpeechSynthesis(text, finish);
        else finish();
      };
      audio.play().catch(() => {
        if (_ttsAudio === audio) _fallbackSpeechSynthesis(text, finish);
        else finish();
      });
    } catch (_) {
      _fallbackSpeechSynthesis(text, finish);
    }
  });
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  if (idx !== 1 && polygonDrawer && polygonDrawer._enabled) {
    polygonDrawer.disable();
  }

  document.querySelectorAll("[data-stage]").forEach((el) => {
    el.classList.toggle("hidden", Number(el.dataset.stage) !== idx);
  });

  document.querySelectorAll("#step-dots .dot-btn").forEach((btn) => {
    const dStage = Number(btn.dataset.stage);
    btn.classList.toggle("is-active", dStage === idx);
    btn.classList.toggle("is-done", dStage < idx);
  });

  document.getElementById("stage-subtitle").textContent = STAGE_TITLES[idx] || "";
  const backBtn = document.getElementById("btn-stage-back");
  if (backBtn) backBtn.classList.toggle("hidden", idx === 0);

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

  restoreModeUI();
}

function restoreModeUI() {
  const s = currentState();
  document.getElementById("input-plot-name").value = s.plot.name || "";

  // Map polygon restore (strict SIM vs LIVE undo history isolation)
  undoStack = [];
  redoStack = [];
  drawingVertexCount = 0;
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
  document.getElementById("survey-live-fallback-msg").classList.add("hidden");
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

  // Final drone stage restore
  const finalDone = Boolean(s.finalDrone.done);
  document.getElementById("dock-concept-card").classList.toggle("hidden", !finalDone);
  document.getElementById("final-cta-wrap").classList.toggle("hidden", finalDone);
  document.getElementById("final-complete-banner").classList.toggle("hidden", !finalDone);
  document.getElementById("final-summary-card").classList.toggle("hidden", !finalDone);
  document.getElementById("final-restart-wrap").classList.toggle("hidden", !finalDone);
  if (finalDone) populateFinalSummary();

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

/* ==================== STAGE 1: SATELLITE MAP + VERTICAL DOCK + POLYGON ==================== */

let mapInstance = null;
let drawnItems = null;
let polygonDrawer = null;
let undoStack = [];
let redoStack = [];
let drawingVertexCount = 0;
let activePolygonLayer = null;

function computeGeodesicAreaM2(latlngs) {
  if (!window.L || !L.GeometryUtil || !latlngs || latlngs.length < 3) return 0;
  return Math.abs(L.GeometryUtil.geodesicArea(latlngs));
}

function updateUndoRedoButtons() {
  const canUndoPoint = Boolean(polygonDrawer && polygonDrawer._enabled && drawingVertexCount > 0);
  document.getElementById("btn-map-undo").disabled = !(canUndoPoint || undoStack.length > 1);
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
  // High-contrast Amber/Gold outline so boundaries stand out clearly against green satellite foliage
  const poly = L.polygon(latlngs, {
    color: "#f59e0b",
    fillColor: "#fbbf24",
    fillOpacity: 0.25,
    weight: 3.5,
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

  // Concise, natural Thai hover tooltips on Leaflet.Draw
  if (L.drawLocal) {
    L.drawLocal.draw.handlers.polygon.tooltip = {
      start: "คลิกบนแผนที่เพื่อวางจุดแรก",
      cont: "คลิกวางจุดถัดไปเรื่อยๆ",
      end: "คลิกจุดแรก (หรือดับเบิลคลิก) เพื่อปิดขอบเขต",
    };
    L.drawLocal.edit.handlers.edit.tooltip = {
      text: "ลากจุดขาวเพื่อปรับมุม หรือลากพื้นที่เพื่อย้าย",
      subtext: "กด บันทึก เมื่อเสร็จสิ้น",
    };
  }

  mapInstance = L.map("map", {
    center: [18.8392, 97.9262],
    zoom: 17,
    zoomControl: false,
  });
  L.control.zoom({ position: "topright" }).addTo(mapInstance);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 17, maxZoom: 21, attribution: "Esri World Imagery" }
  ).addTo(mapInstance);

  drawnItems = new L.FeatureGroup();
  mapInstance.addLayer(drawnItems);

  polygonDrawer = new L.Draw.Polygon(mapInstance, {
    allowIntersection: false,
    showArea: true,
    shapeOptions: { color: "#f59e0b", fillColor: "#fbbf24", fillOpacity: 0.25, weight: 3.5 },
  });

  mapInstance.on(L.Draw.Event.DRAWVERTEX, (e) => {
    drawingVertexCount = e.layers ? e.layers.getLayers().length : drawingVertexCount + 1;
    updateUndoRedoButtons();
  });

  mapInstance.on(L.Draw.Event.DRAWSTART, () => {
    drawingVertexCount = 0;
    updateUndoRedoButtons();
  });

  mapInstance.on(L.Draw.Event.DRAWSTOP, () => {
    drawingVertexCount = 0;
    updateUndoRedoButtons();
  });

  mapInstance.on(L.Draw.Event.CREATED, (e) => {
    drawingVertexCount = 0;
    const pts = e.layer.getLatLngs()[0];
    createEditablePolygonLayer(pts, true);
    document.getElementById("map-tool-hint").textContent =
      "วาดแล้ว! ลากจุดเพื่อปรับมุม หรือลากทั้งรูปเพื่อย้าย";
  });

  document.getElementById("btn-map-draw").addEventListener("click", () => {
    drawingVertexCount = 0;
    polygonDrawer.enable();
    updateUndoRedoButtons();
    document.getElementById("map-tool-hint").textContent =
      "คลิกวางจุดรอบแปลง (กดย้อนกลับได้ทีละจุด)";
  });

  document.getElementById("btn-map-undo").addEventListener("click", () => {
    if (polygonDrawer && polygonDrawer._enabled && drawingVertexCount > 0) {
      polygonDrawer.deleteLastVertex();
      drawingVertexCount = Math.max(0, drawingVertexCount - 1);
      updateUndoRedoButtons();
      return;
    }
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
    drawingVertexCount = 0;
    drawnItems.clearLayers();
    activePolygonLayer = null;
    undoStack = [];
    redoStack = [];
    updateUndoRedoButtons();
    syncPolygonToState(null);
    document.getElementById("map-tool-hint").textContent = "จิ้มวางจุดรอบแปลง หรือลากจุดเพื่อย้าย";
  });

  document.getElementById("btn-map-apply").addEventListener("click", () => {
    if (polygonDrawer) polygonDrawer.disable();
    drawingVertexCount = 0;
    updateUndoRedoButtons();
    if (activePolygonLayer) {
      if (activePolygonLayer.editing) activePolygonLayer.editing.disable();
      const pts = activePolygonLayer.getLatLngs()[0];
      syncPolygonToState(pts);
      setTimeout(() => activePolygonLayer && activePolygonLayer.editing && activePolygonLayer.editing.enable(), 40);
      document.getElementById("map-tool-hint").textContent = "บันทึกขอบเขตแปลงเรียบร้อย";
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

const _customDropdownControllers = new Map();

function closeAllCustomDropdowns(exceptWrapper = null) {
  _customDropdownControllers.forEach(({ wrapper, trigger, menu }) => {
    if (wrapper !== exceptWrapper) {
      menu.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
    }
  });
}

function syncCustomDropdown(selectEl) {
  const ctrl = _customDropdownControllers.get(selectEl);
  if (!ctrl) return;
  const { trigger, labelSpan, menu } = ctrl;

  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  const hasValue = Boolean(selectEl.value);
  labelSpan.textContent = selectedOpt ? selectedOpt.textContent : "เลือก...";
  trigger.classList.toggle("is-placeholder", !hasValue);
  trigger.classList.toggle("is-valid", hasValue);

  menu.innerHTML = "";
  Array.from(selectEl.options).forEach((opt) => {
    if (opt.disabled && !opt.value) return;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "custom-select-option";
    item.setAttribute("role", "option");
    const isSel = opt.value === selectEl.value;
    item.setAttribute("aria-selected", String(isSel));
    if (isSel) item.classList.add("is-selected");
    item.textContent = opt.textContent;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      selectEl.value = opt.value;
      closeAllCustomDropdowns();
      syncCustomDropdown(selectEl);
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      trigger.focus();
    });
    menu.appendChild(item);
  });
}

function syncAllStage2Dropdowns() {
  _customDropdownControllers.forEach((_, sel) => syncCustomDropdown(sel));
}

function initCustomDropdowns() {
  const ids = ["select-crop-name", "select-variety", "select-growth-stage", "select-soil-type"];
  ids.forEach((id) => {
    const selectEl = document.getElementById(id);
    if (!selectEl || _customDropdownControllers.has(selectEl)) return;

    selectEl.classList.add("visually-hidden");
    selectEl.tabIndex = -1;

    const wrapper = document.createElement("div");
    wrapper.className = "custom-select";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select-trigger is-placeholder";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const labelSpan = document.createElement("span");
    labelSpan.className = "custom-select-text";
    trigger.appendChild(labelSpan);

    trigger.insertAdjacentHTML(
      "beforeend",
      '<svg class="custom-select-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>'
    );

    const menu = document.createElement("div");
    menu.className = "custom-select-menu hidden";
    menu.setAttribute("role", "listbox");

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const willOpen = menu.classList.contains("hidden");
      closeAllCustomDropdowns(wrapper);
      menu.classList.toggle("hidden", !willOpen);
      trigger.setAttribute("aria-expanded", String(willOpen));
    });

    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);

    _customDropdownControllers.set(selectEl, { wrapper, trigger, labelSpan, menu });
    syncCustomDropdown(selectEl);
  });

  document.addEventListener("click", (e) => {
    const inside = Array.from(_customDropdownControllers.values()).some(({ wrapper }) =>
      wrapper.contains(e.target)
    );
    if (!inside) closeAllCustomDropdowns();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllCustomDropdowns();
  });
}

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
  syncAllStage2Dropdowns();
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
  syncCustomDropdown(selVar);
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
  syncCustomDropdown(selStage);
}

function bindStage2() {
  initCustomDropdowns();
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
    syncAllStage2Dropdowns();
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
    syncAllStage2Dropdowns();
  });

  selStage.addEventListener("change", (e) => {
    const s = currentState();
    s.crop.growthStage = e.target.value;
    const match = appState.crops.find(
      (c) => c.crop_name === s.crop.cropName && c.variety === s.crop.variety && c.growth_stage === s.crop.growthStage
    );
    s.crop.profileId = match ? match.id : null;
    document.getElementById("wrap-soil-type").classList.remove("hidden");
    syncAllStage2Dropdowns();
  });

  selSoil.addEventListener("change", (e) => {
    currentState().crop.soilType = e.target.value;
    document.getElementById("wrap-stage2-submit").classList.remove("hidden");
    syncCustomDropdown(selSoil);
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
  document.getElementById("survey-live-fallback-msg").classList.add("hidden");
  document.getElementById("img-before-exg").src = origUrl;
  document.getElementById("img-after-exg").src = maskUrl;
  document.getElementById("exg-pct-badge").textContent = `${formatNum(greenPct, 1)} %`;
  document.getElementById("survey-result-wrap").classList.remove("hidden");
}

async function handleSurveyImageUpload(file) {
  if (!file) return;
  const s = currentState();
  document.getElementById("survey-launch-wrap").classList.add("hidden");
  document.getElementById("survey-live-fallback-msg").classList.add("hidden");
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
}

function bindStage3() {
  document.getElementById("btn-fly-survey").addEventListener("click", async () => {
    const s = currentState();
    const mode = appState.activeMode;
    document.getElementById("survey-launch-wrap").classList.add("hidden");
    document.getElementById("survey-live-fallback-msg").classList.add("hidden");
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
      statusWrap.classList.add("hidden");
      document.getElementById("survey-live-fallback-msg").classList.remove("hidden");
      document.getElementById("survey-launch-wrap").classList.remove("hidden");
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

  document.getElementById("input-survey-image").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleSurveyImageUpload(file);
    e.target.value = "";
  });

  document.getElementById("btn-survey-accept").addEventListener("click", () => goToStage(4));
  document.getElementById("btn-survey-skip").addEventListener("click", () => {
    const s = currentState();
    s.survey = { origUrl: "", maskUrl: "", greenPct: null, done: false };
    goToStage(4);
  });
}

/* ==================== STAGE 4: AUTO 1-15 SOIL PROBING + 5-PRONG SENSOR CARDS ==================== */

let _probeTimer = null;
let _probeRunning = false;

let _lastRenderedProbeCount = 0;

function renderProbeCards(pointsList) {
  const validPts = (pointsList || []).filter((p) => p && p.n !== null);
  const grid = document.getElementById("probe-cards-grid");
  const progressWrap = document.getElementById("probe-progress-wrap");
  const liveAnim = document.getElementById("probe-live-anim");
  const bar = document.getElementById("probe-progress-bar");
  const countText = document.getElementById("probe-count-text");
  const confirmWrap = document.getElementById("probe-confirm-wrap");

  if (validPts.length > 0 || _probeRunning) {
    progressWrap.classList.remove("hidden");
  } else {
    progressWrap.classList.add("hidden");
  }
  if (liveAnim) {
    liveAnim.classList.toggle("hidden", !_probeRunning);
  }

  bar.value = validPts.length;
  countText.textContent = `ปักแล้ว ${validPts.length} ครั้ง`;
  confirmWrap.classList.toggle("hidden", validPts.length === 0 || _probeRunning);

  const prevCount = _lastRenderedProbeCount;
  _lastRenderedProbeCount = validPts.length;

  grid.innerHTML = "";
  validPts.forEach((pt, idx) => {
    const card = document.createElement("div");
    card.className = idx >= prevCount ? "sensor-probe-card is-new" : "sensor-probe-card";
    card.innerHTML = `
      <div class="sensor-acrylic-shell">
        <div class="sensor-power-strip">
          <span class="sensor-yellow-pack" aria-hidden="true"></span>
          <span class="sensor-point-pill">จุดที่ ${pt.point_index}</span>
        </div>
        <div class="sensor-body">
          <div class="sensor-head-tag">
            <span>5-PIN SOIL</span>
            <span>NPK•pH</span>
          </div>
          <div class="sensor-metrics">
            <div class="sensor-metric"><span>N</span><strong class="tabular-num">${formatNum(pt.n, 0)}</strong></div>
            <div class="sensor-metric"><span>P</span><strong class="tabular-num">${formatNum(pt.p, 0)}</strong></div>
            <div class="sensor-metric"><span>K</span><strong class="tabular-num">${formatNum(pt.k, 0)}</strong></div>
            <div class="sensor-metric"><span>pH</span><strong class="tabular-num">${formatNum(pt.ph, 1)}</strong></div>
          </div>
        </div>
      </div>
      <div class="sensor-baseplate" aria-hidden="true"></div>
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

  await apiRequest("/api/soil/points", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plot_id: s.plot.id || 1, mode, action: "clear_all" }),
  });
  s.soil.points = [];
  s.soil.avgSummary = null;
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
      // Simulate realistic LDD low/deficient soil readings so every fertilizing stage shows positive N, P, K needs
      bodyPayload.n = Math.round(3 + Math.random() * 3);
      bodyPayload.p = Math.round(2 + Math.random() * 2);
      bodyPayload.k = Math.round(4 + Math.random() * 5);
      bodyPayload.ph = Number((5.4 + Math.random() * 0.8).toFixed(1));
    }

    const res = await apiRequest("/api/soil/points", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });

    if (!_probeRunning) return;
    if (res && !res.__error) {
      s.soil.points = res.points || [];
      s.soil.avgSummary = res.average || null;
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

/* ==================== STAGE 5: DUAL COMPARISON + 10s VOICE + BEAKER SVG ==================== */

let _countdownTimer = null;
let _dispensePollTimer = null;
let _stopArmResetTimer = null;
let _dispenseFlowToken = 0;

function stopDispenseTimers() {
  _dispenseFlowToken += 1;
  _bottlePouring = false;
  stopSpeech();
  if (_countdownTimer) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
  if (_dispensePollTimer) {
    clearInterval(_dispensePollTimer);
    _dispensePollTimer = null;
  }
}

function resetEmergencyStopButton() {
  const stopBtn = document.getElementById("btn-stop-dispense");
  if (!stopBtn) return;
  stopBtn.dataset.armed = "false";
  stopBtn.textContent = "หยุดจ่ายฉุกเฉิน";
  if (_stopArmResetTimer) {
    clearTimeout(_stopArmResetTimer);
    _stopArmResetTimer = null;
  }
}

let _bottleAnimRaf = null;
let _bottleCurrentMl = 0;
let _bottleTargetMl = 0;
let _bottleTotalMl = 1000;
let _bottlePouring = false;
let _wavePhase = 0;

function _renderBottleGeometry(mlValue, totalMl, pouring, phase) {
  const safeTotal = totalMl > 0 ? totalMl : 1000;
  const clamped = Math.max(0, Math.min(safeTotal, mlValue));
  const frac = clamped / safeTotal;
  const pct = frac * 100;

  // Normal Bottle liquid fill: bottom y=266 up 180px to 1000 ml mark (y=86)
  const liquidH = 180 * frac;
  const liquidY = 266 - liquidH;

  const waveBack = document.getElementById("beaker-wave-back");
  const waveFront = document.getElementById("beaker-wave-front");
  const stream = document.getElementById("bottle-pour-stream");
  const bubbles = document.getElementById("bottle-bubbles-group");

  const amp = frac > 0.01 && frac < 0.995 ? (pouring ? 4.8 : 1.6) : 0;
  const f1 = Math.sin(phase) * amp;
  const f2 = Math.cos(phase * 1.3 + 1.2) * (amp * 0.85);

  if (waveFront) {
    if (liquidH <= 0.5) {
      waveFront.setAttribute("d", "M 50 266 H 178 V 268 H 50 Z");
    } else {
      const yL = (liquidY + f1).toFixed(1);
      const yC1 = (liquidY - f1 * 1.4).toFixed(1);
      const yC2 = (liquidY + f1 * 1.4).toFixed(1);
      const yR = (liquidY - f1).toFixed(1);
      waveFront.setAttribute(
        "d",
        `M 50 ${yL} C 82 ${yC1}, 146 ${yC2}, 178 ${yR} V 268 H 50 Z`
      );
    }
  }

  if (waveBack) {
    if (liquidH <= 0.5) {
      waveBack.setAttribute("d", "M 50 266 H 178 V 268 H 50 Z");
    } else {
      const yL = (liquidY + f2 - 1.5).toFixed(1);
      const yC1 = (liquidY + f2 * 1.3).toFixed(1);
      const yC2 = (liquidY - f2 * 1.3).toFixed(1);
      const yR = (liquidY - f2 - 1.5).toFixed(1);
      waveBack.setAttribute(
        "d",
        `M 50 ${yL} C 86 ${yC1}, 142 ${yC2}, 178 ${yR} V 268 H 50 Z`
      );
    }
  }

  if (stream) {
    const showStream = pouring && frac < 0.995;
    stream.setAttribute("y2", Math.max(40, liquidY + 4).toFixed(1));
    stream.setAttribute("opacity", showStream ? "0.78" : "0");
  }

  if (bubbles) {
    bubbles.setAttribute("opacity", pouring && frac > 0.08 && frac < 0.995 ? "0.85" : "0");
  }

  document.getElementById("bottle-ml-text").textContent = `${clamped.toFixed(0)} / ${safeTotal.toFixed(0)} ml`;
  document.getElementById("bottle-pct-text").textContent = `${pct.toFixed(0)} / 100%`;
}

function _stepBottleAnimation() {
  const diff = _bottleTargetMl - _bottleCurrentMl;
  if (Math.abs(diff) > 0.25) {
    _bottleCurrentMl += diff * 0.14;
  } else {
    _bottleCurrentMl = _bottleTargetMl;
  }
  _wavePhase += _bottlePouring ? 0.13 : 0.04;

  _renderBottleGeometry(_bottleCurrentMl, _bottleTotalMl, _bottlePouring, _wavePhase);

  const stillMoving = Math.abs(_bottleTargetMl - _bottleCurrentMl) > 0.25;
  if (_bottlePouring || stillMoving) {
    _bottleAnimRaf = requestAnimationFrame(_stepBottleAnimation);
  } else {
    _bottleAnimRaf = null;
  }
}

function updateBottleVisual(dispensedMl, totalMl = 1000, pouring = null) {
  _bottleTotalMl = totalMl > 0 ? totalMl : 1000;
  _bottleTargetMl = Math.max(0, Math.min(_bottleTotalMl, Number(dispensedMl || 0)));

  if (_bottleTargetMl === 0) {
    _bottleCurrentMl = 0;
  }
  if (pouring !== null) {
    _bottlePouring = Boolean(pouring);
  } else {
    _bottlePouring = _bottleTargetMl > 0 && _bottleTargetMl < _bottleTotalMl;
  }

  if (!_bottleAnimRaf) {
    _bottleAnimRaf = requestAnimationFrame(_stepBottleAnimation);
  }
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

  const sufNote = document.getElementById("calc-sufficient-note");
  if (sufNote) {
    sufNote.classList.toggle("hidden", totalDeficit > 0);
  }

  const alertBox = document.getElementById("ai-crosscheck-alert");
  if (alertBox) {
    const diffs = [
      { label: "N", sVal: Number(sys.n || 0), rVal: Number(rfDefs.n || 0) },
      { label: "P₂O₅", sVal: Number(sys.p2o5 || 0), rVal: Number(rfDefs.p2o5 || 0) },
      { label: "K₂O", sVal: Number(sys.k2o || 0), rVal: Number(rfDefs.k2o || 0) },
    ].filter((d) => {
      const absDiff = Math.abs(d.sVal - d.rVal);
      const base = Math.max(d.sVal, d.rVal, 1);
      return absDiff >= 20 && absDiff / base >= 0.15;
    });

    alertBox.classList.remove("hidden", "is-warn", "is-ok");
    if (diffs.length > 0) {
      const names = diffs.map((d) => `${d.label} (ระบบ ${d.sVal.toFixed(1)} g vs AI ${d.rVal.toFixed(1)} g)`).join(", ");
      alertBox.classList.add("is-warn");
      alertBox.textContent = `ข้อสังเกตทวนสอบ AI (Cross-Check): พบค่าต่างจากสูตรสมดุลมวลในธาตุ ${names} — แนะนำให้ตรวจสอบค่า pH ดิน ความชื้น หรือความเขียวจากภาพโดรนเพิ่มเติม (การจ่ายปุ๋ยยังคงอ้างอิงสูตรสมดุลมวล)`;
    } else {
      alertBox.classList.add("is-ok");
      alertBox.textContent = "ผลทวนสอบจาก AI สอดคล้องกับสูตรสมดุลมวล (ระบบจ่ายปุ๋ยตามสูตรสมดุลมวล)";
    }
  }

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

  document.getElementById("btn-start-dispense").addEventListener("click", async () => {
    stopDispenseTimers();
    resetEmergencyStopButton();
    const myToken = ++_dispenseFlowToken;
    const s = currentState();
    const mode = appState.activeMode;
    const liveSection = document.getElementById("dispense-live-section");
    const countdownBox = document.getElementById("countdown-banner");
    const countdownText = document.getElementById("countdown-text");
    const countdownNum = document.getElementById("countdown-num");
    const statusText = document.getElementById("dispense-status-text");
    const stopBtn = document.getElementById("btn-stop-dispense");
    const nextWrap = document.getElementById("dispense-next-wrap");

    liveSection.classList.remove("hidden");
    countdownBox.classList.remove("hidden");
    stopBtn.classList.remove("hidden");
    nextWrap.classList.add("hidden");
    updateBottleVisual(0, 1000);
    liveSection.scrollIntoView({ behavior: "smooth", block: "start" });

    // Step 1: Speak setup instruction completely without interruption
    countdownNum.textContent = "10";
    countdownText.textContent = "กรุณานำกระบอกผสมมาวางใต้หัวจ่าย...";
    statusText.textContent = "กำลังแจ้งเตือนเตรียมวางกระบอกผสม...";
    await speakThaiAndWait("กรุณานำกระบอกผสมมาวางใต้หัวจ่าย", 7500);
    if (myToken !== _dispenseFlowToken) return;

    // Step 2: Pause 2 seconds after instruction finishes
    statusText.textContent = "รอผู้ใช้เตรียมกระบอกผสม (2 วินาที)...";
    await waitMs(2000);
    if (myToken !== _dispenseFlowToken) return;

    // Step 3: Announce upcoming release, then count down 10..1 sequentially
    countdownText.textContent = "ระบบกำลังจะปล่อยน้ำปุ๋ยผสมลงกระบอกในอีก";
    statusText.textContent = "กำลังนับถอยหลัง 10 วินาที ก่อนเริ่มจ่ายปุ๋ย...";
    await speakThaiAndWait("ระบบกำลังจะปล่อยน้ำปุ๋ยผสมลงกระบอกในอีก", 6500);
    if (myToken !== _dispenseFlowToken) return;

    for (let secLeft = 10; secLeft >= 1; secLeft -= 1) {
      if (myToken !== _dispenseFlowToken) return;
      countdownNum.textContent = String(secLeft);
      await Promise.all([
        waitMs(1050),
        speakThaiAndWait(String(secLeft), 1600),
      ]);
    }
    if (myToken !== _dispenseFlowToken) return;

    // Step 4: Hide countdown banner and begin dispensing
    countdownBox.classList.add("hidden");
    speakThai("เริ่มจ่ายน้ำปุ๋ยครับ");

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
      if (myToken !== _dispenseFlowToken) return;
      if (dispRes && dispRes.__error) {
        statusText.textContent = dispRes.__error;
        return;
      }
      _dispensePollTimer = setInterval(async () => {
        const hw = await apiRequest("/api/mixer/hw-status");
        if (!hw || hw.__error || myToken !== _dispenseFlowToken) return;
        statusText.textContent = hw.current_step || "กำลังจ่ายน้ำ...";
        updateBottleVisual(hw.dispensed_ml, hw.target_total_ml || totalBatch);
        if (!hw.is_running) {
          clearInterval(_dispensePollTimer);
          _dispensePollTimer = null;
          updateBottleVisual(hw.target_total_ml || totalBatch, hw.target_total_ml || totalBatch);
          s.mixer.dispensedDone = true;
          statusText.textContent = "จ่ายน้ำปุ๋ยครบ 1,000 ml เรียบร้อยแล้ว";
          stopBtn.classList.add("hidden");
          nextWrap.classList.remove("hidden");
        }
      }, 250);
    } else {
      const vN = Number(s.mixer.volumes?.n || 0);
      const vP = Number(s.mixer.volumes?.p || 0);
      const vK = Number(s.mixer.volumes?.k || 0);
      let simMl = 0;
      const stepMl = totalBatch / 36;

      _dispensePollTimer = setInterval(() => {
        if (myToken !== _dispenseFlowToken) {
          clearInterval(_dispensePollTimer);
          _dispensePollTimer = null;
          return;
        }
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
          stopBtn.classList.add("hidden");
          nextWrap.classList.remove("hidden");
        }
      }, 250);
    }
  });

  // 2-Step Confirmation Red Emergency Stop
  document.getElementById("btn-stop-dispense").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed !== "true") {
      btn.dataset.armed = "true";
      btn.textContent = "กดยืนยันอีกครั้งเพื่อหยุดจ่ายฉุกเฉิน!";
      _stopArmResetTimer = setTimeout(resetEmergencyStopButton, 4000);
      return;
    }

    resetEmergencyStopButton();
    stopDispenseTimers();
    if (appState.activeMode === "live") {
      await apiRequest("/api/mixer/stop-live", { method: "POST" });
    }
    document.getElementById("countdown-banner").classList.add("hidden");
    document.getElementById("dispense-status-text").textContent = "หยุดการจ่ายน้ำฉุกเฉินแล้ว";
  });

  document.getElementById("btn-goto-drone-final").addEventListener("click", () => goToStage(6));
}

/* ==================== STAGE 6: ANIMATED DRONE SVG & COMPLETE SUMMARY ==================== */

function populateFinalSummary() {
  const s = currentState();
  const area = s.plot.confirmedAreaM2 || 0;
  document.getElementById("sum-plot-name").textContent = s.plot.name || "แปลงสาธิต";
  document.getElementById("sum-area-m2").textContent = `${formatNum(area, 1)} ตร.ม.`;
  document.getElementById("sum-area-thai").textContent = areaM2ToThaiText(area).replace("เท่ากับ ", "");

  document.getElementById("sum-crop-name").textContent = s.crop.cropName || "—";
  document.getElementById("sum-crop-variety").textContent = s.crop.variety || "—";
  document.getElementById("sum-crop-stage").textContent = s.crop.growthStage || "—";
  document.getElementById("sum-soil-type").textContent = SOIL_LABELS[s.crop.soilType] || s.crop.soilType || "—";

  document.getElementById("sum-exg").textContent =
    s.survey.greenPct !== null ? `${formatNum(s.survey.greenPct, 1)} %` : "— %";

  const avg = s.soil.avgSummary;
  const pts = (s.soil.points || []).filter((p) => p && p.n !== null);
  const srcSoil = avg || (pts.length > 0 ? pts[0] : null);
  document.getElementById("sum-soil-n").textContent = srcSoil ? formatNum(srcSoil.n, 0) : "—";
  document.getElementById("sum-soil-p").textContent = srcSoil ? formatNum(srcSoil.p, 0) : "—";
  document.getElementById("sum-soil-k").textContent = srcSoil ? formatNum(srcSoil.k, 0) : "—";
  document.getElementById("sum-soil-ph").textContent = srcSoil ? formatNum(srcSoil.ph, 1) : "—";

  const vols = s.mixer.volumes || {};
  const sys = s.mixer.sysDeficit || {};
  const totDef = Number(sys.n || 0) + Number(sys.p2o5 || 0) + Number(sys.k2o || 0);
  document.getElementById("sum-deficit-tot").textContent = `${totDef.toFixed(1)} g`;
  document.getElementById("sum-vol-n").textContent = `${formatNum(vols.n, 1)} ml`;
  document.getElementById("sum-vol-p").textContent = `${formatNum(vols.p, 1)} ml`;
  document.getElementById("sum-vol-k").textContent = `${formatNum(vols.k, 1)} ml`;
  document.getElementById("sum-vol-w").textContent = `${formatNum(vols.water, 1)} ml`;
}

let _droneAnimRaf = null;

function _stopDroneAnimation() {
  if (_droneAnimRaf) {
    cancelAnimationFrame(_droneAnimRaf);
    _droneAnimRaf = null;
  }
}

function _createDroneSceneController() {
  const droneEl = document.getElementById("svg-drone-group");
  const shadowEl = document.getElementById("svg-drone-shadow");
  const sprayLayerEl = document.getElementById("svg-spray-layer");
  const sprayDropEls = Array.from(document.querySelectorAll("#svg-spray-drops .spray-drop"));
  const streamGroupEl = document.getElementById("svg-refill-stream-group");
  const valveEl = document.getElementById("svg-tap-valve");
  const podLiquidEl = document.getElementById("svg-pod-liquid");
  const supplyLiquidEl = document.getElementById("svg-supply-liquid");
  const supplySurfaceEl = document.getElementById("svg-supply-surface");
  const downwashEl = document.getElementById("svg-downwash-ring");
  const rotorL = document.getElementById("rotor-l");
  const rotorR = document.getElementById("rotor-r");
  const rotorML = document.getElementById("rotor-ml");
  const rotorMR = document.getElementById("rotor-mr");
  const blurL = document.getElementById("rotor-blur-l");
  const blurR = document.getElementById("rotor-blur-r");
  const blurML = document.getElementById("rotor-blur-ml");
  const blurMR = document.getElementById("rotor-blur-mr");
  const ledL = document.getElementById("drone-led-l");
  const ledR = document.getElementById("drone-led-r");
  const cropPlants = Array.from(document.querySelectorAll("#svg-crop-field .crop-plant"));
  const cropDews = Array.from(document.querySelectorAll("#svg-crop-field .crop-dew"));

  const PAD_X = 178;
  const PAD_Y = 152;
  const GROUND_Y = 183;

  // Per-droplet seeds for organic spray particles
  const dropSeeds = sprayDropEls.map((_, idx) => ({
    nozzle: idx % 2 === 0 ? -18 : 18,
    phase: (idx / sprayDropEls.length),
    spread: ((idx * 37) % 24) - 12,
    speed: 0.9 + ((idx * 19) % 5) * 0.14,
  }));

  const state = {
    x: PAD_X,
    y: PAD_Y,
    vx: 0,
    pitch: 0,
    rotorSpeed: 0, // 0..1
    rotorPhase: 0,
    spray: 0, // 0..1
    podLevel: 0, // 0..1
    supplyDrop: 0, // 0..1
    valveOpen: false,
    hydrated: 0, // 0..1
  };

  function render(nowSec) {
    const altitude = Math.max(0, PAD_Y - state.y); // 0 on pad, ~75 at cruise
    const hoverBob = altitude > 2 ? Math.sin(nowSec * 5.2) * 1.8 : 0;
    const drawY = state.y + hoverBob;

    // Drone body position + realistic banking pitch
    droneEl.setAttribute(
      "transform",
      `translate(${state.x.toFixed(2)}, ${drawY.toFixed(2)}) rotate(${state.pitch.toFixed(2)})`
    );

    // Dynamic ground shadow scales & fades with altitude
    const altFactor = Math.min(1, altitude / 95);
    const shadowRx = 34 - altFactor * 14;
    const shadowRy = 5.5 - altFactor * 2.2;
    const shadowOpacity = 0.28 - altFactor * 0.16;
    shadowEl.setAttribute("cx", state.x.toFixed(2));
    shadowEl.setAttribute("rx", shadowRx.toFixed(2));
    shadowEl.setAttribute("ry", shadowRy.toFixed(2));
    shadowEl.setAttribute("opacity", shadowOpacity.toFixed(3));

    // Downwash air ripple when hovering near pad or ground
    if (state.rotorSpeed > 0.35 && altitude < 55) {
      const pulse = (nowSec * 2.6) % 1;
      const ringRx = 22 + pulse * 30;
      const ringRy = 4 + pulse * 4;
      const ringOp = (1 - pulse) * 0.55 * state.rotorSpeed * (1 - altitude / 60);
      downwashEl.setAttribute("cx", state.x.toFixed(2));
      downwashEl.setAttribute("cy", GROUND_Y.toFixed(1));
      downwashEl.setAttribute("rx", ringRx.toFixed(1));
      downwashEl.setAttribute("ry", ringRy.toFixed(1));
      downwashEl.setAttribute("opacity", Math.max(0, ringOp).toFixed(3));
    } else {
      downwashEl.setAttribute("opacity", "0");
    }

    // Spinning rotor blades + motion blur discs
    state.rotorPhase += state.rotorSpeed * 0.72;
    const bladeCos = Math.cos(state.rotorPhase * 6.283);
    const bladeCos2 = Math.cos((state.rotorPhase + 0.35) * 6.283);
    const halfMain = 4 + Math.abs(bladeCos) * 16;
    const halfMid = 3 + Math.abs(bladeCos2) * 10;

    rotorL.setAttribute("x1", (-42 - halfMain).toFixed(1));
    rotorL.setAttribute("x2", (-42 + halfMain).toFixed(1));
    rotorR.setAttribute("x1", (42 - halfMain).toFixed(1));
    rotorR.setAttribute("x2", (42 + halfMain).toFixed(1));
    rotorML.setAttribute("x1", (-29 - halfMid).toFixed(1));
    rotorML.setAttribute("x2", (-29 + halfMid).toFixed(1));
    rotorMR.setAttribute("x1", (29 - halfMid).toFixed(1));
    rotorMR.setAttribute("x2", (29 + halfMid).toFixed(1));

    const blurOp = Math.max(0, (state.rotorSpeed - 0.25) / 0.75) * 0.85;
    blurL.setAttribute("opacity", blurOp.toFixed(3));
    blurR.setAttribute("opacity", blurOp.toFixed(3));
    blurML.setAttribute("opacity", (blurOp * 0.75).toFixed(3));
    blurMR.setAttribute("opacity", (blurOp * 0.75).toFixed(3));

    // Navigation LED strobe
    const blinkOn = Math.sin(nowSec * 7.5) > -0.2;
    ledL.setAttribute("opacity", state.rotorSpeed > 0.05 ? (blinkOn ? "1" : "0.3") : "0.45");
    ledR.setAttribute("opacity", state.rotorSpeed > 0.05 ? (blinkOn ? "1" : "0.3") : "0.45");

    // Solenoid valve & refill stream
    valveEl.setAttribute("fill", state.valveOpen ? "#22c55e" : "#f59e0b");
    streamGroupEl.setAttribute("opacity", state.valveOpen ? "0.95" : "0");

    // Belly pod liquid level (y from 28 empty -> 13 full, height 0 -> 15)
    const podH = Math.max(0, Math.min(15, state.podLevel * 15));
    podLiquidEl.setAttribute("y", (28 - podH).toFixed(2));
    podLiquidEl.setAttribute("height", podH.toFixed(2));

    // Supply tank liquid level slightly drops during refill
    const supY = 72 + state.supplyDrop * 12;
    const supH = 100 - state.supplyDrop * 12;
    supplyLiquidEl.setAttribute("y", supY.toFixed(2));
    supplyLiquidEl.setAttribute("height", supH.toFixed(2));
    supplySurfaceEl.setAttribute("cy", supY.toFixed(2));

    // Spray mist cone + drifting droplets
    if (state.spray > 0.02) {
      sprayLayerEl.setAttribute("opacity", state.spray.toFixed(3));
      sprayLayerEl.setAttribute(
        "transform",
        `translate(${state.x.toFixed(2)}, ${drawY.toFixed(2)})`
      );
      const driftX = -state.vx * 0.12;
      dropSeeds.forEach((seed, idx) => {
        const el = sprayDropEls[idx];
        const t = (nowSec * 1.75 * seed.speed + seed.phase) % 1;
        const dx = seed.nozzle + seed.spread * t + driftX * t;
        const dy = 29 + t * 68;
        el.setAttribute("cx", dx.toFixed(1));
        el.setAttribute("cy", dy.toFixed(1));
        el.setAttribute("opacity", ((1 - t) * 0.9 * state.spray).toFixed(3));
      });
    } else {
      sprayLayerEl.setAttribute("opacity", "0");
    }

    // Crop foliage downwash wind sway + moisture dew shimmer
    cropPlants.forEach((plant) => {
      const cx = Number(plant.getAttribute("data-cx")) || 400;
      const dist = Math.abs(state.x - cx);
      let swayDeg = 0;
      if (state.rotorSpeed > 0.4 && dist < 95) {
        const proximity = 1 - dist / 95;
        const dir = cx >= state.x ? 1 : -1;
        swayDeg = dir * proximity * 7.5 + Math.sin(nowSec * 14 + cx) * proximity * 3.5;
      } else {
        swayDeg = Math.sin(nowSec * 1.8 + cx * 0.05) * 1.1;
      }
      plant.setAttribute("transform", `translate(${cx}, 168) rotate(${swayDeg.toFixed(2)})`);
    });

    cropDews.forEach((dew) => {
      dew.setAttribute("opacity", (state.hydrated * 0.9).toFixed(2));
    });
  }

  function animateSegment(durationMs, updater) {
    return new Promise((resolve) => {
      const start = performance.now();
      let prevX = state.x;
      let prevTime = start;

      const tick = (now) => {
        const elapsed = now - start;
        const rawT = Math.min(1, elapsed / durationMs);
        const dt = Math.max(0.008, (now - prevTime) / 1000);

        updater(rawT, now / 1000);

        // Compute horizontal velocity & smooth pitch banking
        const instVx = (state.x - prevX) / dt;
        state.vx = state.vx * 0.72 + instVx * 0.28;
        const targetPitch = Math.max(-11, Math.min(11, state.vx * 0.055));
        state.pitch = state.pitch * 0.8 + targetPitch * 0.2;

        prevX = state.x;
        prevTime = now;
        render(now / 1000);

        if (rawT < 1) {
          _droneAnimRaf = requestAnimationFrame(tick);
        } else {
          _droneAnimRaf = null;
          resolve();
        }
      };
      _stopDroneAnimation();
      _droneAnimRaf = requestAnimationFrame(tick);
    });
  }

  function resetToPad(isComplete) {
    _stopDroneAnimation();
    state.x = PAD_X;
    state.y = PAD_Y;
    state.vx = 0;
    state.pitch = 0;
    state.rotorSpeed = 0;
    state.spray = 0;
    state.valveOpen = false;
    state.podLevel = isComplete ? 0.12 : 0;
    state.supplyDrop = isComplete ? 1 : 0;
    state.hydrated = isComplete ? 1 : 0;
    render(performance.now() / 1000);
  }

  return { state, animateSegment, resetToPad, PAD_X, PAD_Y };
}

function _easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function bindStage6() {
  const btn = document.getElementById("btn-final-drone-run");
  const statusEl = document.getElementById("final-drone-status");
  const dockCard = document.getElementById("dock-concept-card");
  const scene = _createDroneSceneController();

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const s = currentState();
    const isLive = appState.activeMode === "live";

    // Reveal SVG only after user confirms!
    dockCard.classList.remove("hidden");
    scene.resetToPad(false);

    // Phase 1: Solenoid Valve Opens & Fills Belly Pod (1.4s)
    statusEl.textContent = "1. เปิดก๊อกสถานีเติมน้ำปุ๋ย 8–10 ml ลงตลับใต้โดรน...";
    scene.state.valveOpen = true;
    await scene.animateSegment(1400, (t) => {
      const e = _easeInOutCubic(t);
      scene.state.podLevel = e;
      scene.state.supplyDrop = e;
    });
    scene.state.valveOpen = false;

    // Phase 2: Rotor Spool-Up & Smooth Vertical Takeoff (1.2s)
    statusEl.textContent = "2. ปิดวาล์วเรียบร้อย — เร่งรอบใบพัดและทะยานขึ้นจากจุดจอด...";
    await scene.animateSegment(1200, (t) => {
      scene.state.rotorSpeed = Math.min(1, t * 2.2);
      const liftT = Math.max(0, (t - 0.25) / 0.75);
      scene.state.y = scene.PAD_Y - _easeInOutCubic(liftT) * 76;
    });

    // Phase 3: Forward Cruise to Crop Field with Realistic Banking (1.3s)
    statusEl.textContent = "3. โดรนกำลังบินเข้าสู่แนวแปลงเกษตรเป้าหมาย...";
    await scene.animateSegment(1300, (t) => {
      const e = _easeInOutCubic(t);
      scene.state.x = scene.PAD_X + e * (312 - scene.PAD_X);
      scene.state.y = 76 + Math.sin(t * Math.PI) * -6;
    });

    // Phase 4: Active Agricultural Spraying Sweep Over Crops (Right -> Left Pass)
    statusEl.textContent = "4. โดรนกำลังบินพ่นปุ๋ยละอองฝอยเหนือแปลงเป้าหมาย...";
    const missionPromise = apiRequest("/api/drone/mission", {
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

    // Pass 1: Left -> Right across crop canopy (312 -> 502)
    await scene.animateSegment(1700, (t) => {
      const e = _easeInOutCubic(t);
      scene.state.x = 312 + e * (502 - 312);
      scene.state.y = 78;
      scene.state.spray = Math.min(1, t * 4);
      scene.state.podLevel = 1 - e * 0.45;
      scene.state.hydrated = e * 0.55;
    });

    // Pass 2: Right -> Left return spray pass (502 -> 318)
    await scene.animateSegment(1600, (t) => {
      const e = _easeInOutCubic(t);
      scene.state.x = 502 - e * (502 - 318);
      scene.state.y = 82;
      scene.state.spray = t > 0.85 ? (1 - t) / 0.15 : 1;
      scene.state.podLevel = 0.55 - e * 0.43;
      scene.state.hydrated = 0.55 + e * 0.45;
    });
    scene.state.spray = 0;
    await missionPromise;

    // Phase 5: Return to Home (RTH) Cruise Back to Docking Pad (1.3s)
    statusEl.textContent = "5. พ่นครบแปลงแล้ว — โดรนกำลังบินกลับจุดจอดอัตโนมัติ...";
    await scene.animateSegment(1300, (t) => {
      const e = _easeInOutCubic(t);
      scene.state.x = 318 - e * (318 - scene.PAD_X);
      scene.state.y = 82 - Math.sin(t * Math.PI) * 10;
    });

    // Phase 6: Smooth Vertical Touchdown & Rotor Spin-Down (1.1s)
    await scene.animateSegment(1100, (t) => {
      const descT = Math.min(1, t / 0.72);
      scene.state.y = 82 + _easeInOutCubic(descT) * (scene.PAD_Y - 82);
      scene.state.x = scene.PAD_X;
      if (t > 0.72) {
        const spinDown = (t - 0.72) / 0.28;
        scene.state.rotorSpeed = Math.max(0, 1 - spinDown);
      }
    });
    scene.resetToPad(true);

    // Complete Summary Reveal
    s.finalDrone.done = true;
    statusEl.textContent = isLive
      ? "เสร็จสิ้นการเตรียมพร้อม (หากใช้โดรนบังคับมือ สามารถบินพ่นจริงได้ทันที)"
      : "โดรนบินพ่นและลงจอดปลอดภัยแล้ว";

    document.getElementById("final-cta-wrap").classList.add("hidden");
    populateFinalSummary();
    document.getElementById("final-complete-banner").classList.remove("hidden");
    document.getElementById("final-summary-card").classList.remove("hidden");
    document.getElementById("final-restart-wrap").classList.remove("hidden");
    speakThai("เสร็จสิ้นระบบทั้งหมดเรียบร้อยแล้วครับ");
    btn.disabled = false;
  });

  document.getElementById("btn-restart-workflow").addEventListener("click", () => {
    scene.resetToPad(false);
    appState.byMode[appState.activeMode] = createEmptyModeState();
    restoreModeUI();
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

  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    openBtn.addEventListener("click", () => dialog.showModal());
    closeBtn.addEventListener("click", () => dialog.close());
  }

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

  const checkBox = document.getElementById("pi5-check-result");
  document.getElementById("btn-check-pi5").addEventListener("click", async () => {
    const url = document.getElementById("cfg-pi5-url").value.trim();
    checkBox.classList.remove("hidden", "is-ok", "is-err");
    checkBox.textContent = "กำลังตรวจสอบการเชื่อมต่อ Raspberry Pi 5 และ LoRa...";
    const res = await apiRequest("/api/pi5/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pi5_base_url: url }),
    });
    if (!res || !res.ok) {
      checkBox.classList.add("is-err");
      checkBox.textContent = res?.error || "เชื่อมต่อ Pi 5 ไม่สำเร็จ";
      return;
    }
    checkBox.classList.add("is-ok");
    const soil = res.soil || {};
    const loraTxt = res.lora_connected ? `เชื่อมต่อแล้ว (RSSI: ${res.lora_rssi ?? "—"}, แพ็กเก็ต: ${res.packet_count})` : "ยังไม่พบแพ็กเก็ต LoRa (เช็ก Power Bank กล่องวัดดิน)";
    checkBox.innerHTML =
      `<strong>เชื่อมต่อ Pi 5 สำเร็จ (${res.pi5_base_url})</strong><br>` +
      `LoRa: ${loraTxt}<br>` +
      `ค่าล่าสุด: N=${soil.n ?? "—"} | P=${soil.p ?? "—"} | K=${soil.k ?? "—"} | pH=${soil.ph ?? "—"} (บันทึกแล้ว ${res.recorded_count || 0}/15 จุด)`;
  });

  const pumpBox = document.getElementById("pump-test-result");
  document.querySelectorAll(".btn-pump-test").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pump = btn.dataset.pump;
      const url = document.getElementById("cfg-pi5-url").value.trim();
      btn.disabled = true;
      pumpBox.classList.remove("hidden", "is-ok", "is-err");
      pumpBox.textContent = `กำลังสั่งเปิดปั๊ม ${pump} นาน 5 วินาที...`;
      const res = await apiRequest("/api/pi5/pump-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pump, duration_s: 5, pi5_base_url: url }),
      });
      btn.disabled = false;
      if (!res || !res.ok) {
        pumpBox.classList.add("is-err");
        pumpBox.textContent = res?.error || `ทดสอบปั๊ม ${pump} ไม่สำเร็จ`;
        return;
      }
      pumpBox.classList.add("is-ok");
      pumpBox.textContent = `ทดสอบปั๊ม ${pump} เสร็จสิ้น (5 วินาที) — ปริมาตรตามค่าสอบเทียบควรได้ ≈ ${res.expected_ml} ml (เทียบกับแก้วตวงจริง)`;
    });
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

  document.getElementById("btn-stage-back").addEventListener("click", () => {
    stopAutoSoilProbing(false);
    stopDispenseTimers();
    const cur = currentState().stage;
    if (cur > 0) goToStage(cur - 1);
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
