# Ukrainian Legal AI Chat Backend

AI-powered legal assistant backend for Ukrainian law with Supabase integration.

## 🏗️ Architecture

- **AI Agent**: `supabaseLegalAgent.js` - Main AI logic with RAG (Retrieval-Augmented Generation)
- **Parser**: `radaOfficialApiParser.js` - Official Rada API parser for legal documents
- **Database**: Supabase PostgreSQL with full-text search
- **API**: Express.js REST API
- **Frontend**: Web interface integration ready

## 🚀 Quick Start

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Setup environment**:
   ```bash
   cp supabase.env.example .env
   # Edit .env with your Supabase credentials
   ```

3. **Initialize database**:
   ```bash
   # Apply Supabase schema
   # Run in Supabase SQL editor: supabase_schema.sql
   ```

4. **Initialize knowledge base**:
   ```bash
   # Static laws (fast)
   pnpm run init-kb:static
   
   # Or official Rada API (slower, more comprehensive)
   pnpm run init-kb:official-rada
   ```

5. **Start server**:
   ```bash
   pnpm run dev
   ```

## 📁 Project Structure

```
backend/
├── src/
│   ├── app-supabase.js          # Main application entry
│   ├── config/
│   │   ├── openai.js            # OpenAI configuration
│   │   └── supabase.js          # Supabase configuration
│   ├── controllers/
│   │   └── supabaseChatController.js  # Chat API controller
│   ├── middleware/
│   │   ├── rateLimit.js         # Rate limiting
│   │   └── validation.js        # Request validation
│   ├── models/
│   │   ├── SupabaseMessage.js   # Message model
│   │   └── SupabaseSession.js   # Session model
│   ├── routes/
│   │   ├── health.js            # Health check endpoint
│   │   └── supabaseChat.js      # Chat API routes
│   ├── scripts/
│   │   ├── initOfficialRadaKB.js    # Initialize with Rada API
│   │   └── initStaticKB.js          # Initialize with static laws
│   ├── services/
│   │   ├── radaOfficialApiParser.js     # Official Rada API parser
│   │   ├── supabaseLegalAgent.js        # AI legal agent
│   │   └── supabaseResponseValidator.js # Response validation
│   └── utils/
│       ├── healthcheck.js       # Health check utilities
│       └── logger.js            # Logging configuration
├── supabase_schema.sql          # Database schema
├── supabase.env.example         # Environment variables template
└── package.json                 # Dependencies and scripts
```

## 🔧 API Endpoints

### Health Check
- `GET /health` - Server health status

### Chat API
- `POST /api/chat/send` - Send message to AI
- `GET /api/chat/history/:id` - Get chat history
- `POST /api/chat/sessions` - Create new session
- `GET /api/chat/sessions/user/:id` - Get user sessions
- `PUT /api/chat/sessions/:id` - Update session
- `DELETE /api/chat/sessions/:id` - Delete session
- `GET /api/chat/search/laws` - Search laws
- `GET /api/chat/info` - API documentation

### Admin API
- `GET /api/chat/admin/stats` - System statistics
- `POST /api/chat/admin/knowledge-base/update` - Update knowledge base
- `POST /api/chat/admin/cache/clear` - Clear cache

## 🤖 AI Features

- **RAG (Retrieval-Augmented Generation)**: Searches legal database before generating responses
- **Official Rada API Integration**: Fetches latest Ukrainian laws
- **Response Validation**: Ensures legal accuracy and minimizes hallucinations
- **Caching**: Optimizes performance and reduces API calls
- **Rate Limiting**: Respects API limits (60 requests/minute)

## 🗄️ Database Schema

- `chat_sessions` - Chat sessions
- `chat_messages` - Individual messages
- `legal_laws` - Legal documents from Rada API
- `legal_templates` - Response templates
- `legal_consultations` - Consultation examples

## 🔑 Environment Variables

```env
# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Server
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

## 📊 Monitoring

- Health check endpoint: `GET /health`
- Logs: `logs/` directory
- Winston logging with structured JSON

## 🚀 Deployment

1. Set environment variables
2. Apply database schema
3. Initialize knowledge base
4. Start with `pnpm start`

## 🔄 Knowledge Base Updates

The system automatically updates the knowledge base when:
- New laws are found via Rada API
- User queries require additional legal context
- Manual admin updates are triggered

## 📝 License

Private project - Ukrainian Legal AI Chat
