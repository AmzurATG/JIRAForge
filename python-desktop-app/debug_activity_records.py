#!/usr/bin/env python3
"""Debug script to check activity_records in Supabase"""
import os
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

url = os.getenv('SUPABASE_URL')
key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

if not url or not key:
    print('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    exit(1)

supabase = create_client(url, key)

# Get all users
users = supabase.table('users').select('id, email').limit(10).execute()
print(f"Found {len(users.data) if users.data else 0} users")

if users.data:
    for u in users.data:
        user_id = u['id']
        email = u['email']
        print(f"\n=== User: {email} ===")
        
        # Get activity records
        records = supabase.table('activity_records').select(
            'id, status, user_assigned_issue_key, application_name, window_title, total_time_seconds, created_at'
        ).eq('user_id', user_id).order('created_at', desc=True).limit(15).execute()
        
        if records.data:
            print(f"Recent activity records ({len(records.data)}):")
            for r in records.data:
                status = r['status'] or 'unknown'
                app = (r['application_name'] or 'unknown')[:20]
                issue = r['user_assigned_issue_key'] or '-'
                time_sec = r['total_time_seconds'] or 0
                created = (r['created_at'] or '')[:19]
                print(f"  [{status:10}] {app:20} -> {issue:15} ({time_sec}s) {created}")
        else:
            print("  No activity records found!")
        
        # Count by status
        all_recs = supabase.table('activity_records').select('status').eq('user_id', user_id).execute()
        if all_recs.data:
            counts = {}
            for r in all_recs.data:
                s = r['status'] or 'null'
                counts[s] = counts.get(s, 0) + 1
            print(f"  Status summary: {counts}")
            
            # Count with issue key
            with_issue = supabase.table('activity_records').select('id').eq('user_id', user_id).not_.is_('user_assigned_issue_key', 'null').execute()
            print(f"  Records with issue key: {len(with_issue.data) if with_issue.data else 0}")
else:
    print("No users found in database")
