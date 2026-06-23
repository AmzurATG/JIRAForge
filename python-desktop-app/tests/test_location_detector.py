"""
Tests for the work-location detection feature.

Plan: plan/2026-06-22_multi-component_location-detection-v2.md §9.1

Covers:
  * LocationDetector 3-tier strategy (SSID → subnet → IP geo), including
    precedence (Tier 1 short-circuits and never calls the IP API) and the
    fail-open contract (every failure returns None/False, never raises).
  * TimeTracker._location_log_loop guards (no real/anonymous user, disabled
    org setting, org-default vs project settings) and the INSERT path.
  * TimeTracker._insert_location_log payload shape.
"""

from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest

import desktop_app
from desktop_app import LocationDetector, TimeTracker


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# A realistic 36-char UUID (passes the "not anonymous" guard).
REAL_USER_ID = "11111111-2222-3333-4444-555555555555"


def _netsh_output(ssid):
    """Build fake `netsh wlan show interfaces` stdout with the given SSID.

    The BSSID line is included first on purpose — the parser must skip it.
    """
    return (
        "    Name                   : Wi-Fi\n"
        "    State                  : connected\n"
        f"    BSSID                  : aa:bb:cc:dd:ee:ff\n"
        f"    SSID                   : {ssid}\n"
        "    Signal                 : 90%\n"
    )


def _completed(stdout):
    return SimpleNamespace(stdout=stdout, returncode=0)


# ===========================================================================
# Tier 1a — WiFi SSID detection
# ===========================================================================

class TestTier1aSSID:
    def test_ssid_matches_office_list(self):
        det = LocationDetector()
        with patch.object(desktop_app.subprocess, 'run',
                          return_value=_completed(_netsh_output("Amzur-Office"))):
            result = det.get_location(office_ssids=["Amzur-Office"], office_subnets=[])
        assert result['work_location_type'] == 'office'
        assert result['work_location_source'] == 'ssid'
        assert result['ip'] is None
        assert result['city'] is None

    def test_ssid_present_but_not_in_list_falls_through(self):
        det = LocationDetector()
        with patch.object(desktop_app.subprocess, 'run',
                          return_value=_completed(_netsh_output("HomeWiFi"))), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=None), \
             patch.object(det, '_fetch_ipinfo', return_value=None) as fetch:
            result = det.get_location(office_ssids=["Amzur-Office"], office_subnets=[])
        assert result is None
        fetch.assert_called_once()  # fell through to IP geo

    def test_no_wifi_adapter_filenotfound(self):
        det = LocationDetector()
        with patch.object(desktop_app.subprocess, 'run', side_effect=FileNotFoundError()):
            assert det._get_current_ssid() is None

    def test_ssid_detection_timeout(self):
        det = LocationDetector()
        err = desktop_app.subprocess.TimeoutExpired(cmd='netsh', timeout=3)
        with patch.object(desktop_app.subprocess, 'run', side_effect=err):
            assert det._get_current_ssid() is None

    def test_empty_office_ssid_list_no_match(self):
        det = LocationDetector()
        with patch.object(desktop_app.subprocess, 'run',
                          return_value=_completed(_netsh_output("AnySSID"))), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=None), \
             patch.object(det, '_fetch_ipinfo', return_value=None):
            result = det.get_location(office_ssids=[], office_subnets=[])
        assert result is None

    def test_ssid_match_is_case_sensitive(self):
        det = LocationDetector()
        with patch.object(desktop_app.subprocess, 'run',
                          return_value=_completed(_netsh_output("amzur-office"))), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=None), \
             patch.object(det, '_fetch_ipinfo', return_value=None):
            result = det.get_location(office_ssids=["Amzur-Office"], office_subnets=[])
        assert result is None  # case mismatch → no office match


# ===========================================================================
# Tier 1b — LAN subnet detection
# ===========================================================================

class TestTier1bSubnet:
    def test_local_ip_inside_subnet(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value="10.0.1.42"):
            result = det.get_location(office_ssids=[], office_subnets=["10.0.0.0/8"])
        assert result['work_location_type'] == 'office'
        assert result['work_location_source'] == 'subnet'
        assert result['ip'] is None

    def test_local_ip_outside_all_subnets_falls_through(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value="192.168.1.5"), \
             patch.object(det, '_get_windows_geoposition', return_value=None), \
             patch.object(det, '_fetch_ipinfo', return_value=None) as fetch:
            result = det.get_location(office_ssids=[], office_subnets=["10.0.0.0/8"])
        assert result is None
        fetch.assert_called_once()

    def test_malformed_subnet_entry_is_skipped(self):
        det = LocationDetector()
        # "not-a-cidr" must be skipped; the valid entry must still match.
        assert det._is_in_office_subnet("10.0.0.5", ["not-a-cidr", "10.0.0.0/8"]) is True

    def test_gethostbyname_raises(self):
        det = LocationDetector()
        with patch.object(desktop_app.socket, 'gethostbyname', side_effect=OSError()):
            assert det._get_local_ip() is None

    def test_empty_subnet_list_no_match(self):
        det = LocationDetector()
        assert det._is_in_office_subnet("10.0.0.5", []) is False


# ===========================================================================
# Tier 2 — IP geolocation
# ===========================================================================

def _resp(status=200, json_data=None, raise_json=False):
    m = MagicMock()
    m.status_code = status
    if raise_json:
        m.json.side_effect = ValueError("not json")
    else:
        m.json.return_value = json_data or {}
    return m


class TestTier2IPGeo:
    def test_happy_path(self):
        det = LocationDetector()
        payload = {"city": "Austin", "region": "Texas", "country": "US", "ip": "1.2.3.4"}
        with patch.object(desktop_app.requests, 'get', return_value=_resp(200, payload)):
            result = det._fetch_ipinfo()
        assert result['work_location_type'] == 'remote'
        assert result['work_location_source'] == 'ip_geo'
        assert result['city'] == "Austin"
        assert result['region'] == "Texas"
        assert result['country'] == "US"
        assert result['country_code'] == "US"
        assert result['ip'] == "1.2.3.4"

    @pytest.mark.parametrize("status", [429, 503, 401, 500])
    def test_non_200_returns_none(self, status):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get', return_value=_resp(status)):
            assert det._fetch_ipinfo() is None

    def test_network_timeout_returns_none(self):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get',
                          side_effect=desktop_app.requests.Timeout()):
            assert det._fetch_ipinfo() is None

    def test_connection_error_returns_none(self):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get',
                          side_effect=desktop_app.requests.ConnectionError()):
            assert det._fetch_ipinfo() is None

    def test_malformed_json_returns_none(self):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get', return_value=_resp(200, raise_json=True)):
            assert det._fetch_ipinfo() is None

    def test_partial_response_missing_city(self):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get', return_value=_resp(200, {"ip": "1.2.3.4"})):
            result = det._fetch_ipinfo()
        assert result is not None
        assert result['city'] is None
        assert result['ip'] == "1.2.3.4"


# ===========================================================================
# Tier precedence — tiers must not bleed into each other
# ===========================================================================

class TestTierPrecedence:
    def test_tier1a_match_skips_ip_lookup(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value="Office"), \
             patch.object(det, '_fetch_ipinfo') as fetch:
            result = det.get_location(office_ssids=["Office"], office_subnets=[])
        assert result['work_location_source'] == 'ssid'
        fetch.assert_not_called()

    def test_tier1b_match_skips_ip_lookup(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value="10.0.0.9"), \
             patch.object(det, '_fetch_ipinfo') as fetch:
            result = det.get_location(office_ssids=[], office_subnets=["10.0.0.0/8"])
        assert result['work_location_source'] == 'subnet'
        fetch.assert_not_called()

    def test_all_tiers_fail_returns_none(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=None), \
             patch.object(det, '_fetch_ipinfo', return_value=None):
            assert det.get_location(office_ssids=["X"], office_subnets=["10.0.0.0/8"]) is None


# ===========================================================================
# Tier 2 — Windows precise geolocation + reverse geocode
# ===========================================================================

class TestWindowsGeo:
    def test_win_geo_success_with_reverse_geocode(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=(17.69, 83.15, 50.0)), \
             patch.object(det, '_reverse_geocode',
                          return_value={'city': 'Gajuwaka', 'region': 'Andhra Pradesh', 'country': 'IN'}), \
             patch.object(det, '_fetch_ipinfo') as fetch:
            result = det.get_location(office_ssids=[], office_subnets=[])
        assert result['work_location_source'] == 'win_geo'
        assert result['work_location_type'] == 'remote'
        assert result['city'] == 'Gajuwaka'
        assert result['region'] == 'Andhra Pradesh'
        assert result['country'] == 'IN'
        assert result['country_code'] == 'IN'
        assert result['latitude'] == 17.69
        assert result['longitude'] == 83.15
        assert result['accuracy_m'] == 50.0
        assert result['ip'] is None
        fetch.assert_not_called()  # precise fix → no IP fallback

    def test_win_geo_kept_when_reverse_geocode_fails(self):
        det = LocationDetector()
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=(1.0, 2.0, 30.0)), \
             patch.object(det, '_reverse_geocode', return_value=None), \
             patch.object(det, '_fetch_ipinfo') as fetch:
            result = det.get_location(office_ssids=[], office_subnets=[])
        assert result['work_location_source'] == 'win_geo'
        assert result['latitude'] == 1.0 and result['longitude'] == 2.0
        assert result['city'] is None  # name unknown, but coordinates retained
        fetch.assert_not_called()

    def test_win_geo_unavailable_falls_back_to_ip(self):
        det = LocationDetector()
        ip_result = {'work_location_source': 'ip_geo', 'city': 'Austin'}
        with patch.object(det, '_get_current_ssid', return_value=None), \
             patch.object(det, '_get_local_ip', return_value=None), \
             patch.object(det, '_get_windows_geoposition', return_value=None), \
             patch.object(det, '_fetch_ipinfo', return_value=ip_result) as fetch:
            result = det.get_location(office_ssids=[], office_subnets=[])
        assert result['work_location_source'] == 'ip_geo'
        fetch.assert_called_once()

    def test_get_windows_geoposition_none_when_sdk_unavailable(self):
        det = LocationDetector()
        with patch.object(desktop_app, '_WIN_GEOLOCATION_AVAILABLE', False):
            assert det._get_windows_geoposition() is None

    def test_reverse_geocode_parses_city_region_country(self):
        det = LocationDetector()
        body = {'city': 'Gajuwaka', 'locality': 'Gajuwaka',
                'principalSubdivision': 'Andhra Pradesh', 'countryCode': 'IN'}
        with patch.object(desktop_app.requests, 'get', return_value=_resp(200, body)):
            out = det._reverse_geocode(17.69, 83.15)
        assert out == {'city': 'Gajuwaka', 'region': 'Andhra Pradesh', 'country': 'IN'}

    def test_reverse_geocode_falls_back_to_locality(self):
        det = LocationDetector()
        body = {'locality': 'Madhurawada', 'principalSubdivision': 'AP', 'countryCode': 'IN'}
        with patch.object(desktop_app.requests, 'get', return_value=_resp(200, body)):
            out = det._reverse_geocode(1.0, 2.0)
        assert out['city'] == 'Madhurawada'

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_reverse_geocode_http_error_returns_none(self, status):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get', return_value=_resp(status)):
            assert det._reverse_geocode(1.0, 2.0) is None

    def test_reverse_geocode_network_error_returns_none(self):
        det = LocationDetector()
        with patch.object(desktop_app.requests, 'get',
                          side_effect=desktop_app.requests.ConnectionError()):
            assert det._reverse_geocode(1.0, 2.0) is None


# ===========================================================================
# TimeTracker._location_log_loop guards + insert path
# ===========================================================================

def _loop_stub(*, user_id=REAL_USER_ID, supabase_init=True, org_settings=None):
    """Minimal stub exposing only the attributes _location_log_loop touches."""
    stub = SimpleNamespace()
    stub.running = True
    stub.current_user_id = user_id
    stub.supabase_initialized = supabase_init
    stub.default_tracking_settings = {
        'location_detection_enabled': True,
        'office_ssid_names': [],
        'office_subnet_prefixes': [],
    }
    if org_settings is None:
        org_settings = dict(stub.default_tracking_settings)
    stub.tracking_settings_cache = {'_org_default': org_settings}
    stub.location_detector = MagicMock()
    stub._insert_location_log = MagicMock()
    return stub


def _run_loop_once(stub):
    """Drive the real loop against a stub, breaking it via a patched sleep.

    sleep() flips running False so the loop runs at most one full iteration.
    """
    def _stop_sleep(_seconds):
        stub.running = False
    with patch.object(desktop_app.time, 'sleep', side_effect=_stop_sleep):
        TimeTracker._location_log_loop(stub)


class TestLocationLogLoop:
    def test_disabled_org_setting_skips_everything(self):
        stub = _loop_stub(org_settings={
            'location_detection_enabled': False,
            'office_ssid_names': [], 'office_subnet_prefixes': [],
        })
        _run_loop_once(stub)
        stub.location_detector.get_location.assert_not_called()
        stub._insert_location_log.assert_not_called()

    def test_no_user_id_skips(self):
        stub = _loop_stub(user_id=None)
        _run_loop_once(stub)
        stub.location_detector.get_location.assert_not_called()
        stub._insert_location_log.assert_not_called()

    def test_anonymous_user_skips(self):
        stub = _loop_stub(user_id="anonymous_abc123")
        _run_loop_once(stub)
        stub.location_detector.get_location.assert_not_called()
        stub._insert_location_log.assert_not_called()

    def test_supabase_not_initialized_skips(self):
        stub = _loop_stub(supabase_init=False)
        _run_loop_once(stub)
        stub.location_detector.get_location.assert_not_called()
        stub._insert_location_log.assert_not_called()

    def test_get_location_none_no_insert(self):
        stub = _loop_stub()
        stub.location_detector.get_location.return_value = None
        _run_loop_once(stub)
        stub.location_detector.get_location.assert_called_once()
        stub._insert_location_log.assert_not_called()

    def test_valid_result_inserts(self):
        stub = _loop_stub()
        loc = {'work_location_type': 'remote', 'work_location_source': 'ip_geo'}
        stub.location_detector.get_location.return_value = loc
        _run_loop_once(stub)
        stub._insert_location_log.assert_called_once_with(loc)

    def test_project_row_does_not_mask_org_disable(self):
        # Org-default disabled; even though a project might enable it, the loop
        # reads _org_default only.
        stub = _loop_stub(org_settings={
            'location_detection_enabled': False,
            'office_ssid_names': ["Proj-SSID"], 'office_subnet_prefixes': [],
        })
        _run_loop_once(stub)
        stub.location_detector.get_location.assert_not_called()

    def test_insert_exception_does_not_escape_loop(self):
        stub = _loop_stub()
        stub.location_detector.get_location.return_value = {'work_location_type': 'remote'}
        stub._insert_location_log.side_effect = RuntimeError("supabase down")
        # Should not raise — the loop catches and continues to sleep/exit.
        _run_loop_once(stub)


# ===========================================================================
# TimeTracker._insert_location_log payload
# ===========================================================================

class TestInsertLocationLog:
    def _stub(self):
        stub = SimpleNamespace()
        stub.current_user_id = REAL_USER_ID
        stub.organization_id = "org-uuid"
        # Valid JWT far in the future → the pre-insert refresh guard is a no-op.
        stub.auth_manager = SimpleNamespace(tokens={'supabase_token_expires_at': 9999999999})
        stub._set_supabase_jwt = MagicMock(return_value=True)
        table = MagicMock()
        client = MagicMock()
        client.table.return_value = table
        table.insert.return_value = table
        stub.supabase = client
        return stub, client, table

    def test_payload_fields(self):
        stub, client, table = self._stub()
        loc = {
            'work_location_type': 'remote', 'work_location_source': 'ip_geo',
            'city': 'Austin', 'region': 'Texas', 'country': 'US',
            'country_code': 'US', 'ip': '1.2.3.4',
        }
        TimeTracker._insert_location_log(stub, loc)
        client.table.assert_called_once_with('user_location_log')
        payload = table.insert.call_args[0][0]
        assert payload['user_id'] == REAL_USER_ID
        assert payload['organization_id'] == "org-uuid"
        assert payload['city'] == 'Austin'
        assert payload['work_location_type'] == 'remote'
        assert 'recorded_at' in payload
        table.execute.assert_called_once()

    def test_office_payload_has_null_ip(self):
        stub, client, table = self._stub()
        loc = {
            'work_location_type': 'office', 'work_location_source': 'ssid',
            'city': None, 'region': None, 'country': None,
            'country_code': None, 'ip': None,
        }
        TimeTracker._insert_location_log(stub, loc)
        payload = table.insert.call_args[0][0]
        assert payload['ip'] is None
        assert payload['city'] is None
        assert payload['work_location_source'] == 'ssid'

    def test_refreshes_jwt_when_expired_then_inserts(self):
        # Regression: the startup snapshot raced the JWT refresh and 401'd.
        stub, client, table = self._stub()
        stub.auth_manager.tokens['supabase_token_expires_at'] = 1  # long expired
        stub._set_supabase_jwt = MagicMock(return_value=True)
        TimeTracker._insert_location_log(
            stub, {'work_location_type': 'remote', 'work_location_source': 'win_geo'})
        stub._set_supabase_jwt.assert_called_once()
        table.execute.assert_called_once()  # insert still happens after refresh

    def test_skips_insert_when_jwt_refresh_fails(self):
        stub, client, table = self._stub()
        stub.auth_manager.tokens['supabase_token_expires_at'] = 1  # long expired
        stub._set_supabase_jwt = MagicMock(return_value=False)
        TimeTracker._insert_location_log(
            stub, {'work_location_type': 'remote', 'work_location_source': 'win_geo'})
        stub._set_supabase_jwt.assert_called_once()
        table.insert.assert_not_called()   # no insert when token can't be refreshed
        table.execute.assert_not_called()
