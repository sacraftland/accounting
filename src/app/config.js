// =====================================================================
//  إعداد الربط مع Supabase — عدّل هذين السطرين فقط
//  Supabase → Project Settings → API (أو Data API):
//    url     = Project URL        مثل https://abcdxyz.supabase.co
//    anonKey = anon / publishable key  (مفتاح عام — آمن في المتصفح)
//  لا تضع هنا أبداً مفتاح service_role / secret.
//  إذا تُركا فارغين يعمل النظام في وضع التجربة (البيانات في المتصفح فقط).
// =====================================================================
const SUPABASE_CONFIG = {
  url: '',
  anonKey: '',
};
