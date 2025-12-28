const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

// Supabase Legislation configuration (separate project for legislation data)
const legislationUrl = process.env.SUPABASE_LEGISLATION_URL;
const legislationServiceKey = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY || 
                               process.env.SUPABASE_LEGISLATION_ANON_KEY;

if (!legislationUrl || !legislationServiceKey) {
  logger.warn('⚠️ Legislation Supabase environment variables not set. Legislation queries will fail.');
  logger.warn('   Please set SUPABASE_LEGISLATION_URL and SUPABASE_LEGISLATION_SERVICE_ROLE_KEY');
}

// Create Supabase Legislation client with service role key for backend operations
const legislationSupabase = legislationUrl && legislationServiceKey
  ? createClient(legislationUrl, legislationServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

// Database query helper for legislation tables (Supabase style)
const queryLegislation = async (table, operation, options = {}) => {
  if (!legislationSupabase) {
    throw new Error('Legislation Supabase client is not configured. Please set SUPABASE_LEGISLATION_URL and SUPABASE_LEGISLATION_SERVICE_ROLE_KEY');
  }

  const start = Date.now();
  try {
    let result;
    
    switch (operation) {
      case 'select':
        let query = legislationSupabase
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
        result = await legislationSupabase
          .from(table)
          .insert(options.data)
          .select(options.select || '*');
        break;
        
      case 'update':
        let updateQuery = legislationSupabase
          .from(table)
          .update(options.data);
          
        if (options.eq?.column && options.eq?.value !== undefined) {
          updateQuery = updateQuery.eq(options.eq.column, options.eq.value);
        }
        
        result = await updateQuery.select(options.select || '*');
        break;
        
      case 'delete':
        let deleteQuery = legislationSupabase
          .from(table)
          .delete();
          
        if (options.eq?.column && options.eq?.value !== undefined) {
          deleteQuery = deleteQuery.eq(options.eq.column, options.eq.value);
        }
        
        result = await deleteQuery;
        break;
        
      case 'upsert':
        result = await legislationSupabase
          .from(table)
          .upsert(options.data, { onConflict: options.onConflict })
          .select(options.select || '*');
        break;
        
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
    
    const duration = Date.now() - start;
    logger.debug('Executed Legislation Supabase query', { table, operation, duration, rows: result.data?.length });
    
    if (result.error) {
      throw new Error(result.error.message);
    }
    
    return {
      rows: result.data || [],
      rowCount: result.data?.length || 0,
      data: result.data
    };
    
  } catch (err) {
    logger.error('Legislation Supabase query error:', { table, operation, error: err.message });
    throw err;
  }
};

module.exports = {
  legislationSupabase,
  queryLegislation
};

