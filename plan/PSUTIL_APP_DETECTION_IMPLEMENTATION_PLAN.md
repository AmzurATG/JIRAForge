# Implementation Plan: psutil-Based Application Detection with LLM Fallback

**Date:** March 2, 2026  
**Document Type:** Technical Implementation Plan  
**Status:** ✅ IMPLEMENTED

---

## 1. Executive Summary

This document outlines the implementation plan for enhancing the JIRAForge admin UI to allow administrators to add new applications that are not in the database. The feature **integrates into the existing search functionality** in the Project/Timesheet Settings page.

When an admin searches for an application in the productive/non-productive/private sections:
1. If the app exists in the DB → display it (existing behavior)
2. If the app is **NOT in the DB** → use **psutil** to detect the identifier from running processes
3. If psutil fails → **fallback to LLM** for app identification
4. Detected values are saved to `application_classifications` table

### Key Objectives:
1. Enhance existing search to detect apps not in the database
2. Use psutil to find the process identifier from running applications on the desktop
3. Fall back to LLM when psutil cannot detect the application
4. Automatically save detected applications to the database for future lookups

---

## 2. Current Architecture Analysis

### 2.1 Existing Components

#### Database Layer
- **Table:** `application_classifications` (Supabase)
  - Columns: `id`, `organization_id`, `project_key`, `identifier`, `display_name`, `classification`, `match_by`, `is_default`, `created_by`, `created_at`, `updated_at`
  - Supports 3-tier hierarchy: Global defaults → Organization overrides → Project overrides

#### Desktop App (Python)
- **File:** [desktop_app.py](../python-desktop-app/desktop_app.py)
- **Current psutil usage:**
  - `win32gui.GetForegroundWindow()` for active window detection
  - `win32process.GetWindowThreadProcessId()` for process ID
  - `psutil.Process(pid)` for process name retrieval
- **Classification Manager:** `AppClassificationManager` class handles classification lookups

#### AI Server (Node.js)
- **File:** [activity-service.js](../ai-server/src/services/activity-service.js)
- **Endpoint:** `POST /api/classify-app` for LLM-based classification
- **Current flow:** Takes `application_name`, `window_title`, `ocr_text` → Returns classification + reasoning

#### Forge App UI (React)
- **File:** [AppClassificationSettings.js](../forge-app/static/main/src/shared/components/AppClassificationSettings.js)
- **Current capabilities:**
  - View classifications (productive, non_productive, private)
  - Handle unknown apps from activity records
  - Save classifications via `saveClassification` resolver

#### Forge App Backend (Node.js)
- **Files:** 
  - [classificationService.js](../forge-app/src/services/classificationService.js)
  - [classificationResolvers.js](../forge-app/src/resolvers/classificationResolvers.js)
- **Existing resolvers:**
  - `getClassifications` - Fetch merged classifications
  - `saveClassification` - Create/update classification
  - `deleteClassification` - Remove classification
  - `getUnknownApps` - Get apps needing admin review
  - `bulkImportClassifications` - Bulk import

### 2.2 Current Search & Add Application Flow

```
Admin types app name in search box (e.g., "Zoom", "MyCustomApp")
        ↓
filterAppsBySearch() filters existing classifications
        ↓
If found → Display matching entries from DB
        ↓
If NOT found → Show "No results" message
```

**Gap:** Admin cannot add apps that:
1. Don't exist in the database classifications
2. Are custom/niche applications unique to their organization

---

## 3. Proposed Solution

### 3.1 High-Level Architecture

The solution **enhances the existing search functionality** to detect apps using psutil and LLM when not found in the database.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Admin UI - Search Flow (Enhanced)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Admin types in search box: "MyCustomApp"                                    │
│                     ↓                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Step 1: Check Database (existing behavior)                      │        │
│  │ SELECT * FROM application_classifications WHERE identifier ILIKE│        │
│  └────────────────────────────┬────────────────────────────────────┘        │
│                               ↓                                              │
│                    Found in DB? ──YES──→ Display results (done)             │
│                        │ NO                                                  │
│                        ↓                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Step 2: NEW - psutil Detection via Desktop App                  │        │
│  │ invoke('searchAppIdentifier', { searchTerm: "MyCustomApp" })    │        │
│  │                                                                  │        │
│  │ Desktop App searches running processes for matching app         │        │
│  └────────────────────────────┬────────────────────────────────────┘        │
│                               ↓                                              │
│                    Found running process? ──YES──→ Show "Add" option        │
│                        │ NO                                                  │
│                        ↓                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Step 3: NEW - LLM Fallback                                      │        │
│  │ invoke('identifyAppByName', { appName: "MyCustomApp" })         │        │
│  │                                                                  │        │
│  │ AI Server suggests identifier based on app name                 │        │
│  └────────────────────────────┬────────────────────────────────────┘        │
│                               ↓                                              │
│                    LLM suggestion available? ──YES──→ Show suggestion       │
│                        │ NO                                                  │
│                        ↓                                                     │
│                    Show "App not found" message                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Search-Integrated Detection Flow

```
Admin searches for "Zoom" in Productive Apps section
        ↓
┌────────────────────────────────────────────────────────┐
│ Check 1: Database lookup                                │
│ - Query application_classifications table               │
│ - If found → show existing classification              │
└────────────────────────────────────────────────────────┘
        ↓ Not found
┌────────────────────────────────────────────────────────┐
│ Check 2: psutil detection (NEW)                         │
│ - Call Desktop App: POST /api/search-running-app       │
│ - Desktop searches running processes for "Zoom"         │
│ - Returns: { found: true, identifier: "Zoom.exe",      │
│              displayName: "Zoom Meetings", ... }       │
└────────────────────────────────────────────────────────┘
        ↓ Not running / Not found
┌────────────────────────────────────────────────────────┐
│ Check 3: LLM identification (NEW - fallback)            │
│ - Call AI Server: POST /api/identify-app               │
│ - LLM suggests: { identifier: "Zoom.exe",              │
│                   displayName: "Zoom Video Meetings",  │
│                   confidence: 0.9 }                    │
└────────────────────────────────────────────────────────┘
        ↓
Display result to admin with "Add as [Productive/Non-Productive/Private]" buttons
        ↓
Admin clicks classification button
        ↓
Save to application_classifications table
```

---

## 4. Implementation Details

### 4.1 Desktop App Changes

#### 4.1.1 New API Endpoint: `POST /api/search-running-app`

**File:** `python-desktop-app/desktop_app.py`

This endpoint searches currently running processes for apps matching the admin's search term.

```python
# Add new imports (if not already present)
import win32api
import re

# Add to Flask routes
@app.route('/api/search-running-app', methods=['POST'])
def search_running_app():
    """
    Search running processes for an application matching the search term.
    Used when admin searches for an app not in the database.
    
    Request body:
        { "search_term": "Zoom" }
    
    Returns matching running process with metadata if found.
    """
    try:
        data = request.get_json()
        search_term = (data.get('search_term') or '').strip().lower()
        
        if not search_term or len(search_term) < 2:
            return jsonify({
                'success': False,
                'error': 'search_term must be at least 2 characters'
            }), 400
        
        # System processes to skip
        SYSTEM_PROCESSES = {
            'svchost.exe', 'conhost.exe', 'csrss.exe', 'dwm.exe',
            'system', 'registry', 'idle', 'smss.exe', 'lsass.exe',
            'services.exe', 'wininit.exe', 'winlogon.exe', 'fontdrvhost.exe',
            'spoolsv.exe', 'searchindexer.exe', 'audiodg.exe', 'runtimebroker.exe'
        }
        
        matches = []
        seen_names = set()
        
        for proc in psutil.process_iter(['pid', 'name', 'exe']):
            try:
                info = proc.info
                name = info.get('name', '')
                exe_path = info.get('exe')
                
                # Skip system processes
                if name.lower() in SYSTEM_PROCESSES:
                    continue
                
                # Skip duplicates
                name_lower = name.lower()
                if name_lower in seen_names:
                    continue
                seen_names.add(name_lower)
                
                # Skip processes without exe path
                if not exe_path:
                    continue
                
                # Check if search term matches process name or display name
                name_without_ext = name_lower.replace('.exe', '').replace('.app', '')
                
                # Try to get display name for better matching
                display_name = None
                description = None
                company = None
                version = None
                
                try:
                    version_info = _get_file_version_info(exe_path)
                    if version_info:
                        display_name = version_info.get('ProductName', '')
                        description = version_info.get('FileDescription', '')
                        company = version_info.get('CompanyName', '')
                        version = version_info.get('FileVersion', '')
                except Exception:
                    pass
                
                # Match against process name, display name, or description
                searchable = f"{name_without_ext} {display_name or ''} {description or ''}".lower()
                
                if search_term in searchable:
                    match_score = 1.0 if search_term == name_without_ext else 0.8
                    if display_name and search_term in display_name.lower():
                        match_score = 0.95
                    
                    matches.append({
                        'identifier': name,  # The actual process name (e.g., "Zoom.exe")
                        'display_name': display_name or name.replace('.exe', '').replace('.app', '').title(),
                        'description': description,
                        'company': company,
                        'version': version,
                        'executable_path': exe_path,
                        'match_score': match_score,
                        'source': 'psutil',
                        'confidence': 'high' if display_name else 'medium'
                    })
                    
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        
        # Sort by match score (best matches first)
        matches.sort(key=lambda x: x['match_score'], reverse=True)
        
        if matches:
            return jsonify({
                'success': True,
                'found': True,
                'matches': matches[:5],  # Return top 5 matches
                'best_match': matches[0]
            })
        else:
            return jsonify({
                'success': True,
                'found': False,
                'matches': [],
                'message': f'No running process found matching "{search_term}"'
            })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


def _get_file_version_info(exe_path):
    """
    Extract version info from Windows executable using win32api.
    Returns dict with ProductName, FileDescription, CompanyName, FileVersion.
    """
    try:
        import win32api
        
        # Get the version info
        info = win32api.GetFileVersionInfo(exe_path, '\\')
        ms = info['FileVersionMS']
        ls = info['FileVersionLS']
        version = f"{win32api.HIWORD(ms)}.{win32api.LOWORD(ms)}.{win32api.HIWORD(ls)}.{win32api.LOWORD(ls)}"
        
        # Get string file info
        lang, codepage = win32api.GetFileVersionInfo(exe_path, '\\VarFileInfo\\Translation')[0]
        
        string_info = {}
        for name in ['ProductName', 'FileDescription', 'CompanyName', 'FileVersion']:
            try:
                key = f'\\StringFileInfo\\{lang:04X}{codepage:04X}\\{name}'
                value = win32api.GetFileVersionInfo(exe_path, key)
                if value:
                    string_info[name] = value.strip()
            except:
                pass
        
        if not string_info.get('FileVersion'):
            string_info['FileVersion'] = version
            
        return string_info if string_info else None
        
    except Exception:
        return None
```

#### 4.1.2 Requirements Update

**File:** `python-desktop-app/requirements.txt`

```
# Already present - no changes needed
pywin32>=306
psutil>=5.9.0
```

### 4.2 AI Server Changes

#### 4.2.1 New Endpoint: `POST /api/identify-app`

**File:** `ai-server/src/controllers/activity-controller.js`

This endpoint uses LLM to identify an application when psutil cannot find it (app not running).

```javascript
/**
 * POST /api/identify-app
 * Uses LLM to identify an application from its name when the app is not running.
 * Fallback when psutil cannot detect the app.
 * 
 * Request body:
 *   { "app_name": "Zoom", "user_id": "...", "organization_id": "..." }
 * 
 * Returns suggested identifier, display name, and classification.
 */
async function identifyApp(req, res, next) {
  try {
    const { app_name, user_id, organization_id } = req.body;

    if (!app_name) {
      return res.status(400).json({
        success: false,
        error: 'app_name is required'
      });
    }

    logger.info(`[ActivityController] Identifying app by name: ${app_name}`);

    const result = await activityService.identifyAppByName(
      app_name,
      user_id || null,
      organization_id || null
    );

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[ActivityController] Error in identifyApp:', error);
    next(error);
  }
}

module.exports = { analyzeBatch, classifyApp, identifyApp };
```

#### 4.2.2 New Service Method

**File:** `ai-server/src/services/activity-service.js`

```javascript
/**
 * System prompt for app identification from name only
 */
const APP_IDENTIFICATION_SYSTEM_PROMPT = `You are an expert at identifying desktop applications and software. When given an application name that an admin is searching for, you determine:
1. The most likely process/executable name (identifier)
2. The official display name
3. A suggested classification (productive, non_productive, private)

You have extensive knowledge of:
- Common Windows, macOS, and Linux applications and their executable names
- Application naming conventions (.exe, .app extensions)
- Popular software categories: development tools, browsers, office suites, entertainment apps
- Enterprise and consumer software catalogs`;

/**
 * Build the app identification prompt
 */
function buildAppIdentificationPrompt(appName) {
  return `An administrator is searching for an application called "${appName}" to add to their classification list.

Identify this application and provide:
1. The most likely process/executable name (what would appear in Task Manager)
2. The official display name
3. Whether it's productive, non_productive, or private

Return ONLY valid JSON (no markdown, no extra text):
{
  "identifier": "process_name.exe (e.g., Zoom.exe, Code.exe, spotify.exe)",
  "displayName": "Official Application Name",
  "description": "Brief description of what the app does",
  "company": "Company/vendor name",
  "suggestedClassification": "productive|non_productive|private",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation",
  "alternatives": ["alternative_name.exe"] 
}

Classification rules:
- Development tools, office apps, browsers, work communication → productive
- Games, streaming, social media, entertainment → non_productive  
- Banking, password managers, health apps, personal messaging → private

If you're not confident about the app, set confidence below 0.5.
If you don't recognize the app at all, return confidence: 0.2 and use the search term as both identifier and displayName.`;
}

/**
 * Identify an application by name using LLM.
 * Used when the app is not currently running and psutil cannot detect it.
 * 
 * @param {string} appName - The app name admin is searching for
 * @param {string} userId - User ID for cost tracking (optional)
 * @param {string} organizationId - Organization ID for cost tracking (optional)
 * @returns {Promise<Object>} Identified app info
 */
async function identifyAppByName(appName, userId, organizationId) {
  if (!isActivityAIEnabled()) {
    // Return basic info if AI is not available
    const cleanName = appName.trim();
    const identifier = cleanName.toLowerCase().replace(/\s+/g, '') + '.exe';
    return {
      identifier: identifier,
      displayName: cleanName,
      description: null,
      company: null,
      suggestedClassification: 'productive', // Default to productive
      confidence: 0.1,
      reasoning: 'AI not available - using search term as identifier',
      source: 'fallback'
    };
  }

  const userPrompt = buildAppIdentificationPrompt(appName);

  const messages = [
    { role: 'system', content: APP_IDENTIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0.3,
      max_tokens: 500,
      isVision: false,
      reasoningEffort: 'none',
      userId,
      organizationId,
      apiCallName: 'identify-app'
    });

    const content = response.choices[0].message.content.trim();
    logger.info(`[ActivityService] App identification done | ${provider} (${model}) | ${appName}`);

    // Parse JSON from response
    const result = parseIdentificationResponse(content);
    result.aiProvider = provider;
    result.aiModel = model;
    result.source = 'llm';
    
    return result;

  } catch (error) {
    logger.error(`[ActivityService] App identification failed for ${appName}:`, error);
    // Return fallback info
    const cleanName = appName.trim();
    return {
      identifier: cleanName.toLowerCase().replace(/\s+/g, '') + '.exe',
      displayName: cleanName,
      description: null,
      company: null,
      suggestedClassification: 'productive',
      confidence: 0.2,
      reasoning: 'LLM identification failed - using search term',
      source: 'fallback',
      error: error.message
    };
  }
}

function parseIdentificationResponse(content) {
  try {
    let jsonStr = content;
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }
    
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Failed to parse LLM response as JSON');
  }
}

module.exports = { 
  analyzeBatch, 
  classifyUnknownApp,
  identifyAppByName  // New export
};
```

#### 4.2.3 Register Endpoint

**File:** `ai-server/src/index.js`

```javascript
// Add to existing routes
app.post('/api/identify-app', atlassianAuthMiddleware, activityController.identifyApp);
```

### 4.3 Forge App Changes

#### 4.3.1 New Resolver

**File:** `forge-app/src/resolvers/classificationResolvers.js`

```javascript
/**
 * Search for an application identifier when app is not in the database.
 * Uses psutil (via desktop app) first, falls back to LLM.
 * 
 * Called when admin searches for an app that doesn't exist in classifications.
 */
resolver.define('searchAppIdentifier', async (req) => {
  const { payload, context } = req;
  const { searchTerm } = payload;
  const accountId = context.accountId;
  const cloudId = context.cloudId;

  try {
    const result = await searchAppIdentifier(searchTerm, cloudId, accountId);
    return {
      success: true,
      ...result
    };
  } catch (error) {
    console.error('Error searching app identifier:', error);
    return {
      success: false,
      error: error.message
    };
  }
});
```

#### 4.3.2 New Service Method

**File:** `forge-app/src/services/classificationService.js`

```javascript
/**
 * Search for an application identifier when the app is not in the database.
 * 
 * Flow:
 * 1. Try psutil via desktop app (if running) to find the process
 * 2. If not found, fall back to LLM identification
 * 3. Return the identifier and metadata for admin to add
 * 
 * @param {string} searchTerm - The app name admin is searching for
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} App identification result
 */
export async function searchAppIdentifier(searchTerm, cloudId, accountId) {
  if (!searchTerm || searchTerm.trim().length < 2) {
    return {
      found: false,
      error: 'Search term must be at least 2 characters'
    };
  }

  const cleanSearchTerm = searchTerm.trim();
  
  // Step 1: Try psutil detection via desktop app
  try {
    const desktopApiUrl = 'http://localhost:5000';
    
    const psutilResponse = await fetch(`${desktopApiUrl}/api/search-running-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_term: cleanSearchTerm }),
      timeout: 5000
    });
    
    if (psutilResponse.ok) {
      const psutilData = await psutilResponse.json();
      
      if (psutilData.success && psutilData.found && psutilData.best_match) {
        console.log(`[Classification] psutil found app: ${psutilData.best_match.identifier}`);
        return {
          found: true,
          source: 'psutil',
          identifier: psutilData.best_match.identifier,
          displayName: psutilData.best_match.display_name,
          description: psutilData.best_match.description,
          company: psutilData.best_match.company,
          confidence: psutilData.best_match.confidence,
          allMatches: psutilData.matches
        };
      }
    }
  } catch (e) {
    console.log(`[Classification] Desktop app not available: ${e.message}`);
    // Continue to LLM fallback
  }
  
  // Step 2: Fall back to LLM identification
  const aiServerUrl = process.env.AI_SERVER_URL;
  
  if (aiServerUrl) {
    try {
      console.log(`[Classification] Falling back to LLM for: ${cleanSearchTerm}`);
      
      const llmResponse = await fetch(`${aiServerUrl}/api/identify-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_name: cleanSearchTerm,
          user_id: accountId,
          organization_id: cloudId
        }),
        timeout: 15000
      });
      
      if (llmResponse.ok) {
        const llmData = await llmResponse.json();
        
        if (llmData.success) {
          console.log(`[Classification] LLM identified app: ${llmData.identifier}`);
          return {
            found: true,
            source: 'llm',
            identifier: llmData.identifier,
            displayName: llmData.displayName,
            description: llmData.description,
            company: llmData.company,
            suggestedClassification: llmData.suggestedClassification,
            confidence: llmData.confidence > 0.5 ? 'medium' : 'low',
            reasoning: llmData.reasoning,
            alternatives: llmData.alternatives
          };
        }
      }
    } catch (e) {
      console.log(`[Classification] LLM identification failed: ${e.message}`);
    }
  }
  
  // Step 3: Neither psutil nor LLM found it - return basic suggestion
  return {
    found: false,
    source: 'none',
    suggestion: {
      identifier: cleanSearchTerm.toLowerCase().replace(/\s+/g, '') + '.exe',
      displayName: cleanSearchTerm,
      confidence: 'low'
    },
    message: `Could not automatically detect "${cleanSearchTerm}". You can add it manually with the suggested identifier.`
  };
}
```

### 4.4 UI Changes (Search-Integrated Approach)

The UI changes integrate psutil/LLM detection directly into the **existing search functionality**. No new buttons or modals are needed - the detection happens automatically when an admin searches for an app that doesn't exist in the database.

#### 4.4.1 Enhanced Search Function

**File:** `forge-app/static/main/src/shared/components/AppClassificationSettings.js`

Add a new function to handle psutil/LLM detection when search doesn't find results:

```javascript
// New state variable for detection results
const [detectedAppSuggestions, setDetectedAppSuggestions] = useState({});
const [searchingIdentifier, setSearchingIdentifier] = useState({});

/**
 * Enhanced search suggestion function.
 * Flow:
 * 1. Search existing DB classifications (existing)
 * 2. If no results found → Call psutil detection → LLM fallback (NEW)
 * 3. Return combined results
 */
const getEnhancedSearchSuggestions = async (searchTerm, classificationType) => {
  if (!searchTerm || searchTerm.length < 2) {
    return [];
  }
  
  // Step 1: Check if search matches existing DB classifications
  const existingMatches = filterAppsBySearch(searchTerm);
  
  // If we found results in existing DB, return them
  if (existingMatches.length > 0) {
    return existingMatches;
  }
  
  // Step 2: No results found - try psutil/LLM detection
  // Check if we already searched for this term recently
  const cacheKey = `${searchTerm.toLowerCase()}_${classificationType}`;
  if (detectedAppSuggestions[cacheKey]) {
    return detectedAppSuggestions[cacheKey];
  }
  
  // Don't trigger detection while already searching
  if (searchingIdentifier[cacheKey]) {
    return [];
  }
  
  // Trigger detection (debounced in calling code)
  setSearchingIdentifier(prev => ({ ...prev, [cacheKey]: true }));
  
  try {
    const result = await invoke('searchAppIdentifier', {
      searchTerm: searchTerm
    });
    
    if (result.success && result.found) {
      // Create suggestion from detected app
      const detectedSuggestion = {
        identifier: result.identifier,
        displayName: result.displayName || searchTerm,
        description: result.description,
        company: result.company,
        source: result.source, // 'psutil' or 'llm'
        confidence: result.confidence,
        suggestedClassification: result.suggestedClassification,
        isDetected: true, // Flag to show special UI
        reasoning: result.reasoning
      };
      
      // Cache the result
      setDetectedAppSuggestions(prev => ({
        ...prev,
        [cacheKey]: [detectedSuggestion]
      }));
      
      return [detectedSuggestion];
    } else if (!result.found && result.suggestion) {
      // Neither psutil nor LLM found it - show manual entry suggestion
      const manualSuggestion = {
        identifier: result.suggestion.identifier,
        displayName: result.suggestion.displayName,
        source: 'manual',
        confidence: 'low',
        isDetected: true,
        allowManualEdit: true,
        message: result.message
      };
      
      setDetectedAppSuggestions(prev => ({
        ...prev,
        [cacheKey]: [manualSuggestion]
      }));
      
      return [manualSuggestion];
    }
    
    return [];
    
  } catch (err) {
    console.error('Failed to search for app identifier:', err);
    return [];
  } finally {
    setSearchingIdentifier(prev => ({ ...prev, [cacheKey]: false }));
  }
};

/**
 * Handle adding a detected app to the classification
 */
const addDetectedApp = async (suggestion, classification) => {
  if (!suggestion || !suggestion.identifier) return;
  
  setSavingUnknownApp(prev => ({ ...prev, [suggestion.identifier]: true }));
  setMessage({ type: '', text: '' });
  
  try {
    const result = await invoke('saveClassification', {
      classification: {
        identifier: suggestion.identifier,
        displayName: suggestion.displayName || suggestion.identifier.replace('.exe', ''),
        classification: classification,
        matchBy: 'process',
        // Store detection metadata
        metadata: {
          detection_source: suggestion.source,
          company: suggestion.company,
          description: suggestion.description,
          confidence: suggestion.confidence,
          detected_at: new Date().toISOString()
        }
      },
      projectKey: projectKey || null,
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to save classification');
    }
    
    setMessage({
      type: 'success',
      text: `Added "${suggestion.displayName}" as ${classification.replace('_', ' ')}.`,
    });
    
    // Clear the search and detected suggestions
    clearSearch(classification);
    setDetectedAppSuggestions({});
    
    // Reload classifications
    await loadClassifications();
    
  } catch (err) {
    console.error('Failed to add detected app:', err);
    setMessage({
      type: 'error',
      text: `Failed to add: ${err.message}`,
    });
  } finally {
    setSavingUnknownApp(prev => ({ ...prev, [suggestion.identifier]: false }));
    setTimeout(() => setMessage({ type: '', text: '' }), 3000);
  }
};

// Helper to clear search for a classification type
const clearSearch = (classificationType) => {
  if (classificationType === 'productive') {
    setProductiveSearch('');
  } else if (classificationType === 'non_productive') {
    setNonProductiveSearch('');
  } else if (classificationType === 'private') {
    setPrivateSearch('');
  }
};
```

#### 4.4.2 Updated Search Input Handler

Update the search handlers to use enhanced search with debouncing:

```javascript
// Debounced detection search
const debouncedDetectionSearch = useCallback(
  debounce(async (searchTerm, classificationType) => {
    const suggestions = await getEnhancedSearchSuggestions(searchTerm, classificationType);
    // Update UI state with suggestions...
  }, 500),
  []
);

// Modified search handler
const handleSearchChange = (value, classificationType) => {
  // Update immediate search state
  if (classificationType === 'productive') {
    setProductiveSearch(value);
  } else if (classificationType === 'non_productive') {
    setNonProductiveSearch(value);
  } else if (classificationType === 'private') {
    setPrivateSearch(value);
  }
  
  // Trigger debounced detection search
  debouncedDetectionSearch(value, classificationType);
};
```

#### 4.4.3 Updated Search Suggestions Dropdown JSX

Update the search suggestions dropdown to show detected apps with special styling:

```jsx
{/* Search suggestions dropdown - enhanced for detected apps */}
{showSuggestions && suggestions.length > 0 && (
  <div className="search-suggestions-dropdown">
    {suggestions.map((suggestion, idx) => (
      <div 
        key={suggestion.identifier || idx}
        className={`suggestion-item ${suggestion.isDetected ? 'detected' : ''} ${suggestion.source}`}
      >
        <div className="suggestion-info">
          <span className="suggestion-name">
            {suggestion.displayName || suggestion.identifier}
          </span>
          
          <span className="suggestion-identifier">
            {suggestion.identifier}
          </span>
          
          {suggestion.isDetected && (
            <div className="detection-info">
              {suggestion.source === 'psutil' && (
                <span className="source-badge psutil">
                  ✓ Detected from running process
                </span>
              )}
              {suggestion.source === 'llm' && (
                <span className="source-badge llm">
                  🤖 AI Identified ({suggestion.confidence})
                </span>
              )}
              {suggestion.source === 'manual' && (
                <span className="source-badge manual">
                  ⚠ Manual entry suggested
                </span>
              )}
              
              {suggestion.company && (
                <span className="suggestion-company">by {suggestion.company}</span>
              )}
              
              {suggestion.description && (
                <span className="suggestion-description">{suggestion.description}</span>
              )}
              
              {suggestion.suggestedClassification && (
                <span className={`suggested-class ${suggestion.suggestedClassification}`}>
                  Suggested: {suggestion.suggestedClassification.replace('_', ' ')}
                </span>
              )}
            </div>
          )}
        </div>
        
        <div className="suggestion-actions">
          {/* Show classification buttons for detected apps */}
          <button
            className="add-btn productive"
            onClick={() => addDetectedApp(suggestion, 'productive')}
            disabled={savingUnknownApp[suggestion.identifier]}
            title="Add as Productive"
          >
            + Productive
          </button>
          <button
            className="add-btn non-productive"
            onClick={() => addDetectedApp(suggestion, 'non_productive')}
            disabled={savingUnknownApp[suggestion.identifier]}
            title="Add as Non-Productive"
          >
            + Non-Productive
          </button>
          <button
            className="add-btn private"
            onClick={() => addDetectedApp(suggestion, 'private')}
            disabled={savingUnknownApp[suggestion.identifier]}
            title="Add as Private"
          >
            + Private
          </button>
        </div>
      </div>
    ))}
    
    {/* Loading indicator when detecting */}
    {Object.values(searchingIdentifier).some(Boolean) && (
      <div className="suggestion-item loading">
        <span className="spinner"></span>
        Detecting application...
      </div>
    )}
  </div>
)}
```

#### 4.4.4 CSS Styles for Detection UI

**File:** `forge-app/static/main/src/shared/components/AppClassificationSettings.css`

```css
/* Detection-specific styles for search suggestions */
.suggestion-item.detected {
  background: #F0F9FF;
  border-left: 3px solid #0052CC;
}

.suggestion-item.detected.psutil {
  border-left-color: #00875A;
}

.suggestion-item.detected.llm {
  border-left-color: #6554C0;
}

.suggestion-item.detected.manual {
  border-left-color: #FF8B00;
}

.detection-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.source-badge.psutil {
  background: #E3FCEF;
  color: #006644;
}

.source-badge.llm {
  background: #EAE6FF;
  color: #403294;
}

.source-badge.manual {
  background: #FFFAE6;
  color: #FF8B00;
}

.suggestion-company,
.suggestion-description {
  font-size: 12px;
  color: #6B778C;
}

.suggested-class {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
}

.suggested-class.productive {
  background: #E3FCEF;
  color: #006644;
}

.suggested-class.non_productive {
  background: #FFFAE6;
  color: #FF8B00;
}

.suggested-class.private {
  background: #EAE6FF;
  color: #403294;
}

.suggestion-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.add-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.2s;
}

.add-btn.productive {
  background: #00875A;
  color: white;
}

.add-btn.non-productive {
  background: #FF8B00;
  color: white;
}

.add-btn.private {
  background: #6554C0;
  color: white;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-btn:hover:not(:disabled) {
  opacity: 0.9;
}

/* Loading state */
.suggestion-item.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: #6B778C;
  font-style: italic;
}

.suggestion-item.loading .spinner {
  width: 14px;
  height: 14px;
  border: 2px solid #0052CC40;
  border-top-color: #0052CC;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

---

## 5. Database Schema Changes

### 5.1 Optional: Add Metadata Column

If we want to store additional metadata from detection:

```sql
-- Add metadata column to application_classifications if needed
ALTER TABLE public.application_classifications 
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Example metadata structure:
-- {
--   "detection_source": "psutil" | "llm",
--   "company": "Microsoft Corporation",
--   "category": "development",
--   "llm_confidence": 0.85,
--   "llm_reasoning": "...",
--   "executable_path": "C:\\Program Files\\..."
-- }

COMMENT ON COLUMN public.application_classifications.metadata IS 
  'Additional metadata from app detection (source, company, category, confidence)';
```

---

## 6. API Contracts

### 6.1 Desktop App API

#### `POST /api/search-running-app`

Searches currently running processes for an application matching the search term.

**Request:**
```json
{
  "search_term": "Zoom"
}
```

**Response (found):**
```json
{
  "success": true,
  "found": true,
  "matches": [
    {
      "identifier": "Zoom.exe",
      "display_name": "Zoom Meetings",
      "description": "Zoom Video Conferencing",
      "company": "Zoom Video Communications, Inc.",
      "version": "5.17.5",
      "executable_path": "C:\\Users\\...\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe",
      "match_score": 0.95,
      "source": "psutil",
      "confidence": "high"
    }
  ],
  "best_match": {
    "identifier": "Zoom.exe",
    "display_name": "Zoom Meetings",
    "description": "Zoom Video Conferencing",
    "company": "Zoom Video Communications, Inc.",
    "version": "5.17.5",
    "executable_path": "C:\\Users\\...\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe",
    "match_score": 0.95,
    "source": "psutil",
    "confidence": "high"
  }
}
```

**Response (not found):**
```json
{
  "success": true,
  "found": false,
  "matches": [],
  "message": "No running process found matching \"Zoom\""
}
```

### 6.2 AI Server API

#### `POST /api/identify-app`

Uses LLM to identify an application from its name when the app is not currently running.

**Request:**
```json
{
  "app_name": "Zoom",
  "user_id": "optional-user-id",
  "organization_id": "optional-org-id"
}
```

**Response:**
```json
{
  "success": true,
  "identifier": "Zoom.exe",
  "displayName": "Zoom Meetings",
  "description": "Video conferencing and online meeting software",
  "company": "Zoom Video Communications, Inc.",
  "suggestedClassification": "productive",
  "confidence": 0.92,
  "reasoning": "Zoom is a widely-used video conferencing tool commonly used for business meetings and collaboration.",
  "alternatives": ["zoom.exe", "ZoomIt.exe"],
  "source": "llm",
  "aiProvider": "fireworks",
  "aiModel": "llama-v3p1-70b-instruct"
}
```

### 6.3 Forge App Resolver

#### `searchAppIdentifier`

Called when admin searches for an app that doesn't exist in the database.

**Request (via invoke):**
```javascript
const result = await invoke('searchAppIdentifier', {
  searchTerm: 'Zoom'
});
```

**Response (psutil found):**
```json
{
  "success": true,
  "found": true,
  "source": "psutil",
  "identifier": "Zoom.exe",
  "displayName": "Zoom Meetings",
  "description": "Video conferencing software",
  "company": "Zoom Video Communications, Inc.",
  "confidence": "high",
  "allMatches": [/* array of all matches from psutil */]
}
```

**Response (LLM fallback):**
```json
{
  "success": true,
  "found": true,
  "source": "llm",
  "identifier": "Zoom.exe",
  "displayName": "Zoom Meetings",
  "description": "Video conferencing software",
  "company": "Zoom Video Communications, Inc.",
  "suggestedClassification": "productive",
  "confidence": "medium",
  "reasoning": "Common video conferencing tool",
  "alternatives": ["ZoomIt.exe"]
}
```

**Response (not found):**
```json
{
  "success": true,
  "found": false,
  "source": "none",
  "suggestion": {
    "identifier": "zoom.exe",
    "displayName": "Zoom",
    "confidence": "low"
  },
  "message": "Could not automatically detect \"Zoom\". You can add it manually with the suggested identifier."
}
```

---

## 7. Error Handling

### 7.1 Desktop App Not Running

```javascript
// In classificationService.js
if (error.code === 'ECONNREFUSED') {
  return {
    apps: [],
    error: 'Desktop app is not running. Please start the Time Tracker desktop application to detect running apps.'
  };
}
```

### 7.2 LLM Fallback Failure

```javascript
// In activity-service.js
catch (error) {
  logger.error(`[ActivityService] App detection failed for ${processName}:`, error);
  return {
    displayName: processName.replace('.exe', ''),
    suggestedClassification: 'productive', // Safe default
    confidence: 0.2,
    reasoning: 'LLM detection failed - manual classification recommended',
    error: error.message
  };
}
```

### 7.3 Permission Denied

```python
# In desktop_app.py
except psutil.AccessDenied:
    # Skip processes we can't access (usually system processes)
    continue
```

---

## 8. Testing Plan

### 8.1 Unit Tests

1. **Desktop App:**
   - Test `_get_file_version_info()` with known executables
   - Test process filtering (system processes excluded)
   - Test deduplication logic

2. **AI Server:**
   - Test `detectAppInfo()` with various process names
   - Test JSON parsing from LLM responses
   - Test fallback behavior when AI is unavailable

3. **Forge App:**
   - Test `detectRunningApps()` service method
   - Test resolver integration
   - Test error handling

### 8.2 Integration Tests

1. **End-to-End Flow:**
   - Start desktop app → Call detect API → Verify response
   - Test with LLM fallback enabled/disabled
   - Test with various application states

2. **UI Tests:**
   - Click detect button → Verify modal shows
   - Add app → Verify it appears in classifications
   - Test classification buttons functionality

### 8.3 Manual Testing Checklist

**Search-Integrated Detection Flow:**
- [ ] Search for existing DB app → Shows from database
- [ ] Search for app running locally → Shows psutil detection (green badge)
- [ ] Search for known app not running → Shows LLM identification (purple badge)
- [ ] Search for unknown app → Shows manual entry suggestion (orange badge)
- [ ] Add detected app as productive → Appears in productive list
- [ ] Add detected app as non-productive → Appears in non-productive list
- [ ] Add detected app as private → Appears in private list
- [ ] Clear search → Detected suggestions cleared
- [ ] Refresh page → Classifications persist correctly

**Error Scenarios:**
- [ ] Desktop app not running → LLM fallback works
- [ ] AI server unavailable → Manual entry suggestion shown
- [ ] Search term < 2 chars → No detection triggered
- [ ] Network timeout → Graceful error handling

---

## 9. Implementation Timeline

### Phase 1: Desktop App API (1-2 days)
- [ ] Add `POST /api/search-running-app` endpoint
- [ ] Implement psutil process search with metadata extraction
- [ ] Add Windows version info extraction (`_get_file_version_info`)
- [ ] Add match scoring logic
- [ ] Write unit tests

### Phase 2: AI Server Endpoint (1-2 days)
- [ ] Add `POST /api/identify-app` endpoint
- [ ] Implement LLM identification prompt
- [ ] Add response parsing with JSON extraction
- [ ] Add fallback behavior when AI unavailable
- [ ] Write unit tests

### Phase 3: Forge App Backend (1-2 days)
- [ ] Add `searchAppIdentifier` resolver
- [ ] Implement `searchAppIdentifier()` service method
- [ ] Add psutil call with LLM fallback
- [ ] Add error handling for desktop app/AI server unavailable
- [ ] Write integration tests

### Phase 4: UI Search Integration (2-3 days)
- [ ] Add `getEnhancedSearchSuggestions()` function
- [ ] Implement debounced detection search
- [ ] Update search suggestions dropdown with detection UI
- [ ] Add classification buttons for detected apps
- [ ] Add CSS styles for detection badges
- [ ] Test search flows end-to-end

### Phase 5: Testing & Documentation (1-2 days)
- [ ] End-to-end testing of all search scenarios
- [ ] Bug fixes
- [ ] Update user documentation
- [ ] Code review

**Total Estimated Time: 6-11 days**

---

## 10. Security Considerations

### 10.1 Process Information Exposure
- Only expose necessary process info (name, path, version)
- Don't expose command-line arguments (may contain passwords)
- Don't expose environment variables

### 10.2 API Authentication
- Desktop app API should require authentication
- AI server endpoint uses existing Atlassian token auth
- Forge resolver uses standard Forge authentication

### 10.3 Rate Limiting
- Limit LLM calls per detection request (max 10 apps)
- Add cooldown between detect requests (min 10 seconds)

---

## 11. Future Enhancements

### 11.1 Batch LLM Detection
- Send multiple unknown apps in single LLM request
- Reduce API calls and cost

### 11.2 App Icon Extraction
- Extract app icons for better UI
- Use Windows Shell32 API

### 11.3 Cross-Platform Support
- Add macOS support (using `system_profiler`)
- Add Linux support (using `/proc` filesystem)

### 11.4 Smart Suggestions
- Cache common app patterns
- Pre-populate classification based on install path patterns

---

## 12. References

### Existing Files to Modify:
1. [desktop_app.py](../python-desktop-app/desktop_app.py) - Add `POST /api/search-running-app` endpoint
2. [activity-service.js](../ai-server/src/services/activity-service.js) - Add `identifyAppByName()` method
3. [activity-controller.js](../ai-server/src/controllers/activity-controller.js) - Add `identifyApp` controller
4. [classificationService.js](../forge-app/src/services/classificationService.js) - Add `searchAppIdentifier()` method
5. [classificationResolvers.js](../forge-app/src/resolvers/classificationResolvers.js) - Add `searchAppIdentifier` resolver
6. [AppClassificationSettings.js](../forge-app/static/main/src/shared/components/AppClassificationSettings.js) - Integrate detection into search
7. [AppClassificationSettings.css](../forge-app/static/main/src/shared/components/AppClassificationSettings.css) - Add detection styles
8. [index.js](../ai-server/src/index.js) - Register `/api/identify-app` endpoint

### Related Documentation:
- [PROPOSAL_LOCAL_OCR_APP_CLASSIFICATION.md](./PROPOSAL_LOCAL_OCR_APP_CLASSIFICATION.md)
- [WINDOW_TITLE_CLASSIFICATION_IMPLEMENTATION.md](./WINDOW_TITLE_CLASSIFICATION_IMPLEMENTATION.md)
- [JSON_RECORD_STRUCTURE_AND_FLOW.md](./JSON_RECORD_STRUCTURE_AND_FLOW.md)
