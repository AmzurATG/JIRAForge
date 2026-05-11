"""Quick demo of thread-safe state transitions."""
from desktop_app import TimeTracker, TrackingState
import threading
import time
from unittest.mock import Mock

# Setup tracker
tracker = TimeTracker()
tracker.state = TrackingState.ACTIVE

# Mock methods with delay to simulate race condition
tracker._finalize_active_session = Mock(side_effect=lambda r: time.sleep(0.01))
tracker.session_manager = Mock()
tracker.update_tray_icon = Mock()

results = []

def call_enter_idle():
    result = tracker.enter_idle('concurrent test')
    results.append(result)

# Launch 5 threads concurrently
print("Launching 5 threads concurrently trying to enter idle state...")
threads = [threading.Thread(target=call_enter_idle) for _ in range(5)]
for t in threads:
    t.start()
for t in threads:
    t.join()

# Analyze results
print(f"\nResults: {results}")
print(f"True count (successful transitions): {sum(results)}")
print(f"False count (rejected - already idle): {len(results) - sum(results)}")
print(f"\nFinal state: {tracker.state.name}")
print(f"\nTest: {'✅ PASS' if sum(results) == 1 else '❌ FAIL'}")
print("Only 1 thread should successfully transition due to locking.")
