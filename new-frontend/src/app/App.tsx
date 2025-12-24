import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import LoadingScreen from './pages/LoadingScreen'
import Chat from './pages/Chat'
import WorkspaceLayout from '../layouts/WorkspaceLayout'

const App = () => {
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 1800)
    return () => clearTimeout(timer)
  }, [])

  return (
    <AnimatePresence mode="wait">
      {isLoading ? (
        <motion.div
          key="loading"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
        >
          <LoadingScreen />
        </motion.div>
      ) : (
        <motion.div
          key="workspace"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
        >
          <WorkspaceLayout>
            <Chat />
          </WorkspaceLayout>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default App
