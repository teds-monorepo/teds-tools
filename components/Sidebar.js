'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const navItems = [
  { href: '/tools', label: 'Tools', icon: '⚙' },
  { href: '/texttools', label: 'Text Tools', icon: '✎' },
  { href: '/color', label: 'Color Tools', icon: '◐' },
  { href: '/assets', label: 'Assets Tools', icon: '◈' },
  { href: '/model3d', label: '3D Viewer', icon: '⬢' },
  { href: '/notes', label: 'Notes', icon: '▤' },
  { href: '/links', label: 'Links', icon: '⛓' },
  { href: '/statics', label: 'Static Pages', icon: '▦' },
];

export default function Sidebar() {
  const pathname = usePathname();
  // Start collapsed: the app opens straight into a page, so the nav only takes
  // space when the user asks for it. Hovering expands it temporarily; `pinned`
  // is the explicit toggle and survives the pointer leaving, so un-hovering
  // only collapses a nav that the user did not open that way.
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;

  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`flex flex-shrink-0 flex-col bg-panel border-r border-border transition-all duration-150 ${
        expanded ? 'w-36 px-3' : 'w-16 px-2.5'
      } py-5`}
    >
      <nav className="flex flex-col gap-0.5 pt-5">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setPinned(false)}
              className={`flex items-center gap-2 px-2 py-2 rounded-[9px] text-[13px] border ${
                expanded ? '' : 'justify-center'
              } ${
                active
                  ? 'bg-accent/[0.14] border-accent/30 text-text'
                  : 'border-transparent text-muted hover:text-text hover:bg-panel2'
              }`}
            >
              <span className="w-[18px] text-center flex-shrink-0">{item.icon}</span>
              {expanded && <span className="min-w-0 truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <button
        onClick={() => setPinned((v) => !v)}
        title="Toggle sidebar"
        className="w-full h-9 rounded-[9px] bg-panel2 border border-border text-muted hover:text-text hover:border-accent flex items-center justify-center text-[15px]"
      >
        ☰
      </button>
    </aside>
  );
}
