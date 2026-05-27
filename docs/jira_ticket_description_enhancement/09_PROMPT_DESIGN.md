# Prompt Design

## Strategy

A structured prompt enforces consistent evaluation and output formatting. Each issue type uses a specialized persona to ensure domain-appropriate feedback.

---

## Persona Mapping

| Issue Type | Persona | Focus Areas |
|-----------|---------|-------------|
| Bug | Senior QA Analyst | Reproducibility, steps, expected/actual, environment |
| Story | Product Owner | Acceptance criteria, user value, scope clarity |
| Task | Project Manager | Actionability, clear deliverables, dependencies |
| Epic | Business Analyst | Business context, success metrics, scope boundaries |

---

## Base Prompt Template

```
You are a {persona}.

Evaluate the following Jira {issueType} ticket and provide improvement suggestions.

Title: {title}
Description: {description}

Score the description (0–100) based on:
- Clarity: Is the intent unambiguous?
- Completeness: Are all necessary details present?
- Reproducibility: Can someone act on this without asking questions? (for Bugs)
- Actionability: Are next steps clear?

{type_specific_criteria}

Return a JSON object with exactly this structure:
{
  "score": <number 0-100>,
  "issues": [<array of strings identifying specific problems>],
  "suggestions": [<array of strings with actionable improvements>],
  "improved_title": "<concise, specific improved title>",
  "improved_description": "<fully structured improved description>"
}

RULES:
- Score must be an integer between 0 and 100
- issues array must have 1-5 items
- suggestions array must have 1-5 items
- improved_description must use markdown formatting with clear sections
- Do NOT invent facts not present in the original — only restructure and clarify
- Do NOT include placeholder text like [fill in] — leave sections empty if info is missing
- Keep improved_title under 80 characters
```

---

## Type-Specific Criteria

### Bug

```
Additional criteria for Bug tickets:
- Steps to Reproduce: Are numbered steps provided?
- Expected vs Actual: Are both clearly stated?
- Environment: Is OS/browser/device/version specified?
- Severity indicators: Is impact on users described?

The improved_description MUST include these sections:
## Summary
## Steps to Reproduce
## Expected Result
## Actual Result
## Environment
## Additional Context (if applicable)
```

### Story

```
Additional criteria for Story tickets:
- User value: Is the "who" and "why" clear?
- Acceptance criteria: Are testable conditions listed?
- Scope: Is what's included/excluded clear?
- Dependencies: Are blockers or prerequisites mentioned?

The improved_description MUST include these sections:
## User Story
As a [role], I want [goal], so that [benefit]
## Acceptance Criteria
- Given/When/Then format preferred
## Scope
### In Scope
### Out of Scope
## Dependencies (if applicable)
```

### Task

```
Additional criteria for Task tickets:
- Definition of Done: Is completion clearly measurable?
- Deliverables: What artifacts are expected?
- Dependencies: Are prerequisites listed?
- Timeline indicators: Is urgency or deadline mentioned?

The improved_description MUST include these sections:
## Objective
## Deliverables
## Steps / Approach
## Definition of Done
## Dependencies (if applicable)
```

### Epic

```
Additional criteria for Epic tickets:
- Business context: Is the strategic goal clear?
- Success metrics: How will success be measured?
- Scope boundaries: What's in and out?
- Child ticket breakdown: Is decomposition suggested?

The improved_description MUST include these sections:
## Business Context
## Objective
## Success Metrics
## Scope
### In Scope
### Out of Scope
## Key Features / Child Tickets
## Risks & Dependencies (if applicable)
```

---

## LLM Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `temperature` | 0.3 | Low creativity, high consistency for structured output |
| `max_tokens` | 2000 | Sufficient for full description rewrite |
| `response_format` | `{ type: "json_object" }` | Forces valid JSON output |
| `timeout` | 8000ms | Acceptable UX wait; falls back to deterministic on timeout |
| `model` | Gemini (primary) | Supports temperature; GPT-5 does NOT support temperature |

---

## Response Schema Validation

The LLM response must match this schema:

```json
{
  "type": "object",
  "required": ["score", "issues", "suggestions", "improved_title", "improved_description"],
  "properties": {
    "score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "issues": { 
      "type": "array", 
      "items": { "type": "string" },
      "minItems": 1, 
      "maxItems": 5 
    },
    "suggestions": { 
      "type": "array", 
      "items": { "type": "string" },
      "minItems": 1, 
      "maxItems": 5 
    },
    "improved_title": { "type": "string", "maxLength": 80 },
    "improved_description": { "type": "string", "maxLength": 5000 }
  }
}
```

### Retry Logic

1. First attempt with standard prompt
2. If response fails schema validation → retry once with appended instruction:
   ```
   IMPORTANT: Your previous response was malformed. Return ONLY valid JSON matching the exact schema specified. No additional text outside the JSON object.
   ```
3. If second attempt also fails → return deterministic result only

---

## Cost Projections

| Scenario | Monthly Volume | LLM Calls | Estimated Cost |
|----------|---------------|-----------|----------------|
| 10 users, moderate use | ~200 analyses | ~40 LLM calls (20%) | ~$2/month |
| 50 users, active use | ~1000 analyses | ~200 LLM calls | ~$10/month |
| 200 users, heavy use | ~4000 analyses | ~800 LLM calls | ~$40/month |

Assumptions:
- ~80% of tickets score ≥ 80 and skip LLM
- Average input: ~500 tokens; average output: ~1000 tokens
- Gemini pricing: ~$0.05 per 1K tokens (blended)
