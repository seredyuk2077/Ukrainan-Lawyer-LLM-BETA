import { X } from 'lucide-react'
import { cn } from '../../../utils/cn'

type AttachmentChipProps = {
  name: string
  onRemove: () => void
}

export const AttachmentChip = ({ name, onRemove }: AttachmentChipProps) => {
  return (
    <span className="group inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--border-subtle)] bg-white/88 px-2.5 py-1 text-[12px] text-[var(--text-primary)] shadow-[0_5px_12px_rgba(12,18,34,0.05)] backdrop-blur-sm">
      <span className="max-w-[200px] truncate text-[12px] leading-[1.3]">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        className={cn(
          'rounded-full p-1 text-[var(--text-muted)] transition',
          'hover:bg-[var(--surface-soft)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]/18'
        )}
        aria-label="Видалити вкладення"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}
