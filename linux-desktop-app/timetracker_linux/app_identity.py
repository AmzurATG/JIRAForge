"""
Linux application identity: process-name tables merged into the core's
classification tables, and `.desktop` lookup for the admin running-app search.

Admin classifications use Windows names (chrome.exe). The core normalizes
names (lower-case, strips .exe and separators) and maps aliases to a
canonical key, so only the Linux spellings need adding here.
"""

import configparser
import glob
import os

LINUX_BROWSER_PROCESSES = {
    'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'firefox', 'firefox-esr', 'firefox-bin', 'librewolf', 'msedge', 'microsoft-edge',
    'microsoft-edge-stable', 'brave', 'brave-browser', 'opera', 'vivaldi', 'vivaldi-bin',
    'epiphany', 'falkon',
}

# Same policy as Windows (email clients only; Windows masks Outlook desktop).
LINUX_REDACTED_BODY_PROCESSES = {
    'thunderbird', 'betterbird', 'evolution', 'geary', 'kmail', 'mailspring', 'claws-mail',
}

# normalized Linux name → canonical key used by the Windows names
LINUX_PROCESS_ALIASES = {
    'googlechromestable': 'chrome',
    'chromium': 'chrome',
    'chromiumbrowser': 'chrome',
    'firefoxesr': 'firefox',
    'firefoxbin': 'firefox',
    'librewolf': 'firefox',
    'microsoftedgestable': 'msedge',
    'vivaldibin': 'vivaldi',
    'codeinsiders': 'vscode',
    'codium': 'vscode',
    'vscodium': 'vscode',
    'teamsforlinux': 'teams',
    'jetbrainsidea': 'idea64',
    'jetbrainsideace': 'idea64',
    'jetbrainspycharm': 'pycharm64',
    'jetbrainspycharmce': 'pycharm64',
    'jetbrainswebstorm': 'webstorm64',
    'jetbrainsgoland': 'goland64',
    'jetbrainsrider': 'rider64',
    'jetbrainsclion': 'clion64',
    'jetbrainsdatagrip': 'datagrip64',
    'jetbrainsphpstorm': 'phpstorm64',
    'jetbrainsrubymine': 'rubymine64',
    'gnometerminalserver': 'gnometerminal',
}

LINUX_BROWSER_KEYS = {'epiphany', 'falkon'}


def process_tables():
    return {
        'browser_processes': set(LINUX_BROWSER_PROCESSES),
        'redacted_body_processes': set(LINUX_REDACTED_BODY_PROCESSES),
        'process_identifier_aliases': dict(LINUX_PROCESS_ALIASES),
        'browser_process_normalized_keys': set(LINUX_BROWSER_KEYS),
    }


def desktop_entry_dirs(environ=None):
    environ = os.environ if environ is None else environ
    home = environ.get('HOME') or os.path.expanduser('~')
    data_home = environ.get('XDG_DATA_HOME') or os.path.join(home, '.local/share')
    data_dirs = (environ.get('XDG_DATA_DIRS') or '/usr/local/share:/usr/share').split(':')
    candidates = [data_home] + data_dirs + ['/var/lib/flatpak/exports/share',
                                            os.path.join(home, '.local/share/flatpak/exports/share'),
                                            '/var/lib/snapd/desktop']
    return [os.path.join(d, 'applications') for d in candidates if d]


def read_desktop_entries(dirs=None):
    """Visible application entries: [{'id','name','comment','exec','wm_class','icon','path'}]."""
    entries, seen = [], set()
    for directory in dirs or desktop_entry_dirs():
        for path in sorted(glob.glob(os.path.join(directory, '*.desktop'))):
            entry_id = os.path.basename(path)[:-len('.desktop')]
            if entry_id in seen:
                continue
            parser = configparser.RawConfigParser(strict=False, interpolation=None)
            try:
                parser.read(path, encoding='utf-8')
                section = parser['Desktop Entry']
            except Exception:
                continue
            if section.get('Type', 'Application') != 'Application' \
                    or section.get('NoDisplay', 'false').lower() == 'true' \
                    or section.get('Hidden', 'false').lower() == 'true':
                continue
            seen.add(entry_id)
            exec_line = section.get('Exec', '')
            binary = os.path.basename(exec_line.split()[0]).strip('"') if exec_line.split() else ''
            entries.append({
                'id': entry_id,
                'name': section.get('Name', entry_id),
                'comment': section.get('Comment', ''),
                'exec': binary,
                'wm_class': section.get('StartupWMClass', ''),
                'icon': section.get('Icon', ''),
                'path': path,
            })
    return entries


def search_running_apps(term, entries=None, running_names=None):
    """Matches for the admin 'search running app' API, best first (core response shape)."""
    term = (term or '').strip().lower()
    if len(term) < 2:
        return []
    if entries is None:
        entries = read_desktop_entries()
    if running_names is None:
        running_names = _running_process_names()

    matches, seen = [], set()
    for entry in entries:
        identifier = entry['exec'] or entry['wm_class'] or entry['id']
        searchable = f"{identifier} {entry['name']} {entry['comment']} {entry['wm_class']} {entry['id']}".lower()
        if term not in searchable or identifier.lower() in seen:
            continue
        seen.add(identifier.lower())
        running = identifier.lower() in running_names
        score = 1.0 if term == identifier.lower() else 0.95 if term in entry['name'].lower() else 0.8
        matches.append({
            'identifier': identifier,
            'display_name': entry['name'],
            'description': entry['comment'] or None,
            'company': None,
            'version': None,
            'executable_path': None,
            'match_score': score + (0.01 if running else 0.0),
            'source': 'desktop_entry',
            'confidence': 'high' if running else 'medium',
        })
    for name in sorted(running_names):
        if term in name and name not in seen:
            seen.add(name)
            matches.append({'identifier': name, 'display_name': name.title(), 'description': None,
                            'company': None, 'version': None, 'executable_path': None,
                            'match_score': 1.0 if term == name else 0.7, 'source': 'psutil',
                            'confidence': 'medium'})
    matches.sort(key=lambda m: m['match_score'], reverse=True)
    return matches


def _running_process_names():
    try:
        import psutil
        return {p.info['name'].lower() for p in psutil.process_iter(['name']) if p.info.get('name')}
    except Exception:
        return set()
