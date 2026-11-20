# Software Architecture, Mathematical Formulas & Crop Database Spec — `v1.8`

> **วัตถุประสงค์เอกสาร:** กำหนดสถาปัตยกรรมซอฟต์แวร์ (รันบน **Raspberry Pi 5 คุมปั๊ม GPIO 17,27,22,23 + กล่องวัดดินไร้สาย Arduino Uno LoRa RA-02 1–15 จุด**) โครงสร้างฐานข้อมูลพืช/พันธุ์/ระยะการเจริญเติบโต ชุดสูตรคำนวณทางคณิตศาสตร์ทั้งหมด และ API Contract สำหรับเชื่อมต่อเว็บและโดรน
>
> **หมายเหตุสถานะ `v1.8` & ส่วนหมักปุ๋ย:**
> 1. **ส่วนหมักปุ๋ย (N, P, K) ดำเนินการเสร็จสิ้นแล้ว ไม่ต้องทำเพิ่ม** (นำน้ำหมักกรองใสเติมช่องเครื่องจ่ายปุ๋ยได้เลย)
> 2. **ตัด ESP32 / DS18B20 / TDS-EC / LDD Test Kit ออกจากฮาร์ดแวร์หน้างานแล้ว** (ตาราง/Endpoint เดิมบางส่วน เช่น `/api/fermenter/*`, `/api/mixer/check-ec`, `/api/soil/manual` คงไว้ใน Backend เพื่อความเข้ากันได้ย้อนหลังและชุดทดสอบเท่านั้น)

---

## 1. สถาปัตยกรรมซอฟต์แวร์ (Software Stack)

| เลเยอร์ | เทคโนโลยีที่กำหนด | หน้าที่หลัก |
| :--- | :--- | :--- |
| **Frontend (Map & UI)** | HTML5 + CSS + JavaScript + **Leaflet.js** + **Leaflet.draw** (`L.GeometryUtil.geodesicArea`) + **Esri World Imagery / OpenStreetMap** | วาด Polygon ขอบเขตแปลงบนแผนที่ภาพถ่ายดาวเทียมฟรี (**ไม่ต้องใช้บัตรเครดิต/API Key**), คำนวณพื้นที่ ($\text{m}^2$) แบบ Geodesic พร้อมช่องให้ผู้ใช้แก้ไขเลขเอง, ฟอร์มเลือกพืช/พันธุ์/ระยะเติบโต, และ Dashboard แสดงผลเรียลไทม์ |
| **Backend Server** | **Python Flask บน Raspberry Pi 5** (`host='0.0.0.0'`, พอร์ต `5000`) | คำนวณสูตรปุ๋ยและระยะบิน, ประมวลผลภาพถ่ายโดรน, รันโมเดล Machine Learning, สื่อสารกับโดรนผ่าน USB Wi-Fi, และเปิด REST API ให้ ESP32 ส่งค่า/รับคำสั่ง |
| **Machine Learning (AI)** | **scikit-learn (`RandomForestRegressor`)** | ประมวลผลตัวแปรตาราง 9 มิติ (ชนิดพืช/ระยะเติบโต, ความลึกราก, ความหนาแน่นดิน, N, P, K, pH, ความชื้นดิน, และดัชนีความเขียว `ExG %`) เพื่อพยากรณ์ความต้องการปุ๋ยแบบไม่เป็นเชิงเส้น พร้อมคำนวณค่า $R^2$, `MAE` และ `Feature Importance (%)` |
| **Image Processing** | **OpenCV (`cv2`) + NumPy** | อ่านภาพถ่ายจากโดรนรอบที่ 1 (OpenCV อ่านสีเป็น **BGR** ต้องแปลงเป็น `int16` ก่อนคำนวณ $2G - R - B$ เพื่อป้องกัน `uint8` overflow) |
| **Database** | **SQLite** | จัดเก็บข้อมูลแปลงเกษตร, เกณฑ์ธาตุอาหารพืช 4 ชนิด (120 โปรไฟล์), ค่าตรวจดินสด, สถานะถังหมัก 3 ถัง และประวัติการสั่งผสม/บินพ่น |
| **IoT Firmware** | Arduino C++ (RS485 หัววัดดิน ส่งเข้า Pi 5 ผ่าน USB/LoRa) + ESP32 (แบบ B: DS18B20 3 ถัง + TDS/EC ผ่าน Wi-Fi) |

---

## 2. โครงสร้างฐานข้อมูล (SQLite Schema)

```sql
-- 1. ตารางเกณฑ์ธาตุอาหารอ้างอิงตาม พืช + พันธุ์ + ระยะการเจริญเติบโต
CREATE TABLE crop_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crop_name TEXT NOT NULL,          -- เช่น 'ข้าวโพดเลี้ยงสัตว์'
    variety TEXT NOT NULL,            -- เช่น 'ลูกผสมเดี่ยว (ทั่วไป)'
    growth_stage TEXT NOT NULL,       -- 'seedling', 'vegetative', 'reproductive'
    root_depth_m REAL NOT NULL,       -- ความลึกรากอ้างอิง (เมตร)
    target_n_g_m2 REAL NOT NULL,      -- ความต้องการ N เป้าหมาย (g/m^2)
    target_p2o5_g_m2 REAL NOT NULL,   -- ความต้องการ P2O5 เป้าหมาย (g/m^2)
    target_k2o_g_m2 REAL NOT NULL,    -- ความต้องการ K2O เป้าหมาย (g/m^2)
    ph_min REAL NOT NULL,             -- ช่วง pH เหมาะสมต่ำสุด
    ph_max REAL NOT NULL,             -- ช่วง pH เหมาะสมสูงสุด
    safe_ec_max_ppm REAL NOT NULL     -- ค่า EC/TDS สูงสุดที่ปลอดภัยในการพ่นทางใบ (ppm)
);

-- 2. ตารางแปลงเกษตรที่ผู้ใช้วาดและยืนยันพื้นที่
CREATE TABLE plots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plot_name TEXT NOT NULL,
    polygon_geojson TEXT NOT NULL,    -- พิกัด Lat/Lng ทั้งหมดจาก Leaflet
    calculated_area_m2 REAL NOT NULL, -- พื้นที่ที่แผนที่คำนวณได้
    confirmed_area_m2 REAL NOT NULL,  -- พื้นที่ที่ผู้ใช้กดยืนยันหรือแก้ไขเอง
    soil_type TEXT NOT NULL,          -- เช่น 'sandy_loam', 'clay_loam'
    bulk_density_g_cm3 REAL NOT NULL, -- ความหนาแน่นมวลดิน (g/cm^3)
    crop_profile_id INTEGER NOT NULL,
    mode TEXT NOT NULL DEFAULT 'live',-- 'live' หรือ 'sim' (แยกฐานข้อมูล 100%)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (crop_profile_id) REFERENCES crop_profiles(id)
);

-- 3. ตารางบันทึกค่าดิน (จาก ESP32 #1 + ชุดตรวจดิน; ระบบรวมค่าความชื้นล่าสุดกับค่า NPK ล่าสุดของ plot_id เดียวกันให้อัตโนมัติ)
CREATE TABLE soil_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plot_id INTEGER NOT NULL,
    nitrogen_mg_kg REAL,
    phosphorus_mg_kg REAL,
    potassium_mg_kg REAL,
    ph_value REAL,
    moisture_pct REAL,
    ec_us_cm REAL,
    source TEXT NOT NULL,             -- 'esp32_live', 'manual_testkit', หรือ 'simulated'
    mode TEXT NOT NULL DEFAULT 'live',-- 'live' หรือ 'sim' (แยกฐานข้อมูล 100%)
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. ตารางสถานะถังหมักชีวภาพ 3 ถัง (จาก ESP32 #2)
CREATE TABLE fermenter_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temp_n_c REAL,
    temp_p_c REAL,
    temp_k_c REAL,
    temp_mixer_c REAL,                -- คอลัมน์ใน SQLite (เมื่อส่งออก JSON API จะแปลงชื่อเป็น temp_n, temp_p, temp_k, temp_mixer)
    mixer_tds_ppm REAL,
    is_ready INTEGER DEFAULT 0,       -- 1 เมื่ออุณหภูมิ 3 ถังอยู่ในช่วง 20–45 °C
    source TEXT NOT NULL DEFAULT 'esp32_live', -- 'esp32_live' หรือ 'simulated'
    mode TEXT NOT NULL DEFAULT 'live',
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. ตารางคำสั่งผสมปุ๋ยและประวัติการบิน
CREATE TABLE mixing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plot_id INTEGER NOT NULL,
    delta_n_g REAL NOT NULL,          -- ปริมาณขาด N (g)
    delta_p_g REAL NOT NULL,          -- ปริมาณขาด P2O5 (g)
    delta_k_g REAL NOT NULL,          -- ปริมาณขาด K2O (g)
    vol_n_ml REAL NOT NULL,
    vol_p_ml REAL NOT NULL,
    vol_k_ml REAL NOT NULL,
    vol_water_ml REAL NOT NULL,
    pump_n_sec REAL NOT NULL,         -- เวลาเปิดปั๊ม (วินาที; API ส่ง ms = round(sec*1000))
    pump_p_sec REAL NOT NULL,
    pump_k_sec REAL NOT NULL,
    pump_water_sec REAL NOT NULL,
    final_tds_ppm REAL,
    status TEXT NOT NULL,             -- 'pending', 'mixing', 'diluting', 'ready', 'sprayed'
    mode TEXT NOT NULL DEFAULT 'live',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 3. ตารางเกณฑ์พืชเป้าหมาย 4 ชนิด (ข้าว, กระเทียม, ถั่วลิสง/ถั่วลายเสือ, ข้าวโพดเลี้ยงสัตว์ — 15 สายพันธุ์ / 120 โปรไฟล์)

> **วิธีคำนวณ:** เป้าหมาย = อัตราปุ๋ยแนะนำของหน่วยงานรัฐ (กก./ไร่) × 0.625 → g/m² (1 ไร่ = 1,600 ตร.ม.) ที่มาและเอกสารอ้างอิงอยู่ในหัวข้อ 7 และ `app/database.py` (`SEED_CROP_PROFILES`)
> - **ข้าว (8 สายพันธุ์ × 8 ระยะ = 64 โปรไฟล์):** ขาวดอกมะลิ 105, กข6, สันป่าตอง 1, กข21, บือโปะโหละ, จะแอ้, จะนอนะ/ข้าวลืมผัว, เจ้าลีซอสันป่าตอง (ราก **0.25 m**, pH **5.5–6.5**, EC ≤ **1,000 ppm**)
> - **กระเทียม (1 สายพันธุ์ × 5 ระยะ = 5 โปรไฟล์):** กระเทียมแม่ฮ่องสอน (พันธุ์กลาง สายพันธุ์ปาย) (ราก **0.25 m**, pH **6.0–7.5**, EC ≤ **900 ppm**)
> - **ถั่วลิสง (1 สายพันธุ์ × 6 ระยะ = 6 โปรไฟล์):** ถั่วลายเสือแม่ฮ่องสอน (พันธุ์กาฬสินธุ์ 2 / GI แม่ฮ่องสอน) (ราก **0.30 m**, pH **5.5–6.8**, EC ≤ **700–900 ppm**; ระยะ R2 โรย **ยิปซัม 50–100 กก./ไร่** เสริมแคลเซียม)
> - **ข้าวโพดเลี้ยงสัตว์ (5 สายพันธุ์ × 9 ระยะ = 45 โปรไฟล์):** พันธุ์ลูกผสมการค้า (CP-301/801/Pioneer/Pacific 999), นครสวรรค์ 3/4, นครสวรรค์ 5, สุวรรณ 1, สุวรรณ 5/4452 (ราก **0.35 m**, pH **5.5–7.0**, EC ≤ **1,000 ppm**)

| ชนิดพืช | จำนวนพันธุ์ / ระยะ | ระยะหลักที่มีการใส่ปุ๋ย (ส่วนระยะปลาย/เก็บเกี่ยว = 0.00) | ความลึกราก ($d_{\text{root}}$) | ช่วง N (g/m²) | ช่วง P₂O₅ (g/m²) | ช่วง K₂O (g/m²) | ช่วง pH | EC พ่นปลอดภัย (ppm) |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **ข้าว** | 8 พันธุ์ / 8 ระยะ | 1. งอก–กล้า (0.94, 1.41, 0)<br>2. แตกกอ (2.25, 2.81, 0)<br>3. สร้างช่อดอก (2.88, 0, 0)<br>4. ตั้งท้อง (1.44, 0, 0) | 0.25 m | 0.00–2.88 | 0.00–2.81 | 0.00 | 5.5–6.5 | ≤ 1,000 |
| **กระเทียม** | 1 พันธุ์ / 5 ระยะ | 1. ปลูก–ตั้งตัว (3.75, 3.75, 3.75)<br>2. เจริญทางใบ (2.80, 2.20, 2.20)<br>3. เริ่มลงหัว (1.50, 1.50, 4.00)<br>4. พัฒนาหัว (0, 1.00, 3.00) | 0.25 m | 0.00–3.75 | 0.00–3.75 | 0.00–4.00 | 6.0–7.5 | ≤ 900 |
| **ถั่วลิสง (ถั่วลายเสือ)** | 1 พันธุ์ / 6 ระยะ | 1. งอก (0.63, 1.25, 0.63)<br>2. ลำต้น–ใบ (0.63, 1.25, 0.63)<br>3. ออกดอก (0.62, 1.25, 0.62) | 0.30 m | 0.00–0.63 | 0.00–1.25 | 0.00–0.63 | 5.5–6.8 | ≤ 700–900 |
| **ข้าวโพดเลี้ยงสัตว์** | 5 พันธุ์ / 9 ระยะ | 1. VE งอก (4.22, 4.22, 4.22)<br>2. V1–V(n) ทางใบ (5.63, 0, 2.81)<br>3. VT เกสรตัวผู้ (2.50, 0, 1.50)<br>4. R1 ออกไหม (1.25, 0, 1.00) | 0.35 m | 0.00–5.63 | 0.00–4.22 | 0.00–4.22 | 5.5–7.0 | ≤ 1,000 |

*(ค่าความหนาแน่นดินอ้างอิงแม่ฮ่องสอน 5 ชนิด $\rho_{\text{soil}}$: ดินร่วนปนทราย `1.55`, ดินร่วนเหนียวปนทราย `1.45`, ดินร่วนเหนียว `1.40`, ดินร่วน `1.35`, ดินเหนียว `1.25` g/cm³)*

---

## 4. ชุดสูตรคำนวณคณิตศาสตร์ทั้งหมด (พร้อมตัวอย่างแทนค่า)

### สูตรที่ 1: การคำนวณพื้นที่ Polygon และการยืนยันค่า
- บน Frontend ใช้ `L.GeometryUtil.geodesicArea(latlngs)` คำนวณพื้นที่ผิวโลก (หน่วย $\text{m}^2$) จากจุดมุม Polygon
- แสดงค่า `calculated_area_m2` ในช่อง Input ที่แก้ไขได้ $\rightarrow$ เก็บค่าจริงที่ผู้ใช้ยืนยันเป็น `confirmed_area_m2` ($A_{\text{real}}$)

### สูตรที่ 2: การย่อสเกลเส้นทางบินจากแผนที่ลงสู่ถาดแปลงบนโต๊ะ (Scale Calibration)
กำหนดกรอบพื้นที่บินปลอดภัยบนถาดแปลง `60 × 80 cm` (หักขอบปลอดภัยด้านละ 10 cm) ให้เหลือพื้นที่บินสุทธิ $W_{\text{table}} = 40\text{ cm}$ และความยาว $H_{\text{table}} = 60\text{ cm}$

1. **แปลงพิกัด Lat/Lng (องศา) เป็นพิกัดเมตร $(x_i, y_i)$** เทียบกับจุดมุมแรก $(\text{lat}_0, \text{lng}_0)$ ด้วย Equirectangular Projection ($R_{\text{earth}} = 6{,}371{,}000\text{ m}$, แปลงองศาเป็นเรเดียนก่อนคูณ):
   $$x_i\text{ (m)} = R_{\text{earth}} \cdot (\text{lng}_i - \text{lng}_0) \cdot \cos(\text{lat}_0), \qquad y_i\text{ (m)} = R_{\text{earth}} \cdot (\text{lat}_i - \text{lat}_0)$$
2. หา Bounding Box ของแปลงบนแผนที่จริง: ความกว้าง $W_{\text{real}} = x_{\max} - x_{\min}$ (m) และความยาว $H_{\text{real}} = y_{\max} - y_{\min}$ (m)
3. หาตัวคูณย่อสเกล $k$ (หน่วย $\text{cm/m}$):
   $$k = \min\left(\frac{W_{\text{table}}}{W_{\text{real}}},\ \frac{H_{\text{table}}}{H_{\text{real}}}\right)$$
4. แปลงจุดมุมแปลงแต่ละจุดเป็นคำสั่งเคลื่อนที่ของโดรน (กำหนดจุดเริ่มต้นที่มุมแปลงแรก และ**หันหัวโดรนไปทางทิศเหนือ `+Y` ของโต๊ะเป็น $0^\circ$**):
   $$\Delta X_i\text{ (cm)} = k \cdot (x_i - x_{i-1}), \qquad \Delta Y_i\text{ (cm)} = k \cdot (y_i - y_{i-1})$$
   $$\text{ระยะบินตรง } d_i = \sqrt{\Delta X_i^2 + \Delta Y_i^2}\text{ (cm)}, \qquad \text{มุมทิศ } \text{heading}_i = \text{atan2}(\Delta X_i, \Delta Y_i)$$
   $$\text{มุมสั่งเลี้ยว } \text{turn}_i = \big((\text{heading}_i - \text{heading}_{i-1} + 180^\circ) \bmod 360^\circ\big) - 180^\circ$$
   *(ตัวอย่าง: ถ้า $\Delta X=40, \Delta Y=0$ จะได้ $\text{heading} = 90^\circ$ คือเลี้ยวขวา $90^\circ$ จากทิศเหนือ และหากระยะ $d_i < 20\text{ cm}$ ให้รวมช่วงนี้เข้ากับจุดถัดไปก่อนสั่งบิน โดย GeoJSON Polygon จะมีจุดสุดท้ายซ้ำกับจุดแรกเสมอทำให้บินครบรอบกลับมาจุดเริ่มต้นอัตโนมัติ)*

### สูตรที่ 3: วิเคราะห์ภาพถ่ายโดรนด้วย Excess Green Index (ExG)
*(หมายเหตุสำหรับโค้ด: OpenCV อ่านภาพเป็น **BGR** ไม่ใช่ RGB และต้องแปลงอาร์เรย์เป็น `int16` หรือ `float` ก่อนคำนวณ เพื่อป้องกัน `uint8` overflow)*
สำหรับแต่ละพิกเซล $(R, G, B)$ ในภาพถ่ายแปลงจำลอง (ช่วงค่า 0–255):
$$\text{ExG}(x, y) = 2G(x, y) - R(x, y) - B(x, y)$$
นับจำนวนพิกเซลที่ $\text{ExG}(x, y) > T_{\text{green}}$ (เช่น $T_{\text{green}} = 20$ ปรับค่าตามแสงห้อง):
$$\text{Green Coverage (\%)} = \frac{\text{จำนวนพิกเซลที่ } \text{ExG} > T_{\text{green}}}{\text{จำนวนพิกเซลทั้งหมดในกรอบแปลง}} \times 100$$

### สูตรที่ 4: คำนวณปริมาณธาตุอาหารที่ดินขาด ($\Delta N, \Delta P_2O_5, \Delta K_2O$) และแจ้งเตือน pH

1. **แปลงค่าธาตุอาหารที่มีอยู่ในดิน** จากหน่วย $\text{mg/kg}$ (ppm) เป็นมวลต่อพื้นที่ ($\text{g/m}^2$):
   $$\text{มวลเนื้อดินต่อ } 1\text{ m}^2\text{ (kg/m}^2\text{)} = \rho_{\text{soil}}\ (\text{g/cm}^3) \times d_{\text{root}}\ (\text{m}) \times 1000$$
   $$M_{\text{soil\_elem}, i}\ (\text{g/m}^2) = C_{\text{measured}, i}\ (\text{mg/kg}) \times \big(\rho_{\text{soil}} \times d_{\text{root}}\big)$$
   *(หมายเหตุ: $\text{mg/kg} \times 1000\ \text{kg/m}^2 \times 10^{-3}\ \text{g/mg} = \text{mg/kg} \times 1$ พอดี)*

2. **แปลงรูปธาตุบริสุทธิ์เป็นรูปปุ๋ยออกไซด์และคูณสัมประสิทธิ์การดูดใช้ได้ต่อฤดู** ($f_N = 0.30,\ f_P = 0.20,\ f_K = 0.15$ ซึ่งเป็นค่าพารามิเตอร์สมมติสำหรับโมเดลสาธิตเพื่อสะท้อนสัดส่วนที่พืชดูดใช้ได้จริงจากดินใน 1 ระยะ):
   $$M_{\text{soil, N}} = M_{\text{soil\_elem, N}} \times 0.30, \qquad M_{\text{soil, P}_2\text{O}_5} = 2.29 \times M_{\text{soil\_elem, P}} \times 0.20, \qquad M_{\text{soil, K}_2\text{O}} = 1.20 \times M_{\text{soil\_elem, K}} \times 0.15$$

   > **ตัวอย่างคำนวณ:** ดินร่วน $\rho = 1.35\ \text{g/cm}^3$, ข้าวโพดระยะเติบโต $d_{\text{root}} = 0.25\ \text{m}$, วัดค่า N ระดับกลางจาก LDD ได้ $15\ \text{mg/kg}$ และ P ระดับต่ำ $5\ \text{mg/kg}$ *(สมมติให้ความเข้มข้นเฉลี่ยในเขตรากพืชเท่ากับหน้าดินที่เก็บ 0–15 ซม.)*:
   > $$M_{\text{soil, N}} = 15 \times 1.35 \times 0.25 \times 0.30 = 1.519\ \text{g/m}^2$$
   > $$M_{\text{soil, P}_2\text{O}_5} = 2.29 \times (5 \times 1.35 \times 0.25) \times 0.20 = 0.773\ \text{g/m}^2$$

3. **คำนวณปริมาณธาตุที่ขาดทั้งแปลง** ($\Delta M_i$ หน่วย กรัม):
   $$\Delta M_i\ (\text{g}) = \max(0,\ M_{\text{target}, i} - M_{\text{soil}, i}) \times A_{\text{real}}\ (\text{m}^2)$$
   > **ต่อจากตัวอย่าง:** เป้าหมายข้าวโพดระยะเติบโต $M_{\text{target, N}} = 6.00\ \text{g/m}^2$, $M_{\text{target, P}_2\text{O}_5} = 1.50\ \text{g/m}^2$, พื้นที่จริง $A_{\text{real}} = 100\ \text{m}^2$:
   > $$\Delta M_{\text{N}} = (6.00 - 1.519) \times 100 = 448.1\ \text{g}, \qquad \Delta M_{\text{P}_2\text{O}_5} = (1.50 - 0.773) \times 100 = 72.7\ \text{g}$$
   *(กรณีใช้ LDD Soil Test Kit ที่ให้ผลเป็นระดับ `ต่ำ / ปานกลาง / สูง` ให้ตั้งค่าตัวแทน $C_{\text{measured}}$ ของแต่ละระดับไว้ใน Config เพื่อเข้าสูตรเดียวกันได้ทันที)*

4. **เงื่อนไขตรวจสอบ pH (Safety & Absorption Warning):**
   - ถ้า $\text{pH} < \text{ph\_min}$ $\rightarrow$ แจ้งเตือน `"ดินเป็นกรดเกินเกณฑ์ พืชดูดซึมธาตุได้น้อย ควรปรับสภาพด้วยปูนขาว/โดโลไมต์ก่อนใส่ปุ๋ย"`
   - ถ้า $\text{pH} > \text{ph\_max}$ $\rightarrow$ แจ้งเตือน `"ดินเป็นด่างเกินเกณฑ์ ควรปรับสภาพด้วยอินทรียวัตถุ/กำมะถัน"`

5. **การพยากรณ์ร่วมด้วยโมเดล Machine Learning (`RandomForestRegressor` — `ml_model.py`):**
   - เพื่อจำลองความสัมพันธ์แบบไม่เป็นเชิงเส้น (Non-linear Interactions) ระหว่างสภาพดินกับความสมบูรณ์ของทรงพุ่มตามเอกสารอ้างอิง (`Breiman, 2001`; `Pedregosa et al., 2011`) ระบบใช้ `TransformedTargetRegressor(RandomForestRegressor(n_estimators=80, max_depth=None, min_samples_leaf=2), StandardScaler())` ที่ฝึกสอนด้วยชุดข้อมูลจำลองตามสูตรปฐพีวิทยา 36,000 ตัวอย่าง (ครอบคลุมพืช 4 ชนิด 120 โปรไฟล์ × 300 ตัวอย่าง, 80/20 Train-Test Split)
   - **ตัวแปรนำเข้า 9 ตัว (Features $X$):** `crop_profile_id`, `root_depth_m`, `bulk_density_g_cm3`, `soil_n_mg_kg`, `soil_p_mg_kg`, `soil_k_mg_kg`, `ph_value` (ผลของการตรึงธาตุ P เมื่อดินเป็นกรด/ด่าง), `moisture_pct` (ประสิทธิภาพการแพร่ของธาตุอาหารตามความชื้นดิน), และ `exg_green_pct` (ดัชนีความเขียวของใบจากภาพโดรนรอบที่ 1)
   - **ผลลัพธ์ (Targets $Y$):** พยากรณ์ปริมาณธาตุอาหารที่ขาด ($\text{rf\_deficits\_g}$) และปริมาตรน้ำหมักย่อสเกล ($\text{rf\_demo\_volumes\_ml}$) แสดงผลคู่กับสูตรสมดุลมวลมาตรฐาน พร้อมค่าความแม่นยำ ($R^2 = 0.9670$, $\text{MAE} = 0.0410\text{ g/m}^2$) และลำดับความสำคัญของตัวแปร (`feature_importances_pct`) บนหน้าเว็บแดชบอร์ด

### สูตรที่ 5: คำนวณปริมาตรน้ำหมัก, ย่อสเกล Demo และเวลาเปิดปั๊ม (Pump Runtime)

1. **ปริมาตรน้ำหมักที่ต้องการจริงตามทฤษฎี** (เมื่อความเข้มข้นน้ำหมักแต่ละถังคือ $C_{\text{bio}, i}$ หน่วย $\text{mg/ml}$ ของ $\text{N}, \text{P}_2\text{O}_5, \text{K}_2\text{O}$ จากค่า Placeholder ใน `config.py` — ตั้งเท่ากัน `2.0 mg/ml` ทั้ง 3 ถังเพื่อรักษาสัดส่วน $\Delta M$ จนกว่าคนที่ 4 จะวัดค่าจริง):
   $$V_{\text{real}, i}\ (\text{ml}) = \frac{\Delta M_i\ (\text{g}) \times 1000}{C_{\text{bio}, i}\ (\text{mg/ml})}$$
2. **การย่อสเกลปริมาตรสำหรับผสมโชว์บนโต๊ะ (Demo Batch Scaling):**
   ผสมในถังกลางปริมาตรรวม $V_{\text{batch}} = 1{,}000\text{ ml}$ (ตรงตามชุดปั๊ม `Back/`) โดยล็อกปริมาณน้ำหมักรวมคงที่ $V_{\text{demo\_bio}} = 400\text{ ml}$ และใช้ $\Delta M$ กำหนด **อัตราส่วน N : P : K** (ส่วนที่เหลือ $600\text{ ml}$ เป็นน้ำเปล่าเจือจาง):
   $$V_{\text{demo}, i} = V_{\text{demo\_bio}} \times \frac{V_{\text{real}, i}}{V_{\text{real, N}} + V_{\text{real, P}} + V_{\text{real, K}}}$$
   *(กรณีที่ดินไม่ขาดธาตุใดเลย คือผลรวม $V_{\text{real}} = 0$ ให้บันทึก `status = 'ready'`, คืนค่าเวลาทุกปั๊มเป็น `0.0 s` และแจ้งเตือนบนเว็บว่า "ดินมีความสมบูรณ์เพียงพอ ไม่ต้องเติมปุ๋ย")*

3. **คำนวณเวลาเปิด-ปิดปั๊ม 4 ตัว ($t_{\text{pump}, i}$) พร้อม Minimum Runtime Guard:**
   $$t_{\text{pump}, i}\ (\text{วินาที}) = \frac{V_{\text{demo}, i}\ (\text{ml})}{Q_{\text{pump}, i}\ (\text{ml/s})}$$
   - **กติกาเดียวป้องกัน Pump Dead-Time:** ก่อนเริ่มสั่งงานต้องไล่น้ำเต็มสายยางทุกเส้น (Pre-priming) และหากปั๊มธาตุใดคำนวณเวลาได้ $0 < t_{\text{pump}, i} < 1.5\text{ s}$ ให้ **ตัดเป็น `0.0 s`** แล้วย้ายปริมาตรส่วนนั้นไปบวกในน้ำเปล่าเพื่อให้รวมยังเป็น $1{,}000\text{ ml}$ โดยเก็บ `pump_seconds` ปัดทศนิยม 2 ตำแหน่ง (`round(sec, 2)`) ลงฐานข้อมูล แล้วแปลงเป็นมิลลิวินาทีใน API ด้วย `int(round(pump_sec * 1000))`
   > **ตัวอย่างคำนวณ:** ปั๊ม N มี $Q = 5.0\ \text{ml/s}$, ปริมาตร $V_{\text{demo, N}} = 68.83\text{ ml} \rightarrow t_{\text{pump, N}} = \text{round}(68.8326 / 5.0, 2) = 13.77\text{ s}$ (`13770 ms`) และปั๊ม P มี $V_{\text{demo, P}} = 11.17\text{ ml} \rightarrow t_{\text{pump, P}} = \text{round}(11.1674 / 5.0, 2) = 2.23\text{ s}$ (`2230 ms`)

4. **ลูปตรวจเช็กความเค็มและเจือจาง TDS/EC กึ่งอัตโนมัติ (Salinity/Osmotic Burn Guard):**
   หลัง ESP32 #2 เปิดปั๊มครบ 4 ตัว ให้ผู้ใช้กวนถังผสมแล้วจุ่มหัววัด TDS รอ **5 วินาที** เพื่อให้ ESP32 #2 ส่งค่า `mixer_tds_ppm` (มัธยฐานจาก 30 ตัวอย่าง) เข้า `/api/fermenter/telemetry` แล้วกดปุ่มตรวจบนเว็บ (`POST /api/mixer/check-ec`):
   - *(หมายเหตุ: คอลัมน์ `safe_ec_max_ppm` เก็บเป็นค่า TDS หน่วย ppm โดย $\text{TDS ppm} = \text{EC }\mu\text{S/cm} \times 0.5$ และห้ามนำค่านี้ไปเทียบตรงๆ กับ `ec_us_cm` ของดิน)*
   - ถ้า `mixer_tds_ppm` $\le$ `safe_ec_max_ppm` $\rightarrow$ สถานะ = `'ready'` (อนุญาตให้ตักขึ้นโดรนได้ และล้างหัววัดด้วยน้ำสะอาด)
   - ถ้า `mixer_tds_ppm` $>$ `safe_ec_max_ppm` $\rightarrow$ Flask คำนวณปริมาตรน้ำเปล่าเติมเพิ่มโดยคิดค่า TDS พื้นฐานของน้ำประปา ($\text{EC}_{\text{water}} \approx 150\ \text{ppm}$) และใช้ปริมาตรสะสมปัจจุบัน $V_{\text{current}} = V_{\text{N}} + V_{\text{P}} + V_{\text{K}} + V_{\text{water}}$:
     $$V_{\text{add\_water}} = V_{\text{current}} \times \frac{\text{EC}_{\text{current}} - \text{EC}_{\text{safe}}}{\text{EC}_{\text{safe}} - \text{EC}_{\text{water}}}$$
     *(ตรวจเช็กความจุถัง: หาก $V_{\text{current}} + V_{\text{add\_water}} > 2{,}000\text{ ml}$ ให้หยุดและแจ้งเตือนผู้ใช้แบ่งน้ำปุ๋ยออกครึ่งหนึ่งก่อน)* มิฉะนั้นระบบจะตั้ง `status = 'diluting'`, บวก `vol_water_ml` สะสมเพิ่ม, รีเซ็ตเวลาปั๊ม N/P/K เป็น `0`, และใส่เวลาปั๊มน้ำเปล่า $t_{\text{add}} = V_{\text{add\_water}} / Q_{\text{pump, water}}$ ให้ ESP32 #2 ดึงไปเติมน้ำเจือจางแล้ววัดซ้ำ

---

## 5. API Contract ฉบับสมบูรณ์ (Request + Response JSON + State Machine)

> **กฎการเชื่อมต่อกลาง:** ทุก Endpoint ใช้ `HTTP/1.1` พอร์ต `5000` (`Content-Type: application/json` ยกเว้นอัปโหลดภาพใช้ `multipart/form-data`) เวลาทั้งหมดใช้ ISO-8601 หรือ Timestamp จากเซิร์ฟเวอร์ ห้ามเปลี่ยนแปลงชื่อ Key เพื่อไม่ให้โค้ดของทีมพัง

| Endpoint | Method | ผู้ส่ง $\rightarrow$ ผู้รับ | Payload ตัวอย่าง (Request $\rightarrow$ Response) |
| :--- | :---: | :--- | :--- |
| `/api/crops` | `GET` | Web UI $\leftarrow$ Flask | **Resp `200`:** `{"crops": [{"id": 1, "crop_name": "ข้าวโพดเลี้ยงสัตว์", "variety": "ลูกผสมทั่วไป", "growth_stage": "1. ระยะต้นกล้า/รองพื้น (0–20 วัน)", "root_depth_m": 0.15, "target_n_g_m2": 2.5, "target_p2o5_g_m2": 2.0, "target_k2o_g_m2": 1.5, "ph_min": 5.5, "ph_max": 7.0, "safe_ec_max_ppm": 800}]}` |
| `/api/plots` | `GET` | Web UI $\leftarrow$ Flask | **Resp `200`:** `{"plots": [{"id": 1, "plot_name": "...", "confirmed_area_m2": 100.0, ...}]}` |
| `/api/plots` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `{"plot_name": "แปลง A", "mode": "sim", "polygon_geojson": {...}, "calculated_area_m2": 102.4, "confirmed_area_m2": 100.0, "soil_type": "loam", "crop_profile_id": 2}` *(Flask คำนวณ `bulk_density` จาก `soil_type` อัตโนมัติ)*<br>**Resp `201`:** `{"plot_id": 1, "mode": "sim", "waypoints_cm": [{"dx": 40.0, "dy": 0.0, "distance_cm": 40.0, "angle_deg": 90.0, "turn_deg": 90.0}]}` |
| `/api/soil/update` | `POST` | ESP32 #1 / Sim $\rightarrow$ Flask | **Req:** `{"plot_id": 1, "moisture_pct": 42.5, "ec_us_cm": null, "n": null, "p": null, "k": null, "ph": null, "simulated": false}`<br>**Resp `200`:** `{"ok": true, "provenance": "LIVE"}` *(หาก `"simulated": true` บันทึกเป็น `SIMULATED`)* |
| `/api/soil/manual` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `{"plot_id": 1, "mode": "sim", "n_level": "medium", "p_level": "low", "k_level": "medium", "ph_value": 6.0}`<br>**Resp `200`:** `{"ok": true, "nitrogen_mg_kg": 15.0, "phosphorus_mg_kg": 5.0, "potassium_mg_kg": 60.0, "provenance": "MANUAL"}` |
| `/api/soil/latest/<plot_id>` | `GET` | Web UI $\leftarrow$ Flask | **Resp `200`:** `{"mode": "sim", "reading": {"moisture_pct": 42.5, "ec_us_cm": null, "nitrogen_mg_kg": 15.0, "phosphorus_mg_kg": 5.0, "potassium_mg_kg": 60.0, "ph_value": 6.0, "source": "manual_testkit", "recorded_at": "2026-11-16T09:30:00"}}` |
| `/api/fermenter/telemetry` | `POST` | ESP32 #2 / Sim $\rightarrow$ Flask | **Req:** `{"temp_n": 31.2, "temp_p": 30.8, "temp_k": 31.5, "temp_mixer": null, "mixer_tds_ppm": null, "simulated": false}` *(ส่ง `mixer_tds_ppm: null` ระหว่างเช็กอุณหภูมิปกติ และส่งเป็นตัวเลข 30-sample median เฉพาะตอนจุ่มวัดหลังผสมเสร็จ)*<br>**Resp `200`:** `{"ok": true, "is_ready": true}` *(พร้อมเมื่ออุณหภูมิ 3 ถังอยู่ในช่วง 20–45 °C; ช่วงดีที่สุดคือ 25–40 °C)* |
| `/api/fermenter/latest` | `GET` | Web UI $\leftarrow$ Flask | **Resp `200`:** `{"mode": "live", "telemetry": {"temp_n": 31.2, "temp_p": 30.8, "temp_k": 31.5, "temp_mixer": null, "mixer_tds_ppm": 740, "is_ready": true, "recorded_at": "..."}}` *(Backend แปลงคอลัมน์ `temp_*_c` ใน SQLite เป็น `temp_n, temp_p, temp_k, temp_mixer` ให้ตรงกับขา POST)* |
| `/api/mixer/calculate` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `{"plot_id": 1, "mode": "sim", "crop_profile_id": 2, "confirmed_area_m2": 100.0, "soil_type": "loam"}`<br>**Resp `200`:** `{"job_id": 5, "status": "pending", "deficits_g": {"n": 448.1, "p2o5": 72.7, "k2o": 0.0}, "demo_volumes_ml": {"n": 68.83, "p": 11.17, "k": 0.0, "water": 120.0}, "pump_seconds": {"n": 13.77, "p": 2.23, "k": 0.0, "water": 24.0}, "ph_warning": null}` |
| `/api/mixer/command?mode=live` | `GET` | ESP32 #2 $\leftarrow$ Flask | **Resp `200` (มีงานค้าง — เปลี่ยนสถานะงานใน DB เป็น `'mixing'` ทันทีเพื่อกันการดึงซ้ำ และแปลงวินาทีเป็น ms ด้วย `int(round(pump_sec * 1000))`):** `{"has_command": true, "mode": "live", "job_id": 5, "status": "mixing", "pump_n_ms": 13770, "pump_p_ms": 2230, "pump_k_ms": 0, "pump_water_ms": 24000}`<br>**Resp `200` (ไม่มีงาน):** `{"has_command": false, "mode": "live", "job_id": null}` |
| `/api/mixer/dispense-live` | `POST` | Web UI $\rightarrow$ Pi 5 GPIO | **Req:** `{}`<br>**Resp `200`:** `{"ok": true, "job_id": 5, "status": "mixing", "gpio_pins": {"n": 17, "p": 27, "k": 22, "water": 23}}` *(สั่งปั๊ม 4 ตัวตรงบน GPIO ของ Pi 5; หยุดฉุกเฉินผ่าน `POST /api/mixer/stop-live`)* |
| `/api/mixer/status` | `POST` | Web/ESP32 $\rightarrow$ Flask | **Req:** `{"job_id": 5, "status": "mixing", "final_tds_ppm": null}` *(ส่งเมื่อปั๊มหยุดทำงานเพื่อรอผู้ใช้จุ่มวัด TDS หรือส่ง `"status": "ready"` เมื่อยืนยันค่าแล้ว)*<br>**Resp `200`:** `{"ok": true, "status": "mixing"}` |
| `/api/mixer/check-ec` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `{"job_id": 5, "mode": "sim", "simulated": true}`<br>**Resp `200`:** `{"measured_tds_ppm": 780, "safe_ec_max_ppm": 1000, "needs_dilution": false, "add_water_ml": 0.0, "add_water_sec": 0.0, "message": "ค่าความเค็มอยู่ในเกณฑ์ปลอดภัย"}` |
| `/api/drone/mission` | `POST` | Web UI $\rightarrow$ Flask Drone | **Req:** `{"plot_id": 1, "job_id": 5, "mode": "survey_photo", "execution_mode": "SIMULATED", "waypoints_cm": [...]}` *(`mode` รับค่า `"survey_photo"` สำหรับบินสำรวจรอบที่ 1 หรือ `"spray_fertilizer"` สำหรับบินพ่นปุ๋ยรอบที่ 2)*<br>**Resp `200`:** `{"ok": true, "execution_mode": "SIMULATED", "mode": "survey_photo", "status": "completed", "message": "..."}` |
| `/api/drone/analyze-image` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `multipart/form-data` (`image` file + `plot_id` + `mode`)<br>**Resp `200`:** `{"green_coverage_pct": 64.2, "mask_image_url": "/static/uploads/mask_sim_1.png"}` |
| `/api/ml/metrics` | `GET` | Web UI $\leftarrow$ Flask | **Resp `200`:** `{"model_name": "RandomForestRegressor (scikit-learn)", "n_estimators": 80, "training_samples": 36000, "r2_score": 0.9670, "mae_g_m2": 0.0410, "feature_importances_pct": {...}}` |
| `/api/config` | `GET`/`POST` | Web UI $\leftrightarrow$ Flask | **JSON:** `{"q_pump_n": 3.03, "q_pump_p": 2.0, "q_pump_k": 6.4, "q_pump_water": 22.08, "c_bio_n": 2.0, "c_bio_p2o5": 2.0, "c_bio_k2o": 2.0, "water_tds_ppm": 150.0, "table_width_cm": 40.0, "table_height_cm": 60.0}` |

---

## 6. ค่าคงที่อ้างอิงและ State Machine กลาง (ห้ามเปลี่ยนแปลงโดยพลการ)

### 6.1 ตารางแปลงผล LDD Soil Test Kit (`MANUAL`) เป็นค่าตัวแทนสมมติ `mg/kg`
*(หมายเหตุทางวิชาการ: ชุดตรวจดินภาคสนาม LDD ให้ผลเชิงกึ่งปริมาณ จึงกำหนดค่าตัวแทนสมมติเทียบเคียงช่วงเกณฑ์วิเคราะห์ดินของกรมพัฒนาที่ดินไว้ใน `config.py` เพื่อให้ทีมทุกคนคำนวณตรงกัน รองรับทั้งแบบ 3 ระดับและ 5 ระดับ)*:
- **ไนโตรเจน (N):** `very_low` = `2.5`, `low` = `5.0`, `medium` = `15.0`, `high` = `30.0`, `very_high` = `45.0 mg/kg`
- **ฟอสฟอรัส (P — เทียบช่วง Bray II):** `very_low` = `2.0`, `low` = `5.0`, `medium` = `15.0`, `high` = `30.0`, `very_high` = `50.0 mg/kg`
- **โพแทสเซียม (K — เทียบช่วง NH₄OAc):** `very_low` = `20.0`, `low` = `30.0`, `medium` = `60.0`, `high` = `100.0`, `very_high` = `130.0 mg/kg`

### 6.2 ตารางความหนาแน่นมวลดินอ้างอิงแม่ฮ่องสอน ($\rho_{\text{soil}}$)
- `sandy_loam` (ดินร่วนปนทราย) = `1.55 g/cm³`
- `sandy_clay_loam` (ดินร่วนเหนียวปนทราย) = `1.45 g/cm³`
- `clay_loam` (ดินร่วนเหนียว) = `1.40 g/cm³`
- `loam` (ดินร่วน) = `1.35 g/cm³`
- `clay` (ดินเหนียว) = `1.25 g/cm³`

### 6.3 State Machine ของคำสั่งผสมปุ๋ย (`mixing_jobs.status`)
1. `pending` — คำนวณสูตรเสร็จ รอ ESP32 #2 ดึงคำสั่งผ่าน `GET /api/mixer/command`
2. `mixing` — ESP32 #2 รับคำสั่งไปแล้ว กำลังเปิดปั๊ม N, P, K, น้ำเปล่า ทีละตัว
3. `diluting` — หลังผสมพบ `mixer_tds_ppm > safe_ec_max_ppm` กำลังสั่งปั๊มน้ำเปล่าเติมเจือจางเพิ่ม
4. `ready` — ผ่านเกณฑ์ EC ปลอดภัย พร้อมตักน้ำปุ๋ยใส่ตลับพ่นโดรน
5. `sprayed` — โดรนรอบที่ 2 ปฏิบัติภารกิจพ่นปุ๋ยเสร็จสิ้น

---

---

## 7. ที่มาของข้อมูล เอกสารอ้างอิงที่ตรวจสอบแล้ว และผลการประเมินโมเดล Random Forest

### 7.1 แหล่งอ้างอิงเป้าหมายธาตุอาหารและเกณฑ์ดิน (ตรวจสอบจากเอกสาร PDF ต้นฉบับแล้ว)
| พืช / หัวข้อ | ข้อมูลและเกณฑ์ที่ยืนยันจากเอกสารต้นฉบับ | แหล่งอ้างอิง |
|---|---|---|
| **ข้าว (ตารางวิเคราะห์ดิน & ช่วง pH)** | • ช่วง pH เหมาะสม: **5.5–6.5** (หน้า 2)<br>• เกณฑ์ความอุดมสมบูรณ์ดินนา (หน้า 1): OM <1% (ต่ำ), 1–2% (ปานกลาง), >2% (สูง); ฟอสฟอรัสที่เป็นประโยชน์ (P): **<5 ppm (ต่ำ), 5–10 ppm (ปานกลาง), >10 ppm (สูง)**; โพแทสเซียมที่สกัดได้ (K): **<60 ppm (ต่ำ), 60–80 ppm (ปานกลาง), >80 ppm (สูง)**<br>• อัตราใส่ตามค่าวิเคราะห์ดิน: ข้าวไวแสง N = 9 / 6 / 3 กก./ไร่ (ตาม OM ต่ำ/กลาง/สูง), ข้าวไม่ไวแสง N = 18 / 12 / 6 กก./ไร่; P₂O₅ = 6 / 3 / 0 กก./ไร่; K₂O = 6 / 3 / 0 กก./ไร่ | กรมการข้าว: *ข้าวงามเพราะดินดี (การใส่ปุ๋ยตามค่าวิเคราะห์ดิน)* (`files-rice-1749007694793.pdf`) และ *คู่มือการใช้ปุ๋ยไนโตรเจนตามค่าวิเคราะห์ดิน* (`files-rice-1775720306069.pdf`) |
| **ข้าวไวต่อช่วงแสง ปักดำ (ค่าตั้งต้นรายระยะ)** | • ครั้งที่ 1 (ปักดำ): 16-20-0 อัตรา 20–25 กก./ไร่ (ค่ากลาง 22.5 กก./ไร่ → N 3.6, P₂O₅ 4.5 กก./ไร่ = **2.25, 2.81 g/m²**)<br>• ครั้งที่ 2 (กำเนิดช่อดอก 30 วันก่อนออกดอก): ยูเรีย 46-0-0 อัตรา 10 กก./ไร่ (N 4.6 กก./ไร่ = **2.88 g/m²**); ข้าวไวแสงแบ่งใส่ 2 ครั้ง (ระยะแตกกอ = 0)<br>• เขตรากดูดซึมหลัก (Effective Root Zone): **0.25 m** | กรมการข้าว Rice Knowledge Bank (`A-RSMV0T688W`) & เกณฑ์ชลประทานกรมการข้าว |
| **ถั่วลิสง / ถั่วลายเสือ (พันธุ์ กวก. กาฬสินธุ์ 2, KAC 431)** | • ถั่วลายเสือแม่ฮ่องสอน (ทะเบียน GI สช 64100153) คือ **พันธุ์กาฬสินธุ์ 2 (Kalasin Accession #431)** ดินปลูกใน อ.เมือง, ปางมะผ้า, **ขุนยวม**, ปาย เป็นดินร่วน/ร่วนปนทราย/ร่วนเหนียว **pH 5.5–6.8, OM >1.5%**<br>• ปุ๋ยตั้งต้น (Default): คลุกเมล็ดด้วยไรโซเบียม 200 กรัม/เมล็ด 12 กก. ร่วมกับปุ๋ย **12-24-12 อัตรา 25 กก./ไร่** (หรือ 18-46-0 @ 17 กก./ไร่ + 0-0-60 @ 10 กก./ไร่) ให้เนื้อธาตุ **3-6-3 กก. N-P₂O₅-K₂O/ไร่** แบ่งครึ่งใส่ช่วงต้นกล้าและเจริญเติบโต → ระยะละ **0.94, 1.88, 0.94 g/m²** (ใช้สูตร LDD 3-9-6 เป็น Conditional Rule เมื่อตรวจดินพบ P, K ต่ำมาก)<br>• ระยะ R2 (เริ่มแทงเข็มลงดิน อายุ 30–35 วัน): โรย **ยิปซัม 50–100 กก./ไร่** เสริมแคลเซียม (Ca) ให้ฝักสมบูรณ์ (N-P₂O₅-K₂O = 0)<br>• เขตรากหาอาหารหลัก + Pod Zone: **0.30 m** | กรมวิชาการเกษตร: *เทคโนโลยีการผลิตถั่วลิสง* (`E-Book-8.pdf`, หน้า 11–12) & คู่มือคำขอขึ้นทะเบียน GI *ถั่วลายเสือแม่ฮ่องสอน* (`630402-1359.pdf`, หน้า 14, 25–26) |
| **กระเทียม (พันธุ์กลาง สายพันธุ์ปาย จ.แม่ฮ่องสอน)** | • แบ่งใส่ 5 ระยะ: ปลูก–ตั้งตัว (3.75/3.75/3.75), ทางใบ (2.80/2.20/2.20), เริ่มลงหัว (1.50/1.50/4.00), พัฒนาหัว (0/1.00/3.00), เก็บเกี่ยว (0/0/0 g/m²)<br>• เขตรากหาอาหารหลัก **0.25 m**, ช่วง pH **6.0–7.5**, EC ≤ **900 ppm** | กรมวิชาการเกษตร / สวพ.1 & เกณฑ์ปุ๋ยกระเทียมแม่ฮ่องสอน |
| **ข้าวโพดเลี้ยงสัตว์ (5 สายพันธุ์ × 9 ระยะ)** | • พันธุ์ลูกผสมการค้า, นครสวรรค์ 3/4, นครสวรรค์ 5, สุวรรณ 1, สุวรรณ 5/4452<br>• ใส่ 4 ระยะแรก: VE (4.22/4.22/4.22), V1–V(n) (5.63/0/2.81), VT (2.50/0/1.50), R1 (1.25/0/1.00 g/m²); ระยะ R2–R6 = 0<br>• เขตรากหาอาหารหลัก **0.35 m**, ช่วง pH **5.5–7.0**, EC ≤ **1,000 ppm** | กรมวิชาการเกษตร / กรมส่งเสริมการเกษตร |

### 7.2 การจำลองข้อมูลดินแม่ฮ่องสอน (อิงเกณฑ์กรมการข้าวและกรมพัฒนาที่ดิน)
ครอบคลุมช่วงตั้งแต่ดินขาดธาตุอาหารรุนแรงไปจนถึงดินอุดมสมบูรณ์สูงตามตารางวิเคราะห์ดินของกรมการข้าว (P <5 ถึง >10 ppm, K <60 ถึง >80 ppm) และกรมพัฒนาที่ดิน:

| ตัวแปร | การแจกแจงที่ใช้ | เหตุผลอ้างอิง |
|---|---|---|
| pH | Normal(5.9, 0.55) ตัดที่ 4.5–7.2 | ครอบคลุมช่วงเหมาะสมของข้าว (5.5–6.5), ถั่วลายเสือแม่ฮ่องสอน (5.5–6.8), ข้าวโพด (5.5–7.0), กระเทียม (6.0–7.5) และดินกรดจัด (<5.5) |
| P (Bray II) mg/kg | Log-normal median 8.0, σ=0.75, ตัดที่ 1–60 | ครอบคลุมเกณฑ์ต่ำ (<5 ppm), ปานกลาง (5–10 ppm) และสูง (>10–45 ppm) |
| K mg/kg | Log-normal median 55.0, σ=0.65, ตัดที่ 5–150 | ครอบคลุมเกณฑ์ต่ำของนาข้าว (<60 ppm), ปานกลาง (60–80 ppm) และสูง (>80 ppm) |
| N แร่ธาตุ mg/kg | Log-normal median 12.0, σ=0.6, ตัดที่ 2–60 | ตัวแทนระดับ N ที่ปลดปล่อยจากอินทรียวัตถุ (%OM <1% ถึง >2%) |
| ความชื้นดิน % | นาข้าว 21.5–85.0%, พืชไร่ 15.0–75.0% | นาข้าวเริ่มตั้งแต่ความชื้นแปลงทดลอง (21.5–27.2%) ถึงสภาพอิ่มตัว/ขังน้ำตื้น |
| ความหนาแน่นดิน | สุ่มจาก 1.25 / 1.35 / 1.40 / 1.45 / 1.55 g/cm³ | ดินเหนียว / ดินร่วน / ดินร่วนเหนียว / ดินร่วนเหนียวปนทราย / ดินร่วนปนทราย ในแม่ฮ่องสอน |
| ExG % | Normal ตามระยะ (35 / 60 / 55), σ=12 | ดัชนีความเขียวทรงพุ่มจากโดรนตามระยะการเจริญเติบโต |

### 7.3 ชุดข้อมูลและโมเดล
- ชุดข้อมูล: `app/data/agronomic_rf_dataset.csv` (36,000 ตัวอย่าง = 120 โปรไฟล์ × 300) | สคริปต์: `app/train_rf.py` และโน้ตบุ๊ก `app/train_rf_colab.ipynb`
- โมเดล: `app/data/rf_fertilizer_model.joblib` (บีบอัด `compress=3` ~16.66 MB) | รายงาน: `app/data/rf_evaluation_report.json`
- **หมายเหตุความโปร่งใส:** Target (`deficit_*_g_m2`) คำนวณจากสูตรปฐพีวิทยาไม่เป็นเชิงเส้น (ผลของ pH ต่อการตรึง P, ความชื้นดินต่อการแพร่, และ ExG ต่อความต้องการ N ทางใบ) ร่วมกับเกณฑ์พืชข้างต้น ค่า R² จึงสะท้อนความแม่นยำในการเรียนรู้ฟังก์ชันปฐพีวิทยาของโมเดล

### 7.4 ผลการประเมินโมเดล (Hold-out 80:20 และ 5-Fold Cross-Validation)
แบ่ง Train 28,800 / Test 7,200 ตัวอย่าง (Stratify ตาม `crop_profile_id`)

| Target | R² (hold-out) | RMSE (g/m²) | MAE (g/m²) | R² (5-fold CV) | RMSE (CV) | MAE (CV) |
|---|---|---|---|---|---|---|
| N | 0.9716 | 0.1699 | 0.0717 | 0.9678 ± 0.0020 | 0.1814 | 0.0740 |
| P2O5 | 0.9727 | 0.1103 | 0.0375 | 0.9715 ± 0.0020 | 0.1137 | 0.0372 |
| K2O | 0.9568 | 0.0634 | 0.0139 | 0.9546 ± 0.0040 | 0.0661 | 0.0141 |
| overall | 0.9670 | 0.1225 | 0.0410 | 0.9646 ± 0.0023 | 0.1294 | 0.0418 |

**Feature Importance (%):**

| Feature | % |
|---|---|
| `crop_profile_id` | 71.52 |
| `soil_k_mg_kg` | 11.60 |
| `soil_p_mg_kg` | 6.46 |
| `soil_n_mg_kg` | 5.49 |
| `exg_green_pct` | 2.57 |
| `root_depth_m` | 0.95 |
| `moisture_pct` | 0.59 |
| `ph_value` | 0.53 |
| `bulk_density_g_cm3` | 0.29 |
| `exg_green_pct` | 0.17 |
| `moisture_pct` | 0.16 |
