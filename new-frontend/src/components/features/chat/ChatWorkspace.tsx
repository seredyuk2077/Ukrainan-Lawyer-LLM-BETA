import { useState } from 'react'
import ChatComposer from './ChatComposer'
import ChatMessage, { type ChatMessageType } from './ChatMessage'

const initialMessages: ChatMessageType[] = [
  {
    id: '1',
    role: 'assistant',
    content:
      'Вітаю у LEXERY AI. Готова проаналізувати ваш кейс, судову практику або сформувати проект договору.',
    timestamp: 'Сьогодні · 10:24',
  },
  {
    id: '2',
    role: 'user',
    content: 'Потрібно коротко оцінити ризики договору поставки для замовника.',
    timestamp: 'Сьогодні · 10:24',
  },
  {
    id: '3',
    role: 'assistant',
    content:
      'Підготуємо: 1) ключові обов’язки сторін, 2) ризики щодо відповідальності, 3) умови зміни ціни та строки, 4) юрисдикцію та застосовне право. Додайте файл або уточнення.',
    timestamp: 'Сьогодні · 10:24',
  },
]

const ChatWorkspace = () => {
  const [messages, setMessages] = useState<ChatMessageType[]>(initialMessages)

  const handleSend = (text: string) => {
    const newMessage: ChatMessageType = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: 'Щойно',
    }
    setMessages((prev) => [...prev, newMessage])

    const draftReply: ChatMessageType = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Аналітика готується… Додайте деталі: умови оплати, строки, територію постачання.',
      timestamp: 'генерується',
    }

    setTimeout(() => setMessages((prev) => [...prev, draftReply]), 220)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1200px] px-4 pb-14 pt-8 lg:px-10">
            <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4.5 lg:gap-5">
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 w-full bg-gradient-to-t from-[var(--bg-canvas)] via-[var(--bg-canvas)]/96 to-transparent px-3 pb-4 pt-3 backdrop-blur-xl sm:px-4 lg:px-10">
          <div className="flex justify-center">
            <ChatComposer onSend={handleSend} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default ChatWorkspace
