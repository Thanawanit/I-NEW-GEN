"""SQLite database initialization, migrations, and DOA/ARDA-aligned crop seed data."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from config import DB_PATH

SEED_CROP_PROFILES: list[tuple[Any, ...]] = [
    # ข้าวโพดเลี้ยงสัตว์ (DOA baseline ~18-8-11 kg/rai -> ~11.25-5.0-6.88 g/m^2 total)
    ("ข้าวโพดเลี้ยงสัตว์", "ลูกผสมทั่วไป", "1. ระยะต้นกล้า/รองพื้น (0–20 วัน)", 0.15, 2.50, 2.00, 1.50, 5.5, 7.0, 800.0),
    ("ข้าวโพดเลี้ยงสัตว์", "ลูกผสมทั่วไป", "2. ระยะเจริญเติบโต/ทำรุ่น (21–45 วัน)", 0.25, 6.00, 1.50, 2.50, 5.5, 7.0, 1000.0),
    ("ข้าวโพดเลี้ยงสัตว์", "ลูกผสมทั่วไป", "3. ระยะออกดอก–ติดฝัก (46+ วัน)", 0.30, 2.75, 1.50, 2.88, 5.5, 7.0, 1000.0),
    # ถั่วลายเสือ / ถั่วลิสง (DOA baseline ~7-0.9-2.3 kg/rai; rhizobium N fixation)
    ("ถั่วลายเสือ", "พันธุ์พื้นเมืองแม่ฮ่องสอน", "1. ระยะต้นกล้า (0–20 วัน)", 0.15, 1.00, 0.30, 0.50, 5.5, 6.8, 700.0),
    ("ถั่วลายเสือ", "พันธุ์พื้นเมืองแม่ฮ่องสอน", "2. ระยะเจริญเติบโต (21–45 วัน)", 0.20, 1.50, 0.30, 0.80, 5.5, 6.8, 900.0),
    ("ถั่วลายเสือ", "พันธุ์พื้นเมืองแม่ฮ่องสอน", "3. ระยะลงเข็ม–ติดฝัก (46+ วัน)", 0.25, 0.50, 0.30, 1.00, 5.5, 6.8, 900.0),
    # กาแฟอราบิก้า (ARDA/DOA site-specific baseline: 15-3-6 canopy, 3-6-15 fruiting)
    ("กาแฟอราบิก้า", "คาทิมอร์ (Catimor)", "1. ระยะต้นกล้า/ฟื้นต้นหลังเก็บเกี่ยว", 0.20, 3.00, 0.40, 2.00, 5.0, 6.2, 800.0),
    ("กาแฟอราบิก้า", "คาทิมอร์ (Catimor)", "2. ระยะแตกทรงพุ่ม/บำรุงใบ (15-3-6)", 0.30, 8.00, 0.60, 4.00, 5.0, 6.2, 1000.0),
    ("กาแฟอราบิก้า", "คาทิมอร์ (Catimor)", "3. ระยะติดผล–บำรุงเมล็ด (3-6-15)", 0.35, 4.50, 0.80, 11.00, 5.0, 6.2, 1100.0),
]


@contextmanager
def get_connection(db_path: Path = DB_PATH) -> Iterator[sqlite3.Connection]:
    """Open a SQLite connection with dictionary-like Row access and auto-close."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """Safely add a column to an existing table if upgrading from an older DB file."""
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db(db_path: Path = DB_PATH) -> None:
    """Create schema tables if missing, migrate mode columns, and seed crop profiles."""
    with get_connection(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS crop_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                crop_name TEXT NOT NULL,
                variety TEXT NOT NULL,
                growth_stage TEXT NOT NULL,
                root_depth_m REAL NOT NULL,
                target_n_g_m2 REAL NOT NULL,
                target_p2o5_g_m2 REAL NOT NULL,
                target_k2o_g_m2 REAL NOT NULL,
                ph_min REAL NOT NULL,
                ph_max REAL NOT NULL,
                safe_ec_max_ppm REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plot_name TEXT NOT NULL,
                polygon_geojson TEXT NOT NULL,
                calculated_area_m2 REAL NOT NULL,
                confirmed_area_m2 REAL NOT NULL,
                soil_type TEXT NOT NULL,
                bulk_density_g_cm3 REAL NOT NULL,
                crop_profile_id INTEGER NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (crop_profile_id) REFERENCES crop_profiles(id)
            );

            CREATE TABLE IF NOT EXISTS soil_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plot_id INTEGER NOT NULL,
                nitrogen_mg_kg REAL,
                phosphorus_mg_kg REAL,
                potassium_mg_kg REAL,
                ph_value REAL,
                moisture_pct REAL,
                ec_us_cm REAL,
                source TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS fermenter_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                temp_n_c REAL,
                temp_p_c REAL,
                temp_k_c REAL,
                mixer_tds_ppm REAL,
                is_ready INTEGER DEFAULT 1,
                source TEXT NOT NULL DEFAULT 'esp32_live',
                mode TEXT NOT NULL DEFAULT 'live',
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS mixing_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plot_id INTEGER NOT NULL,
                delta_n_g REAL NOT NULL,
                delta_p_g REAL NOT NULL,
                delta_k_g REAL NOT NULL,
                vol_n_ml REAL NOT NULL,
                vol_p_ml REAL NOT NULL,
                vol_k_ml REAL NOT NULL,
                vol_water_ml REAL NOT NULL,
                pump_n_sec REAL NOT NULL,
                pump_p_sec REAL NOT NULL,
                pump_k_sec REAL NOT NULL,
                pump_water_sec REAL NOT NULL,
                final_tds_ppm REAL,
                status TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # Ensure strict mode isolation columns exist even on pre-existing DB files
        for table_name in ("plots", "soil_readings", "fermenter_logs", "mixing_jobs"):
            _ensure_column(conn, table_name, "mode", "TEXT NOT NULL DEFAULT 'live'")

        existing = conn.execute("SELECT COUNT(*) FROM crop_profiles").fetchone()[0]
        if existing == 0:
            conn.executemany(
                """
                INSERT INTO crop_profiles (
                    crop_name, variety, growth_stage, root_depth_m,
                    target_n_g_m2, target_p2o5_g_m2, target_k2o_g_m2,
                    ph_min, ph_max, safe_ec_max_ppm
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                SEED_CROP_PROFILES,
            )
        conn.commit()
