# lib (compat layer)

**Призначення:** compat stub для `supabaseAdmin`; реальний код у `prod_lexery_legislation_db_infra/lib/`.  
**Файли:** лише `supabaseAdmin.ts` (реекспорт із prod).  
**Чому тут:** щоб `./lib/supabaseAdmin` продовжував працювати для admin-cli та інших entrypoints.
