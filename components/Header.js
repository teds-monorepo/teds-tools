'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Modal from '@/components/Modal';

// Fill in your own info — shown in the Contact modal.
const CONTACT = {
  name: "Ted's Tools",
  email: 'you@example.com',
  github: 'https://github.com/',
};

const navItems = [
  { href: '/tools', label: 'Tools' },
  { href: '/texttools', label: 'Text Tools' },
  { href: '/color', label: 'Color Tools' },
  { href: '/assets', label: 'Assets Tools' },
  { href: '/model3d', label: '3D Viewer' },
  { href: '/notes', label: 'Notes' },
  { href: '/links', label: 'Links' },
  { href: '/statics', label: 'Static Pages' },
];

const linkClass = (active) =>
  `px-2.5 py-1.5 rounded-[9px] text-[13px] border whitespace-nowrap ${
    active
      ? 'bg-accent/[0.14] border-accent/30 text-text'
      : 'border-transparent text-muted hover:text-text hover:bg-panel2'
  }`;

export default function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  // Compact = Logo + hamburger only. Decided by measured space, not viewport
  // width, so a narrow desktop window behaves like mobile and there is never
  // a nav scrollbar.
  const [compact, setCompact] = useState(false);
  const headerRef = useRef(null);
  const measureRef = useRef(null);

  useEffect(() => {
    const header = headerRef.current;
    const measure = measureRef.current;
    if (!header || !measure) return;
    const fit = () => {
      const available = header.clientWidth - 32; // px-4 both sides
      setCompact(measure.scrollWidth > available);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const openContact = () => {
    setMenuOpen(false);
    setContactOpen(true);
  };

  return (
    <>
      <header
        ref={headerRef}
        className="h-14 flex-shrink-0 flex items-center gap-3 px-4 bg-panel border-b border-border relative z-40"
      >
        <Link
          href="/tools"
          className="flex items-center gap-2 text-[15px] font-semibold whitespace-nowrap min-w-0"
        >
          <span className="flex-shrink-0">⚙</span>
          <span className="truncate">Ted&apos;s Tools</span>
        </Link>

        {!compact && (
          <nav className="flex items-center gap-0.5 ml-4 min-w-0 overflow-hidden">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className={linkClass(pathname === item.href)}>
                {item.label}
              </Link>
            ))}
          </nav>
        )}

        {!compact && (
          <button
            type="button"
            onClick={openContact}
            className="ml-auto flex-shrink-0 px-3.5 py-1.5 rounded-lg bg-accent text-bg text-[13px] font-medium hover:brightness-110"
          >
            Contact
          </button>
        )}

        {compact && (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="Toggle menu"
            className="ml-auto w-9 h-9 flex-shrink-0 rounded-[9px] bg-panel2 border border-border text-muted hover:text-text hover:border-accent flex items-center justify-center text-[15px]"
          >
            ☰
          </button>
        )}

        {compact && menuOpen && (
          <nav className="absolute top-14 left-0 right-0 bg-panel border-b border-border px-4 py-3 flex flex-col gap-0.5">
            {navItems.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`px-2.5 py-2 rounded-[9px] text-[13px] border ${
                    active
                      ? 'bg-accent/[0.14] border-accent/30 text-text'
                      : 'border-transparent text-muted hover:text-text hover:bg-panel2'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={openContact}
              className="mt-2 px-3.5 py-2 rounded-lg bg-accent text-bg text-[13px] font-medium hover:brightness-110"
            >
              Contact
            </button>
          </nav>
        )}

        {/* Hidden measurer: full-size header content. Compact mode never
            depends on it for layout, so it always reports the true width the
            full nav + Contact need — no hysteresis when growing back. */}
        <div aria-hidden className="absolute invisible top-0 left-0 pointer-events-none">
          <div ref={measureRef} className="flex items-center gap-3 whitespace-nowrap">
            <span className="flex items-center gap-2 text-[15px] font-semibold">
              <span>⚙</span>
              <span>Ted&apos;s Tools</span>
            </span>
            <span className="flex items-center gap-0.5 ml-4">
              {navItems.map((item) => (
                <span key={item.href} className={linkClass(false)}>
                  {item.label}
                </span>
              ))}
            </span>
            <span className="px-3.5 py-1.5 rounded-lg bg-accent text-[13px] font-medium">
              Contact
            </span>
          </div>
        </div>
      </header>

      <Modal open={contactOpen} title="Contact" onClose={() => setContactOpen(false)}>
        <div className="text-[13.5px] font-semibold">{CONTACT.name}</div>
        <div className="mt-2 flex flex-col gap-1.5 text-[13px] text-muted">
          <a className="hover:text-text" href={`mailto:${CONTACT.email}`}>
            {CONTACT.email}
          </a>
          <a className="hover:text-text" href={CONTACT.github} target="_blank" rel="noreferrer">
            {CONTACT.github}
          </a>
        </div>
      </Modal>
    </>
  );
}
