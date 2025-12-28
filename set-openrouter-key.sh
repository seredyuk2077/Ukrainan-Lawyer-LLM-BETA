#!/bin/bash

# Перевірка чи є OPENROUTER_API_KEY в .env
if grep -q "OPENROUTER_API_KEY" .env 2>/dev/null; then
    echo "✅ Знайдено OPENROUTER_API_KEY в .env файлі"
    OPENROUTER_KEY=$(grep "OPENROUTER_API_KEY" .env | cut -d '=' -f2 | tr -d '"' | tr -d "'")
    
    if [ -n "$OPENROUTER_KEY" ]; then
        echo "📤 Встановлюю OPENROUTER_API_KEY в Supabase..."
        npx supabase secrets set OPENROUTER_API_KEY="$OPENROUTER_KEY"
        echo "✅ Готово!"
    else
        echo "❌ OPENROUTER_API_KEY порожній в .env файлі"
        exit 1
    fi
else
    echo "❌ OPENROUTER_API_KEY не знайдено в .env файлі"
    echo "Додайте рядок: OPENROUTER_API_KEY=your_key_here"
    exit 1
fi
