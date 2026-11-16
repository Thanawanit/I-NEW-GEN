"""Automated unit and Flask API integration tests for Smart Bio-Fert Backend."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

APP_ROOT = Path(__file__).resolve().parents[1]
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from app import create_app  # noqa: E402
from calculations import (  # noqa: E402
    analyze_green_coverage,
    calculate_ec_dilution,
    calculate_mixing_plan,
    calculate_nutrient_deficit,
    project_latlng_to_waypoints,
)


class TestCalculations(unittest.TestCase):
    """Verify geospatial scaling, ExG image analysis, and fertilizer/EC formulas."""

    def test_project_latlng_to_waypoints_fits_tabletop_bounds(self) -> None:
        square_geojson = {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [97.92600, 18.83900],
                        [97.92695, 18.83900],
                        [97.92695, 18.83990],
                        [97.92600, 18.83990],
                        [97.92600, 18.83900],
                    ]
                ],
            },
        }
        waypoints = project_latlng_to_waypoints(
            square_geojson, table_w_cm=100.0, table_h_cm=80.0, min_move_cm=20.0
        )
        self.assertEqual(len(waypoints), 4)
        for wp in waypoints:
            self.assertLessEqual(abs(wp["dx"]), 100.01)
            self.assertLessEqual(abs(wp["dy"]), 80.01)
            self.assertGreaterEqual(wp["distance_cm"], 20.0)

    def test_analyze_green_coverage_half_green_image(self) -> None:
        img = np.zeros((100, 100, 3), dtype=np.uint8)
        img[:, :50] = (20, 200, 20)  # Bright green half (BGR)
        img[:, 50:] = (40, 50, 90)   # Brown soil half (BGR)
        ok, encoded = cv2.imencode(".png", img)
        self.assertTrue(ok)

        with tempfile.TemporaryDirectory() as tmp:
            mask_path = Path(tmp) / "mask.png"
            pct = analyze_green_coverage(encoded.tobytes(), mask_path, threshold=20)
            self.assertAlmostEqual(pct, 50.0, delta=0.5)
            self.assertTrue(mask_path.exists())

    def test_calculate_nutrient_deficit_converts_oxides_and_warns_acidic_ph(self) -> None:
        res = calculate_nutrient_deficit(
            measured_n_mg_kg=12.0,
            measured_p_mg_kg=5.0,
            measured_k_mg_kg=30.0,
            ph_value=4.8,
            bulk_density_g_cm3=1.35,
            root_depth_m=0.25,
            area_m2=100.0,
            target_n_g_m2=6.0,
            target_p2o5_g_m2=1.5,
            target_k2o_g_m2=2.5,
            ph_min=5.5,
            ph_max=7.0,
        )
        # M_soil_n = 12 * 1.35 * 0.25 * 0.30 = 1.215 -> deficit = (6.0 - 1.215) * 100 = 478.5 g
        self.assertAlmostEqual(res["deficits_g"]["n"], 478.5, places=2)
        # M_soil_p2o5 = 5 * 1.35 * 0.25 * 2.29 * 0.20 = 0.772875 < 1.5 -> positive P deficit
        self.assertGreater(res["deficits_g"]["p2o5"], 0.0)
        # M_soil_k2o = 30 * 1.35 * 0.25 * 1.20 * 0.15 = 1.8225 < 2.5 -> positive K deficit
        self.assertGreater(res["deficits_g"]["k2o"], 0.0)
        self.assertIsNotNone(res["ph_warning"])
        self.assertIn("กรด", res["ph_warning"])

    def test_calculate_mixing_plan_zero_deficit_and_min_runtime_guard(self) -> None:
        zero_plan = calculate_mixing_plan(
            {"n": 0.0, "p2o5": 0.0, "k2o": 0.0},
            c_bio_n=2.0,
            c_bio_p2o5=1.0,
            c_bio_k2o=2.0,
            q_pump_n=5.0,
            q_pump_p=5.0,
            q_pump_k=5.0,
            q_pump_water=5.0,
        )
        self.assertTrue(zero_plan["all_sufficient"])
        self.assertEqual(zero_plan["pump_seconds"]["n"], 0.0)

        # Tiny K trace (< 1.5s) should be suppressed to 0 while N stays proportional
        guarded = calculate_mixing_plan(
            {"n": 200.0, "p2o5": 100.0, "k2o": 2.0},
            c_bio_n=2.0,
            c_bio_p2o5=1.0,
            c_bio_k2o=2.0,
            q_pump_n=5.0,
            q_pump_p=5.0,
            q_pump_k=5.0,
            q_pump_water=5.0,
            demo_batch_ml=200.0,
            demo_bio_ml=80.0,
            min_runtime_s=1.5,
        )
        self.assertEqual(guarded["pump_seconds"]["k"], 0.0)
        self.assertGreaterEqual(guarded["pump_seconds"]["n"], 1.5)
        total_ml = sum(guarded["demo_volumes_ml"].values())
        self.assertAlmostEqual(total_ml, 200.0, places=1)

    def test_calculate_ec_dilution_over_and_within_limit(self) -> None:
        safe = calculate_ec_dilution(800.0, 1000.0, 200.0, 5.0)
        self.assertFalse(safe["needs_dilution"])
        self.assertEqual(safe["add_water_ml"], 0.0)

        # V=200, EC=1500, safe=800, water=150 -> 200 * (1500-800)/(800-150) = 215.38 ml
        high = calculate_ec_dilution(1500.0, 800.0, 200.0, 5.0, water_ec_ppm=150.0)
        self.assertTrue(high["needs_dilution"])
        self.assertAlmostEqual(high["add_water_ml"], 215.38, places=2)
        self.assertAlmostEqual(high["add_water_sec"], 43.08, places=2)


class TestFlaskAPI(unittest.TestCase):
    """End-to-end integration tests using Flask test_client and isolated SQLite DB."""

    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        tmp_path = Path(self.tmp_dir.name)
        self.app = create_app(
            db_path=tmp_path / "test.db",
            override_path=tmp_path / "overrides.json",
            upload_dir=tmp_path / "uploads",
        )
        self.client = self.app.test_client()

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def test_end_to_end_workflow_endpoints(self) -> None:
        # 1. Crops seeded
        crops_resp = self.client.get("/api/crops")
        self.assertEqual(crops_resp.status_code, 200)
        crops = crops_resp.get_json()["crops"]
        self.assertEqual(len(crops), 9)

        # 2. Save plot & compute tabletop waypoints
        plot_resp = self.client.post(
            "/api/plots",
            json={
                "plot_name": "แปลงทดสอบ",
                "polygon_geojson": {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [97.9260, 18.8390],
                                [97.9265, 18.8390],
                                [97.9265, 18.8395],
                                [97.9260, 18.8395],
                                [97.9260, 18.8390],
                            ]
                        ],
                    },
                },
                "calculated_area_m2": 2500.0,
                "confirmed_area_m2": 2400.0,
                "soil_type": "loam",
                "crop_profile_id": crops[1]["id"],
            },
        )
        self.assertEqual(plot_resp.status_code, 201)
        plot_id = plot_resp.get_json()["plot_id"]
        self.assertTrue(len(plot_resp.get_json()["waypoints_cm"]) > 0)

        # 3. Simulated ESP32 soil + Manual LDD input in SIM mode
        sim_soil = self.client.post(
            "/api/soil/update",
            json={"plot_id": plot_id, "mode": "sim", "moisture_pct": 40.0, "ec_us_cm": 320, "simulated": True},
        )
        self.assertEqual(sim_soil.status_code, 200)
        self.assertEqual(sim_soil.get_json()["provenance"], "SIMULATED")

        # Verify SIM data NEVER leaks into LIVE queries
        live_soil_check = self.client.get(f"/api/soil/latest/{plot_id}?mode=live")
        self.assertIsNone(live_soil_check.get_json()["reading"])

        man_soil = self.client.post(
            "/api/soil/manual",
            json={"plot_id": plot_id, "mode": "sim", "n_level": "low", "p_level": "low", "k_level": "low", "ph_value": 6.0},
        )
        self.assertEqual(man_soil.status_code, 200)
        self.assertEqual(man_soil.get_json()["provenance"], "MANUAL")

        # 4. Fermenter telemetry -> Calculate -> Command -> EC check (isolated to SIM)
        ferm_resp = self.client.post(
            "/api/fermenter/telemetry",
            json={"mode": "sim", "temp_n": 31.0, "temp_p": 30.5, "temp_k": 31.2, "mixer_tds_ppm": 850, "simulated": True},
        )
        self.assertEqual(ferm_resp.status_code, 200)
        self.assertTrue(ferm_resp.get_json()["is_ready"])

        # LIVE calculation must reject when only SIM soil exists
        live_calc_fail = self.client.post(
            "/api/mixer/calculate",
            json={
                "plot_id": plot_id,
                "mode": "live",
                "crop_profile_id": crops[1]["id"],
                "confirmed_area_m2": 2400.0,
                "soil_type": "loam",
            },
        )
        self.assertEqual(live_calc_fail.status_code, 400)

        calc_resp = self.client.post(
            "/api/mixer/calculate",
            json={
                "plot_id": plot_id,
                "mode": "sim",
                "crop_profile_id": crops[1]["id"],
                "confirmed_area_m2": 2400.0,
                "soil_type": "loam",
            },
        )
        self.assertEqual(calc_resp.status_code, 200)
        job_id = calc_resp.get_json()["job_id"]

        # Real hardware ESP32 polling mode=live must NOT pick up SIM jobs
        live_cmd_resp = self.client.get("/api/mixer/command?mode=live")
        self.assertFalse(live_cmd_resp.get_json()["has_command"])

        sim_cmd_resp = self.client.get("/api/mixer/command?mode=sim")
        self.assertEqual(sim_cmd_resp.status_code, 200)
        self.assertTrue(sim_cmd_resp.get_json()["has_command"])
        self.assertEqual(sim_cmd_resp.get_json()["job_id"], job_id)

        ec_resp = self.client.post("/api/mixer/check-ec", json={"job_id": job_id, "mode": "sim", "simulated": True})
        self.assertEqual(ec_resp.status_code, 200)
        self.assertFalse(ec_resp.get_json()["needs_dilution"])

        # Over-limit EC must queue ONLY clean water dilution (pump_n/p/k_ms == 0)
        dil_resp = self.client.post(
            "/api/mixer/check-ec",
            json={"job_id": job_id, "mode": "sim", "simulated": True, "measured_tds_ppm": 1500.0},
        )
        self.assertEqual(dil_resp.status_code, 200)
        self.assertTrue(dil_resp.get_json()["needs_dilution"])

        dil_cmd = self.client.get("/api/mixer/command?mode=sim").get_json()
        self.assertTrue(dil_cmd["has_command"])
        self.assertEqual(dil_cmd["pump_n_ms"], 0)
        self.assertEqual(dil_cmd["pump_p_ms"], 0)
        self.assertEqual(dil_cmd["pump_k_ms"], 0)
        self.assertGreater(dil_cmd["pump_water_ms"], 0)

        # 5. Drone LIVE should report 501 (not configured), SIMULATED should succeed
        live_drone = self.client.post("/api/drone/mission", json={"mode": "survey_photo", "execution_mode": "LIVE"})
        self.assertEqual(live_drone.status_code, 501)
        sim_drone = self.client.post("/api/drone/mission", json={"mode": "survey_photo", "execution_mode": "SIMULATED"})
        self.assertEqual(sim_drone.status_code, 200)


if __name__ == "__main__":
    unittest.main()
