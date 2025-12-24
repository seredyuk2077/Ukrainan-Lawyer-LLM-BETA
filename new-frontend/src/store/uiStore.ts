import { create } from 'zustand'

type UIState = {
  isHistoryOpen: boolean
  toggleHistory: () => void
  closeHistory: () => void
}

export const useUIStore = create<UIState>((set) => ({
  isHistoryOpen: false,
  toggleHistory: () => set((state) => ({ isHistoryOpen: !state.isHistoryOpen })),
  closeHistory: () => set({ isHistoryOpen: false }),
}))
