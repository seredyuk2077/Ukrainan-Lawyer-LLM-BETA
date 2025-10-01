const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://lhltmmzwvikdgxxakbcl.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxobHRtbXp3dmlrZGd4eGFrYmNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg5MDI1ODksImV4cCI6MjA3NDQ3ODU4OX0.e7KwgbRDSxzugIuNoM-aFnMYXrgDSRrOOd6LKRsbvMQ';

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Відсутні Supabase змінні середовища. Перевірте SUPABASE_URL та SUPABASE_SERVICE_ROLE_KEY');
}

// Create Supabase client with service role key for backend operations
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Database query helper (Supabase style)
const query = async (table, operation, options = {}) => {
  const start = Date.now();
  try {
    let result;
    
    switch (operation) {
      case 'select':
        let query = supabase
          .from(table)
          .select(options.select || '*');
          
        if (options.eq?.column && options.eq?.value !== undefined) {
          query = query.eq(options.eq.column, options.eq.value);
        }
        
        if (options.in?.column && options.in?.values) {
          query = query.in(options.in.column, options.in.values);
        }
        
        if (options.order?.column) {
          query = query.order(options.order.column, { ascending: options.order.ascending });
        }
        
        if (options.limit) {
          query = query.limit(options.limit);
        }
        
        if (options.range?.from !== undefined && options.range?.to !== undefined) {
          query = query.range(options.range.from, options.range.to);
        }
        
        result = await query;
        break;
        
      case 'insert':
        result = await supabase
          .from(table)
          .insert(options.data)
          .select(options.select || '*');
        break;
        
      case 'update':
        let updateQuery = supabase
          .from(table)
          .update(options.data);
          
        if (options.eq?.column && options.eq?.value !== undefined) {
          updateQuery = updateQuery.eq(options.eq.column, options.eq.value);
        }
        
        result = await updateQuery.select(options.select || '*');
        break;
        
      case 'delete':
        let deleteQuery = supabase
          .from(table)
          .delete();
          
        if (options.eq?.column && options.eq?.value !== undefined) {
          deleteQuery = deleteQuery.eq(options.eq.column, options.eq.value);
        }
        
        result = await deleteQuery;
        break;
        
      case 'upsert':
        result = await supabase
          .from(table)
          .upsert(options.data, { onConflict: options.onConflict })
          .select(options.select || '*');
        break;
        
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
    
    const duration = Date.now() - start;
    logger.debug('Executed Supabase query', { table, operation, duration, rows: result.data?.length });
    
    if (result.error) {
      throw new Error(result.error.message);
    }
    
    return {
      rows: result.data || [],
      rowCount: result.data?.length || 0,
      data: result.data
    };
    
  } catch (err) {
    logger.error('Supabase query error:', { table, operation, error: err.message });
    throw err;
  }
};

// Transaction helper (Supabase doesn't support transactions in the same way, but we can simulate)
const transaction = async (callback) => {
  try {
    // Supabase handles transactions automatically for single operations
    // For multiple operations, we'll execute them sequentially
    const result = await callback({
      query: (table, operation, options) => query(table, operation, options)
    });
    return result;
  } catch (err) {
    logger.error('Transaction error:', err);
    throw err;
  }
};

// Cache helpers (using Supabase storage or a simple in-memory cache)
const cache = {
  // Simple in-memory cache for development
  _cache: new Map(),
  
  async get(key) {
    try {
      // Try to get from Supabase storage first
      const { data, error } = await supabase.storage
        .from('cache')
        .download(key);
        
      if (error || !data) {
        // Fallback to in-memory cache
        const value = this._cache.get(key);
        return value ? JSON.parse(value) : null;
      }
      
      const text = await data.text();
      return JSON.parse(text);
    } catch (err) {
      logger.error('Cache get error:', err);
      return null;
    }
  },

  async set(key, value, ttl = 3600) {
    try {
      const data = JSON.stringify(value);
      
      // Try to store in Supabase storage
      const { error } = await supabase.storage
        .from('cache')
        .upload(key, data, {
          cacheControl: `${ttl}`,
          upsert: true
        });
        
      if (error) {
        // Fallback to in-memory cache
        this._cache.set(key, data);
        // Set expiration
        setTimeout(() => this._cache.delete(key), ttl * 1000);
      }
    } catch (err) {
      logger.error('Cache set error:', err);
      // Fallback to in-memory cache
      this._cache.set(key, JSON.stringify(value));
    }
  },

  async del(key) {
    try {
      // Try to delete from Supabase storage
      await supabase.storage
        .from('cache')
        .remove([key]);
        
      // Also delete from in-memory cache
      this._cache.delete(key);
    } catch (err) {
      logger.error('Cache delete error:', err);
      this._cache.delete(key);
    }
  },

  async keys(pattern) {
    try {
      // For in-memory cache, return all keys matching pattern
      const regex = new RegExp(pattern.replace('*', '.*'));
      return Array.from(this._cache.keys()).filter(key => regex.test(key));
    } catch (err) {
      logger.error('Cache keys error:', err);
      return [];
    }
  }
};

// Health check functions
const checkDatabaseHealth = async () => {
  try {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('count')
      .limit(1);
      
    if (error) {
      return { status: 'unhealthy', message: error.message };
    }
    
    return { status: 'healthy', message: 'Supabase connection OK' };
  } catch (err) {
    return { status: 'unhealthy', message: err.message };
  }
};

const checkRedisHealth = async () => {
  // Redis is not used with Supabase, so we'll return healthy
  return { status: 'healthy', message: 'Cache system OK' };
};

// Initialize cache bucket
const initializeCache = async () => {
  try {
    // Create cache bucket if it doesn't exist
    const { data, error } = await supabase.storage
      .createBucket('cache', {
        public: false,
        fileSizeLimit: 50 * 1024 * 1024, // 50MB
        allowedMimeTypes: ['application/json']
      });
      
    if (error && !error.message.includes('already exists')) {
      logger.warn('Could not create cache bucket:', error.message);
    } else {
      logger.info('Cache bucket initialized');
    }
  } catch (err) {
    logger.warn('Cache initialization failed:', err.message);
  }
};

// Initialize on module load
initializeCache();

module.exports = {
  supabase,
  query,
  transaction,
  cache,
  checkDatabaseHealth,
  checkRedisHealth
};
