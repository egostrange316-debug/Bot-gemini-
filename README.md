# Gemini Ai — Telegram bot

Gemini API asosidagi mustaqil Telegram yordamchi. Google’ning rasmiy Telegram boti emas.
Supabase Edge Functions + PostgreSQL; runtime uchun tashqi npm paketi kerak emas.

## Hozirgi imkoniyatlar

- Shaxsiy chatda matnli suhbat; o‘zbekcha va foydalanuvchi tanlagan boshqa tillar.
- `/start`, `/help`, `/new`, `/forget`, `/privacy`.
- Foydalanuvchilar o‘rtasida ajratilgan suhbat xotirasi.
- Uzun javoblarni Telegram xabarlariga bo‘lib yuborish.
- API kvotasi, tarmoq xatosi va javob bloklanishi uchun tushunarli xabarlar.
- Webhook maxfiy kaliti, RLS va faqat serverga berilgan database huquqlari.
- Takroriy update’larni aniqlash, saqlangan javobdan yuborishni davom ettirish.
- Ixtiyoriy `ALLOWED_USER_IDS`; bo‘sh bo‘lsa barcha shaxsiy-chat foydalanuvchilari kira oladi.
- Bot tomonidan kunlik xabar kvotasi yo‘q. Google va Supabase kvotalari saqlanadi.

Bu versiya rasm, audio, fayl, internet qidiruvi yoki guruh suhbatlarini ishlamaydi.
API kaliti modelni internet qidiruvi bilan avtomatik ta’minlamaydi.

## Ishga tushirish

Node.js 22 yoki yangirog‘i kerak. Repository: https://github.com/egostrange316-debug/Bot-gemini-
Haqiqiy kalitlar repoda saqlanmaydi; ular lokal `.env` va Supabase Secrets orqali beriladi.

1. `.env.example` nusxasini `.env` deb saqlang. Token va Gemini kalitini shu faylga kiriting.
   `.env` Git’dan chiqarilgan; haqiqiy kalitlarni README, SQL yoki kodga yozmang.
2. Webhook maxfiy kalitini yarating va `TELEGRAM_WEBHOOK_SECRET` sifatida saqlang:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Tanlangan Supabase loyihasining SQL Editor’ida `db/setup.sql` faylini bir marta bajaring.
   Boshqa bot ham ishlatayotgan loyihada jadval nomlari to‘qnashmasligini tekshiring.
   `public` sxemasi Data API orqali ochiq bo‘lishi kerak. Jadvallarni `anon`ga ochmang:
   ushbu kod `service_role` huquqlarini aniq beradi va RLS’ni yoqadi.
4. Supabase’ga kiring; `PROJECT_REF` o‘rniga loyihangiz ID’sini yozing:

   ```sh
   npx --yes supabase@2.121.0 login
   npx --yes supabase@2.121.0 secrets set --env-file .env --project-ref PROJECT_REF
   npx --yes supabase@2.121.0 functions deploy telegram-bot --project-ref PROJECT_REF --no-verify-jwt --use-api
   ```

   `--no-verify-jwt` Telegram uchun kerak; endpoint o‘zining webhook maxfiy kalitini tekshiradi.
   Hosted runtime `SUPABASE_URL` va `SUPABASE_SERVICE_ROLE_KEY`ni o‘zi beradi.
   Ularni Telegramga yoki ochiq repoga joylamang. CLI o‘rniga ulangan Supabase vositalari
   orqali ham xuddi shu SQL va uchta function faylini deploy qilish mumkin.
5. `.env`da `WEBHOOK_URL=https://PROJECT_REF.supabase.co/functions/v1/telegram-bot` bo‘lsin.
   Keyin bot nomi, buyruqlar va webhook’ni sozlang:

   ```sh
   npm run telegram:setup
   npm run telegram:status
   ```

6. Telegramda `/start`, `Salom`, oldingi savolga bog‘liq yana bir savol va `/new`ni sinang.
   Supabase Security Advisor’ni ishga tushiring. Funksiya loglarida xato bo‘lmasligini,
   begona webhook maxfiy kaliti bilan so‘rov `401` olishini tekshiring.

## Sozlamalar

| Nom | Vazifasi |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather bergan token |
| `GEMINI_API_KEY` | Google Gemini API kaliti |
| `TELEGRAM_WEBHOOK_SECRET` | Kamida 32 belgili tasodifiy maxfiy kalit |
| `GEMINI_MODEL` | Boshlang‘ich model: `gemini-2.5-flash-lite`; ishga tushirishda kalit bilan mavjudligini tekshiring |
| `MAX_OUTPUT_TOKENS` | Bir javobning token budjeti, odatda 4096 |
| `HISTORY_TURNS` | Xotirada saqlanadigan savol-javob juftlari, odatda 12 |
| `HISTORY_CHAR_LIMIT` | Xotira matni hajmi, odatda 48000 belgi |
| `ALLOWED_USER_IDS` | Vergul bilan ajratilgan Telegram ID’lari; bo‘sh = barcha foydalanuvchilar |

Token va xotira sozlamalari kunlik xabar cheklovi emas. Ular javob uzunligi, kechikish va
xarajatni boshqaradi. Eski suhbat juftlari chegaradan chiqqanda xotiradan chiqariladi.
Gemini safety settings o‘zgartirilmagan; botda qo‘shimcha mavzu qora ro‘yxati yo‘q.
Google’ning model himoyalari, xizmat qoidalari va loyiha kvotalarini kod bekor qilmaydi.

## Tekshirish

```sh
npm ci
npm test
```

Testlar HTTP xizmatlarini mock qiladi va SQL’ni PGlite PostgreSQL muhitida bajaradi.
Ular jonli Telegram/Gemini yoki hosted Supabase sinovining o‘rnini bosmaydi.
PGlite faqat test uchun development dependency; Edge Function uni import qilmaydi.
GitHub Actions push va pull request paytida testlarni ishga tushiradi.

## Ishlash va cheklovlar

Webhook javobi qayta ishlash yakunlangandan keyin beriladi. Har ish uchun 90 soniya umumiy
tarmoq budjeti, Gemini chaqiruvi uchun 40 soniya va database’da 120 soniyalik lease bor.
`max_connections=1` boshlang‘ich kichik bot uchun update’larni ketma-ket oladi; ko‘p
foydalanuvchili xizmatga kengaytirishda mustahkam navbat va alohida worker qo‘shish kerak.
Bu server cheklovi sababiga ko‘ra cheksiz trafik yoki uzluksiz 24/7 kafolati berilmaydi.

Javob yuborilishidan oldin bazada saqlanadi. Telegram uzilganda keyingi urinish saqlangan
javobdan davom etadi. Telegram xabarni qabul qilgan, lekin tasdiq kelmagan yoki checkpoint
yozilmagan juda qisqa oraliqda xabar takrorlanishi mumkin; exactly-once kafolati yo‘q.
Gemini javobi saqlanishidan oldin jarayon uzilsa, AI so‘rovi qayta bajarilishi mumkin.

Doimiy yuborish xatosi yoki Telegram qayta urinishni to‘xtatishi chatdagi pending ishni
ushlab qolishi mumkin. Administrator sababni tuzatishi, kerak bo‘lsa aynan shu chatning
pending update’ini bekor qilib session lock’ini tozalashi kerak. Yangi xabarni indamay
yo‘qotib yubormaslik uchun bot bu holatda `503` qaytaradi.

Tugagan ishlarning matni darhol tozalanadi; deduplikatsiya metadata’si faol chatlarda
7 kundan keyin tozalanadi. Faol suhbat xotirasi `/new` yoki `/forget`gacha saqlanadi.
Bu buyruqlar Telegram xabarlari, Google saqlash siyosati va database backup’larini o‘chirmaydi.
Bot kodi maxfiy kalitlar, suhbat matni yoki provider javoblarini logga yozmaydi.

## GitHub’ga joylash

Kod https://github.com/egostrange316-debug/Bot-gemini- reposida saqlanadi.
`.env`, `node_modules` va maxfiy kalitlar push qilinmaydi.
GitHub kodni saqlaydi; botni Supabase Edge Functions bajaradi.

## Rasmiy hujjatlar

- https://core.telegram.org/bots/api#setwebhook
- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/safety-settings
- https://supabase.com/docs/guides/functions/examples/telegram-bot
- https://supabase.com/docs/guides/functions/secrets
- https://supabase.com/docs/guides/functions/limits

Tayyorlangan sana: 2026-10-16. Haqiqiy kalit va loyiha tanlanganda modelga kirish, tarif
hamda hosted sozlamalar yana tekshiriladi.
