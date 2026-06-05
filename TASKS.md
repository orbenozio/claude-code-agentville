# TASKS

מסמך מעקב משימות חי. סמן `[x]` כשמשימה הושלמה; הוסף משימות חדשות מתחת תוך כדי עבודה.

## מפת שלבים (איפה אנחנו)
מסמכי-יסוד: `CONCEPT.md` → `JSONL-FINDINGS.md` → `SPEC.md` → `SPIKE-FINDINGS.md`.

- ✅ **שלב 0 — spike ליבה** (הושלם): tail+parser+reducer מאומתים על נתונים אמיתיים, 2 ערוצים (JSONL+hooks). קוד: `src/core`, `src/spike`.
- ✅ **שלב 1 — MVP ויזואלי** (רץ על המסך!): Electron + Pixi, עיירה חיה עם דמות לכל סוכן, בועת-משימה, מעברי מצב. הרצה: `npm start`.
- 👉 **שלב 2** — מצבי-קצה ויזואליים (⚠️ שגיאה, 😴 rate-limit) + חוסן tail.
- ⬜ **שלב 3** — ⏳ הרשאות + idle-ודאי דרך ערוץ ה-hooks (אשף-התקנה אידמפוטנטי).
- ⬜ **שלב 4** — ליטוש, בורר-פרויקט, ריבוי-פרויקטים, "קפיצה-לשיחה".

## Todo (הצעדים הבאים, לפי סדר)
- [ ] **שלב 2.0** — ⚠️ error + 😴 rate-limit ויזואלית (badges + התנהגות דביקה ב-renderer)
- [ ] **שלב 2.1** — חוסן tail: debounce/throttle ל-IPC (ARCH§8), זיהוי רוטציה לפי size+חוסר-רצף (QA#4), אידמפוטנטיות activity (QA#5)
- [ ] חוזה snapshot/diff ממוספר-seq + resync (ARCH§10) — כרגע diffs חשופים בלי זיהוי-פער
- [ ] `claimSpawn`: התאמת spawn↔agent כש-2+ סוכנים מאותו type ב-JSONL-בלבד (ARCH; נפתר עם hooks)
- [ ] `SubagentStop.exitStatus` — אבחנה בין done תקין לכישלון/timeout (QA#8)
- [ ] (opt-in) אימות-חי אחרון של ה-hooks: `subagent_id`==`agentId` + פרומפט-הרשאה אמיתי יורה
- [ ] (לתיעוד) sandbox:false ב-main (ARCH🟢) — פשרת preload; לשקול preload תואם-sandbox

## In progress

## Done
- [x] setup_project — junctions, git, TASKS.md
- [x] אימות מקור הנתונים (JSONL) → `JSONL-FINDINGS.md`
- [x] הכרעת סטאק: Electron + Pixi.js
- [x] איפיון מלא → `SPEC.md` (architect DRAFT; הכרעה: MVP צפייה-בלבד)
- [x] review כפול (spec-reviewer + architect REVIEW) — הוטמע לתוך SPEC.md
- [x] הכרעה: אימוץ ערוץ hooks ל-MVP (פותר ⏳ הרשאות ואת "שקט≠idle")
- [x] הכרעת ש1–ש5 (idle=45s, אימות-hook ב-spike, done נעלם 5דק', צפייה-בלבד טהורה, גילוי-אוטומטי)
- [x] spike שלב 0 — ליבה מאומתת מקצה-לקצה → `SPIKE-FINDINGS.md` (tail/parser/reducer + 2 ערוצים; 3 באגים תוקנו)
- [x] שלב 1 — MVP ויזואלי: Electron + Pixi, עיירה חיה (`src/main`, `src/renderer`); `npm start`. תוקן: ELECTRON_RUN_AS_NODE של VSCode
- [x] סבב QA (סוכן-משנה) + תיקונים: שמות-סוכן ב-renderer (diff מטא-דאטה), StopFailure→ערוץ שגיאה (QA#1), reset של StringDecoder (QA#2), openToolUses→working (QA#3), היעלמות done+reuse בתים (QA#6), סינון `system` (QA#7), fixture ל-StopFailure
- [x] שדרוג ויזואלי לכפר: פלטה ללא-ירוקים, בית-עירייה+מגבעת לראש-העיר, בתים עם פתח+שביל לכל בית, שינה מונפשת (Zzz+נשימה), בגדי-עבודה+קסדה, בועת-מחשבה עם המשימה, תנועה במפעל
- [x] שכבות z-order נכונות (ציפור בשמיים, כבשה מאחורי מבנים), כיווני-תנועה נכונים
- [x] סצנה מורחבת: שמיים+עננים, נהר זורם+דג קופץ, עצי-פרי (תפוח/שזיף/תפוז), חיות-חווה (כבש/פרה/סוס/תרנגול) עם רעייה משותפת
- [x] תיקוני הגהה (סוכן-משנה): typo `שביל`, `ממופתח`, וסתירת-SPEC על `SubagentStart`/`description` מול ה-spike
- [x] שיפורי UX: בועת-מחשבה חיה (claimSpawn), שמות במלבן-לבן+פונט, חלון-הגדרות לחיות (⚙️), רספונסיביות (world בקנה-מידה אחיד)
- [x] ביקורת ארכיטקט + תיקונים: סיגנל-דביק עקבי (clearStaleSignal), חיבור ערוץ ה-hooks החי ב-SessionMonitor (HookEventTail+מיזוג)
- [x] רספונסיביות אמיתית מקצה-לקצה: בתים יחסית-למרכז + reflow ב-resize (נהר/כביש/שמיים נמתחים לרוחב מלא, בלי עיוות)
