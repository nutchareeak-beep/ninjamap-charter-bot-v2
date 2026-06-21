# Deploy Ninjamap Charter Bot

บอท Discord ต้องรันตลอดเวลาเพื่อให้ปุ่มยืนยันทำงาน ถ้าไม่อยากเปิดคอมทิ้งไว้ ให้ deploy เป็น worker บน Railway หรือ Render

## ก่อน deploy

ห้ามเอาไฟล์ `.env` ขึ้น GitHub เพราะมี token ของบอทอยู่แล้ว ไฟล์ `.gitignore` กันไว้ให้แล้ว

ค่าที่ต้องใส่บนเว็บโฮสต์:

```env
DISCORD_TOKEN=token ของบอท
CLIENT_ID=1518267640345264158
GUILD_ID=1157250991490609223
REFERENCE_CHANNEL_ID=1158357016570503208
CHARTER_CATEGORY_ID=
TEST_MODE=true
COACH_ROLE_ID=
COACH_ROLE_NAME=Coach
MANAGED_ROLE_NAMES=user,Membership,นักเรียน,Member,Free
PROTECTED_ROLE_NAMES=Admin,Staff,Bot
CHARTER_CHANNEL_NAME=ข้อตกลงและเงื่อนไข
CHARTER_VERSION=ninjamap-community-charter-2026
LOG_CHANNEL_ID=
DATA_DIR=./data
```

ถ้าใช้ Render พร้อม persistent disk ให้ตั้ง:

```env
DATA_DIR=/var/data
```

## Railway

1. สร้าง GitHub repository ใหม่
2. อัปโหลดโปรเจกต์นี้ขึ้น GitHub
3. เข้า Railway แล้วเลือก New Project
4. เลือก Deploy from GitHub repo
5. เพิ่ม Variables ตามรายการด้านบน
6. Railway จะใช้ `npm start` จาก `railway.toml`

## Render

1. สร้าง GitHub repository ใหม่
2. อัปโหลดโปรเจกต์นี้ขึ้น GitHub
3. เข้า Render แล้วเลือก New Background Worker
4. เลือก repository นี้
5. ตั้ง Build Command:

```bash
npm install
```

6. ตั้ง Start Command:

```bash
npm start
```

7. เพิ่ม Environment Variables ตามรายการด้านบน
8. เพิ่ม Persistent Disk ขนาดเล็ก แล้ว mount ที่ `/var/data`

## หลัง deploy

เมื่อ service online แล้ว บอทจะ:

- ลงทะเบียนคำสั่ง `/export-acceptance-logs`
- หา/สร้างห้อง `#ข้อตกลงและเงื่อนไข`
- โพสต์ Charter ถ้ายังไม่มี
- รอรับการกดปุ่มยืนยัน

ตอนนี้ยังไม่มีโค้ดถอด role, คืน role, หรือแก้ role สมาชิกใด ๆ
