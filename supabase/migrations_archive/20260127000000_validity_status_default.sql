-- Migration: Validity Status Default
-- PROD PIPELINE: встановлення DEFAULT 'unknown' для validity_status
-- Дата: 2026-01-27

-- 1. Спочатку нормалізуємо старі значення до нових форматів (перед встановленням constraint)
UPDATE legislation_documents
SET validity_status = 'in_force'
WHERE validity_status = 'ACTIVE';

UPDATE legislation_documents
SET validity_status = 'expired'
WHERE validity_status = 'REPEALED';

UPDATE legislation_documents
SET validity_status = 'unknown'
WHERE validity_status = 'UNKNOWN';

UPDATE legislation_documents
SET validity_status = 'in_force'
WHERE validity_status = 'PARTIALLY_IN_FORCE';

-- 2. Видаляємо старий CHECK constraint якщо він існує (може бути зі старими значеннями)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conrelid = 'legislation_documents'::regclass 
    AND conname LIKE '%validity_status%'
  ) THEN
    ALTER TABLE legislation_documents DROP CONSTRAINT IF EXISTS legislation_documents_validity_status_check;
  END IF;
END $$;

-- 3. Встановлюємо DEFAULT 'unknown' для validity_status
ALTER TABLE legislation_documents
  ALTER COLUMN validity_status SET DEFAULT 'unknown';

-- 4. Оновлюємо всі NULL значення на 'unknown'
UPDATE legislation_documents
SET validity_status = 'unknown'
WHERE validity_status IS NULL;

-- 5. Додаємо новий CHECK constraint з правильними значеннями
ALTER TABLE legislation_documents
  ADD CONSTRAINT legislation_documents_validity_status_check 
  CHECK (validity_status IN ('in_force', 'expired', 'not_in_force', 'suspended', 'unknown'));

-- 6. Коментар для документації
COMMENT ON COLUMN legislation_documents.validity_status IS 'Статус чинності документа: in_force, expired, not_in_force, suspended, unknown. DEFAULT: unknown. НЕ NULL (заповнюється автоматично під час імпорту).';
