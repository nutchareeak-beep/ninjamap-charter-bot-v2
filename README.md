# Ninjamap Community Charter Bot

บอทนี้สร้างและดูแลห้อง `#ข้อตกลงและเงื่อนไข` สำหรับ Ninjamap Community Charter 2026 เท่านั้น

เวอร์ชันนี้ยังไม่ล็อก role, ไม่ถอด role, ไม่คืน role และไม่กระทบสมาชิกคนใด

## สิ่งที่บอททำ

- สร้าง channel `#ข้อตกลงและเงื่อนไข`
- ถ้าไม่ได้ตั้ง `CHARTER_CATEGORY_ID` บอทจะสร้าง channel ใต้ category เดียวกับ channel อ้างอิง `1158357016570503208`
- โพสต์ Ninjamap Community Charter 2026
- ให้สมาชิกกดยอมรับทีละ section ตามลำดับ
- บันทึก Discord User ID, username, accepted sections, timestamp และ charter version
- มีคำสั่ง `/export-acceptance-logs`
- มี test mode สำหรับ role Coach ก่อนเปิดใช้จริง
- มีคำสั่ง test lock รายคน โดยจัดการเฉพาะ role `user`, `Membership`, `นักเรียน`, `Member`, `Free`

## Setup

1. ติดตั้ง dependencies

```bash
npm install --cache .npm-cache
```

2. สร้างไฟล์ `.env` จาก `.env.example`

```bash
cp .env.example .env
```

3. ใส่ค่าใน `.env`

```env
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=1157250991490609223
REFERENCE_CHANNEL_ID=1158357016570503208
TEST_MODE=true
COACH_ROLE_ID=
COACH_ROLE_NAME=Coach
MANAGED_ROLE_NAMES=user,Membership,นักเรียน,Member,Free
PROTECTED_ROLE_NAMES=Admin,Staff,Bot
```

ถ้าต้องการบังคับ category เอง ให้ใส่:

```env
CHARTER_CATEGORY_ID=
```

4. ลงทะเบียน slash command

```bash
npm run register
```

5. เปิดบอท

```bash
npm start
```

## Test Mode

เมื่อ `TEST_MODE=true`:

- ถ้าใส่ `COACH_ROLE_ID` บอทจะสร้าง channel ใหม่โดยให้ role Coach เห็น channel สำหรับทดสอบ
- เฉพาะคนที่มี role Coach เท่านั้นที่กดปุ่ม acceptance ได้
- บอทยังไม่แตะ role อื่นใด

## Logs

Acceptance logs จะถูกเก็บที่:

```text
data/acceptance-logs.json
```

แอดมินสามารถใช้คำสั่งนี้ใน Discord เพื่อ export เป็น CSV:

```text
/export-acceptance-logs
```

## Test Lock

ใช้ทดสอบกับสมาชิกทีละคนก่อนเท่านั้น:

```text
/reverify-lock-test member:@name apply:false
```

ถ้า dry-run ถูกต้องแล้วค่อยใช้:

```text
/reverify-lock-test member:@name apply:true
```

คำสั่งนี้จะ snapshot และถอดเฉพาะ role:

```text
user, Membership, นักเรียน, Member, Free
```

เมื่อสมาชิกกดยอมรับ Charter ครบทุกข้อ บอทจะคืน role เดิมจาก snapshot ให้อัตโนมัติ

ถ้าต้อง rollback เอง:

```text
/reverify-rollback-test member:@name
```
