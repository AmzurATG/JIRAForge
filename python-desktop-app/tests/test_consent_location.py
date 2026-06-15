"""
Consent v1.1 — approximate working-location disclosure (plan AC1, AC2).
Plan: plan/2026-06-12_cross-component_automatic-employee-location-detection.md

The consent version bump must force re-consent for users who consented under
v1.0, and the recorded consent must disclose the approximate-working-location
data category.
"""

import json
import os
import sys

import pytest

# Add parent directory to path to import desktop_app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from desktop_app import ConsentManager


@pytest.fixture
def manager(tmp_path):
    return ConsentManager(store_path=str(tmp_path / "consent.json"))


def test_consent_version_is_bumped_for_location_detection():
    assert ConsentManager.CONSENT_VERSION == "1.1"


def test_v10_consent_is_invalid_under_v11(manager):
    """AC1: a previously-consented user is re-prompted after the version bump."""
    manager.consent_data["user-1"] = {
        "consented": True,
        "version": "1.0",
        "user_email": "u@example.com",
    }
    assert manager.has_valid_consent("user-1") is False


def test_recorded_consent_discloses_approximate_working_location(manager):
    """AC2: the stored consent record lists the new data category."""
    manager.record_consent("user-1", True, "u@example.com")

    info = manager.get_consent_info("user-1")
    assert info["consented"] is True
    assert info["version"] == "1.1"
    assert any("approximate_working_location" in item for item in info["data_collected"])

    # And it round-trips through the store file
    with open(manager.store_path) as f:
        stored = json.load(f)
    assert any("approximate_working_location" in item for item in stored["user-1"]["data_collected"])


def test_fresh_v11_consent_is_valid(manager):
    manager.record_consent("user-1", True, "u@example.com")
    assert manager.has_valid_consent("user-1") is True


def test_denial_and_revocation_still_block(manager):
    """Declining or revoking consent keeps tracking gated (pre-existing behavior)."""
    manager.record_consent("user-1", False, "u@example.com")
    assert manager.has_valid_consent("user-1") is False

    manager.record_consent("user-1", True, "u@example.com")
    manager.revoke_consent("user-1")
    assert manager.has_valid_consent("user-1") is False
