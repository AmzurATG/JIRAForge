2026-09-30 18:04:18 - INFO - app_logger - ======================================================================
2026-09-30 18:04:18 - INFO - app_logger - TimeTracker Logging System Initialized
2026-09-30 18:04:18 - INFO - app_logger - Log file: /home/iswaryak/.local/share/TimeTracker/logs/timetracker.log
2026-09-30 18:04:18 - INFO - app_logger - Log level: INFO
2026-09-30 18:04:18 - INFO - app_logger - PII redaction: ENABLED
2026-09-30 18:04:18 - INFO - app_logger - Max log size: 10MB x 5 files = 50MB total
2026-09-30 18:04:18 - INFO - app_logger - ======================================================================
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] ======================================================================
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] TimeTracker v1.4.13 starting...
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] OS: Linux 7.0.0-34-generic #34~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 15:38:29 UTC 2
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] Python: 3.11.13 (main, Apr 28 2026, 01:55:19) [GCC 8.5.0 20210514 (Red Hat 8.5.0-28)]
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] Process ID: 58995
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] Executable: /opt/timetracker/TimeTracker
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] Log file: /home/iswaryak/.local/share/TimeTracker/logs/timetracker.log
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] Screenshot monitoring: DISABLED
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] ======================================================================
2026-09-30 18:04:18 - INFO - desktop_app - [MAIN] Initializing TimeTracker application...
2026-09-30 18:04:18 - INFO - timetracker_linux.provider - [LINUX] Ubuntu 24.04.5 LTS | session=wayland desktop=ubuntu:GNOME | install=package
2026-09-30 18:04:18 - INFO - timetracker_linux.provider - [LINUX] window=gnome_extension -> atspi capture=gnome_extension -> portal_screencast -> null idle=mutter -> logind_idlehint
2026-09-30 18:04:18 - INFO - STDOUT - [INFO] Initializing TimeTracker...
2026-09-30 18:04:18 - INFO - desktop_app - [TRACKER] TimeTracker.__init__() starting...
2026-09-30 18:04:18 - INFO - desktop_app - [TRACKER] Configuration: capture_interval=300s, web_port=51778
2026-09-30 18:04:18 - INFO - desktop_app - [TRACKER] Initializing Atlassian authentication manager...
2026-09-30 18:04:18 - INFO - auth.secure_storage - SecureTokenStorage initialized (keyring_available=True)
2026-09-30 18:04:18 - INFO - STDOUT - [OK] Loaded 3 tokens from secure storage
2026-09-30 18:04:18 - INFO - STDOUT - [INFO] Orphaned keyring credentials detected after a clean install — clearing stale session so login is required
2026-09-30 18:04:18 - INFO - auth.secure_storage - Tokens deleted for default
2026-09-30 18:04:19 - INFO - desktop_app - [TRACKER] Atlassian authentication manager initialized
2026-09-30 18:04:19 - INFO - STDOUT - [INFO] No pause settings file found, using defaults
2026-09-30 18:04:19 - INFO - STDOUT - [DEBUG] key done
2026-09-30 18:04:19 - INFO - STDOUT - [DEBUG] migrate done
2026-09-30 18:04:19 - INFO - STDOUT - [DB] app_classifications_cache: fresh install, no migration needed
2026-09-30 18:04:19 - INFO - db_connection - [DB] [DB] app_classifications_cache: fresh install, no migration needed
2026-09-30 18:04:19 - INFO - STDOUT - [DEBUG] schema done
2026-09-30 18:04:19 - INFO - STDOUT - [DEBUG] perms done
2026-09-30 18:04:19 - INFO - STDOUT - [OK] Offline manager initialized (DB: /home/iswaryak/.local/share/TimeTracker/time_tracker_offline.db)
2026-09-30 18:04:19 - INFO - STDOUT - [OK] Application initialized
2026-09-30 18:04:19 - INFO - desktop_app - [MAIN] TimeTracker initialized successfully
2026-09-30 18:04:19 - INFO - desktop_app - [MAIN] Starting main application loop...
2026-09-30 18:04:19 - INFO - STDOUT - [OK] Starting TimeTracker...
2026-09-30 18:04:19 - INFO - STDOUT - [INFO] First run detected - starting OCR dependency check in background
2026-09-30 18:04:19 - INFO - STDOUT - [INFO] Starting background OCR setup...
2026-09-30 18:04:19 - INFO - STDOUT - [OCR SETUP] Background worker started
2026-09-30 18:04:19 - INFO - STDOUT - [OCR SETUP] All dependencies already installed
2026-09-30 18:04:19 - INFO - STDOUT - [OCR SETUP] Finalizing OCR engines...
2026-09-30 18:04:19 - INFO - ocr.config - OCR engine 'winrtocr' is Windows-only; skipped on linux
2026-09-30 18:04:19 - INFO - ocr.facade - Primary OCR engine: rapidocr
2026-09-30 18:04:19 - INFO - STDOUT - [OK] Added to autostart: /home/iswaryak/.config/autostart/com.amzur.timetracker.desktop
2026-09-30 18:04:19 - INFO - presidio-analyzer - Using device of type: cpu
2026-09-30 18:04:19 - INFO - STDOUT - [ERROR] No refresh token available
2026-09-30 18:04:19 - ERROR - desktop_app - [AUTH] token_refresh_failed | reason_code=OAUTH_REAUTH_REQUIRED | permanent_failure=True | refresh_fail_count=0 | invalid_flag=False | next_action=manual_reauth_required | failure_reason=missing_refresh_token
2026-09-30 18:04:19 - INFO - STDOUT - b" * Serving Flask app 'desktop_app'"
2026-09-30 18:04:19 - INFO - STDOUT - b' * Debug mode: off'
2026-09-30 18:04:19 - INFO - werkzeug - [31m[1mWARNING: This is a development server. Do not use it in a production deployment. Use a production WSGI server instead.[0m
 * Running on http://[IP]:51778
2026-09-30 18:04:19 - INFO - werkzeug - [33mPress CTRL+C to quit[0m
2026-09-30 18:04:21 - INFO - presidio-analyzer - Created NLP engine: spacy. Loaded models: ['en']
2026-09-30 18:04:21 - INFO - presidio-analyzer - registry not provided, creating default.
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:21 - INFO - STDOUT - [INFO] Checking for app updates...
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: UsBankRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: UsLicenseRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: UsItinRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: UsPassportRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: UsSsnRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: NhsRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: EsNifRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: EsNieRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: ItDriverLicenseRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: ItFiscalCodeRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: ItVatCodeRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: ItIdentityCardRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: ItPassportRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: PlPeselRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: CryptoRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: DateRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: EmailRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: IbanRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: IpRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: MedicalLicenseRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: MacAddressRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: PhoneRecognizer
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: UrlRecognizer
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - CreditCardRecognizer supported languages: es, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - CreditCardRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - CreditCardRecognizer supported languages: pl, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - EsNifRecognizer supported languages: es, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - EsNieRecognizer supported languages: es, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItDriverLicenseRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItFiscalCodeRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItVatCodeRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItIdentityCardRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItPassportRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:21 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - PlPeselRecognizer supported languages: pl, registry supported languages: en
2026-09-30 18:04:21 - INFO - presidio-analyzer - Loaded recognizer: SpacyRecognizer
2026-09-30 18:04:21 - INFO - privacy.filter - Privacy filter initialized with 3 detectors
2026-09-30 18:04:21 - INFO - ocr.facade - Privacy filter initialized with detectors: ['custom_patterns', 'presidio', 'entropy']
2026-09-30 18:04:21 - INFO - ocr.facade - ============================================================
2026-09-30 18:04:21 - INFO - ocr.facade - OCR DIAGNOSTICS REPORT
2026-09-30 18:04:21 - INFO - ocr.facade - ============================================================
2026-09-30 18:04:21 - INFO - ocr.facade - Timestamp: 2026-09-30T12:34:21.394852Z
2026-09-30 18:04:21 - INFO - ocr.facade - Running as frozen exe: True
2026-09-30 18:04:21 - INFO - ocr.facade - Bundled path (_MEIPASS): /opt/timetracker/_internal
2026-09-30 18:04:21 - INFO - ocr.facade - System: Linux #34~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 15:38:29 UTC 2
2026-09-30 18:04:21 - INFO - ocr.facade - Machine: x86_64 | Python: 3.11.13
2026-09-30 18:04:21 - INFO - ocr.facade - Hostname: AMZ-LAP-240
2026-09-30 18:04:21 - INFO - ocr.facade - Primary engine: rapidocr
2026-09-30 18:04:21 - INFO - ocr.facade - Fallback engines: []
2026-09-30 18:04:21 - INFO - ocr.facade - Primary engine (rapidocr): READY
2026-09-30 18:04:21 - INFO - ocr.facade - ----------------------------------------
2026-09-30 18:04:21 - INFO - ocr.facade - ENGINE INITIALIZATION DETAILS:
2026-09-30 18:04:21 - INFO - ocr.facade -   [RAPIDOCR]
2026-09-30 18:04:21 - INFO - ocr.facade -     Engine ready: True
2026-09-30 18:04:21 - INFO - ocr.facade - ----------------------------------------
2026-09-30 18:04:21 - INFO - ocr.facade - OCR Status: READY
2026-09-30 18:04:21 - INFO - ocr.facade - ============================================================
2026-09-30 18:04:21 - INFO - STDOUT - [OK] OCR ready — primary: rapidocr, fallbacks: []
2026-09-30 18:04:21 - INFO - STDOUT - [OCR] LocalOCRProcessor initialized - using dynamic engine selection
2026-09-30 18:04:21 - INFO - STDOUT - [OCR] Primary engine: rapidocr, Fallback: none
2026-09-30 18:04:21 - INFO - STDOUT - [OCR] Async OCR worker thread started
2026-09-30 18:04:21 - INFO - STDOUT - [OCR SETUP] OCR system ready
2026-09-30 18:04:21 - INFO - STDOUT - [INFO] Checking for updates (current version: v1.4.13)
2026-09-30 18:04:21 - INFO - STDOUT - [INFO] App is up to date (v1.4.13)
2026-09-30 18:04:21 - INFO - STDOUT - [INFO] Opening browser for authentication...
2026-09-30 18:04:21 - INFO - STDOUT - [OK] Application running at http://localhost:51778
2026-09-30 18:04:21 - INFO - STDOUT - [OK] Check system tray for application icon
2026-09-30 18:04:21 - INFO - timetracker_linux.compat.tray_sni - [LINUX] tray icon registered with the StatusNotifierWatcher
2026-09-30 18:04:22 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:22] "GET /login HTTP/1.1" 200 -
2026-09-30 18:04:22 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:22] "[33mGET /favicon.ico HTTP/1.1[0m" 404 -
2026-09-30 18:04:28 - INFO - STDOUT - [OK] Saved metadata to /home/iswaryak/.local/share/TimeTracker/auth_metadata.json
2026-09-30 18:04:28 - INFO - STDOUT - [OK] PKCE code_challenge generated (S256)
2026-09-30 18:04:28 - INFO - STDOUT - [OK] Redirecting to Atlassian OAuth: https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=q0sTWP...
2026-09-30 18:04:28 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:28] "[32mGET /auth/atlassian HTTP/1.1[0m" 302 -
2026-09-30 18:04:39 - INFO - STDOUT - [INFO] Exchanging OAuth code for tokens...
2026-09-30 18:04:39 - INFO - STDOUT - [INFO] Exchanging OAuth code via AI Server (with PKCE)...
2026-09-30 18:04:40 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-09-30 18:04:40 - INFO - STDOUT - [OK] Saved 2 tokens to secure storage
2026-09-30 18:04:40 - INFO - STDOUT - [OK] Saved metadata to /home/iswaryak/.local/share/TimeTracker/auth_metadata.json
2026-09-30 18:04:40 - INFO - STDOUT - [OK] OAuth tokens received via AI Server
2026-09-30 18:04:41 - INFO - STDOUT - [WARN] Custody migration rejected (HTTP 500) — keeping legacy refresh flow
2026-09-30 18:04:41 - INFO - STDOUT - [INFO] Fetching user info from Atlassian...
2026-09-30 18:04:42 - INFO - STDOUT - [INFO] Initializing database connection...
2026-09-30 18:04:42 - INFO - STDOUT - [INFO] Fetching Supabase configuration from AI server...
2026-09-30 18:04:42 - INFO - STDOUT - [INFO] Fetching Supabase config from AI Server...
2026-09-30 18:04:42 - INFO - STDOUT - [OK] Supabase config loaded from AI server
2026-09-30 18:04:43 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-09-30 18:04:43 - INFO - STDOUT - [OK] Saved 2 tokens to secure storage
2026-09-30 18:04:43 - INFO - STDOUT - [OK] Saved metadata to /home/iswaryak/.local/share/TimeTracker/auth_metadata.json
2026-09-30 18:04:43 - INFO - STDOUT - [INFO] Fetching OCR configuration from AI server...
2026-09-30 18:04:43 - INFO - STDOUT - [INFO] Fetching OCR config from AI Server...
2026-09-30 18:04:43 - INFO - ocr.facade - OCR facade and engine cache reset — will reinitialise on next OCR call
2026-09-30 18:04:43 - INFO - STDOUT - [OK] OCR facade reset — will reinitialise with AI server config on next call
2026-09-30 18:04:43 - INFO - STDOUT - [OK] OCR config loaded from AI server (engines: winrtocr, rapidocr)
2026-09-30 18:04:43 - INFO - STDOUT - [OK] Privacy config loaded from AI server (PII detection: enabled)
2026-09-30 18:04:43 - INFO - STDOUT - [INFO] OCR setup deferred to background thread (prevents auth blocking)
2026-09-30 18:04:43 - INFO - STDOUT - [OK] Supabase client initialized for https://jvijitdewbypqbatfboi.supabase.co (timeout: 60s)
2026-09-30 18:04:43 - INFO - STDOUT - [INFO] Supabase token expired or missing, getting new one...
2026-09-30 18:04:43 - INFO - desktop_app - [AUTH] Supabase token refresh required: token_exists=False, time_remaining=-1790771684s
2026-09-30 18:04:43 - INFO - STDOUT - [INFO] Requesting Supabase token from AI Server...
2026-09-30 18:04:44 - INFO - STDOUT - [OK] Exchange-token user data: user_id=[UUID], org_id=[UUID], jira_cloud_id=[UUID]
2026-09-30 18:04:45 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Saved 3 tokens to secure storage
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Saved metadata to /home/iswaryak/.local/share/TimeTracker/auth_metadata.json
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Supabase token received (expires in 3600s)
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Organization ID set from exchange-token: [UUID]
2026-09-30 18:04:45 - INFO - STDOUT - [OK] User ID set from exchange-token: [UUID]
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Jira Cloud ID pre-seeded from exchange-token: [UUID]
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Supabase JWT set on client (PostgREST + Storage)
2026-09-30 18:04:45 - INFO - STDOUT - [INFO] Starting background OCR setup...
2026-09-30 18:04:45 - INFO - STDOUT - [OCR SETUP] Background worker started
2026-09-30 18:04:45 - INFO - STDOUT - [OCR SETUP] All dependencies already installed
2026-09-30 18:04:45 - INFO - STDOUT - [OCR SETUP] Finalizing OCR engines...
2026-09-30 18:04:45 - INFO - ocr.facade - Primary OCR engine: rapidocr
2026-09-30 18:04:45 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=id%2C%20organization_id&atlassian_account_id=eq.712020%3A[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Found existing user | user_id=[UUID]
2026-09-30 18:04:45 - INFO - presidio-analyzer - Created NLP engine: spacy. Loaded models: ['en']
2026-09-30 18:04:45 - INFO - presidio-analyzer - registry not provided, creating default.
2026-09-30 18:04:45 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=display_name%2C%20email&id=eq.[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:04:45 - INFO - STDOUT - [OK] User info cached for offline mode
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:45 - INFO - STDOUT - [OK] Authenticated user | email=[EMAIL]
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: CreditCardRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: UsBankRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: UsLicenseRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: UsItinRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: UsPassportRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: UsSsnRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: NhsRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: EsNifRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: EsNieRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: ItDriverLicenseRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: ItFiscalCodeRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: ItVatCodeRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: ItIdentityCardRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: ItPassportRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: PlPeselRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: CryptoRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: DateRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: EmailRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: IbanRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: IpRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: MedicalLicenseRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: MacAddressRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: PhoneRecognizer
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: UrlRecognizer
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - CreditCardRecognizer supported languages: es, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - CreditCardRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - CreditCardRecognizer supported languages: pl, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - EsNifRecognizer supported languages: es, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - EsNieRecognizer supported languages: es, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItDriverLicenseRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItFiscalCodeRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItVatCodeRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItIdentityCardRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - ItPassportRecognizer supported languages: it, registry supported languages: en
2026-09-30 18:04:45 - WARNING - presidio-analyzer - Recognizer not added to registry because language is not supported by registry - PlPeselRecognizer supported languages: pl, registry supported languages: en
2026-09-30 18:04:45 - INFO - presidio-analyzer - Loaded recognizer: SpacyRecognizer
2026-09-30 18:04:45 - INFO - privacy.filter - Privacy filter initialized with 3 detectors
2026-09-30 18:04:45 - INFO - ocr.facade - Privacy filter initialized with detectors: ['custom_patterns', 'presidio', 'entropy']
2026-09-30 18:04:45 - INFO - ocr.facade - ============================================================
2026-09-30 18:04:45 - INFO - ocr.facade - OCR DIAGNOSTICS REPORT
2026-09-30 18:04:45 - INFO - ocr.facade - ============================================================
2026-09-30 18:04:45 - INFO - ocr.facade - Timestamp: 2026-09-30T12:34:45.922697Z
2026-09-30 18:04:45 - INFO - ocr.facade - Running as frozen exe: True
2026-09-30 18:04:45 - INFO - ocr.facade - Bundled path (_MEIPASS): /opt/timetracker/_internal
2026-09-30 18:04:45 - INFO - ocr.facade - System: Linux #34~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 15:38:29 UTC 2
2026-09-30 18:04:45 - INFO - ocr.facade - Machine: x86_64 | Python: 3.11.13
2026-09-30 18:04:45 - INFO - ocr.facade - Hostname: AMZ-LAP-240
2026-09-30 18:04:45 - INFO - ocr.facade - Primary engine: rapidocr
2026-09-30 18:04:45 - INFO - ocr.facade - Fallback engines: []
2026-09-30 18:04:45 - INFO - ocr.facade - Primary engine (rapidocr): READY
2026-09-30 18:04:45 - INFO - ocr.facade - ----------------------------------------
2026-09-30 18:04:45 - INFO - ocr.facade - ENGINE INITIALIZATION DETAILS:
2026-09-30 18:04:45 - INFO - ocr.facade -   [RAPIDOCR]
2026-09-30 18:04:45 - INFO - ocr.facade -     Engine ready: True
2026-09-30 18:04:45 - INFO - ocr.facade - ----------------------------------------
2026-09-30 18:04:45 - INFO - ocr.facade - OCR Status: READY
2026-09-30 18:04:45 - INFO - ocr.facade - ============================================================
2026-09-30 18:04:45 - INFO - STDOUT - [OK] OCR ready — primary: rapidocr, fallbacks: []
2026-09-30 18:04:45 - INFO - STDOUT - [OCR] LocalOCRProcessor initialized - using dynamic engine selection
2026-09-30 18:04:45 - INFO - STDOUT - [OCR] Primary engine: rapidocr, Fallback: none
2026-09-30 18:04:45 - INFO - STDOUT - [OCR] Async OCR worker thread started
2026-09-30 18:04:45 - INFO - STDOUT - [OCR SETUP] OCR system ready
2026-09-30 18:04:46 - INFO - httpx - HTTP Request: PATCH https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?id=eq.[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:04:46 - INFO - STDOUT - [OK] Desktop status updated: logged in
2026-09-30 18:04:46 - INFO - STDOUT - [DIAGNOSTIC] Login flow: {
2026-09-30 18:04:46 - INFO - STDOUT -   "status": "success",
2026-09-30 18:04:46 - INFO - STDOUT -   "step": "complete",
2026-09-30 18:04:46 - INFO - STDOUT -   "timestamp": "2026-09-30T12:34:46.065990Z",
2026-09-30 18:04:46 - INFO - STDOUT -   "system_info": {
2026-09-30 18:04:46 - INFO - STDOUT -     "platform": "Linux",
2026-09-30 18:04:46 - INFO - STDOUT -     "platform_version": "#34~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 15:38:29 UTC 2",
2026-09-30 18:04:46 - INFO - STDOUT -     "hostname": "AMZ-LAP-240",
2026-09-30 18:04:46 - INFO - STDOUT -     "platform_details": {
2026-09-30 18:04:46 - INFO - STDOUT -       "distro": "Ubuntu 24.04.5 LTS",
2026-09-30 18:04:46 - INFO - STDOUT -       "session_type": "wayland",
2026-09-30 18:04:46 - INFO - STDOUT -       "desktop": "gnome",
2026-09-30 18:04:46 - INFO - STDOUT -       "desktop_raw": "ubuntu:GNOME",
2026-09-30 18:04:46 - INFO - STDOUT -       "kernel": "7.0.0-34-generic",
2026-09-30 18:04:46 - INFO - STDOUT -       "window_backend": null,
2026-09-30 18:04:46 - INFO - STDOUT -       "window_backends": [
2026-09-30 18:04:46 - INFO - STDOUT -         "gnome_extension",
2026-09-30 18:04:46 - INFO - STDOUT -         "atspi"
2026-09-30 18:04:46 - INFO - STDOUT -       ],
2026-09-30 18:04:46 - INFO - STDOUT -       "idle_backend": null,
2026-09-30 18:04:46 - INFO - STDOUT -       "capture_backend": "gnome_extension",
2026-09-30 18:04:46 - INFO - STDOUT -       "capture_backends": [
2026-09-30 18:04:46 - INFO - STDOUT -         "gnome_extension",
2026-09-30 18:04:46 - INFO - STDOUT -         "portal_screencast",
2026-09-30 18:04:46 - INFO - STDOUT -         "null"
2026-09-30 18:04:46 - INFO - STDOUT -       ],
2026-09-30 18:04:46 - INFO - STDOUT -       "capture_by_status": {},
2026-09-30 18:04:46 - INFO - STDOUT -       "install_mode": "package"
2026-09-30 18:04:46 - INFO - STDOUT -     }
2026-09-30 18:04:46 - INFO - STDOUT -   },
2026-09-30 18:04:46 - INFO - STDOUT -   "error_details": {
2026-09-30 18:04:46 - INFO - STDOUT -     "user_id": "[UUID]"
2026-09-30 18:04:46 - INFO - STDOUT -   }
2026-09-30 18:04:46 - INFO - STDOUT - }
2026-09-30 18:04:46 - INFO - STDOUT - [OK] LOGIN diagnostics sent to server
2026-09-30 18:04:46 - INFO - STDOUT - [INFO] Sending OCR diagnostics to server...
2026-09-30 18:04:47 - INFO - STDOUT - [OK] OCR diagnostics sent to server
2026-09-30 18:04:47 - INFO - STDOUT - [INFO] Fetching user's accessible Jira projects...
2026-09-30 18:04:47 - INFO - STDOUT - [OK] User has access to 16 projects (fetched 16 in first page, isLast=True)
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG] Raw project/search response keys: ['self', 'maxResults', 'startAt', 'total', 'isLast', 'values']
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=AATG, name=AATG (Advanced Technology Group), projectTypeKey=software
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IDIA, name=AWS_Billing_Tracker, projectTypeKey=software
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=CHAIT, name=Chaitanya Saradhi, projectTypeKey=software
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IN, name=InfraOps Amzur, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IATG, name=InfraOps ATG, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IACS, name=InfraOps AWS Cloud Security, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IEV, name=InfraOps Evoke, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IF, name=InfraOps F2MX, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IG, name=InfraOps Genesis, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=II, name=InfraOps Itracker, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IR, name=InfraOps RevUp, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=IS, name=InfraOps Stackyon, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=JRTP, name=Jira R&D Test Project, projectTypeKey=business
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=MWM, name=MyWork Mate, projectTypeKey=software
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=PROC, name=Procurement App, projectTypeKey=software
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG]   project: key=TTJ, name=Time Tracker JIRA, projectTypeKey=software
2026-09-30 18:04:47 - INFO - STDOUT - [DEBUG] All browsable project keys: ['AATG', 'IDIA', 'CHAIT', 'IN', 'IATG', 'IACS', 'IEV', 'IF', 'IG', 'II', 'IR', 'IS', 'JRTP', 'MWM', 'PROC', 'TTJ']
2026-09-30 18:04:48 - INFO - STDOUT - [MEMBER-FILTER] JQL found 2 projects from user's issues: ['AATG', 'MWM']
2026-09-30 18:04:48 - INFO - STDOUT - [DEBUG] Filtered to 2 member projects: ['AATG', 'MWM']
2026-09-30 18:04:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&is_default=eq.True&organization_id=is.null "HTTP/1.1 200 OK"
2026-09-30 18:04:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=is.null "HTTP/1.1 200 OK"
2026-09-30 18:04:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.AATG "HTTP/1.1 200 OK"
2026-09-30 18:04:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.MWM "HTTP/1.1 200 OK"
2026-09-30 18:04:49 - INFO - STDOUT - [OK] Synced 208 app classification rows from Supabase (208 global, 0 org, 0 project for ['AATG', 'MWM'])
2026-09-30 18:04:49 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-09-30 18:04:49 - INFO - STDOUT - [INFO] User needs to provide consent | email=[EMAIL]
2026-09-30 18:04:49 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:49] "[32mGET /auth/callback?state=c_2iAh7IzQpeDclzM4YBShsICQufXE35BL4xiLkLWEo&code=[JWT] HTTP/1.1[0m" 302 -
2026-09-30 18:04:49 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:49] "GET /consent HTTP/1.1" 200 -
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Consent granted for user | user_id=[ATLASSIAN_ACCOUNT]
2026-09-30 18:04:53 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Activity monitoring via the system idle clock (no input hooks)
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Activity monitor (re)started
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Offline sync and heartbeat background thread started
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Location log background thread started
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Tracking started with idle detection
2026-09-30 18:04:53 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-09-30 18:04:53 - INFO - httpx - HTTP Request: PATCH https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?id=eq.[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:04:53 - INFO - STDOUT - [OK] Heartbeat sent (v1.4.13)
2026-09-30 18:04:53 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:04:53 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-09-30 18:04:53 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-09-30 18:04:53 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-09-30 18:04:54 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/user_location_log "HTTP/1.1 201 Created"
2026-09-30 18:04:54 - INFO - STDOUT - [OK] Location logged (remote via ip_geo)
2026-09-30 18:04:54 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-09-30 18:04:54 - INFO - dq_nudge.poller - [DqNudge.poller] Started
2026-09-30 18:04:54 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: ['TTJ-87']
2026-09-30 18:04:54 - INFO - STDOUT - [OK] Description-quality nudge poller started
2026-09-30 18:04:54 - INFO - STDOUT - [OK] Jira API returned 1 issues
2026-09-30 18:04:54 - INFO - STDOUT - [PROJECT] Set to TTJ
2026-09-30 18:04:54 - INFO - timetracker_linux.session_events - [LINUX] session events: logind=yes, screensaver=yes
2026-09-30 18:04:54 - INFO - STDOUT - [OK] System event monitoring started (platform provider)
2026-09-30 18:04:54 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:54] "[32mPOST /consent/submit HTTP/1.1[0m" 302 -
2026-09-30 18:04:54 - INFO - werkzeug - [IP] - - [30/Sep/2026 18:04:54] "GET /success HTTP/1.1" 200 -
2026-09-30 18:04:54 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=eq.TTJ&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:04:54 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:04:54 - INFO - STDOUT - [OK] Tracking settings loaded for project 'TTJ' (source: organization) - mode: interval-only, interval: 900s
2026-09-30 18:04:54 - INFO - STDOUT -      - App classifications loaded: 208
2026-09-30 18:04:54 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&is_default=eq.True&organization_id=is.null "HTTP/1.1 200 OK"
2026-09-30 18:04:54 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=is.null "HTTP/1.1 200 OK"
2026-09-30 18:04:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.AATG "HTTP/1.1 200 OK"
2026-09-30 18:04:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.TTJ "HTTP/1.1 200 OK"
2026-09-30 18:04:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.MWM "HTTP/1.1 200 OK"
2026-09-30 18:04:55 - INFO - STDOUT - [OK] Synced 208 app classification rows from Supabase (208 global, 0 org, 0 project for ['AATG', 'MWM', 'TTJ'])
2026-09-30 18:04:55 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-09-30 18:04:55 - INFO - STDOUT - [OK] Tracking started (interval-only mode)
2026-09-30 18:04:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=settings&id=eq.[UUID]&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:04:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/unassigned_work_groups?select=id%2Ctotal_seconds&user_id=eq.[UUID]&organization_id=eq.[UUID]&is_assigned=eq.False "HTTP/1.1 200 OK"
2026-09-30 18:04:55 - INFO - STDOUT - [OK] Unassigned work notification shown - 1000 groups, 342.7h total
2026-09-30 18:04:55 - INFO - timetracker_linux.idle - [LINUX] idle clock: mutter
2026-09-30 18:04:55 - INFO - timetracker_linux.window.service - [LINUX] window info: gnome_extension
2026-09-30 18:04:55 - INFO - STDOUT - [INFO] Window switched at 12:34:55:
2026-09-30 18:04:55 - INFO - STDOUT -      - App: chrome
2026-09-30 18:04:55 - INFO - STDOUT -      - Title: Login Successful - Google Chrome
2026-09-30 18:04:55 - INFO - presidio-analyzer - Fetching all recognizers for language en
2026-09-30 18:04:56 - INFO - STDOUT - [PROD] chrome — Login Successful - Google Chrome
2026-09-30 18:04:56 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for chrome
2026-09-30 18:04:57 - INFO - ocr.engines.rapidocr_engine - RapidOCR engine initialized
2026-09-30 18:05:01 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:05:01 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:05:01 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:05:01 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.95, lines: 18, prep: 15.0ms, infer: 5136.5ms, privacy: 117.2ms, total: 5268.9ms)
2026-09-30 18:05:01 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.95, took: 5269.7ms, prep: 15.007582000180264ms, infer: 5136.539392000486ms, total: 5269.710092999958ms)
2026-09-30 18:05:02 - INFO - STDOUT - [INFO] Window switched at 12:35:02:
2026-09-30 18:05:02 - INFO - STDOUT -      - App: chrome
2026-09-30 18:05:02 - INFO - STDOUT -      - Title: New Tab - Google Chrome
2026-09-30 18:05:02 - INFO - STDOUT - [PROD] chrome — New Tab - Google Chrome
2026-09-30 18:05:04 - INFO - STDOUT - [INFO] Window switched at 12:35:04:
2026-09-30 18:05:04 - INFO - STDOUT -      - App: chrome
2026-09-30 18:05:04 - INFO - STDOUT -      - Title: Amzur Technologies, Inc. Mail - Google Chrome
2026-09-30 18:05:04 - INFO - STDOUT - [PROD] chrome — Amzur Technologies, Inc. Mail - Google Chrome
2026-09-30 18:05:08 - INFO - STDOUT - [INFO] Window switched at 12:35:08:
2026-09-30 18:05:08 - INFO - STDOUT -      - App: chrome
2026-09-30 18:05:08 - INFO - STDOUT -      - Title: Inbox (4,599) - [EMAIL] - Amzu
2026-09-30 18:05:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:05:08 - INFO - STDOUT - [PRIVACY] Window title redacted: 1 PII item(s)
2026-09-30 18:05:09 - INFO - STDOUT - [PROD] chrome — Inbox (4,599) - [EMAIL] - Amzu
2026-09-30 18:05:55 - INFO - STDOUT - [INTERVAL] 60s elapsed, 839s until next interval capture
2026-09-30 18:06:56 - INFO - STDOUT - [INTERVAL] 120s elapsed, 779s until next interval capture
2026-09-30 18:07:22 - INFO - STDOUT - [INFO] Window switched at 12:37:22:
2026-09-30 18:07:22 - INFO - STDOUT -      - App: cursor
2026-09-30 18:07:22 - INFO - STDOUT -      - Title: .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:07:22 - INFO - STDOUT - [PROD] cursor — .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:07:22 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for cursor
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.94, lines: 40, prep: 5.7ms, infer: 7456.0ms, privacy: 130.4ms, total: 7592.2ms)
2026-09-30 18:07:30 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.94, took: 7592.8ms, prep: 5.710997000278439ms, infer: 7456.024799000261ms, total: 7592.755534999924ms)
2026-09-30 18:07:30 - INFO - STDOUT - [INFO] Window switched at 12:37:30:
2026-09-30 18:07:30 - INFO - STDOUT -      - App: chrome
2026-09-30 18:07:30 - INFO - STDOUT -      - Title: Inbox (4,599) - [EMAIL] - Amzu
2026-09-30 18:07:30 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:07:30 - INFO - STDOUT - [PRIVACY] Window title redacted: 1 PII item(s)
2026-09-30 18:07:30 - INFO - STDOUT - [PROD] chrome — Inbox (4,599) - [EMAIL] - Amzu
2026-09-30 18:07:32 - INFO - STDOUT - [INFO] Window switched at 12:37:32:
2026-09-30 18:07:32 - INFO - STDOUT -      - App: chrome
2026-09-30 18:07:32 - INFO - STDOUT -      - Title: Amzur Technologies, Inc. Mail - Google Chrome
2026-09-30 18:07:33 - INFO - STDOUT - [PROD] chrome — Amzur Technologies, Inc. Mail - Google Chrome
2026-09-30 18:07:39 - INFO - STDOUT - [INFO] Window switched at 12:37:39:
2026-09-30 18:07:39 - INFO - STDOUT -      - App: chrome
2026-09-30 18:07:39 - INFO - STDOUT -      - Title: notes - [EMAIL] - Amzur Techno
2026-09-30 18:07:39 - INFO - STDOUT - [PRIVACY] Window title redacted: 1 PII item(s)
2026-09-30 18:07:39 - INFO - STDOUT - [PROD] chrome — notes - [EMAIL] - Amzur Techno
2026-09-30 18:08:53 - INFO - STDOUT - [INFO] Window switched at 12:38:53:
2026-09-30 18:08:53 - INFO - STDOUT -      - App: cursor
2026-09-30 18:08:53 - INFO - STDOUT -      - Title: .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:08:53 - INFO - STDOUT - [PROD] cursor — .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:08:53 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for cursor
2026-09-30 18:08:55 - INFO - STDOUT - [INTERVAL] 240s elapsed, 659s until next interval capture
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:00 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.94, lines: 40, prep: 5.5ms, infer: 6504.7ms, privacy: 111.9ms, total: 6622.4ms)
2026-09-30 18:09:00 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.94, took: 6622.9ms, prep: 5.542179999793007ms, infer: 6504.748758999995ms, total: 6622.907991999455ms)
2026-09-30 18:09:03 - INFO - STDOUT - [INFO] Window switched at 12:39:03:
2026-09-30 18:09:03 - INFO - STDOUT -      - App: chrome
2026-09-30 18:09:03 - INFO - STDOUT -      - Title: notes - [EMAIL] - Amzur Techno
2026-09-30 18:09:03 - INFO - STDOUT - [PRIVACY] Window title redacted: 1 PII item(s)
2026-09-30 18:09:04 - INFO - STDOUT - [PROD] chrome — notes - [EMAIL] - Amzur Techno
2026-09-30 18:09:12 - INFO - STDOUT - [INFO] Window switched at 12:39:12:
2026-09-30 18:09:12 - INFO - STDOUT -      - App: cursor
2026-09-30 18:09:12 - INFO - STDOUT -      - Title: .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:09:12 - INFO - STDOUT - [PROD] cursor — .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:09:12 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for cursor
2026-09-30 18:09:18 - INFO - STDOUT - [INFO] Window switched at 12:39:18:
2026-09-30 18:09:18 - INFO - STDOUT -      - App: chrome
2026-09-30 18:09:18 - INFO - STDOUT -      - Title: notes - [EMAIL] - Amzur Techno
2026-09-30 18:09:18 - INFO - STDOUT - [PRIVACY] Window title redacted: 1 PII item(s)
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - WARNING - presidio-analyzer - Entity MONEY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:19 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.94, lines: 40, prep: 5.5ms, infer: 6633.8ms, privacy: 113.9ms, total: 6753.3ms)
2026-09-30 18:09:19 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.94, took: 6754.0ms, prep: 5.522260999896389ms, infer: 6633.766683000431ms, total: 6753.972504999183ms)
2026-09-30 18:09:19 - INFO - STDOUT - [PROD] chrome — notes - [EMAIL] - Amzur Techno
2026-09-30 18:09:19 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for chrome
2026-09-30 18:09:24 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:24 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:24 - WARNING - presidio-analyzer - Entity LAW is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:24 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.95, lines: 30, prep: 5.2ms, infer: 5277.3ms, privacy: 161.3ms, total: 5443.9ms)
2026-09-30 18:09:24 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.95, took: 5444.8ms, prep: 5.150918999788701ms, infer: 5277.340962999915ms, total: 5444.772659999217ms)
2026-09-30 18:09:29 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:29 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:29 - WARNING - presidio-analyzer - Entity LAW is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:29 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.95, lines: 29, prep: 12.4ms, infer: 4629.4ms, privacy: 73.3ms, total: 4715.2ms)
2026-09-30 18:09:29 - INFO - STDOUT - [OCR] Backfill OCR: rapidocr (confidence: 0.95, took: 4715.9ms, prep: 12.442420000297716ms, infer: 4629.37114000033ms, total: 4715.8791450001445ms)
2026-09-30 18:09:37 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:37 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:37 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:37 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:37 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:37 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.94, lines: 30, prep: 6.1ms, infer: 7426.3ms, privacy: 118.0ms, total: 7550.6ms)
2026-09-30 18:09:37 - INFO - STDOUT - [OCR] Backfill OCR: rapidocr (confidence: 0.94, took: 7551.3ms, prep: 6.149967999590444ms, infer: 7426.284394000504ms, total: 7551.24388799959ms)
2026-09-30 18:09:43 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:43 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:43 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:43 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:43 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:43 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.94, lines: 30, prep: 6.3ms, infer: 6374.7ms, privacy: 113.6ms, total: 6494.7ms)
2026-09-30 18:09:43 - INFO - STDOUT - [OCR] Backfill OCR: rapidocr (confidence: 0.94, took: 6495.5ms, prep: 6.2752080002610455ms, infer: 6374.739810999927ms, total: 6495.461587999671ms)
2026-09-30 18:09:47 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:47 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:47 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:09:47 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.95, lines: 18, prep: 7.9ms, infer: 3391.8ms, privacy: 74.4ms, total: 3474.1ms)
2026-09-30 18:09:47 - INFO - STDOUT - [OCR] Backfill OCR: rapidocr (confidence: 0.95, took: 3474.8ms, prep: 7.871468999837816ms, infer: 3391.766588999417ms, total: 3474.7821900000417ms)
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Filtered 1 noise sessions (< 5s)
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'MWM', 'TTJ']
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] User assigned issues: 1 across 1 projects
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Inserting 5 activity records...
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-09-30T12:34:56.693828+00:00, window_title='Login Successful - Google Chrome'
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-09-30 18:09:47 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Insert result: data_count=5, count=None
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-09-30T12:39:47.135949+00:00
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Uploaded 5 activity records (5 pending AI, 0 pre-analyzed)
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]', '[UUID]', '[UUID]', 'ee469476-[PHONE]-9cf2-26689e28a41b']
2026-09-30 18:09:47 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]', '[UUID]', '[UUID]', 'ee469476-[PHONE]-9cf2-26689e28a41b']
2026-09-30 18:09:48 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-09-30 18:09:48 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-09-30 18:09:48 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-09-30 18:09:48 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-09-30 18:09:48 - INFO - STDOUT - [INFO] Window switched at 12:39:48:
2026-09-30 18:09:48 - INFO - STDOUT -      - App: chrome
2026-09-30 18:09:48 - INFO - STDOUT -      - Title: notes - [EMAIL] - Amzur Techno
2026-09-30 18:09:48 - INFO - STDOUT - [PRIVACY] Window title redacted: 1 PII item(s)
2026-09-30 18:09:48 - INFO - STDOUT - [PROD] chrome — notes - [EMAIL] - Amzur Techno
2026-09-30 18:09:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=eq.TTJ&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:09:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:09:55 - INFO - STDOUT - [OK] Tracking settings loaded for project 'TTJ' (source: organization) - mode: interval-only, interval: 900s
2026-09-30 18:09:55 - INFO - STDOUT -      - App classifications loaded: 208
2026-09-30 18:09:57 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-09-30 18:09:57 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-09-30 18:09:57 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:09:57 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-09-30 18:09:57 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-09-30 18:09:57 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-09-30 18:09:58 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-09-30 18:09:58 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: ['TTJ-87']
2026-09-30 18:09:58 - INFO - STDOUT - [OK] Jira API returned 1 issues
2026-09-30 18:10:56 - INFO - STDOUT - [INTERVAL] 360s elapsed, 539s until next interval capture
2026-09-30 18:14:23 - INFO - STDOUT - [INFO] Idle timeout (300s) — entering idle state
2026-09-30 18:14:23 - INFO - STDOUT - [STATE] ACTIVE → IDLE (reason: idle timeout)
2026-09-30 18:14:23 - INFO - STDOUT - [IDLE] Trimmed sessions to idle anchor 2026-09-30T12:39:22.697997+00:00: 1 phantom deleted, 0 trimmed
2026-09-30 18:14:28 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:14:28 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:14:28 - WARNING - presidio-analyzer - Entity LAW is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:14:28 - WARNING - ocr.facade - [PRIVACY] Detected 1 sensitive item(s) in OCR text from rapidocr
2026-09-30 18:14:28 - WARNING - ocr.facade - [PRIVACY]   - PASSWORD: 1 occurrence(s) REDACTED
2026-09-30 18:14:28 - INFO - ocr.facade - [PRIVACY] Redaction complete: 1 items masked (detectors: ['custom_patterns', 'presidio', 'entropy'], time: 99.5ms)
2026-09-30 18:14:28 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.95, lines: 31, prep: 5.1ms, infer: 5060.3ms, privacy: 99.5ms, total: 5166.2ms)
2026-09-30 18:14:28 - INFO - STDOUT - [OCR] Backfill OCR: rapidocr (confidence: 0.95, took: 5166.7ms, prep: 5.120390000229236ms, infer: 5060.258175999479ms, total: 5166.651032000118ms)
2026-09-30 18:14:28 - INFO - STDOUT - [BATCH] No activity records to upload
2026-09-30 18:14:33 - INFO - STDOUT - [STATE] IDLE → ACTIVE
2026-09-30 18:14:33 - INFO - STDOUT - [IDLE] Created idle record: 12:39:22 → 12:44:33 (310s, reason: idle timeout)
2026-09-30 18:14:33 - INFO - STDOUT - [IDLE] Flushing 1 idle record(s)...
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] All work sessions were noise — but idle records exist, continuing
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'MWM', 'TTJ']
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] User assigned issues: 1 across 1 projects
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Including 1 idle records in batch
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=analyzed, start_time=2026-09-30T12:39:22.697997+00:00, window_title='[Idle: idle timeout]'
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-09-30 18:14:33 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-09-30T12:44:33.348420+00:00
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (0 pending AI, 1 pre-analyzed)
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-09-30 18:14:33 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-09-30 18:14:34 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-09-30 18:14:34 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-09-30 18:14:34 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-09-30 18:14:34 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-09-30 18:14:34 - INFO - STDOUT - [INFO] Activity detected — resumed from idle
2026-09-30 18:14:34 - INFO - STDOUT - [INFO] Window switched at 12:44:34:
2026-09-30 18:14:34 - INFO - STDOUT -      - App: cursor
2026-09-30 18:14:34 - INFO - STDOUT -      - Title: .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:14:34 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:14:34 - INFO - STDOUT - [OK] Tracking settings loaded (source: organization) - mode: interval-only, interval: 900s
2026-09-30 18:14:34 - INFO - STDOUT -      - App classifications loaded: 208
2026-09-30 18:14:34 - INFO - STDOUT - [PROD] cursor — .requirements-core.txt - timetracker_linux - Curso
2026-09-30 18:14:58 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-09-30 18:14:58 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-09-30 18:14:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-09-30 18:14:59 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-09-30 18:14:59 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-09-30 18:14:59 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-09-30 18:15:00 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-09-30 18:15:00 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: ['TTJ-87']
2026-09-30 18:15:00 - INFO - STDOUT - [OK] Jira API returned 1 issues
2026-09-30 18:15:00 - INFO - STDOUT - [PROJECT] Set to TTJ
2026-09-30 18:15:00 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=eq.TTJ&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:15:00 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-09-30 18:15:00 - INFO - STDOUT - [OK] Tracking settings loaded for project 'TTJ' (source: organization) - mode: interval-only, interval: 900s
2026-09-30 18:15:00 - INFO - STDOUT -      - App classifications loaded: 208
2026-09-30 18:15:00 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&is_default=eq.True&organization_id=is.null "HTTP/1.1 200 OK"
2026-09-30 18:15:00 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=is.null "HTTP/1.1 200 OK"
2026-09-30 18:15:00 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.AATG "HTTP/1.1 200 OK"
2026-09-30 18:15:01 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.TTJ "HTTP/1.1 200 OK"
2026-09-30 18:15:01 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.MWM "HTTP/1.1 200 OK"
2026-09-30 18:15:01 - INFO - STDOUT - [OK] Synced 208 app classification rows from Supabase (208 global, 0 org, 0 project for ['AATG', 'MWM', 'TTJ'])
2026-09-30 18:15:01 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-09-30 18:15:05 - INFO - STDOUT - [INFO] Window switched at 12:45:05:
2026-09-30 18:15:05 - INFO - STDOUT -      - App: nautilus
2026-09-30 18:15:05 - INFO - STDOUT -      - Title: Home
2026-09-30 18:15:05 - INFO - STDOUT - [UNKNOWN] nautilus
2026-09-30 18:15:05 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for nautilus
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - WARNING - presidio-analyzer - Entity WORK_OF_ART is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:08 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.96, lines: 38, prep: 4.7ms, infer: 3414.2ms, privacy: 88.9ms, total: 3507.9ms)
2026-09-30 18:15:08 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.96, took: 3508.5ms, prep: 4.650957999729144ms, infer: 3414.2180689996167ms, total: 3508.5107900004004ms)
2026-09-30 18:15:09 - INFO - STDOUT - [UNKNOWN] nautilus — sending to AI server for classification (key: nautilus)
2026-09-30 18:15:09 - INFO - STDOUT - [INFO] Window switched at 12:45:09:
2026-09-30 18:15:09 - INFO - STDOUT -      - App: nautilus
2026-09-30 18:15:09 - INFO - STDOUT -      - Title: .local
2026-09-30 18:15:09 - INFO - STDOUT - [UNKNOWN] nautilus
2026-09-30 18:15:09 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for nautilus
2026-09-30 18:15:11 - INFO - STDOUT - [INFO] Window switched at 12:45:11:
2026-09-30 18:15:11 - INFO - STDOUT -      - App: nautilus
2026-09-30 18:15:11 - INFO - STDOUT -      - Title: TimeTracker
2026-09-30 18:15:11 - INFO - STDOUT - [UNKNOWN] nautilus
2026-09-30 18:15:11 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for nautilus
2026-09-30 18:15:12 - INFO - STDOUT - [AI] Classification for nautilus: productive
2026-09-30 18:15:12 - INFO - STDOUT -      Reasoning: This is the Nautilus file manager open to the user's Home directory. A file mana
2026-09-30 18:15:12 - INFO - httpx - HTTP Request: PATCH https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?user_id=eq.[UUID]&organization_id=eq.[UUID]&application_name=eq.nautilus&classification=eq.unknown&project_key=eq.TTJ "HTTP/1.1 200 OK"
2026-09-30 18:15:12 - INFO - STDOUT - [AI] Updated 5 activity_records rows for nautilus: unknown → productive
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - WARNING - presidio-analyzer - Entity WORK_OF_ART is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:13 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.96, lines: 38, prep: 5.0ms, infer: 3503.1ms, privacy: 83.4ms, total: 3591.6ms)
2026-09-30 18:15:13 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.96, took: 3592.3ms, prep: 5.002301999411429ms, infer: 3503.1437859997823ms, total: 3592.3119580002094ms)
2026-09-30 18:15:13 - INFO - STDOUT - [UNKNOWN] nautilus — already sent to AI server, skipping (key: nautilus)
2026-09-30 18:15:15 - INFO - STDOUT - [INFO] Window switched at 12:45:15:
2026-09-30 18:15:15 - INFO - STDOUT -      - App: nautilus
2026-09-30 18:15:15 - INFO - STDOUT -      - Title: logs
2026-09-30 18:15:16 - INFO - STDOUT - [UNKNOWN] nautilus
2026-09-30 18:15:16 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for nautilus
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - WARNING - presidio-analyzer - Entity WORK_OF_ART is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:16 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.96, lines: 38, prep: 6.0ms, infer: 3556.6ms, privacy: 83.2ms, total: 3645.9ms)
2026-09-30 18:15:16 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.96, took: 3646.8ms, prep: 6.043774999852758ms, infer: 3556.6052379999746ms, total: 3646.8105490002927ms)
2026-09-30 18:15:16 - INFO - STDOUT - [UNKNOWN] nautilus — already sent to AI server, skipping (key: nautilus)
2026-09-30 18:15:18 - INFO - STDOUT - [INFO] Window switched at 12:45:18:
2026-09-30 18:15:18 - INFO - STDOUT -      - App: gnome-text-editor
2026-09-30 18:15:18 - INFO - STDOUT -      - Title: timetracker.log (~/.local/share/TimeTracker/logs)
2026-09-30 18:15:18 - INFO - STDOUT - [UNKNOWN] gnome-text-editor
2026-09-30 18:15:18 - INFO - STDOUT - [OCR-ASYNC] Dispatched async OCR for gnome-text-editor
2026-09-30 18:15:20 - WARNING - presidio-analyzer - Entity PERCENT is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:20 - WARNING - presidio-analyzer - Entity QUANTITY is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:20 - WARNING - presidio-analyzer - Entity CARDINAL is not mapped to a Presidio entity, but keeping anyway. Add to `NerModelConfiguration.labels_to_ignore` to remove.
2026-09-30 18:15:20 - INFO - ocr.facade - OCR succeeded with rapidocr (confidence: 0.94, lines: 24, prep: 7.6ms, infer: 3624.1ms, privacy: 71.8ms, total: 3703.6ms)
2026-09-30 18:15:20 - INFO - STDOUT - [OCR-ASYNC] rapidocr (confidence: 0.94, took: 3704.4ms, prep: 7.61537399921508ms, infer: 3624.1194099993663ms, total: 3704.39431900013ms)
2026-09-30 18:15:20 - INFO - STDOUT - [UNKNOWN] nautilus — already sent to AI server, skipping (key: nautilus)