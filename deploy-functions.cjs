#!/usr/bin/env node

/**
 * 🚀 Автоматичне деплоювання Supabase Edge Functions
 * 
 * Цей скрипт дозволяє швидко деплоїти функції без ручного копіювання через інтерфейс
 * 
 * Використання:
 * - node deploy-functions.js                    # Деплой всіх функцій
 * - node deploy-functions.js app_78e3d871a2_chat # Деплой конкретної функції
 * - npm run deploy                              # Через npm скрипт
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Кольори для консолі
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n${step} ${message}`, 'cyan');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function execCommand(command, description) {
  try {
    logStep('🔄', description);
    const output = execSync(command, { 
      encoding: 'utf8', 
      stdio: 'pipe',
      cwd: process.cwd()
    });
    return output;
  } catch (error) {
    logError(`Помилка виконання команди: ${command}`);
    logError(error.message);
    if (error.stdout) {
      console.log('STDOUT:', error.stdout);
    }
    if (error.stderr) {
      console.log('STDERR:', error.stderr);
    }
    throw error;
  }
}

function checkSupabaseAuth() {
  // Перевіряємо чи є правильний access token
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  
  if (!accessToken) {
    logError('SUPABASE_ACCESS_TOKEN не встановлено');
    showTokenInstructions();
    return false;
  }
  
  if (!accessToken.startsWith('sbp_')) {
    logError('Неправильний формат токену. Токен має починатися з "sbp_"');
    showTokenInstructions();
    return false;
  }
  
  logSuccess('✅ Access token знайдено');
  logSuccess('✅ Проєкт: lhltmmzwvikdgxxakbcl');
  
  return true;
}

function showTokenInstructions() {
  log('\n🔑 Як отримати Supabase Access Token:', 'yellow');
  log('', 'reset');
  log('1. Відкрийте: https://supabase.com/dashboard', 'cyan');
  log('2. Оберіть ваш проєкт', 'cyan');
  log('3. Settings → API → Project API keys → service_role (скопіювати)', 'cyan');
  log('', 'reset');
  log('АБО:', 'yellow');
  log('', 'reset');
  log('1. Клікніть на аватар → Account Settings', 'cyan');
  log('2. Access Tokens → Generate new token', 'cyan');
  log('', 'reset');
  log('Потім встановіть токен:', 'yellow');
  log('export SUPABASE_ACCESS_TOKEN=sbp_ваш_токен_тут', 'green');
  log('', 'reset');
  log('📖 Детальні інструкції: GET_SUPABASE_TOKEN.md', 'blue');
}

function getFunctions() {
  const functionsDir = path.join(process.cwd(), 'supabase', 'functions');
  
  if (!fs.existsSync(functionsDir)) {
    logError(`Директорія функцій не знайдена: ${functionsDir}`);
    return [];
  }
  
  const functions = fs.readdirSync(functionsDir)
    .filter(item => {
      const itemPath = path.join(functionsDir, item);
      return fs.statSync(itemPath).isDirectory() && 
             fs.existsSync(path.join(itemPath, 'index.ts'));
    });
  
  return functions;
}

function deployFunction(functionName) {
  try {
    logStep('🚀', `Деплоювання функції: ${functionName}`);
    
    // Перевіряємо чи існує функція
    const functionPath = path.join(process.cwd(), 'supabase', 'functions', functionName);
    if (!fs.existsSync(functionPath)) {
      logError(`Функція не знайдена: ${functionName}`);
      return false;
    }
    
    // Автоматично підключаємося до проєкту
    try {
      logStep('🔗', 'Підключення до проєкту...');
      execCommand('supabase link --project-ref lhltmmzwvikdgxxakbcl', 'Підключення до проєкту lhltmmzwvikdgxxakbcl');
      logSuccess('Підключено до проєкту!');
    } catch (error) {
      // Можливо вже підключено, спробуємо деплоїти
      logWarning('Проєкт може бути вже підключений, продовжуємо...');
    }
    
    // Деплоїмо функцію
    const output = execCommand(
      `supabase functions deploy ${functionName}`,
      `Деплоювання ${functionName}...`
    );
    
    logSuccess(`Функція ${functionName} успішно деплоїна!`);
    
    // Показуємо URL функції
    if (output.includes('https://')) {
      const urlMatch = output.match(/https:\/\/[^\s]+/);
      if (urlMatch) {
        log(`🔗 URL: ${urlMatch[0]}`, 'blue');
      }
    }
    
    return true;
  } catch (error) {
    logError(`Не вдалося деплоїти функцію ${functionName}`);
    if (error.message.includes('not linked')) {
      log('Підключіться до проєкту: supabase link --project-ref YOUR_PROJECT_ID', 'yellow');
    }
    return false;
  }
}

function deployAllFunctions() {
  const functions = getFunctions();
  
  if (functions.length === 0) {
    logWarning('Не знайдено функцій для деплоювання');
    return;
  }
  
  log(`\nЗнайдено функцій: ${functions.length}`, 'blue');
  functions.forEach(func => log(`  - ${func}`, 'cyan'));
  
  let successCount = 0;
  let failCount = 0;
  
  for (const functionName of functions) {
    if (deployFunction(functionName)) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  log('\n' + '='.repeat(50), 'blue');
  logSuccess(`Успішно деплоїно: ${successCount} функцій`);
  if (failCount > 0) {
    logError(`Помилки: ${failCount} функцій`);
  }
}

function showHelp() {
  log('\n🚀 Supabase Functions Deploy Tool', 'bright');
  log('\nВикористання:', 'yellow');
  log('  node deploy-functions.js                    # Деплой всіх функцій');
  log('  node deploy-functions.js <function-name>    # Деплой конкретної функції');
  log('  node deploy-functions.js --help             # Показати допомогу');
  
  log('\nПриклади:', 'yellow');
  log('  node deploy-functions.js app_78e3d871a2_chat');
  log('  npm run deploy');
  
  log('\nДоступні функції:', 'yellow');
  const functions = getFunctions();
  if (functions.length > 0) {
    functions.forEach(func => log(`  - ${func}`, 'cyan'));
  } else {
    log('  Функції не знайдено', 'red');
  }
}

function main() {
  const args = process.argv.slice(2);
  
  // Показати допомогу
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  log('🚀 Supabase Functions Deploy Tool', 'bright');
  log('=' .repeat(50), 'blue');
  
  // Перевірка Supabase CLI
  try {
    execCommand('supabase --version', 'Перевірка Supabase CLI');
  } catch (error) {
    logError('Supabase CLI не встановлено');
    log('Встановіть CLI: brew install supabase/tap/supabase', 'yellow');
    process.exit(1);
  }
  
  // Перевірка авторизації
  if (!checkSupabaseAuth()) {
    process.exit(1);
  }
  
  // Деплоювання
  if (args.length === 0) {
    // Деплой всіх функцій
    deployAllFunctions();
  } else {
    // Деплой конкретної функції
    const functionName = args[0];
    deployFunction(functionName);
  }
  
  log('\n✨ Готово!', 'green');
}

// Запуск
if (require.main === module) {
  main();
}

module.exports = {
  deployFunction,
  deployAllFunctions,
  getFunctions
};
