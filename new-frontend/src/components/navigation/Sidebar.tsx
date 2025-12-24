import { motion, AnimatePresence } from 'framer-motion'
import { Scale, FileText, Clock3, Settings } from 'lucide-react'
import { useMemo, useState } from 'react'
import LexeryLogo from '../branding/LexeryLogo'
import { useUIStore } from '../../store/uiStore'
import { SidebarItem } from '../ui/primitives/SidebarItem'
import { HistoryItem } from '../ui/primitives/HistoryItem'
import { easeEmphatic, springSlow } from '../../styles/motion'

const navItems = [
  { icon: Scale, label: 'Справи', key: 'cases' },
  { icon: FileText, label: 'Документи', key: 'docs' },
  { icon: Clock3, label: 'Історія', key: 'history' },
  { icon: Settings, label: 'Налаштування', key: 'settings' },
]

const historyItems = [
  { id: 'h1', title: 'Risk memo · Supply contract', ts: 'Сьогодні · 10:20' },
  { id: 'h2', title: 'Позов · Антимонопольний', ts: 'Вчора · 18:45' },
  { id: 'h3', title: 'Due diligence · NDA', ts: 'Пн · 14:12' },
  { id: 'h4', title: 'Скарга до ВС', ts: 'Пт · 11:30' },
  { id: 'h5', title: 'Договір поставки · ревізія', ts: 'Чт · 09:05' },
  { id: 'h6', title: 'Відзив · ПДВ спір', ts: 'Пн · 08:40' },
]

const Sidebar = () => {
  const { isHistoryOpen, toggleHistory, closeHistory } = useUIStore()
  const [activeHistory, setActiveHistory] = useState('h1')

  const sidebarWidth = useMemo(() => (isHistoryOpen ? 320 : 88), [isHistoryOpen])

  return (
    <motion.aside
      animate={{ width: sidebarWidth }}
      transition={{ ...springSlow }}
      className="relative z-40 hidden h-screen shrink-0 flex-col justify-between overflow-hidden bg-gradient-to-b from-[var(--primary)] via-[#1c2f4a] to-[var(--primary-dark)] text-white shadow-[8px_0_26px_rgba(12,18,34,0.14)] md:flex"
      style={{ minWidth: sidebarWidth, maxWidth: sidebarWidth }}
    >
      <div className="flex flex-col gap-6 px-4 pt-7">
        <div className="flex items-center gap-3 pl-1">
          <motion.div whileHover={{ scale: 1.04, opacity: 0.96 }} transition={{ duration: 0.2, ease: easeEmphatic }}>
            <LexeryLogo size="md" variant="mark-white" className="h-10 w-10 opacity-100" />
          </motion.div>
          <AnimatePresence initial={false}>
            {isHistoryOpen && (
              <motion.div
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={{ duration: 0.2, ease: easeEmphatic }}
                className="text-sm font-semibold text-white/90"
              >
                LEXERY AI
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <nav className="flex flex-col gap-2.5">
          {navItems.map((item) => {
            const isHistory = item.key === 'history'
            return (
              <SidebarItem
                key={item.key}
                icon={item.icon}
                label={item.label}
                expanded={isHistoryOpen}
                onClick={() => {
                  if (isHistory) toggleHistory()
                  else closeHistory()
                }}
                active={isHistory && isHistoryOpen}
              />
            )
          })}
        </nav>

        <AnimatePresence initial={false}>
          {isHistoryOpen && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.22, ease: easeEmphatic }}
              className="rounded-[14px] border border-white/12 bg-white/8 p-3.5 backdrop-blur-md shadow-[0_16px_34px_rgba(12,18,34,0.22)]"
            >
              <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-white/70">
                <span>History</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {historyItems.map((item) => (
                  <HistoryItem
                    key={item.id}
                    title={item.title}
                    timestamp={item.ts}
                    active={item.id === activeHistory}
                    onClick={() => setActiveHistory(item.id)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.aside>
  )
}

export default Sidebar
