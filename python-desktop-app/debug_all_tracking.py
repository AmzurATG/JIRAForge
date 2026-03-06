#!/usr/bin/env python3
"""Debug script to check ALL time tracking data sources in Supabase"""
import os
import sys

# Try to load from parent .env or current
from pathlib import Path
env_paths = [
    Path('.env'),
    Path('../.env'),
    Path('../../.env'),
]

from dotenv import load_dotenv
for p in env_paths:
    if p.exists():
        load_dotenv(p)
        print(f"Loaded env from: {p.absolute()}")
        break

url = os.getenv('SUPABASE_URL')
key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

if not url or not key:
    # Try reading from ai-server .env
    ai_env = Path('../ai-server/.env')
    if ai_env.exists():
        load_dotenv(ai_env)
        url = os.getenv('SUPABASE_URL')
        key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        print(f"Loaded env from: {ai_env.absolute()}")

if not url or not key:
    print('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    print('Set these in .env file')
    sys.exit(1)

from supabase import create_client
supabase = create_client(url, key)

print(f"\n{'='*60}")
print("SUPABASE TIME TRACKING DATA DEBUG")
print(f"{'='*60}")

# Get users
users = supabase.table('users').select('id, email').limit(10).execute()
print(f"\nUsers in database: {len(users.data) if users.data else 0}")

for u in (users.data or []):
    user_id = u['id']
    email = u['email']
    print(f"\n{'='*60}")
    print(f"USER: {email}")
    print(f"{'='*60}")
    
    # 1. Check screenshots table
    screenshots = supabase.table('screenshots').select('id, status').eq('user_id', user_id).execute()
    print(f"\n1. SCREENSHOTS: {len(screenshots.data) if screenshots.data else 0}")
    
    # 2. Check analysis_results (for screenshot-based tracking)  
    analysis = supabase.table('analysis_results').select(
        'id, active_task_key, work_type'
    ).eq('user_id', user_id).limit(20).execute()
    print(f"\n2. ANALYSIS_RESULTS: {len(analysis.data) if analysis.data else 0}")
    if analysis.data:
        with_task = [r for r in analysis.data if r.get('active_task_key')]
        print(f"   - With active_task_key: {len(with_task)}")
        if with_task[:5]:
            print(f"   - Sample keys: {[r['active_task_key'] for r in with_task[:5]]}")
    
    # 3. Check activity_records (for event-based tracking)
    activity = supabase.table('activity_records').select(
        'id, status, user_assigned_issue_key, application_name, total_time_seconds'
    ).eq('user_id', user_id).limit(20).execute()
    print(f"\n3. ACTIVITY_RECORDS: {len(activity.data) if activity.data else 0}")
    if activity.data:
        status_counts = {}
        for r in activity.data:
            s = r.get('status', 'null')
            status_counts[s] = status_counts.get(s, 0) + 1
        print(f"   - By status: {status_counts}")
        with_issue = [r for r in activity.data if r.get('user_assigned_issue_key')]
        print(f"   - With issue_key: {len(with_issue)}")
        if with_issue[:5]:
            for r in with_issue[:5]:
                print(f"     - {r['application_name'][:20]} -> {r['user_assigned_issue_key']} ({r['total_time_seconds']}s)")

print(f"\n{'='*60}")
print("DEBUG COMPLETE")
print(f"{'='*60}")
