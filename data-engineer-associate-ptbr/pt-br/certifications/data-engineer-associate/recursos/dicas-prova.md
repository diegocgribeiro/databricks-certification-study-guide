---
title: Dicas para a Prova — Data Engineer Associate
type: exam-tips
tags: [data-engineer-associate, dicas, certificacao]
status: published
---

# Dicas e Estratégias para a Prova Data Engineer Associate

Estratégias práticas para passar na Databricks Certified Data Engineer Associate na primeira tentativa.

## Formato da prova

| Detalhe | Valor |
|---|---|
| Questões pontuadas | 45 de múltipla escolha, mais até 10 itens não pontuados |
| Duração | 90 minutos (inclui o tempo dos itens não pontuados) |
| Nota de aprovação | Não publicada. Resultado: aprovado/reprovado |
| Código nas questões | SQL quando possível, senão Python |
| Idiomas | Inglês, japonês, **português (BR)**, coreano |
| Aplicação | Online com fiscal (proctored) ou em centro de testes |
| Exam guide | [Agosto 2026 (PDF)](https://www.databricks.com/sites/default/files/2026-10/Databricks-Certified-Data-Engineer-Associate-Exam-Guide-August-2026.pdf), atualizado em 06/08/2026 |

> [!tip] Idioma
> Mesmo que a prova exista em português, os termos técnicos (Auto Loader, streaming table, Unity Catalog...) aparecem em inglês. Por isso as questões de prática deste repositório estão em inglês — use o tradutor automático só quando travar no enunciado.

## Pesos dos domínios e tempo de estudo

| Domínio | Peso | ≈ Questões | Tempo de estudo sugerido |
|---|---|---|---|
| Data Transformation and Modeling | 22 % | ~10 | 8–10 horas |
| Data Ingestion and Loading | 21 % | ~9 | 7–9 horas |
| Working with Lakeflow Jobs | 16 % | ~7 | 5–6 horas |
| Governance and Security | 15 % | ~7 | 5–6 horas |
| Implementing CI/CD | 10 % | ~5 | 3–4 horas |
| Troubleshooting, Monitoring, and Optimization | 10 % | ~4 | 3–4 horas |
| Databricks Intelligence Platform | 6 % | ~3 | 2–3 horas |

Ingestão e transformação somam 43 % da prova. Lakeflow Jobs, CI/CD e governança (41 % juntos) são onde o blueprint de 2026 mais difere dos materiais antigos — não pule.

## Gestão do tempo

| Fase | Tempo | Meta |
|---|---|---|
| Primeira passada (responder tudo) | 60 min | ~80 s por questão |
| Revisar as marcadas | 20 min | Voltar às respostas incertas |
| Revisão final | 10 min | Conferir as puladas |

Marque (flag) qualquer questão em que estiver em dúvida e siga. Não gaste mais de 2 minutos numa questão na primeira passada.

## Tópicos para dominar

### Obrigatório (alta frequência)

- [ ] Idempotência do `COPY INTO` e `force`. Opções `cloudFiles` do Auto Loader: `schemaLocation`, `inferColumnTypes`, `schemaEvolutionMode` (`addNewColumns` / `rescue` / `failOnNewColumns` / `none`), `_rescued_data`
- [ ] Lakeflow Connect: standard vs managed connectors, e de que é feito um managed connector (connection, gateway para bancos, pipeline, streaming tables)
- [ ] Limpeza Bronze → Silver: `try_cast`, `coalesce`, `dropna`, `dropDuplicates` vs `ROW_NUMBER()`. Joins (inner, left, broadcast, cross), `union` vs `unionByName`, `explode` / `split`, `approx_count_distinct`
- [ ] Objetos Gold: table vs view vs materialized view vs streaming table
- [ ] Expectations: warn (padrão), `ON VIOLATION DROP ROW`, `ON VIOLATION FAIL UPDATE`
- [ ] Lakeflow Jobs: tipos de task (notebook, SQL, dashboard, pipeline), Run if, retries e timeouts, If/else, For each, task values
- [ ] Triggers: scheduled (cron Quartz), file arrival, table update, e escolher por tempo vs por dados
- [ ] Privilégios do UC: `USE CATALOG` + `USE SCHEMA` + `SELECT`, herança, grupos, service principals
- [ ] Row filters, column masks (`is_account_group_member`) e políticas ABAC
- [ ] Managed vs external tables, `UNDROP`, `SET MANAGED` / `UNSET MANAGED` (rollback em 14 dias)

### Importante (média frequência)

- [ ] Git folders: criar e trocar branch, Commit & Push, Pull, PR no provedor Git
- [ ] Declarative Automation Bundles: targets, `${var.x}`, `BUNDLE_VAR_`, precedência de variáveis, modo development vs production, `databricks bundle validate` / `deploy -t` / `run`
- [ ] Spark UI: skew (max ≫ percentil 75), spill, shuffle. O AQE só trata skew em joins — faça salting em agregações
- [ ] Parâmetros de tuning: `spark.sql.shuffle.partitions` (200 ou `auto`), `spark.default.parallelism` (RDDs), memória de executor/driver, `spark.sql.autoBroadcastJoinThreshold` (10 MB)
- [ ] Liquid Clustering (`CLUSTER BY`, `AUTO`, `OPTIMIZE FULL`) e predictive optimization (só managed tables do UC)
- [ ] Monitoramento de jobs: matrix view, status (Succeeded with failures, Upstream failed, Timed Out), repair runs
- [ ] Compute: serverless vs classic, tipos de SQL warehouse, falhas de inicialização, precedência de bibliotecas, OOM no driver vs executor
- [ ] Delta Lake: MERGE, time travel (`VERSION AS OF` / `TIMESTAMP AS OF`), `RESTORE`, `VACUUM` (retenção padrão de 7 dias)

### Bom saber (baixa frequência)

- [ ] Leituras JDBC paralelas (`partitionColumn`, limites, `numPartitions`) e secrets via `dbutils.secrets.get`
- [ ] Sintaxe de caminho JSON `:` e o tipo `VARIANT`
- [ ] System tables: `system.lakeflow.*`, `system.access.audit`, `system.billing.usage`
- [ ] `DENY` clássico é só Hive metastore legado. Políticas ABAC DENY (Beta) negam `MANAGE ACCESS CONTROL`
- [ ] `%run` vs `dbutils.notebook.run()` em notebooks. Widgets

## Pegadinhas comuns

| Pegadinha | O que a prova testa | Entendimento correto |
|---|---|---|
| Retenção do VACUUM | Qualquer valor funciona | O mínimo padrão é **168 horas (7 dias)**. Valores menores exigem desativar a verificação `spark.databricks.delta.retentionDurationCheck.enabled = false` |
| Schema evolution | Sempre automática na escrita | Precisa ser habilitada explicitamente com `.option("mergeSchema", "true")` ou `spark.databricks.delta.schema.autoMerge.enabled` |
| `availableNow` vs `once` | São iguais? | `availableNow=True` processa todos os dados disponíveis em micro-batches e para. `once=True` (depreciado) processa num único batch. Prefira `availableNow` |
| Auto Loader vs COPY INTO | Quando usar cada um? | Auto Loader (`cloudFiles`) para a maioria das ingestões: evolução de schema, rastreamento escalável. `COPY INTO` para equipes só SQL, cargas periódicas de conjuntos modestos. Para usuários SQL, a Databricks recomenda streaming tables (que usam Auto Loader) |
| Checkpoint de streaming | Opcional? | **Obrigatório** para tolerância a falhas e exactly-once. Defina com `checkpointLocation` |
| Escopo do Unity Catalog | No nível do workspace | **No nível da conta** — abrange vários workspaces |
| OPTIMIZE vs VACUUM | Fazem a mesma coisa? | Não. `OPTIMIZE` compacta arquivos pequenos. `VACUUM` remove arquivos antigos não referenciados pelo log |
| MATERIALIZED VIEW vs STREAMING TABLE | Intercambiáveis? | Não. Streaming tables processam linhas novas incrementalmente (append). Materialized views guardam o resultado de uma consulta e o atualizam, incrementalmente quando possível |
| AQE e skew | O AQE resolve todo skew? | Não. Só divide partições com skew em **joins** sort-merge e shuffle-hash. Faça salting em `groupBy` com skew |
| DENY no Unity Catalog | `DENY SELECT` bloqueia o usuário? | O `DENY` clássico é só Hive metastore. No UC, revogue ou não conceda, use filtros, máscaras ou ABAC. Políticas ABAC DENY (Beta) negam só `MANAGE ACCESS CONTROL` |
| Segredos no bundle | Colocar a senha no `databricks.yml`? | Não. Use uma variável definida via `BUNDLE_VAR_<nome>` a partir dos secrets do CI |
| Task Timed Out | Aumentar retries? | Não. Aumente o **timeout** da task. O warning de duração só alerta |

## Números de referência rápida

| Item | Valor |
|---|---|
| Nota de aprovação | Não publicada (aprovado/reprovado) |
| Retenção padrão do VACUUM | 168 horas (7 dias) |
| Tamanho alvo de arquivo Delta | ~1 GB (após OPTIMIZE) |
| Shuffle partitions padrão | 200 |
| Limite de broadcast join | 10 MB (`spark.sql.autoBroadcastJoinThreshold`). Limite do AQE em runtime: 30 MB |
| Retenção do transaction log | 30 dias |
| Comportamento do `availableNow` | Vários micro-batches |
| Níveis do Unity Catalog | catalog.schema.table |
| Janela do `UNDROP` | 7 dias (padrão) |
| Janela do `UNSET MANAGED` | 14 dias |
| Máximo de chaves no Liquid Clustering | 4 |
| Histórico de execuções na UI de Jobs | 60 dias |

## Padrões comuns de questão

### Baseadas em cenário

```text
"A data engineer needs to ingest JSON files as they arrive in
cloud storage. The schema may change over time. Which approach
should they use?"
```

**Estratégia**: identifique os requisitos (incremental, evolução de schema) e associe ao Auto Loader com inferência de schema.

### Boas práticas

```text
"What is the recommended approach for ensuring data quality
in a Lakeflow Declarative Pipelines pipeline?"
```

**Estratégia**: conheça as boas práticas oficiais — expectations (`CONSTRAINT ... EXPECT`), não lógica de validação customizada.

### Troubleshooting

```text
"A query against a Delta table is returning stale data even
after new data was written. What should the engineer check?"
```

**Estratégia**: pense em cache (`REFRESH TABLE`), time travel (lendo versão antiga) ou problemas de checkpoint de streaming.

### Configuração

```text
"Which option enables Change Data Feed on an existing Delta table?"
```

**Estratégia**: memorize os nomes das propriedades — `delta.enableChangeDataFeed = true` via `ALTER TABLE SET TBLPROPERTIES`.

## Glossário de palavras-chave nos enunciados

| Inglês no enunciado | O que significa / aponta para |
| :--- | :--- |
| *least operational overhead* / *most managed* | Solução gerenciada: managed connector, Auto Loader, serverless, Lakeflow Jobs |
| *idempotent* / *re-run safely* | `COPY INTO`, Auto Loader com checkpoint, `MERGE` |
| *incrementally* / *only new files* | Auto Loader, `COPY INTO`, streaming tables |
| *unpredictable arrival* | File arrival trigger |
| *upstream tables owned by another team* | Table update trigger |
| *must not copy the data* | Lakehouse Federation ou OpenSharing |
| *only members of group X can see* | Column mask / row filter com `is_account_group_member` |
| *across many tables / centrally* | Políticas ABAC com governed tags |
| *one task runs much longer* | Skew |
| *spill to disk* | Partições grandes demais / pouca memória |

## Véspera da prova

- [ ] Revise a tabela de pesos e priorize Data Transformation and Modeling e Data Ingestion and Loading
- [ ] Releia as operações do Delta Lake: MERGE, OPTIMIZE, VACUUM, sintaxe de time travel
- [ ] Revise Auto Loader vs COPY INTO, tipos de conector do Lakeflow Connect e tipos de trigger (scheduled, file arrival, table update)
- [ ] Releia a hierarquia do Unity Catalog, sintaxe de GRANT/REVOKE, row filters, column masks e ABAC
- [ ] Releia variables, targets, modos de deploy e comandos `databricks bundle`
- [ ] Revise triggers de streaming: `processingTime`, `availableNow`, exigência de checkpoint
- [ ] Faça o **modo Revisão de erros** no site de estudos e zere o caderno de erros
- [ ] Confirme que o software de fiscalização está instalado e teste sua internet
- [ ] Durma 8 horas

## Durante a prova

- [ ] Leia a questão inteira antes das alternativas — identifique a restrição-chave
- [ ] Elimine primeiro as alternativas claramente erradas
- [ ] Em questões de SQL, cuidado com pegadinhas de sintaxe (ex.: `MERGE INTO` exige `USING`)
- [ ] Marque as incertas e siga — não fique travado
- [ ] Atenção a "BEST" ou "recommended" — a prova costuma ter duas alternativas plausíveis
- [ ] Em questões de Delta Lake, veja se pergunta sobre leitura ou escrita
- [ ] Em questões de streaming, note se é processamento contínuo ou disparado (triggered)
- [ ] Lembre: o Unity Catalog é no nível da conta, não do workspace

## Se não passar

- Revise o relatório de desempenho por seção — identifique o domínio mais fraco
- Concentre o estudo no domínio com menor pontuação (o painel "Pontos fracos" do site ajuda nisso)
- Aguarde o período exigido para refazer (geralmente 14 dias)
- Refaça os simulados e revise as respostas erradas
- Faça de novo com confiança

## Prioridade de recursos de estudo

### Essencial

1. Databricks Academy — trilha Data Engineer Associate
2. Documentação oficial das suas áreas fracas
3. Simulados (os dois deste guia)
4. Prática no [Databricks Free Edition](https://docs.databricks.com/aws/en/getting-started/free-edition) (o Community Edition foi aposentado no fim de 2025)
5. O **AI Prep Guide** citado no exam guide, que gera um checklist prático adequado ao Free Edition

### Útil (se der tempo)

1. Fóruns da Databricks Community
2. Tutoriais no YouTube (busque "Databricks DE Associate")
3. Posts de engenheiros certificados

### Pule

- Conteúdo desatualizado (anterior a 2023)
- Internos profundos do Spark (Tungsten, detalhes do Catalyst)
- Padrões avançados de streaming (joins stream-stream, sinks customizados)

---

[← Voltar aos Recursos](README.md)
