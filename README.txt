גרסה v10.4

מה עודכן בגרסה הזו:
- צמצום משמעותי של שימוש ב-!important בקובץ ה-CSS.
- נשארו רק 3 שימושים לגיטימיים בתוך prefers-reduced-motion לצורכי נגישות.
- נוספה פונקציית clearAllActiveTimers לניהול טיימרים מרכזי.
- נוספה הפרדה בין טיימרי רוטציה/אינטראקציה לבין טיימרי אנימציה וגלילת מודל.
- נוסף transitionToken כדי למנוע Race Conditions בעת קליקים מהירים, חיפוש, פתיחה/סגירה של סיפור ושינוי גודל מסך.
- נבדקו תקינות JS, data.js ו-data.json.

להעלאה לגיטהאב:
אם כבר קיימת תיקיית images באתר, העלי רק את הקבצים שבגרסת code-only.
לא צריך להעלות מחדש תמונות קיימות.


עדכון v10.5 - ניקוי Cache
---------------------------
הקבצים מקבלים גרסת טעינה חדשה: v10-5-cache-clear-20260623-1015
בגיטהאב מומלץ להעלות את כל הקבצים יחד: index.html, styles.css, app.js, data.js, data.json.
אם עדיין רואים גרסה ישנה אחרי ההעלאה: לפתוח פעם אחת עם פרמטר רענון, למשל ?refresh=v10-5, או לבצע Ctrl+F5 / Ctrl+Shift+R.
העמוד כולל גם ניקוי עדין ל-service worker/cache ישן אם היה אחד בדפדפן.


V10.6 updates:
- Compact story popup to remove the large empty areas, especially for cards without a family-photo section.
- Omer: removed “בן זוגה של אורית” from the family/left section; Orith remains only in the description as requested.
- Added a new cache-busting build string: v10-6-compact-20260623-1325.


V11 updates — woven/color design:
- Removed the heartbeat visual line and the broken-heart SVG from the page layout.
- Changed the visual direction to a warmer “רקמה אנושית” / woven-fabric background.
- Portraits are now shown in color; grayscale filters were overridden for cards and story popups.
- Cards are placed in a softer organic fabric grid instead of above/below a divider line.
- New cache-busting build string: v11-woven-color-20260624-1300.

Upload note:
This package does not include the images folder. Upload/replace the updated code files only.
