# Lexery Legal AI Agent — MEGA Architecture (Overview)

Один великий flowchart: Online Serving, Offline DocListDB Updater, Offline LLDBI Ingestion, Storages & External Services. ID нод узгоджені з матрицею блоків та 07_BLOCK_CARDS.md.

```mermaid
%%{init: {"flowchart":{"curve":"basis"},"theme":"base"} }%%
flowchart TB
  USR[User]
  FE[Frontend]
  BE[Backend API]

  subgraph S0["Lexery Legal AI Agent — MEGA Architecture"]
    direction TB

    subgraph ON["Online Serving (U1–U12)"]
      direction TB
      U1["[U1] Gateway/Intake<br/>in: POST /v1/runs<br/>out: run_id + enqueue"]
      U2["[U2] Classify<br/>QueryProfile + RoutingFlags"]
      U2a["[U2a] IntentClassifier"]
      U2b["[U2b] LegalDomainTagger"]
      U2c["[U2c] Entity Extractor"]
      U2d["[U2d] Ambiguity Detector"]
      U3["[U3] Plan<br/>out: SearchPlan"]
      U3a["[U3a] Plan Builder<br/>policy: A/B/C discovery"]
      U4["[U4] CacheRAG<br/>Qdrant chunks/acts + Memory"]
      U5["[U5] Gate<br/>expand?"]
      U6["[U6] Expand<br/>out: expanded_query"]
      U6a["[U6a] Synonymizer<br/>LLM synonyms"]
      U7["[U7] DocList<br/>out: ActCandidates"]
      U8["[U8] Import<br/>start ingestion"]
      U8a["[U8a] ActIngestionOrchestrator<br/>pick top N, rest queue"]
      U8b["[U8b] ActRelevanceValidator<br/>confidence check, Web fallback"]
      U9["[U9] Assemble<br/>ContextPack + EvidencePack"]
      U10["[U10] Write<br/>LLM draft answer"]
      U11["[U11] Verify<br/>Rerank + CoverageCritic"]
      U11a["[U11a] CoverageCritic"]
      U11b["[U11b] CrossEncoderReranker"]
      U11c["[U11c] QueryRefiner"]
      U11d["[U11d] StopPolicy"]
      U11e["[U11e] WebNavigator<br/>web hints only"]
      U12["[U12] Deliver<br/>SSE stream + persist"]
    end

    subgraph OFF1["Offline DocListDB Updater (T0/O1–O6)"]
      direction TB
      T0["[T0] Schedule Cron"]
      O2["[O2] Fetch Act List (Rada)"]
      O3["[O3] Download New Acts"]
      O4["[O4] Parse & Gen Embeddings 768d"]
      O1d["[O1] Store Canonical JSON R2"]
      O5["[O5] Upsert Metadata Supabase"]
      O6["[O6] Update Catalog Index<br/>Qdrant: legislation-catalog-index"]
    end

    subgraph OFF2["Offline LLDBI Ingestion (T6/O7–O12)"]
      direction TB
      T6["[T6] Import Job Trigger"]
      O7["[O7] Retrieve Act Content R2/Web"]
      O1i["[O1] Store Canonical JSON R2"]
      O8["[O8] Split into Chunks"]
      O9["[O9] Embed Chunks 1536d"]
      O10["[O10] Update Chunk Index<br/>lexery_legislation_chunks"]
      O11["[O11] Update Act Index<br/>lexery_legislation_acts"]
      O12["[O12] Mark Indexed Supabase"]
    end

    subgraph ST["Storages & External Services"]
      direction TB
      SB1[(Supabase runs/messages/memory)]
      SB2[(Supabase legislation_documents)]
      SB3[(Supabase legislation_import_jobs)]
      R2[(R2 legislation/ + state/locks/runs)]
      QD1[(Qdrant lexery_legislation_chunks)]
      QD2[(Qdrant lexery_legislation_acts)]
      QD3[(Qdrant legislation-catalog-index)]
      OR[OpenRouter API]
      RADA[rada.gov.ua]
      DOCL[DocList Resolver API]
      WEB[Perplexity Sonar — web search]
    end
  end

  %% ===== Online flow =====
  USR --> FE --> BE --> U1
  U1 --> U2 --> U2a --> U2b --> U2c --> U2d
  U2d --> U3 --> U3a --> U4 --> U5
  U5 -->|expand=false| U9
  U5 -->|expand=true| U6 --> U6a --> U7 --> U8a --> U8b --> U8
  U8 -.->|triggers| T6
  U8 --> U9
  U9 --> U10 --> U11 --> U11a --> U11b --> U11d
  U11d -->|stop/deliver| U12
  U11a -.->|retry| U11c
  U11c -.-> U4
  U11a -.->|need web| U11e --> U11c

  %% ===== DocListDB Offline =====
  T0 --> O2 --> O3 --> O4
  O4 --> O1d
  O4 --> O5
  O4 --> O6

  %% ===== LLDBI Offline =====
  T6 --> O7 --> O1i
  O7 --> O8
  O1i --> O8
  O8 --> O9 --> O10
  O9 --> O11
  O10 --> O12
  O11 --> O12

  %% ===== Dependencies (dashed) =====
  U1 -.-> SB1
  U4 -.-> QD1
  U4 -.-> QD2
  U7 -.-> DOCL
  U9 -.-> R2
  U10 -.-> OR
  U11a -.-> OR
  U11e -.-> WEB
  O1d -.-> R2
  O2 -.-> RADA
  O3 -.-> RADA
  O6 -.-> QD3
  O7 -.-> R2
  O7 -.-> RADA
  O10 -.-> QD1
  O11 -.-> QD2
  O12 -.-> SB2
  O12 -.-> SB3

  %% ===== Classes =====
  classDef online fill:#E8F0FE,stroke:#1A73E8,stroke-width:1px,color:#111
  classDef offline fill:#E6F4EA,stroke:#1E8E3E,stroke-width:1px,color:#111
  classDef storage fill:#FEF7E0,stroke:#F9AB00,stroke-width:1px,color:#111
  classDef external fill:#FCE8E6,stroke:#D93025,stroke-width:1px,color:#111

  class U1,U2,U2a,U2b,U2c,U2d,U3,U3a,U4,U5,U6,U6a,U7,U8,U8a,U8b,U9,U10,U11,U11a,U11b,U11c,U11d,U11e,U12 online
  class T0,O2,O3,O4,O1d,O5,O6,T6,O7,O1i,O8,O9,O10,O11,O12 offline
  class SB1,SB2,SB3,R2,QD1,QD2,QD3 storage
  class OR,RADA,DOCL,WEB external
```

## Легенда

- **Стрілки суцільні** — основний потік даних/контролю.
- **Стрілки пунктирні** — залежності від сховищ/зовнішніх сервісів або тригери (наприклад U8 → T6).
- **online** (блакитний) — блоки Online Serving.
- **offline** (зелений) — блоки Offline pipelines.
- **storage** (жовтий) — Supabase, Qdrant, R2.
- **external** (червоний) — OpenRouter, Rada, DocList API, Web.

## Примітки

- R2 для DocListDB Updater: prefix `legislation/DocListDB rada gov updater log/`, ключі `state.json`, `locks/daily.lock`, `runs/<run_id>.json`.
- Деталі по кожному блоку — у **02_ONLINE_DETAILED.md**, **03_DOCLISTDB_DETAILED.md**, **04_LLDBI_DETAILED.md** та **07_BLOCK_CARDS.md**.
