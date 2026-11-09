---
title: Limpeza e Qualidade de Dados
type: study-material
tags:
  - data-engineer-associate
  - limpeza-de-dados
  - qualidade-de-dados
  - expectations
  - constraints
  - medallion
status: published
---

# Limpeza e Qualidade de Dados

## Visão geral

Tabelas Silver existem para guardar dados **limpos e confiáveis**. Este arquivo cobre os passos de limpeza Bronze → Silver que o exam guide cita: ler a Bronze com PySpark ou SQL, tratar nulos, padronizar tipos, deduplicar e gravar uma nova tabela Silver. Também cobre as **verificações de qualidade e regras de validação** que mantêm Silver e Gold confiáveis: constraints `CHECK` e `NOT NULL` do Delta, **expectations** de pipeline e padrões de quarentena.

> [!abstract] Resumo
>
> - **Kit de limpeza**: `cast` / `try_cast` para tipos, `coalesce` / `fillna` / `dropna` para nulos, `trim` / `lower` / `to_date` para padronizar, `dropDuplicates` ou `ROW_NUMBER()` para deduplicar
> - **Profiling**: `describe()` (count, mean, stddev, min, max) e `summary()` (o mesmo + quartis aproximados de 25/50/75 %), `count_if`, `approx_count_distinct`
> - **Constraints Delta** (`NOT NULL`, `CHECK`) são aplicadas em toda escrita. Uma violação faz a transação falhar
> - **Expectations** em Lakeflow pipelines: warn (padrão), `ON VIOLATION DROP ROW` ou `ON VIOLATION FAIL UPDATE`, com métricas na UI do pipeline e no event log

> [!tip] O que a prova cobra
>
> - Habilidades do exam guide: limpeza Bronze → Silver (nulos, tipos) com PySpark/SQL, deduplicação e agregados (count, contagem distinta aproximada, média, summary) e regras de qualidade/validação para Silver e Gold
> - Escolher entre constraint (rejeita a escrita inteira) e expectation (warn, drop ou fail por registro)
> - O que acontece com registros inválidos em cada ação de expectation
> - Deduplicar "o registro mais recente por chave" corretamente

---

## Bronze → Silver: uma receita de limpeza

```python
from pyspark.sql import functions as F
from pyspark.sql.window import Window

bronze = spark.table("main.bronze.customers_raw")

silver = (bronze
    # 1. Padronizar strings
    .withColumn("email", F.lower(F.trim("email")))
    .withColumn("country", F.upper(F.trim("country")))
    # 2. Padronizar tipos (try_cast retorna NULL em vez de falhar em valores ruins)
    .withColumn("signup_date", F.to_date("signup_date", "yyyy-MM-dd"))
    .withColumn("lifetime_value", F.expr("try_cast(lifetime_value AS DECIMAL(12,2))"))
    # 3. Tratar nulos: valor padrão onde a regra de negócio permite, remover onde falta a chave
    .fillna({"country": "UNKNOWN", "lifetime_value": 0})
    .dropna(subset=["customer_id"])
    # 4. Renomear para o padrão de nomes da Silver
    .withColumnRenamed("cust_nm", "customer_name"))

# 5. Deduplicar: manter o registro mais recente por customer_id
w = Window.partitionBy("customer_id").orderBy(F.col("_ingested_at").desc())
silver_dedup = (silver
    .withColumn("rn", F.row_number().over(w))
    .filter("rn = 1")
    .drop("rn"))

# 6. Gravar uma nova tabela Silver no Unity Catalog
silver_dedup.write.mode("overwrite").saveAsTable("main.silver.customers")
```

Os mesmos passos em SQL:

```sql
CREATE OR REPLACE TABLE main.silver.customers AS
SELECT customer_id,
       lower(trim(email))                          AS email,
       coalesce(upper(trim(country)), 'UNKNOWN')   AS country,
       to_date(signup_date, 'yyyy-MM-dd')          AS signup_date,
       coalesce(try_cast(lifetime_value AS DECIMAL(12,2)), 0) AS lifetime_value
FROM main.bronze.customers_raw
WHERE customer_id IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY _ingested_at DESC) = 1;
```

### Referência de tratamento de nulos

| Necessidade | PySpark | SQL |
| :--- | :--- | :--- |
| Remover linhas com qualquer nulo | `df.dropna()` (`how="any"` padrão) | `WHERE col1 IS NOT NULL AND ...` |
| Remover só se todas as colunas forem nulas | `df.dropna(how="all")` | — |
| Remover se a coluna-chave for nula | `df.dropna(subset=["id"])` | `WHERE id IS NOT NULL` |
| Substituir nulos por padrão | `df.fillna({"col": value})` | `coalesce(col, value)` / `nvl(col, value)` |
| Contar nulos | `F.count_if(F.col("c").isNull())` (ou `F.sum(F.col("c").isNull().cast("int"))`) | `count_if(c IS NULL)` |

`dropna` e `na.drop` são aliases. `dropna(how="any")` remove a linha se tiver qualquer nulo, e `how="all"` só se todos os valores forem nulos.

### Opções de deduplicação

| Método | Mantém | Use quando |
| :--- | :--- | :--- |
| `df.distinct()` | Uma cópia de cada linha totalmente idêntica | Duplicatas exatas |
| `df.dropDuplicates(["id"])` | Uma linha **arbitrária** por `id` | Qualquer cópia serve |
| `ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) = 1` | A linha **mais recente** por `id` | "O registro mais recente vence" |
| `MERGE INTO ... WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT` | Uma linha por chave no destino | Cargas incrementais que não podem inserir duplicatas |

## Profiling antes e depois da limpeza

```python
df = spark.table("main.silver.customers")

df.describe("lifetime_value").show()     # count, mean, stddev, min, max
df.summary().show()                      # + quartis aproximados 25%, 50%, 75%
df.summary("count", "min", "10%", "90%", "max").show()   # estatísticas escolhidas

df.agg(
    F.count("*").alias("rows"),
    F.countDistinct("customer_id").alias("exact_customers"),
    F.approx_count_distinct("customer_id").alias("approx_customers"),   # HLL++, erro padrão ~5 %
    F.mean("lifetime_value").alias("avg_ltv"),
).show()
```

- `summary()` sem argumentos calcula count, mean, stddev, min, quartis aproximados (25 %, 50 %, 75 %) e max. `describe()` calcula só as estatísticas básicas
- `approx_count_distinct(expr [, relativeSD])` estima valores distintos com HyperLogLog++. O desvio padrão relativo máximo padrão é 5 % ([approx_count_distinct](https://docs.databricks.com/aws/en/sql/language-manual/functions/approx_count_distinct)). Use quando um `COUNT(DISTINCT ...)` exato for caro demais em tabelas muito grandes

## Regra de validação 1: constraints de tabela Delta

Constraints são aplicadas pela própria tabela, em qualquer caminho de escrita: SQL, DataFrame, streaming ou `MERGE`.

```sql
ALTER TABLE main.silver.customers ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE main.silver.customers ADD CONSTRAINT valid_ltv CHECK (lifetime_value >= 0);
ALTER TABLE main.silver.customers ADD CONSTRAINT valid_country CHECK (length(country) = 2 OR country = 'UNKNOWN');
```

| Constraint | Aplicada? | Em caso de violação |
| :--- | :--- | :--- |
| `NOT NULL` | Sim | "A transação falha com erro" |
| `CHECK (expr)` | Sim | A transação falha — a escrita inteira é rejeitada |
| `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE` | **Não, apenas informativas** | Nada é bloqueado. Documentam relacionamentos e podem ajudar na otimização |

Fonte: [Constraints on Databricks](https://docs.databricks.com/aws/en/tables/constraints).

## Regra de validação 2: expectations de pipeline

Expectations são cláusulas opcionais em **streaming tables, materialized views e temporary views** de um Lakeflow pipeline. Cada uma aplica uma verificação booleana SQL a cada registro ([pipeline expectations](https://docs.databricks.com/aws/en/ldp/expectations)).

```sql
CREATE OR REFRESH STREAMING TABLE main.silver.orders (
  CONSTRAINT valid_id     EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT valid_amount EXPECT (amount > 0)           ON VIOLATION FAIL UPDATE,
  CONSTRAINT recent       EXPECT (order_ts > '2020-01-01')            -- só avisa (warn)
)
AS SELECT * FROM STREAM(main.bronze.orders);
```

```python
from pyspark import pipelines as dp

@dp.table(name="silver_orders")
@dp.expect_or_drop("valid_id", "order_id IS NOT NULL")
@dp.expect_or_fail("valid_amount", "amount > 0")
@dp.expect("recent", "order_ts > '2020-01-01'")
def silver_orders():
    return spark.readStream.table("main.bronze.orders")
```

| Ação | SQL | Python | Registros inválidos | Pipeline |
| :--- | :--- | :--- | :--- | :--- |
| **Warn** *(padrão)* | `EXPECT (...)` | `@dp.expect` | **Gravados** no destino; violações contadas | Continua |
| **Drop** | `... ON VIOLATION DROP ROW` | `@dp.expect_or_drop` | **Removidos** antes da escrita; contagem registrada | Continua |
| **Fail** | `... ON VIOLATION FAIL UPDATE` | `@dp.expect_or_fail` | O update **falha e é revertido** | Para (precisa de intervenção) |

- Variantes agrupadas (`expect_all`, `expect_all_or_drop`, `expect_all_or_fail`) recebem um dicionário nome → constraint. Existem **apenas em Python**
- **Onde ver os resultados**: na aba **Data quality** de cada dataset na UI do pipeline (warn e drop; fail não registra métricas), ou no **event log**, única opção para pipelines SQL standalone
- Desde junho de 2026 também é possível adicionar expectations a **materialized views criadas no Databricks SQL**

> [!note] Atualização da plataforma (out/2026)
> O **Lakeflow Declarative Pipelines** da prova se chama **Lakeflow Spark Declarative Pipelines** (forma curta "Lakeflow pipelines") na documentação atual. Os decorators legados `@dlt.expect*` ainda funcionam, mas o módulo `pyspark.pipelines` (`dp`) é o recomendado.

## Padrão de quarentena

Às vezes registros ruins não podem ser descartados silenciosamente nem bloquear o pipeline. Direcione-os para uma tabela separada para revisão:

```sql
-- Linhas válidas seguem para a Silver
CREATE OR REFRESH STREAMING TABLE main.silver.orders_valid AS
SELECT * FROM STREAM(main.bronze.orders) WHERE order_id IS NOT NULL AND amount > 0;

-- Linhas inválidas ficam guardadas para investigação, em vez de perdidas
CREATE OR REFRESH STREAMING TABLE main.silver.orders_quarantine AS
SELECT *, current_timestamp() AS quarantined_at
FROM STREAM(main.bronze.orders) WHERE NOT (order_id IS NOT NULL AND amount > 0);
```

## Validando Silver e Gold com consultas

Constraints e expectations verificam linhas individuais. Algumas regras abrangem o dataset inteiro e são melhor expressas como consultas de validação rodando como task depois da carga. A task falha o job se uma regra for quebrada:

```python
# Roda como task após o refresh da Gold; lançar exceção falha a task (e alerta o plantão)
silver_total = spark.sql("SELECT SUM(amount) AS t FROM main.silver.orders WHERE order_date = current_date() - 1").first().t
gold_total   = spark.sql("SELECT SUM(revenue) AS t FROM main.gold.daily_revenue WHERE order_date = current_date() - 1").first().t

if silver_total is None or gold_total is None or abs(silver_total - gold_total) > 0.01:
    raise ValueError(f"Reconciliação falhou: silver={silver_total} gold={gold_total}")

dupes = spark.sql("""
    SELECT COUNT(*) AS n FROM (
      SELECT customer_id FROM main.silver.customers GROUP BY customer_id HAVING COUNT(*) > 1)
""").first().n
if dupes:
    raise ValueError(f"{dupes} customer_id duplicados na Silver")
```

Regras típicas no nível do dataset:

| Regra | Exemplo de verificação |
| :--- | :--- |
| **Reconciliação** | Totais da Gold iguais aos da Silver para o mesmo período |
| **Unicidade** | Nenhuma chave de negócio aparece duas vezes na Silver |
| **Completude** | A partição de ontem existe e a contagem de linhas está numa faixa esperada |
| **Atualidade (freshness)** | `max(event_ts)` não é mais antigo que o SLA |
| **Integridade referencial** | Todo `customer_id` dos fatos existe na dimensão de clientes. PK/FK são informativas, então verifique com consulta |

Schema enforcement (o Delta rejeitando escritas com colunas ou tipos incompatíveis) é uma proteção separada e sempre ativa. Ela protege a **forma** dos dados; as verificações acima protegem o **conteúdo**.

## Constraints vs expectations: como escolher

| Requisito | Use |
| :--- | :--- |
| Nenhum caminho de escrita pode inserir linha ruim, e o lote deve falhar | Constraint Delta `CHECK` / `NOT NULL` |
| Continuar carregando linhas boas e descartar as ruins | Expectation com `DROP ROW` |
| Acompanhar a qualidade ao longo do tempo sem bloquear | Expectation (warn) |
| Parar o pipeline em qualquer violação para alguém intervir | Expectation com `FAIL UPDATE` |
| Guardar linhas ruins para revisão | Tabela de quarentena |

## Casos de uso

- **Cadastro de clientes na Silver**: trim e lowercase em emails, cast de datas, manter o registro mais recente por `customer_id` e aplicar `NOT NULL` na chave
- **Stream de pagamentos**: `FAIL UPDATE` em valor negativo para o pipeline antes que valores errados cheguem à Gold
- **Telemetria IoT**: `DROP ROW` descarta leituras fora da faixa física, e as contagens descartadas são revisadas na aba Data quality
- **Guarda de KPI na Gold**: uma constraint `CHECK` numa tabela Gold rejeita qualquer refresh que publicaria receita total negativa

## Problemas e erros comuns

### `dropDuplicates` mantém um registro antigo

**Cenário:** depois de `dropDuplicates(["customer_id"])`, alguns clientes aparecem com endereço desatualizado.
**Correção:** `dropDuplicates` mantém uma linha arbitrária. Use `ROW_NUMBER()` ordenado por timestamp de atualização ou ingestão (ou `QUALIFY` em SQL) para manter a mais recente.

### Escrita falha por violação de CHECK

**Cenário:** um append noturno na Silver falha porque algumas linhas quebram `CHECK (amount > 0)`.
**Correção:** constraints falham a transação inteira. Limpe ou filtre as linhas antes de gravar, ou mova a regra para uma expectation com `DROP ROW` se descartar for aceitável.

### Registros ruins chegam silenciosamente à Gold

**Cenário:** uma expectation foi adicionada sem cláusula `ON VIOLATION`, e linhas inválidas continuam aparecendo downstream.
**Correção:** a ação padrão é warn: as linhas são gravadas e apenas contadas. Adicione `ON VIOLATION DROP ROW` ou `FAIL UPDATE`.

### Erros de `CAST` param a carga

**Cenário:** `CAST(amount AS DECIMAL(12,2))` falha em valores como `'N/A'` com o modo ANSI ligado.
**Correção:** use `try_cast`, que retorna NULL para valores que não consegue converter, e depois trate os NULLs explicitamente.

## Dicas para a prova

> [!tip] Dicas para a prova
>
> - Expectations são **warn** por padrão: linhas mantidas e violações contadas. `DROP ROW` remove. `FAIL UPDATE` para e reverte
> - Decorators agrupados `expect_all*` são **só Python**
> - `CHECK` / `NOT NULL` do Delta são aplicadas. PK/FK/UNIQUE são **apenas informativas**
> - "Registro mais recente por chave" → `ROW_NUMBER()` + filtro (ou `QUALIFY`), não `dropDuplicates`
> - `summary()` adiciona quartis ao que o `describe()` retorna. `approx_count_distinct` troca ~5 % de erro por velocidade

## Pontos-chave

- Limpeza = padronizar strings, corrigir tipos (`try_cast`), tratar nulos, deduplicar e gravar a Silver
- Constraints protegem a tabela em todo caminho de escrita. Expectations dão controle por registro dentro de pipelines
- Métricas de expectations ficam na aba Data quality do pipeline e no event log
- Tabelas de quarentena mantêm registros ruins visíveis em vez de descartá-los

## Tópicos relacionados

- [Operações com DataFrame](02-dataframe-operations.md)
- [Transformações avançadas (nulos, arrays)](04-advanced-transformations.md)
- [Objetos da camada Gold](06-gold-layer-objects.md)
- [Fundamentos do Delta Lake (schema enforcement)](../01-databricks-intelligence-platform/04-delta-lake-fundamentals.md)

## Documentação oficial

- [Manage data quality with pipeline expectations](https://docs.databricks.com/aws/en/ldp/expectations)
- [Constraints on Databricks](https://docs.databricks.com/aws/en/tables/constraints)
- [approx_count_distinct function](https://docs.databricks.com/aws/en/sql/language-manual/functions/approx_count_distinct)
- [PySpark DataFrame.summary](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.summary.html)

---

**[← Anterior: Transformações avançadas](04-advanced-transformations.md) | [↑ Voltar para Data Transformation and Modeling](README.md) | [Próximo: Objetos da camada Gold →](06-gold-layer-objects.md)**
