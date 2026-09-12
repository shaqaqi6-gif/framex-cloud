# FrameX Cloud Mobile v0.2

نسخة سحابية تعمل من الجوال: رفع فيديو على أجزاء صغيرة، معالجة 1080p/2K/4K، إخراج 30/60FPS، تنسيق 9:16، وحفظ النتيجة على الهاتف.

## ما الذي تم تنفيذه؟

- واجهة عربية PWA للآيفون والأندرويد.
- 1080×1920 و1440×2560 و2160×3840.
- 30 أو 60FPS.
- Motion interpolation بواسطة FFmpeg بدل تكرار الإطارات.
- وضع Fill لملء 9:16 ووضع Fit بدون قص.
- تحسين خفيف: denoise + contrast/saturation + sharpen.
- رفع الفيديو على أجزاء 8MB حتى تكون عملية الرفع أكثر ثباتًا عبر بروكسيات الويب.
- Queue للمعالجة مع status polling؛ لا يبقى طلب HTTP واحد مفتوحًا أثناء المعالجة.
- استخدام NVENC تلقائيًا إذا كان متاحًا، وإلا x264.
- حذف ملف المصدر بعد المعالجة، وحذف النتائج تلقائيًا بعد 24 ساعة افتراضيًا.
- رمز دخول اختياري عبر APP_PIN.
- Dockerfile جاهز للنشر.
- GitHub Actions جاهز لبناء صورة Docker على GHCR تلقائيًا.

> ملاحظة مهمة: هذه النسخة تستخدم FFmpeg لرفع الدقة وMotion Interpolation. محرك AI Upscaling الحقيقي وRIFE GPU هما المرحلة التالية، ولم أدّعِ أنهما موجودان في v0.2.

## النشر من الجوال فقط

### 1) GitHub
أنشئ مستودع GitHub **عام** باسم `framex-cloud`. لا تضع داخله مفاتيح أو كلمات مرور.

بعد رفع ملفات هذا المشروع إلى المستودع، GitHub Actions الموجود في:

`.github/workflows/build-container.yml`

سيبني صورة Docker تلقائيًا بعنوان:

`ghcr.io/<اسم-حسابك>/framex-cloud:latest`

إذا كان المستودع عامًا والصورة ورثت الظهور العام، يستطيع RunPod سحبها بدون بيانات Registry سرية.

### 2) RunPod
أنشئ Custom Pod Template بهذه القيم:

- Container Image: `ghcr.io/<اسم-حسابك>/framex-cloud:latest`
- Container Disk: 20GB أو أكثر
- Volume: يفضل 40GB أو أكثر
- Volume Mount Path: `/workspace`
- Expose HTTP Port: `8000`
- Environment Variable: `APP_PIN` = رمز دخول تختاره
- Environment Variable: `OUTPUT_TTL_HOURS` = `24`

ثم شغّل Pod. رابط التطبيق يكون بالنمط:

`https://<POD_ID>-8000.proxy.runpod.net`

افتحه من Safari أو Chrome على الجوال.

## لماذا الرفع مقسّم؟

واجهة RunPod HTTP proxy تمر عبر عدة طبقات ولها قيود زمنية للطلبات الطويلة. لذلك FrameX يقسم رفع الفيديو إلى طلبات صغيرة، ثم يبدأ المعالجة كـ background job ويستعلم الجوال عن الحالة بدل إبقاء طلب المعالجة مفتوحًا.

## متغيرات البيئة

| المتغير | الافتراضي | الوظيفة |
|---|---:|---|
| `APP_PIN` | فارغ | إذا وضعته تصبح المعالجة محمية برمز دخول |
| `FRAMEX_STORAGE` | `/workspace/framex` | موقع الملفات المؤقتة والنتائج |
| `MAX_UPLOAD_BYTES` | 3GB | الحد الأعلى لملف الفيديو |
| `UPLOAD_CHUNK_BYTES` | 8MB | حجم جزء الرفع |
| `OUTPUT_TTL_HOURS` | 24 | مدة حفظ النتائج |
| `DELETE_INPUT_AFTER_DONE` | 1 | حذف المصدر بعد اكتمال/فشل المعالجة |
| `PREFER_NVENC` | 1 | استخدام NVIDIA NVENC عند توفره |
| `X264_CRF` | 18 | جودة x264 عند عدم توفر NVENC |

## تشغيل محلي للمطور فقط

لا يحتاجه المستخدم النهائي. للمطور:

```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

## المرحلة التالية

- RIFE GPU interpolation.
- Real-ESRGAN / بديل حديث لرفع التفاصيل بالذكاء الاصطناعي.
- Object storage للملفات الكبيرة مع روابط تنزيل مؤقتة.
- فصل queue عن واجهة الويب عند التوسع لعدة مستخدمين.
