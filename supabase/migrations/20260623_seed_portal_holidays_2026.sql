-- ============================================================================
-- Seed: Portal company holidays — 2026
-- Date: 2026-06-23
-- Spec: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
--
-- Initial 2026 holiday list taken from the holiday calendar provided by the
-- business. Idempotent: ON CONFLICT (holiday_date) updates the name so re-runs
-- and corrections are safe. Admins can add/edit/remove holidays afterwards via
-- the portal Holidays page. Replace/extend this list with the official roster
-- if it differs.
-- ============================================================================

INSERT INTO public.portal_holidays (holiday_date, name) VALUES
    ('2026-01-01', 'New Year'),
    ('2026-01-15', 'Pongal/Makar Sankranti'),
    ('2026-01-26', 'Republic Day'),
    ('2026-03-03', 'Holi'),
    ('2026-03-19', 'Ugadi'),
    ('2026-03-20', 'Ramzan Id/Eid-ul-Fitar'),
    ('2026-09-14', 'Ganesh Chaturthi'),
    ('2026-10-02', 'Mahatma Gandhi Jayanti'),
    ('2026-10-20', 'Vijaya Dashami'),
    ('2026-12-25', 'Christmas')
ON CONFLICT (holiday_date) DO UPDATE
    SET name = EXCLUDED.name,
        is_active = TRUE,
        updated_at = NOW();
