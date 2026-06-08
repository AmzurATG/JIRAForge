# Issue Details & Description Quality Report — User Guide

## Overview

This suite of SQL reports provides comprehensive analysis of issue matching accuracy and description quality for the BRD Time Tracker system. The reports analyze activity records to determine which Jira issues were successfully matched vs. unassigned, and correlates this with description quality.

## Report Files

### 1. `issue_details_comprehensive_report.sql`
Full-featured report with variable placeholders and comprehensive analysis.

**Use when:** Running from command-line tools or when you need the most detailed analysis.

### 2. `issue_details_report_simple.sql` ⭐ RECOMMENDED
Simplified version with inline date literals, optimized for Supabase dashboard execution.

**Use when:** Running directly in Supabase SQL Editor (most common use case).

## Quick Start

### Step 1: Choose Your Date Range

Edit the date values in the SQL queries:

```sql
WHERE ar.created_at >= '2026-05-18'::DATE
  AND ar.created_at < '2026-05-26'::DATE  -- Exclusive end date
```

**Important:** The end date is EXCLUSIVE (uses `<` not `<=`), so use the day AFTER your intended end date.

**Example:** For May 18-25, 2026 reporting window, use:
- Start: `'2026-05-18'`
- End: `'2026-05-26'` (day after May 25)

### Step 2: Run the Queries

Copy and paste each section into Supabase SQL Editor and execute separately:

1. **Quick Summary** — Overall metrics at a glance
2. **Main Report** — Detailed per-issue analysis
3. **User Summary** — One row per user with aggregated stats
4. **Problem Issues** — Issues causing matching failures

### Step 3: Export Results

Click "Download CSV" in Supabase to export results for analysis in Excel or Google Sheets.

## Report Sections Explained

### Section 1: Quick Summary

**Purpose:** High-level overview of matching performance

**Output:** 8 key metrics including:
- Total activity records
- Match rate percentage
- Number of unique issues
- Total users

**Use for:** Executive summary, quick health check

---

### Section 2: Main Report (Issue Details)

**Purpose:** Comprehensive per-issue analysis with user-level statistics

**Output:** One row per (user, issue) pair with:
- **Issue Information**
  - Email, organization
  - Issue key, summary, description preview
  - Description length
  - Issue status, project
  
- **Matching Status**
  - MATCHED: Issue appeared as `user_assigned_issue_key` in at least one activity record
  - UNASSIGNED: Issue was in user's list but never matched
  
- **Description Quality**
  - NONE: No description or empty/whitespace only
  - BAD: Description < 30 characters
  - GOOD: Description >= 30 characters
  
- **User-Level Statistics** (same for all issues from that user)
  - Total activity records for that user
  - Number/percentage matched vs. unassigned
  - Issue quality breakdown (% matched with good/bad/none descriptions)

**Use for:**
- Identifying which specific issues have poor descriptions
- Analyzing per-user matching patterns
- Correlating description quality with matching success
- Creating targeted improvement plans

**Example Row:**
```
email: john@example.com
issue_key: PROJ-123
matching_status: UNASSIGNED
description_quality: BAD
description_length: 15
user_pct_records_matched: 65.5
user_pct_unassigned_with_bad_desc: 45.2
```

**Interpretation:** User John has 65.5% match rate overall. PROJ-123 was never matched and has only a 15-char description. 45.2% of his unassigned issues have bad descriptions, indicating description quality is a major factor.

---

### Section 3: User Summary

**Purpose:** Aggregated view showing one row per user

**Output:** Per-user statistics including:
- Total activity records, matched/unassigned counts, percentages
- Total hours tracked
- Number of unique issues (total, matched, unassigned)
- Quality breakdown:
  - Matched issues: counts and % with good/bad/none descriptions
  - Unassigned issues: counts and % with good/bad/none descriptions

**Use for:**
- Identifying users with low match rates
- Comparing users across the organization
- Prioritizing coaching/training efforts
- Dashboard visualizations

**Sorted by:** Unassigned records (descending) — users with most matching problems appear first

---

### Section 4: Problem Issues List

**Purpose:** Actionable list of issues likely causing matching failures

**Output:** Issues from unassigned activity records that have bad/no descriptions

**Fields:**
- Email, issue key, summary, status
- Description preview (first 200 chars)
- Description length
- Quality classification
- Problem description

**Use for:**
- Creating Jira tickets to improve descriptions
- Sending targeted requests to issue owners
- Measuring description improvement over time
- Training data for description quality guidelines

**Sorted by:** Email, then issue key

---

## Methodology

### Data Sources

1. **Activity Records** (`activity_records` table)
   - Filters: `classification = 'productive'` AND `status = 'analyzed'`
   - Date range: User-specified window
   - Fields used: `user_assigned_issue_key`, `user_assigned_issues` (JSON)

2. **User Issues** (extracted from `user_assigned_issues` JSON field)
   - Contains the issues that were in user's assigned list at the time of activity
   - Includes: key, summary, description, status, project, labels

### Key Definitions

#### Matching Status

- **MATCHED**: The issue key appeared as `user_assigned_issue_key` in at least one activity record within the reporting window. This means the AI successfully matched screen content to this Jira issue.

- **UNASSIGNED**: The issue was in the user's assigned-issues list during the window but never got matched by the AI. These represent potential matching failures.

#### Description Quality

Based on BRD Time Tracker methodology (stricter than some tools):

- **NONE**: `description IS NULL` OR `TRIM(description) = ''`
  - Completely missing or only whitespace
  - Impact: AI has ZERO context for semantic matching

- **BAD**: `LENGTH(TRIM(description)) < 30`
  - Present but too short to be meaningful
  - Impact: Insufficient context for accurate matching
  - Common examples: "TBD", "N/A", "See summary"

- **GOOD**: `LENGTH(TRIM(description)) >= 30`
  - Meets minimum quality threshold
  - Impact: Provides meaningful context for AI matching
  - Note: 30 chars is a LOW bar — better descriptions are 100+ chars with technical details

### Calculation Logic

#### Percentages

All percentages use `NULLIF(denominator, 0)` to handle division by zero gracefully.

**User-level percentages** (e.g., `user_pct_matched_good_desc`):
```
COUNT(matched issues with good desc) * 100.0
─────────────────────────────────────────────
COUNT(all matched issues for this user)
```

**Activity record percentages** (e.g., `user_pct_records_matched`):
```
COUNT(records with issue_key NOT NULL) * 100.0
───────────────────────────────────────────────
COUNT(all activity records for this user)
```

#### Deduplication

Issues are deduplicated per user using `SELECT DISTINCT` on the JSON expansion. If the same issue appears in multiple activity records (common for long-running tasks), it's counted once in issue-level statistics.

### Common Pitfalls

1. **Date Range Confusion**
   - End date is EXCLUSIVE: Use `< '2026-05-26'` not `<= '2026-05-25'`
   - Activity records use `created_at` timestamp (when uploaded, not when activity occurred)

2. **JSON Field Handling**
   - `user_assigned_issues` may be NULL, empty string, or literal string 'null'
   - Always check: `WHERE field IS NOT NULL AND field != '' AND field != 'null'`

3. **Description Trimming**
   - Leading/trailing whitespace doesn't count toward length
   - Empty descriptions may have spaces: `'   '` becomes `''` after `TRIM()`

4. **Percentage Base**
   - "% matched good desc" is out of MATCHED issues only (not all issues)
   - "% records matched" is out of activity records (not issues)

## Common Use Cases

### Use Case 1: Why is User X's Match Rate So Low?

1. Run **User Summary** → Identify user with low `pct_records_matched`
2. Run **Main Report** filtered for that user → See their issue list
3. Check `user_pct_unassigned_with_bad_desc` and `user_pct_unassigned_with_none_desc`
4. If high → Description quality is the problem
5. Run **Problem Issues** → Get specific issue keys to fix

### Use Case 2: Measure Impact of Description Improvements

1. Run reports for Week 1 (before improvements)
2. Improve descriptions based on **Problem Issues** list
3. Run reports for Week 2 (after improvements)
4. Compare `pct_records_matched` and `pct_matched_good_desc` metrics

### Use Case 3: Organization-Wide Description Audit

1. Run **User Summary** for all users
2. Export to spreadsheet
3. Calculate averages:
   - Average `pct_records_matched` across users
   - Average `pct_unassigned_none` (% unassigned with no description)
4. Identify organization-wide patterns
5. Create training/guidelines based on findings

### Use Case 4: Validate AI Matching Improvements

After deploying AI matching algorithm changes:

1. Run reports for same date range as before deployment
2. Compare `pct_records_matched` metrics
3. Check if `pct_matched_bad_desc` increased (AI now matching despite poor descriptions)
4. Validate no regression in `pct_matched_good_desc`

## Performance Tips

### For Large Datasets (>100K records)

1. **Run during off-peak hours** (AI processing load is low)

2. **Narrow the date range**
   - Start with 1 week windows
   - Expand only if needed

3. **Add indexes** (if not present):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_activity_created_classification_status 
   ON activity_records(created_at, classification, status);
   ```

4. **Materialize CTEs** for repeated runs:
   ```sql
   CREATE TEMP TABLE date_filtered AS
   SELECT ... -- CTE content
   ```

### For Quick Ad-Hoc Queries

Run only the specific section you need:
- **Quick Summary** — Fastest, ~1-2 seconds
- **User Summary** — Fast, ~5-10 seconds
- **Main Report** — Moderate, ~20-30 seconds
- **Problem Issues** — Fast, ~5-10 seconds

## Troubleshooting

### Issue: Query returns no results

**Causes:**
1. Date range has no activity records
2. All records are non-productive or non-analyzed
3. `user_assigned_issues` field is NULL for all records

**Solutions:**
```sql
-- Check if records exist in date range
SELECT COUNT(*) 
FROM activity_records 
WHERE created_at >= '2026-05-18'::DATE
  AND created_at < '2026-05-26'::DATE;

-- Check classification/status distribution
SELECT classification, status, COUNT(*) 
FROM activity_records 
WHERE created_at >= '2026-05-18'::DATE
GROUP BY classification, status;
```

### Issue: Percentages are NULL

**Cause:** Division by zero (no records in that category)

**Solution:** This is expected when a user has no matched/unassigned issues. Use `COALESCE(percentage, 0)` in downstream analysis if needed.

### Issue: Issue appears as both MATCHED and UNASSIGNED

**Cause:** This is IMPOSSIBLE by design — the queries use LEFT JOIN and CASE logic that ensures mutual exclusivity.

**If you see this:** There's a data integrity issue. Investigate:
```sql
-- Find issues appearing in both categories
SELECT user_id, issue_key, COUNT(DISTINCT matching_status)
FROM [main_report_output]
GROUP BY user_id, issue_key
HAVING COUNT(DISTINCT matching_status) > 1;
```

### Issue: Description length doesn't match preview

**Cause:** Likely whitespace differences — `TRIM()` is applied for length but not for preview.

**Solution:** Consistent trimming:
```sql
LEFT(TRIM(COALESCE(issue_description, '')), 200)
```

## Data Dictionary

### Fields in Main Report Output

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `email` | TEXT | User's email address | `john@example.com` |
| `organization` | TEXT | Organization display name | `ACME Corp` |
| `issue_key` | TEXT | Jira issue identifier | `PROJ-123` |
| `issue_summary` | TEXT | One-line issue title | `Fix login bug` |
| `description_preview` | TEXT | First 200 chars of description | `User clicks login but...` |
| `description_length` | INTEGER | Character count after trimming | `156` |
| `issue_status` | TEXT | Jira workflow status | `In Progress` |
| `project_key` | TEXT | Jira project code | `PROJ` |
| `matching_status` | TEXT | MATCHED or UNASSIGNED | `UNASSIGNED` |
| `description_quality` | TEXT | GOOD, BAD, or NONE | `BAD` |
| `user_total_activity_records` | INTEGER | Total records for user in window | `420` |
| `user_matched_activity_records` | INTEGER | Records with issue_key assigned | `275` |
| `user_unassigned_activity_records` | INTEGER | Records with no issue_key | `145` |
| `user_pct_records_matched` | NUMERIC(5,2) | % of records that matched | `65.48` |
| `user_pct_records_unassigned` | NUMERIC(5,2) | % of records unassigned | `34.52` |
| `user_total_issues` | INTEGER | Unique issues in user's list | `15` |
| `user_matched_issues` | INTEGER | Issues that got matched | `10` |
| `user_unassigned_issues` | INTEGER | Issues never matched | `5` |
| `user_pct_matched_good_desc` | NUMERIC(5,2) | % matched issues with good desc | `80.00` |
| `user_pct_matched_bad_desc` | NUMERIC(5,2) | % matched issues with bad desc | `15.00` |
| `user_pct_matched_none_desc` | NUMERIC(5,2) | % matched issues with no desc | `5.00` |
| `user_pct_unassigned_good_desc` | NUMERIC(5,2) | % unassigned with good desc | `40.00` |
| `user_pct_unassigned_bad_desc` | NUMERIC(5,2) | % unassigned with bad desc | `40.00` |
| `user_pct_unassigned_none_desc` | NUMERIC(5,2) | % unassigned with no desc | `20.00` |

### Statistical Interpretation

**High `user_pct_records_matched`** (>80%)
- ✅ AI is successfully matching most activity to issues
- Possible causes: Good descriptions, consistent naming, clear context

**Low `user_pct_records_matched`** (<50%)
- ⚠️ Significant matching problems
- Investigate: Description quality, issue list completeness, workflow status

**High `user_pct_unassigned_with_none_desc`** (>30%)
- ❗ Description quality is a major factor
- Action: Mandate descriptions for all issues

**High `user_pct_matched_bad_desc`** (>50%)
- 🤔 AI is matching despite poor descriptions
- Possible: Window titles contain issue keys explicitly
- Don't be complacent — descriptions still matter for edge cases

## Best Practices

### 1. Regular Reporting Cadence

Run reports weekly or bi-weekly to:
- Track improvement trends
- Catch regressions early
- Provide timely feedback to teams

### 2. Benchmark Establishment

First run establishes baseline:
- Save results with clear date/version labels
- Document any known issues (e.g., "Migration in progress")
- Share with stakeholders for context

### 3. Actionable Insights

Always tie metrics to actions:
- **Finding:** 60% of User X's unassigned issues have no description
- **Action:** Send User X the Problem Issues report
- **Measure:** Re-run report in 2 weeks, target 80% described

### 4. Cross-Functional Collaboration

Share reports with:
- **Development Teams**: To improve their own descriptions
- **Product Owners**: To understand time tracking accuracy
- **Managers**: For coaching and process improvements
- **Data Team**: For ML model training if applicable

### 5. Iterative Improvement

Description quality guidelines evolve:
1. Start with 30-char minimum (current)
2. Analyze what "good" looks like (matched issues)
3. Raise bar to 50 or 100 chars as team improves
4. Add semantic checks (keywords, structure)

## FAQ

**Q: Why use `user_assigned_issues` JSON instead of `user_jira_issues_cache` table?**

A: The JSON field captures the exact issue list the AI saw at analysis time. The cache table may have been updated since then, leading to incorrect correlation.

**Q: What if `user_assigned_issues` is NULL?**

A: The record won't appear in issue-level analysis. Check if the desktop app is properly populating this field. Older records may lack it if the field was added later.

**Q: Can I compare different date ranges?**

A: Yes — run the report twice with different dates and use spreadsheet tools (VLOOKUP, pivot tables) to compare. Consider creating a union query for direct comparison.

**Q: Why are percentages sometimes over 100%?**

A: They shouldn't be — this indicates a logic error. Verify the data or contact support.

**Q: How do I handle multi-organization deployments?**

A: Add `WHERE o.id = 'specific-org-id'` to filter, or keep the current GROUP BY for all orgs.

## Change Log

**Version 1.0** (2026-06-08)
- Initial release
- Based on BRD Time Tracker methodology
- 30-character description threshold
- Four report sections (Summary, Details, User, Problems)

---

## Support

For questions or issues:
1. Check the [Troubleshooting](#troubleshooting) section
2. Review example queries in the SQL files
3. Contact the data team with:
   - Date range used
   - Specific error message or unexpected result
   - Sample output (anonymized if needed)
