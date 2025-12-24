import { type FormEvent, type DragEvent, useEffect, useRef, useState } from 'react'
import { Paperclip, Send } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '../../../utils/cn'
import { AttachmentChip } from '../../ui/primitives/AttachmentChip'
import { easeEmphatic } from '../../../styles/motion'

type Props = {
  onSend: (text: string) => void
  disabled?: boolean
}

type Attachment = {
  id: string
  name: string
  size: number
  url: string
}

const ChatComposer = ({ onSend, disabled }: Props) => {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const autosize = () => {
    const el = textareaRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.style.height = 'auto'
      const next = Math.min(el.scrollHeight, 260)
      el.style.height = `${next}px`
    })
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const text = value.trim()
    if (!text && attachments.length === 0) return
    onSend(text)
    setValue('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleFiles = (files: FileList | null) => {
    if (!files) return
    const next = Array.from(files).slice(0, 5).map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      url: URL.createObjectURL(file),
    }))
    setAttachments((prev) => [...prev, ...next].slice(0, 5))
  }

  const handleDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (disabled) return
    handleFiles(e.dataTransfer.files)
  }

  useEffect(() => {
    autosize()
  }, [value])

  return (
    <motion.form
      onSubmit={handleSubmit}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onFocusCapture={() => setIsFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsFocused(false)
      }}
      className={cn(
        'w-full max-w-[880px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-white/94 px-3.5 py-2.5 backdrop-blur-xl',
        'shadow-[0_8px_18px_rgba(12,18,34,0.045)] transition-colors'
      )}
      initial={{ opacity: 0, y: 8 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: isFocused ? 1.005 : 1,
        boxShadow: isFocused
          ? '0 16px 38px rgba(12,18,34,0.08)'
          : '0 8px 20px rgba(12,18,34,0.045)',
        borderColor: isFocused ? 'var(--border-strong)' : 'var(--border)',
        backgroundColor: isFocused ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.9)',
      }}
      transition={{ duration: 0.26, ease: easeEmphatic }}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            'mt-0.5 flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-white text-[var(--text-primary)] transition',
            'hover:bg-white hover:border-[var(--border-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/14',
            disabled && 'cursor-not-allowed opacity-60'
          )}
          aria-label="Додати вкладення"
        >
          <Paperclip className="h-4 w-4 stroke-[1.6]" />
        </button>

        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Сформулюйте юридичне запитання або опишіть кейс…"
            className={cn(
              'w-full resize-none rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-transparent px-3 py-2.5 text-[15px] leading-[1.5] text-[var(--text-primary)] transition',
              'placeholder:text-[var(--text-secondary)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/12',
              disabled && 'cursor-not-allowed opacity-70'
            )}
            rows={1}
            disabled={disabled}
            onInput={autosize}
            onFocus={() => setIsFocused(true)}
            onBlur={(e) => {
              if (!(e.currentTarget.parentElement?.contains(document.activeElement))) {
                setIsFocused(false)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(e)
              }
            }}
          />

          {attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {attachments.map((att) => (
                <AttachmentChip
                  key={att.id}
                  name={att.name}
                  onRemove={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                />
              ))}
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className={cn(
            'mt-auto flex h-9 w-9 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--primary)] text-white shadow-[0_8px_18px_rgba(15,23,42,0.1)] transition-transform',
            'hover:scale-[1.02] hover:bg-[var(--primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/18',
            (disabled || (!value.trim() && attachments.length === 0)) &&
              'cursor-not-allowed bg-gray-200 text-gray-500 shadow-none hover:scale-100 hover:bg-gray-200 focus:ring-0'
          )}
        >
          <Send className="h-4 w-4 stroke-[1.6]" />
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10.5px] text-[var(--text-muted)]">
        <span>Enter — відправити · Shift+Enter — новий рядок</span>
        <span className="hidden sm:inline text-[var(--text-secondary)]">Drag & drop · до 5 файлів</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
      />
    </motion.form>
  )
}

export default ChatComposer
