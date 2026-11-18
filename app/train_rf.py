"""Data simulation + training pipeline for the Random Forest fertilizer-deficit model.

Run (locally or on Google Colab):  python train_rf.py
Outputs (app/data/): agronomic_rf_dataset.csv, rf_fertilizer_model.joblib, rf_evaluation_report.json

Soil states are SIMULATED for Mae Hong Son (see Info/03_SOFTWARE_FORMULAS_AND_CROP_DB.md section 7):
no Khun Yuam soil-test table was found, so distributions are anchored to Land Development Department
(LDD) interpretation classes. Targets come from the agronomic formula in ml_model.py.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import TransformedTargetRegressor
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import KFold, train_test_split
from sklearn.preprocessing import StandardScaler

from database import SEED_CROP_PROFILES
from ml_model import FEATURE_NAMES, _compute_agronomic_nonlinear_targets

DATA_DIR = Path(__file__).resolve().parent / "data"
DATASET_CSV = DATA_DIR / "agronomic_rf_dataset.csv"
MODEL_PATH = DATA_DIR / "rf_fertilizer_model.joblib"
REPORT_PATH = DATA_DIR / "rf_evaluation_report.json"

SAMPLES_PER_PROFILE = 1500
STAGE_EXG_MEAN = {1: 35.0, 2: 60.0, 3: 55.0}
BULK_DENSITIES = [1.25, 1.35, 1.45]
# Simulation distributions anchored to verified Rice Department & LDD soil test thresholds:
# - Rice Dept (files-rice-1749007694793.pdf & 1775720306069.pdf): pH 5.5-6.5; P <5 low, 5-10 mid, >10 high ppm;
#   K <60 low, 60-80 mid, >80 high ppm; OM <1% low, 1-2% mid, >2% high
# - LDD upland thresholds: P Bray II <10 low, 10-15 mid, >15 high mg/kg; K <10 low, 10-25 mid, >25 high mg/kg
PH_MEAN, PH_SD, PH_RANGE = 5.9, 0.55, (4.5, 7.2)
P_BRAY_MEDIAN, P_SIGMA, P_RANGE = 8.0, 0.75, (1.0, 60.0)      # mg/kg; covers <5 (rice low) and 5-15 (mid) up to >45
K_MEDIAN, K_SIGMA, K_RANGE = 55.0, 0.65, (5.0, 150.0)         # mg/kg; covers <60 (rice low), 60-80 (rice mid), >80 (high)
N_MEDIAN, N_SIGMA, N_RANGE = 12.0, 0.6, (2.0, 60.0)           # mg/kg available N (proxy for %OM 0.5-3.5%)
MOISTURE_PADDY, MOISTURE_UPLAND = (21.5, 85.0), (15.0, 75.0)  # % ; paddy field test 21.5-27.2% up to saturated/flooded
PADDY_CROPS = {"ข้าว"}
TARGETS = ["deficit_n_g_m2", "deficit_p2o5_g_m2", "deficit_k2o_g_m2"]
N_ESTIMATORS, MAX_DEPTH, MIN_LEAF, SEED = 120, 12, 2, 42


def _lognormal(rng: np.random.Generator, median: float, sigma: float, bounds: tuple[float, float]) -> float:
    return float(np.clip(rng.lognormal(np.log(median), sigma), *bounds))


def build_dataset() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    records: list[dict] = []
    for pid, prof in enumerate(SEED_CROP_PROFILES, start=1):
        crop, _, _, root_depth, t_n, t_p2o5, t_k2o, ph_min, ph_max, _ = prof
        moist_lo, moist_hi = MOISTURE_PADDY if crop in PADDY_CROPS else MOISTURE_UPLAND
        for _ in range(SAMPLES_PER_PROFILE):
            bd = float(rng.choice(BULK_DENSITIES))
            exg = float(np.clip(rng.normal(STAGE_EXG_MEAN[(pid - 1) % 3 + 1], 12.0), 5.0, 90.0))
            s_n = _lognormal(rng, N_MEDIAN, N_SIGMA, N_RANGE)
            s_p = _lognormal(rng, P_BRAY_MEDIAN, P_SIGMA, P_RANGE)
            s_k = _lognormal(rng, K_MEDIAN, K_SIGMA, K_RANGE)
            ph = float(np.clip(rng.normal(PH_MEAN, PH_SD), *PH_RANGE))
            moist = float(rng.uniform(moist_lo, moist_hi))
            dn, dp, dk = _compute_agronomic_nonlinear_targets(
                pid, root_depth, t_n, t_p2o5, t_k2o, ph_min, ph_max, bd,
                s_n, s_p, s_k, ph, moist, exg,
            )
            records.append({
                "crop_profile_id": pid, "crop_name": crop, "root_depth_m": root_depth,
                "bulk_density_g_cm3": bd, "soil_n_mg_kg": round(s_n, 3), "soil_p_mg_kg": round(s_p, 3),
                "soil_k_mg_kg": round(s_k, 3), "ph_value": round(ph, 3), "moisture_pct": round(moist, 3),
                "exg_green_pct": round(exg, 3), "deficit_n_g_m2": round(dn, 5),
                "deficit_p2o5_g_m2": round(dp, 5), "deficit_k2o_g_m2": round(dk, 5),
            })
    return pd.DataFrame(records)


def _metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    out = {}
    for i, name in enumerate(["N", "P2O5", "K2O"]):
        out[name] = {
            "r2": float(r2_score(y_true[:, i], y_pred[:, i])),
            "rmse": float(np.sqrt(mean_squared_error(y_true[:, i], y_pred[:, i]))),
            "mae": float(mean_absolute_error(y_true[:, i], y_pred[:, i])),
        }
    out["overall"] = {
        "r2": float(r2_score(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "mae": float(mean_absolute_error(y_true, y_pred)),
    }
    return out


def _new_rf() -> TransformedTargetRegressor:
    # Targets differ in scale; without standardising, the multi-output MSE criterion under-weights small ones.
    rf = RandomForestRegressor(n_estimators=N_ESTIMATORS, max_depth=MAX_DEPTH,
                               min_samples_leaf=MIN_LEAF, random_state=SEED, n_jobs=-1)
    return TransformedTargetRegressor(regressor=rf, transformer=StandardScaler())


def train_and_save() -> dict:
    started = time.time()
    df = build_dataset()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(DATASET_CSV, index=False)

    x, y = df[FEATURE_NAMES].to_numpy(), df[TARGETS].to_numpy()
    # Stratify by profile so every crop/stage appears in both splits.
    x_tr, x_te, y_tr, y_te = train_test_split(x, y, test_size=0.20, random_state=SEED,
                                              stratify=df["crop_profile_id"])
    rf = _new_rf().fit(x_tr, y_tr)
    holdout = _metrics(y_te, rf.predict(x_te))

    folds = []
    for f_tr, f_te in KFold(n_splits=5, shuffle=True, random_state=SEED).split(x):
        folds.append(_metrics(y[f_te], _new_rf().fit(x[f_tr], y[f_tr]).predict(x[f_te])))
    cv = {}
    for key in ["N", "P2O5", "K2O", "overall"]:
        cv[key] = {m: {"mean": float(np.mean([f[key][m] for f in folds])),
                       "std": float(np.std([f[key][m] for f in folds]))} for m in ["r2", "rmse", "mae"]}

    imp = {n: round(float(v) * 100.0, 2) for n, v in zip(FEATURE_NAMES, rf.regressor_.feature_importances_)}
    report = {
        "model": "RandomForestRegressor (scikit-learn)",
        "hyperparameters": {"n_estimators": N_ESTIMATORS, "max_depth": MAX_DEPTH,
                            "min_samples_leaf": MIN_LEAF, "random_state": SEED},
        "dataset": {
            "source": "Simulated Mae Hong Son soil states + DOAE/Rice Dept/LDD fertilizer rates (see docs section 7)",
            "crops": sorted(df["crop_name"].unique().tolist()),
            "total_samples": int(len(df)), "train_samples": int(len(x_tr)), "test_samples": int(len(x_te)),
            "simulation_assumptions": {
                "ph": {"mean": PH_MEAN, "sd": PH_SD, "range": PH_RANGE},
                "p_bray_ii_mg_kg": {"median": P_BRAY_MEDIAN, "sigma": P_SIGMA, "range": P_RANGE},
                "k_mg_kg": {"median": K_MEDIAN, "sigma": K_SIGMA, "range": K_RANGE},
                "n_mineral_mg_kg": {"median": N_MEDIAN, "sigma": N_SIGMA, "range": N_RANGE},
                "moisture_pct_paddy": MOISTURE_PADDY, "moisture_pct_upland": MOISTURE_UPLAND,
            },
            "targets_note": "Targets are computed by the agronomic non-linear formula, not field measurements.",
        },
        "holdout_80_20": holdout,
        "cross_validation_5fold": cv,
        "feature_importance_pct": imp,
        "training_seconds": round(time.time() - started, 1),
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    joblib.dump({"model": rf, "report": report}, MODEL_PATH)
    return report


if __name__ == "__main__":
    rep = train_and_save()
    print(json.dumps({k: rep[k] for k in ["holdout_80_20", "feature_importance_pct", "training_seconds"]}, indent=2))
