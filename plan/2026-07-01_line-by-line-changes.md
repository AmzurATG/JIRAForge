# Line-by-Line Changes — Commit `000d226`

**Branch:** `feature/email-chat-redaction-v1.4.10`
**Commit:** `000d226` — `feat(desktop): email/chat body redaction + v1.4.10; idle-flap getattr fix`
**Author/Date:** Vishnu — 2026-07-01
**Totals:** 10 files changed, **1336 insertions(+), 69 deletions(-)**

This document reproduces the actual `git` diff hunks for every modified code file, annotated by concern, plus a list of the new files added.

Legend: `-` removed line, `+` added line, ` ` unchanged context.

---

## 1. `python-desktop-app/desktop_app.py`

Contains four concerns: (A) version bump, (B) email/chat redaction, (C) idle C1/C2/C3, (D) the C3 `getattr` fix. Hunks are shown in file order and tagged.

### (A) Version bump — line 390

```diff
@@ -387,7 +387,7 @@ load_dotenv()
 
 # Application version - IMPORTANT: Update this when releasing new versions
 # This is used for update checking and notifications
-APP_VERSION = "1.4.9"
+APP_VERSION = "1.4.10"
```

### (B) Redaction — constants (after `BROWSER_PROCESSES`, ~line 4996)

```diff
@@ -4996,6 +4996,24 @@ BROWSER_PROCESSES = {
     'opera.exe', 'vivaldi.exe', 'arc.exe',
 }
 
+# Email / chat body redaction — Gmail, Google Chat, Outlook.
+# For these surfaces the on-screen body is NEVER read: OCR/screen capture is
+# skipped entirely and the body is stored as this literal mask. The window title
+# is still captured (and PII-filtered) and time is still tracked.
+REDACTED_BODY_PLACEHOLDER = '***'
+# Browser-based mail/chat (Gmail, Google Chat, Outlook web) all run inside a
+# browser process, so they cannot be told apart by process name — match on
+# markers in the window title instead.
+REDACTED_BODY_TITLE_MARKERS = (
+    'gmail', 'mail.google.com',
+    'google chat', 'chat.google.com',
+    'outlook',
+)
+# Outlook desktop clients — matched by process name (classic / new / newest).
+REDACTED_BODY_PROCESSES = {
+    'outlook.exe', 'hxoutlook.exe', 'olk.exe',
+}
+
 PROCESS_IDENTIFIER_ALIASES = {
```

### (C) Idle C3 — new instance state in `__init__` (~line 6366)

```diff
@@ -6366,6 +6384,12 @@ class TimeTracker:
         self.idle_start_time = None  # When the current idle period began (UTC datetime)
         self.idle_project_key = None  # Project key at idle entry — used for idle record's project_key
         self._pending_idle_records = []  # Idle records waiting to be uploaded in next batch
+        # C3 overlap guard: the anchor + end of the last idle record we emitted.
+        # Repeated emission for the SAME anchor records only the increment beyond
+        # _last_idle_end, so queued idle time for one anchor can never exceed real
+        # elapsed time (defends against any re-emission slipping past C1).
+        self._last_idle_anchor = None
+        self._last_idle_end = None
         self._tracking_thread = None
```

### (B) Redaction — `should_skip_screenshot` defense-in-depth (~line 10359)

```diff
@@ -10335,6 +10359,12 @@ class TimeTracker:
         if not self.tracking_settings.get('screenshot_monitoring_enabled', True):
             return (True, 'screenshot_monitoring_disabled')
 
+        # Email/chat surfaces (Gmail, Google Chat, Outlook): never capture the
+        # screen. Defense in depth for the legacy screenshot path if it is ever
+        # re-enabled — the live pipeline already skips OCR via _should_redact_body.
+        if self._should_redact_body(app_name, window_title):
+            return (True, 'redacted_body_app')
+
         # Use database-driven classification to skip private/non-productive apps
         classification, _ = self.classification_manager.classify(app_name, window_title)
         if classification == 'private':
```

### (B) Redaction — new `_should_redact_body()` method (~line 10833)

```diff
@@ -10803,6 +10833,25 @@ class TimeTracker:
                 self.add_admin_log('ERROR', f'Idle record insert failed — CHECK constraint may not allow classification=idle. Run migration 20260325.')
             self.last_batch_upload_time = time.time()
 
+    def _should_redact_body(self, app_name, window_title):
+        """True when the active surface is email/chat (Gmail, Google Chat, Outlook)
+        whose body must never be read.
+
+        Outlook desktop is matched by process name; browser-based mail/chat is
+        matched by markers in the window title (all browser mail/chat shares the
+        same browser process name and cannot be told apart otherwise). Matching is
+        intentionally inclusive — a browser tab merely mentioning a marker (e.g. a
+        video titled "How to use Gmail") is treated as mail/chat and masked, which
+        errs toward privacy. Uses no instance state so it is safe to call anywhere.
+        """
+        app_lower = (app_name or '').lower().strip()
+        if app_lower in REDACTED_BODY_PROCESSES:
+            return True
+        if app_lower in BROWSER_PROCESSES:
+            title_lower = (window_title or '').lower()
+            return any(m in title_lower for m in REDACTED_BODY_TITLE_MARKERS)
+        return False
+
     def process_window_event(self, window_info):
```

### (B) Redaction — compute `redact_body` in `process_window_event` (~line 10874)

```diff
@@ -10825,6 +10874,12 @@ class TimeTracker:
         # Classify the application
         classification, match_type = self.classification_manager.classify(app_name, window_title)
 
+        # Email/chat body redaction (Gmail, Google Chat, Outlook): never read the
+        # on-screen body. Computed here so the productive/unknown branch below can
+        # skip OCR/capture entirely. Title is still captured + PII-filtered and
+        # the session is still created, so time is still tracked.
+        redact_body = self._should_redact_body(app_name, window_title)
+
         ocr_result = None
         display_title = window_title
```

### (B) Redaction — new `elif redact_body:` branch (~line 10907)

```diff
@@ -10852,6 +10907,18 @@ class TimeTracker:
             # Non-productive: no OCR, just metadata
             print(f"[NON-PROD] {app_name} — {window_title[:50]}")
 
+        elif redact_body:
+            # Email/chat surface (Gmail, Google Chat, Outlook): store the body mask
+            # and skip screen capture/OCR entirely — nothing is ever read, so there
+            # is nothing to leak. Title is kept and the session is still created.
+            ocr_result = {
+                'text': REDACTED_BODY_PLACEHOLDER,
+                'method': 'redacted_body',
+                'confidence': 1.0,
+                'error_message': None,
+            }
+            print(f"[REDACT] {app_name} — body redacted to '{REDACTED_BODY_PLACEHOLDER}' (title kept, time tracked)")
+
         elif classification in ('productive', 'unknown'):
             # Productive or unknown: capture screenshot (fast, ~50ms) then dispatch OCR async
             issue_key_in_title = bool(re.search(r'\b[A-Z][A-Z0-9]+-\d+\b', window_title or ''))
```

### (B) Redaction — guard async-OCR dispatch (~line 10952)

```diff
@@ -10885,7 +10952,8 @@ class TimeTracker:
         self.session_manager.on_window_switch(display_title, app_name, classification, ocr_result)
 
         # Now dispatch async OCR AFTER session exists (only for productive/unknown with valid screenshot)
-        if classification in ('productive', 'unknown'):
+        # Never for redacted mail/chat surfaces — no screenshot was ever captured.
+        if classification in ('productive', 'unknown') and not redact_body:
             # Re-check if we have a non-throttled screenshot to process
             if 'capture_result' in dir() and capture_result.get('screenshot') and not capture_result.get('throttled'):
```

### (C) Idle C2 — `enter_idle()` never re-anchors an open period (~line 11776)

```diff
@@ -11708,16 +11776,22 @@ class TimeTracker:
                 # Stop SQLite activity timer so idle time isn't counted in activity_records
                 self.session_manager.stop_current_timer()
                 
-                # Record when idle started (backdate to last activity)
-                self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
-                
-                # Store the project key at idle entry — this is the project the user
-                # was actually working on, not whatever project is active when they resume
-                self.idle_project_key = self.current_project_key
+                # C2: never re-anchor an already-open idle period. idle_start_time
+                # is cleared only on a genuine resume, so a non-null value here means
+                # an idle stretch is still open (e.g. a lock flap that briefly flipped
+                # us back to ACTIVE). Keep the ORIGINAL anchor — moving it forward is
+                # what let one locked period be re-emitted as many cumulative rows.
+                if self.idle_start_time is None:
+                    # Record when idle started (backdate to last activity)
+                    self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
+                    # Store the project key at idle entry — this is the project the user
+                    # was actually working on, not whatever project is active when they resume
+                    self.idle_project_key = self.current_project_key
             else:
                 # Entering idle from STOPPED state (e.g., system sleep before tracking starts)
-                # Just record the current time
-                self.idle_start_time = datetime.now(timezone.utc)
+                # Just record the current time — but never clobber an open anchor.
+                if self.idle_start_time is None:
+                    self.idle_start_time = datetime.now(timezone.utc)
             
             # Store idle reason for logging
             self.idle_reason = reason
```

### (C) Idle C1 — new `_should_resume_from_idle()` + `_process_idle_resume()` (~line 11861)

```diff
@@ -11787,6 +11861,55 @@ class TimeTracker:
             
             return True
 
+    def _should_resume_from_idle(self, idle_duration, current_idle_timeout):
+        """C1: decide whether the resume safeguard should fire this cycle.
+
+        It fires only when ALL hold:
+          - we are currently idle,
+          - the OS reports genuine recent input (idle_duration back under the
+            threshold), and
+          - the screen is NOT locked.
+
+        The lock check is the fix: while the workstation is locked the OS idle
+        clock (GetLastInputInfo) does not reflect true away-time, so a low
+        idle_duration is not a real return. Treating it as one made the app
+        "resume" every ~5 s and re-emit overlapping idle records from a frozen
+        anchor — the root cause of idle/office hours exceeding 24 h/day.
+        """
+        if not self.is_idle:
+            return False
+        if idle_duration > current_idle_timeout:
+            return False
+        if self._is_screen_locked():
+            return False
+        return True
+
+    def _process_idle_resume(self):
+        """C1: act on a pending resume signal, but never while the screen is
+        locked. Returns True only when we actually resumed.
+
+        While locked we leave the event set (so a genuine unlock, or real input
+        after unlock, still resumes) and do nothing else — no resume, no idle
+        record. That guarantees one continuous locked period produces exactly one
+        idle record covering the whole span instead of a cumulative cluster.
+        """
+        if not self.idle_resume_event.is_set():
+            return False
+        if self._is_screen_locked():
+            # Locked → ignore this cycle. Do NOT clear the event, resume, or emit.
+            return False
+
+        resumed = self.resume_from_idle()
+        if resumed and self._pending_idle_records:
+            try:
+                print(f"[IDLE] Flushing {len(self._pending_idle_records)} idle record(s)...")
+                self.upload_activity_batch()
+            except Exception as e:
+                print(f"[WARN] Idle record flush failed: {e}")
+        # We acted on the signal this cycle (screen not locked) — clear it.
+        self.idle_resume_event.clear()
+        return resumed
+
     def _is_within_work_hours(self, utc_dt):
```

### (C+D) Idle C3 — `_create_idle_record()` overlap guard + the `getattr` fix (~line 11954)

The `getattr(self, '_last_idle_anchor'/'_last_idle_end', None)` lines are the fix applied this session; the rest is the pre-existing C3 change.

```diff
@@ -11831,13 +11954,39 @@ class TimeTracker:
             return True  # Fail-open: record idle if check fails
 
     def _create_idle_record(self, reason="idle timeout"):
-        """Create an idle record from idle_start_time to now and queue it for upload."""
+        """Create an idle record from idle_start_time to now and queue it for upload.
+
+        C3 (overlap-proof): if a record was already emitted for the current
+        anchor, only the segment beyond the previously emitted end is recorded.
+        Re-emission (a lock flap, or the suspend + unlock paths both firing) is
+        therefore idempotent — total queued idle time for one anchor can never
+        exceed real elapsed time, so a day's totals cannot balloon past 24 h even
+        if a re-emission ever slips past the C1 guards.
+        """
         if self.idle_start_time is None:
             return
+        anchor = self.idle_start_time
         idle_end = datetime.now(timezone.utc)
-        idle_duration = int((idle_end - self.idle_start_time).total_seconds())
+
+        # Start of the segment still to record. If we already emitted a row for
+        # THIS anchor, resume from where that row ended so the new row does not
+        # overlap it (avoids the triangular cumulative sum from a frozen anchor).
+        # Read the coverage markers defensively (getattr) so paths that build a
+        # tracker without running __init__ still work — mirrors idle_project_key
+        # below.
+        last_anchor = getattr(self, '_last_idle_anchor', None)
+        last_end = getattr(self, '_last_idle_end', None)
+        effective_start = anchor
+        if (last_anchor is not None
+                and anchor == last_anchor
+                and last_end is not None
+                and last_end > effective_start):
+            effective_start = last_end
+
+        idle_duration = int((idle_end - effective_start).total_seconds())
         if idle_duration < 60:
-            # Skip very short idle periods (< 1 minute)
+            # Nothing new worth recording (period < 1 min, or the increment since
+            # the last emission is sub-minute). Leave _last_idle_end untouched.
             self.idle_start_time = None
             return
```

```diff
@@ -11866,10 +12015,10 @@ class TimeTracker:
             'ocr_error_message': None,
             'total_time_seconds': idle_duration,
             'visit_count': 1,
-            'start_time': self.idle_start_time.isoformat(),
+            'start_time': effective_start.isoformat(),
             'end_time': idle_end.isoformat(),
             'duration_seconds': idle_duration,
-            'work_date': _utc_ts_to_local_date(self.idle_start_time.isoformat()),
+            'work_date': _utc_ts_to_local_date(effective_start.isoformat()),
             'user_timezone': get_local_timezone_name(),
             'project_key': project_key,
```

```diff
@@ -11882,7 +12031,11 @@ class TimeTracker:
             }
         }
         self._pending_idle_records.append(record)
-        print(f"[IDLE] Created idle record: {self.idle_start_time.strftime('%H:%M:%S')} → {idle_end.strftime('%H:%M:%S')} ({idle_duration}s, reason: {reason})")
+        # Remember coverage for this anchor so a later re-emission only adds the
+        # increment beyond idle_end.
+        self._last_idle_anchor = anchor
+        self._last_idle_end = idle_end
+        print(f"[IDLE] Created idle record: {effective_start.strftime('%H:%M:%S')} → {idle_end.strftime('%H:%M:%S')} ({idle_duration}s, reason: {reason})")
         self.idle_start_time = None
```

### (C) Idle C1 — wire the guards into the tracking loop (~line 12808)

```diff
@@ -12655,7 +12808,7 @@ class TimeTracker:
                 # has died. This replaces the old "window changed → force resume"
                 # logic, which wrongly treated a self-changing window title as the
                 # user returning. Only real input resumes.
-                if self.is_idle and idle_duration <= current_idle_timeout:
+                if self._should_resume_from_idle(idle_duration, current_idle_timeout):
                     self.idle_resume_event.set()
```

```diff
@@ -12679,23 +12832,13 @@ class TimeTracker:
                         time.sleep(5)
                         continue
 
-                # Resume from idle if activity was detected by pynput
+                # Resume from idle if activity was detected — but NEVER while the
+                # screen is locked (C1). _process_idle_resume() performs the flush
+                # and, when locked, leaves the event set so a real unlock resumes
+                # cleanly and emits a single idle record for the whole locked span.
                 if self.idle_resume_event.is_set():  # B-3: Use Event
-                    resume_time = datetime.now(timezone.utc)
-                    print(f"[INFO] Activity detected — resuming from idle")
-                    
-                    # Use state machine instead of direct assignment
-                    if self.resume_from_idle():
-                        # Immediately flush idle records to database
-                        if self._pending_idle_records:
-                            try:
-                                print(f"[IDLE] Flushing {len(self._pending_idle_records)} idle record(s)...")
-                                self.upload_activity_batch()
-                            except Exception as e:
-                                print(f"[WARN] Idle record flush failed: {e}")
-                    
-                    # Clear the event regardless of whether resume succeeded
-                    self.idle_resume_event.clear()  # B-3: Clear event
+                    if self._process_idle_resume():
+                        print(f"[INFO] Activity detected — resumed from idle")
```

### (B) Redaction — extend loop skip-reason log filter (~line 12863)

```diff
@@ -12720,7 +12863,7 @@ class TimeTracker:
                 should_skip, skip_reason = self.should_skip_screenshot(app_name, window_title)
                 
                 if should_skip:
-                    if skip_reason in ('private_app', 'non_productive_app'):
+                    if skip_reason in ('private_app', 'non_productive_app', 'redacted_body_app'):
                         if not hasattr(self, '_last_skip_log') or time.time() - self._last_skip_log > 60:
                             print(f"[SKIP] {skip_reason}: {app_name}")
                             self._last_skip_log = time.time()
```

---

## 2. `python-desktop-app/installer/TimeTracker.iss` — installer version fallback

```diff
@@ -23,7 +23,7 @@
 ; ============================================================================
 
 #ifndef MyAppVersion
-  #define MyAppVersion "1.4.9"    ; fallback; build.bat overrides with /D
+  #define MyAppVersion "1.4.10"    ; fallback; build.bat overrides with /D
 #endif
```

---

## 3. `ai-server/src/services/portal-service.js` — C4 overlap-safe aggregation

### New helper `mergedCoverageSeconds()` (~line 44)

```diff
@@ -44,6 +44,33 @@ function categorizeActivity(row) {
   return 'neutral';
 }
 
+/**
+ * Total covered seconds of a set of [startMs, endMs] intervals, counting any
+ * overlap ONCE (union coverage). This is the C4 fix: overlapping/duplicate rows
+ * — e.g. a screen-lock flap that wrote one idle stretch as dozens of nested
+ * cumulative rows — must not be summed multiple times, or a day's totals exceed
+ * the real elapsed time (>24 h/day observed in production).
+ */
+function mergedCoverageSeconds(intervals) {
+  if (!intervals || intervals.length === 0) return 0;
+  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
+  let totalMs = 0;
+  let curStart = sorted[0][0];
+  let curEnd = sorted[0][1];
+  for (let i = 1; i < sorted.length; i++) {
+    const [s, e] = sorted[i];
+    if (s > curEnd) {
+      totalMs += curEnd - curStart;
+      curStart = s;
+      curEnd = e;
+    } else if (e > curEnd) {
+      curEnd = e;
+    }
+  }
+  totalMs += curEnd - curStart;
+  return Math.round(totalMs / 1000);
+}
+
 // Warn once (per process) when the 20260610 category-breakdown migration has
 // not been applied — the portal then renders the pre-breakdown view (AC-C6).
 let warnedMissingBreakdown = false;
```

### Select `start_time, end_time` (~line 419)

```diff
@@ -392,7 +419,7 @@ class PortalService {
     for (;;) {
       const { data: batch, error: activityError } = await supabase
         .from('activity_records')
-        .select('classification, duration_seconds, work_date, is_idle')
+        .select('classification, duration_seconds, work_date, is_idle, start_time, end_time')
         .eq('user_id', userId)
         .gte('work_date', from)
         .lte('work_date', to)
```

### Replace blind SUM with interval-merge buckets (~line 444)

```diff
@@ -417,31 +444,62 @@ class PortalService {
       pageStart += PAGE_SIZE;
     }
     
-    // Calculate summary — single pass, canonical WS-C taxonomy:
-    // Productive / Non-Productive (both spellings) / Neutral (everything
-    // else non-idle) / Idle. Active = P + NP + Neutral; Office = Active + Idle.
-    const totals = { productive: 0, 'non-productive': 0, neutral: 0, idle: 0 };
-    const dailyTrend = {};
+    // Calculate summary — canonical WS-C taxonomy with OVERLAP-SAFE coverage (C4):
+    // Productive / Non-Productive (both spellings) / Neutral (everything else
+    // non-idle) / Idle. Active = P + NP + Neutral; Office = Active + Idle.
+    //
+    // Per category we UNION each row's [start_time, end_time] and sum the merged
+    // spans, so overlapping rows (e.g. a lock-flap idle cluster) are counted
+    // once instead of blindly summed. Rows without usable timestamps fall back
+    // to a plain duration sum — parity with the pre-C4 behaviour and the SQL
+    // aggregates (this also keeps callers that don't provide start/end correct).
+    const ACTIVE_CATS = ['productive', 'non-productive', 'neutral'];
+    const ALL_CATS = ['productive', 'non-productive', 'neutral', 'idle'];
+    const makeBuckets = () => ({
+      intervals: { productive: [], 'non-productive': [], neutral: [], idle: [] },
+      fallback: { productive: 0, 'non-productive': 0, neutral: 0, idle: 0 }
+    });
+    const overall = makeBuckets();
+    const dailyBuckets = {};
 
     activities.forEach(activity => {
       // Parity with the pre-WS-C `.neq('is_idle', true)` filter and with the
       // SQL aggregates: rows where is_idle IS NULL fall in NO bucket (the old
       // query excluded them entirely; `is_idle <> true` drops NULL in SQL).
       if (activity.is_idle !== true && activity.is_idle !== false) return;
-      const seconds = activity.duration_seconds || 0;
       const category = categorizeActivity(activity);
-      totals[category] += seconds;
+      const seconds = activity.duration_seconds || 0;
+
+      const startMs = activity.start_time ? Date.parse(activity.start_time) : NaN;
+      const endMs = activity.end_time ? Date.parse(activity.end_time) : NaN;
+      const hasInterval = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
 
       const date = activity.work_date;
-      if (!dailyTrend[date]) {
-        dailyTrend[date] = { date, productive: 0, 'non-productive': 0, neutral: 0, idle: 0 };
+      if (!dailyBuckets[date]) dailyBuckets[date] = makeBuckets();
+
+      if (hasInterval) {
+        overall.intervals[category].push([startMs, endMs]);
+        dailyBuckets[date].intervals[category].push([startMs, endMs]);
+      } else {
+        overall.fallback[category] += seconds;
+        dailyBuckets[date].fallback[category] += seconds;
       }
-      dailyTrend[date][category] += seconds;
     });
 
-    const productiveSeconds = totals.productive;
-    const nonProductiveSeconds = totals['non-productive'];
-    const activeSeconds = productiveSeconds + nonProductiveSeconds + totals.neutral;
+    const catSeconds = (b, c) => mergedCoverageSeconds(b.intervals[c]) + b.fallback[c];
+    const unionSeconds = (b, cats) => {
+      const intervals = [];
+      let fb = 0;
+      for (const c of cats) { intervals.push(...b.intervals[c]); fb += b.fallback[c]; }
+      return mergedCoverageSeconds(intervals) + fb;
+    };
+
+    const productiveSeconds = catSeconds(overall, 'productive');
+    const nonProductiveSeconds = catSeconds(overall, 'non-productive');
+    const neutralSeconds = catSeconds(overall, 'neutral');
+    const idleSeconds = catSeconds(overall, 'idle');
+    const activeSeconds = unionSeconds(overall, ACTIVE_CATS);
+    const officeSeconds = unionSeconds(overall, ALL_CATS);
```

### Summary + dailyTrend use merged coverage (~line 519)

```diff
@@ -461,25 +519,31 @@ class PortalService {
       summary: {
         productiveHours: productiveSeconds / 3600,
         nonProductiveHours: nonProductiveSeconds / 3600,
-        neutralHours: totals.neutral / 3600,
-        idleHours: totals.idle / 3600,
+        neutralHours: neutralSeconds / 3600,
+        idleHours: idleSeconds / 3600,
         activeHours: activeSeconds / 3600,
-        officeHours: (activeSeconds + totals.idle) / 3600,
+        officeHours: officeSeconds / 3600,
         productivityPercentage: Math.round(productivityPercentage * 10) / 10
       },
-      dailyTrend: Object.values(dailyTrend).map(day => {
-        const dayDenominator = day.productive + day['non-productive'];
+      dailyTrend: Object.keys(dailyBuckets).map(date => {
+        const b = dailyBuckets[date];
+        const dayProd = catSeconds(b, 'productive');
+        const dayNonProd = catSeconds(b, 'non-productive');
+        const dayNeutral = catSeconds(b, 'neutral');
+        const dayIdle = catSeconds(b, 'idle');
+        const dayActive = unionSeconds(b, ACTIVE_CATS);
+        const dayDenominator = dayProd + dayNonProd;
         return {
-          date: day.date,
+          date,
           productivityPercentage: dayDenominator > 0
-            ? Math.round((day.productive / dayDenominator) * 1000) / 10
+            ? Math.round((dayProd / dayDenominator) * 1000) / 10
             : 0,
-          productiveHours: day.productive / 3600,
-          nonProductiveHours: day['non-productive'] / 3600,
-          neutralHours: day.neutral / 3600,
-          idleHours: day.idle / 3600,
+          productiveHours: dayProd / 3600,
+          nonProductiveHours: dayNonProd / 3600,
+          neutralHours: dayNeutral / 3600,
+          idleHours: dayIdle / 3600,
           // Active time (idle excluded) — same meaning the field had before.
-          totalHours: (day.productive + day['non-productive'] + day.neutral) / 3600
+          totalHours: dayActive / 3600
         };
       }).sort((a, b) => a.date.localeCompare(b.date))
     };
```

---

## 4. `ai-server/tests/services/portal-service.test.js` — AC7/AC8 tests (added block)

```diff
@@ -360,6 +360,84 @@ describe('getTimeLogs — category filters and field (WS-C)', () => {
   });
 });
 
+describe('getEmployeeDetail — overlap-safe interval-merge aggregation (C4)', () => {
+  // Same shape as the WS-C helper, but rows carry start_time/end_time so the
+  // service can merge overlapping intervals instead of blindly summing.
+  function buildDetailClient({ user, activityRows }) {
+    const userChain = {
+      select: jest.fn(function () { return this; }),
+      eq: jest.fn(function () { return this; }),
+      single: jest.fn(async () => ({ data: user, error: null })),
+    };
+    const activityChain = {
+      select: jest.fn(function () { return this; }),
+      eq: jest.fn(function () { return this; }),
+      gte: jest.fn(function () { return this; }),
+      lte: jest.fn(function () { return this; }),
+      order: jest.fn(function () { return this; }),
+      range: jest.fn(async () => ({ data: activityRows, error: null })),
+    };
+    return { from: jest.fn((table) => (table === 'users' ? userChain : activityChain)) };
+  }
+
+  test('AC7: overlapping idle rows are counted once (merged coverage), not summed', async () => {
+    // 4 overlapping idle rows all inside [13:00, 15:00] (merged span = 2h),
+    // whose raw durations sum to 6h — the exact overcount shape from the incident.
+    // One disjoint productive hour [10:00, 11:00] exercises office = merged(all).
+    const activityRows = [
+      { classification: 'productive', is_idle: false, work_date: '2026-06-29',
+        start_time: '2026-06-29T10:00:00Z', end_time: '2026-06-29T11:00:00Z', duration_seconds: 3600 },
+      { classification: 'idle', is_idle: true, work_date: '2026-06-29',
+        start_time: '2026-06-29T13:00:00Z', end_time: '2026-06-29T14:00:00Z', duration_seconds: 3600 },
+      { classification: 'idle', is_idle: true, work_date: '2026-06-29',
+        start_time: '2026-06-29T13:00:00Z', end_time: '2026-06-29T14:30:00Z', duration_seconds: 5400 },
+      { classification: 'idle', is_idle: true, work_date: '2026-06-29',
+        start_time: '2026-06-29T13:00:00Z', end_time: '2026-06-29T15:00:00Z', duration_seconds: 7200 },
+      { classification: 'idle', is_idle: true, work_date: '2026-06-29',
+        start_time: '2026-06-29T13:30:00Z', end_time: '2026-06-29T15:00:00Z', duration_seconds: 5400 },
+    ];
+    getClient.mockReturnValue(buildDetailClient({
+      user: { id: 'u1', display_name: 'Jane', email: 'j@x.com' },
+      activityRows,
+    }));
+
+    const { summary: s } = await portalService.getEmployeeDetail('org', 'u1', '2026-06-29', '2026-06-29');
+
+    // Merged idle span = 2h (NOT the 6h raw sum).
+    expect(s.idleHours).toBeCloseTo(2);
+    expect(s.productiveHours).toBeCloseTo(1);
+    // Active = merged(active union) = the single productive hour.
+    expect(s.activeHours).toBeCloseTo(1);
+    // Office = merged(all) = disjoint 1h productive + 2h idle = 3h.
+    expect(s.officeHours).toBeCloseTo(3);
+    // Sanity: office is far below the raw-sum figure (1h + 6h = 7h) that caused >24h days.
+    expect(s.officeHours).toBeLessThan(7);
+  });
+
+  test('AC8: disjoint rows yield the same totals as a plain sum (no undercount)', async () => {
+    const activityRows = [
+      { classification: 'productive', is_idle: false, work_date: '2026-06-29',
+        start_time: '2026-06-29T10:00:00Z', end_time: '2026-06-29T11:00:00Z', duration_seconds: 3600 },
+      { classification: 'non_productive', is_idle: false, work_date: '2026-06-29',
+        start_time: '2026-06-29T11:00:00Z', end_time: '2026-06-29T11:15:00Z', duration_seconds: 900 },
+      { classification: 'idle', is_idle: true, work_date: '2026-06-29',
+        start_time: '2026-06-29T12:00:00Z', end_time: '2026-06-29T12:30:00Z', duration_seconds: 1800 },
+    ];
+    getClient.mockReturnValue(buildDetailClient({
+      user: { id: 'u1', display_name: 'Jane', email: 'j@x.com' },
+      activityRows,
+    }));
+
+    const { summary: s } = await portalService.getEmployeeDetail('org', 'u1', '2026-06-29', '2026-06-29');
+
+    expect(s.productiveHours).toBeCloseTo(3600 / 3600);
+    expect(s.nonProductiveHours).toBeCloseTo(900 / 3600);
+    expect(s.idleHours).toBeCloseTo(1800 / 3600);
+    expect(s.activeHours).toBeCloseTo((3600 + 900) / 3600);
+    expect(s.officeHours).toBeCloseTo((3600 + 900 + 1800) / 3600);
+  });
+});
+
 describe('empty scope short-circuits (head with no employees sees nothing)', () => {
```

---

## 5. `CLAUDE.md` — documentation updates (context)

```diff
@@ -19,12 +19,13 @@ The Jira-embedded UI and backend logic. Uses Atlassian Forge platform (not a sta
 ### ai-server/ — AI Analysis Server (Node.js >=20, Express)
 ...
-- `src/controllers/` — Express route handlers (activity, auth, feedback, notifications, admin dashboard, forge-proxy, user data, app versioning)
-- `src/services/ai/` — OpenAI integration; prompt definitions in `prompts.js`, classification in `activity-service.js`
+- `src/controllers/` — Express route handlers (…, app versioning, plus the `portal-*` controllers below)
+- `src/services/ai/` — AI classification; … Model calls go through a **Portkey/LiteLLM gateway** …, not the raw OpenAI SDK — do not hardcode a provider.
 - `src/services/db/` — Supabase operations (…)
-- `src/services/notifications/` — Email via notifme-sdk
-- `src/middleware/` — Four auth layers, one per caller type (see Auth below)
+- `src/services/notifications/` — Email (notifme-sdk, plus Resend/SendGrid paths; see `EMAIL_SYSTEM_MIGRATION.md`)
+- `src/middleware/` — Six auth layers, one per caller type (see Auth below)
 - `src/dashboard/` — Single HTML admin dashboard served at `/admin-dashboard` …
+- **Portal (`src/portal/`)** — A separate React + Vite + Tailwind SPA … guarded by `src/middleware/portal-auth.js` … `PORTAL_*` feature flags … default `off`.
```

(Also: added the portal-SPA build commands block, the auth-middleware table now lists Desktop server-JWT / Desktop-or-OAuth / Portal SPA rows, and the Environment Variables line now names the Portkey gateway config + `PORTAL_JWT_SECRET` + `PORTAL_*` flags. Full text in the file diff.)

---

## 6. New files added (entire file is new)

| File | Lines | Purpose |
|------|-------|---------|
| `python-desktop-app/tests/test_email_chat_body_redaction.py` | +203 | Redaction tests: 22 pytest cases (decision-level + end-to-end via `process_window_event`) + a `__main__` proof report (11/11). |
| `python-desktop-app/tests/test_idle_lock_flap.py` | +240 | Idle lock-flap tests (AC1–AC6): C1 resume gating, C2 no re-anchor, C3 overlap-proof records. |
| `plan/2026-06-30_multi-component_fix-idle-overcount-lock-flap.md` | +113 | Plan doc for the idle-overcount/lock-flap fix (C1–C4). |
| `plan/EMAIL_CHAT_BODY_REDACTION.md` | +271 | Plan doc for the email/chat body redaction feature. |
| `plan/2026-07-01_session-changes-summary.md` | +146 | Narrative summary of this session's changes. |

These are new files, so every line is an addition — open the files directly for their full contents.
