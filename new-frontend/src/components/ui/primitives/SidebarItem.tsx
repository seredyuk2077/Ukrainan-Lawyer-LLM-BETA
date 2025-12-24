import { type ComponentType } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '../../../utils/cn'
import { easeStandard } from '../../../styles/motion'

type SidebarItemProps = {
  icon: ComponentType<{ className?: string }>
  label: string
  expanded: boolean
  onClick?: () => void
  active?: boolean
}

export const SidebarItem = ({ icon: Icon, label, expanded, onClick, active }: SidebarItemProps) => (
  <motion.button
    layout
    onClick={onClick}
    className={cn(
      'group flex items-center gap-3 rounded-[12px] border border-white/8 bg-white/4 px-3 py-2.5 text-white/90 backdrop-blur transition',
      'hover:border-white/24 hover:bg-white/10',
      active && 'border-white/24 bg-white/12 shadow-[0_10px_26px_rgba(12,18,34,0.16)]'
    )}
    whileHover={{ scale: 1.02 }}
    whileTap={{ scale: 0.985 }}
    transition={{ duration: 0.2, ease: easeStandard }}
    aria-label={label}
  >
    <Icon className="h-[20px] w-[20px] stroke-[1.5] opacity-90" />
    <AnimatePresence initial={false}>
      {expanded && (
        <motion.span
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ duration: 0.2, ease: easeStandard }}
          className="text-[13px] font-medium tracking-wide text-white/90"
        >
          {label}
        </motion.span>
      )}
    </AnimatePresence>
  </motion.button>
)
