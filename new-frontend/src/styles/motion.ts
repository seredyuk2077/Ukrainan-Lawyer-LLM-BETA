export const easeEmphatic = [0.16, 1, 0.3, 1] as const
export const easeStandard = [0.4, 0, 0.2, 1] as const
export const springSlow = { type: 'spring', stiffness: 260, damping: 28 }
export const springSoft = { type: 'spring', stiffness: 220, damping: 24 }
export const motionEntrance = { duration: 0.28, ease: easeEmphatic }
export const motionFade = { duration: 0.18, ease: easeStandard }
