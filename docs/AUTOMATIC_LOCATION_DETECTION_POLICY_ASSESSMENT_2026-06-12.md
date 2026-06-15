# Automatic Employee Location Detection — Atlassian Policy & Compliance Assessment

**Date:** 2026-06-12
**Status:** Research / decision-support (no implementation)
**Relates to:** WS-B Employee Location feature (`plan/2026-06-10_web-productivity-portal_ux-improvements.md`, migration `supabase/migrations/20260610_portal_employee_profiles.sql`)
**Question:** The portal currently supports *manual* location assignment (superadmin assigns a `portal_locations` entry to each employee via `portal_employee_profiles`). Can we instead detect each user's location **automatically** — which would involve the desktop app and/or ai-server — and is that permitted by Atlassian's policies for Marketplace apps?

---

## 1. Bottom line

**Atlassian does not prohibit automatic location detection — but it is *conditionally* allowed, not freely allowed.**

No Atlassian policy bans location data as a category. However, automatic detection is only compliant if all of the following hold:

1. **User consent** is collected directly from the employee (a privacy-policy line is not sufficient).
2. **Disclosure** is updated in both the End User Privacy Policy and the Marketplace **Privacy & Security tab** before shipping.
3. **Applicable employment-privacy laws** are complied with — Atlassian contractually delegates this to the Marketplace partner.

Silent/background geolocation without informing the employee would breach the Marketplace Partner Agreement even though the word "location" never appears in it.

---

## 2. What the Atlassian policies actually say

### 2.1 Location is NOT a restricted data category

The [Atlassian Developer Terms](https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/) restrict only three categories of data:

> "any (a) special categories of data enumerated in European Union Regulation 2016/679, Article 9(1) … patient, medical or other protected health information regulated by … HIPAA … [or] credit, debit or other payment card data subject to the Payment Card Industry Data Security Standards."

GDPR Article 9 special categories are race/ethnicity, political opinions, religion, trade-union membership, genetics, biometrics, health, and sex life/orientation. **Location is not among them.**

Supporting signals that location-class data is contemplated, not banned:

- The [Privacy & Security tab](https://developer.atlassian.com/platform/marketplace/security-privacy-tab/) questionnaire explicitly anticipates apps storing "**device ID, IP address**" outside Atlassian products.
- A location-data app ([GeoData for Jira](https://marketplace.atlassian.com/apps/1223972/geodata-for-jira)) is live on the Marketplace.
- The [security requirements FAQ](https://developer.atlassian.com/platform/marketplace/security-requirements-faq/) refers to protecting "user data shared with you and collected by your app, **including user device information**."

### 2.2 The processing test is strict — consent is the only available leg

[Marketplace Partner Agreement §8.4](https://www.atlassian.com/licensing/marketplace/partneragreement) (mirrored in the Developer Terms):

> "you must limit your access and processing of such information to that **(a) authorized by the end user or (b) necessary for the purposes of providing the functionality of your Marketplace App**."

Auto-detected location is hard to defend as "necessary for functionality": the feature demonstrably works with manual assignment (WS-B shipped that way). That leaves **(a) authorized by the end user** — i.e., consent.

The [Data privacy guidelines for developers](https://developer.atlassian.com/platform/marketplace/data-privacy-guidelines/) define what valid consent means:

> "a privacy policy gives notice and explains to the user how their data will be used, whereas **consent gets permission for a specific use**" — consent "may not be embedded in a privacy policy. Instead, it must be collected from the user directly."

> "**you should always get consent if the user would not expect their data to be used or shared in a particular way.**"

An employee would not naturally expect a time-tracking app to also geolocate them, so this rule is squarely triggered.

Also relevant (data minimization):

> "Collect data only where you need it … do not collect it because you think it may be useful later."

### 2.3 The desktop app does NOT escape Atlassian's scope

The desktop app is not distributed through the Marketplace, but the Partner Agreement defines End User Data as:

> "any data, content or information of an end user that is accessed, collected or otherwise processed **by you or your Marketplace App** in connection with use of the Atlassian Marketplace." (§2.4)

The desktop app feeds the Forge app's analytics and is part of the listed offering — location collected there counts. The Privacy & Security tab questions specifically cover data stored/processed "**outside of Atlassian products and services**" (i.e., our Supabase/ai-server stack), and:

> "Your answers will go live on the Privacy & Security tab of your app listing page immediately after you submit the information."

**Consequence:** adding location collection requires updating the public listing disclosures and the privacy policy *before* shipping.

### 2.4 Consent obligation (verbatim)

Partner Agreement §8.4(b) / Developer Terms:

> "You must obtain **all necessary rights, permissions, and consents from end users** for your access, collection, storage, transmission, treatment, use, disclosure, sharing, and other processing of any End User Data."

> "**You may not sell any End User Data.**"

### 2.5 GDPR plumbing — Personal Data Reporting & erasure

Per the [User privacy guide for app developers](https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/) and the [Forge user privacy guidelines](https://developer.atlassian.com/platform/forge/user-privacy-guidelines/):

- Apps storing personal data keyed to Atlassian accounts must report stored `accountId`s via the **Personal Data Reporting API** (default cycle: every 7 days) and honor **erasure** ("right to be forgotten") and **rectification**.
- Atlassian's stated preference: "we recommend that your apps do not store any user personal data" — retrieve at time of use instead.

Our forge-app already implements personal-data callbacks (see CLAUDE.md / `forge-app/src/index.js` lifecycle handlers), but a stored location attribute would need to be wired into the erasure path. Note the WS-B tables intentionally have **no FK cascade** from `users` (`user_id` is a soft reference), so erasure of `portal_employee_profiles` rows must be handled in application code.

### 2.6 Acceptable Use Policy

The [Atlassian Acceptable Use Policy](https://www.atlassian.com/legal/acceptable-use-policy) prohibits:

> "Using our services to **stalk, track, or monitor others** or harass, bully, intimidate…"

> "…collecting or gathering other people's personal information (including account names or information) from our services"

These clauses target user-to-user abuse rather than employer-sanctioned workforce analytics — but they are the clauses Atlassian could lean on if location tracking were **covert**. Transparent, consented detection is the line between the two.

---

## 3. The law layer (Atlassian delegates this to the partner)

Partner Agreement §8.4(f) requires compliance with "all applicable Laws," so legality is not only an Atlassian question. Relevant for Amzur (US + India workforce):

| Jurisdiction | Position |
|---|---|
| **India (DPDP Act 2023 + Rules, Nov 2025)** | Employment processing has a "legitimate use" ground (Section 7(i)) — consent-chasing not required for standard HR activities, **but** the employer must inform the employee, justify purpose, secure the data, and delete when done. Day-to-day obligations phase in over 18 months; full compliance ~mid-May 2027. ([Fisher Phillips](https://www.fisherphillips.com/en/insights/insights/indias-new-data-privacy-rules-are-here)) |
| **United States** | Most states: notice is sufficient; continued employment after notice = implied consent. Several states (e.g., CT, DE, NY) have explicit electronic-monitoring notice statutes; the 2025–26 legislative trend is toward **more** notification/consent requirements. ([DataGuidance](https://www.dataguidance.com/topics/employee-monitoring), [eMonitor state guide](https://www.employee-monitoring.net/compliance/employee-monitoring-laws-us-states)) |
| **EU/GDPR (if any EU staff)** | Legitimate-interest basis requires proportionality; a **DPIA** is expected for high-risk monitoring; covert monitoring only in exceptional circumstances. Consent is a weak basis in employment due to power imbalance. ([DataGuidance](https://www.dataguidance.com/topics/employee-monitoring)) |
| **CCPA/CPRA + several US states** | **Precise geolocation** (GPS-grade, e.g., Windows Location API) is classified as *sensitive personal information*. Coarse city-level location is not. |

---

## 4. Technical options compared

| Method | Granularity | Desktop change? | Sensitivity / risk | Notes |
|---|---|---|---|---|
| **Server-side IP geolocation** (ai-server derives city/country from request IP) | City/country | No | Low — coarse; IP is personal data but not "precise geolocation" | Office NAT/VPN will mislocate users → treat as suggestion only |
| **Timezone/locale from desktop** | Region-level | Trivial | Lowest | Very coarse; many locations share a timezone (e.g., all of India) |
| **Windows Location API (GPS/Wi-Fi)** | Precise | Yes | **High** — "precise geolocation" = sensitive under CPRA et al.; OS consent prompts; worst optics | **Avoid** |

---

## 5. Recommendation

If auto-detection is pursued, the compliant low-risk design is:

1. **Coarse signal only** — derive city/country from the desktop app's request IP server-side at ai-server (no desktop code change), or from machine timezone. Never the OS location APIs.
2. **Suggest, don't auto-assign** — surface the detected location on the Employees page as a pre-filled *suggestion* the superadmin confirms; `portal_employee_profiles` remains the source of truth. This keeps the manual feature intact and keeps processing closer to "necessary for functionality."
3. **Notice + consent in the desktop app** — a one-time disclosure at login (e.g., "this app derives your approximate work location for reporting"), with the acknowledgement recorded.
4. **Before shipping:**
   - Update the End User Privacy Policy.
   - Update the Marketplace **Privacy & Security tab** data-type disclosures (data stored outside Atlassian now includes IP-derived location).
   - Wire stored location into the existing personal-data erasure path (forge-app personal-data callbacks → ai-server → `portal_employee_profiles`).

**Verdict: possible, and permitted by Atlassian — but only as a transparent, consented, disclosed feature; never as silent background detection.**

---

## 6. Sources

### Atlassian policy (primary)
- [Atlassian Developer Terms](https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/)
- [Marketplace Partner Agreement](https://www.atlassian.com/licensing/marketplace/partneragreement)
- [Data privacy guidelines for developers](https://developer.atlassian.com/platform/marketplace/data-privacy-guidelines/)
- [Privacy and security tab in the Marketplace listing](https://developer.atlassian.com/platform/marketplace/security-privacy-tab/)
- [Acceptable Use Policy](https://www.atlassian.com/legal/acceptable-use-policy)
- [User privacy guide for app developers](https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/)
- [User privacy guide for Forge app developers](https://developer.atlassian.com/platform/forge/user-privacy-guidelines/)
- [FAQ: Security requirements for cloud apps](https://developer.atlassian.com/platform/marketplace/security-requirements-faq/)
- [Marketplace Security Enforcement Policy](https://developer.atlassian.com/platform/marketplace/marketplace-security-enforcement-policy/)
- [Marketplace App Trust](https://www.atlassian.com/trust/marketplace)

### Marketplace precedent
- [GeoData for Jira — Atlassian Marketplace](https://marketplace.atlassian.com/apps/1223972/geodata-for-jira)

### Employment-privacy law (secondary)
- [Fisher Phillips — India's New Data Privacy Rules (DPDP)](https://www.fisherphillips.com/en/insights/insights/indias-new-data-privacy-rules-are-here)
- [DataGuidance — Employee Monitoring topic hub](https://www.dataguidance.com/topics/employee-monitoring)
- [eMonitor — US state-by-state monitoring notice rules](https://www.employee-monitoring.net/compliance/employee-monitoring-laws-us-states)
- [eMonitor — Employee monitoring laws by country](https://www.employee-monitoring.net/resources/employee-monitoring-laws-by-country)
- [Worklytics — Remote employee monitoring compliance](https://www.worklytics.co/blog/key-compliance-laws-for-remote-employee-monitoring-data-protection)
