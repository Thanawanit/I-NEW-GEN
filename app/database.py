"""SQLite database initialization, migrations, and DOA/ARDA-aligned crop seed data."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from config import DB_PATH

_RICE_VARIETIES: tuple[str, ...] = (
    "ขาวดอกมะลิ 105 (นาสวน • ไวต่อช่วงแสง)",
    "กข6 (นาสวน • ไวต่อช่วงแสง)",
    "สันป่าตอง 1 (นาสวน • ไม่ไวต่อช่วงแสง)",
    "กข21 (นาสวน • ไม่ไวต่อช่วงแสง)",
    "บือโปะโหละ (ข้าวไร่พื้นเมือง)",
    "จะแอ้ (ข้าวไร่พื้นเมือง)",
    "จะนอนะ / ข้าวลืมผัว (ข้าวไร่พื้นเมือง)",
    "เจ้าลีซอสันป่าตอง (ข้าวไร่)",
)

_RICE_STAGES: tuple[tuple[str, float, float, float], ...] = (
    ("1. ระยะงอกและระยะกล้า (0–30 วัน)", 0.94, 1.41, 0.00),
    ("2. ระยะแตกกอ (30–80 วัน)", 2.25, 2.81, 0.00),
    ("3. ระยะสร้างช่อดอก (~60–70 วันก่อนเก็บเกี่ยว)", 2.88, 0.00, 0.00),
    ("4. ระยะตั้งท้อง (~30–35 วันก่อนออกรวง)", 1.44, 0.00, 0.00),
    ("5. ระยะออกรวงและผสมเกสร (~25–30 วันก่อนเก็บเกี่ยว)", 0.00, 0.00, 0.00),
    ("6. ระยะสร้างน้ำนม (1–15 วันหลังดอกบาน)", 0.00, 0.00, 0.00),
    ("7. ระยะแป้งแข็ง (15–25 วันหลังดอกบาน)", 0.00, 0.00, 0.00),
    ("8. ระยะสุกแก่และเก็บเกี่ยว (25–35 วันหลังดอกบาน)", 0.00, 0.00, 0.00),
)

_GARLIC_VARIETIES: tuple[str, ...] = (
    "กระเทียมแม่ฮ่องสอน (พันธุ์กลาง สายพันธุ์ปาย)",
)

_GARLIC_STAGES: tuple[tuple[str, float, float, float], ...] = (
    ("1. ระยะปลูกและตั้งตัว (0–15 วัน)", 3.75, 3.75, 3.75),
    ("2. ระยะเจริญเติบโตทางใบ (15–60 วัน)", 2.80, 2.20, 2.20),
    ("3. ระยะเริ่มลงหัว (60–80 วัน)", 1.50, 1.50, 4.00),
    ("4. ระยะพัฒนาหัวให้สมบูรณ์ (80–100 วัน)", 0.00, 1.00, 3.00),
    ("5. ระยะแก่และเก็บเกี่ยว (100–120 วัน)", 0.00, 0.00, 0.00),
)

_PEANUT_VARIETIES: tuple[str, ...] = (
    "ถั่วลายเสือแม่ฮ่องสอน (พันธุ์กาฬสินธุ์ 2)",
)

_PEANUT_STAGES: tuple[tuple[str, float, float, float, float], ...] = (
    ("1. ระยะงอก (0–15 วัน)", 0.63, 1.25, 0.63, 700.0),
    ("2. ระยะเจริญเติบโตทางลำต้นและใบ (15–35 วัน)", 0.63, 1.25, 0.63, 800.0),
    ("3. ระยะออกดอก (30–40 วัน)", 0.62, 1.25, 0.62, 900.0),
    ("4. ระยะสร้างเข็ม / แทงเข็ม (35–50 วัน)", 0.00, 0.00, 0.00, 900.0),
    ("5. ระยะฝักและเมล็ดพัฒนา (50–95 วัน)", 0.00, 0.00, 0.00, 900.0),
    ("6. ระยะสุกแก่และเก็บเกี่ยว (95–115 วัน)", 0.00, 0.00, 0.00, 900.0),
)

_CORN_VARIETIES: tuple[str, ...] = (
    "พันธุ์ลูกผสมการค้า (CP-301 / CP-801 / Pioneer / Pacific 999)",
    "นครสวรรค์ 3 / นครสวรรค์ 4 (ทนแล้ง)",
    "นครสวรรค์ 5 (อายุสั้น 95–100 วัน)",
    "สุวรรณ 1 (พันธุ์ผสมเปิด)",
    "สุวรรณ 5 / สุวรรณ 4452 (พันธุ์ลูกผสมเดี่ยว)",
)

_CORN_STAGES: tuple[tuple[str, float, float, float], ...] = (
    ("1. VE ระยะงอก (ต้นอ่อนแทงพ้นดิน)", 4.22, 4.22, 4.22),
    ("2. V1-V(n) ระยะเจริญเติบโตทางใบ", 5.63, 0.00, 2.81),
    ("3. VT ระยะเกสรตัวผู้ออกสุด", 2.50, 0.00, 1.50),
    ("4. R1 ระยะออกไหม", 1.25, 0.00, 1.00),
    ("5. R2 ระยะตุ่มน้ำใส (10–14 วันหลังออกไหม)", 0.00, 0.00, 0.00),
    ("6. R3 ระยะน้ำนม (18–22 วันหลังออกไหม)", 0.00, 0.00, 0.00),
    ("7. R4 ระยะแป้งข้น (24–28 วันหลังออกไหม)", 0.00, 0.00, 0.00),
    ("8. R5 ระยะบุ๋ม (35–42 วันหลังออกไหม)", 0.00, 0.00, 0.00),
    ("9. R6 ระยะสุกแก่ทางสรีรวิทยา (55–65 วันหลังออกไหม)", 0.00, 0.00, 0.00),
)

SEED_CROP_PROFILES: list[tuple[Any, ...]] = [
    *[
        ("ข้าว", var, st, 0.25, n, p, k, 5.5, 6.5, 1000.0)
        for var in _RICE_VARIETIES
        for (st, n, p, k) in _RICE_STAGES
    ],
    *[
        ("กระเทียม", var, st, 0.25, n, p, k, 6.0, 7.5, 900.0)
        for var in _GARLIC_VARIETIES
        for (st, n, p, k) in _GARLIC_STAGES
    ],
    *[
        ("ถั่วลิสง", var, st, 0.30, n, p, k, 5.5, 6.8, ec)
        for var in _PEANUT_VARIETIES
        for (st, n, p, k, ec) in _PEANUT_STAGES
    ],
    *[
        ("ข้าวโพดเลี้ยงสัตว์", var, st, 0.35, n, p, k, 5.5, 7.0, 1000.0)
        for var in _CORN_VARIETIES
        for (st, n, p, k) in _CORN_STAGES
    ],
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
                point_index INTEGER,
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS fermenter_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                temp_n_c REAL,
                temp_p_c REAL,
                temp_k_c REAL,
                temp_mixer_c REAL,
                mixer_tds_ppm REAL,
                is_ready INTEGER DEFAULT 0,
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
        _ensure_column(conn, "fermenter_logs", "temp_mixer_c", "REAL")
        _ensure_column(conn, "soil_readings", "point_index", "INTEGER")

        # Upsert by id so an existing DB file picks up the current crop table without breaking plot FKs.
        conn.executemany(
            """
            INSERT OR REPLACE INTO crop_profiles (
                id, crop_name, variety, growth_stage, root_depth_m,
                target_n_g_m2, target_p2o5_g_m2, target_k2o_g_m2,
                ph_min, ph_max, safe_ec_max_ppm
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [(idx, *prof) for idx, prof in enumerate(SEED_CROP_PROFILES, start=1)],
        )
        conn.commit()
