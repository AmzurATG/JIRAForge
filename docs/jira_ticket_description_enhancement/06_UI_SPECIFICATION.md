# UI Specification

## Component Hierarchy

```
DescriptionQuality (container)
├── ScoreBadge
├── IssuesList
├── SuggestionsList
├── ImproveButton (V1)
├── ComparisonView (V2)
│   ├── OriginalPane
│   └── ImprovedPane
├── ActionButtons (V2)
│   ├── AcceptButton
│   ├── EditButton
│   └── RejectButton
└── EditMode (V2)
    ├── Textarea
    └── SaveButton
```

---

## States & Transitions

```
[Idle] ──── Click "Check Quality" ───→ [Loading]
                                            │
                                      Analysis complete
                                            │
                                            ▼
                                       [Score View]
                                            │
                            ┌───────────────┼───────────────┐
                            │               │               │
                     Score ≥ 80       Score < 80      User clicks
                     (No Improve)   (Show Improve)    "Improve"
                            │               │               │
                            ▼               ▼               ▼
                       [Done]         [Improve Available]  [Loading LLM]
                                            │               │
                                      Click "Improve"  LLM response
                                            │               │
                                            ▼               ▼
                                     [Loading LLM] → [Comparison View]
                                                        │
                                          ┌─────────────┼─────────────┐
                                          │             │             │
                                       Accept         Edit         Reject
                                          │             │             │
                                          ▼             ▼             ▼
                                    [Writing...]  [Edit Mode]    [Idle]
                                          │             │
                                          ▼             ▼
                                    [Success]     [Writing...]
                                                        │
                                                        ▼
                                                  [Success]
```

---

## Component Specifications

### ScoreBadge

**Purpose**: Displays the quality score with color coding.

| Score Range | Color | Label |
|-------------|-------|-------|
| 0–49 | Red (`#DE350B`) | Poor |
| 50–79 | Yellow (`#FF991F`) | Needs Improvement |
| 80–100 | Green (`#36B37E`) | Good |

**Layout**: Circular badge with score number centered, label text below.

**Props**:
```js
{
  score: number,       // 0–100
  loading: boolean     // shows spinner when true
}
```

---

### IssuesList

**Purpose**: Lists quality issues found in the ticket.

**Layout**: Bulleted list with red/warning icons per item.

**Props**:
```js
{
  issues: string[]     // e.g., ["Missing steps to reproduce", "Ambiguous title"]
}
```

**Behavior**: Hidden when `issues` is empty.

---

### SuggestionsList

**Purpose**: Actionable suggestions for improvement.

**Layout**: Numbered list with lightbulb icons per item.

**Props**:
```js
{
  suggestions: string[]  // e.g., ["Add expected vs actual behavior"]
}
```

**Behavior**: Hidden when `suggestions` is empty.

---

### ImproveButton (V1)

**Purpose**: Triggers LLM-powered improvement generation.

**Layout**: Primary button, full-width below suggestions.

**Props**:
```js
{
  onClick: () => void,
  loading: boolean,
  disabled: boolean    // disabled when score >= 80 and not explicitly requested
}
```

**Label**: "✨ Improve with AI"

**Loading state**: Shows "Analyzing..." with spinner.

---

### ComparisonView (V2)

**Purpose**: Side-by-side display of original vs improved content.

**Layout**: Two-column (or stacked on narrow panels) with headers "Original" and "Improved".

**Props**:
```js
{
  originalTitle: string,
  originalDescription: string,
  improvedTitle: string,
  improvedDescription: string,
  show: boolean
}
```

**Behavior**:
- Improved content highlighted with subtle green background
- Sections with changes are visually indicated
- Scrollable if content is long

---

### ActionButtons (V2)

**Purpose**: User decision controls for accepting/rejecting improvements.

**Layout**: Horizontal button group below ComparisonView.

| Button | Style | Action |
|--------|-------|--------|
| Accept | Primary (green) | Triggers write-back to Jira |
| Edit | Secondary (neutral) | Opens EditMode |
| Reject | Tertiary (subtle) | Dismisses and logs |

**Props**:
```js
{
  onAccept: () => void,
  onEdit: () => void,
  onReject: () => void,
  loading: boolean       // shows spinner on Accept while writing
}
```

---

### EditMode (V2)

**Purpose**: Allows user to modify the AI-suggested improvement before accepting.

**Layout**: Full-width textarea pre-filled with improved content + "Save" button.

**Props**:
```js
{
  initialTitle: string,
  initialDescription: string,
  onSave: (title: string, description: string) => void,
  onCancel: () => void
}
```

**Behavior**:
- Title field: single-line input
- Description field: multi-line textarea with reasonable height (200px min)
- "Save" triggers write-back with edited content
- "Cancel" returns to ComparisonView

---

## Loading & Error States

| State | UI Treatment |
|-------|-------------|
| Analyzing | Spinner + "Analyzing ticket quality..." text |
| Improving | Spinner + "Generating improvement..." text |
| Writing | Spinner + "Updating ticket..." on Accept button |
| Error (AI unavailable) | Yellow banner: "AI temporarily unavailable. Showing rule-based analysis only." + Retry button |
| Error (Auth) | Red banner: "Authentication error. Please reload the page." |
| Error (Write failed) | Red banner: "Failed to update ticket. Please try again." |
| Success (Write) | Green banner: "Ticket updated successfully!" (auto-dismiss after 3s) |

---

## Responsive Behavior

The Jira issue panel has limited width (~350–400px). Design must account for:

- **Score badge**: Always visible, compact
- **Lists**: Full-width, text wraps
- **Comparison view**: Stacked (not side-by-side) in narrow panels
- **Buttons**: Full-width stacked in narrow mode
- **Textarea**: Full-width with vertical scroll

---

## Accessibility

- Score badge includes `aria-label` with full description (e.g., "Quality score: 62 out of 100, Needs Improvement")
- All buttons have clear labels (no icon-only buttons)
- Color is not the sole indicator — labels accompany color badges
- Focus management: after Accept/Reject, focus returns to "Check Quality" button
- Loading states announce via `aria-live="polite"`
