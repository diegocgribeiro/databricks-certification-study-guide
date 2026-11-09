---
title: JDBC, REST e Ingestão Semiestruturada
type: study-material
tags:
  - data-engineer-associate
  - ingestao
  - jdbc
  - rest-api
  - json
  - variant
  - structured-streaming
status: published
---

# JDBC, REST e Ingestão Semiestruturada

## Visão geral

Algumas fontes não têm managed connector. Só são acessíveis via **driver JDBC/ODBC** ou **API REST**. Para elas, você escreve código em notebook que grava os dados em cloud storage (um volume UC) ou direto em uma tabela do Unity Catalog, e agenda com **Lakeflow Jobs**. Este arquivo também cobre a ingestão de dados **semiestruturados** (JSON aninhado) e **não estruturados** em tabelas Delta do UC, e os triggers do Structured Streaming que transformam qualquer uma dessas cargas em batch, incremental ou streaming.

> [!abstract] Resumo
>
> - **JDBC**: `spark.read.format("jdbc")` com `url`, `dbtable` ou `query`, e credenciais vindas de **Databricks secrets**. Paralelize com `partitionColumn`, `lowerBound`, `upperBound` e `numPartitions`
> - **REST**: chame a API a partir de um notebook, grave as respostas brutas em um **volume UC** e depois carregue com Auto Loader ou `COPY INTO` — ou grave um DataFrame direto numa tabela UC
> - **Semiestruturado**: use structs e arrays com notação de ponto e `explode`, a sintaxe de caminho `:` em strings JSON, ou o tipo **`VARIANT`**, que a Databricks recomenda no lugar de strings JSON
> - **Triggers**: `processingTime` (streaming), `availableNow` (batch incremental) ou sem trigger (micro-batches o mais rápido possível)

> [!tip] O que a prova cobra
>
> - Habilidades do exam guide: clientes JDBC/ODBC ou REST em notebooks gravando em cloud storage ou tabelas UC, agendados com Lakeflow Jobs; ingerir dados semiestruturados e não estruturados (JSON, aninhados) em tabelas Delta do UC
> - Manter credenciais fora do código com `dbutils.secrets.get`
> - Por que uma leitura JDBC é lenta (uma única thread por padrão) e como paralelizar
> - Ler campos de JSON aninhado e "achatar" arrays

---

## Leituras JDBC a partir de um notebook

```python
jdbc_url = "jdbc:postgresql://db.example.com:5432/sales"

orders = (spark.read
    .format("jdbc")
    .option("url", jdbc_url)
    .option("dbtable", "public.orders")
    .option("user", dbutils.secrets.get(scope="jdbc", key="username"))
    .option("password", dbutils.secrets.get(scope="jdbc", key="password"))
    # Leitura paralela: divide a faixa de chaves em 8 consultas concorrentes
    .option("partitionColumn", "order_id")
    .option("lowerBound", "1")
    .option("upperBound", "10000000")
    .option("numPartitions", "8")
    .option("fetchSize", "1000")
    .load())

orders.write.mode("overwrite").saveAsTable("main.bronze.orders_snapshot")
```

| Opção | Propósito | Orientação da documentação |
| :--- | :--- | :--- |
| `url`, `dbtable` | String de conexão e tabela de origem. `dbtable` pode ser uma subquery, que é executada no banco (push down) | Guarde credenciais em **secrets**, não na URL |
| `partitionColumn`, `lowerBound`, `upperBound`, `numPartitions` | Dividem a leitura em consultas paralelas | Uma leitura JDBC usa **uma thread por padrão**. Escolha uma coluna indexada. Cuidado acima de ~50 partições |
| `fetchSize` | Linhas por ida e volta na rede | Muito baixo aumenta a latência; muito alto pode causar out-of-memory. O padrão do Oracle é 10 |

Fonte: [Query databases using JDBC](https://docs.databricks.com/aws/en/connect/external-systems/jdbc). A mesma página diz: "Se o Lakehouse Federation suporta seu banco de origem, a Databricks recomenda usá-lo". O Federation consulta a fonte no lugar, sem cópia. Escolha ingestão JDBC quando precisar de uma cópia governada em Delta, por exemplo para histórico ou performance.

### JDBC vs Lakehouse Federation vs managed connector

| Abordagem | Copia dados? | Incremental? | Esforço | Escolha quando |
| :--- | :--- | :--- | :--- | :--- |
| **Managed database connector** | Sim, em streaming tables | Sim, via CDC | Baixo (só configuração) | A fonte é um banco suportado e você quer replicação contínua e governada |
| **Lakehouse Federation** | Não, as consultas rodam na fonte | n/a | Baixo | Precisa de consultas ao vivo sem cópia, e a fonte é suportada |
| **Leitura JDBC em notebook** | Sim, em tabelas Delta que você controla | Só se você programar (watermark + `MERGE`) | Médio (código + agenda) | Não existe conector, ou você precisa de lógica de extração customizada |

### Padrão JDBC incremental

Um snapshot completo a cada execução fica caro. Um padrão incremental comum aplica um filtro de watermark na consulta de origem e faz merge do resultado:

```python
last_ts = spark.sql("SELECT coalesce(max(updated_at), '1900-01-01') AS ts FROM main.bronze.orders").first().ts

changes = (spark.read.format("jdbc")
    .option("url", jdbc_url)
    .option("query", f"SELECT * FROM public.orders WHERE updated_at > '{last_ts}'")
    .option("user", dbutils.secrets.get(scope="jdbc", key="username"))
    .option("password", dbutils.secrets.get(scope="jdbc", key="password"))
    .load())

changes.createOrReplaceTempView("changes")
spark.sql("""
  MERGE INTO main.bronze.orders AS t
  USING changes AS s ON t.order_id = s.order_id
  WHEN MATCHED THEN UPDATE SET *
  WHEN NOT MATCHED THEN INSERT *
""")
```

Se o banco é suportado por um **managed database connector** (MySQL, PostgreSQL, SQL Server, Oracle), a ingestão baseada em CDC do conector costuma ser melhor que esse padrão escrito à mão. Veja [01-ingestion-patterns-and-lakeflow-connect.md](01-ingestion-patterns-and-lakeflow-connect.md).

### ODBC e outros drivers

O mesmo padrão vale para clientes ODBC e bibliotecas Python de banco instaladas com escopo de notebook (`%pip install`) ou como bibliotecas de environment. Leia no driver, converta para DataFrame Spark e grave numa tabela UC. Mantenha os segredos da conexão em um secret scope.

## APIs REST a partir de um notebook

```python
import json, requests
from datetime import datetime, timezone

token = dbutils.secrets.get(scope="vendor_api", key="token")
resp = requests.get(
    "https://api.vendor.example.com/v1/orders",
    headers={"Authorization": f"Bearer {token}"},
    params={"updated_since": dbutils.widgets.get("updated_since")},
    timeout=60,
)
resp.raise_for_status()

# Grava o payload bruto em um volume UC (cloud storage), um arquivo por execução
run_ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
path = f"/Volumes/main/raw/landing/vendor_orders/orders_{run_ts}.json"
with open(path, "w") as f:
    f.write(json.dumps(resp.json()["data"]))
```

Duas opções de landing:

| Opção | Como | Quando |
| :--- | :--- | :--- |
| **Gravar primeiro em cloud storage** (recomendado para dados brutos) | Escreva arquivos JSON em um volume UC e ingira com Auto Loader ou `COPY INTO` | Mantém uma cópia bruta imutável para reprocessar. A evolução de schema fica com o loader |
| **Gravar direto numa tabela UC** | `spark.createDataFrame(records).write.mode("append").saveAsTable(...)` | Payloads pequenos em que a cópia bruta não é necessária |

### Parametrizando o notebook

Faça da janela de extração um parâmetro em vez de valor fixo, para que o mesmo notebook sirva execuções diárias e backfills:

```python
dbutils.widgets.text("updated_since", "1900-01-01")   # padrão para execuções interativas
updated_since = dbutils.widgets.get("updated_since")   # o parâmetro do job sobrescreve
```

No job, defina o parâmetro `updated_since` com um valor como `{{job.start_time.iso_date}}`. Dynamic value references são resolvidas quando a execução começa ([dynamic value references](https://docs.databricks.com/aws/en/jobs/dynamic-value-references)).

### Agendando com Lakeflow Jobs

Faça do notebook a primeira task de um Lakeflow Job:

1. **Task 1 (notebook)**: chama a API e grava os arquivos. Passe `updated_since` como parâmetro do job ou valor dinâmico como `{{job.start_time.iso_date}}`
2. **Task 2 (pipeline ou notebook)**: o Auto Loader leva os arquivos para a Bronze
3. Adicione **retries** na Task 1 para erros HTTP transitórios, um **timeout** para chamadas travadas e um trigger **agendado**. Veja o [Domínio 4](../04-working-with-lakeflow-jobs/README.md)

## Dados semiestruturados e aninhados

### Structs e arrays (schema tipado)

Quando o JSON é lido com schema inferido ou explícito, objetos aninhados viram **structs** e listas viram **arrays**:

```python
raw = spark.read.json("/Volumes/main/raw/landing/vendor_orders/")

from pyspark.sql.functions import col, explode

flat = (raw
    .select(
        col("order_id"),
        col("customer.id").alias("customer_id"),        # campo de struct
        col("customer.address.city").alias("city"),     # struct aninhado
        explode(col("line_items")).alias("item"))       # uma linha por elemento do array
    .select("order_id", "customer_id", "city",
            col("item.sku").alias("sku"), col("item.qty").alias("qty")))
```

### Strings JSON com a sintaxe de caminho `:`

Se uma coluna guarda **strings** JSON, o Databricks SQL extrai campos com `<coluna>:<caminho>`:

```sql
SELECT
  raw:customer.id              AS customer_id,
  raw:line_items[0].sku        AS first_sku,     -- arrays começam em 0
  raw:total::double            AS total          -- cast com ::
FROM main.bronze.vendor_orders_raw;

-- Converter um fragmento aninhado em struct tipado
SELECT from_json(raw:customer, 'id BIGINT, name STRING') AS customer
FROM main.bronze.vendor_orders_raw;
```

Fonte: [Query JSON strings](https://docs.databricks.com/aws/en/semi-structured/json).

### O tipo `VARIANT`

`VARIANT` guarda dados semiestruturados em uma forma binária tipada. Está disponível a partir do Databricks Runtime 15.4, e "a Databricks recomenda usar `VARIANT` em vez de strings JSON para dados semiestruturados" ([Query variant data](https://docs.databricks.com/aws/en/semi-structured/variant)).

```sql
CREATE TABLE main.bronze.events_variant AS
SELECT parse_json(raw) AS payload FROM main.bronze.vendor_orders_raw;

SELECT payload:customer.id::bigint AS customer_id,
       variant_get(payload, '$.total', 'double') AS total
FROM main.bronze.events_variant;
```

### Dados não estruturados

```python
# Batch: ler PDFs como linhas binárias (path, modificationTime, length, content)
pdfs = (spark.read.format("binaryFile")
    .option("pathGlobFilter", "*.pdf")
    .load("/Volumes/main/raw/documents/contracts/"))

# Incremental: Auto Loader com formato binaryFile
docs = (spark.readStream.format("cloudFiles")
    .option("cloudFiles.format", "binaryFile")
    .load("/Volumes/main/raw/documents/contracts/"))
```

Imagens, PDFs e áudios ficam em um **volume UC**. Podem ser lidos com o formato `binaryFile` (retorna caminho, data de modificação, tamanho e conteúdo) ou com Auto Loader (`cloudFiles.format = "binaryFile"`) para cargas incrementais. **File source** connectors gerenciados como SharePoint e Google Drive trazem documentos sem código.

## Triggers do Structured Streaming (referência rápida)

| Trigger | Sintaxe | Comportamento |
| :--- | :--- | :--- |
| Padrão (nenhum definido) | — | Micro-batches um atrás do outro (`processingTime` de 0), latência de ~3–5 s |
| Intervalo fixo | `.trigger(processingTime="1 minute")` | Um micro-batch a cada intervalo até ser parado |
| Batch incremental | `.trigger(availableNow=True)` | Processa tudo que está disponível em um ou mais micro-batches e para |
| Once | `.trigger(once=True)` | **Depreciado** (DBR 11.3 LTS+). Use `availableNow` |
| Continuous | `.trigger(continuous="1 second")` | **Não suportado** no Databricks. Use o real-time mode |

Toda escrita streaming precisa de um **`checkpointLocation`** (a menos que um Lakeflow pipeline o gerencie), e um DataFrame streaming deve ser escrito com **`writeStream`**, não `write`. Fonte: [trigger intervals](https://docs.databricks.com/aws/en/structured-streaming/triggers).

## Casos de uso

- **ERP sem conector**: um Lakeflow Job noturno faz leitura JDBC paralela das mudanças de ontem e faz merge na Bronze
- **API de marketing**: um notebook puxa estatísticas de campanhas de uma API REST a cada hora, grava JSON num volume e o Auto Loader ingere
- **Eventos de pedido aninhados**: a Silver achata `line_items` com `explode` para que cada item seja uma linha na agregação de receita
- **Payloads de eventos que evoluem**: a Bronze guarda o evento bruto como `VARIANT`, e a Silver extrai colunas tipadas conforme estabilizam

## Problemas e erros comuns

### Leitura JDBC roda em um core só

**Cenário:** uma leitura JDBC de 200 milhões de linhas leva horas enquanto o cluster fica ocioso.
**Correção:** sem `partitionColumn`, `lowerBound`, `upperBound` e `numPartitions`, o Spark lê com uma thread. Adicione essas opções usando uma coluna numérica ou de data indexada.

### Senha visível no notebook

**Cenário:** um revisor encontra a senha do banco escrita direto nas opções JDBC.
**Correção:** guarde-a em um secret scope e leia com `dbutils.secrets.get`. Valores de secrets aparecem como `[REDACTED]` na saída do notebook.

### `explode` some com pedidos sem lista de itens

**Cenário:** depois de `explode(line_items)`, pedidos cujo `line_items` é NULL desaparecem da Silver.
**Correção:** `explode` não retorna linhas quando a coleção é NULL. `explode_outer` gera uma linha com NULLs, preservando o pedido ([explode_outer](https://docs.databricks.com/aws/en/sql/language-manual/functions/explode_outer)).

### Rate limit da API derruba o job noturno

**Cenário:** a task de extração REST falha de forma intermitente com HTTP 429, e o job inteiro fica como falho.
**Correção:** adicione **retries** com intervalo na task de extração e pagine a API em janelas menores. Como os arquivos brutos vão primeiro para um volume, uma reexecução regrava apenas a sua janela. O Auto Loader depois pega os arquivos novos.

### DataFrame streaming escrito com `write`

**Cenário:** `df.write.saveAsTable(...)` em um DataFrame de `readStream` gera `AnalysisException`.
**Correção:** fontes streaming precisam ser escritas com `writeStream` (`.toTable(...)` ou `.start(...)`) e um checkpoint location.

## Dicas para a prova

> [!tip] Dicas para a prova
>
> - "A fonte só tem driver JDBC" → `spark.read.format("jdbc")`. Se o Lakehouse Federation suporta a fonte e não é preciso copiar, federation é o preferido
> - Credenciais sempre vêm de **`dbutils.secrets.get`**
> - Leitura JDBC lenta → adicione `partitionColumn` / limites / `numPartitions`
> - Padrão REST: grave arquivos brutos num **volume**, carregue com Auto Loader e agende os dois passos em um único **Lakeflow Job**
> - `availableNow` = processa todos os dados novos e para. `once` está depreciado. `continuous` não é suportado

## Pontos-chave

- Código em notebook cobre o que os managed connectors não cobrem: JDBC/ODBC para bancos, REST para APIs
- Grave dados brutos em volumes UC para poder reprocessar, depois carregue em tabelas UC
- JSON aninhado é tratado com structs e arrays, `explode`, a sintaxe `:` ou `VARIANT`
- Lakeflow Jobs agendam e reexecutam esses notebooks como qualquer outra task

## Tópicos relacionados

- [Padrões de Ingestão e Lakeflow Connect](01-ingestion-patterns-and-lakeflow-connect.md)
- [COPY INTO e Auto Loader](02-copy-into-and-auto-loader.md)
- [Transformações avançadas (arrays, structs, explode)](../03-data-transformation-and-modeling/04-advanced-transformations.md)
- [Lakeflow Jobs e Tasks](../04-working-with-lakeflow-jobs/01-lakeflow-jobs-and-tasks.md)

## Documentação oficial

- [Query databases using JDBC](https://docs.databricks.com/aws/en/connect/external-systems/jdbc)
- [Secret management](https://docs.databricks.com/aws/en/security/secrets/)
- [Query JSON strings](https://docs.databricks.com/aws/en/semi-structured/json)
- [Query variant data](https://docs.databricks.com/aws/en/semi-structured/variant)
- [Configure Structured Streaming trigger intervals](https://docs.databricks.com/aws/en/structured-streaming/triggers)

---

**[← Anterior: COPY INTO e Auto Loader](02-copy-into-and-auto-loader.md) | [↑ Voltar para Data Ingestion and Loading](README.md)**
