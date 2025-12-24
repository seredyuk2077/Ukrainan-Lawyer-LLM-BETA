import { motion } from 'framer-motion'
import { cn } from '../../utils/cn'

type SpinnerProps = {
  className?: string
}

const ease = [0.4, 0, 0.2, 1] as const

const Spinner = ({ className }: SpinnerProps) => {
  return (
    <div className={cn('flex items-center gap-4 text-[var(--primary)]', className)}>
      <motion.div
        className="relative h-14 w-14 rounded-full bg-gradient-to-br from-[rgba(29,58,107,0.08)] to-[rgba(59,130,246,0.08)] backdrop-blur"
        animate={{ rotate: 360 }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
      >
        <motion.div
          className="absolute inset-2 rounded-full bg-white border border-[var(--border)] shadow-sm"
          initial={{ scale: 0.9, opacity: 0.6 }}
          animate={{ scale: [0.9, 1, 0.96, 1], opacity: [0.6, 1, 0.85, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease }}
        />

        <div className="absolute inset-0 flex items-center justify-center">
          <motion.div
            className="h-10 w-[2px] rounded-full bg-[var(--primary)]"
            initial={{ rotate: -6, scaleY: 0.6, opacity: 0.8 }}
            animate={{ rotate: [-6, 6, -4, 6, -6], scaleY: [0.6, 1, 0.75, 1, 0.6] }}
            transition={{ duration: 1.6, repeat: Infinity, ease }}
          />
          <motion.div
            className="h-10 w-[2px] rounded-full bg-[var(--accent)] ml-2"
            initial={{ rotate: 6, scaleY: 0.6, opacity: 0.8 }}
            animate={{ rotate: [6, -6, 6, -4, 6], scaleY: [0.6, 1, 0.8, 1, 0.6] }}
            transition={{ duration: 1.6, repeat: Infinity, ease, delay: 0.08 }}
          />
        </div>
      </motion.div>

      <div className="flex flex-col gap-1">
        <motion.div
          className="flex items-center gap-1"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: { opacity: 0 },
            visible: { opacity: 1, transition: { staggerChildren: 0.12 } },
          }}
        >
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-2 w-2 rounded-full bg-[var(--primary)]"
              variants={{
                hidden: { scale: 0.5, opacity: 0 },
                visible: { scale: 1.35, opacity: 1 },
              }}
              transition={{ duration: 0.6, repeat: Infinity, repeatType: 'reverse', delay: i * 0.12 }}
            />
          ))}
        </motion.div>
        <p className="text-sm font-medium text-[var(--text-secondary)]">Підготовка робочого простору…</p>
      </div>
    </div>
  )
}

export default Spinner
