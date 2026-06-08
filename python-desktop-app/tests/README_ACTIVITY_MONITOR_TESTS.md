# Activity Monitor Fix - Test Suite

This directory contains comprehensive tests for the activity monitor thread fix.

---

## Test Files

### 1. `test_activity_monitor_fix.py` (Unit Tests)
**Automated unit tests** for the activity monitor thread fix.

**Tests**:
- Thread stays alive after starting (CRITICAL)
- No continuous restarts
- Heartbeat updates during loop
- Listener failure detection
- Stuck idle recovery (30-min safeguard)
- Fallback detection on window switch

**Run**:
```bash
python test_activity_monitor_fix.py
```

**Expected**: All 6 tests pass

---

### 2. `test_activity_monitor_integration.py` (Integration Tests)
**Integration tests** that run against a live desktop app instance.

**Tests**:
- Thread stays alive (log monitoring)
- No continuous restarts (10-minute monitoring)
- Icon color after login (manual)
- Idle timeout and resume (manual, 6 minutes)
- Data tracking verification

**Requirements**:
- Desktop app must be running
- Access to log file

**Run**:
```bash
python test_activity_monitor_integration.py
```

**Duration**: 10-20 minutes

---

### 3. `manual_test_script.py` (Manual Tests)
**Interactive guided tests** for manual validation.

**Test Scenarios**:
1. Fresh install (clean install + login)
2. No restart warnings (5-minute log monitoring)
3. Idle timeout and resume (6-minute idle test)
4. Activity tracking (15-minute usage)
5. Long-running session (4+ hours)

**Run**:
```bash
python manual_test_script.py
```

**Duration**: 20-30 minutes (excluding long-running test)

---

## Quick Start

### Run All Automated Tests
```bash
# Unit tests
python test_activity_monitor_fix.py

# Integration tests (requires running app)
python test_activity_monitor_integration.py
```

### Run Manual Tests
```bash
python manual_test_script.py
```

---

## Test Strategy

### Pre-Deployment (Required)
1. ✅ Run unit tests
2. ✅ Run integration tests (automated parts)
3. ✅ Run manual test scenarios 1-4

### Post-Deployment (Recommended)
1. ✅ Run full manual test suite
2. ✅ Test on fresh machine
3. ✅ Monitor logs for 4+ hours

---

## Success Criteria

### Unit Tests
- All 6 tests pass
- No exceptions or errors

### Integration Tests
- No "thread is dead" warnings in 10 minutes
- Icon is green after login
- Activity records found in logs

### Manual Tests
- Fresh install shows green icon
- Idle timeout and resume work
- Tracking data captured
- Stable for 4+ hours

---

## Common Issues

### Import Errors
If you get import errors:
```bash
# Make sure you're in the python-desktop-app directory
cd python-desktop-app
python tests/test_activity_monitor_fix.py
```

### "Module not found: desktop_app"
The tests add the parent directory to sys.path, but if you still get this error:
```bash
# Add PYTHONPATH
export PYTHONPATH=$PYTHONPATH:$(pwd)  # Linux/Mac
set PYTHONPATH=%PYTHONPATH%;%cd%      # Windows
```

### Integration Tests: "Log file not found"
The integration tests need the log file path:
- Default: `C:\Users\<username>\AppData\Local\TimeTracker\logs\timetracker.log`
- Customize when prompted

---

## Test Reports

After running tests, check:
- Console output for results
- Test summary at end
- Failed tests are marked with ❌

Example output:
```
======================================================================
TEST SUMMARY
======================================================================
Tests run: 6
Successes: 6
Failures: 0
Errors: 0
======================================================================
🎉 ALL TESTS PASSED! 🎉
```

---

## CI/CD Integration (Future)

These tests can be integrated into CI/CD:

```yaml
# Example GitHub Actions workflow
- name: Run unit tests
  run: |
    cd python-desktop-app
    python tests/test_activity_monitor_fix.py

# Integration tests require a running app, so they're best for manual QA
```

---

## Contributing

When adding new tests:
1. Follow existing test structure
2. Use descriptive test names
3. Add docstrings explaining what's tested
4. Update this README with new tests

---

## Support

For issues or questions:
1. Check [DESKTOP_APP_ACTIVITY_MONITOR_FIX_PLAN.md](../docs/DESKTOP_APP_ACTIVITY_MONITOR_FIX_PLAN.md)
2. Check [ACTIVITY_MONITOR_FIX_IMPLEMENTATION_SUMMARY.md](../docs/ACTIVITY_MONITOR_FIX_IMPLEMENTATION_SUMMARY.md)
3. Review test output carefully
4. Check desktop app logs

---

## Quick Reference

| Test Type | File | Duration | Requires App? | Automated? |
|-----------|------|----------|---------------|------------|
| Unit | `test_activity_monitor_fix.py` | 1 min | No | Yes |
| Integration | `test_activity_monitor_integration.py` | 10-20 min | Yes | Partial |
| Manual | `manual_test_script.py` | 20-30 min | Yes | No |
