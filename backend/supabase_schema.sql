-- Supabase Schema for Enhanced Ukrainian Legal AI Chat
-- Run this in your Supabase SQL editor

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Create Ukrainian text search configuration
CREATE TEXT SEARCH CONFIGURATION ukrainian (COPY = simple);

-- Create custom types
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

-- Chat sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,
    title TEXT NOT NULL DEFAULT 'Нова консультація',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true
);

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role message_role NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    tokens_used INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'
);

-- Legal laws table
CREATE TABLE IF NOT EXISTS legal_laws (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    source_url VARCHAR(1000) UNIQUE NOT NULL,
    law_number VARCHAR(100),
    date_created DATE,
    keywords JSONB DEFAULT '[]',
    articles JSONB DEFAULT '[]',
    category VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Legal articles table
CREATE TABLE IF NOT EXISTS legal_articles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    law_id UUID REFERENCES legal_laws(id) ON DELETE CASCADE,
    article_number VARCHAR(50),
    title VARCHAR(500),
    content TEXT NOT NULL,
    keywords JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Legal precedents table
CREATE TABLE IF NOT EXISTS legal_precedents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_number VARCHAR(100),
    court_name VARCHAR(200),
    case_title VARCHAR(500),
    decision_text TEXT,
    legal_issues JSONB DEFAULT '[]',
    keywords JSONB DEFAULT '[]',
    date_decided DATE,
    source_url VARCHAR(1000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Legal consultations table
CREATE TABLE IF NOT EXISTS legal_consultations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category VARCHAR(100),
    keywords JSONB DEFAULT '[]',
    law_references JSONB DEFAULT '[]',
    quality_score INTEGER DEFAULT 0 CHECK (quality_score >= 0 AND quality_score <= 5),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Legal templates table
CREATE TABLE IF NOT EXISTS legal_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    template_content TEXT NOT NULL,
    fields JSONB DEFAULT '[]',
    law_references JSONB DEFAULT '[]',
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Response cache table
CREATE TABLE IF NOT EXISTS response_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    question_hash VARCHAR(64) UNIQUE NOT NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    law_references JSONB DEFAULT '[]',
    tokens_used INTEGER DEFAULT 0,
    quality_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days')
);

-- Response validations table
CREATE TABLE IF NOT EXISTS response_validations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    question TEXT NOT NULL,
    response TEXT NOT NULL,
    validation_results JSONB NOT NULL,
    session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_active ON chat_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at ON chat_sessions(updated_at);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role);

-- Full-text search indexes for Ukrainian language
CREATE INDEX IF NOT EXISTS idx_legal_laws_title_gin ON legal_laws USING gin(to_tsvector('simple', title));
CREATE INDEX IF NOT EXISTS idx_legal_laws_content_gin ON legal_laws USING gin(to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS idx_legal_laws_keywords_gin ON legal_laws USING gin(keywords);

CREATE INDEX IF NOT EXISTS idx_legal_articles_content_gin ON legal_articles USING gin(to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS idx_legal_articles_keywords_gin ON legal_articles USING gin(keywords);
CREATE INDEX IF NOT EXISTS idx_legal_articles_number ON legal_articles(article_number);

CREATE INDEX IF NOT EXISTS idx_legal_precedents_content_gin ON legal_precedents USING gin(to_tsvector('simple', decision_text));
CREATE INDEX IF NOT EXISTS idx_legal_precedents_keywords_gin ON legal_precedents USING gin(keywords);
CREATE INDEX IF NOT EXISTS idx_legal_precedents_date ON legal_precedents(date_decided);

CREATE INDEX IF NOT EXISTS idx_legal_consultations_question_gin ON legal_consultations USING gin(to_tsvector('simple', question));
CREATE INDEX IF NOT EXISTS idx_legal_consultations_answer_gin ON legal_consultations USING gin(to_tsvector('simple', answer));
CREATE INDEX IF NOT EXISTS idx_legal_consultations_category ON legal_consultations(category);

CREATE INDEX IF NOT EXISTS idx_response_cache_hash ON response_cache(question_hash);
CREATE INDEX IF NOT EXISTS idx_response_cache_expires ON response_cache(expires_at);

-- Create functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for automatic timestamp updates (if not exist)
DO $$
BEGIN
    -- Chat sessions trigger
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_chat_sessions_updated_at') THEN
        CREATE TRIGGER update_chat_sessions_updated_at 
            BEFORE UPDATE ON chat_sessions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    -- Legal laws trigger
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_legal_laws_updated_at') THEN
        CREATE TRIGGER update_legal_laws_updated_at 
            BEFORE UPDATE ON legal_laws
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    -- Legal templates trigger
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_legal_templates_updated_at') THEN
        CREATE TRIGGER update_legal_templates_updated_at 
            BEFORE UPDATE ON legal_templates
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Function to cleanup expired cache
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM response_cache WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to search relevant laws
CREATE OR REPLACE FUNCTION search_relevant_laws(
    search_query TEXT,
    max_results INTEGER DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    title VARCHAR(500),
    content TEXT,
    law_number VARCHAR(100),
    source_url VARCHAR(1000),
    relevance REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        l.id,
        l.title,
        l.content,
        l.law_number,
        l.source_url,
        ts_rank(
            to_tsvector('simple', l.title || ' ' || l.content), 
            plainto_tsquery('simple', search_query)
        ) as relevance
    FROM legal_laws l
    WHERE to_tsvector('simple', l.title || ' ' || l.content) @@ plainto_tsquery('simple', search_query)
    ORDER BY relevance DESC
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- Function to search relevant articles
CREATE OR REPLACE FUNCTION search_relevant_articles(
    search_query TEXT,
    max_results INTEGER DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    law_id UUID,
    article_number VARCHAR(50),
    title VARCHAR(500),
    content TEXT,
    law_title VARCHAR(500),
    relevance REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.id,
        a.law_id,
        a.article_number,
        a.title,
        a.content,
        l.title as law_title,
        ts_rank(
            to_tsvector('simple', a.title || ' ' || a.content), 
            plainto_tsquery('simple', search_query)
        ) as relevance
    FROM legal_articles a
    JOIN legal_laws l ON a.law_id = l.id
    WHERE to_tsvector('simple', a.title || ' ' || a.content) @@ plainto_tsquery('simple', search_query)
    ORDER BY relevance DESC
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- Function to get message statistics
CREATE OR REPLACE FUNCTION get_message_stats()
RETURNS TABLE (
    total_messages BIGINT,
    user_messages BIGINT,
    assistant_messages BIGINT,
    messages_today BIGINT,
    messages_week BIGINT,
    avg_tokens NUMERIC,
    total_tokens BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total_messages,
        COUNT(*) FILTER (WHERE role = 'user') as user_messages,
        COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as messages_today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as messages_week,
        AVG(tokens_used) FILTER (WHERE tokens_used > 0) as avg_tokens,
        SUM(tokens_used) as total_tokens
    FROM chat_messages;
END;
$$ LANGUAGE plpgsql;

-- Function to get session statistics
CREATE OR REPLACE FUNCTION get_session_stats()
RETURNS TABLE (
    total_sessions BIGINT,
    active_sessions BIGINT,
    sessions_today BIGINT,
    sessions_week BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total_sessions,
        COUNT(*) FILTER (WHERE is_active = true) as active_sessions,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as sessions_today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as sessions_week
    FROM chat_sessions;
END;
$$ LANGUAGE plpgsql;

-- Function to get legal knowledge statistics
CREATE OR REPLACE FUNCTION get_legal_knowledge_stats()
RETURNS TABLE (
    total_laws BIGINT,
    total_articles BIGINT,
    total_precedents BIGINT,
    total_consultations BIGINT,
    total_templates BIGINT,
    cache_hit_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        (SELECT COUNT(*) FROM legal_laws) as total_laws,
        (SELECT COUNT(*) FROM legal_articles) as total_articles,
        (SELECT COUNT(*) FROM legal_precedents) as total_precedents,
        (SELECT COUNT(*) FROM legal_consultations) as total_consultations,
        (SELECT COUNT(*) FROM legal_templates) as total_templates,
        (SELECT 
            CASE 
                WHEN COUNT(*) = 0 THEN 0
                ELSE ROUND(COUNT(*) FILTER (WHERE expires_at > NOW())::NUMERIC / COUNT(*)::NUMERIC * 100, 2)
            END
         FROM response_cache
        ) as cache_hit_rate;
END;
$$ LANGUAGE plpgsql;

-- Insert sample data
INSERT INTO legal_templates (name, description, category, template_content, fields, law_references) VALUES
('Договір купівлі-продажу нерухомості', 'Шаблон договору купівлі-продажу нерухомого майна', 'Цивільне право', 
'ДОГОВІР КУПІВЛІ-ПРОДАЖУ НЕРУХОМОГО МАЙНА...', 
'[{"id": "seller_name", "label": "ПІБ продавця", "type": "text", "required": true}]',
'["ЦК України ст. 656", "Закон про державну реєстрацію речових прав на нерухоме майно"]'),
('Трудовий договір', 'Базовий трудовий договір', 'Трудове право',
'ТРУДОВИЙ ДОГОВІР...',
'[{"id": "employee_name", "label": "ПІБ працівника", "type": "text", "required": true}]',
'["КЗпП України ст. 21", "КЗпП України ст. 22"]')
ON CONFLICT DO NOTHING;

-- Insert sample consultations
INSERT INTO legal_consultations (question, answer, category, keywords, law_references, quality_score) VALUES
('Як оформити договір купівлі-продажу нерухомості?', 
'Договір купівлі-продажу нерухомості оформляється в письмовій формі згідно зі ст. 656 ЦК України. Договір повинен містити: предмет договору, ціну, строки виконання, права та обов''язки сторін. Після підписання договір підлягає державній реєстрації.',
'цивільне право',
'["договір", "купівля", "продаж", "нерухомість", "оформлення"]',
'["ЦК України ст. 656", "Закон про державну реєстрацію речових прав на нерухоме майно"]',
4),
('Які права має працівник при звільненні?',
'При звільненні працівник має право на: виплату заробітної плати за відпрацьований час, компенсацію за невикористану відпустку, вихідну допомогу (у випадках, передбачених законом). Згідно зі ст. 45 КЗпП України, роботодавець зобов''язаний видати трудову книжку та довідку про роботу.',
'трудове право',
'["звільнення", "працівник", "права", "компенсація", "трудова книжка"]',
'["КЗпП України ст. 45", "КЗпП України ст. 24"]',
4)
ON CONFLICT DO NOTHING;

-- Enable Row Level Security (RLS)
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view their own sessions" ON chat_sessions
    FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can create sessions" ON chat_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can update their own sessions" ON chat_sessions
    FOR UPDATE USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can delete their own sessions" ON chat_sessions
    FOR DELETE USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can view messages from their sessions" ON chat_messages
    FOR SELECT USING (
        session_id IN (
            SELECT id FROM chat_sessions 
            WHERE user_id = auth.uid() OR user_id IS NULL
        )
    );

CREATE POLICY "Users can create messages in their sessions" ON chat_messages
    FOR INSERT WITH CHECK (
        session_id IN (
            SELECT id FROM chat_sessions 
            WHERE user_id = auth.uid() OR user_id IS NULL
        )
    );

-- Create storage bucket for cache (if not exists)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('cache', 'cache', false)
ON CONFLICT (id) DO NOTHING;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
