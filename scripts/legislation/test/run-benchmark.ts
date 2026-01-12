
import dotenv from 'dotenv';
// Load environment variables immediately at the top
dotenv.config();

import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import { resolve } from 'path';

// Reuse existing R2 client logic
import { createR2Client, getLegislationBucket } from '../lib/r2Client';

const program = new Command();

// --- CONFIGURATION ---

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// --- TYPES ---

interface SearchResult {
    document_nreg: string;
    article_number: string;
    text: string;
    similarity: number;
    r2_key: string;
    json_path: string;
}

interface TestCase {
    category: string;
    query: string;
    expected_article?: string;
    expected_keywords?: string[];
}

// --- CLIENT FACTORIES ---

function getSupabaseClient() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Missing Supabase credentials");
    }
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function getOpenAIClient(apiKey: string) {
    return new OpenAI({
        apiKey: apiKey,
        baseURL: "https://openrouter.ai/api/v1",
    });
}

// --- EMBEDDINGS ---

async function generateEmbeddingsBatch(texts: string[], apiKey: string) {
    const openai = getOpenAIClient(apiKey);
    const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
        encoding_format: "float",
    });
    return response.data;
}

// --- LLM EXPANSION (HyDE-lite) ---

async function expandQueryWithLLM(query: string, apiKey: string): Promise<string> {
    const openai = getOpenAIClient(apiKey);
    try {
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            messages: [
                {
                    role: "system", 
                    content: "You are a legal search assistant for the Constitution of Ukraine. Your goal is to generate relevant keywords, article numbers, and legal concepts that answer the user's query. Output ONLY the keywords and article numbers separated by spaces. Do not write full sentences."
                },
                {
                    role: "user",
                    content: `Query: ${query}`
                }
            ],
            temperature: 0.1,
            max_tokens: 50
        });
        const expanded = completion.choices[0].message.content || query;
        return `${query} ${expanded}`;
    } catch (e) {
        console.warn(chalk.yellow("   -> LLM Expansion failed, using original query."));
        return query;
    }
}

// --- CORE SEARCH LOGIC ---

async function performSearch(query: string, topK: number): Promise<SearchResult[]> {
    const supabase = getSupabaseClient();
    const r2 = createR2Client();
    const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPENROUTER_API_KEY;
    const r2Bucket = getLegislationBucket();

    if (!apiKey) {
        throw new Error("OPEN_ROUTER_API_RAG or OPENROUTER_API_KEY is not set");
    }

    // 0. Detect specific article reference (Regex)
    const articleMatch = query.match(/(?:ст\.?|стаття)\s*(\d+(?:-\d+)?)/i) || 
                         query.match(/^(\d+(?:-\d+)?)\s*(?:ст\.?|стаття)/i);
    
    let exactMatches: any[] = [];
    if (articleMatch) {
        const articleNumber = articleMatch[1];
        
        // Try exact match first
        let { data: dbChunks } = await supabase
            .from('legislation_chunks')
            .select('id, document_nreg, article_number, r2_key, json_path')
            .eq('article_number', articleNumber)
            .limit(5);

        // Fallback for "131-1" -> "1311"
        if ((!dbChunks || dbChunks.length === 0) && articleNumber.includes('-')) {
             const normalized = articleNumber.replace('-', '');
             const { data: retryChunks } = await supabase
                .from('legislation_chunks')
                .select('id, document_nreg, article_number, r2_key, json_path')
                .eq('article_number', normalized)
                .limit(5);
             if (retryChunks) dbChunks = retryChunks;
        }

        if (dbChunks && dbChunks.length > 0) {
            exactMatches = dbChunks.map(chunk => ({
                ...chunk,
                similarity: 2.0 // Boost significantly above vector results
            }));
        }
    }

    // 1. Query Expansion (LLM)
    let searchInput = query;
    if (!articleMatch) {
        searchInput = await expandQueryWithLLM(query, apiKey);
    }

    // 2. Generate embedding
    const embeddings = await generateEmbeddingsBatch([searchInput], apiKey);
    const queryEmbedding = embeddings[0].embedding;

    // 3. Perform vector search (Pool Size: 50)
    // console.log(chalk.gray(`   -> Searching with threshold ${0.01} and count ${50}...`));
    const { data: chunks, error } = await supabase.rpc('match_chunks_v3', {
        query_embedding: queryEmbedding,
        threshold: 0.01,
        max_count: 50,
    });

    if (error) {
        throw new Error(`Supabase RPC error: ${error.message}`);
    }

    // 4. Merge and Deduplicate
    const allChunks = [...exactMatches, ...(chunks || [])];
    const uniqueChunksMap = new Map();
    
    for (const chunk of allChunks) {
        if (!uniqueChunksMap.has(chunk.id)) {
            uniqueChunksMap.set(chunk.id, chunk);
        }
    }
    
    let candidateChunks = Array.from(uniqueChunksMap.values());

    // 5. Retrieve content from R2
    const contentPromises = candidateChunks.map(async (chunk: any) => {
        try {
            const command = new GetObjectCommand({
                Bucket: r2Bucket,
                Key: chunk.r2_key,
            });
            const { Body } = await r2.send(command);
            const content = await Body?.transformToString('utf-8');
            if (!content) return null;
            
            const canonicalDoc = JSON.parse(content);
            const chunkIndex = parseInt(chunk.json_path.match(/\[(\d+)\]/)?.[1] || '0', 10);
            const text = canonicalDoc.content.chunks[chunkIndex]?.text || '';

            return {
                document_nreg: chunk.document_nreg,
                article_number: chunk.article_number,
                text,
                similarity: chunk.similarity,
                r2_key: chunk.r2_key,
                json_path: chunk.json_path,
            };
        } catch (e) {
            console.error(`Failed R2 fetch: ${chunk.r2_key}`, e);
            return null;
        }
    });

    let results = (await Promise.all(contentPromises)).filter(Boolean) as SearchResult[];

    // 6. Client-side Reranking (Keyword Boosting)
    const queryWords = query.toLowerCase().replace(/[^\w\sа-яіїєґ]/gi, '').split(/\s+/).filter(w => w.length > 3);
    
    results = results.map(r => {
        let boost = 0;
        const textLower = r.text.toLowerCase();
        
        if (articleMatch && r.article_number === articleMatch[1]) {
             boost += 1.0; 
        }

        for (const word of queryWords) {
            if (textLower.includes(word)) {
                boost += 0.05;
            }
        }

        if (textLower.includes(query.toLowerCase())) {
            boost += 0.2;
        }

        return { ...r, similarity: r.similarity + boost };
    });

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

// --- REPORT GENERATION ---

async function generateReport(
    results: any[], 
    metrics: { totalQueries: number; totalHits: number; hitRate: number; mrr: number; topK: number }
) {
    const reportPath = resolve(process.cwd(), 'scripts/legislation/test/reports/REPORT.md');
    const problematicCases = results.filter(r => !r.hit && r.expected_article);

    let reportContent = `# Звіт про тестування векторного пошуку (Advanced Hybrid)\n\n`;
    reportContent += `**Дата:** ${new Date().toISOString()}\n\n`;
    
    reportContent += `## 1. Архітектура пошуку\n\n`;
    reportContent += `- **Core:** Supabase Vector Search (\`text-embedding-3-small\`).\n`;
    reportContent += `- **Direct Lookup:** Regex-детектор для номерів статей.\n`;
    reportContent += `- **Query Expansion:** OpenAI \`gpt-4o-mini\` для розширення контексту (HyDE).\n`;
    reportContent += `- **Reranking:** Клієнтський алгоритм Keyword Boosting.\n`;
    reportContent += `- **Pool Size:** 50 кандидатів -> Rerank -> Top-${metrics.topK}.\n\n`;
    
    reportContent += `## 2. Результати\n\n`;
    reportContent += `| Метрика | Значення |\n`;
    reportContent += `|---|---|\n`;
    reportContent += `| Всього запитів | ${metrics.totalQueries} |\n`;
    reportContent += `| Hits | **${metrics.totalHits}** |\n`;
    reportContent += `| Misses | ${metrics.totalQueries - metrics.totalHits} |\n`;
    reportContent += `| **Hit Rate@${metrics.topK}** | **${metrics.hitRate.toFixed(2)}%** |\n`;
    reportContent += `| **MRR@${metrics.topK}** | **${metrics.mrr.toFixed(4)}** |\n\n`;

    reportContent += `## 3. Проблемні кейси (Misses)\n\n`;
    if (problematicCases.length > 0) {
        problematicCases.forEach(pc => {
            reportContent += `***\n\n`;
            reportContent += `**Запит:** \`${pc.query}\`\n`;
            reportContent += `*   **Очікувана стаття:** \`${pc.expected_article}\`\n`;
            reportContent += `*   **Результат:** ❌ **Промах**\n\n`;
            
            if (pc.results.length > 0) {
                reportContent += `**Топ-3 знайдених:**\n\n`;
                reportContent += `| # | Стаття | Score | Фрагмент |\n`;
                reportContent += `|---|---|---|---|\n`;
                pc.results.slice(0, 3).forEach((r: SearchResult, i: number) => {
                    const textFragment = r.text.substring(0, 80).replace(/\|/g, '\\|').replace(/\n/g, ' ');
                    reportContent += `| ${i + 1} | **${r.article_number}** | ${r.similarity.toFixed(2)} | *${textFragment}...* |\n`;
                });
            } else {
                reportContent += `(Нічого не знайдено)\n`;
            }
            reportContent += `\n`;
        });
    } else {
        reportContent += `✅ **Ідеальний результат! Всі очікувані статті знайдені.**\n`;
    }

    await fs.writeFile(reportPath, reportContent);
    console.log(chalk.green(`\nReport generated at: ${reportPath}`));
}

// --- MODES ---

async function runBatchTests(file: string, topK: number) {
    console.log(chalk.blue('\n--- Running Batch Benchmark (Advanced) ---'));
    console.log(`Loading test cases from: ${file}`);
    
    const content = await fs.readFile(file, 'utf-8');
    const testSuites = JSON.parse(content);
    
    let totalQueries = 0;
    let totalHits = 0;
    let totalReciprocalRank = 0;
    const resultsDetails: any[] = [];

    for (const suite of testSuites) {
        console.log(chalk.yellow(`\n--- Category: ${suite.category} ---`));
        
        for (const testCase of suite.cases) {
            totalQueries++;
            console.log(`\nQuery: "${testCase.query}"`);
            
            try {
                const results = await performSearch(testCase.query, topK);
                const expected = testCase.expected_article?.replace('-', '');
                const foundIndex = results.findIndex(r => 
                    r.article_number?.replace('-', '') === expected || 
                    r.article_number === testCase.expected_article
                );
                
                const isHit = foundIndex !== -1;
                
                if (isHit) {
                    totalHits++;
                    totalReciprocalRank += 1 / (foundIndex + 1);
                    console.log(chalk.green(`  -> HIT! Found article ${results[foundIndex].article_number} at position ${foundIndex + 1}.`));
                } else {
                    console.log(chalk.red(`  -> MISS! Expected article ${testCase.expected_article} not found in top ${topK}.`));
                }

                resultsDetails.push({ ...testCase, hit: isHit, results });
            } catch (error: any) {
                console.error(chalk.red(`  -> ERROR: ${error.message}`));
            }
        }
    }

    const hitRate = (totalHits / totalQueries) * 100;
    const mrr = totalReciprocalRank / totalQueries;

    console.log(chalk.blue('\n--- Benchmark Summary ---'));
    console.log(`Total Queries: ${totalQueries}`);
    console.log(`Total Hits:    ${totalHits}`);
    console.log(`Hit Rate@${topK}:   ${hitRate.toFixed(2)}%`);
    console.log(`MRR@${topK}:        ${mrr.toFixed(4)}`);

    await generateReport(resultsDetails, { totalQueries, totalHits, hitRate, mrr, topK });
}

async function runInteractiveMode(topK: number) {
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log(chalk.blue('\n--- Interactive Search Mode (Advanced) ---'));
    console.log('Type your query and press Enter. Type "exit" to quit.\n');

    const askQuestion = () => {
        readline.question(chalk.green('Query: '), async (query: string) => {
            if (query.toLowerCase() === 'exit') {
                readline.close();
                process.exit(0);
            }

            try {
                const results = await performSearch(query, topK);
                console.log(`\nFound ${results.length} results:\n`);
                results.forEach((r, i) => {
                    console.log(`${i + 1}. [Art. ${chalk.bold(r.article_number)}] (Score: ${r.similarity.toFixed(2)})`);
                    console.log(`   ${chalk.gray(r.text.substring(0, 150).replace(/\n/g, ' '))}...\n`);
                });
            } catch (error: any) {
                console.error(chalk.red(`Error: ${error.message}`));
            }
            askQuestion();
        });
    };
    askQuestion();
}

// --- CLI ENTRY POINT ---

program
    .name('legislation-search')
    .description('CLI for searching legislation chunks');

program
    .command('batch')
    .description('Run batch benchmark tests')
    .option('--file <path>', 'Path to test cases JSON', 'scripts/legislation/test/test-cases-advanced.json')
    .option('--topK <number>', 'Number of results to retrieve', '10')
    .action(async (options) => {
        await runBatchTests(resolve(process.cwd(), options.file), parseInt(options.topK));
    });

program
    .command('interactive')
    .description('Run interactive search')
    .option('--topK <number>', 'Number of results to retrieve', '5')
    .action(async (options) => {
        await runInteractiveMode(parseInt(options.topK));
    });

program.parse(process.argv);
