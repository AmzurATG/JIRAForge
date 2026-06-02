# ============================================================================
# Gherkin acceptance tests for: Web Productivity Portal — LOB Segmentation & RBAC
# Source design doc: plan/2026-06-01_web-productivity-portal_lob-segmentation-rbac.md
# Status: starter set — derived from the DRAFT plan (feature not yet built).
#
# HOW TO READ THIS FILE
#   Feature  = the area being tested
#   Rule     = one business rule the area must obey
#   Scenario = one concrete example of that rule (a checklist item you can click through)
#   Given    = the starting situation
#   When     = the action someone takes
#   Then     = the result you should see  (And / But just add more lines)
#
# Tags (the @words) let you filter, e.g. run only @security or only @ui scenarios.
# "Scenario Outline" + "Examples" = the same scenario run once per table row.
# ============================================================================

@portal @lob @rbac
Feature: Line-of-Business segmentation and role-based access in the portal
  So that managers only see the employees they are responsible for,
  the portal scopes all analytics and management by Line of Business (LOB)
  and by the caller's role (superadmin vs LOB head vs unscoped user).

  Background:
    Given the portal feature flag "PORTAL_LOB_ENFORCEMENT" is "on"
    And the following LOBs exist:
      | lob            | head        |
      | Cloud Practice | head.cloud  |
      | Data Practice  | head.data   |
    And employee "emp.alice" is a member of "Cloud Practice"
    And employee "emp.bob"   is a member of "Cloud Practice"
    And employee "emp.carol" is a member of "Data Practice"

  # --------------------------------------------------------------------------
  Rule: Only a superadmin can create, edit, or delete an LOB

    @superadmin @api
    Scenario: Superadmin creates a new LOB
      Given "super.admin" is logged in as a superadmin
      When they create an LOB named "Security Practice"
      Then the LOB "Security Practice" is created
      And it appears in the LOB list

    @superadmin @validation
    Scenario: LOB names must be unique within the organization
      Given "super.admin" is logged in as a superadmin
      When they create an LOB named "Cloud Practice"
      Then the request is rejected as a duplicate
      And no second "Cloud Practice" LOB is created

    @superadmin
    Scenario: Deleting an LOB removes its memberships but not the employees
      Given "super.admin" is logged in as a superadmin
      When they delete the LOB "Data Practice"
      Then "Data Practice" is removed from the LOB list
      And its member, head, and app-classification rows are removed
      But employee "emp.carol" still exists in the employee directory
      And no row in "activity_records" is changed

    @lob-head @security
    Scenario: An LOB head cannot create an LOB
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they attempt to create an LOB named "Sneaky Practice"
      Then the request is rejected with "403 insufficient permissions"
      And no LOB is created

  # --------------------------------------------------------------------------
  Rule: Membership and head assignment are many-to-many and superadmin-managed

    @superadmin
    Scenario: An employee can belong to more than one LOB
      Given "super.admin" is logged in as a superadmin
      When they add employee "emp.alice" to "Data Practice"
      Then "emp.alice" is a member of both "Cloud Practice" and "Data Practice"

    @superadmin
    Scenario: A person can be head of more than one LOB
      Given "super.admin" is logged in as a superadmin
      When they assign "head.cloud" as a head of "Data Practice"
      Then "head.cloud" heads both "Cloud Practice" and "Data Practice"

    @superadmin @validation
    Scenario: Adding the same member twice is rejected, not duplicated
      Given "super.admin" is logged in as a superadmin
      And "emp.alice" is already a member of "Cloud Practice"
      When they add "emp.alice" to "Cloud Practice" again
      Then the request is rejected as a duplicate
      And "Cloud Practice" still lists "emp.alice" only once

    @lob-head @security
    Scenario: An LOB head cannot add or remove members
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they attempt to add "emp.carol" to "Cloud Practice"
      Then the request is rejected with "403 insufficient permissions"

  # --------------------------------------------------------------------------
  Rule: Analytics are scoped to the employees the caller is allowed to see

    @superadmin @analytics
    Scenario: A superadmin sees every employee's data
      Given "super.admin" is logged in as a superadmin
      When they open the Dashboard
      Then the data includes "emp.alice", "emp.bob", and "emp.carol"

    @lob-head @analytics
    Scenario: An LOB head sees only their LOB's employees
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they open the Dashboard
      Then the data includes "emp.alice" and "emp.bob"
      But the data does not include "emp.carol"

    @lob-head @analytics
    Scenario: Time Logs, Employees, and Reports are all scoped the same way
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they open each of "Employees", "Time Logs", and "Reports"
      Then every page shows only "Cloud Practice" employees

    @lob-head @edge
    Scenario: An employee in two of the head's LOBs is counted only once
      Given "head.cloud" is logged in and heads "Cloud Practice" and "Data Practice"
      And "emp.alice" is a member of both "Cloud Practice" and "Data Practice"
      When they open the Dashboard
      Then "emp.alice" appears exactly once in the employee count

    @lob-head @scope-freshness @security
    Scenario: Removing a head revokes their access on the very next request
      Given "head.cloud" is logged in and heads "Cloud Practice"
      And a superadmin removes "head.cloud" as head of "Cloud Practice"
      When "head.cloud" reloads the Dashboard with their existing session
      Then they see no employees
      And they see an empty-state message, not an error

  # --------------------------------------------------------------------------
  Rule: A caller may never read data outside their scope (security)

    @security @api
    Scenario: A head requesting an out-of-scope employee is refused
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they open the detail page for "emp.carol"
      Then the request is rejected with "403 insufficient permissions"
      And no activity for "emp.carol" is read from the database

    @security @api
    Scenario Outline: Out-of-scope LOB filters are refused, not silently ignored
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they request analytics filtered to LOB "<lob>"
      Then the response is "<result>"

      Examples:
        | lob            | result                          |
        | Cloud Practice | the Cloud Practice data         |
        | Data Practice  | 403 insufficient permissions    |

    @security
    Scenario: A portal user with no head assignment sees nothing
      Given "viewer.dan" is logged in with no LOB head assignments
      When they open the Dashboard
      Then they see an explanatory empty state
      And they see no management menus

  # --------------------------------------------------------------------------
  Rule: Each LOB has its own app-classification list (portal-only)

    @app-classification @superadmin
    Scenario: Superadmin adds an app rule to one LOB
      Given "super.admin" is logged in as a superadmin
      When they classify "slack.exe" as "productive" for "Cloud Practice"
      Then "slack.exe" appears in the "Cloud Practice" app list as "productive"
      But the Jira "application_classifications" table is not changed

    @app-classification @lob-head
    Scenario: An LOB head manages the app list only for the LOB they head
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they classify "figma.exe" as "productive" for "Cloud Practice"
      Then the rule is saved for "Cloud Practice"

    @app-classification @lob-head @security
    Scenario: An LOB head cannot edit another LOB's app list
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they attempt to classify "figma.exe" for "Data Practice"
      Then the request is rejected with "403 insufficient permissions"

    @app-classification @validation
    Scenario Outline: App rules accept only the allowed classification values
      Given "super.admin" is logged in as a superadmin
      When they add an app rule with classification "<value>" to "Cloud Practice"
      Then the request is "<result>"

      Examples:
        | value          | result   |
        | productive     | accepted |
        | non_productive | accepted |
        | private        | accepted |
        | banana         | rejected |

    @app-classification @validation
    Scenario: The same app cannot be added twice to one LOB
      Given "super.admin" is logged in as a superadmin
      And "slack.exe" is already classified for "Cloud Practice"
      When they add "slack.exe" to "Cloud Practice" again
      Then the request is rejected as a duplicate

    @app-classification @bulk
    Scenario: Bulk import reports per-row success and failure
      Given "super.admin" is logged in as a superadmin
      When they bulk-import 3 app rules to "Cloud Practice" where 1 row is invalid
      Then 2 rows are imported
      And the response reports the 1 failed row with a reason

  # --------------------------------------------------------------------------
  Rule: The UI gates navigation and actions by the caller's effective role

    @ui @superadmin
    Scenario: Superadmin sees the "Line of Businesses" menu item
      Given "super.admin" is logged in as a superadmin
      When the portal loads
      Then the sidebar shows the "Line of Businesses" item

    @ui @lob-head @security
    Scenario: An LOB head does not see the LOB-management menu
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When the portal loads
      Then the sidebar does not show the "Line of Businesses" item
      And visiting "/lobs" directly shows an "Access Denied" page

    @ui @lob-head
    Scenario: The LOB filter lists only the head's own LOBs
      Given "head.cloud" is logged in and heads "Cloud Practice"
      When they open the LOB filter on the Dashboard
      Then the filter offers "Cloud Practice" and "All my LOBs"
      But the filter does not offer "Data Practice"

    @ui @lob-head
    Scenario: "All my LOBs" is the default and unions the head's LOBs
      Given "head.cloud" is logged in and heads "Cloud Practice" and "Data Practice"
      When they open the Dashboard
      Then the LOB filter defaults to "All my LOBs"
      And the data covers employees from both LOBs

  # --------------------------------------------------------------------------
  Rule: The feature flag controls whether scoping is enforced (safe rollout)

    @rollout @flag
    Scenario: With enforcement off, the portal behaves exactly as before
      Given the feature flag "PORTAL_LOB_ENFORCEMENT" is "off"
      And "viewer.dan" is logged in with no LOB head assignments
      When they open the Dashboard
      Then they see every employee's data, as in the pre-LOB behavior

    @rollout @flag
    Scenario: With enforcement on, the same non-head user is scoped to nothing
      Given the feature flag "PORTAL_LOB_ENFORCEMENT" is "on"
      And "viewer.dan" is logged in with no LOB head assignments
      When they open the Dashboard
      Then they see no employee data

  # --------------------------------------------------------------------------
  Rule: Orphaned data from the Jira side is tolerated, never fatal

    @edge
    Scenario: A membership pointing at a deleted employee does not crash the page
      Given "emp.bob" is a member of "Cloud Practice"
      And "emp.bob" has been deleted on the Jira side
      And "head.cloud" is logged in and heads "Cloud Practice"
      When they open the Employees page
      Then "emp.alice" is shown normally
      And the orphaned "emp.bob" row is skipped or labelled "Unknown"
      And the page does not error
