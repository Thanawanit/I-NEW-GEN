"""Central configuration and teammate calibration constants."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

APP_DIR = Path(__file__).resolve().parent
OVERRIDE_PATH = APP_DIR / "calibration_overrides.json"
DB_PATH = APP_DIR / "smart_biofert.db"
UPLOAD_DIR = APP_DIR / "static" / "uploads"


@dataclass
class AppConfig:
    """Holds hardware calibration constants and demo scaling parameters."""

    # Calibrated pump flow rates (ml/s) - updated by Teammate #2
    q_pump_n: float = 5.0
    q_pump_p: float = 5.0
    q_pump_k: float = 5.0
    q_pump_water: float = 5.0

    # Bio-liquid nutrient concentrations (mg/ml) - baseline placeholders until measured
    c_bio_n: float = 2.0
    c_bio_p2o5: float = 1.0
    c_bio_k2o: float = 2.0

    # Tabletop drone flight boundaries (cm) - updated by Teammate #3
    table_width_cm: float = 100.0
    table_height_cm: float = 80.0
    min_move_cm: float = 20.0

    # Mixing batch & safety thresholds
    demo_batch_ml: float = 200.0
    demo_bio_ml: float = 80.0
    min_pump_runtime_s: float = 1.5
    exg_green_threshold: int = 20
    fermenter_temp_min_c: float = 25.0
    fermenter_temp_max_c: float = 40.0

    # Reference soil bulk densities (g/cm^3)
    bulk_density_map: dict[str, float] = field(
        default_factory=lambda: {
            "sandy_loam": 1.45,
            "loam": 1.35,
            "clay_loam": 1.25,
        }
    )

    # LDD Soil Test Kit qualitative level -> baseline mg/kg mapping
    ldd_level_to_mg_kg: dict[str, dict[str, float]] = field(
        default_factory=lambda: {
            "n": {"low": 5.0, "medium": 15.0, "high": 30.0},
            "p": {"low": 5.0, "medium": 15.0, "high": 30.0},
            "k": {"low": 30.0, "medium": 60.0, "high": 100.0},
        }
    )


def get_config(override_path: Path = OVERRIDE_PATH) -> AppConfig:
    """Load default config merged with any persisted JSON overrides."""
    cfg = AppConfig()
    if override_path.exists():
        raw = json.loads(override_path.read_text(encoding="utf-8"))
        for key, value in raw.items():
            if hasattr(cfg, key) and isinstance(value, (int, float)):
                setattr(cfg, key, float(value))
    return cfg


def update_config(
    updates: dict[str, Any], override_path: Path = OVERRIDE_PATH
) -> AppConfig:
    """Validate and persist numeric calibration overrides."""
    editable_fields = {
        "q_pump_n",
        "q_pump_p",
        "q_pump_k",
        "q_pump_water",
        "c_bio_n",
        "c_bio_p2o5",
        "c_bio_k2o",
        "table_width_cm",
        "table_height_cm",
        "min_move_cm",
    }
    cfg = get_config(override_path)
    persisted: dict[str, float] = {}
    if override_path.exists():
        persisted = json.loads(override_path.read_text(encoding="utf-8"))

    for key, value in updates.items():
        if key not in editable_fields or value is None:
            continue
        num = float(value)
        if num <= 0:
            raise ValueError(f"Calibration value '{key}' must be greater than 0.")
        setattr(cfg, key, num)
        persisted[key] = num

    override_path.write_text(json.dumps(persisted, indent=2), encoding="utf-8")
    return cfg


def config_to_dict(cfg: AppConfig) -> dict[str, Any]:
    """Serialize AppConfig to a JSON-friendly dictionary."""
    return asdict(cfg)
