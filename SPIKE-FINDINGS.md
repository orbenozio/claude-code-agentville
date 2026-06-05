# ממצאי spike שלב 0 — Agentville

אימות קצה-לקצה של הליבה הטכנית מול נתונים אמיתיים, לפני בניית ה-UI. הקוד תחת `src/core` (לוגיקה נטו, בלי Electron/Pixi) ו-`src/spike` (הרצה לקונסול). הרצה: `npm run spike` (live), `npm run spike:replay -- <file>`, `npx tsx src/spike/tailcheck.ts`, `npx tsx src/spike/hookcheck.ts`.

## TL;DR

* ✅ **הליבה עובדת מקצה-לקצה.** tail אינקרמנטלי חי → פרסור → נירמול → reducer → מצבי-סוכן, על סשן אמיתי.
* ✅ **שני הערוצים הוכחו מכנית:** JSONL (replay על 1247 שורות, 0 unknown) ו-hooks (הסקריפט האמיתי כותב `events.jsonl`, נקרא ומופעל ב-reducer).
* ✅ **TailReader עמיד:** שחזור byte-exact מעבר לחיתוך תו-UTF-8 וחיתוך שורת-JSON; זיהוי רוטציה/truncation.
* ⚠️ **3 באגים אמיתיים נתפסו ותוקנו** במהלך ה-spike (ראו למטה) — בדיוק מה שה-spike נועד לחשוף.
* 🔜 **נשאר רק אימות-חי אחד שלא ניתן לעשות מתוך הסשן הזה:** לוודא על fire אמיתי ש-`subagent_id` של ה-hook == `agentId` של קובץ ה-JSONL (מצריך התקנת hook גלובלי + הרצת שיחה — דורש opt-in של המשתמש).

## מה אומת מול נתונים אמיתיים

### ערוץ JSONL (replay על סשן night-shift אמיתי)
* 1247 שורות גולמיות → 722 רשומות מנורמלות, **0 unknown** (שאר השורות = רעש-תשתית מסונן נכון).
* זוהו נכון **כל 4 סוכני-המשנה** עם הסוג והמשימה: `claude-code-guide` ("Research /loop…"), `architect` ×2 ("Draft spec…", "Architecture review…"), `spec-reviewer` ("Review…").
* מחזור-החיים `working → done` נגזר נכון (מ-`toolUseResult.status:"completed"`); הסוכן הראשי מסיים `idle`.

### ערוץ hooks (סקריפט אמיתי, payloads לפי התיעוד הרשמי)
`hooks/agentville-hook.mjs` קיבל ב-stdin payloads כפי ש-Claude Code שולח, וכתב `~/.claude/agentville/events.jsonl`. ה-parser+reducer הגיבו נכון:
* `SubagentStart` → סוכן נכנס ל-working, **הסוג נפתר מה-hook** (`subagent_type`).
* `SubagentStop` → `done`.
* `Notification:permission_prompt` + `idle_prompt` → נלכדו עם השדות (בסיס ל-⏳ ול-idle-ודאי).
* `PermissionRequest` → נלכד עם שם-הכלי (`Bash`) וה-`permission_rule`.

## תובנות מפתח על ה-hooks (מהתיעוד הרשמי, אומת סכמתית)

| Hook | שדות רלוונטיים | שימוש ב-Agentville |
| --- | --- | --- |
| `SubagentStart` | `subagent_id`, `subagent_type`, `agent_type`, `session_id` | spawn ודאי + סוג + id. **אין `description`!** |
| `SubagentStop` | `subagent_id`, `exit_status` (success/failure/timeout) | done ודאי + תוצאה |
| `Notification` | `notification_type` (`permission_prompt`/`idle_prompt`/`auth_success`), `message` | ⏳ הרשאה + 🏠 idle-ודאי |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_rule` | ⏳ הרשאה לפי כלי |
| `StopFailure` | `error_type` (`rate_limit`/`overloaded`/…) | ⚠️/😴 **ודאי** — עדיף על טקסט-JSONL |

**שתי השלכות עיצוביות חשובות:**
1. **`SubagentStart` לא נושא `description`.** ⇒ טקסט בועת-המשימה חייב להמשיך להגיע מ-JSONL (`Agent.input.description`). **מאשר שמיזוג שני-הערוצים הוא חובה**, לא רשות — ה-hook נותן id/סוג/מחזור-חיים/תזמון ודאיים, ה-JSONL נותן את המשימה.
2. **`StopFailure.error_type` הוא מקור ודאי לשגיאה/rate-limit** — טוב יותר מהיוריסטיקת-הטקסט ב-JSONL (שכבר הוכחה כרועשת, ראו באג 1). כדאי לקדם אותו למקור-האמת ל-⚠️/😴 כשה-hooks זמינים.

## באגים אמיתיים שה-spike חשף ותיקן

1. **חיובי-שווא של שגיאה/rate-limit מתוכן השיחה.** התאמת טקסט `rate limit`/`overloaded` על כל השורה תפסה את המילים בתוך *תוכן* שיחה שדנה ב-rate limits (פרויקט night-shift) → הסוכן הראשי "ריצד" בין error/rateLimited/working. **תיקון:** סיגנל נגזר **רק** מהשדה המובנה `isApiErrorMessage:true`, לעולם לא מטקסט-תוכן חופשי.
2. **ריצוד idle↔working ב-live.** גזירת idle/working השתמשה ב-timestamp של הרשומה כשעון; בקריאת backlog של רשומות ישנות זה נתן "פעיל עכשיו" שגוי, מול שעון-הקיר של ה-tick. **תיקון:** מודל-שעון מפורש — live משתמש בשעון-קיר, replay בשעון-סימולציה מונוטוני (דטרמיניזם).
3. **יצירת-סוכן לא פלטה diff.** סוכן חדש שמצבו ההתחלתי כבר `working` לא הפיק שינוי-מצב ⇒ renderer מבוסס-diff לעולם לא היה רואה אותו. **תיקון:** ההופעה הראשונה של כל סוכן פולטת תמיד diff-יצירה (`before: undefined`).

## מה עדיין דורש fire אמיתי (opt-in של המשתמש)

ההתקנה הגלובלית של ה-hook משנה את `~/.claude/settings.json` ומשפיעה על **כל** סשני Claude Code (כולל הנוכחי) — לכן לא בוצעה אוטומטית. כדי לסגור את הפינה האחרונה צריך:
1. להוסיף את רישום-ה-hook ל-`settings.json` (snippet למטה), אידמפוטנטית.
2. להריץ שיחה עם סוכן-משנה ולוודא: ש-`subagent_id` שה-hook מדווח **זהה** ל-`agentId` של `subagents/agent-<id>.jsonl` (כך ש-EventMerger ממזג נכון בין הערוצים), ושפרומפט-הרשאה אכן יורה `Notification:permission_prompt`/`PermissionRequest`.

### snippet התקנה ל-`settings.json` (user או project-level)

```json
{
  "hooks": {
    "SubagentStart":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/hooks/agentville-hook.mjs", "async": true }] }],
    "SubagentStop":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/hooks/agentville-hook.mjs", "async": true }] }],
    "Notification":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/hooks/agentville-hook.mjs", "async": true }] }],
    "PermissionRequest":[{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/hooks/agentville-hook.mjs", "async": true }] }],
    "StopFailure":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/hooks/agentville-hook.mjs", "async": true }] }]
  }
}
```

`async: true` כדי שלא יחסום את Claude Code. הסקריפט פסיבי (קורא stdin, מוסיף לקובץ משלו, תמיד יוצא 0). שלב 3ב באיפיון יעטוף זאת באשף-התקנה אידמפוטנטי.

## עמידה בקריטריון-היציאה של spike שלב 0 (SPEC §12)

* ✅ spawn (עם description) → working → done בזמן-אמת מ-tail אינקרמנטלי — replay + live.
* ✅ שלמות tail: TailReader מוכח byte-exact מול חיתוכי-גבול ורוטציה (`tailcheck`).
* ✅ idle: מעבר working↔idle נצפה נכון (אחרי תיקון שעון-ה-backlog).
* ✅ אירועי-hook: תועד אילו שדות חושף כל אחד מ-5 ה-hooks הרלוונטיים.

---

*spike שלב 0 הושלם 2026-06-05. השלב הבא: שלב 1 — MVP ויזואלי (Electron + Pixi), על בסיס `src/core` שכבר מאומת.*
