---
title: Revisão Final — Data Engineer Associate
type: final-review
tags:
  - data-engineer-associate
  - revisao-final
  - manha-da-prova
status: published
---

# Revisão Final — DE Associate (leitura de 20 minutos na manhã da prova)

> [!important] Importante
> **Leia na manhã da prova.** É uma revisão relâmpago, não um guia de estudo. Se algum fato abaixo parecer desconhecido, é um domínio que você deixou passar — anote e revise a pasta do tópico assim que puder.

## Fatos de 2 minutos que mais aparecem

- **Lakeflow Jobs** é o nome atual do que se chamava Workflows. "Workflows" só aparece em materiais antigos
- **Lakeflow Declarative Pipelines** (nome da prova) = o antigo "Delta Live Tables / DLT". Desde 12/11/2025 a documentação chama de **Lakeflow Spark Declarative Pipelines**
- **Declarative Automation Bundles** = o antigo **Databricks Asset Bundles** (DABs). Mesma CLI `databricks bundle`. **Git folders** = o antigo Repos
- **`COPY INTO` é idempotente**: reexecutar ignora arquivos já carregados. `'force' = 'true'` recarrega
- **Auto Loader (`cloudFiles`)**: `addNewColumns` (padrão) *para* o stream e evolui no reinício. `rescue` nunca falha e manda o excesso para `_rescued_data`
- **Managed connectors** (SaaS, bancos) → ingestion pipelines serverless gravando streaming tables. O **ingestion gateway** existe só para bancos
- **Triggers**: scheduled (por tempo) vs **file arrival** e **table update** (por dados)
- **Tratamento de skew do AQE = só joins**. Um `groupBy` com skew precisa de **salting**
- **Liquid Clustering** (`CLUSTER BY`, até 4 chaves, não combina com particionamento nem Z-order). **Predictive optimization** = `OPTIMIZE` / `VACUUM` / `ANALYZE` automáticos em **managed tables do UC**
- **Acesso no UC** = `USE CATALOG` + `USE SCHEMA` + privilégio no objeto. Grants são herdados por filhos atuais e futuros
- **DENY**: o comando clássico é **só Hive metastore**. O UC usa REVOKE ou não conceder, filtros, máscaras e ABAC (a política ABAC DENY, em Beta, nega só `MANAGE ACCESS CONTROL`)
- **External → managed**: `ALTER TABLE ... SET MANAGED`. Desfaça com `UNSET MANAGED` em até 14 dias

## Revisão rápida por domínio (5 minutos)

### 01 — Databricks Intelligence Platform (6 %)

- Lakehouse = uma cópia governada (Delta Lake + Unity Catalog) para BI e IA. Time travel dá rollback e trilha de auditoria
- Muitos usuários concorrentes de SQL ad hoc → **serverless SQL warehouse** (inicia em ~2–6 s, autoscaling, auto stop)
- ETL agendado → serverless jobs ou jobs compute. Trabalho interativo → all-purpose ou notebook serverless

### 02 — Data Ingestion and Loading (21 %)

- Comece pela camada **mais gerenciada**: managed connector → Lakeflow pipelines → Structured Streaming / APIs Spark
- Detecção de arquivos: directory listing (padrão) vs **file notification com file events** (recomendado)
- JDBC: secrets via `dbutils.secrets.get`. Paralelize com `partitionColumn` / limites / `numPartitions`
- REST → grave JSON num **volume UC** → Auto Loader → agende os dois num único Lakeflow Job

### 03 — Data Transformation and Modeling (22 %)

- `union` mantém duplicatas e casa por posição. `unionByName` casa por nome. O `UNION` do SQL deduplica
- "Linha mais recente por chave" → `ROW_NUMBER()` / `QUALIFY`, não `dropDuplicates`
- View (recalculada por consulta) vs **materialized view** (armazenada, atualizada) vs **streaming table** (append incremental) vs table
- Expectations: warn (padrão) / `DROP ROW` / `FAIL UPDATE`
- `spark.sql.shuffle.partitions` (200 ou `auto`) para shuffles de DataFrame. `spark.default.parallelism` para RDDs. Broadcast threshold 10 MB

### 04 — Working with Lakeflow Jobs (16 %)

- Tipos de task: notebook, SQL, dashboard, pipeline. **Depends on** monta o DAG
- **If/else** (ramificação), **For each** (loop, concorrência padrão 1), **retries**, Run if **All done** para limpeza
- Cron Quartz: `0 0 9 ? * MON-FRI` = dias úteis às 09:00

### 05 — Implementing CI/CD (10 %)

- Git folder: Create Branch → editar → **Commit & Push** → **PR no provedor Git**
- Precedência de variáveis: `--var` > `BUNDLE_VAR_` > `variable-overrides.json` > `variables` do target > `default`
- `mode: development` = nomes com prefixo e agendas pausadas. `mode: production` = validações de branch, `run_as` e caminhos
- `databricks bundle validate` → `deploy -t prod` → `run`

### 06 — Troubleshooting, Monitoring, and Optimization (10 %)

- Tendências de duração → **matrix view** do job. Bloqueios → visão **Graph** (`Upstream failed` aponta para cima)
- **Timed Out** → aumente o timeout da task. **Succeeded with failures** → as leaf tasks tiveram sucesso
- Skew: max ≫ percentil 75. Spill: Spill (Disk) > 0 → `auto` / mais partições ou mais memória
- Falha de inicialização → código de término no event log. Conflito de biblioteca → `%pip` no notebook, versões fixadas. OOM no driver → pare de trazer dados para o driver

### 07 — Governance and Security (15 %)

- Managed: `DROP` apaga após a janela do `UNDROP` (7 dias). External: `DROP` remove só os metadados
- Column mask com `is_account_group_member('finance_team')`. Row filter = UDF `BOOLEAN` com `SET ROW FILTER ... ON (cols)`
- **ABAC** = `CREATE POLICY ... FOR TABLES` com governed tags, no nível de catálogo ou schema

## Lembretes de pegadinhas

| Pegadinha | Resposta certa |
| :--- | :--- |
| A questão diz "Workflows" | Leia como Lakeflow Jobs |
| A questão diz "DLT" ou "Delta Live Tables" | Leia como Lakeflow Declarative Pipelines |
| "O AQE está ligado, então o skew está resolvido" num `groupBy` | Não. Faça salting na chave |
| "Diminua shuffle partitions para resolver skew" | Não. Deixa as partições maiores |
| "Coloque a senha no `databricks.yml`" | Não. Use `BUNDLE_VAR_<nome>` dos secrets do CI |
| "DENY bloqueia acesso no Unity Catalog" | O `DENY` clássico é só Hive metastore. Revogue, filtre, mascare ou use ABAC |
| Desfazer `SET MANAGED` | `UNSET MANAGED` em até 14 dias, não `RESTORE` |
| Arquivos chegam em horários imprevisíveis | File arrival trigger, não agenda de polling |
| Compute mais barato para job agendado | Jobs compute ou serverless jobs, não all-purpose |

## Orçamento de tempo — 90 minutos

- **45 questões ÷ 90 minutos = ~2 min/questão** — continue andando
- **Marque e pule** o que não conseguir responder em 90 segundos — volte no fim
- **Releia o cenário** antes de reler a pergunta — a maioria das pegadinhas está no cenário
- **Prefira a opção mais simples** que atende a *todas* as restrições; a Databricks premia respostas "mais gerenciadas" (Auto Loader > polling customizado, Lakeflow Jobs > orquestração customizada, UC > local do workspace)
- **Não mude de ideia** nas marcadas na segunda passada, a menos que encontre informação nova

## Coma. Hidrate-se. Respire.

Você está preparado. O trabalho está feito. Confie nele. Vá e passe.

---

**[← Voltar aos Recursos](README.md)** | **[↑ Voltar à Certificação](../README.md)**
