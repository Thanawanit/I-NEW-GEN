# Software Architecture, Mathematical Formulas & Crop Database Spec

> **วัตถุประสงค์เอกสาร:** กำหนดสถาปัตยกรรมซอฟต์แวร์ โครงสร้างฐานข้อมูลพืช/พันธุ์/ระยะการเจริญเติบโต ชุดสูตรคำนวณทางคณิตศาสตร์ทั้งหมด (พร้อมตัวอย่างการแทนค่า) และ API Contract สำหรับเชื่อมต่อเว็บ, โดรน และบอร์ด ESP32

---

## 1. สถาปัตยกรรมซอฟต์แวร์ (Software Stack)

| เลเยอร์ | เทคโนโลยีที่กำหนด | หน้าที่หลัก |
| :--- | :--- | :--- |
| **Frontend (Map & UI)** | HTML5 + CSS + JavaScript + **Leaflet.js** + **Leaflet.draw** (`L.GeometryUtil.geodesicArea`) + **Esri World Imagery / OpenStreetMap** | วาด Polygon ขอบเขตแปลงบนแผนที่ภาพถ่ายดาวเทียมฟรี (**ไม่ต้องใช้บัตรเครดิต/API Key**), คำนวณพื้นที่ ($\text{m}^2$) แบบ Geodesic พร้อมช่องให้ผู้ใช้แก้ไขเลขเอง, ฟอร์มเลือกพืช/พันธุ์/ระยะเติบโต, และ Dashboard แสดงผลเรียลไทม์ |
| **Backend Server** | **Python Flask** (`host='0.0.0.0'`, พอร์ต `5000`) | คำนวณสูตรปุ๋ยและระยะบิน, ประมวลผลภาพถ่ายโดรน, สื่อสารกับโดรนผ่าน USB Wi-Fi, และเปิด REST API ให้ ESP32 ส่งค่า/รับคำสั่ง |
| **Image Processing** | **OpenCV (`cv2`) + NumPy** | อ่านภาพถ่ายจากโดรนรอบที่ 1 (OpenCV อ่านสีเป็น **BGR** ต้องแปลงเป็น `int16` ก่อนคำนวณ $2G - R - B$ เพื่อป้องกัน `uint8` overflow) |
| **Database** | **SQLite** | จัดเก็บข้อมูลแปลงเกษตร, เกณฑ์ธาตุอาหารพืช 3 ชนิด, ค่าตรวจดินสด, สถานะถังหมัก 3 ถัง และประวัติการสั่งผสม/บินพ่น |
| **IoT Firmware** | Arduino C++ (สำหรับ **ESP32 #1** ชุดดิน และ **ESP32 #2** เครื่องหมัก/ผสม) | อ่านค่าเซนเซอร์และยิง HTTP POST/GET JSON เข้า Flask Server ผ่าน Wi-Fi วงเดียวกับโน้ตบุ๊ก |

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

-- 3. ตารางบันทึกค่าดิน (จาก ESP32 #1 + ชุดตรวจดิน)
CREATE TABLE soil_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plot_id INTEGER NOT NULL,
    nitrogen_mg_kg REAL,
    phosphorus_mg_kg REAL,
    potassium_mg_kg REAL,
    ph_value REAL,
    moisture_pct REAL,
    ec_us_cm REAL,
    source TEXT NOT NULL,             -- 'esp32_live' หรือ 'manual_testkit'
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. ตารางสถานะถังหมักชีวภาพ 3 ถัง (จาก ESP32 #2)
CREATE TABLE fermenter_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temp_n_c REAL,
    temp_p_c REAL,
    temp_k_c REAL,
    temp_mixer_c REAL,                -- อุณหภูมิน้ำในถังผสม (ถ้ามี DS18B20 ตัวที่ 4)
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

## 3. ตารางเกณฑ์พืชเป้าหมาย 3 ชนิด (อ้างอิงสัดส่วนตามข้อมูลกรมวิชาการเกษตร & ARDA)

> **หมายเหตุทางวิชาการ:** ค่าเป้าหมายทั้ง 3 ระยะต่อฤดู/ปีด้านล่างปรับสัดส่วนให้สอดคล้องกับปริมาณธาตุอาหารที่พืชดูดใช้จริงตามข้อมูลกรมวิชาการเกษตร (ข้าวโพด ~18-8-11 กก./ไร่ ที่ 1 ตัน/ไร่, ถั่วลิสง ~7-0.9-2.3 กก./ไร่ ที่ 300 กก./ไร่ โดยตรึง N เองได้บางส่วน, กาแฟอราบิก้า ~25-2.5-27.5 กก./ไร่/ปี ที่ 700 กก./ไร่ แปลงเป็น $\text{g/m}^2$ โดย $\div 1.6$) โดยยังต้องเทียบตารางระดับดิน (ต่ำ/กลาง/สูง) จากคู่มือปุ๋ยสั่งตัดฉบับเต็ม (2565) ตามพันธุ์เฉพาะถิ่นจริงอีกครั้ง

| ชนิดพืช | พันธุ์ตัวอย่าง | ระยะการเจริญเติบโต | ความลึกราก ($d_{\text{root}}$) | เป้าหมาย $\text{N}$ ($\text{g/m}^2$) | เป้าหมาย $\text{P}_2\text{O}_5$ ($\text{g/m}^2$) | เป้าหมาย $\text{K}_2\text{O}$ ($\text{g/m}^2$) | ช่วง pH | EC พ่นปลอดภัย ($\text{ppm}$) |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **ข้าวโพดเลี้ยงสัตว์** | ลูกผสมทั่วไป | 1. ระยะต้นกล้า/รองพื้น (0–20 วัน) | 0.15 m | 2.50 | 2.00 | 1.50 | 5.5–7.0 | ≤ 800 |
| **ข้าวโพดเลี้ยงสัตว์** | ลูกผสมทั่วไป | 2. ระยะเจริญเติบโต/ทำรุ่น (21–45 วัน) | 0.25 m | 6.00 | 1.50 | 2.50 | 5.5–7.0 | ≤ 1,000 |
| **ข้าวโพดเลี้ยงสัตว์** | ลูกผสมทั่วไป | 3. ระยะออกดอก–ติดฝัก (46+ วัน) | 0.30 m | 2.75 | 1.50 | 2.88 | 5.5–7.0 | ≤ 1,000 |
| **ถั่วลิสงพันธุ์ลายเสือ** | พันธุ์พื้นเมืองแม่ฮ่องสอน | 1. ระยะต้นกล้า (0–20 วัน) | 0.15 m | 1.00 | 0.20 | 0.40 | 5.5–6.8 | ≤ 700 |
| **ถั่วลิสงพันธุ์ลายเสือ** | พันธุ์พื้นเมืองแม่ฮ่องสอน | 2. ระยะเจริญเติบโต (21–45 วัน) | 0.20 m | 1.50 | 0.20 | 0.50 | 5.5–6.8 | ≤ 900 |
| **ถั่วลิสงพันธุ์ลายเสือ** | พันธุ์พื้นเมืองแม่ฮ่องสอน | 3. ระยะลงเข็ม–ติดฝัก (46+ วัน) | 0.25 m | 0.50 | 0.16 | 0.54 | 5.5–6.8 | ≤ 900 |
| **กาแฟอราบิก้า** | คาทิมอร์ (Catimor) | 1. ระยะต้นกล้า/ฟื้นต้นหลังเก็บเกี่ยว | 0.20 m | 3.00 | 0.40 | 2.00 | 5.0–6.2 | ≤ 800 |
| **กาแฟอราบิก้า** | คาทิมอร์ (Catimor) | 2. ระยะแตกทรงพุ่ม/บำรุงใบ | 0.30 m | 8.00 | 0.56 | 4.00 | 5.0–6.2 | ≤ 1,000 |
| **กาแฟอราบิก้า** | คาทิมอร์ (Catimor) | 3. ระยะติดผล–บำรุงเมล็ด | 0.35 m | 4.50 | 0.60 | 11.00 | 5.0–6.2 | ≤ 1,000 |

*(ค่าความหนาแน่นดินอ้างอิงเบื้องต้น $\rho_{\text{soil}}$: ดินร่วนทราย $\approx 1.45\ \text{g/cm}^3$, ดินร่วน $\approx 1.35\ \text{g/cm}^3$, ดินร่วนเหนียว $\approx 1.25\ \text{g/cm}^3$)*

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
   *(ตัวอย่าง: ถ้า $\Delta X=40, \Delta Y=0$ จะได้ $\text{heading} = 90^\circ$ คือเลี้ยวขวา $90^\circ$ จากทิศเหนือ และหากระยะ $d_i < 20\text{ cm}$ ให้รวมช่วงนี้เข้ากับจุดถัดไปก่อนสั่งบิน)*

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

2. **แปลงรูปธาตุบริสุทธิ์เป็นรูปปุ๋ยออกไซด์และคูณสัมประสิทธิ์การดูดใช้ได้ต่อฤดู** ($f_N = 0.30,\ f_P = 0.20,\ f_K = 0.15$ เพื่อสะท้อนสัดส่วนที่พืชดูดใช้ได้จริงจากดินใน 1 ระยะ):
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

### สูตรที่ 5: คำนวณปริมาตรน้ำหมัก, ย่อสเกล Demo และเวลาเปิดปั๊ม (Pump Runtime)

1. **ปริมาตรน้ำหมักที่ต้องการจริงตามทฤษฎี** (เมื่อความเข้มข้นน้ำหมักแต่ละถังคือ $C_{\text{bio}, i}$ หน่วย $\text{mg/ml}$ ของ $\text{N}, \text{P}_2\text{O}_5, \text{K}_2\text{O}$ จากค่า Placeholder ใน `config.py` — ตั้งเท่ากัน `2.0 mg/ml` ทั้ง 3 ถังเพื่อรักษาสัดส่วน $\Delta M$ จนกว่าคนที่ 4 จะวัดค่าจริง):
   $$V_{\text{real}, i}\ (\text{ml}) = \frac{\Delta M_i\ (\text{g}) \times 1000}{C_{\text{bio}, i}\ (\text{mg/ml})}$$
2. **การย่อสเกลปริมาตรสำหรับผสมโชว์บนโต๊ะ (Demo Batch Scaling):**
   ผสมในถังกลางปริมาตรรวม $V_{\text{batch}} = 200\text{ ml}$ โดยล็อกปริมาณน้ำหมักรวมคงที่ $V_{\text{demo\_bio}} = 80\text{ ml}$ และใช้ $\Delta M$ กำหนด **อัตราส่วน N : P : K** (ส่วนที่เหลือ $120\text{ ml}$ เป็นน้ำเปล่าเจือจาง):
   $$V_{\text{demo}, i} = V_{\text{demo\_bio}} \times \frac{V_{\text{real}, i}}{V_{\text{real, N}} + V_{\text{real, P}} + V_{\text{real, K}}}$$
   *(กรณีที่ดินไม่ขาดธาตุใดเลย คือผลรวม $V_{\text{real}} = 0$ ให้คืนค่าเวลาทุกปั๊มเป็น `0.0 s` และแจ้งเตือนบนเว็บว่า "ดินมีความสมบูรณ์เพียงพอ ไม่ต้องเติมปุ๋ย")*

3. **คำนวณเวลาเปิด-ปิดปั๊ม 4 ตัว ($t_{\text{pump}, i}$) พร้อม Minimum Runtime Guard:**
   $$t_{\text{pump}, i}\ (\text{วินาที}) = \frac{V_{\text{demo}, i}\ (\text{ml})}{Q_{\text{pump}, i}\ (\text{ml/s})}$$
   - **กติกาเดียวป้องกัน Pump Dead-Time:** ก่อนเริ่มสั่งงานต้องไล่น้ำเต็มสายยางทุกเส้น (Pre-priming) และหากปั๊มธาตุใดคำนวณเวลาได้ $0 < t_{\text{pump}, i} < 1.5\text{ s}$ ให้ **ตัดเป็น `0.0 s`** แล้วย้ายปริมาตรส่วนนั้นไปบวกในน้ำเปล่าเพื่อให้รวมยังเป็น $200\text{ ml}$ (API แปลงเป็นมิลลิวินาทีด้วย `round(sec * 1000)`)
   > **ตัวอย่างคำนวณ:** ปั๊ม N มี $Q = 5.0\ \text{ml/s}$, ปริมาตร $V_{\text{demo, N}} = 68.8\text{ ml} \rightarrow t_{\text{pump, N}} = 68.8 / 5.0 = 13.77\text{ s}$ (`13766 ms`)

4. **ลูปตรวจเช็กความเค็มและเจือจาง TDS/EC อัตโนมัติ (Salinity/Osmotic Burn Guard):**
   หลังเปิดปั๊มครบ 4 ตัว ให้ผู้ใช้กวนถังผสมแล้วจุ่มหัววัด รอ **5 วินาที** แล้วกดปุ่มตรวจบนเว็บ (ให้ ESP32 อ่านค่า 30 ครั้งแล้วใช้ค่า **มัธยฐาน** เพื่อลดสัญญาณรบกวน):
   - *(หมายเหตุ: คอลัมน์ `safe_ec_max_ppm` เก็บเป็นค่า TDS หน่วย ppm โดย $\text{TDS ppm} = \text{EC }\mu\text{S/cm} \times 0.5$ และห้ามนำค่านี้ไปเทียบตรงๆ กับ `ec_us_cm` ของดิน)*
   - ถ้า `mixer_tds_ppm` $\le$ `safe_ec_max_ppm` $\rightarrow$ สถานะ = `'ready'` (อนุญาตให้ตักขึ้นโดรนได้ และล้างหัววัดด้วยน้ำสะอาด)
   - ถ้า `mixer_tds_ppm` $>$ `safe_ec_max_ppm` $\rightarrow$ Flask คำนวณปริมาตรน้ำเปล่าเติมเพิ่มโดยคิดค่า TDS พื้นฐานของน้ำประปา ($\text{EC}_{\text{water}} \approx 150\ \text{ppm}$):
     $$V_{\text{add\_water}} = V_{\text{current}} \times \frac{\text{EC}_{\text{current}} - \text{EC}_{\text{safe}}}{\text{EC}_{\text{safe}} - \text{EC}_{\text{water}}}$$
     *(ตรวจเช็กความจุถัง: หาก $V_{\text{current}} + V_{\text{add\_water}} > 500\text{ ml}$ ให้หยุดและแจ้งเตือนผู้ใช้แบ่งน้ำปุ๋ยออกครึ่งหนึ่งก่อน)* มิฉะนั้นระบบจะตั้ง `status = 'diluting'`, รีเซ็ตเวลาปั๊ม N/P/K เป็น `0`, และใส่เวลาปั๊มน้ำเปล่า $t_{\text{add}} = V_{\text{add\_water}} / Q_{\text{pump, water}}$ ให้ ESP32 #2 ดึงไปเติมน้ำเจือจางแล้ววัดซ้ำ

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
| `/api/fermenter/latest` | `GET` | Web UI $\leftarrow$ Flask | **Resp `200`:** `{"mode": "live", "telemetry": {"temp_n": 31.2, "temp_p": 30.8, "temp_k": 31.5, "temp_mixer_c": null, "mixer_tds_ppm": 740, "is_ready": true, "recorded_at": "..."}}` |
| `/api/mixer/calculate` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `{"plot_id": 1, "mode": "sim", "crop_profile_id": 2, "confirmed_area_m2": 100.0, "soil_type": "loam"}`<br>**Resp `200`:** `{"job_id": 5, "deficits_g": {"n": 448.1, "p2o5": 72.7, "k2o": 0.0}, "demo_volumes_ml": {"n": 68.8, "p": 11.2, "k": 0.0, "water": 120.0}, "pump_seconds": {"n": 13.77, "p": 2.23, "k": 0.0, "water": 24.0}, "ph_warning": null}` |
| `/api/mixer/command?mode=live` | `GET` | ESP32 #2 $\leftarrow$ Flask | **Resp `200` (มีงานค้าง — แปลงวินาทีเป็น ms ด้วย `round(sec * 1000)`):** `{"has_command": true, "job_id": 5, "pump_n_ms": 13766, "pump_p_ms": 2234, "pump_k_ms": 0, "pump_water_ms": 24000}`<br>**Resp `200` (ไม่มีงาน):** `{"has_command": false, "job_id": null}` |
| `/api/mixer/status` | `POST` | ESP32 #2 $\rightarrow$ Flask | **Req:** `{"job_id": 5, "status": "ready", "final_tds_ppm": 780}`<br>**Resp `200`:** `{"ok": true, "status": "ready"}` |
| `/api/mixer/check-ec` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `{"job_id": 5, "mode": "sim", "simulated": true}`<br>**Resp `200`:** `{"measured_tds_ppm": 780, "safe_ec_max_ppm": 1000, "needs_dilution": false, "add_water_ml": 0.0, "add_water_sec": 0.0, "message": "ค่าความเค็มอยู่ในเกณฑ์ปลอดภัย"}` |
| `/api/drone/mission` | `POST` | Web UI $\rightarrow$ Flask Drone | **Req:** `{"plot_id": 1, "job_id": 5, "mode": "spray_fertilizer", "execution_mode": "SIMULATED", "waypoints_cm": [...]}`<br>**Resp `200`:** `{"ok": true, "execution_mode": "SIMULATED", "status": "completed", "message": "..."}` |
| `/api/drone/analyze-image` | `POST` | Web UI $\rightarrow$ Flask | **Req:** `multipart/form-data` (`image` file + `plot_id` + `mode`)<br>**Resp `200`:** `{"green_coverage_pct": 64.2, "mask_image_url": "/static/uploads/mask_sim_1.png"}` |
| `/api/config` | `GET`/`POST` | Web UI $\leftrightarrow$ Flask | **JSON:** `{"q_pump_n": 5.0, "q_pump_p": 5.0, "q_pump_k": 5.0, "q_pump_water": 5.0, "c_bio_n": 2.0, "c_bio_p2o5": 1.0, "c_bio_k2o": 2.0, "water_tds_ppm": 150.0, "table_width_cm": 40.0, "table_height_cm": 60.0}` |

---

## 6. ค่าคงที่อ้างอิงและ State Machine กลาง (ห้ามเปลี่ยนแปลงโดยพลการ)

### 6.1 ตารางแปลงผล LDD Soil Test Kit (`MANUAL`) เป็นค่าประมาณการ `mg/kg`
ใช้ค่ากลางอ้างอิงต่อไปนี้ใน `config.py` เพื่อให้ทีมทุกคนคำนวณตรงกัน:
- **ไนโตรเจน (N):** `low` = `5.0 mg/kg`, `medium` = `15.0 mg/kg`, `high` = `30.0 mg/kg`
- **ฟอสฟอรัส (P):** `low` = `5.0 mg/kg`, `medium` = `15.0 mg/kg`, `high` = `30.0 mg/kg`
- **โพแทสเซียม (K):** `low` = `30.0 mg/kg`, `medium` = `60.0 mg/kg`, `high` = `100.0 mg/kg`

### 6.2 ตารางความหนาแน่นมวลดินอ้างอิง ($\rho_{\text{soil}}$)
- `sandy_loam` (ดินร่วนปนทราย) = `1.45 g/cm³`
- `loam` (ดินร่วน) = `1.35 g/cm³`
- `clay_loam` (ดินร่วนเหนียว) = `1.25 g/cm³`

### 6.3 State Machine ของคำสั่งผสมปุ๋ย (`mixing_jobs.status`)
1. `pending` — คำนวณสูตรเสร็จ รอ ESP32 #2 ดึงคำสั่งผ่าน `GET /api/mixer/command`
2. `mixing` — ESP32 #2 รับคำสั่งไปแล้ว กำลังเปิดปั๊ม N, P, K, น้ำเปล่า ทีละตัว
3. `diluting` — หลังผสมพบ `mixer_tds_ppm > safe_ec_max_ppm` กำลังสั่งปั๊มน้ำเปล่าเติมเจือจางเพิ่ม
4. `ready` — ผ่านเกณฑ์ EC ปลอดภัย พร้อมตักน้ำปุ๋ยใส่ตลับพ่นโดรน
5. `sprayed` — โดรนรอบที่ 2 ปฏิบัติภารกิจพ่นปุ๋ยเสร็จสิ้น

