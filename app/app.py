"""Flask REST API & Web Server with strict SIM vs LIVE mode isolation."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request

APP_ROOT = Path(__file__).resolve().parent
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from calculations import (  # noqa: E402
    analyze_green_coverage,
    calculate_ec_dilution,
    calculate_mixing_plan,
    calculate_nutrient_deficit,
    project_latlng_to_waypoints,
)
from config import (  # noqa: E402
    DB_PATH,
    OVERRIDE_PATH,
    UPLOAD_DIR,
    config_to_dict,
    get_config,
    update_config,
)
from database import get_connection, init_db  # noqa: E402
from hardware_bridge import (  # noqa: E402
    force_stop_all_pumps,
    get_pump_hardware_status,
    get_soil_receiver_status,
    parse_soil_packet,
    start_sequential_dispense,
    start_soil_receivers,
)
from ml_model import (  # noqa: E402
    FEATURE_LABELS_TH,
    get_or_train_rf_model,
    predict_rf_nutrient_deficit,
)


def _normalize_mode(value: Any, simulated_flag: Any = False) -> str:
    """Normalize operational mode strictly to 'sim' or 'live'."""
    if bool(simulated_flag):
        return "sim"
    text = str(value or "live").strip().lower()
    if text in {"sim", "simulated", "demo"}:
        return "sim"
    return "live"


def _persist_soil_reading(
    db_path: Path,
    plot_id: int | None,
    mode: str,
    source: str,
    values: dict[str, Any],
) -> dict[str, Any]:
    """Insert a soil reading while preserving prior partial NPK or moisture fields."""
    with get_connection(db_path) as conn:
        resolved_plot_id = plot_id
        if resolved_plot_id is None:
            latest_plot = conn.execute(
                "SELECT id FROM plots WHERE mode = ? ORDER BY id DESC LIMIT 1",
                (mode,),
            ).fetchone()
            resolved_plot_id = int(latest_plot["id"]) if latest_plot else 1

        prev_npk = conn.execute(
            """
            SELECT nitrogen_mg_kg, phosphorus_mg_kg, potassium_mg_kg, ph_value
            FROM soil_readings
            WHERE plot_id = ? AND mode = ? AND nitrogen_mg_kg IS NOT NULL
            ORDER BY id DESC LIMIT 1
            """,
            (resolved_plot_id, mode),
        ).fetchone()
        prev_moist = conn.execute(
            """
            SELECT moisture_pct, ec_us_cm
            FROM soil_readings
            WHERE plot_id = ? AND mode = ? AND moisture_pct IS NOT NULL
            ORDER BY id DESC LIMIT 1
            """,
            (resolved_plot_id, mode),
        ).fetchone()

        n_val = values.get("n") if values.get("n") is not None else (prev_npk["nitrogen_mg_kg"] if prev_npk else None)
        p_val = values.get("p") if values.get("p") is not None else (prev_npk["phosphorus_mg_kg"] if prev_npk else None)
        k_val = values.get("k") if values.get("k") is not None else (prev_npk["potassium_mg_kg"] if prev_npk else None)
        ph_val = values.get("ph") if values.get("ph") is not None else (prev_npk["ph_value"] if prev_npk else None)
        moist_val = (
            values.get("moisture_pct")
            if values.get("moisture_pct") is not None
            else (prev_moist["moisture_pct"] if prev_moist else None)
        )
        ec_val = (
            values.get("ec_us_cm")
            if values.get("ec_us_cm") is not None
            else (prev_moist["ec_us_cm"] if prev_moist else None)
        )

        conn.execute(
            """
            INSERT INTO soil_readings (
                plot_id, nitrogen_mg_kg, phosphorus_mg_kg, potassium_mg_kg,
                ph_value, moisture_pct, ec_us_cm, source, mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (resolved_plot_id, n_val, p_val, k_val, ph_val, moist_val, ec_val, source, mode),
        )
        conn.commit()

    return {
        "n": n_val,
        "p": p_val,
        "k": k_val,
        "ph": ph_val,
        "moisture_pct": moist_val,
        "ec_us_cm": ec_val,
    }


def create_app(
    db_path: Path = DB_PATH,
    override_path: Path = OVERRIDE_PATH,
    upload_dir: Path = UPLOAD_DIR,
    start_hw_receivers: bool = False,
) -> Flask:
    """Create and configure the Flask application instance."""
    flask_app = Flask(
        __name__,
        template_folder=str(APP_ROOT / "templates"),
        static_folder=str(APP_ROOT / "static"),
    )
    flask_app.config["DB_PATH"] = db_path
    flask_app.config["OVERRIDE_PATH"] = override_path
    flask_app.config["UPLOAD_DIR"] = upload_dir

    init_db(db_path)

    if start_hw_receivers:
        start_soil_receivers(
            on_soil_packet=lambda parsed, src, _raw: _persist_soil_reading(
                db_path=db_path,
                plot_id=None,
                mode="live",
                source=src,
                values=parsed,
            )
        )

    @flask_app.get("/")
    def index() -> str:
        return render_template("index.html")

    @flask_app.get("/api/crops")
    def list_crops() -> Any:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT * FROM crop_profiles ORDER BY id ASC").fetchall()
        return jsonify({"crops": [dict(r) for r in rows]})

    @flask_app.get("/api/plots")
    def list_plots() -> Any:
        mode = _normalize_mode(request.args.get("mode", "live"))
        with get_connection(db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM plots WHERE mode = ? ORDER BY id DESC",
                (mode,),
            ).fetchall()
        return jsonify({"mode": mode, "plots": [dict(r) for r in rows]})

    @flask_app.post("/api/plots")
    def create_plot() -> Any:
        data = request.get_json(silent=True) or {}
        geojson = data.get("polygon_geojson")
        confirmed_area = data.get("confirmed_area_m2")
        if geojson is None or confirmed_area is None:
            return jsonify({"error": "polygon_geojson and confirmed_area_m2 are required"}), 400

        confirmed_area_val = float(confirmed_area)
        if confirmed_area_val <= 0:
            return jsonify({"error": "confirmed_area_m2 must be greater than 0"}), 400

        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        calc_area_val = float(data.get("calculated_area_m2") or confirmed_area_val)
        soil_type = str(data.get("soil_type") or "loam")
        cfg = get_config(override_path)
        bulk_density = cfg.bulk_density_map.get(soil_type, 1.35)
        crop_profile_id = int(data.get("crop_profile_id") or 1)
        plot_name = str(data.get("plot_name") or "แปลงทดสอบ").strip() or "แปลงทดสอบ"

        waypoints = project_latlng_to_waypoints(
            geojson,
            table_w_cm=cfg.table_width_cm,
            table_h_cm=cfg.table_height_cm,
            min_move_cm=cfg.min_move_cm,
        )

        with get_connection(db_path) as conn:
            cursor = conn.execute(
                """
                INSERT INTO plots (
                    plot_name, polygon_geojson, calculated_area_m2, confirmed_area_m2,
                    soil_type, bulk_density_g_cm3, crop_profile_id, mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    plot_name,
                    json.dumps(geojson),
                    calc_area_val,
                    confirmed_area_val,
                    soil_type,
                    bulk_density,
                    crop_profile_id,
                    mode,
                ),
            )
            conn.commit()
            plot_id = cursor.lastrowid

        return jsonify({"plot_id": plot_id, "mode": mode, "waypoints_cm": waypoints}), 201

    @flask_app.post("/api/soil/update")
    def update_soil_live() -> Any:
        data = request.get_json(silent=True) or {}
        plot_id = int(data.get("plot_id") or 1)
        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        is_sim = mode == "sim"
        raw_packet = parse_soil_packet(str(data.get("raw") or ""))
        source = "simulated" if is_sim else str(data.get("source") or ("arduino_rs485" if raw_packet else "live_sensor"))

        values = {
            "n": data.get("n") if data.get("n") is not None else raw_packet.get("n"),
            "p": data.get("p") if data.get("p") is not None else raw_packet.get("p"),
            "k": data.get("k") if data.get("k") is not None else raw_packet.get("k"),
            "ph": data.get("ph") if data.get("ph") is not None else raw_packet.get("ph"),
            "moisture_pct": data.get("moisture_pct") if data.get("moisture_pct") is not None else raw_packet.get("moisture_pct"),
            "ec_us_cm": data.get("ec_us_cm") if data.get("ec_us_cm") is not None else raw_packet.get("ec_us_cm"),
        }
        saved_soil = _persist_soil_reading(
            db_path=db_path,
            plot_id=plot_id,
            mode=mode,
            source=source,
            values=values,
        )

        return jsonify(
            {
                "ok": True,
                "mode": mode,
                "provenance": "SIMULATED" if is_sim else "LIVE",
                "soil": saved_soil,
            }
        )

    @flask_app.get("/api/soil/hw-status")
    def get_soil_hw_status() -> Any:
        """Return live LoRa RA-02 and USB Serial soil receiver diagnostics."""
        return jsonify(get_soil_receiver_status())

    @flask_app.post("/api/soil/manual")
    def save_soil_manual() -> Any:
        data = request.get_json(silent=True) or {}
        plot_id = int(data.get("plot_id") or 1)
        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        cfg = get_config(override_path)

        n_lvl = str(data.get("n_level") or "medium").lower()
        p_lvl = str(data.get("p_level") or "low").lower()
        k_lvl = str(data.get("k_level") or "medium").lower()

        n_val = cfg.ldd_level_to_mg_kg["n"].get(n_lvl, 15.0)
        p_val = cfg.ldd_level_to_mg_kg["p"].get(p_lvl, 5.0)
        k_val = cfg.ldd_level_to_mg_kg["k"].get(k_lvl, 60.0)
        ph_val = float(data.get("ph_value")) if data.get("ph_value") is not None else 6.0

        with get_connection(db_path) as conn:
            prev = conn.execute(
                """
                SELECT moisture_pct, ec_us_cm FROM soil_readings
                WHERE plot_id = ? AND mode = ? AND moisture_pct IS NOT NULL
                ORDER BY id DESC LIMIT 1
                """,
                (plot_id, mode),
            ).fetchone()
            moisture = prev["moisture_pct"] if prev else None
            ec_val = prev["ec_us_cm"] if prev else None

            conn.execute(
                """
                INSERT INTO soil_readings (
                    plot_id, nitrogen_mg_kg, phosphorus_mg_kg, potassium_mg_kg,
                    ph_value, moisture_pct, ec_us_cm, source, mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_testkit', ?)
                """,
                (plot_id, n_val, p_val, k_val, ph_val, moisture, ec_val, mode),
            )
            conn.commit()

        return jsonify(
            {
                "ok": True,
                "mode": mode,
                "nitrogen_mg_kg": n_val,
                "phosphorus_mg_kg": p_val,
                "potassium_mg_kg": k_val,
                "provenance": "MANUAL",
            }
        )

    def _get_15_points_summary(conn: Any, plot_id: int, mode: str) -> dict[str, Any]:
        rows = conn.execute(
            """
            SELECT point_index, nitrogen_mg_kg, phosphorus_mg_kg, potassium_mg_kg, ph_value, recorded_at
            FROM soil_readings
            WHERE plot_id = ? AND mode = ? AND point_index BETWEEN 1 AND 15
            ORDER BY id ASC
            """,
            (plot_id, mode),
        ).fetchall()
        slot_map: dict[int, dict[str, Any]] = {}
        for r in rows:
            idx = int(r["point_index"])
            slot_map[idx] = {
                "point_index": idx,
                "n": r["nitrogen_mg_kg"],
                "p": r["phosphorus_mg_kg"],
                "k": r["potassium_mg_kg"],
                "ph": r["ph_value"],
                "recorded_at": r["recorded_at"],
            }
        points = [
            slot_map.get(
                idx,
                {"point_index": idx, "n": None, "p": None, "k": None, "ph": None, "recorded_at": None},
            )
            for idx in range(1, 16)
        ]
        recorded = [p for p in points if p["n"] is not None]
        avg = None
        if recorded:
            ph_vals = [float(p["ph"]) for p in recorded if p["ph"] is not None]
            avg = {
                "n": round(sum(float(p["n"]) for p in recorded) / len(recorded), 2),
                "p": round(sum(float(p["p"]) for p in recorded) / len(recorded), 2),
                "k": round(sum(float(p["k"]) for p in recorded) / len(recorded), 2),
                "ph": round(sum(ph_vals) / len(ph_vals), 2) if ph_vals else None,
            }
        return {"mode": mode, "plot_id": plot_id, "recorded_count": len(recorded), "points": points, "average": avg}

    @flask_app.get("/api/soil/points/<int:plot_id>")
    def get_soil_points(plot_id: int) -> Any:
        mode = _normalize_mode(request.args.get("mode", "live"))
        with get_connection(db_path) as conn:
            return jsonify(_get_15_points_summary(conn, plot_id, mode))

    @flask_app.post("/api/soil/points")
    def manage_soil_points() -> Any:
        data = request.get_json(silent=True) or {}
        plot_id = int(data.get("plot_id") or 1)
        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        action = str(data.get("action") or "record").lower()

        with get_connection(db_path) as conn:
            if action == "clear_all":
                conn.execute(
                    "DELETE FROM soil_readings WHERE plot_id = ? AND mode = ? AND point_index BETWEEN 1 AND 15",
                    (plot_id, mode),
                )
                conn.commit()
                return jsonify({"ok": True, **_get_15_points_summary(conn, plot_id, mode)})

            point_index = int(data.get("point_index") or 0)
            if not (1 <= point_index <= 15):
                return jsonify({"error": "point_index must be between 1 and 15"}), 400

            if action == "clear":
                conn.execute(
                    "DELETE FROM soil_readings WHERE plot_id = ? AND mode = ? AND point_index = ?",
                    (plot_id, mode, point_index),
                )
                conn.commit()
                return jsonify({"ok": True, **_get_15_points_summary(conn, plot_id, mode)})

            n_val = data.get("n")
            p_val = data.get("p")
            k_val = data.get("k")
            ph_val = data.get("ph")
            if n_val is None or p_val is None or k_val is None:
                latest = conn.execute(
                    """
                    SELECT nitrogen_mg_kg, phosphorus_mg_kg, potassium_mg_kg, ph_value
                    FROM soil_readings
                    WHERE plot_id = ? AND mode = ? AND nitrogen_mg_kg IS NOT NULL
                    ORDER BY id DESC LIMIT 1
                    """,
                    (plot_id, mode),
                ).fetchone()
                if not latest:
                    return jsonify({"error": "ยังไม่มีค่าดินล่าสุดสำหรับบันทึกในจุดที่เลือก"}), 400
                n_val = latest["nitrogen_mg_kg"]
                p_val = latest["phosphorus_mg_kg"]
                k_val = latest["potassium_mg_kg"]
                if ph_val is None:
                    ph_val = latest["ph_value"]

            conn.execute(
                "DELETE FROM soil_readings WHERE plot_id = ? AND mode = ? AND point_index = ?",
                (plot_id, mode, point_index),
            )
            conn.execute(
                """
                INSERT INTO soil_readings (
                    plot_id, nitrogen_mg_kg, phosphorus_mg_kg, potassium_mg_kg,
                    ph_value, source, mode, point_index
                ) VALUES (?, ?, ?, ?, ?, 'point_15', ?, ?)
                """,
                (plot_id, n_val, p_val, k_val, ph_val, mode, point_index),
            )
            conn.commit()
            return jsonify({"ok": True, **_get_15_points_summary(conn, plot_id, mode)})

    @flask_app.get("/api/soil/latest/<int:plot_id>")
    def get_latest_soil(plot_id: int) -> Any:
        mode = _normalize_mode(request.args.get("mode", "live"))
        with get_connection(db_path) as conn:
            row = conn.execute(
                "SELECT * FROM soil_readings WHERE plot_id = ? AND mode = ? ORDER BY id DESC LIMIT 1",
                (plot_id, mode),
            ).fetchone()
        return jsonify({"mode": mode, "reading": dict(row) if row else None})

    @flask_app.post("/api/fermenter/telemetry")
    def post_fermenter_telemetry() -> Any:
        data = request.get_json(silent=True) or {}
        cfg = get_config(override_path)
        temps = [data.get("temp_n"), data.get("temp_p"), data.get("temp_k")]
        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        source = "simulated" if mode == "sim" else "esp32_live"

        # Fermenter microbes stay healthy when temps are within 20-45 C
        numeric_temps = [float(t) for t in temps if t is not None]
        is_ready = bool(numeric_temps) and all(
            20.0 <= t <= 45.0 for t in numeric_temps
        )

        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO fermenter_logs (
                    temp_n_c, temp_p_c, temp_k_c, temp_mixer_c,
                    mixer_tds_ppm, is_ready, source, mode
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data.get("temp_n"),
                    data.get("temp_p"),
                    data.get("temp_k"),
                    data.get("temp_mixer"),
                    data.get("mixer_tds_ppm"),
                    1 if is_ready else 0,
                    source,
                    mode,
                ),
            )
            conn.commit()

        return jsonify({"ok": True, "mode": mode, "is_ready": is_ready})

    @flask_app.get("/api/fermenter/latest")
    def get_latest_fermenter() -> Any:
        mode = _normalize_mode(request.args.get("mode", "live"))
        with get_connection(db_path) as conn:
            row = conn.execute(
                "SELECT * FROM fermenter_logs WHERE mode = ? ORDER BY id DESC LIMIT 1",
                (mode,),
            ).fetchone()
        if not row:
            return jsonify({"mode": mode, "telemetry": None})
        item = dict(row)
        item["temp_n"] = item.pop("temp_n_c")
        item["temp_p"] = item.pop("temp_p_c")
        item["temp_k"] = item.pop("temp_k_c")
        item["temp_mixer"] = item.pop("temp_mixer_c", None)
        item["is_ready"] = bool(item["is_ready"])
        return jsonify({"mode": mode, "telemetry": item})

    @flask_app.post("/api/mixer/calculate")
    def calculate_mixer_recipe() -> Any:
        data = request.get_json(silent=True) or {}
        plot_id = int(data.get("plot_id") or 1)
        crop_profile_id = data.get("crop_profile_id")
        confirmed_area = data.get("confirmed_area_m2")
        if not crop_profile_id or not confirmed_area:
            return jsonify({"error": "crop_profile_id and confirmed_area_m2 are required"}), 400

        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        cfg = get_config(override_path)
        soil_type = str(data.get("soil_type") or "loam")
        bulk_density = cfg.bulk_density_map.get(soil_type, 1.35)

        with get_connection(db_path) as conn:
            profile = conn.execute(
                "SELECT * FROM crop_profiles WHERE id = ?",
                (int(crop_profile_id),),
            ).fetchone()
            if not profile:
                return jsonify({"error": "Crop profile not found"}), 404

            # Prefer 15-point averaged readings if recorded; otherwise fall back to latest reading
            points_summary = _get_15_points_summary(conn, plot_id, mode)
            if points_summary["average"] is not None:
                avg = points_summary["average"]
                n_mg = float(avg["n"])
                p_mg = float(avg["p"])
                k_mg = float(avg["k"])
                ph_val = float(avg["ph"]) if avg["ph"] is not None else None
                latest_moist = conn.execute(
                    """
                    SELECT moisture_pct FROM soil_readings
                    WHERE plot_id = ? AND mode = ? AND moisture_pct IS NOT NULL
                    ORDER BY id DESC LIMIT 1
                    """,
                    (plot_id, mode),
                ).fetchone()
                moist_val = float(latest_moist["moisture_pct"]) if latest_moist else None
            else:
                soil_row = conn.execute(
                    """
                    SELECT * FROM soil_readings
                    WHERE plot_id = ? AND mode = ? AND nitrogen_mg_kg IS NOT NULL
                    ORDER BY id DESC LIMIT 1
                    """,
                    (plot_id, mode),
                ).fetchone()

                if not soil_row:
                    return (
                        jsonify(
                            {
                                "error": (
                                    f"ยังไม่มีผลตรวจค่า N, P, K ในโหมด {mode.upper()} "
                                    "กรุณาวัดค่าดินหรือบันทึกจุดตรวจดินก่อนคำนวณสูตร"
                                )
                            }
                        ),
                        400,
                    )

                n_mg = float(soil_row["nitrogen_mg_kg"])
                p_mg = float(soil_row["phosphorus_mg_kg"])
                k_mg = float(soil_row["potassium_mg_kg"])
                ph_val = float(soil_row["ph_value"]) if soil_row["ph_value"] is not None else None
                moist_val = float(soil_row["moisture_pct"]) if soil_row["moisture_pct"] is not None else None
            exg_val = float(data["exg_green_pct"]) if data.get("exg_green_pct") is not None else None

            deficit_res = calculate_nutrient_deficit(
                measured_n_mg_kg=n_mg,
                measured_p_mg_kg=p_mg,
                measured_k_mg_kg=k_mg,
                ph_value=ph_val,
                bulk_density_g_cm3=bulk_density,
                root_depth_m=float(profile["root_depth_m"]),
                area_m2=float(confirmed_area),
                target_n_g_m2=float(profile["target_n_g_m2"]),
                target_p2o5_g_m2=float(profile["target_p2o5_g_m2"]),
                target_k2o_g_m2=float(profile["target_k2o_g_m2"]),
                ph_min=float(profile["ph_min"]),
                ph_max=float(profile["ph_max"]),
                n_avail_factor=cfg.n_avail_factor,
                p_avail_factor=cfg.p_avail_factor,
                k_avail_factor=cfg.k_avail_factor,
            )

            rf_res = predict_rf_nutrient_deficit(
                crop_profile_id=int(crop_profile_id),
                root_depth_m=float(profile["root_depth_m"]),
                bulk_density_g_cm3=bulk_density,
                measured_n_mg_kg=n_mg,
                measured_p_mg_kg=p_mg,
                measured_k_mg_kg=k_mg,
                ph_value=ph_val,
                moisture_pct=moist_val,
                exg_green_pct=exg_val,
                area_m2=float(confirmed_area),
                c_bio_n=cfg.c_bio_n,
                c_bio_p2o5=cfg.c_bio_p2o5,
                c_bio_k2o=cfg.c_bio_k2o,
                demo_bio_ml=cfg.demo_bio_ml,
                demo_batch_ml=cfg.demo_batch_ml,
            )

            mixing_res = calculate_mixing_plan(
                deficits_g=deficit_res["deficits_g"],
                c_bio_n=cfg.c_bio_n,
                c_bio_p2o5=cfg.c_bio_p2o5,
                c_bio_k2o=cfg.c_bio_k2o,
                q_pump_n=cfg.q_pump_n,
                q_pump_p=cfg.q_pump_p,
                q_pump_k=cfg.q_pump_k,
                q_pump_water=cfg.q_pump_water,
                demo_batch_ml=cfg.demo_batch_ml,
                demo_bio_ml=cfg.demo_bio_ml,
                min_runtime_s=cfg.min_pump_runtime_s,
            )

            initial_status = "ready" if mixing_res["all_sufficient"] else "pending"
            cursor = conn.execute(
                """
                INSERT INTO mixing_jobs (
                    plot_id, delta_n_g, delta_p_g, delta_k_g,
                    vol_n_ml, vol_p_ml, vol_k_ml, vol_water_ml,
                    pump_n_sec, pump_p_sec, pump_k_sec, pump_water_sec,
                    status, mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    plot_id,
                    deficit_res["deficits_g"]["n"],
                    deficit_res["deficits_g"]["p2o5"],
                    deficit_res["deficits_g"]["k2o"],
                    mixing_res["demo_volumes_ml"]["n"],
                    mixing_res["demo_volumes_ml"]["p"],
                    mixing_res["demo_volumes_ml"]["k"],
                    mixing_res["demo_volumes_ml"]["water"],
                    mixing_res["pump_seconds"]["n"],
                    mixing_res["pump_seconds"]["p"],
                    mixing_res["pump_seconds"]["k"],
                    mixing_res["pump_seconds"]["water"],
                    initial_status,
                    mode,
                ),
            )
            conn.commit()
            job_id = cursor.lastrowid

        return jsonify(
            {
                "job_id": job_id,
                "mode": mode,
                "status": initial_status,
                "deficits_g": deficit_res["deficits_g"],
                "demo_volumes_ml": mixing_res["demo_volumes_ml"],
                "pump_seconds": mixing_res["pump_seconds"],
                "ph_warning": deficit_res["ph_warning"],
                "all_sufficient": mixing_res["all_sufficient"],
                "rf_prediction": rf_res,
            }
        )

    @flask_app.get("/api/ml/metrics")
    def get_ml_metrics() -> Any:
        bundle = get_or_train_rf_model()
        return jsonify(
            {
                "model_name": "RandomForestRegressor (scikit-learn)",
                "n_estimators": bundle.n_estimators,
                "training_samples": bundle.sample_count,
                "r2_score": bundle.r2_score_val,
                "mae_g_m2": bundle.mae_g_m2,
                "feature_importances_pct": bundle.feature_importances_pct,
                "feature_labels_th": FEATURE_LABELS_TH,
            }
        )

    @flask_app.get("/api/mixer/command")
    def get_mixer_command() -> Any:
        # Real ESP32 hardware always polls mode='live' so simulated jobs never fire real pumps
        mode = _normalize_mode(request.args.get("mode", "live"))
        is_peek = str(request.args.get("peek", "")).lower() in {"1", "true", "yes"}
        with get_connection(db_path) as conn:
            row = conn.execute(
                """
                SELECT * FROM mixing_jobs
                WHERE mode = ? AND status IN ('pending', 'diluting')
                ORDER BY id DESC LIMIT 1
                """,
                (mode,),
            ).fetchone()
            if not row:
                return jsonify({"has_command": False, "mode": mode, "job_id": None})
            if not is_peek:
                # Transition immediately to 'mixing' so repeated polling never re-runs the same command
                conn.execute("UPDATE mixing_jobs SET status = 'mixing' WHERE id = ?", (row["id"],))
                conn.commit()

        return jsonify(
            {
                "has_command": True,
                "mode": mode,
                "job_id": row["id"],
                "status": "mixing",
                "pump_n_ms": int(round(row["pump_n_sec"] * 1000)),
                "pump_p_ms": int(round(row["pump_p_sec"] * 1000)),
                "pump_k_ms": int(round(row["pump_k_sec"] * 1000)),
                "pump_water_ms": int(round(row["pump_water_sec"] * 1000)),
            }
        )

    @flask_app.post("/api/mixer/dispense-live")
    def dispense_mixer_live() -> Any:
        """Directly drive Raspberry Pi GPIO 17, 27, 22, 23 (inherited from Back/) for LIVE jobs."""
        data = request.get_json(silent=True) or {}
        sync_for_test = bool(data.get("_sync_for_test", False))
        with get_connection(db_path) as conn:
            row = conn.execute(
                """
                SELECT * FROM mixing_jobs
                WHERE mode = 'live' AND status IN ('pending', 'diluting')
                ORDER BY id DESC LIMIT 1
                """
            ).fetchone()
            if not row:
                return jsonify({"ok": False, "error": "ยังไม่มีคำสั่งผสมปุ๋ยที่รอจ่ายในโหมด LIVE"}), 400
            job_id = int(row["id"])
            durations = {
                "n": float(row["pump_n_sec"]),
                "p": float(row["pump_p_sec"]),
                "k": float(row["pump_k_sec"]),
                "water": float(row["pump_water_sec"]),
            }
            conn.execute("UPDATE mixing_jobs SET status = 'mixing' WHERE id = ?", (job_id,))
            conn.commit()

        started = start_sequential_dispense(job_id, durations, sync_for_test=sync_for_test)
        if not started:
            return jsonify({"ok": False, "error": "ปั๊มกำลังทำงานอยู่ กรุณารอสักครู่หรือกดหยุดฉุกเฉิน"}), 409

        return jsonify(
            {
                "ok": True,
                "job_id": job_id,
                "status": "mixing",
                "gpio_pins": {"n": 17, "p": 27, "k": 22, "water": 23},
                "durations_sec": durations,
                "hw_status": get_pump_hardware_status(),
            }
        )

    @flask_app.post("/api/mixer/stop-live")
    def stop_mixer_live() -> Any:
        """Emergency stop all 4 Raspberry Pi GPIO relays immediately."""
        force_stop_all_pumps()
        return jsonify({"ok": True, "hw_status": get_pump_hardware_status()})

    @flask_app.get("/api/mixer/hw-status")
    def get_mixer_hw_status() -> Any:
        """Return current Raspberry Pi GPIO pump and LoRa/USB soil receiver status."""
        status = get_pump_hardware_status()
        status["soil_receiver"] = get_soil_receiver_status()
        return jsonify(status)

    @flask_app.post("/api/mixer/status")
    def update_mixer_status() -> Any:
        data = request.get_json(silent=True) or {}
        job_id = data.get("job_id")
        status = str(data.get("status") or "ready")
        final_tds = data.get("final_tds_ppm")
        if not job_id:
            return jsonify({"error": "job_id is required"}), 400

        with get_connection(db_path) as conn:
            conn.execute(
                "UPDATE mixing_jobs SET status = ?, final_tds_ppm = ? WHERE id = ?",
                (status, final_tds, int(job_id)),
            )
            conn.commit()
        return jsonify({"ok": True, "status": status})

    @flask_app.post("/api/mixer/check-ec")
    def check_ec_safety() -> Any:
        data = request.get_json(silent=True) or {}
        job_id = int(data.get("job_id") or 1)
        mode = _normalize_mode(data.get("mode"), data.get("simulated"))
        is_sim = mode == "sim"
        cfg = get_config(override_path)

        with get_connection(db_path) as conn:
            job = conn.execute(
                "SELECT * FROM mixing_jobs WHERE id = ? AND mode = ?",
                (job_id, mode),
            ).fetchone()
            safe_ec = 1000.0
            current_vol = cfg.demo_batch_ml

            if job:
                plot = conn.execute(
                    "SELECT crop_profile_id FROM plots WHERE id = ?",
                    (job["plot_id"],),
                ).fetchone()
                if plot:
                    prof = conn.execute(
                        "SELECT safe_ec_max_ppm FROM crop_profiles WHERE id = ?",
                        (plot["crop_profile_id"],),
                    ).fetchone()
                    if prof:
                        safe_ec = float(prof["safe_ec_max_ppm"])
                current_vol = float(
                    job["vol_n_ml"] + job["vol_p_ml"] + job["vol_k_ml"] + job["vol_water_ml"]
                ) or cfg.demo_batch_ml

            latest_ferm = conn.execute(
                """
                SELECT mixer_tds_ppm FROM fermenter_logs
                WHERE mode = ? AND mixer_tds_ppm IS NOT NULL
                ORDER BY id DESC LIMIT 1
                """,
                (mode,),
            ).fetchone()

            if data.get("measured_tds_ppm") is not None:
                measured_tds = float(data["measured_tds_ppm"])
            elif job and job["final_tds_ppm"] is not None:
                measured_tds = float(job["final_tds_ppm"])
            elif latest_ferm and latest_ferm["mixer_tds_ppm"] is not None:
                measured_tds = float(latest_ferm["mixer_tds_ppm"])
            elif is_sim:
                measured_tds = 780.0
            else:
                return jsonify({"error": "No LIVE TDS/EC reading available from ESP32 #2"}), 400

            result = calculate_ec_dilution(
                current_ec_ppm=measured_tds,
                safe_ec_ppm=safe_ec,
                current_vol_ml=current_vol,
                q_water_ml_s=cfg.q_pump_water,
                water_ec_ppm=cfg.water_tds_ppm,
            )

            # Tank overflow guard (aligned with mixing_tank_max_ml, e.g. 2,000 ml)
            if result["needs_dilution"] and (current_vol + result["add_water_ml"] > cfg.mixing_tank_max_ml):
                result["tank_overflow_warning"] = (
                    f"ปริมาตรรวม ({current_vol + result['add_water_ml']:.0f} ml) เกินความจุถังผสม {cfg.mixing_tank_max_ml:.0f} ml "
                    "กรุณาแบ่งน้ำปุ๋ยออกครึ่งหนึ่งก่อนเติมน้ำเจือจาง"
                )

            new_status = "diluting" if result["needs_dilution"] else "ready"
            if job:
                if result["needs_dilution"]:
                    # Queue ONLY clean water dilution runtime and accumulate vol_water_ml
                    conn.execute(
                        """
                        UPDATE mixing_jobs
                        SET status = ?, final_tds_ppm = ?,
                            vol_water_ml = vol_water_ml + ?,
                            pump_n_sec = 0.0, pump_p_sec = 0.0, pump_k_sec = 0.0,
                            pump_water_sec = ?
                        WHERE id = ?
                        """,
                        (new_status, measured_tds, result["add_water_ml"], result["add_water_sec"], job_id),
                    )
                else:
                    conn.execute(
                        "UPDATE mixing_jobs SET status = ?, final_tds_ppm = ? WHERE id = ?",
                        (new_status, measured_tds, job_id),
                    )
                conn.commit()

        result["mode"] = mode
        result["provenance"] = "SIMULATED" if is_sim else "LIVE"
        return jsonify(result)

    @flask_app.post("/api/drone/mission")
    def trigger_drone_mission() -> Any:
        data = request.get_json(silent=True) or {}
        mode = str(data.get("mode") or "survey_photo")
        execution_mode = str(data.get("execution_mode") or "SIMULATED").upper()
        waypoints = data.get("waypoints_cm") or []
        job_id = data.get("job_id")

        if execution_mode == "LIVE":
            return (
                jsonify(
                    {
                        "ok": False,
                        "execution_mode": "LIVE",
                        "status": "not_configured",
                        "message": "ยังไม่ได้เชื่อมต่อ Python SDK ของโดรนจริง (รอสคริปต์รุ่นโดรนจากคนที่ 3)",
                    }
                ),
                501,
            )

        if mode == "spray_fertilizer" and job_id:
            with get_connection(db_path) as conn:
                conn.execute("UPDATE mixing_jobs SET status = 'sprayed' WHERE id = ?", (int(job_id),))
                conn.commit()

        return jsonify(
            {
                "ok": True,
                "execution_mode": "SIMULATED",
                "mode": mode,
                "status": "completed",
                "waypoint_count": len(waypoints),
                "message": f"จำลองภารกิจ {mode} จำนวน {len(waypoints)} จุดเสร็จสิ้น",
            }
        )

    @flask_app.post("/api/drone/analyze-image")
    def analyze_drone_image() -> Any:
        if "image" not in request.files:
            return jsonify({"error": "No image file provided"}), 400
        image_file = request.files["image"]
        image_bytes = image_file.read()
        if not image_bytes:
            return jsonify({"error": "Empty image file"}), 400

        cfg = get_config(override_path)
        plot_id = str(request.form.get("plot_id") or "1")
        op_mode = _normalize_mode(request.form.get("mode"))
        filename = f"mask_{op_mode}_{plot_id}_{int(time.time() * 1000)}.png"
        mask_path = Path(upload_dir) / filename

        try:
            green_pct = analyze_green_coverage(
                image_bytes=image_bytes,
                output_mask_path=mask_path,
                threshold=cfg.exg_green_threshold,
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        return jsonify(
            {
                "mode": op_mode,
                "green_coverage_pct": green_pct,
                "mask_image_url": f"/static/uploads/{filename}",
            }
        )

    @flask_app.route("/api/config", methods=["GET", "POST"])
    def handle_config() -> Any:
        if request.method == "GET":
            return jsonify(config_to_dict(get_config(override_path)))

        data = request.get_json(silent=True) or {}
        try:
            updated = update_config(data, override_path=override_path)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(config_to_dict(updated))

    return flask_app


if __name__ == "__main__":
    app = create_app(start_hw_receivers=True)
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
