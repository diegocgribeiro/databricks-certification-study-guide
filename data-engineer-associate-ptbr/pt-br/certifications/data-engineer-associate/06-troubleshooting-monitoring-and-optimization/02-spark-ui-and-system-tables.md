---
title: Spark UI e System Tables
type: study-material
tags:
  - data-engineer-associate
  - monitoramento
  - spark-ui
  - skew
  - spill
  - system-tables
status: published
---

# Spark UI e System Tables

## Visão geral

Quando o histórico de execuções de um job mostra uma regressão, a **Spark UI** explica *por quê*. Suas métricas por stage revelam os três gargalos que o exam guide cita: **data skew**, **shuffle** e **disk spill**. As **system tables** adicionam um histórico consultável em SQL de execuções de jobs, eventos de auditoria, linhagem e cobrança, para tendências que uma única execução não mostra.

> [!abstract] Resumo
>
> - Comece pela aba **Stages**: ordene por duração, abra o stage mais lento e leia as **Summary Metrics** (Min / 25º / Mediana / 75º / Max) de duração das tasks, shuffle read e spill
> - **Skew**: "Se a duração Max excede o percentil 75 em 50 % ou mais, o stage pode ter skew"
> - **Spill**: a memória de execução acabou e os dados foram gravados em disco. As estatísticas de spill aparecem nos detalhes do stage
> - O **AQE** divide partições com skew só em **sort-merge e shuffle-hash joins**. **Agregações** com skew precisam de **salting**

> [!tip] O que a prova cobra
>
> - Habilidade do exam guide: identificar gargalos comuns como data skew, shuffle e disk spill interpretando métricas de stage na Spark UI
> - Escolher a correção que bate com o sintoma: salting, broadcast, número de partições, memória ou Liquid Clustering
> - Por que adicionar executores não resolve uma task com skew, e por que menos shuffle partitions piora o skew
> - Qual system table responde "quais jobs falharam?", "quem leu esta tabela?" ou "quanto isso custou?"

---

## Lendo a Spark UI

| Aba | Use para |
| :--- | :--- |
| **Jobs** | Cada job Spark disparado por uma ação, e seus stages |
| **Stages** | **Comece aqui.** Duração por stage. Clique para ver Summary Metrics e detalhes por task |
| **SQL / DataFrame** | O plano físico: `Exchange` (shuffle), `BroadcastHashJoin` vs `SortMergeJoin` e replanejamentos do AQE |
| **Storage** | DataFrames em cache e seu uso de memória ou disco |
| **Executors** | Tempo de GC, memória e tasks com falha por executor |
| **Environment** | Configuração Spark efetiva |

Um fluxo de investigação:

1. Encontre o **stage** mais lento (ordene por Duration)
2. Leia suas **Summary Metrics**: compare o **Max** com o **percentil 75 / Mediana** para duração e tamanho do shuffle read
3. Verifique o **spill (memory) / spill (disk)** e o **Peak Execution Memory** do stage
4. Abra a aba **SQL / DataFrame** para ver qual operador (join, agregação, sort) gerou o stage

## Os três gargalos

| Sintoma nas métricas do stage | Diagnóstico | Correções |
| :--- | :--- | :--- |
| A maioria das tasks termina rápido, mas uma ou poucas demoram muito mais. Shuffle read Max muito maior que a mediana | **Data skew**: uma chave "quente" coloca dados demais em uma partição | Joins: confirme o tratamento de skew do AQE (ou ajuste os limites). **Agregações: faça salting da chave** e agregue em duas etapas. Skew em tabela armazenada: **Liquid Clustering**. Na escrita: hint `REBALANCE` |
| Grande **Shuffle Read/Write** em um stage de join, com `Exchange` antes de um `SortMergeJoin` | **Shuffle caro** | Faça broadcast do lado pequeno. Filtre e selecione colunas antes do join. Evite `repartition` desnecessário |
| **Spill (disk)** > 0, Peak Execution Memory alto, tasks lentas | **Disk spill**: faltou memória de execução durante shuffle, join, sort ou agregação | `spark.sql.shuffle.partitions=auto` (ou mais partições). Reduza linhas e colunas largas em memória. Mais memória por executor (menos workers, maiores, para ETL pesado) |
| Nem skew nem spill, mas lento | Provavelmente **limitado por I/O** | Verifique tamanho e layout dos arquivos (`OPTIMIZE`, Liquid Clustering) e predicate pushdown |

Fonte: [Skew and spill](https://docs.databricks.com/aws/en/optimizations/spark-ui-guide/long-spark-stage-page), [Adaptive query execution](https://docs.databricks.com/aws/en/optimizations/aqe).

### Skew em agregação: salting

O AQE "divide e, se necessário, replica partições com skew em sort merge joins e shuffle hash joins", e nunca em broadcast joins. Ele **não** resolve um `groupBy` com skew. Espalhe a chave quente entre tasks com um salt e depois combine os resultados parciais:

```python
from pyspark.sql import functions as F

SALT_BUCKETS = 16

# Etapa 1: agrega por (customer_id, salt). O cliente "quente" agora fica dividido em 16 tasks
partial = (spark.table("main.silver.events")
    .withColumn("salt", (F.rand() * SALT_BUCKETS).cast("int"))
    .groupBy("customer_id", "salt")
    .agg(F.count("*").alias("cnt"), F.sum("amount").alias("amt")))

# Etapa 2: combina os agregados parciais por customer_id
result = (partial
    .groupBy("customer_id")
    .agg(F.sum("cnt").alias("events"), F.sum("amt").alias("amount")))
```

> [!warning] Erros comuns com skew
>
> - **Adicionar executores** não ajuda: a partição gigante continua sendo processada por uma única task
> - **Diminuir `spark.sql.shuffle.partitions`** deixa as partições maiores, piorando skew e spill
> - **"O AQE está ligado, então o skew está resolvido"** só é verdade para **joins** sort-merge e shuffle-hash

### Shuffle: broadcast do lado pequeno

```sql
-- Antes: Exchange + SortMergeJoin nos dois lados
-- Depois: a dimensão de 20 MB vai para cada executor; o lado grande não sofre shuffle
SELECT /*+ BROADCAST(d) */ f.*, d.region
FROM main.silver.sales f JOIN main.silver.stores d ON f.store_id = d.store_id;
```

Veja [Parâmetros de tuning do Spark](../03-data-transformation-and-modeling/07-spark-tuning-parameters.md) para `spark.sql.autoBroadcastJoinThreshold` e o limite de broadcast em runtime do AQE.

## System tables que você deve conhecer

| Tabela | Contém |
| :--- | :--- |
| `system.lakeflow.jobs` | Definições de jobs |
| `system.lakeflow.job_run_timeline` | Execuções de jobs: início, fim, resultado |
| `system.lakeflow.job_task_run_timeline` | Execuções de tasks dentro das execuções de jobs |
| `system.access.audit` | Eventos de auditoria: quem fez o quê, e quando |
| `system.access.table_lineage` | Linhagem de leitura/escrita entre tabelas |
| `system.billing.usage` | Uso cobrável (DBUs) por workspace, SKU, job, warehouse e mais |
| `system.storage.predictive_optimization_operations_history` | Execuções de `OPTIMIZE` / `VACUUM` / `ANALYZE` pelo predictive optimization |

"System tables não suportam monitoramento em tempo real", e a atualidade varia por tabela ([System tables](https://docs.databricks.com/aws/en/admin/system-tables/)).

```sql
-- Taxa de falha por job nos últimos 7 dias
SELECT job_id,
       COUNT(*) AS runs,
       COUNT_IF(result_state = 'FAILED') AS failed,
       ROUND(100 * COUNT_IF(result_state = 'FAILED') / COUNT(*), 1) AS failure_pct
FROM system.lakeflow.job_run_timeline
WHERE period_start_time >= current_timestamp() - INTERVAL 7 DAYS
GROUP BY job_id
ORDER BY failure_pct DESC;
```

> [!note] Observação
> Nomes de colunas nas system tables evoluem. Confira a [referência das system tables de jobs](https://docs.databricks.com/aws/en/admin/system-tables/jobs) antes de construir dashboards.

## Notificações e repair runs

- **Notificações**: email e destinos do sistema (ex.: Slack ou webhook) no início, sucesso, falha e avisos de duração, configuradas por job ou por task
- **Repair run**: reexecuta só as tasks que falharam de uma execução multi-task e suas dependentes, reaproveitando os resultados upstream bem-sucedidos. É mais barato que **Run now**, que reexecuta o DAG inteiro

## Casos de uso

- **Agregação de clientes com skew**: um stage `groupBy("customer_id")` tem uma task de 10 minutos entre tasks de 30 segundos. O salting reduz para minutos
- **Join com spill**: o disk spill em um join de 2 TB some com shuffle partitions `auto` e workers maiores
- **Join de dimensão com muito shuffle**: um hint de broadcast remove o `Exchange` da tabela fato
- **Relatório semanal de confiabilidade**: um dashboard sobre `system.lakeflow.job_run_timeline` acompanha a taxa de falha por job

## Problemas e erros comuns

### Escalar não resolve uma task retardatária

**Cenário:** depois de dobrar os workers, o stage mais lento ainda tem uma task rodando por 10 minutos.
**Correção:** é skew. Faça salting na chave da agregação, ou, para joins, confie no tratamento de skew do AQE (ou ajuste-o). Mais executores não dividem uma partição.

### Spark UI sumiu depois que o job cluster encerrou

**Cenário:** engenheiros querem inspecionar os stages de uma execução passada, mas o job cluster não existe mais.
**Correção:** abra a Spark UI a partir dos detalhes da execução da task. Compute reiniciado mostra só a Spark UI mais recente, então registre métricas-chave ou configure entrega de logs para análise posterior.

### Esperar dados em tempo real das system tables

**Cenário:** um alerta construído sobre `system.lakeflow.job_run_timeline` dispara atrasado.
**Correção:** system tables não suportam monitoramento em tempo real. Use notificações de job para alertas imediatos e system tables para tendências.

## Dicas para a prova

> [!tip] Dicas para a prova
>
> - Duração Max ou shuffle read muito acima da mediana ou do percentil 75 = **skew**
> - **groupBy** com skew e AQE já ligado → **salting da chave** (agregação em duas etapas)
> - **Join** com skew → tratamento de skew join do AQE (sort-merge ou shuffle-hash), ou salting
> - **Spill** → mais (ou `auto`) shuffle partitions, menos dados por task ou mais memória no executor
> - **Shuffle** grande com dimensão pequena → **broadcast**
> - System tables são para tendências e auditoria, não para alertas em tempo real

## Pontos-chave

- As Summary Metrics do stage são a evidência para skew, shuffle e spill
- O AQE ajuda em joins e no agrupamento de partições. Skew em agregação precisa de salting
- Faça broadcast de tabelas pequenas para evitar shuffles, e dimensione partições para evitar spill
- `system.lakeflow.*`, `system.access.*` e `system.billing.usage` cobrem execuções, auditoria, linhagem e custo

## Tópicos relacionados

- [Monitoramento de Jobs](01-job-monitoring.md)
- [Parâmetros de tuning do Spark](../03-data-transformation-and-modeling/07-spark-tuning-parameters.md)
- [Liquid Clustering e Predictive Optimization](04-liquid-clustering-and-predictive-optimization.md)

## Documentação oficial

- [Skew and spill](https://docs.databricks.com/aws/en/optimizations/spark-ui-guide/long-spark-stage-page)
- [Adaptive query execution](https://docs.databricks.com/aws/en/optimizations/aqe)
- [System tables](https://docs.databricks.com/aws/en/admin/system-tables/)
- [Add notifications on a job](https://docs.databricks.com/aws/en/jobs/notifications)
- [Repair a failed job run](https://docs.databricks.com/aws/en/jobs/repair-job-failures)

---

**[← Anterior: Monitoramento de Jobs](01-job-monitoring.md) | [↑ Voltar para Troubleshooting, Monitoring, and Optimization](README.md) | [Próximo: Otimização do Delta Lake →](03-delta-optimization.md)**
