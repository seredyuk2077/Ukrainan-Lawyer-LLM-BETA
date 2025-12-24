import { type ReactNode } from 'react'
import Sidebar from '../components/navigation/Sidebar'
import Topbar from '../components/navigation/Topbar'

type WorkspaceLayoutProps = {
  children: ReactNode
}

const WorkspaceLayout = ({ children }: WorkspaceLayoutProps) => {
  return (
    <div className="flex h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden">
      <Sidebar />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
          {children}
        </main>
      </div>
    </div>
  )
}

export default WorkspaceLayout
