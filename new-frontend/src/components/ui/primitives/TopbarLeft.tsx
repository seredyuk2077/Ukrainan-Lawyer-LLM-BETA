type TopbarLeftProps = {
  brand: string
  section: string
}

export const TopbarLeft = ({ brand, section }: TopbarLeftProps) => (
  <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
    <span className="uppercase tracking-[0.14em] text-[11px] text-[var(--text-muted)]">{brand}</span>
    <span className="h-[4px] w-[4px] rounded-full bg-[var(--border)]" />
    <span className="text-[13px] text-[var(--text-primary)]">{section}</span>
  </div>
)
