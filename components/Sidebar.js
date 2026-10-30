'use client';

/**
 * The sidebar in the app shell — a full-height context panel that sits
 * between the header and the page content. Each page renders its own content
 * into it. See docs/DESIGN.md.
 */
import { useState } from 'react';

export function Sidebar({ title, action, children, activeLabel }) {
  // Mobile: the sidebar collapses into an overlay dropdown under the header,
  // like the header menu. Selecting any item closes it; page logic
  // (activeKey, etc.) is untouched.
  const [open, setOpen] = useState(false);
  return (
    <>
      <aside className="hidden md:flex w-60 flex-shrink-0 flex-col bg-panel2 border-r border-border px-3 py-5">
        <div className="flex items-center justify-between gap-2 px-2 pb-3">
          <div className="min-w-0 truncate text-[15px] font-semibold">{title}</div>
          {action}
        </div>
        <div className="flex flex-col gap-0.5 min-h-0 overflow-y-auto">{children}</div>
      </aside>
      <div className="md:hidden flex-shrink-0 bg-panel2 border-b border-border px-3 py-2 relative z-30">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</span>
            {activeLabel && (
              <span className="flex-shrink-0 max-w-[50%] truncate text-[12px] text-muted">
                {activeLabel}
              </span>
            )}
            <span className="text-muted text-[12px] flex-shrink-0">{open ? '▴' : '▾'}</span>
          </button>
          {action}
        </div>
        {open && (
          <div
            className="absolute top-full left-0 right-0 bg-panel border-b border-border px-4 py-3 flex flex-col gap-0.5 max-h-[45vh] overflow-y-auto"
            onClick={(e) => {
              if (e.target.closest('button')) setOpen(false);
            }}
          >
            {children}
          </div>
        )}
      </div>
    </>
  );
}

export function SubItem({ active, onClick, icon, label, sub }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-[9px] border ${
        active
          ? 'bg-accent/[0.14] border-accent/30 text-text'
          : 'border-transparent text-muted hover:text-text hover:bg-panel'
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium truncate">{label}</span>
        {sub ? <span className="block text-[11px] text-muted truncate mt-0.5">{sub}</span> : null}
      </span>
    </button>
  );
}

/** Compact icon button used as a Sidebar `action`. */
export function SubAction({ onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="w-7 h-7 flex-shrink-0 rounded-[7px] bg-panel border border-border text-muted hover:text-text hover:border-accent flex items-center justify-center text-[15px] leading-none"
    >
      {children}
    </button>
  );
}

/**
 * Scrollable, padded column that holds a page's main content.
 *
 * A page that manages its own scrolling turns both off. These are booleans rather than an
 * extra `className`, because a class appended afterwards can't reliably override
 * the base ones: Tailwind emits both rules at the same specificity, so which of
 * them wins comes down to stylesheet order rather than the order in the
 * attribute.
 */
export function ContentPane({ children, padded = true, scroll = true }) {
  return (
    <div
      className={`flex-1 min-w-0 ${scroll ? 'overflow-y-auto' : 'overflow-hidden'} ${
        padded ? 'px-6 py-7 pb-16' : ''
      }`}
    >
      {children}
    </div>
  );
}
