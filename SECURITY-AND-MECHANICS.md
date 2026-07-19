# Entix Health — آلية الموقع والمراجعة الأمنية

> وثيقة مرجعية تشرح كيف يعمل الموقع فعلياً، التهديدات الأمنية، والمهام المتبقية.

---

## 1) آلية العمل الكاملة (كيف يعمل الموقع فعلياً)

### 1.1 تدفق المصادقة والعزل

```
المستخدم → /api/signup أو /api/login
                ↓
    upsertActiveEmailUser(email, password)
                ↓
    ensurePersonForUser(email)  ← ينشئ person فريد بـ slug = u-<localpart>-<hash>
                ↓
    app_users.person_slug = slug الفريد (ليس 'tareq')
                ↓
    setSession(cookie, {slug, email, role})
                ↓
    كل استعلام لاحق → resolvePersonSlug(session) ← يحمي من تسرّب 'tareq'
                ↓
    withPerson(slug) → كل استعلامات DB مفلترة بـ person_id = $1
```

**القاعدة الذهبية**: كل مستخدم يملك `person` منفصل. لا توجد مشاركة بيانات بين المستخدمين. الأدمن فقط (بريد في `ADMIN_GOOGLE_EMAILS`) مرتبط بـ`tareq`.

### 1.2 تدفق الشات (المجلس)

```
المستخدم يكتب + يرفع صورة
        ↓
Frontend: uploadHealthFiles() → /api/documents (يخزّن الملف ويرجع document IDs)
        ↓
Frontend: sendMsg() → /api/chat {question, attachment_ids}
        ↓
Backend: loadPersonImages(slug, attachment_ids) → base64 images
        ↓
Backend: runHealthCommittee()
    ├─ buildHealthSnapshot(slug) — يجلب تحاليل/أدوية/حالات المستخدم
    ├─ deterministicCommittee() — فحص red-lines محلي
    ├─ isDiagnosticIntent() ? runCouncil : runDirect
    │   ├─ runDirect: نموذج واحد سريع (Claude → GPT → Gemini fallback)
    │   │   └─ إذا فيه صور → callGeminiVision (multimodal)
    │   └─ runCouncil: 3 أعضاء (Researcher → Clinician → Auditor)
    └─ saveChatMessage()
        ↓
الرد يظهر في الشات + يُحفظ في chat_messages
```

### 1.3 تدفق رفع الملفات واستخراج المؤشرات

```
/api/documents (multipart)
    ↓
حفظ الملف على القرص → insert into documents
    ↓
إن كان صورة/PDF → visionExtractLabs() (Claude Vision)
    ↓
يستخرج markers JSON → insert into lab_panels + lab_markers
    ↓
إن كان نصياً → استخراج مباشر
    ↓
إن فشل → OCR排队 (tesseract) → polling عبر /api/documents/:id/status
```

### 1.4 تدفق البروتوكول والتقرير

```
/api/protocol أو /api/dashboard
    ↓
buildProtocolSnapshot(meds, supps, conditions, redLines)
    ├─ dedupeByName() — إزالة التكرار
    ├─ enrichItem() — إثراء ثنائي اللغة (name_ar, brand, why_formulation)
    ├─ schedule — توزيع الصباح/الظهيرة/المساء
    └─ interactions — قواعد السلامة (title_ar, body_ar)
    ↓
Frontend: loadProtocol() → عرض بطاقات + جدول اليوم + قواعد السلامة
```

---

## 2) المراجعة الأمنية

### 2.1 الإصلاحات المنجزة

| # | الثغرة | الخطورة | الإصلاح | الحالة |
|---|--------|---------|---------|--------|
| P0 | تجاوز المصادقة في `/api/signup` | **حرجة** | إرجاع 409 عند وجود الحساب | ✅ مغلقة |
| P0 | كل مستخدم يرى بيانات Tareq | **حرجة** | `ensurePersonForUser` + `resolvePersonSlug` | ✅ مغلقة |
| P1 | `!==` في `requireHmdbSecret` (timing attack) | عالية | `timingSafeStringEqual` | ✅ مغلقة |
| P1 | الصور لا تمر للـAI (ردود تسليكية) | عالية | `callGeminiVision` + `attachment_ids` | ✅ مغلقة |
| P2 | `dedupeByName` يحذف جرعات صحيحة | متوسطة | مفتاح موسّع (name+dose+freq+timing) | ✅ مغلقة |
| P2 | `verifySessionCookie` لا يفحص انتهاء الصلاحية | متوسطة | فحص `iat` (7 أيام) | ✅ مغلقة |
| P3 | `sharedLoginLimit` يستخدم `request.ip` | منخفضة | `requestIp(request)` | ✅ مغلقة |

### 2.2 التهديدات المتبقية والمهام

| # | التهديد | الخطورة | المهمة المطلوبة |
|---|---------|---------|-----------------|
| T1 | المستخدمون القدامى المرتبطون بـ`tareq` قبل الإصلاح | عالية | سكريبت migration: حدّث `app_users.person_slug` لكل مستخدم غير admin من `tareq` إلى `slugFromEmail(email)` |
| T2 | لا يوجد rate-limit على `/api/chat` | متوسطة | إضافة `rateLimit: {max: 20, timeWindow: "1 minute"}` على `/api/chat` |
| T3 | مفاتيح API في env بدون تدوير | منخفضة | جدول تدوير ربع سنوي لـANTHROPIC/OPENAI/GEMINI keys |
| T4 | لا يوجد audit log لعمليات الحذف | متوسطة | تسجيل `resetMyData` و`DELETE /api/conversations` في audit_logs |
| T5 | الصور المرفوعة لا يُتحقق من حجمها قبل الـvision | منخفضة | التحقق من `buf.length < 10MB` قبل `callGeminiVision` |

### 2.3 نموذج الثقة (Trust Boundaries)

```
[المستخدم] ──cookie──→ [Fastify API] ──→ [PostgreSQL · health_memory schema]
                            │
                            ├──→ [Anthropic / OpenAI / Gemini] (PHI: نعم، مُصرّح)
                            ├──→ [Serper Search] (PHI: لا، مُعقّم)
                            └──→ [نظام الملفات /data/health-memory/files] (صور خاصة)
```

**القواعد**:
- PHI يذهب **فقط** لمزودي النماذج الأولية (Anthropic/OpenAI/Google)
- بحث Serper يستقبل استعلام مُعقّم (بدون أرقام/إيميلات/تواريخ)
- ملفات المستخدم محمية بـ`person_id` في كل استعلام
- مفاتيح API في headers (ليس في URL) لمنع تسرّبها في logs

---

## 3) مهام محددة لحل الإشكاليات المتبقية

### 3.1 عاجل (هذا الأسبوع)
1. **سكريبت migration لعزل المستخدمين القدامى**:
   ```sql
   UPDATE health_memory.app_users
   SET person_slug = 'u-' || split_part(email, '@', 1) || '-' || substr(md5(email), 1, 8)
   WHERE person_slug = 'tareq'
     AND email NOT IN (admin emails)
     AND status = 'active';
   ```
2. إضافة rate-limit على `/api/chat`

### 3.2 قصير المدى (أسبوعان)
3. التحقق من حجم الصور قبل إرسالها للـvision
4. audit logs لعمليات الحذف
5. اختبار اختراق (penetration test) للمسارات المصادقة عليها

### 3.3 متوسط المدى (شهر)
6. تدوير مفاتيح API ربع سنوياً
7. تشفير الملفات at-rest (حالياً 0o600 فقط)
8. backup تلقائي لقاعدة البيانات

---

## 4) نقاط التحقق (DoD) للإصلاحات الحالية

| الإصلاح | كيف تتحقق |
|---------|-----------|
| عزل المستخدمين | حساب جديد يرى 0 دواء (وليس 40) |
| الصور في الشات | ارفع صورة قط → الرد يصف الصورة فعلياً |
| منع الردود التسليكية | اسأل عن شيء unrelated → الرد لا يذكر التحاليل |
| قواعد السلامة ثنائية اللغة | بروتوكول → عرض شامل → 5 قواعد بـAR+EN |
