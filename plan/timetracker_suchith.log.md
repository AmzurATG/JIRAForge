2026-06-11 12:33:24 - INFO - app_logger - ======================================================================
2026-06-11 12:33:24 - INFO - app_logger - TimeTracker Logging System Initialized
2026-06-11 12:33:24 - INFO - app_logger - Log file: /home/suchithgoud/.local/share/TimeTracker/logs/timetracker.log
2026-06-11 12:33:24 - INFO - app_logger - Log level: INFO
2026-06-11 12:33:24 - INFO - app_logger - PII redaction: ENABLED
2026-06-11 12:33:24 - INFO - app_logger - Max log size: 10MB x 5 files = 50MB total
2026-06-11 12:33:24 - INFO - app_logger - ======================================================================
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] ======================================================================
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] TimeTracker v1.0.4 starting...
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] OS: Linux 6.17.0-35-generic #35~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 19:30:42 UTC 2
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] Python: 3.12.3 (main, Mar 23 2026, 19:04:32) [GCC 13.3.0]
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] Process ID: 471442
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] Executable: /tmp/appimage_extracted_e221844582fba437480c9b862b5af357/usr/bin/TimeTracker
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] Log file: /home/suchithgoud/.local/share/TimeTracker/logs/timetracker.log
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] Screenshot monitoring: DISABLED
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] ======================================================================
2026-06-11 12:33:24 - INFO - STDOUT - [DEBUG-MAIN] Starting TimeTracker initialization...
2026-06-11 12:33:24 - INFO - __main__ - [MAIN] Initializing TimeTracker application...
2026-06-11 12:33:24 - INFO - monitor_capture - Display environment: Linux, session=wayland, DISPLAY=':0', WAYLAND_DISPLAY='wayland-0'
2026-06-11 12:33:24 - INFO - monitor_capture - Screenshot backend: gnome-screenshot=not found, scrot=available, PIL_XCB=True
2026-06-11 12:33:24 - INFO - STDOUT - [DEBUG-MAIN] Creating TimeTracker instance...
2026-06-11 12:33:24 - INFO - STDOUT - [INFO] Initializing Time Tracker...
2026-06-11 12:33:24 - INFO - __main__ - [TRACKER] TimeTracker.__init__() starting...
2026-06-11 12:33:24 - INFO - __main__ - [TRACKER] Configuration: capture_interval=300s, web_port=51777
2026-06-11 12:33:24 - INFO - __main__ - [TRACKER] Initializing Atlassian authentication manager...
2026-06-11 12:33:24 - INFO - auth.secure_storage - SecureTokenStorage initialized (keyring_available=True)
2026-06-11 12:33:25 - INFO - STDOUT - [INFO] Keyring backend: ChainerBackend
2026-06-11 12:33:25 - INFO - __main__ - [TRACKER] Atlassian authentication manager initialized
2026-06-11 12:33:25 - INFO - STDOUT - [INFO] No pause settings file found, using defaults
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Generated new database encryption key
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG] key done
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG] migrate done
2026-06-11 12:33:25 - INFO - STDOUT - [DB] app_classifications_cache: fresh install, no migration needed
2026-06-11 12:33:25 - INFO - db_connection - [DB] [DB] app_classifications_cache: fresh install, no migration needed
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG] schema done
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG] perms done
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Offline manager initialized (DB: /home/suchithgoud/.local/share/TimeTracker/time_tracker_offline.db)
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Application initialized
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-MAIN] TimeTracker instance created
2026-06-11 12:33:25 - INFO - __main__ - [MAIN] TimeTracker initialized successfully
2026-06-11 12:33:25 - INFO - __main__ - [MAIN] Starting main application loop...
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-MAIN] Calling app.run()...
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-RUN] run() method called
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Starting Time Tracker...
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-RUN] Checking self-install...
2026-06-11 12:33:25 - INFO - STDOUT - [INFO] Running from canonical AppImage location: /home/suchithgoud/.local/share/TimeTracker/TimeTracker.AppImage
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Uninstaller created: /home/suchithgoud/.local/share/TimeTracker/uninstall.sh
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Autostart entry created: /home/suchithgoud/.config/autostart/timetracker.desktop
2026-06-11 12:33:25 - INFO - STDOUT - [OK] GNOME AppIndicator extension enabled via gdbus: [EMAIL]
2026-06-11 12:33:25 - INFO - STDOUT - [OK] First-launch marker written: /home/suchithgoud/.local/share/TimeTracker/.first_launch_done
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-RUN] Self-install check complete
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-RUN] Clearing shutdown signals...
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-RUN] Shutdown signals cleared
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG-RUN] Acquiring single instance lock...
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Lock file acquired
2026-06-11 12:33:25 - INFO - STDOUT - [INFO] SIGTERM handler registered (Linux graceful shutdown enabled)
2026-06-11 12:33:25 - INFO - STDOUT - [OK] Added to Linux autostart: /home/suchithgoud/.local/share/TimeTracker/TimeTracker.AppImage
2026-06-11 12:33:25 - INFO - STDOUT - [DEBUG] About to start web server...
2026-06-11 12:33:25 - INFO - STDOUT - b" * Serving Flask app 'desktop_app'"
2026-06-11 12:33:25 - INFO - STDOUT - b' * Debug mode: off'
2026-06-11 12:33:25 - INFO - werkzeug - [31m[1mWARNING: This is a development server. Do not use it in a production deployment. Use a production WSGI server instead.[0m
 * Running on http://[IP]:51777
2026-06-11 12:33:25 - INFO - werkzeug - [33mPress CTRL+C to quit[0m
2026-06-11 12:33:27 - INFO - STDOUT - [DEBUG] Web server thread started
2026-06-11 12:33:27 - INFO - STDOUT - [DEBUG] Checking for staged updates...
2026-06-11 12:33:27 - INFO - STDOUT - [DEBUG] Update check complete
2026-06-11 12:33:27 - INFO - STDOUT - [DEBUG] Update check complete
2026-06-11 12:33:27 - INFO - STDOUT - [DEBUG] Checking connectivity for updates...
2026-06-11 12:33:27 - INFO - STDOUT - [INFO] Checking for app updates...
2026-06-11 12:33:27 - INFO - STDOUT - [DEBUG] About to call check_for_app_updates...
2026-06-11 12:33:27 - INFO - STDOUT - [INFO] Checking for updates (current version: v1.0.4)
2026-06-11 12:33:28 - INFO - STDOUT - [INFO] App is up to date (v1.0.4)
2026-06-11 12:33:28 - INFO - STDOUT - [DEBUG] check_for_app_updates returned
2026-06-11 12:33:28 - INFO - STDOUT - [DEBUG] Starting tracking checks...
2026-06-11 12:33:28 - INFO - STDOUT - [INFO] Opening browser for authentication...
2026-06-11 12:33:29 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:33:29] "GET /login HTTP/1.1" 200 -
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] Preparing final status messages...
2026-06-11 12:33:29 - INFO - STDOUT - [OK] Application running at http://localhost:51777
2026-06-11 12:33:29 - INFO - STDOUT - [OK] Check system tray for application icon
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] About to setup system tray...
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] setup_system_tray() called
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] Icon image created: <PIL.Image.Image image mode=RGBA size=22x22 at 0x7741A6507980>
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] _build_tray_menu() called
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] Added user status item
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] Menu built with 3 items
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] Menu object created:     Login
2026-06-11 12:33:29 - INFO - STDOUT -     - - - -
2026-06-11 12:33:29 - INFO - STDOUT -     ✓ Up to Date (v1.0.4) - Click to Check
2026-06-11 12:33:29 - INFO - STDOUT - [DEBUG] Menu created in setup_system_tray:     Login
2026-06-11 12:33:29 - INFO - STDOUT -     - - - -
2026-06-11 12:33:29 - INFO - STDOUT -     ✓ Up to Date (v1.0.4) - Click to Check
2026-06-11 12:33:29 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:33:29] "[33mGET /favicon.ico HTTP/1.1[0m" 404 -
2026-06-11 12:33:30 - INFO - STDOUT - [DEBUG] pystray.Icon created with menu:     Login
2026-06-11 12:33:30 - INFO - STDOUT -     - - - -
2026-06-11 12:33:30 - INFO - STDOUT -     ✓ Up to Date (v1.0.4) - Click to Check
2026-06-11 12:33:30 - INFO - STDOUT - [DEBUG] About to call tray.run() with menu:     Login
2026-06-11 12:33:30 - INFO - STDOUT -     - - - -
2026-06-11 12:33:30 - INFO - STDOUT -     ✓ Up to Date (v1.0.4) - Click to Check
2026-06-11 12:33:30 - INFO - STDOUT - [DEBUG] on_tray_ready() CALLED — setting icon visible
2026-06-11 12:33:30 - INFO - STDOUT - [DEBUG] icon.visible set to True
2026-06-11 12:33:41 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:33:41] "GET /login HTTP/1.1" 200 -
2026-06-11 12:33:56 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:33:56] "GET /login HTTP/1.1" 200 -
2026-06-11 12:34:13 - INFO - STDOUT - [OK] Saved metadata to /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 12:34:13 - INFO - STDOUT - [OK] PKCE code_challenge generated (S256)
2026-06-11 12:34:13 - INFO - STDOUT - [OK] Redirecting to Atlassian OAuth: https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=Q8HT4J...
2026-06-11 12:34:13 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:34:13] "[32mGET /auth/atlassian HTTP/1.1[0m" 302 -
2026-06-11 12:34:51 - INFO - STDOUT - [INFO] Exchanging OAuth code for tokens...
2026-06-11 12:34:51 - INFO - STDOUT - [INFO] Exchanging OAuth code via AI Server (with PKCE)...
2026-06-11 12:34:52 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-06-11 12:34:52 - INFO - STDOUT - [OK] Saved 2 tokens to secure storage
2026-06-11 12:34:52 - INFO - STDOUT - [OK] Saved metadata to /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 12:34:52 - INFO - STDOUT - [OK] OAuth tokens received via AI Server
2026-06-11 12:34:52 - INFO - STDOUT - [INFO] Fetching user info from Atlassian...
2026-06-11 12:34:53 - INFO - STDOUT - [INFO] Initializing database connection...
2026-06-11 12:34:53 - INFO - STDOUT - [INFO] Fetching Supabase configuration from AI server...
2026-06-11 12:34:53 - INFO - STDOUT - [INFO] Fetching Supabase config from AI Server...
2026-06-11 12:34:54 - INFO - STDOUT - [OK] Supabase config loaded from AI server
2026-06-11 12:34:54 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-06-11 12:34:54 - INFO - STDOUT - [OK] Saved 2 tokens to secure storage
2026-06-11 12:34:54 - INFO - STDOUT - [OK] Saved metadata to /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 12:34:54 - INFO - STDOUT - [INFO] Fetching OCR configuration from AI server...
2026-06-11 12:34:54 - INFO - STDOUT - [INFO] Fetching OCR config from AI Server...
2026-06-11 12:34:55 - INFO - ocr.facade - OCR facade and engine cache reset — will reinitialise on next OCR call
2026-06-11 12:34:55 - INFO - STDOUT - [OK] OCR facade reset — will reinitialise with AI server config on next call
2026-06-11 12:34:55 - INFO - STDOUT - [OK] OCR config loaded from AI server (engines: winrtocr, rapidocr,easyocr)
2026-06-11 12:34:55 - INFO - STDOUT - [OK] Privacy config loaded from AI server (PII detection: enabled)
2026-06-11 12:34:55 - WARNING - ocr.config - Primary OCR engine 'winrtocr' is not compatible with linux. Switching to fallback.
2026-06-11 12:34:55 - INFO - ocr.config - Using 'rapidocr' as primary OCR engine on linux
2026-06-11 12:34:55 - INFO - ocr.config - OCR engine configuration adjusted for linux: primary=rapidocr, fallbacks=['rapidocr', 'easyocr']
2026-06-11 12:34:55 - INFO - ocr.facade - Primary OCR engine: rapidocr
2026-06-11 12:34:55 - INFO - ocr.engines.dynamic_engine - Auto-detected package 'easyocr' for engine 'easyocr'
2026-06-11 12:34:55 - WARNING - ocr.engine_factory - Dynamic engine easyocr created but package not installed
2026-06-11 12:34:55 - INFO - presidio-analyzer - Using device of type: cpu
2026-06-11 12:34:55 - ERROR - STDERR - PyInstaller/loader/pyimod02_importers.py:419: RuntimeWarning: CRITICAL: Presidio is NOT installed or failed to load. PII detection is DEGRADED — credit card Luhn validation, phone number format detection, and NER-based name/address detection are DISABLED. Error: No module named 'spacy'. Install with: pip install presidio-analyzer && python -m spacy download en_core_web_sm
2026-06-11 12:34:55 - INFO - privacy.filter - Presidio not available - install with: pip install presidio-analyzer
2026-06-11 12:34:55 - INFO - privacy.filter - Privacy filter initialized with 2 detectors
2026-06-11 12:34:55 - INFO - ocr.facade - Privacy filter initialized with detectors: ['custom_patterns', 'entropy']
2026-06-11 12:34:55 - INFO - ocr.facade - ============================================================
2026-06-11 12:34:55 - INFO - ocr.facade - OCR DIAGNOSTICS REPORT
2026-06-11 12:34:55 - INFO - ocr.facade - ============================================================
2026-06-11 12:34:55 - INFO - ocr.facade - Timestamp: 2026-06-11T07:04:55.471931Z
2026-06-11 12:34:55 - INFO - ocr.facade - Running as frozen exe: True
2026-06-11 12:34:55 - INFO - ocr.facade - Bundled path (_MEIPASS): /tmp/_MEIiBxsJT
2026-06-11 12:34:55 - INFO - ocr.facade - System: Linux #35~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 19:30:42 UTC 2
2026-06-11 12:34:55 - INFO - ocr.facade - Machine: x86_64 | Python: 3.12.3
2026-06-11 12:34:55 - INFO - ocr.facade - Hostname: suchithgoud
2026-06-11 12:34:55 - INFO - ocr.facade - Primary engine: rapidocr
2026-06-11 12:34:55 - INFO - ocr.facade - Fallback engines: ['rapidocr', 'easyocr']
2026-06-11 12:34:55 - INFO - ocr.facade - Primary engine (rapidocr): READY
2026-06-11 12:34:55 - INFO - ocr.facade - Fallback engine (rapidocr): READY
2026-06-11 12:34:55 - INFO - ocr.facade - ----------------------------------------
2026-06-11 12:34:55 - INFO - ocr.facade - ENGINE INITIALIZATION DETAILS:
2026-06-11 12:34:55 - INFO - ocr.facade -   [RAPIDOCR]
2026-06-11 12:34:55 - INFO - ocr.facade -     Engine ready: True
2026-06-11 12:34:55 - INFO - ocr.facade - ----------------------------------------
2026-06-11 12:34:55 - INFO - ocr.facade - OCR Status: READY
2026-06-11 12:34:55 - INFO - ocr.facade - ============================================================
2026-06-11 12:34:55 - INFO - STDOUT - [OK] OCR ready — primary: rapidocr, fallbacks: ['rapidocr', 'easyocr']
2026-06-11 12:34:55 - INFO - STDOUT - [OCR] LocalOCRProcessor initialized - using dynamic engine selection
2026-06-11 12:34:55 - INFO - STDOUT - [OCR] OpenCV check OK: cv2 available (/tmp/_MEIiBxsJT/cv2/__init__.py)
2026-06-11 12:34:55 - INFO - STDOUT - [OCR] Primary engine: winrtocr, Fallback: rapidocr,easyocr
2026-06-11 12:34:55 - INFO - STDOUT - [OCR] Async OCR worker thread started
2026-06-11 12:34:55 - INFO - STDOUT - [OK] Supabase client initialized for https://jvijitdewbypqbatfboi.supabase.co (timeout: 60s)
2026-06-11 12:34:55 - INFO - STDOUT - [INFO] Supabase token expired or missing, getting new one...
2026-06-11 12:34:55 - INFO - __main__ - [AUTH] Supabase token refresh required: token_exists=False, time_remaining=-1781161495s
2026-06-11 12:34:55 - INFO - STDOUT - [INFO] Requesting Supabase token from AI Server...
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Exchange-token user data: user_id=[UUID], org_id=[UUID], jira_cloud_id=[UUID]
2026-06-11 12:34:56 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Saved 3 tokens to secure storage
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Saved metadata to /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Supabase token received (expires in 3600s)
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Organization ID set from exchange-token: [UUID]
2026-06-11 12:34:56 - INFO - STDOUT - [OK] User ID set from exchange-token: [UUID]
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Jira Cloud ID pre-seeded from exchange-token: [UUID]
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Supabase JWT set on client (PostgREST + Storage)
2026-06-11 12:34:56 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=id%2C%20organization_id&atlassian_account_id=eq.712020%3A[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Found existing user | user_id=[UUID]
2026-06-11 12:34:56 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=display_name%2C%20email&id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:34:56 - INFO - STDOUT - [OK] User info cached for offline mode
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Authenticated user | email=[EMAIL]
2026-06-11 12:34:56 - INFO - httpx - HTTP Request: PATCH https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:34:56 - INFO - STDOUT - [OK] Desktop status updated: logged in
2026-06-11 12:34:56 - ERROR - STDERR - desktop_app.py:4366: DeprecationWarning: datetime.datetime.utcnow() is deprecated and scheduled for removal in a future version. Use timezone-aware objects to represent datetimes in UTC: datetime.datetime.now(datetime.UTC).
2026-06-11 12:34:56 - INFO - STDOUT - [DIAGNOSTIC] Login flow: {
2026-06-11 12:34:56 - INFO - STDOUT -   "status": "success",
2026-06-11 12:34:56 - INFO - STDOUT -   "step": "complete",
2026-06-11 12:34:56 - INFO - STDOUT -   "timestamp": "2026-06-11T07:04:56.742005Z",
2026-06-11 12:34:56 - INFO - STDOUT -   "system_info": {
2026-06-11 12:34:56 - INFO - STDOUT -     "platform": "Linux",
2026-06-11 12:34:56 - INFO - STDOUT -     "platform_version": "#35~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 19:30:42 UTC 2",
2026-06-11 12:34:56 - INFO - STDOUT -     "hostname": "suchithgoud"
2026-06-11 12:34:56 - INFO - STDOUT -   },
2026-06-11 12:34:56 - INFO - STDOUT -   "error_details": {
2026-06-11 12:34:56 - INFO - STDOUT -     "user_id": "[UUID]"
2026-06-11 12:34:56 - INFO - STDOUT -   }
2026-06-11 12:34:56 - INFO - STDOUT - }
2026-06-11 12:34:57 - INFO - STDOUT - [OK] LOGIN diagnostics sent to server
2026-06-11 12:34:57 - INFO - STDOUT - [INFO] Sending OCR diagnostics to server...
2026-06-11 12:34:57 - INFO - STDOUT - [OK] OCR diagnostics sent to server
2026-06-11 12:34:57 - INFO - STDOUT - [INFO] Fetching user's accessible Jira projects...
2026-06-11 12:34:58 - INFO - STDOUT - [OK] User has access to 11 projects (fetched 11 in first page, isLast=True)
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG] Raw project/search response keys: ['self', 'maxResults', 'startAt', 'total', 'isLast', 'values']
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=AATG, name=AATG (Advanced Technology Group), projectTypeKey=software
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IN, name=InfraOps Amzur, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IATG, name=InfraOps ATG, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IACS, name=InfraOps AWS Cloud Security, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IEV, name=InfraOps Evoke, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IF, name=InfraOps F2MX, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IG, name=InfraOps Genesis, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=II, name=InfraOps Itracker, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IR, name=InfraOps RevUp, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=IS, name=InfraOps Stackyon, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG]   project: key=JRTP, name=Jira R&D Test Project, projectTypeKey=business
2026-06-11 12:34:58 - INFO - STDOUT - [DEBUG] All browsable project keys: ['AATG', 'IN', 'IATG', 'IACS', 'IEV', 'IF', 'IG', 'II', 'IR', 'IS', 'JRTP']
2026-06-11 12:34:58 - INFO - STDOUT - [MEMBER-FILTER] JQL found 0 projects from user's issues: []
2026-06-11 12:34:58 - INFO - STDOUT - [WARN] Membership filter returned 0 projects — using full browsable list (11 projects)
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&is_default=eq.True&organization_id=is.null "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=is.null "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.II "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IF "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IS "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IN "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.AATG "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.JRTP "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IG "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IEV "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IR "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IATG "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IACS "HTTP/1.1 200 OK"
2026-06-11 12:34:59 - INFO - STDOUT - [OK] Synced 208 app classification rows from Supabase (208 global, 0 org, 0 project for ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP'])
2026-06-11 12:34:59 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-06-11 12:34:59 - INFO - STDOUT - [DEBUG] _build_tray_menu() called
2026-06-11 12:34:59 - INFO - STDOUT - [DEBUG] Added user status item
2026-06-11 12:34:59 - INFO - STDOUT - [DEBUG] Menu built with 3 items
2026-06-11 12:34:59 - INFO - STDOUT - [DEBUG] Menu object created:     Logged in as: [EMAIL]
2026-06-11 12:34:59 - INFO - STDOUT -     - - - -
2026-06-11 12:34:59 - INFO - STDOUT -     ✓ Up to Date (v1.0.4) - Click to Check
2026-06-11 12:34:59 - INFO - STDOUT - [INFO] User needs to provide consent | email=[EMAIL]
2026-06-11 12:34:59 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:34:59] "[32mGET /auth/callback?state=LG65NNBWUcmJdfJB0joTuo-dNZcqEdu1bC9a8zewGmU&code=[JWT] HTTP/1.1[0m" 302 -
2026-06-11 12:34:59 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:34:59] "GET /consent HTTP/1.1" 200 -
2026-06-11 12:35:40 - INFO - STDOUT - [OK] Consent granted for user | user_id=[ATLASSIAN_ACCOUNT]
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] Display server detected: wayland (Wayland=True)
2026-06-11 12:35:40 - INFO - STDOUT - [OK] Offline sync and heartbeat background thread started
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] Idle detection backend selected: gnome_mutter
2026-06-11 12:35:40 - INFO - STDOUT - [OK] D-Bus idle poll worker started (poll every 10s)
2026-06-11 12:35:40 - INFO - STDOUT - [OK] Activity monitoring started via gnome_mutter (5-minute idle timeout)
2026-06-11 12:35:40 - INFO - STDOUT - [DEBUG] _build_tray_menu() called
2026-06-11 12:35:40 - INFO - STDOUT - [DEBUG] Added user status item
2026-06-11 12:35:40 - INFO - STDOUT - [DEBUG] Menu built with 6 items
2026-06-11 12:35:40 - INFO - STDOUT - [DEBUG] Menu object created:     Logged in as: [EMAIL]
2026-06-11 12:35:40 - INFO - STDOUT -     - - - -
2026-06-11 12:35:40 - INFO - STDOUT -     ⚪ No active window
2026-06-11 12:35:40 - INFO - STDOUT -       View All App Rules…
2026-06-11 12:35:40 - INFO - STDOUT -     - - - -
2026-06-11 12:35:40 - INFO - STDOUT -     ✓ Up to Date (v1.0.4) - Click to Check
2026-06-11 12:35:40 - INFO - STDOUT - [OK] Tracking started with idle detection
2026-06-11 12:35:40 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:35:40] "[32mPOST /consent/submit HTTP/1.1[0m" 302 -
2026-06-11 12:35:40 - INFO - werkzeug - [IP] - - [11/Jun/2026 12:35:40] "GET /success HTTP/1.1" 200 -
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 12:35:40 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:35:40 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:35:40 - INFO - httpx - HTTP Request: PATCH https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 12:35:40 - INFO - STDOUT - [OK] Heartbeat sent (v1.0.4)
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 12:35:40 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:35:40 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 12:35:40 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 12:35:40 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 12:35:40 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 12:35:40 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 12:35:41 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 12:35:41 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 12:35:41 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 12:35:41 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 12:35:41 - INFO - STDOUT - [OK] Tracking started (event-only mode)
2026-06-11 12:35:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=settings&id=eq.[UUID]&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:35:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/unassigned_work_groups?select=id%2Ctotal_seconds&user_id=eq.[UUID]&organization_id=eq.[UUID]&is_assigned=eq.False "HTTP/1.1 200 OK"
2026-06-11 12:35:41 - INFO - STDOUT - [INFO] Window switched at 07:05:41:
2026-06-11 12:35:41 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:35:41 - INFO - STDOUT -      - Title: Login Successful - Google Chrome (Guest)
2026-06-11 12:35:42 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:35:42 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:35:42 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:35:42 - INFO - STDOUT - [PROD] Google Chrome — Login Successful - Google Chrome (Guest)
2026-06-11 12:35:46 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:35:46 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:35:46 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:36:02 - INFO - STDOUT - [INFO] Window switched at 07:06:02:
2026-06-11 12:36:02 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:02 - INFO - STDOUT -      - Title: PPG Security Document review and closure - Jun 9 -
2026-06-11 12:36:02 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:02 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:02 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:02 - INFO - STDOUT - [PROD] Google Chrome — PPG Security Document review and closure - Jun 9 -
2026-06-11 12:36:04 - INFO - STDOUT - [INFO] Window switched at 07:06:04:
2026-06-11 12:36:04 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:04 - INFO - STDOUT -      - Title: Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:04 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:04 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:04 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:04 - INFO - STDOUT - [PROD] Google Chrome — Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:06 - INFO - STDOUT - [INFO] Window switched at 07:06:06:
2026-06-11 12:36:06 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:06 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:36:06 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:06 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:06 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:06 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:36:08 - INFO - STDOUT - [INFO] Window switched at 07:06:08:
2026-06-11 12:36:08 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:08 - INFO - STDOUT -      - Title: Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:09 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:09 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:09 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:09 - INFO - STDOUT - [PROD] Google Chrome — Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:11 - INFO - STDOUT - [INFO] Window switched at 07:06:11:
2026-06-11 12:36:11 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:11 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:36:11 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:11 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:11 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:11 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:36:13 - INFO - STDOUT - [INFO] Window switched at 07:06:13:
2026-06-11 12:36:13 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:13 - INFO - STDOUT -      - Title: Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:13 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:13 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:13 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:13 - INFO - STDOUT - [PROD] Google Chrome — Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:15 - INFO - STDOUT - [INFO] Window switched at 07:06:15:
2026-06-11 12:36:15 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:15 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:36:15 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:15 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:15 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:15 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:36:17 - INFO - STDOUT - [INFO] Window switched at 07:06:17:
2026-06-11 12:36:17 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:17 - INFO - STDOUT -      - Title: Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:18 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:18 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:18 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:18 - INFO - STDOUT - [PROD] Google Chrome — Team ATG - Chat - Google Chrome (Guest)
2026-06-11 12:36:22 - INFO - STDOUT - [INFO] Window switched at 07:06:22:
2026-06-11 12:36:22 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:36:22 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:36:22 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:36:22 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:36:22 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:36:22 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:36:50 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:36:50 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:36:50 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:37:54 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:37:54 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:37:54 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:38:26 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:08:26.986334+00:00 (last upload 301s ago)
2026-06-11 12:38:26 - INFO - STDOUT - [BATCH] Filtered 1 noise sessions (< 5s)
2026-06-11 12:38:26 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 12:38:26 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Inserting 3 activity records...
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:05:42.023581+00:00, window_title='Login Successful - Google Chrome (Guest)'
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 12:38:27 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Insert result: data_count=3, count=None
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:08:26.998029+00:00
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Uploaded 3 activity records (3 pending AI, 0 pre-analyzed)
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]', '[UUID]']
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]', '[UUID]']
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 12:38:27 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 12:38:27 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 12:38:27 - INFO - STDOUT - [INFO] Window switched at 07:08:27:
2026-06-11 12:38:27 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:38:27 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:38:28 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:38:28 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:38:28 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:38:28 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:39:00 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:39:00 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:39:00 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:40:04 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:40:04 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:40:04 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:40:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:40:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:40:41 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:40:42 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 12:40:42 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 12:40:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:40:42 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 12:40:42 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 12:40:42 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 12:40:43 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 12:40:43 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 12:40:43 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 12:40:43 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 12:40:43 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 12:40:43 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 12:40:43 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 12:40:43 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 12:40:43 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 12:40:43 - INFO - STDOUT - [INFO] Window switched at 07:10:43:
2026-06-11 12:40:43 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:40:43 - INFO - STDOUT -      - Title: Chat - Audio playing - Google Chrome (Guest)
2026-06-11 12:40:43 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:40:43 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:40:43 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:40:43 - INFO - STDOUT - [PROD] Google Chrome — Chat - Audio playing - Google Chrome (Guest)
2026-06-11 12:40:45 - INFO - STDOUT - [INFO] Window switched at 07:10:45:
2026-06-11 12:40:45 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:40:45 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:40:46 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:40:46 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:40:46 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:40:46 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:41:10 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:41:10 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:41:10 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:41:40 - INFO - STDOUT - [INFO] Window switched at 07:11:40:
2026-06-11 12:41:40 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:40 - INFO - STDOUT -      - Title: Chat - Audio playing - Google Chrome (Guest)
2026-06-11 12:41:40 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:40 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:40 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:40 - INFO - STDOUT - [PROD] Google Chrome — Chat - Audio playing - Google Chrome (Guest)
2026-06-11 12:41:42 - INFO - STDOUT - [INFO] Window switched at 07:11:42:
2026-06-11 12:41:42 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:42 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:41:42 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:42 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:42 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:42 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:41:44 - INFO - STDOUT - [INFO] Window switched at 07:11:44:
2026-06-11 12:41:44 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:44 - INFO - STDOUT -      - Title: Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:45 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:45 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:45 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:45 - INFO - STDOUT - [PROD] Google Chrome — Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:47 - INFO - STDOUT - [INFO] Window switched at 07:11:47:
2026-06-11 12:41:47 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:47 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:41:47 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:47 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:47 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:47 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:41:49 - INFO - STDOUT - [INFO] Window switched at 07:11:49:
2026-06-11 12:41:49 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:49 - INFO - STDOUT -      - Title: Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:49 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:49 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:49 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:49 - INFO - STDOUT - [PROD] Google Chrome — Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:51 - INFO - STDOUT - [INFO] Window switched at 07:11:51:
2026-06-11 12:41:51 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:51 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:41:51 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:51 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:51 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:51 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:41:53 - INFO - STDOUT - [INFO] Window switched at 07:11:53:
2026-06-11 12:41:53 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:53 - INFO - STDOUT -      - Title: Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:53 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:53 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:53 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:53 - INFO - STDOUT - [PROD] Google Chrome — Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:55 - INFO - STDOUT - [INFO] Window switched at 07:11:55:
2026-06-11 12:41:55 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:55 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:41:56 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:56 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:56 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:56 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:41:58 - INFO - STDOUT - [INFO] Window switched at 07:11:58:
2026-06-11 12:41:58 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:41:58 - INFO - STDOUT -      - Title: Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:41:58 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:41:58 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:41:58 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:41:58 - INFO - STDOUT - [PROD] Google Chrome — Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:42:02 - INFO - STDOUT - [INFO] Window switched at 07:12:02:
2026-06-11 12:42:02 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:42:02 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:42:02 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:42:02 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:42:02 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:42:02 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:42:04 - INFO - STDOUT - [INFO] Window switched at 07:12:04:
2026-06-11 12:42:04 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:42:04 - INFO - STDOUT -      - Title: Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:42:04 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:42:04 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:42:04 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:42:04 - INFO - STDOUT - [PROD] Google Chrome — Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:42:06 - INFO - STDOUT - [INFO] Window switched at 07:12:06:
2026-06-11 12:42:06 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:42:06 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:42:07 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:42:07 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:42:07 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:42:07 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:42:09 - INFO - STDOUT - [INFO] Window switched at 07:12:09:
2026-06-11 12:42:09 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:42:09 - INFO - STDOUT -      - Title: Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:42:09 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:42:09 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:42:09 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:42:09 - INFO - STDOUT - [PROD] Google Chrome — Divya Amrutha, Geetashish - Chat - Google Chrome (
2026-06-11 12:42:11 - INFO - STDOUT - [INFO] Window switched at 07:12:11:
2026-06-11 12:42:11 - INFO - STDOUT -      - App: Google Chrome
2026-06-11 12:42:11 - INFO - STDOUT -      - Title: Chat - Google Chrome (Guest)
2026-06-11 12:42:11 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:42:11 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:42:11 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:42:11 - INFO - STDOUT - [PROD] Google Chrome — Chat - Google Chrome (Guest)
2026-06-11 12:42:15 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:42:15 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:42:15 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:42:51 - INFO - STDOUT - [INFO] Window switched at 07:12:51:
2026-06-11 12:42:51 - INFO - STDOUT -      - App: code
2026-06-11 12:42:51 - INFO - STDOUT -      - Title: legacy - Visual Studio Code
2026-06-11 12:42:52 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:42:52 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:42:52 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:42:52 - INFO - STDOUT - [PROD] code — legacy - Visual Studio Code
2026-06-11 12:43:08 - INFO - STDOUT - [INFO] Window switched at 07:13:08:
2026-06-11 12:43:08 - INFO - STDOUT -      - App: code
2026-06-11 12:43:08 - INFO - STDOUT -      - Title: AI_Migration_Framework_Implementation_Plan_v2.docx
2026-06-11 12:43:08 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:43:08 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:43:08 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:43:08 - INFO - STDOUT - [PROD] code — AI_Migration_Framework_Implementation_Plan_v2.docx
2026-06-11 12:43:12 - INFO - STDOUT - [INFO] Window switched at 07:13:12:
2026-06-11 12:43:12 - INFO - STDOUT -      - App: code
2026-06-11 12:43:12 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:43:12 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:43:12 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:43:12 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:43:12 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:43:20 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:43:20 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:43:20 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:13:28.765591+00:00 (last upload 300s ago)
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Filtered 2 noise sessions (< 5s)
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Inserting 4 activity records...
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:08:28.136758+00:00, window_title='Chat - Google Chrome (Guest)'
2026-06-11 12:43:28 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 12:43:29 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] Insert result: data_count=4, count=None
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:13:28.773196+00:00
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] Uploaded 4 activity records (4 pending AI, 0 pre-analyzed)
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]', '[UUID]', '[UUID]']
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]', '[UUID]', '[UUID]']
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 12:43:29 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 12:43:29 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 12:43:29 - INFO - STDOUT - [INFO] Window switched at 07:13:29:
2026-06-11 12:43:29 - INFO - STDOUT -      - App: code
2026-06-11 12:43:29 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:43:29 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:43:29 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:43:29 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:43:29 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:44:26 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:44:26 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:44:26 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:45:30 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:45:30 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:45:30 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:45:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:45:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:45:41 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:45:44 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 12:45:44 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 12:45:44 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:45:44 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 12:45:44 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 12:45:44 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 12:45:45 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 12:45:45 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 12:45:45 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 12:45:45 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 12:45:45 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 12:45:45 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 12:45:45 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 12:45:45 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 12:45:45 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 12:46:35 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:46:35 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:46:35 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:47:40 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:47:40 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:47:40 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:18:30.520256+00:00 (last upload 301s ago)
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:13:29.719408+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 12:48:30 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:18:30.528216+00:00
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:48:30 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:48:31 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 12:48:31 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 12:48:31 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 12:48:31 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 12:48:31 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 12:48:31 - INFO - STDOUT - [INFO] Window switched at 07:18:31:
2026-06-11 12:48:31 - INFO - STDOUT -      - App: code
2026-06-11 12:48:31 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:48:31 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:48:31 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:48:31 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:48:31 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:48:45 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:48:45 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:48:45 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:48:49 - INFO - STDOUT - [INFO] Idle timeout (300s) — entering idle state
2026-06-11 12:48:49 - INFO - STDOUT - [STATE] ACTIVE → IDLE (reason: idle timeout)
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:18:49.796017+00:00 (last upload 18s ago)
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:18:31.656036+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 12:48:49 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 12:48:50 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:18:49.798248+00:00
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 12:48:50 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 12:48:50 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 12:48:51 - INFO - STDOUT - [IDLE] D-Bus: idle 302s ≥ timeout 300s — entering idle
2026-06-11 12:49:21 - INFO - STDOUT - [IDLE] D-Bus: activity detected — idle reset to 8s
2026-06-11 12:49:25 - INFO - STDOUT - [INFO] Activity detected — resuming from idle
2026-06-11 12:49:25 - INFO - STDOUT - [STATE] IDLE → ACTIVE
2026-06-11 12:49:25 - INFO - STDOUT - [INFO] Window switched at 07:19:25:
2026-06-11 12:49:25 - INFO - STDOUT -      - App: code
2026-06-11 12:49:25 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:49:25 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:49:25 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:49:25 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:49:25 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:49:51 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:49:51 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:49:51 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:50:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:50:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:50:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:50:42 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:50:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:50:42 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:50:46 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 12:50:46 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 12:50:46 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:50:46 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 12:50:46 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 12:50:46 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 12:50:47 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 12:50:47 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 12:50:47 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 12:50:47 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 12:50:47 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 12:50:47 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 12:50:47 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 12:50:47 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 12:50:47 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 12:50:57 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:50:57 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:50:57 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:52:01 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:52:01 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:52:01 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:53:06 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:53:06 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:53:06 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:23:50.705512+00:00 (last upload 300s ago)
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:19:25.426319+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 12:53:50 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 12:53:51 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:23:50.713253+00:00
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 12:53:51 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 12:53:51 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 12:53:51 - INFO - STDOUT - [INFO] Window switched at 07:23:51:
2026-06-11 12:53:51 - INFO - STDOUT -      - App: code
2026-06-11 12:53:51 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:53:51 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:53:51 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:53:51 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:53:51 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:54:11 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:54:11 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:54:11 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:55:16 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:55:16 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:55:16 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:55:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:55:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:55:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:55:43 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:55:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 12:55:43 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 12:55:49 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 12:55:49 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 12:55:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 12:55:49 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 12:55:49 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 12:55:49 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 12:55:51 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 12:55:51 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 12:55:51 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 12:55:51 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 12:55:51 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 12:55:52 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 12:55:52 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 12:55:52 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 12:55:52 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 12:56:22 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:56:22 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:56:22 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:57:26 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:57:26 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:57:26 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:58:31 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:58:31 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:58:31 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:28:53.146305+00:00 (last upload 301s ago)
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:23:51.849615+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 12:58:53 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:28:53.148471+00:00
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 12:58:53 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 12:58:53 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 12:58:53 - INFO - STDOUT - [INFO] Window switched at 07:28:53:
2026-06-11 12:58:53 - INFO - STDOUT -      - App: code
2026-06-11 12:58:53 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:58:54 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:58:54 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:58:54 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 12:58:54 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 12:59:36 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:59:36 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:59:36 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:00:40 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:00:40 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:00:40 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:00:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 13:00:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 13:00:43 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 13:00:52 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 13:00:52 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 13:00:53 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 13:00:53 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 13:00:53 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 13:00:53 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 13:00:53 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 13:00:53 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 13:00:53 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 13:00:53 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 13:00:53 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 13:00:54 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 13:00:54 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 13:00:54 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 13:00:54 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 13:01:46 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:01:46 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:01:46 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:02:29 - INFO - STDOUT - [INFO] Window switched at 07:32:29:
2026-06-11 13:02:29 - INFO - STDOUT -      - App: Unknown
2026-06-11 13:02:29 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:02:29 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 13:02:29 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 13:02:29 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 13:02:29 - INFO - STDOUT - [UNKNOWN] Unknown — sending to AI server for classification (key: unknown)
2026-06-11 13:02:29 - INFO - STDOUT - [UNKNOWN] Unknown
2026-06-11 13:02:31 - INFO - STDOUT - [INFO] Window switched at 07:32:31:
2026-06-11 13:02:31 - INFO - STDOUT -      - App: code
2026-06-11 13:02:31 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:02:31 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 13:02:31 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 13:02:31 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 13:02:31 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:02:32 - INFO - STDOUT - [AI] Classification for Unknown: productive
2026-06-11 13:02:32 - INFO - STDOUT -      Reasoning: The window title 'BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Code' clearly
2026-06-11 13:02:33 - INFO - httpx - HTTP Request: PATCH https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?user_id=eq.[UUID]&organization_id=eq.[UUID]&application_name=eq.Unknown&classification=eq.unknown "HTTP/1.1 200 OK"
2026-06-11 13:02:33 - INFO - STDOUT - [AI] Updated 0 activity_records rows for Unknown: unknown → productive
2026-06-11 13:02:52 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:02:52 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:02:52 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:33:54.357841+00:00 (last upload 300s ago)
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Filtered 1 noise sessions (< 5s)
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:28:54.029165+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 13:03:54 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:33:54.365770+00:00
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 13:03:54 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 13:03:54 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 13:03:54 - INFO - STDOUT - [INFO] Window switched at 07:33:54:
2026-06-11 13:03:54 - INFO - STDOUT -      - App: code
2026-06-11 13:03:54 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:03:54 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 13:03:54 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 13:03:54 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 13:03:54 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:03:56 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:03:56 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:03:56 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:05:01 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:05:01 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:05:01 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:05:41 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&is_default=eq.True&organization_id=is.null "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=is.null "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.II "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IF "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IS "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IN "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.AATG "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.JRTP "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IG "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IEV "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IR "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IATG "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IACS "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - STDOUT - [OK] Synced 208 app classification rows from Supabase (208 global, 0 org, 0 project for ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP'])
2026-06-11 13:05:42 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=settings&id=eq.[UUID]&limit=1 "HTTP/1.1 200 OK"
2026-06-11 13:05:42 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/unassigned_work_groups?select=id%2Ctotal_seconds&user_id=eq.[UUID]&organization_id=eq.[UUID]&is_assigned=eq.False "HTTP/1.1 200 OK"
2026-06-11 13:05:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 13:05:43 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 13:05:43 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 13:05:55 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 13:05:55 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 13:05:55 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 13:05:55 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 13:05:55 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 13:05:55 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 13:05:55 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 13:05:55 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 13:05:55 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 13:05:55 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 13:05:55 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 13:05:56 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 13:05:56 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 13:05:56 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 13:05:56 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 13:06:06 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:06:06 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:06:06 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:07:10 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:07:10 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:07:10 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:08:14 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:08:14 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:08:14 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T07:38:55.119568+00:00 (last upload 300s ago)
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:33:54.923740+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 13:08:55 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T07:38:55.122888+00:00
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 13:08:55 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 13:08:55 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 13:08:55 - INFO - STDOUT - [INFO] Window switched at 07:38:55:
2026-06-11 13:08:55 - INFO - STDOUT -      - App: code
2026-06-11 13:08:55 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:08:56 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 13:08:56 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 13:08:56 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 13:08:56 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 13:09:20 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 13:09:20 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 13:09:20 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 13:09:58 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 13:09:58 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 13:09:58 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 13:09:58 - INFO - STDOUT - [UNKNOWN] Unknown — already sent to AI server, skipping (key: unknown)
2026-06-11 13:09:58 - INFO - STDOUT - [UNKNOWN] Unknown
2026-06-11 13:10:02 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'atspi' circuit-open for 60s
2026-06-11 17:06:30 - INFO - STDOUT - [INFO] Large time gap detected: 14188s — system was likely suspended
2026-06-11 17:06:30 - INFO - STDOUT - [INFO] Access token expired, attempting refresh (attempt 1/3)...
2026-06-11 17:06:30 - INFO - STDOUT - [INFO] Refreshing access token via AI Server...
2026-06-11 17:06:30 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T11:36:30.888530+00:00 (last upload 14254s ago)
2026-06-11 17:06:30 - INFO - STDOUT - [ERROR] Failed to refresh access token: HTTPSConnectionPool(host='forgesync.amzur.com', port=443): Max retries exceeded with url: /api/auth/refresh-token (Caused by NameResolutionError("HTTPSConnection(host='forgesync.amzur.com', port=443): Failed to resolve 'forgesync.amzur.com' ([Errno -3] Temporary failure in name resolution)"))
2026-06-11 17:06:30 - ERROR - __main__ - [AUTH] token_refresh_exception | error_code=OAUTH_TEMPORARY_FAILURE | exception_type=ConnectionError | message=HTTPSConnectionPool(host='forgesync.amzur.com', port=443): Max retries exceeded with url: /api/auth/refresh-token (Caused by NameResolutionError("HTTPSConnection(host='forgesync.amzur.com', port=443): Failed to resolve 'forgesync.amzur.com' ([Errno -3] Temporary failure in name resolution)")) | next_action=retry_refresh
2026-06-11 17:06:30 - INFO - STDOUT - [INFO] Refresh failed, retrying in 2s...
2026-06-11 17:06:30 - INFO - STDOUT - [WARN] Network connectivity lost - switching to offline mode
2026-06-11 17:06:30 - INFO - STDOUT - [BATCH] Offline — restoring 2 sessions to SQLite for retry
2026-06-11 17:06:30 - INFO - STDOUT - [BATCH] Restored 2 sessions to SQLite for retry
2026-06-11 17:06:30 - INFO - STDOUT - [WARN] Failed to fetch tracking settings: [Errno -3] Temporary failure in name resolution
2026-06-11 17:06:31 - INFO - STDOUT - [INFO] Screen still locked after suspension — entering idle state
2026-06-11 17:06:31 - INFO - STDOUT - [STATE] ACTIVE → IDLE (reason: screen still locked after suspension)
2026-06-11 17:06:31 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:32 - INFO - STDOUT - [INFO] Access token expired, attempting refresh (attempt 2/3)...
2026-06-11 17:06:32 - INFO - STDOUT - [INFO] Refreshing access token via AI Server...
2026-06-11 17:06:32 - INFO - STDOUT - [ERROR] Failed to refresh access token: HTTPSConnectionPool(host='forgesync.amzur.com', port=443): Max retries exceeded with url: /api/auth/refresh-token (Caused by NameResolutionError("HTTPSConnection(host='forgesync.amzur.com', port=443): Failed to resolve 'forgesync.amzur.com' ([Errno -3] Temporary failure in name resolution)"))
2026-06-11 17:06:32 - ERROR - __main__ - [AUTH] token_refresh_exception | error_code=OAUTH_TEMPORARY_FAILURE | exception_type=ConnectionError | message=HTTPSConnectionPool(host='forgesync.amzur.com', port=443): Max retries exceeded with url: /api/auth/refresh-token (Caused by NameResolutionError("HTTPSConnection(host='forgesync.amzur.com', port=443): Failed to resolve 'forgesync.amzur.com' ([Errno -3] Temporary failure in name resolution)")) | next_action=retry_refresh
2026-06-11 17:06:32 - INFO - STDOUT - [INFO] Refresh failed, retrying in 4s...
2026-06-11 17:06:34 - INFO - STDOUT - [INFO] Access token expired, attempting refresh (attempt 1/3)...
2026-06-11 17:06:34 - INFO - STDOUT - [INFO] Refreshing access token via AI Server...
2026-06-11 17:06:34 - INFO - STDOUT - [ERROR] Failed to refresh access token: HTTPSConnectionPool(host='forgesync.amzur.com', port=443): Max retries exceeded with url: /api/auth/refresh-token (Caused by NameResolutionError("HTTPSConnection(host='forgesync.amzur.com', port=443): Failed to resolve 'forgesync.amzur.com' ([Errno -3] Temporary failure in name resolution)"))
2026-06-11 17:06:34 - ERROR - __main__ - [AUTH] token_refresh_exception | error_code=OAUTH_TEMPORARY_FAILURE | exception_type=ConnectionError | message=HTTPSConnectionPool(host='forgesync.amzur.com', port=443): Max retries exceeded with url: /api/auth/refresh-token (Caused by NameResolutionError("HTTPSConnection(host='forgesync.amzur.com', port=443): Failed to resolve 'forgesync.amzur.com' ([Errno -3] Temporary failure in name resolution)")) | next_action=retry_refresh
2026-06-11 17:06:34 - INFO - STDOUT - [INFO] Refresh failed, retrying in 2s...
2026-06-11 17:06:36 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:36 - INFO - STDOUT - [INFO] Access token expired, attempting refresh (attempt 2/3)...
2026-06-11 17:06:36 - INFO - STDOUT - [INFO] Refreshing access token via AI Server...
2026-06-11 17:06:36 - INFO - STDOUT - [INFO] Access token expired, attempting refresh (attempt 3/3)...
2026-06-11 17:06:37 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-06-11 17:06:37 - INFO - STDOUT - [OK] Saved 3 tokens to secure storage
2026-06-11 17:06:37 - INFO - STDOUT - [OK] Saved metadata to /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 17:06:37 - INFO - __main__ - [AUTH] token_refresh_succeeded | refresh_fail_count=0 | invalid_flag=False | prior_error_code=
2026-06-11 17:06:37 - INFO - STDOUT - [OK] Access token refreshed successfully via AI Server
2026-06-11 17:06:37 - INFO - STDOUT - [INFO] Token already refreshed by another thread, skipping
2026-06-11 17:06:37 - INFO - STDOUT - [INFO] Supabase JWT nearing expiry, refreshing proactively...
2026-06-11 17:06:37 - INFO - STDOUT - [INFO] Supabase token expired or missing, getting new one...
2026-06-11 17:06:37 - INFO - __main__ - [AUTH] Supabase token refresh required: token_exists=True, time_remaining=-12702s
2026-06-11 17:06:37 - INFO - STDOUT - [INFO] Requesting Supabase token from AI Server...
2026-06-11 17:06:38 - INFO - STDOUT - [OK] Exchange-token user data: user_id=[UUID], org_id=[UUID], jira_cloud_id=[UUID]
2026-06-11 17:06:38 - INFO - auth.secure_storage - Tokens saved to keyring for default
2026-06-11 17:06:38 - INFO - STDOUT - [OK] Saved 3 tokens to secure storage
2026-06-11 17:06:38 - INFO - STDOUT - [OK] Saved metadata to /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 17:06:38 - INFO - STDOUT - [OK] Supabase token received (expires in 3600s)
2026-06-11 17:06:38 - INFO - STDOUT - [OK] Supabase JWT set on client (PostgREST + Storage)
2026-06-11 17:06:38 - INFO - STDOUT - [OK] Supabase JWT refresh successful
2026-06-11 17:06:41 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:41 - INFO - STDOUT - [INFO] Window switched at 11:36:41:
2026-06-11 17:06:41 - INFO - STDOUT -      - App: code
2026-06-11 17:06:41 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:06:41 - INFO - STDOUT - [INFO] Window switch detected while idle — triggering resume (pynput fallback)
2026-06-11 17:06:41 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:06:41 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:06:41 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:06:41 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:06:43 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:43 - INFO - STDOUT - [INFO] Activity detected — resuming from idle
2026-06-11 17:06:43 - INFO - STDOUT - [STATE] IDLE → ACTIVE
2026-06-11 17:06:43 - INFO - STDOUT - [INFO] Window switched at 11:36:43:
2026-06-11 17:06:43 - INFO - STDOUT -      - App: code
2026-06-11 17:06:43 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:06:44 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:06:44 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:06:44 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:06:44 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:06:46 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 17:06:46 - INFO - STDOUT - [INFO] Offline - loading project settings from local cache...
2026-06-11 17:06:46 - INFO - STDOUT - [WARN] No cached project settings available offline
2026-06-11 17:06:46 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 17:06:46 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 17:06:46 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 17:06:46 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 17:06:46 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 17:06:46 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 17:06:46 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 17:06:47 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 17:06:47 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 17:06:47 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 17:06:47 - INFO - STDOUT - [INFO] Fetching user's accessible Jira projects...
2026-06-11 17:06:47 - INFO - STDOUT - [OK] User has access to 11 projects (fetched 11 in first page, isLast=True)
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG] Raw project/search response keys: ['self', 'maxResults', 'startAt', 'total', 'isLast', 'values']
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=AATG, name=AATG (Advanced Technology Group), projectTypeKey=software
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IN, name=InfraOps Amzur, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IATG, name=InfraOps ATG, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IACS, name=InfraOps AWS Cloud Security, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IEV, name=InfraOps Evoke, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IF, name=InfraOps F2MX, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IG, name=InfraOps Genesis, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=II, name=InfraOps Itracker, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IR, name=InfraOps RevUp, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=IS, name=InfraOps Stackyon, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG]   project: key=JRTP, name=Jira R&D Test Project, projectTypeKey=business
2026-06-11 17:06:47 - INFO - STDOUT - [DEBUG] All browsable project keys: ['AATG', 'IN', 'IATG', 'IACS', 'IEV', 'IF', 'IG', 'II', 'IR', 'IS', 'JRTP']
2026-06-11 17:06:48 - INFO - STDOUT - [MEMBER-FILTER] JQL found 0 projects from user's issues: []
2026-06-11 17:06:48 - INFO - STDOUT - [WARN] Membership filter returned 0 projects — using full browsable list (11 projects)
2026-06-11 17:06:48 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 17:06:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&is_default=eq.True&organization_id=is.null "HTTP/1.1 200 OK"
2026-06-11 17:06:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=is.null "HTTP/1.1 200 OK"
2026-06-11 17:06:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.II "HTTP/1.1 200 OK"
2026-06-11 17:06:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IF "HTTP/1.1 200 OK"
2026-06-11 17:06:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IS "HTTP/1.1 200 OK"
2026-06-11 17:06:48 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IN "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.AATG "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.JRTP "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IG "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IEV "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IR "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IATG "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/application_classifications?select=identifier%2C%20display_name%2C%20classification%2C%20match_by&organization_id=eq.[UUID]&project_key=eq.IACS "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - STDOUT - [OK] Synced 208 app classification rows from Supabase (208 global, 0 org, 0 project for ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP'])
2026-06-11 17:06:49 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=settings&id=eq.[UUID]&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/unassigned_work_groups?select=id%2Ctotal_seconds&user_id=eq.[UUID]&organization_id=eq.[UUID]&is_assigned=eq.False "HTTP/1.1 200 OK"
2026-06-11 17:06:49 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:49 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:06:49 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:06:49 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:06:51 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:53 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:55 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:57 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:06:59 - INFO - STDOUT - [INFO] Offline - skipping update check
2026-06-11 17:07:01 - INFO - STDOUT - [OK] Network connectivity restored
2026-06-11 17:07:01 - INFO - STDOUT - [INFO] Checking for updates (current version: v1.0.4)
2026-06-11 17:07:01 - INFO - STDOUT - [INFO] App is up to date (v1.0.4)
2026-06-11 17:07:31 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:07:31 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:07:31 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 17:07:54 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:07:54 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:07:54 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:08:58 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:08:58 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:08:58 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:10:03 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:10:03 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:10:03 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:11:07 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:11:07 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:11:07 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T11:41:32.093349+00:00 (last upload 301s ago)
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Inserting 2 activity records...
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T07:38:56.137661+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 17:11:32 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Insert result: data_count=2, count=None
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T11:41:32.101409+00:00
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Uploaded 2 activity records (2 pending AI, 0 pre-analyzed)
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]']
2026-06-11 17:11:32 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]', '[UUID]']
2026-06-11 17:11:33 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 17:11:33 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 17:11:33 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 17:11:33 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 17:11:33 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 17:11:33 - INFO - STDOUT - [INFO] Window switched at 11:41:33:
2026-06-11 17:11:33 - INFO - STDOUT -      - App: code
2026-06-11 17:11:33 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:11:33 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:11:33 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:11:33 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:11:33 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:11:49 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 17:11:49 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 17:11:50 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 17:11:50 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 17:11:50 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 17:11:50 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 17:11:50 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 17:11:50 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 17:11:50 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 17:11:50 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 17:11:50 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 17:11:50 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 17:11:50 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 17:11:50 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 17:11:50 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 17:12:13 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:12:13 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:12:13 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:12:23 - INFO - STDOUT - [INFO] Idle timeout (300s) — entering idle state
2026-06-11 17:12:23 - INFO - STDOUT - [STATE] ACTIVE → IDLE (reason: idle timeout)
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T11:42:23.290672+00:00 (last upload 50s ago)
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T11:41:33.454224+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 17:12:23 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T11:42:23.292497+00:00
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 17:12:23 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 17:12:23 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 17:12:31 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:12:31 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:12:31 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 17:12:33 - INFO - STDOUT - [INFO] Window switched at 11:42:33:
2026-06-11 17:12:33 - INFO - STDOUT -      - App: code
2026-06-11 17:12:33 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:12:33 - INFO - STDOUT - [INFO] Window switch detected while idle — triggering resume (pynput fallback)
2026-06-11 17:12:34 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:12:34 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:12:34 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:12:34 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:12:36 - INFO - STDOUT - [INFO] Activity detected — resuming from idle
2026-06-11 17:12:36 - INFO - STDOUT - [STATE] IDLE → ACTIVE
2026-06-11 17:12:36 - INFO - STDOUT - [INFO] Window switched at 11:42:36:
2026-06-11 17:12:36 - INFO - STDOUT -      - App: code
2026-06-11 17:12:36 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:12:36 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:12:36 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:12:36 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:12:36 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:13:19 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:13:19 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:13:19 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:14:23 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:14:23 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:14:23 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:15:28 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:15:28 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:15:28 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:16:32 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:16:32 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:16:32 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:16:51 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 17:16:51 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 17:16:51 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 17:16:51 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 17:16:51 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 17:16:51 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 17:16:52 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 17:16:52 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 17:16:52 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 17:16:52 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 17:16:52 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 17:16:52 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 17:16:52 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 17:16:52 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 17:16:52 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T11:47:25.057298+00:00 (last upload 301s ago)
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T11:42:34.355371+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 17:17:25 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T11:47:25.065159+00:00
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 17:17:25 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 17:17:25 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 17:17:25 - INFO - STDOUT - [INFO] Window switched at 11:47:25:
2026-06-11 17:17:25 - INFO - STDOUT -      - App: code
2026-06-11 17:17:25 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:17:25 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:17:25 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:17:25 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:17:25 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:17:31 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:17:31 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:17:31 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 17:17:31 - INFO - STDOUT - [IDLE] D-Bus: idle 303s ≥ timeout 300s — entering idle
2026-06-11 17:17:31 - INFO - STDOUT - [STATE] ACTIVE → IDLE (reason: idle timeout)
2026-06-11 17:17:37 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:17:37 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:17:37 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:22:32 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:22:32 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=eq.[UUID]&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:22:32 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:22:32 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 17:22:32 - INFO - STDOUT - [IDLE] D-Bus: activity detected — idle reset to 5s
2026-06-11 17:22:32 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/tracking_settings?select=%2A&organization_id=is.null&project_key=is.null&limit=1 "HTTP/1.1 200 OK"
2026-06-11 17:22:32 - INFO - STDOUT - [INFO] No tracking settings found in Supabase, using defaults
2026-06-11 17:22:32 - INFO - STDOUT - [INFO] Activity detected — resuming from idle
2026-06-11 17:22:32 - INFO - STDOUT - [STATE] IDLE → ACTIVE
2026-06-11 17:22:32 - INFO - STDOUT - [INFO] Window switched at 11:52:32:
2026-06-11 17:22:32 - INFO - STDOUT -      - App: code
2026-06-11 17:22:32 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:22:32 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:22:32 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:22:32 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:22:32 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:22:34 - INFO - STDOUT - [INFO] Attempting to fetch Jira issues...
2026-06-11 17:22:34 - INFO - STDOUT - [INFO] Fetching project settings from Supabase...
2026-06-11 17:22:34 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/project_settings?select=project_key%2C%20project_name%2C%20tracked_statuses&organization_id=eq.[UUID] "HTTP/1.1 200 OK"
2026-06-11 17:22:34 - INFO - STDOUT - [INFO] No project settings found, will use default (In Progress)
2026-06-11 17:22:34 - INFO - STDOUT - [INFO] No project settings, using statusCategory = 'In Progress'
2026-06-11 17:22:34 - INFO - STDOUT - [INFO] Querying Jira with JQL (POST): assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d
2026-06-11 17:22:35 - INFO - STDOUT - !!!DEBUG!!! Main JQL query executed. Response status: 200
2026-06-11 17:22:35 - INFO - STDOUT - !!!DEBUG!!! Main JQL response issues: []
2026-06-11 17:22:35 - INFO - STDOUT - [OK] Jira API returned 0 issues
2026-06-11 17:22:35 - INFO - STDOUT - !!!DEBUG!!! Entering fallback JQL block for assigned issues.
2026-06-11 17:22:35 - INFO - STDOUT - [INFO] Retrying with fallback JQL (status-based, all project types)
2026-06-11 17:22:36 - INFO - STDOUT - !!!DEBUG!!! Fallback JQL issues: []
2026-06-11 17:22:36 - INFO - STDOUT - !!!DEBUG!!! Combined fallback issues: []
2026-06-11 17:22:36 - INFO - STDOUT - !!!DEBUG!!! Exiting fallback JQL block.
2026-06-11 17:22:36 - INFO - STDOUT - [INFO] User has 11 projects but no assigned issues — cannot determine project key
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Triggered at 2026-06-11T11:52:36.077920+00:00 (last upload 310s ago)
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Known project keys: ['AATG', 'IACS', 'IATG', 'IEV', 'IF', 'IG', 'II', 'IN', 'IR', 'IS', 'JRTP']
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] User assigned issues: 0 across 0 projects
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Inserting 1 activity records...
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] user_id=[UUID], org_id=[UUID]
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Target table: activity_records | user_id=[UUID]
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] JWT check: sub=[UUID], role=authenticated, expired=False, exp=[PHONE]
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Sample record: user_id=[UUID], org_id=[UUID], status=pending, start_time=2026-06-11T11:47:25.772278+00:00, window_title='BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co'
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Supabase URL: https://jvijitdewbypqbatfboi.supabase.co
2026-06-11 17:22:36 - INFO - httpx - HTTP Request: POST https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records "HTTP/1.1 201 Created"
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Insert result: data_count=1, count=None
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Correlation ID | batch_timestamp=2026-06-11T11:52:36.079618+00:00
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Uploaded 1 activity records (1 pending AI, 0 pre-analyzed)
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Inserted record IDs | ids=['[UUID]']
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] RAW HTTP verify: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/activity_records?id=eq.[UUID]&select=id
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] RAW HTTP result: status=200, rows=1, body=[{"id":"[UUID]"}]
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] RAW HTTP verification PASSED — record [UUID] confirmed via independent HTTP call
2026-06-11 17:22:36 - INFO - STDOUT - [BATCH] Upload verified and committed successfully
2026-06-11 17:22:36 - INFO - STDOUT - [WARN] FIX-9: _drain_pending_finalizes error: 'DatabaseConnectionManager' object has no attribute 'fetchall'
2026-06-11 17:22:36 - INFO - STDOUT - [INFO] Window switched at 11:52:36:
2026-06-11 17:22:36 - INFO - STDOUT -      - App: code
2026-06-11 17:22:36 - INFO - STDOUT -      - Title: BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:22:36 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 17:22:36 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 17:22:36 - INFO - STDOUT - [OCR] Screenshot capture skipped (no valid monitor target)
2026-06-11 17:22:36 - INFO - STDOUT - [PROD] code — BLOCKED-ON-EXTERNAL.md - legacy - Visual Studio Co
2026-06-11 17:22:38 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 17:22:38 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 17:22:38 - INFO - STDOUT - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s
2026-06-11 17:23:03 - ERROR - dbus.proxies - Introspect error on :1.33:/org/gnome/Mutter/IdleMonitor/Core: dbus.exceptions.DBusException: org.freedesktop.DBus.Error.NoReply: Message recipient disconnected from message bus without replying
2026-06-11 17:36:35 - INFO - app_logger - ======================================================================
2026-06-11 17:36:35 - INFO - app_logger - TimeTracker Logging System Initialized
2026-06-11 17:36:35 - INFO - app_logger - Log file: /home/suchithgoud/.local/share/TimeTracker/logs/timetracker.log
2026-06-11 17:36:35 - INFO - app_logger - Log level: INFO
2026-06-11 17:36:35 - INFO - app_logger - PII redaction: ENABLED
2026-06-11 17:36:35 - INFO - app_logger - Max log size: 10MB x 5 files = 50MB total
2026-06-11 17:36:35 - INFO - app_logger - ======================================================================
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] ======================================================================
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] TimeTracker v1.0.4 starting...
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] OS: Linux 6.17.0-35-generic #35~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 19:30:42 UTC 2
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] Python: 3.12.3 (main, Mar 23 2026, 19:04:32) [GCC 13.3.0]
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] Process ID: 522059
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] Executable: /tmp/.mount_TimeTrOVccqJ/usr/bin/TimeTracker
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] Log file: /home/suchithgoud/.local/share/TimeTracker/logs/timetracker.log
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] Screenshot monitoring: DISABLED
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] ======================================================================
2026-06-11 17:36:35 - INFO - STDOUT - [DEBUG-MAIN] Starting TimeTracker initialization...
2026-06-11 17:36:35 - INFO - __main__ - [MAIN] Initializing TimeTracker application...
2026-06-11 17:36:35 - INFO - monitor_capture - Display environment: Linux, session=wayland, DISPLAY=':0', WAYLAND_DISPLAY='wayland-0'
2026-06-11 17:36:35 - INFO - monitor_capture - Screenshot backend: gnome-screenshot=not found, scrot=available, PIL_XCB=True
2026-06-11 17:36:35 - INFO - STDOUT - [DEBUG-MAIN] Creating TimeTracker instance...
2026-06-11 17:36:35 - INFO - STDOUT - [INFO] Initializing Time Tracker...
2026-06-11 17:36:35 - INFO - __main__ - [TRACKER] TimeTracker.__init__() starting...
2026-06-11 17:36:35 - INFO - __main__ - [TRACKER] Configuration: capture_interval=300s, web_port=51777
2026-06-11 17:36:35 - INFO - __main__ - [TRACKER] Initializing Atlassian authentication manager...
2026-06-11 17:36:35 - INFO - auth.secure_storage - SecureTokenStorage initialized (keyring_available=True)
2026-06-11 17:36:35 - INFO - STDOUT - [INFO] Keyring backend: ChainerBackend
2026-06-11 17:36:35 - INFO - STDOUT - [OK] Loaded metadata from /home/suchithgoud/.local/share/TimeTracker/auth_metadata.json
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Loaded 3 tokens from secure storage
2026-06-11 17:36:36 - INFO - __main__ - [TRACKER] Atlassian authentication manager initialized
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] No pause settings file found, using defaults
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG] key done
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG] migrate done
2026-06-11 17:36:36 - INFO - STDOUT - [DB] app_classifications_cache: schema v2 already present, skipping migration
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG] schema done
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG] perms done
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Offline manager initialized (DB: /home/suchithgoud/.local/share/TimeTracker/time_tracker_offline.db)
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Loaded 208 app classifications into memory
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Application initialized
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-MAIN] TimeTracker instance created
2026-06-11 17:36:36 - INFO - __main__ - [MAIN] TimeTracker initialized successfully
2026-06-11 17:36:36 - INFO - __main__ - [MAIN] Starting main application loop...
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-MAIN] Calling app.run()...
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-RUN] run() method called
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Starting Time Tracker...
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-RUN] Checking self-install...
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] Running from canonical AppImage location: /home/suchithgoud/.local/share/TimeTracker/TimeTracker.AppImage
2026-06-11 17:36:36 - INFO - STDOUT - [OK] GNOME AppIndicator extension enabled via gdbus: [EMAIL]
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-RUN] Self-install check complete
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-RUN] Clearing shutdown signals...
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-RUN] Shutdown signals cleared
2026-06-11 17:36:36 - INFO - STDOUT - [DEBUG-RUN] Acquiring single instance lock...
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] Removing stale lock file (PID 471442 not running)
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Lock file acquired
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] SIGTERM handler registered (Linux graceful shutdown enabled)
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Added to Linux autostart: /home/suchithgoud/.local/share/TimeTracker/TimeTracker.AppImage
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Restored organization_id from cache: [UUID]
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] Fetching Supabase configuration from AI server...
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] Using locally cached Supabase config (last fetched <24h ago)
2026-06-11 17:36:36 - INFO - STDOUT - [OK] Supabase config loaded from AI server
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] Fetching OCR configuration from AI server...
2026-06-11 17:36:36 - INFO - STDOUT - [INFO] Fetching OCR config from AI Server...
2026-06-11 17:36:37 - INFO - ocr.facade - OCR facade and engine cache reset — will reinitialise on next OCR call
2026-06-11 17:36:37 - INFO - STDOUT - [OK] OCR facade reset — will reinitialise with AI server config on next call
2026-06-11 17:36:37 - INFO - STDOUT - [OK] OCR config loaded from AI server (engines: winrtocr, rapidocr,easyocr)
2026-06-11 17:36:37 - INFO - STDOUT - [OK] Privacy config loaded from AI server (PII detection: enabled)
2026-06-11 17:36:37 - WARNING - ocr.config - Primary OCR engine 'winrtocr' is not compatible with linux. Switching to fallback.
2026-06-11 17:36:37 - INFO - ocr.config - Using 'rapidocr' as primary OCR engine on linux
2026-06-11 17:36:37 - INFO - ocr.config - OCR engine configuration adjusted for linux: primary=rapidocr, fallbacks=['rapidocr', 'easyocr']
2026-06-11 17:36:37 - INFO - ocr.facade - Primary OCR engine: rapidocr
2026-06-11 17:36:37 - INFO - ocr.engines.dynamic_engine - Auto-detected package 'easyocr' for engine 'easyocr'
2026-06-11 17:36:37 - WARNING - ocr.engine_factory - Dynamic engine easyocr created but package not installed
2026-06-11 17:36:37 - INFO - presidio-analyzer - Using device of type: cpu
2026-06-11 17:36:37 - ERROR - STDERR - PyInstaller/loader/pyimod02_importers.py:419: RuntimeWarning: CRITICAL: Presidio is NOT installed or failed to load. PII detection is DEGRADED — credit card Luhn validation, phone number format detection, and NER-based name/address detection are DISABLED. Error: No module named 'spacy'. Install with: pip install presidio-analyzer && python -m spacy download en_core_web_sm
2026-06-11 17:36:37 - INFO - privacy.filter - Presidio not available - install with: pip install presidio-analyzer
2026-06-11 17:36:37 - INFO - privacy.filter - Privacy filter initialized with 2 detectors
2026-06-11 17:36:37 - INFO - ocr.facade - Privacy filter initialized with detectors: ['custom_patterns', 'entropy']
2026-06-11 17:36:37 - INFO - ocr.facade - ============================================================
2026-06-11 17:36:37 - INFO - ocr.facade - OCR DIAGNOSTICS REPORT
2026-06-11 17:36:37 - INFO - ocr.facade - ============================================================
2026-06-11 17:36:37 - INFO - ocr.facade - Timestamp: 2026-06-11T12:06:37.311685Z
2026-06-11 17:36:37 - INFO - ocr.facade - Running as frozen exe: True
2026-06-11 17:36:37 - INFO - ocr.facade - Bundled path (_MEIPASS): /tmp/_MEIAovFqP
2026-06-11 17:36:37 - INFO - ocr.facade - System: Linux #35~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Tue May 26 19:30:42 UTC 2
2026-06-11 17:36:37 - INFO - ocr.facade - Machine: x86_64 | Python: 3.12.3
2026-06-11 17:36:37 - INFO - ocr.facade - Hostname: suchithgoud
2026-06-11 17:36:37 - INFO - ocr.facade - Primary engine: rapidocr
2026-06-11 17:36:37 - INFO - ocr.facade - Fallback engines: ['rapidocr', 'easyocr']
2026-06-11 17:36:37 - INFO - ocr.facade - Primary engine (rapidocr): READY
2026-06-11 17:36:37 - INFO - ocr.facade - Fallback engine (rapidocr): READY
2026-06-11 17:36:37 - INFO - ocr.facade - ----------------------------------------
2026-06-11 17:36:37 - INFO - ocr.facade - ENGINE INITIALIZATION DETAILS:
2026-06-11 17:36:37 - INFO - ocr.facade -   [RAPIDOCR]
2026-06-11 17:36:37 - INFO - ocr.facade -     Engine ready: True
2026-06-11 17:36:37 - INFO - ocr.facade - ----------------------------------------
2026-06-11 17:36:37 - INFO - ocr.facade - OCR Status: READY
2026-06-11 17:36:37 - INFO - ocr.facade - ============================================================
2026-06-11 17:36:37 - INFO - STDOUT - [OK] OCR ready — primary: rapidocr, fallbacks: ['rapidocr', 'easyocr']
2026-06-11 17:36:37 - INFO - STDOUT - [OCR] LocalOCRProcessor initialized - using dynamic engine selection
2026-06-11 17:36:37 - INFO - STDOUT - [OCR] OpenCV check OK: cv2 available (/tmp/_MEIAovFqP/cv2/__init__.py)
2026-06-11 17:36:37 - INFO - STDOUT - [OCR] Primary engine: winrtocr, Fallback: rapidocr,easyocr
2026-06-11 17:36:37 - INFO - STDOUT - [OCR] Async OCR worker thread started
2026-06-11 17:36:37 - INFO - STDOUT - [OK] Supabase client initialized for https://jvijitdewbypqbatfboi.supabase.co (timeout: 60s)
2026-06-11 17:36:37 - INFO - STDOUT - [OK] Jira Cloud ID pre-seeded from exchange-token: [UUID]
2026-06-11 17:36:37 - INFO - STDOUT - [OK] Supabase JWT set on client (PostgREST + Storage)
2026-06-11 17:36:37 - INFO - STDOUT - [OK] Supabase initialized successfully from cache
2026-06-11 17:36:37 - INFO - STDOUT - [INFO] Supabase already initialized
2026-06-11 17:36:38 - INFO - httpx - HTTP Request: GET https://jvijitdewbypqbatfboi.supabase.co/rest/v1/users?select=id%2C%20organization_id&atlassian_account_id=eq.712020%3A[UUID] "HTTP/1.1 200 OK"
2026-06-11 17:36:38 - INFO - STDOUT - [OK] Found existing user | user_id=[