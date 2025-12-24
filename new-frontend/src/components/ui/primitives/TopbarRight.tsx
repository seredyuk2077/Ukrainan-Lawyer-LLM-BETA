import { type ReactNode } from 'react'

type TopbarRightProps = {
  indicatorLabel: string
  children: ReactNode
}

export const TopbarRight = ({ indicatorLabel, children }: TopbarRightProps) => (
  <div className="flex items-center gap-3">
    <div className="flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-white/90 px-2.5 py-1 text-[11px] text-[var(--text-secondary)] shadow-[0_8px_18px_rgba(12,18,34,0.06)]">
      <span
        className="flex h-1.5 w-1.5 items-center justify-center rounded-full bg-emerald-500 shadow-[0_0_0_2px_rgba(255,255,255,0.9)]"
        aria-hidden
      />
      <span>{indicatorLabel}</span>
    </div>
    {children}
  </div>
)
