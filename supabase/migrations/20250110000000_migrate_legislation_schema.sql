-- Migration: Create legislation schema in supabase-legislation project
-- This migration creates all legislation-related tables, indexes, functions, and triggers
-- Date: 2025-01-10

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- TABLES
-- ============================================================================

-- Legal laws table (parent table)
CREATE TABLE IF NOT EXISTS legal_laws (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    source_url VARCHAR(1000) UNIQUE NOT NULL,
    law_number VARCHAR(100),
    date_created DATE,
    keywords JSONB DEFAULT '[]'::jsonb,
    articles JSON,
    category VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    codex_type VARCHAR(20),
    is_procedural BOOLEAN DEFAULT false,
    CONSTRAINT legal_laws_codex_type_check CHECK (codex_type IS NULL OR length(codex_type) <= 20)
);

COMMENT ON COLUMN legal_laws.codex_type IS 'Тип кодексу: ККУ, КПК, ЦК, ТК, СК, тощо';
COMMENT ON COLUMN legal_laws.is_procedural IS 'Чи це процесуальний кодекс (для розрізнення ККУ/КПК)';

-- Legal articles table (child of legal_laws)
CREATE TABLE IF NOT EXISTS legal_articles (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    law_id UUID REFERENCES legal_laws(id) ON DELETE CASCADE,
    article_number VARCHAR(50),
    title VARCHAR(500),
    content TEXT NOT NULL,
    keywords JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    codex_type VARCHAR(20)
);

COMMENT ON COLUMN legal_articles.codex_type IS 'Тип кодексу для швидкого фільтрування';

-- Legal documents storage table
CREATE TABLE IF NOT EXISTS legal_documents_storage (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    rada_dokid INTEGER,
    rada_nreg VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(500) NOT NULL,
    law_number VARCHAR(100),
    document_type VARCHAR(100),
    codex_type VARCHAR(50),
    is_procedural BOOLEAN DEFAULT false,
    storage_path TEXT,
    storage_bucket VARCHAR(100) DEFAULT 'legal-documents'::character varying,
    category VARCHAR(100),
    keywords JSONB DEFAULT '[]'::jsonb,
    date_created DATE,
    date_updated DATE,
    rada_datred DATE,
    last_synced_at TIMESTAMP WITH TIME ZONE,
    next_sync_at TIMESTAMP WITH TIME ZONE,
    file_size BIGINT,
    articles_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    sync_status VARCHAR(50) DEFAULT 'pending'::character varying,
    sync_error TEXT,
    source_url VARCHAR(1000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    theme_code TEXT
);

-- Legal consultations table
CREATE TABLE IF NOT EXISTS legal_consultations (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category VARCHAR(100),
    keywords JSONB DEFAULT '[]'::jsonb,
    law_references JSONB DEFAULT '[]'::jsonb,
    quality_score INTEGER DEFAULT 0 CHECK (quality_score >= 0 AND quality_score <= 5),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Legal templates table
CREATE TABLE IF NOT EXISTS legal_templates (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    template_content TEXT NOT NULL,
    fields JSONB DEFAULT '[]'::jsonb,
    law_references JSONB DEFAULT '[]'::jsonb,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Response cache table (optional - contains law_references)
CREATE TABLE IF NOT EXISTS response_cache (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    question_hash VARCHAR(64) UNIQUE NOT NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    law_references JSONB DEFAULT '[]'::jsonb,
    tokens_used INTEGER DEFAULT 0,
    quality_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (now() + INTERVAL '7 days')
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Legal laws indexes
CREATE INDEX IF NOT EXISTS idx_legal_laws_pkey ON legal_laws USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS legal_laws_source_url_key ON legal_laws USING btree (source_url);
CREATE INDEX IF NOT EXISTS idx_legal_laws_title_gin ON legal_laws USING gin (to_tsvector('simple'::regconfig, (title)::text));
CREATE INDEX IF NOT EXISTS idx_legal_laws_content_gin ON legal_laws USING gin (to_tsvector('simple'::regconfig, content));
CREATE INDEX IF NOT EXISTS idx_legal_laws_keywords_gin ON legal_laws USING gin (keywords);
CREATE INDEX IF NOT EXISTS idx_legal_laws_category ON legal_laws USING btree (category);
CREATE INDEX IF NOT EXISTS idx_legal_laws_codex_type ON legal_laws USING btree (codex_type);
CREATE INDEX IF NOT EXISTS idx_legal_laws_codex_procedural ON legal_laws USING btree (codex_type, is_procedural) WHERE (codex_type IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_legal_laws_is_procedural ON legal_laws USING btree (is_procedural);
CREATE INDEX IF NOT EXISTS idx_legal_laws_law_number ON legal_laws USING btree (law_number);
CREATE INDEX IF NOT EXISTS idx_legal_laws_law_number_articles ON legal_laws USING btree (law_number) WHERE (articles IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_legal_laws_category_articles ON legal_laws USING btree (category, ((articles IS NOT NULL))) WHERE (articles IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_legal_laws_title_codex ON legal_laws USING btree (title text_pattern_ops) WHERE ((title)::text !~~* '%процесуальний%'::text);
CREATE INDEX IF NOT EXISTS idx_legal_laws_codex_search ON legal_laws USING btree (title, category) WHERE ((title)::text ~~* '%кодекс%'::text);
CREATE INDEX IF NOT EXISTS idx_legal_laws_articles_path_gin ON legal_laws USING gin (((articles)::jsonb) jsonb_path_ops);

-- Legal articles indexes
CREATE UNIQUE INDEX IF NOT EXISTS legal_articles_pkey ON legal_articles USING btree (id);
CREATE INDEX IF NOT EXISTS idx_legal_articles_law_id ON legal_articles USING btree (law_id);
CREATE INDEX IF NOT EXISTS idx_legal_articles_number ON legal_articles USING btree (article_number);
CREATE INDEX IF NOT EXISTS idx_legal_articles_codex_type ON legal_articles USING btree (codex_type);
CREATE INDEX IF NOT EXISTS idx_legal_articles_codex_article ON legal_articles USING btree (codex_type, article_number) WHERE (codex_type IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_articles_law_article_unique ON legal_articles USING btree (law_id, article_number) WHERE ((law_id IS NOT NULL) AND (article_number IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS legal_articles_law_article_unique ON legal_articles USING btree (law_id, article_number);
CREATE INDEX IF NOT EXISTS idx_legal_articles_content_gin ON legal_articles USING gin (to_tsvector('simple'::regconfig, content));
CREATE INDEX IF NOT EXISTS idx_legal_articles_keywords_gin ON legal_articles USING gin (keywords);

-- Legal documents storage indexes
CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_storage_pkey ON legal_documents_storage USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_storage_rada_nreg_key ON legal_documents_storage USING btree (rada_nreg);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_rada_dokid ON legal_documents_storage USING btree (rada_dokid);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_rada_nreg ON legal_documents_storage USING btree (rada_nreg);
CREATE INDEX IF NOT EXISTS idx_legal_documents_storage_rada_nreg ON legal_documents_storage USING btree (rada_nreg);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_codex_type ON legal_documents_storage USING btree (codex_type);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_is_active ON legal_documents_storage USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_sync_status ON legal_documents_storage USING btree (sync_status);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_next_sync ON legal_documents_storage USING btree (next_sync_at);
CREATE INDEX IF NOT EXISTS idx_legal_documents_storage_category ON legal_documents_storage USING btree (category);
CREATE INDEX IF NOT EXISTS idx_legal_documents_storage_theme ON legal_documents_storage USING btree (theme_code);
CREATE INDEX IF NOT EXISTS idx_legal_docs_storage_keywords_gin ON legal_documents_storage USING gin (keywords);

-- Legal consultations indexes
CREATE UNIQUE INDEX IF NOT EXISTS legal_consultations_pkey ON legal_consultations USING btree (id);
CREATE INDEX IF NOT EXISTS idx_legal_consultations_category ON legal_consultations USING btree (category);
CREATE INDEX IF NOT EXISTS idx_legal_consultations_question_gin ON legal_consultations USING gin (to_tsvector('simple'::regconfig, question));
CREATE INDEX IF NOT EXISTS idx_legal_consultations_answer_gin ON legal_consultations USING gin (to_tsvector('simple'::regconfig, answer));

-- Legal templates indexes
CREATE UNIQUE INDEX IF NOT EXISTS legal_templates_pkey ON legal_templates USING btree (id);

-- Response cache indexes
CREATE UNIQUE INDEX IF NOT EXISTS response_cache_pkey ON response_cache USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS response_cache_question_hash_key ON response_cache USING btree (question_hash);
CREATE INDEX IF NOT EXISTS idx_response_cache_hash ON response_cache USING btree (question_hash);
CREATE INDEX IF NOT EXISTS idx_response_cache_expires ON response_cache USING btree (expires_at);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Function for legal_documents_storage updated_at trigger
CREATE OR REPLACE FUNCTION trg_legal_documents_storage_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Function for legal_documents_storage updated_at trigger (alternative)
CREATE OR REPLACE FUNCTION update_legal_documents_storage_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Function to cleanup expired cache
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM response_cache WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Function to search relevant laws
CREATE OR REPLACE FUNCTION search_relevant_laws(search_query text, max_results integer DEFAULT 10)
RETURNS TABLE(id uuid, title character varying, content text, law_number character varying, source_url character varying, relevance real)
LANGUAGE plpgsql
AS $$
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
$$;

-- Function to search relevant articles
CREATE OR REPLACE FUNCTION search_relevant_articles(search_query text, max_results integer DEFAULT 10)
RETURNS TABLE(id uuid, law_id uuid, article_number character varying, title character varying, content text, law_title character varying, relevance real)
LANGUAGE plpgsql
AS $$
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
$$;

-- Function to search documents by codex article
CREATE OR REPLACE FUNCTION search_documents_by_codex_article(
    p_codex_type character varying, 
    p_article_number character varying DEFAULT NULL::character varying, 
    p_is_procedural boolean DEFAULT NULL::boolean, 
    p_rada_nreg character varying DEFAULT NULL::character varying
)
RETURNS TABLE(
    id uuid, 
    title character varying, 
    law_number character varying, 
    codex_type character varying, 
    storage_path text, 
    source_url character varying, 
    date_updated date, 
    articles_count integer, 
    rada_nreg character varying, 
    category character varying
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        d.id,
        d.title,
        d.law_number,
        d.codex_type,
        d.storage_path,
        d.source_url,
        d.date_updated,
        d.articles_count,
        d.rada_nreg,
        d.category
    FROM legal_documents_storage d
    WHERE d.is_active = true
        AND d.sync_status = 'synced'
        AND d.codex_type = p_codex_type
        AND (p_is_procedural IS NULL OR d.is_procedural = p_is_procedural)
        AND (p_rada_nreg IS NULL OR d.rada_nreg = p_rada_nreg)
    ORDER BY d.date_updated DESC;
END;
$$;

-- Function to search Rada laws
CREATE OR REPLACE FUNCTION search_rada_laws(
    search_query text DEFAULT ''::text, 
    law_status character varying DEFAULT ''::character varying, 
    law_category character varying DEFAULT ''::character varying, 
    limit_count integer DEFAULT 10
)
RETURNS TABLE(
    id uuid, 
    title character varying, 
    law_number character varying, 
    dokid character varying, 
    nreg character varying, 
    status character varying, 
    category character varying, 
    date_created date, 
    datred date, 
    source_url character varying, 
    types jsonb, 
    organs jsonb, 
    minjust boolean, 
    relevance real
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        l.id,
        l.title,
        l.law_number,
        NULL::character varying as dokid,
        NULL::character varying as nreg,
        NULL::character varying as status,
        l.category,
        l.date_created,
        NULL::date as datred,
        l.source_url,
        NULL::jsonb as types,
        NULL::jsonb as organs,
        NULL::boolean as minjust,
        CASE 
            WHEN search_query = '' THEN 1.0
            ELSE ts_rank(to_tsvector('simple', l.title || ' ' || COALESCE(l.content, '')), plainto_tsquery('simple', search_query))
        END as relevance
    FROM legal_laws l
    WHERE 
        (search_query = '' OR to_tsvector('simple', l.title || ' ' || COALESCE(l.content, '')) @@ plainto_tsquery('simple', search_query))
        AND (law_status = '' OR NULL::character varying = law_status)
        AND (law_category = '' OR l.category = law_category)
    ORDER BY relevance DESC, l.updated_at DESC
    LIMIT limit_count;
END;
$$;

-- Function to sync articles from JSON
CREATE OR REPLACE FUNCTION sync_articles_from_json(law_id_param uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    articles_json JSONB;
    article_item JSONB;
    articles_synced INTEGER := 0;
    codex_type_val VARCHAR(20);
    article_num TEXT;
    article_title TEXT;
    article_content TEXT;
BEGIN
    -- Отримуємо articles та codex_type з legal_laws
    SELECT articles::jsonb, codex_type INTO articles_json, codex_type_val
    FROM legal_laws
    WHERE id = law_id_param;
    
    -- Перевіряємо чи є articles
    IF articles_json IS NULL OR jsonb_typeof(articles_json) != 'array' THEN
        RETURN 0;
    END IF;
    
    -- Проходимо по всіх статтях
    FOR article_item IN SELECT * FROM jsonb_array_elements(articles_json)
    LOOP
        article_num := article_item->>'number';
        article_title := COALESCE(article_item->>'title', '');
        article_content := article_item->>'content';
        
        -- Перевіряємо чи є необхідні поля
        IF article_num IS NOT NULL 
           AND article_content IS NOT NULL 
           AND length(article_content) > 20 THEN
            
            -- Вставляємо або оновлюємо статтю
            INSERT INTO legal_articles (
                law_id,
                article_number,
                title,
                content,
                codex_type,
                keywords
            )
            VALUES (
                law_id_param,
                article_num,
                article_title,
                article_content,
                codex_type_val,
                '[]'::jsonb
            )
            ON CONFLICT (law_id, article_number) 
            DO UPDATE SET
                title = EXCLUDED.title,
                content = EXCLUDED.content,
                codex_type = COALESCE(EXCLUDED.codex_type, legal_articles.codex_type);
            
            articles_synced := articles_synced + 1;
        END IF;
    END LOOP;
    
    RETURN articles_synced;
END;
$$;

-- Function to sync all articles from JSON
CREATE OR REPLACE FUNCTION sync_all_articles_from_json()
RETURNS TABLE(law_title character varying, articles_synced integer)
LANGUAGE plpgsql
AS $$
DECLARE
    law_record RECORD;
    synced_count INTEGER;
BEGIN
    FOR law_record IN 
        SELECT id, title 
        FROM legal_laws 
        WHERE articles IS NOT NULL 
        AND jsonb_typeof(articles::jsonb) = 'array'
    LOOP
        synced_count := sync_articles_from_json(law_record.id);
        law_title := law_record.title;
        articles_synced := synced_count;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- Function to get documents for sync
CREATE OR REPLACE FUNCTION get_documents_for_sync(p_limit integer DEFAULT 10)
RETURNS TABLE(
    id uuid, 
    rada_dokid integer, 
    rada_nreg character varying, 
    title character varying, 
    storage_path text, 
    next_sync_at timestamp with time zone
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        d.id,
        d.rada_dokid,
        d.rada_nreg,
        d.title,
        d.storage_path,
        d.next_sync_at
    FROM legal_documents_storage d
    WHERE d.is_active = true
        AND (
            d.next_sync_at IS NULL OR
            d.next_sync_at <= NOW()
        )
        AND d.sync_status IN ('pending', 'synced')
    ORDER BY d.next_sync_at ASC NULLS FIRST
    LIMIT p_limit;
END;
$$;

-- Function to update sync status
CREATE OR REPLACE FUNCTION update_sync_status(
    p_rada_dokid integer, 
    p_sync_status character varying, 
    p_next_sync_at timestamp with time zone DEFAULT NULL::timestamp with time zone, 
    p_sync_error text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE legal_documents_storage
    SET 
        sync_status = p_sync_status,
        last_synced_at = NOW(),
        next_sync_at = COALESCE(p_next_sync_at, NOW() + INTERVAL '3 days'),
        sync_error = p_sync_error,
        updated_at = NOW()
    WHERE (p_rada_dokid IS NULL OR rada_dokid = p_rada_dokid)
        OR (p_rada_dokid IS NULL AND id IN (
            SELECT id FROM legal_documents_storage 
            WHERE sync_status IN ('pending', 'updating')
            LIMIT 1
        ));
END;
$$;

-- Function to update sync status by nreg
CREATE OR REPLACE FUNCTION update_sync_status_by_nreg(
    p_rada_nreg character varying, 
    p_sync_status character varying, 
    p_next_sync_at timestamp with time zone DEFAULT NULL::timestamp with time zone, 
    p_sync_error text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE legal_documents_storage
    SET 
        sync_status = p_sync_status,
        last_synced_at = NOW(),
        next_sync_at = COALESCE(p_next_sync_at, NOW() + INTERVAL '3 days'),
        sync_error = p_sync_error,
        updated_at = NOW()
    WHERE rada_nreg = p_rada_nreg;
END;
$$;

-- Function to get legal knowledge stats
CREATE OR REPLACE FUNCTION get_legal_knowledge_stats()
RETURNS TABLE(
    total_laws bigint, 
    total_articles bigint, 
    total_precedents bigint, 
    total_consultations bigint, 
    total_templates bigint, 
    cache_hit_rate numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        (SELECT COUNT(*) FROM legal_laws) as total_laws,
        (SELECT COUNT(*) FROM legal_articles) as total_articles,
        (SELECT 0::bigint) as total_precedents, -- legal_precedents не мігрується
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
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Trigger for legal_laws updated_at
DROP TRIGGER IF EXISTS update_legal_laws_updated_at ON legal_laws;
CREATE TRIGGER update_legal_laws_updated_at 
    BEFORE UPDATE ON legal_laws
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for legal_templates updated_at
DROP TRIGGER IF EXISTS update_legal_templates_updated_at ON legal_templates;
CREATE TRIGGER update_legal_templates_updated_at 
    BEFORE UPDATE ON legal_templates
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for legal_documents_storage updated_at
DROP TRIGGER IF EXISTS legal_documents_storage_updated_at_trg ON legal_documents_storage;
DROP TRIGGER IF EXISTS update_legal_documents_storage_updated_at ON legal_documents_storage;
CREATE TRIGGER legal_documents_storage_updated_at_trg
    BEFORE UPDATE ON legal_documents_storage
    FOR EACH ROW
    EXECUTE FUNCTION trg_legal_documents_storage_updated_at();

-- ============================================================================
-- GRANTS (if needed)
-- ============================================================================

-- Grant permissions to service_role and authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_laws TO service_role;
GRANT SELECT ON legal_laws TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON legal_articles TO service_role;
GRANT SELECT ON legal_articles TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON legal_documents_storage TO service_role;
GRANT SELECT ON legal_documents_storage TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON legal_consultations TO service_role;
GRANT SELECT ON legal_consultations TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON legal_templates TO service_role;
GRANT SELECT ON legal_templates TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON response_cache TO service_role;
GRANT SELECT ON response_cache TO authenticated;

