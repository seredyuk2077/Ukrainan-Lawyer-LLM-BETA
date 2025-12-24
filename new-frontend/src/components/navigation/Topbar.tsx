import { User2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { easeStandard } from '../../styles/motion'
import { TopbarLeft } from '../ui/primitives/TopbarLeft'
import { TopbarRight } from '../ui/primitives/TopbarRight'

const Topbar = () => {
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center border-b border-[var(--border)] bg-white/88 px-4 text-sm shadow-[0_6px_18px_rgba(12,18,34,0.05)] backdrop-blur-xl md:px-6">
      <div className="flex flex-1 items-center justify-between gap-3">
        <TopbarLeft brand="LEXERY AI" section="Workspace" />

        <TopbarRight indicatorLabel="Model · Supreme">
          <motion.button
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-strong)] bg-white text-[var(--text-primary)] shadow-[0_8px_18px_rgba(12,18,34,0.07)] transition"
            aria-label="Профіль"
            whileHover={{ y: -2, scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={{ duration: 0.18, ease: easeStandard }}
          >
            <User2 className="h-5 w-5" />
          </motion.button>
        </TopbarRight>
      </div>
    </header>
  )
}

export default Topbar
