# Portal Frontend

React-based web productivity portal for viewing employee analytics.

## Setup

```bash
npm install
cp .env.example .env
```

## Development

```bash
npm run dev
```

Portal will run on http://localhost:3002 and proxy API requests to http://localhost:3001.

## Build

```bash
npm run build
```

Output will be in `build/` directory.

## Structure

- `src/api/` — API client functions
- `src/components/` — Reusable UI components
- `src/contexts/` — Auth context
- `src/hooks/` — Custom hooks
- `src/pages/` — Page components
- `src/utils/` — Helper functions
