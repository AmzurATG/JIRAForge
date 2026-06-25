# Linux Startup Capability Routing Plan (Screen Capture + OCR)

Date: 2026-06-20
Owner: Desktop App Team
Scope: python-desktop-app Linux startup behavior only
Status: Planning document (no code changes in this task)

---

## 1) Direct Answer

Yes, it is possible.

But the correct approach is not only "detect OCR version". For Linux reliability you should detect a full startup compatibility fingerprint:

- OS/desktop/session details (Ubuntu version, GNOME major, Wayland/X11)
- screen capture stack readiness (Portal, PipeWire, GStreamer pipewiresrc)
- window-title backend readiness (GNOME Introspect, AT-SPI, XWayland fallback)
- OCR engine/runtime readiness (configured engine, package import, engine init errors, versions)

Then route to the best compatible capture + window-title + OCR strategy at startup.

---

## 2) Current Codebase Capabilities (Already Available)

The codebase already has strong building blocks:

- OS compatibility assessment:
  - os_diagnostics.py has compatibility levels for window detection, idle, screenshot.
- Linux capture strategy checks:
  - monitor_capture.py checks ScreenCast portal + GStreamer + pipewiresrc.
  - Has XDG portal screenshot fallback.
  - Has cached ScreenCast session + restore token flow.
- OCR facade diagnostics:
  - ocr/facade.py exposes get_ocr_diagnostics() including engine availability and init errors.
- Runtime engine config:
  - desktop_app.py loads OCR config from server and resets OCR facade at runtime.

Important: this means you do not need a redesign from scratch. You need orchestration and policy.

---

## 3) Problem Model for Your 3 Systems

### System A (fully working, OCR works)
Likely profile:
- Window title backend available
- ScreenCast pipeline available
- OCR engine initialized and healthy

### System B (screencasting + titles work, OCR fails)
Likely profile:
- Capture pipeline healthy
- Window backend healthy
- OCR runtime unhealthy (engine init error, missing package, bad model/backend, OpenCV/PyTorch mismatch, AppImage path issue)

### System C (newer Ubuntu, window title = unknown, OCR fails)
Likely profile:
- Wayland + stricter desktop behavior (GNOME 47/48/49+)
- Window backend negotiation failing (Introspect/AT-SPI path broken)
- OCR also failing (independent or compounded)

This is exactly why startup should choose profile-specific methods.

---

## 4) Target Architecture: Startup Capability Router

Create a startup "Capability Router" that computes a deterministic capability signature and selects a runtime profile.

### 4.1 Capability Signature Fields

Collect once at startup:

- App/runtime:
  - app_version
  - packaging mode (AppImage/frozen/python)
  - executable path
- OS/desktop:
  - distro_id, distro_version
  - desktop name + major version
  - session type (wayland/x11)
  - xwayland present
- Capture stack:
  - portal_screencast available
  - portal_screenshot available
  - gstreamer available
  - gst pipewiresrc available
  - pipewire/wireplumber running
- Window-title stack:
  - gnome_shell_introspect
  - atspi bus + python atspi bindings
  - xdotool fallback readiness
- OCR stack:
  - configured primary/fallback engines
  - selected engine import success/failure
  - engine init errors
  - OCR package versions (rapidocr_onnxruntime, onnxruntime, cv2, torch/easyocr if configured)
  - tesseract binary version if tesseract is in fallback chain

### 4.2 Routing Output

Generate a startup runtime plan object:

- capture_mode:
  - screencast_portal
  - screenshot_portal
  - gnome_dbus
  - gnome_screenshot_cli
  - disabled
- window_mode:
  - gnome_introspect
  - atspi
  - xdotool_xwayland
  - unknown_only
- ocr_mode:
  - primary_engine_name
  - fallback_chain
  - preprocessing_profile
  - metadata_only_when_unavailable
- health_grade:
  - full / partial / limited

---

## 5) Startup Decision Matrix (Policy)

### 5.1 Capture Policy

1. If Wayland and ScreenCast + pipewiresrc + pipewire are all healthy:
- use ScreenCast portal

2. Else if Wayland and Screenshot portal exists:
- use Screenshot portal
- tag as partial (permission dialog risk)

3. Else if GNOME D-Bus screenshot works:
- use GNOME D-Bus screenshot

4. Else if gnome-screenshot CLI works:
- use CLI capture

5. Else:
- capture disabled
- set OCR unavailable reason = no image source

### 5.2 Window Title Policy

1. GNOME Introspect first on GNOME Wayland
2. AT-SPI second
3. xdotool only when X11/XWayland path valid
4. if all fail: set explicit reason code (WINDOW_BACKEND_UNAVAILABLE) instead of silent unknown

### 5.3 OCR Policy

1. Evaluate configured primary engine from server config.
2. If primary engine init fails, auto-walk fallback chain.
3. If all fail, mark OCR_MODE=metadata_only and include detailed engine failure reasons.
4. Apply engine-specific preprocessing profile:
- rapidocr/winrtocr: keep RGB lightweight preprocessing
- easyocr: grayscale + contrast path
- tesseract: high-contrast + OCR-friendly resize

---

## 6) "Version-Compatible Methods" Strategy (What to Detect)

Do not route only by Ubuntu version string. Route by capability + version constraints together.

### 6.1 Desktop/Session Version Gates

- GNOME >=45 on Wayland:
  - do not rely on Shell.Eval-style assumptions
  - prioritize Introspect + AT-SPI + portal paths
- Ubuntu newer release + Wayland default:
  - expect stricter portal behavior
  - require explicit portal readiness checks

### 6.2 OCR Version Gates

At startup, gather and evaluate:

- rapidocr_onnxruntime version
- onnxruntime version
- opencv version
- easyocr/torch versions if easyocr enabled
- pytesseract + tesseract --version if tesseract enabled

Then apply compatibility guardrails, for example:

- if engine import succeeds but init fails: quarantine that engine for session and move to fallback
- if known bad combination detected (from internal compatibility table), skip directly to fallback

---

## 7) Implementation Phases

## Phase 1: Capability Inventory + Structured Logging

Goal:
- Produce one startup JSON object containing all capture/window/OCR capabilities and versions.

Tasks:
- merge OS diagnostics summary + monitor_capture checks + OCR diagnostics into one startup report object
- add explicit reason codes for each unavailable subsystem
- emit one log line with profile id and selected modes

Deliverables:
- startup capability JSON schema
- single "selected runtime profile" log event

Exit Criteria:
- every startup run shows deterministic profile and reason codes

## Phase 2: Runtime Router (Read-only policy first)

Goal:
- Convert diagnostics into selected modes without changing deep implementations yet.

Tasks:
- define routing policy table
- implement profile resolver from capability signature
- wire resolver output to existing capture/window/OCR entry points

Deliverables:
- CapabilityRouter policy doc + profile resolver
- profile id visible in logs and diagnostics upload

Exit Criteria:
- system B and C produce distinct profile ids with non-ambiguous failure reasons

## Phase 3: OCR Engine Compatibility Layer

Goal:
- Make OCR robust against engine/package mismatch.

Tasks:
- collect OCR package versions at startup
- add compatibility table (known-good + known-bad combos)
- auto-disable incompatible engine and use fallback chain
- add session-level circuit breaker for repeatedly failing engine

Deliverables:
- OCR compatibility matrix config
- engine quarantine and fallback behavior

Exit Criteria:
- in system B type cases, OCR falls back gracefully with clear reason instead of silent failure

## Phase 4: Window Title Hardening for New Ubuntu/GNOME

Goal:
- eliminate "unknown" titles caused by backend mismatch.

Tasks:
- hard-priority ordering for Wayland backends
- capture backend health probes with timeout and explicit errors
- when unknown persists, attach backend diagnostics per sample window check

Deliverables:
- stable window backend selection logic
- diagnostic reasons for unknown titles (not generic unknown)

Exit Criteria:
- in system C type cases, either titles recover or reason is explicit and actionable

## Phase 5: Validation Across 3 Machines

Goal:
- prove routing policy works on your exact three systems.

Tasks:
- run startup diagnostics and collect profile ids on each machine
- run 15-minute capture+OCR test with same app usage script
- compare: capture success rate, non-unknown title rate, OCR success rate

Deliverables:
- 3-system comparison report
- final routing policy adjustments

Exit Criteria:
- all 3 machines achieve stable and explainable behavior

---

## 8) Test Plan

### 8.1 Unit Tests

- capability signature builder
- policy matrix routing for mocked capabilities
- engine compatibility evaluator and fallback selection
- reason-code generation

### 8.2 Integration Tests (Linux)

- Wayland + ScreenCast available path
- Wayland + no pipewiresrc path
- Window backend fallback sequence
- OCR primary fail then fallback succeed
- OCR all fail -> metadata-only with detailed diagnostics

### 8.3 Field Validation (Your 3 Systems)

For each machine capture:
- selected profile id
- capture mode
- window mode
- OCR mode
- reason codes if partial/limited

KPIs:
- title_unknown_rate
- ocr_success_rate
- ocr_empty_text_rate
- capture_black_frame_rate
- engine_init_failure_rate

---

## 9) Observability and Supportability

Add/standardize these startup diagnostic fields:

- profile_id
- capture_mode_selected
- window_mode_selected
- ocr_mode_selected
- ocr_engine_failures
- package_versions
- blocker_codes
- recommendations

Recommended blocker/reason code examples:

- SC_PIPEWIRE_PLUGIN_MISSING
- SC_PORTAL_UNAVAILABLE
- WIN_INTROSPECT_UNAVAILABLE
- WIN_ATSPI_BINDING_MISSING
- OCR_ENGINE_INIT_FAILED_<engine>
- OCR_NO_ENGINE_AVAILABLE

---

## 10) Rollout Plan

1. Stage to internal Linux test builds.
2. Enable router in observe-only mode first (no behavior change, just profile logs).
3. Validate profile correctness against real outcomes.
4. Enable behavior-routing for a subset of users.
5. Full rollout once system B and C cases are resolved or gracefully degraded with clear diagnostics.

Rollback:
- single env flag to bypass router and use current default behavior.

---

## 11) Risks and Mitigations

Risk: Overfitting to Ubuntu version only.
Mitigation: capability-first routing, version only as tie-breaker.

Risk: Startup latency increases due to many probes.
Mitigation: strict timeouts and cached probe results.

Risk: False negatives in probe checks.
Mitigation: multi-signal checks + retry on first capture failure.

Risk: AppImage runtime mismatch with host libs.
Mitigation: include packaging mode and binary path in capability signature; test AppImage-specific dependency visibility.

---

## 12) What This Solves for Your Doubt

Your idea is valid.

Yes, detect at startup and choose compatible methods. But do it as a capability router, not only OCR version detection.

- For system A: router selects full profile.
- For system B: router keeps capture/title path, reroutes OCR engine/fallback with version-aware compatibility guardrails.
- For system C: router selects newer-Wayland-safe window backend sequence and OCR fallback with explicit reason codes.

This gives stable behavior and fast root-cause visibility across different Ubuntu/GNOME combinations.
