import { cn } from '../../../utils/cn'
import { lexeryMark } from '../../../assets/lexery'
import { Bubble } from '../../ui/primitives/Bubble'

export type ChatRole = 'user' | 'assistant'

export type ChatMessageType = {
  id: string
  role: ChatRole
  content: string
  timestamp?: string
}

type Props = {
  message: ChatMessageType
}

const ChatMessage = ({ message }: Props) => {
  const isUser = message.role === 'user'

  return (
    <Bubble variant={isUser ? 'user' : 'assistant'} accent={false} className="gap-2">
      {!isUser && (
        <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
          <img src={lexeryMark} alt="LEXERY AI" className="h-[14px] w-[14px] rounded-sm" />
          <span className="text-[var(--text-secondary)]">LEXERY AI</span>
        </div>
      )}
      <div
        className={cn(
          'flex flex-col gap-2.5 text-[14.5px] leading-[1.66] tracking-[0.0015em] text-[var(--text-primary)]',
          !isUser && 'pl-0.5'
        )}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    </Bubble>
  )
}

export default ChatMessage
