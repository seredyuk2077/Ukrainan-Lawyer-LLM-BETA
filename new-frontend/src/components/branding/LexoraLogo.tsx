import { useMemo, useState } from 'react'
import { lexeryBrand, lexeryIcon, lexeryMark } from '../../assets/lexery'
import { cn } from '../../utils/cn'

type LexoraLogoVariant = 'full' | 'mark' | 'icon'
type LexoraLogoSize = 'xs' | 'sm' | 'md' | 'lg'

type Props = {
  variant?: LexoraLogoVariant
  size?: LexoraLogoSize
  className?: string
  withShadow?: boolean
}

const paths: Record<LexoraLogoVariant, string> = {
  full: lexeryBrand,
  icon: lexeryIcon,
  mark: lexeryMark,
}

const sizeMap: Record<LexoraLogoSize, { w: number; h: number }> = {
  xs: { w: 72, h: 22 },
  sm: { w: 104, h: 32 },
  md: { w: 168, h: 50 },
  lg: { w: 228, h: 70 },
}

const LexoraLogo = ({ variant = 'full', size = 'md', className, withShadow }: Props) => {
  const [broken, setBroken] = useState(false)
  const dim = useMemo(() => sizeMap[size], [size])
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

export default LexoraLogo
