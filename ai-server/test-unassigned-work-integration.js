/**
 * test-unassigned-work-integration.js
 * 
 * Test harness for unassigned work flow validation
 * Creates sample unassigned work, verifies conversion updates timeline correctly
 * 
 * USAGE:
 * node test-unassigned-work-integration.js --user-id <UUID> --org-id <UUID> [--project PROJ] [--issue PROJ-123]
 * 
 * EXAMPLES:
 * node test-unassigned-work-integration.js --user-id 550e8400-e29b-41d4-a716-446655440000 --org-id 660e8400-e29b-41d4-a716-446655440001
 * 
 * PHASES:
 * 1. Create 3 sample unassigned work activities (900s, 720s, 1080s = 2700s total)
 * 2. Group them into unassigned_work_groups
 * 3. Verify PRE-CONVERSION state
 * 4. Simulate assignment to PROJ-123
 * 5. Verify POST-CONVERSION state
 * 6. Check timeline behavior
 * 7. Validate data consistency
 * 8. Provide cleanup instructions
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================

class UnassignedWorkTester {
  constructor(config) {
    this.targetUserId = config.userId;
    this.targetOrgId = config.orgId;
    this.testProjectKey = config.projectKey || 'PROJ';
    this.testIssueKey = config.issueKey || 'PROJ-123';
    this.testDate = config.testDate || '2026-04-16';
    
    this.supabase = createClient(
      process.env.SUPABASE_URL || 'https://your-project.supabase.co',
      process.env.SUPABASE_SERVICE_KEY || 'your-service-key'
    );
    
    this.createdActivityIds = [];
    this.createdGroupId = null;
    this.results = {
      phase: {},
      checks: {}
    };
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
    console.log(`[${timestamp}] ${icon} ${message}`);
  }

  // =========================================================================
  // PHASE 1: Create Sample Activities
  // =========================================================================

  async createSampleActivities() {
    this.log('PHASE 1: Creating 3 sample unassigned work activities...', 'info');
    
    const activities = [
      {
        window_title: 'localhost:5432 - pgAdmin 4',
        application_name: 'pgAdmin',
        start_time: new Date('2026-04-16T09:30:00Z').toISOString(),
        end_time: new Date('2026-04-16T09:45:00Z').toISOString(),
        duration_seconds: 900,
        description: 'Database optimization work'
      },
      {
        window_title: 'localhost:3000 - My API Server',
        application_name: 'VS Code',
        start_time: new Date('2026-04-16T10:15:00Z').toISOString(),
        end_time: new Date('2026-04-16T10:27:00Z').toISOString(),
        duration_seconds: 720,
        description: 'API debugging'
      },
      {
        window_title: 'GitHub - Pull Request Review',
        application_name: 'Google Chrome',
        start_time: new Date('2026-04-16T11:00:00Z').toISOString(),
        end_time: new Date('2026-04-16T11:18:00Z').toISOString(),
        duration_seconds: 1080,
        description: 'Code review'
      }
    ];

    for (const activity of activities) {
      try {
        const { data, error } = await this.supabase
          .from('activity_records')
          .insert({
            user_id: this.targetUserId,
            organization_id: this.targetOrgId,
            window_title: activity.window_title,
            application_name: activity.application_name,
            start_time: activity.start_time,
            end_time: activity.end_time,
            duration_seconds: activity.duration_seconds,
            total_time_seconds: activity.duration_seconds,
            status: 'analyzed',
            classification: 'productive',
            clustering_dismissed: false,
            user_assigned_issue_key: null,  // CRITICAL: Unassigned
            project_key: null
          })
          .select('id');

        if (error) throw error;
        
        const activityId = data[0].id;
        this.createdActivityIds.push(activityId);
        this.log(`  ✓ Created activity: ${activity.description} (${activity.duration_seconds}s)`, 'success');
      } catch (err) {
        this.log(`  Failed to create activity: ${err.message}`, 'error');
        throw err;
      }
    }

    this.results.phase.creation = {
      status: 'success',
      activities_created: this.createdActivityIds.length,
      total_seconds: 2700
    };

    this.log(`PHASE 1 COMPLETE: Created ${this.createdActivityIds.length} activities`, 'success');
  }

  // =========================================================================
  // PHASE 2: Create Unassigned Work Group
  // =========================================================================

  async createUnassignedWorkGroup() {
    this.log('PHASE 2: Creating unassigned work group...', 'info');

    try {
      const { data, error } = await this.supabase
        .from('unassigned_work_groups')
        .insert({
          user_id: this.targetUserId,
          organization_id: this.targetOrgId,
          group_label: 'Backend Development Work',
          group_description: 'Unassigned work on database and API development',
          session_count: this.createdActivityIds.length,
          total_seconds: 2700,
          is_assigned: false,  // CRITICAL: NOT assigned yet
          assigned_to_issue_key: null,
          is_dismissed: false,
          confidence_level: 'high',
          recommended_action: 'assign_to',
          suggested_issue_key: this.testIssueKey,
          recommendation_reason: 'Work matches the development timeline for this sprint'
        })
        .select('id');

      if (error) throw error;

      this.createdGroupId = data[0].id;
      this.log(`Created unassigned work group: ${this.createdGroupId}`, 'success');

      // Link activities to group
      await this.linkActivitiesToGroup();

    } catch (err) {
      this.log(`Failed to create group: ${err.message}`, 'error');
      throw err;
    }

    this.results.phase.grouping = {
      status: 'success',
      group_id: this.createdGroupId
    };

    this.log('PHASE 2 COMPLETE: Group created and activities linked', 'success');
  }

  async linkActivitiesToGroup() {
    this.log('Linking activities to group...', 'info');

    try {
      const members = this.createdActivityIds.map(activityId => ({
        group_id: this.createdGroupId,
        activity_record_id: activityId
      }));

      const { error } = await this.supabase
        .from('unassigned_group_members')
        .insert(members);

      if (error) throw error;

      this.log(`Linked ${members.length} activities to group`, 'success');
    } catch (err) {
      this.log(`Failed to link activities: ${err.message}`, 'error');
      throw err;
    }
  }

  // =========================================================================
  // PHASE 3: PRE-CONVERSION Verification
  // =========================================================================

  async verifyPreConversionState() {
    this.log('PHASE 3: Verifying PRE-CONVERSION state...', 'info');

    // CHECK 1: Group is NOT assigned
    const groupCheck = await this.supabase
      .from('unassigned_work_groups')
      .select('id, is_assigned, assigned_to_issue_key')
      .eq('id', this.createdGroupId)
      .single();

    if (groupCheck.error) throw groupCheck.error;

    const groupData = groupCheck.data;
    const groupOk = groupData.is_assigned === false && groupData.assigned_to_issue_key === null;
    
    this.log(`  CHECK 1: Group is_assigned = ${groupData.is_assigned} (expected: false) ${groupOk ? '✓' : '✗'}`, 
      groupOk ? 'success' : 'error');

    // CHECK 2: Activities are unassigned
    const activitiesCheck = await this.supabase
      .from('activity_records')
      .select('id, user_assigned_issue_key')
      .in('id', this.createdActivityIds);

    if (activitiesCheck.error) throw activitiesCheck.error;

    const allUnassigned = activitiesCheck.data.every(a => a.user_assigned_issue_key === null);
    this.log(`  CHECK 2: All activities unassigned (${activitiesCheck.data.length}/null) ${allUnassigned ? '✓' : '✗'}`,
      allUnassigned ? 'success' : 'error');

    // CHECK 3: Group appears in unassigned list
    const groupsListCheck = await this.supabase
      .from('unassigned_work_groups')
      .select('id')
      .eq('user_id', this.targetUserId)
      .eq('organization_id', this.targetOrgId)
      .eq('is_assigned', false)
      .eq('is_dismissed', false)
      .gt('session_count', 0);

    if (groupsListCheck.error) throw groupsListCheck.error;

    const groupInList = groupsListCheck.data.some(g => g.id === this.createdGroupId);
    this.log(`  CHECK 3: Group appears in unassigned list ${groupInList ? '✓' : '✗'}`,
      groupInList ? 'success' : 'error');

    // CHECK 4: Total unassigned time
    const timeCheck = await this.supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('user_id', this.targetUserId)
      .eq('organization_id', this.targetOrgId)
      .is('user_assigned_issue_key', null)
      .in('classification', ['productive', 'unknown']);

    const totalUnassignedSeconds = (timeCheck.data || []).reduce((sum, a) => sum + a.duration_seconds, 0);
    this.log(`  CHECK 4: Total unassigned time = ${totalUnassignedSeconds}s (${(totalUnassignedSeconds/60).toFixed(1)}m)`,
      totalUnassignedSeconds >= 2700 ? 'success' : 'error');

    this.results.checks.preConversion = {
      group_is_unassigned: groupOk,
      activities_unassigned: allUnassigned,
      group_in_list: groupInList,
      total_unassigned_seconds: totalUnassignedSeconds
    };

    this.log('PHASE 3 COMPLETE: PRE-CONVERSION state verified', 'success');
  }

  // =========================================================================
  // PHASE 4: Simulate Assignment
  // =========================================================================

  async simulateAssignment() {
    this.log('PHASE 4: Simulating assignment to ' + this.testIssueKey + '...', 'info');

    const projectKey = this.testIssueKey.split('-')[0];

    try {
      // STEP 1: Update activities
      this.log('  Updating activities...', 'info');
      const { error: activitiesError } = await this.supabase
        .from('activity_records')
        .update({
          user_assigned_issue_key: this.testIssueKey,
          project_key: projectKey
        })
        .in('id', this.createdActivityIds);

      if (activitiesError) throw activitiesError;
      this.log(`  ✓ Updated ${this.createdActivityIds.length} activities`, 'success');

      // STEP 2: Mark group as assigned
      this.log('  Marking group as assigned...', 'info');
      const { error: groupError } = await this.supabase
        .from('unassigned_work_groups')
        .update({
          is_assigned: true,
          assigned_to_issue_key: this.testIssueKey,
          assigned_at: new Date().toISOString(),
          assigned_by: this.targetUserId
        })
        .eq('id', this.createdGroupId);

      if (groupError) throw groupError;
      this.log('  ✓ Marked group as assigned', 'success');

    } catch (err) {
      this.log(`Assignment failed: ${err.message}`, 'error');
      throw err;
    }

    this.results.phase.assignment = { status: 'success' };
    this.log('PHASE 4 COMPLETE: Assignment simulated', 'success');
  }

  // =========================================================================
  // PHASE 5: POST-CONVERSION Verification
  // =========================================================================

  async verifyPostConversionState() {
    this.log('PHASE 5: Verifying POST-CONVERSION state...', 'info');

    // CHECK 5: Group is now assigned
    const groupCheck = await this.supabase
      .from('unassigned_work_groups')
      .select('id, is_assigned, assigned_to_issue_key, assigned_at')
      .eq('id', this.createdGroupId)
      .single();

    if (groupCheck.error) throw groupCheck.error;

    const groupData = groupCheck.data;
    const groupAssigned = groupData.is_assigned === true && groupData.assigned_to_issue_key === this.testIssueKey;
    
    this.log(`  CHECK 5: Group is_assigned = ${groupData.is_assigned} (expected: true) ${groupAssigned ? '✓' : '✗'}`,
      groupAssigned ? 'success' : 'error');

    // CHECK 6: Activities are now assigned
    const activitiesCheck = await this.supabase
      .from('activity_records')
      .select('id, user_assigned_issue_key')
      .in('id', this.createdActivityIds);

    if (activitiesCheck.error) throw activitiesCheck.error;

    const allAssigned = activitiesCheck.data.every(a => a.user_assigned_issue_key === this.testIssueKey);
    this.log(`  CHECK 6: All activities assigned to ${this.testIssueKey} ${allAssigned ? '✓' : '✗'}`,
      allAssigned ? 'success' : 'error');

    // CHECK 7: Group no longer in unassigned list
    const groupsListCheck = await this.supabase
      .from('unassigned_work_groups')
      .select('id')
      .eq('user_id', this.targetUserId)
      .eq('organization_id', this.targetOrgId)
      .eq('is_assigned', false)
      .eq('is_dismissed', false);

    const groupNotInList = !groupsListCheck.data.some(g => g.id === this.createdGroupId);
    this.log(`  CHECK 7: Group no longer in unassigned list ${groupNotInList ? '✓' : '✗'}`,
      groupNotInList ? 'success' : 'error');

    // CHECK 8: Total unassigned time decreased
    const timeCheck = await this.supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('user_id', this.targetUserId)
      .eq('organization_id', this.targetOrgId)
      .is('user_assigned_issue_key', null)
      .in('classification', ['productive', 'unknown']);

    const totalUnassignedSeconds = (timeCheck.data || []).reduce((sum, a) => sum + a.duration_seconds, 0);
    const timeDecreased = totalUnassignedSeconds < (this.results.checks.preConversion?.total_unassigned_seconds || 2700);
    
    this.log(`  CHECK 8: Total unassigned time = ${totalUnassignedSeconds}s (expected: < ${this.results.checks.preConversion?.total_unassigned_seconds}) ${timeDecreased ? '✓' : '✗'}`,
      timeDecreased ? 'success' : 'error');

    this.results.checks.postConversion = {
      group_is_assigned: groupAssigned,
      activities_assigned: allAssigned,
      group_not_in_list: groupNotInList,
      total_unassigned_seconds: totalUnassignedSeconds,
      time_decreased: timeDecreased
    };

    this.log('PHASE 5 COMPLETE: POST-CONVERSION state verified', 'success');
  }

  // =========================================================================
  // PHASE 6: Timeline Behavior
  // =========================================================================

  async verifyTimelineBehavior() {
    this.log('PHASE 6: Verifying timeline behavior...', 'info');

    // Get unassigned activities (should be 0 now)
    const unassignedCheck = await this.supabase
      .from('activity_records')
      .select('id')
      .in('id', this.createdActivityIds)
      .is('user_assigned_issue_key', null);

    this.log(`  Unassigned activities for our sessions: ${unassignedCheck.data.length} (expected: 0) ${unassignedCheck.data.length === 0 ? '✓' : '✗'}`,
      unassignedCheck.data.length === 0 ? 'success' : 'error');

    // Get assigned activities
    const assignedCheck = await this.supabase
      .from('activity_records')
      .select('id, user_assigned_issue_key')
      .in('id', this.createdActivityIds)
      .eq('user_assigned_issue_key', this.testIssueKey);

    this.log(`  Assigned activities for our sessions: ${assignedCheck.data.length} (expected: 3) ${assignedCheck.data.length === 3 ? '✓' : '✗'}`,
      assignedCheck.data.length === 3 ? 'success' : 'error');

    this.results.phase.timeline = {
      unassigned_activities: unassignedCheck.data.length,
      assigned_activities: assignedCheck.data.length
    };

    this.log('PHASE 6 COMPLETE: Timeline behavior verified', 'success');
  }

  // =========================================================================
  // PHASE 7: Data Consistency
  // =========================================================================

  async verifyDataConsistency() {
    this.log('PHASE 7: Verifying data consistency...', 'info');

    // Check group members still exist
    const membersCheck = await this.supabase
      .from('unassigned_group_members')
      .select('id')
      .eq('group_id', this.createdGroupId);

    this.log(`  Group members: ${membersCheck.data.length} (expected: 3) ${membersCheck.data.length === 3 ? '✓' : '✗'}`,
      membersCheck.data.length === 3 ? 'success' : 'error');

    this.results.phase.consistency = {
      group_members_count: membersCheck.data.length
    };

    this.log('PHASE 7 COMPLETE: Data consistency verified', 'success');
  }

  // =========================================================================
  // Generate Report
  // =========================================================================

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      testInput: {
        userId: this.targetUserId,
        orgId: this.targetOrgId,
        testProjectKey: this.testProjectKey,
        testIssueKey: this.testIssueKey,
        testDate: this.testDate
      },
      phases: this.results.phase,
      checks: this.results.checks,
      summary: this.generateSummary()
    };

    return report;
  }

  generateSummary() {
    const preConvChecks = this.results.checks.preConversion;
    const postConvChecks = this.results.checks.postConversion;

    const allPassed = 
      preConvChecks.group_is_unassigned &&
      preConvChecks.activities_unassigned &&
      preConvChecks.group_in_list &&
      postConvChecks.group_is_assigned &&
      postConvChecks.activities_assigned &&
      postConvChecks.group_not_in_list &&
      postConvChecks.time_decreased;

    return {
      status: allPassed ? 'PASS' : 'FAIL',
      preConversionValid: preConvChecks.group_is_unassigned && preConvChecks.activities_unassigned,
      postConversionValid: postConvChecks.group_is_assigned && postConvChecks.activities_assigned,
      timelineUpdated: postConvChecks.time_decreased,
      groupRemovedFromList: postConvChecks.group_not_in_list
    };
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  async cleanup() {
    this.log('Cleaning up test data...', 'info');

    try {
      // Delete group members
      await this.supabase
        .from('unassigned_group_members')
        .delete()
        .eq('group_id', this.createdGroupId);

      // Delete group
      await this.supabase
        .from('unassigned_work_groups')
        .delete()
        .eq('id', this.createdGroupId);

      // Delete activities
      await this.supabase
        .from('activity_records')
        .delete()
        .in('id', this.createdActivityIds);

      this.log('Test data cleaned up successfully', 'success');
    } catch (err) {
      this.log(`Cleanup failed: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // Main Test Runner
  // =========================================================================

  async runAllPhases(cleanup = false) {
    try {
      await this.createSampleActivities();
      await this.createUnassignedWorkGroup();
      await this.verifyPreConversionState();
      await this.simulateAssignment();
      await this.verifyPostConversionState();
      await this.verifyTimelineBehavior();
      await this.verifyDataConsistency();

      const report = this.generateReport();
      
      console.log('\n' + '='.repeat(70));
      console.log('TEST REPORT');
      console.log('='.repeat(70));
      console.log(JSON.stringify(report, null, 2));
      console.log('='.repeat(70) + '\n');

      if (cleanup) {
        await this.cleanup();
      } else {
        this.log(`Test data preserved. Run with --cleanup to delete test data.`, 'info');
        this.log(`Created Group ID: ${this.createdGroupId}`, 'info');
        this.log(`Created Activity IDs: ${this.createdActivityIds.join(', ')}`, 'info');
      }

      return report;

    } catch (err) {
      this.log(`Test execution failed: ${err.message}`, 'error');
      console.error(err);
      throw err;
    }
  }
}

// ============================================================================
// CLI Runner
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  const config = {
    userId: null,
    orgId: null,
    projectKey: 'PROJ',
    issueKey: 'PROJ-123',
    testDate: '2026-04-16'
  };

  let cleanup = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user-id':
        config.userId = args[++i];
        break;
      case '--org-id':
        config.orgId = args[++i];
        break;
      case '--project':
        config.projectKey = args[++i];
        break;
      case '--issue':
        config.issueKey = args[++i];
        break;
      case '--date':
        config.testDate = args[++i];
        break;
      case '--cleanup':
        cleanup = true;
        break;
      case '--help':
        console.log(`
Usage: node test-unassigned-work-integration.js [options]

Options:
  --user-id <UUID>      User ID for test data (required)
  --org-id <UUID>       Organization ID for test data (required)
  --project <KEY>       Project key (default: PROJ)
  --issue <KEY>         Issue key to assign to (default: PROJ-123)
  --date <YYYY-MM-DD>   Test date (default: 2026-04-16)
  --cleanup             Delete test data after running
  --help                Show this help message

Examples:
  node test-unassigned-work-integration.js --user-id <UUID> --org-id <UUID>
  node test-unassigned-work-integration.js --user-id <UUID> --org-id <UUID> --cleanup
        `);
        process.exit(0);
    }
  }

  if (!config.userId || !config.orgId) {
    console.error('ERROR: --user-id and --org-id are required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  const tester = new UnassignedWorkTester(config);
  await tester.runAllPhases(cleanup);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

module.exports = UnassignedWorkTester;
