"""Random Forest Regressor for Site-Specific Bio-Fertilizer Deficit Prediction.

Implements the Machine Learning component referenced in the project specification
(Breiman, 2001; Pedregosa et al., 2011; Department of Agriculture, 2022).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from calculations import K_TO_K2O_FACTOR, P_TO_P2O5_FACTOR
from database import SEED_CROP_PROFILES

FEATURE_NAMES: list[str] = [
    "crop_profile_id",
    "root_depth_m",
    "bulk_density_g_cm3",
    "soil_n_mg_kg",
    "soil_p_mg_kg",
    "soil_k_mg_kg",
    "ph_value",
    "moisture_pct",
    "exg_green_pct",
]

FEATURE_LABELS_TH: dict[str, str] = {
    "crop_profile_id": "ชนิดพืชและระยะเติบโต (Crop & Stage)",
    "root_depth_m": "ความลึกรากพืช (Root Depth)",
    "bulk_density_g_cm3": "ความหนาแน่นมวลดิน (Bulk Density)",
    "soil_n_mg_kg": "ไนโตรเจนในดิน (Soil N)",
    "soil_p_mg_kg": "ฟอสฟอรัสในดิน (Soil P)",
    "soil_k_mg_kg": "โพแทสเซียมในดิน (Soil K)",
    "ph_value": "ความเป็นกรด-ด่าง (Soil pH)",
    "moisture_pct": "ความชื้นในดิน (Soil Moisture %)",
    "exg_green_pct": "ดัชนีความเขียวภาพโดรน (Drone ExG %)",
}


@dataclass
class RFModelBundle:
    """Container for trained RandomForestRegressor and evaluation metadata."""

    model: RandomForestRegressor
    r2_score_val: float
    mae_g_m2: float
    sample_count: int
    n_estimators: int
    feature_importances_pct: dict[str, float]


_CACHED_BUNDLE: RFModelBundle | None = None


def _compute_agronomic_nonlinear_targets(
    profile_id: int,
    root_depth_m: float,
    target_n: float,
    target_p2o5: float,
    target_k2o: float,
    ph_min: float,
    ph_max: float,
    bulk_density: float,
    soil_n: float,
    soil_p: float,
    soil_k: float,
    ph_val: float,
    moisture_pct: float,
    exg_pct: float,
) -> tuple[float, float, float]:
    """Compute non-linear agronomic nutrient deficits (g/m^2) for training data generation.

    Captures three real-world interactions beyond linear mass balance:
    1. Soil pH lock-up (acidic Al/Fe fixation or alkaline Ca fixation reduces P & N uptake).
    2. Soil moisture diffusion efficiency (optimal uptake at 35-65% moisture).
    3. Canopy ExG foliar feedback (low green index signals chlorophyll stress -> higher N need).
    """
    # 1. pH availability modifier (0.60 to 1.00)
    if ph_val < ph_min:
        ph_penalty = max(0.60, 1.0 - 0.18 * (ph_min - ph_val))
    elif ph_val > ph_max:
        ph_penalty = max(0.65, 1.0 - 0.15 * (ph_val - ph_max))
    else:
        ph_penalty = 1.0

    # 2. Moisture diffusion modifier (0.70 to 1.05)
    if moisture_pct < 25.0:
        moisture_factor = max(0.70, 0.70 + 0.30 * (moisture_pct / 25.0))
    elif moisture_pct > 80.0:
        moisture_factor = max(0.75, 1.0 - 0.01 * (moisture_pct - 80.0))
    else:
        moisture_factor = 1.0

    # 3. Canopy ExG foliar demand modifier for Nitrogen (0.92 to 1.12)
    expected_exg = 35.0 if (profile_id % 3 == 1) else (60.0 if (profile_id % 3 == 2) else 55.0)
    exg_gap = expected_exg - exg_pct
    canopy_n_modifier = float(np.clip(1.0 + 0.0025 * exg_gap, 0.92, 1.12))

    soil_mass_factor = bulk_density * root_depth_m
    eff_n_avail = 0.30 * ph_penalty * moisture_factor
    eff_p_avail = 0.20 * (ph_penalty ** 1.3) * moisture_factor
    eff_k_avail = 0.15 * ph_penalty * moisture_factor

    m_soil_n = soil_n * soil_mass_factor * eff_n_avail
    m_soil_p2o5 = soil_p * soil_mass_factor * P_TO_P2O5_FACTOR * eff_p_avail
    m_soil_k2o = soil_k * soil_mass_factor * K_TO_K2O_FACTOR * eff_k_avail

    adj_target_n = target_n * canopy_n_modifier
    def_n_m2 = max(0.0, adj_target_n - m_soil_n)
    def_p_m2 = max(0.0, target_p2o5 - m_soil_p2o5)
    def_k_m2 = max(0.0, target_k2o - m_soil_k2o)
    return def_n_m2, def_p_m2, def_k_m2


def get_or_train_rf_model() -> RFModelBundle:
    """Build or return cached RandomForestRegressor trained on DOA/ARDA agronomic domain samples."""
    global _CACHED_BUNDLE
    if _CACHED_BUNDLE is not None:
        return _CACHED_BUNDLE

    rng = np.random.default_rng(42)
    samples_per_profile = 200
    x_rows: list[list[float]] = []
    y_rows: list[list[float]] = []

    bulk_choices = [1.25, 1.35, 1.45]

    for idx, prof in enumerate(SEED_CROP_PROFILES, start=1):
        _, _, _, root_depth, t_n, t_p2o5, t_k2o, ph_min, ph_max, _ = prof
        for _ in range(samples_per_profile):
            bd = float(rng.choice(bulk_choices))
            s_n = float(rng.uniform(2.0, 45.0))
            s_p = float(rng.uniform(2.0, 50.0))
            s_k = float(rng.uniform(15.0, 130.0))
            ph = float(rng.uniform(4.3, 7.8))
            moist = float(rng.uniform(15.0, 85.0))
            exg = float(rng.uniform(15.0, 85.0))

            dn, dp, dk = _compute_agronomic_nonlinear_targets(
                profile_id=idx,
                root_depth_m=float(root_depth),
                target_n=float(t_n),
                target_p2o5=float(t_p2o5),
                target_k2o=float(t_k2o),
                ph_min=float(ph_min),
                ph_max=float(ph_max),
                bulk_density=bd,
                soil_n=s_n,
                soil_p=s_p,
                soil_k=s_k,
                ph_val=ph,
                moisture_pct=moist,
                exg_pct=exg,
            )
            x_rows.append([float(idx), float(root_depth), bd, s_n, s_p, s_k, ph, moist, exg])
            y_rows.append([dn, dp, dk])

    x_arr = np.array(x_rows, dtype=np.float64)
    y_arr = np.array(y_rows, dtype=np.float64)

    x_train, x_test, y_train, y_test = train_test_split(
        x_arr, y_arr, test_size=0.20, random_state=42
    )

    rf = RandomForestRegressor(
        n_estimators=120,
        max_depth=12,
        min_samples_leaf=2,
        random_state=42,
        n_jobs=1,
    )
    rf.fit(x_train, y_train)

    y_pred = rf.predict(x_test)
    r2_val = float(r2_score(y_test, y_pred))
    mae_val = float(mean_absolute_error(y_test, y_pred))

    raw_imp = rf.feature_importances_
    imp_pct = {
        name: round(float(val) * 100.0, 2)
        for name, val in zip(FEATURE_NAMES, raw_imp)
    }

    _CACHED_BUNDLE = RFModelBundle(
        model=rf,
        r2_score_val=round(r2_val, 4),
        mae_g_m2=round(mae_val, 4),
        sample_count=int(len(x_rows)),
        n_estimators=120,
        feature_importances_pct=imp_pct,
    )
    return _CACHED_BUNDLE


def predict_rf_nutrient_deficit(
    crop_profile_id: int,
    root_depth_m: float,
    bulk_density_g_cm3: float,
    measured_n_mg_kg: float,
    measured_p_mg_kg: float,
    measured_k_mg_kg: float,
    ph_value: float | None,
    moisture_pct: float | None,
    exg_green_pct: float | None,
    area_m2: float,
    c_bio_n: float = 2.0,
    c_bio_p2o5: float = 2.0,
    c_bio_k2o: float = 2.0,
    demo_bio_ml: float = 80.0,
    demo_batch_ml: float = 200.0,
) -> dict[str, Any]:
    """Run trained RandomForestRegressor on field inputs and return deficits + demo volumes."""
    bundle = get_or_train_rf_model()

    ph_in = float(ph_value) if ph_value is not None else 6.0
    moist_in = float(moisture_pct) if moisture_pct is not None else 45.0
    exg_in = float(exg_green_pct) if exg_green_pct is not None else 50.0

    features = np.array(
        [
            [
                float(crop_profile_id),
                float(root_depth_m),
                float(bulk_density_g_cm3),
                float(measured_n_mg_kg),
                float(measured_p_mg_kg),
                float(measured_k_mg_kg),
                ph_in,
                moist_in,
                exg_in,
            ]
        ],
        dtype=np.float64,
    )

    pred_m2 = bundle.model.predict(features)[0]
    rf_n_g = max(0.0, float(pred_m2[0]) * area_m2)
    rf_p2o5_g = max(0.0, float(pred_m2[1]) * area_m2)
    rf_k2o_g = max(0.0, float(pred_m2[2]) * area_m2)

    v_real_n = (rf_n_g * 1000.0) / c_bio_n if c_bio_n > 0 else 0.0
    v_real_p = (rf_p2o5_g * 1000.0) / c_bio_p2o5 if c_bio_p2o5 > 0 else 0.0
    v_real_k = (rf_k2o_g * 1000.0) / c_bio_k2o if c_bio_k2o > 0 else 0.0
    total_real = v_real_n + v_real_p + v_real_k

    if total_real > 0:
        vol_n = demo_bio_ml * (v_real_n / total_real)
        vol_p = demo_bio_ml * (v_real_p / total_real)
        vol_k = demo_bio_ml * (v_real_k / total_real)
        vol_w = max(0.0, demo_batch_ml - (vol_n + vol_p + vol_k))
    else:
        vol_n = vol_p = vol_k = vol_w = 0.0

    return {
        "model_name": "RandomForestRegressor (scikit-learn)",
        "n_estimators": bundle.n_estimators,
        "training_samples": bundle.sample_count,
        "r2_score": bundle.r2_score_val,
        "mae_g_m2": bundle.mae_g_m2,
        "inputs_used": {
            "ph_value": round(ph_in, 2),
            "moisture_pct": round(moist_in, 1),
            "exg_green_pct": round(exg_in, 1),
        },
        "rf_deficits_g": {
            "n": round(rf_n_g, 2),
            "p2o5": round(rf_p2o5_g, 2),
            "k2o": round(rf_k2o_g, 2),
        },
        "rf_demo_volumes_ml": {
            "n": round(vol_n, 2),
            "p": round(vol_p, 2),
            "k": round(vol_k, 2),
            "water": round(vol_w, 2),
        },
        "feature_importances_pct": bundle.feature_importances_pct,
        "feature_labels_th": FEATURE_LABELS_TH,
    }
