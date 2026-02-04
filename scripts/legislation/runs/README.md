# runs/

**Призначення:** вихідні дані імпортів (run dirs з report/logs) та історичні audit-звіти (.md).

**Що тут:**  
- Підпапка `audit/` та кореневі `.md` — збережені звіти аудитів (parser integrity, RAG, doc-type, validity тощо).  
- JSON/TXT/logs генеруються під час роботи CLI і **не комітяться** (див. `.gitignore`: `runs/**/*.json`, `runs/**/*.txt`, `runs/**/logs.txt`).

**Хто/коли наповнює:** CLI команди (add, verify, audit-*, repair тощо) пишуть у runs при виконанні; .md-звіти додаються вручну або скриптами при аудіті.
