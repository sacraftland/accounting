# تشغيل نظام كرافت لاند المحاسبي — Supabase + Google + GitHub Pages

الملف `index.html` هو النظام كاملاً (ملف واحد). يحتاج ثلاث خطوات منك لأنها حساباتك ومفاتيحك:
Supabase (قاعدة البيانات والدخول)، Google (زر الدخول بحساب Google)، وGitHub (الاستضافة).
المدة التقريبية: 20–30 دقيقة.

---

## 1) Supabase — قاعدة البيانات

1. ادخل [supabase.com](https://supabase.com) ← **New project**. اختر اسماً (مثل `craftland`) وكلمة مرور قوية لقاعدة البيانات واحفظها عندك، واختر أقرب منطقة متاحة.
2. من القائمة الجانبية: **SQL Editor** ← **New query** ← الصق محتوى الملف `supabase/setup.sql` كاملاً ← **Run**.
   يجب أن تظهر `Success. No rows returned`. (شغّله مرة واحدة فقط على مشروع جديد.)
3. **Project Settings ← API** (أو Data API / API Keys): انسخ
   - **Project URL** — مثل `https://abcdxyz.supabase.co`
   - **anon / publishable key** — مفتاح عام، آمن في المتصفح.
   - ⚠️ لا تنسخ أبداً مفتاح `service_role` أو `secret` إلى الملف.
4. افتح `index.html` بأي محرر نصوص، ابحث عن `SUPABASE_CONFIG` (في أول الكود)، وضع القيمتين:
   ```js
   const SUPABASE_CONFIG = {
     url: 'https://abcdxyz.supabase.co',
     anonKey: 'eyJhbGciOi...',
   };
   ```

## 2) إعدادات الدخول في Supabase

في **Authentication**:

1. **URL Configuration**
   - **Site URL**: رابط موقعك على GitHub Pages، مثل `https://dekkahsalabah.github.io/accounting/`
   - **Redirect URLs** ← Add URL: نفس الرابط السابق.
   (بدون هذا ترجع روابط التأكيد وGoogle إلى عنوان خاطئ.)
2. **Sign In / Providers ← Email**: مفعّل، و**Confirm email** مفعّل (المستخدم يؤكد بريده قبل الدخول).
3. **مهم قبل دعوة مستخدمين حقيقيين:** خادم البريد المدمج في Supabase للتجربة فقط ويرسل عدداً قليلاً جداً من الرسائل في الساعة.
   اربط بريدك الخاص من **Authentication ← Emails ← SMTP Settings** (مثلاً Resend أو Zoho) ليصل التأكيد واستعادة كلمة المرور بانتظام.
4. (اختياري) **Emails ← Templates**: ترجم نص رسائل التأكيد واستعادة كلمة المرور للعربية.

## 3) الدخول بحساب Google

1. ادخل [console.cloud.google.com](https://console.cloud.google.com) ← أنشئ مشروعاً (مثل `Craft Land Accounting`).
2. **APIs & Services ← OAuth consent screen** (أو Google Auth Platform ← Branding): نوع **External**، اسم التطبيق، بريد الدعم، ثم احفظ.
   الصلاحيات المطلوبة فقط: `email` و`profile` و`openid` — لا تحتاج مراجعة من Google لهذه الصلاحيات الأساسية.
3. **Credentials ← Create credentials ← OAuth client ID** ← النوع **Web application**:
   - **Authorized JavaScript origins**: `https://dekkahsalabah.github.io` (نطاق موقعك بدون مسار)
   - **Authorized redirect URIs**: الرابط الذي تعرضه Supabase في صفحة Google provider، وهو بالشكل
     `https://abcdxyz.supabase.co/auth/v1/callback`
4. انسخ **Client ID** و**Client secret** ← Supabase ← **Authentication ← Sign In / Providers ← Google** ← فعّله والصق القيمتين ← Save.
5. إن بقي التطبيق في وضع **Testing** في Google فلن يدخل إلا من تضيفهم كـ Test users؛ اضغط **Publish app** عندما تجهز.

## 4) الرفع على GitHub Pages

1. في GitHub أنشئ مستودعاً جديداً، مثلاً `accounting` (عام Public — GitHub Pages المجانية تحتاج مستودعاً عاماً.
   هذا آمن: المفتاح العام مصمم ليكون ظاهراً، والحماية في قاعدة البيانات نفسها — كل شركة لا ترى إلا بياناتها).
2. **Add file ← Upload files** ← ارفع `index.html` (بعد وضع مفاتيح Supabase فيه) ← **Commit changes**.
3. **Settings ← Pages** ← Source: **Deploy from a branch** ← Branch: `main` / `/(root)` ← **Save**.
4. بعد دقيقة تقريباً يظهر الرابط: `https://dekkahsalabah.github.io/accounting/` — هذا نفسه الذي وضعته في الخطوة 2 و3.

## 5) أول تجربة

1. افتح الرابط ← **إنشاء حساب** بالبريد، أو **المتابعة بحساب Google**.
2. أكّد بريدك من الرسالة (إن سجّلت بالبريد) ← أدخل بيانات كرافت لاند ← تُنشأ شجرة الحسابات تلقائياً.
3. أضف عميلاً وصنفاً ← أصدر فاتورة ← سند قبض ← افتح ميزان المراجعة وتأكد أنه متوازن.

### إذا واجهت مشكلة
| المشكلة | الحل |
| --- | --- |
| «الدخول بـ Google غير مفعّل» | الخطوة 3-4: فعّل Google في Supabase |
| `redirect_uri_mismatch` من Google | رابط callback في Google Cloud يجب أن يطابق ما تعرضه Supabase حرفياً |
| رابط التأكيد يفتح صفحة خاطئة / localhost | الخطوة 2-1: Site URL و Redirect URLs |
| لا تصل رسائل البريد | حد الإرسال في البريد المدمج — الخطوة 2-3 |
| «محاولات كثيرة» | حماية Supabase من التخمين — انتظر دقيقة |
| الصفحة تعمل «وضع التجربة» | لم توضع قيم `SUPABASE_CONFIG` في الملف المرفوع |
