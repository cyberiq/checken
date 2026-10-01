# Poultry Monitor Mobile App

هذا التطبيق مُبني بلغة JavaScript باستخدام React Native + Expo، ويعرض قيم الدواجن مباشرة: NH3، O2، درجة الحرارة، والرطوبة، ويقرأ القيم بصوت عربي كل 700ms تقريباً.

## التشغيل

```bash
cd /home/kali/Documents/checken/mobile
npm install
npx expo start
```

ثم استخدم:
- Expo Go على الهاتف
- أو محاكي Android
- أو محاكي iOS

## المميزات
- تحديثات فورية كل 700ms
- نطق القيم صوتياً باللغة العربية
- شاشة واضحة للحالة: آمن / تحذير / طوارئ
- مناسب لعرض بيانات المزرعة في الوقت الحقيقي
