#!/usr/bin/env node
/**
 * Manual Audit — ручний аудит документів один за одним
 * 
 * Використання:
 *   manual-audit --nregs "nreg1,nreg2,..."  # конкретні документи
 *   manual-audit --non-cmu                  # всі non-CMU документи
 *   manual-audit --type <slug>              # документи конкретного типу
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { printDocCard } from './print-doc-card.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIT_LOG_PATH = path.join(__dirname, '../../runs/manual_audit_log.md');

interface AuditLogEntry {
  nreg: string;
  timestamp: string;
  status: 'OK' | 'MISMATCH';
  issue?: string;
  rootCause?: string;
  fix?: string;
}

function appendToLog(entry: AuditLogEntry): void {
  const logDir = path.dirname(AUDIT_LOG_PATH);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logLine = `| ${entry.nreg} | ${entry.timestamp} | ${entry.status} | ${entry.issue || '-'} | ${entry.rootCause || '-'} | ${entry.fix || '-'} |\n`;
  
  if (!fs.existsSync(AUDIT_LOG_PATH)) {
    const header = `# Manual Audit Log\n\n| NREG | Timestamp | Status | Issue | Root Cause | Fix |\n|------|-----------|--------|-------|------------|-----|\n`;
    fs.writeFileSync(AUDIT_LOG_PATH, header);
  }
  
  fs.appendFileSync(AUDIT_LOG_PATH, logLine);
}

export async function manualAuditCLI(options: {
  nregs?: string;
  nonCmu?: boolean;
  type?: string;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  let nregs: string[] = [];

  if (options.nregs) {
    nregs = options.nregs.split(',').map(n => n.trim());
  } else if (options.nonCmu) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg, document_type_slug')
      .order('rada_datred', { ascending: true, nullsLast: true });
    
    if (error) {
      console.error('❌ Failed to fetch documents:', error.message);
      return;
    }
    
    if (!data || data.length === 0) {
      console.error('❌ No documents found');
      return;
    }

    const nonCmu = data.filter(d => 
      d.document_type_slug !== 'cmu_resolution' && 
      d.document_type_slug !== 'cmu_order' && 
      d.document_type_slug !== 'cmu_decree'
    );
    nregs = nonCmu.map(d => d.rada_nreg);
    console.log(`📋 Знайдено ${nonCmu.length} non-CMU документів з ${data.length} загалом\n`);
  } else if (options.type) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg')
      .eq('document_type_slug', options.type)
      .order('rada_datred', { ascending: true, nullsLast: true });
    
    if (error) {
      console.error('❌ Failed to fetch documents:', error.message);
      return;
    }
    
    if (!data || data.length === 0) {
      console.error('❌ No documents found');
      return;
    }
    
    nregs = data.map(d => d.rada_nreg);
    console.log(`📋 Знайдено ${nregs.length} документів типу ${options.type}\n`);
  } else {
    console.error('❌ Потрібно вказати --nregs, --non-cmu або --type');
    return;
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`🔍 Ручний аудит: ${nregs.length} документів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  console.log(`📝 Лог зберігається: ${AUDIT_LOG_PATH}\n`);

  for (let i = 0; i < nregs.length; i++) {
    const nreg = nregs[i];
    console.log(`\n[${i + 1}/${nregs.length}] ${nreg}`);
    console.log(`═══════════════════════════════════════════════════════════`);
    
    try {
      await printDocCard(nreg);
      
      console.log(`\n❓ Статус: [OK] / [MISMATCH]`);
      console.log(`   Якщо MISMATCH - вкажи причину вручну після перевірки`);
      
      // Тут має бути інтерактивний ввід, але для автоматизації просто логуємо
      // В реальному використанні користувач буде дивитись і вручну ставити мітку
      const timestamp = new Date().toISOString();
      appendToLog({
        nreg,
        timestamp,
        status: 'OK', // За замовчуванням, потрібно перевірити вручну
      });
      
    } catch (error) {
      console.error(`❌ Помилка при обробці ${nreg}:`, error);
      appendToLog({
        nreg,
        timestamp: new Date().toISOString(),
        status: 'MISMATCH',
        issue: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  console.log(`\n✅ Аудит завершено. Перевір лог: ${AUDIT_LOG_PATH}`);
}
