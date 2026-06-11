/**
 * AppKindBadge — visible desktop-app vs web-application distinction (AC-A4).
 *
 * Renders an icon + colored chip for a catalog/classification row's
 * match_by kind: 'process' → Desktop (Monitor, indigo), 'url' → Website
 * (Globe, teal). Used everywhere apps are listed so the two kinds are
 * distinguishable at a glance.
 */

import { Monitor, Globe } from 'lucide-react';

const KINDS = {
  process: {
    label: 'Desktop',
    Icon: Monitor,
    className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  },
  url: {
    label: 'Website',
    Icon: Globe,
    className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  },
};

function AppKindBadge({ matchBy }) {
  const kind = KINDS[matchBy] || KINDS.process;
  const { label, Icon, className } = kind;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${className}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

export default AppKindBadge;
