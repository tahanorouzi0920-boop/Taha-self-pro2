# Taha Self Pro

ربات شخصی تلگرام روی Cloudflare Workers و D1. امتیازها مجازی هستند و بازی‌ها فقط امتیاز رایگان می‌دهند.

## راه‌اندازی
1. `npm install`
2. ساخت دیتابیس: `npx wrangler d1 create taha-self-pro-db` و شناسه را در `wrangler.toml` بگذار.
3. اجرای مهاجرت: `npm run db:init`
4. Secret ها:
   - `npx wrangler secret put BOT_TOKEN`
   - `npx wrangler secret put WEBHOOK_SECRET` (یک رشته تصادفی)
   - `npx wrangler secret put PANEL_TOKEN` (رمز پنل)
5. `ADMIN_TELEGRAM_ID` را در `wrangler.toml` با شناسه عددی خودت پر کن.
6. دیپلوی: `npm run deploy`
7. ثبت Webhook:
   `curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker>/webhook/<WEBHOOK_SECRET>"`

## دستورات
کاربر: /start /help /profile /balance /موجودی /top /games /بازی سطح /transfer آیدی مقدار
مدیر: /grant /block /unblock /stats /logs /پاسخ کلمه | متن

## محدودیت‌ها
- اتصال حساب شخصی MTProto در این نسخه پیاده‌سازی نشده (نیاز به سرویس جداگانه دارد).
- محدودیت نرخ درخواست (rate limit) و پنل کامل با همه صفحات هنوز ساخته نشده‌اند.
- هیچ بازی با پول واقعی یا برداشت پولی وجود ندارد.

## تنظیمات مدیر (روشن/خاموش)
- `/settings` وضعیت را نشان می‌دهد.
- `/settings امتیاز off` سیستم امتیاز (افزایش، کسر، انتقال) را خاموش می‌کند.
- `/settings بازی off` بازی‌ها را خاموش می‌کند.
- `/deduct آیدی مقدار` امتیاز مجازی را کم می‌کند (فقط برای تست).
