import { useMemo, useState } from 'react'
import { lexeryBrand, lexeryIcon, lexeryMark, lexeryMarkWhite } from '../../assets/lexery'
import { cn } from '../../utils/cn'

type LexeryLogoVariant = 'full' | 'mark' | 'mark-white' | 'icon'
type LexeryLogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

type Props = {
  variant?: LexeryLogoVariant
  size?: LexeryLogoSize
  className?: string
  withShadow?: boolean
}

const paths: Record<LexeryLogoVariant, string> = {
  full: lexeryBrand,
  icon: lexeryIcon,
  mark: lexeryMark,
  'mark-white': lexeryMarkWhite,
}

const fullSizeMap: Record<LexeryLogoSize, { w: number; h: number }> = {
  xs: { w: 72, h: 22 },
  sm: { w: 110, h: 34 },
  md: { w: 176, h: 54 },
  lg: { w: 228, h: 70 },
  xl: { w: 260, h: 80 },
}

const markSizeMap: Record<LexeryLogoSize, { w: number; h: number }> = {
  xs: { w: 28, h: 28 },
  sm: { w: 32, h: 32 },
  md: { w: 40, h: 40 },
  lg: { w: 44, h: 44 },
  xl: { w: 52, h: 52 },
}

const LexeryLogo = ({ variant = 'full', size = 'md', className, withShadow }: Props) => {
  const [broken, setBroken] = useState(false)
  const dim = useMemo(() => {
    const isMark = variant === 'mark' || variant === 'mark-white'
    return isMark ? markSizeMap[size] : fullSizeMap[size]
  }, [size, variant])
  const src = paths[variant]

  if (src && !broken) {
    return (
      <img
        src={src}
        width={dim.w}
        height={dim.h}
        alt="LEXERY AI"
        className={cn(
          'object-contain',
          withShadow && 'drop-shadow-[0_8px_24px_rgba(17,24,39,0.08)]',
          className
        )}
        onError={() => setBroken(true)}
      />
    )
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-white px-4 py-2 shadow-sm',
        className
      )}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--primary)] text-white font-semibold uppercase">
        L
      </div>
      {variant !== 'mark' && (
        <div className="leading-tight">
          <p className="text-sm font-semibold text-[var(--text-primary)]">LEXERY AI</p>
          <p className="text-[11px] text-[var(--text-secondary)]">Legal Intelligence Workspace</p>
        </div>
      )}
    </div>
  )
}

export default LexeryLogo
