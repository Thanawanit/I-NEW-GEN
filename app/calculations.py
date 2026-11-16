"""Core mathematical, geospatial scaling, and OpenCV ExG calculations."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

EARTH_RADIUS_M = 6_371_000.0
P_TO_P2O5_FACTOR = 2.29
K_TO_K2O_FACTOR = 1.20


def _extract_ring_coords(polygon_geojson: Any) -> list[tuple[float, float]]:
    """Extract (lat, lng) coordinate pairs from GeoJSON Feature/Geometry or list."""
    if isinstance(polygon_geojson, dict):
        geom = polygon_geojson.get("geometry", polygon_geojson)
        coords = geom.get("coordinates", [])
        if coords and isinstance(coords[0], list) and isinstance(coords[0][0], list):
            ring = coords[0]
            return [(float(pt[1]), float(pt[0])) for pt in ring]
    if isinstance(polygon_geojson, list):
        parsed: list[tuple[float, float]] = []
        for item in polygon_geojson:
            if isinstance(item, dict) and "lat" in item and "lng" in item:
                parsed.append((float(item["lat"]), float(item["lng"])))
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                parsed.append((float(item[1]), float(item[0])))
        return parsed
    return []


def project_latlng_to_waypoints(
    polygon_geojson: Any,
    table_w_cm: float = 40.0,
    table_h_cm: float = 60.0,
    min_move_cm: float = 20.0,
) -> list[dict[str, float]]:
    """Project Lat/Lng polygon into scaled tabletop drone waypoints (heading clockwise from +Y North)."""
    points = _extract_ring_coords(polygon_geojson)
    if len(points) < 2:
        return []

    lat0_rad = math.radians(points[0][0])
    lng0_rad = math.radians(points[0][1])

    meters_xy: list[tuple[float, float]] = []
    for lat_deg, lng_deg in points:
        x_m = EARTH_RADIUS_M * (math.radians(lng_deg) - lng0_rad) * math.cos(lat0_rad)
        y_m = EARTH_RADIUS_M * (math.radians(lat_deg) - lat0_rad)
        meters_xy.append((x_m, y_m))

    xs = [pt[0] for pt in meters_xy]
    ys = [pt[1] for pt in meters_xy]
    w_real = max(xs) - min(xs)
    h_real = max(ys) - min(ys)

    if w_real <= 1e-6 and h_real <= 1e-6:
        return []

    scale_x = table_w_cm / w_real if w_real > 1e-6 else float("inf")
    scale_y = table_h_cm / h_real if h_real > 1e-6 else float("inf")
    scale_k = min(scale_x, scale_y)

    waypoints: list[dict[str, float]] = []
    acc_x, acc_y = meters_xy[0]
    prev_heading = 0.0  # Drone starts facing +Y (North)

    for idx in range(1, len(meters_xy)):
        cur_x, cur_y = meters_xy[idx]
        dx_cm = scale_k * (cur_x - acc_x)
        dy_cm = scale_k * (cur_y - acc_y)
        dist_cm = math.hypot(dx_cm, dy_cm)

        if dist_cm < min_move_cm and idx < len(meters_xy) - 1:
            continue

        if dist_cm < 1e-3:
            continue

        # Navigation azimuth clockwise from +Y (North): dx=80, dy=0 -> 90 deg
        heading_deg = math.degrees(math.atan2(dx_cm, dy_cm))
        turn_deg = ((heading_deg - prev_heading + 180.0) % 360.0) - 180.0
        waypoints.append(
            {
                "dx": round(dx_cm, 2),
                "dy": round(dy_cm, 2),
                "distance_cm": round(dist_cm, 2),
                "angle_deg": round(heading_deg, 2),
                "turn_deg": round(turn_deg, 2),
            }
        )
        prev_heading = heading_deg
        acc_x, acc_y = cur_x, cur_y

    return waypoints


def analyze_green_coverage(
    image_bytes: bytes,
    output_mask_path: Path,
    threshold: int = 20,
) -> float:
    """Compute Excess Green Index (ExG = 2G - R - B) coverage % and save overlay PNG."""
    buf = np.frombuffer(image_bytes, dtype=np.uint8)
    img_bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img_bgr is None or img_bgr.size == 0:
        raise ValueError("Invalid or unsupported image format.")

    b, g, r = cv2.split(img_bgr.astype(np.int16))
    exg = (2 * g) - r - b
    green_mask = exg > threshold

    green_pct = (float(np.count_nonzero(green_mask)) / float(green_mask.size)) * 100.0

    # Create clean botanical highlight over grayscale background for editorial UI display
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    overlay = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    overlay[green_mask] = (59, 145, 52)  # Botanical green highlight (BGR)

    output_mask_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_mask_path), overlay)
    return round(green_pct, 2)


def calculate_nutrient_deficit(
    measured_n_mg_kg: float,
    measured_p_mg_kg: float,
    measured_k_mg_kg: float,
    ph_value: float | None,
    bulk_density_g_cm3: float,
    root_depth_m: float,
    area_m2: float,
    target_n_g_m2: float,
    target_p2o5_g_m2: float,
    target_k2o_g_m2: float,
    ph_min: float,
    ph_max: float,
    n_avail_factor: float = 0.30,
    p_avail_factor: float = 0.20,
    k_avail_factor: float = 0.15,
) -> dict[str, Any]:
    """Calculate N, P2O5, K2O deficits (g) across area_m2 and check soil pH warnings."""
    if area_m2 <= 0 or bulk_density_g_cm3 <= 0 or root_depth_m <= 0:
        raise ValueError("Area, bulk density, and root depth must be positive.")

    soil_factor = bulk_density_g_cm3 * root_depth_m
    m_soil_n = (measured_n_mg_kg * soil_factor) * n_avail_factor
    m_soil_p2o5 = (measured_p_mg_kg * soil_factor) * P_TO_P2O5_FACTOR * p_avail_factor
    m_soil_k2o = (measured_k_mg_kg * soil_factor) * K_TO_K2O_FACTOR * k_avail_factor

    delta_n_g = max(0.0, target_n_g_m2 - m_soil_n) * area_m2
    delta_p2o5_g = max(0.0, target_p2o5_g_m2 - m_soil_p2o5) * area_m2
    delta_k2o_g = max(0.0, target_k2o_g_m2 - m_soil_k2o) * area_m2

    ph_warning: str | None = None
    if ph_value is not None:
        if ph_value < ph_min:
            ph_warning = (
                f"คำเตือน pH ({ph_value:.1f}): ดินเป็นกรดเกินเกณฑ์เหมาะสม ({ph_min:.1f}–{ph_max:.1f}) "
                "พืชดูดซึมธาตุได้น้อย ควรปรับสภาพด้วยปูนขาวหรือโดโลไมต์ก่อนใส่ปุ๋ย"
            )
        elif ph_value > ph_max:
            ph_warning = (
                f"คำเตือน pH ({ph_value:.1f}): ดินเป็นด่างเกินเกณฑ์เหมาะสม ({ph_min:.1f}–{ph_max:.1f}) "
                "ควรปรับสภาพด้วยอินทรียวัตถุหรือกำมะถัน"
            )

    return {
        "deficits_g": {
            "n": round(delta_n_g, 2),
            "p2o5": round(delta_p2o5_g, 2),
            "k2o": round(delta_k2o_g, 2),
        },
        "soil_available_g_m2": {
            "n": round(m_soil_n, 2),
            "p2o5": round(m_soil_p2o5, 2),
            "k2o": round(m_soil_k2o, 2),
        },
        "ph_warning": ph_warning,
    }


def calculate_mixing_plan(
    deficits_g: dict[str, float],
    c_bio_n: float,
    c_bio_p2o5: float,
    c_bio_k2o: float,
    q_pump_n: float,
    q_pump_p: float,
    q_pump_k: float,
    q_pump_water: float,
    demo_batch_ml: float = 200.0,
    demo_bio_ml: float = 80.0,
    min_runtime_s: float = 1.5,
) -> dict[str, Any]:
    """Scale field deficits to a tabletop demo batch and compute pump runtimes."""
    v_real_n = (deficits_g["n"] * 1000.0) / c_bio_n if c_bio_n > 0 else 0.0
    v_real_p = (deficits_g["p2o5"] * 1000.0) / c_bio_p2o5 if c_bio_p2o5 > 0 else 0.0
    v_real_k = (deficits_g["k2o"] * 1000.0) / c_bio_k2o if c_bio_k2o > 0 else 0.0
    total_real = v_real_n + v_real_p + v_real_k

    if total_real <= 0:
        return {
            "all_sufficient": True,
            "demo_volumes_ml": {"n": 0.0, "p": 0.0, "k": 0.0, "water": 0.0},
            "pump_seconds": {"n": 0.0, "p": 0.0, "k": 0.0, "water": 0.0},
            "note": "ดินมีความสมบูรณ์เพียงพอ ไม่ต้องเติมปุ๋ย",
        }

    vol_n = demo_bio_ml * (v_real_n / total_real)
    vol_p = demo_bio_ml * (v_real_p / total_real)
    vol_k = demo_bio_ml * (v_real_k / total_real)

    sec_n = vol_n / q_pump_n
    sec_p = vol_p / q_pump_p
    sec_k = vol_k / q_pump_k

    # Minimum pump runtime guard: avoid unreliable < 1.5s motor priming bursts
    if 0 < sec_n < min_runtime_s:
        vol_n, sec_n = 0.0, 0.0
    if 0 < sec_p < min_runtime_s:
        vol_p, sec_p = 0.0, 0.0
    if 0 < sec_k < min_runtime_s:
        vol_k, sec_k = 0.0, 0.0

    vol_water = max(0.0, demo_batch_ml - (vol_n + vol_p + vol_k))
    sec_water = vol_water / q_pump_water

    return {
        "all_sufficient": False,
        "demo_volumes_ml": {
            "n": round(vol_n, 2),
            "p": round(vol_p, 2),
            "k": round(vol_k, 2),
            "water": round(vol_water, 2),
        },
        "pump_seconds": {
            "n": round(sec_n, 2),
            "p": round(sec_p, 2),
            "k": round(sec_k, 2),
            "water": round(sec_water, 2),
        },
        "note": None,
    }


def calculate_ec_dilution(
    current_ec_ppm: float,
    safe_ec_ppm: float,
    current_vol_ml: float,
    q_water_ml_s: float,
    water_ec_ppm: float = 150.0,
) -> dict[str, Any]:
    """Evaluate TDS/EC safety and compute dilution water volume accounting for tap water TDS."""
    if current_ec_ppm <= safe_ec_ppm or safe_ec_ppm <= 0:
        return {
            "measured_tds_ppm": round(current_ec_ppm, 1),
            "safe_ec_max_ppm": round(safe_ec_ppm, 1),
            "needs_dilution": False,
            "add_water_ml": 0.0,
            "add_water_sec": 0.0,
            "message": "ค่าความเค็มอยู่ในเกณฑ์ปลอดภัย พร้อมนำไปใช้งานบนโดรน",
        }

    denom = safe_ec_ppm - water_ec_ppm
    if denom <= 0:
        return {
            "measured_tds_ppm": round(current_ec_ppm, 1),
            "safe_ec_max_ppm": round(safe_ec_ppm, 1),
            "needs_dilution": True,
            "add_water_ml": 0.0,
            "add_water_sec": 0.0,
            "message": "น้ำเปล่าที่ใช้เจือจางมีค่า TDS สูงกว่าเกณฑ์ปลอดภัยของพืช กรุณาใช้น้ำกรอง/น้ำสะอาด",
        }

    add_water_ml = current_vol_ml * ((current_ec_ppm - safe_ec_ppm) / denom)
    add_water_sec = add_water_ml / q_water_ml_s if q_water_ml_s > 0 else 0.0
    return {
        "measured_tds_ppm": round(current_ec_ppm, 1),
        "safe_ec_max_ppm": round(safe_ec_ppm, 1),
        "needs_dilution": True,
        "add_water_ml": round(add_water_ml, 2),
        "add_water_sec": round(add_water_sec, 2),
        "message": (
            f"ค่าความเค็มเกินเกณฑ์ปลอดภัย ({current_ec_ppm:.0f} > {safe_ec_ppm:.0f} ppm) "
            f"ต้องเติมน้ำเปล่าเจือจางเพิ่ม {add_water_ml:.1f} ml ({add_water_sec:.1f} วินาที) แล้วกวนวัดซ้ำ"
        ),
    }
