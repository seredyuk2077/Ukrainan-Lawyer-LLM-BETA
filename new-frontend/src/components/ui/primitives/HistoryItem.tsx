import { motion } from 'framer-motion'
import { cn } from '../../../utils/cn'

type HistoryItemProps = {
  title: string
  timestamp: string
  active?: boolean
  onClick?: () => void
}

export const HistoryItem = ({ title, timestamp, active, onClick }: HistoryItemProps) => (
  <motion.button
    layout
    onClick={onClick}
    className={cn(
      'group relative flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-white/90 transition',
      'before:absolute before:left-0.5 before:top-1 before:h-[calc(100%-8px)] before:w-[3px] before:rounded-full before:bg-white/30 before:opacity-0 before:transition-opacity',
      'hover:bg-white/10 hover:text-white',
      active && 'bg-white/12 text-white shadow-[0_14px_32px_rgba(12,18,34,0.18)] before:opacity-100'
    )}
    whileHover={{ scale: 1.01, y: -1 }}
    transition={{ duration: 0.18 }}
  >
    <div className="flex flex-col gap-0.5">
      <span className="line-clamp-1 text-[13px] font-semibold text-white/92">{title}</span>
      <span className="text-[11px] text-white/70">{timestamp}</span>
    </div>
    <span className="text-[10px] uppercase tracking-[0.12em] text-white/60 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      Open
    </span>
  </motion.button>
)
