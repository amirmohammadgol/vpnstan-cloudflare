# vpnstan Cloudflare Edition

نسخه Cloudflare-only پنل vpnstan، بدون Xray. پنل و مسیر VLESS روی Cloudflare Worker اجرا می‌شوند و از TCP Sockets + WebSocket استفاده می‌کنند.

## نکته مهم
این نسخه برای VLESS/WS ساخته شده است. Cloudflare Worker خودش نقش لایه VLESS را انجام می‌دهد؛ بنابراین Xray در این پروژه وجود ندارد. WireGuard/VMess در این نسخه به‌عنوان تونل اجرایی پیاده‌سازی نشده‌اند.

## نصب
1. یک D1 Database بسازید:
   `npx wrangler d1 create vpnstan`
2. مقدار `database_id` را در `wrangler.toml` جایگزین کنید.
3. جدول‌ها را بسازید:
   `npx wrangler d1 execute vpnstan --remote --file=./schema.sql`
4. ADMIN_PASSWORD را در `wrangler.toml` تغییر دهید.
5. با `npx wrangler deploy` منتشر کنید.

Cloudflare می‌تواند Worker و فایل‌های static را با یک deployment منتشر کند.

## اتصال دامنه
پس از deploy، در Cloudflare برای Worker یک Custom Domain مثل `panel.example.com` قرار دهید. لینک VLESS ساخته‌شده از همان host استفاده می‌کند.

## رفتار حجم
مصرف رفت و برگشت روی اتصال VLESS جمع می‌شود و Worker هر حدود یک ثانیه مقدار تجمعی را به D1 flush می‌کند. Subscription با هدر `Profile-Update-Interval: 1` و `Cache-Control: no-store` ارائه می‌شود؛ اما اینکه کلاینت دقیقاً هر 1 ثانیه ساب را refresh کند، به خود کلاینت بستگی دارد.
