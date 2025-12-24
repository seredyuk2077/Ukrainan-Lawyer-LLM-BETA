import { motion } from 'framer-motion'
import { Landmark, Scale, FileText } from 'lucide-react'
import LexeryLogo from '../../components/branding/LexeryLogo'
import Spinner from '../../components/ui/Spinner'

const statuses = [
  'Завантаження правових баз…',
  'Підключення до LEXERY AI…',
  'Підготовка workspace…',
]

const highlights = [
  { title: 'Аналіз НПА', desc: 'Нормативні акти, кодекси, позиції', icon: Landmark },
  { title: 'Судова практика', desc: 'Верховний Суд, касація, апеляція', icon: Scale },
  { title: 'Документи', desc: 'Договори, процесуальні форми, листи', icon: FileText },
]

const LoadingScreen = () => {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--bg-workspace)] px-6">
      <div className="absolute inset-0 bg-gradient-to-b from-white via-transparent to-white opacity-80" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(29,58,107,0.08),transparent_32%),radial-gradient(circle_at_80%_15%,rgba(59,130,246,0.09),transparent_30%)]" />
      <div className="absolute inset-0 backdrop-blur-sm" />

      <motion.div
        className="pointer-events-none absolute h-[520px] w-[520px] rounded-full border border-[rgba(29,58,107,0.08)]"
        initial={{ rotate: 0, opacity: 0.45 }}
        animate={{ rotate: 360 }}
        transition={{ duration: 30, ease: 'linear', repeat: Infinity }}
      />
      <motion.div
        className="pointer-events-none absolute h-[380px] w-[380px] rounded-full border border-[rgba(59,130,246,0.08)]"
        initial={{ rotate: 0, opacity: 0.4 }}
        animate={{ rotate: -360 }}
        transition={{ duration: 36, ease: 'linear', repeat: Infinity }}
      />

      <motion.div
        className="relative flex max-w-3xl flex-col items-center gap-10 rounded-3xl border border-[var(--border)] bg-white/85 px-12 py-14 shadow-2xl shadow-[rgba(17,24,39,0.08)] backdrop-blur"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.65, ease: [0.4, 0, 0.2, 1] }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.65, ease: [0.4, 0, 0.2, 1] }}
        >
          <LexeryLogo size="xl" variant="full" withShadow />
        </motion.div>

        <div className="max-w-2xl space-y-3 text-center">
          <motion.h1
            className="text-3xl font-semibold text-[var(--text-primary)]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
          >
            Ініціалізація LEXERY AI workspace
          </motion.h1>
          <motion.p
            className="text-sm text-[var(--text-secondary)]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.16, duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
          >
            Готуємо правові джерела, моделі та інтерфейс, щоб ви одразу працювали з
            юриспруденцією без шуму.
          </motion.p>
        </div>

        <Spinner />

        <div className="grid w-full gap-4 md:grid-cols-3">
          {highlights.map((item, idx) => (
            <motion.div
              key={item.title}
              className="rounded-[16px] border border-[var(--border)] bg-[var(--surface-soft)]/80 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18 + idx * 0.08, duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className="mb-2 flex items-center gap-2 text-[var(--primary)]">
                <item.icon className="h-4 w-4" />
                <p className="text-sm font-semibold text-[var(--text-primary)]">{item.title}</p>
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">{item.desc}</p>
            </motion.div>
          ))}
        </div>

        <div className="w-full space-y-2">
          {statuses.map((status, idx) => (
            <motion.div
              key={status}
              className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-3 shadow-sm"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + idx * 0.09, duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-40" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--primary)]" />
              </span>
              <span className="text-sm text-[var(--text-primary)]">{status}</span>
            </motion.div>
          ))}
        </div>

        <motion.div
          className="flex items-center gap-2 text-xs text-[var(--text-secondary)] rounded-full border border-[var(--border)] bg-white/70 px-3 py-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
        >
          <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-pulse" />
          <span>LEXERY AI · Legal Intelligence for Ukraine</span>
        </motion.div>
      </motion.div>
    </div>
  )
}

export default LoadingScreen
