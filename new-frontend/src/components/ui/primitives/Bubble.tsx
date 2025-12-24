import { type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cn } from '../../../utils/cn'
import { easeEmphatic } from '../../../styles/motion'

type BubbleVariant = 'assistant' | 'user'

type BubbleProps = {
  variant: BubbleVariant
  children: ReactNode
  accent?: boolean
  className?: string
}

export const Bubble = ({ variant, children, accent = false, className }: BubbleProps) => {
  const isUser = variant === 'user'
  const widthClass = isUser ? 'max-w-[58%] md:max-w-[540px]' : 'max-w-full'

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, x: isUser ? 4 : 0 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      transition={{ duration: 0.22, ease: easeEmphatic }}
      className={cn('flex w-full', isUser ? 'justify-end pr-1' : 'justify-start pl-1')}
    >
      <div
        className={cn(
          'w-full transition duration-200',
          widthClass,
          isUser
            ? 'rounded-[7px] bg-[var(--surface-soft)]/92 px-3 py-2.5 text-[var(--text-primary)] shadow-none'
            : 'rounded-none bg-transparent px-0 py-0 text-[var(--text-primary)] shadow-none border-none',
          accent && !isUser && 'border-l-0',
          className
        )}
      >
        {children}
      </div>
    </motion.div>
  )
}
